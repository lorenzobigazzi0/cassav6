package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ReliableChannelTest {
    @Test
    fun `durable delivery ACK and persistent dedup complete end to end`() {
        val clock = MutableClock(NOW)
        val outboundA = mutableListOf<ByteArray>()
        val outboundB = mutableListOf<ByteArray>()
        val delivered = mutableListOf<ByteArray>()
        val storeA = InMemoryReliableChannelStoreV1()
        val storeB = InMemoryReliableChannelStoreV1()
        var committedBeforeTransport = false
        val channelA = channel(
            transport = {
                committedBeforeTransport =
                    committedBeforeTransport || storeA.snapshot().outboxDepth == 1
                outboundA += it.copyOf()
            },
            store = storeA,
            clock = clock,
            txKey = KEY_A,
            rxKey = KEY_B,
            txPrefix = PREFIX_A,
            rxPrefix = PREFIX_B,
            generatedIds = IdSource(ACK_A_ID)
        )
        val channelB = channel(
            transport = { outboundB += it.copyOf() },
            store = storeB,
            clock = clock,
            txKey = KEY_B,
            rxKey = KEY_A,
            txPrefix = PREFIX_B,
            rxPrefix = PREFIX_A,
            generatedIds = IdSource(ACK_B_ID, ACK_B_DUPLICATE_ID),
            peerTrustId = PEER_TRUST_A,
            onMessage = { delivered += it.payload.copyOf() }
        )

        try {
            val sent = channelA.send(
                ReliableChannelSendInputV1(
                    type = ReliableFrameTypeV1.SHADOW_DIAGNOSTIC,
                    payload = "health-only".toByteArray(),
                    durable = true,
                    messageId = MESSAGE_ID
                )
            )
            assertEquals(MESSAGE_ID, sent.messageId)
            assertTrue(sent.durableCommitted)
            assertTrue(committedBeforeTransport)
            assertEquals(1, storeA.snapshot().outboxDepth)
            val originalFrames = outboundA.map { it.copyOf() }

            val receiveResults = drain(outboundA, channelB)
            assertTrue(receiveResults.last().complete)
            assertTrue(receiveResults.last().delivered)
            assertArrayEquals("health-only".toByteArray(), delivered.single())
            assertEquals(1, storeB.snapshot().inboxDedupDepth)

            drain(outboundB, channelA)
            assertEquals(0, storeA.snapshot().outboxDepth)
            assertEquals(0, channelA.snapshot().pendingMessages)
            assertEquals(1, channelA.snapshot().acknowledgementsRx)

            val duplicateResults = originalFrames.map(channelB::receiveFragment)
            assertTrue(duplicateResults.last().duplicate)
            assertFalse(duplicateResults.last().delivered)
            assertEquals(1, channelB.snapshot().duplicates)
            assertEquals(1, delivered.size)
        } finally {
            channelA.close()
            channelB.close()
            storeA.close()
            storeB.close()
            outboundA.forEach { it.fill(0) }
            outboundB.forEach { it.fill(0) }
            delivered.forEach { it.fill(0) }
        }
    }

    @Test
    fun `durable outbox restores into a fresh channel and clears after ACK`() {
        val clock = MutableClock(NOW)
        val durableStore = InMemoryReliableChannelStoreV1()
        val abandonedFrames = mutableListOf<ByteArray>()
        val first = channel(
            transport = { abandonedFrames += it.copyOf() },
            store = durableStore,
            clock = clock,
            generatedIds = IdSource(ACK_A_ID)
        )
        first.send(
            ReliableChannelSendInputV1(
                ReliableFrameTypeV1.ROUTE_ADVERTISEMENT,
                "route-test".toByteArray(),
                durable = true,
                messageId = MESSAGE_ID
            )
        )
        first.close()
        assertEquals(1, durableStore.snapshot().outboxDepth)

        val outbound = mutableListOf<ByteArray>()
        val acknowledgements = mutableListOf<ByteArray>()
        val delivered = mutableListOf<ByteArray>()
        val receiverStore = InMemoryReliableChannelStoreV1()
        val restored = channel(
            transport = { outbound += it.copyOf() },
            store = durableStore,
            clock = clock,
            generatedIds = IdSource(ACK_A_ID)
        )
        val receiver = channel(
            transport = { acknowledgements += it.copyOf() },
            store = receiverStore,
            clock = clock,
            txKey = KEY_B,
            rxKey = KEY_A,
            txPrefix = PREFIX_B,
            rxPrefix = PREFIX_A,
            generatedIds = IdSource(ACK_B_ID),
            peerTrustId = PEER_TRUST_A,
            onMessage = { delivered += it.payload.copyOf() }
        )

        try {
            assertEquals(1, restored.restoreDurableOutbox())
            drain(outbound, receiver)
            drain(acknowledgements, restored)

            assertEquals(0, durableStore.snapshot().outboxDepth)
            assertEquals(0, restored.snapshot().pendingMessages)
            assertArrayEquals("route-test".toByteArray(), delivered.single())
        } finally {
            restored.close()
            receiver.close()
            durableStore.close()
            receiverStore.close()
            abandonedFrames.forEach { it.fill(0) }
            outbound.forEach { it.fill(0) }
            acknowledgements.forEach { it.fill(0) }
            delivered.forEach { it.fill(0) }
        }
    }

    @Test
    fun `retry schedule suspends durable messages and explicit resume restarts attempts`() {
        val clock = MutableClock(NOW)
        val frames = mutableListOf<ByteArray>()
        val store = InMemoryReliableChannelStoreV1()
        val channel = channel(
            transport = { frames += it.copyOf() },
            store = store,
            clock = clock,
            maxAttempts = 3,
            baseRetryMs = 100,
            generatedIds = IdSource(ACK_A_ID)
        )

        try {
            channel.send(
                ReliableChannelSendInputV1(
                    ReliableFrameTypeV1.DATA,
                    "test-only".toByteArray(),
                    durable = true,
                    messageId = MESSAGE_ID
                )
            )
            val initialFrameCount = frames.size

            clock.value = NOW + 100
            assertEquals(1, channel.tick().retried)
            clock.value = NOW + 300
            assertEquals(1, channel.tick().retried)
            clock.value = NOW + 700
            val suspended = channel.tick()
            assertEquals(1, suspended.suspended)
            assertEquals(1, channel.snapshot().suspendedMessages)
            assertEquals(1, store.snapshot().outboxDepth)
            assertEquals(2, channel.snapshot().retries)
            assertEquals(initialFrameCount * 3, frames.size)

            assertEquals(1, channel.resumeSuspended())
            assertEquals(1, channel.tick().retried)
            assertEquals(0, channel.snapshot().suspendedMessages)
            assertEquals(1, store.snapshot().outboxDepth)
        } finally {
            channel.close()
            store.close()
            frames.forEach { it.fill(0) }
        }
    }

    @Test
    fun `TTL expiry clears pending durable state`() {
        val clock = MutableClock(NOW)
        val store = InMemoryReliableChannelStoreV1()
        val channel = channel(
            transport = {},
            store = store,
            clock = clock,
            generatedIds = IdSource(ACK_A_ID)
        )

        try {
            channel.send(
                ReliableChannelSendInputV1(
                    ReliableFrameTypeV1.DATA,
                    byteArrayOf(1),
                    durable = true,
                    ttlMs = 1_000,
                    messageId = MESSAGE_ID
                )
            )
            clock.value = NOW + 1_000
            val result = channel.tick()

            assertEquals(1, result.expired)
            assertEquals(0, store.snapshot().outboxDepth)
            assertEquals(0, channel.snapshot().pendingMessages)
        } finally {
            channel.close()
            store.close()
        }
    }

    @Test
    fun `upper layer failure rolls back dedup and allows a clean retry`() {
        val clock = MutableClock(NOW)
        val senderFrames = mutableListOf<ByteArray>()
        var deliveryAttempts = 0
        val receiverStore = InMemoryReliableChannelStoreV1()
        val sender = channel(
            transport = { senderFrames += it.copyOf() },
            store = InMemoryReliableChannelStoreV1(),
            clock = clock,
            generatedIds = IdSource(ACK_A_ID)
        )
        val receiver = channel(
            transport = {},
            store = receiverStore,
            clock = clock,
            txKey = KEY_B,
            rxKey = KEY_A,
            txPrefix = PREFIX_B,
            rxPrefix = PREFIX_A,
            generatedIds = IdSource(ACK_B_ID),
            peerTrustId = PEER_TRUST_A,
            onMessage = {
                deliveryAttempts += 1
                throw IllegalStateException("diagnostic consumer unavailable")
            }
        )

        try {
            sender.send(
                ReliableChannelSendInputV1(
                    ReliableFrameTypeV1.DATA,
                    "test-only".toByteArray(),
                    messageId = MESSAGE_ID
                )
            )
            val original = senderFrames.map { it.copyOf() }
            assertChannelError("DELIVERY_FAILED") {
                original.forEach(receiver::receiveFragment)
            }
            assertEquals(0, receiverStore.snapshot().inboxDedupDepth)
            assertChannelError("DELIVERY_FAILED") {
                original.forEach(receiver::receiveFragment)
            }
            assertEquals(2, deliveryAttempts)
            assertEquals(2, receiver.snapshot().deliveryFailures)
        } finally {
            sender.close()
            receiver.close()
            receiverStore.close()
            senderFrames.forEach { it.fill(0) }
        }
    }

    @Test
    fun `durable records never restore across peer trust contexts`() {
        val clock = MutableClock(NOW)
        val store = InMemoryReliableChannelStoreV1()
        val first = channel(
            transport = {},
            store = store,
            clock = clock,
            peerTrustId = PEER_TRUST_A,
            generatedIds = IdSource(ACK_A_ID)
        )
        first.send(
            ReliableChannelSendInputV1(
                ReliableFrameTypeV1.DATA,
                "peer-a".toByteArray(),
                durable = true,
                messageId = MESSAGE_ID
            )
        )
        first.close()

        val otherPeer = channel(
            transport = {},
            store = store,
            clock = clock,
            peerTrustId = PEER_TRUST_B,
            generatedIds = IdSource(ACK_B_ID)
        )
        try {
            assertEquals(0, otherPeer.restoreDurableOutbox())
            otherPeer.send(
                ReliableChannelSendInputV1(
                    ReliableFrameTypeV1.DATA,
                    "peer-b".toByteArray(),
                    durable = true,
                    messageId = MESSAGE_ID
                )
            )
            assertEquals(2, store.snapshot().outboxDepth)
        } finally {
            otherPeer.close()
            store.close()
        }
    }

    @Test
    fun `clock regression invalid random and reserved ACK fail closed`() {
        val clock = MutableClock(NOW)
        val channel = channel(
            transport = {},
            store = InMemoryReliableChannelStoreV1(),
            clock = clock,
            random = { 1.0 },
            generatedIds = IdSource(ACK_A_ID)
        )

        try {
            assertChannelError("ACK_RESERVED") {
                channel.send(
                    ReliableChannelSendInputV1(
                        ReliableFrameTypeV1.ACK,
                        byteArrayOf(),
                        messageId = MESSAGE_ID
                    )
                )
            }
            assertChannelError("INVALID_RANDOM_SOURCE") {
                channel.send(
                    ReliableChannelSendInputV1(
                        ReliableFrameTypeV1.DATA,
                        byteArrayOf(),
                        messageId = MESSAGE_ID
                    )
                )
            }
            assertChannelError("OUTBOX_CONFLICT") {
                channel.send(
                    ReliableChannelSendInputV1(
                        ReliableFrameTypeV1.DATA,
                        byteArrayOf(),
                        messageId = MESSAGE_ID
                    )
                )
            }

            clock.value = NOW - 1
            assertChannelError("CLOCK_REGRESSION") { channel.tick() }
        } finally {
            channel.close()
        }
    }

    private fun channel(
        transport: ReliableChannelTransportV1,
        store: ReliableChannelStoreV1,
        clock: MutableClock,
        txKey: ByteArray = KEY_A,
        rxKey: ByteArray = KEY_B,
        txPrefix: ByteArray = PREFIX_A,
        rxPrefix: ByteArray = PREFIX_B,
        maxAttempts: Int = 5,
        baseRetryMs: Long = 250,
        random: () -> Double = { 0.0 },
        generatedIds: IdSource,
        peerTrustId: String = PEER_TRUST_B,
        onMessage: ReliableChannelMessageHandlerV1 = ReliableChannelMessageHandlerV1 {}
    ): ReliableChannelV1 =
        ReliableChannelV1(
            transport = transport,
            peerTrustId = peerTrustId,
            mtu = 64,
            txKey = txKey,
            rxKey = rxKey,
            txNoncePrefix = txPrefix,
            rxNoncePrefix = rxPrefix,
            onMessage = onMessage,
            store = store,
            maxAttempts = maxAttempts,
            baseRetryMs = baseRetryMs,
            maxRetryMs = 8_000,
            random = random,
            now = { clock.value },
            messageIdGenerator = generatedIds::next
        )

    private fun drain(
        frames: MutableList<ByteArray>,
        receiver: ReliableChannelV1
    ): List<ReliableChannelReceiveResultV1> {
        val copy = frames.toList()
        frames.clear()
        return copy.map(receiver::receiveFragment)
    }

    private fun assertChannelError(code: String, operation: () -> Unit) {
        val error = assertThrows(ReliableChannelException::class.java) { operation() }
        assertEquals(code, error.code)
    }

    private class MutableClock(var value: Long)

    private class IdSource(vararg values: String) {
        private val values = ArrayDeque(values.toList())

        fun next(): String = values.removeFirst()
    }

    companion object {
        private const val NOW = 1_800_000_000_000L
        private const val MESSAGE_ID = "00112233445566778899aabbccddeeff"
        private const val ACK_A_ID = "10112233445566778899aabbccddeeff"
        private const val ACK_B_ID = "20112233445566778899aabbccddeeff"
        private const val ACK_B_DUPLICATE_ID = "30112233445566778899aabbccddeeff"
        private const val PEER_TRUST_A =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        private const val PEER_TRUST_B =
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        private val KEY_A = ByteArray(32) { 0x11 }
        private val KEY_B = ByteArray(32) { 0x22 }
        private val PREFIX_A = ByteArray(8) { 0x33 }
        private val PREFIX_B = ByteArray(8) { 0x44 }
    }
}
