package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Test

class BluetoothConnectivityMetricsTest {
    @Test
    fun `metrics contain only aggregate lifecycle counters`() {
        val metrics = BluetoothConnectivityMetrics()
        val machine = BluetoothConnectivityStateMachine()

        record(machine, metrics, BluetoothConnectivityEvent.START_REQUESTED)
        record(machine, metrics, BluetoothConnectivityEvent.START_REQUESTED)
        record(machine, metrics, BluetoothConnectivityEvent.DISCOVERY_READY)
        record(machine, metrics, BluetoothConnectivityEvent.BACKOFF_REQUESTED)
        record(machine, metrics, BluetoothConnectivityEvent.BACKOFF_EXPIRED)
        record(machine, metrics, BluetoothConnectivityEvent.FUTURE_PEER_CONNECTED)
        record(machine, metrics, BluetoothConnectivityEvent.STOP_REQUESTED)
        record(machine, metrics, BluetoothConnectivityEvent.STOP_REQUESTED)

        assertEquals(
            BluetoothConnectivityMetricsSnapshot(
                starts = 1L,
                stops = 1L,
                backoffs = 1L,
                transitions = 5L,
                duplicates = 2L,
                invalid = 1L
            ),
            metrics.snapshot()
        )
    }

    @Test
    fun `sixty minute steady discovery has no transition or publication churn`() {
        val metrics = BluetoothConnectivityMetrics()
        val store = BluetoothAgentStateStore()
        val machine = BluetoothConnectivityStateMachine()

        apply(machine, metrics, store, BluetoothConnectivityEvent.START_REQUESTED)
        apply(machine, metrics, store, BluetoothConnectivityEvent.DISCOVERY_READY)
        val stableSequence = store.snapshot().sequence

        repeat(60 * 60) {
            apply(machine, metrics, store, BluetoothConnectivityEvent.DISCOVERY_READY)
        }

        val snapshot = metrics.snapshot()
        assertEquals(BluetoothConnectivityState.DISCOVERING, machine.state)
        assertEquals(BluetoothConnectivityState.DISCOVERING, store.snapshot().state)
        assertEquals(stableSequence, store.snapshot().sequence)
        assertEquals(2L, snapshot.transitions)
        assertEquals(1L, snapshot.starts)
        assertEquals(0L, snapshot.stops)
        assertEquals(0L, snapshot.backoffs)
        assertEquals(3_600L, snapshot.duplicates)
        assertEquals(0L, snapshot.invalid)
    }

    private fun record(
        machine: BluetoothConnectivityStateMachine,
        metrics: BluetoothConnectivityMetrics,
        event: BluetoothConnectivityEvent
    ) {
        metrics.record(machine.dispatch(event))
    }

    private fun apply(
        machine: BluetoothConnectivityStateMachine,
        metrics: BluetoothConnectivityMetrics,
        store: BluetoothAgentStateStore,
        event: BluetoothConnectivityEvent
    ) {
        val result = machine.dispatch(event)
        metrics.record(result)
        if (result.changed) store.publish(result.to)
    }
}
