package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidGattReliableSessionLifecycleV1Test {
    @Test
    fun `disconnect resets same peer token before rebinding new session keys`() {
        val store = InMemoryReliableChannelStoreV1()
        var sessionGeneration = 0
        val keyA = ByteArray(32) { it.toByte() }
        val reverseA = ByteArray(32) { (31 - it).toByte() }
        val keyB = ByteArray(32) { (it + 32).toByte() }
        val reverseB = ByteArray(32) { (63 - it).toByte() }
        val captured = mutableListOf<ByteArray>()
        val plane = GattReliableDataPlaneV1(
            contextProvider = {
                val forward = if (sessionGeneration == 0) keyA else keyB
                val reverse = if (sessionGeneration == 0) reverseA else reverseB
                GattReliableChannelContextV1(
                    peerTrustId = PEER_TRUST_ID,
                    mtu = 247,
                    role = GattReliableEndpointRoleV1.CLIENT,
                    material = deriveReliableChannelMaterialV1(forward, reverse)
                )
            },
            store = store,
            onMessage = {},
            enabled = true,
            now = { NOW }
        )
        var bridge: AndroidGattReliableDataPlaneBridgeV1? = null
        try {
            val firstBridge = openClientBridge(plane, captured)
            bridge = firstBridge
            plane.send(SESSION_TOKEN, input("session-a", MESSAGE_A))
            assertTrue(plane.snapshot().bound)
            assertEquals(1, plane.snapshot().sessionBinds)

            firstBridge.close()
            bridge = null
            assertFalse(plane.snapshot().bound)
            assertEquals(1, plane.snapshot().resets)

            sessionGeneration = 1
            val secondBridge = openClientBridge(plane, captured)
            bridge = secondBridge
            plane.send(SESSION_TOKEN, input("session-b", MESSAGE_B))
            assertTrue(plane.snapshot().bound)
            assertEquals(2, plane.snapshot().sessionBinds)
            assertEquals(2, captured.size)

            val oldMaterial = deriveReliableChannelDirectionMaterialV1(keyA)
            val newMaterial = deriveReliableChannelDirectionMaterialV1(keyB)
            try {
                assertThrows(ReliableFrameException::class.java) {
                    ReliableFrameCodecV1.decode(
                        ReliableFrameDecodeInputV1(
                            fragments = listOf(captured[1]),
                            key = oldMaterial.key,
                            noncePrefix = oldMaterial.noncePrefix,
                            nowEpochMs = NOW
                        )
                    )
                }
                val decoded = ReliableFrameCodecV1.decode(
                    ReliableFrameDecodeInputV1(
                        fragments = listOf(captured[1]),
                        key = newMaterial.key,
                        noncePrefix = newMaterial.noncePrefix,
                        nowEpochMs = NOW
                    )
                )
                try {
                    assertEquals("session-b", decoded.payload.toString(Charsets.UTF_8))
                } finally {
                    decoded.payload.fill(0)
                }
            } finally {
                oldMaterial.close()
                newMaterial.close()
            }
        } finally {
            bridge?.close()
            plane.close()
            store.close()
            captured.forEach { it.fill(0) }
            keyA.fill(0)
            reverseA.fill(0)
            keyB.fill(0)
            reverseB.fill(0)
        }
    }

    private fun openClientBridge(
        plane: GattReliableDataPlaneV1,
        captured: MutableList<ByteArray>
    ): AndroidGattReliableDataPlaneBridgeV1 =
        AndroidGattReliableDataPlaneBridgeV1(
            role = GattReliableEndpointRoleV1.CLIENT,
            sessionToken = SESSION_TOKEN,
            dataPlane = AndroidGattReliableDataPlaneBindingAdapterV1(plane),
            physicalPublisher = AndroidGattReliablePhysicalPublisherV1 { target, frame ->
                assertEquals(AndroidGattProfileV1.dataRxUuid, target.characteristicUuid)
                assertEquals(AndroidGattReliableDeliveryV1.WRITE_REQUEST, target.delivery)
                captured += frame.copyOf()
            }
        ).also {
            it.setTransmitterReady(GattReliableTransmitterV1.DATA, true)
            it.setTransmitterReady(GattReliableTransmitterV1.ACK, true)
        }

    private fun input(body: String, messageId: String) = ReliableChannelSendInputV1(
        type = ReliableFrameTypeV1.SHADOW_DIAGNOSTIC,
        payload = body.toByteArray(),
        messageId = messageId
    )

    companion object {
        private const val NOW = 1_800_000_000_000L
        private const val SESSION_TOKEN = 1L
        private const val PEER_TRUST_ID =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        private const val MESSAGE_A = "00112233445566778899aabbccddeeff"
        private const val MESSAGE_B = "ffeeddccbbaa99887766554433221100"
    }
}
