package com.sentrapa.cassav6.webkiosk.bluetooth

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
