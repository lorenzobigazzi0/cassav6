package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Test

class BluetoothDiscoveryMetricsTest {
    @Test
    fun `metrics expose only aggregate counters and first observation offset p95`() {
        val metrics = BluetoothDiscoveryMetrics()
        metrics.recordScanWindowStarted()
        metrics.recordConcurrentScanAdvertiseWindowStarted()
        metrics.recordScanWindowCompleted()
        metrics.recordScanFailure()
        metrics.recordRawCallback()
        metrics.recordUuidMatch()
        metrics.recordValidPayload()
        metrics.recordAdvertisementStarted()
        metrics.recordAdvertisementUpdated()
        metrics.recordAdvertisementFailure()
        metrics.recordInvalidPayload()
        metrics.recordPeerExpiry(2)
        metrics.recordScanIngressDropped(3)
        for (offset in 1L..100L) {
            metrics.recordAcceptedObservation()
            metrics.recordFirstObservationOffset(offset)
        }

        val snapshot = metrics.snapshot()
        assertEquals(1L, snapshot.scanWindowsStarted)
        assertEquals(1L, snapshot.concurrentScanAdvertiseWindowsStarted)
        assertEquals(1L, snapshot.scanWindowsCompleted)
        assertEquals(1L, snapshot.scanFailures)
        assertEquals(1L, snapshot.rawCallbacks)
        assertEquals(1L, snapshot.uuidMatches)
        assertEquals(1L, snapshot.validPayloads)
        assertEquals(1L, snapshot.advertisementsStarted)
        assertEquals(1L, snapshot.advertisementUpdates)
        assertEquals(1L, snapshot.advertisementFailures)
        assertEquals(1L, snapshot.invalidPayloads)
        assertEquals(100L, snapshot.acceptedObservations)
        assertEquals(3L, snapshot.scanIngressDropped)
        assertEquals(2L, snapshot.peerExpiryCount)
        assertEquals(95L, snapshot.firstObservationOffsetP95Ms)
        assertEquals(BluetoothPeerDirectoryMetrics.EMPTY, snapshot.peerDirectory)
    }

    @Test
    fun `concurrent scan advertise counter is cumulative and independent`() {
        val metrics = BluetoothDiscoveryMetrics()
        repeat(3) { metrics.recordScanWindowStarted() }
        repeat(2) { metrics.recordConcurrentScanAdvertiseWindowStarted() }

        val snapshot = metrics.snapshot()

        assertEquals(3L, snapshot.scanWindowsStarted)
        assertEquals(2L, snapshot.concurrentScanAdvertiseWindowsStarted)
    }

    @Test
    fun `offset history is bounded independently from accepted count`() {
        val metrics = BluetoothDiscoveryMetrics(maximumOffsetSamples = 3)
        repeat(5) { metrics.recordAcceptedObservation() }
        metrics.recordFirstObservationOffset(1L)
        metrics.recordFirstObservationOffset(2L)
        metrics.recordFirstObservationOffset(100L)
        metrics.recordFirstObservationOffset(3L)

        val snapshot = metrics.snapshot()
        assertEquals(5L, snapshot.acceptedObservations)
        assertEquals(100L, snapshot.firstObservationOffsetP95Ms)
    }

    @Test
    fun `composite snapshot exposes aggregate directory expiry and capacity metrics`() {
        val metrics = BluetoothDiscoveryMetrics()
        val directory = BluetoothPeerDirectory(
            maximumStreams = 1,
            maximumNewStreamAttemptsPerWindow = 2
        )
        directory.observe(advertisement(alias = "000000000001"), -70, 0L)
        directory.observe(advertisement(alias = "000000000002"), -60, 1L)
        directory.pruneExpired(20_000L)

        val snapshot = metrics.snapshot(directory.metrics())

        assertEquals(1L, snapshot.peerExpiryCount)
        assertEquals(1L, snapshot.peerDirectory.capacityEvicted)
        assertEquals(1L, snapshot.peerDirectory.expired)
        assertEquals(2L, snapshot.peerDirectory.added)
        assertEquals(2L, snapshot.peerDirectory.prunePasses)
    }

    private fun advertisement(
        alias: String
    ) = BluetoothAdvertisementV1(
        protocolVersion = 1,
        nodeKind = BluetoothAdvertisementNodeKind.HANDHELD,
        rotatingAlias = alias,
        bootId = 17,
        capabilities = BluetoothCapabilityBitsV1.B2_FULL_NODE,
        serverReachable = false,
        sequence = 1
    )
}
