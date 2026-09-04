package com.sentrapa.cassav6.webkiosk.bluetooth

import javax.crypto.Mac
import javax.crypto.SecretKey

object RotatingAliasV1 {
    const val ALIAS_BYTES = 6
    const val ALIAS_KEY_BYTES = 32
    const val DEFAULT_EPOCH_SECONDS = 60L
    const val HMAC_ALGORITHM = "HmacSHA256"

    private const val CONTEXT = "CASSA_V6-BT-ALIAS-V1\u0000"
    private val nodeIdPattern = Regex(
        "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    )

    fun isCanonicalNodeId(nodeId: String): Boolean = nodeIdPattern.matches(nodeId)

    fun isValidNodeId(nodeId: String): Boolean = isCanonicalNodeId(nodeId)

    fun epoch(
        timestampSeconds: Long,
        epochSeconds: Long = DEFAULT_EPOCH_SECONDS
    ): Long {
        require(timestampSeconds >= 0L) {
            "timestampSeconds must be non-negative"
        }
        require(epochSeconds in 1L..86_400L) {
            "epochSeconds must be between 1 and 86400"
        }
        return timestampSeconds / epochSeconds
    }

    fun buildMessage(nodeId: String, epoch: Long): ByteArray {
        require(isCanonicalNodeId(nodeId)) {
            "nodeId must be a canonical lowercase RFC 4122 UUID"
        }
        require(epoch >= 0L) {
            "epoch must be non-negative"
        }

        val prefix = (CONTEXT + nodeId + "\u0000")
            .toByteArray(Charsets.UTF_8)
        return ByteArray(prefix.size + Long.SIZE_BYTES).also { message ->
            prefix.copyInto(message)
            for (index in 0 until Long.SIZE_BYTES) {
                val shift = (Long.SIZE_BYTES - 1 - index) * Byte.SIZE_BITS
                message[prefix.size + index] = (epoch ushr shift).toByte()
            }
        }
    }

    fun deriveHex(
        aliasKey: SecretKey,
        nodeId: String,
        timestampSeconds: Long,
        epochSeconds: Long = DEFAULT_EPOCH_SECONDS
    ): String {
        require(aliasKey.algorithm.equals(HMAC_ALGORITHM, ignoreCase = true)) {
            "aliasKey must use HmacSHA256"
        }
        aliasKey.encoded?.let { encoded ->
            require(encoded.size == ALIAS_KEY_BYTES) {
                "aliasKey must be exactly 32 bytes"
            }
        }

        val currentEpoch = epoch(timestampSeconds, epochSeconds)
        val mac = Mac.getInstance(HMAC_ALGORITHM)
        mac.init(aliasKey)
        return mac.doFinal(buildMessage(nodeId, currentEpoch))
            .copyOfRange(0, ALIAS_BYTES)
            .toHex()
    }
}

internal fun ByteArray.toHex(): String =
    joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
