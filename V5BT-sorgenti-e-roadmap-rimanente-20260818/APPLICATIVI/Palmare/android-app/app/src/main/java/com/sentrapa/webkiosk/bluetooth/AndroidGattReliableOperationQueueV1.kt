package com.sentrapa.webkiosk.bluetooth

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicLong

data class AndroidGattReliableQueuedOperationV1(
    val generation: Long,
    val token: Long,
    val target: AndroidGattReliablePublishTargetV1
)

data class AndroidGattReliableOperationQueueSnapshotV1(
    val pending: Int,
    val inFlight: Boolean,
    val deadlineActive: Boolean,
    val enqueued: Long,
    val completed: Long,
    val failures: Long,
    val closed: Boolean
)

class AndroidGattReliableOperationQueueExceptionV1(
    val code: String,
    message: String
) : RuntimeException(message)

fun interface AndroidGattReliableDeadlineScheduleV1 {
    fun schedule(delayMs: Long, operation: () -> Unit): AutoCloseable
}

class AndroidHandlerGattReliableDeadlineScheduleV1(
    private val handler: Handler = Handler(Looper.getMainLooper())
) : AndroidGattReliableDeadlineScheduleV1 {
    override fun schedule(delayMs: Long, operation: () -> Unit): AutoCloseable {
        val callback = Runnable(operation)
        if (!handler.postDelayed(callback, delayMs)) {
            throw IllegalStateException("reliable GATT deadline was rejected")
        }
        return AutoCloseable { handler.removeCallbacks(callback) }
    }
}

private object AndroidGattReliableQueueGenerationV1 {
    private val next = AtomicLong(1)

    fun allocate(): Long {
        while (true) {
            val current = next.get()
            if (current <= 0 || current == Long.MAX_VALUE) {
                throw IllegalStateException("reliable GATT queue generation exhausted")
            }
            if (next.compareAndSet(current, current + 1)) return current
        }
    }
}

