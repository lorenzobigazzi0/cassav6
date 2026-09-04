package com.sentrapa.cassav6.webkiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.provider.Settings
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URI
import java.util.Locale
import java.util.concurrent.TimeUnit

internal object BatteryReportPolicy {
    const val INTERVAL_MS = 120_000L
    const val DUPLICATE_ATTEMPT_WINDOW_MS = 15_000L

    fun isPeriodicReportDue(nowMs: Long, lastSentAtMs: Long, lastAttemptAtMs: Long): Boolean {
        val lastReportAtMs = maxOf(lastSentAtMs, lastAttemptAtMs)
        return lastReportAtMs <= 0L || nowMs - lastReportAtMs >= INTERVAL_MS
    }

    fun nextPeriodicDelayMs(nowMs: Long, lastSentAtMs: Long, lastAttemptAtMs: Long): Long {
        val lastReportAtMs = maxOf(lastSentAtMs, lastAttemptAtMs)
        if (lastReportAtMs <= 0L) return INTERVAL_MS
        val elapsedMs = (nowMs - lastReportAtMs).coerceAtLeast(0L)
        return (INTERVAL_MS - elapsedMs).coerceAtLeast(1L)
    }
}

internal object BatteryReportEndpointPolicy {
    private const val BATTERY_SERVICE_PORT = 8965

    fun resolve(configuredPortalUrl: String?, requireHttpsPortal: Boolean): String? {
        val uri = configuredPortalUrl
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?.let { runCatching { URI(it) }.getOrNull() }
            ?: return null
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        if (scheme !in setOf("http", "https")) return null
        if (requireHttpsPortal && scheme != "https") return null
        if (uri.userInfo != null || uri.host.isNullOrBlank()) return null
        val host = uri.host
        val authorityHost = if (host.contains(':')) "[$host]" else host
        return "http://$authorityHost:$BATTERY_SERVICE_PORT/battery"
    }
}

