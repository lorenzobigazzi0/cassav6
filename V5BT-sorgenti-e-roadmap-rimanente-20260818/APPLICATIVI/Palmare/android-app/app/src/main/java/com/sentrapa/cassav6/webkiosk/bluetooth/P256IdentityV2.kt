package com.sentrapa.cassav6.webkiosk.bluetooth

import java.math.BigInteger
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.spec.X509EncodedKeySpec

object P256SpkiV2 {
    const val PUBLIC_KEY_ALGORITHM = "EC-P256"
    const val JCA_KEY_ALGORITHM = "EC"
    const val CURVE_NAME = "secp256r1"
    const val ENCODING = "spki-der-base64"
    const val DER_BYTES = 91
    const val BASE64_LENGTH = 124

    private const val STANDARD_ALPHABET =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    private val prefix = byteArrayOf(
        0x30,
        0x59,
        0x30,
        0x13,
        0x06,
        0x07,
        0x2a,
        0x86.toByte(),
        0x48,
        0xce.toByte(),
        0x3d,
        0x02,
        0x01,
        0x06,
        0x08,
        0x2a,
        0x86.toByte(),
        0x48,
        0xce.toByte(),
        0x3d,
        0x03,
        0x01,
        0x07,
        0x03,
        0x42,
        0x00,
        0x04
    )

    fun decodeCanonicalBase64(value: String): ByteArray {
        require(value.length == BASE64_LENGTH && value.endsWith("==")) {
            "publicKeySpkiDerBase64 must be canonical padded base64"
        }
        require('=' !in value.dropLast(2)) {
            "publicKeySpkiDerBase64 contains misplaced padding"
        }
        return decodeUnpaddedBase64(
            value = value.dropLast(2),
            alphabet = STANDARD_ALPHABET,
            encodedLength = BASE64_LENGTH - 2,
            decodedLength = DER_BYTES,
            trailingBits = 4,
            field = "publicKeySpkiDerBase64"
        )
    }

    fun isCanonicalP256Spki(spkiDer: ByteArray): Boolean {
        if (
            spkiDer.size != DER_BYTES ||
            prefix.indices.any { index -> spkiDer[index] != prefix[index] }
        ) {
            return false
        }
        return runCatching {
            val publicKey = KeyFactory.getInstance(JCA_KEY_ALGORITHM)
                .generatePublic(X509EncodedKeySpec(spkiDer)) as ECPublicKey
            publicKey.encoded.contentEquals(spkiDer) &&
                publicKey.params.order == P256EcdsaSignatureV2.CURVE_ORDER &&
                publicKey.params.cofactor == 1 &&
                publicKey.params.curve.field.fieldSize == P256_BITS
        }.getOrDefault(false)
    }

    fun sha256Fingerprint(spkiDer: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(spkiDer).toHex()

    private const val P256_BITS = 256
}

object P256EcdsaSignatureV2 {
    const val PROOF_ALGORITHM = "ECDSA-P256-SHA256-P1363"
    const val JCA_SIGNATURE_ALGORITHM = "SHA256withECDSA"
    const val P1363_BYTES = 64

    internal val CURVE_ORDER = BigInteger(
        "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551",
        16
    )
    private val HALF_CURVE_ORDER = CURVE_ORDER.shiftRight(1)

    fun derToCanonicalP1363(derSignature: ByteArray): ByteArray {
        val cursor = DerCursor(derSignature)
        cursor.requireTag(SEQUENCE_TAG)
        val sequenceLength = cursor.readLength()
        require(sequenceLength == cursor.remaining()) {
            "ECDSA DER sequence length is not canonical"
        }
        val r = cursor.readPositiveInteger("r")
        val originalS = cursor.readPositiveInteger("s")
        require(cursor.remaining() == 0) {
            "ECDSA DER signature has trailing data"
        }
        validateScalar(r, "r")
        validateScalar(originalS, "s")
        val s = if (originalS > HALF_CURVE_ORDER) {
            CURVE_ORDER.subtract(originalS)
        } else {
            originalS
        }
        return ByteArray(P1363_BYTES).also { output ->
            writeScalar(r, output, 0)
            writeScalar(s, output, SCALAR_BYTES)
        }
    }

