package com.sentrapa.webkiosk.bluetooth

import java.security.MessageDigest

data class LocalEnrollmentIdentityV2(
    val protocolVersion: Int,
    val nodeId: String,
    val publicKeySpkiDerBase64: String,
    val publicKeySha256: String
)

data class ValidatedEnrollmentResponseV2(
    val protocolVersion: Int,
    val nodeId: String,
    val certificateId: String,
    val publicKeySpkiDerBase64: String,
    val publicKeySha256: String,
    val aliasKey: ByteArray,
    val enrolledAt: String
)

object EnrollmentResponseValidatorV2 {
    const val PROTOCOL_VERSION = BluetoothEnrollmentProtocolV2.PROTOCOL_VERSION

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

    fun validate(
        fields: Map<String, Any?>,
        localIdentity: LocalEnrollmentIdentityV2
    ): EnrollmentResponseValidationResultV2 {
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
                P256SpkiV2.decodeCanonicalBase64(
                    localIdentity.publicKeySpkiDerBase64
                )
            } catch (_: IllegalArgumentException) {
                return failure(EnrollmentResponseValidationCode.LOCAL_IDENTITY_INVALID)
            }
        if (
            !P256SpkiV2.isCanonicalP256Spki(localSpki) ||
            P256SpkiV2.sha256Fingerprint(localSpki) !=
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
                        EnrollmentResponseValidationCode.UNSUPPORTED_PROTOCOL_VERSION
                    )
            }
        if (protocolVersion != PROTOCOL_VERSION.toLong()) {
            return failure(EnrollmentResponseValidationCode.UNSUPPORTED_PROTOCOL_VERSION)
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
            P256SpkiV2.PUBLIC_KEY_ALGORITHM
        ) {
            return failure(
                EnrollmentResponseValidationCode.PUBLIC_KEY_ALGORITHM_MISMATCH
            )
        }

        val responseSpkiBase64 = fields.string("publicKeySpkiDerBase64")
            ?: return failure(EnrollmentResponseValidationCode.INVALID_STRUCTURE)
        val responseSpki =
            try {
                P256SpkiV2.decodeCanonicalBase64(responseSpkiBase64)
            } catch (_: IllegalArgumentException) {
                return failure(EnrollmentResponseValidationCode.PUBLIC_KEY_INVALID)
            }
        if (!P256SpkiV2.isCanonicalP256Spki(responseSpki)) {
            return failure(EnrollmentResponseValidationCode.PUBLIC_KEY_INVALID)
        }
        if (!MessageDigest.isEqual(responseSpki, localSpki)) {
            return failure(EnrollmentResponseValidationCode.PUBLIC_KEY_MISMATCH)
        }
        val responseFingerprint = P256SpkiV2.sha256Fingerprint(responseSpki)
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
        if (
            enrolledAt == null ||
            !EnrollmentResponseValidatorV1.isCanonicalUtcDate(enrolledAt)
        ) {
            aliasKey.fill(0)
            return failure(EnrollmentResponseValidationCode.ENROLLED_AT_INVALID)
        }
        return EnrollmentResponseValidationResultV2.Ready(
            ValidatedEnrollmentResponseV2(
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

    private fun Map<String, Any?>.string(field: String): String? =
        this[field] as? String

    private fun failure(
        code: EnrollmentResponseValidationCode
    ): EnrollmentResponseValidationResultV2.Failure =
        EnrollmentResponseValidationResultV2.Failure(code)
}

sealed class EnrollmentResponseValidationResultV2 {
    data class Ready(
        val response: ValidatedEnrollmentResponseV2
    ) : EnrollmentResponseValidationResultV2()

    data class Failure(
        val code: EnrollmentResponseValidationCode
    ) : EnrollmentResponseValidationResultV2()
}
