package com.sentrapa.cassav6.webkiosk.bluetooth

enum class BluetoothNodeClass {
    FULL_NODE,
    CLIENT_ONLY,
    UNSUPPORTED
}

enum class BluetoothProbeStatus {
    COMPLETE,
    UNSUPPORTED_HARDWARE,
    PERMISSIONS_REQUIRED,
    BLUETOOTH_DISABLED,
    PROBE_INCOMPLETE
}

data class BluetoothNodeCapabilities(
    val scan: Boolean,
    val advertise: Boolean,
    val gattClient: Boolean,
    val gattServer: Boolean
)

data class BluetoothCapabilityObservation(
    val bluetoothLeFeature: Boolean,
    val adapterPresent: Boolean,
    val adapterEnabled: Boolean?,
    val scanPermission: Boolean,
    val advertisePermission: Boolean,
    val connectPermission: Boolean,
    val scannerAvailable: Boolean?,
    val advertiserAvailable: Boolean?,
    val gattClientAvailable: Boolean?,
    val gattServerOpen: Boolean?
)

data class BluetoothCapabilityAssessment(
    val status: BluetoothProbeStatus,
    val capabilities: BluetoothNodeCapabilities?,
    val classification: BluetoothNodeClass?
)

object BluetoothNodeClassifier {
    fun classify(capabilities: BluetoothNodeCapabilities): BluetoothNodeClass =
        when {
            capabilities.scan &&
                capabilities.advertise &&
                capabilities.gattClient &&
                capabilities.gattServer -> BluetoothNodeClass.FULL_NODE
            capabilities.scan && capabilities.gattClient -> BluetoothNodeClass.CLIENT_ONLY
            else -> BluetoothNodeClass.UNSUPPORTED
        }
}

object BluetoothDiscoveryNodeClassifier {
    fun classifyNonInvasively(
        scannerAvailable: Boolean?,
        advertiserAvailable: Boolean?,
        gattClientAvailable: Boolean?
    ): BluetoothNodeClass? {
        if (
            scannerAvailable == null ||
            advertiserAvailable == null ||
            gattClientAvailable == null
        ) {
            return null
        }
        return when {
            scannerAvailable && advertiserAvailable && gattClientAvailable ->
                BluetoothNodeClass.FULL_NODE
            scannerAvailable && gattClientAvailable ->
                BluetoothNodeClass.CLIENT_ONLY
            else ->
                BluetoothNodeClass.UNSUPPORTED
        }
    }
}

object BluetoothCapabilityAssessmentPolicy {
    fun assess(observation: BluetoothCapabilityObservation): BluetoothCapabilityAssessment {
        if (!observation.bluetoothLeFeature || !observation.adapterPresent) {
            val capabilities = BluetoothNodeCapabilities(
                scan = false,
                advertise = false,
                gattClient = false,
                gattServer = false
            )
            return BluetoothCapabilityAssessment(
                status = BluetoothProbeStatus.UNSUPPORTED_HARDWARE,
                capabilities = capabilities,
                classification = BluetoothNodeClassifier.classify(capabilities)
            )
        }

        if (
            !observation.scanPermission ||
            !observation.advertisePermission ||
            !observation.connectPermission
        ) {
            return BluetoothCapabilityAssessment(
                status = BluetoothProbeStatus.PERMISSIONS_REQUIRED,
                capabilities = null,
                classification = null
            )
        }

        if (observation.adapterEnabled == false) {
            return BluetoothCapabilityAssessment(
                status = BluetoothProbeStatus.BLUETOOTH_DISABLED,
                capabilities = null,
                classification = null
            )
        }

        if (
            observation.adapterEnabled == null ||
            observation.scannerAvailable == null ||
            observation.advertiserAvailable == null ||
            observation.gattClientAvailable == null ||
            observation.gattServerOpen == null
        ) {
            return BluetoothCapabilityAssessment(
                status = BluetoothProbeStatus.PROBE_INCOMPLETE,
                capabilities = null,
                classification = null
            )
        }

        val capabilities = BluetoothNodeCapabilities(
            scan = observation.scannerAvailable,
            advertise = observation.advertiserAvailable,
            gattClient = observation.gattClientAvailable,
            gattServer = observation.gattServerOpen
        )
        return BluetoothCapabilityAssessment(
            status = BluetoothProbeStatus.COMPLETE,
            capabilities = capabilities,
            classification = BluetoothNodeClassifier.classify(capabilities)
        )
    }
}
