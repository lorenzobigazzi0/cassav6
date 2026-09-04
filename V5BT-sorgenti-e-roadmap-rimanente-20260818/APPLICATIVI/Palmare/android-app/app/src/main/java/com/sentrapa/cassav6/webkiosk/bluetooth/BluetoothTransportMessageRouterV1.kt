package com.sentrapa.cassav6.webkiosk.bluetooth

data class BluetoothTransportMessageRouterSnapshotV1(
    val routesAccepted: Long,
    val shadowsAccepted: Long,
    val shadowDuplicates: Long,
    val controlMessagesReceived: Long,
    val businessMessagesRejected: Long,
    val businessMessagesForwarded: Long = 0
)

class BluetoothTransportMessageRouterExceptionV1(
    val code: String,
    message: String
) : RuntimeException(message)

class BluetoothTransportMessageRouterV1(
    private val routeIngress: RouteAdvertisementIngressV1,
    private val shadowIngress: BluetoothShadowIngressV1
) : ReliableChannelMessageHandlerV1 {
    private var routesAccepted = 0L
    private var shadowsAccepted = 0L
    private var shadowDuplicates = 0L
    private var controlMessagesReceived = 0L
    private var businessMessagesRejected = 0L

    @Synchronized
    override fun onMessage(message: ReliableMessageV1) {
        when (message.type) {
            ReliableFrameTypeV1.ROUTE_ADVERTISEMENT -> {
                routeIngress.accept(authenticated = true, message = message)
                routesAccepted += 1
            }
            ReliableFrameTypeV1.SHADOW_DIAGNOSTIC -> {
                val result = shadowIngress.accept(authenticated = true, message = message)
                if (result.duplicate) shadowDuplicates += 1 else shadowsAccepted += 1
            }
            ReliableFrameTypeV1.CLOSE,
            ReliableFrameTypeV1.ERROR -> controlMessagesReceived += 1
            ReliableFrameTypeV1.DATA -> {
                businessMessagesRejected += 1
                fail(
                    "BUSINESS_MESSAGE_FORBIDDEN",
                    "B10 shadow never accepts or routes Bluetooth business messages"
                )
            }
            ReliableFrameTypeV1.ACK -> fail(
                "ACK_NOT_DELIVERABLE",
                "ACK frames are consumed by ReliableChannelV1"
            )
        }
    }

    @Synchronized
    fun snapshot(): BluetoothTransportMessageRouterSnapshotV1 =
        BluetoothTransportMessageRouterSnapshotV1(
            routesAccepted = routesAccepted,
            shadowsAccepted = shadowsAccepted,
            shadowDuplicates = shadowDuplicates,
            controlMessagesReceived = controlMessagesReceived,
            businessMessagesRejected = businessMessagesRejected
        )

    private fun fail(code: String, message: String): Nothing =
        throw BluetoothTransportMessageRouterExceptionV1(code, message)
}
