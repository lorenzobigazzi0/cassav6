package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidGattReliableOperationQueueV1Test {
    @Test
    fun `queue serializes operations and wipes only the exact completion`() {
        var now = 100L
        val schedule = FakeDeadlineSchedule()
        val started = mutableListOf<Pair<AndroidGattReliableQueuedOperationV1, ByteArray>>()
        val queue = queue(
            now = { now },
            schedule = schedule,
            starter = { operation, frame ->
                started += operation to frame
                true
            }
        )
        val first = ByteArray(15) { 1 }
        val second = ByteArray(15) { 2 }
        val dataTarget = target(AndroidGattProfileV1.dataTxUuid.toString(), false)
        val ackTarget = target(AndroidGattProfileV1.ackTxUuid.toString(), true)

        queue.enqueue(dataTarget, first)
        queue.enqueue(ackTarget, second)
        assertEquals(1, started.size)
        assertEquals(2, queue.snapshot().pending)
        assertTrue(queue.snapshot().deadlineActive)
        assertTrue(first.all { it.toInt() == 1 })

        now += 1
        queue.complete(started[0].first, success = true)
        assertTrue(started[0].second.all { it.toInt() == 0 })
        assertEquals(listOf(dataTarget, ackTarget), started.map { it.first.target })
        assertEquals(1, queue.snapshot().pending)
        now += 1
        queue.complete(started[1].first, success = true)
        assertTrue(started[1].second.all { it.toInt() == 0 })
        assertEquals(0, queue.snapshot().pending)
        assertEquals(2, queue.snapshot().completed)
        assertFalse(queue.snapshot().deadlineActive)
        assertNull(schedule.operation)
        queue.close()
        first.fill(0)
        second.fill(0)
    }

    @Test
    fun `stale token or wrong completion target closes and wipes queue`() {
        var now = 500L
        val schedule = FakeDeadlineSchedule()
        lateinit var started: Pair<AndroidGattReliableQueuedOperationV1, ByteArray>
        val queue = queue(
            now = { now },
            schedule = schedule,
            starter = { operation, frame ->
                started = operation to frame
                true
            }
        )
        val frame = ByteArray(15) { 3 }
        queue.enqueue(target(AndroidGattProfileV1.dataRxUuid.toString()), frame)

        now += 1
        val stale = assertThrows(
            AndroidGattReliableOperationQueueExceptionV1::class.java
        ) {
            queue.complete(
                started.first.copy(token = started.first.token + 1),
                success = true
            )
        }
        assertEquals("GATT_COMPLETION_MISMATCH", stale.code)
        assertTrue(started.second.all { it.toInt() == 0 })
        assertTrue(queue.snapshot().closed)

        val otherSchedule = FakeDeadlineSchedule()
        lateinit var otherStarted: Pair<AndroidGattReliableQueuedOperationV1, ByteArray>
        val other = queue(
            now = { now },
            schedule = otherSchedule,
            starter = { operation, copy ->
                otherStarted = operation to copy
                true
            }
        )
        other.enqueue(target(AndroidGattProfileV1.dataTxUuid.toString(), false), frame)
        now += 1
        val wrongTarget = assertThrows(
            AndroidGattReliableOperationQueueExceptionV1::class.java
        ) {
            other.complete(
                otherStarted.first.copy(
                    target = target(AndroidGattProfileV1.ackTxUuid.toString(), true)
                ),
                success = true
            )
        }
        assertEquals("GATT_COMPLETION_MISMATCH", wrongTarget.code)
        assertTrue(otherStarted.second.all { it.toInt() == 0 })
        frame.fill(0)
    }

    @Test
    fun `callback from closed lifecycle cannot complete a new queue generation`() {
        var now = 700L
        lateinit var oldOperation: AndroidGattReliableQueuedOperationV1
        val oldQueue = queue(
            now = { now },
            starter = { operation, _ ->
                oldOperation = operation
                true
            }
        )
        val frame = ByteArray(15) { 7 }
        val target = target(AndroidGattProfileV1.dataRxUuid.toString())
        oldQueue.enqueue(target, frame)
        oldQueue.close()

        lateinit var newOperation: AndroidGattReliableQueuedOperationV1
        lateinit var newFrame: ByteArray
        val newQueue = queue(
            now = { now },
            starter = { operation, copy ->
                newOperation = operation
                newFrame = copy
                true
            }
        )
        newQueue.enqueue(target, frame)
        assertEquals(oldOperation.token, newOperation.token)
        assertEquals(oldOperation.target, newOperation.target)
        assertTrue(oldOperation.generation != newOperation.generation)

        now += 1
        val stale = assertThrows(
            AndroidGattReliableOperationQueueExceptionV1::class.java
        ) { newQueue.complete(oldOperation, success = true) }
        assertEquals("GATT_COMPLETION_MISMATCH", stale.code)
        assertTrue(newFrame.all { it.toInt() == 0 })
        assertTrue(newQueue.snapshot().closed)
        frame.fill(0)
    }

    @Test
    fun `target allowlist rejects wrong characteristic delivery pair`() {
        val queue = queue()
        val frame = ByteArray(15) { 4 }
        val error = assertThrows(
            AndroidGattReliableOperationQueueExceptionV1::class.java
        ) {
            queue.enqueue(
                AndroidGattReliablePublishTargetV1(
                    AndroidGattProfileV1.dataTxUuid,
                    AndroidGattReliableDeliveryV1.INDICATE
                ),
                frame
            )
        }
        assertEquals("INVALID_PUBLISH_TARGET", error.code)
        assertEquals(0, queue.snapshot().pending)
        assertFalse(queue.snapshot().closed)
        queue.close()
        frame.fill(0)
    }

    @Test
    fun `missing callback expires on monotonic deadline and wipes pending frames`() {
        var now = 1_000L
        val schedule = FakeDeadlineSchedule()
        val fatal = mutableListOf<String>()
        lateinit var startedFrame: ByteArray
        val queue = queue(
            now = { now },
            schedule = schedule,
            onFatal = { fatal += it.code },
            starter = { _, frame ->
                startedFrame = frame
                true
            }
        )
        val frame = ByteArray(15) { 5 }
        queue.enqueue(target(AndroidGattProfileV1.dataRxUuid.toString()), frame)

        now += TIMEOUT_MS
        schedule.fire()
        assertEquals(listOf("GATT_OPERATION_TIMEOUT"), fatal)
        assertTrue(startedFrame.all { it.toInt() == 0 })
        assertEquals(0, queue.snapshot().pending)
        assertTrue(queue.snapshot().closed)
        assertFalse(queue.snapshot().deadlineActive)
        frame.fill(0)
    }

    @Test
    fun `rejected deadline scheduling fails closed and wipes in flight`() {
        lateinit var startedFrame: ByteArray
        val queue = AndroidGattReliableOperationQueueV1(
            starter = { _, frame ->
                startedFrame = frame
                true
            },
            operationTimeoutMs = TIMEOUT_MS,
            deadlineSchedule = AndroidGattReliableDeadlineScheduleV1 { _, _ ->
                throw IllegalStateException("rejected")
            },
            nowElapsedMs = { 2_000L }
        )
        val frame = ByteArray(15) { 8 }
        val error = assertThrows(
            AndroidGattReliableOperationQueueExceptionV1::class.java
        ) {
            queue.enqueue(target(AndroidGattProfileV1.dataRxUuid.toString()), frame)
        }
        assertEquals("DEADLINE_SCHEDULE_FAILED", error.code)
        assertTrue(startedFrame.all { it.toInt() == 0 })
        assertTrue(queue.snapshot().closed)
        frame.fill(0)
    }

    @Test
    fun `clock regression is fatal and overflow wipes in flight`() {
        var now = 10_000L
        val schedule = FakeDeadlineSchedule()
        lateinit var startedFrame: ByteArray
        val queue = queue(
            now = { now },
            schedule = schedule,
            maximumPending = 2,
            starter = { _, frame ->
                startedFrame = frame
                true
            }
        )
        val frame = ByteArray(15) { 6 }
        val target = target(AndroidGattProfileV1.dataRxUuid.toString())
        queue.enqueue(target, frame)
        queue.enqueue(target, frame)
        val overflow = assertThrows(
            AndroidGattReliableOperationQueueExceptionV1::class.java
        ) { queue.enqueue(target, frame) }
        assertEquals("QUEUE_CAPACITY_EXCEEDED", overflow.code)
        assertTrue(startedFrame.all { it.toInt() == 0 })

        now = 20_000L
        val regressiveSchedule = FakeDeadlineSchedule()
        lateinit var regressiveFrame: ByteArray
        val regressive = queue(
            now = { now },
            schedule = regressiveSchedule,
            starter = { _, copy ->
                regressiveFrame = copy
                true
            }
        )
        regressive.enqueue(target, frame)
        now -= 1
        val clock = assertThrows(
            AndroidGattReliableOperationQueueExceptionV1::class.java
        ) { regressive.tick() }
        assertEquals("CLOCK_REGRESSION", clock.code)
        assertTrue(regressiveFrame.all { it.toInt() == 0 })
        assertTrue(regressive.snapshot().closed)
        frame.fill(0)
    }

    private fun queue(
        now: () -> Long = { 0 },
        schedule: FakeDeadlineSchedule = FakeDeadlineSchedule(),
        maximumPending: Int = 64,
        onFatal: (AndroidGattReliableOperationQueueExceptionV1) -> Unit = {},
        starter: (AndroidGattReliableQueuedOperationV1, ByteArray) -> Boolean =
            { _, _ -> true }
    ) = AndroidGattReliableOperationQueueV1(
        starter = starter,
        maximumPending = maximumPending,
        operationTimeoutMs = TIMEOUT_MS,
        deadlineSchedule = schedule,
        nowElapsedMs = now,
        onFatal = onFatal
    )

    private fun target(uuid: String, indicate: Boolean = false) =
        AndroidGattReliablePublishTargetV1(
            java.util.UUID.fromString(uuid),
            when {
                uuid == AndroidGattProfileV1.dataRxUuid.toString() ->
                    AndroidGattReliableDeliveryV1.WRITE_REQUEST
                indicate -> AndroidGattReliableDeliveryV1.INDICATE
                else -> AndroidGattReliableDeliveryV1.NOTIFY
            }
        )

    private class FakeDeadlineSchedule : AndroidGattReliableDeadlineScheduleV1 {
        var operation: (() -> Unit)? = null

        override fun schedule(delayMs: Long, operation: () -> Unit): AutoCloseable {
            this.operation = operation
            return AutoCloseable {
                if (this.operation === operation) this.operation = null
            }
        }

        fun fire() {
            val callback = checkNotNull(operation)
            operation = null
            callback()
        }
    }

    companion object {
        private const val TIMEOUT_MS = 1_000L
    }
}
