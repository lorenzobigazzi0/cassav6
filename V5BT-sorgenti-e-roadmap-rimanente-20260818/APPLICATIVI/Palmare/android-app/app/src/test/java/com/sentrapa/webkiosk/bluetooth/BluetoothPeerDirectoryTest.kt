package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothPeerDirectoryTest {
    @Test
    fun `new observation is added and exact duplicate refreshes ttl`() {
        val directory = BluetoothPeerDirectory()
        val value = advertisement()

        assertEquals(
            BluetoothPeerObservationResult.ADDED,
            directory.observe(value, -50, 1_000L).result
        )
        assertEquals(
            BluetoothPeerObservationResult.DUPLICATE_REFRESHED,
            directory.observe(value, -55, 2_000L).result
        )
        val record = directory.snapshot(2_000L).single()
        assertEquals(-55, record.rssi)
        assertEquals(1_000L, record.firstSeenMs)
        assertEquals(2_000L, record.lastSeenMs)
    }

    @Test
    fun `newer sequence replaces semantics and wrap from 255 is accepted`() {
        val directory = BluetoothPeerDirectory()
        val initial = advertisement(sequence = 255)
        directory.observe(initial, -50, 1_000L)

        val result = directory.observe(
            initial.copy(sequence = 0, serverReachable = false),
            -51,
            2_000L
        )

        assertEquals(BluetoothPeerObservationResult.UPDATED, result.result)
        assertEquals(false, directory.snapshot(2_000L).single().advertisement.serverReachable)
    }

    @Test
    fun `older ambiguous and conflicting packets do not refresh ttl`() {
        val directory = BluetoothPeerDirectory()
        val initial = advertisement(sequence = 0)
        directory.observe(initial, -50, 1_000L)

        assertEquals(
            BluetoothPeerObservationResult.OLDER_REJECTED,
            directory.observe(initial.copy(sequence = 255), -40, 2_000L).result
        )
        assertEquals(
            BluetoothPeerObservationResult.AMBIGUOUS_REJECTED,
            directory.observe(initial.copy(sequence = 128), -40, 3_000L).result
        )
        assertEquals(
            BluetoothPeerObservationResult.CONFLICT_REJECTED,
            directory.observe(initial.copy(capabilities = 1), -40, 4_000L).result
        )
        assertEquals(1_000L, directory.snapshot(4_000L).single().lastSeenMs)
    }

    @Test
    fun `alias and boot changes create independent soft state streams`() {
        val directory = BluetoothPeerDirectory()
        directory.observe(advertisement(), -50, 1_000L)
        directory.observe(advertisement(alias = "aabbccddee00"), -50, 1_001L)
        directory.observe(advertisement(bootId = 18), -50, 1_002L)

        assertEquals(3, directory.snapshot(1_002L).size)
    }

    @Test
    fun `RSSI below floor and directory overflow are rejected`() {
        val directory = BluetoothPeerDirectory(maximumStreams = 1)
        assertEquals(
            BluetoothPeerObservationResult.BELOW_RSSI_FLOOR,
            directory.observe(advertisement(), -89, 1_000L).result
        )
        assertEquals(
            BluetoothPeerObservationResult.ADDED,
            directory.observe(advertisement(), -88, 1_001L).result
        )
        assertEquals(
            BluetoothPeerObservationResult.DIRECTORY_FULL,
            directory.observe(advertisement(bootId = 18), -88, 1_002L).result
        )
    }

    @Test
    fun `capacity replaces only an aging or six decibel weaker peer`() {
        val strongerDirectory = BluetoothPeerDirectory(
            maximumStreams = 2,
            maximumNewStreamAttemptsPerWindow = 3
        )
        strongerDirectory.observe(advertisement(alias = "000000000001"), -70, 0L)
        strongerDirectory.observe(advertisement(alias = "000000000002"), -60, 1L)

        assertEquals(
            BluetoothPeerObservationResult.CAPACITY_EVICTED_ADDED,
            strongerDirectory.observe(
                advertisement(alias = "000000000003"),
                -64,
                2L
            ).result
        )
        assertEquals(1L, strongerDirectory.metrics().capacityEvicted)

        val agingDirectory = BluetoothPeerDirectory(
            maximumStreams = 1,
            maximumNewStreamAttemptsPerWindow = 2
        )
        agingDirectory.observe(advertisement(alias = "000000000001"), -50, 0L)
        assertEquals(
            BluetoothPeerObservationResult.CAPACITY_EVICTED_ADDED,
            agingDirectory.observe(
                advertisement(alias = "000000000002"),
                -88,
                BluetoothDiscoveryPolicy.FRESH_PEER_MS
            ).result
        )
    }

    @Test
    fun `anonymous stream attempts are bounded and reset in the next window`() {
        val directory = BluetoothPeerDirectory(
            maximumStreams = 2,
            maximumNewStreamAttemptsPerWindow = 3
        )
        directory.observe(advertisement(alias = "000000000001"), -70, 0L)
        directory.observe(advertisement(alias = "000000000002"), -60, 1L)
        directory.observe(advertisement(alias = "000000000003"), -50, 2L)

        assertEquals(
            BluetoothPeerObservationResult.NEW_STREAM_ATTEMPT_RATE_REJECTED,
            directory.observe(advertisement(alias = "000000000004"), -40, 3L).result
        )
        assertEquals(1L, directory.metrics().newStreamAttemptRateRejected)

        assertEquals(
            BluetoothPeerObservationResult.CAPACITY_EVICTED_ADDED,
            directory.observe(
                advertisement(alias = "000000000004"),
                -40,
                BluetoothDiscoveryPolicy.NEW_STREAM_ATTEMPT_WINDOW_MS
            ).result
        )
        assertEquals(2L, directory.metrics().newStreamAttemptWindowsStarted)
    }

    @Test
    fun `automatic full pruning runs at most once per second`() {
        val directory = BluetoothPeerDirectory()
        val value = advertisement()
        directory.observe(value, -50, 0L)
        directory.observe(value, -50, 100L)
        directory.observe(value, -50, 999L)
        assertEquals(1L, directory.metrics().prunePasses)

        directory.observe(value, -50, 1_000L)
        assertEquals(2L, directory.metrics().prunePasses)
    }

    @Test
    fun `peer is aging at exactly fifteen seconds and expires after it`() {
        val directory = BluetoothPeerDirectory()
        directory.observe(advertisement(), -50, 0L)

        assertEquals(1, directory.activePeerCount(0L))
        assertEquals(1, directory.activePeerCount(15_000L))
        assertEquals(0, directory.activePeerCount(15_001L))
        assertEquals(
            BluetoothPeerFreshness.AGING,
            directory.snapshot(15_000L).single().freshness(15_000L)
        )
        assertEquals(0, directory.pruneExpired(15_000L))
        assertEquals(1, directory.pruneExpired(15_001L))
        assertTrue(directory.snapshot(15_001L).isEmpty())
    }

    @Test
    fun `expired stream returning is a new generation`() {
        val directory = BluetoothPeerDirectory()
        val first = directory.observe(advertisement(), -50, 0L).record!!
        val returned = directory.observe(advertisement(), -50, 20_000L)

        assertEquals(BluetoothPeerObservationResult.ADDED, returned.result)
        assertTrue(returned.record!!.generation > first.generation)
        assertEquals(1L, directory.metrics().expired)
    }

    @Test
    fun `monotonic clock regression is rejected without mutating peer`() {
        val directory = BluetoothPeerDirectory()
        directory.observe(advertisement(), -50, 1_000L)

        assertEquals(
            BluetoothPeerObservationResult.CLOCK_REGRESSION,
            directory.observe(advertisement(), -40, 999L).result
        )
        assertEquals(1_000L, directory.snapshot(1_000L).single().lastSeenMs)
        assertEquals(1L, directory.metrics().clockRegressions)
    }

    private fun advertisement(
        alias: String = "aabbccddeeff",
        bootId: Int = 17,
        sequence: Int = 1
    ) = BluetoothAdvertisementV1(
        protocolVersion = 1,
        nodeKind = BluetoothAdvertisementNodeKind.HANDHELD,
        rotatingAlias = alias,
        bootId = bootId,
        capabilities = BluetoothCapabilityBitsV1.B2_FULL_NODE,
        serverReachable = false,
        sequence = sequence
    )
}
