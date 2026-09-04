package com.sentrapa.cassav6.webkiosk.bluetooth

import android.os.Handler
import android.os.Looper
import java.util.concurrent.atomic.AtomicBoolean

enum class AndroidBluetoothTransportRuntimeStateV1 {
    IDLE,
    RUNNING,
    BLOCKED,
    FAILED,
    STOPPED
}

data class BluetoothRouteHealthV1(
    val canReachServer: Boolean,
    val routeKind: BluetoothRouteKindV1,
    val serverRttMs: Double?,
    val lastRouteChangeAtEpochMs: Long,
    val queueDepth: Long,
    val batteryPercent: Double?
)

fun interface BluetoothRouteHealthProviderV1 {
    fun snapshot(nowEpochMs: Long): BluetoothRouteHealthV1
}

data class BluetoothReliableApplicationPortSnapshotV1(
    val available: Boolean,
    val bound: Boolean,
    val publishedFragments: Long,
    val receivedFragments: Long,
    val failures: Long
)

interface BluetoothReliableApplicationPortV1 {
    val available: Boolean

    fun send(input: ReliableChannelSendInputV1): ReliableChannelSendResultV1

    fun restoreBound(): Int

    fun tick(): ReliableChannelTickResultV1

    fun reset()

    fun snapshot(): BluetoothReliableApplicationPortSnapshotV1
}

class BluetoothReliableApplicationPortExceptionV1(
    val code: String,
    message: String
) : RuntimeException(message)

object UnavailableBluetoothReliableApplicationPortV1 :
    BluetoothReliableApplicationPortV1 {
    override val available: Boolean = false

    override fun send(input: ReliableChannelSendInputV1): ReliableChannelSendResultV1 =
        unavailable()

    override fun restoreBound(): Int = unavailable()

    override fun tick(): ReliableChannelTickResultV1 = unavailable()

    override fun reset() = Unit

    override fun snapshot(): BluetoothReliableApplicationPortSnapshotV1 =
        BluetoothReliableApplicationPortSnapshotV1(
            available = false,
            bound = false,
            publishedFragments = 0,
            receivedFragments = 0,
            failures = 0
        )

    private fun unavailable(): Nothing =
        throw BluetoothReliableApplicationPortExceptionV1(
            "RELIABLE_GATT_PORT_UNAVAILABLE",
            "the authenticated reliable GATT data plane is not attached"
        )
}

class GattReliableApplicationPortV1(
    private val dataPlane: GattReliableDataPlaneV1,
    private val sessionToken: Long? = null
) : BluetoothReliableApplicationPortV1 {
    override val available: Boolean
        get() = dataPlane.snapshot().let {
            it.enabled && it.dataSubscribed && it.ackSubscribed
        }

    override fun send(input: ReliableChannelSendInputV1): ReliableChannelSendResultV1 =
        sessionToken?.let { dataPlane.send(it, input) } ?: dataPlane.sendBound(input)

    override fun restoreBound(): Int =
        sessionToken?.let(dataPlane::restore) ?: dataPlane.restoreBound()

    override fun tick(): ReliableChannelTickResultV1 = dataPlane.tick()

    override fun reset() = dataPlane.reset()

    override fun snapshot(): BluetoothReliableApplicationPortSnapshotV1 =
        dataPlane.snapshot().let {
            BluetoothReliableApplicationPortSnapshotV1(
                available = it.enabled,
                bound = it.bound,
                publishedFragments = it.publishedFragments,
                receivedFragments = it.receivedFragments,
                failures = it.failures
            )
        }
}

data class BluetoothReliableApplicationPortLeaseV1 internal constructor(
    internal val generation: Long
)

