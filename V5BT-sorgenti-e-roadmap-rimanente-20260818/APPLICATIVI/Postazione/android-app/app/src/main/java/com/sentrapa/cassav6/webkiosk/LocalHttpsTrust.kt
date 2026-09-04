package com.sentrapa.cassav6.webkiosk

import android.net.Uri
import okhttp3.OkHttpClient
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Locale
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

object LocalHttpsTrust {
    fun shouldAllowCertificateError(errorUrl: String?, savedUrl: String?): Boolean {
        val errorUri = errorUrl?.let { runCatching { Uri.parse(it) }.getOrNull() } ?: return false
        val savedUri = savedUrl?.let { runCatching { Uri.parse(it) }.getOrNull() } ?: return false
        val errorScheme = errorUri.scheme?.lowercase(Locale.ROOT)
        if (errorScheme != "https" && errorScheme != "wss") return false
        if (!savedUri.scheme.equals("https", ignoreCase = true)) return false
        if (!errorUri.host.equals(savedUri.host, ignoreCase = true)) return false
        if (normalizedUriPort(errorUri) != normalizedUriPort(savedUri)) return false
        return isPrivateOrLocalHost(savedUri.host)
    }

    fun shouldUseFor(url: String): Boolean {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return false
        return uri.scheme.equals("https", ignoreCase = true) && isPrivateOrLocalHost(uri.host)
    }

    fun configure(connection: HttpsURLConnection, url: String) {
        if (!shouldUseFor(url)) return
        connection.sslSocketFactory = sslSocketFactory
        connection.hostnameVerifier = hostnameVerifier
    }

    fun configure(builder: OkHttpClient.Builder): OkHttpClient.Builder =
        builder
            .sslSocketFactory(sslSocketFactory, trustManager)
            .hostnameVerifier(hostnameVerifier)
            .followRedirects(false)
            .followSslRedirects(false)

    private fun normalizedUriPort(uri: Uri): Int =
        when {
            uri.port > 0 -> uri.port
            uri.scheme.equals("https", ignoreCase = true) ||
                uri.scheme.equals("wss", ignoreCase = true) -> 443
            uri.scheme.equals("http", ignoreCase = true) -> 80
            else -> -1
        }

    private fun isPrivateOrLocalHost(host: String?): Boolean {
        val value = host?.trim()?.lowercase(Locale.ROOT)?.trim('[', ']') ?: return false
        if (value == "localhost" || value.endsWith(".local")) return true
        val parts = value.split('.')
        if (parts.size != 4) return false
        val octets = parts.map { it.toIntOrNull() ?: return false }
        return octets[0] == 10 ||
            (octets[0] == 172 && octets[1] in 16..31) ||
            (octets[0] == 192 && octets[1] == 168) ||
            octets[0] == 127
    }

    private val trustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private val sslSocketFactory by lazy {
        SSLContext.getInstance("TLS").apply {
            init(null, arrayOf<TrustManager>(trustManager), SecureRandom())
        }.socketFactory
    }

    private val hostnameVerifier = HostnameVerifier { _, _ -> true }
}
