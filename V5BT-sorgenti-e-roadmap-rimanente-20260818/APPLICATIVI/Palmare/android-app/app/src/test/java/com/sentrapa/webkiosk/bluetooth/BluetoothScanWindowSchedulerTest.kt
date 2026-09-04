package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothScanWindowSchedulerTest {
    @Test
    fun `stable scheduler follows absolute start and stop boundaries`() {
        val scheduler = BluetoothScanWindowScheduler(BluetoothScanProfile.STABLE, 0L)

        assertDecision(
            scheduler.evaluate(0L),
            scanning = true,
            command = BluetoothScanCommand.START,
            nextTransitionAtMs = 3_000L
        )
        assertDecision(
            scheduler.evaluate(3_000L),
            scanning = false,
            command = BluetoothScanCommand.STOP,
            nextTransitionAtMs = 30_000L
        )
        assertDecision(
            scheduler.evaluate(30_000L),
            scanning = true,
            command = BluetoothScanCommand.START,
            nextTransitionAtMs = 33_000L
        )
    }

    @Test
    fun `delayed callback at 31 seconds restarts across missed idle boundary`() {
        val scheduler = BluetoothScanWindowScheduler(BluetoothScanProfile.STABLE, 0L)
        scheduler.evaluate(0L)

        val decision = scheduler.evaluate(31_000L)

        assertTrue(decision.scanning)
        assertEquals(1L, decision.windowIndex)
        assertEquals(BluetoothScanCommand.RESTART, decision.command)
        assertEquals(30_000L, decision.windowStartAtMs)
        assertEquals(33_000L, decision.nextTransitionAtMs)
    }

    @Test
    fun `delayed callback across multiple periods still forces restart`() {
        val scheduler = BluetoothScanWindowScheduler(BluetoothScanProfile.STABLE, 0L)
        scheduler.evaluate(0L)

        val decision = scheduler.evaluate(91_000L)

        assertTrue(decision.scanning)
        assertEquals(3L, decision.windowIndex)
        assertEquals(BluetoothScanCommand.RESTART, decision.command)
        assertEquals(90_000L, decision.windowStartAtMs)
        assertEquals(93_000L, decision.nextTransitionAtMs)
    }

    @Test
    fun `delayed callback landing in idle stops the scanner`() {
        val scheduler = BluetoothScanWindowScheduler(BluetoothScanProfile.STABLE, 0L)
        scheduler.evaluate(0L)

        val decision = scheduler.evaluate(34_000L)

        assertFalse(decision.scanning)
        assertEquals(BluetoothScanCommand.STOP, decision.command)
        assertEquals(60_000L, decision.nextTransitionAtMs)
    }

    @Test
    fun `failover scheduler keeps eight second windows every ten seconds`() {
        val scheduler = BluetoothScanWindowScheduler(BluetoothScanProfile.FAILOVER, 100L)

        assertDecision(
            scheduler.evaluate(100L),
            scanning = true,
            command = BluetoothScanCommand.START,
            nextTransitionAtMs = 8_100L
        )
        assertDecision(
            scheduler.evaluate(8_100L),
            scanning = false,
            command = BluetoothScanCommand.STOP,
            nextTransitionAtMs = 10_100L
        )
        assertDecision(
            scheduler.evaluate(10_100L),
            scanning = true,
            command = BluetoothScanCommand.START,
            nextTransitionAtMs = 18_100L
        )
    }

    @Test
    fun `profile change is anchored at change time and restarts active scan`() {
        val scheduler = BluetoothScanWindowScheduler(BluetoothScanProfile.STABLE, 0L)
        scheduler.evaluate(0L)

        assertTrue(scheduler.setProfile(BluetoothScanProfile.FAILOVER, 1_000L))
        val decision = scheduler.evaluate(1_000L)

        assertEquals(BluetoothScanProfile.FAILOVER, decision.profile)
        assertEquals(BluetoothScanCommand.RESTART, decision.command)
        assertEquals(1_000L, decision.windowStartAtMs)
        assertEquals(9_000L, decision.nextTransitionAtMs)
        assertFalse(scheduler.setProfile(BluetoothScanProfile.FAILOVER, 2_000L))
    }

    @Test
    fun `scheduler rejects invalid or regressing monotonic clocks`() {
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothScanWindowScheduler(BluetoothScanProfile.STABLE, -1L)
        }
        val scheduler = BluetoothScanWindowScheduler(BluetoothScanProfile.STABLE, 10L)
        scheduler.evaluate(20L)
        assertThrows(IllegalArgumentException::class.java) {
            scheduler.evaluate(19L)
        }
    }

    private fun assertDecision(
        decision: BluetoothScanDecision,
        scanning: Boolean,
        command: BluetoothScanCommand,
        nextTransitionAtMs: Long
    ) {
        assertEquals(scanning, decision.scanning)
        assertEquals(command, decision.command)
        assertEquals(nextTransitionAtMs, decision.nextTransitionAtMs)
    }
}
