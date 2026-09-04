package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AliasKeyEnrollmentV1Test {
    @Test
    fun `registry base64url aliasKey decodes to exactly 32 bytes`() {
        val decoded = AliasKeyEnrollmentCodecV1.decode(ALIAS_KEY_BASE64URL)

        assertArrayEquals(ByteArray(32) { it.toByte() }, decoded)
    }

    @Test
    fun `alias decoder rejects padding length characters and trailing bits`() {
        assertThrows(IllegalArgumentException::class.java) {
            AliasKeyEnrollmentCodecV1.decode("$ALIAS_KEY_BASE64URL=")
        }
        assertThrows(IllegalArgumentException::class.java) {
            AliasKeyEnrollmentCodecV1.decode("not-a-key")
        }
        assertThrows(IllegalArgumentException::class.java) {
            AliasKeyEnrollmentCodecV1.decode(
                "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9"
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            AliasKeyEnrollmentCodecV1.decode(
                "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh*"
            )
        }
    }

    @Test
    fun `provisioning policy has no overwrite or reprovision mode`() {
        assertEquals(
            AliasKeyImportDecision.IMPORT_NEW,
            AliasKeyProvisioningPolicy.decide(
                aliasKeyAlreadyProvisioned = false
            )
        )
        assertEquals(
            AliasKeyImportDecision.REJECT_ALREADY_PROVISIONED,
            AliasKeyProvisioningPolicy.decide(
                aliasKeyAlreadyProvisioned = true
            )
        )
        assertEquals(
            setOf("IMPORT_NEW", "REJECT_ALREADY_PROVISIONED"),
            enumValues<AliasKeyImportDecision>().map { it.name }.toSet()
        )
    }

    @Test
    fun `Ed25519 SPKI requires exact DER prefix OID length and fingerprint`() {
        val decoded = Ed25519SpkiV1.decodeCanonicalBase64(PUBLIC_KEY_SPKI)

        assertEquals(44, decoded.size)
        assertTrue(Ed25519SpkiV1.isCanonicalEd25519Spki(decoded))
        assertEquals(PUBLIC_KEY_SHA256, Ed25519SpkiV1.sha256Fingerprint(decoded))

        assertThrows(IllegalArgumentException::class.java) {
            Ed25519SpkiV1.decodeCanonicalBase64(PUBLIC_KEY_SPKI.dropLast(1))
        }
        assertTrue(
            !Ed25519SpkiV1.isCanonicalEd25519Spki(
                Ed25519SpkiV1.decodeCanonicalBase64(BAD_OID_PUBLIC_KEY_SPKI)
            )
        )
    }

    @Test
    fun `complete canonical response is bound to the local identity`() {
        val result = EnrollmentResponseValidatorV1.validate(
            fields = validResponse(),
            localIdentity = LOCAL_IDENTITY
        )
        val ready = result as EnrollmentResponseValidationResult.Ready
        try {
            assertEquals(1, ready.response.protocolVersion)
            assertEquals(NODE_ID, ready.response.nodeId)
            assertEquals(CERTIFICATE_ID, ready.response.certificateId)
            assertEquals(PUBLIC_KEY_SPKI, ready.response.publicKeySpkiDerBase64)
            assertEquals(PUBLIC_KEY_SHA256, ready.response.publicKeySha256)
            assertArrayEquals(ByteArray(32) { it.toByte() }, ready.response.aliasKey)
            assertEquals(ENROLLED_AT, ready.response.enrolledAt)
        } finally {
            ready.response.aliasKey.fill(0)
        }
    }

    @Test
    fun `response rejects missing extra and wrongly typed fields`() {
        assertFailure(
            EnrollmentResponseValidationCode.INVALID_STRUCTURE,
            validResponse().apply { remove("certificateId") }
        )
        assertFailure(
            EnrollmentResponseValidationCode.INVALID_STRUCTURE,
            validResponse().apply { put("unexpected", true) }
        )
        assertFailure(
            EnrollmentResponseValidationCode.INVALID_STRUCTURE,
            validResponse().apply { put("nodeId", 42) }
        )
    }

    @Test
    fun `protocol version must be integer one`() {
        assertFailure(
            EnrollmentResponseValidationCode.UNSUPPORTED_PROTOCOL_VERSION,
            validResponse().apply { put("protocolVersion", 2) }
        )
        assertFailure(
            EnrollmentResponseValidationCode.UNSUPPORTED_PROTOCOL_VERSION,
            validResponse().apply { put("protocolVersion", 1.0) }
        )
    }

    @Test
    fun `local NodeId SPKI and fingerprint must be canonical and coherent`() {
        assertFailure(
            EnrollmentResponseValidationCode.LOCAL_IDENTITY_INVALID,
            localIdentity = LOCAL_IDENTITY.copy(nodeId = NODE_ID.uppercase())
        )
        assertFailure(
            EnrollmentResponseValidationCode.LOCAL_IDENTITY_INVALID,
            localIdentity =
                LOCAL_IDENTITY.copy(publicKeySha256 = "0".repeat(64))
        )
        assertFailure(
            EnrollmentResponseValidationCode.LOCAL_IDENTITY_INVALID,
            localIdentity =
                LOCAL_IDENTITY.copy(
                    publicKeySpkiDerBase64 = BAD_OID_PUBLIC_KEY_SPKI,
                    publicKeySha256 =
                        "cfdb4c62b72ccf43d020aaeffa73242dd563913393bf3be8a9aee040a591c028"
                )
        )
    }

    @Test
    fun `response NodeId rejects uppercase invalid UUID and local mismatch`() {
        assertFailure(
            EnrollmentResponseValidationCode.NODE_ID_INVALID,
            validResponse().apply { put("nodeId", NODE_ID.uppercase()) }
        )
        assertFailure(
            EnrollmentResponseValidationCode.NODE_ID_INVALID,
            validResponse().apply { put("nodeId", "not-a-node-id") }
        )
        assertFailure(
            EnrollmentResponseValidationCode.NODE_ID_MISMATCH,
            validResponse().apply {
                put("nodeId", "550e8400-e29b-41d4-a716-446655440001")
            }
        )
    }

    @Test
    fun `certificateId must be a canonical lowercase UUID`() {
        assertFailure(
            EnrollmentResponseValidationCode.CERTIFICATE_ID_INVALID,
            validResponse().apply {
                put("certificateId", CERTIFICATE_ID.uppercase())
            }
        )
        assertFailure(
            EnrollmentResponseValidationCode.CERTIFICATE_ID_INVALID,
            validResponse().apply { put("certificateId", "invalid") }
        )
    }

    @Test
    fun `public key algorithm SPKI OID and local key binding are enforced`() {
        assertFailure(
            EnrollmentResponseValidationCode.PUBLIC_KEY_ALGORITHM_MISMATCH,
            validResponse().apply { put("publicKeyAlgorithm", "EdDSA") }
        )
        assertFailure(
            EnrollmentResponseValidationCode.PUBLIC_KEY_INVALID,
            validResponse().apply {
                put("publicKeySpkiDerBase64", BAD_OID_PUBLIC_KEY_SPKI)
            }
        )
        assertFailure(
            EnrollmentResponseValidationCode.PUBLIC_KEY_INVALID,
            validResponse().apply {
                put("publicKeySpkiDerBase64", PUBLIC_KEY_SPKI.dropLast(1))
            }
        )
        assertFailure(
            EnrollmentResponseValidationCode.PUBLIC_KEY_MISMATCH,
            validResponse().apply {
                put("publicKeySpkiDerBase64", OTHER_PUBLIC_KEY_SPKI)
            }
        )
    }

    @Test
    fun `alias algorithm encoding and canonical key are enforced`() {
        assertFailure(
            EnrollmentResponseValidationCode.ALIAS_KEY_ALGORITHM_MISMATCH,
            validResponse().apply { put("aliasKeyAlgorithm", "HmacSHA256") }
        )
        assertFailure(
            EnrollmentResponseValidationCode.ALIAS_KEY_ENCODING_MISMATCH,
            validResponse().apply { put("aliasKeyEncoding", "base64") }
        )
        assertFailure(
            EnrollmentResponseValidationCode.ALIAS_KEY_INVALID,
            validResponse().apply {
                put("aliasKeyBase64url", "$ALIAS_KEY_BASE64URL=")
            }
        )
    }

    @Test
    fun `enrollment time must be exact UTC milliseconds`() {
        assertFailure(
            EnrollmentResponseValidationCode.ENROLLED_AT_INVALID,
            validResponse().apply {
                put("enrolledAt", "2026-07-19T16:00:00Z")
            }
        )
        assertFailure(
            EnrollmentResponseValidationCode.ENROLLED_AT_INVALID,
            validResponse().apply {
                put("enrolledAt", "2026-02-30T16:00:00.000Z")
            }
        )
        assertFailure(
            EnrollmentResponseValidationCode.ENROLLED_AT_INVALID,
            validResponse().apply {
                put("enrolledAt", "2026-07-19T18:00:00.000+02:00")
            }
        )
    }

    private fun assertFailure(
        expected: EnrollmentResponseValidationCode,
        fields: Map<String, Any?> = validResponse(),
        localIdentity: LocalEnrollmentIdentityV1 = LOCAL_IDENTITY
    ) {
        val result = EnrollmentResponseValidatorV1.validate(
            fields = fields,
            localIdentity = localIdentity
        )

        assertEquals(
            expected,
            (result as EnrollmentResponseValidationResult.Failure).code
        )
    }

    private fun validResponse(): MutableMap<String, Any?> =
        linkedMapOf(
            "protocolVersion" to 1,
            "nodeId" to NODE_ID,
            "certificateId" to CERTIFICATE_ID,
            "publicKeyAlgorithm" to Ed25519SpkiV1.PUBLIC_KEY_ALGORITHM,
            "publicKeySpkiDerBase64" to PUBLIC_KEY_SPKI,
            "aliasKeyAlgorithm" to AliasKeyEnrollmentCodecV1.ALGORITHM,
            "aliasKeyEncoding" to AliasKeyEnrollmentCodecV1.ENCODING,
            "aliasKeyBase64url" to ALIAS_KEY_BASE64URL,
            "enrolledAt" to ENROLLED_AT
        )

    companion object {
        private const val NODE_ID = "550e8400-e29b-41d4-a716-446655440000"
        private const val CERTIFICATE_ID =
            "123e4567-e89b-42d3-a456-426614174000"
        private const val PUBLIC_KEY_SPKI =
            "MCowBQYDK2VwAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
        private const val OTHER_PUBLIC_KEY_SPKI =
            "MCowBQYDK2VwAyEAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA="
        private const val BAD_OID_PUBLIC_KEY_SPKI =
            "MCowBQYDK2VxAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
        private const val PUBLIC_KEY_SHA256 =
            "9408457aefd071cec127c1f98539930861ad1ba94c940db975c972c09fc68b68"
        private const val ALIAS_KEY_BASE64URL =
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        private const val ENROLLED_AT = "2026-07-19T16:00:00.000Z"
        private val LOCAL_IDENTITY = LocalEnrollmentIdentityV1(
            protocolVersion = 1,
            nodeId = NODE_ID,
            publicKeySpkiDerBase64 = PUBLIC_KEY_SPKI,
            publicKeySha256 = PUBLIC_KEY_SHA256
        )
    }
}