    fun canonicalP1363ToDer(signature: ByteArray): ByteArray {
        require(signature.size == P1363_BYTES) {
            "ECDSA P1363 signature must contain exactly $P1363_BYTES bytes"
        }
        val r = BigInteger(1, signature.copyOfRange(0, SCALAR_BYTES))
        val s = BigInteger(1, signature.copyOfRange(SCALAR_BYTES, P1363_BYTES))
        validateScalar(r, "r")
        validateScalar(s, "s")
        require(s <= HALF_CURVE_ORDER) {
            "ECDSA P1363 signature is not canonical low-S"
        }
        val encodedR = encodePositiveInteger(r)
        val encodedS = encodePositiveInteger(s)
        val sequenceLength = 2 + encodedR.size + 2 + encodedS.size
        require(sequenceLength < 128)
        return ByteArray(2 + sequenceLength).also { output ->
            var offset = 0
            output[offset++] = SEQUENCE_TAG.toByte()
            output[offset++] = sequenceLength.toByte()
            output[offset++] = INTEGER_TAG.toByte()
            output[offset++] = encodedR.size.toByte()
            encodedR.copyInto(output, destinationOffset = offset)
            offset += encodedR.size
            output[offset++] = INTEGER_TAG.toByte()
            output[offset++] = encodedS.size.toByte()
            encodedS.copyInto(output, destinationOffset = offset)
        }
    }

    fun isCanonicalP1363(signature: ByteArray): Boolean =
        runCatching {
            val der = canonicalP1363ToDer(signature)
            derToCanonicalP1363(der).contentEquals(signature)
        }.getOrDefault(false)

    private fun validateScalar(value: BigInteger, field: String) {
        require(value.signum() > 0 && value < CURVE_ORDER) {
            "ECDSA $field scalar is outside the P-256 order"
        }
    }

    private fun writeScalar(value: BigInteger, output: ByteArray, offset: Int) {
        val encoded = unsignedBytes(value)
        require(encoded.size <= SCALAR_BYTES)
        encoded.copyInto(
            output,
            destinationOffset = offset + SCALAR_BYTES - encoded.size
        )
    }

    private fun encodePositiveInteger(value: BigInteger): ByteArray {
        val unsigned = unsignedBytes(value)
        return if (unsigned[0].toInt() and 0x80 != 0) {
            byteArrayOf(0) + unsigned
        } else {
            unsigned
        }
    }

    private fun unsignedBytes(value: BigInteger): ByteArray {
        val encoded = value.toByteArray()
        return if (encoded.size > 1 && encoded[0] == 0.toByte()) {
            encoded.copyOfRange(1, encoded.size)
        } else {
            encoded
        }
    }

    private class DerCursor(private val input: ByteArray) {
        private var offset = 0

        fun remaining(): Int = input.size - offset

        fun requireTag(expected: Int) {
            require(readByte() == expected) { "ECDSA DER tag is invalid" }
        }

        fun readLength(): Int {
            val value = readByte()
            require(value < 0x80) {
                "ECDSA DER uses a non-canonical long-form length"
            }
            require(value <= remaining()) { "ECDSA DER length exceeds input" }
            return value
        }

        fun readPositiveInteger(field: String): BigInteger {
            requireTag(INTEGER_TAG)
            val length = readLength()
            require(length in 1..MAX_DER_INTEGER_BYTES) {
                "ECDSA DER $field length is invalid"
            }
            val encoded = readBytes(length)
            require(encoded[0].toInt() and 0x80 == 0) {
                "ECDSA DER $field is negative"
            }
            require(
                encoded.size == 1 ||
                    encoded[0] != 0.toByte() ||
                    encoded[1].toInt() and 0x80 != 0
            ) {
                "ECDSA DER $field has redundant leading zeroes"
            }
            return BigInteger(1, encoded)
        }

        private fun readByte(): Int {
            require(offset < input.size) { "ECDSA DER input is truncated" }
            return input[offset++].toInt() and 0xff
        }

        private fun readBytes(length: Int): ByteArray {
            require(length <= remaining()) { "ECDSA DER input is truncated" }
            return input.copyOfRange(offset, offset + length).also {
                offset += length
            }
        }
    }

    private const val SEQUENCE_TAG = 0x30
    private const val INTEGER_TAG = 0x02
    private const val SCALAR_BYTES = 32
    private const val MAX_DER_INTEGER_BYTES = SCALAR_BYTES + 1
}
