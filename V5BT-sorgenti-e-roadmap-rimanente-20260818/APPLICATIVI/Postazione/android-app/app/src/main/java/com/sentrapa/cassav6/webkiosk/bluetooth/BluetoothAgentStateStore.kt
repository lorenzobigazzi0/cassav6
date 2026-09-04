package com.sentrapa.cassav6.webkiosk.bluetooth

import java.util.concurrent.atomic.AtomicBoolean

data class BluetoothAgentStateSnapshot(
    val schemaVersion: Int,
    val source: String,
    val sequence: Long,
    val state: BluetoothConnectivityState
) {
    init {
        require(schemaVersion == BluetoothAgentStateStore.SCHEMA_VERSION)
        require(source == BluetoothAgentStateStore.SOURCE)
        require(sequence >= 0L)
    }

    fun toRedactedWebViewJson(): String =
        "{\"schemaVersion\":$schemaVersion," +
            "\"source\":\"$source\"," +
            "\"sequence\":$sequence," +
            "\"state\":\"${state.name}\"}"
}

class BluetoothAgentStateSubscription internal constructor(
    private val closeAction: () -> Unit
) : AutoCloseable {
    private val closed = AtomicBoolean(false)

    override fun close() {
        if (closed.compareAndSet(false, true)) closeAction()
    }
}

class BluetoothAgentStateStore(
    initialState: BluetoothConnectivityState = BluetoothConnectivityState.DISABLED,
    private val maximumListeners: Int = MAX_LISTENERS
) {
    private val lock = Any()
    private val listeners = linkedMapOf<Long, ListenerRegistration>()
    private var nextListenerId = 1L
    private var current = BluetoothAgentStateSnapshot(
        schemaVersion = SCHEMA_VERSION,
        source = SOURCE,
        sequence = 0L,
        state = initialState
    )

    init {
        require(maximumListeners in 1..MAX_LISTENERS)
    }

    fun snapshot(): BluetoothAgentStateSnapshot = synchronized(lock) { current }

    fun publish(state: BluetoothConnectivityState): BluetoothAgentStateSnapshot {
        val publication: Pair<BluetoothAgentStateSnapshot, List<ListenerRegistration>> =
            synchronized(lock) {
                if (current.state == state) return current
                check(current.sequence < Long.MAX_VALUE) {
                    "Bluetooth agent state sequence exhausted"
                }
                current = current.copy(sequence = current.sequence + 1L, state = state)
                current to listeners.values.toList()
            }
        publication.second.forEach { registration ->
            registration.deliver(publication.first)
        }
        return publication.first
    }

    fun addListener(
        emitCurrent: Boolean = true,
        listener: (BluetoothAgentStateSnapshot) -> Unit
    ): BluetoothAgentStateSubscription? {
        val registration: ListenerRegistration
        val listenerId: Long
        val initialSnapshot: BluetoothAgentStateSnapshot
        synchronized(lock) {
            if (listeners.size >= maximumListeners) return null
            check(nextListenerId < Long.MAX_VALUE) {
                "Bluetooth agent listener identifier exhausted"
            }
            listenerId = nextListenerId
            nextListenerId += 1L
            registration = ListenerRegistration(listener)
            listeners[listenerId] = registration
            initialSnapshot = current
        }
        if (emitCurrent) registration.deliver(initialSnapshot)
        return BluetoothAgentStateSubscription {
            synchronized(lock) {
                listeners.remove(listenerId)?.deactivate()
            }
        }
    }

    internal fun listenerCount(): Int = synchronized(lock) { listeners.size }

    private class ListenerRegistration(
        private val listener: (BluetoothAgentStateSnapshot) -> Unit
    ) {
        private var active = true
        private var lastDeliveredSequence = -1L

        @Synchronized
        fun deliver(snapshot: BluetoothAgentStateSnapshot) {
            if (!active || snapshot.sequence <= lastDeliveredSequence) return
            lastDeliveredSequence = snapshot.sequence
            runCatching { listener(snapshot) }
        }

        @Synchronized
        fun deactivate() {
            active = false
        }
    }

    companion object {
        const val SCHEMA_VERSION = 1
        const val SOURCE = "CASSA_V6_ANDROID_CONNECTIVITY_AGENT"
        const val MAX_LISTENERS = 32
    }
}