class BluetoothReliableApplicationPortMultiplexerV1 :
    BluetoothReliableApplicationPortV1,
    AutoCloseable {
    private var active: BluetoothReliableApplicationPortV1? = null
    private var generation = 0L

    override val available: Boolean
        @Synchronized get() = active?.available == true

    @Synchronized
    fun bind(value: BluetoothReliableApplicationPortV1): BluetoothReliableApplicationPortLeaseV1 {
        if (active != null) {
            unavailable("RELIABLE_GATT_PORT_BUSY", "another reliable GATT link is active")
        }
        if (!value.available) {
            unavailable("RELIABLE_GATT_PORT_NOT_READY", "reliable GATT link is not ready")
        }
        if (generation == Long.MAX_VALUE) {
            unavailable("RELIABLE_GATT_PORT_EXHAUSTED", "reliable GATT lease space is exhausted")
        }
        generation += 1
        active = value
        return BluetoothReliableApplicationPortLeaseV1(generation)
    }

    fun unbind(lease: BluetoothReliableApplicationPortLeaseV1): Boolean {
        val value = synchronized(this) {
            if (active == null || lease.generation != generation) return false
            active.also { active = null }
        }
        value?.reset()
        return true
    }

    override fun send(input: ReliableChannelSendInputV1): ReliableChannelSendResultV1 =
        target().send(input)

    override fun restoreBound(): Int = target().restoreBound()

    override fun tick(): ReliableChannelTickResultV1 = target().tick()

    override fun reset() {
        synchronized(this) { active }?.reset()
    }

    override fun snapshot(): BluetoothReliableApplicationPortSnapshotV1 =
        synchronized(this) { active }?.snapshot()
            ?: BluetoothReliableApplicationPortSnapshotV1(
                available = false,
                bound = false,
                publishedFragments = 0,
                receivedFragments = 0,
                failures = 0
            )

    override fun close() {
        val value = synchronized(this) {
            active.also { active = null }
        }
        value?.reset()
    }

    private fun target(): BluetoothReliableApplicationPortV1 =
        synchronized(this) { active }
            ?: unavailable(
                "RELIABLE_GATT_PORT_UNAVAILABLE",
                "no authenticated reliable GATT link is active"
            )

    private fun unavailable(code: String, message: String): Nothing =
        throw BluetoothReliableApplicationPortExceptionV1(code, message)
}

fun interface AndroidBluetoothTransportScheduleV1 {
    fun schedule(
        intervalMs: Long,
        operation: () -> Unit,
        onRejected: (Throwable) -> Unit
    ): AutoCloseable
}

class AndroidHandlerBluetoothTransportScheduleV1(
    private val handler: Handler = Handler(Looper.getMainLooper())
) : AndroidBluetoothTransportScheduleV1 {
    override fun schedule(
        intervalMs: Long,
        operation: () -> Unit,
        onRejected: (Throwable) -> Unit
    ): AutoCloseable {
        val closed = AtomicBoolean(false)
        lateinit var task: Runnable
        task = Runnable {
            if (closed.get()) return@Runnable
            operation()
            val rejection = if (closed.get()) {
                null
            } else {
                try {
                    if (handler.postDelayed(task, intervalMs)) null else {
                        IllegalStateException("Bluetooth transport tick was rejected")
                    }
                } catch (error: RuntimeException) {
                    error
                }
            }
            if (rejection != null && closed.compareAndSet(false, true)) {
                runCatching {
                    onRejected(rejection)
                }
            }
        }
        if (!handler.postDelayed(task, intervalMs)) {
            closed.set(true)
            throw IllegalStateException("Bluetooth transport schedule was rejected")
        }
        return AutoCloseable {
            if (closed.compareAndSet(false, true)) handler.removeCallbacks(task)
        }
    }
}

data class AndroidBluetoothTransportRuntimeSnapshotV1(
    val state: AndroidBluetoothTransportRuntimeStateV1,
    val routeAdvertisementEnabled: Boolean,
    val commandBusShadowEnabled: Boolean,
    val ticks: Long,
    val tickFailures: Long,
    val restoredDurableMessages: Long,
    val routesSent: Long,
    val businessMessagesForwarded: Long,
    val businessTransport: String,
    val port: BluetoothReliableApplicationPortSnapshotV1,
    val router: BluetoothTransportMessageRouterSnapshotV1,
    val routeIngress: RouteAdvertisementIngressMetricsV1,
    val shadow: BluetoothCommandBusShadowSnapshotV1,
    val diagnosticCommandBus: BluetoothDiagnosticCommandBusSnapshotV1
)

class AndroidBluetoothTransportRuntimeExceptionV1(
    val code: String,
    message: String,
    cause: Throwable? = null
) : RuntimeException(message, cause)

