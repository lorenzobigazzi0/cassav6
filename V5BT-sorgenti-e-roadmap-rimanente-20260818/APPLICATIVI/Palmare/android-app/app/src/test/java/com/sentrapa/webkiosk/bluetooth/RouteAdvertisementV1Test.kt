package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class RouteAdvertisementV1Test {
    @Test
    fun `route advertisement matches frozen Node wire`() {
        val input = RouteAdvertisementV1(
            canReachServer = true,
            routeKind = BluetoothRouteKindV1.LAN,
            serverRttBucket = 2,
            routeAgeSeconds = 5,
            queueDepthBucket = 4,
            batteryBucket = 8,
            sequence = 1
        )

        val wire = RouteAdvertisementCodecV1.encode(input)

        assertEquals(ROUTE_ADVERTISEMENT_WIRE_BYTES_V1, wire.size)
        assertArrayEquals(hex("010102020005040800000001"), wire)
        assertEquals(input, RouteAdvertisementCodecV1.decode(wire))
        assertFalse(wire.toString(Charsets.UTF_8).contains("node"))
    }

    @Test
    fun `bucket functions match Node boundaries and unknown values`() {
        assertEquals(
            listOf(0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7),
            listOf(
                0.0,
                10.0,
                11.0,
                25.0,
                26.0,
                50.0,
                51.0,
                100.0,
                101.0,
                250.0,
                251.0,
                500.0,
                501.0,
                1_000.0,
                1_001.0
            ).map(::serverRttBucketV1)
        )
        assertEquals(ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET_V1, serverRttBucketV1(null))
        assertEquals(
            listOf(0, 1, 2, 2, 3, 4, 5, 15),
            listOf(0L, 1L, 2L, 3L, 4L, 8L, 16L, 32_768L)
                .map(::queueDepthBucketV1)
        )
        assertEquals(
            listOf(0, 0, 1, 5, 9, 10),
            listOf(0.0, 9.9, 10.0, 50.0, 99.9, 100.0)
                .map(::batteryBucketV1)
        )
        assertEquals(ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET_V1, batteryBucketV1(null))
    }

    @Test
    fun `B9 rejects multihop reachability invalid RTT and reserved flags`() {
        val base = RouteAdvertisementV1(
            canReachServer = true,
            routeKind = BluetoothRouteKindV1.LAN,
            serverRttBucket = 1,
            routeAgeSeconds = 0,
            queueDepthBucket = 0,
            batteryBucket = 10,
            sequence = 1
        )
        assertRouteError("MULTIHOP_NOT_ALLOWED") {
            RouteAdvertisementCodecV1.encode(
                base.copy(routeKind = BluetoothRouteKindV1.BLE_DIRECT)
            )
        }
        assertRouteError("INVALID_ROUTE_STATE") {
            RouteAdvertisementCodecV1.encode(base.copy(canReachServer = false))
        }
        val reserved = RouteAdvertisementCodecV1.encode(base).also { it[1] = 2 }
        assertRouteError("INVALID_ROUTE_FLAGS") {
            RouteAdvertisementCodecV1.decode(reserved)
        }
    }

    @Test
    fun `publisher refreshes within five seconds and forces route changes`() {
        val publisher = RouteAdvertisementPublisherV1(5_000)
        val input = RouteAdvertisementBuildInputV1(
            nowEpochMs = 100_000,
            canReachServer = true,
            routeKind = BluetoothRouteKindV1.WIFI,
            serverRttMs = 20.0,
            lastRouteChangeAtEpochMs = 95_000,
            queueDepth = 3,
            batteryPercent = 75.0
        )

        assertEquals(1, RouteAdvertisementCodecV1.decode(publisher.build(input)!!).sequence)
        assertNull(publisher.build(input.copy(nowEpochMs = 104_999)))
        assertEquals(
            2,
            RouteAdvertisementCodecV1.decode(
                publisher.build(input.copy(nowEpochMs = 105_000))!!
            ).sequence
        )
        assertEquals(
            3,
            RouteAdvertisementCodecV1.decode(
                publisher.build(input.copy(nowEpochMs = 105_001, force = true))!!
            ).sequence
        )
        assertRouteError("CLOCK_REGRESSION") {
            publisher.build(input.copy(nowEpochMs = 105_000))
        }
        assertEquals(5_000, publisher.snapshot().publishIntervalMs)
        assertRouteError("INVALID_ROUTE_FIELD") {
            RouteAdvertisementPublisherV1(5_001)
        }
    }

    @Test
    fun `publisher resumes a persisted sequence after recreation`() {
        val sequenceStore = InMemoryRouteAdvertisementSequenceStoreV1(40)
        val input = RouteAdvertisementBuildInputV1(
            nowEpochMs = 100_000,
            canReachServer = true,
            routeKind = BluetoothRouteKindV1.WIFI,
            serverRttMs = 20.0,
            lastRouteChangeAtEpochMs = 95_000,
            queueDepth = 0,
            batteryPercent = 75.0
        )
        val first = RouteAdvertisementPublisherV1(5_000, sequenceStore)
        assertEquals(41, RouteAdvertisementCodecV1.decode(first.build(input)!!).sequence)
        val reopened = RouteAdvertisementPublisherV1(5_000, sequenceStore)
        assertEquals(42, RouteAdvertisementCodecV1.decode(reopened.build(input)!!).sequence)
    }

    @Test
    fun `emitter is off by default and sends only bounded non durable route frames`() {
        val sent = mutableListOf<ReliableChannelSendInputV1>()
        val channel = RouteAdvertisementChannelV1 { input ->
            sent += input.copy(payload = input.payload.copyOf())
            ReliableChannelSendResultV1("00112233445566778899aabbccddeeff", false)
        }
        val input = RouteAdvertisementBuildInputV1(
            nowEpochMs = 100_000,
            canReachServer = true,
            routeKind = BluetoothRouteKindV1.WIFI,
            serverRttMs = 20.0,
            lastRouteChangeAtEpochMs = 95_000,
            queueDepth = 0,
            batteryPercent = 75.0
        )
        val disabled = RouteAdvertisementEmitterV1(
            RouteAdvertisementPublisherV1(),
            channel
        )
        assertEquals(RouteAdvertisementEmitResultV1(false), disabled.update(input))
        assertTrue(sent.isEmpty())

        val enabled = RouteAdvertisementEmitterV1(
            RouteAdvertisementPublisherV1(5_000),
            channel,
            enabled = true
        )
        assertEquals(RouteAdvertisementEmitResultV1(true), enabled.update(input))
        assertEquals(RouteAdvertisementEmitResultV1(false), enabled.update(input.copy(nowEpochMs = 104_999)))
        assertEquals(1, sent.size)
        assertEquals(ReliableFrameTypeV1.ROUTE_ADVERTISEMENT, sent.single().type)
        assertFalse(sent.single().durable)
        assertEquals(15_000, sent.single().ttlMs)
        assertEquals(0, enabled.update(input.copy(nowEpochMs = 105_000)).businessMessagesForwarded)
        assertEquals(2, sent.size)
        sent.forEach { it.payload.fill(0) }
    }

    @Test
    fun `authenticated ingress commits B8 route and never forwards business`() {
        val store = FakeRouteStore()
        val ingress = RouteAdvertisementIngressV1(
            store = store,
            enabled = true,
            now = { NOW }
        )
        val route = RouteAdvertisementV1(
            canReachServer = true,
            routeKind = BluetoothRouteKindV1.WIFI,
            serverRttBucket = 3,
            routeAgeSeconds = 2,
            queueDepthBucket = 1,
            batteryBucket = 7,
            sequence = 9
        )
        val payload = RouteAdvertisementCodecV1.encode(route)
        val message = reliableMessage(ReliableFrameTypeV1.ROUTE_ADVERTISEMENT, payload)

        assertEquals(route, ingress.accept(authenticated = true, message = message))
        assertEquals(
            BluetoothStoredRouteAdvertisementV1(
                true,
                BluetoothRouteKindV1.WIFI,
                3,
                2,
                1,
                7,
                9,
                NOW
            ),
            store.value
        )
        assertEquals(
            RouteReachabilityV1(true, false, true, BluetoothRouteKindV1.WIFI, 5_000),
            ingress.reachability(NOW + 5_000)
        )
        assertEquals(
            RouteReachabilityV1(true, true, false, BluetoothRouteKindV1.NONE, 5_001),
            ingress.reachability(NOW + 5_001)
        )
        assertEquals(
            RouteAdvertisementIngressMetricsV1(true, 1, 1, 0, 1),
            ingress.snapshot()
        )
        assertEquals(0, ingress.snapshot().businessMessagesForwarded)

        assertRouteError("ROUTE_SEQUENCE_REPLAY") {
            ingress.accept(authenticated = true, message = message)
        }
        val olderPayload = RouteAdvertisementCodecV1.encode(route.copy(sequence = 8))
        assertRouteError("ROUTE_SEQUENCE_REPLAY") {
            ingress.accept(
                authenticated = true,
                message = reliableMessage(
                    ReliableFrameTypeV1.ROUTE_ADVERTISEMENT,
                    olderPayload
                )
            )
        }

        val disabled = RouteAdvertisementIngressV1(store)
        assertRouteError("ROUTE_ADVERTISEMENT_DISABLED") {
            disabled.accept(true, message)
        }
        assertRouteError("UNAUTHENTICATED_ROUTE_ADVERTISEMENT") {
            ingress.accept(false, message)
        }
        assertRouteError("BUSINESS_MESSAGE_REJECTED") {
            ingress.accept(true, reliableMessage(ReliableFrameTypeV1.DATA, payload))
        }
    }

    @Test
    fun `persistence failure is fail closed without false acceptance`() {
        val store = FakeRouteStore(failWrites = true)
        val ingress = RouteAdvertisementIngressV1(store, enabled = true, now = { NOW })
        val payload = RouteAdvertisementCodecV1.encode(
            RouteAdvertisementV1(
                false,
                BluetoothRouteKindV1.NONE,
                ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET_V1,
                0,
                0,
                ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET_V1,
                1
            )
        )

        assertRouteError("ROUTE_PERSISTENCE_FAILED") {
            ingress.accept(
                true,
                reliableMessage(ReliableFrameTypeV1.ROUTE_ADVERTISEMENT, payload)
            )
        }
        assertEquals(RouteAdvertisementIngressMetricsV1(true, 1, 0, 1, 0), ingress.snapshot())
    }

    private fun reliableMessage(
        type: ReliableFrameTypeV1,
        payload: ByteArray
    ): ReliableMessageV1 = ReliableMessageV1(
        type,
        0,
        1,
        "10112233445566778899aabbccddeeff",
        NOW + 30_000,
        payload
    )

    private fun assertRouteError(code: String, operation: () -> Unit) {
        val error = assertThrows(RouteAdvertisementExceptionV1::class.java) {
            operation()
        }
        assertEquals(code, error.code)
    }

    private fun hex(value: String): ByteArray =
        value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    private class FakeRouteStore(
        private val failWrites: Boolean = false
    ) : RouteAdvertisementStoreV1 {
        var value: BluetoothStoredRouteAdvertisementV1? = null

        override fun storeLastServerAdvertisement(value: BluetoothStoredRouteAdvertisementV1) {
            if (failWrites) error("simulated durable write failure")
            this.value = value
        }

        override fun lastServerAdvertisement(): BluetoothStoredRouteAdvertisementV1? = value
    }

    companion object {
        private const val NOW = 1_800_000_000_000L
    }
}
