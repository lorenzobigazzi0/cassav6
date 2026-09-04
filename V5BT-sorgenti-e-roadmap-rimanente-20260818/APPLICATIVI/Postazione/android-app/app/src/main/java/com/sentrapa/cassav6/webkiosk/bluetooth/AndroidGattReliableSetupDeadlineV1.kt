package com.sentrapa.cassav6.webkiosk.bluetooth

import android.os.SystemClock
import java.util.concurrent.atomic.AtomicLong

enum class AndroidGattReliableSetupPhaseV1 {
    NEW,
    DATA_WRITING,
    ACK_WRITING,
    PORT_ACTIVATING,
    READY,
    CLOSED
}

data class AndroidGattReliableSetupTokenV1(
    val generation: Long,
    val phase: AndroidGattReliableSetupPhaseV1
)

data class AndroidGattReliableSetupDeadlineSnapshotV1(
    val phase: AndroidGattReliableSetupPhaseV1,
    val deadlineActive: Boolean,
    val closed: Boolean
)

class AndroidGattReliableSetupDeadlineExceptionV1(
    val code: String,
    message: String
) : RuntimeException(message)

private object AndroidGattReliableSetupGenerationV1 {
    private val next = AtomicLong(1)

    fun allocate(): Long {
        while (true) {
            val current = next.get()
            if (current <= 0 || current == Long.MAX_VALUE) {
                throw IllegalStateException("reliable GATT setup generation exhausted")
            }
            if (next.compareAndSet(current, current + 1)) return current
        }
    }
}

