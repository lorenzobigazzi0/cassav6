package com.sentrapa.cassav6.webkiosk.bluetooth

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

const val BLUETOOTH_BATTERY_SAMPLE_INTERVAL_MS_V1 = 120_000L
const val BLUETOOTH_BATTERY_SAMPLE_MAX_AGE_MS_V1 =
    BLUETOOTH_BATTERY_SAMPLE_INTERVAL_MS_V1 * 3
const val BLUETOOTH_QUEUE_SAMPLE_INTERVAL_MS_V1 = 1_000L
const val BLUETOOTH_BACKEND_LINK_MAX_AGE_MS_V1 = 2_500L

enum class BluetoothBackendLinkStateV1 {
    REACHABLE,
    UNREACHABLE
}

data class BluetoothBackendLinkObservationV1(
    val state: BluetoothBackendLinkStateV1,
    val serverRttMs: Double?,
    val observedAtEpochMs: Long,
    val observedAtElapsedRealtimeMs: Long
)

data class BluetoothBatteryObservationV1(
    val percent: Double,
    val observedAtEpochMs: Long,
    val observedAtElapsedRealtimeMs: Long
)

data class BluetoothRouteHealthSignalSnapshotV1(
    val backend: BluetoothBackendLinkObservationV1?,
    val battery: BluetoothBatteryObservationV1?
)

interface BluetoothBackendLinkObserverV1 {
    fun open(observedAtEpochMs: Long, observedAtElapsedRealtimeMs: Long):
        BluetoothBackendLinkSessionV1

    fun reachable(
        session: BluetoothBackendLinkSessionV1,
        serverRttMs: Double,
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): Boolean

    fun unreachable(
        session: BluetoothBackendLinkSessionV1,
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): Boolean

    fun close(
        session: BluetoothBackendLinkSessionV1,
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): Boolean
}

data class BluetoothBackendLinkSessionV1 internal constructor(internal val generation: Long)

fun interface BluetoothBatteryObserverV1 {
    fun observe(
        percent: Double,
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): Boolean
}

fun interface BluetoothRouteHealthSignalSourceV1 {
    fun snapshotSignals(): BluetoothRouteHealthSignalSnapshotV1
}

fun interface BluetoothRouteKindSourceV1 {
    fun currentRouteKind(): BluetoothRouteKindV1
}

fun interface BluetoothQueueDepthSourceV1 {
    fun currentQueueDepth(): Long
}

class BluetoothDynamicRouteHealthExceptionV1(
    val code: String,
    message: String
) : RuntimeException(message)

