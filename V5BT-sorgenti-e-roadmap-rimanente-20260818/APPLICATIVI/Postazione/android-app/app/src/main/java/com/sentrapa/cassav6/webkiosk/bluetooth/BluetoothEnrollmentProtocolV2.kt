package com.sentrapa.cassav6.webkiosk.bluetooth

data class BluetoothEnrollmentQrV2(
    val version: Int,
    val enrollmentEndpointId: String,
    val token: String
)

data class BluetoothEnrollmentRequestV2(
    val protocolVersion: Int,
    val enrollmentEndpointId: String,
    val token: String,
    val nodeId: String,
    val publicKeySpkiDerBase64: String,
    val proofSignatureBase64: String,
    val publicKeyAlgorithm: String =
        BluetoothEnrollmentProtocolV2.PUBLIC_KEY_ALGORITHM,
    val proofAlgorithm: String =
        BluetoothEnrollmentProtocolV2.PROOF_ALGORITHM
)

sealed class BluetoothEnrollmentClaimResultV2 {
    data class Ready(
        val request: BluetoothEnrollmentRequestV2
    ) : BluetoothEnrollmentClaimResultV2()

    data class Failure(
        val status: DeviceIdentityStatus
    ) : BluetoothEnrollmentClaimResultV2()
}

object BluetoothEnrollmentProtocolV2 {
    const val PROTOCOL_VERSION = 2
    const val PUBLIC_KEY_ALGORITHM = "EC-P256"
    const val PROOF_ALGORITHM = "ECDSA-P256-SHA256-P1363"
    const val PROOF_CONTEXT = "CASSA_V6-BT-ENROLLMENT-PROOF-V2"
    const val ENROLLMENT_PATH = "/v2/enroll"
    const val MAX_QR_BYTES = 512
    const val MAX_RESPONSE_BYTES = 4096

    private val endpointIdPattern =
        Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    private val tokenPattern =
        Regex("^c6e2_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$")
    private val signaturePattern =
        Regex("^[A-Za-z0-9+/]{85}[AQgw]==$")

    fun isCanonicalEndpointId(value: String): Boolean =
        endpointIdPattern.matches(value)

    fun isCanonicalToken(value: String): Boolean =
        tokenPattern.matches(value) &&
            runCatching {
                decodeCanonicalBase64Url(value.removePrefix("c6e2_"), 32)
            }.getOrNull() != null

    fun isCanonicalSignature(value: String): Boolean {
        if (!signaturePattern.matches(value)) return false
        val decoded = runCatching {
            decodeUnpaddedBase64(
                value = value.dropLast(2),
                alphabet =
                    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
                encodedLength = 86,
                decodedLength = P256EcdsaSignatureV2.P1363_BYTES,
                trailingBits = 4,
                field = "proofSignatureBase64"
            )
        }.getOrNull() ?: return false
        return try {
            P256EcdsaSignatureV2.isCanonicalP1363(decoded)
        } finally {
            decoded.fill(0)
        }
    }

    fun proofBytes(
        protocolVersion: Int,
        enrollmentEndpointId: String,
        token: String,
        nodeId: String,
        publicKeyAlgorithm: String,
        proofAlgorithm: String,
        publicKeySpkiDerBase64: String
    ): ByteArray =
        listOf(
            PROOF_CONTEXT,
            protocolVersion.toString(),
            enrollmentEndpointId,
            token,
            nodeId,
            publicKeyAlgorithm,
            proofAlgorithm,
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
                output[outputIndex++] = (accumulator shr bits).toByte()
                accumulator = accumulator and ((1 shl bits) - 1)
            }
        }
        require(outputIndex == expectedBytes && accumulator == 0) {
            "non-canonical base64url"
        }
        return output
    }
}

object BluetoothEnrollmentJsonV2 {
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

