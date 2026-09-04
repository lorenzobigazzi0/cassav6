package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidBluetoothReliableRuntimeEndToEndV1Test {
    @Test
    fun `A2 material carries B9 routes and B10 diagnostic bus over reliable plane`() {
        val clientStore = InMemoryReliableChannelStoreV1()
        val serverStore = InMemoryReliableChannelStoreV1()
        val routeStore = FakeRouteStore()
        val diagnosticKinds = mutableListOf<BluetoothShadowKindV1>()
        val router = BluetoothTransportMessageRouterV1(
            RouteAdvertisementIngressV1(routeStore, enabled = true, now = { NOW }),
            BluetoothShadowIngressV1(
                BluetoothShadowHandlerV1 { diagnosticKinds += it.kind },
                enabled = true,
                now = { NOW }
            )
        )
        val controlForward = ByteArray(32) { it.toByte() }
        val controlReverse = ByteArray(32) { (31 - it).toByte() }
        val client = plane(
            GattReliableEndpointRoleV1.CLIENT,
            SERVER_PEER_TRUST_ID,
            controlForward,
            controlReverse,
            clientStore,
            ReliableChannelMessageHandlerV1 {}
        )
        val server = plane(
            GattReliableEndpointRoleV1.SERVER,
            CLIENT_PEER_TRUST_ID,
            controlForward,
            controlReverse,
            serverStore,
            router
        )
        subscribe(client)
        subscribe(server)
        client.setPublisher { _, frame -> server.receive(SESSION_TOKEN, frame) }
        server.setPublisher { _, frame -> client.receive(SESSION_TOKEN, frame) }
        val bus = BluetoothDiagnosticCommandBusV1()
        val runtime = AndroidBluetoothTransportRuntimeV1(
            routeAdvertisementEnabled = true,
            commandBusShadowEnabled = true,
            routeStore = FakeRouteStore(),
            shadowHandler = BluetoothShadowHandlerV1 {},
            diagnosticCommandBus = bus,
            healthProvider = {
                BluetoothRouteHealthV1(
                    canReachServer = true,
                    routeKind = BluetoothRouteKindV1.WIFI,
                    serverRttMs = 18.0,
                    lastRouteChangeAtEpochMs = NOW - 2_000,
                    queueDepth = 0,
                    batteryPercent = 80.0
                )
            },
            schedule = FakeSchedule(),
            now = { NOW }
        )
        runtime.attachPort(GattReliableApplicationPortV1(client, SESSION_TOKEN))

        try {
            runtime.start()
            assertEquals(AndroidBluetoothTransportRuntimeStateV1.RUNNING, runtime.snapshot().state)
            assertTrue(routeStore.lastServerAdvertisement()?.canReachServer == true)
            BluetoothShadowKindV1.entries.forEach { kind ->
                val result = bus.publish(
                    BluetoothDiagnosticCommandV1(kind, "diagnostic", 12)
                )
                assertEquals(1, result.delivered)
                assertEquals(0, result.failures)
                assertEquals(0, result.businessMessagesForwarded)
            }
            assertEquals(BluetoothShadowKindV1.entries, diagnosticKinds)
            assertEquals(1, router.snapshot().routesAccepted)
            assertEquals(3, router.snapshot().shadowsAccepted)
            assertEquals(0, router.snapshot().businessMessagesForwarded)
            assertEquals(0, runtime.snapshot().businessMessagesForwarded)
            assertTrue(client.snapshot().publishedFragments >= 4)
            assertTrue(server.snapshot().publishedFragments >= 4)
        } finally {
            runtime.close()
            client.close()
            server.close()
            clientStore.close()
            serverStore.close()
            controlForward.fill(0)
            controlReverse.fill(0)
        }
    }

    private fun plane(
        role: GattReliableEndpointRoleV1,
        peerTrustId: String,
        forward: ByteArray,
        reverse: ByteArray,
        store: ReliableChannelStoreV1,
        handler: ReliableChannelMessageHandlerV1
    ) = GattReliableDataPlaneV1(
        contextProvider = {
            GattReliableChannelContextV1(
                peerTrustId = peerTrustId,
                mtu = 247,
                role = role,
                material = deriveReliableChannelMaterialV1(forward, reverse)
            )
        },
        store = store,
        onMessage = handler,
        enabled = true,
        now = { NOW }
    )

    private fun subscribe(plane: GattReliableDataPlaneV1) {
        plane.setSubscription(GattReliableTransmitterV1.DATA, true)
        plane.setSubscription(GattReliableTransmitterV1.ACK, true)
    }

    private class FakeSchedule : AndroidBluetoothTransportScheduleV1 {
        override fun schedule(
            intervalMs: Long,
            operation: () -> Unit,
            onRejected: (Throwable) -> Unit
        ): AutoCloseable =
            AutoCloseable {}
    }

    private class FakeRouteStore : RouteAdvertisementStoreV1 {
        private var value: BluetoothStoredRouteAdvertisementV1? = null

        override fun storeLastServerAdvertisement(value: BluetoothStoredRouteAdvertisementV1) {
            this.value = value
        }

        override fun lastServerAdvertisement(): BluetoothStoredRouteAdvertisementV1? = value
    }

    companion object {
        private const val NOW = 1_800_000_000_000L
        private const val SESSION_TOKEN = 1L
        private const val CLIENT_PEER_TRUST_ID =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        private const val SERVER_PEER_TRUST_ID =
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
}
