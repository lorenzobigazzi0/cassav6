package com.sentrapa.webkiosk

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder
import java.util.Locale
import java.util.WeakHashMap
import java.util.concurrent.TimeUnit

internal fun resolveNotificationApiBaseCandidates(savedUrl: String?): List<String> {
    if (savedUrl.isNullOrBlank()) return emptyList()
    return runCatching {
        val uri = URI(savedUrl)
        val scheme = uri.scheme?.takeIf { it.equals("http", true) || it.equals("https", true) }
            ?: return@runCatching emptyList()
        val host = uri.host ?: return@runCatching emptyList()
        val portPart = if (uri.port > 0) ":${uri.port}" else ""
        listOf("${scheme.lowercase(Locale.ROOT)}://$host$portPart/api")
    }.getOrElse { emptyList() }
}

internal fun interface NativeNotificationSessionStopTarget {
    fun stopForSessionClear()
}

internal class NativeNotificationSessionStopRegistry {
    private val targets = WeakHashMap<NativeNotificationSessionStopTarget, Unit>()

    fun register(target: NativeNotificationSessionStopTarget) {
        synchronized(targets) {
            targets[target] = Unit
        }
    }

    fun unregister(target: NativeNotificationSessionStopTarget) {
        synchronized(targets) {
            targets.remove(target)
        }
    }

    fun stopAll(): Int {
        val snapshot = synchronized(targets) { targets.keys.toList() }
        snapshot.forEach(NativeNotificationSessionStopTarget::stopForSessionClear)
        return snapshot.size
    }
}

private val activeNotificationPollers = NativeNotificationSessionStopRegistry()

internal fun stopNativeNotificationPollersForSessionClear(): Int =
    activeNotificationPollers.stopAll()

