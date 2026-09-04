package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BluetoothNodeClassifierTest {
    @Test
    fun `classifier covers every capability combination`() {
        for (mask in 0 until 16) {
            val capabilities = BluetoothNodeCapabilities(
                scan = mask and 1 != 0,
                advertise = mask and 2 != 0,
                gattClient = mask and 4 != 0,
                gattServer = mask and 8 != 0
            )
            val expected =
                when {
                    capabilities.scan &&
                        capabilities.advertise &&
                        capabilities.gattClient &&
                        capabilities.gattServer -> BluetoothNodeClass.FULL_NODE
                    capabilities.scan && capabilities.gattClient ->
                        BluetoothNodeClass.CLIENT_ONLY
                    else -> BluetoothNodeClass.UNSUPPORTED
                }

            assertEquals(
                "Unexpected classification for capability mask $mask",
                expected,
                BluetoothNodeClassifier.classify(capabilities)
            )
        }
    }

    @Test
    fun `complete probe reports a full node`() {
        val assessment = BluetoothCapabilityAssessmentPolicy.assess(completeObservation())

        assertEquals(BluetoothProbeStatus.COMPLETE, assessment.status)
        assertEquals(BluetoothNodeClass.FULL_NODE, assessment.classification)
        assertEquals(
            BluetoothNodeCapabilities(
                scan = true,
                advertise = true,
                gattClient = true,
                gattServer = true
            ),
            assessment.capabilities
        )
    }

    @Test
    fun `missing advertise permission does not masquerade as client only`() {
        val assessment = BluetoothCapabilityAssessmentPolicy.assess(
            completeObservation(advertisePermission = false)
        )

        assertEquals(BluetoothProbeStatus.PERMISSIONS_REQUIRED, assessment.status)
        assertNull(assessment.capabilities)
        assertNull(assessment.classification)
    }

    @Test
    fun `disabled adapter remains unclassified`() {
        val assessment = BluetoothCapabilityAssessmentPolicy.assess(
            completeObservation(adapterEnabled = false)
        )

        assertEquals(BluetoothProbeStatus.BLUETOOTH_DISABLED, assessment.status)
        assertNull(assessment.capabilities)
        assertNull(assessment.classification)
    }

    @Test
    fun `missing BLE hardware is definitively unsupported`() {
        val assessment = BluetoothCapabilityAssessmentPolicy.assess(
            completeObservation(
                bluetoothLeFeature = false,
                adapterPresent = false,
                adapterEnabled = null,
                scannerAvailable = null,
                advertiserAvailable = null,
                gattClientAvailable = null,
                gattServerOpen = null
            )
        )

        assertEquals(BluetoothProbeStatus.UNSUPPORTED_HARDWARE, assessment.status)
        assertEquals(BluetoothNodeClass.UNSUPPORTED, assessment.classification)
        assertEquals(
            BluetoothNodeCapabilities(
                scan = false,
                advertise = false,
                gattClient = false,
                gattServer = false
            ),
            assessment.capabilities
        )
    }

    @Test
    fun `scanner with GATT client and no advertiser is client only`() {
        val assessment = BluetoothCapabilityAssessmentPolicy.assess(
            completeObservation(
                advertiserAvailable = false,
                gattServerOpen = false
            )
        )

        assertEquals(BluetoothProbeStatus.COMPLETE, assessment.status)
        assertEquals(
            BluetoothNodeClass.CLIENT_ONLY,
            assessment.classification
        )
    }

    @Test
    fun `unknown GATT server result keeps probe incomplete`() {
        val assessment = BluetoothCapabilityAssessmentPolicy.assess(
            completeObservation(gattServerOpen = null)
        )

        assertEquals(BluetoothProbeStatus.PROBE_INCOMPLETE, assessment.status)
        assertNull(assessment.capabilities)
        assertNull(assessment.classification)
    }

    @Test
    fun `discovery classification does not require opening a GATT server`() {
        assertEquals(
            BluetoothNodeClass.FULL_NODE,
            BluetoothDiscoveryNodeClassifier.classifyNonInvasively(
                scannerAvailable = true,
                advertiserAvailable = true,
                gattClientAvailable = true
            )
        )
        assertEquals(
            BluetoothNodeClass.CLIENT_ONLY,
            BluetoothDiscoveryNodeClassifier.classifyNonInvasively(
                scannerAvailable = true,
                advertiserAvailable = false,
                gattClientAvailable = true
            )
        )
        assertNull(
            BluetoothDiscoveryNodeClassifier.classifyNonInvasively(
                scannerAvailable = true,
                advertiserAvailable = null,
                gattClientAvailable = true
            )
        )
    }

    private fun completeObservation(
        bluetoothLeFeature: Boolean = true,
        adapterPresent: Boolean = true,
        adapterEnabled: Boolean? = true,
        scanPermission: Boolean = true,
        advertisePermission: Boolean = true,
        connectPermission: Boolean = true,
        scannerAvailable: Boolean? = true,
        advertiserAvailable: Boolean? = true,
        gattClientAvailable: Boolean? = true,
        gattServerOpen: Boolean? = true
    ) = BluetoothCapabilityObservation(
        bluetoothLeFeature = bluetoothLeFeature,
        adapterPresent = adapterPresent,
        adapterEnabled = adapterEnabled,
        scanPermission = scanPermission,
        advertisePermission = advertisePermission,
        connectPermission = connectPermission,
        scannerAvailable = scannerAvailable,
        advertiserAvailable = advertiserAvailable,
        gattClientAvailable = gattClientAvailable,
        gattServerOpen = gattServerOpen
    )
}
