package com.sentrapa.cassav6.webkiosk.bluetooth

import okhttp3.ConnectionSpec
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.TlsVersion
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString
import java.net.Proxy
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.X509TrustManager

data class BluetoothEnrollmentConfig(
    val enabled: Boolean,
    val endpointId: String,
    val url: String,
    val spkiSha256: String
)

enum class BluetoothEnrollmentClientStatus {
    READY,
    FEATURE_DISABLED,
    CONFIGURATION_INVALID,
    TLS_AUTHENTICATION_FAILED,
    NETWORK_FAILED,
    HTTP_REJECTED,
    RESPONSE_INVALID,
    CLOSED
}

sealed class BluetoothEnrollmentClientResult {
    data class Ready(
        val responseFields: Map<String, Any?>
    ) : BluetoothEnrollmentClientResult()

    data class Failure(
        val status: BluetoothEnrollmentClientStatus,
        val httpStatus: Int? = null,
        val parseCode: BluetoothEnrollmentParseCode? = null
    ) : BluetoothEnrollmentClientResult()
}

sealed class BluetoothEnrollmentConfigResult {
    data class Ready(
        val endpointId: String,
        val url: HttpUrl,
        val spkiSha256: String,
        val spkiSha256Bytes: ByteArray
    ) : BluetoothEnrollmentConfigResult()

    data class Failure(
        val status: BluetoothEnrollmentClientStatus
    ) : BluetoothEnrollmentConfigResult()
}

object BluetoothEnrollmentConfigValidator {
    private val pinPattern =
        Regex("^sha256/[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$")

    fun validate(config: BluetoothEnrollmentConfig): BluetoothEnrollmentConfigResult {
        if (!config.enabled) {
            return BluetoothEnrollmentConfigResult.Failure(
                BluetoothEnrollmentClientStatus.FEATURE_DISABLED
            )
        }
        val url = config.url.toHttpUrlOrNull()
        if (
            !BluetoothEnrollmentProtocolV1.isCanonicalEndpointId(
                config.endpointId
            ) ||
            url == null ||
            !url.isHttps ||
            url.username.isNotEmpty() ||
            url.password.isNotEmpty() ||
            url.encodedPath !in setOf(
                BluetoothEnrollmentProtocolV1.ENROLLMENT_PATH,
                BluetoothEnrollmentProtocolV2.ENROLLMENT_PATH
            ) ||
            url.query != null ||
            url.fragment != null ||
            !pinPattern.matches(config.spkiSha256)
        ) {
            return BluetoothEnrollmentConfigResult.Failure(
                BluetoothEnrollmentClientStatus.CONFIGURATION_INVALID
            )
        }
        val pinBytes =
            config.spkiSha256
                .removePrefix("sha256/")
                .decodeBase64()
                ?.toByteArray()
        if (
            pinBytes == null ||
            pinBytes.size != SHA256_BYTES ||
            pinBytes.toByteString().base64() !=
            config.spkiSha256.removePrefix("sha256/")
        ) {
            pinBytes?.fill(0)
            return BluetoothEnrollmentConfigResult.Failure(
                BluetoothEnrollmentClientStatus.CONFIGURATION_INVALID
            )
        }
        return BluetoothEnrollmentConfigResult.Ready(
            endpointId = config.endpointId,
            url = url,
            spkiSha256 = config.spkiSha256,
            spkiSha256Bytes = pinBytes
        )
    }

    private const val SHA256_BYTES = 32
}

