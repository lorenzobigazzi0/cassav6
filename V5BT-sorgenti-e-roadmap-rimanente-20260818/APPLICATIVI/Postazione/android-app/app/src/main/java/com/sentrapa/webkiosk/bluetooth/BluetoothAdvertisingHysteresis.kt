package com.sentrapa.webkiosk.bluetooth

internal enum class BluetoothAdvertisingHysteresisAction {
    NONE,
    APPLY_LOW_LATENCY,
    APPLY_BALANCED
}

internal data class BluetoothAdvertisingHysteresisDecision(
    val generation: Long,
    val action: BluetoothAdvertisingHysteresisAction,
    val mode: BluetoothAdvertiseMode,
    val downgradeAtMs: Long?
)

internal enum class AdvertisingDowngradeScheduleResult {
    ACCEPTED,
    ABORTED,
    FAILED
}

internal fun classifyAdvertisingDowngradePost(
    posted: Boolean,
    radioActive: Boolean,
    closed: Boolean
): AdvertisingDowngradeScheduleResult =
    when {
        posted -> AdvertisingDowngradeScheduleResult.ACCEPTED
        !radioActive || closed -> AdvertisingDowngradeScheduleResult.ABORTED
        else -> AdvertisingDowngradeScheduleResult.FAILED
    }

internal class BluetoothAdvertisingTimerSlot {
    private var pending: Runnable? = null

    @Synchronized
    fun reserve(candidate: Runnable): Boolean {
        if (pending != null) return false
        pending = candidate
        return true
    }

    @Synchronized
    fun releaseIfCurrent(candidate: Runnable): Boolean {
        if (pending !== candidate) return false
        pending = null
        return true
    }

    @Synchronized
    fun cancel(): Runnable? = pending.also { pending = null }

    @Synchronized
    fun hasPending(): Boolean = pending != null
}

internal class BluetoothAdvertisingHysteresis(
    private val graceMs: Long =
        BluetoothDiscoveryPolicy.RECIPROCAL_DISCOVERY_ADVERTISE_GRACE_MS
) {
    private var generation = 0L
    private var active = false
    private var mode =
        BluetoothDiscoveryPolicy.advertiseMode(BluetoothScanProfile.FAILOVER)
    private var downgradeAtMs: Long? = null
    private var lastClockMs: Long? = null

    init {
        require(graceMs > 0L)
    }

    @Synchronized
    fun start(nowMs: Long): BluetoothAdvertisingHysteresisDecision {
        acceptClock(nowMs)
        generation = nextGeneration(generation)
        active = true
        mode = BluetoothDiscoveryPolicy.advertiseMode(BluetoothScanProfile.FAILOVER)
        downgradeAtMs = null
        return decision(BluetoothAdvertisingHysteresisAction.APPLY_LOW_LATENCY)
    }

    @Synchronized
    fun onAcceptedObservation(nowMs: Long): BluetoothAdvertisingHysteresisDecision {
        acceptClock(nowMs)
        if (
            !active ||
            mode != BluetoothDiscoveryPolicy.advertiseMode(BluetoothScanProfile.FAILOVER)
        ) {
            return decision()
        }
        if (downgradeAtMs == null) {
            require(nowMs <= Long.MAX_VALUE - graceMs) {
                "advertising hysteresis deadline overflow"
            }
            downgradeAtMs = nowMs + graceMs
        }
        return decision()
    }

    @Synchronized
    fun enterFailover(nowMs: Long): BluetoothAdvertisingHysteresisDecision {
        acceptClock(nowMs)
        generation = nextGeneration(generation)
        downgradeAtMs = null
        if (!active) return decision()
        val failoverMode =
            BluetoothDiscoveryPolicy.advertiseMode(BluetoothScanProfile.FAILOVER)
        val changed = mode != failoverMode
        mode = failoverMode
        return decision(
            if (changed) {
                BluetoothAdvertisingHysteresisAction.APPLY_LOW_LATENCY
            } else {
                BluetoothAdvertisingHysteresisAction.NONE
            }
        )
    }

    @Synchronized
    fun onDowngradeTimer(
        expectedGeneration: Long,
        nowMs: Long
    ): BluetoothAdvertisingHysteresisDecision {
        if (!active || expectedGeneration != generation) return decision()
        acceptClock(nowMs)
        val deadline = downgradeAtMs ?: return decision()
        if (nowMs < deadline) return decision()
        downgradeAtMs = null
        val stableMode =
            BluetoothDiscoveryPolicy.advertiseMode(BluetoothScanProfile.STABLE)
        if (mode == stableMode) return decision()
        mode = stableMode
        return decision(BluetoothAdvertisingHysteresisAction.APPLY_BALANCED)
    }

    @Synchronized
    fun snapshot(): BluetoothAdvertisingHysteresisDecision = decision()

    @Synchronized
    fun stop() {
        generation = nextGeneration(generation)
        active = false
        mode = BluetoothDiscoveryPolicy.advertiseMode(BluetoothScanProfile.FAILOVER)
        downgradeAtMs = null
    }

    private fun decision(
        action: BluetoothAdvertisingHysteresisAction =
            BluetoothAdvertisingHysteresisAction.NONE
    ): BluetoothAdvertisingHysteresisDecision =
        BluetoothAdvertisingHysteresisDecision(
            generation = generation,
            action = action,
            mode = mode,
            downgradeAtMs = downgradeAtMs
        )

    private fun acceptClock(nowMs: Long) {
        require(nowMs >= 0L) {
            "monotonic clock must be non-negative"
        }
        val previous = lastClockMs
        require(previous == null || nowMs >= previous) {
            "monotonic clock must not move backwards"
        }
        lastClockMs = nowMs
    }

    private fun nextGeneration(current: Long): Long =
        if (current == Long.MAX_VALUE) 1L else current + 1L
}
