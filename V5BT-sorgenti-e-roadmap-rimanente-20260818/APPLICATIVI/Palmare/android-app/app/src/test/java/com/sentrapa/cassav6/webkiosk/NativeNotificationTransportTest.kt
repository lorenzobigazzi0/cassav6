package com.sentrapa.cassav6.webkiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class NativeNotificationTransportTest {
    @Test
    fun httpsKioskUsesOnlyItsHttpsApiOrigin() {
        val candidates = resolveNotificationApiBaseCandidates("https://192.168.1.182:5480/mobile/")

        assertEquals(
            listOf("https://192.168.1.182:5480/api"),
            candidates
        )
        assertFalse(candidates.any { it.startsWith("http://") })
    }

    @Test
    fun explicitHttpConfigurationDoesNotAddAnotherFallback() {
        assertEquals(
            listOf("http://192.168.1.182:5481/api"),
            resolveNotificationApiBaseCandidates("http://192.168.1.182:5481/")
        )
    }

    @Test
    fun backgroundRadioUsesOnlyTheConfiguredOrigin() {
        assertEquals(
            listOf("https://192.168.1.182:5480/api"),
            resolveRadioApiBaseCandidates("https://192.168.1.182:5480/mobile/")
        )
        assertEquals(
            "wss://192.168.1.182:5480/api/radio/ws",
            buildRadioWebSocketUrl("https://192.168.1.182:5480/api")
        )
    }
}
