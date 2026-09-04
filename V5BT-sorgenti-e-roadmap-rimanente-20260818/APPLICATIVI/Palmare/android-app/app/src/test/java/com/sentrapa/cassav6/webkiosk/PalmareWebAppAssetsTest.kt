package com.sentrapa.cassav6.webkiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PalmareWebAppAssetsTest {
    @Test
    fun mapsMobileRootAndAssets() {
        assertEquals("mobile/index.html", resolveBundledAssetPath("/mobile/"))
        assertEquals(
            "mobile/assets/index-123.js",
            resolveBundledAssetPath("/mobile/assets/index-123.js")
        )
    }

    @Test
    fun mapsClientRoutesToTheSpaEntryPoint() {
        assertEquals("mobile/index.html", resolveBundledAssetPath("/mobile/tables"))
    }

    @Test
    fun rejectsOutsideAndTraversalPaths() {
        assertNull(resolveBundledAssetPath("/api/health"))
        assertNull(resolveBundledAssetPath("/mobile/../secrets.txt"))
        assertNull(resolveBundledAssetPath("/mobile/%2e%2e/secrets.txt"))
    }

    @Test
    fun matchesSchemeHostAndPort() {
        val configured = "https://192.168.0.28:5280/mobile/"
        assertTrue(isConfiguredOrigin("https://192.168.0.28:5280/mobile/", configured))
        assertTrue(isConfiguredOrigin("https://192.168.0.28:5280/mobile/assets/a.js", configured))
        assertFalse(isConfiguredOrigin("http://192.168.0.28:5280/mobile/", configured))
        assertFalse(isConfiguredOrigin("https://192.168.0.28:5281/mobile/", configured))
    }

    @Test
    fun preservesEveryExplicitlyConfiguredServerUrl() {
        val current = "https://192.168.0.28:5280/mobile/"
        assertEquals(
            "https://192.168.1.182:5280/mobile",
            resolveConfiguredKioskUrl("https://192.168.1.182:5280/mobile", current)
        )
        assertEquals(
            "https://10.0.0.15:5280/mobile/",
            resolveConfiguredKioskUrl("https://10.0.0.15:5280/mobile/", current)
        )
        assertEquals(current, resolveConfiguredKioskUrl(null, current))
    }

    @Test
    fun usesTheCurrentServerAsDefault() {
        assertEquals("https://192.168.1.79:5480/mobile/", DEFAULT_SERVER_URL)
        assertEquals(DEFAULT_SERVER_URL, resolveConfiguredKioskUrl(null, DEFAULT_SERVER_URL))
    }

    @Test
    fun preservesTheCurrentServerUrl() {
        val savedCurrent = "https://192.168.1.79:5480/mobile"
        assertEquals(
            savedCurrent,
            resolveConfiguredKioskUrl(savedCurrent, DEFAULT_SERVER_URL)
        )
    }

    @Test
    fun migratesThePreviousDotZeroDefaultToTheCurrentServer() {
        assertEquals(
            DEFAULT_SERVER_URL,
            resolveConfiguredKioskUrl("https://192.168.0.67:5480/mobile/", DEFAULT_SERVER_URL)
        )
    }

    @Test
    fun migratesThePreviousDotOneDefaultToTheCurrentServer() {
        assertEquals(
            DEFAULT_SERVER_URL,
            resolveConfiguredKioskUrl("https://192.168.1.182:5480/mobile", DEFAULT_SERVER_URL)
        )
    }
}
