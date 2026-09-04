package com.sentrapa.webkiosk.bluetooth

enum class BluetoothScanCommand {
    NONE,
    START,
    STOP,
    RESTART
}

data class BluetoothScanDecision(
    val evaluatedAtMs: Long,
    val profile: BluetoothScanProfile,
    val scanning: Boolean,
    val command: BluetoothScanCommand,
    val windowIndex: Long,
    val windowStartAtMs: Long,
    val windowEndAtMs: Long,
    val nextTransitionAtMs: Long
)

class BluetoothScanWindowScheduler(
    initialProfile: BluetoothScanProfile,
    startedAtMs: Long
) {
    private var profile = initialProfile
    private var profileStartedAtMs = requireValidInitialClock(startedAtMs)
    private var lastClockMs = startedAtMs
    private var lastDecisionScanning = false
    private var lastDecisionProfile: BluetoothScanProfile? = null
    private var lastDecisionWindowIndex: Long? = null

    fun setProfile(nextProfile: BluetoothScanProfile, nowMs: Long): Boolean {
        acceptClock(nowMs)
        if (profile == nextProfile) return false
        profile = nextProfile
        profileStartedAtMs = nowMs
        return true
    }

    fun evaluate(nowMs: Long): BluetoothScanDecision {
        acceptClock(nowMs)
        val schedule = BluetoothDiscoveryPolicy.scanWindow(profile)
        val elapsedMs = nowMs - profileStartedAtMs
        val windowIndex = elapsedMs / schedule.periodMs
        val periodOffsetMs = elapsedMs % schedule.periodMs
        val windowStartAtMs = nowMs - periodOffsetMs
        val windowEndAtMs = windowStartAtMs + schedule.windowMs
        val scanning = periodOffsetMs < schedule.windowMs
        val nextTransitionAtMs =
            if (scanning) windowEndAtMs else windowStartAtMs + schedule.periodMs

        val command =
            when {
                scanning != lastDecisionScanning ->
                    if (scanning) BluetoothScanCommand.START else BluetoothScanCommand.STOP
                scanning &&
                    lastDecisionProfile != null &&
                    (
                        profile != lastDecisionProfile ||
                            windowIndex != lastDecisionWindowIndex
                        ) ->
                    BluetoothScanCommand.RESTART
                else ->
                    BluetoothScanCommand.NONE
            }
        lastDecisionScanning = scanning
        lastDecisionProfile = profile
        lastDecisionWindowIndex = windowIndex

        return BluetoothScanDecision(
            evaluatedAtMs = nowMs,
            profile = profile,
            scanning = scanning,
            command = command,
            windowIndex = windowIndex,
            windowStartAtMs = windowStartAtMs,
            windowEndAtMs = windowEndAtMs,
            nextTransitionAtMs = nextTransitionAtMs
        )
    }

    private fun acceptClock(nowMs: Long) {
        require(nowMs >= 0L) {
            "monotonic clock must be non-negative"
        }
        require(nowMs >= lastClockMs) {
            "monotonic clock must not move backwards"
        }
        lastClockMs = nowMs
    }

    companion object {
        private fun requireValidInitialClock(startedAtMs: Long): Long {
            require(startedAtMs >= 0L) {
                "monotonic clock must be non-negative"
            }
            return startedAtMs
        }
    }
}
