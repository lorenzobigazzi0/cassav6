package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class FrameCodecTest {
    private val key = ByteArray(32) { 0x45 }
    private val noncePrefix = hex("0102030405060708")

    @Test
    fun `control key separation matches frozen Node vector and returns both directions`() {
        val clientControlKey = ByteArray(32) { it.toByte() }
        val serverControlKey = ByteArray(32) { (31 - it).toByte() }
        val originalClientKey = clientControlKey.copyOf()
        val material = deriveReliableChannelMaterialV1(
            clientControlKey,
            serverControlKey
        )
        val clientDataKey = material.clientToServer.key
        val clientNoncePrefix = material.clientToServer.noncePrefix
        val serverDataKey = material.serverToClient.key
        val serverNoncePrefix = material.serverToClient.noncePrefix

        try {
            assertEquals(EXPECTED_DATA_KEY, clientDataKey.toHex())
            assertEquals(EXPECTED_DATA_NONCE_PREFIX, clientNoncePrefix.toHex())
            assertFalse(clientDataKey.contentEquals(serverDataKey))
            assertFalse(clientNoncePrefix.contentEquals(serverNoncePrefix))
            assertArrayEquals(originalClientKey, clientControlKey)
            assertFalse(material.toString().contains(EXPECTED_DATA_KEY))
        } finally {
            clientDataKey.fill(0)
            clientNoncePrefix.fill(0)
            serverDataKey.fill(0)
            serverNoncePrefix.fill(0)
            originalClientKey.fill(0)
            material.close()
        }
        assertTrue(material.isClosed)
        assertThrows(IllegalStateException::class.java) {
            material.clientToServer.key
        }
        assertFrameError("INVALID_KEY_MATERIAL") {
            deriveReliableChannelDirectionMaterialV1(ByteArray(31))
        }
    }

    @Test
    fun `frozen TypeScript AES GCM vector matches every byte`() {
        val frames = encode()

        assertEquals(1, frames.size)
        assertEquals(EXPECTED_WIRE, frames.single().toHex())
        assertEquals(14, ReliableFrameCodecV1.HEADER_BYTES)
        assertEquals(16_384, ReliableFrameCodecV1.MAX_PAYLOAD_BYTES)

        val decoded = ReliableFrameCodecV1.decode(
            ReliableFrameDecodeInputV1(frames, key, noncePrefix, NOW)
        )
        try {
            assertEquals(ReliableFrameTypeV1.DATA, decoded.type)
            assertEquals(ReliableFrameFlagsV1.DURABLE, decoded.flags)
            assertEquals(7, decoded.sequence)
            assertEquals(MESSAGE_ID, decoded.messageId)
            assertEquals(NOW + 60_000, decoded.expiresAtEpochMs)
            assertArrayEquals("v5bt reliable payload".toByteArray(), decoded.payload)
        } finally {
            decoded.payload.fill(0)
        }
    }

    @Test
    fun `round trip supports ATT fallback MTUs and out of order fragments`() {
        val payload = ByteArray(1_337) { (it and 0xff).toByte() }

        listOf(23, 64, 247, 517).forEach { mtu ->
            val frames = encode(payload = payload, mtu = mtu)
            assertTrue(frames.all { it.size <= mtu - 3 })
            val decoded = ReliableFrameCodecV1.decode(
                ReliableFrameDecodeInputV1(frames.reversed(), key, noncePrefix, NOW)
            )
            try {
                assertArrayEquals(payload, decoded.payload)
            } finally {
                decoded.payload.fill(0)
                frames.forEach { it.fill(0) }
            }
        }
    }

    @Test
    fun `authenticated metadata ciphertext key and nonce fail closed`() {
        val frames = encode()
        val changedType = frames.map { it.copyOf() }.also {
            it.first()[3] = ReliableFrameTypeV1.ROUTE_ADVERTISEMENT.wireValue.toByte()
        }
        val changedCiphertext = frames.map { it.copyOf() }.also {
            val last = it.last()
            last[last.lastIndex] = (last.last().toInt() xor 0x80).toByte()
        }

        assertFrameError("AUTHENTICATION_FAILED") {
            ReliableFrameCodecV1.decode(
                ReliableFrameDecodeInputV1(changedType, key, noncePrefix, NOW)
            )
        }
        assertFrameError("AUTHENTICATION_FAILED") {
            ReliableFrameCodecV1.decode(
                ReliableFrameDecodeInputV1(changedCiphertext, key, noncePrefix, NOW)
            )
        }
        assertFrameError("AUTHENTICATION_FAILED") {
            ReliableFrameCodecV1.decode(
                ReliableFrameDecodeInputV1(
                    frames,
                    ByteArray(32) { 0x46 },
                    noncePrefix,
                    NOW
                )
            )
        }
        assertFrameError("AUTHENTICATION_FAILED") {
            ReliableFrameCodecV1.decode(
                ReliableFrameDecodeInputV1(
                    frames,
                    key,
                    ByteArray(8) { 0x09 },
                    NOW
                )
            )
        }
    }

    @Test
    fun `TTL identifiers payload limits and reserved header are enforced`() {
        val expired = encode(expiresAtEpochMs = NOW + 1)
        assertFrameError("MESSAGE_EXPIRED") {
            ReliableFrameCodecV1.decode(
                ReliableFrameDecodeInputV1(expired, key, noncePrefix, NOW + 1)
            )
        }
        assertFrameError("INVALID_MESSAGE_ID") {
            encode(messageId = MESSAGE_ID.uppercase())
        }
        assertFrameError("PAYLOAD_TOO_LARGE") {
            encode(payload = ByteArray(ReliableFrameCodecV1.MAX_PAYLOAD_BYTES + 1))
        }
        assertFrameError("INVALID_FRAME_FIELD") {
            encode(mtu = 22)
        }

        val reserved = encode(payload = byteArrayOf()).single().copyOf()
        reserved[5] = 1
        assertFrameError("INVALID_FRAME_RESERVED") {
            ReliableFrameCodecV1.decodeFragment(reserved)
        }
    }

    @Test
    fun `reassembler accepts retries completes out of order and prunes`() {
        val frames = encode(payload = ByteArray(64) { 0x62 }, mtu = 23)
        val reassembler = ReliableFrameReassemblerV1()

        assertNull(reassembler.accept(frames.first(), NOW))
        assertNull(reassembler.accept(frames.first(), NOW + 1))
        val completed = frames.drop(1).reversed().fold(null as List<ByteArray>?) { result, frame ->
            reassembler.accept(frame, NOW + 2) ?: result
        }
        requireNotNull(completed)
        val decoded = ReliableFrameCodecV1.decode(
            ReliableFrameDecodeInputV1(completed, key, noncePrefix, NOW)
        )
        try {
            assertArrayEquals(ByteArray(64) { 0x62 }, decoded.payload)
            assertEquals(ReliableFrameReassemblySnapshotV1(0, 0), reassembler.snapshot())
        } finally {
            decoded.payload.fill(0)
            completed.forEach { it.fill(0) }
        }

        assertNull(reassembler.accept(frames.first(), NOW + 10))
        assertEquals(1, reassembler.prune(NOW + 30_010))
        assertEquals(ReliableFrameReassemblySnapshotV1(0, 0), reassembler.snapshot())
    }

    @Test
    fun `reassembler rejects conflicting duplicates and enforces byte bounds`() {
        val frames = encode(payload = ByteArray(64) { 0x61 }, mtu = 23)
        val reassembler = ReliableFrameReassemblerV1()
        reassembler.accept(frames.first(), NOW)
        val conflict = frames.first().copyOf().also {
            it[it.lastIndex] = (it.last().toInt() xor 1).toByte()
        }
        assertFrameError("FRAGMENT_CONFLICT") {
            reassembler.accept(conflict, NOW + 1)
        }
        assertEquals(ReliableFrameReassemblySnapshotV1(0, 0), reassembler.snapshot())

        val bounded = ReliableFrameReassemblerV1(maximumBufferedBytes = 1_024)
        val largeFrames = encode(payload = ByteArray(1_337), mtu = 517)
        assertFrameError("REASSEMBLY_BYTE_LIMIT") {
            largeFrames.forEach { bounded.accept(it, NOW) }
        }
        assertEquals(ReliableFrameReassemblySnapshotV1(0, 0), bounded.snapshot())
    }

    @Test
    fun `sequence bound nonces create distinct authenticated wire`() {
        val first = encode(sequence = 1)
        val second = encode(sequence = 2)

        assertNotEquals(first.joinToString { it.toHex() }, second.joinToString { it.toHex() })
        assertEquals(1, ReliableFrameCodecV1.decodeFragment(first.first()).sequence)
        assertEquals(2, ReliableFrameCodecV1.decodeFragment(second.first()).sequence)
    }

    private fun encode(
        payload: ByteArray = "v5bt reliable payload".toByteArray(),
        mtu: Int = 247,
        sequence: Long = 7,
        messageId: String = MESSAGE_ID,
        expiresAtEpochMs: Long = NOW + 60_000
    ): List<ByteArray> =
        ReliableFrameCodecV1.encode(
            ReliableFrameEncodeInputV1(
                type = ReliableFrameTypeV1.DATA,
                flags = ReliableFrameFlagsV1.DURABLE,
                sequence = sequence,
                messageId = messageId,
                expiresAtEpochMs = expiresAtEpochMs,
                payload = payload,
                mtu = mtu,
                key = key,
                noncePrefix = noncePrefix
            )
        )

    private fun assertFrameError(code: String, operation: () -> Unit) {
        val error = assertThrows(ReliableFrameException::class.java) { operation() }
        assertEquals(code, error.code)
    }

    private fun hex(value: String): ByteArray =
        value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    private fun ByteArray.toHex(): String =
        joinToString(separator = "") { "%02x".format(it.toInt() and 0xff) }

    companion object {
        private const val MESSAGE_ID = "00112233445566778899aabbccddeeff"
        private const val NOW = 1_800_000_000_000L
        private const val EXPECTED_WIRE =
            "c5b7010101000000000700000001" +
                "d94d823f34ae4b048f8750ab83add6bbbb79ffe40ec49d22a05ab7984f0b9c" +
                "4c3fc126f62576f635a8e43cbc65493363576b78bf7ec3506a582e1fd3a7c4d1f570"
        private const val EXPECTED_DATA_KEY =
            "b4e326395fd563d2f68097a6434498eeb7dc81c98adafcac51771ddce9c2a511"
        private const val EXPECTED_DATA_NONCE_PREFIX = "1b296bcdee534f82"
    }
}
