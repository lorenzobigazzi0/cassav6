package com.sentrapa.webkiosk.bluetooth

enum class AndroidGattClientState {
    IDLE,
    CONNECTING,
    DISCOVERING_SERVICES,
    NEGOTIATING_MTU,
    READY,
    WRITING_HELLO,
    READING_HELLO,
    HELLO_EXCHANGED,
    AUTH_SUBSCRIBING,
    AUTH_WRITING_CLIENT_PROOF,
    AUTH_WAITING_SERVER_PROOF,
    AUTH_WRITING_FINISH,
    AUTHENTICATED,
    KEY_WRITING_CLIENT_SHARE,
    KEY_WAITING_SERVER_SHARE,
    KEY_WRITING_CLIENT_CONFIRM,
    KEY_ESTABLISHED,
    ACTIVATION_PROBING,
    ACTIVE,
    HEARTBEAT_WRITING_PONG,
    CLOSING,
    FAILED,
    CLOSED
}

enum class AndroidGattClientEvent {
    CONNECT_REQUESTED,
    GATT_CONNECTED,
    SERVICES_VALIDATED,
    MTU_NEGOTIATED,
    HELLO_WRITE_REQUESTED,
    HELLO_WRITTEN,
    HELLO_ACCEPTED,
    AUTH_SUBSCRIBE_REQUESTED,
    AUTH_SUBSCRIBED,
    AUTH_CLIENT_PROOF_WRITTEN,
    AUTH_SERVER_PROOF_VERIFIED,
    AUTH_FINISH_WRITTEN,
    ANDROID_PEER_SESSION_ESTABLISHED,
    SESSION_KEY_START_REQUESTED,
    CLIENT_KEY_SHARE_WRITTEN,
    SERVER_KEY_SHARE_VERIFIED,
    CLIENT_KEY_CONFIRM_WRITTEN,
    ACTIVATION_PING_RECEIVED,
    ACTIVATION_PONG_WRITTEN,
    HEARTBEAT_PING_RECEIVED,
    HEARTBEAT_PONG_WRITTEN,
    CLOSE_FRAME_RECEIVED,
    CLOSE_ACK_WRITTEN,
    CLOSE_ACK_RECEIVED,
    DISCONNECTED,
    FAILURE,
    CLOSE_REQUESTED,
    RESET
}

enum class AndroidGattClientTransitionDisposition {
    TRANSITIONED,
    IDEMPOTENT,
    REJECTED
}

data class AndroidGattClientTransition(
    val event: AndroidGattClientEvent,
    val from: AndroidGattClientState,
    val to: AndroidGattClientState,
    val disposition: AndroidGattClientTransitionDisposition
) {
    val changed: Boolean
        get() =
            disposition == AndroidGattClientTransitionDisposition.TRANSITIONED &&
                from != to
}

