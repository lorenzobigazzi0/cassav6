package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothDiscoveryLabReporterTest {
    @Test
    fun `status is bounded aggregate JSON with explicit Lab gates`() {
        val json = BluetoothDiscoveryLabStatusV1(
            sampleSequence = 7L,
            sampledAtEpochMs = 2_000L,
            reporterStartedAtEpochMs = 1_000L,
            readiness = BluetoothDiscoveryReadiness.READY,
            radioActive = true,
            scanProfile = BluetoothScanProfile.STABLE,
            activePeerCount = 2,
            metrics = emptySnapshot().copy(
                concurrentScanAdvertiseWindowsStarted = 3L
            )
        ).toRedactedJson()

        assertTrue(json.startsWith("{\"schemaVersion\":1,"))
        assertTrue(json.endsWith("}}}"))
        assertEquals(3, json.count { it == '{' })
        assertEquals(3, json.count { it == '}' })
        assertTrue(json.contains("\"source\":\"CASSA_V6_ANDROID_DISCOVERY_LAB\""))
        assertTrue(json.contains("\"labBuild\":true"))
        assertTrue(json.contains("\"diagnosticsEnabled\":true"))
        assertTrue(json.contains("\"readiness\":\"READY\""))
        assertTrue(json.contains("\"ready\":true"))
        assertTrue(json.contains("\"radioActive\":true"))
        assertTrue(json.contains("\"scanProfile\":\"STABLE\""))
        assertTrue(json.contains("\"activePeerCount\":2"))
        assertTrue(json.contains("\"concurrentScanAdvertiseWindowsStarted\":3"))
        assertTrue(json.contains("\"rawCallbacks\":0"))
        assertTrue(json.contains("\"uuidMatches\":0"))
        assertTrue(json.contains("\"validPayloads\":0"))
        assertTrue(json.contains("\"acceptedObservations\":0"))
        assertTrue(json.contains("\"firstObservationOffsetP95Ms\":null"))
        assertTrue(json.toByteArray(Charsets.UTF_8).size < 4_096)
    }

    @Test
    fun `status never contains peer identity or enrollment material`() {
        val json = BluetoothDiscoveryLabStatusV1(
            sampleSequence = 1L,
            sampledAtEpochMs = 2L,
            reporterStartedAtEpochMs = 1L,
            readiness = BluetoothDiscoveryReadiness.IDENTITY_NOT_READY,
            radioActive = false,
            scanProfile = BluetoothScanProfile.FAILOVER,
            activePeerCount = 0,
            metrics = emptySnapshot().copy(
                acceptedObservations = 4L,
                firstObservationOffsetP95Ms = 1_234L,
                peerDirectory = BluetoothPeerDirectoryMetrics.EMPTY.copy(
                    updated = 3L,
                    capacityHighWatermark = 1
                )
            )
        ).toRedactedJson()

        assertTrue(json.contains("\"readiness\":\"IDENTITY_NOT_READY\""))
        assertTrue(json.contains("\"ready\":false"))
        assertTrue(json.contains("\"acceptedObservations\":4"))
        assertTrue(json.contains("\"firstObservationOffsetP95Ms\":1234"))
        assertTrue(json.contains("\"capacityHighWatermark\":1"))
        listOf(
            "rotatingAlias",
            "nodeId",
            "token",
            "secret",
            "privateKey",
            "publicKey",
            "certificate",
            "macAddress",
            "endpoint",
            "androidId",
            "deviceId"
        ).forEach { forbidden ->
            assertFalse(json.contains(forbidden, ignoreCase = true))
        }
    }

    private fun emptySnapshot() = BluetoothDiscoveryMetricsSnapshot(
        scanWindowsStarted = 0L,
        concurrentScanAdvertiseWindowsStarted = 0L,
        scanWindowsCompleted = 0L,
        scanFailures = 0L,
        rawCallbacks = 0L,
        uuidMatches = 0L,
        validPayloads = 0L,
        advertisementsStarted = 0L,
        advertisementUpdates = 0L,
        advertisementFailures = 0L,
        invalidPayloads = 0L,
        acceptedObservations = 0L,
        scanIngressDropped = 0L,
        peerExpiryCount = 0L,
        firstObservationOffsetP95Ms = null,
        peerDirectory = BluetoothPeerDirectoryMetrics.EMPTY
    )
}