class BluetoothRouteHealthSignalStoreV1(
    private val batterySampleIntervalMs: Long =
        BLUETOOTH_BATTERY_SAMPLE_INTERVAL_MS_V1
) : BluetoothBackendLinkObserverV1,
    BluetoothBatteryObserverV1,
    BluetoothRouteHealthSignalSourceV1 {
    private var backend: BluetoothBackendLinkObservationV1? = null
    private var battery: BluetoothBatteryObservationV1? = null
    private var backendClockHighWatermarkMs = 0L
    private var backendElapsedRealtimeHighWatermarkMs = 0L
    private var backendGeneration = 0L
    private var activeBackendGeneration: Long? = null
    private var batteryClockHighWatermarkMs = 0L
    private var batteryElapsedRealtimeHighWatermarkMs = 0L

    init {
        require(batterySampleIntervalMs > 0L)
    }

    @Synchronized
    override fun open(
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): BluetoothBackendLinkSessionV1 {
        require(observedAtEpochMs >= 0L && observedAtElapsedRealtimeMs >= 0L)
        if (
            observedAtEpochMs < backendClockHighWatermarkMs ||
            observedAtElapsedRealtimeMs < backendElapsedRealtimeHighWatermarkMs
        ) {
            backend = null
            activeBackendGeneration = null
            throw BluetoothDynamicRouteHealthExceptionV1(
                "CLOCK_REGRESSION",
                "backend link session clock moved backwards"
            )
        }
        if (backendGeneration == Long.MAX_VALUE) {
            throw BluetoothDynamicRouteHealthExceptionV1(
                "LINK_SESSION_EXHAUSTED",
                "backend link session generation is exhausted"
            )
        }
        backendGeneration += 1L
        activeBackendGeneration = backendGeneration
        backendClockHighWatermarkMs = maxOf(
            backendClockHighWatermarkMs,
            observedAtEpochMs
        )
        backendElapsedRealtimeHighWatermarkMs = maxOf(
            backendElapsedRealtimeHighWatermarkMs,
            observedAtElapsedRealtimeMs
        )
        backend = null
        return BluetoothBackendLinkSessionV1(backendGeneration)
    }

    @Synchronized
    override fun reachable(
        session: BluetoothBackendLinkSessionV1,
        serverRttMs: Double,
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): Boolean {
        require(serverRttMs.isFinite() && serverRttMs >= 0.0)
        if (!advanceBackendClock(session, observedAtEpochMs, observedAtElapsedRealtimeMs)) {
            return false
        }
        backend = BluetoothBackendLinkObservationV1(
            BluetoothBackendLinkStateV1.REACHABLE,
            serverRttMs,
            observedAtEpochMs,
            observedAtElapsedRealtimeMs
        )
        return true
    }

    @Synchronized
    override fun unreachable(
        session: BluetoothBackendLinkSessionV1,
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): Boolean {
        if (!advanceBackendClock(session, observedAtEpochMs, observedAtElapsedRealtimeMs)) {
            return false
        }
        backend = BluetoothBackendLinkObservationV1(
            BluetoothBackendLinkStateV1.UNREACHABLE,
            null,
            observedAtEpochMs,
            observedAtElapsedRealtimeMs
        )
        return true
    }

    @Synchronized
    override fun close(
        session: BluetoothBackendLinkSessionV1,
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): Boolean {
        if (!advanceBackendClock(session, observedAtEpochMs, observedAtElapsedRealtimeMs)) {
            return false
        }
        backend = null
        activeBackendGeneration = null
        return true
    }

    @Synchronized
    override fun observe(
        percent: Double,
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): Boolean {
        require(percent.isFinite() && percent in 0.0..100.0)
        require(observedAtEpochMs >= 0L)
        require(observedAtElapsedRealtimeMs >= 0L)
        if (
            observedAtEpochMs < batteryClockHighWatermarkMs ||
            observedAtElapsedRealtimeMs < batteryElapsedRealtimeHighWatermarkMs
        ) {
            battery = null
            return false
        }
        batteryClockHighWatermarkMs = observedAtEpochMs
        batteryElapsedRealtimeHighWatermarkMs = observedAtElapsedRealtimeMs
        val previous = battery
        if (
            previous != null &&
            observedAtElapsedRealtimeMs - previous.observedAtElapsedRealtimeMs <
                batterySampleIntervalMs
        ) return false
        battery = BluetoothBatteryObservationV1(
            percent,
            observedAtEpochMs,
            observedAtElapsedRealtimeMs
        )
        return true
    }

    @Synchronized
    override fun snapshotSignals(): BluetoothRouteHealthSignalSnapshotV1 =
        BluetoothRouteHealthSignalSnapshotV1(backend, battery)

    @Synchronized
    fun failClosed(session: BluetoothBackendLinkSessionV1?) {
        if (session == null || session.generation == activeBackendGeneration) {
            backend = null
            activeBackendGeneration = null
        }
    }

    private fun advanceBackendClock(
        session: BluetoothBackendLinkSessionV1,
        candidateEpochMs: Long,
        candidateElapsedMs: Long
    ): Boolean {
        require(candidateEpochMs >= 0L && candidateElapsedMs >= 0L)
        if (session.generation != activeBackendGeneration) return false
        if (
            candidateEpochMs < backendClockHighWatermarkMs ||
            candidateElapsedMs < backendElapsedRealtimeHighWatermarkMs
        ) {
            backend = null
            activeBackendGeneration = null
            return false
        }
        backendClockHighWatermarkMs = candidateEpochMs
        backendElapsedRealtimeHighWatermarkMs = candidateElapsedMs
        return true
    }
}

