package com.sentrapa.cassav6.webkiosk.bluetooth

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.AtomicFile
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicBoolean

internal data class BluetoothGattClientLabStatusV1(
    val sampleSequence: Long,
    val sampledAtEpochMs: Long,
    val reporterStartedAtEpochMs: Long,
    val snapshot: AndroidGattClientSnapshot
) {
    fun toRedactedJson(): String = buildString {
        append('{')
        if (snapshot.heartbeatEnabled) {
            append("\"schemaVersion\":4,")
            append("\"source\":\"CASSA_V6_ANDROID_DIRECT_CONTROL_LAB\",")
        } else if (snapshot.mutualAuthEnabled) {
            append("\"schemaVersion\":3,")
            append("\"source\":\"CASSA_V6_ANDROID_GATT_MUTUAL_AUTH_LAB\",")
        } else {
            append("\"schemaVersion\":2,")
            append("\"source\":\"CASSA_V6_ANDROID_GATT_HELLO_LAB\",")
        }
        append("\"labBuild\":true,")
        append("\"diagnosticsEnabled\":true,")
        append("\"gattClientEnabled\":true,")
        append("\"sampleSequence\":").append(sampleSequence).append(',')
        append("\"sampledAtEpochMs\":").append(sampledAtEpochMs).append(',')
        append("\"reporterStartedAtEpochMs\":")
            .append(reporterStartedAtEpochMs)
            .append(',')
        append("\"state\":\"").append(snapshot.state.name).append("\",")
        append("\"profileValidated\":").append(snapshot.profileValidated).append(',')
        append("\"negotiatedMtu\":")
        if (snapshot.negotiatedMtu == null) {
            append("null")
        } else {
            append(snapshot.negotiatedMtu)
        }
        append(',')
        append("\"lastFailure\":\"")
            .append(snapshot.lastFailure.name)
            .append("\",")
        append("\"helloEnabled\":").append(snapshot.helloEnabled).append(',')
        append("\"helloExchanged\":").append(snapshot.helloExchanged).append(',')
        append("\"helloDeadlineActive\":")
            .append(snapshot.helloDeadlineActive)
            .append(',')
        if (snapshot.mutualAuthEnabled) {
            append("\"mutualAuthEnabled\":true,")
            append("\"mutuallyAuthenticated\":")
                .append(snapshot.mutuallyAuthenticated)
                .append(',')
            append("\"authDeadlineActive\":")
                .append(snapshot.authDeadlineActive)
                .append(',')
        }
        append("\"authenticatedSessionCount\":")
            .append(snapshot.authenticatedSessionCount)
            .append(',')
        if (snapshot.sessionKeyEnabled) {
            append("\"sessionKeyEnabled\":true,")
            append("\"keyEstablished\":")
                .append(snapshot.keyEstablished)
                .append(',')
        }
        if (snapshot.heartbeatEnabled) {
            append("\"heartbeatEnabled\":true,")
            append("\"active\":").append(snapshot.active).append(',')
            append("\"directControlDeadlineActive\":")
                .append(snapshot.directControlDeadlineActive)
                .append(',')
        }
        append("\"reliablePortReady\":")
            .append(snapshot.reliablePortReady)
            .append(',')
        append("\"metrics\":{")
        append("\"connectionAttempts\":")
            .append(snapshot.metrics.connectionAttempts)
            .append(',')
        append("\"connectionsEstablished\":")
            .append(snapshot.metrics.connectionsEstablished)
            .append(',')
        append("\"servicesValidated\":")
            .append(snapshot.metrics.servicesValidated)
            .append(',')
        append("\"mtuNegotiated\":").append(snapshot.metrics.mtuNegotiated).append(',')
        append("\"helloWritesStarted\":")
            .append(snapshot.metrics.helloWritesStarted)
            .append(',')
        append("\"helloWritesCompleted\":")
            .append(snapshot.metrics.helloWritesCompleted)
            .append(',')
        append("\"helloReadsCompleted\":")
            .append(snapshot.metrics.helloReadsCompleted)
            .append(',')
        append("\"helloExchanged\":")
            .append(snapshot.metrics.helloExchanged)
            .append(',')
        if (snapshot.mutualAuthEnabled) {
            append("\"authSubscriptionsStarted\":")
                .append(snapshot.metrics.authSubscriptionsStarted)
                .append(',')
            append("\"authSubscriptionsCompleted\":")
                .append(snapshot.metrics.authSubscriptionsCompleted)
                .append(',')
            append("\"clientProofWritesCompleted\":")
                .append(snapshot.metrics.clientProofWritesCompleted)
                .append(',')
            append("\"serverProofsVerified\":")
                .append(snapshot.metrics.serverProofsVerified)
                .append(',')
            append("\"authFinishWritesCompleted\":")
                .append(snapshot.metrics.authFinishWritesCompleted)
                .append(',')
            append("\"authenticatedSessions\":")
                .append(snapshot.metrics.authenticatedSessions)
                .append(',')
        }
        if (snapshot.sessionKeyEnabled) {
            append("\"keyExchangesStarted\":")
                .append(snapshot.metrics.keyExchangesStarted)
                .append(',')
            append("\"clientKeySharesWritten\":")
                .append(snapshot.metrics.clientKeySharesWritten)
                .append(',')
            append("\"serverKeySharesVerified\":")
                .append(snapshot.metrics.serverKeySharesVerified)
                .append(',')
            append("\"clientKeyConfirmsWritten\":")
                .append(snapshot.metrics.clientKeyConfirmsWritten)
                .append(',')
            append("\"keysEstablished\":")
                .append(snapshot.metrics.keysEstablished)
                .append(',')
        }
        if (snapshot.heartbeatEnabled) {
            append("\"activationPingsReceived\":")
                .append(snapshot.metrics.activationPingsReceived)
                .append(',')
            append("\"activationPongsWritten\":")
                .append(snapshot.metrics.activationPongsWritten)
                .append(',')
            append("\"activeSessions\":")
                .append(snapshot.metrics.activeSessions)
                .append(',')
            append("\"heartbeatPingsReceived\":")
                .append(snapshot.metrics.heartbeatPingsReceived)
                .append(',')
            append("\"heartbeatPongsWritten\":")
                .append(snapshot.metrics.heartbeatPongsWritten)
                .append(',')
            append("\"closeFramesReceived\":")
                .append(snapshot.metrics.closeFramesReceived)
                .append(',')
            append("\"cleanCloses\":")
                .append(snapshot.metrics.cleanCloses)
                .append(',')
        }
        append("\"disconnects\":").append(snapshot.metrics.disconnects).append(',')
        append("\"failures\":").append(snapshot.metrics.failures).append(',')
        append("\"closes\":").append(snapshot.metrics.closes)
        append("}}")
    }
}

internal class BluetoothGattClientLabReporter(
    context: Context,
    private val labBuild: Boolean,
    private val diagnosticsEnabled: Boolean,
    private val gattClientEnabled: Boolean,
    private val statusProvider: () -> AndroidGattClientSnapshot,
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
                    BluetoothGattClientLabStatusV1(
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
            !gattClientEnabled ||
            workerThread != null
        ) {
            return
        }
        val thread = HandlerThread("CASSA_V6-GattClientLabReport").apply { start() }
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
        const val STATUS_FILE_NAME = "bluetooth-gatt-client-status-v1.json"
        private const val SAMPLE_INTERVAL_MS = 500L
        private const val MIN_SAMPLE_INTERVAL_MS = 250L
        private const val MAX_SAMPLE_INTERVAL_MS = 5_000L
    }
}
