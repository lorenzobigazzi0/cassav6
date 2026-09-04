package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothAdvertisingHysteresisTest {
    @Test
    fun `post rejection distinguishes clean abort from active failure`() {
        assertEquals(
            AdvertisingDowngradeScheduleResult.ACCEPTED,
            classifyAdvertisingDowngradePost(
                posted = true,
                radioActive = true,
                closed = false
            )
        )
        assertEquals(
            AdvertisingDowngradeScheduleResult.FAILED,
            classifyAdvertisingDowngradePost(
                posted = false,
                radioActive = true,
                closed = false
            )
        )
        assertEquals(
            AdvertisingDowngradeScheduleResult.ABORTED,
            classifyAdvertisingDowngradePost(
                posted = false,
                radioActive = true,
                closed = true
            )
        )
        assertEquals(
            AdvertisingDowngradeScheduleResult.ABORTED,
            classifyAdvertisingDowngradePost(
                posted = false,
                radioActive = false,
                closed = false
            )
        )
    }

    @Test
    fun `timer slot rejects a second post and stale release cannot clear it`() {
        val slot = BluetoothAdvertisingTimerSlot()
        val first = Runnable {}
        val second = Runnable {}

        assertTrue(slot.reserve(first))
        assertFalse(slot.reserve(second))
        assertTrue(slot.releaseIfCurrent(first))
        assertTrue(slot.reserve(second))
        assertFalse(slot.releaseIfCurrent(first))
        assertTrue(slot.hasPending())
        assertSame(second, slot.cancel())
        assertFalse(slot.hasPending())
    }

    @Test
    fun `downgrade happens exactly at the grace boundary and only once`() {
        val hysteresis = BluetoothAdvertisingHysteresis(graceMs = 8_000L)
        val started = hysteresis.start(100L)
        assertEquals(
            BluetoothAdvertisingHysteresisAction.APPLY_LOW_LATENCY,
            started.action
        )

        val armed = hysteresis.onAcceptedObservation(1_000L)
        assertEquals(9_000L, armed.downgradeAtMs)
        val early = hysteresis.onDowngradeTimer(armed.generation, 8_999L)
        assertEquals(BluetoothAdvertisingHysteresisAction.NONE, early.action)
        assertEquals(9_000L, early.downgradeAtMs)

        val boundary = hysteresis.onDowngradeTimer(armed.generation, 9_000L)
        assertEquals(
            BluetoothAdvertisingHysteresisAction.APPLY_BALANCED,
            boundary.action
        )
        assertEquals(BluetoothAdvertiseMode.BALANCED, boundary.mode)
        assertNull(boundary.downgradeAtMs)
        assertEquals(
            BluetoothAdvertisingHysteresisAction.NONE,
            hysteresis.onDowngradeTimer(armed.generation, 9_001L).action
        )
    }

    @Test
    fun `duplicates and updates never extend or rearm the grace period`() {
        val hysteresis = BluetoothAdvertisingHysteresis(graceMs = 8_000L)
        hysteresis.start(0L)
        val first = hysteresis.onAcceptedObservation(1_000L)

        val duplicate = hysteresis.onAcceptedObservation(5_000L)
        assertEquals(first.generation, duplicate.generation)
        assertEquals(9_000L, duplicate.downgradeAtMs)

        hysteresis.onDowngradeTimer(first.generation, 9_000L)
        val update = hysteresis.onAcceptedObservation(10_000L)
        assertEquals(BluetoothAdvertiseMode.BALANCED, update.mode)
        assertNull(update.downgradeAtMs)
    }

    @Test
    fun `failover before the deadline cancels it and rejects its stale timer`() {
        val hysteresis = BluetoothAdvertisingHysteresis(graceMs = 8_000L)
        hysteresis.start(0L)
        val armed = hysteresis.onAcceptedObservation(100L)

        val failover = hysteresis.enterFailover(200L)
        assertNotEquals(armed.generation, failover.generation)
        assertEquals(BluetoothAdvertiseMode.LOW_LATENCY, failover.mode)
        assertNull(failover.downgradeAtMs)
        assertEquals(
            BluetoothAdvertisingHysteresisAction.NONE,
            hysteresis.onDowngradeTimer(armed.generation, 8_100L).action
        )
        assertEquals(
            BluetoothAdvertiseMode.LOW_LATENCY,
            hysteresis.snapshot().mode
        )
        val rearmed = hysteresis.onAcceptedObservation(8_200L)
        assertEquals(16_200L, rearmed.downgradeAtMs)
    }

    @Test
    fun `failover after downgrade requests low latency exactly once`() {
        val hysteresis = BluetoothAdvertisingHysteresis(graceMs = 8_000L)
        hysteresis.start(0L)
        val armed = hysteresis.onAcceptedObservation(100L)
        hysteresis.onDowngradeTimer(armed.generation, 8_100L)

        val failover = hysteresis.enterFailover(8_200L)
        assertEquals(
            BluetoothAdvertisingHysteresisAction.APPLY_LOW_LATENCY,
            failover.action
        )
        assertEquals(BluetoothAdvertiseMode.LOW_LATENCY, failover.mode)
        assertEquals(
            BluetoothAdvertisingHysteresisAction.NONE,
            hysteresis.enterFailover(8_201L).action
        )
    }

    @Test
    fun `stop and restart invalidate timers from the old lifecycle`() {
        val hysteresis = BluetoothAdvertisingHysteresis(graceMs = 8_000L)
        hysteresis.start(0L)
        val old = hysteresis.onAcceptedObservation(100L)
        hysteresis.stop()

        val restarted = hysteresis.start(9_000L)
        assertNotEquals(old.generation, restarted.generation)
        assertEquals(
            BluetoothAdvertisingHysteresisAction.NONE,
            hysteresis.onDowngradeTimer(old.generation, 9_001L).action
        )
        assertEquals(BluetoothAdvertiseMode.LOW_LATENCY, hysteresis.snapshot().mode)
        assertNull(hysteresis.snapshot().downgradeAtMs)
    }

    @Test
    fun `invalid grace clocks and deadline overflow are rejected`() {
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothAdvertisingHysteresis(graceMs = 0L)
        }
        val hysteresis = BluetoothAdvertisingHysteresis(graceMs = 8_000L)
        hysteresis.start(100L)
        assertThrows(IllegalArgumentException::class.java) {
            hysteresis.onAcceptedObservation(99L)
        }

        val overflow = BluetoothAdvertisingHysteresis(graceMs = 8_000L)
        overflow.start(Long.MAX_VALUE - 1L)
        assertThrows(IllegalArgumentException::class.java) {
            overflow.onAcceptedObservation(Long.MAX_VALUE - 1L)
        }
    }
}
