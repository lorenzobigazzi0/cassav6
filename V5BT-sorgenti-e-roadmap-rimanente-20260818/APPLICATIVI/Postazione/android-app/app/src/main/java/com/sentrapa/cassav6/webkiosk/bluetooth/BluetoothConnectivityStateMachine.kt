package com.sentrapa.cassav6.webkiosk.bluetooth

enum class BluetoothConnectivityState {
    DISABLED,
    PERMISSION_REQUIRED,
    STARTING,
    DISCOVERING,
    DIRECT_SERVER,
    PEER_CONNECTED,
    DEGRADED,
    BACKOFF,
    STOPPED
}

enum class BluetoothConnectivityEvent {
    START_REQUESTED,
    FEATURE_DISABLED,
    PERMISSIONS_MISSING,
    PERMISSIONS_GRANTED,
    DISCOVERY_READY,
    FUTURE_DIRECT_SERVER_READY,
    FUTURE_PEER_CONNECTED,
    FUTURE_PEER_DISCONNECTED,
    FAULT_DETECTED,
    BACKOFF_REQUESTED,
    BACKOFF_EXPIRED,
    STOP_REQUESTED
}

enum class BluetoothConnectivityTransitionDisposition {
    TRANSITIONED,
    IDEMPOTENT,
    INVALID,
    FUTURE_GUARDED
}

data class BluetoothConnectivityTransition(
    val event: BluetoothConnectivityEvent,
    val from: BluetoothConnectivityState,
    val to: BluetoothConnectivityState,
    val disposition: BluetoothConnectivityTransitionDisposition
) {
    val changed: Boolean
        get() = disposition == BluetoothConnectivityTransitionDisposition.TRANSITIONED
}