object BluetoothDynamicRouteHealthSignalsV1 :
    BluetoothBackendLinkObserverV1,
    BluetoothBatteryObserverV1,
    BluetoothRouteHealthSignalSourceV1 {
    private val store = BluetoothRouteHealthSignalStoreV1()

    override fun open(
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): BluetoothBackendLinkSessionV1 =
        store.open(observedAtEpochMs, observedAtElapsedRealtimeMs)

    override fun reachable(
        session: BluetoothBackendLinkSessionV1,
        serverRttMs: Double,
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): Boolean = store.reachable(
        session,
        serverRttMs,
        observedAtEpochMs,
        observedAtElapsedRealtimeMs
    )

    override fun unreachable(
        session: BluetoothBackendLinkSessionV1,
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): Boolean = store.unreachable(
        session,
        observedAtEpochMs,
        observedAtElapsedRealtimeMs
    )

    override fun close(
        session: BluetoothBackendLinkSessionV1,
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): Boolean = store.close(session, observedAtEpochMs, observedAtElapsedRealtimeMs)

    override fun observe(
        percent: Double,
        observedAtEpochMs: Long,
        observedAtElapsedRealtimeMs: Long
    ): Boolean = store.observe(percent, observedAtEpochMs, observedAtElapsedRealtimeMs)

    override fun snapshotSignals(): BluetoothRouteHealthSignalSnapshotV1 =
        store.snapshotSignals()
}

class AndroidBluetoothRouteKindSourceV1(context: Context) : BluetoothRouteKindSourceV1 {
    private val connectivityManager =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as
            ConnectivityManager

    override fun currentRouteKind(): BluetoothRouteKindV1 = runCatching {
        val network = connectivityManager.activeNetwork ?: return@runCatching BluetoothRouteKindV1.NONE
        val capabilities = connectivityManager.getNetworkCapabilities(network)
            ?: return@runCatching BluetoothRouteKindV1.NONE
        BluetoothRouteKindClassifierV1.classify(
            wifi = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
            ethernet = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
            usb = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_USB)
        )
    }.getOrDefault(BluetoothRouteKindV1.NONE)
}

internal object BluetoothRouteKindClassifierV1 {
    fun classify(
        wifi: Boolean,
        ethernet: Boolean,
        usb: Boolean
    ): BluetoothRouteKindV1 = when {
        wifi -> BluetoothRouteKindV1.WIFI
        ethernet || usb -> BluetoothRouteKindV1.LAN
        else -> BluetoothRouteKindV1.NONE
    }
}

