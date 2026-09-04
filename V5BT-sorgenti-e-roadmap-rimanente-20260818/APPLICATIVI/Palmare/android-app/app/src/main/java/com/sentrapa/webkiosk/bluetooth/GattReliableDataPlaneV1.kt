package com.sentrapa.webkiosk.bluetooth

enum class GattReliableEndpointRoleV1 {
    CLIENT,
    SERVER
}

enum class GattReliableTransmitterV1 {
    DATA,
    ACK
}

class GattReliableChannelContextV1(
    val peerTrustId: String,
    val mtu: Int,
    val role: GattReliableEndpointRoleV1,
    val material: ReliableChannelMaterialV1
) : AutoCloseable {
    init {
        if (
            mtu !in ReliableFrameCodecV1.MINIMUM_GATT_MTU..
            ReliableFrameCodecV1.MAXIMUM_GATT_MTU ||
            !Regex("^[0-9a-f]{64}$").matches(peerTrustId) ||
            material.isClosed
        ) {
            material.close()
            gattReliableDataPlaneFailureV1(
                "INVALID_RELIABLE_CONTEXT",
                "reliable GATT context is not canonical"
            )
        }
    }

    override fun close() {
        material.close()
    }

    override fun toString(): String =
        "GattReliableChannelContextV1(mtu=$mtu, role=$role, material=<redacted>)"
}

fun interface GattReliableSessionContextProviderV1 {
    fun export(sessionToken: Long): GattReliableChannelContextV1
}

fun interface GattReliablePublisherV1 {
    fun publish(transmitter: GattReliableTransmitterV1, frame: ByteArray)
}

data class GattReliableDataPlaneSnapshotV1(
    val enabled: Boolean,
    val bound: Boolean,
    val dataSubscribed: Boolean,
    val ackSubscribed: Boolean,
    val receivedFragments: Long,
    val publishedFragments: Long,
    val sessionBinds: Long,
    val resets: Long,
    val failures: Long,
    val channel: ReliableChannelMetricsV1?
)

class GattReliableDataPlaneExceptionV1(
    val code: String,
    message: String,
    cause: Throwable? = null
) : RuntimeException(message, cause)

internal fun gattReliableDataPlaneFailureV1(
    code: String,
    message: String,
    cause: Throwable? = null
): Nothing = throw GattReliableDataPlaneExceptionV1(code, message, cause)

