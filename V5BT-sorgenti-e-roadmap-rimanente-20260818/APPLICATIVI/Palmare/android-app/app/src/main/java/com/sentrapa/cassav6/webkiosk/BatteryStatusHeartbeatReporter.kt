package com.sentrapa.cassav6.webkiosk

import android.content.Context
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

internal object BatteryHeartbeatPolicy {
    const val INTERVAL_MS = 120_000L

    fun resolveHost(url: String?): String? {
        if (url.isNullOrBlank()) return null
        return runCatching {
            val uri = URI(url)
            uri.host ?: url.substringAfter("://").substringBefore("/").substringBefore(":")
        }.getOrNull()?.trim()?.takeIf { it.isNotEmpty() }
    }
}

class BatteryStatusHeartbeatReporter(context: Context) {
    private val appContext = context.applicationContext
    private val snapshotReader = NativeBatterySnapshotReader(appContext)
    private val client = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .writeTimeout(2, TimeUnit.SECONDS)
        .build()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var heartbeatJob: Job? = null

    @Volatile
    private var currentHost: String? = null

    @Synchronized
    fun updateUrl(url: String?) {
        val nextHost = BatteryHeartbeatPolicy.resolveHost(url)
        if (nextHost == null) {
            stop()
            return
        }
        if (currentHost == nextHost && heartbeatJob?.isActive == true) return
        currentHost = nextHost
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            sendHeartbeat()
            while (isActive) {
                delay(BatteryHeartbeatPolicy.INTERVAL_MS)
                sendHeartbeat()
            }
        }
    }

    fun close() {
        stop()
        scope.cancel()
    }

    @Synchronized
    private fun stop() {
        heartbeatJob?.cancel()
        heartbeatJob = null
        currentHost = null
    }

    private fun sendHeartbeat() {
        val host = currentHost ?: return
        val snapshot = snapshotReader.readCurrent() ?: return
        val deviceId = KioskPreferences.getNotificationClientContext(appContext).deviceUuid
            .trim()
            .ifBlank(::readNativeDeviceId)
        val payload = JSONObject().apply {
            put("battery_level", snapshot.level)
            put("charging", snapshot.charging)
            put("device", snapshot.deviceName)
            put("device_id", deviceId)
            put("platform", "android")
            put("clientApp", "palmare")
        }
        val request = Request.Builder()
            .url("http://$host:8965/battery")
            .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "Heartbeat batteria rifiutato: HTTP ${response.code}")
                }
            }
        } catch (error: Exception) {
            Log.w(TAG, "Heartbeat batteria non inviato: ${error.message}")
        }
    }

    private fun readNativeDeviceId(): String {
        val androidId = Settings.Secure.getString(
            appContext.contentResolver,
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

    private companion object {
        const val TAG = "BatteryHeartbeat"
        val JSON_MEDIA_TYPE = "application/json".toMediaType()
    }
}