class DynamicBluetoothRouteHealthProviderV1(
    private val signalSource: BluetoothRouteHealthSignalSourceV1,
    private val routeKindSource: BluetoothRouteKindSourceV1,
    private val queueDepthSource: BluetoothQueueDepthSourceV1,
    private val elapsedRealtimeMs: () -> Long,
    private val queueSampleIntervalMs: Long = BLUETOOTH_QUEUE_SAMPLE_INTERVAL_MS_V1,
    private val batteryMaximumAgeMs: Long = BLUETOOTH_BATTERY_SAMPLE_MAX_AGE_MS_V1
) : BluetoothRouteHealthProviderV1 {
    private var lastSnapshotAtEpochMs: Long? = null
    private var lastSnapshotAtElapsedRealtimeMs: Long? = null
    private var clockFailed = false
    private var lastRouteState: Pair<Boolean, BluetoothRouteKindV1>? = null
    private var lastRouteChangeAtEpochMs = 0L
    private var queueDepth = 0L
    private var queueSampledAtEpochMs: Long? = null

    init {
        require(queueSampleIntervalMs > 0L)
        require(batteryMaximumAgeMs >= BLUETOOTH_BATTERY_SAMPLE_INTERVAL_MS_V1)
    }

    @Synchronized
    override fun snapshot(nowEpochMs: Long): BluetoothRouteHealthV1 {
        val nowElapsedRealtimeMs = elapsedRealtimeMs()
        checkClock(nowEpochMs, nowElapsedRealtimeMs)
        val signals = signalSource.snapshotSignals()
        val routeKind = routeKindSource.currentRouteKind()
        val resolved = resolveRoute(signals.backend, routeKind, nowElapsedRealtimeMs)
        val routeState = resolved.first to resolved.second
        if (lastRouteState == null || lastRouteState != routeState) {
            lastRouteState = routeState
            lastRouteChangeAtEpochMs = nowEpochMs
        }
        val sampledAt = queueSampledAtEpochMs
        if (sampledAt == null || nowEpochMs - sampledAt >= queueSampleIntervalMs) {
            queueDepth = queueDepthSource.currentQueueDepth().also {
                if (it < 0L) failure("INVALID_QUEUE_DEPTH", "queue depth cannot be negative")
            }
            queueSampledAtEpochMs = nowEpochMs
        }
        val battery = signals.battery?.takeIf {
            nowElapsedRealtimeMs >= it.observedAtElapsedRealtimeMs &&
                nowElapsedRealtimeMs - it.observedAtElapsedRealtimeMs <= batteryMaximumAgeMs
        }?.percent
        return BluetoothRouteHealthV1(
            canReachServer = resolved.first,
            routeKind = resolved.second,
            serverRttMs = resolved.third,
            lastRouteChangeAtEpochMs = lastRouteChangeAtEpochMs,
            queueDepth = queueDepth,
            batteryPercent = battery
        )
    }

    @Synchronized
    fun currentServerReachable(): Boolean {
        val currentElapsedRealtimeMs = elapsedRealtimeMs()
        checkElapsedClock(currentElapsedRealtimeMs)
        val signals = signalSource.snapshotSignals()
        return resolveRoute(
            signals.backend,
            routeKindSource.currentRouteKind(),
            currentElapsedRealtimeMs
        ).first
    }

    private fun checkClock(nowEpochMs: Long, nowElapsedRealtimeMs: Long) {
        if (clockFailed) {
            failure("CLOCK_REGRESSION", "route health clock is latched failed")
        }
        if (nowEpochMs < 0L || nowElapsedRealtimeMs < 0L) {
            failure("INVALID_CLOCK", "route health clocks cannot be negative")
        }
        val previousEpoch = lastSnapshotAtEpochMs
        val previousElapsed = lastSnapshotAtElapsedRealtimeMs
        if (
            previousEpoch != null && nowEpochMs < previousEpoch ||
            previousElapsed != null && nowElapsedRealtimeMs < previousElapsed
        ) {
            clockFailed = true
            failure("CLOCK_REGRESSION", "route health clock moved backwards")
        }
        lastSnapshotAtEpochMs = nowEpochMs
        lastSnapshotAtElapsedRealtimeMs = nowElapsedRealtimeMs
    }

    private fun checkElapsedClock(nowElapsedRealtimeMs: Long) {
        if (clockFailed) {
            failure("CLOCK_REGRESSION", "route health clock is latched failed")
        }
        if (nowElapsedRealtimeMs < 0L) {
            failure("INVALID_CLOCK", "route health monotonic clock cannot be negative")
        }
        val previous = lastSnapshotAtElapsedRealtimeMs
        if (previous != null && nowElapsedRealtimeMs < previous) {
            clockFailed = true
            failure("CLOCK_REGRESSION", "route health monotonic clock moved backwards")
        }
        lastSnapshotAtElapsedRealtimeMs = nowElapsedRealtimeMs
    }

    private fun resolveRoute(
        backend: BluetoothBackendLinkObservationV1?,
        routeKind: BluetoothRouteKindV1,
        nowElapsedRealtimeMs: Long
    ): Triple<Boolean, BluetoothRouteKindV1, Double?> {
        val currentBackend = backend?.takeIf {
            nowElapsedRealtimeMs >= it.observedAtElapsedRealtimeMs &&
                nowElapsedRealtimeMs - it.observedAtElapsedRealtimeMs <=
                    BLUETOOTH_BACKEND_LINK_MAX_AGE_MS_V1
        }
        if (currentBackend == null || routeKind == BluetoothRouteKindV1.NONE) {
            return Triple(false, BluetoothRouteKindV1.NONE, null)
        }
        if (routeKind == BluetoothRouteKindV1.BLE_DIRECT) {
            failure("INVALID_ROUTE_KIND", "local backend health cannot use BLE_DIRECT")
        }
        return if (currentBackend.state == BluetoothBackendLinkStateV1.REACHABLE) {
            Triple(true, routeKind, checkNotNull(currentBackend.serverRttMs))
        } else {
            Triple(false, routeKind, null)
        }
    }

    private fun failure(code: String, message: String): Nothing =
        throw BluetoothDynamicRouteHealthExceptionV1(code, message)
}