class BatteryReporter(private val context: Context) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .writeTimeout(2, TimeUnit.SECONDS)
        .build()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val sendLock = Any()
    private var keepAliveJob: Job? = null

    @Volatile
    private var currentEndpoint: String? = null

    @Volatile
    private var webDeviceIdentifier: String? = null

    @Volatile
    private var receiverRegistered = false

    @Volatile
    private var lastObservedState: BatterySnapshot? = null

    private var lastSentAtMs = 0L
    private var lastAttemptSignature: String? = null
    private var lastAttemptAtMs = 0L
    private val nativeDeviceId = readNativeDeviceId()
    private val deviceName = readDeviceName()

    private val batteryReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != Intent.ACTION_BATTERY_CHANGED) return
            val state = readBatterySnapshot(intent) ?: return
            lastObservedState = state
        }
    }

    @Synchronized
    fun updateUrl(url: String?) {
        val endpoint = BatteryReportEndpointPolicy.resolve(
            configuredPortalUrl = url,
            requireHttpsPortal = BuildConfig.API31_COMPAT_NON_GATE_BUILD
        )
        if (endpoint == null) {
            stop()
            return
        }
        if (endpoint != currentEndpoint) {
            currentEndpoint = endpoint
            start()
        }
    }

    fun updateDeviceIdentifier(identifier: String?) {
        val normalized = identifier?.trim()?.takeIf { it.isNotEmpty() }
        if (normalized == webDeviceIdentifier) return
        webDeviceIdentifier = normalized
        if (currentEndpoint != null) scope.launch { sendBatteryStatus(force = true) }
    }

    fun close() {
        stop()
        scope.cancel()
    }

    @Synchronized
    private fun start() {
        registerBatteryReceiver()
        keepAliveJob?.cancel()
        keepAliveJob = scope.launch {
            sendBatteryStatus(force = true)
            while (isActive) {
                delay(nextPeriodicDelayMs())
                sendBatteryStatus()
            }
        }
    }

    @Synchronized
    private fun stop() {
        keepAliveJob?.cancel()
        keepAliveJob = null
        unregisterBatteryReceiver()
        currentEndpoint = null
        synchronized(sendLock) {
            lastSentAtMs = 0L
            lastAttemptSignature = null
            lastAttemptAtMs = 0L
        }
    }

    private fun registerBatteryReceiver() {
        if (receiverRegistered) return
        val sticky = context.registerReceiver(
            batteryReceiver,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        )
        receiverRegistered = true
        readBatterySnapshot(sticky)?.let { lastObservedState = it }
    }

    private fun unregisterBatteryReceiver() {
        if (!receiverRegistered) return
        try {
            context.unregisterReceiver(batteryReceiver)
        } catch (_: IllegalArgumentException) {
            // Android had already detached the receiver.
        } finally {
            receiverRegistered = false
        }
    }

    private fun sendBatteryStatus(force: Boolean = false) {
        val state = lastObservedState ?: readBatterySnapshotFromSystem() ?: return
        sendBatteryStatus(state, force)
    }

    private fun nextPeriodicDelayMs(): Long = synchronized(sendLock) {
        BatteryReportPolicy.nextPeriodicDelayMs(
            nowMs = System.currentTimeMillis(),
            lastSentAtMs = lastSentAtMs,
            lastAttemptAtMs = lastAttemptAtMs
        )
    }

    private fun sendBatteryStatus(state: BatterySnapshot, force: Boolean = false) {
        synchronized(sendLock) {
            val endpoint = currentEndpoint ?: return
            val now = System.currentTimeMillis()
            val deviceId = webDeviceIdentifier ?: nativeDeviceId
            val signature = "${state.signature()}|$deviceId"
            if (
                !force &&
                !BatteryReportPolicy.isPeriodicReportDue(now, lastSentAtMs, lastAttemptAtMs)
            ) {
                return
            }
            if (
                signature == lastAttemptSignature &&
                now - lastAttemptAtMs < BatteryReportPolicy.DUPLICATE_ATTEMPT_WINDOW_MS
            ) {
                return
            }
            lastAttemptSignature = signature
            lastAttemptAtMs = now
            val batteryLevel: Any = if (state.level >= 0) state.level else JSONObject.NULL
            val json = JSONObject().apply {
                put("battery_level", batteryLevel)
                put("level", batteryLevel)
                put("percentage", batteryLevel)
                put("charging", state.charging)
                put("isCharging", state.charging)
                put("device", deviceName)
                put("name", deviceName)
                put("deviceName", deviceName)
                put("device_id", deviceId)
                put("deviceId", deviceId)
                put("deviceUuid", deviceId)
                put("platform", "android")
                put("clientApp", "webkiosk-advanced")
            }
            val request = Request.Builder()
                .url(endpoint)
                .post(json.toString().toRequestBody(JSON_MEDIA_TYPE))
                .build()

            try {
                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        Log.e(TAG, "Failed to report battery: ${response.code}")
                        return
                    }
                }
                // Anchor the next interval to delivery completion so network latency
                // can never make two server-side notifications arrive too close.
                lastSentAtMs = System.currentTimeMillis()
            } catch (error: Exception) {
                Log.e(TAG, "Error reporting battery: ${error.message}")
            }
        }
    }

    private fun readBatterySnapshotFromSystem(): BatterySnapshot? =
        readBatterySnapshot(context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)))

    private fun readBatterySnapshot(intent: Intent?): BatterySnapshot? {
        if (intent == null) return null
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val percentage = if (level >= 0 && scale > 0) {
            ((level * 100f) / scale).toInt().coerceIn(0, 100)
        } else {
            -1
        }
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        return BatterySnapshot(percentage, charging)
    }

    private fun readNativeDeviceId(): String {
        val androidId = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ANDROID_ID
        )?.trim()?.takeIf {
            it.isNotEmpty() && it.lowercase(Locale.ROOT) != "9774d56d682e549c"
        }
        return androidId ?: "android-${Build.MANUFACTURER}-${Build.MODEL}"
            .lowercase(Locale.ROOT)
            .replace(Regex("[^a-z0-9_-]+"), "-")
            .trim('-')
            .ifBlank { "android-device" }
    }

    private fun readDeviceName(): String =
        listOf(Build.MANUFACTURER.orEmpty().trim(), Build.MODEL.orEmpty().trim())
            .filter(String::isNotEmpty)
            .joinToString(" ")
            .ifBlank { "Android" }

    private data class BatterySnapshot(
        val level: Int,
        val charging: Boolean
    ) {
        fun signature(): String = "$level|${if (charging) "charging" else "not-charging"}"
    }

    private companion object {
        const val TAG = "BatteryReporter"
        val JSON_MEDIA_TYPE = "application/json".toMediaType()
    }
}