class AndroidGattClientStateMachine(
    initialState: AndroidGattClientState = AndroidGattClientState.IDLE
) {
    private val lock = Any()

    @Volatile
    private var currentState = initialState

    val state: AndroidGattClientState
        get() = currentState

    fun dispatch(
        event: AndroidGattClientEvent,
        mtu: Int? = null
    ): AndroidGattClientTransition =
        synchronized(lock) {
            evaluate(currentState, event, mtu).also { transition ->
                if (transition.changed) currentState = transition.to
            }
        }

    private fun evaluate(
        current: AndroidGattClientState,
        event: AndroidGattClientEvent,
        mtu: Int?
    ): AndroidGattClientTransition {
        if (
            (event == AndroidGattClientEvent.MTU_NEGOTIATED) != (mtu != null) ||
            (mtu != null && !AndroidGattProfileV1.isValidMtu(mtu))
        ) {
            return reject(event, current)
        }
        return when (event) {
            AndroidGattClientEvent.CONNECT_REQUESTED ->
                when (current) {
                    AndroidGattClientState.IDLE ->
                        transition(event, current, AndroidGattClientState.CONNECTING)
                    AndroidGattClientState.CONNECTING ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.GATT_CONNECTED ->
                when (current) {
                    AndroidGattClientState.CONNECTING ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.DISCOVERING_SERVICES
                        )
                    AndroidGattClientState.DISCOVERING_SERVICES ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.SERVICES_VALIDATED ->
                when (current) {
                    AndroidGattClientState.DISCOVERING_SERVICES ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.NEGOTIATING_MTU
                        )
                    AndroidGattClientState.NEGOTIATING_MTU ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.MTU_NEGOTIATED ->
                when (current) {
                    AndroidGattClientState.NEGOTIATING_MTU ->
                        transition(event, current, AndroidGattClientState.READY)
                    AndroidGattClientState.READY ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.HELLO_WRITE_REQUESTED ->
                when (current) {
                    AndroidGattClientState.READY ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.WRITING_HELLO
                        )
                    AndroidGattClientState.WRITING_HELLO ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.HELLO_WRITTEN ->
                when (current) {
                    AndroidGattClientState.WRITING_HELLO ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.READING_HELLO
                        )
                    AndroidGattClientState.READING_HELLO ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.HELLO_ACCEPTED ->
                when (current) {
                    AndroidGattClientState.READING_HELLO ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.HELLO_EXCHANGED
                        )
                    AndroidGattClientState.HELLO_EXCHANGED ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.AUTH_SUBSCRIBE_REQUESTED ->
                when (current) {
                    AndroidGattClientState.HELLO_EXCHANGED ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.AUTH_SUBSCRIBING
                        )
                    AndroidGattClientState.AUTH_SUBSCRIBING ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.AUTH_SUBSCRIBED ->
                when (current) {
                    AndroidGattClientState.AUTH_SUBSCRIBING ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.AUTH_WRITING_CLIENT_PROOF
                        )
                    AndroidGattClientState.AUTH_WRITING_CLIENT_PROOF ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.AUTH_CLIENT_PROOF_WRITTEN ->
                when (current) {
                    AndroidGattClientState.AUTH_WRITING_CLIENT_PROOF ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.AUTH_WAITING_SERVER_PROOF
                        )
                    AndroidGattClientState.AUTH_WAITING_SERVER_PROOF ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.AUTH_SERVER_PROOF_VERIFIED ->
                when (current) {
                    AndroidGattClientState.AUTH_WAITING_SERVER_PROOF ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.AUTH_WRITING_FINISH
                        )
                    AndroidGattClientState.AUTH_WRITING_FINISH ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.AUTH_FINISH_WRITTEN ->
                when (current) {
                    AndroidGattClientState.AUTH_WRITING_FINISH ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.AUTHENTICATED
                        )
                    AndroidGattClientState.AUTHENTICATED ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.ANDROID_PEER_SESSION_ESTABLISHED ->
                when (current) {
                    AndroidGattClientState.AUTH_WRITING_FINISH ->
                        transition(event, current, AndroidGattClientState.ACTIVE)
                    AndroidGattClientState.ACTIVE ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.SESSION_KEY_START_REQUESTED ->
                when (current) {
                    AndroidGattClientState.AUTHENTICATED ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.KEY_WRITING_CLIENT_SHARE
                        )
                    AndroidGattClientState.KEY_WRITING_CLIENT_SHARE ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.CLIENT_KEY_SHARE_WRITTEN ->
                when (current) {
                    AndroidGattClientState.KEY_WRITING_CLIENT_SHARE ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.KEY_WAITING_SERVER_SHARE
                        )
                    AndroidGattClientState.KEY_WAITING_SERVER_SHARE ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.SERVER_KEY_SHARE_VERIFIED ->
                when (current) {
                    AndroidGattClientState.KEY_WAITING_SERVER_SHARE ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.KEY_WRITING_CLIENT_CONFIRM
                        )
                    AndroidGattClientState.KEY_WRITING_CLIENT_CONFIRM ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.CLIENT_KEY_CONFIRM_WRITTEN ->
                when (current) {
                    AndroidGattClientState.KEY_WRITING_CLIENT_CONFIRM ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.KEY_ESTABLISHED
                        )
                    AndroidGattClientState.KEY_ESTABLISHED ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.ACTIVATION_PING_RECEIVED ->
                when (current) {
                    AndroidGattClientState.KEY_ESTABLISHED ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.ACTIVATION_PROBING
                        )
                    AndroidGattClientState.ACTIVATION_PROBING ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.ACTIVATION_PONG_WRITTEN ->
                when (current) {
                    AndroidGattClientState.ACTIVATION_PROBING ->
                        transition(event, current, AndroidGattClientState.ACTIVE)
                    AndroidGattClientState.ACTIVE ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.HEARTBEAT_PING_RECEIVED ->
                when (current) {
                    AndroidGattClientState.ACTIVE ->
                        transition(
                            event,
                            current,
                            AndroidGattClientState.HEARTBEAT_WRITING_PONG
                        )
                    AndroidGattClientState.HEARTBEAT_WRITING_PONG ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.HEARTBEAT_PONG_WRITTEN ->
                when (current) {
                    AndroidGattClientState.HEARTBEAT_WRITING_PONG ->
                        transition(event, current, AndroidGattClientState.ACTIVE)
                    AndroidGattClientState.ACTIVE ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.CLOSE_FRAME_RECEIVED ->
                when (current) {
                    AndroidGattClientState.KEY_ESTABLISHED,
                    AndroidGattClientState.ACTIVATION_PROBING,
                    AndroidGattClientState.ACTIVE,
                    AndroidGattClientState.HEARTBEAT_WRITING_PONG ->
                        transition(event, current, AndroidGattClientState.CLOSING)
                    AndroidGattClientState.CLOSING ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.CLOSE_ACK_WRITTEN,
            AndroidGattClientEvent.CLOSE_ACK_RECEIVED ->
                when (current) {
                    AndroidGattClientState.CLOSING ->
                        transition(event, current, AndroidGattClientState.CLOSED)
                    AndroidGattClientState.CLOSED ->
                        idempotent(event, current)
                    else ->
                        reject(event, current)
                }
            AndroidGattClientEvent.DISCONNECTED ->
                when (current) {
                    AndroidGattClientState.IDLE,
                    AndroidGattClientState.FAILED,
                    AndroidGattClientState.CLOSED ->
                        idempotent(event, current)
                    AndroidGattClientState.CLOSING ->
                        transition(event, current, AndroidGattClientState.CLOSED)
                    else ->
                        transition(event, current, AndroidGattClientState.FAILED)
                }
            AndroidGattClientEvent.FAILURE ->
                when (current) {
                    AndroidGattClientState.FAILED,
                    AndroidGattClientState.CLOSED ->
                        idempotent(event, current)
                    else ->
                        transition(event, current, AndroidGattClientState.FAILED)
                }
            AndroidGattClientEvent.CLOSE_REQUESTED ->
                when (current) {
                    AndroidGattClientState.CLOSED ->
                        idempotent(event, current)
                    AndroidGattClientState.KEY_ESTABLISHED,
                    AndroidGattClientState.ACTIVATION_PROBING,
                    AndroidGattClientState.ACTIVE,
                    AndroidGattClientState.HEARTBEAT_WRITING_PONG ->
                        transition(event, current, AndroidGattClientState.CLOSING)
                    AndroidGattClientState.CLOSING ->
                        idempotent(event, current)
                    else ->
                        transition(event, current, AndroidGattClientState.CLOSED)
                }
            AndroidGattClientEvent.RESET ->
                when (current) {
                    AndroidGattClientState.IDLE ->
                        idempotent(event, current)
                    AndroidGattClientState.FAILED,
                    AndroidGattClientState.CLOSED ->
                        transition(event, current, AndroidGattClientState.IDLE)
                    else ->
                        reject(event, current)
                }
        }
    }

    private fun transition(
        event: AndroidGattClientEvent,
        from: AndroidGattClientState,
        to: AndroidGattClientState
    ) = AndroidGattClientTransition(
        event = event,
        from = from,
        to = to,
        disposition = AndroidGattClientTransitionDisposition.TRANSITIONED
    )

    private fun idempotent(
        event: AndroidGattClientEvent,
        state: AndroidGattClientState
    ) = AndroidGattClientTransition(
        event = event,
        from = state,
        to = state,
        disposition = AndroidGattClientTransitionDisposition.IDEMPOTENT
    )

    private fun reject(
        event: AndroidGattClientEvent,
        state: AndroidGattClientState
    ) = AndroidGattClientTransition(
            event = event,
            from = state,
            to = state,
            disposition = AndroidGattClientTransitionDisposition.REJECTED
        )
}

data class AndroidGattClientMetricsSnapshot(
    val connectionAttempts: Long,
    val connectionsEstablished: Long,
    val servicesValidated: Long,
    val mtuNegotiated: Long,
    val helloWritesStarted: Long = 0L,
    val helloWritesCompleted: Long = 0L,
    val helloReadsCompleted: Long = 0L,
    val helloExchanged: Long = 0L,
    val authSubscriptionsStarted: Long = 0L,
    val authSubscriptionsCompleted: Long = 0L,
    val clientProofWritesCompleted: Long = 0L,
    val serverProofsVerified: Long = 0L,
    val authFinishWritesCompleted: Long = 0L,
    val authenticatedSessions: Long = 0L,
    val keyExchangesStarted: Long = 0L,
    val clientKeySharesWritten: Long = 0L,
    val serverKeySharesVerified: Long = 0L,
    val clientKeyConfirmsWritten: Long = 0L,
    val keysEstablished: Long = 0L,
    val activationPingsReceived: Long = 0L,
    val activationPongsWritten: Long = 0L,
    val activeSessions: Long = 0L,
    val heartbeatPingsReceived: Long = 0L,
    val heartbeatPongsWritten: Long = 0L,
    val closeFramesReceived: Long = 0L,
    val cleanCloses: Long = 0L,
    val disconnects: Long,
    val failures: Long,
    val closes: Long
)

class AndroidGattClientMetrics {
    private var connectionAttempts = 0L
    private var connectionsEstablished = 0L
    private var servicesValidated = 0L
    private var mtuNegotiated = 0L
    private var helloWritesStarted = 0L
    private var helloWritesCompleted = 0L
    private var helloReadsCompleted = 0L
    private var helloExchanged = 0L
    private var authSubscriptionsStarted = 0L
    private var authSubscriptionsCompleted = 0L
    private var clientProofWritesCompleted = 0L
    private var serverProofsVerified = 0L
    private var authFinishWritesCompleted = 0L
    private var authenticatedSessions = 0L
    private var keyExchangesStarted = 0L
    private var clientKeySharesWritten = 0L
    private var serverKeySharesVerified = 0L
    private var clientKeyConfirmsWritten = 0L
    private var keysEstablished = 0L
    private var activationPingsReceived = 0L
    private var activationPongsWritten = 0L
    private var activeSessions = 0L
    private var heartbeatPingsReceived = 0L
    private var heartbeatPongsWritten = 0L
    private var closeFramesReceived = 0L
    private var cleanCloses = 0L
    private var disconnects = 0L
    private var failures = 0L
    private var closes = 0L

    @Synchronized
    fun record(transition: AndroidGattClientTransition) {
        if (
            transition.event == AndroidGattClientEvent.CONNECT_REQUESTED &&
            transition.changed
        ) {
            connectionAttempts = increment(connectionAttempts)
        }
        if (
            transition.event == AndroidGattClientEvent.GATT_CONNECTED &&
            transition.changed
        ) {
            connectionsEstablished = increment(connectionsEstablished)
        }
        if (
            transition.event == AndroidGattClientEvent.SERVICES_VALIDATED &&
            transition.changed
        ) {
            servicesValidated = increment(servicesValidated)
        }
        if (
            transition.event == AndroidGattClientEvent.MTU_NEGOTIATED &&
            transition.changed
        ) {
            mtuNegotiated = increment(mtuNegotiated)
        }
        if (
            transition.event == AndroidGattClientEvent.HELLO_WRITE_REQUESTED &&
            transition.changed
        ) {
            helloWritesStarted = increment(helloWritesStarted)
        }
        if (
            transition.event == AndroidGattClientEvent.HELLO_WRITTEN &&
            transition.changed
        ) {
            helloWritesCompleted = increment(helloWritesCompleted)
        }
        if (
            transition.event == AndroidGattClientEvent.HELLO_ACCEPTED &&
            transition.changed
        ) {
            helloReadsCompleted = increment(helloReadsCompleted)
            helloExchanged = increment(helloExchanged)
        }
        if (
            transition.event == AndroidGattClientEvent.AUTH_SUBSCRIBE_REQUESTED &&
            transition.changed
        ) {
            authSubscriptionsStarted = increment(authSubscriptionsStarted)
        }
        if (
            transition.event == AndroidGattClientEvent.AUTH_SUBSCRIBED &&
            transition.changed
        ) {
            authSubscriptionsCompleted = increment(authSubscriptionsCompleted)
        }
        if (
            transition.event == AndroidGattClientEvent.AUTH_CLIENT_PROOF_WRITTEN &&
            transition.changed
        ) {
            clientProofWritesCompleted = increment(clientProofWritesCompleted)
        }
        if (
            transition.event == AndroidGattClientEvent.AUTH_SERVER_PROOF_VERIFIED &&
            transition.changed
        ) {
            serverProofsVerified = increment(serverProofsVerified)
        }
        if (
            transition.event == AndroidGattClientEvent.AUTH_FINISH_WRITTEN &&
            transition.changed
        ) {
            authFinishWritesCompleted = increment(authFinishWritesCompleted)
            authenticatedSessions = increment(authenticatedSessions)
        }
        if (
            transition.event == AndroidGattClientEvent.SESSION_KEY_START_REQUESTED &&
            transition.changed
        ) {
            keyExchangesStarted = increment(keyExchangesStarted)
        }
        if (
            transition.event == AndroidGattClientEvent.CLIENT_KEY_SHARE_WRITTEN &&
            transition.changed
        ) {
            clientKeySharesWritten = increment(clientKeySharesWritten)
        }
        if (
            transition.event == AndroidGattClientEvent.SERVER_KEY_SHARE_VERIFIED &&
            transition.changed
        ) {
            serverKeySharesVerified = increment(serverKeySharesVerified)
        }
        if (
            transition.event == AndroidGattClientEvent.CLIENT_KEY_CONFIRM_WRITTEN &&
            transition.changed
        ) {
            clientKeyConfirmsWritten = increment(clientKeyConfirmsWritten)
            keysEstablished = increment(keysEstablished)
        }
        if (
            transition.event == AndroidGattClientEvent.ACTIVATION_PING_RECEIVED &&
            transition.changed
        ) {
            activationPingsReceived = increment(activationPingsReceived)
        }
        if (
            transition.event == AndroidGattClientEvent.ACTIVATION_PONG_WRITTEN &&
            transition.changed
        ) {
            activationPongsWritten = increment(activationPongsWritten)
            activeSessions = increment(activeSessions)
        }
        if (
            transition.event == AndroidGattClientEvent.HEARTBEAT_PING_RECEIVED &&
            transition.changed
        ) {
            heartbeatPingsReceived = increment(heartbeatPingsReceived)
        }
        if (
            transition.event == AndroidGattClientEvent.HEARTBEAT_PONG_WRITTEN &&
            transition.changed
        ) {
            heartbeatPongsWritten = increment(heartbeatPongsWritten)
        }
        if (
            transition.event == AndroidGattClientEvent.CLOSE_FRAME_RECEIVED &&
            transition.changed
        ) {
            closeFramesReceived = increment(closeFramesReceived)
        }
        if (
            transition.event in setOf(
                AndroidGattClientEvent.CLOSE_ACK_WRITTEN,
                AndroidGattClientEvent.CLOSE_ACK_RECEIVED
            ) && transition.changed
        ) {
            cleanCloses = increment(cleanCloses)
        }
        if (transition.event == AndroidGattClientEvent.DISCONNECTED) {
            disconnects = increment(disconnects)
        }
        if (
            transition.to == AndroidGattClientState.FAILED &&
            transition.from != AndroidGattClientState.FAILED
        ) {
            failures = increment(failures)
        }
        if (
            transition.event == AndroidGattClientEvent.CLOSE_REQUESTED &&
            transition.changed
        ) {
            closes = increment(closes)
        }
    }

    @Synchronized
    fun snapshot() = AndroidGattClientMetricsSnapshot(
        connectionAttempts = connectionAttempts,
        connectionsEstablished = connectionsEstablished,
        servicesValidated = servicesValidated,
        mtuNegotiated = mtuNegotiated,
        helloWritesStarted = helloWritesStarted,
        helloWritesCompleted = helloWritesCompleted,
        helloReadsCompleted = helloReadsCompleted,
        helloExchanged = helloExchanged,
        authSubscriptionsStarted = authSubscriptionsStarted,
        authSubscriptionsCompleted = authSubscriptionsCompleted,
        clientProofWritesCompleted = clientProofWritesCompleted,
        serverProofsVerified = serverProofsVerified,
        authFinishWritesCompleted = authFinishWritesCompleted,
        authenticatedSessions = authenticatedSessions,
        keyExchangesStarted = keyExchangesStarted,
        clientKeySharesWritten = clientKeySharesWritten,
        serverKeySharesVerified = serverKeySharesVerified,
        clientKeyConfirmsWritten = clientKeyConfirmsWritten,
        keysEstablished = keysEstablished,
        activationPingsReceived = activationPingsReceived,
        activationPongsWritten = activationPongsWritten,
        activeSessions = activeSessions,
        heartbeatPingsReceived = heartbeatPingsReceived,
        heartbeatPongsWritten = heartbeatPongsWritten,
        closeFramesReceived = closeFramesReceived,
        cleanCloses = cleanCloses,
        disconnects = disconnects,
        failures = failures,
        closes = closes
    )

    private fun increment(value: Long): Long =
        if (value == Long.MAX_VALUE) Long.MAX_VALUE else value + 1L
}
