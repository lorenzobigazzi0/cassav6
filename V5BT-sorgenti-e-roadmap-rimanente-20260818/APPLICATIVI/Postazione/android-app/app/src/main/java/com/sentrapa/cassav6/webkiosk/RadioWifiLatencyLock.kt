package com.sentrapa.cassav6.webkiosk

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log

class RadioWifiLatencyLock(context: Context) {
    private val wifiManager =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    private var wifiLock: WifiManager.WifiLock? = null

    @Synchronized
    fun acquire() {
        if (wifiLock?.isHeld == true) return
        val manager = wifiManager ?: return
        runCatching {
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = manager.createWifiLock(mode, "WebKiosk:RadioLowLatency").apply {
                setReferenceCounted(false)
                acquire()
            }
        }.onFailure { error ->
            Log.w(TAG, "Unable to acquire radio Wi-Fi latency lock: ${error.message}")
        }
    }

    @Synchronized
    fun release() {
        wifiLock?.let { lock ->
            runCatching { if (lock.isHeld) lock.release() }
                .onFailure { error ->
                    Log.w(TAG, "Unable to release radio Wi-Fi latency lock: ${error.message}")
                }
        }
        wifiLock = null
    }

    private companion object {
        const val TAG = "RadioWifiLatencyLock"
    }
}
