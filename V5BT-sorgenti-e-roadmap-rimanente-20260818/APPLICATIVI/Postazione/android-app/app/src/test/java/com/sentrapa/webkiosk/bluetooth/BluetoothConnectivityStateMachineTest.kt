package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothConnectivityStateMachineTest {
    @Test
    fun `supported transition matrix reaches only the declared target`() {
        val rows = listOf(
            row(
                BluetoothConnectivityState.DISABLED,
                BluetoothConnectivityEvent.START_REQUESTED,
                BluetoothConnectivityState.STARTING
            ),
            row(
                BluetoothConnectivityState.STOPPED,
                BluetoothConnectivityEvent.START_REQUESTED,
                BluetoothConnectivityState.STARTING
            ),
            row(
                BluetoothConnectivityState.STARTING,
                BluetoothConnectivityEvent.PERMISSIONS_MISSING,
                BluetoothConnectivityState.PERMISSION_REQUIRED
            ),
            row(
                BluetoothConnectivityState.PERMISSION_REQUIRED,
                BluetoothConnectivityEvent.PERMISSIONS_GRANTED,
                BluetoothConnectivityState.STARTING
            ),
            row(
                BluetoothConnectivityState.STARTING,
                BluetoothConnectivityEvent.DISCOVERY_READY,
                BluetoothConnectivityState.DISCOVERING
            ),
            row(
                BluetoothConnectivityState.DISCOVERING,
                BluetoothConnectivityEvent.FAULT_DETECTED,
                BluetoothConnectivityState.DEGRADED
            ),
            row(
                BluetoothConnectivityState.DEGRADED,
                BluetoothConnectivityEvent.BACKOFF_REQUESTED,
                BluetoothConnectivityState.BACKOFF
            ),
            row(
                BluetoothConnectivityState.BACKOFF,
                BluetoothConnectivityEvent.BACKOFF_EXPIRED,
                BluetoothConnectivityState.STARTING
            ),
            row(
                BluetoothConnectivityState.DISCOVERING,
                BluetoothConnectivityEvent.FUTURE_DIRECT_SERVER_READY,
                BluetoothConnectivityState.DIRECT_SERVER
            ),
            row(
                BluetoothConnectivityState.DIRECT_SERVER,
                BluetoothConnectivityEvent.FUTURE_PEER_CONNECTED,
                BluetoothConnectivityState.PEER_CONNECTED
            ),
            row(
                BluetoothConnectivityState.PEER_CONNECTED,
                BluetoothConnectivityEvent.FUTURE_PEER_DISCONNECTED,
                BluetoothConnectivityState.DISCOVERING
            )
        )

        rows.forEach { row ->
            val machine = BluetoothConnectivityStateMachine(
                initialState = row.from,
                futureConnectivityEventsEnabled = true
            )
            val result = machine.dispatch(row.event)

            assertEquals(BluetoothConnectivityTransitionDisposition.TRANSITIONED, result.disposition)
            assertEquals(row.from, result.from)
            assertEquals(row.to, result.to)
            assertEquals(row.to, machine.state)
        }
    }

    @Test
    fun `duplicate lifecycle events are idempotent and never churn state`() {
        val machine = BluetoothConnectivityStateMachine()
        assertTrue(machine.dispatch(BluetoothConnectivityEvent.START_REQUESTED).changed)
        assertFalse(machine.dispatch(BluetoothConnectivityEvent.START_REQUESTED).changed)
        assertTrue(machine.dispatch(BluetoothConnectivityEvent.DISCOVERY_READY).changed)

        repeat(3_600) {
            val duplicate = machine.dispatch(BluetoothConnectivityEvent.DISCOVERY_READY)
            assertEquals(
                BluetoothConnectivityTransitionDisposition.IDEMPOTENT,
                duplicate.disposition
            )
            assertEquals(BluetoothConnectivityState.DISCOVERING, duplicate.to)
        }

        assertEquals(BluetoothConnectivityState.DISCOVERING, machine.state)
    }

    @Test
    fun `future GATT and peer states remain guarded by default`() {
        val machine = BluetoothConnectivityStateMachine(
            initialState = BluetoothConnectivityState.DISCOVERING
        )
        listOf(
            BluetoothConnectivityEvent.FUTURE_DIRECT_SERVER_READY,
            BluetoothConnectivityEvent.FUTURE_PEER_CONNECTED,
            BluetoothConnectivityEvent.FUTURE_PEER_DISCONNECTED
        ).forEach { event ->
            val result = machine.dispatch(event)
            assertEquals(
                BluetoothConnectivityTransitionDisposition.FUTURE_GUARDED,
                result.disposition
            )
            assertEquals(BluetoothConnectivityState.DISCOVERING, machine.state)
        }
    }

    @Test
    fun `illegal events fail closed without changing state`() {
        val cases = listOf(
            BluetoothConnectivityState.DISABLED to BluetoothConnectivityEvent.DISCOVERY_READY,
            BluetoothConnectivityState.DISABLED to BluetoothConnectivityEvent.PERMISSIONS_GRANTED,
            BluetoothConnectivityState.PERMISSION_REQUIRED to
                BluetoothConnectivityEvent.BACKOFF_REQUESTED,
            BluetoothConnectivityState.STOPPED to BluetoothConnectivityEvent.PERMISSIONS_MISSING
        )

        cases.forEach { (state, event) ->
            val machine = BluetoothConnectivityStateMachine(initialState = state)
            val result = machine.dispatch(event)

            assertEquals(BluetoothConnectivityTransitionDisposition.INVALID, result.disposition)
            assertEquals(state, result.to)
            assertEquals(state, machine.state)
        }
    }

    @Test
    fun `stop and disable are deterministic from every state`() {
        BluetoothConnectivityState.entries.forEach { initial ->
            val stopped = BluetoothConnectivityStateMachine(initial)
                .dispatch(BluetoothConnectivityEvent.STOP_REQUESTED)
            assertEquals(BluetoothConnectivityState.STOPPED, stopped.to)

            val disabled = BluetoothConnectivityStateMachine(initial)
                .dispatch(BluetoothConnectivityEvent.FEATURE_DISABLED)
            assertEquals(BluetoothConnectivityState.DISABLED, disabled.to)
        }
    }

    private fun row(
        from: BluetoothConnectivityState,
        event: BluetoothConnectivityEvent,
        to: BluetoothConnectivityState
    ) = TransitionRow(from, event, to)

    private data class TransitionRow(
        val from: BluetoothConnectivityState,
        val event: BluetoothConnectivityEvent,
        val to: BluetoothConnectivityState
    )
}
