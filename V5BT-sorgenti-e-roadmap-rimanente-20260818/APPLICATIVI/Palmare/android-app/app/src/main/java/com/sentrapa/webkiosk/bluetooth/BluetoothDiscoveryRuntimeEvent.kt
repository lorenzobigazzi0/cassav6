package com.sentrapa.webkiosk.bluetooth

enum class BluetoothDiscoveryLifecycle {
    STARTING,
    ACTIVE,
    NOT_READY,
    BACKOFF,
    STOPPED
}

data class BluetoothDiscoveryRuntimeEvent(
    val lifecycle: BluetoothDiscoveryLifecycle,
    val readiness: BluetoothDiscoveryReadiness
)
