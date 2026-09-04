package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BleAdvertiserStartDeadlineV1Test {
    @Test
    fun `advertiser watchdog preserves both five second B9 loss budgets`() {
        assertTrue(
            BLUETOOTH_BACKEND_HEALTH_PROBE_INTERVAL_MS_V1 +
                BLUETOOTH_BACKEND_HEALTH_PROBE_TIMEOUT_MS_V1 +
                BluetoothDiscoveryPolicy.ADVERTISEMENT_HEALTH_REFRESH_MS +
                BluetoothDiscoveryPolicy.ADVERTISEMENT_UPDATE_MIN_INTERVAL_MS +
                BLUETOOTH_ADVERTISER_START_CALLBACK_TIMEOUT_MS_V1 <= 5_000L - 250L
        )
        assertTrue(
            BLUETOOTH_BACKEND_LINK_MAX_AGE_MS_V1 +
                BluetoothDiscoveryPolicy.ADVERTISEMENT_HEALTH_REFRESH_MS +
                BluetoothDiscoveryPolicy.ADVERTISEMENT_UPDATE_MIN_INTERVAL_MS +
                BLUETOOTH_ADVERTISER_START_CALLBACK_TIMEOUT_MS_V1 <= 5_000L - 250L
        )
    }

    @Test
    fun `advertiser becomes active only after the matching success callback`() {
        var now = 1_000L
        val schedule = FakeDeadlineSchedule()
        val deadline = deadline(now = { now }, schedule = schedule)

        val token = deadline.start()
        assertEquals(
            BluetoothAdvertiserStartPhaseV1.WAITING_CALLBACK,
            deadline.snapshot().phase
        )
        assertTrue(deadline.snapshot().deadlineActive)

        now += 100L
        assertTrue(deadline.started(token))
        assertEquals(BluetoothAdvertiserStartPhaseV1.ACTIVE, deadline.snapshot().phase)
        assertFalse(deadline.snapshot().deadlineActive)
        assertTrue(schedule.entries.single().cancelled)

        assertTrue(deadline.failed(token))
        assertEquals(BluetoothAdvertiserStartPhaseV1.CLOSED, deadline.snapshot().phase)
        assertFalse(deadline.failed(token))
    }

    @Test
    fun `missing framework callback expires once and closes the attempt`() {
        var now = 2_000L
        val schedule = FakeDeadlineSchedule()
        val fatal = mutableListOf<String>()
        val deadline = deadline(now = { now }, schedule = schedule, fatal = fatal)

        deadline.start()
        now += TIMEOUT_MS
        schedule.fireLatest()

        assertEquals(listOf("ADVERTISER_START_CALLBACK_TIMEOUT"), fatal)
        assertEquals(BluetoothAdvertiserStartPhaseV1.CLOSED, deadline.snapshot().phase)
        assertFalse(deadline.snapshot().deadlineActive)
        schedule.fireLatest(includeCancelled = true)
        assertEquals(1, fatal.size)
    }

    @Test
    fun `stale generation and late old timer cannot activate the replacement`() {
        var now = 3_000L
        val oldSchedule = FakeDeadlineSchedule()
        val oldFatal = mutableListOf<String>()
        val old = deadline(now = { now }, schedule = oldSchedule, fatal = oldFatal)
        val oldToken = old.start()
        old.close()

        val currentSchedule = FakeDeadlineSchedule()
        val currentFatal = mutableListOf<String>()
        val current = deadline(
            now = { now },
            schedule = currentSchedule,
            fatal = currentFatal
        )
        val currentToken = current.start()
        assertNotEquals(oldToken.generation, currentToken.generation)
        assertFalse(current.started(oldToken))

        now += TIMEOUT_MS
        oldSchedule.fireLatest(includeCancelled = true)
        assertTrue(oldFatal.isEmpty())
        assertTrue(currentFatal.isEmpty())
        assertEquals(
            BluetoothAdvertiserStartPhaseV1.WAITING_CALLBACK,
            current.snapshot().phase
        )
        assertThrows(BluetoothAdvertiserStartDeadlineExceptionV1::class.java) {
            current.started(currentToken)
        }
        assertEquals(BluetoothAdvertiserStartPhaseV1.CLOSED, current.snapshot().phase)
    }

    @Test
    fun `early scheduler callback rearms only for the remaining monotonic time`() {
        var now = 4_000L
        val schedule = FakeDeadlineSchedule()
        val fatal = mutableListOf<String>()
        val deadline = deadline(now = { now }, schedule = schedule, fatal = fatal)

        deadline.start()
        now += 400L
        schedule.fireLatest()
        assertEquals(listOf(TIMEOUT_MS, TIMEOUT_MS - 400L), schedule.delays)
        assertTrue(fatal.isEmpty())

        now = 4_000L + TIMEOUT_MS
        schedule.fireLatest()
        assertEquals(listOf("ADVERTISER_START_CALLBACK_TIMEOUT"), fatal)
        assertEquals(BluetoothAdvertiserStartPhaseV1.CLOSED, deadline.snapshot().phase)
    }

    @Test
    fun `monotonic clock regression is terminal`() {
        var now = 5_000L
        val schedule = FakeDeadlineSchedule()
        val deadline = deadline(now = { now }, schedule = schedule)
        val token = deadline.start()

        now -= 1L
        val failure = assertThrows(BluetoothAdvertiserStartDeadlineExceptionV1::class.java) {
            deadline.started(token)
        }
        assertEquals("CLOCK_REGRESSION", failure.code)
        assertEquals(BluetoothAdvertiserStartPhaseV1.CLOSED, deadline.snapshot().phase)
        assertFalse(deadline.snapshot().deadlineActive)
    }

    @Test
    fun `deadline scheduler rejection fails closed before advertising can start`() {
        val schedule = FakeDeadlineSchedule(reject = true)
        val deadline = deadline(now = { 6_000L }, schedule = schedule)

        val failure = assertThrows(BluetoothAdvertiserStartDeadlineExceptionV1::class.java) {
            deadline.start()
        }
        assertEquals("DEADLINE_SCHEDULE_FAILED", failure.code)
        assertEquals(BluetoothAdvertiserStartPhaseV1.CLOSED, deadline.snapshot().phase)
        assertFalse(deadline.snapshot().deadlineActive)
    }

    private fun deadline(
        now: () -> Long,
        schedule: FakeDeadlineSchedule,
        fatal: MutableList<String> = mutableListOf()
    ) = BluetoothAdvertiserStartDeadlineV1(
        timeoutMs = TIMEOUT_MS,
        deadlineSchedule = schedule,
        nowElapsedMs = now,
        onFatal = { fatal += it.code }
    )

    private class FakeDeadlineSchedule(
        private val reject: Boolean = false
    ) : BluetoothAdvertiserDeadlineScheduleV1 {
        data class Entry(
            val operation: () -> Unit,
            var cancelled: Boolean = false
        )

        val entries = mutableListOf<Entry>()
        val delays = mutableListOf<Long>()

        override fun schedule(delayMs: Long, operation: () -> Unit): AutoCloseable {
            if (reject) throw IllegalStateException("rejected")
            delays += delayMs
            val entry = Entry(operation)
            entries += entry
            return AutoCloseable { entry.cancelled = true }
        }

        fun fireLatest(includeCancelled: Boolean = false) {
            val entry = entries.last()
            if (!entry.cancelled || includeCancelled) entry.operation()
        }
    }

    companion object {
        private const val TIMEOUT_MS = 1_000L
    }
}