class GattReliableDataPlaneV1(
    private val contextProvider: GattReliableSessionContextProviderV1,
    private val store: ReliableChannelStoreV1,
    private val onMessage: ReliableChannelMessageHandlerV1,
    private val enabled: Boolean = false,
    private val now: () -> Long = System::currentTimeMillis
) : AutoCloseable {
    private val subscriptions = mutableSetOf<GattReliableTransmitterV1>()
    private var publisher: GattReliablePublisherV1? = null
    private var channel: ReliableChannelV1? = null
    private var boundSessionToken: Long? = null
    private var boundPeerTrustId: String? = null
    private var receivedFragments = 0L
    private var publishedFragments = 0L
    private var sessionBinds = 0L
    private var resets = 0L
    private var failures = 0L
    private var closed = false

    @Synchronized
    fun setPublisher(value: GattReliablePublisherV1?) {
        assertOpen()
        publisher = value
    }

    @Synchronized
    fun setSubscription(transmitter: GattReliableTransmitterV1, enabled: Boolean) {
        assertOpen()
        assertEnabled()
        if (enabled) subscriptions += transmitter else subscriptions -= transmitter
    }

    @Synchronized
    fun receive(
        sessionToken: Long,
        frame: ByteArray
    ): ReliableChannelReceiveResultV1 {
        assertOpen()
        assertEnabled()
        assertSubscriptionsReady()
        val activeChannel = bind(sessionToken)
        receivedFragments += 1
        return try {
            activeChannel.receiveFragment(frame)
        } catch (error: Throwable) {
            failures += 1
            throw error
        }
    }

    @Synchronized
    fun send(
        sessionToken: Long,
        input: ReliableChannelSendInputV1
    ): ReliableChannelSendResultV1 {
        assertOpen()
        assertEnabled()
        assertSubscriptionsReady()
        if (input.type == ReliableFrameTypeV1.ACK) {
            gattReliableDataPlaneFailureV1(
                "ACK_RESERVED",
                "ACK is emitted only by ReliableChannelV1"
            )
        }
        return try {
            bind(sessionToken).send(input)
        } catch (error: Throwable) {
            failures += 1
            throw error
        }
    }

    @Synchronized
    fun sendBound(input: ReliableChannelSendInputV1): ReliableChannelSendResultV1 {
        val token = boundSessionToken
            ?: gattReliableDataPlaneFailureV1(
                "RELIABLE_CHANNEL_NOT_BOUND",
                "reliable data plane has no authenticated bound peer"
            )
        return send(token, input)
    }

    @Synchronized
    fun restore(sessionToken: Long): Int {
        assertOpen()
        assertEnabled()
        assertSubscriptionsReady()
        return try {
            bind(sessionToken).restoreDurableOutbox()
        } catch (error: Throwable) {
            failures += 1
            throw error
        }
    }

    @Synchronized
    fun restoreBound(): Int {
        val token = boundSessionToken
            ?: gattReliableDataPlaneFailureV1(
                "RELIABLE_CHANNEL_NOT_BOUND",
                "reliable data plane has no authenticated bound peer"
            )
        return restore(token)
    }

    @Synchronized
    fun tick(): ReliableChannelTickResultV1 {
        assertOpen()
        assertEnabled()
        return channel?.tick() ?: ReliableChannelTickResultV1(0, 0, 0)
    }

    @Synchronized
    fun reset() {
        if (closed) return
        channel?.close()
        channel = null
        boundSessionToken = null
        boundPeerTrustId = null
        subscriptions.clear()
        resets += 1
    }

    @Synchronized
    fun snapshot(): GattReliableDataPlaneSnapshotV1 =
        GattReliableDataPlaneSnapshotV1(
            enabled = enabled,
            bound = channel != null,
            dataSubscribed = subscriptions.contains(GattReliableTransmitterV1.DATA),
            ackSubscribed = subscriptions.contains(GattReliableTransmitterV1.ACK),
            receivedFragments = receivedFragments,
            publishedFragments = publishedFragments,
            sessionBinds = sessionBinds,
            resets = resets,
            failures = failures,
            channel = channel?.snapshot()
        )

    @Synchronized
    override fun close() {
        if (closed) return
        reset()
        publisher = null
        closed = true
    }

    private fun bind(sessionToken: Long): ReliableChannelV1 {
        if (sessionToken <= 0) {
            gattReliableDataPlaneFailureV1(
                "INVALID_SESSION_TOKEN",
                "session token must be positive"
            )
        }
        val existing = channel
        if (existing != null) {
            if (boundSessionToken != sessionToken) {
                gattReliableDataPlaneFailureV1(
                    "SESSION_ARBITRATION_CONFLICT",
                    "one data plane cannot bind two session contexts"
                )
            }
            try {
                contextProvider.export(sessionToken).use { fresh ->
                    if (fresh.peerTrustId != boundPeerTrustId) {
                        gattReliableDataPlaneFailureV1(
                            "PEER_TRUST_MISMATCH",
                            "bound session changed peer trust context"
                        )
                    }
                }
            } catch (error: Throwable) {
                reset()
                if (error is GattReliableDataPlaneExceptionV1) throw error
                gattReliableDataPlaneFailureV1(
                    "RELIABLE_CHANNEL_NOT_AUTHORIZED",
                    "bound session authorization could not be revalidated",
                    error
                )
            }
            return existing
        }

        val context = try {
            contextProvider.export(sessionToken)
        } catch (error: Throwable) {
            gattReliableDataPlaneFailureV1(
                "RELIABLE_CHANNEL_NOT_AUTHORIZED",
                "reliable data requires one active authenticated session",
                error
            )
        }
        try {
            val clientToServerKey = context.material.clientToServer.key
            val clientToServerNonce = context.material.clientToServer.noncePrefix
            val serverToClientKey = context.material.serverToClient.key
            val serverToClientNonce = context.material.serverToClient.noncePrefix
            try {
                val clientRole = context.role == GattReliableEndpointRoleV1.CLIENT
                channel = ReliableChannelV1(
                    transport = ReliableChannelTransportV1(::publish),
                    peerTrustId = context.peerTrustId,
                    mtu = context.mtu,
                    txKey = if (clientRole) clientToServerKey else serverToClientKey,
                    rxKey = if (clientRole) serverToClientKey else clientToServerKey,
                    txNoncePrefix = if (clientRole) {
                        clientToServerNonce
                    } else {
                        serverToClientNonce
                    },
                    rxNoncePrefix = if (clientRole) {
                        serverToClientNonce
                    } else {
                        clientToServerNonce
                    },
                    onMessage = onMessage,
                    store = store,
                    now = now
                )
            } finally {
                clientToServerKey.fill(0)
                clientToServerNonce.fill(0)
                serverToClientKey.fill(0)
                serverToClientNonce.fill(0)
            }
            boundSessionToken = sessionToken
            boundPeerTrustId = context.peerTrustId
            sessionBinds += 1
            return checkNotNull(channel)
        } finally {
            context.close()
        }
    }

    private fun publish(frame: ByteArray) {
        val decoded = ReliableFrameCodecV1.decodeFragment(frame)
        val target = try {
            if (decoded.type == ReliableFrameTypeV1.ACK) {
                GattReliableTransmitterV1.ACK
            } else {
                GattReliableTransmitterV1.DATA
            }
        } finally {
            decoded.payload.fill(0)
        }
        if (!subscriptions.contains(target)) {
            gattReliableDataPlaneFailureV1(
                "TRANSMITTER_NOT_SUBSCRIBED",
                "$target transmitter is not subscribed"
            )
        }
        val activePublisher = publisher
            ?: gattReliableDataPlaneFailureV1(
                "PUBLISHER_NOT_READY",
                "data-plane publisher is not bound"
            )
        val copy = frame.copyOf()
        try {
            activePublisher.publish(target, copy)
            publishedFragments += 1
        } finally {
            copy.fill(0)
        }
    }

    private fun assertSubscriptionsReady() {
        if (!subscriptions.contains(GattReliableTransmitterV1.DATA)) {
            gattReliableDataPlaneFailureV1(
                "DATA_SUBSCRIPTION_REQUIRED",
                "data transmitter subscription is required"
            )
        }
        if (!subscriptions.contains(GattReliableTransmitterV1.ACK)) {
            gattReliableDataPlaneFailureV1(
                "ACK_SUBSCRIPTION_REQUIRED",
                "ack transmitter subscription is required"
            )
        }
    }

    private fun assertEnabled() {
        if (!enabled) {
            gattReliableDataPlaneFailureV1(
                "DATA_PLANE_DISABLED",
                "reliable GATT data plane is disabled"
            )
        }
    }

    private fun assertOpen() {
        if (closed) {
            gattReliableDataPlaneFailureV1(
                "DATA_PLANE_CLOSED",
                "reliable GATT data plane is closed"
            )
        }
    }
}

class GattReliableApplicationChannelV1(
    private val dataPlane: GattReliableDataPlaneV1
) : BluetoothShadowChannelV1, RouteAdvertisementChannelV1 {
    override fun send(input: ReliableChannelSendInputV1): ReliableChannelSendResultV1 =
        dataPlane.sendBound(input)
}