class AndroidBluetoothTransportRuntimeV1(
    private val routeAdvertisementEnabled: Boolean,
    private val commandBusShadowEnabled: Boolean,
    routeStore: RouteAdvertisementStoreV1,
    shadowHandler: BluetoothShadowHandlerV1,
    private val diagnosticCommandBus: BluetoothDiagnosticCommandBusV1? = null,
    private val healthProvider: BluetoothRouteHealthProviderV1,
    publisher: RouteAdvertisementPublisherV1? = null,
    private val schedule: AndroidBluetoothTransportScheduleV1 =
        AndroidHandlerBluetoothTransportScheduleV1(),
    private val tickIntervalMs: Long = 250,
    private val now: () -> Long = System::currentTimeMillis,
    private val onFatal: (AndroidBluetoothTransportRuntimeExceptionV1) -> Unit = {}
) : ReliableChannelMessageHandlerV1, BluetoothReliableRuntimeLifecycleV1, AutoCloseable {
    private val routeIngress = RouteAdvertisementIngressV1(
        routeStore,
        enabled = routeAdvertisementEnabled,
        now = now
    )
    private val publisher = publisher ?: RouteAdvertisementPublisherV1(
        ROUTE_ADVERTISEMENT_MAX_PUBLISH_INTERVAL_MS_V1,
        (routeStore as? RouteAdvertisementSequenceStoreV1)
            ?: InMemoryRouteAdvertisementSequenceStoreV1()
    )
    private val shadowIngress = BluetoothShadowIngressV1(
        shadowHandler,
        enabled = commandBusShadowEnabled,
        now = now
    )
    private val router = BluetoothTransportMessageRouterV1(routeIngress, shadowIngress)
    private var port: BluetoothReliableApplicationPortV1? = null
    private var emitter: RouteAdvertisementEmitterV1? = null
    private var shadowAdapter: BluetoothCommandBusShadowAdapterV1? = null
    private var diagnosticSubscription: AutoCloseable? = null
    private var scheduleHandle: AutoCloseable? = null
    private var state = AndroidBluetoothTransportRuntimeStateV1.IDLE
    private var ticks = 0L
    private var tickFailures = 0L
    private var restoredDurableMessages = 0L
    private var routesSent = 0L

    init {
        if (commandBusShadowEnabled && !routeAdvertisementEnabled) {
            fail(
                "INVALID_RUNTIME_CONFIGURATION",
                "B10 shadow requires B9 route advertisement"
            )
        }
        if (tickIntervalMs !in 50..ROUTE_ADVERTISEMENT_MAX_PUBLISH_INTERVAL_MS_V1) {
            fail("INVALID_RUNTIME_CONFIGURATION", "runtime tick interval is out of range")
        }
    }

    @Synchronized
    fun attachPort(value: BluetoothReliableApplicationPortV1) {
        if (port != null || state != AndroidBluetoothTransportRuntimeStateV1.IDLE) {
            fail("INVALID_PORT_BINDING", "runtime accepts exactly one port before start")
        }
        port = value
        val channel = object : RouteAdvertisementChannelV1, BluetoothShadowChannelV1 {
            override fun send(input: ReliableChannelSendInputV1) = value.send(input)
        }
        emitter = RouteAdvertisementEmitterV1(
            publisher,
            channel,
            enabled = routeAdvertisementEnabled
        )
        shadowAdapter = BluetoothCommandBusShadowAdapterV1(
            channel,
            shadowIngress,
            enabled = commandBusShadowEnabled,
            now = now
        )
    }

    @Synchronized
    override fun start(): Boolean {
        if (state == AndroidBluetoothTransportRuntimeStateV1.RUNNING) return true
        if (state != AndroidBluetoothTransportRuntimeStateV1.IDLE) {
            fail("RUNTIME_NOT_STARTABLE", "Bluetooth transport runtime is not startable")
        }
        if (!routeAdvertisementEnabled && !commandBusShadowEnabled) {
            state = AndroidBluetoothTransportRuntimeStateV1.STOPPED
            return false
        }
        val activePort = port
            ?: fail("PORT_NOT_ATTACHED", "Bluetooth reliable application port is missing")
        if (!activePort.available) {
            state = AndroidBluetoothTransportRuntimeStateV1.BLOCKED
            return false
        }
        state = AndroidBluetoothTransportRuntimeStateV1.RUNNING
        if (commandBusShadowEnabled) {
            diagnosticSubscription = diagnosticCommandBus?.subscribe { command ->
                emitDiagnostic(command.kind, command.body, command.lanLatencyMs)
            }
        }
        if (runTickLocked(restore = true) != null) return false
        scheduleHandle = try {
            schedule.schedule(
                tickIntervalMs,
                operation = ::guardedTick,
                onRejected = ::handleScheduleRejected
            )
        } catch (error: Throwable) {
            failRuntimeLocked(
                "RUNTIME_SCHEDULE_REJECTED",
                "Bluetooth transport runtime schedule was rejected",
                error
            )
            null
        }
        return state == AndroidBluetoothTransportRuntimeStateV1.RUNNING &&
            scheduleHandle != null
    }

    @Synchronized
    override fun onMessage(message: ReliableMessageV1) {
        if (state != AndroidBluetoothTransportRuntimeStateV1.RUNNING) {
            fail("RUNTIME_NOT_RUNNING", "upper-layer delivery requires a running runtime")
        }
        router.onMessage(message)
    }

    @Synchronized
    fun emitDiagnostic(
        kind: BluetoothShadowKindV1,
        body: String,
        lanLatencyMs: Long? = null
    ): BluetoothShadowEmitResultV1 {
        if (state != AndroidBluetoothTransportRuntimeStateV1.RUNNING) {
            fail("RUNTIME_NOT_RUNNING", "diagnostic shadow requires a running runtime")
        }
        return checkNotNull(shadowAdapter).emitDiagnostic(kind, body, lanLatencyMs)
    }

    @Synchronized
    fun routeReachability(nowEpochMs: Long = now()): RouteReachabilityV1 =
        routeIngress.reachability(nowEpochMs)

    @Synchronized
    override fun suspendForLinkLoss() {
        if (state == AndroidBluetoothTransportRuntimeStateV1.STOPPED) return
        diagnosticSubscription?.close()
        diagnosticSubscription = null
        scheduleHandle?.close()
        scheduleHandle = null
        port?.reset()
        state = AndroidBluetoothTransportRuntimeStateV1.IDLE
    }

    @Synchronized
    fun snapshot(): AndroidBluetoothTransportRuntimeSnapshotV1 {
        val activePort = port ?: UnavailableBluetoothReliableApplicationPortV1
        val adapter = shadowAdapter ?: BluetoothCommandBusShadowAdapterV1(
            BluetoothShadowChannelV1 { UnavailableBluetoothReliableApplicationPortV1.send(it) },
            shadowIngress
        )
        return AndroidBluetoothTransportRuntimeSnapshotV1(
            state = state,
            routeAdvertisementEnabled = routeAdvertisementEnabled,
            commandBusShadowEnabled = commandBusShadowEnabled,
            ticks = ticks,
            tickFailures = tickFailures,
            restoredDurableMessages = restoredDurableMessages,
            routesSent = routesSent,
            businessMessagesForwarded = 0,
            businessTransport = BLUETOOTH_SHADOW_BUSINESS_TRANSPORT_V1,
            port = activePort.snapshot(),
            router = router.snapshot(),
            routeIngress = routeIngress.snapshot(),
            shadow = adapter.snapshot(),
            diagnosticCommandBus = diagnosticCommandBus?.snapshot()
                ?: BluetoothDiagnosticCommandBusSnapshotV1(
                    activeSubscribers = 0,
                    published = 0,
                    delivered = 0,
                    failures = 0
                )
        )
    }

    @Synchronized
    override fun close() {
        diagnosticSubscription?.close()
        diagnosticSubscription = null
        scheduleHandle?.close()
        scheduleHandle = null
        port?.reset()
        state = AndroidBluetoothTransportRuntimeStateV1.STOPPED
    }

    private fun guardedTick() {
        val failure = synchronized(this) { runTickLocked(restore = false) }
        failure?.let(::notifyFatal)
    }

    private fun handleScheduleRejected(cause: Throwable) {
        val failure = synchronized(this) {
            if (state != AndroidBluetoothTransportRuntimeStateV1.RUNNING) {
                null
            } else {
                failRuntimeLocked(
                    "RUNTIME_SCHEDULE_REJECTED",
                    "Bluetooth transport runtime reschedule was rejected",
                    cause
                )
            }
        }
        failure?.let(::notifyFatal)
    }

    private fun runTickLocked(
        restore: Boolean
    ): AndroidBluetoothTransportRuntimeExceptionV1? {
        if (state != AndroidBluetoothTransportRuntimeStateV1.RUNNING) return null
        return try {
            val activePort = checkNotNull(port)
            if (restore) restoredDurableMessages += activePort.restoreBound()
            activePort.tick()
            val current = now()
            val health = healthProvider.snapshot(current)
            val result = checkNotNull(emitter).update(
                RouteAdvertisementBuildInputV1(
                    nowEpochMs = current,
                    canReachServer = health.canReachServer,
                    routeKind = health.routeKind,
                    serverRttMs = health.serverRttMs,
                    lastRouteChangeAtEpochMs = health.lastRouteChangeAtEpochMs,
                    queueDepth = health.queueDepth,
                    batteryPercent = health.batteryPercent
                )
            )
            if (result.sent) routesSent += 1
            ticks += 1
            null
        } catch (error: Throwable) {
            failRuntimeLocked(
                if (restore) "RUNTIME_RESTORE_FAILED" else "RUNTIME_TICK_FAILED",
                if (restore) {
                    "Bluetooth transport durable restore failed"
                } else {
                    "Bluetooth transport runtime tick failed"
                },
                error
            )
        }
    }

    private fun failRuntimeLocked(
        code: String,
        message: String,
        cause: Throwable
    ): AndroidBluetoothTransportRuntimeExceptionV1 {
        tickFailures += 1
        state = AndroidBluetoothTransportRuntimeStateV1.FAILED
        diagnosticSubscription?.close()
        diagnosticSubscription = null
        scheduleHandle?.close()
        scheduleHandle = null
        runCatching { port?.reset() }
        return AndroidBluetoothTransportRuntimeExceptionV1(code, message, cause)
    }

    private fun notifyFatal(error: AndroidBluetoothTransportRuntimeExceptionV1) {
        runCatching { onFatal(error) }
    }

    private fun fail(code: String, message: String, cause: Throwable? = null): Nothing =
        throw AndroidBluetoothTransportRuntimeExceptionV1(code, message, cause)
}
