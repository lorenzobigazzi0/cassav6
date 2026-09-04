package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import okio.Buffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class AndroidBluetoothBackendHealthProbeV1Test {
    @Test
    fun `target is canonical HTTPS and stores only a session commitment`() {
        val token = "secret-bearer-token"
        val commitment = "ab".repeat(32)
        val first = BluetoothBackendHealthProbeTargetResolverV1.resolve(
            "https://192.168.1.79:5380/postazione/?ignored=no",
            commitment
        )
        assertNull(first)

        val accepted = checkNotNull(
            BluetoothBackendHealthProbeTargetResolverV1.resolve(
                "https://192.168.1.79:5380/postazione/",
                commitment
            )
        )
        assertEquals("https://192.168.1.79:5380/api/health", accepted.healthUrl)
        assertTrue(Regex("^[0-9a-f]{64}$").matches(accepted.sessionBindingCommitment))
        assertFalse(accepted.toString().contains(token))
        assertEquals(commitment, accepted.sessionBindingCommitment)
        assertNull(
            BluetoothBackendHealthProbeTargetResolverV1.resolve(
                "https://192.168.1.79:5380/postazione/",
                token
            )
        )
        assertNotEquals(token, accepted.sessionBindingCommitment)
    }

    @Test
    fun `HTTP credentials and arbitrary target commitments are rejected`() {
        assertNull(
            BluetoothBackendHealthProbeTargetResolverV1.resolve(
                "http://192.168.1.79:5380/postazione/",
                "binding"
            )
        )
        assertNull(
            BluetoothBackendHealthProbeTargetResolverV1.resolve(
                "https://user:pass@192.168.1.79:5380/postazione/",
                "binding"
            )
        )
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothBackendHealthProbeTargetV1(
                "https://example.com/api/health",
                "raw-token"
            )
        }
    }

    @Test
    fun `health response requires bounded JSON ok true and no redirect`() {
        assertTrue(
            BluetoothBackendHealthResponsePolicyV1.accepts(
                successful = true,
                redirect = false,
                contentType = "application/json; charset=utf-8",
                body = "{\"ok\":true}"
            )
        )
        for ((successful, redirect, type, body) in listOf(
            listOf(false, false, "application/json", "{\"ok\":true}"),
            listOf(true, true, "application/json", "{\"ok\":true}"),
            listOf(true, false, "text/html", "{\"ok\":true}"),
            listOf(true, false, "application/json", "{\"ok\":false}"),
            listOf(true, false, "application/json", "{\"ok\":\"true\"}"),
            listOf(true, false, "application/json", "not-json")
        )) {
            assertFalse(
                BluetoothBackendHealthResponsePolicyV1.accepts(
                    successful as Boolean,
                    redirect as Boolean,
                    type as String,
                    body as String
                )
            )
        }
        assertFalse(
            BluetoothBackendHealthResponsePolicyV1.accepts(
                true,
                false,
                "application/json",
                "x".repeat(BLUETOOTH_BACKEND_HEALTH_MAX_BODY_BYTES_V1 + 1)
            )
        )
    }

    @Test
    fun `bounded reader accepts short EOF and rejects oversized streams`() {
        val shortBody = Buffer().writeUtf8("{\"ok\":true}")
        assertEquals(
            "{\"ok\":true}",
            readBluetoothBackendHealthBodyBoundedV1(shortBody)?.toString(Charsets.UTF_8)
        )

        val oversized = Buffer().write(ByteArray(BLUETOOTH_BACKEND_HEALTH_MAX_BODY_BYTES_V1 + 1))
        assertNull(readBluetoothBackendHealthBodyBoundedV1(oversized))
    }

    @Test
    fun `probe timeout plus advertisement refresh stays within five seconds`() {
        assertTrue(
            BLUETOOTH_BACKEND_HEALTH_PROBE_INTERVAL_MS_V1 +
                BLUETOOTH_BACKEND_HEALTH_PROBE_TIMEOUT_MS_V1 +
                BluetoothDiscoveryPolicy.ADVERTISEMENT_HEALTH_REFRESH_MS +
                BluetoothDiscoveryPolicy.ADVERTISEMENT_UPDATE_MIN_INTERVAL_MS +
                BLUETOOTH_ADVERTISER_START_CALLBACK_TIMEOUT_MS_V1 <= 4_750L
        )
        assertTrue(
            BLUETOOTH_BACKEND_LINK_MAX_AGE_MS_V1 +
                BluetoothDiscoveryPolicy.ADVERTISEMENT_HEALTH_REFRESH_MS +
                BluetoothDiscoveryPolicy.ADVERTISEMENT_UPDATE_MIN_INTERVAL_MS +
                BLUETOOTH_ADVERTISER_START_CALLBACK_TIMEOUT_MS_V1 <= 4_750L
        )
    }

    @Test
    fun `battery gate reads once initially and once every two minutes`() {
        val gate = BluetoothBatterySampleGateV1()
        assertTrue(gate.claim(1_000L))
        assertFalse(gate.claim(1_001L))
        assertFalse(gate.claim(120_999L))
        assertTrue(gate.claim(121_000L))
        val failure = assertThrows(BluetoothDynamicRouteHealthExceptionV1::class.java) {
            gate.claim(120_999L)
        }
        assertEquals("CLOCK_REGRESSION", failure.code)
    }

    @Test
    fun `probe clock covers request start and rejects regressive completion`() {
        val clock = BluetoothBackendHealthProbeClockV1()
        clock.claim(epochMs = 2_000L, elapsedMs = 1_000L)
        val failure = assertThrows(BluetoothDynamicRouteHealthExceptionV1::class.java) {
            clock.claim(epochMs = 2_001L, elapsedMs = 999L)
        }
        assertEquals("CLOCK_REGRESSION", failure.code)
        assertThrows(BluetoothDynamicRouteHealthExceptionV1::class.java) {
            clock.claim(epochMs = 3_000L, elapsedMs = 3_000L)
        }
    }

    @Test
    fun `normal start close cancellation never reports a fatal error`() {
        val sampled = CountDownLatch(1)
        val fatalCount = AtomicInteger()
        val signals = BluetoothRouteHealthSignalStoreV1()
        val probe = AndroidBluetoothBackendHealthProbeV1(
            signals = signals,
            batteryPercentSource = {
                sampled.countDown()
                50.0
            },
            nowEpochMs = { 1_000L },
            elapsedRealtimeMs = { 1_000L },
            onFatal = { fatalCount.incrementAndGet() }
        )

        probe.start()
        assertTrue(sampled.await(2L, TimeUnit.SECONDS))
        val publicationDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2L)
        var battery = signals.snapshotSignals().battery
        while (battery == null && System.nanoTime() < publicationDeadline) {
            Thread.yield()
            battery = signals.snapshotSignals().battery
        }
        assertEquals(50.0, battery?.percent!!, 0.0)
        probe.close()
        Thread.sleep(50L)

        assertEquals(0, fatalCount.get())
    }
}
