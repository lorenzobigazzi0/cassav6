package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidGattReliableDataPlaneBridgeV1Test {
    @Test
    fun `client maps writes and inbound notifications without crossing DATA and ACK`() {
        val binding = FakeBinding()
        val physical = FakePhysicalPublisher()
        val bridge = AndroidGattReliableDataPlaneBridgeV1(
            role = GattReliableEndpointRoleV1.CLIENT,
            sessionToken = 1,
            dataPlane = binding,
            physicalPublisher = AndroidGattReliablePhysicalPublisherV1(physical::publish)
        )
        val data = frame(ReliableFrameTypeV1.DATA, 1)
        val ack = frame(ReliableFrameTypeV1.ACK, 2)
        try {
            bridge.setTransmitterReady(GattReliableTransmitterV1.DATA, true)
            bridge.setTransmitterReady(GattReliableTransmitterV1.ACK, true)
            binding.publish(GattReliableTransmitterV1.DATA, data)
            binding.publish(GattReliableTransmitterV1.ACK, ack)

            assertEquals(2, physical.targets.size)
            physical.targets.forEach { target ->
                assertEquals(AndroidGattProfileV1.dataRxUuid, target.characteristicUuid)
                assertEquals(AndroidGattReliableDeliveryV1.WRITE_REQUEST, target.delivery)
            }

            bridge.receive(AndroidGattProfileV1.dataTxUuid, data)
            bridge.receive(AndroidGattProfileV1.ackTxUuid, ack)
            val error = assertThrows(
                AndroidGattReliableDataPlaneBridgeExceptionV1::class.java
            ) {
                bridge.receive(AndroidGattProfileV1.dataTxUuid, ack)
            }
            assertEquals("INVALID_INBOUND_CHARACTERISTIC", error.code)
            val snapshot = bridge.snapshot()
            assertTrue(snapshot.dataReady)
            assertTrue(snapshot.ackReady)
            assertEquals(1, snapshot.dataPublished)
            assertEquals(1, snapshot.ackPublished)
            assertEquals(1, snapshot.dataReceived)
            assertEquals(1, snapshot.ackReceived)
            assertEquals(1, snapshot.rejected)
        } finally {
            bridge.close()
            physical.close()
            data.fill(0)
            ack.fill(0)
        }
        assertNull(binding.currentPublisher)
        assertEquals(1, binding.resets)
        assertFalse(bridge.snapshot().dataReady)
        assertTrue(bridge.snapshot().closed)
    }

    @Test
    fun `server accepts only dataRx and maps DATA notify plus ACK indicate`() {
        val binding = FakeBinding()
        val physical = FakePhysicalPublisher()
        val bridge = AndroidGattReliableDataPlaneBridgeV1(
            role = GattReliableEndpointRoleV1.SERVER,
            sessionToken = 7,
            dataPlane = binding,
            physicalPublisher = AndroidGattReliablePhysicalPublisherV1(physical::publish)
        )
        val data = frame(ReliableFrameTypeV1.ROUTE_ADVERTISEMENT, 3)
        val ack = frame(ReliableFrameTypeV1.ACK, 4)
        try {
            bridge.setTransmitterReady(GattReliableTransmitterV1.DATA, true)
            bridge.setTransmitterReady(GattReliableTransmitterV1.ACK, true)
            binding.publish(GattReliableTransmitterV1.DATA, data)
            binding.publish(GattReliableTransmitterV1.ACK, ack)

            assertEquals(
                AndroidGattReliablePublishTargetV1(
                    AndroidGattProfileV1.dataTxUuid,
                    AndroidGattReliableDeliveryV1.NOTIFY
                ),
                physical.targets[0]
            )
            assertEquals(
                AndroidGattReliablePublishTargetV1(
                    AndroidGattProfileV1.ackTxUuid,
                    AndroidGattReliableDeliveryV1.INDICATE
                ),
                physical.targets[1]
            )
            bridge.receive(AndroidGattProfileV1.dataRxUuid, data)
            bridge.receive(AndroidGattProfileV1.dataRxUuid, ack)
            assertThrows(AndroidGattReliableDataPlaneBridgeExceptionV1::class.java) {
                bridge.receive(AndroidGattProfileV1.dataTxUuid, data)
            }
            assertEquals(1, bridge.snapshot().dataReceived)
            assertEquals(1, bridge.snapshot().ackReceived)
        } finally {
            bridge.close()
            physical.close()
            data.fill(0)
            ack.fill(0)
        }
    }

    private fun frame(type: ReliableFrameTypeV1, sequence: Long): ByteArray {
        val key = ByteArray(ReliableFrameCodecV1.KEY_BYTES) { 1 }
        val nonce = ByteArray(ReliableFrameCodecV1.NONCE_PREFIX_BYTES) { 2 }
        return try {
            ReliableFrameCodecV1.encode(
                ReliableFrameEncodeInputV1(
                    type = type,
                    sequence = sequence,
                    messageId = "00112233445566778899aabbccddeeff",
                    expiresAtEpochMs = 1_900_000_000_000,
                    payload = byteArrayOf(1),
                    mtu = 247,
                    key = key,
                    noncePrefix = nonce
                )
            ).single()
        } finally {
            key.fill(0)
            nonce.fill(0)
        }
    }

    private class FakeBinding : AndroidGattReliableDataPlaneBindingV1 {
        var currentPublisher: GattReliablePublisherV1? = null
        var resets = 0

        override fun setPublisher(value: GattReliablePublisherV1?) {
            currentPublisher = value
        }

        override fun setSubscription(
            transmitter: GattReliableTransmitterV1,
            enabled: Boolean
        ) = Unit

        override fun receive(
            sessionToken: Long,
            frame: ByteArray
        ) = ReliableChannelReceiveResultV1(true, true, false)

        override fun reset() {
            resets += 1
        }

        override fun snapshot() = GattReliableDataPlaneSnapshotV1(
            enabled = true,
            bound = true,
            dataSubscribed = true,
            ackSubscribed = true,
            receivedFragments = 0,
            publishedFragments = 0,
            sessionBinds = 1,
            resets = resets.toLong(),
            failures = 0,
            channel = null
        )

        fun publish(transmitter: GattReliableTransmitterV1, frame: ByteArray) {
            checkNotNull(currentPublisher).publish(transmitter, frame)
        }
    }

    private class FakePhysicalPublisher : AutoCloseable {
        val targets = mutableListOf<AndroidGattReliablePublishTargetV1>()
        private val frames = mutableListOf<ByteArray>()

        fun publish(target: AndroidGattReliablePublishTargetV1, frame: ByteArray) {
            targets += target
            frames += frame.copyOf()
        }

        override fun close() {
            frames.forEach { it.fill(0) }
            frames.clear()
        }
    }
}
