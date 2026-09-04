package com.sentrapa.webkiosk.bluetooth

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothScanIngressQueueTest {
    @Test
    fun `bounded queue drops oldest and keeps latest observations`() {
        val ingress = BluetoothScanIngressQueue<Int>(maximumPending = 2)
        val generation = ingress.openGeneration()

        assertTrue(ingress.offer(generation, 1).shouldScheduleDrain)
        assertFalse(ingress.offer(generation, 2).shouldScheduleDrain)
        val overflow = ingress.offer(generation, 3)

        assertTrue(overflow.accepted)
        assertFalse(overflow.shouldScheduleDrain)
        assertEquals(1, overflow.droppedCount)
        assertEquals(listOf(2, 3), ingress.takeBatch(2).values)
        assertEquals(0, ingress.pendingCount())
    }

    @Test
    fun `invalidated generation clears queued work and rejects tardy results`() {
        val ingress = BluetoothScanIngressQueue<Int>(maximumPending = 4)
        val oldGeneration = ingress.openGeneration()
        ingress.offer(oldGeneration, 1)
        ingress.offer(oldGeneration, 2)

        assertEquals(2, ingress.invalidateGeneration(oldGeneration))
        val stale = ingress.offer(oldGeneration, 3)

        assertFalse(stale.accepted)
        assertEquals(1, stale.droppedCount)
        assertEquals(0, ingress.pendingCount())
        val newGeneration = ingress.openGeneration()
        val reopened = ingress.offer(newGeneration, 4)
        assertTrue(reopened.accepted)
        assertTrue(reopened.shouldScheduleDrain)
        assertEquals(listOf(4), ingress.takeBatch(1).values)
    }

    @Test
    fun `one producer schedules the drain under concurrent ingress`() {
        val workers = 32
        val ingress = BluetoothScanIngressQueue<Int>(maximumPending = 16)
        val generation = ingress.openGeneration()
        val executor = Executors.newFixedThreadPool(workers)
        val ready = CountDownLatch(workers)
        val start = CountDownLatch(1)
        val completed = CountDownLatch(workers)
        val drainRequests = AtomicInteger(0)
        val drops = AtomicInteger(0)

        repeat(workers) { value ->
            executor.execute {
                ready.countDown()
                start.await()
                val result = ingress.offer(generation, value)
                if (result.shouldScheduleDrain) drainRequests.incrementAndGet()
                drops.addAndGet(result.droppedCount)
                completed.countDown()
            }
        }

        assertTrue(ready.await(5, TimeUnit.SECONDS))
        start.countDown()
        assertTrue(completed.await(5, TimeUnit.SECONDS))
        executor.shutdown()
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
        assertEquals(1, drainRequests.get())
        assertEquals(16, ingress.pendingCount())
        assertEquals(16, drops.get())
    }

    @Test
    fun `batched drain remains scheduled while queued work remains`() {
        val ingress = BluetoothScanIngressQueue<Int>(maximumPending = 64)
        val generation = ingress.openGeneration()
        repeat(40) { ingress.offer(generation, it) }

        val first = ingress.takeBatch(32)
        assertEquals(32, first.values.size)
        assertTrue(first.hasMore)
        assertFalse(ingress.offer(generation, 40).shouldScheduleDrain)

        val second = ingress.takeBatch(32)
        assertEquals(9, second.values.size)
        assertFalse(second.hasMore)
        assertTrue(ingress.offer(generation, 41).shouldScheduleDrain)
    }

    @Test
    fun `profile transition can drain callbacks before invalidating generation`() {
        val ingress = BluetoothScanIngressQueue<Int>(maximumPending = 4)
        val generation = ingress.openGeneration()
        ingress.offer(generation, 1)
        assertEquals(listOf(1), ingress.takeBatch(1).values)

        ingress.offer(generation, 2)
        ingress.offer(generation, 3)
        val pending = ingress.takeBatch(4)

        assertEquals(listOf(2, 3), pending.values)
        assertFalse(pending.hasMore)
        assertEquals(0, ingress.invalidateGeneration(generation))
    }

    @Test
    fun `policy bound drops oldest results under a 300 item flood`() {
        val ingress =
            BluetoothScanIngressQueue<Int>(
                BluetoothDiscoveryPolicy.MAX_PENDING_SCAN_RESULTS
            )
        val generation = ingress.openGeneration()
        var dropped = 0

        repeat(300) { value ->
            dropped += ingress.offer(generation, value).droppedCount
        }

        assertEquals(44, dropped)
        assertEquals(256, ingress.pendingCount())
        val retained = ingress.takeBatch(256)
        assertEquals((44 until 300).toList(), retained.values)
        assertFalse(retained.hasMore)
    }

    @Test
    fun `cancelling a full pending drain permits a fresh schedule`() {
        val ingress = BluetoothScanIngressQueue<Int>(maximumPending = 4)
        val generation = ingress.openGeneration()
        repeat(4) { ingress.offer(generation, it) }

        assertEquals(4, ingress.cancelScheduledDrain())
        assertEquals(0, ingress.pendingCount())
        assertTrue(ingress.offer(generation, 5).shouldScheduleDrain)
    }
}
