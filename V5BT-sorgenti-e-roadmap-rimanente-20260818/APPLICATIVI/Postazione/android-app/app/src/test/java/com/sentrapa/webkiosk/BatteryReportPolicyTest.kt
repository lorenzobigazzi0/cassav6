package com.sentrapa.webkiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BatteryReportPolicyTest {
    @Test
    fun `periodic battery reports use a two minute interval`() {
        assertEquals(120_000L, BatteryReportPolicy.INTERVAL_MS)
    }

    @Test
    fun `battery changes cannot report before the interval expires`() {
        assertFalse(
            BatteryReportPolicy.isPeriodicReportDue(
                nowMs = 120_000L,
                lastSentAtMs = 1L,
                lastAttemptAtMs = 0L
            )
        )
        assertTrue(
            BatteryReportPolicy.isPeriodicReportDue(
                nowMs = 120_001L,
                lastSentAtMs = 1L,
                lastAttemptAtMs = 0L
            )
        )
    }

    @Test
    fun `a failed attempt is also throttled for two minutes`() {
        assertFalse(
            BatteryReportPolicy.isPeriodicReportDue(
                nowMs = 219_999L,
                lastSentAtMs = 0L,
                lastAttemptAtMs = 100_000L
            )
        )
        assertTrue(
            BatteryReportPolicy.isPeriodicReportDue(
                nowMs = 220_000L,
                lastSentAtMs = 0L,
                lastAttemptAtMs = 100_000L
            )
        )
    }

    @Test
    fun `periodic scheduling waits only for the remaining interval`() {
        assertEquals(
            10L,
            BatteryReportPolicy.nextPeriodicDelayMs(
                nowMs = 120_000L,
                lastSentAtMs = 10L,
                lastAttemptAtMs = 0L
            )
        )
        assertEquals(
            BatteryReportPolicy.INTERVAL_MS,
            BatteryReportPolicy.nextPeriodicDelayMs(
                nowMs = 50_000L,
                lastSentAtMs = 0L,
                lastAttemptAtMs = 0L
            )
        )
    }

    @Test
    fun `successful delivery completion anchors the full next interval`() {
        val requestCompletedAtMs = 122_000L

        assertFalse(
            BatteryReportPolicy.isPeriodicReportDue(
                nowMs = requestCompletedAtMs + BatteryReportPolicy.INTERVAL_MS - 1L,
                lastSentAtMs = requestCompletedAtMs,
                lastAttemptAtMs = 120_000L
            )
        )
        assertTrue(
            BatteryReportPolicy.isPeriodicReportDue(
                nowMs = requestCompletedAtMs + BatteryReportPolicy.INTERVAL_MS,
                lastSentAtMs = requestCompletedAtMs,
                lastAttemptAtMs = 120_000L
            )
        )
    }

    @Test
    fun `API31 compatibility battery endpoint is derived only from an HTTPS portal`() {
        assertEquals(
            "http://192.168.1.79:8865/battery",
            BatteryReportEndpointPolicy.resolve(
                configuredPortalUrl = "https://192.168.1.79:5380/postazione/",
                requireHttpsPortal = true
            )
        )
        assertEquals(
            null,
            BatteryReportEndpointPolicy.resolve(
                configuredPortalUrl = "http://192.168.1.79:5380/postazione/",
                requireHttpsPortal = true
            )
        )
        assertEquals(
            null,
            BatteryReportEndpointPolicy.resolve(
                configuredPortalUrl = "https://user:secret@192.168.1.79:5380/postazione/",
                requireHttpsPortal = true
            )
        )
    }
}
