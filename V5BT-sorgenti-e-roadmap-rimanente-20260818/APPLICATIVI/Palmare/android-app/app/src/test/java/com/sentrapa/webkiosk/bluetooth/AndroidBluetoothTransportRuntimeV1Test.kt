package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidBluetoothTransportRuntimeV1Test {
    @Test
    fun `reliable port multiplexer is leased fail closed and wipes on unbind`() {
        val multiplexer = BluetoothReliableApplicationPortMultiplexerV1()
        val port = FakePort()
        assertFalse(multiplexer.available)
        val unavailable = assertThrows(
            BluetoothReliableApplicationPortExceptionV1::class.java
        ) {
            multiplexer.tick()
        }
        assertEquals("RELIABLE_GATT_PORT_UNAVAILABLE", unavailable.code)

        val lease = multiplexer.bind(port)
        assertTrue(multiplexer.available)
        multiplexer.tick()
        val busy = assertThrows(BluetoothReliableApplicationPortExceptionV1::class.java) {
            multiplexer.bind(FakePort())
        }
        assertEquals("RELIABLE_GATT_PORT_BUSY", busy.code)
        assertTrue(multiplexer.unbind(lease))
        assertFalse(multiplexer.available)
        assertTrue(port.resetCalls > 0)
        assertFalse(multiplexer.unbind(lease))
    }

    @Test
    fun `runtime suspends on link loss and can restart on a new ready lease`() {
        val diagnosticBus = BluetoothDiagnosticCommandBusV1()
        val port = FakePort()
        val runtime = runtime(port = port, diagnosticBus = diagnosticBus)
        assertTrue(runtime.start())
        assertEquals(AndroidBluetoothTransportRuntimeStateV1.RUNNING, runtime.snapshot().state)
        assertEquals(1, diagnosticBus.snapshot().activeSubscribers)

        runtime.suspendForLinkLoss()
        assertEquals(AndroidBluetoothTransportRuntimeStateV1.IDLE, runtime.snapshot().state)
        assertEquals(0, diagnosticBus.snapshot().activeSubscribers)
        assertTrue(runtime.start())
        assertEquals(AndroidBluetoothTransportRuntimeStateV1.RUNNING, runtime.snapshot().state)
        assertEquals(2, port.restoreCalls)
        runtime.close()
        port.sent.forEach { it.payload.fill(0) }
    }

    @Test
    fun `disabled shadow flag never subscribes or sends diagnostic copies`() {
        val diagnosticBus = BluetoothDiagnosticCommandBusV1()
        val port = FakePort()
        val runtime = runtime(
            port = port,
            diagnosticBus = diagnosticBus,
            commandBusShadowEnabled = false
        )
        assertTrue(runtime.start())

        val publish = diagnosticBus.publish(
            BluetoothDiagnosticCommandV1(BluetoothShadowKindV1.HEALTH, "disabled")
        )

        assertEquals(AndroidBluetoothTransportRuntimeStateV1.RUNNING, runtime.snapshot().state)
        assertEquals(0, publish.subscribers)
        assertEquals(0, publish.delivered)
        assertEquals(1, port.sent.size)
        assertEquals(ReliableFrameTypeV1.ROUTE_ADVERTISEMENT, port.sent.single().type)
        runtime.close()
        port.sent.forEach { it.payload.fill(0) }
    }

    @Test
    fun `service boundary remains blocked when real reliable GATT port is unavailable`() {
        val diagnosticBus = BluetoothDiagnosticCommandBusV1()
        val runtime = runtime(
            UnavailableBluetoothReliableApplicationPortV1,
            diagnosticBus = diagnosticBus
        )
        assertFalse(runtime.start())
        val publish = diagnosticBus.publish(
            BluetoothDiagnosticCommandV1(BluetoothShadowKindV1.HEALTH, "blocked")
        )
        val snapshot = runtime.snapshot()
        assertEquals(AndroidBluetoothTransportRuntimeStateV1.BLOCKED, snapshot.state)
        assertFalse(snapshot.port.available)
        assertEquals(0, snapshot.port.publishedFragments)
        assertEquals(0, publish.subscribers)
        assertEquals(0, publish.delivered)
        assertEquals(0, snapshot.diagnosticCommandBus.activeSubscribers)
        assertEquals(1, snapshot.diagnosticCommandBus.published)
        assertEquals(0, snapshot.businessMessagesForwarded)
        assertEquals(BLUETOOTH_SHADOW_BUSINESS_TRANSPORT_V1, snapshot.businessTransport)
        assertThrows(AndroidBluetoothTransportRuntimeExceptionV1::class.java) {
            runtime.emitDiagnostic(BluetoothShadowKindV1.HEALTH, "blocked")
        }
        runtime.close()
    }

    @Test
    fun `available typed port runs bounded cadence shadow and business rejection`() {
        var now = NOW
        val port = FakePort()
        val schedule = FakeSchedule()
        val store = FakeRouteStore()
        val diagnosticBus = BluetoothDiagnosticCommandBusV1()
        val diagnostics = mutableListOf<BluetoothShadowKindV1>()
        val runtime = runtime(
            port = port,
            schedule = schedule,
            store = store,
            diagnosticBus = diagnosticBus,
            now = { now },
            shadowHandler = { diagnostics += it.kind }
        )
        assertTrue(runtime.start())
        assertEquals(1, port.sent.size)
        assertEquals(ReliableFrameTypeV1.ROUTE_ADVERTISEMENT, port.sent.single().type)
        assertEquals(1, port.restoreCalls)

        now += 4_999
        schedule.run()
        assertEquals(1, port.sent.size)
        now += 1
        schedule.run()
        assertEquals(2, port.sent.size)

        BluetoothShadowKindV1.entries.forEach { kind ->
            val published = diagnosticBus.publish(
                BluetoothDiagnosticCommandV1(kind, "health", 12)
            )
            assertEquals(1, published.subscribers)
            assertEquals(1, published.delivered)
            assertEquals(0, published.failures)
            assertEquals(0, published.businessMessagesForwarded)
        }
        assertEquals(ReliableFrameTypeV1.SHADOW_DIAGNOSTIC, port.sent.last().type)
        val shadowPayload = BluetoothShadowCodecV1.encode(
            BluetoothShadowMessageV1(
                kind = BluetoothShadowKindV1.TEST,
                correlationId = MESSAGE_ID,
                sentAtEpochMs = now,
                lanLatencyMs = 10,
                body = "ok"
            )
        )
        runtime.onMessage(message(ReliableFrameTypeV1.SHADOW_DIAGNOSTIC, shadowPayload, now))
        assertEquals(listOf(BluetoothShadowKindV1.TEST), diagnostics)
        val business = assertThrows(
            BluetoothTransportMessageRouterExceptionV1::class.java
        ) {
            runtime.onMessage(message(ReliableFrameTypeV1.DATA, byteArrayOf(1), now))
        }
        assertEquals("BUSINESS_MESSAGE_FORBIDDEN", business.code)
        val snapshot = runtime.snapshot()
        assertEquals(AndroidBluetoothTransportRuntimeStateV1.RUNNING, snapshot.state)
        assertEquals(2, snapshot.routesSent)
        assertEquals(3, snapshot.ticks)
        assertEquals(1, snapshot.router.businessMessagesRejected)
        assertEquals(3, snapshot.shadow.diagnosticsSent)
        assertEquals(1, snapshot.diagnosticCommandBus.activeSubscribers)
        assertEquals(3, snapshot.diagnosticCommandBus.published)
        assertEquals(3, snapshot.diagnosticCommandBus.delivered)
        assertEquals(0, snapshot.diagnosticCommandBus.failures)
        assertEquals(0, snapshot.businessMessagesForwarded)
        runtime.close()
        assertEquals(0, diagnosticBus.snapshot().activeSubscribers)
        assertTrue(port.resetCalls > 0)
        port.sent.forEach { it.payload.fill(0) }
    }

    @Test
    fun `initial restore failure rejects lease without stale subscriber or ready endpoint`() {
        val multiplexer = BluetoothReliableApplicationPortMultiplexerV1()
        val diagnosticBus = BluetoothDiagnosticCommandBusV1()
        val fatal = mutableListOf<String>()
        val runtime = runtime(
            port = multiplexer,
            diagnosticBus = diagnosticBus,
            onFatal = { fatal += it.code }
        )
        val arbiter = BluetoothReliableEndpointArbiterV1(multiplexer, runtime)
        val endpoint = FakePort(failRestore = true)

        assertFalse(
            arbiter.onPortChanged(BluetoothReliableEndpointSourceV1.CLIENT, endpoint)
        )
        assertEquals(AndroidBluetoothTransportRuntimeStateV1.FAILED, runtime.snapshot().state)
        assertFalse(arbiter.snapshot().clientActive)
        assertFalse(arbiter.snapshot().serverActive)
        assertEquals(0, diagnosticBus.snapshot().activeSubscribers)
        assertTrue(endpoint.resetCalls > 0)
        assertTrue(fatal.isEmpty())
        arbiter.close()
        runtime.close()
    }

    @Test
    fun `later tick failure revokes lease closes endpoint boundary and subscriber`() {
        val multiplexer = BluetoothReliableApplicationPortMultiplexerV1()
        val diagnosticBus = BluetoothDiagnosticCommandBusV1()
        val schedule = FakeSchedule()
        val fatal = mutableListOf<String>()
        val closedSources = mutableListOf<BluetoothReliableEndpointSourceV1>()
        lateinit var arbiter: BluetoothReliableEndpointArbiterV1
        val runtime = runtime(
            port = multiplexer,
            schedule = schedule,
            diagnosticBus = diagnosticBus,
            onFatal = {
                fatal += it.code
                arbiter.onRuntimeFatal()?.let(closedSources::add)
            }
        )
        arbiter = BluetoothReliableEndpointArbiterV1(multiplexer, runtime)
        val endpoint = FakePort(failTickAt = 2)
        assertTrue(
            arbiter.onPortChanged(BluetoothReliableEndpointSourceV1.SERVER, endpoint)
        )
        assertTrue(arbiter.snapshot().serverActive)
        assertEquals(1, diagnosticBus.snapshot().activeSubscribers)

        schedule.run()
        assertEquals(listOf("RUNTIME_TICK_FAILED"), fatal)
        assertEquals(listOf(BluetoothReliableEndpointSourceV1.SERVER), closedSources)
        assertEquals(AndroidBluetoothTransportRuntimeStateV1.FAILED, runtime.snapshot().state)
        assertFalse(arbiter.snapshot().serverActive)
        assertEquals(0, diagnosticBus.snapshot().activeSubscribers)
        assertFalse(schedule.active)
        assertTrue(endpoint.resetCalls > 0)
        arbiter.close()
        runtime.close()
    }

    @Test
    fun `initial and recurring schedule rejection fail closed`() {
        val initialBus = BluetoothDiagnosticCommandBusV1()
        val initialPort = FakePort()
        val initial = runtime(
            port = initialPort,
            schedule = FakeSchedule(rejectInitial = true),
            diagnosticBus = initialBus
        )
        assertFalse(initial.start())
        assertEquals(AndroidBluetoothTransportRuntimeStateV1.FAILED, initial.snapshot().state)
        assertEquals(0, initialBus.snapshot().activeSubscribers)
        assertTrue(initialPort.resetCalls > 0)
        initial.close()

        val recurringBus = BluetoothDiagnosticCommandBusV1()
        val recurringPort = FakePort()
        val recurringSchedule = FakeSchedule()
        val recurringFatal = mutableListOf<String>()
        val recurring = runtime(
            port = recurringPort,
            schedule = recurringSchedule,
            diagnosticBus = recurringBus,
            onFatal = { recurringFatal += it.code }
        )
        assertTrue(recurring.start())
        recurringSchedule.reject()
        assertEquals(listOf("RUNTIME_SCHEDULE_REJECTED"), recurringFatal)
        assertEquals(AndroidBluetoothTransportRuntimeStateV1.FAILED, recurring.snapshot().state)
        assertEquals(0, recurringBus.snapshot().activeSubscribers)
        assertFalse(recurringSchedule.active)
        assertTrue(recurringPort.resetCalls > 0)
        recurring.close()
    }

    private fun runtime(
        port: BluetoothReliableApplicationPortV1,
        schedule: AndroidBluetoothTransportScheduleV1 = FakeSchedule(),
        store: RouteAdvertisementStoreV1 = FakeRouteStore(),
        diagnosticBus: BluetoothDiagnosticCommandBusV1 =
            BluetoothDiagnosticCommandBusV1(),
        commandBusShadowEnabled: Boolean = true,
        now: () -> Long = { NOW },
        shadowHandler: BluetoothShadowHandlerV1 = BluetoothShadowHandlerV1 {},
        onFatal: (AndroidBluetoothTransportRuntimeExceptionV1) -> Unit = {}
    ) = AndroidBluetoothTransportRuntimeV1(
        routeAdvertisementEnabled = true,
        commandBusShadowEnabled = commandBusShadowEnabled,
        routeStore = store,
        shadowHandler = shadowHandler,
        diagnosticCommandBus = diagnosticBus,
        healthProvider = {
            BluetoothRouteHealthV1(
                canReachServer = true,
                routeKind = BluetoothRouteKindV1.WIFI,
                serverRttMs = 20.0,
                lastRouteChangeAtEpochMs = it - 1_000,
                queueDepth = 0,
                batteryPercent = 75.0
            )
        },
        schedule = schedule,
        now = now,
        onFatal = onFatal
    ).also { it.attachPort(port) }

    private fun message(type: ReliableFrameTypeV1, payload: ByteArray, now: Long) =
        ReliableMessageV1(type, 0, 1, MESSAGE_ID, now + 30_000, payload)

    private class FakeSchedule(
        private val rejectInitial: Boolean = false
    ) : AndroidBluetoothTransportScheduleV1 {
        private var operation: (() -> Unit)? = null
        private var onRejected: ((Throwable) -> Unit)? = null
        val active: Boolean
            get() = operation != null

        override fun schedule(
            intervalMs: Long,
            operation: () -> Unit,
            onRejected: (Throwable) -> Unit
        ): AutoCloseable {
            if (rejectInitial) error("schedule rejected")
            this.operation = operation
            this.onRejected = onRejected
            return AutoCloseable {
                this.operation = null
                this.onRejected = null
            }
        }

        fun run() = checkNotNull(operation).invoke()

        fun reject() {
            val callback = checkNotNull(onRejected)
            operation = null
            onRejected = null
            callback(IllegalStateException("reschedule rejected"))
        }
    }

    private class FakePort(
        private val failRestore: Boolean = false,
        private val failTickAt: Int? = null
    ) : BluetoothReliableApplicationPortV1 {
        override val available = true
        val sent = mutableListOf<ReliableChannelSendInputV1>()
        var restoreCalls = 0
        var resetCalls = 0
        var tickCalls = 0

        override fun send(input: ReliableChannelSendInputV1): ReliableChannelSendResultV1 {
            sent += input.copy(payload = input.payload.copyOf())
            return ReliableChannelSendResultV1(MESSAGE_ID, false)
        }

        override fun restoreBound(): Int {
            restoreCalls += 1
            if (failRestore) error("restore failed")
            return 0
        }

        override fun tick(): ReliableChannelTickResultV1 {
            tickCalls += 1
            if (tickCalls == failTickAt) error("tick failed")
            return ReliableChannelTickResultV1(0, 0, 0)
        }

        override fun reset() {
            resetCalls += 1
        }

        override fun snapshot() = BluetoothReliableApplicationPortSnapshotV1(
            available = true,
            bound = true,
            publishedFragments = sent.size.toLong(),
            receivedFragments = 0,
            failures = 0
        )
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
        private const val MESSAGE_ID = "00112233445566778899aabbccddeeff"
    }
}