class BluetoothConnectivityStateMachine(
    initialState: BluetoothConnectivityState = BluetoothConnectivityState.DISABLED,
    private val futureConnectivityEventsEnabled: Boolean = false
) {
    private val lock = Any()

    @Volatile
    private var currentState = initialState

    val state: BluetoothConnectivityState
        get() = currentState

    fun dispatch(event: BluetoothConnectivityEvent): BluetoothConnectivityTransition =
        synchronized(lock) {
            evaluate(currentState, event).also { result ->
                if (result.changed) currentState = result.to
            }
        }

    private fun evaluate(
        current: BluetoothConnectivityState,
        event: BluetoothConnectivityEvent
    ): BluetoothConnectivityTransition =
        when (event) {
            BluetoothConnectivityEvent.START_REQUESTED ->
                when (current) {
                    BluetoothConnectivityState.DISABLED,
                    BluetoothConnectivityState.STOPPED ->
                        transition(event, current, BluetoothConnectivityState.STARTING)
                    else ->
                        idempotent(event, current)
                }

            BluetoothConnectivityEvent.FEATURE_DISABLED ->
                transition(event, current, BluetoothConnectivityState.DISABLED)

            BluetoothConnectivityEvent.PERMISSIONS_MISSING ->
                when (current) {
                    BluetoothConnectivityState.PERMISSION_REQUIRED ->
                        idempotent(event, current)
                    BluetoothConnectivityState.STARTING,
                    BluetoothConnectivityState.DISCOVERING,
                    BluetoothConnectivityState.DIRECT_SERVER,
                    BluetoothConnectivityState.PEER_CONNECTED,
                    BluetoothConnectivityState.DEGRADED,
                    BluetoothConnectivityState.BACKOFF ->
                        transition(
                            event,
                            current,
                            BluetoothConnectivityState.PERMISSION_REQUIRED
                        )
                    BluetoothConnectivityState.DISABLED,
                    BluetoothConnectivityState.STOPPED ->
                        invalid(event, current)
                }

            BluetoothConnectivityEvent.PERMISSIONS_GRANTED ->
                when (current) {
                    BluetoothConnectivityState.PERMISSION_REQUIRED ->
                        transition(event, current, BluetoothConnectivityState.STARTING)
                    BluetoothConnectivityState.STARTING,
                    BluetoothConnectivityState.DISCOVERING,
                    BluetoothConnectivityState.DIRECT_SERVER,
                    BluetoothConnectivityState.PEER_CONNECTED,
                    BluetoothConnectivityState.DEGRADED,
                    BluetoothConnectivityState.BACKOFF ->
                        idempotent(event, current)
                    BluetoothConnectivityState.DISABLED,
                    BluetoothConnectivityState.STOPPED ->
                        invalid(event, current)
                }

            BluetoothConnectivityEvent.DISCOVERY_READY ->
                when (current) {
                    BluetoothConnectivityState.STARTING,
                    BluetoothConnectivityState.DEGRADED,
                    BluetoothConnectivityState.BACKOFF ->
                        transition(event, current, BluetoothConnectivityState.DISCOVERING)
                    BluetoothConnectivityState.DISCOVERING,
                    BluetoothConnectivityState.DIRECT_SERVER,
                    BluetoothConnectivityState.PEER_CONNECTED ->
                        idempotent(event, current)
                    BluetoothConnectivityState.DISABLED,
                    BluetoothConnectivityState.PERMISSION_REQUIRED,
                    BluetoothConnectivityState.STOPPED ->
                        invalid(event, current)
                }

            BluetoothConnectivityEvent.FUTURE_DIRECT_SERVER_READY ->
                evaluateFutureDirectServer(current, event)

            BluetoothConnectivityEvent.FUTURE_PEER_CONNECTED ->
                evaluateFuturePeerConnected(current, event)

            BluetoothConnectivityEvent.FUTURE_PEER_DISCONNECTED ->
                evaluateFuturePeerDisconnected(current, event)

            BluetoothConnectivityEvent.FAULT_DETECTED ->
                when (current) {
                    BluetoothConnectivityState.STARTING,
                    BluetoothConnectivityState.DISCOVERING,
                    BluetoothConnectivityState.DIRECT_SERVER,
                    BluetoothConnectivityState.PEER_CONNECTED ->
                        transition(event, current, BluetoothConnectivityState.DEGRADED)
                    BluetoothConnectivityState.DEGRADED,
                    BluetoothConnectivityState.BACKOFF ->
                        idempotent(event, current)
                    BluetoothConnectivityState.DISABLED,
                    BluetoothConnectivityState.PERMISSION_REQUIRED,
                    BluetoothConnectivityState.STOPPED ->
                        invalid(event, current)
                }

            BluetoothConnectivityEvent.BACKOFF_REQUESTED ->
                when (current) {
                    BluetoothConnectivityState.STARTING,
                    BluetoothConnectivityState.DISCOVERING,
                    BluetoothConnectivityState.DIRECT_SERVER,
                    BluetoothConnectivityState.PEER_CONNECTED,
                    BluetoothConnectivityState.DEGRADED ->
                        transition(event, current, BluetoothConnectivityState.BACKOFF)
                    BluetoothConnectivityState.BACKOFF ->
                        idempotent(event, current)
                    BluetoothConnectivityState.DISABLED,
                    BluetoothConnectivityState.PERMISSION_REQUIRED,
                    BluetoothConnectivityState.STOPPED ->
                        invalid(event, current)
                }

            BluetoothConnectivityEvent.BACKOFF_EXPIRED ->
                when (current) {
                    BluetoothConnectivityState.BACKOFF ->
                        transition(event, current, BluetoothConnectivityState.STARTING)
                    BluetoothConnectivityState.STARTING ->
                        idempotent(event, current)
                    else ->
                        invalid(event, current)
                }

            BluetoothConnectivityEvent.STOP_REQUESTED ->
                transition(event, current, BluetoothConnectivityState.STOPPED)
        }

    private fun evaluateFutureDirectServer(
        current: BluetoothConnectivityState,
        event: BluetoothConnectivityEvent
    ): BluetoothConnectivityTransition {
        if (!futureConnectivityEventsEnabled) return futureGuarded(event, current)
        return when (current) {
            BluetoothConnectivityState.DISCOVERING ->
                transition(event, current, BluetoothConnectivityState.DIRECT_SERVER)
            BluetoothConnectivityState.DIRECT_SERVER,
            BluetoothConnectivityState.PEER_CONNECTED ->
                idempotent(event, current)
            else ->
                invalid(event, current)
        }
    }

    private fun evaluateFuturePeerConnected(
        current: BluetoothConnectivityState,
        event: BluetoothConnectivityEvent
    ): BluetoothConnectivityTransition {
        if (!futureConnectivityEventsEnabled) return futureGuarded(event, current)
        return when (current) {
            BluetoothConnectivityState.DISCOVERING,
            BluetoothConnectivityState.DIRECT_SERVER ->
                transition(event, current, BluetoothConnectivityState.PEER_CONNECTED)
            BluetoothConnectivityState.PEER_CONNECTED ->
                idempotent(event, current)
            else ->
                invalid(event, current)
        }
    }

    private fun evaluateFuturePeerDisconnected(
        current: BluetoothConnectivityState,
        event: BluetoothConnectivityEvent
    ): BluetoothConnectivityTransition {
        if (!futureConnectivityEventsEnabled) return futureGuarded(event, current)
        return when (current) {
            BluetoothConnectivityState.PEER_CONNECTED ->
                transition(event, current, BluetoothConnectivityState.DISCOVERING)
            BluetoothConnectivityState.DISCOVERING,
            BluetoothConnectivityState.DIRECT_SERVER ->
                idempotent(event, current)
            else ->
                invalid(event, current)
        }
    }

    private fun transition(
        event: BluetoothConnectivityEvent,
        from: BluetoothConnectivityState,
        to: BluetoothConnectivityState
    ): BluetoothConnectivityTransition =
        if (from == to) {
            idempotent(event, from)
        } else {
            BluetoothConnectivityTransition(
                event = event,
                from = from,
                to = to,
                disposition = BluetoothConnectivityTransitionDisposition.TRANSITIONED
            )
        }

    private fun idempotent(
        event: BluetoothConnectivityEvent,
        state: BluetoothConnectivityState
    ) = BluetoothConnectivityTransition(
        event = event,
        from = state,
        to = state,
        disposition = BluetoothConnectivityTransitionDisposition.IDEMPOTENT
    )

    private fun invalid(
        event: BluetoothConnectivityEvent,
        state: BluetoothConnectivityState
    ) = BluetoothConnectivityTransition(
        event = event,
        from = state,
        to = state,
        disposition = BluetoothConnectivityTransitionDisposition.INVALID
    )

    private fun futureGuarded(
        event: BluetoothConnectivityEvent,
        state: BluetoothConnectivityState
    ) = BluetoothConnectivityTransition(
        event = event,
        from = state,
        to = state,
        disposition = BluetoothConnectivityTransitionDisposition.FUTURE_GUARDED
    )
}
