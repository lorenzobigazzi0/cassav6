package com.sentrapa.webkiosk.bluetooth

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

data class BluetoothEnrollmentQrV1(
    val version: Int,
    val enrollmentEndpointId: String,
    val token: String
)

data class BluetoothEnrollmentRequestV1(
    val protocolVersion: Int,
    val enrollmentEndpointId: String,
    val token: String,
    val nodeId: String,
    val publicKeySpkiDerBase64: String,
    val proofSignatureBase64: String
)

enum class BluetoothEnrollmentParseCode {
    INVALID_JSON,
    DUPLICATE_FIELD,
    MISSING_OR_EXTRA_FIELD,
    INVALID_FIELD_TYPE,
    INVALID_FIELD_VALUE,
    INPUT_TOO_LARGE
}

sealed class BluetoothEnrollmentParseResult<out T> {
    data class Ready<T>(val value: T) : BluetoothEnrollmentParseResult<T>()
    data class Failure(
        val code: BluetoothEnrollmentParseCode
    ) : BluetoothEnrollmentParseResult<Nothing>()
}

sealed class BluetoothEnrollmentClaimResult {
    data class Ready(
        val request: BluetoothEnrollmentRequestV1
    ) : BluetoothEnrollmentClaimResult()

    data class Failure(
        val status: DeviceIdentityStatus
    ) : BluetoothEnrollmentClaimResult()
}

object BluetoothEnrollmentProtocolV1 {
    const val PROTOCOL_VERSION = 1
    const val PUBLIC_KEY_ALGORITHM = "Ed25519"
    const val PROOF_ALGORITHM = "Ed25519"
    const val PROOF_CONTEXT = "CASSAV5BT-BT-ENROLLMENT-PROOF-V1"
    const val ENROLLMENT_PATH = "/v1/enroll"
    const val MAX_QR_BYTES = 512
    const val MAX_RESPONSE_BYTES = 4096

    private val endpointIdPattern =
        Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    private val tokenPattern =
        Regex("^c5e1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$")
    private val signaturePattern =
        Regex("^[A-Za-z0-9+/]{85}[AQgw]==$")

    fun isCanonicalEndpointId(value: String): Boolean =
        endpointIdPattern.matches(value)

    fun isCanonicalToken(value: String): Boolean =
        tokenPattern.matches(value) &&
            runCatching {
                decodeCanonicalBase64Url(value.removePrefix("c5e1_"), 32)
            }.getOrNull() != null

    fun isCanonicalSignature(value: String): Boolean =
        signaturePattern.matches(value)

    fun proofBytes(
        protocolVersion: Int,
        enrollmentEndpointId: String,
        token: String,
        nodeId: String,
        publicKeySpkiDerBase64: String
    ): ByteArray =
        listOf(
            PROOF_CONTEXT,
            protocolVersion.toString(),
            enrollmentEndpointId,
            token,
            nodeId,
            publicKeySpkiDerBase64
        ).joinToString("\u0000").toByteArray(Charsets.UTF_8)

    private fun decodeCanonicalBase64Url(
        value: String,
        expectedBytes: Int
    ): ByteArray {
        val alphabet =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        val output = ByteArray(expectedBytes)
        var accumulator = 0
        var bits = 0
        var outputIndex = 0
        value.forEach { character ->
            val digit = alphabet.indexOf(character)
            require(digit >= 0) { "invalid base64url character" }
            accumulator = (accumulator shl 6) or digit
            bits += 6
            if (bits >= 8) {
                bits -= 8
                require(outputIndex < output.size) { "decoded value is too long" }
                output[outputIndex] = (accumulator shr bits).toByte()
                outputIndex += 1
                accumulator = accumulator and ((1 shl bits) - 1)
            }
        }
        require(outputIndex == expectedBytes && accumulator == 0) {
            "non-canonical base64url"
        }
        return output
    }
}

object BluetoothEnrollmentJsonV1 {
    private val qrFields = setOf(
        "version",
        "enrollmentEndpointId",
        "token"
    )
    private val responseFields = setOf(
        "protocolVersion",
        "nodeId",
        "certificateId",
        "publicKeyAlgorithm",
        "publicKeySpkiDerBase64",
        "aliasKeyAlgorithm",
        "aliasKeyEncoding",
        "aliasKeyBase64url",
        "enrolledAt"
    )

