package com.sentrapa.cassav6.webkiosk.bluetooth

import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidGattClientStateMachineTest {
    @Test
    fun `mutual authentication has one explicit ordered path`() {
        val machine = AndroidGattClientStateMachine()
        val metrics = AndroidGattClientMetrics()
        fun dispatch(
            event: AndroidGattClientEvent,
            mtu: Int? = null
        ) {
            metrics.record(machine.dispatch(event, mtu))
        }

        dispatch(AndroidGattClientEvent.CONNECT_REQUESTED)
        dispatch(AndroidGattClientEvent.GATT_CONNECTED)
        dispatch(AndroidGattClientEvent.SERVICES_VALIDATED)
        dispatch(AndroidGattClientEvent.MTU_NEGOTIATED, 247)
        dispatch(AndroidGattClientEvent.HELLO_WRITE_REQUESTED)
        dispatch(AndroidGattClientEvent.HELLO_WRITTEN)
        dispatch(AndroidGattClientEvent.HELLO_ACCEPTED)
        assertEquals(
            AndroidGattClientTransitionDisposition.REJECTED,
            machine.dispatch(
                AndroidGattClientEvent.AUTH_CLIENT_PROOF_WRITTEN
            ).disposition
        )
        dispatch(AndroidGattClientEvent.AUTH_SUBSCRIBE_REQUESTED)
        dispatch(AndroidGattClientEvent.AUTH_SUBSCRIBED)
        dispatch(AndroidGattClientEvent.AUTH_CLIENT_PROOF_WRITTEN)
        dispatch(AndroidGattClientEvent.AUTH_SERVER_PROOF_VERIFIED)
        dispatch(AndroidGattClientEvent.AUTH_FINISH_WRITTEN)

        assertEquals(AndroidGattClientState.AUTHENTICATED, machine.state)
        val snapshot = metrics.snapshot()
        assertEquals(1L, snapshot.authSubscriptionsStarted)
        assertEquals(1L, snapshot.authSubscriptionsCompleted)
        assertEquals(1L, snapshot.clientProofWritesCompleted)
        assertEquals(1L, snapshot.serverProofsVerified)
        assertEquals(1L, snapshot.authFinishWritesCompleted)
        assertEquals(1L, snapshot.authenticatedSessions)
    }

    @Test
    fun `happy path stops at transport ready without opening a session`() {
        val machine = AndroidGattClientStateMachine()
        val metrics = AndroidGattClientMetrics()

        listOf(
            AndroidGattClientEvent.CONNECT_REQUESTED to
                AndroidGattClientState.CONNECTING,
            AndroidGattClientEvent.GATT_CONNECTED to
                AndroidGattClientState.DISCOVERING_SERVICES,
            AndroidGattClientEvent.SERVICES_VALIDATED to
                AndroidGattClientState.NEGOTIATING_MTU
        ).forEach { (event, expectedState) ->
            val transition = machine.dispatch(event)
            metrics.record(transition)
            assertEquals(
                AndroidGattClientTransitionDisposition.TRANSITIONED,
                transition.disposition
            )
            assertEquals(expectedState, machine.state)
        }

        val ready = machine.dispatch(
            AndroidGattClientEvent.MTU_NEGOTIATED,
            AndroidGattProfileV1.PREFERRED_MTU
        )
        metrics.record(ready)

        assertEquals(AndroidGattClientState.READY, machine.state)
        assertEquals(
            AndroidGattClientMetricsSnapshot(
                connectionAttempts = 1L,
                connectionsEstablished = 1L,
                servicesValidated = 1L,
                mtuNegotiated = 1L,
                disconnects = 0L,
                failures = 0L,
                closes = 0L
            ),
            metrics.snapshot()
        )
    }

    @Test
    fun `out of order callbacks are rejected without mutating state`() {
        val machine = AndroidGattClientStateMachine()

        val transition = machine.dispatch(
            AndroidGattClientEvent.MTU_NEGOTIATED,
            AndroidGattProfileV1.PREFERRED_MTU
        )

        assertEquals(
            AndroidGattClientTransitionDisposition.REJECTED,
            transition.disposition
        )
        assertFalse(transition.changed)
        assertEquals(AndroidGattClientState.IDLE, machine.state)
    }

    @Test
    fun `HELLO reaches exchanged without authenticating or opening a session`() {
        val machine = AndroidGattClientStateMachine()
        val metrics = AndroidGattClientMetrics()
        listOf(
            AndroidGattClientEvent.CONNECT_REQUESTED,
            AndroidGattClientEvent.GATT_CONNECTED,
            AndroidGattClientEvent.SERVICES_VALIDATED
        ).forEach { metrics.record(machine.dispatch(it)) }
        metrics.record(
            machine.dispatch(
                AndroidGattClientEvent.MTU_NEGOTIATED,
                AndroidGattProfileV1.PREFERRED_MTU
            )
        )
        listOf(
            AndroidGattClientEvent.HELLO_WRITE_REQUESTED,
            AndroidGattClientEvent.HELLO_WRITTEN,
            AndroidGattClientEvent.HELLO_ACCEPTED
        ).forEach { metrics.record(machine.dispatch(it)) }

        assertEquals(AndroidGattClientState.HELLO_EXCHANGED, machine.state)
        assertEquals(1L, metrics.snapshot().helloWritesStarted)
        assertEquals(1L, metrics.snapshot().helloWritesCompleted)
        assertEquals(1L, metrics.snapshot().helloReadsCompleted)
        assertEquals(1L, metrics.snapshot().helloExchanged)
        assertEquals(
            AndroidGattClientTransitionDisposition.IDEMPOTENT,
            machine.dispatch(AndroidGattClientEvent.HELLO_ACCEPTED).disposition
        )
    }

    @Test
    fun `HELLO callbacks cannot skip write and read boundaries`() {
        val machine = AndroidGattClientStateMachine()
        machine.dispatch(AndroidGattClientEvent.CONNECT_REQUESTED)
        machine.dispatch(AndroidGattClientEvent.GATT_CONNECTED)
        machine.dispatch(AndroidGattClientEvent.SERVICES_VALIDATED)
        machine.dispatch(
            AndroidGattClientEvent.MTU_NEGOTIATED,
            AndroidGattProfileV1.PREFERRED_MTU
        )

        assertEquals(
            AndroidGattClientTransitionDisposition.REJECTED,
            machine.dispatch(AndroidGattClientEvent.HELLO_ACCEPTED).disposition
        )
        assertEquals(AndroidGattClientState.READY, machine.state)
    }

    @Test
    fun `failure and clean close can reset for the next direct session`() {
        val machine = AndroidGattClientStateMachine()
        machine.dispatch(AndroidGattClientEvent.CONNECT_REQUESTED)

        assertEquals(
            AndroidGattClientState.FAILED,
            machine.dispatch(AndroidGattClientEvent.FAILURE).to
        )
        assertEquals(
            AndroidGattClientState.IDLE,
            machine.dispatch(AndroidGattClientEvent.RESET).to
        )
        assertEquals(
            AndroidGattClientState.CLOSED,
            machine.dispatch(AndroidGattClientEvent.CLOSE_REQUESTED).to
        )
        assertEquals(
            AndroidGattClientState.IDLE,
            machine.dispatch(AndroidGattClientEvent.RESET).to
        )
        assertEquals(AndroidGattClientState.IDLE, machine.state)
    }

    @Test
    fun `session key activation heartbeat and clean close have one ordered path`() {
        val machine = AndroidGattClientStateMachine()
        val metrics = AndroidGattClientMetrics()
        fun dispatch(event: AndroidGattClientEvent, mtu: Int? = null) {
            metrics.record(machine.dispatch(event, mtu))
        }

        listOf(
            AndroidGattClientEvent.CONNECT_REQUESTED,
            AndroidGattClientEvent.GATT_CONNECTED,
            AndroidGattClientEvent.SERVICES_VALIDATED
        ).forEach { dispatch(it) }
        dispatch(AndroidGattClientEvent.MTU_NEGOTIATED, 247)
        listOf(
            AndroidGattClientEvent.HELLO_WRITE_REQUESTED,
            AndroidGattClientEvent.HELLO_WRITTEN,
            AndroidGattClientEvent.HELLO_ACCEPTED,
            AndroidGattClientEvent.AUTH_SUBSCRIBE_REQUESTED,
            AndroidGattClientEvent.AUTH_SUBSCRIBED,
            AndroidGattClientEvent.AUTH_CLIENT_PROOF_WRITTEN,
            AndroidGattClientEvent.AUTH_SERVER_PROOF_VERIFIED,
            AndroidGattClientEvent.AUTH_FINISH_WRITTEN,
            AndroidGattClientEvent.SESSION_KEY_START_REQUESTED,
            AndroidGattClientEvent.CLIENT_KEY_SHARE_WRITTEN,
            AndroidGattClientEvent.SERVER_KEY_SHARE_VERIFIED,
            AndroidGattClientEvent.CLIENT_KEY_CONFIRM_WRITTEN
        ).forEach { dispatch(it) }
        assertEquals(AndroidGattClientState.KEY_ESTABLISHED, machine.state)

        dispatch(AndroidGattClientEvent.ACTIVATION_PING_RECEIVED)
        dispatch(AndroidGattClientEvent.ACTIVATION_PONG_WRITTEN)
        assertEquals(AndroidGattClientState.ACTIVE, machine.state)
        dispatch(AndroidGattClientEvent.HEARTBEAT_PING_RECEIVED)
        dispatch(AndroidGattClientEvent.HEARTBEAT_PONG_WRITTEN)
        dispatch(AndroidGattClientEvent.CLOSE_FRAME_RECEIVED)
        assertEquals(AndroidGattClientState.CLOSING, machine.state)
        dispatch(AndroidGattClientEvent.CLOSE_ACK_WRITTEN)
        assertEquals(AndroidGattClientState.CLOSED, machine.state)

        val snapshot = metrics.snapshot()
        assertEquals(1L, snapshot.keyExchangesStarted)
        assertEquals(1L, snapshot.clientKeySharesWritten)
        assertEquals(1L, snapshot.serverKeySharesVerified)
        assertEquals(1L, snapshot.clientKeyConfirmsWritten)
        assertEquals(1L, snapshot.keysEstablished)
        assertEquals(1L, snapshot.activationPingsReceived)
        assertEquals(1L, snapshot.activationPongsWritten)
        assertEquals(1L, snapshot.activeSessions)
        assertEquals(1L, snapshot.heartbeatPingsReceived)
        assertEquals(1L, snapshot.heartbeatPongsWritten)
        assertEquals(1L, snapshot.closeFramesReceived)
        assertEquals(1L, snapshot.cleanCloses)
    }

    @Test
    fun `local close from active reaches closed before resources are released`() {
        val machine = AndroidGattClientStateMachine()
        listOf(
            AndroidGattClientEvent.CONNECT_REQUESTED,
            AndroidGattClientEvent.GATT_CONNECTED,
            AndroidGattClientEvent.SERVICES_VALIDATED
        ).forEach { machine.dispatch(it) }
        machine.dispatch(
            AndroidGattClientEvent.MTU_NEGOTIATED,
            AndroidGattProfileV1.PREFERRED_MTU
        )
        listOf(
            AndroidGattClientEvent.HELLO_WRITE_REQUESTED,
            AndroidGattClientEvent.HELLO_WRITTEN,
            AndroidGattClientEvent.HELLO_ACCEPTED,
            AndroidGattClientEvent.AUTH_SUBSCRIBE_REQUESTED,
            AndroidGattClientEvent.AUTH_SUBSCRIBED,
            AndroidGattClientEvent.AUTH_CLIENT_PROOF_WRITTEN,
            AndroidGattClientEvent.AUTH_SERVER_PROOF_VERIFIED,
            AndroidGattClientEvent.AUTH_FINISH_WRITTEN,
            AndroidGattClientEvent.SESSION_KEY_START_REQUESTED,
            AndroidGattClientEvent.CLIENT_KEY_SHARE_WRITTEN,
            AndroidGattClientEvent.SERVER_KEY_SHARE_VERIFIED,
            AndroidGattClientEvent.CLIENT_KEY_CONFIRM_WRITTEN,
            AndroidGattClientEvent.ACTIVATION_PING_RECEIVED,
            AndroidGattClientEvent.ACTIVATION_PONG_WRITTEN
        ).forEach { machine.dispatch(it) }

        assertEquals(AndroidGattClientState.ACTIVE, machine.state)
        assertEquals(
            AndroidGattClientState.CLOSING,
            machine.dispatch(AndroidGattClientEvent.CLOSE_REQUESTED).to
        )
        assertEquals(
            AndroidGattClientState.CLOSED,
            machine.dispatch(AndroidGattClientEvent.DISCONNECTED).to
        )
        assertEquals(
            AndroidGattClientState.IDLE,
            machine.dispatch(AndroidGattClientEvent.RESET).to
        )
    }

    @Test
    fun `profile validation requires exact uuids and capabilities`() {
        assertTrue(
            AndroidGattProfileV1.isComplete(
                AndroidGattProfileV1.serviceUuid,
                AndroidGattProfileV1.characteristics
            )
        )

        val missing = AndroidGattProfileV1.characteristics.toMutableMap()
        missing.remove(
            UUID.fromString("544e9ea6-c9a9-56f7-a1ed-41afe8c72078")
        )
        assertFalse(
            AndroidGattProfileV1.isComplete(
                AndroidGattProfileV1.serviceUuid,
                missing
            )
        )

        val wrongCapabilities =
            AndroidGattProfileV1.characteristics.toMutableMap()
        val helloUuid =
            UUID.fromString("34f16f91-8558-595d-ba61-f0b31b2aa7f0")
        wrongCapabilities[helloUuid] =
            setOf(AndroidGattCharacteristicCapability.READ)
        assertFalse(
            AndroidGattProfileV1.isComplete(
                AndroidGattProfileV1.serviceUuid,
                wrongCapabilities
            )
        )
    }

    @Test
    fun `candidate policy selects only a newly observed reachable raspberry`() {
        val raspberry = advertisement(
            kind = BluetoothAdvertisementNodeKind.RASPBERRY,
            reachable = true,
            capabilities = BluetoothCapabilityBitsV1.GATT_SERVER
        )

        assertTrue(
            BluetoothGattCandidatePolicy.shouldConnect(
                BluetoothPeerObservationResult.ADDED,
                raspberry
            )
        )
        assertFalse(
            BluetoothGattCandidatePolicy.shouldConnect(
                BluetoothPeerObservationResult.DUPLICATE_REFRESHED,
                raspberry
            )
        )
        assertFalse(
            BluetoothGattCandidatePolicy.isEligible(
                raspberry.copy(serverReachable = false)
            )
        )
        assertFalse(
            BluetoothGattCandidatePolicy.isEligible(
                raspberry.copy(
                    nodeKind = BluetoothAdvertisementNodeKind.HANDHELD
                )
            )
        )
        assertFalse(
            BluetoothGattCandidatePolicy.isEligible(
                raspberry.copy(capabilities = 0)
            )
        )
    }

    @Test
    fun `offline Android full nodes connect only from elected client side`() {
        val fullNode = BluetoothCapabilityBitsV1.B2_FULL_NODE
        val electedClient = advertisement(
            kind = BluetoothAdvertisementNodeKind.HANDHELD,
            reachable = false,
            capabilities = fullNode
        ).copy(rotatingAlias = "8899aabbccdd")
        val electedServer = advertisement(
            kind = BluetoothAdvertisementNodeKind.STATION,
            reachable = false,
            capabilities = fullNode
        ).copy(rotatingAlias = "001122334455")

        assertTrue(
            BluetoothGattCandidatePolicy.shouldConnect(
                BluetoothPeerObservationResult.ADDED,
                electedServer,
                electedClient,
                androidPeerAuthEnabled = true,
                aliasEpoch = 77L
            )
        )
        assertFalse(
            BluetoothGattCandidatePolicy.shouldConnect(
                BluetoothPeerObservationResult.ADDED,
                electedClient,
                electedServer,
                androidPeerAuthEnabled = true,
                aliasEpoch = 77L
            )
        )
        assertFalse(
            BluetoothGattCandidatePolicy.isEligible(
                electedServer.copy(
                    nodeKind = BluetoothAdvertisementNodeKind.RASPBERRY,
                    serverReachable = false
                )
            )
        )
    }

    @Test
    fun `lab status reports mutual auth metrics and remains redacted`() {
        val json = BluetoothGattClientLabStatusV1(
            sampleSequence = 3L,
            sampledAtEpochMs = 20L,
            reporterStartedAtEpochMs = 10L,
            snapshot = AndroidGattClientSnapshot(
                state = AndroidGattClientState.AUTHENTICATED,
                profileValidated = true,
                negotiatedMtu = AndroidGattProfileV1.PREFERRED_MTU,
                lastFailure = AndroidGattClientFailure.NONE,
                metrics = AndroidGattClientMetricsSnapshot(
                    connectionAttempts = 1L,
                    connectionsEstablished = 1L,
                    servicesValidated = 1L,
                    mtuNegotiated = 1L,
                    helloWritesStarted = 1L,
                    helloWritesCompleted = 1L,
                    helloReadsCompleted = 1L,
                    helloExchanged = 1L,
                    authSubscriptionsStarted = 1L,
                    authSubscriptionsCompleted = 1L,
                    clientProofWritesCompleted = 1L,
                    serverProofsVerified = 1L,
                    authFinishWritesCompleted = 1L,
                    authenticatedSessions = 1L,
                    disconnects = 0L,
                    failures = 0L,
                    closes = 0L
                ),
                helloEnabled = true,
                helloExchanged = true,
                mutualAuthEnabled = true,
                mutuallyAuthenticated = true,
                authenticatedSessionCount = 1L
            )
        ).toRedactedJson()

        assertTrue(json.contains("\"schemaVersion\":3"))
        assertTrue(json.contains("\"state\":\"AUTHENTICATED\""))
        assertTrue(json.contains("\"profileValidated\":true"))
        assertTrue(json.contains("\"negotiatedMtu\":247"))
        assertTrue(json.contains("\"lastFailure\":\"NONE\""))
        assertTrue(json.contains("\"helloExchanged\":true"))
        assertTrue(json.contains("\"mutualAuthEnabled\":true"))
        assertTrue(json.contains("\"mutuallyAuthenticated\":true"))
        assertTrue(json.contains("\"authenticatedSessionCount\":1"))
        assertTrue(json.contains("\"serverProofsVerified\":1"))
        assertTrue(json.contains("\"authenticatedSessions\":1"))
        assertFalse(json.contains("address", ignoreCase = true))
        assertFalse(json.contains("alias", ignoreCase = true))
        assertFalse(json.contains("nodeId", ignoreCase = true))
        assertFalse(json.contains("sessionId", ignoreCase = true))
        assertFalse(json.contains("certificateId", ignoreCase = true))
        assertFalse(json.contains("signature", ignoreCase = true))
    }

    @Test
    fun `B5_7 lab status reports active control without protocol identifiers`() {
        val json = BluetoothGattClientLabStatusV1(
            sampleSequence = 4L,
            sampledAtEpochMs = 20L,
            reporterStartedAtEpochMs = 10L,
            snapshot = AndroidGattClientSnapshot(
                state = AndroidGattClientState.ACTIVE,
                profileValidated = true,
                negotiatedMtu = AndroidGattProfileV1.PREFERRED_MTU,
                lastFailure = AndroidGattClientFailure.NONE,
                metrics = AndroidGattClientMetricsSnapshot(
                    connectionAttempts = 1L,
                    connectionsEstablished = 1L,
                    servicesValidated = 1L,
                    mtuNegotiated = 1L,
                    authenticatedSessions = 1L,
                    keyExchangesStarted = 1L,
                    clientKeySharesWritten = 1L,
                    serverKeySharesVerified = 1L,
                    clientKeyConfirmsWritten = 1L,
                    keysEstablished = 1L,
                    activationPingsReceived = 1L,
                    activationPongsWritten = 1L,
                    activeSessions = 1L,
                    heartbeatPingsReceived = 3L,
                    heartbeatPongsWritten = 3L,
                    disconnects = 0L,
                    failures = 0L,
                    closes = 0L
                ),
                helloEnabled = true,
                helloExchanged = true,
                mutualAuthEnabled = true,
                mutuallyAuthenticated = true,
                authenticatedSessionCount = 1L,
                sessionKeyEnabled = true,
                keyEstablished = true,
                heartbeatEnabled = true,
                active = true,
                directControlDeadlineActive = true
            )
        ).toRedactedJson()

        assertTrue(json.contains("\"schemaVersion\":4"))
        assertTrue(json.contains("CASSA_V6_ANDROID_DIRECT_CONTROL_LAB"))
        assertTrue(json.contains("\"keyEstablished\":true"))
        assertTrue(json.contains("\"active\":true"))
        assertTrue(json.contains("\"directControlDeadlineActive\":true"))
        assertTrue(json.contains("\"heartbeatPongsWritten\":3"))
        assertFalse(json.contains("sessionId", ignoreCase = true))
        assertFalse(json.contains("publicKey", ignoreCase = true))
        assertFalse(json.contains("confirmation", ignoreCase = true))
        assertFalse(json.contains("\"sequence\"", ignoreCase = true))
    }

    @Test
    fun `lab status retains B5_5 schema when mutual auth is disabled`() {
        val json = BluetoothGattClientLabStatusV1(
            sampleSequence = 1L,
            sampledAtEpochMs = 20L,
            reporterStartedAtEpochMs = 10L,
            snapshot = AndroidGattClientSnapshot(
                state = AndroidGattClientState.HELLO_EXCHANGED,
                profileValidated = true,
                negotiatedMtu = AndroidGattProfileV1.PREFERRED_MTU,
                lastFailure = AndroidGattClientFailure.NONE,
                metrics = AndroidGattClientMetricsSnapshot(
                    connectionAttempts = 1L,
                    connectionsEstablished = 1L,
                    servicesValidated = 1L,
                    mtuNegotiated = 1L,
                    helloWritesStarted = 1L,
                    helloWritesCompleted = 1L,
                    helloReadsCompleted = 1L,
                    helloExchanged = 1L,
                    disconnects = 0L,
                    failures = 0L,
                    closes = 0L
                ),
                helloEnabled = true,
                helloExchanged = true
            )
        ).toRedactedJson()

        assertTrue(json.contains("\"schemaVersion\":2"))
        assertTrue(json.contains("CASSA_V6_ANDROID_GATT_HELLO_LAB"))
        assertTrue(json.contains("\"authenticatedSessionCount\":0"))
        assertFalse(json.contains("mutualAuth"))
        assertFalse(json.contains("authSubscriptionsStarted"))
        assertFalse(json.contains("serverProofsVerified"))
    }

    private fun advertisement(
        kind: BluetoothAdvertisementNodeKind,
        reachable: Boolean,
        capabilities: Int
    ) = BluetoothAdvertisementV1(
        protocolVersion = BluetoothAdvertisementCodecV1.PROTOCOL_VERSION,
        nodeKind = kind,
        rotatingAlias = "aabbccddeeff",
        bootId = 1,
        capabilities = capabilities,
        serverReachable = reachable,
        sequence = 1
    )
}
