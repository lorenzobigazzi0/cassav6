package com.sentrapa.webkiosk

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.net.URI
import java.util.Locale
import java.util.concurrent.TimeUnit

internal fun resolveRadioApiBaseCandidates(savedUrl: String?): List<String> {
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

internal fun buildRadioWebSocketUrl(apiBaseUrl: String): String {
    val origin = apiBaseUrl.trimEnd('/').removeSuffix("/api")
    val wsOrigin = when {
        origin.startsWith("https://", true) -> "wss://${origin.substringAfter("://")}" 
        origin.startsWith("http://", true) -> "ws://${origin.substringAfter("://")}" 
        else -> origin
    }
    return "$wsOrigin/api/radio/ws"
}

class NativeBackgroundRadioReceiver(context: Context) {
    private val player = NativeRadioPlaybackPlayer(context.applicationContext)
    private val wifiLatencyLock = RadioWifiLatencyLock(context.applicationContext)
    private val client = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .writeTimeout(4, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()
    private val localHttpsClient = LocalHttpsTrust.configure(
        OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .writeTimeout(4, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
    ).build()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var job: Job? = null
    private var socket: WebSocket? = null

    @Volatile
    private var savedUrl: String? = null

    @Volatile
    private var notificationContext = NotificationClientContext()

    @Volatile
    private var appForeground = AppForegroundState.isForeground

    @Volatile
    private var activeApiBaseUrl: String? = null

    @Volatile
    private var activeStreamId: Int? = null

    @Volatile
    private var primaryChannelId: String? = null

    @Volatile
    private var sessionEpoch = 0L

    @Synchronized
    fun update(savedUrl: String?, notificationContext: NotificationClientContext) {
        val normalizedUrl = savedUrl?.trim()?.takeIf { it.isNotEmpty() }
        if (
            this.savedUrl != normalizedUrl ||
            this.notificationContext.identityKey != notificationContext.identityKey
        ) {
            activeApiBaseUrl = null
            primaryChannelId = null
            stop()
        }
        this.savedUrl = normalizedUrl
        this.notificationContext = notificationContext
        syncRunningState()
    }

    @Synchronized
    fun updateForeground(isForeground: Boolean) {
        appForeground = isForeground
        syncRunningState()
    }

    fun close() {
        stop()
        player.close()
        wifiLatencyLock.release()
        scope.cancel()
    }

    @Synchronized
    private fun syncRunningState() {
        if (canRun()) start() else stop()
    }

    @Synchronized
    private fun start() {
        if (job?.isActive == true) return
        wifiLatencyLock.acquire()
        val startEpoch = sessionEpoch
        job = scope.launch { runLoop(startEpoch) }
    }

    @Synchronized
    private fun stop() {
        sessionEpoch += 1
        job?.cancel()
        job = null
        socket?.close(1000, "foreground")
        socket = null
        activeStreamId = null
        player.stop()
        wifiLatencyLock.release()
    }

    private fun canRun(): Boolean =
        !appForeground && !savedUrl.isNullOrBlank() && notificationContext.canUseRadio

    private fun isSessionCurrent(session: RadioSession): Boolean =
        sessionEpoch == session.epoch &&
            notificationContext.identityKey == session.context.identityKey &&
            savedUrl == session.savedUrl &&
            canRun()

    private suspend fun runLoop(startEpoch: Long) {
        while (currentCoroutineContext().isActive) {
            val session = synchronized(this) {
                if (sessionEpoch != startEpoch || !canRun()) return
                RadioSession(sessionEpoch, savedUrl, notificationContext)
            }
            try {
                val config = fetchRadioConfig(session)
                if (!isSessionCurrent(session)) break
                if (config.channelIds.isEmpty()) {
                    delay(IDLE_CONFIG_DELAY_MS)
                    continue
                }
                synchronized(this) {
                    if (isSessionCurrent(session)) {
                        primaryChannelId = config.channelIds.firstOrNull()
                    }
                }
                if (!isSessionCurrent(session)) break
                connectAndReceive(config, session)
            } catch (error: Exception) {
                Log.d(TAG, "Native radio background reconnect: ${error.message}")
                synchronized(this) {
                    if (isSessionCurrent(session)) {
                        activeStreamId = null
                        player.stop()
                    }
                }
                if (!isSessionCurrent(session)) break
                delay(RECONNECT_DELAY_MS)
            }
        }
    }

    private fun fetchRadioConfig(session: RadioSession): RadioConfig {
        val contextSnapshot = session.context
        val preferredBase = activeApiBaseUrl
        val candidates = if (preferredBase.isNullOrBlank()) {
            resolveApiBaseCandidates(session.savedUrl)
        } else {
            listOf(preferredBase) +
                resolveApiBaseCandidates(session.savedUrl).filterNot { it == preferredBase }
        }
        val payload = JSONObject()
            .put("token", contextSnapshot.token)
            .put("userId", contextSnapshot.userId)
            .put("deviceUuid", contextSnapshot.deviceUuid)
            .put("clientApp", RADIO_CLIENT_APP)
            .toString()
            .toRequestBody(JSON_MEDIA_TYPE)

        for (baseUrl in candidates) {
            val request = Request.Builder()
                .url("${baseUrl.trimEnd('/')}/mobile/radio/config")
                .post(payload)
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer ${contextSnapshot.token}")
                .header("X-User-Id", contextSnapshot.userId)
                .header("X-Device-Uuid", contextSnapshot.deviceUuid)
                .build()
            try {
                clientFor(baseUrl).newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@use
                    val config = parseRadioConfig(response.body?.string().orEmpty())
                    synchronized(this) {
                        if (isSessionCurrent(session)) {
                            activeApiBaseUrl = baseUrl
                            return config.copy(apiBaseUrl = baseUrl)
                        }
                    }
                    return RadioConfig(apiBaseUrl = "", channelIds = emptyList())
                }
            } catch (error: Exception) {
                Log.d(TAG, "Native radio config failed at $baseUrl: ${error.message}")
            }
        }
        return RadioConfig(apiBaseUrl = "", channelIds = emptyList())
    }

    private suspend fun connectAndReceive(config: RadioConfig, session: RadioSession) {
        if (config.apiBaseUrl.isBlank() || config.channelIds.isEmpty()) return
        val contextSnapshot = session.context
        val closed = CompletableDeferred<Unit>()
        val request = Request.Builder()
            .url(buildRadioWebSocketUrl(config.apiBaseUrl))
            .build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                synchronized(this@NativeBackgroundRadioReceiver) {
                    if (!isSessionCurrent(session)) {
                        webSocket.close(1000, "inactive-session")
                        return
                    }
                    socket = webSocket
                    webSocket.send(
                        JSONObject()
                            .put("type", "hello")
                            .put("token", contextSnapshot.token)
                            .put("userId", contextSnapshot.userId)
                            .put("deviceUuid", contextSnapshot.deviceUuid)
                            .put("clientApp", RADIO_CLIENT_APP)
                            .put("protocolVersion", RADIO_PROTOCOL_VERSION)
                            .toString()
                    )
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleJsonMessage(webSocket, text, config.channelIds, session)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                handleBinaryMessage(webSocket, bytes.toByteArray(), session)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                synchronized(this@NativeBackgroundRadioReceiver) {
                    if (socket === webSocket) socket = null
                }
                if (!closed.isCompleted) closed.complete(Unit)
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                synchronized(this@NativeBackgroundRadioReceiver) {
                    if (socket === webSocket) socket = null
                }
                if (!closed.isCompleted) closed.complete(Unit)
            }
        }
        val newSocket = clientFor(config.apiBaseUrl).newWebSocket(request, listener)
        synchronized(this) {
            if (isSessionCurrent(session)) {
                socket = newSocket
            } else {
                newSocket.cancel()
            }
        }
        closed.await()
    }

    @Synchronized
    private fun handleJsonMessage(
        webSocket: WebSocket,
        text: String,
        channelIds: List<String>,
        session: RadioSession
    ) {
        if (!isSessionCurrent(session)) {
            webSocket.close(1000, "inactive-session")
            return
        }
        val message = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (message.optString("type")) {
            "ready" -> webSocket.send(
                JSONObject()
                    .put("type", "subscribe")
                    .put("channelIds", org.json.JSONArray(channelIds))
                    .toString()
            )
            "ptt:incoming-start" -> handleIncomingStart(message)
            "ptt:incoming-stop" -> handleIncomingStop(message)
        }
    }

    private fun handleIncomingStart(message: JSONObject) {
        val streamId = message.optInt("streamId", 0).takeIf { it > 0 } ?: return
        val channelId = normalizePart(message.optString("channelId"))
        val current = activeStreamId
        val primary = primaryChannelId
        if (current == null || (primary != null && channelId == primary)) {
            if (current != null && current != streamId) player.stop()
            activeStreamId = streamId
        }
    }

    private fun handleIncomingStop(message: JSONObject) {
        val streamId = message.optInt("streamId", 0)
        if (streamId > 0 && activeStreamId == streamId) {
            activeStreamId = null
            player.finish()
        }
    }

    @Synchronized
    private fun handleBinaryMessage(webSocket: WebSocket, frame: ByteArray, session: RadioSession) {
        if (!isSessionCurrent(session)) {
            webSocket.close(1000, "inactive-session")
            return
        }
        val streamId = readStreamId(frame) ?: return
        if (streamId == activeStreamId) player.playFrame(frame)
    }

    private fun readStreamId(frame: ByteArray): Int? {
        if (frame.size < RADIO_FRAME_HEADER_BYTES) return null
        if (
            frame[0].toInt().toChar() != 'R' ||
            frame[1].toInt().toChar() != 'P' ||
            frame[2].toInt().toChar() != 'T' ||
            frame[3].toInt().toChar() != '1'
        ) {
            return null
        }
        return ((frame[4].toInt() and 0xff) shl 24) or
            ((frame[5].toInt() and 0xff) shl 16) or
            ((frame[6].toInt() and 0xff) shl 8) or
            (frame[7].toInt() and 0xff)
    }

    private fun parseRadioConfig(body: String): RadioConfig {
        val root = JSONObject(body)
        val enabled = LinkedHashSet<String>()
        root.optJSONArray("channels")?.let { channels ->
            for (index in 0 until channels.length()) {
                val channel = channels.optJSONObject(index) ?: continue
                val id = normalizePart(channel.optString("id"))
                if (id.isNotBlank() && channel.optBoolean("enabled", true)) enabled.add(id)
            }
        }
        val selected = ArrayList<String>()
        root.optJSONArray("slots")?.let { slots ->
            for (index in 0 until slots.length()) {
                val id = normalizePart(slots.optString(index))
                if (id.isNotBlank() && id in enabled && id !in selected) selected.add(id)
            }
        }
        return RadioConfig(apiBaseUrl = "", channelIds = selected)
    }

    private fun clientFor(baseUrl: String): OkHttpClient =
        if (LocalHttpsTrust.shouldUseFor(baseUrl)) localHttpsClient else client

    private fun resolveApiBaseCandidates(savedUrl: String?): List<String> {
        return resolveRadioApiBaseCandidates(savedUrl)
    }

    private fun normalizePart(value: String): String = value.trim().lowercase(Locale.ROOT)

    private data class RadioConfig(
        val apiBaseUrl: String,
        val channelIds: List<String>
    )

    private data class RadioSession(
        val epoch: Long,
        val savedUrl: String?,
        val context: NotificationClientContext
    )

    private companion object {
        const val TAG = "NativeBackgroundRadio"
        const val RADIO_CLIENT_APP = "mobile-frontend"
        const val RADIO_PROTOCOL_VERSION = 1
        const val RADIO_FRAME_HEADER_BYTES = 16
        const val RECONNECT_DELAY_MS = 2_500L
        const val IDLE_CONFIG_DELAY_MS = 10_000L
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