    fun parseQr(
        raw: ByteArray
    ): BluetoothEnrollmentParseResult<BluetoothEnrollmentQrV2> {
        return when (
            val parsed = BluetoothEnrollmentJsonV1.parseExactFlatObject(
                raw,
                qrFields,
                BluetoothEnrollmentProtocolV2.MAX_QR_BYTES
            )
        ) {
            is BluetoothEnrollmentParseResult.Failure -> parsed
            is BluetoothEnrollmentParseResult.Ready -> {
                val version = parsed.value["version"] as? Int
                    ?: return BluetoothEnrollmentParseResult.Failure(
                        BluetoothEnrollmentParseCode.INVALID_FIELD_TYPE
                    )
                val endpointId = parsed.value["enrollmentEndpointId"] as? String
                    ?: return BluetoothEnrollmentParseResult.Failure(
                        BluetoothEnrollmentParseCode.INVALID_FIELD_TYPE
                    )
                val token = parsed.value["token"] as? String
                    ?: return BluetoothEnrollmentParseResult.Failure(
                        BluetoothEnrollmentParseCode.INVALID_FIELD_TYPE
                    )
                if (
                    version != BluetoothEnrollmentProtocolV2.PROTOCOL_VERSION ||
                    !BluetoothEnrollmentProtocolV2.isCanonicalEndpointId(endpointId) ||
                    !BluetoothEnrollmentProtocolV2.isCanonicalToken(token)
                ) {
                    BluetoothEnrollmentParseResult.Failure(
                        BluetoothEnrollmentParseCode.INVALID_FIELD_VALUE
                    )
                } else {
                    BluetoothEnrollmentParseResult.Ready(
                        BluetoothEnrollmentQrV2(version, endpointId, token)
                    )
                }
            }
        }
    }

    fun parseResponse(
        raw: ByteArray
    ): BluetoothEnrollmentParseResult<Map<String, Any?>> =
        BluetoothEnrollmentJsonV1.parseExactFlatObject(
            raw,
            responseFields,
            BluetoothEnrollmentProtocolV2.MAX_RESPONSE_BYTES
        )

    fun encodeRequest(request: BluetoothEnrollmentRequestV2): ByteArray {
        require(
            request.protocolVersion == BluetoothEnrollmentProtocolV2.PROTOCOL_VERSION &&
                BluetoothEnrollmentProtocolV2.isCanonicalEndpointId(
                    request.enrollmentEndpointId
                ) &&
                BluetoothEnrollmentProtocolV2.isCanonicalToken(request.token) &&
                RotatingAliasV1.isCanonicalNodeId(request.nodeId) &&
                request.publicKeyAlgorithm ==
                BluetoothEnrollmentProtocolV2.PUBLIC_KEY_ALGORITHM &&
                request.proofAlgorithm ==
                BluetoothEnrollmentProtocolV2.PROOF_ALGORITHM &&
                runCatching {
                    val publicKey = P256SpkiV2.decodeCanonicalBase64(
                        request.publicKeySpkiDerBase64
                    )
                    P256SpkiV2.isCanonicalP256Spki(publicKey)
                }.getOrDefault(false) &&
                BluetoothEnrollmentProtocolV2.isCanonicalSignature(
                    request.proofSignatureBase64
                )
        ) {
            "Enrollment request v2 is not canonical"
        }
        return (
            "{\"protocolVersion\":${request.protocolVersion}," +
                "\"enrollmentEndpointId\":\"${request.enrollmentEndpointId}\"," +
                "\"token\":\"${request.token}\"," +
                "\"nodeId\":\"${request.nodeId}\"," +
                "\"publicKeyAlgorithm\":\"" +
                "${request.publicKeyAlgorithm}\"," +
                "\"publicKeySpkiDerBase64\":\"" +
                "${request.publicKeySpkiDerBase64}\"," +
                "\"proofAlgorithm\":\"" +
                "${request.proofAlgorithm}\"," +
                "\"proofSignatureBase64\":\"${request.proofSignatureBase64}\"}"
            ).toByteArray(Charsets.UTF_8)
    }
}
