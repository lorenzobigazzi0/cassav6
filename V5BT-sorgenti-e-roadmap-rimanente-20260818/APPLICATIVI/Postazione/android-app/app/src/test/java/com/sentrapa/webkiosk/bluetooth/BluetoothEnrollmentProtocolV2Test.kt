package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class BluetoothEnrollmentProtocolV2Test {
    @Test
    fun `v2 QR is bound to c5e2 token and rejects v1 token`() {
        val parsed = BluetoothEnrollmentJsonV2.parseQr(validQr())
            as BluetoothEnrollmentParseResult.Ready
        assertEquals(2, parsed.value.version)
        assertEquals(TOKEN, parsed.value.token)

        val wrongProtocol = validQr().decodeToString()
            .replace("c5e2_", "c5e1_")
            .encodeToByteArray()
        assertEquals(
            BluetoothEnrollmentParseCode.INVALID_FIELD_VALUE,
            (BluetoothEnrollmentJsonV2.parseQr(wrongProtocol)
                as BluetoothEnrollmentParseResult.Failure).code
        )
        assertTrue(
            BluetoothEnrollmentJsonV1.parseQr(validQr()) is
                BluetoothEnrollmentParseResult.Failure
        )
    }

    @Test
    fun `v2 request uses P256 SPKI and canonical low-S P1363 proof`() {
        val keyPair = p256KeyPair()
        val spki = Base64.getEncoder().encodeToString(keyPair.public.encoded)
        val proof = BluetoothEnrollmentProtocolV2.proofBytes(
            protocolVersion = BluetoothEnrollmentProtocolV2.PROTOCOL_VERSION,
            enrollmentEndpointId = ENDPOINT_ID,
            token = TOKEN,
            nodeId = NODE_ID,
            publicKeyAlgorithm = BluetoothEnrollmentProtocolV2.PUBLIC_KEY_ALGORITHM,
            proofAlgorithm = BluetoothEnrollmentProtocolV2.PROOF_ALGORITHM,
            publicKeySpkiDerBase64 = spki
        )
        val signer = Signature.getInstance(
            P256EcdsaSignatureV2.JCA_SIGNATURE_ALGORITHM
        )
        signer.initSign(keyPair.private)
        signer.update(proof)
        val signature = P256EcdsaSignatureV2.derToCanonicalP1363(signer.sign())
        val signatureBase64 = Base64.getEncoder().encodeToString(signature)
        val request = BluetoothEnrollmentRequestV2(
            protocolVersion = 2,
            enrollmentEndpointId = ENDPOINT_ID,
            token = TOKEN,
            nodeId = NODE_ID,
            publicKeySpkiDerBase64 = spki,
            proofSignatureBase64 = signatureBase64
        )

        assertTrue(
            BluetoothEnrollmentProtocolV2.isCanonicalSignature(
                signatureBase64
            )
        )
        val json = BluetoothEnrollmentJsonV2.encodeRequest(request).decodeToString()
        assertTrue(json.contains("\"protocolVersion\":2"))
        assertTrue(json.contains("\"publicKeyAlgorithm\":\"EC-P256\""))
        assertTrue(
            json.contains(
                "\"proofAlgorithm\":\"ECDSA-P256-SHA256-P1363\""
            )
        )
        assertFalse(
            BluetoothEnrollmentProtocolV2.isCanonicalSignature(
                Base64.getEncoder().encodeToString(ByteArray(64))
            )
        )

        assertEquals(
            listOf(
                BluetoothEnrollmentProtocolV2.PROOF_CONTEXT,
                "2",
                ENDPOINT_ID,
                TOKEN,
                NODE_ID,
                "EC-P256",
                "ECDSA-P256-SHA256-P1363",
                spki
            ).joinToString("\u0000"),
            proof.decodeToString()
        )
        val algorithmSubstitution = BluetoothEnrollmentProtocolV2.proofBytes(
            protocolVersion = 2,
            enrollmentEndpointId = ENDPOINT_ID,
            token = TOKEN,
            nodeId = NODE_ID,
            publicKeyAlgorithm = "Ed25519",
            proofAlgorithm = "Ed25519",
            publicKeySpkiDerBase64 = spki
        )
        assertFalse(proof.contentEquals(algorithmSubstitution))
        val verifier = Signature.getInstance(
            P256EcdsaSignatureV2.JCA_SIGNATURE_ALGORITHM
        )
        verifier.initVerify(keyPair.public)
        verifier.update(algorithmSubstitution)
        assertFalse(
            verifier.verify(
                P256EcdsaSignatureV2.canonicalP1363ToDer(signature)
            )
        )
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothEnrollmentJsonV2.encodeRequest(
                request.copy(proofAlgorithm = "Ed25519")
            )
        }
    }

    @Test
    fun `v2 response validator binds exact local P256 identity`() {
        val publicKey = p256KeyPair().public.encoded
        val spki = Base64.getEncoder().encodeToString(publicKey)
        val local = LocalEnrollmentIdentityV2(
            protocolVersion = 2,
            nodeId = NODE_ID,
            publicKeySpkiDerBase64 = spki,
            publicKeySha256 = P256SpkiV2.sha256Fingerprint(publicKey)
        )
        val fields = response(spki)
        val ready = EnrollmentResponseValidatorV2.validate(fields, local)
            as EnrollmentResponseValidationResultV2.Ready
        assertEquals(2, ready.response.protocolVersion)
        assertEquals(spki, ready.response.publicKeySpkiDerBase64)
        ready.response.aliasKey.fill(0)

        val downgraded = LinkedHashMap(fields).apply {
            this["publicKeyAlgorithm"] = "Ed25519"
        }
        assertEquals(
            EnrollmentResponseValidationCode.PUBLIC_KEY_ALGORITHM_MISMATCH,
            (EnrollmentResponseValidatorV2.validate(downgraded, local)
                as EnrollmentResponseValidationResultV2.Failure).code
        )
    }

    @Test
    fun `v2 pipeline completes without changing v1 pipeline contract`() {
        var claimCalls = 0
        var networkCalls = 0
        var importCalls = 0
        val pipeline = BluetoothEnrollmentPipelineV2(
            ENDPOINT_ID,
            object : BluetoothEnrollmentIdentityPortV2 {
                override fun inspect() = DeviceIdentityReport(
                    enabled = true,
                    status = DeviceIdentityStatus.ALIAS_KEY_UNPROVISIONED
                )

                override fun createClaim(
                    qr: BluetoothEnrollmentQrV2
                ): BluetoothEnrollmentClaimResultV2 {
                    claimCalls += 1
                    return BluetoothEnrollmentClaimResultV2.Ready(
                        BluetoothEnrollmentRequestV2(
                            2,
                            ENDPOINT_ID,
                            TOKEN,
                            NODE_ID,
                            Base64.getEncoder().encodeToString(
                                p256KeyPair().public.encoded
                            ),
                            "unused-by-fake"
                        )
                    )
                }

                override fun importResponse(
                    fields: Map<String, Any?>
                ): DeviceIdentityReport {
                    importCalls += 1
                    return DeviceIdentityReport(
                        enabled = true,
                        status = DeviceIdentityStatus.READY
                    )
                }
            },
            object : BluetoothEnrollmentNetworkPortV2 {
                override fun enroll(
                    request: BluetoothEnrollmentRequestV2
                ): BluetoothEnrollmentClientResult {
                    networkCalls += 1
                    return BluetoothEnrollmentClientResult.Ready(emptyMap())
                }
            }
        )

        val result = pipeline.process(validQr())
        assertEquals(BluetoothEnrollmentAttemptStatus.READY, result.status)
        assertEquals(1, claimCalls)
        assertEquals(1, networkCalls)
        assertEquals(1, importCalls)
    }

    @Test
    fun `configuration accepts only the two exact enrollment paths`() {
        val pin = "sha256/${Base64.getEncoder().encodeToString(ByteArray(32))}"
        val base = BluetoothEnrollmentConfig(
            enabled = true,
            endpointId = ENDPOINT_ID,
            url = "https://192.168.1.79:9443/v2/enroll",
            spkiSha256 = pin
        )
        assertTrue(
            BluetoothEnrollmentConfigValidator.validate(base) is
                BluetoothEnrollmentConfigResult.Ready
        )
        assertTrue(
            BluetoothEnrollmentConfigValidator.validate(
                base.copy(url = "https://192.168.1.79:9443/v3/enroll")
            ) is BluetoothEnrollmentConfigResult.Failure
        )

        val v1BoundClient = BluetoothEnrollmentClient(
            base.copy(url = "https://192.168.1.79:9443/v1/enroll")
        )
        try {
            val crossProtocol = v1BoundClient.enroll(
                BluetoothEnrollmentRequestV2(
                    protocolVersion = 2,
                    enrollmentEndpointId = ENDPOINT_ID,
                    token = TOKEN,
                    nodeId = NODE_ID,
                    publicKeySpkiDerBase64 = "invalid",
                    proofSignatureBase64 = "invalid"
                )
            ) as BluetoothEnrollmentClientResult.Failure
            assertEquals(
                BluetoothEnrollmentClientStatus.CONFIGURATION_INVALID,
                crossProtocol.status
            )
        } finally {
            v1BoundClient.close()
        }
    }

    private fun validQr(): ByteArray =
        (
            "{\"version\":2,\"enrollmentEndpointId\":\"$ENDPOINT_ID\"," +
                "\"token\":\"$TOKEN\"}"
            ).encodeToByteArray()

    private fun response(spki: String): LinkedHashMap<String, Any?> =
        linkedMapOf(
            "protocolVersion" to 2,
            "nodeId" to NODE_ID,
            "certificateId" to CERTIFICATE_ID,
            "publicKeyAlgorithm" to "EC-P256",
            "publicKeySpkiDerBase64" to spki,
            "aliasKeyAlgorithm" to "HMAC-SHA256",
            "aliasKeyEncoding" to "base64url-unpadded",
            "aliasKeyBase64url" to ALIAS_KEY,
            "enrolledAt" to "2026-08-17T16:00:00.000Z"
        )

    private fun p256KeyPair() =
        KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec(P256SpkiV2.CURVE_NAME))
        }.generateKeyPair()

    companion object {
        private const val ENDPOINT_ID = "raspberry-lab-v5bt"
        private const val TOKEN =
            "c5e2_SkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSko"
        private const val NODE_ID = "550e8400-e29b-41d4-a716-446655440000"
        private const val CERTIFICATE_ID =
            "123e4567-e89b-42d3-a456-426614174000"
        private const val ALIAS_KEY =
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    }
}