    fun parseQr(raw: ByteArray): BluetoothEnrollmentParseResult<BluetoothEnrollmentQrV1> {
        if (raw.size > BluetoothEnrollmentProtocolV1.MAX_QR_BYTES) {
            return failure(BluetoothEnrollmentParseCode.INPUT_TOO_LARGE)
        }
        return parseObject(raw, qrFields) { fields ->
            val version = fields["version"] as? Int
                ?: return@parseObject failure(
                    BluetoothEnrollmentParseCode.INVALID_FIELD_TYPE
                )
            val endpointId = fields["enrollmentEndpointId"] as? String
                ?: return@parseObject failure(
                    BluetoothEnrollmentParseCode.INVALID_FIELD_TYPE
                )
            val token = fields["token"] as? String
                ?: return@parseObject failure(
                    BluetoothEnrollmentParseCode.INVALID_FIELD_TYPE
                )
            if (
                version != BluetoothEnrollmentProtocolV1.PROTOCOL_VERSION ||
                !BluetoothEnrollmentProtocolV1.isCanonicalEndpointId(endpointId) ||
                !BluetoothEnrollmentProtocolV1.isCanonicalToken(token)
            ) {
                return@parseObject failure(
                    BluetoothEnrollmentParseCode.INVALID_FIELD_VALUE
                )
            }
            BluetoothEnrollmentParseResult.Ready(
                BluetoothEnrollmentQrV1(version, endpointId, token)
            )
        }
    }

    fun parseResponse(
        raw: ByteArray
    ): BluetoothEnrollmentParseResult<Map<String, Any?>> {
        if (raw.size > BluetoothEnrollmentProtocolV1.MAX_RESPONSE_BYTES) {
            return failure(BluetoothEnrollmentParseCode.INPUT_TOO_LARGE)
        }
        return parseObject(raw, responseFields) { fields ->
            BluetoothEnrollmentParseResult.Ready(fields)
        }
    }

    internal fun parseExactFlatObject(
        raw: ByteArray,
        expectedFields: Set<String>,
        maxBytes: Int
    ): BluetoothEnrollmentParseResult<Map<String, Any?>> {
        if (raw.size > maxBytes) {
            return failure(BluetoothEnrollmentParseCode.INPUT_TOO_LARGE)
        }
        return parseObject(raw, expectedFields) { fields ->
            BluetoothEnrollmentParseResult.Ready(fields)
        }
    }

    fun encodeRequest(request: BluetoothEnrollmentRequestV1): ByteArray {
        require(
            request.protocolVersion ==
                BluetoothEnrollmentProtocolV1.PROTOCOL_VERSION &&
                BluetoothEnrollmentProtocolV1.isCanonicalEndpointId(
                    request.enrollmentEndpointId
                ) &&
                BluetoothEnrollmentProtocolV1.isCanonicalToken(request.token) &&
                RotatingAliasV1.isCanonicalNodeId(request.nodeId) &&
                runCatching {
                    val publicKey = Ed25519SpkiV1.decodeCanonicalBase64(
                        request.publicKeySpkiDerBase64
                    )
                    Ed25519SpkiV1.isCanonicalEd25519Spki(publicKey)
                }.getOrDefault(false) &&
                BluetoothEnrollmentProtocolV1.isCanonicalSignature(
                    request.proofSignatureBase64
                )
        ) {
            "Enrollment request is not canonical"
        }
        return (
            "{\"protocolVersion\":${request.protocolVersion}," +
                "\"enrollmentEndpointId\":\"${request.enrollmentEndpointId}\"," +
                "\"token\":\"${request.token}\"," +
                "\"nodeId\":\"${request.nodeId}\"," +
                "\"publicKeyAlgorithm\":\"" +
                "${BluetoothEnrollmentProtocolV1.PUBLIC_KEY_ALGORITHM}\"," +
                "\"publicKeySpkiDerBase64\":\"" +
                "${request.publicKeySpkiDerBase64}\"," +
                "\"proofAlgorithm\":\"" +
                "${BluetoothEnrollmentProtocolV1.PROOF_ALGORITHM}\"," +
                "\"proofSignatureBase64\":\"${request.proofSignatureBase64}\"}"
            ).toByteArray(Charsets.UTF_8)
    }

    private fun <T> parseObject(
        raw: ByteArray,
        expectedFields: Set<String>,
        build: (Map<String, Any?>) -> BluetoothEnrollmentParseResult<T>
    ): BluetoothEnrollmentParseResult<T> {
        return try {
            val fields = StrictFlatJsonObjectReader(raw).read()
            if (fields.keys != expectedFields) {
                return failure(
                    BluetoothEnrollmentParseCode.MISSING_OR_EXTRA_FIELD
                )
            }
            build(fields)
        } catch (error: StrictJsonException) {
            failure(error.code)
        } catch (_: Exception) {
            failure(BluetoothEnrollmentParseCode.INVALID_JSON)
        }
    }

    private fun <T> failure(
        code: BluetoothEnrollmentParseCode
    ): BluetoothEnrollmentParseResult<T> =
        BluetoothEnrollmentParseResult.Failure(code)

