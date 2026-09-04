package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothDiscoveryPolicyTest {
    @Test
    fun `stable and failover windows match the frozen policy`() {
        assertEquals(
            BluetoothScanWindow(3_000L, 30_000L),
            BluetoothDiscoveryPolicy.scanWindow(BluetoothScanProfile.STABLE)
        )
        assertEquals(
            BluetoothScanWindow(8_000L, 10_000L),
            BluetoothDiscoveryPolicy.scanWindow(BluetoothScanProfile.FAILOVER)
        )
        assertEquals(
            27_000L,
            BluetoothDiscoveryPolicy.scanWindow(BluetoothScanProfile.STABLE).idleMs
        )
        assertEquals(
            2_000L,
            BluetoothDiscoveryPolicy.scanWindow(BluetoothScanProfile.FAILOVER).idleMs
        )
        assertEquals(1_000L, BluetoothDiscoveryPolicy.PEER_PRUNE_INTERVAL_MS)
        assertEquals(10_000L, BluetoothDiscoveryPolicy.NEW_STREAM_ATTEMPT_WINDOW_MS)
        assertEquals(2_048, BluetoothDiscoveryPolicy.MAX_NEW_STREAM_ATTEMPTS_PER_WINDOW)
        assertEquals(6, BluetoothDiscoveryPolicy.CAPACITY_REPLACEMENT_RSSI_MARGIN_DB)
        assertEquals(256, BluetoothDiscoveryPolicy.MAX_PENDING_SCAN_RESULTS)
        assertEquals(32, BluetoothDiscoveryPolicy.SCAN_INGRESS_BATCH_SIZE)
        assertEquals(33, BluetoothDiscoveryPolicy.MIN_ANDROID_API)
        assertEquals(
            33,
            BluetoothDiscoveryPlatformProfile.CERTIFIED.minimumAndroidApi
        )
        assertEquals(
            31,
            BluetoothDiscoveryPlatformProfile.API31_COMPAT_NON_GATE
                .minimumAndroidApi
        )
        assertFalse(
            BluetoothDiscoveryPlatformProfile.API31_COMPAT_NON_GATE
                .formalGateEligible
        )
        assertEquals(
            8_000L,
            BluetoothDiscoveryPolicy.RECIPROCAL_DISCOVERY_ADVERTISE_GRACE_MS
        )
        assertEquals(
            BluetoothScanProfile.FAILOVER,
            BluetoothDiscoveryPolicy.scanProfileForPeerPresence(false)
        )
        assertEquals(
            BluetoothScanProfile.STABLE,
            BluetoothDiscoveryPolicy.scanProfileForPeerPresence(true)
        )
        assertEquals(
            BluetoothAdvertiseMode.LOW_LATENCY,
            BluetoothDiscoveryPolicy.advertiseMode(BluetoothScanProfile.FAILOVER)
        )
        assertEquals(
            BluetoothAdvertiseMode.BALANCED,
            BluetoothDiscoveryPolicy.advertiseMode(BluetoothScanProfile.STABLE)
        )
    }

    @Test
    fun `build configuration cannot relabel the certified API minimum`() {
        assertEquals(
            BluetoothDiscoveryPlatformProfile.CERTIFIED,
            BluetoothDiscoveryPlatformProfile.fromBuildConfiguration(
                api31CompatNonGateBuild = false,
                configuredMinimumAndroidApi = 33
            )
        )
        assertEquals(
            BluetoothDiscoveryPlatformProfile.API31_COMPAT_NON_GATE,
            BluetoothDiscoveryPlatformProfile.fromBuildConfiguration(
                api31CompatNonGateBuild = true,
                configuredMinimumAndroidApi = 31
            )
        )
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothDiscoveryPlatformProfile.fromBuildConfiguration(
                api31CompatNonGateBuild = false,
                configuredMinimumAndroidApi = 31
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothDiscoveryPlatformProfile.fromBuildConfiguration(
                api31CompatNonGateBuild = true,
                configuredMinimumAndroidApi = 33
            )
        }
    }

    @Test
    fun `advertiser idempotency key includes the interval mode`() {
        val balanced = BluetoothAdvertiserStartKey(
            payload = listOf(1, 2, 3).map(Int::toByte),
            connectable = false,
            advertiseMode = BluetoothAdvertiseMode.BALANCED
        )
        val lowLatency = balanced.copy(
            advertiseMode = BluetoothAdvertiseMode.LOW_LATENCY
        )

        assertNotEquals(balanced, lowLatency)
        assertEquals(balanced, balanced.copy())
    }

    @Test
    fun `alias boundary scheduling never creates a continuous loop`() {
        assertEquals(60_000L, BluetoothDiscoveryPolicy.nextAliasBoundaryDelayMs(0L))
        assertEquals(1L, BluetoothDiscoveryPolicy.nextAliasBoundaryDelayMs(59_999L))
        assertEquals(60_000L, BluetoothDiscoveryPolicy.nextAliasBoundaryDelayMs(60_000L))
    }

    @Test
    fun `peer expiry wakeup honors the strict fifteen second boundary`() {
        assertEquals(
            15_001L,
            BluetoothDiscoveryPolicy.nextPeerExpiryDelayMs(0L, listOf(0L))
        )
        assertEquals(
            1L,
            BluetoothDiscoveryPolicy.nextPeerExpiryDelayMs(15_000L, listOf(0L))
        )
        assertEquals(
            501L,
            BluetoothDiscoveryPolicy.nextPeerExpiryDelayMs(
                15_000L,
                listOf(500L, 2_000L)
            )
        )
        assertNull(
            BluetoothDiscoveryPolicy.nextPeerExpiryDelayMs(15_001L, emptyList())
        )
    }

    @Test
    fun `B2 advertisement is non connectable until a GATT server exists`() {
        assertFalse(BluetoothDiscoveryPolicy.B2_ADVERTISEMENT_CONNECTABLE)
        assertFalse(BluetoothDiscoveryPolicy.isAdvertisementConnectable(false))
        assertTrue(BluetoothDiscoveryPolicy.isAdvertisementConnectable(true))
    }

    @Test
    fun `invalid scan windows and clocks are rejected`() {
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothScanWindow(0L, 1L)
        }
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothScanWindow(2L, 1L)
        }
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothScanWindow(2L, 2L)
        }
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothDiscoveryPolicy.nextAliasBoundaryDelayMs(-1L)
        }
    }
}
