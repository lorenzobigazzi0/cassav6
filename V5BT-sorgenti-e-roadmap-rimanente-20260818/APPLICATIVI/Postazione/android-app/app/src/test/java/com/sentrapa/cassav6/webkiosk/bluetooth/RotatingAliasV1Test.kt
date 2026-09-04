package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import javax.crypto.spec.SecretKeySpec

class RotatingAliasV1Test {
    @Test
    fun `frozen HMAC SHA-256 vector produces the 48-bit alias`() {
        val aliasKey = SecretKeySpec(
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
                .hexToBytes(),
            RotatingAliasV1.HMAC_ALGORITHM
        )
        val nodeId = "550e8400-e29b-41d4-a716-446655440000"
        val timestampSeconds = 1_710_000_060L

        val epoch = RotatingAliasV1.epoch(timestampSeconds, 60L)

        assertEquals(28_500_001L, epoch)
        assertEquals(
            "43415353415f56362d42542d414c4941532d563100" +
                "35353065383430302d653239622d343164342d613731362d34343636353534343030303000" +
                "0000000001b2e021",
            RotatingAliasV1.buildMessage(nodeId, epoch).toHex()
        )
        assertEquals(
            "a20dd6c6a124",
            RotatingAliasV1.deriveHex(aliasKey, nodeId, timestampSeconds, 60L)
        )
    }

    @Test
    fun `alias remains stable in one epoch and rotates at the boundary`() {
        val aliasKey = SecretKeySpec(ByteArray(32) { it.toByte() }, "HmacSHA256")
        val nodeId = "550e8400-e29b-41d4-a716-446655440000"

        val first = RotatingAliasV1.deriveHex(aliasKey, nodeId, 1_710_000_060L, 60L)
        val sameEpoch = RotatingAliasV1.deriveHex(aliasKey, nodeId, 1_710_000_119L, 60L)
        val nextEpoch = RotatingAliasV1.deriveHex(aliasKey, nodeId, 1_710_000_120L, 60L)

        assertEquals(first, sameEpoch)
        assertNotEquals(first, nextEpoch)
    }

    @Test
    fun `invalid inputs are rejected before HMAC`() {
        val shortKey = SecretKeySpec(ByteArray(31), "HmacSHA256")
        val validKey = SecretKeySpec(ByteArray(32), "HmacSHA256")
        val nodeId = "550e8400-e29b-41d4-a716-446655440000"

        assertThrows(IllegalArgumentException::class.java) {
            RotatingAliasV1.deriveHex(shortKey, nodeId, 0L)
        }
        assertThrows(IllegalArgumentException::class.java) {
            RotatingAliasV1.deriveHex(validKey, "not-a-node-id", 0L)
        }
        assertThrows(IllegalArgumentException::class.java) {
            RotatingAliasV1.deriveHex(validKey, nodeId.uppercase(), 0L)
        }
        assertThrows(IllegalArgumentException::class.java) {
            RotatingAliasV1.deriveHex(validKey, nodeId, -1L)
        }
        assertThrows(IllegalArgumentException::class.java) {
            RotatingAliasV1.deriveHex(validKey, nodeId, 0L, 0L)
        }
    }
}

private fun String.hexToBytes(): ByteArray {
    require(length % 2 == 0)
    return chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