internal class NativeNotificationPoller(
    context: Context,
    private val onSnapshot: (List<NativeNotificationEvent>, Boolean, String) -> Unit,
    private val onEvent: (NativeNotificationEvent) -> Unit
) : NativeNotificationSessionStopTarget {
    private val appContext = context.applicationContext
    private val client = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .writeTimeout(3, TimeUnit.SECONDS)
        .build()
    private val localHttpsClient = LocalHttpsTrust.configure(
        OkHttpClient.Builder()
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
            .writeTimeout(3, TimeUnit.SECONDS)
    ).build()
    private val streamClient = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(3, TimeUnit.SECONDS)
        .build()
    private val localHttpsStreamClient = LocalHttpsTrust.configure(
        OkHttpClient.Builder()
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(3, TimeUnit.SECONDS)
    ).build()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var job: Job? = null
    private var reconcileJob: Job? = null
    private val activePullCalls = LinkedHashSet<Call>()
    private var requestGeneration = 0L

    @Volatile
    private var savedUrl: String? = null

    @Volatile
    private var notificationContext = NotificationClientContext()

    @Volatile
    private var activeApiBaseUrl: String? = null

    @Volatile
    private var backgroundPrimed = false

    @Volatile
    private var activeStreamCall: Call? = null

    @Volatile
    private var lastEventId = 0L

    init {
        activeNotificationPollers.register(this)
    }

    @Synchronized
    fun update(savedUrl: String?, notificationContext: NotificationClientContext) {
        val normalizedUrl = savedUrl?.trim()?.takeIf { it.isNotEmpty() }
        val endpointChanged = this.savedUrl != normalizedUrl
        val identityChanged = this.notificationContext.identityKey != notificationContext.identityKey
        this.savedUrl = normalizedUrl
        this.notificationContext = notificationContext
        if (endpointChanged || identityChanged) {
            invalidateRequestsLocked()
            activeApiBaseUrl = null
            backgroundPrimed = false
            lastEventId = 0L
        }
        if (canRun()) start() else stop()
    }

    @Synchronized
    fun updateForeground(isForeground: Boolean) {
        if (isForeground) stop() else if (canRun()) start()
    }

    fun close() {
        activeNotificationPollers.unregister(this)
        stop()
        scope.cancel()
    }

    @Synchronized
    override fun stopForSessionClear() {
        savedUrl = null
        notificationContext = NotificationClientContext()
        stop()
    }

    private fun canRun(): Boolean = shouldRunNativeNotificationTransport(
        isForeground = AppForegroundState.isForeground,
        savedUrl = savedUrl,
        activeContext = notificationContext,
        persistedContext = KioskPreferences.getNotificationClientContext(appContext)
    )

    @Synchronized
    private fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            var retryDelayMs = STREAM_RECONNECT_BASE_MS
            while (isActive) {
                val streamReachedServer = streamOnce()
                if (!isActive || !canRun()) break
                val pullReachedServer = pollOnce()
                val reachedServer = streamReachedServer || pullReachedServer
                retryDelayMs = if (reachedServer) {
                    STREAM_RECONNECT_BASE_MS
                } else {
                    (retryDelayMs * 2).coerceAtMost(OFFLINE_POLL_MAX_INTERVAL_MS)
                }
                delay(retryDelayMs)
            }
        }
    }

    @Synchronized
    private fun stop() {
        invalidateRequestsLocked()
        reconcileJob?.cancel()
        reconcileJob = null
        job?.cancel()
        job = null
        activeApiBaseUrl = null
        backgroundPrimed = false
        lastEventId = 0L
    }

    private fun streamOnce(): Boolean {
        val requestScope = captureRequestScope() ?: return true

        val contextSnapshot = requestScope.context
        val path = "/integration/notifications/stream?${buildQuery(contextSnapshot)}"
        for (baseUrl in orderedApiBaseCandidates(requestScope)) {
            val requestBuilder = applyNotificationSessionHeaders(
                Request.Builder()
                    .url("$baseUrl$path")
                    .get()
                    .header("Accept", "text/event-stream")
                    .header("Cache-Control", "no-cache"),
                contextSnapshot
            )
            if (requestScope.lastEventId > 0L) {
                requestBuilder.header("Last-Event-ID", requestScope.lastEventId.toString())
            }
            val call = streamClientFor(baseUrl).newCall(requestBuilder.build())
            if (!registerStreamCall(call, requestScope)) {
                call.cancel()
                return true
            }
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) return@use
                    val source = response.body?.source() ?: return@use
                    if (!markActiveApiBaseIfCurrent(requestScope, baseUrl)) return true
                    var eventName = "message"
                    var eventId = 0L
                    val data = StringBuilder()
                    while (isRequestCurrent(requestScope) && !source.exhausted()) {
                        val line = source.readUtf8Line() ?: break
                        if (line.isEmpty()) {
                            dispatchStreamEvent(
                                requestScope,
                                eventName,
                                data.toString(),
                                eventId
                            )
                            eventName = "message"
                            eventId = 0L
                            data.setLength(0)
                            continue
                        }
                        when {
                            line.startsWith(":") -> Unit
                            line.startsWith("event:") -> eventName = line.substringAfter(':').trim()
                            line.startsWith("id:") -> eventId = line.substringAfter(':').trim().toLongOrNull() ?: 0L
                            line.startsWith("data:") -> {
                                if (data.isNotEmpty()) data.append('\n')
                                data.append(line.substringAfter(':').trimStart())
                            }
                        }
                    }
                    return true
                }
            } catch (error: Exception) {
                if (isRequestCurrent(requestScope)) {
                    Log.d(TAG, "Notification stream failed at $baseUrl: ${error.message}")
                }
            } finally {
                unregisterStreamCall(call)
            }
        }
        return false
    }

    private fun dispatchStreamEvent(
        requestScope: RequestScope,
        eventName: String,
        data: String,
        eventId: Long
    ) {
        if (!recordStreamEventIfCurrent(requestScope, eventId)) return
        when (eventName) {
            "ready" -> if (shouldPrimeBackground(requestScope)) pollOnce()
            "payload", "refresh" -> {
                val events = parseStreamNotifications(
                    data,
                    requestScope.context.sessionBindingKey
                )
                if (
                    deliverStreamEventsIfCurrent(requestScope, events) &&
                    (events.isNotEmpty() || isNotificationLifecycleEvent(data))
                ) {
                    scheduleReconcilePull()
                }
            }
            "recovery" -> if (isRequestCurrent(requestScope)) pollOnce()
        }
    }

    @Synchronized
    private fun scheduleReconcilePull() {
        if (!canRun() || reconcileJob?.isActive == true) return
        reconcileJob = scope.launch {
            delay(STREAM_RECONCILE_DELAY_MS)
            if (canRun()) pollOnce()
        }
    }

    private fun pollOnce(): Boolean {
        if (AppForegroundState.isForeground) {
            backgroundPrimed = false
            return true
        }
        val requestScope = captureRequestScope() ?: return true

        val contextSnapshot = requestScope.context
        val path = "/integration/notifications/pull?${buildQuery(contextSnapshot)}"
        for (baseUrl in orderedApiBaseCandidates(requestScope)) {
            val request = applyNotificationSessionHeaders(
                Request.Builder()
                    .url("$baseUrl$path")
                    .get()
                    .header("Accept", "application/json"),
                contextSnapshot
            ).build()
            val call = clientFor(baseUrl).newCall(request)
            if (!registerPullCall(call, requestScope)) {
                call.cancel()
                return true
            }
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) return@use
                    val body = response.body?.string().orEmpty()
                    deliverSnapshotIfCurrent(
                        requestScope,
                        baseUrl,
                        parseResponse(body, requestScope.context.sessionBindingKey)
                    )
                    return true
                }
            } catch (error: Exception) {
                if (isRequestCurrent(requestScope)) {
                    Log.d(TAG, "Notification pull failed at $baseUrl: ${error.message}")
                }
            } finally {
                unregisterPullCall(call)
            }
        }
        return false
    }

    @Synchronized
    private fun captureRequestScope(): RequestScope? {
        if (!canRun()) return null
        val url = savedUrl ?: return null
        return RequestScope(
            generation = requestGeneration,
            context = notificationContext,
            savedUrl = url,
            preferredApiBaseUrl = activeApiBaseUrl,
            lastEventId = lastEventId
        )
    }

    @Synchronized
    private fun registerStreamCall(call: Call, requestScope: RequestScope): Boolean {
        if (!isRequestCurrentLocked(requestScope)) return false
        activeStreamCall = call
        return true
    }

    @Synchronized
    private fun unregisterStreamCall(call: Call) {
        if (activeStreamCall === call) activeStreamCall = null
    }

    @Synchronized
    private fun registerPullCall(call: Call, requestScope: RequestScope): Boolean {
        if (!isRequestCurrentLocked(requestScope)) return false
        activePullCalls.add(call)
        return true
    }

    @Synchronized
    private fun unregisterPullCall(call: Call) {
        activePullCalls.remove(call)
    }

    @Synchronized
    private fun isRequestCurrent(requestScope: RequestScope): Boolean =
        isRequestCurrentLocked(requestScope)

    private fun isRequestCurrentLocked(requestScope: RequestScope): Boolean {
        val persistedContext =
            KioskPreferences.getNotificationClientContext(appContext)
        return canRun() && shouldDeliverNativeNotificationResponse(
            requestGeneration = requestScope.generation,
            activeGeneration = requestGeneration,
            requestIdentityKey = requestScope.context.identityKey,
            activeIdentityKey = notificationContext.identityKey,
            persistedIdentityKey = persistedContext.identityKey,
            activeAuthenticated = notificationContext.hasAuthenticatedSession,
            persistedAuthenticated = persistedContext.hasAuthenticatedSession
        )
    }

    @Synchronized
    private fun markActiveApiBaseIfCurrent(
        requestScope: RequestScope,
        baseUrl: String
    ): Boolean {
        if (!isRequestCurrentLocked(requestScope)) return false
        activeApiBaseUrl = baseUrl
        return true
    }

    @Synchronized
    private fun recordStreamEventIfCurrent(
        requestScope: RequestScope,
        eventId: Long
    ): Boolean {
        if (!isRequestCurrentLocked(requestScope)) return false
        if (eventId > 0L) lastEventId = maxOf(lastEventId, eventId)
        return true
    }

    @Synchronized
    private fun shouldPrimeBackground(requestScope: RequestScope): Boolean =
        isRequestCurrentLocked(requestScope) && !backgroundPrimed

    @Synchronized
    private fun deliverStreamEventsIfCurrent(
        requestScope: RequestScope,
        events: List<NativeNotificationEvent>
    ): Boolean {
        if (!isRequestCurrentLocked(requestScope)) return false
        events
            .filter { event ->
                event.sessionBindingKey == requestScope.context.sessionBindingKey &&
                    isNativeNotificationFreshForSession(
                        event.createdAt,
                        requestScope.context.sessionStartedAt
                    )
            }
            .forEach(onEvent)
        return isRequestCurrentLocked(requestScope)
    }

    @Synchronized
    private fun deliverSnapshotIfCurrent(
        requestScope: RequestScope,
        baseUrl: String,
        events: List<NativeNotificationEvent>
    ): Boolean {
        if (!isRequestCurrentLocked(requestScope)) return false
        activeApiBaseUrl = baseUrl
        val shouldAlert = backgroundPrimed
        val freshEvents = events.filter { event ->
            event.sessionBindingKey == requestScope.context.sessionBindingKey &&
                isNativeNotificationFreshForSession(
                    event.createdAt,
                    requestScope.context.sessionStartedAt
                )
        }
        onSnapshot(freshEvents, shouldAlert, requestScope.context.sessionBindingKey)
        if (!isRequestCurrentLocked(requestScope)) return false
        backgroundPrimed = true
        return true
    }

    private fun invalidateRequestsLocked() {
        requestGeneration = nextNotificationRequestGeneration(requestGeneration)
        activeStreamCall?.cancel()
        activeStreamCall = null
        activePullCalls.forEach(Call::cancel)
        activePullCalls.clear()
    }

    private fun clientFor(baseUrl: String): OkHttpClient =
        if (LocalHttpsTrust.shouldUseFor(baseUrl)) localHttpsClient else client

    private fun streamClientFor(baseUrl: String): OkHttpClient =
        if (LocalHttpsTrust.shouldUseFor(baseUrl)) localHttpsStreamClient else streamClient

    private fun orderedApiBaseCandidates(requestScope: RequestScope): List<String> {
        val preferredBase = requestScope.preferredApiBaseUrl
        val candidates = resolveNotificationApiBaseCandidates(requestScope.savedUrl)
        return if (preferredBase.isNullOrBlank()) {
            candidates
        } else {
            listOf(preferredBase) + candidates.filterNot { it == preferredBase }
        }
    }

    private fun parseResponse(
        body: String,
        sessionBindingKey: String
    ): List<NativeNotificationEvent> {
        val items = runCatching { JSONObject(body).optJSONArray("items") }.getOrNull()
            ?: return emptyList()
        val now = System.currentTimeMillis()
        return buildList {
            for (index in 0 until items.length()) {
                val item = items.optJSONObject(index) ?: continue
                add(parseNotification(item, index, now, sessionBindingKey))
            }
        }
    }

    private fun parseStreamNotifications(
        body: String,
        sessionBindingKey: String
    ): List<NativeNotificationEvent> {
        if (body.isBlank()) return emptyList()
        val root = runCatching { JSONObject(body) }.getOrNull() ?: return emptyList()
        val payload = root.optJSONObject("payload") ?: root
        val detail = payload.optJSONObject("detail") ?: payload
        val now = System.currentTimeMillis()
        val events = buildList {
            detail.optJSONObject("notification")?.let {
                add(parseNotification(it, 0, now, sessionBindingKey))
            }
            val notifications = detail.optJSONArray("notifications")
            if (notifications != null) {
                for (index in 0 until notifications.length()) {
                    notifications.optJSONObject(index)?.let {
                        add(parseNotification(it, index + 1, now, sessionBindingKey))
                    }
                }
            }
        }
        return events.distinctBy { it.identity }
    }

    private fun isNotificationLifecycleEvent(body: String): Boolean {
        if (body.isBlank()) return false
        val root = runCatching { JSONObject(body) }.getOrNull() ?: return false
        val payload = root.optJSONObject("payload") ?: root
        val reason = payload.optString("reason").trim().lowercase(Locale.ROOT)
        return reason == "order_ready" || reason.startsWith("notification_")
    }

    private fun parseNotification(
        item: JSONObject,
        index: Int,
        now: Long,
        sessionBindingKey: String
    ): NativeNotificationEvent {
        val meta = item.optJSONObject("meta")
        val type = item.optString("type").trim()
        val eventType = meta?.optString("eventType")?.trim()
        val tone = NotificationTone.fromPayload(type, eventType)
        val title = item.optString("title").trim().ifBlank { defaultTitleFor(tone) }
        val text = item.optString("description").trim().ifBlank { title }
        val createdAt = readTimestamp(item)
        val id = notificationIdentity(item, index, createdAt, tone, title, text)
        return NativeNotificationEvent(
            id = id,
            tone = tone,
            title = title,
            text = text,
            createdAt = createdAt,
            sessionBindingKey = sessionBindingKey,
            receivedAt = now
        )
    }

    private fun notificationIdentity(
        item: JSONObject,
        index: Int,
        createdAt: Long,
        tone: NotificationTone,
        title: String,
        text: String
    ): String {
        val id = item.optString("id").trim()
        if (id.isNotEmpty()) return id
        return "fallback:${listOf(createdAt, tone.name, title, text, index).joinToString("|").hashCode()}"
    }

    private fun readTimestamp(source: JSONObject): Long {
        for (key in TIMESTAMP_KEYS) {
            when (val value = source.opt(key)) {
                is Number -> if (value.toLong() > 0L) return value.toLong()
                is String -> value.trim().toLongOrNull()?.takeIf { it > 0L }?.let { return it }
            }
        }
        return 0L
    }

    private fun buildQuery(context: NotificationClientContext): String {
        val params = listOf(
            "consumer" to buildConsumerId(context),
            "clientApp" to "mobile-frontend",
            "userId" to context.userId,
            "username" to context.username,
            "fullName" to context.fullName,
            "deviceUuid" to context.deviceUuid,
            "roomId" to context.roomId,
            "roomName" to context.roomName
        )
        return params
            .filter { (_, value) -> value.isNotBlank() }
            .joinToString("&") { (key, value) -> "${encode(key)}=${encode(value)}" }
    }

    private fun buildConsumerId(context: NotificationClientContext): String {
        val userPart = normalizePart(context.userId.ifBlank { context.username }.ifBlank { "anon" })
        val devicePart = normalizePart(context.deviceUuid.ifBlank { "device" }).take(24)
        return "amalia-advanced:$userPart:$devicePart"
    }

    private fun normalizePart(value: String): String =
        value.trim()
            .lowercase(Locale.ROOT)
            .replace(Regex("[^a-z0-9_-]+"), "_")
            .ifBlank { "x" }

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name())

    private fun defaultTitleFor(tone: NotificationTone): String = when (tone) {
        NotificationTone.WAITER -> "Chiamata cameriere"
        NotificationTone.BELL -> "Comanda pronta"
        NotificationTone.HANDHELD_RING -> "Squillo palmare"
        NotificationTone.GENERAL -> "Notifica"
    }

    private companion object {
        const val TAG = "NativeNotificationPoller"
        const val STREAM_RECONNECT_BASE_MS = 500L
        const val STREAM_RECONCILE_DELAY_MS = 900L
        const val OFFLINE_POLL_MAX_INTERVAL_MS = 60_000L
        val TIMESTAMP_KEYS = listOf("createdAt", "created_at", "timestamp", "ts")
    }

    private data class RequestScope(
        val generation: Long,
        val context: NotificationClientContext,
        val savedUrl: String,
        val preferredApiBaseUrl: String?,
        val lastEventId: Long
    )
}

