package com.sentrapa.webkiosk.bluetooth

import java.security.MessageDigest
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

enum class AliasKeyImportDecision {
    IMPORT_NEW,
    REJECT_ALREADY_PROVISIONED
}

object AliasKeyProvisioningPolicy {
    fun decide(aliasKeyAlreadyProvisioned: Boolean): AliasKeyImportDecision =
        if (aliasKeyAlreadyProvisioned) {
            AliasKeyImportDecision.REJECT_ALREADY_PROVISIONED
        } else {
            AliasKeyImportDecision.IMPORT_NEW
        }
}

object AliasKeyEnrollmentCodecV1 {
    const val ALGORITHM = "HMAC-SHA256"
    const val ENCODING = "base64url-unpadded"
    const val ENCODED_LENGTH = 43

    private const val ALPHABET =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    fun decode(aliasKeyBase64url: String): ByteArray =
        decodeUnpaddedBase64(
            value = aliasKeyBase64url,
            alphabet = ALPHABET,
            encodedLength = ENCODED_LENGTH,
            decodedLength = RotatingAliasV1.ALIAS_KEY_BYTES,
            trailingBits = 2,
            field = "aliasKeyBase64url"
        )
}

object Ed25519SpkiV1 {
    const val PUBLIC_KEY_ALGORITHM = "Ed25519"
    const val ENCODING = "spki-der-base64"
    const val DER_BYTES = 44
    const val BASE64_LENGTH = 60

    private val prefix = byteArrayOf(
        0x30,
        0x2a,
        0x30,
        0x05,
        0x06,
        0x03,
        0x2b,
        0x65,
        0x70,
        0x03,
        0x21,
        0x00
    )
    private const val STANDARD_ALPHABET =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

    fun decodeCanonicalBase64(value: String): ByteArray {
        require(value.length == BASE64_LENGTH && value.endsWith("=")) {
            "publicKeySpkiDerBase64 must be canonical padded base64"
        }
        require('=' !in value.dropLast(1)) {
            "publicKeySpkiDerBase64 contains misplaced padding"
        }
        return decodeUnpaddedBase64(
            value = value.dropLast(1),
            alphabet = STANDARD_ALPHABET,
            encodedLength = BASE64_LENGTH - 1,
            decodedLength = DER_BYTES,
            trailingBits = 2,
            field = "publicKeySpkiDerBase64"
        )
    }

    fun isCanonicalEd25519Spki(spkiDer: ByteArray): Boolean =
        spkiDer.size == DER_BYTES &&
            prefix.indices.all { index -> spkiDer[index] == prefix[index] }

    fun sha256Fingerprint(spkiDer: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(spkiDer).toHex()
}

data class LocalEnrollmentIdentityV1(
    val protocolVersion: Int,
    val nodeId: String,
    val publicKeySpkiDerBase64: String,
    val publicKeySha256: String
)

data class ValidatedEnrollmentResponseV1(
    val protocolVersion: Int,
    val nodeId: String,
    val certificateId: String,
    val publicKeySpkiDerBase64: String,
    val publicKeySha256: String,
    val aliasKey: ByteArray,
    val enrolledAt: String
)

enum class EnrollmentResponseValidationCode {
    INVALID_STRUCTURE,
    UNSUPPORTED_PROTOCOL_VERSION,
    LOCAL_IDENTITY_INVALID,
    NODE_ID_INVALID,
    NODE_ID_MISMATCH,
    CERTIFICATE_ID_INVALID,
    PUBLIC_KEY_ALGORITHM_MISMATCH,
    PUBLIC_KEY_INVALID,
    PUBLIC_KEY_MISMATCH,
    PUBLIC_KEY_FINGERPRINT_MISMATCH,
    ALIAS_KEY_ALGORITHM_MISMATCH,
    ALIAS_KEY_ENCODING_MISMATCH,
    ALIAS_KEY_INVALID,
    ENROLLED_AT_INVALID
}

sealed class EnrollmentResponseValidationResult {
    data class Ready(
        val response: ValidatedEnrollmentResponseV1
    ) : EnrollmentResponseValidationResult()

