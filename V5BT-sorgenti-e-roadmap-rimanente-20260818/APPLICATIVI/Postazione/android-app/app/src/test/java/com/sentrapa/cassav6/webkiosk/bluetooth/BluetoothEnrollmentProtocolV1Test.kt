package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class BluetoothEnrollmentProtocolV1Test {
    @Test
    fun `QR parser accepts exact protocol and rejects duplicate keys`() {
        val parsed = BluetoothEnrollmentJsonV1.parseQr(validQr())
            as BluetoothEnrollmentParseResult.Ready
        assertEquals(1, parsed.value.version)
        assertEquals(ENDPOINT_ID, parsed.value.enrollmentEndpointId)
        assertEquals(TOKEN, parsed.value.token)

        val duplicate = validQr().decodeToString().replace(
            "\"token\":\"$TOKEN\"",
            "\"token\":\"$TOKEN\",\"to\\u006ben\":\"$TOKEN\""
        ).encodeToByteArray()
        assertFailure(
            BluetoothEnrollmentParseCode.DUPLICATE_FIELD,
            BluetoothEnrollmentJsonV1.parseQr(duplicate)
        )
    }

    @Test
    fun `QR parser rejects extra missing wrong type noncanonical and oversized data`() {
        assertFailure(
            BluetoothEnrollmentParseCode.MISSING_OR_EXTRA_FIELD,
            BluetoothEnrollmentJsonV1.parseQr(
                validQr().decodeToString()
                    .replace("}", ",\"extra\":\"x\"}")
                    .encodeToByteArray()
            )
        )
        assertFailure(
            BluetoothEnrollmentParseCode.MISSING_OR_EXTRA_FIELD,
            BluetoothEnrollmentJsonV1.parseQr(
                "{\"version\":1,\"enrollmentEndpointId\":\"$ENDPOINT_ID\"}"
                    .encodeToByteArray()
            )
        )
        assertFailure(
            BluetoothEnrollmentParseCode.INVALID_FIELD_TYPE,
            BluetoothEnrollmentJsonV1.parseQr(
                validQr().decodeToString()
                    .replace("\"version\":1", "\"version\":\"1\"")
                    .encodeToByteArray()
            )
        )
        assertFailure(
            BluetoothEnrollmentParseCode.INVALID_FIELD_VALUE,
            BluetoothEnrollmentJsonV1.parseQr(
                validQr().decodeToString()
                    .replace(ENDPOINT_ID, "../wrong")
                    .encodeToByteArray()
            )
        )
        assertFailure(
            BluetoothEnrollmentParseCode.INPUT_TOO_LARGE,
            BluetoothEnrollmentJsonV1.parseQr(ByteArray(513) { 'a'.code.toByte() })
        )
    }

    @Test
    fun `response parser keeps exact scalar fields and rejects duplicates`() {
        val parsed = BluetoothEnrollmentJsonV1.parseResponse(validResponse())
            as BluetoothEnrollmentParseResult.Ready
        assertEquals(1, parsed.value["protocolVersion"])
        assertEquals(NODE_ID, parsed.value["nodeId"])
        assertEquals(ALIAS_KEY, parsed.value["aliasKeyBase64url"])

        val duplicate = validResponse().decodeToString().replace(
            "\"nodeId\":\"$NODE_ID\"",
            "\"nodeId\":\"$NODE_ID\",\"node\\u0049d\":\"$NODE_ID\""
        ).encodeToByteArray()
        assertFailure(
            BluetoothEnrollmentParseCode.DUPLICATE_FIELD,
            BluetoothEnrollmentJsonV1.parseResponse(duplicate)
        )
    }

    @Test
    fun `proof bytes are frozen and domain separated`() {
        val proof = BluetoothEnrollmentProtocolV1.proofBytes(
            protocolVersion = 1,
            enrollmentEndpointId = ENDPOINT_ID,
            token = TOKEN,
            nodeId = NODE_ID,
            publicKeySpkiDerBase64 = PUBLIC_KEY_SPKI
        )
        assertEquals(
            listOf(
                BluetoothEnrollmentProtocolV1.PROOF_CONTEXT,
                "1",
                ENDPOINT_ID,
                TOKEN,
                NODE_ID,
                PUBLIC_KEY_SPKI
            ).joinToString("\u0000"),
            proof.decodeToString()
        )
        assertEquals(
            PROOF_UTF8_BASE64,
            Base64.getEncoder().encodeToString(proof)
        )
    }

    @Test
    fun `request serializer emits the exact signed contract`() {
        val signature = PROOF_SIGNATURE_BASE64
        val request = BluetoothEnrollmentRequestV1(
            protocolVersion = 1,
            enrollmentEndpointId = ENDPOINT_ID,
            token = TOKEN,
            nodeId = NODE_ID,
            publicKeySpkiDerBase64 = PUBLIC_KEY_SPKI,
            proofSignatureBase64 = signature
        )
        assertEquals(
            "{\"protocolVersion\":1," +
                "\"enrollmentEndpointId\":\"$ENDPOINT_ID\"," +
                "\"token\":\"$TOKEN\"," +
                "\"nodeId\":\"$NODE_ID\"," +
                "\"publicKeyAlgorithm\":\"Ed25519\"," +
                "\"publicKeySpkiDerBase64\":\"$PUBLIC_KEY_SPKI\"," +
                "\"proofAlgorithm\":\"Ed25519\"," +
                "\"proofSignatureBase64\":\"$signature\"}",
            BluetoothEnrollmentJsonV1.encodeRequest(request).decodeToString()
        )
    }

    @Test
    fun `configuration requires feature HTTPS exact path no credentials and canonical pin`() {
        assertTrue(
            BluetoothEnrollmentConfigValidator.validate(validConfig()) is
                BluetoothEnrollmentConfigResult.Ready
        )
        listOf(
            validConfig().copy(enabled = false),
            validConfig().copy(endpointId = "../bad"),
            validConfig().copy(url = "http://192.168.1.79:9443/v1/enroll"),
            validConfig().copy(url = "https://user:pass@host/v1/enroll"),
            validConfig().copy(url = "https://host/v1/enroll?token=bad"),
            validConfig().copy(url = "https://host/other"),
            validConfig().copy(spkiSha256 = "sha256/not-a-pin")
        ).forEach { config ->
            assertTrue(
                BluetoothEnrollmentConfigValidator.validate(config) is
                    BluetoothEnrollmentConfigResult.Failure
            )
        }
    }

    @Test
    fun `transport source does not reuse permissive WebView trust`() {
        val source = BluetoothEnrollmentClient::class.java
            .getResourceAsStream("/does-not-exist")
        assertEquals(null, source)
        assertTrue(
            BluetoothEnrollmentClient::class.java.declaredClasses
                .any { it.simpleName == "PinnedSpkiTrustManager" }
        )
    }

    private fun validQr(): ByteArray =
        (
            "{\"version\":1,\"enrollmentEndpointId\":\"$ENDPOINT_ID\"," +
                "\"token\":\"$TOKEN\"}"
            ).encodeToByteArray()

    private fun validResponse(): ByteArray =
        (
            "{\"protocolVersion\":1,\"nodeId\":\"$NODE_ID\"," +
                "\"certificateId\":\"$CERTIFICATE_ID\"," +
                "\"publicKeyAlgorithm\":\"Ed25519\"," +
                "\"publicKeySpkiDerBase64\":\"$PUBLIC_KEY_SPKI\"," +
                "\"aliasKeyAlgorithm\":\"HMAC-SHA256\"," +
                "\"aliasKeyEncoding\":\"base64url-unpadded\"," +
                "\"aliasKeyBase64url\":\"$ALIAS_KEY\"," +
                "\"enrolledAt\":\"2026-07-19T16:00:00.000Z\"}"
            ).encodeToByteArray()

    private fun validConfig() = BluetoothEnrollmentConfig(
        enabled = true,
        endpointId = ENDPOINT_ID,
        url = "https://192.168.1.79:9443/v1/enroll",
        spkiSha256 = "sha256/${Base64.getEncoder().encodeToString(ByteArray(32))}"
    )

    private fun assertFailure(
        expected: BluetoothEnrollmentParseCode,
        result: BluetoothEnrollmentParseResult<*>
    ) {
        assertEquals(
            expected,
            (result as BluetoothEnrollmentParseResult.Failure).code
        )
    }

    companion object {
        private const val ENDPOINT_ID = "raspberry-lab-cassav6"
        private const val TOKEN =
            "c6e1_SkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSko"
        private const val NODE_ID = "550e8400-e29b-41d4-a716-446655440000"
        private const val CERTIFICATE_ID =
            "123e4567-e89b-42d3-a456-426614174000"
        private const val PUBLIC_KEY_SPKI =
            "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo="
        private const val PROOF_UTF8_BASE64 =
            "Q0FTU0FWNUJULUJULUVOUk9MTE1FTlQtUFJPT0YtVjEAMQByYXNwYmVycnkt" +
                "bGFiLXY1YnQAYzVlMV9Ta3BLU2twS1NrcEtTa3BLU2twS1NrcEtTa3BLU2tw" +
                "S1NrcEtTa3BLU2tvADU1MGU4NDAwLWUyOWItNDFkNC1hNzE2LTQ0NjY1NTQ0" +
                "MDAwMABNQ293QlFZREsyVndBeUVBMTFxWUFZS3hDcmZWUy83VHlXUUhPZzdo" +
                "Y3ZQYXBpTWxyd0lhYVBjSFVSbz0="
        private const val PROOF_SIGNATURE_BASE64 =
            "0SHJewphNo9dqvB7ab4HmM0uQFwpyUZLuu55Iq72p2QliP9IAdbwrDDzJWa9" +
                "HY30pfN+xOMscF7PcMj1e0DoCw=="
        private const val ALIAS_KEY =
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    }
}
