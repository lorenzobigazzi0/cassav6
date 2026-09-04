package com.sentrapa.webkiosk.bluetooth

import java.util.UUID

enum class AndroidGattReliableDeliveryV1 {
    WRITE_REQUEST,
    NOTIFY,
    INDICATE
}

data class AndroidGattReliablePublishTargetV1(
    val characteristicUuid: UUID,
    val delivery: AndroidGattReliableDeliveryV1
)

fun interface AndroidGattReliablePhysicalPublisherV1 {
    fun publish(
        target: AndroidGattReliablePublishTargetV1,
        frame: ByteArray
    )
}

interface AndroidGattReliableDataPlaneBindingV1 {
    fun setPublisher(value: GattReliablePublisherV1?)

    fun setSubscription(transmitter: GattReliableTransmitterV1, enabled: Boolean)

    fun receive(sessionToken: Long, frame: ByteArray): ReliableChannelReceiveResultV1

    fun reset()

    fun snapshot(): GattReliableDataPlaneSnapshotV1
}

class AndroidGattReliableDataPlaneBindingAdapterV1(
    private val dataPlane: GattReliableDataPlaneV1
) : AndroidGattReliableDataPlaneBindingV1 {
    override fun setPublisher(value: GattReliablePublisherV1?) =
        dataPlane.setPublisher(value)

    override fun setSubscription(
        transmitter: GattReliableTransmitterV1,
        enabled: Boolean
    ) = dataPlane.setSubscription(transmitter, enabled)

    override fun receive(
        sessionToken: Long,
        frame: ByteArray
    ): ReliableChannelReceiveResultV1 = dataPlane.receive(sessionToken, frame)

    override fun reset() = dataPlane.reset()

    override fun snapshot(): GattReliableDataPlaneSnapshotV1 = dataPlane.snapshot()
}

data class AndroidGattReliableDataPlaneBridgeSnapshotV1(
    val role: GattReliableEndpointRoleV1,
    val dataReady: Boolean,
    val ackReady: Boolean,
    val dataPublished: Long,
    val ackPublished: Long,
    val dataReceived: Long,
    val ackReceived: Long,
    val rejected: Long,
    val closed: Boolean,
    val dataPlane: GattReliableDataPlaneSnapshotV1
)

class AndroidGattReliableDataPlaneBridgeExceptionV1(
    val code: String,
    message: String,
    cause: Throwable? = null
) : RuntimeException(message, cause)

