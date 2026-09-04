package com.sentrapa.webkiosk.bluetooth

import android.webkit.JavascriptInterface

class BluetoothFailoverUiBridge(
    private val stateProvider: () -> BluetoothAgentStateSnapshot
) {
    @JavascriptInterface
    fun getState(): String = stateProvider().toRedactedWebViewJson()

    companion object {
        const val BRIDGE_NAME = "V5BTBluetoothState"
        const val EVENT_NAME = "v5bt:bluetooth-connectivity"
    }
}
