package com.sentrapa.webkiosk.bluetooth

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothAgentStateStoreTest {
    @Test
    fun `WebView JSON contains exactly the four redacted state fields`() {
        val store = BluetoothAgentStateStore()
        store.publish(BluetoothConnectivityState.STARTING)
        val snapshot = store.publish(BluetoothConnectivityState.DISCOVERING)

        assertEquals(
            "{\"schemaVersion\":1," +
                "\"source\":\"V5BT_ANDROID_CONNECTIVITY_AGENT\"," +
                "\"sequence\":2," +
                "\"state\":\"DISCOVERING\"}",
            snapshot.toRedactedWebViewJson()
        )
        val json = snapshot.toRedactedWebViewJson()
        assertEquals(
            setOf("schemaVersion", "source", "sequence", "state"),
            Regex("\"([A-Za-z]+)\"\\s*:").findAll(json)
                .map { it.groupValues[1] }
                .toSet()
        )
        listOf("metrics", "nodeId", "alias", "peer", "address", "token", "key").forEach {
            assertFalse(json.contains(it, ignoreCase = true))
        }
    }

    @Test
    fun `listeners receive changed state once and can unsubscribe`() {
        val store = BluetoothAgentStateStore()
        val received = mutableListOf<BluetoothAgentStateSnapshot>()
        val subscription = store.addListener { received += it }

        assertNotNull(subscription)
        store.publish(BluetoothConnectivityState.STARTING)
        store.publish(BluetoothConnectivityState.STARTING)
        subscription?.close()
        subscription?.close()
        store.publish(BluetoothConnectivityState.DISCOVERING)

        assertEquals(
            listOf(
                BluetoothConnectivityState.DISABLED,
                BluetoothConnectivityState.STARTING
            ),
            received.map { it.state }
        )
        assertEquals(listOf(0L, 1L), received.map { it.sequence })
        assertEquals(0, store.listenerCount())
    }

    @Test
    fun `listener capacity remains bounded under concurrent registration`() {
        val store = BluetoothAgentStateStore()
        val subscriptions =
            Collections.synchronizedList(mutableListOf<BluetoothAgentStateSubscription>())
        val executor = Executors.newFixedThreadPool(8)
        val start = CountDownLatch(1)
        val complete = CountDownLatch(64)

        repeat(64) {
            executor.execute {
                try {
                    start.await()
                    store.addListener(emitCurrent = false) { }?.let(subscriptions::add)
                } finally {
                    complete.countDown()
                }
            }
        }

        start.countDown()
        assertTrue(complete.await(5, TimeUnit.SECONDS))
        executor.shutdownNow()
        assertEquals(BluetoothAgentStateStore.MAX_LISTENERS, subscriptions.size)
        assertEquals(BluetoothAgentStateStore.MAX_LISTENERS, store.listenerCount())
        assertNull(store.addListener(emitCurrent = false) { })

        subscriptions.forEach(BluetoothAgentStateSubscription::close)
        assertEquals(0, store.listenerCount())
        assertNotNull(store.addListener(emitCurrent = false) { })
    }
}
