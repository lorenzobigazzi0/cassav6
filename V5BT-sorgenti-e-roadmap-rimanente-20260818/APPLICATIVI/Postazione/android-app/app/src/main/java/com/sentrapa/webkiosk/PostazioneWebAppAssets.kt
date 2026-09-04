package com.sentrapa.webkiosk

import android.content.Context
import android.net.Uri
import android.util.Log
import android.webkit.MimeTypeMap
import android.webkit.WebResourceResponse
import java.io.FileNotFoundException
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Locale

private const val POSTAZIONE_WEB_PATH = "/postazione"
private const val POSTAZIONE_ASSET_ROOT = "postazione"

/**
 * Serves the bundled frontend while preserving the configured HTTPS origin.
 * Requests outside /postazione stay on the network, so API, SSE and WebSocket
 * traffic keep the same origin and contracts used by the hosted application.
 */
internal class PostazioneWebAppAssets(context: Context) {
    private val assets = context.applicationContext.assets

    fun shouldIntercept(requestUrl: Uri, configuredUrl: String?): WebResourceResponse? {
        if (!isConfiguredOrigin(requestUrl.toString(), configuredUrl)) return null
        val assetPath = resolveBundledAssetPath(requestUrl.encodedPath.orEmpty()) ?: return null
        val stream = try {
            assets.open(assetPath)
        } catch (_: FileNotFoundException) {
            return null
        } catch (error: Exception) {
            Log.w("PostazioneAssets", "Asset locale non leggibile: $assetPath", error)
            return null
        }

        return WebResourceResponse(
            mimeTypeFor(assetPath),
            textEncodingFor(assetPath),
            stream
        )
    }
}

internal fun resolveBundledAssetPath(encodedPath: String): String? {
    val path = runCatching {
        URLDecoder.decode(encodedPath.substringBefore('?'), StandardCharsets.UTF_8.name())
    }.getOrNull() ?: return null
    if (path != POSTAZIONE_WEB_PATH && !path.startsWith("$POSTAZIONE_WEB_PATH/")) return null

    var relative = path.removePrefix(POSTAZIONE_WEB_PATH).trimStart('/')
    if (relative.contains('\\') || relative.split('/').any { it == ".." }) return null
    if (relative.isBlank() || relative.endsWith('/')) relative += "index.html"
    if (!relative.substringAfterLast('/', relative).contains('.')) relative = "index.html"
    return "$POSTAZIONE_ASSET_ROOT/$relative"
}

internal fun isConfiguredOrigin(candidateUrl: String?, configuredUrl: String?): Boolean {
    if (candidateUrl.isNullOrBlank() || configuredUrl.isNullOrBlank()) return false
    return runCatching {
        val candidate = URI(candidateUrl)
        val configured = URI(configuredUrl)
        val candidateScheme = candidate.scheme?.lowercase(Locale.ROOT)
        val configuredScheme = configured.scheme?.lowercase(Locale.ROOT)
        candidateScheme in setOf("http", "https") &&
            candidateScheme == configuredScheme &&
            candidate.host.equals(configured.host, ignoreCase = true) &&
            effectiveOriginPort(candidate) == effectiveOriginPort(configured)
    }.getOrDefault(false)
}

private fun effectiveOriginPort(uri: URI): Int = when {
    uri.port > 0 -> uri.port
    uri.scheme.equals("https", ignoreCase = true) -> 443
    uri.scheme.equals("http", ignoreCase = true) -> 80
    else -> -1
}

private fun mimeTypeFor(assetPath: String): String {
    val extension = assetPath.substringAfterLast('.', "").lowercase(Locale.ROOT)
    return when (extension) {
        "js", "mjs" -> "text/javascript"
        "json", "map" -> "application/json"
        "svg" -> "image/svg+xml"
        "woff" -> "font/woff"
        "woff2" -> "font/woff2"
        "ttf" -> "font/ttf"
        else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
            ?: "application/octet-stream"
    }
}

private fun textEncodingFor(assetPath: String): String? =
    when (assetPath.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
        "html", "htm", "css", "js", "mjs", "json", "map", "svg", "txt", "xml" -> "utf-8"
        else -> null
    }
