package com.sentrapa.cassav6.webkiosk.bluetooth

import okhttp3.ConnectionSpec
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.TlsVersion
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

internal data class AndroidPeerTrustClientConfigV1(
    val enabled: Boolean,
    val url: String,
    val tlsSpkiSha256: String
)

internal enum class AndroidPeerTrustClientStatusV1 {
    READY,
    FEATURE_DISABLED,
    CONFIGURATION_INVALID,
    TLS_AUTHENTICATION_FAILED,
    NETWORK_FAILED,
    HTTP_REJECTED,
    RESPONSE_INVALID,
    DIRECTORY_REJECTED,
    CLOSED
}

internal sealed class AndroidPeerTrustClientResultV1 {
    data class Ready(val revision: Long) : AndroidPeerTrustClientResultV1()
    data class Failure(
        val status: AndroidPeerTrustClientStatusV1,
        val httpStatus: Int? = null,
        val directoryCode: String? = null
    ) : AndroidPeerTrustClientResultV1()
}

internal data class ValidatedAndroidPeerTrustClientConfigV1(
    val url: HttpUrl,
    val tlsPin: ByteArray
)

internal object AndroidPeerTrustClientConfigValidatorV1 {
    const val PATH = "/v1/peer-trust-directory"
    private val pinPattern = Regex("^sha256/[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$")

    fun validate(
        config: AndroidPeerTrustClientConfigV1
    ): Result<ValidatedAndroidPeerTrustClientConfigV1> = runCatching {
        require(config.enabled)
        val url = requireNotNull(config.url.toHttpUrlOrNull())
        require(
            url.isHttps &&
                url.username.isEmpty() &&
                url.password.isEmpty() &&
                url.encodedPath == PATH &&
                url.query == null &&
                url.fragment == null &&
                pinPattern.matches(config.tlsSpkiSha256)
        )
        val pin = requireNotNull(
            config.tlsSpkiSha256.removePrefix("sha256/").decodeBase64()
                ?.toByteArray()
        )
        require(
            pin.size == 32 &&
                pin.any { it.toInt() != 0 } &&
                pin.toByteString().base64() ==
                config.tlsSpkiSha256.removePrefix("sha256/")
        )
        ValidatedAndroidPeerTrustClientConfigV1(url, pin)
    }
}

