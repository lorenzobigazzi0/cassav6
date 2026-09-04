package com.sentrapa.cassav6.webkiosk.bluetooth

import android.webkit.JavascriptInterface

class BluetoothFailoverUiBridge(
    private val stateProvider: () -> BluetoothAgentStateSnapshot
) {
    @JavascriptInterface
    fun getState(): String = stateProvider().toRedactedWebViewJson()

    companion object {
        const val BRIDGE_NAME = "CassaV6BluetoothState"
        const val EVENT_NAME = "cassav6:bluetooth-connectivity"
    }
}
