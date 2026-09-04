package com.sentrapa.cassav6.webkiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.webkit.JavascriptInterface
import org.json.JSONObject

internal object NativeBatteryPolicy {
    fun percentage(level: Int, scale: Int): Int? {
        if (level < 0 || scale <= 0) return null
        return ((level * 100f) / scale).toInt().coerceIn(0, 100)
    }
}

internal data class NativeBatterySnapshot(
    val level: Int,
    val charging: Boolean,
    val deviceName: String,
    val observedAt: Long = System.currentTimeMillis()
) {
    fun hasSameState(other: NativeBatterySnapshot?): Boolean =
        other != null && level == other.level && charging == other.charging

    fun toPayloadJson(): String = JSONObject().apply {
        put("source", "android")
        put("level", level)
        put("charging", charging)
        put("deviceName", deviceName)
        put("observedAt", observedAt)
    }.toString()
}

internal class NativeBatterySnapshotReader(context: Context) {
    private val appContext = context.applicationContext
    private val deviceName = listOf(Build.MANUFACTURER.orEmpty().trim(), Build.MODEL.orEmpty().trim())
        .filter(String::isNotEmpty)
        .joinToString(" ")
        .ifBlank { "Android" }

    fun readCurrent(): NativeBatterySnapshot? =
        fromIntent(
            appContext.registerReceiver(
                null,
                IntentFilter(Intent.ACTION_BATTERY_CHANGED)
            )
        )

    fun fromIntent(intent: Intent?): NativeBatterySnapshot? {
        if (intent?.action != Intent.ACTION_BATTERY_CHANGED) return null
        val percentage = NativeBatteryPolicy.percentage(
            intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1),
            intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        ) ?: return null
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        return NativeBatterySnapshot(
            level = percentage,
            charging = charging,
            deviceName = deviceName
        )
    }
}

class NativeBatteryBridge internal constructor(
    private val snapshotProvider: () -> String
) {
    @JavascriptInterface
    fun getSnapshot(): String = snapshotProvider()
}

class NativeBatteryController(
    context: Context,
    private val onSnapshotChanged: (String) -> Unit
) {
    private val appContext = context.applicationContext
    private val snapshotReader = NativeBatterySnapshotReader(appContext)

    @Volatile
    private var currentSnapshot: NativeBatterySnapshot? = null

    @Volatile
    private var receiverRegistered = false

    val bridge = NativeBatteryBridge(::currentPayloadJson)

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            updateSnapshot(intent)
        }
    }

    @Synchronized
    fun start() {
        if (receiverRegistered) return
        val sticky = appContext.registerReceiver(
            receiver,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        )
        receiverRegistered = true
        updateSnapshot(sticky, force = true)
    }

    fun publishCurrent() {
        val snapshot = currentSnapshot ?: readCurrentSnapshot() ?: return
        currentSnapshot = snapshot
        onSnapshotChanged(snapshot.toPayloadJson())
    }

    @Synchronized
    fun close() {
        if (!receiverRegistered) return
        try {
            appContext.unregisterReceiver(receiver)
        } catch (_: IllegalArgumentException) {
            // Android aveva gia scollegato il receiver.
        } finally {
            receiverRegistered = false
        }
    }

    private fun currentPayloadJson(): String {
        val snapshot = currentSnapshot ?: readCurrentSnapshot() ?: return ""
        currentSnapshot = snapshot
        return snapshot.toPayloadJson()
    }

    private fun readCurrentSnapshot(): NativeBatterySnapshot? =
        snapshotReader.readCurrent()

    private fun updateSnapshot(intent: Intent?, force: Boolean = false) {
        val snapshot = snapshotReader.fromIntent(intent) ?: return
        val previous = currentSnapshot
        currentSnapshot = snapshot
        if (!force && snapshot.hasSameState(previous)) return
        onSnapshotChanged(snapshot.toPayloadJson())
    }

    companion object {
        const val BRIDGE_NAME = "AmaliaNativeBattery"
        const val EVENT_NAME = "amalia:native-battery"
    }
}
