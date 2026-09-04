package com.sentrapa.cassav6.webkiosk.bluetooth

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothReliableEndpointArbiterV1Test {
    @Test
    fun `duplicate callback and opposite endpoint preserve the active lease`() {
        val runtime = FakeRuntime()
        val arbiter = BluetoothReliableEndpointArbiterV1(
            BluetoothReliableApplicationPortMultiplexerV1(),
            runtime
        )
        val client = FakePort()
        val duplicate = FakePort()
        val server = FakePort()

        assertTrue(arbiter.onPortChanged(BluetoothReliableEndpointSourceV1.CLIENT, client))
        assertFalse(
            arbiter.onPortChanged(BluetoothReliableEndpointSourceV1.CLIENT, duplicate)
        )
        assertFalse(arbiter.onPortChanged(BluetoothReliableEndpointSourceV1.SERVER, server))
        assertEquals(1, runtime.starts)
        assertEquals(0, runtime.suspends)
        assertEquals(0, client.resets)
        assertEquals(0, duplicate.resets)
        assertEquals(0, server.resets)
        assertEquals(1, arbiter.snapshot().duplicateRejected)
        assertEquals(1, arbiter.snapshot().conflictRejected)
        assertTrue(arbiter.snapshot().clientActive)

        assertTrue(arbiter.onPortChanged(BluetoothReliableEndpointSourceV1.CLIENT, null))
        assertEquals(1, runtime.suspends)
        assertTrue(client.resets >= 1)
        assertTrue(arbiter.onPortChanged(BluetoothReliableEndpointSourceV1.SERVER, server))
        assertTrue(arbiter.snapshot().serverActive)
        arbiter.close()
    }

    @Test
    fun `concurrent client server race accepts exactly one without throwing`() {
        val runtime = FakeRuntime()
        val arbiter = BluetoothReliableEndpointArbiterV1(
            BluetoothReliableApplicationPortMultiplexerV1(),
            runtime
        )
        val ready = CountDownLatch(2)
        val start = CountDownLatch(1)
        val done = CountDownLatch(2)
        val results = BooleanArray(2)
        val errors = mutableListOf<Throwable>()
        listOf(
            BluetoothReliableEndpointSourceV1.CLIENT,
            BluetoothReliableEndpointSourceV1.SERVER
        ).forEachIndexed { index, source ->
            Thread {
                ready.countDown()
                start.await()
                runCatching { arbiter.onPortChanged(source, FakePort()) }
                    .onSuccess { results[index] = it }
                    .onFailure { synchronized(errors) { errors += it } }
                done.countDown()
            }.start()
        }
        assertTrue(ready.await(2, TimeUnit.SECONDS))
        start.countDown()
        assertTrue(done.await(2, TimeUnit.SECONDS))
        assertTrue(errors.isEmpty())
        assertEquals(1, results.count { it })
        assertEquals(1, arbiter.snapshot().accepted)
        assertEquals(1, arbiter.snapshot().conflictRejected)
        assertEquals(1, runtime.starts)
        arbiter.close()
    }

    @Test
    fun `runtime start failure releases lease and remains retryable`() {
        val runtime = FakeRuntime(failFirstStart = true)
        val arbiter = BluetoothReliableEndpointArbiterV1(
            BluetoothReliableApplicationPortMultiplexerV1(),
            runtime
        )
        val rejected = FakePort()
        val accepted = FakePort()
        assertFalse(
            arbiter.onPortChanged(BluetoothReliableEndpointSourceV1.CLIENT, rejected)
        )
        assertTrue(rejected.resets >= 1)
        assertFalse(arbiter.snapshot().clientActive)
        assertEquals(1, arbiter.snapshot().startRejected)
        assertTrue(
            arbiter.onPortChanged(BluetoothReliableEndpointSourceV1.SERVER, accepted)
        )
        assertTrue(arbiter.snapshot().serverActive)
        arbiter.close()
    }

    private class FakeRuntime(
        private var failFirstStart: Boolean = false
    ) : BluetoothReliableRuntimeLifecycleV1 {
        var starts = 0
        var suspends = 0

        override fun start(): Boolean {
            starts += 1
            if (failFirstStart) {
                failFirstStart = false
                error("start rejected")
            }
            return true
        }

        override fun suspendForLinkLoss() {
            suspends += 1
        }
    }

    private class FakePort : BluetoothReliableApplicationPortV1 {
        var resets = 0
        override val available: Boolean = true

        override fun send(
            input: ReliableChannelSendInputV1
        ): ReliableChannelSendResultV1 = error("not used")

        override fun restoreBound(): Int = 0

        override fun tick(): ReliableChannelTickResultV1 =
            ReliableChannelTickResultV1(0, 0, 0)

        override fun reset() {
            resets += 1
        }

        override fun snapshot(): BluetoothReliableApplicationPortSnapshotV1 =
            BluetoothReliableApplicationPortSnapshotV1(
                available = true,
                bound = true,
                publishedFragments = 0,
                receivedFragments = 0,
                failures = 0
            )
    }
}
