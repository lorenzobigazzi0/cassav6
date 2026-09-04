package com.sentrapa.webkiosk.bluetooth

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.AtomicFile
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicBoolean

internal data class BluetoothDiscoveryLabRuntimeSnapshot(
    val readiness: BluetoothDiscoveryReadiness,
    val radioActive: Boolean,
    val scanProfile: BluetoothScanProfile,
    val activePeerCount: Int,
    val metrics: BluetoothDiscoveryMetricsSnapshot
) {
    init {
        require(activePeerCount in 0..BluetoothDiscoveryPolicy.MAX_PEER_STREAMS)
    }
}

internal data class BluetoothDiscoveryLabStatusV1(
    val sampleSequence: Long,
    val sampledAtEpochMs: Long,
    val reporterStartedAtEpochMs: Long,
    val readiness: BluetoothDiscoveryReadiness,
    val radioActive: Boolean,
    val scanProfile: BluetoothScanProfile,
    val activePeerCount: Int,
    val metrics: BluetoothDiscoveryMetricsSnapshot
) {
    fun toRedactedJson(): String = buildString {
        append('{')
        append("\"schemaVersion\":1,")
        append("\"source\":\"V5BT_ANDROID_DISCOVERY_LAB\",")
        append("\"labBuild\":true,")
        append("\"diagnosticsEnabled\":true,")
        append("\"sampleSequence\":").append(sampleSequence).append(',')
        append("\"sampledAtEpochMs\":").append(sampledAtEpochMs).append(',')
        append("\"reporterStartedAtEpochMs\":")
            .append(reporterStartedAtEpochMs)
            .append(',')
        append("\"readiness\":\"").append(readiness.name).append("\",")
        append("\"ready\":").append(readiness == BluetoothDiscoveryReadiness.READY).append(',')
        append("\"radioActive\":").append(radioActive).append(',')
        append("\"scanProfile\":\"").append(scanProfile.name).append("\",")
        append("\"activePeerCount\":").append(activePeerCount).append(',')
        append("\"metrics\":{")
        append("\"scanWindowsStarted\":").append(metrics.scanWindowsStarted).append(',')
        append("\"concurrentScanAdvertiseWindowsStarted\":")
            .append(metrics.concurrentScanAdvertiseWindowsStarted)
            .append(',')
        append("\"scanWindowsCompleted\":").append(metrics.scanWindowsCompleted).append(',')
        append("\"scanFailures\":").append(metrics.scanFailures).append(',')
        append("\"rawCallbacks\":").append(metrics.rawCallbacks).append(',')
        append("\"uuidMatches\":").append(metrics.uuidMatches).append(',')
        append("\"validPayloads\":").append(metrics.validPayloads).append(',')
        append("\"advertisementsStarted\":").append(metrics.advertisementsStarted).append(',')
        append("\"advertisementUpdates\":").append(metrics.advertisementUpdates).append(',')
        append("\"advertisementFailures\":").append(metrics.advertisementFailures).append(',')
        append("\"invalidPayloads\":").append(metrics.invalidPayloads).append(',')
        append("\"acceptedObservations\":").append(metrics.acceptedObservations).append(',')
        append("\"scanIngressDropped\":").append(metrics.scanIngressDropped).append(',')
        append("\"peerExpiryCount\":").append(metrics.peerExpiryCount).append(',')
        append("\"firstObservationOffsetP95Ms\":")
        val offsetP95Ms = metrics.firstObservationOffsetP95Ms
        if (offsetP95Ms == null) {
            append("null")
        } else {
            append(offsetP95Ms)
        }
        append(',')
        append("\"peerDirectory\":{")
        append("\"added\":").append(metrics.peerDirectory.added).append(',')
        append("\"updated\":").append(metrics.peerDirectory.updated).append(',')
        append("\"duplicateRefreshes\":")
            .append(metrics.peerDirectory.duplicateRefreshes)
            .append(',')
        append("\"belowRssiFloor\":").append(metrics.peerDirectory.belowRssiFloor).append(',')
        append("\"olderRejected\":").append(metrics.peerDirectory.olderRejected).append(',')
        append("\"ambiguousRejected\":")
            .append(metrics.peerDirectory.ambiguousRejected)
            .append(',')
        append("\"conflicts\":").append(metrics.peerDirectory.conflicts).append(',')
        append("\"directoryFull\":").append(metrics.peerDirectory.directoryFull).append(',')
        append("\"newStreamAttemptRateRejected\":")
            .append(metrics.peerDirectory.newStreamAttemptRateRejected)
            .append(',')
        append("\"capacityEvicted\":").append(metrics.peerDirectory.capacityEvicted).append(',')
        append("\"clockRegressions\":")
            .append(metrics.peerDirectory.clockRegressions)
            .append(',')
        append("\"expired\":").append(metrics.peerDirectory.expired).append(',')
        append("\"prunePasses\":").append(metrics.peerDirectory.prunePasses).append(',')
        append("\"newStreamAttempts\":")
            .append(metrics.peerDirectory.newStreamAttempts)
            .append(',')
        append("\"newStreamsAccepted\":")
            .append(metrics.peerDirectory.newStreamsAccepted)
            .append(',')
        append("\"newStreamAttemptWindowsStarted\":")
            .append(metrics.peerDirectory.newStreamAttemptWindowsStarted)
            .append(',')
        append("\"capacityHighWatermark\":")
            .append(metrics.peerDirectory.capacityHighWatermark)
        append("}}")
        append('}')
    }
}

internal class BluetoothDiscoveryLabReporter(
    context: Context,
    private val labBuild: Boolean,
    private val diagnosticsEnabled: Boolean,
    private val statusProvider: () -> BluetoothDiscoveryLabRuntimeSnapshot,
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
                sampleSequence += 1L
                val runtime = statusProvider()
                val status = BluetoothDiscoveryLabStatusV1(
                    sampleSequence = sampleSequence,
                    sampledAtEpochMs = System.currentTimeMillis(),
                    reporterStartedAtEpochMs = reporterStartedAtEpochMs,
                    readiness = runtime.readiness,
                    radioActive = runtime.radioActive,
                    scanProfile = runtime.scanProfile,
                    activePeerCount = runtime.activePeerCount,
                    metrics = runtime.metrics
                )
                writeAtomically(status.toRedactedJson())
            }
            if (!closed.get()) {
                worker?.postDelayed(this, sampleIntervalMs)
            }
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
            workerThread != null
        ) {
            return
        }
        val thread = HandlerThread("V5BT-BluetoothLabReport").apply { start() }
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
        const val STATUS_FILE_NAME = "bluetooth-discovery-status-v1.json"
        private const val SAMPLE_INTERVAL_MS = 2_000L
        private const val MIN_SAMPLE_INTERVAL_MS = 250L
        private const val MAX_SAMPLE_INTERVAL_MS = 5_000L
    }
}