internal fun shouldDeliverNativeNotificationResponse(
    requestGeneration: Long,
    activeGeneration: Long,
    requestIdentityKey: String,
    activeIdentityKey: String,
    persistedIdentityKey: String,
    activeAuthenticated: Boolean,
    persistedAuthenticated: Boolean
): Boolean =
    requestGeneration == activeGeneration &&
        activeAuthenticated &&
        persistedAuthenticated &&
        requestIdentityKey == activeIdentityKey &&
        requestIdentityKey == persistedIdentityKey

internal fun nextNotificationRequestGeneration(current: Long): Long =
    if (current == Long.MAX_VALUE) 0L else current + 1L

internal fun shouldRunNativeNotificationTransport(
    isForeground: Boolean,
    savedUrl: String?,
    activeContext: NotificationClientContext,
    persistedContext: NotificationClientContext
): Boolean =
    !isForeground &&
        !savedUrl.isNullOrBlank() &&
        activeContext.canPullNotifications &&
        persistedContext.canPullNotifications &&
        activeContext.identityKey == persistedContext.identityKey

internal fun applyNotificationSessionHeaders(
    builder: Request.Builder,
    context: NotificationClientContext
): Request.Builder {
    if (!context.hasAuthenticatedSession) return builder
    builder.header("Authorization", "Bearer ${context.token}")
    builder.header("X-Device-Uuid", context.deviceUuid)
    builder.header("X-Session-Started-At", context.sessionStartedAt.toString())
    if (context.userId.isNotBlank()) builder.header("X-User-Id", context.userId)
    if (context.username.isNotBlank()) builder.header("X-Username", context.username)
    return builder
}
