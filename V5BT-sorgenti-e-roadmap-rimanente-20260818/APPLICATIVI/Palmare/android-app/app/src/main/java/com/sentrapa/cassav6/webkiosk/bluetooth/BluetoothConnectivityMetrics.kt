package com.sentrapa.cassav6.webkiosk.bluetooth

data class BluetoothConnectivityMetricsSnapshot(
    val starts: Long,
    val stops: Long,
    val backoffs: Long,
    val transitions: Long,
    val duplicates: Long,
    val invalid: Long
)

class BluetoothConnectivityMetrics {
    private var starts = 0L
    private var stops = 0L
    private var backoffs = 0L
    private var transitions = 0L
    private var duplicates = 0L
    private var invalid = 0L

    @Synchronized
    fun record(result: BluetoothConnectivityTransition) {
        when (result.disposition) {
            BluetoothConnectivityTransitionDisposition.TRANSITIONED -> {
                transitions = incrementSaturated(transitions)
                if (
                    result.event == BluetoothConnectivityEvent.START_REQUESTED &&
                    result.to == BluetoothConnectivityState.STARTING
                ) {
                    starts = incrementSaturated(starts)
                }
                if (
                    result.event == BluetoothConnectivityEvent.STOP_REQUESTED &&
                    result.to == BluetoothConnectivityState.STOPPED
                ) {
                    stops = incrementSaturated(stops)
                }
                if (result.to == BluetoothConnectivityState.BACKOFF) {
                    backoffs = incrementSaturated(backoffs)
                }
            }
            BluetoothConnectivityTransitionDisposition.IDEMPOTENT ->
                duplicates = incrementSaturated(duplicates)
            BluetoothConnectivityTransitionDisposition.INVALID,
            BluetoothConnectivityTransitionDisposition.FUTURE_GUARDED ->
                invalid = incrementSaturated(invalid)
        }
    }

    @Synchronized
    fun snapshot() = BluetoothConnectivityMetricsSnapshot(
        starts = starts,
        stops = stops,
        backoffs = backoffs,
        transitions = transitions,
        duplicates = duplicates,
        invalid = invalid
    )

    private fun incrementSaturated(value: Long): Long =
        if (value == Long.MAX_VALUE) Long.MAX_VALUE else value + 1L
}
