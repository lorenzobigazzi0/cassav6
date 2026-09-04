package com.sentrapa.cassav6.webkiosk.bluetooth

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.AtomicFile
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicBoolean

internal data class BluetoothAgentResourceSnapshot(
    val scannerActive: Boolean,
    val advertiserActive: Boolean,
    val gattServerActive: Boolean = false,
    val gattClientActive: Boolean = false,
    val sessionCount: Int = 0,
    val reliableClientActive: Boolean = false,
    val reliableServerActive: Boolean = false,
    val reliableArbitrationRejected: Long = 0
) {
    init {
        require(sessionCount >= 0)
        require(reliableArbitrationRejected >= 0)
    }
}

internal data class BluetoothAgentLabRuntimeSnapshot(
    val state: BluetoothConnectivityState,
    val metrics: BluetoothConnectivityMetricsSnapshot,
    val resources: BluetoothAgentResourceSnapshot
)

internal data class BluetoothAgentLabStatusV1(
    val sampleSequence: Long,
    val sampledAtEpochMs: Long,
    val reporterStartedAtEpochMs: Long,
    val state: BluetoothConnectivityState,
    val metrics: BluetoothConnectivityMetricsSnapshot,
    val resources: BluetoothAgentResourceSnapshot
) {
    fun toRedactedJson(): String = buildString {
        append('{')
        append("\"schemaVersion\":1,")
        append("\"source\":\"CASSA_V6_ANDROID_CONNECTIVITY_AGENT\",")
        append("\"labBuild\":true,")
        append("\"diagnosticsEnabled\":true,")
        append("\"agentEnabled\":true,")
        append("\"sampleSequence\":").append(sampleSequence).append(',')
        append("\"sampledAtEpochMs\":").append(sampledAtEpochMs).append(',')
        append("\"reporterStartedAtEpochMs\":")
            .append(reporterStartedAtEpochMs)
            .append(',')
        append("\"state\":\"").append(state.name).append("\",")
        append("\"metrics\":{")
        append("\"startCount\":").append(metrics.starts).append(',')
        append("\"stopCount\":").append(metrics.stops).append(',')
        append("\"backoffCount\":").append(metrics.backoffs).append(',')
        append("\"transitionCount\":").append(metrics.transitions).append(',')
        append("\"duplicateEventCount\":").append(metrics.duplicates).append(',')
        append("\"invalidTransitionCount\":").append(metrics.invalid)
        append("},")
        append("\"resources\":{")
        append("\"scannerActive\":").append(resources.scannerActive).append(',')
        append("\"advertiserActive\":").append(resources.advertiserActive).append(',')
        append("\"gattServerActive\":").append(resources.gattServerActive).append(',')
        append("\"gattClientActive\":").append(resources.gattClientActive).append(',')
        append("\"sessionCount\":").append(resources.sessionCount).append(',')
        append("\"reliableClientActive\":")
            .append(resources.reliableClientActive)
            .append(',')
        append("\"reliableServerActive\":")
            .append(resources.reliableServerActive)
            .append(',')
        append("\"reliableArbitrationRejected\":")
            .append(resources.reliableArbitrationRejected)
        append("}}")
    }
}

internal class BluetoothAgentLabReporter(
    context: Context,
    private val labBuild: Boolean,
    private val diagnosticsEnabled: Boolean,
    private val agentEnabled: Boolean,
    private val statusProvider: () -> BluetoothAgentLabRuntimeSnapshot,
    private val sampleIntervalMs: Long = SAMPLE_INTERVAL_MS
) : AutoCloseable {
    private val statusFile =
        AtomicFile(context.noBackupFilesDir.resolve(STATUS_FILE_NAME))
    private val closed = AtomicBoolean(false)
    private val reporterStartedAtEpochMs = System.currentTimeMillis()
    private var sampleSequence = 0L
    private var workerThread: HandlerThread? = null
    private var worker: Handler? = null

    private val publishStatus = object : Runnable {
        override fun run() {
            if (closed.get()) return
            runCatching {
                check(sampleSequence < Long.MAX_VALUE)
                sampleSequence += 1L
                val runtime = statusProvider()
                val status = BluetoothAgentLabStatusV1(
                    sampleSequence = sampleSequence,
                    sampledAtEpochMs = System.currentTimeMillis(),
                    reporterStartedAtEpochMs = reporterStartedAtEpochMs,
                    state = runtime.state,
                    metrics = runtime.metrics,
                    resources = runtime.resources
                )
                writeAtomically(status.toRedactedJson())
            }
            if (!closed.get()) worker?.postDelayed(this, sampleIntervalMs)
        }
    }

    init {
        require(sampleIntervalMs in MIN_SAMPLE_INTERVAL_MS..MAX_SAMPLE_INTERVAL_MS)
    }

    @Synchronized
    fun start() {
        if (
            closed.get() ||
            !labBuild ||
            !diagnosticsEnabled ||
            !agentEnabled ||
            workerThread != null
        ) {
            return
        }
        val thread = HandlerThread("CASSA_V6-BluetoothAgentReport").apply { start() }
        val handler = Handler(thread.looper)
        workerThread = thread
        worker = handler
        handler.post(publishStatus)
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        synchronized(this) {
            worker?.removeCallbacks(publishStatus)
            worker = null
            workerThread?.quitSafely()
            workerThread = null
        }
    }

    private fun writeAtomically(json: String) {
        var output: FileOutputStream? = null
        try {
            output = statusFile.startWrite()
            output.write("$json\n".toByteArray(Charsets.UTF_8))
            output.fd.sync()
            statusFile.finishWrite(output)
        } catch (_: Exception) {
            statusFile.failWrite(output)
        }
    }

    companion object {
        const val STATUS_FILE_NAME = "bluetooth-connectivity-agent-status-v1.json"
        private const val SAMPLE_INTERVAL_MS = 2_000L
        private const val MIN_SAMPLE_INTERVAL_MS = 250L
        private const val MAX_SAMPLE_INTERVAL_MS = 5_000L
    }
}