class AndroidGattReliableSetupDeadlineV1(
    private val timeoutMs: Long = 5_000,
    private val deadlineSchedule: AndroidGattReliableDeadlineScheduleV1 =
        AndroidHandlerGattReliableDeadlineScheduleV1(),
    private val nowElapsedMs: () -> Long = SystemClock::elapsedRealtime,
    private val onFatal: (AndroidGattReliableSetupDeadlineExceptionV1) -> Unit = {}
) : AutoCloseable {
    private val generation = AndroidGattReliableSetupGenerationV1.allocate()
    private var phase = AndroidGattReliableSetupPhaseV1.NEW
    private var deadlineElapsedMs: Long? = null
    private var deadlineHandle: AutoCloseable? = null
    private var lastClockMs = -1L

    init {
        require(timeoutMs in 1_000..10_000) {
            "reliable GATT setup timeout is out of range"
        }
    }

    @Synchronized
    fun start(): AndroidGattReliableSetupTokenV1 {
        if (phase != AndroidGattReliableSetupPhaseV1.NEW) {
            terminate(
                "RELIABLE_SETUP_ALREADY_STARTED",
                "reliable GATT setup deadline has already started"
            )
        }
        val current = checkedNow()
        if (current > Long.MAX_VALUE - timeoutMs) {
            terminate("CLOCK_OVERFLOW", "reliable GATT setup deadline overflowed")
        }
        deadlineElapsedMs = current + timeoutMs
        phase = AndroidGattReliableSetupPhaseV1.DATA_WRITING
        armDeadline(timeoutMs)
        return token(AndroidGattReliableSetupPhaseV1.DATA_WRITING)
    }

    @Synchronized
    fun dataWritten(
        setupToken: AndroidGattReliableSetupTokenV1
    ): AndroidGattReliableSetupTokenV1? {
        if (isStale(setupToken)) return null
        validate(setupToken, AndroidGattReliableSetupPhaseV1.DATA_WRITING)
        assertBeforeDeadline()
        phase = AndroidGattReliableSetupPhaseV1.ACK_WRITING
        return token(AndroidGattReliableSetupPhaseV1.ACK_WRITING)
    }

    @Synchronized
    fun ackWritten(
        setupToken: AndroidGattReliableSetupTokenV1
    ): AndroidGattReliableSetupTokenV1? {
        if (isStale(setupToken)) return null
        validate(setupToken, AndroidGattReliableSetupPhaseV1.ACK_WRITING)
        assertBeforeDeadline()
        phase = AndroidGattReliableSetupPhaseV1.PORT_ACTIVATING
        return token(AndroidGattReliableSetupPhaseV1.PORT_ACTIVATING)
    }

    @Synchronized
    fun portReady(setupToken: AndroidGattReliableSetupTokenV1): Boolean {
        if (isStale(setupToken)) return false
        validate(setupToken, AndroidGattReliableSetupPhaseV1.PORT_ACTIVATING)
        assertBeforeDeadline()
        phase = AndroidGattReliableSetupPhaseV1.READY
        deadlineElapsedMs = null
        cancelDeadline()
        return true
    }

    @Synchronized
    fun tick() {
        if (phase in setOf(
                AndroidGattReliableSetupPhaseV1.NEW,
                AndroidGattReliableSetupPhaseV1.READY,
                AndroidGattReliableSetupPhaseV1.CLOSED
            )
        ) return
        assertBeforeDeadline()
    }

    @Synchronized
    fun snapshot(): AndroidGattReliableSetupDeadlineSnapshotV1 =
        AndroidGattReliableSetupDeadlineSnapshotV1(
            phase = phase,
            deadlineActive = deadlineHandle != null,
            closed = phase == AndroidGattReliableSetupPhaseV1.CLOSED
        )

    @Synchronized
    override fun close() {
        if (phase == AndroidGattReliableSetupPhaseV1.CLOSED) return
        phase = AndroidGattReliableSetupPhaseV1.CLOSED
        deadlineElapsedMs = null
        cancelDeadline()
    }

    private fun token(
        expectedPhase: AndroidGattReliableSetupPhaseV1
    ) = AndroidGattReliableSetupTokenV1(generation, expectedPhase)

    private fun isStale(setupToken: AndroidGattReliableSetupTokenV1): Boolean =
        setupToken.generation != generation ||
            phase == AndroidGattReliableSetupPhaseV1.READY ||
            phase == AndroidGattReliableSetupPhaseV1.CLOSED

    private fun validate(
        setupToken: AndroidGattReliableSetupTokenV1,
        expectedPhase: AndroidGattReliableSetupPhaseV1
    ) {
        if (setupToken.phase != expectedPhase || phase != expectedPhase) {
            terminate(
                "RELIABLE_SETUP_CALLBACK_MISMATCH",
                "reliable GATT setup callback does not match the active phase"
            )
        }
    }

    private fun assertBeforeDeadline() {
        val current = checkedNow()
        val deadline = deadlineElapsedMs
            ?: terminate(
                "RELIABLE_SETUP_DEADLINE_MISSING",
                "reliable GATT setup deadline is missing"
            )
        if (current >= deadline) {
            terminate(timeoutCode(), "reliable GATT setup timed out")
        }
    }

    private fun checkedNow(): Long {
        val current = nowElapsedMs()
        if (current < 0 || current < lastClockMs) {
            terminate(
                "CLOCK_REGRESSION",
                "reliable GATT setup monotonic clock moved backwards"
            )
        }
        lastClockMs = current
        return current
    }

    private fun armDeadline(delayMs: Long) {
        cancelDeadline()
        deadlineHandle = try {
            deadlineSchedule.schedule(delayMs) { handleDeadline(generation) }
        } catch (_: Exception) {
            terminate(
                "DEADLINE_SCHEDULE_FAILED",
                "reliable GATT setup deadline could not be scheduled"
            )
        }
    }

    private fun handleDeadline(expectedGeneration: Long) {
        var failure: AndroidGattReliableSetupDeadlineExceptionV1? = null
        synchronized(this) {
            if (
                expectedGeneration != generation ||
                phase in setOf(
                    AndroidGattReliableSetupPhaseV1.NEW,
                    AndroidGattReliableSetupPhaseV1.READY,
                    AndroidGattReliableSetupPhaseV1.CLOSED
                )
            ) return
            val current = nowElapsedMs()
            if (current < 0 || current < lastClockMs) {
                failure = terminateWithoutThrow(
                    "CLOCK_REGRESSION",
                    "reliable GATT setup monotonic clock moved backwards"
                )
            } else {
                lastClockMs = current
                val deadline = deadlineElapsedMs
                if (deadline == null) {
                    failure = terminateWithoutThrow(
                        "RELIABLE_SETUP_DEADLINE_MISSING",
                        "reliable GATT setup deadline is missing"
                    )
                } else if (current >= deadline) {
                    failure = terminateWithoutThrow(
                        timeoutCode(),
                        "reliable GATT setup timed out"
                    )
                } else {
                    try {
                        armDeadline(deadline - current)
                    } catch (error: AndroidGattReliableSetupDeadlineExceptionV1) {
                        failure = error
                    }
                }
            }
        }
        failure?.let { runCatching { onFatal(it) } }
    }

    private fun timeoutCode(): String = when (phase) {
        AndroidGattReliableSetupPhaseV1.DATA_WRITING ->
            "RELIABLE_DATA_SUBSCRIBE_TIMEOUT"
        AndroidGattReliableSetupPhaseV1.ACK_WRITING ->
            "RELIABLE_ACK_SUBSCRIBE_TIMEOUT"
        AndroidGattReliableSetupPhaseV1.PORT_ACTIVATING ->
            "RELIABLE_PORT_READY_TIMEOUT"
        else -> "RELIABLE_SETUP_TIMEOUT"
    }

    private fun cancelDeadline() {
        runCatching { deadlineHandle?.close() }
        deadlineHandle = null
    }

    private fun terminate(code: String, message: String): Nothing {
        throw terminateWithoutThrow(code, message)
    }

    private fun terminateWithoutThrow(
        code: String,
        message: String
    ): AndroidGattReliableSetupDeadlineExceptionV1 {
        phase = AndroidGattReliableSetupPhaseV1.CLOSED
        deadlineElapsedMs = null
        cancelDeadline()
        return AndroidGattReliableSetupDeadlineExceptionV1(code, message)
    }
}
