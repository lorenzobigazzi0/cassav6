package com.sentrapa.cassav6.webkiosk.bluetooth

enum class BluetoothReliableEndpointSourceV1 {
    CLIENT,
    SERVER
}

fun interface AndroidGattReliablePortListenerV1 {
    fun onChanged(port: BluetoothReliableApplicationPortV1?): Boolean
}

interface BluetoothReliableRuntimeLifecycleV1 {
    fun start(): Boolean

    fun suspendForLinkLoss()
}

internal object AndroidPeerTrustLeaseBoundaryV2 {
    fun enforce(
        ready: Boolean,
        arbiter: BluetoothReliableEndpointArbiterV1?,
        revalidateClient: () -> Boolean,
        revalidateServer: () -> Boolean,
        abortClient: () -> Unit,
        abortServer: () -> Unit
    ): Boolean {
        val clientValid = ready && runCatching(revalidateClient).getOrDefault(false)
        val serverValid = ready && runCatching(revalidateServer).getOrDefault(false)
        if (clientValid && serverValid) return true

        runCatching {
            arbiter?.onPortChanged(BluetoothReliableEndpointSourceV1.CLIENT, null)
        }
        runCatching {
            arbiter?.onPortChanged(BluetoothReliableEndpointSourceV1.SERVER, null)
        }
        runCatching(abortClient)
        runCatching(abortServer)
        return false
    }
}

data class BluetoothReliableEndpointArbiterSnapshotV1(
    val clientActive: Boolean,
    val serverActive: Boolean,
    val accepted: Long,
    val released: Long,
    val duplicateRejected: Long,
    val conflictRejected: Long,
    val startRejected: Long
) {
    val rejected: Long
        get() = duplicateRejected + conflictRejected + startRejected
}

class BluetoothReliableEndpointArbiterV1(
    private val multiplexer: BluetoothReliableApplicationPortMultiplexerV1,
    private val runtime: BluetoothReliableRuntimeLifecycleV1
) : AutoCloseable {
    private var clientLease: BluetoothReliableApplicationPortLeaseV1? = null
    private var serverLease: BluetoothReliableApplicationPortLeaseV1? = null
    private var accepted = 0L
    private var released = 0L
    private var duplicateRejected = 0L
    private var conflictRejected = 0L
    private var startRejected = 0L
    private var closed = false

    @Synchronized
    fun onPortChanged(
        source: BluetoothReliableEndpointSourceV1,
        port: BluetoothReliableApplicationPortV1?
    ): Boolean {
        if (closed) return false
        val current = lease(source)
        if (port == null) {
            if (current == null) return true
            runtime.suspendForLinkLoss()
            multiplexer.unbind(current)
            setLease(source, null)
            released += 1
            return true
        }
        if (current != null) {
            duplicateRejected += 1
            return false
        }
        if (lease(opposite(source)) != null) {
            conflictRejected += 1
            return false
        }
        val next = runCatching { multiplexer.bind(port) }.getOrNull()
        if (next == null) {
            startRejected += 1
            return false
        }
        setLease(source, next)
        val started = runCatching { runtime.start() }.getOrDefault(false)
        if (!started) {
            setLease(source, null)
            multiplexer.unbind(next)
            startRejected += 1
            return false
        }
        accepted += 1
        return true
    }

    @Synchronized
    fun onRuntimeFatal(): BluetoothReliableEndpointSourceV1? {
        if (closed) return null
        val source = when {
            clientLease != null -> BluetoothReliableEndpointSourceV1.CLIENT
            serverLease != null -> BluetoothReliableEndpointSourceV1.SERVER
            else -> return null
        }
        val current = checkNotNull(lease(source))
        setLease(source, null)
        multiplexer.unbind(current)
        released += 1
        return source
    }

    @Synchronized
    fun snapshot(): BluetoothReliableEndpointArbiterSnapshotV1 =
        BluetoothReliableEndpointArbiterSnapshotV1(
            clientActive = clientLease != null,
            serverActive = serverLease != null,
            accepted = accepted,
            released = released,
            duplicateRejected = duplicateRejected,
            conflictRejected = conflictRejected,
            startRejected = startRejected
        )

    @Synchronized
    override fun close() {
        if (closed) return
        if (clientLease != null || serverLease != null) runtime.suspendForLinkLoss()
        clientLease?.let(multiplexer::unbind)
        serverLease?.let(multiplexer::unbind)
        clientLease = null
        serverLease = null
        multiplexer.close()
        closed = true
    }

    private fun lease(
        source: BluetoothReliableEndpointSourceV1
    ): BluetoothReliableApplicationPortLeaseV1? = when (source) {
        BluetoothReliableEndpointSourceV1.CLIENT -> clientLease
        BluetoothReliableEndpointSourceV1.SERVER -> serverLease
    }

    private fun setLease(
        source: BluetoothReliableEndpointSourceV1,
        value: BluetoothReliableApplicationPortLeaseV1?
    ) {
        when (source) {
            BluetoothReliableEndpointSourceV1.CLIENT -> clientLease = value
            BluetoothReliableEndpointSourceV1.SERVER -> serverLease = value
        }
    }

    private fun opposite(
        source: BluetoothReliableEndpointSourceV1
    ): BluetoothReliableEndpointSourceV1 = when (source) {
        BluetoothReliableEndpointSourceV1.CLIENT -> BluetoothReliableEndpointSourceV1.SERVER
        BluetoothReliableEndpointSourceV1.SERVER -> BluetoothReliableEndpointSourceV1.CLIENT
    }
}
