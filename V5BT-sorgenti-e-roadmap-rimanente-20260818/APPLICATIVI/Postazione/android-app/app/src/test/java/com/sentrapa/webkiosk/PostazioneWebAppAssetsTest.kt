package com.sentrapa.webkiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PostazioneWebAppAssetsTest {
    @Test
    fun mapsPostazioneRootAndAssets() {
        assertEquals("postazione/index.html", resolveBundledAssetPath("/postazione/"))
        assertEquals(
            "postazione/assets/index-123.js",
            resolveBundledAssetPath("/postazione/assets/index-123.js")
        )
    }

    @Test
    fun mapsClientRoutesToTheSpaEntryPoint() {
        assertEquals("postazione/index.html", resolveBundledAssetPath("/postazione/orders"))
    }

    @Test
    fun rejectsOutsideAndTraversalPaths() {
        assertNull(resolveBundledAssetPath("/api/health"))
        assertNull(resolveBundledAssetPath("/postazione/../secrets.txt"))
        assertNull(resolveBundledAssetPath("/postazione/%2e%2e/secrets.txt"))
    }

    @Test
    fun matchesSchemeHostAndPort() {
        val configured = "https://192.168.0.28:5280/postazione/"
        assertTrue(isConfiguredOrigin("https://192.168.0.28:5280/postazione/", configured))
        assertTrue(isConfiguredOrigin("https://192.168.0.28:5280/postazione/assets/a.js", configured))
        assertFalse(isConfiguredOrigin("http://192.168.0.28:5280/postazione/", configured))
        assertFalse(isConfiguredOrigin("https://192.168.0.28:5281/postazione/", configured))
    }

    @Test
    fun migratesOnlyKnownLegacyServerUrls() {
        val current = DEFAULT_SERVER_URL
        val legacyUrls = listOf(
            "https://192.168.1.79:5280/postazione",
            "https://192.168.1.79:5380/postazione/",
            "https://192.168.1.182:5280/postazione",
            "https://192.168.1.182:5380/postazione/"
        )
        legacyUrls.forEach { legacy ->
            assertEquals(current, resolveConfiguredKioskUrl(legacy, current))
        }
        assertEquals(
            "https://10.0.0.15:5280/postazione/",
            resolveConfiguredKioskUrl("https://10.0.0.15:5280/postazione/", current)
        )
        assertEquals(current, resolveConfiguredKioskUrl(null, current))
        assertTrue(current.startsWith("https://"))
        assertTrue(current.endsWith("/postazione/"))
    }
}
