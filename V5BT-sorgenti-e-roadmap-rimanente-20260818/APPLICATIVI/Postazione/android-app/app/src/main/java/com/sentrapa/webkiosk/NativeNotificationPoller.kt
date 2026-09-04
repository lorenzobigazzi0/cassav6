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
import java.util.concurrent.TimeUnit

class NativeNotificationPoller(
    context: Context,
    private val onSnapshot: (List<NativeNotificationEvent>, Boolean) -> Unit
) {
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
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var job: Job? = null
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
        }
        if (canRun()) start() else stop()
    }

    fun close() {
        stop()
        scope.cancel()
    }

    private fun canRun(): Boolean =
        !savedUrl.isNullOrBlank() && notificationContext.canPullNotifications

    @Synchronized
    private fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            var retryDelayMs = POLL_INTERVAL_MS
            while (isActive) {
                val reachedServer = pollOnce()
                retryDelayMs = if (reachedServer) {
                    POLL_INTERVAL_MS
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
        job?.cancel()
        job = null
        activeApiBaseUrl = null
        backgroundPrimed = false
    }

    private fun pollOnce(): Boolean {
        if (AppForegroundState.isForeground) {
            backgroundPrimed = false
            return true
        }
        val requestScope = captureRequestScope() ?: return true

        val contextSnapshot = requestScope.context
        val path = "/integration/notifications/pull?${buildQuery(contextSnapshot)}"
        val preferredBase = requestScope.preferredApiBaseUrl
        val candidates = if (preferredBase.isNullOrBlank()) {
            resolveApiBaseCandidates(requestScope.savedUrl)
        } else {
            listOf(preferredBase) +
                resolveApiBaseCandidates(requestScope.savedUrl).filterNot { it == preferredBase }
        }

        for (baseUrl in candidates) {
            val request = Request.Builder()
                .url("$baseUrl$path")
                .get()
                .header("Accept", "application/json")
                .build()
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
                        parseResponse(body)
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
            preferredApiBaseUrl = activeApiBaseUrl
        )
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
    private fun deliverSnapshotIfCurrent(
        requestScope: RequestScope,
        baseUrl: String,
        events: List<NativeNotificationEvent>
    ): Boolean {
        if (!isRequestCurrentLocked(requestScope)) return false
        activeApiBaseUrl = baseUrl
        val shouldAlert = backgroundPrimed
        onSnapshot(events, shouldAlert)
        if (!isRequestCurrentLocked(requestScope)) return false
        backgroundPrimed = true
        return true
    }

    private fun invalidateRequestsLocked() {
        requestGeneration = nextNotificationRequestGeneration(requestGeneration)
        activePullCalls.forEach(Call::cancel)
        activePullCalls.clear()
    }

    private fun clientFor(baseUrl: String): OkHttpClient =
        if (LocalHttpsTrust.shouldUseFor(baseUrl)) localHttpsClient else client

    private fun parseResponse(body: String): List<NativeNotificationEvent> {
        val items = runCatching { JSONObject(body).optJSONArray("items") }.getOrNull()
            ?: return emptyList()
        val now = System.currentTimeMillis()
        return buildList {
            for (index in 0 until items.length()) {
                val item = items.optJSONObject(index) ?: continue
                val meta = item.optJSONObject("meta")
                val type = item.optString("type").trim()
                val eventType = meta?.optString("eventType")?.trim()
                val tone = NotificationTone.fromPayload(type, eventType)
                val title = item.optString("title").trim().ifBlank { defaultTitleFor(tone) }
                val text = item.optString("description").trim().ifBlank { title }
                val createdAt = readTimestamp(item).takeIf { it > 0L } ?: now
                val id = notificationIdentity(item, index, createdAt, tone, title, text)
                add(
                    NativeNotificationEvent(
                        id = id,
                        tone = tone,
                        title = title,
                        text = text,
                        createdAt = createdAt,
                        receivedAt = now
                    )
                )
            }
        }
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
            "clientApp" to "postazione",
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
        return "postazione-native:$userPart:$devicePart"
    }

    private fun normalizePart(value: String): String =
        value.trim()
            .lowercase(Locale.ROOT)
            .replace(Regex("[^a-z0-9_-]+"), "_")
            .ifBlank { "x" }

    private fun resolveApiBaseCandidates(savedUrl: String?): List<String> {
        if (savedUrl.isNullOrBlank()) return emptyList()
        return runCatching {
            val uri = URI(savedUrl)
            val scheme = uri.scheme?.takeIf { it.equals("http", true) || it.equals("https", true) }
                ?: "http"
            val host = uri.host ?: return@runCatching emptyList()
            val portPart = if (uri.port > 0) ":${uri.port}" else ""
            val origin = "$scheme://$host$portPart"
            val backendOrigin = "$scheme://$host:$DEFAULT_BACKEND_PORT"
            val httpBackendOrigin = "http://$host:$DEFAULT_BACKEND_PORT"
            listOf("$origin/api", "$backendOrigin/api", "$httpBackendOrigin/api").distinct()
        }.getOrElse { emptyList() }
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name())

    private fun defaultTitleFor(tone: NotificationTone): String = when (tone) {
        NotificationTone.WAITER -> "Chiamata cameriere"
        NotificationTone.BELL -> "Comanda pronta"
        NotificationTone.HANDHELD_RING -> "Chiamata postazione"
        NotificationTone.GENERAL -> "Notifica"
    }

    private companion object {
        const val TAG = "NativeNotificationPoller"
        const val DEFAULT_BACKEND_PORT = 5381
        const val POLL_INTERVAL_MS = 4_000L
        const val OFFLINE_POLL_MAX_INTERVAL_MS = 60_000L
        val TIMESTAMP_KEYS = listOf("createdAt", "created_at", "timestamp", "ts")
    }

    private data class RequestScope(
        val generation: Long,
        val context: NotificationClientContext,
        val savedUrl: String,
        val preferredApiBaseUrl: String?
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
