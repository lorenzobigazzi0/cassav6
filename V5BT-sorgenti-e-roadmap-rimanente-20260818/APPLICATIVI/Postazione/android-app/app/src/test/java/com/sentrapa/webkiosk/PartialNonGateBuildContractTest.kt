package com.sentrapa.webkiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI
import java.util.Base64

class PartialNonGateBuildContractTest {
    @Test
    fun `partial package is isolated and every certified bluetooth flag stays disabled`() {
        if (!BuildConfig.PARTIAL_NON_GATE_BUILD) {
            assertEquals("com.sentrapa.postazione.advanced", BuildConfig.APPLICATION_ID)
            assertFalse(BuildConfig.API31_COMPAT_NON_GATE_BUILD)
            return
        }

        if (BuildConfig.API31_COMPAT_NON_GATE_BUILD) return

        assertEquals(
            "com.sentrapa.postazione.advanced.partial",
            BuildConfig.APPLICATION_ID
        )
        assertTrue(BuildConfig.VERSION_NAME.endsWith("-partial"))
        assertEquals(
            "https://192.168.1.79:5380/postazione/",
            BuildConfig.DEFAULT_SERVER_URL
        )
        assertFalse(BuildConfig.BLUETOOTH_LAB_BUILD)
        assertFalse(BuildConfig.BLUETOOTH_DIAGNOSTICS_ENABLED)
        assertFalse(BuildConfig.BLUETOOTH_IDENTITY_ENABLED)
        assertFalse(BuildConfig.BLUETOOTH_DISCOVERY_ENABLED)
        assertFalse(BuildConfig.BLUETOOTH_FAILOVER_ENABLED)
        assertFalse(BuildConfig.BLUETOOTH_DIRECT_SERVER_ENABLED)
        assertFalse(BuildConfig.BLUETOOTH_PEER_LINK_ENABLED)
        assertFalse(BuildConfig.BLUETOOTH_GATT_CLIENT_ENABLED)
        assertFalse(BuildConfig.BLUETOOTH_HELLO_EXCHANGE_ENABLED)
        assertFalse(BuildConfig.BLUETOOTH_MUTUAL_AUTH_ENABLED)
        assertFalse(BuildConfig.BLUETOOTH_SESSION_KEY_ENABLED)
        assertFalse(BuildConfig.BLUETOOTH_HEARTBEAT_ENABLED)
        assertFalse(BuildConfig.BLUETOOTH_ENROLLMENT_ENABLED)
        assertFalse(BuildConfig.BLUETOOTH_DIAGNOSTIC_BADGE)
    }

    @Test
    fun `API31 compat is isolated enabled and permanently non-gate`() {
        if (!BuildConfig.API31_COMPAT_NON_GATE_BUILD) return

        assertTrue(BuildConfig.PARTIAL_NON_GATE_BUILD)
        assertEquals(
            "com.sentrapa.postazione.advanced.partial",
            BuildConfig.APPLICATION_ID
        )
        assertTrue(BuildConfig.VERSION_NAME.endsWith("-api31compat"))
        assertEquals(31, BuildConfig.BLUETOOTH_DISCOVERY_MIN_ANDROID_API)
        assertTrue(BuildConfig.DEFAULT_SERVER_URL.startsWith("https://"))
        assertTrue(BuildConfig.BLUETOOTH_LAB_BUILD)
        assertTrue(BuildConfig.BLUETOOTH_DIAGNOSTICS_ENABLED)
        assertTrue(BuildConfig.BLUETOOTH_IDENTITY_ENABLED)
        assertTrue(BuildConfig.BLUETOOTH_DISCOVERY_ENABLED)
        assertTrue(BuildConfig.BLUETOOTH_FAILOVER_ENABLED)
        assertTrue(BuildConfig.BLUETOOTH_GATT_CLIENT_ENABLED)
        assertTrue(BuildConfig.BLUETOOTH_HELLO_EXCHANGE_ENABLED)
        assertTrue(BuildConfig.BLUETOOTH_MUTUAL_AUTH_ENABLED)
        assertTrue(BuildConfig.BLUETOOTH_SESSION_KEY_ENABLED)
        assertTrue(BuildConfig.BLUETOOTH_HEARTBEAT_ENABLED)
        assertTrue(BuildConfig.BLUETOOTH_ENROLLMENT_ENABLED)
        assertTrue(BuildConfig.BLUETOOTH_DIAGNOSTIC_BADGE)
        assertTrue(BuildConfig.BLUETOOTH_DIRECT_SERVER_ENABLED)
        assertFalse(BuildConfig.BLUETOOTH_PEER_LINK_ENABLED)

        assertTrue(
            Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
                .matches(BuildConfig.BLUETOOTH_ENROLLMENT_ENDPOINT_ID)
        )
        val enrollmentUri = URI(BuildConfig.BLUETOOTH_ENROLLMENT_URL)
        assertEquals("https", enrollmentUri.scheme)
        assertEquals("/v2/enroll", enrollmentUri.path)
        assertEquals(null, enrollmentUri.userInfo)
        assertEquals(null, enrollmentUri.query)
        assertEquals(null, enrollmentUri.fragment)
        val pin = BuildConfig.BLUETOOTH_ENROLLMENT_SPKI_SHA256
        assertTrue(pin.startsWith("sha256/"))
        val pinBytes = Base64.getDecoder().decode(pin.removePrefix("sha256/"))
        assertEquals(32, pinBytes.size)
        assertFalse(pinBytes.all { it == 0.toByte() })
        assertEquals(
            pin.removePrefix("sha256/"),
            Base64.getEncoder().encodeToString(pinBytes)
        )
    }
}
