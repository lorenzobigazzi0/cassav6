package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothDynamicRouteHealthV1Test {
    @Test
    fun `unavailable backend publishes NONE while known failures preserve the link kind`() {
        val fixture = Fixture()

        assertEquals(
            BluetoothRouteKindV1.NONE,
            fixture.provider.snapshot(1_000L).routeKind
        )
        fixture.signals.unreachable(fixture.linkSession, 1_100L, 1_100L)
        fixture.elapsed = 1_100L

        val failed = fixture.provider.snapshot(1_100L)
        assertFalse(failed.canReachServer)
        assertEquals(BluetoothRouteKindV1.WIFI, failed.routeKind)
        assertNull(failed.serverRttMs)
        assertEquals(1_100L, failed.lastRouteChangeAtEpochMs)

        fixture.signals.close(fixture.linkSession, 1_200L, 1_200L)
        fixture.elapsed = 1_200L
        val unavailable = fixture.provider.snapshot(1_200L)
        assertFalse(unavailable.canReachServer)
        assertEquals(BluetoothRouteKindV1.NONE, unavailable.routeKind)
    }

    @Test
    fun `reachable transitions expose RTT and keep route change monotonic`() {
        val fixture = Fixture()
        fixture.provider.snapshot(1_000L)
        fixture.signals.reachable(fixture.linkSession, 42.5, 1_250L, 1_250L)
        fixture.elapsed = 1_250L

        val reachable = fixture.provider.snapshot(1_250L)
        assertTrue(reachable.canReachServer)
        assertEquals(BluetoothRouteKindV1.WIFI, reachable.routeKind)
        assertEquals(42.5, reachable.serverRttMs!!, 0.0)
        assertEquals(1_250L, reachable.lastRouteChangeAtEpochMs)
        assertEquals(2, serverRttBucketV1(reachable.serverRttMs))

        fixture.signals.reachable(fixture.linkSession, 250.0, 2_000L, 2_000L)
        fixture.elapsed = 2_000L
        val sameRoute = fixture.provider.snapshot(2_000L)
        assertEquals(1_250L, sameRoute.lastRouteChangeAtEpochMs)
        assertEquals(4, serverRttBucketV1(sameRoute.serverRttMs))
    }

    @Test
    fun `silent backend expires in five seconds and cannot remain reachable`() {
        val fixture = Fixture()
        fixture.signals.reachable(fixture.linkSession, 20.0, 1_000L, 1_000L)
        fixture.elapsed = 3_500L
        assertTrue(fixture.provider.snapshot(3_500L).canReachServer)

        fixture.elapsed = 3_501L
        val stale = fixture.provider.snapshot(3_501L)
        assertFalse(stale.canReachServer)
        assertEquals(BluetoothRouteKindV1.NONE, stale.routeKind)
    }

    @Test
    fun `battery samples are accepted at two minute cadence and later expire`() {
        val fixture = Fixture()
        assertTrue(fixture.signals.observe(81.0, 1_000L, 1_000L))
        assertFalse(fixture.signals.observe(50.0, 2_000L, 2_000L))
        fixture.elapsed = 2_000L
        assertEquals(81.0, fixture.provider.snapshot(2_000L).batteryPercent!!, 0.0)

        val next = 1_000L + BLUETOOTH_BATTERY_SAMPLE_INTERVAL_MS_V1
        assertTrue(fixture.signals.observe(50.0, next, next))
        fixture.elapsed = next
        assertEquals(50.0, fixture.provider.snapshot(next).batteryPercent!!, 0.0)

        fixture.elapsed = next + BLUETOOTH_BATTERY_SAMPLE_MAX_AGE_MS_V1 + 1L
        assertNull(
            fixture.provider.snapshot(
                next + BLUETOOTH_BATTERY_SAMPLE_MAX_AGE_MS_V1 + 1L
            ).batteryPercent
        )
    }

    @Test
    fun `queue depth is sampled from the durable store boundary`() {
        val fixture = Fixture()
        fixture.queueDepth = 7L
        assertEquals(7L, fixture.provider.snapshot(1_000L).queueDepth)
        fixture.queueDepth = 9L
        fixture.elapsed = 1_500L
        assertEquals(7L, fixture.provider.snapshot(1_500L).queueDepth)
        fixture.elapsed = 2_000L
        assertEquals(9L, fixture.provider.snapshot(2_000L).queueDepth)
    }

    @Test
    fun `route classifier publishes only wifi ethernet or usb`() {
        assertEquals(
            BluetoothRouteKindV1.WIFI,
            BluetoothRouteKindClassifierV1.classify(
                wifi = true,
                ethernet = false,
                usb = false
            )
        )
        assertEquals(
            BluetoothRouteKindV1.LAN,
            BluetoothRouteKindClassifierV1.classify(
                wifi = false,
                ethernet = true,
                usb = false
            )
        )
        assertEquals(
            BluetoothRouteKindV1.LAN,
            BluetoothRouteKindClassifierV1.classify(
                wifi = false,
                ethernet = false,
                usb = true
            )
        )
        assertEquals(
            BluetoothRouteKindV1.NONE,
            BluetoothRouteKindClassifierV1.classify(false, false, false)
        )
    }

    @Test
    fun `epoch and monotonic clock regressions fail closed`() {
        val fixture = Fixture()
        fixture.provider.snapshot(2_000L)
        fixture.elapsed = 2_100L
        val epoch = assertThrows(BluetoothDynamicRouteHealthExceptionV1::class.java) {
            fixture.provider.snapshot(1_999L)
        }
        assertEquals("CLOCK_REGRESSION", epoch.code)

        val second = Fixture()
        second.elapsed = 2_000L
        second.provider.snapshot(2_000L)
        second.elapsed = 1_999L
        val monotonic = assertThrows(BluetoothDynamicRouteHealthExceptionV1::class.java) {
            second.provider.snapshot(2_001L)
        }
        assertEquals("CLOCK_REGRESSION", monotonic.code)

        second.elapsed = 3_000L
        val latched = assertThrows(BluetoothDynamicRouteHealthExceptionV1::class.java) {
            second.provider.currentServerReachable()
        }
        assertEquals("CLOCK_REGRESSION", latched.code)
    }

    @Test
    fun `signal store rejects stale results from an earlier request generation`() {
        val signals = BluetoothRouteHealthSignalStoreV1()
        val session = signals.open(1_000L, 1_000L)
        assertTrue(signals.reachable(session, 10.0, 2_000L, 2_000L))
        assertFalse(signals.unreachable(session, 1_999L, 1_999L))
        assertNull(signals.snapshotSignals().backend)
        assertThrows(BluetoothDynamicRouteHealthExceptionV1::class.java) {
            signals.open(1_999L, 1_999L)
        }
    }

    @Test
    fun `rebound signal session ignores old completion without clearing current state`() {
        val signals = BluetoothRouteHealthSignalStoreV1()
        val first = signals.open(1_000L, 1_000L)
        val second = signals.open(1_001L, 1_001L)
        assertTrue(signals.reachable(second, 10.0, 1_002L, 1_002L))
        assertFalse(signals.unreachable(first, 1_003L, 1_003L))

        val current = signals.snapshotSignals().backend
        assertEquals(BluetoothBackendLinkStateV1.REACHABLE, current?.state)
        assertEquals(1_002L, current?.observedAtElapsedRealtimeMs)
    }

    private class Fixture {
        val signals = BluetoothRouteHealthSignalStoreV1()
        val linkSession = signals.open(0L, 0L)
        var elapsed = 1_000L
        var routeKind = BluetoothRouteKindV1.WIFI
        var queueDepth = 0L
        val provider = DynamicBluetoothRouteHealthProviderV1(
            signalSource = signals,
            routeKindSource = { routeKind },
            queueDepthSource = { queueDepth },
            elapsedRealtimeMs = { elapsed }
        )
    }
}
