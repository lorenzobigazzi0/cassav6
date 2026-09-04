package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidGattReliableSetupDeadlineV1Test {
    @Test
    fun `missing DATA callback expires the single setup deadline`() {
        var now = 1_000L
        val schedule = FakeDeadlineSchedule()
        val fatal = mutableListOf<String>()
        val setup = setup(now = { now }, schedule = schedule, fatal = fatal)

        val token = setup.start()
        assertEquals(AndroidGattReliableSetupPhaseV1.DATA_WRITING, token.phase)
        now += TIMEOUT_MS
        schedule.fireLatest()

        assertEquals(listOf("RELIABLE_DATA_SUBSCRIBE_TIMEOUT"), fatal)
        assertEquals(AndroidGattReliableSetupPhaseV1.CLOSED, setup.snapshot().phase)
        assertFalse(setup.snapshot().deadlineActive)
    }

    @Test
    fun `missing ACK callback uses the original unextended deadline`() {
        var now = 2_000L
        val schedule = FakeDeadlineSchedule()
        val fatal = mutableListOf<String>()
        val setup = setup(now = { now }, schedule = schedule, fatal = fatal)

        val data = setup.start()
        now += 800
        val ack = setup.dataWritten(data)
        assertEquals(AndroidGattReliableSetupPhaseV1.ACK_WRITING, ack?.phase)
        assertEquals(TIMEOUT_MS, schedule.delays.single())

        now = 2_000L + TIMEOUT_MS
        schedule.fireLatest()
        assertEquals(listOf("RELIABLE_ACK_SUBSCRIBE_TIMEOUT"), fatal)
        assertEquals(AndroidGattReliableSetupPhaseV1.CLOSED, setup.snapshot().phase)
    }

    @Test
    fun `stale generation callbacks are ignored without touching current setup`() {
        var now = 3_000L
        val oldSchedule = FakeDeadlineSchedule()
        val oldFatal = mutableListOf<String>()
        val old = setup(now = { now }, schedule = oldSchedule, fatal = oldFatal)
        val oldData = old.start()
        old.close()

        val currentSchedule = FakeDeadlineSchedule()
        val currentFatal = mutableListOf<String>()
        val current = setup(now = { now }, schedule = currentSchedule, fatal = currentFatal)
        val currentData = current.start()
        assertTrue(oldData.generation != currentData.generation)

        assertNull(current.dataWritten(oldData))
        assertEquals(
            AndroidGattReliableSetupPhaseV1.DATA_WRITING,
            current.snapshot().phase
        )
        oldSchedule.fireLatest(includeCancelled = true)
        assertTrue(oldFatal.isEmpty())
        assertTrue(currentFatal.isEmpty())
        assertTrue(current.snapshot().deadlineActive)
        current.close()
    }

    @Test
    fun `port ready cancels deadline and late scheduled callback is inert`() {
        var now = 4_000L
        val schedule = FakeDeadlineSchedule()
        val fatal = mutableListOf<String>()
        val setup = setup(now = { now }, schedule = schedule, fatal = fatal)

        val data = setup.start()
        now += 100
        val ack = checkNotNull(setup.dataWritten(data))
        now += 100
        val port = checkNotNull(setup.ackWritten(ack))
        now += 100
        assertTrue(setup.portReady(port))
        assertEquals(AndroidGattReliableSetupPhaseV1.READY, setup.snapshot().phase)
        assertFalse(setup.snapshot().deadlineActive)

        now += TIMEOUT_MS
        schedule.fireLatest(includeCancelled = true)
        assertTrue(fatal.isEmpty())
        assertEquals(AndroidGattReliableSetupPhaseV1.READY, setup.snapshot().phase)
        setup.close()
    }

    private fun setup(
        now: () -> Long,
        schedule: FakeDeadlineSchedule,
        fatal: MutableList<String>
    ) = AndroidGattReliableSetupDeadlineV1(
        timeoutMs = TIMEOUT_MS,
        deadlineSchedule = schedule,
        nowElapsedMs = now,
        onFatal = { fatal += it.code }
    )

    private class FakeDeadlineSchedule : AndroidGattReliableDeadlineScheduleV1 {
        private data class Entry(
            val operation: () -> Unit,
            var cancelled: Boolean = false
        )

        private val entries = mutableListOf<Entry>()
        val delays = mutableListOf<Long>()

        override fun schedule(delayMs: Long, operation: () -> Unit): AutoCloseable {
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
        private const val TIMEOUT_MS = 5_000L
    }
}
