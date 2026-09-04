package com.sentrapa.cassav6.webkiosk.bluetooth

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.AtomicFile
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicBoolean

internal data class BluetoothGattServerLabStatusV1(
    val sampleSequence: Long,
    val sampledAtEpochMs: Long,
    val reporterStartedAtEpochMs: Long,
    val snapshot: AndroidGattServerSnapshot
) {
    fun toRedactedJson(): String = buildString {
        append('{')
        append("\"schemaVersion\":1,")
        append("\"source\":\"CASSA_V6_ANDROID_GATT_SERVER_LAB\",")
        append("\"labBuild\":true,")
        append("\"diagnosticsEnabled\":true,")
        append("\"gattServerEnabled\":").append(snapshot.enabled).append(',')
        append("\"sampleSequence\":").append(sampleSequence).append(',')
        append("\"sampledAtEpochMs\":").append(sampledAtEpochMs).append(',')
        append("\"reporterStartedAtEpochMs\":")
            .append(reporterStartedAtEpochMs)
            .append(',')
        append("\"state\":\"").append(snapshot.state.name).append("\",")
        append("\"active\":").append(snapshot.active).append(',')
        append("\"reliablePortReady\":").append(snapshot.reliablePortReady).append(',')
        append("\"servicePublished\":").append(snapshot.servicePublished).append(',')
        append("\"helloEnabled\":").append(snapshot.helloEnabled).append(',')
        append("\"sessionCount\":").append(snapshot.sessionCount).append(',')
        append("\"transportMetrics\":{")
        append("\"openAttempts\":").append(snapshot.metrics.openAttempts).append(',')
        append("\"serversOpened\":").append(snapshot.metrics.serversOpened).append(',')
        append("\"serviceAddRequests\":")
            .append(snapshot.metrics.serviceAddRequests)
            .append(',')
        append("\"servicesPublished\":")
            .append(snapshot.metrics.servicesPublished)
            .append(',')
        append("\"connectionsAccepted\":")
            .append(snapshot.metrics.connectionsAccepted)
            .append(',')
        append("\"connectionsRejected\":")
            .append(snapshot.metrics.connectionsRejected)
            .append(',')
        append("\"disconnects\":").append(snapshot.metrics.disconnects).append(',')
        append("\"mtuChanges\":").append(snapshot.metrics.mtuChanges).append(',')
        append("\"reads\":").append(snapshot.metrics.reads).append(',')
        append("\"writes\":").append(snapshot.metrics.writes).append(',')
        append("\"descriptorReads\":")
            .append(snapshot.metrics.descriptorReads)
            .append(',')
        append("\"descriptorWrites\":")
            .append(snapshot.metrics.descriptorWrites)
            .append(',')
        append("\"notificationsStarted\":")
            .append(snapshot.metrics.notificationsStarted)
            .append(',')
        append("\"notificationsCompleted\":")
            .append(snapshot.metrics.notificationsCompleted)
            .append(',')
        append("\"deniedRequests\":")
            .append(snapshot.metrics.deniedRequests)
            .append(',')
        append("\"failures\":").append(snapshot.metrics.failures).append(',')
        append("\"resets\":").append(snapshot.metrics.resets).append(',')
        append("\"closes\":").append(snapshot.metrics.closes)
        append("},")
        append("\"handlerMetrics\":{")
        append("\"secureActiveSessionCount\":")
            .append(snapshot.handler.secureActiveSessionCount)
            .append(',')
        append("\"securePromotionBlockedSessionCount\":")
            .append(snapshot.handler.securePromotionBlockedSessionCount)
            .append(',')
        append("\"sessionsAccepted\":")
            .append(snapshot.handler.sessionsAccepted)
            .append(',')
        append("\"sessionsRejected\":")
            .append(snapshot.handler.sessionsRejected)
            .append(',')
        append("\"sessionsExpired\":")
            .append(snapshot.handler.sessionsExpired)
            .append(',')
        append("\"helloWritesAccepted\":")
            .append(snapshot.handler.helloWritesAccepted)
            .append(',')
        append("\"helloReadsCompleted\":")
            .append(snapshot.handler.helloReadsCompleted)
            .append(',')
        append("\"deniedRequests\":")
            .append(snapshot.handler.deniedRequests)
            .append(',')
        append("\"protocolFailures\":")
            .append(snapshot.handler.protocolFailures)
        append("}}")
    }
}

internal class BluetoothGattServerLabReporter(
    context: Context,
    private val labBuild: Boolean,
    private val diagnosticsEnabled: Boolean,
    private val gattServerEnabled: Boolean,
    private val statusProvider: () -> AndroidGattServerSnapshot,
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
                writeAtomically(
                    BluetoothGattServerLabStatusV1(
                        sampleSequence = sampleSequence,
                        sampledAtEpochMs = System.currentTimeMillis(),
                        reporterStartedAtEpochMs = reporterStartedAtEpochMs,
                        snapshot = statusProvider()
                    ).toRedactedJson()
                )
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
            !gattServerEnabled ||
            workerThread != null
        ) {
            return
        }
        val thread = HandlerThread("CASSA_V6-GattServerLabReport").apply { start() }
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
        const val STATUS_FILE_NAME = "bluetooth-gatt-server-status-v1.json"
        private const val SAMPLE_INTERVAL_MS = 500L
        private const val MIN_SAMPLE_INTERVAL_MS = 250L
        private const val MAX_SAMPLE_INTERVAL_MS = 5_000L
    }
}
