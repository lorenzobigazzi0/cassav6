package com.sentrapa.cassav6.webkiosk.bluetooth

data class BluetoothDiagnosticCommandV1(
    val kind: BluetoothShadowKindV1,
    val body: String,
    val lanLatencyMs: Long? = null
)

data class BluetoothDiagnosticCommandPublishResultV1(
    val subscribers: Int,
    val delivered: Int,
    val failures: Int,
    val businessMessagesForwarded: Long = 0,
    val businessTransport: String = BLUETOOTH_SHADOW_BUSINESS_TRANSPORT_V1
)

data class BluetoothDiagnosticCommandBusSnapshotV1(
    val activeSubscribers: Int,
    val published: Long,
    val delivered: Long,
    val failures: Long,
    val businessMessagesForwarded: Long = 0,
    val businessTransport: String = BLUETOOTH_SHADOW_BUSINESS_TRANSPORT_V1
)

fun interface BluetoothDiagnosticCommandSinkV1 {
    fun onDiagnosticCommand(command: BluetoothDiagnosticCommandV1)
}

class BluetoothDiagnosticCommandBusExceptionV1(
    val code: String,
    message: String
) : RuntimeException(message)

class BluetoothDiagnosticCommandBusV1(
    private val maxSubscribers: Int = 8
) {
    private val subscribers = linkedMapOf<Long, BluetoothDiagnosticCommandSinkV1>()
    private var nextSubscriptionId = 1L
    private var published = 0L
    private var delivered = 0L
    private var failures = 0L

    init {
        if (maxSubscribers !in 1..64) {
            throw BluetoothDiagnosticCommandBusExceptionV1(
                "INVALID_DIAGNOSTIC_BUS_LIMIT",
                "diagnostic command bus subscriber limit is out of range"
            )
        }
    }

    @Synchronized
    fun subscribe(sink: BluetoothDiagnosticCommandSinkV1): AutoCloseable {
        if (subscribers.size >= maxSubscribers) {
            throw BluetoothDiagnosticCommandBusExceptionV1(
                "DIAGNOSTIC_BUS_FULL",
                "diagnostic command bus subscriber limit reached"
            )
        }
        val subscriptionId = nextSubscriptionId++
        subscribers[subscriptionId] = sink
        var closed = false
        return AutoCloseable {
            synchronized(this) {
                if (!closed) {
                    closed = true
                    subscribers.remove(subscriptionId)
                }
            }
        }
    }

    fun publish(
        command: BluetoothDiagnosticCommandV1
    ): BluetoothDiagnosticCommandPublishResultV1 {
        validate(command)
        val currentSubscribers = synchronized(this) {
            published += 1
            subscribers.values.toList()
        }
        var currentDelivered = 0
        var currentFailures = 0
        currentSubscribers.forEach { sink ->
            try {
                sink.onDiagnosticCommand(command)
                currentDelivered += 1
            } catch (_: Exception) {
                currentFailures += 1
            }
        }
        synchronized(this) {
            delivered += currentDelivered
            failures += currentFailures
        }
        return BluetoothDiagnosticCommandPublishResultV1(
            subscribers = currentSubscribers.size,
            delivered = currentDelivered,
            failures = currentFailures
        )
    }

    @Synchronized
    fun snapshot(): BluetoothDiagnosticCommandBusSnapshotV1 =
        BluetoothDiagnosticCommandBusSnapshotV1(
            activeSubscribers = subscribers.size,
            published = published,
            delivered = delivered,
            failures = failures
        )

    private fun validate(command: BluetoothDiagnosticCommandV1) {
        BluetoothShadowCodecV1.validate(
            BluetoothShadowMessageV1(
                kind = command.kind,
                correlationId = VALIDATION_CORRELATION_ID,
                sentAtEpochMs = 0,
                lanLatencyMs = command.lanLatencyMs,
                body = command.body
            )
        )
    }

    private companion object {
        private const val VALIDATION_CORRELATION_ID =
            "00000000000000000000000000000000"
    }
}
