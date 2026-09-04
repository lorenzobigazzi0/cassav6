package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BleScannerCompatibilityTest {
    @Test
    fun `only Android 12 non-gate uses the controller-unfiltered fallback`() {
        for (api in listOf(31, 32)) {
            assertEquals(
                BluetoothControllerScanFilterMode.UNFILTERED_ANDROID_12_NON_GATE,
                BluetoothScanCompatibilityPolicy.controllerFilterMode(
                    api,
                    BluetoothDiscoveryPlatformProfile.API31_COMPAT_NON_GATE
                )
            )
        }
        for (api in listOf(30, 33, 36)) {
            assertEquals(
                BluetoothControllerScanFilterMode.SERVICE_DATA_V1,
                BluetoothScanCompatibilityPolicy.controllerFilterMode(
                    api,
                    BluetoothDiscoveryPlatformProfile.API31_COMPAT_NON_GATE
                )
            )
        }
        for (api in listOf(31, 32, 33, 36)) {
            assertEquals(
                BluetoothControllerScanFilterMode.SERVICE_DATA_V1,
                BluetoothScanCompatibilityPolicy.controllerFilterMode(
                    api,
                    BluetoothDiscoveryPlatformProfile.CERTIFIED
                )
            )
        }
    }

    @Test
    fun `software matcher accepts only exact v1 service-data frames`() {
        val valid = ByteArray(BluetoothAdvertisementCodecV1.PAYLOAD_BYTES).also {
            it[0] = 0x31
        }

        assertTrue(BluetoothAdvertisementScanMatcherV1.matches(valid))
        assertFalse(BluetoothAdvertisementScanMatcherV1.matches(null))
        assertFalse(BluetoothAdvertisementScanMatcherV1.matches(valid.copyOf(9)))
        assertFalse(
            BluetoothAdvertisementScanMatcherV1.matches(
                valid.copyOf().also { it[0] = 0x32 }
            )
        )
        assertFalse(
            BluetoothAdvertisementScanMatcherV1.matches(
                valid.copyOf().also { it[0] = 0x71 }
            )
        )
        assertFalse(
            BluetoothAdvertisementScanMatcherV1.matches(
                valid.copyOf().also { it[0] = 0x21 }
            )
        )
    }

    @Test
    fun `software scan budget bounds inspections and matched payload copies`() {
        val budget = BluetoothSoftwareScanBudget(
            maximumInspections = 3,
            maximumMatches = 2
        )

        assertTrue(budget.tryInspect())
        assertTrue(budget.tryInspect())
        assertTrue(budget.tryInspect())
        assertFalse(budget.tryInspect())
        assertTrue(budget.tryAcquireMatch())
        assertTrue(budget.tryAcquireMatch())
        assertFalse(budget.tryAcquireMatch())
    }

    @Test
    fun `software scan budget rejects unsafe limits`() {
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothSoftwareScanBudget(maximumInspections = 0, maximumMatches = 1)
        }
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothSoftwareScanBudget(maximumInspections = 1, maximumMatches = 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothSoftwareScanBudget(maximumInspections = 1, maximumMatches = 2)
        }
    }
}
