package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class BluetoothDiscoveryClosePolicyTest {
    @Test
    fun `synchronous fallback runs when cleanup was not posted`() {
        assertTrue(
            BluetoothDiscoveryClosePolicy.requiresSynchronousFallback(
                posted = false,
                completedInTime = false
            )
        )
    }

    @Test
    fun `synchronous fallback runs when worker cleanup times out`() {
        assertTrue(
            BluetoothDiscoveryClosePolicy.requiresSynchronousFallback(
                posted = true,
                completedInTime = false
            )
        )
    }

    @Test
    fun `completed worker cleanup needs no fallback`() {
        assertFalse(
            BluetoothDiscoveryClosePolicy.requiresSynchronousFallback(
                posted = true,
                completedInTime = true
            )
        )
    }

    @Test
    fun `timeout fallback waits for cleanup already claimed by worker`() {
        val gate = BluetoothDiscoveryCleanupGate()
        val cleanupEntered = CountDownLatch(1)
        val releaseCleanup = CountDownLatch(1)
        val fallbackWaiting = CountDownLatch(1)
        val fallbackCompleted = CountDownLatch(1)
        val cleanupRuns = AtomicInteger(0)
        val worker = Thread {
            gate.runOnce {
                cleanupRuns.incrementAndGet()
                cleanupEntered.countDown()
                releaseCleanup.await()
            }
        }
        worker.start()
        assertTrue(cleanupEntered.await(1L, TimeUnit.SECONDS))
        assertFalse(gate.await(1L))

        val fallback = Thread {
            assertFalse(gate.runOnce { cleanupRuns.incrementAndGet() })
            fallbackWaiting.countDown()
            gate.awaitCompletionUninterruptibly()
            fallbackCompleted.countDown()
        }
        fallback.start()
        assertTrue(fallbackWaiting.await(1L, TimeUnit.SECONDS))
        assertFalse(fallbackCompleted.await(50L, TimeUnit.MILLISECONDS))

        releaseCleanup.countDown()
        assertTrue(fallbackCompleted.await(1L, TimeUnit.SECONDS))
        worker.join(1_000L)
        fallback.join(1_000L)
        assertFalse(worker.isAlive)
        assertFalse(fallback.isAlive)
        assertEquals(1, cleanupRuns.get())
    }
}
