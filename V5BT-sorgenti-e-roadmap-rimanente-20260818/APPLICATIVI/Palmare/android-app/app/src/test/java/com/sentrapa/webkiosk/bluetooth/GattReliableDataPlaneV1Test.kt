package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GattReliableDataPlaneV1Test {
    @Test
    fun `client and server planes bind reliable channel to durable stores`() {
        val storeA = InMemoryReliableChannelStoreV1()
        val storeB = InMemoryReliableChannelStoreV1()
        val delivered = mutableListOf<ByteArray>()
        val publishedA = mutableListOf<GattReliableTransmitterV1>()
        val publishedB = mutableListOf<GattReliableTransmitterV1>()
        var committedBeforePublish = false
        val client = plane(GattReliableEndpointRoleV1.CLIENT, storeA)
        val server = plane(GattReliableEndpointRoleV1.SERVER, storeB) {
            delivered += it.payload.copyOf()
        }
        subscribe(client)
        subscribe(server)
        client.setPublisher { transmitter, frame ->
            publishedA += transmitter
            committedBeforePublish =
                committedBeforePublish || storeA.snapshot().outboxDepth == 1
            server.receive(SESSION_TOKEN, frame)
        }
        server.setPublisher { transmitter, frame ->
            publishedB += transmitter
            client.receive(SESSION_TOKEN, frame)
        }

        try {
            val result = client.send(
                SESSION_TOKEN,
                ReliableChannelSendInputV1(
                    ReliableFrameTypeV1.SHADOW_DIAGNOSTIC,
                    "diagnostic-only".toByteArray(),
                    durable = true,
                    messageId = MESSAGE_ID
                )
            )
            assertTrue(result.durableCommitted)
            assertTrue(committedBeforePublish)
            assertArrayEquals("diagnostic-only".toByteArray(), delivered.single())
            assertEquals(0, storeA.snapshot().outboxDepth)
            assertTrue(publishedA.all { it == GattReliableTransmitterV1.DATA })
            assertTrue(publishedB.all { it == GattReliableTransmitterV1.ACK })
            assertEquals(1, client.snapshot().sessionBinds)
            assertEquals(1, server.snapshot().sessionBinds)
            assertEquals(0, client.snapshot().channel!!.pendingMessages)
        } finally {
            client.close()
            server.close()
            storeA.close()
            storeB.close()
            delivered.forEach { it.fill(0) }
        }
    }

    @Test
    fun `feature subscriptions authorization and publisher fail closed`() {
        val store = InMemoryReliableChannelStoreV1()
        val disabled = GattReliableDataPlaneV1(
            contextProvider = provider(GattReliableEndpointRoleV1.CLIENT),
            store = store,
            onMessage = {}
        )
        assertPlaneError("DATA_PLANE_DISABLED") {
            disabled.send(SESSION_TOKEN, sendInput())
        }

        val enabled = plane(GattReliableEndpointRoleV1.CLIENT, store)
        assertPlaneError("DATA_SUBSCRIPTION_REQUIRED") {
            enabled.send(SESSION_TOKEN, sendInput())
        }
        enabled.setSubscription(GattReliableTransmitterV1.DATA, true)
        assertPlaneError("ACK_SUBSCRIPTION_REQUIRED") {
            enabled.send(SESSION_TOKEN, sendInput())
        }
        enabled.setSubscription(GattReliableTransmitterV1.ACK, true)
        assertPlaneError("PUBLISHER_NOT_READY") {
            enabled.send(SESSION_TOKEN, sendInput())
        }

        val unauthorized = GattReliableDataPlaneV1(
            contextProvider = { error("no active authenticated session") },
            store = InMemoryReliableChannelStoreV1(),
            onMessage = {},
            enabled = true,
            now = { NOW }
        )
        subscribe(unauthorized)
        unauthorized.setPublisher { _, _ -> }
        assertPlaneError("RELIABLE_CHANNEL_NOT_AUTHORIZED") {
            unauthorized.restore(SESSION_TOKEN)
        }
        assertFalse(unauthorized.snapshot().bound)

        disabled.close()
        enabled.close()
        unauthorized.close()
        store.close()
    }

    @Test
    fun `session arbitration and authorization revalidation reset the plane`() {
        val store = InMemoryReliableChannelStoreV1()
        var authorized = true
        var peerTrustId = PEER_TRUST_A
        val plane = GattReliableDataPlaneV1(
            contextProvider = {
                if (!authorized) error("revoked")
                context(GattReliableEndpointRoleV1.CLIENT, peerTrustId)
            },
            store = store,
            onMessage = {},
            enabled = true,
            now = { NOW }
        )
        subscribe(plane)
        plane.setPublisher { _, _ -> }

        try {
            assertEquals(0, plane.restore(SESSION_TOKEN))
            assertTrue(plane.snapshot().bound)
            assertPlaneError("SESSION_ARBITRATION_CONFLICT") {
                plane.restore(SESSION_TOKEN + 1)
            }
            peerTrustId = PEER_TRUST_B
            assertPlaneError("PEER_TRUST_MISMATCH") {
                plane.restore(SESSION_TOKEN)
            }
            assertFalse(plane.snapshot().bound)
            subscribe(plane)
            authorized = false
            assertPlaneError("RELIABLE_CHANNEL_NOT_AUTHORIZED") {
                plane.restore(SESSION_TOKEN)
            }
            assertFalse(plane.snapshot().bound)
            assertEquals(1, plane.snapshot().resets)
        } finally {
            plane.close()
            store.close()
        }
    }

    @Test
    fun `context owns and clears derived directional material`() {
        val value = context(GattReliableEndpointRoleV1.CLIENT)
        assertFalse(value.material.isClosed)
        assertFalse(value.toString().contains(CONTROL_KEY_HEX))
        value.close()
        assertTrue(value.material.isClosed)
    }

    @Test
    fun `application adapter carries only route and shadow over the bound plane`() {
        val storeA = InMemoryReliableChannelStoreV1()
        val storeB = InMemoryReliableChannelStoreV1()
        val received = mutableListOf<ReliableFrameTypeV1>()
        val client = plane(GattReliableEndpointRoleV1.CLIENT, storeA)
        val server = plane(GattReliableEndpointRoleV1.SERVER, storeB) {
            received += it.type
        }
        subscribe(client)
        subscribe(server)
        client.setPublisher { _, frame -> server.receive(SESSION_TOKEN, frame) }
        server.setPublisher { _, frame -> client.receive(SESSION_TOKEN, frame) }
        val adapter = GattReliableApplicationChannelV1(client)

        try {
            client.restore(SESSION_TOKEN)
            adapter.send(
                ReliableChannelSendInputV1(
                    ReliableFrameTypeV1.ROUTE_ADVERTISEMENT,
                    ByteArray(12),
                    durable = false
                )
            )
            adapter.send(
                ReliableChannelSendInputV1(
                    ReliableFrameTypeV1.SHADOW_DIAGNOSTIC,
                    "health".toByteArray(),
                    durable = false
                )
            )
            assertEquals(
                listOf(
                    ReliableFrameTypeV1.ROUTE_ADVERTISEMENT,
                    ReliableFrameTypeV1.SHADOW_DIAGNOSTIC
                ),
                received
            )
        } finally {
            client.close()
            server.close()
            storeA.close()
            storeB.close()
        }
    }

    private fun plane(
        role: GattReliableEndpointRoleV1,
        store: ReliableChannelStoreV1,
        onMessage: ReliableChannelMessageHandlerV1 = ReliableChannelMessageHandlerV1 {}
    ): GattReliableDataPlaneV1 = GattReliableDataPlaneV1(
        contextProvider = provider(role),
        store = store,
        onMessage = onMessage,
        enabled = true,
        now = { NOW }
    )

    private fun provider(role: GattReliableEndpointRoleV1) =
        GattReliableSessionContextProviderV1 { context(role) }

    private fun context(
        role: GattReliableEndpointRoleV1,
        peerTrustId: String = PEER_TRUST_A
    ): GattReliableChannelContextV1 =
        GattReliableChannelContextV1(
            peerTrustId = peerTrustId,
            mtu = 247,
            role = role,
            material = deriveReliableChannelMaterialV1(CONTROL_KEY, REVERSE_CONTROL_KEY)
        )

    private fun subscribe(plane: GattReliableDataPlaneV1) {
        plane.setSubscription(GattReliableTransmitterV1.DATA, true)
        plane.setSubscription(GattReliableTransmitterV1.ACK, true)
    }

    private fun sendInput() = ReliableChannelSendInputV1(
        ReliableFrameTypeV1.SHADOW_DIAGNOSTIC,
        byteArrayOf(1),
        messageId = MESSAGE_ID
    )

    private fun assertPlaneError(code: String, operation: () -> Unit) {
        val error = assertThrows(GattReliableDataPlaneExceptionV1::class.java) {
            operation()
        }
        assertEquals(code, error.code)
    }

    companion object {
        private const val NOW = 1_800_000_000_000L
        private const val SESSION_TOKEN = 1L
        private const val MESSAGE_ID = "00112233445566778899aabbccddeeff"
        private const val PEER_TRUST_A =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        private const val PEER_TRUST_B =
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        private const val CONTROL_KEY_HEX =
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
        private val CONTROL_KEY = ByteArray(32) { it.toByte() }
        private val REVERSE_CONTROL_KEY = ByteArray(32) { (31 - it).toByte() }
    }
}