class BluetoothEnrollmentClient(
    config: BluetoothEnrollmentConfig
) : AutoCloseable {
    private val validatedConfig = BluetoothEnrollmentConfigValidator.validate(config)
    private val client: OkHttpClient? =
        (validatedConfig as? BluetoothEnrollmentConfigResult.Ready)
            ?.let { ready ->
                runCatching { buildPinnedClient(ready) }.getOrNull()
            }

    @Volatile
    private var closed = false

    fun enroll(
        request: BluetoothEnrollmentRequestV1
    ): BluetoothEnrollmentClientResult =
        executeEnrollment(
            endpointId = request.enrollmentEndpointId,
            protocolVersion = request.protocolVersion,
            expectedProtocolVersion = BluetoothEnrollmentProtocolV1.PROTOCOL_VERSION,
            enrollmentPath = BluetoothEnrollmentProtocolV1.ENROLLMENT_PATH,
            maxResponseBytes = BluetoothEnrollmentProtocolV1.MAX_RESPONSE_BYTES,
            encode = { BluetoothEnrollmentJsonV1.encodeRequest(request) },
            parse = BluetoothEnrollmentJsonV1::parseResponse
        )

    fun enroll(
        request: BluetoothEnrollmentRequestV2
    ): BluetoothEnrollmentClientResult =
        executeEnrollment(
            endpointId = request.enrollmentEndpointId,
            protocolVersion = request.protocolVersion,
            expectedProtocolVersion = BluetoothEnrollmentProtocolV2.PROTOCOL_VERSION,
            enrollmentPath = BluetoothEnrollmentProtocolV2.ENROLLMENT_PATH,
            maxResponseBytes = BluetoothEnrollmentProtocolV2.MAX_RESPONSE_BYTES,
            encode = { BluetoothEnrollmentJsonV2.encodeRequest(request) },
            parse = BluetoothEnrollmentJsonV2::parseResponse
        )

    private fun executeEnrollment(
        endpointId: String,
        protocolVersion: Int,
        expectedProtocolVersion: Int,
        enrollmentPath: String,
        maxResponseBytes: Int,
        encode: () -> ByteArray,
        parse: (ByteArray) -> BluetoothEnrollmentParseResult<Map<String, Any?>>
    ): BluetoothEnrollmentClientResult {
        if (closed) {
            return failure(BluetoothEnrollmentClientStatus.CLOSED)
        }
        val readyConfig =
            validatedConfig as? BluetoothEnrollmentConfigResult.Ready
                ?: return failure(
                    (validatedConfig as BluetoothEnrollmentConfigResult.Failure)
                        .status
                )
        val httpClient = client
            ?: return failure(
                BluetoothEnrollmentClientStatus.TLS_AUTHENTICATION_FAILED
            )
        if (
            endpointId != readyConfig.endpointId ||
            protocolVersion != expectedProtocolVersion ||
            readyConfig.url.encodedPath != enrollmentPath
        ) {
            return failure(BluetoothEnrollmentClientStatus.CONFIGURATION_INVALID)
        }
        val requestBytes =
            try {
                encode()
            } catch (_: IllegalArgumentException) {
                return failure(BluetoothEnrollmentClientStatus.CONFIGURATION_INVALID)
            }
        return try {
            val httpRequest = Request.Builder()
                .url(
                    readyConfig.url.newBuilder()
                        .encodedPath(enrollmentPath)
                        .build()
                )
                .header("Accept", JSON_MEDIA_TYPE_TEXT)
                .header("Cache-Control", "no-store")
                .post(requestBytes.toRequestBody(JSON_MEDIA_TYPE))
                .build()
            httpClient.newCall(httpRequest).execute().use { response ->
                if (response.code != EXPECTED_SUCCESS_STATUS) {
                    return failure(
                        BluetoothEnrollmentClientStatus.HTTP_REJECTED,
                        httpStatus = response.code
                    )
                }
                val contentType = response.body?.contentType()
                if (
                    contentType == null ||
                    contentType.type != "application" ||
                    contentType.subtype != "json"
                ) {
                    return failure(BluetoothEnrollmentClientStatus.RESPONSE_INVALID)
                }
                val body = response.body
                    ?: return failure(
                        BluetoothEnrollmentClientStatus.RESPONSE_INVALID
                    )
                if (
                    body.contentLength() >
                    maxResponseBytes
                ) {
                    return failure(BluetoothEnrollmentClientStatus.RESPONSE_INVALID)
                }
                val source = body.source()
                source.request(
                    (maxResponseBytes + 1).toLong()
                )
                if (
                    source.buffer.size >
                    maxResponseBytes
                ) {
                    return failure(BluetoothEnrollmentClientStatus.RESPONSE_INVALID)
                }
                val responseBytes = source.readByteArray()
                try {
                    when (
                        val parsed = parse(responseBytes)
                    ) {
                        is BluetoothEnrollmentParseResult.Failure ->
                            failure(
                                BluetoothEnrollmentClientStatus.RESPONSE_INVALID,
                                parseCode = parsed.code
                            )
                        is BluetoothEnrollmentParseResult.Ready ->
                            BluetoothEnrollmentClientResult.Ready(parsed.value)
                    }
                } finally {
                    responseBytes.fill(0)
                }
            }
        } catch (_: SSLPeerUnverifiedException) {
            failure(BluetoothEnrollmentClientStatus.TLS_AUTHENTICATION_FAILED)
        } catch (_: SSLHandshakeException) {
            failure(BluetoothEnrollmentClientStatus.TLS_AUTHENTICATION_FAILED)
        } catch (_: CertificateException) {
            failure(BluetoothEnrollmentClientStatus.TLS_AUTHENTICATION_FAILED)
        } catch (_: Exception) {
            failure(BluetoothEnrollmentClientStatus.NETWORK_FAILED)
        } finally {
            requestBytes.fill(0)
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        client?.dispatcher?.cancelAll()
        client?.connectionPool?.evictAll()
        (validatedConfig as? BluetoothEnrollmentConfigResult.Ready)
            ?.spkiSha256Bytes
            ?.fill(0)
    }

    private fun buildPinnedClient(
        config: BluetoothEnrollmentConfigResult.Ready
    ): OkHttpClient {
        val trustManager = PinnedSpkiTrustManager(config.spkiSha256Bytes)
        val sslContext = SSLContext.getInstance("TLSv1.3").apply {
            init(null, arrayOf(trustManager), SecureRandom())
        }
        val tls13Only = ConnectionSpec.Builder(ConnectionSpec.RESTRICTED_TLS)
            .tlsVersions(TlsVersion.TLS_1_3)
            .build()
        return OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .connectionSpecs(listOf(tls13Only))
            .proxy(Proxy.NO_PROXY)
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            .callTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    private fun failure(
        status: BluetoothEnrollmentClientStatus,
        httpStatus: Int? = null,
        parseCode: BluetoothEnrollmentParseCode? = null
    ): BluetoothEnrollmentClientResult.Failure =
        BluetoothEnrollmentClientResult.Failure(
            status = status,
            httpStatus = httpStatus,
            parseCode = parseCode
        )

    private class PinnedSpkiTrustManager(
        expectedSpkiSha256: ByteArray
    ) : X509TrustManager {
        private val expectedPin = expectedSpkiSha256.copyOf()

        override fun checkClientTrusted(
            chain: Array<out X509Certificate>?,
            authType: String?
        ) {
            throw CertificateException("Client certificates are not accepted")
        }

        override fun checkServerTrusted(
            chain: Array<out X509Certificate>?,
            authType: String?
        ) {
            val leaf = chain?.firstOrNull()
                ?: throw CertificateException("Server certificate is missing")
            leaf.checkValidity()
            val actualPin = MessageDigest.getInstance("SHA-256")
                .digest(leaf.publicKey.encoded)
            try {
                if (!MessageDigest.isEqual(expectedPin, actualPin)) {
                    throw CertificateException("Server SPKI pin mismatch")
                }
            } finally {
                actualPin.fill(0)
            }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> =
            emptyArray()
    }

    companion object {
        private const val EXPECTED_SUCCESS_STATUS = 201
        private const val JSON_MEDIA_TYPE_TEXT = "application/json"
        private val JSON_MEDIA_TYPE = JSON_MEDIA_TYPE_TEXT.toMediaType()
    }
}
