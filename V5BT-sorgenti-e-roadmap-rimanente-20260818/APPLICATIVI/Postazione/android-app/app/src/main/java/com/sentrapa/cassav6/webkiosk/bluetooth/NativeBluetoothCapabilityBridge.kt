package com.sentrapa.cassav6.webkiosk.bluetooth

import android.content.Context
import android.webkit.JavascriptInterface

class NativeBluetoothCapabilityBridge(
    context: Context,
    private val allowGattServerProbe: Boolean = true
) {
    private val probe = BluetoothCapabilityProbe(context)

    @JavascriptInterface
    fun getCapabilityReport(): String =
        probe.probe(probeGattServer = allowGattServerProbe).toJson()

    companion object {
        const val BRIDGE_NAME = "CassaBluetoothDiagnostics"
    }
}

internal fun shouldAllowGattServerCapabilityProbe(
    diagnosticsEnabled: Boolean,
    labBuild: Boolean
): Boolean = diagnosticsEnabled && labBuild
