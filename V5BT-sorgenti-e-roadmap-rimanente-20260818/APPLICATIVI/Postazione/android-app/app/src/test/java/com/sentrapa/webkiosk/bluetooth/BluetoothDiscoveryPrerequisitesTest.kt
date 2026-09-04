package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothDiscoveryPrerequisitesTest {
    @Test
    fun `all gates must be satisfied before radio and connectedDevice type`() {
        val ready = readyInput()

        assertEquals(
            BluetoothDiscoveryReadiness.READY,
            BluetoothDiscoveryPrerequisitePolicy.evaluate(ready)
        )
        assertTrue(
            BluetoothDiscoveryPrerequisitePolicy
                .mayUseConnectedDeviceForegroundService(ready)
        )
    }

    @Test
    fun `feature and identity gates fail closed in order`() {
        assertEquals(
            BluetoothDiscoveryReadiness.DISCOVERY_FEATURE_DISABLED,
            BluetoothDiscoveryPrerequisitePolicy.evaluate(
                readyInput().copy(discoveryFeatureEnabled = false)
            )
        )
        assertEquals(
            BluetoothDiscoveryReadiness.IDENTITY_FEATURE_DISABLED,
            BluetoothDiscoveryPrerequisitePolicy.evaluate(
                readyInput().copy(identityFeatureEnabled = false)
            )
        )
        assertEquals(
            BluetoothDiscoveryReadiness.PLATFORM_UNSUPPORTED,
            BluetoothDiscoveryPrerequisitePolicy.evaluate(
                readyInput().copy(androidApi = 32)
            )
        )
        assertEquals(
            BluetoothDiscoveryReadiness.IDENTITY_NOT_READY,
            BluetoothDiscoveryPrerequisitePolicy.evaluate(
                readyInput().copy(identityReady = false)
            )
        )
    }

    @Test
    fun `API31 is accepted only by the explicit non-gate profile`() {
        val certifiedApi31 = readyInput().copy(androidApi = 31)
        val compatibleApi31 = certifiedApi31.copy(
            platformProfile =
                BluetoothDiscoveryPlatformProfile.API31_COMPAT_NON_GATE
        )

        assertEquals(
            BluetoothDiscoveryReadiness.PLATFORM_UNSUPPORTED,
            BluetoothDiscoveryPrerequisitePolicy.evaluate(certifiedApi31)
        )
        assertEquals(
            BluetoothDiscoveryReadiness.READY,
            BluetoothDiscoveryPrerequisitePolicy.evaluate(compatibleApi31)
        )
        assertEquals(
            BluetoothDiscoveryReadiness.PLATFORM_UNSUPPORTED,
            BluetoothDiscoveryPrerequisitePolicy.evaluate(
                compatibleApi31.copy(androidApi = 30)
            )
        )
    }

    @Test
    fun `each missing Android 12 permission blocks radio`() {
        val missing = listOf(
            readyInput().copy(scanPermission = false),
            readyInput().copy(advertisePermission = false),
            readyInput().copy(connectPermission = false)
        )

        missing.forEach { input ->
            assertEquals(
                BluetoothDiscoveryReadiness.PERMISSIONS_REQUIRED,
                BluetoothDiscoveryPrerequisitePolicy.evaluate(input)
            )
            assertFalse(
                BluetoothDiscoveryPrerequisitePolicy
                    .mayUseConnectedDeviceForegroundService(input)
            )
        }
    }

    @Test
    fun `hardware adapter and FULL_NODE capability are mandatory`() {
        val invalid = listOf(
            readyInput().copy(bluetoothLeFeature = false) to
                BluetoothDiscoveryReadiness.BLE_HARDWARE_UNAVAILABLE,
            readyInput().copy(adapterPresent = false) to
                BluetoothDiscoveryReadiness.BLE_HARDWARE_UNAVAILABLE,
            readyInput().copy(adapterEnabled = false) to
                BluetoothDiscoveryReadiness.ADAPTER_DISABLED,
            readyInput().copy(nodeClass = BluetoothNodeClass.CLIENT_ONLY) to
                BluetoothDiscoveryReadiness.CAPABILITY_NOT_FULL_NODE,
            readyInput().copy(nodeClass = null) to
                BluetoothDiscoveryReadiness.CAPABILITY_NOT_FULL_NODE
        )

        invalid.forEach { (input, expected) ->
            assertEquals(expected, BluetoothDiscoveryPrerequisitePolicy.evaluate(input))
        }
    }

    private fun readyInput() = BluetoothDiscoveryPrerequisiteInput(
        discoveryFeatureEnabled = true,
        identityFeatureEnabled = true,
        androidApi = BluetoothDiscoveryPolicy.MIN_ANDROID_API,
        identityReady = true,
        bluetoothLeFeature = true,
        adapterPresent = true,
        adapterEnabled = true,
        scanPermission = true,
        advertisePermission = true,
        connectPermission = true,
        nodeClass = BluetoothNodeClass.FULL_NODE
    )
}