    data class Failure(
        val code: EnrollmentResponseValidationCode
    ) : EnrollmentResponseValidationResult()
}

object EnrollmentResponseValidatorV1 {
    const val PROTOCOL_VERSION = 1

    private val expectedFields = setOf(
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
    private val fingerprintPattern = Regex("^[0-9a-f]{64}$")
    private val canonicalUtcPattern =
        Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")

    fun validate(
        fields: Map<String, Any?>,
        localIdentity: LocalEnrollmentIdentityV1
    ): EnrollmentResponseValidationResult {
        if (fields.keys != expectedFields) {
            return failure(EnrollmentResponseValidationCode.INVALID_STRUCTURE)
        }
        if (
            localIdentity.protocolVersion != PROTOCOL_VERSION ||
            !RotatingAliasV1.isCanonicalNodeId(localIdentity.nodeId) ||
            !fingerprintPattern.matches(localIdentity.publicKeySha256)
        ) {
            return failure(EnrollmentResponseValidationCode.LOCAL_IDENTITY_INVALID)
        }

        val localSpki =
            try {
                Ed25519SpkiV1.decodeCanonicalBase64(
                    localIdentity.publicKeySpkiDerBase64
                )
            } catch (_: IllegalArgumentException) {
                return failure(EnrollmentResponseValidationCode.LOCAL_IDENTITY_INVALID)
            }
        if (
            !Ed25519SpkiV1.isCanonicalEd25519Spki(localSpki) ||
            Ed25519SpkiV1.sha256Fingerprint(localSpki) !=
            localIdentity.publicKeySha256
        ) {
            return failure(EnrollmentResponseValidationCode.LOCAL_IDENTITY_INVALID)
        }

        val protocolVersion =
            when (val value = fields["protocolVersion"]) {
                is Int -> value.toLong()
                is Long -> value
                else ->
                    return failure(
                        EnrollmentResponseValidationCode
                            .UNSUPPORTED_PROTOCOL_VERSION
                    )
            }
        if (protocolVersion != PROTOCOL_VERSION.toLong()) {
            return failure(
                EnrollmentResponseValidationCode.UNSUPPORTED_PROTOCOL_VERSION
            )
        }
        val nodeId = fields.string("nodeId")
            ?: return failure(EnrollmentResponseValidationCode.INVALID_STRUCTURE)
        if (!RotatingAliasV1.isCanonicalNodeId(nodeId)) {
            return failure(EnrollmentResponseValidationCode.NODE_ID_INVALID)
        }
        if (nodeId != localIdentity.nodeId) {
            return failure(EnrollmentResponseValidationCode.NODE_ID_MISMATCH)
        }

        val certificateId = fields.string("certificateId")
            ?: return failure(EnrollmentResponseValidationCode.INVALID_STRUCTURE)
        if (!RotatingAliasV1.isCanonicalNodeId(certificateId)) {
            return failure(EnrollmentResponseValidationCode.CERTIFICATE_ID_INVALID)
        }
        if (
            fields.string("publicKeyAlgorithm") !=
            Ed25519SpkiV1.PUBLIC_KEY_ALGORITHM
        ) {
            return failure(
                EnrollmentResponseValidationCode.PUBLIC_KEY_ALGORITHM_MISMATCH
            )
        }

        val responseSpkiBase64 = fields.string("publicKeySpkiDerBase64")
            ?: return failure(EnrollmentResponseValidationCode.INVALID_STRUCTURE)
        val responseSpki =
            try {
                Ed25519SpkiV1.decodeCanonicalBase64(responseSpkiBase64)
            } catch (_: IllegalArgumentException) {
                return failure(EnrollmentResponseValidationCode.PUBLIC_KEY_INVALID)
            }
        if (!Ed25519SpkiV1.isCanonicalEd25519Spki(responseSpki)) {
            return failure(EnrollmentResponseValidationCode.PUBLIC_KEY_INVALID)
        }
        if (!MessageDigest.isEqual(responseSpki, localSpki)) {
            return failure(EnrollmentResponseValidationCode.PUBLIC_KEY_MISMATCH)
        }
        val responseFingerprint = Ed25519SpkiV1.sha256Fingerprint(responseSpki)
        if (responseFingerprint != localIdentity.publicKeySha256) {
            return failure(
                EnrollmentResponseValidationCode.PUBLIC_KEY_FINGERPRINT_MISMATCH
            )
        }

        if (
            fields.string("aliasKeyAlgorithm") !=
            AliasKeyEnrollmentCodecV1.ALGORITHM
        ) {
            return failure(
                EnrollmentResponseValidationCode.ALIAS_KEY_ALGORITHM_MISMATCH
            )
        }
        if (
            fields.string("aliasKeyEncoding") !=
            AliasKeyEnrollmentCodecV1.ENCODING
        ) {
            return failure(
                EnrollmentResponseValidationCode.ALIAS_KEY_ENCODING_MISMATCH
            )
        }
        val aliasKey =
            try {
                AliasKeyEnrollmentCodecV1.decode(
                    fields.string("aliasKeyBase64url")
                        ?: return failure(
                            EnrollmentResponseValidationCode.INVALID_STRUCTURE
                        )
                )
            } catch (_: IllegalArgumentException) {
                return failure(EnrollmentResponseValidationCode.ALIAS_KEY_INVALID)
            }

        val enrolledAt = fields.string("enrolledAt")
        if (enrolledAt == null || !isCanonicalUtcDate(enrolledAt)) {
            aliasKey.fill(0)
            return failure(EnrollmentResponseValidationCode.ENROLLED_AT_INVALID)
        }
        return EnrollmentResponseValidationResult.Ready(
            ValidatedEnrollmentResponseV1(
                protocolVersion = PROTOCOL_VERSION,
                nodeId = nodeId,
                certificateId = certificateId,
                publicKeySpkiDerBase64 = responseSpkiBase64,
                publicKeySha256 = responseFingerprint,
                aliasKey = aliasKey,
                enrolledAt = enrolledAt
            )
        )
    }

    fun isCanonicalUtcDate(value: String): Boolean {
        if (!canonicalUtcPattern.matches(value)) return false
        val formatter = SimpleDateFormat(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            Locale.ROOT
        ).apply {
            isLenient = false
            timeZone = TimeZone.getTimeZone("UTC")
        }
        val position = ParsePosition(0)
        val parsed = formatter.parse(value, position) ?: return false
        return position.index == value.length && formatter.format(parsed) == value
    }

    private fun Map<String, Any?>.string(field: String): String? =
        this[field] as? String

    private fun failure(
        code: EnrollmentResponseValidationCode
    ): EnrollmentResponseValidationResult.Failure =
        EnrollmentResponseValidationResult.Failure(code)
}

internal fun decodeUnpaddedBase64(
    value: String,
    alphabet: String,
    encodedLength: Int,
    decodedLength: Int,
    trailingBits: Int,
    field: String
): ByteArray {
    require(value.length == encodedLength) {
        "$field has an invalid encoded length"
    }
    val output = ByteArray(decodedLength)
    var buffer = 0
    var bufferedBits = 0
    var outputIndex = 0

    for (character in value) {
        val decoded = alphabet.indexOf(character)
        require(decoded >= 0) {
            "$field contains a non-base64 character"
        }
        buffer = (buffer shl 6) or decoded
        bufferedBits += 6
        if (bufferedBits >= Byte.SIZE_BITS) {
            bufferedBits -= Byte.SIZE_BITS
            require(outputIndex < output.size) {
                "$field exceeds the expected decoded length"
            }
            output[outputIndex++] = (buffer ushr bufferedBits).toByte()
            buffer = buffer and ((1 shl bufferedBits) - 1)
        }
    }
    require(
        outputIndex == output.size &&
            bufferedBits == trailingBits &&
            buffer == 0
    ) {
        "$field has non-canonical padding bits"
    }
    return output
}