internal class AndroidPeerTrustDirectoryClientV1(
    config: AndroidPeerTrustClientConfigV1,
    private val cache: AndroidPeerTrustCacheV1,
    private val now: () -> Long = System::currentTimeMillis
) : AutoCloseable {
    private val configuration =
        if (config.enabled) AndroidPeerTrustClientConfigValidatorV1.validate(config)
        else Result.failure(IllegalStateException("feature disabled"))
    private val client = configuration.getOrNull()?.let(::pinnedClient)
    private val featureEnabled = config.enabled
    @Volatile private var closed = false

    fun refresh(): AndroidPeerTrustClientResultV1 {
        if (closed) return failure(AndroidPeerTrustClientStatusV1.CLOSED)
        if (!featureEnabled) {
            return failure(AndroidPeerTrustClientStatusV1.FEATURE_DISABLED)
        }
        val ready = configuration.getOrNull()
            ?: return failure(AndroidPeerTrustClientStatusV1.CONFIGURATION_INVALID)
        val http = client
            ?: return failure(AndroidPeerTrustClientStatusV1.TLS_AUTHENTICATION_FAILED)
        return try {
            val request = Request.Builder()
                .url(ready.url)
                .get()
                .header("Accept", MEDIA_TYPE)
                .header("Cache-Control", "no-store")
                .build()
            http.newCall(request).execute().use { response ->
                if (response.code != 200) {
                    return failure(
                        AndroidPeerTrustClientStatusV1.HTTP_REJECTED,
                        response.code
                    )
                }
                if (response.header("Cache-Control") != "no-store") {
                    return failure(AndroidPeerTrustClientStatusV1.RESPONSE_INVALID)
                }
                val type = response.body?.contentType()
                if (
                    type == null ||
                    "${type.type}/${type.subtype}" != MEDIA_TYPE
                ) {
                    return failure(AndroidPeerTrustClientStatusV1.RESPONSE_INVALID)
                }
                val body = response.body
                    ?: return failure(AndroidPeerTrustClientStatusV1.RESPONSE_INVALID)
                if (body.contentLength() > PEER_TRUST_DIRECTORY_MAX_BYTES_V1) {
                    return failure(AndroidPeerTrustClientStatusV1.RESPONSE_INVALID)
                }
                val source = body.source()
                source.request((PEER_TRUST_DIRECTORY_MAX_BYTES_V1 + 1).toLong())
                if (source.buffer.size > PEER_TRUST_DIRECTORY_MAX_BYTES_V1) {
                    return failure(AndroidPeerTrustClientStatusV1.RESPONSE_INVALID)
                }
                val wire = source.readByteArray()
                try {
                    AndroidPeerTrustClientResultV1.Ready(
                        cache.importSignedDirectory(wire, now())
                    )
                } catch (error: AndroidPeerTrustExceptionV1) {
                    failure(
                        AndroidPeerTrustClientStatusV1.DIRECTORY_REJECTED,
                        directoryCode = error.code
                    )
                } finally {
                    wire.fill(0)
                }
            }
        } catch (_: SSLPeerUnverifiedException) {
            failure(AndroidPeerTrustClientStatusV1.TLS_AUTHENTICATION_FAILED)
        } catch (_: SSLHandshakeException) {
            failure(AndroidPeerTrustClientStatusV1.TLS_AUTHENTICATION_FAILED)
        } catch (_: CertificateException) {
            failure(AndroidPeerTrustClientStatusV1.TLS_AUTHENTICATION_FAILED)
        } catch (_: Exception) {
            failure(AndroidPeerTrustClientStatusV1.NETWORK_FAILED)
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        client?.dispatcher?.cancelAll()
        client?.connectionPool?.evictAll()
        configuration.getOrNull()?.tlsPin?.fill(0)
    }

    private fun pinnedClient(
        config: ValidatedAndroidPeerTrustClientConfigV1
    ): OkHttpClient {
        val trust = PeerTrustPinnedSpkiManagerV1(config.tlsPin)
        val tls = SSLContext.getInstance("TLSv1.3").apply {
            init(null, arrayOf(trust), SecureRandom())
        }
        val tls13 = ConnectionSpec.Builder(ConnectionSpec.RESTRICTED_TLS)
            .tlsVersions(TlsVersion.TLS_1_3)
            .build()
        return OkHttpClient.Builder()
            .sslSocketFactory(tls.socketFactory, trust)
            .connectionSpecs(listOf(tls13))
            .proxy(Proxy.NO_PROXY)
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
            .writeTimeout(5, TimeUnit.SECONDS)
            .callTimeout(8, TimeUnit.SECONDS)
            .build()
    }

    private fun failure(
        status: AndroidPeerTrustClientStatusV1,
        httpStatus: Int? = null,
        directoryCode: String? = null
    ) = AndroidPeerTrustClientResultV1.Failure(
        status,
        httpStatus,
        directoryCode
    )

    private class PeerTrustPinnedSpkiManagerV1(pin: ByteArray) : X509TrustManager {
        private val expected = pin.copyOf()

        override fun checkClientTrusted(
            chain: Array<out X509Certificate>?,
            authType: String?
        ) = throw CertificateException("client certificates are not accepted")

        override fun checkServerTrusted(
            chain: Array<out X509Certificate>?,
            authType: String?
        ) {
            val leaf = chain?.firstOrNull()
                ?: throw CertificateException("server certificate is absent")
            leaf.checkValidity()
            val actual = MessageDigest.getInstance("SHA-256")
                .digest(leaf.publicKey.encoded)
            try {
                if (!MessageDigest.isEqual(expected, actual)) {
                    throw CertificateException("server SPKI pin mismatch")
                }
            } finally {
                actual.fill(0)
            }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    companion object {
        private const val MEDIA_TYPE =
            "application/vnd.cassav6.peer-trust-directory-v1+json"
    }
}