    private class StrictJsonException(
        val code: BluetoothEnrollmentParseCode
    ) : Exception()

    /**
     * Enrollment v1 deliberately uses one flat object of scalar values. This
     * reader implements that exact grammar so duplicate decoded names cannot be
     * overwritten as they are by JSONObject and JSON.parse.
     */
    private class StrictFlatJsonObjectReader(raw: ByteArray) {
        private val text =
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(raw))
                .toString()
        private var index = 0

        fun read(): Map<String, Any?> {
            val result = linkedMapOf<String, Any?>()
            skipWhitespace()
            requireCharacter('{')
            skipWhitespace()
            if (consume('}')) {
                finish()
                return result
            }
            while (true) {
                val name = readString()
                if (result.containsKey(name)) {
                    fail(BluetoothEnrollmentParseCode.DUPLICATE_FIELD)
                }
                skipWhitespace()
                requireCharacter(':')
                skipWhitespace()
                result[name] = readScalar()
                skipWhitespace()
                if (consume('}')) break
                requireCharacter(',')
                skipWhitespace()
            }
            finish()
            return result
        }

        private fun readScalar(): Any =
            if (peek() == '"') {
                readString()
            } else {
                readNumber()
            }

        private fun readNumber(): Number {
            val start = index
            if (peek() == '-') index += 1
            when {
                peek() == '0' -> index += 1
                peek() in '1'..'9' -> {
                    index += 1
                    while (peek() in '0'..'9') index += 1
                }
                else -> fail(BluetoothEnrollmentParseCode.INVALID_FIELD_TYPE)
            }
            var integral = true
            if (peek() == '.') {
                integral = false
                index += 1
                if (peek() !in '0'..'9') {
                    fail(BluetoothEnrollmentParseCode.INVALID_JSON)
                }
                while (peek() in '0'..'9') index += 1
            }
            if (peek() == 'e' || peek() == 'E') {
                integral = false
                index += 1
                if (peek() == '+' || peek() == '-') index += 1
                if (peek() !in '0'..'9') {
                    fail(BluetoothEnrollmentParseCode.INVALID_JSON)
                }
                while (peek() in '0'..'9') index += 1
            }
            val token = text.substring(start, index)
            return if (integral) {
                token.toIntOrNull()
                    ?: fail(BluetoothEnrollmentParseCode.INVALID_FIELD_TYPE)
            } else {
                token.toDoubleOrNull()
                    ?.takeIf(Double::isFinite)
                    ?: fail(BluetoothEnrollmentParseCode.INVALID_FIELD_TYPE)
            }
        }

        private fun readString(): String {
            requireCharacter('"')
            val value = StringBuilder()
            while (index < text.length) {
                val character = text[index++]
                when {
                    character == '"' -> return value.toString()
                    character == '\\' -> value.append(readEscape())
                    character.code < 0x20 ->
                        fail(BluetoothEnrollmentParseCode.INVALID_JSON)
                    else -> value.append(character)
                }
            }
            fail(BluetoothEnrollmentParseCode.INVALID_JSON)
        }

        private fun readEscape(): Char {
            if (index >= text.length) {
                fail(BluetoothEnrollmentParseCode.INVALID_JSON)
            }
            return when (val escaped = text[index++]) {
                '"', '\\', '/' -> escaped
                'b' -> '\b'
                'f' -> '\u000c'
                'n' -> '\n'
                'r' -> '\r'
                't' -> '\t'
                'u' -> {
                    if (index + 4 > text.length) {
                        fail(BluetoothEnrollmentParseCode.INVALID_JSON)
                    }
                    val codePoint = text.substring(index, index + 4)
                        .toIntOrNull(16)
                        ?: fail(BluetoothEnrollmentParseCode.INVALID_JSON)
                    index += 4
                    codePoint.toChar()
                }
                else -> fail(BluetoothEnrollmentParseCode.INVALID_JSON)
            }
        }

        private fun finish() {
            skipWhitespace()
            if (index != text.length) {
                fail(BluetoothEnrollmentParseCode.INVALID_JSON)
            }
        }

        private fun requireCharacter(expected: Char) {
            if (!consume(expected)) {
                fail(BluetoothEnrollmentParseCode.INVALID_JSON)
            }
        }

        private fun consume(expected: Char): Boolean =
            if (peek() == expected) {
                index += 1
                true
            } else {
                false
            }

        private fun peek(): Char? = text.getOrNull(index)

        private fun skipWhitespace() {
            while (peek() == ' ' || peek() == '\t' || peek() == '\r' || peek() == '\n') {
                index += 1
            }
        }

        private fun fail(code: BluetoothEnrollmentParseCode): Nothing =
            throw StrictJsonException(code)
    }
}
