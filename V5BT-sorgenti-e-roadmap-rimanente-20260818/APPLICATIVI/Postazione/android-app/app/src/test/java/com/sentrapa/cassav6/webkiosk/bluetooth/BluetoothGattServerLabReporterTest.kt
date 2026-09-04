package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothGattServerLabReporterTest {
    @Test
    fun `status contains aggregate server state and no peer material`() {
        val json = BluetoothGattServerLabStatusV1(
            sampleSequence = 4L,
            sampledAtEpochMs = 20L,
            reporterStartedAtEpochMs = 10L,
            snapshot = snapshot()
        ).toRedactedJson()

        for (expected in listOf(
            "\"source\":\"CASSA_V6_ANDROID_GATT_SERVER_LAB\"",
            "\"state\":\"ACTIVE\"",
            "\"active\":true",
            "\"servicePublished\":true",
            "\"sessionCount\":2",
            "\"secureActiveSessionCount\":0",
            "\"securePromotionBlockedSessionCount\":2",
            "\"connectionsAccepted\":3",
            "\"helloWritesAccepted\":2",
            "\"protocolFailures\":1"
        )) {
            assertTrue(expected, json.contains(expected))
        }
        for (forbidden in listOf(
            "serial",
            "address",
            "mac",
            "alias",
            "nodeId",
            "deviceId",
            "payload",
            "peerToken",
            "path"
        )) {
            assertFalse(forbidden, json.contains(forbidden, ignoreCase = true))
        }
    }

    private fun snapshot() = AndroidGattServerSnapshot(
        state = AndroidGattServerState.ACTIVE,
        enabled = true,
        active = true,
        servicePublished = true,
        sessionCount = 2,
        helloEnabled = true,
        metrics = AndroidGattServerMetricsSnapshot(
            openAttempts = 1L,
            serversOpened = 1L,
            serviceAddRequests = 1L,
            servicesPublished = 1L,
            connectionsAccepted = 3L,
            connectionsRejected = 1L,
            disconnects = 1L,
            mtuChanges = 3L,
            reads = 2L,
            writes = 2L,
            descriptorReads = 0L,
            descriptorWrites = 0L,
            notificationsStarted = 0L,
            notificationsCompleted = 0L,
            deniedRequests = 1L,
            failures = 0L,
            resets = 0L,
            closes = 0L
        ),
        handler = AndroidGattServerSessionHandlerSnapshotV1(
            enabled = true,
            helloEnabled = true,
            sessionCount = 2,
            secureActiveSessionCount = 0,
            securePromotionBlockedSessionCount = 2,
            sessionsAccepted = 3L,
            sessionsRejected = 1L,
            sessionsExpired = 0L,
            helloWritesAccepted = 2L,
            helloReadsCompleted = 2L,
            deniedRequests = 1L,
            protocolFailures = 1L
        )
    )
}
