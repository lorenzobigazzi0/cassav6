package com.sentrapa.webkiosk.bluetooth

enum class BluetoothDiscoveryReadiness {
    READY,
    DISCOVERY_FEATURE_DISABLED,
    IDENTITY_FEATURE_DISABLED,
    PLATFORM_UNSUPPORTED,
    IDENTITY_NOT_READY,
    BLE_HARDWARE_UNAVAILABLE,
    PERMISSIONS_REQUIRED,
    ADAPTER_DISABLED,
    CAPABILITY_NOT_FULL_NODE
}

data class BluetoothDiscoveryPrerequisiteInput(
    val discoveryFeatureEnabled: Boolean,
    val identityFeatureEnabled: Boolean,
    val androidApi: Int,
    val platformProfile: BluetoothDiscoveryPlatformProfile =
        BluetoothDiscoveryPlatformProfile.CERTIFIED,
    val identityReady: Boolean,
    val bluetoothLeFeature: Boolean,
    val adapterPresent: Boolean,
    val adapterEnabled: Boolean,
    val scanPermission: Boolean,
    val advertisePermission: Boolean,
    val connectPermission: Boolean,
    val nodeClass: BluetoothNodeClass?
)

object BluetoothDiscoveryPrerequisitePolicy {
    fun evaluate(input: BluetoothDiscoveryPrerequisiteInput): BluetoothDiscoveryReadiness =
        when {
            !input.discoveryFeatureEnabled ->
                BluetoothDiscoveryReadiness.DISCOVERY_FEATURE_DISABLED
            !input.identityFeatureEnabled ->
                BluetoothDiscoveryReadiness.IDENTITY_FEATURE_DISABLED
            input.androidApi < input.platformProfile.minimumAndroidApi ->
                BluetoothDiscoveryReadiness.PLATFORM_UNSUPPORTED
            !input.identityReady ->
                BluetoothDiscoveryReadiness.IDENTITY_NOT_READY
            !input.bluetoothLeFeature || !input.adapterPresent ->
                BluetoothDiscoveryReadiness.BLE_HARDWARE_UNAVAILABLE
            !input.scanPermission ||
                !input.advertisePermission ||
                !input.connectPermission ->
                BluetoothDiscoveryReadiness.PERMISSIONS_REQUIRED
            !input.adapterEnabled ->
                BluetoothDiscoveryReadiness.ADAPTER_DISABLED
            input.nodeClass != BluetoothNodeClass.FULL_NODE ->
                BluetoothDiscoveryReadiness.CAPABILITY_NOT_FULL_NODE
            else ->
                BluetoothDiscoveryReadiness.READY
        }

    fun mayUseConnectedDeviceForegroundService(
        input: BluetoothDiscoveryPrerequisiteInput
    ): Boolean = evaluate(input) == BluetoothDiscoveryReadiness.READY
}
