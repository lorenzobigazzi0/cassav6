package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.SocketException
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import kotlin.concurrent.thread

class BluetoothEnrollmentTlsIntegrationTest {
    @Test
    fun `matching pin and IP SAN succeeds over TLS 1_3`() {
        withServer(VALID_STORE, arrayOf("TLSv1.3")) { server ->
            val result = enroll(server, host = "127.0.0.1", pin = server.pin)
            assertTrue(result is BluetoothEnrollmentClientResult.Ready)
        }
    }

    @Test
    fun `shared P256 vector completes the native v2 client over TLS 1_3`() {
        withServer(
            VALID_STORE,
            arrayOf("TLSv1.3"),
            response = v2Response(),
            expectedRequest = expectedV2Request()
        ) { server ->
            val result = enrollV2(server, host = "127.0.0.1", pin = server.pin)
            assertTrue(result is BluetoothEnrollmentClientResult.Ready)
        }
    }

    @Test
    fun `wrong pin and wrong SAN both fail authentication`() {
        withServer(VALID_STORE, arrayOf("TLSv1.3")) { server ->
            val wrongPin = "sha256/${
                Base64.getEncoder().encodeToString(ByteArray(32) { 0x5a })
            }"
            assertAuthenticationFailure(
                enroll(server, host = "127.0.0.1", pin = wrongPin)
            )
            assertAuthenticationFailure(
                enroll(server, host = "localhost", pin = server.pin)
            )
        }
    }

    @Test
    fun `expired pinned certificate fails authentication`() {
        withServer(EXPIRED_STORE, arrayOf("TLSv1.3")) { server ->
            assertAuthenticationFailure(
                enroll(server, host = "127.0.0.1", pin = server.pin)
            )
        }
    }

    @Test
    fun `TLS 1_2 only server cannot downgrade the client`() {
        withServer(VALID_STORE, arrayOf("TLSv1.2")) { server ->
            assertAuthenticationFailure(
                enroll(server, host = "127.0.0.1", pin = server.pin)
            )
        }
    }

    private fun enroll(
        server: TestServer,
        host: String,
        pin: String
    ): BluetoothEnrollmentClientResult {
        val client = BluetoothEnrollmentClient(
            BluetoothEnrollmentConfig(
                enabled = true,
                endpointId = ENDPOINT_ID,
                url = "https://$host:${server.port}/v1/enroll",
                spkiSha256 = pin
            )
        )
        return try {
            client.enroll(REQUEST)
        } finally {
            client.close()
        }
    }

    private fun enrollV2(
        server: TestServer,
        host: String,
        pin: String
    ): BluetoothEnrollmentClientResult {
        val client = BluetoothEnrollmentClient(
            BluetoothEnrollmentConfig(
                enabled = true,
                endpointId = ENDPOINT_ID,
                url = "https://$host:${server.port}/v2/enroll",
                spkiSha256 = pin
            )
        )
        return try {
            client.enroll(EnrollmentV2GoldenVectorFixture.value.request)
        } finally {
            client.close()
        }
    }

    private fun assertAuthenticationFailure(
        result: BluetoothEnrollmentClientResult
    ) {
        assertEquals(
            BluetoothEnrollmentClientStatus.TLS_AUTHENTICATION_FAILED,
            (result as BluetoothEnrollmentClientResult.Failure).status
        )
    }

    private fun withServer(
        keyStoreResource: String,
        protocols: Array<String>,
        response: String = RESPONSE,
        expectedRequest: ExpectedHttpRequest? = null,
        block: (TestServer) -> Unit
    ) {
        val keyStore = KeyStore.getInstance("PKCS12")
        requireNotNull(
            javaClass.getResourceAsStream("/tls/$keyStoreResource")
        ).use { input ->
            keyStore.load(input, STORE_PASSWORD)
        }
        val keyManagers = KeyManagerFactory.getInstance(
            KeyManagerFactory.getDefaultAlgorithm()
        ).apply {
            init(keyStore, STORE_PASSWORD)
        }
        val sslContext = SSLContext.getInstance("TLS").apply {
            init(keyManagers.keyManagers, null, SecureRandom())
        }
        val certificate = keyStore.getCertificate("server") as X509Certificate
        val pin = "sha256/${
            Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-256")
                    .digest(certificate.publicKey.encoded)
            )
        }"
        LocalTlsServer(
            sslContext = sslContext,
            protocols = protocols,
            response = response,
            expectedRequest = expectedRequest
        ).use { server ->
            val blockFailure = runCatching {
                block(
                    TestServer(
                        port = server.port,
                        pin = pin
                    )
                )
            }.exceptionOrNull()
            server.assertExpectedRequest()
            if (blockFailure != null) throw blockFailure
        }
    }

    private class LocalTlsServer(
        sslContext: SSLContext,
        protocols: Array<String>,
        private val response: String,
        private val expectedRequest: ExpectedHttpRequest?
    ) : AutoCloseable {
        private val running = AtomicBoolean(true)
        @Volatile
        private var requestValidationFailure: String? = null
        @Volatile
        private var validatedRequestCount = 0
        private val serverSocket =
            (
                sslContext.serverSocketFactory.createServerSocket(
                    0,
                    16,
                    InetAddress.getByName("127.0.0.1")
                ) as SSLServerSocket
            ).apply {
                enabledProtocols = protocols
            }
        private val worker = thread(
            name = "V5BT-Enrollment-TLS-Test",
            isDaemon = true,
            block = ::acceptLoop
        )

        val port: Int
            get() = serverSocket.localPort

        private fun acceptLoop() {
            while (running.get()) {
                try {
                    (serverSocket.accept() as SSLSocket).use { socket ->
                        socket.soTimeout = 5_000
                        socket.startHandshake()
                        handleRequest(socket)
                    }
                } catch (_: SocketException) {
                    if (!running.get()) return
                } catch (_: Exception) {
                    if (!running.get()) return
                }
            }
        }

        private fun handleRequest(socket: SSLSocket) = try {
            val reader = socket.inputStream.bufferedReader(Charsets.US_ASCII)
            val requestLine = reader.readLine()
                ?: error("HTTP request line is missing")
            var contentLength: Int? = null
            var contentType: String? = null
            while (true) {
                val line = reader.readLine()
                    ?: error("HTTP headers ended unexpectedly")
                if (line.isEmpty()) break
                if (line.startsWith("Content-Length:", ignoreCase = true)) {
                    if (contentLength != null) {
                        error("Content-Length header is duplicated")
                    }
                    contentLength = line.substringAfter(':').trim().toIntOrNull()
                        ?: error("Content-Length header is invalid")
                }
                if (line.startsWith("Content-Type:", ignoreCase = true)) {
                    if (contentType != null) {
                        error("Content-Type header is duplicated")
                    }
                    contentType = line.substringAfter(':').trim()
                }
            }
            val exactLength = contentLength
                ?: error("Content-Length header is missing")
            if (exactLength !in 0..MAX_TEST_REQUEST_BYTES) {
                error("Content-Length header exceeds the test limit")
            }
            val bodyChars = CharArray(exactLength)
            var offset = 0
            while (offset < bodyChars.size) {
                val read = reader.read(bodyChars, offset, bodyChars.size - offset)
                if (read < 0) error("HTTP request body ended unexpectedly")
                offset += read
            }
            val requestBody = String(bodyChars).toByteArray(Charsets.UTF_8)
            expectedRequest?.let { expected ->
                when {
                    requestLine.contains(" /v1/enroll ") ->
                        error("The v2 client attempted a v1 enrollment fallback")
                    requestLine != expected.requestLine ->
                        error("Unexpected HTTP request line: $requestLine")
                    contentType != expected.contentType ->
                        error("Unexpected Content-Type: $contentType")
                    !requestBody.contentEquals(expected.body) ->
                        error("The HTTP request body differs from the golden vector")
                    else -> validatedRequestCount += 1
                }
            }
            val responseBody = response.toByteArray(Charsets.UTF_8)
            val headers =
                "HTTP/1.1 201 Created\r\n" +
                    "Content-Type: application/json; charset=utf-8\r\n" +
                    "Cache-Control: no-store\r\n" +
                    "Content-Length: ${responseBody.size}\r\n" +
                    "Connection: close\r\n\r\n"
            socket.outputStream.write(headers.toByteArray(Charsets.US_ASCII))
            socket.outputStream.write(responseBody)
            socket.outputStream.flush()
        } catch (error: Exception) {
            if (expectedRequest != null && requestValidationFailure == null) {
                requestValidationFailure = error.message ?: error.javaClass.simpleName
            }
            throw error
        }

        fun assertExpectedRequest() {
            if (expectedRequest == null) return
            val failure = requestValidationFailure
            if (failure != null) throw AssertionError(failure)
            assertEquals(
                "The v2 client must send exactly one request without v1 fallback",
                1,
                validatedRequestCount
            )
        }

        override fun close() {
            if (!running.compareAndSet(true, false)) return
            runCatching { serverSocket.close() }
            worker.join(2_000)
        }
    }

    private data class TestServer(
        val port: Int,
        val pin: String
    )

    private data class ExpectedHttpRequest(
        val requestLine: String,
        val contentType: String,
        val body: ByteArray
    )

    companion object {
        private val STORE_PASSWORD = "changeit".toCharArray()
        private const val VALID_STORE = "tls-server-valid.p12"
        private const val EXPIRED_STORE = "tls-server-expired.p12"
        private const val JSON_CONTENT_TYPE = "application/json"
        private const val MAX_TEST_REQUEST_BYTES = 64 * 1024
        private const val ENDPOINT_ID = "raspberry-lab-v5bt"
        private const val TOKEN =
            "c5e1_SkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSko"
        private const val NODE_ID =
            "550e8400-e29b-41d4-a716-446655440000"
        private const val PUBLIC_KEY_SPKI =
            "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo="
        private const val SIGNATURE =
            "0SHJewphNo9dqvB7ab4HmM0uQFwpyUZLuu55Iq72p2QliP9IAdbwrDDzJWa9" +
                "HY30pfN+xOMscF7PcMj1e0DoCw=="
        private val REQUEST = BluetoothEnrollmentRequestV1(
            protocolVersion = 1,
            enrollmentEndpointId = ENDPOINT_ID,
            token = TOKEN,
            nodeId = NODE_ID,
            publicKeySpkiDerBase64 = PUBLIC_KEY_SPKI,
            proofSignatureBase64 = SIGNATURE
        )
        private val RESPONSE =
            (
                "{\"protocolVersion\":1,\"nodeId\":\"$NODE_ID\"," +
                    "\"certificateId\":\"123e4567-e89b-42d3-a456-426614174000\"," +
                    "\"publicKeyAlgorithm\":\"Ed25519\"," +
                    "\"publicKeySpkiDerBase64\":\"$PUBLIC_KEY_SPKI\"," +
                    "\"aliasKeyAlgorithm\":\"HMAC-SHA256\"," +
                    "\"aliasKeyEncoding\":\"base64url-unpadded\"," +
                    "\"aliasKeyBase64url\":" +
                    "\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\"," +
                    "\"enrolledAt\":\"2026-07-19T16:00:00.000Z\"}"
            )

        private fun v2Response(): String {
            val request = EnrollmentV2GoldenVectorFixture.value.request
            return (
                "{\"protocolVersion\":2,\"nodeId\":\"${request.nodeId}\"," +
                    "\"certificateId\":\"123e4567-e89b-42d3-a456-426614174000\"," +
                    "\"publicKeyAlgorithm\":\"EC-P256\"," +
                    "\"publicKeySpkiDerBase64\":\"" +
                    "${request.publicKeySpkiDerBase64}\"," +
                    "\"aliasKeyAlgorithm\":\"HMAC-SHA256\"," +
                    "\"aliasKeyEncoding\":\"base64url-unpadded\"," +
                    "\"aliasKeyBase64url\":" +
                    "\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\"," +
                    "\"enrolledAt\":\"2026-08-17T16:00:00.000Z\"}"
                )
        }

        private fun expectedV2Request(): ExpectedHttpRequest {
            val fixture = EnrollmentV2GoldenVectorFixture.value
            return ExpectedHttpRequest(
                requestLine =
                    "POST ${BluetoothEnrollmentProtocolV2.ENROLLMENT_PATH} HTTP/1.1",
                contentType = JSON_CONTENT_TYPE,
                body = Base64.getDecoder().decode(fixture.requestJsonUtf8Base64)
            )
        }
    }
}
