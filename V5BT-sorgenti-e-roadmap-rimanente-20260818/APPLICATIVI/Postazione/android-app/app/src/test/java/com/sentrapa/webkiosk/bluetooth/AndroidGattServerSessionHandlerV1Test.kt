package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidGattServerSessionHandlerV1Test {
    @Test
    fun `HELLO round trip binds the opaque session and is replay idempotent`() {
        val handler = handler()
        val request = request()
        val encoded = BluetoothHelloCodecV1.encode(request)

        assertStatus(
            AndroidGattServerAccessStatusV1.SUCCESS,
            handler.onConnected(7L, 1_000L)
        )
        assertStatus(
            AndroidGattServerAccessStatusV1.SUCCESS,
            handler.onMtuChanged(7L, BluetoothHelloCodecV1.MINIMUM_MTU, 1_001L)
        )
        assertStatus(
            AndroidGattServerAccessStatusV1.SUCCESS,
            handler.onWrite(
                7L,
                AndroidGattProfileV1.helloUuid,
                offset = 0,
                preparedWrite = false,
                value = encoded,
                nowElapsedMs = 1_002L
            )
        )
        assertStatus(
            AndroidGattServerAccessStatusV1.SUCCESS,
            handler.onWrite(
                7L,
                AndroidGattProfileV1.helloUuid,
                offset = 0,
                preparedWrite = false,
                value = encoded,
                nowElapsedMs = 1_003L
            )
        )

        val read = handler.onRead(
            7L,
            AndroidGattProfileV1.helloUuid,
            offset = 0,
            nowElapsedMs = 1_004L
        )
        assertStatus(AndroidGattServerAccessStatusV1.SUCCESS, read)
        val response = BluetoothHelloCodecV1.decode(requireNotNull(read.valueCopy()))
        assertEquals(request.sessionId, response.sessionId)
        assertEquals(LOCAL_NODE_ID, response.nodeId)
        assertEquals(LOCAL_BOOT_ID, response.bootId)
        assertEquals(BluetoothCapabilityBitsV1.B2_FULL_NODE, response.capabilities)
        assertNotEquals(request.nonce, response.nonce)

        val snapshot = handler.snapshot()
        assertEquals(1, snapshot.sessionCount)
        assertEquals(0, snapshot.secureActiveSessionCount)
        assertEquals(1, snapshot.securePromotionBlockedSessionCount)
        assertEquals(1L, snapshot.sessionsAccepted)
        assertEquals(1L, snapshot.helloWritesAccepted)
        assertEquals(1L, snapshot.helloReadsCompleted)
        handler.onDisconnected(7L)
        assertEquals(0, handler.snapshot().sessionCount)
        encoded.fill(0)
    }

    @Test
    fun `HELLO read honors offsets and result buffers are defensive copies`() {
        val handler = readyHandler(peerToken = 1L)
        val write = handler.onWrite(
            1L,
            AndroidGattProfileV1.helloUuid,
            offset = 0,
            preparedWrite = false,
            value = BluetoothHelloCodecV1.encode(request()),
            nowElapsedMs = 12L
        )
        assertStatus(AndroidGattServerAccessStatusV1.SUCCESS, write)
        val full = requireNotNull(
            handler.onRead(1L, AndroidGattProfileV1.helloUuid, 0, 13L).valueCopy()
        )
        val tailResult = handler.onRead(
            1L,
            AndroidGattProfileV1.helloUuid,
            11,
            14L
        )
        val firstCopy = requireNotNull(tailResult.valueCopy())
        assertArrayEquals(full.copyOfRange(11, full.size), firstCopy)
        firstCopy.fill(0)
        assertArrayEquals(
            full.copyOfRange(11, full.size),
            requireNotNull(tailResult.valueCopy())
        )
    }

    @Test
    fun `malformed HELLO variants invalidate the session`() {
        val cases = listOf<(V5btGattServerSessionHandlerV1) -> AndroidGattServerHandlerResultV1>(
            { value ->
                value.onWrite(
                    1L,
                    AndroidGattProfileV1.helloUuid,
                    1,
                    false,
                    BluetoothHelloCodecV1.encode(request()),
                    12L
                )
            },
            { value ->
                value.onWrite(
                    1L,
                    AndroidGattProfileV1.helloUuid,
                    0,
                    true,
                    BluetoothHelloCodecV1.encode(request()),
                    12L
                )
            },
            { value ->
                value.onWrite(
                    1L,
                    AndroidGattProfileV1.helloUuid,
                    0,
                    false,
                    ByteArray(BluetoothHelloCodecV1.WIRE_BYTES - 1),
                    12L
                )
            },
            { value ->
                value.onWrite(
                    1L,
                    AndroidGattProfileV1.helloUuid,
                    0,
                    false,
                    BluetoothHelloCodecV1.encode(
                        request().copy(capabilities = BluetoothCapabilityBitsV1.SCAN)
                    ),
                    12L
                )
            }
        )

        cases.forEach { invoke ->
            val handler = readyHandler(peerToken = 1L)
            assertNotEquals(AndroidGattServerAccessStatusV1.SUCCESS, invoke(handler).status)
            assertEquals(0, handler.snapshot().sessionCount)
        }
    }

    @Test
    fun `HELLO requires an ATT MTU large enough for the exact frame`() {
        val handler = handler()
        handler.onConnected(1L, 10L)

        val result = handler.onWrite(
            1L,
            AndroidGattProfileV1.helloUuid,
            0,
            false,
            BluetoothHelloCodecV1.encode(request()),
            11L
        )

        assertStatus(AndroidGattServerAccessStatusV1.REQUEST_NOT_SUPPORTED, result)
        assertTrue(result.disconnect)
        assertEquals(0, handler.snapshot().sessionCount)
    }

    @Test
    fun `conflicting HELLO replay fails closed`() {
        val handler = readyHandler(peerToken = 1L)
        val first = BluetoothHelloCodecV1.encode(request())
        val second = BluetoothHelloCodecV1.encode(
            request().copy(sessionId = "AQEBAQEBAQEBAQEBAQEBAQ")
        )
        handler.onWrite(1L, AndroidGattProfileV1.helloUuid, 0, false, first, 12L)

        val result = handler.onWrite(
            1L,
            AndroidGattProfileV1.helloUuid,
            0,
            false,
            second,
            13L
        )

        assertStatus(AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION, result)
        assertTrue(result.disconnect)
        assertEquals(0, handler.snapshot().sessionCount)
        assertEquals(1L, handler.snapshot().protocolFailures)
    }

    @Test
    fun `control data metrics and subscriptions remain outside this boundary`() {
        val operations = listOf<(V5btGattServerSessionHandlerV1) -> AndroidGattServerHandlerResultV1>(
            { value ->
                value.onWrite(
                    1L,
                    AndroidGattProfileV1.controlRxUuid,
                    0,
                    false,
                    byteArrayOf(1),
                    12L
                )
            },
            { value ->
                value.onRead(1L, AndroidGattProfileV1.characteristicUuids.last(), 0, 12L)
            },
            { value ->
                value.onSubscriptionChanged(
                    1L,
                    AndroidGattProfileV1.controlTxUuid,
                    enabled = true,
                    indicate = true,
                    nowElapsedMs = 12L
                )
            }
        )

        operations.forEach { invoke ->
            val handler = readyHandler(peerToken = 1L)
            val result = invoke(handler)
            assertStatus(AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION, result)
            assertTrue(result.disconnect)
            assertEquals(0, handler.snapshot().sessionCount)
        }
    }

    @Test
    fun `capacity timeout reset and disabled mode are fail closed`() {
        val handler = V5btGattServerSessionHandlerV1(
            enabled = true,
            helloEnabled = true,
            localContextProvider = ::localContext,
            maximumSessions = 2,
            sessionIdleTimeoutMs = 1_000L
        )
        assertStatus(AndroidGattServerAccessStatusV1.SUCCESS, handler.onConnected(1L, 0L))
        assertStatus(AndroidGattServerAccessStatusV1.SUCCESS, handler.onConnected(2L, 0L))
        assertStatus(AndroidGattServerAccessStatusV1.BUSY, handler.onConnected(3L, 0L))
        assertEquals(setOf(1L, 2L), handler.expire(1_001L))
        assertEquals(0, handler.snapshot().sessionCount)
        assertEquals(2L, handler.snapshot().sessionsExpired)

        handler.onConnected(4L, 2_000L)
        handler.reset()
        assertEquals(0, handler.snapshot().sessionCount)

        val disabled = V5btGattServerSessionHandlerV1(
            enabled = false,
            helloEnabled = false,
            localContextProvider = { null }
        )
        assertStatus(AndroidGattServerAccessStatusV1.BUSY, disabled.onConnected(1L, 0L))
        assertFalse(disabled.snapshot().enabled)
        assertNull(disabled.onConnected(2L, 0L).valueCopy())
    }

    @Test
    fun `regressive monotonic clock invalidates the affected session`() {
        val handler = readyHandler(peerToken = 1L)

        val result = handler.onRead(
            1L,
            AndroidGattProfileV1.helloUuid,
            offset = 0,
            nowElapsedMs = 9L
        )

        assertStatus(AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION, result)
        assertTrue(result.disconnect)
        assertEquals(0, handler.snapshot().sessionCount)
        assertEquals(1L, handler.snapshot().protocolFailures)
    }

    private fun readyHandler(peerToken: Long): V5btGattServerSessionHandlerV1 =
        handler().also {
            assertStatus(AndroidGattServerAccessStatusV1.SUCCESS, it.onConnected(peerToken, 10L))
            assertStatus(
                AndroidGattServerAccessStatusV1.SUCCESS,
                it.onMtuChanged(peerToken, BluetoothHelloCodecV1.MINIMUM_MTU, 11L)
            )
        }

    private fun handler() = V5btGattServerSessionHandlerV1(
        enabled = true,
        helloEnabled = true,
        localContextProvider = ::localContext,
        randomBytes = { length -> ByteArray(length) { 0x2a } }
    )

    private fun localContext() = AndroidGattServerLocalContextV1(
        nodeId = LOCAL_NODE_ID,
        advertisement = BluetoothAdvertisementV1(
            protocolVersion = BluetoothAdvertisementCodecV1.PROTOCOL_VERSION,
            nodeKind = BluetoothAdvertisementNodeKind.HANDHELD,
            rotatingAlias = "aabbccddeeff",
            bootId = LOCAL_BOOT_ID,
            capabilities = BluetoothCapabilityBitsV1.B2_FULL_NODE,
            serverReachable = false,
            sequence = 3
        )
    )

    private fun request() = BluetoothHelloV1(
        protocolVersion = BluetoothHelloCodecV1.PROTOCOL_VERSION,
        sessionId = "AbCdEfGhIjKlMnOpQrStUg",
        nodeId = "550e8400-e29b-41d4-a716-446655440000",
        bootId = 17,
        capabilities = BluetoothCapabilityBitsV1.GATT_CLIENT,
        nonce = "AAECAwQFBgcICQoLDA0ODw"
    )

    private fun assertStatus(
        expected: AndroidGattServerAccessStatusV1,
        result: AndroidGattServerHandlerResultV1
    ) {
        assertEquals(expected, result.status)
    }

    companion object {
        private const val LOCAL_NODE_ID = "123e4567-e89b-12d3-a456-426614174000"
        private const val LOCAL_BOOT_ID = 31
    }
}
