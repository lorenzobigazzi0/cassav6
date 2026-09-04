package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

internal data class EnrollmentV2GoldenVector(
    val request: BluetoothEnrollmentRequestV2,
    val requestJsonUtf8Base64: String,
    val proofTranscriptUtf8Base64: String,
    val proofTranscriptSha256: String
)

internal object EnrollmentV2GoldenVectorFixture {
    val value: EnrollmentV2GoldenVector by lazy {
        val raw = requireNotNull(
            javaClass.getResourceAsStream(RESOURCE_NAME)
        ).use { it.readBytes() }
        val fields = when (
            val parsed = BluetoothEnrollmentJsonV1.parseExactFlatObject(
                raw = raw,
                expectedFields = EXPECTED_FIELDS,
                maxBytes = MAX_FIXTURE_BYTES
            )
        ) {
            is BluetoothEnrollmentParseResult.Failure ->
                error("Invalid enrollment v2 golden vector: ${parsed.code}")
            is BluetoothEnrollmentParseResult.Ready -> parsed.value
        }
        check(fields["schemaVersion"] == SCHEMA_VERSION)
        check(fields["kind"] == FIXTURE_KIND)
        EnrollmentV2GoldenVector(
            request = BluetoothEnrollmentRequestV2(
                protocolVersion = fields.requireInt("protocolVersion"),
                enrollmentEndpointId = fields.requireString("enrollmentEndpointId"),
                token = fields.requireString("token"),
                nodeId = fields.requireString("nodeId"),
                publicKeySpkiDerBase64 =
                    fields.requireString("publicKeySpkiDerBase64"),
                proofSignatureBase64 = fields.requireString("proofSignatureBase64"),
                publicKeyAlgorithm = fields.requireString("publicKeyAlgorithm"),
                proofAlgorithm = fields.requireString("proofAlgorithm")
            ),
            requestJsonUtf8Base64 = fields.requireString("requestJsonUtf8Base64"),
            proofTranscriptUtf8Base64 =
                fields.requireString("proofTranscriptUtf8Base64"),
            proofTranscriptSha256 = fields.requireString("proofTranscriptSha256")
        )
    }

    private fun Map<String, Any?>.requireString(field: String): String =
        this[field] as? String ?: error("$field is not a string")

    private fun Map<String, Any?>.requireInt(field: String): Int =
        this[field] as? Int ?: error("$field is not an integer")

    private const val RESOURCE_NAME = "/enrollment-v2-p256-v1.json"
    private const val MAX_FIXTURE_BYTES = 8_192
    private const val SCHEMA_VERSION = 1
    private const val FIXTURE_KIND =
        "cassav5bt.bluetooth.enrollment-v2-p256-golden-vector"
    private val EXPECTED_FIELDS = setOf(
        "schemaVersion",
        "kind",
        "protocolVersion",
        "enrollmentEndpointId",
        "token",
        "nodeId",
        "publicKeyAlgorithm",
        "proofAlgorithm",
        "publicKeySpkiDerBase64",
        "requestJsonUtf8Base64",
        "proofTranscriptUtf8Base64",
        "proofTranscriptSha256",
        "proofSignatureBase64"
    )
}

class BluetoothEnrollmentV2GoldenVectorTest {
    @Test
    fun `shared Node and Android vector fixes transcript SPKI and low-S signature`() {
        val fixture = EnrollmentV2GoldenVectorFixture.value
        val request = fixture.request
        assertEquals(
            fixture.requestJsonUtf8Base64,
            Base64.getEncoder().encodeToString(
                BluetoothEnrollmentJsonV2.encodeRequest(request)
            )
        )
        val transcript = BluetoothEnrollmentProtocolV2.proofBytes(
            protocolVersion = request.protocolVersion,
            enrollmentEndpointId = request.enrollmentEndpointId,
            token = request.token,
            nodeId = request.nodeId,
            publicKeyAlgorithm = request.publicKeyAlgorithm,
            proofAlgorithm = request.proofAlgorithm,
            publicKeySpkiDerBase64 = request.publicKeySpkiDerBase64
        )
        assertEquals(
            fixture.proofTranscriptUtf8Base64,
            Base64.getEncoder().encodeToString(transcript)
        )
        assertEquals(
            fixture.proofTranscriptSha256,
            MessageDigest.getInstance("SHA-256").digest(transcript).toHex()
        )

        val spki = P256SpkiV2.decodeCanonicalBase64(
            request.publicKeySpkiDerBase64
        )
        assertTrue(P256SpkiV2.isCanonicalP256Spki(spki))
        val signature = Base64.getDecoder().decode(request.proofSignatureBase64)
        assertTrue(P256EcdsaSignatureV2.isCanonicalP1363(signature))
        val verifier = Signature.getInstance(
            P256EcdsaSignatureV2.JCA_SIGNATURE_ALGORITHM
        )
        verifier.initVerify(
            KeyFactory.getInstance(P256SpkiV2.JCA_KEY_ALGORITHM)
                .generatePublic(X509EncodedKeySpec(spki))
        )
        verifier.update(transcript)
        assertTrue(
            verifier.verify(
                P256EcdsaSignatureV2.canonicalP1363ToDer(signature)
            )
        )
    }
}
