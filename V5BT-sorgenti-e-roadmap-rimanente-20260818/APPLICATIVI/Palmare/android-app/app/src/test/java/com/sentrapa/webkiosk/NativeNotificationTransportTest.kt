package com.sentrapa.webkiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class NativeNotificationTransportTest {
    @Test
    fun httpsKioskUsesOnlyItsHttpsApiOrigin() {
        val candidates = resolveNotificationApiBaseCandidates("https://192.168.1.182:5380/mobile/")

        assertEquals(
            listOf("https://192.168.1.182:5380/api"),
            candidates
        )
        assertFalse(candidates.any { it.startsWith("http://") })
    }

    @Test
    fun explicitHttpConfigurationDoesNotAddAnotherFallback() {
        assertEquals(
            listOf("http://192.168.1.182:5381/api"),
            resolveNotificationApiBaseCandidates("http://192.168.1.182:5381/")
        )
    }

    @Test
    fun backgroundRadioUsesOnlyTheConfiguredOrigin() {
        assertEquals(
            listOf("https://192.168.1.182:5380/api"),
            resolveRadioApiBaseCandidates("https://192.168.1.182:5380/mobile/")
        )
        assertEquals(
            "wss://192.168.1.182:5380/api/radio/ws",
            buildRadioWebSocketUrl("https://192.168.1.182:5380/api")
        )
    }
}