class AndroidGattReliableOperationQueueV1(
    private val starter:
        (AndroidGattReliableQueuedOperationV1, ByteArray) -> Boolean,
    private val maximumPending: Int = 64,
    private val operationTimeoutMs: Long = 2_000,
    private val deadlineSchedule: AndroidGattReliableDeadlineScheduleV1 =
        AndroidHandlerGattReliableDeadlineScheduleV1(),
    private val nowElapsedMs: () -> Long = SystemClock::elapsedRealtime,
    private val onFatal: (AndroidGattReliableOperationQueueExceptionV1) -> Unit = {}
) : AutoCloseable {
    private class Pending(
        val operation: AndroidGattReliableQueuedOperationV1,
        frame: ByteArray
    ) : AutoCloseable {
        val frame = frame.copyOf()
        var deadlineElapsedMs: Long? = null

        override fun close() {
            frame.fill(0)
            deadlineElapsedMs = null
        }
    }

    private val waiting = ArrayDeque<Pending>()
    private val generation = AndroidGattReliableQueueGenerationV1.allocate()
    private var inFlight: Pending? = null
    private var deadlineHandle: AutoCloseable? = null
    private var nextToken = 1L
    private var lastClockMs = -1L
    private var enqueued = 0L
    private var completed = 0L
    private var failures = 0L
    private var closed = false

    init {
        if (maximumPending !in 1..256) {
            fail("INVALID_QUEUE_LIMIT", "reliable GATT queue limit is out of range")
        }
        if (operationTimeoutMs !in 250..10_000) {
            fail("INVALID_OPERATION_TIMEOUT", "reliable GATT timeout is out of range")
        }
    }

    @Synchronized
    fun enqueue(
        target: AndroidGattReliablePublishTargetV1,
        frame: ByteArray
    ): Long {
        assertOpen()
        checkClockAndDeadline()
        validateTarget(target)
        if (
            frame.size !in (ReliableFrameCodecV1.HEADER_BYTES + 1)..
            (AndroidGattProfileV1.MAXIMUM_MTU - 3)
        ) {
            fail("INVALID_FRAME_LENGTH", "reliable GATT frame length is invalid")
        }
        if (pendingCount() >= maximumPending) {
            terminate("QUEUE_CAPACITY_EXCEEDED", "reliable GATT operation queue is full")
        }
        if (nextToken <= 0 || nextToken == Long.MAX_VALUE) {
            terminate("QUEUE_TOKEN_EXHAUSTED", "reliable GATT token space is exhausted")
        }
        val token = nextToken++
        waiting.addLast(
            Pending(AndroidGattReliableQueuedOperationV1(generation, token, target), frame)
        )
        enqueued += 1
        startNext()
        return token
    }

    @Synchronized
    fun complete(
        operation: AndroidGattReliableQueuedOperationV1,
        success: Boolean
    ) {
        assertOpen()
        checkClockAndDeadline()
        val current = inFlight
            ?: terminate("NO_OPERATION_IN_FLIGHT", "reliable GATT completion is unsolicited")
        if (current.operation != operation) {
            terminate(
                "GATT_COMPLETION_MISMATCH",
                "reliable GATT completion does not match the in-flight operation"
            )
        }
        cancelDeadline()
        inFlight = null
        current.close()
        if (!success) {
            terminate("GATT_OPERATION_FAILED", "reliable GATT operation failed")
        }
        completed += 1
        startNext()
    }

    @Synchronized
    fun tick() {
        assertOpen()
        checkClockAndDeadline()
    }

    @Synchronized
    fun snapshot(): AndroidGattReliableOperationQueueSnapshotV1 =
        AndroidGattReliableOperationQueueSnapshotV1(
            pending = pendingCount(),
            inFlight = inFlight != null,
            deadlineActive = deadlineHandle != null,
            enqueued = enqueued,
            completed = completed,
            failures = failures,
            closed = closed
        )

    @Synchronized
    fun clear() {
        if (closed) return
        clearPending()
    }

    @Synchronized
    override fun close() {
        if (closed) return
        clearPending()
        closed = true
    }

    private fun startNext() {
        if (inFlight != null) return
        val next = waiting.pollFirst() ?: return
        // Own the frame before any fail-closed clock validation so termination
        // always wipes it, including the regression and overflow paths.
        inFlight = next
        val current = checkedNow()
        if (current > Long.MAX_VALUE - operationTimeoutMs) {
            terminate("CLOCK_OVERFLOW", "reliable GATT deadline overflowed")
        }
        next.deadlineElapsedMs = current + operationTimeoutMs
        val started = try {
            starter(next.operation, next.frame)
        } catch (_: Exception) {
            false
        }
        if (!started) {
            terminate(
                "GATT_OPERATION_START_FAILED",
                "reliable GATT operation did not start"
            )
        }
        armDeadline(next.operation.token, operationTimeoutMs)
    }

    private fun armDeadline(token: Long, delayMs: Long) {
        cancelDeadline()
        deadlineHandle = try {
            deadlineSchedule.schedule(delayMs) { handleDeadline(token) }
        } catch (_: Exception) {
            terminate(
                "DEADLINE_SCHEDULE_FAILED",
                "reliable GATT deadline could not be scheduled"
            )
        }
    }

    private fun handleDeadline(token: Long) {
        var failure: AndroidGattReliableOperationQueueExceptionV1? = null
        synchronized(this) {
            if (closed || inFlight?.operation?.token != token) return
            val current = nowElapsedMs()
            if (current < 0 || current < lastClockMs) {
                failure = terminateWithoutThrow(
                    "CLOCK_REGRESSION",
                    "reliable GATT monotonic clock moved backwards"
                )
            } else {
                lastClockMs = current
                val deadline = checkNotNull(inFlight?.deadlineElapsedMs)
                if (current >= deadline) {
                    failure = terminateWithoutThrow(
                        "GATT_OPERATION_TIMEOUT",
                        "reliable GATT operation timed out"
                    )
                } else {
                    armDeadline(token, deadline - current)
                }
            }
        }
        failure?.let(::notifyFatal)
    }

    private fun checkClockAndDeadline() {
        val current = checkedNow()
        val deadline = inFlight?.deadlineElapsedMs
        if (deadline != null && current >= deadline) {
            terminate("GATT_OPERATION_TIMEOUT", "reliable GATT operation timed out")
        }
    }

    private fun checkedNow(): Long {
        val current = nowElapsedMs()
        if (current < 0 || current < lastClockMs) {
            terminate(
                "CLOCK_REGRESSION",
                "reliable GATT monotonic clock moved backwards"
            )
        }
        lastClockMs = current
        return current
    }

    private fun validateTarget(target: AndroidGattReliablePublishTargetV1) {
        val accepted =
            target == AndroidGattReliablePublishTargetV1(
                AndroidGattProfileV1.dataRxUuid,
                AndroidGattReliableDeliveryV1.WRITE_REQUEST
            ) ||
                target == AndroidGattReliablePublishTargetV1(
                    AndroidGattProfileV1.dataTxUuid,
                    AndroidGattReliableDeliveryV1.NOTIFY
                ) ||
                target == AndroidGattReliablePublishTargetV1(
                    AndroidGattProfileV1.ackTxUuid,
                    AndroidGattReliableDeliveryV1.INDICATE
                )
        if (!accepted) {
            fail("INVALID_PUBLISH_TARGET", "reliable GATT publish target is not allowed")
        }
    }

    private fun pendingCount(): Int = waiting.size + if (inFlight == null) 0 else 1

    private fun clearPending() {
        cancelDeadline()
        inFlight?.close()
        inFlight = null
        while (waiting.isNotEmpty()) waiting.removeFirst().close()
    }

    private fun cancelDeadline() {
        deadlineHandle?.close()
        deadlineHandle = null
    }

    private fun assertOpen() {
        if (closed) fail("QUEUE_CLOSED", "reliable GATT operation queue is closed")
    }

    private fun terminate(code: String, message: String): Nothing {
        val error = terminateWithoutThrow(code, message)
        notifyFatal(error)
        throw error
    }

    private fun terminateWithoutThrow(
        code: String,
        message: String
    ): AndroidGattReliableOperationQueueExceptionV1 {
        failures += 1
        clearPending()
        closed = true
        return AndroidGattReliableOperationQueueExceptionV1(code, message)
    }

    private fun notifyFatal(error: AndroidGattReliableOperationQueueExceptionV1) {
        runCatching { onFatal(error) }
    }

    private fun fail(code: String, message: String): Nothing =
        throw AndroidGattReliableOperationQueueExceptionV1(code, message)
}