class AndroidGattReliableDataPlaneBridgeV1(
    private val role: GattReliableEndpointRoleV1,
    private val sessionToken: Long,
    private val dataPlane: AndroidGattReliableDataPlaneBindingV1,
    private val physicalPublisher: AndroidGattReliablePhysicalPublisherV1
) : AutoCloseable {
    private var dataReady = false
    private var ackReady = false
    private var dataPublished = 0L
    private var ackPublished = 0L
    private var dataReceived = 0L
    private var ackReceived = 0L
    private var rejected = 0L
    private var closed = false

    init {
        if (sessionToken <= 0) {
            fail("INVALID_SESSION_TOKEN", "reliable bridge session token must be positive")
        }
        dataPlane.setPublisher(GattReliablePublisherV1(::publishPhysical))
    }

    @Synchronized
    fun setTransmitterReady(
        transmitter: GattReliableTransmitterV1,
        ready: Boolean
    ) {
        assertOpen()
        dataPlane.setSubscription(transmitter, ready)
        when (transmitter) {
            GattReliableTransmitterV1.DATA -> dataReady = ready
            GattReliableTransmitterV1.ACK -> ackReady = ready
        }
    }

    @Synchronized
    fun receive(
        characteristicUuid: UUID,
        frame: ByteArray
    ): ReliableChannelReceiveResultV1 {
        assertOpen()
        val transmitter = validateInbound(characteristicUuid, frame)
        return try {
            dataPlane.receive(sessionToken, frame).also {
                when (transmitter) {
                    GattReliableTransmitterV1.DATA -> dataReceived += 1
                    GattReliableTransmitterV1.ACK -> ackReceived += 1
                }
            }
        } catch (error: Exception) {
            rejected += 1
            throw error
        }
    }

    @Synchronized
    fun snapshot(): AndroidGattReliableDataPlaneBridgeSnapshotV1 =
        AndroidGattReliableDataPlaneBridgeSnapshotV1(
            role = role,
            dataReady = dataReady,
            ackReady = ackReady,
            dataPublished = dataPublished,
            ackPublished = ackPublished,
            dataReceived = dataReceived,
            ackReceived = ackReceived,
            rejected = rejected,
            closed = closed,
            dataPlane = dataPlane.snapshot()
        )

    @Synchronized
    override fun close() {
        if (closed) return
        dataReady = false
        ackReady = false
        runCatching {
            dataPlane.setSubscription(GattReliableTransmitterV1.DATA, false)
        }
        runCatching {
            dataPlane.setSubscription(GattReliableTransmitterV1.ACK, false)
        }
        runCatching { dataPlane.setPublisher(null) }
        runCatching { dataPlane.reset() }
        closed = true
    }

    private fun publishPhysical(
        transmitter: GattReliableTransmitterV1,
        frame: ByteArray
    ) {
        synchronized(this) {
            assertOpen()
            val decodedTransmitter = transmitterOf(frame)
            if (decodedTransmitter != transmitter) {
                rejected += 1
                fail(
                    "TRANSMITTER_FRAME_MISMATCH",
                    "reliable frame type does not match its transmitter"
                )
            }
            if (
                transmitter == GattReliableTransmitterV1.DATA && !dataReady ||
                transmitter == GattReliableTransmitterV1.ACK && !ackReady
            ) {
                rejected += 1
                fail(
                    "TRANSMITTER_NOT_READY",
                    "reliable transmitter is not ready"
                )
            }
            try {
                physicalPublisher.publish(outboundTarget(transmitter), frame)
                when (transmitter) {
                    GattReliableTransmitterV1.DATA -> dataPublished += 1
                    GattReliableTransmitterV1.ACK -> ackPublished += 1
                }
            } catch (error: Exception) {
                rejected += 1
                fail(
                    "PHYSICAL_PUBLISH_FAILED",
                    "reliable frame could not be handed to the Android GATT operation queue",
                    error
                )
            }
        }
    }

    private fun validateInbound(
        characteristicUuid: UUID,
        frame: ByteArray
    ): GattReliableTransmitterV1 {
        val transmitter = transmitterOf(frame)
        val accepted = when (role) {
            GattReliableEndpointRoleV1.CLIENT ->
                (
                    characteristicUuid == AndroidGattProfileV1.dataTxUuid &&
                        transmitter == GattReliableTransmitterV1.DATA
                ) ||
                    (
                        characteristicUuid == AndroidGattProfileV1.ackTxUuid &&
                            transmitter == GattReliableTransmitterV1.ACK
                    )
            GattReliableEndpointRoleV1.SERVER ->
                characteristicUuid == AndroidGattProfileV1.dataRxUuid
        }
        if (!accepted) {
            rejected += 1
            fail(
                "INVALID_INBOUND_CHARACTERISTIC",
                "reliable frame arrived on an invalid GATT characteristic"
            )
        }
        return transmitter
    }

    private fun outboundTarget(
        transmitter: GattReliableTransmitterV1
    ): AndroidGattReliablePublishTargetV1 = when (role) {
        GattReliableEndpointRoleV1.CLIENT ->
            AndroidGattReliablePublishTargetV1(
                AndroidGattProfileV1.dataRxUuid,
                AndroidGattReliableDeliveryV1.WRITE_REQUEST
            )
        GattReliableEndpointRoleV1.SERVER -> when (transmitter) {
            GattReliableTransmitterV1.DATA ->
                AndroidGattReliablePublishTargetV1(
                    AndroidGattProfileV1.dataTxUuid,
                    AndroidGattReliableDeliveryV1.NOTIFY
                )
            GattReliableTransmitterV1.ACK ->
                AndroidGattReliablePublishTargetV1(
                    AndroidGattProfileV1.ackTxUuid,
                    AndroidGattReliableDeliveryV1.INDICATE
                )
        }
    }

    private fun transmitterOf(frame: ByteArray): GattReliableTransmitterV1 {
        val decoded = try {
            ReliableFrameCodecV1.decodeFragment(frame)
        } catch (error: Exception) {
            rejected += 1
            fail("INVALID_RELIABLE_FRAME", "reliable frame is invalid", error)
        }
        return try {
            if (decoded.type == ReliableFrameTypeV1.ACK) {
                GattReliableTransmitterV1.ACK
            } else {
                GattReliableTransmitterV1.DATA
            }
        } finally {
            decoded.payload.fill(0)
        }
    }

    private fun assertOpen() {
        if (closed) fail("BRIDGE_CLOSED", "reliable GATT bridge is closed")
    }

    private fun fail(code: String, message: String, cause: Throwable? = null): Nothing =
        throw AndroidGattReliableDataPlaneBridgeExceptionV1(code, message, cause)
}
