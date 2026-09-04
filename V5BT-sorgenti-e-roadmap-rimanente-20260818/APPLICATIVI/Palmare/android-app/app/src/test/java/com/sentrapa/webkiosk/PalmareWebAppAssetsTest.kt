package com.sentrapa.webkiosk

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
        assertEquals("https://192.168.0.67:5380/mobile/", DEFAULT_SERVER_URL)
        assertEquals(DEFAULT_SERVER_URL, resolveConfiguredKioskUrl(null, DEFAULT_SERVER_URL))
    }

    @Test
    fun preservesTheCurrentServerUrl() {
        val savedCurrent = "https://192.168.0.67:5380/mobile"
        assertEquals(
            savedCurrent,
            resolveConfiguredKioskUrl(savedCurrent, DEFAULT_SERVER_URL)
        )
    }

    /**
     * Questo caso esiste perche la sua assenza ha nascosto un difetto.
     *
     * L'indirizzo del Raspberry **in uso** era finito nella lista degli
     * indirizzi dismessi: l'URL configurato a mano funzionava per quella
     * sessione e a ogni riavvio veniva sostituito con il default, che puntava a
     * una rete non piu esistente. Il palmare risultava "backend non
     * raggiungibile" senza che nulla lo spiegasse.
     *
     * Il default qui e volutamente **un altro indirizzo**: se il server in uso
     * tornasse a essere trattato come dismesso, il risultato sarebbe quel
     * default e non l'URL salvato. Il caso precedente confrontava l'indirizzo
     * con un default identico, quindi passava senza provare niente.
     */
    @Test
    fun neverTreatsTheCurrentServerAsDismissed() {
        val altroDefault = "https://192.168.1.79:5380/mobile/"
        for (salvato in listOf(
            "https://192.168.0.67:5380/mobile/",
            "https://192.168.0.67:5380/mobile",
            "HTTPS://192.168.0.67:5380/Mobile/"
        )) {
            assertEquals(salvato, resolveConfiguredKioskUrl(salvato, altroDefault))
        }
    }

    @Test
    fun migratesThePreviousDotOneDefaultToTheCurrentServer() {
        assertEquals(
            DEFAULT_SERVER_URL,
            resolveConfiguredKioskUrl("https://192.168.1.182:5380/mobile", DEFAULT_SERVER_URL)
        )
    }
}
