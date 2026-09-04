package com.sentrapa.webkiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NativeBatteryPolicyTest {
    @Test
    fun `normalizes the Android battery scale to a percentage`() {
        assertEquals(50, NativeBatteryPolicy.percentage(level = 25, scale = 50))
        assertEquals(100, NativeBatteryPolicy.percentage(level = 120, scale = 100))
        assertEquals(0, NativeBatteryPolicy.percentage(level = 0, scale = 100))
    }

    @Test
    fun `rejects missing Android battery values`() {
        assertNull(NativeBatteryPolicy.percentage(level = -1, scale = 100))
        assertNull(NativeBatteryPolicy.percentage(level = 20, scale = 0))
    }

    @Test
    fun `server heartbeat is fixed to two minutes`() {
        assertEquals(120_000L, BatteryHeartbeatPolicy.INTERVAL_MS)
    }

    @Test
    fun `server heartbeat resolves only the configured kiosk host`() {
        assertEquals(
            "192.168.0.28",
            BatteryHeartbeatPolicy.resolveHost("https://192.168.0.28:5280/mobile/")
        )
        assertNull(BatteryHeartbeatPolicy.resolveHost(null))
        assertNull(BatteryHeartbeatPolicy.resolveHost(""))
    }
}
