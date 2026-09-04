package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BluetoothTransportMessageRouterV1Test {
    @Test
    fun `router persists routes accepts diagnostics and rejects business`() {
        val store = FakeRouteStore()
        val diagnostics = mutableListOf<BluetoothShadowKindV1>()
        val router = BluetoothTransportMessageRouterV1(
            RouteAdvertisementIngressV1(store, enabled = true, now = { NOW }),
            BluetoothShadowIngressV1(
                handler = { diagnostics += it.kind },
                enabled = true,
                now = { NOW }
            )
        )
        val routePayload = RouteAdvertisementCodecV1.encode(
            RouteAdvertisementV1(
                true,
                BluetoothRouteKindV1.WIFI,
                2,
                0,
                0,
                8,
                1
            )
        )
        val shadowPayload = BluetoothShadowCodecV1.encode(
            BluetoothShadowMessageV1(
                kind = BluetoothShadowKindV1.HEALTH,
                correlationId = MESSAGE_ID,
                sentAtEpochMs = NOW,
                lanLatencyMs = 10,
                body = "ok"
            )
        )

        router.onMessage(message(ReliableFrameTypeV1.ROUTE_ADVERTISEMENT, routePayload))
        router.onMessage(message(ReliableFrameTypeV1.SHADOW_DIAGNOSTIC, shadowPayload))
        router.onMessage(message(ReliableFrameTypeV1.SHADOW_DIAGNOSTIC, shadowPayload))
        router.onMessage(message(ReliableFrameTypeV1.CLOSE, byteArrayOf()))
        val businessError = assertThrows(
            BluetoothTransportMessageRouterExceptionV1::class.java
        ) {
            router.onMessage(message(ReliableFrameTypeV1.DATA, byteArrayOf(1)))
        }
        assertEquals("BUSINESS_MESSAGE_FORBIDDEN", businessError.code)
        val ackError = assertThrows(
            BluetoothTransportMessageRouterExceptionV1::class.java
        ) {
            router.onMessage(message(ReliableFrameTypeV1.ACK, byteArrayOf()))
        }
        assertEquals("ACK_NOT_DELIVERABLE", ackError.code)
        assertEquals(listOf(BluetoothShadowKindV1.HEALTH), diagnostics)
        assertEquals(
            BluetoothTransportMessageRouterSnapshotV1(
                routesAccepted = 1,
                shadowsAccepted = 1,
                shadowDuplicates = 1,
                controlMessagesReceived = 1,
                businessMessagesRejected = 1
            ),
            router.snapshot()
        )
        assertEquals(0, router.snapshot().businessMessagesForwarded)
    }

    private fun message(type: ReliableFrameTypeV1, payload: ByteArray) =
        ReliableMessageV1(type, 0, 1, MESSAGE_ID, NOW + 30_000, payload)

    private class FakeRouteStore : RouteAdvertisementStoreV1 {
        private var value: BluetoothStoredRouteAdvertisementV1? = null

        override fun storeLastServerAdvertisement(value: BluetoothStoredRouteAdvertisementV1) {
            this.value = value
        }

        override fun lastServerAdvertisement(): BluetoothStoredRouteAdvertisementV1? = value
    }

    companion object {
        private const val NOW = 1_800_000_000_000L
        private const val MESSAGE_ID = "00112233445566778899aabbccddeeff"
    }
}
