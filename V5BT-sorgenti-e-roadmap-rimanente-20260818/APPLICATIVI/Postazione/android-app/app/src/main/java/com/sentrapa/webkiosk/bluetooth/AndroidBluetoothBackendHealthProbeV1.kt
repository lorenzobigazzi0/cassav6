package com.sentrapa.webkiosk.bluetooth

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.SystemClock
import com.sentrapa.webkiosk.LocalHttpsTrust
import java.net.URI
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Call
import okhttp3.CacheControl
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.Buffer
import okio.BufferedSource
import org.json.JSONObject

const val BLUETOOTH_BACKEND_HEALTH_PROBE_INTERVAL_MS_V1 = 1_750L
const val BLUETOOTH_BACKEND_HEALTH_PROBE_TIMEOUT_MS_V1 = 750L
const val BLUETOOTH_BACKEND_HEALTH_MAX_BODY_BYTES_V1 = 16_384

data class BluetoothBackendHealthProbeTargetV1(
    val healthUrl: String,
    val sessionBindingCommitment: String
) {
    init {
        val uri = runCatching { URI(healthUrl) }.getOrNull()
        require(
            uri?.scheme == "https" &&
                !uri.host.isNullOrBlank() &&
                uri.path == "/api/health" &&
                uri.userInfo == null &&
                uri.query == null &&
                uri.fragment == null
        )
        require(Regex("^[0-9a-f]{64}$").matches(sessionBindingCommitment))
    }
}

internal object BluetoothBackendHealthResponsePolicyV1 {
    fun accepts(
        successful: Boolean,
        redirect: Boolean,
        contentType: String?,
        body: String
    ): Boolean {
        if (!successful || redirect) return false
        if (!contentType?.substringBefore(';')?.trim().equals("application/json", true)) {
            return false
        }
        if (body.toByteArray(Charsets.UTF_8).size > BLUETOOTH_BACKEND_HEALTH_MAX_BODY_BYTES_V1) {
            return false
        }
        return runCatching { JSONObject(body).opt("ok") }
            .getOrNull() == true
    }
}

internal class BluetoothBatterySampleGateV1(
    private val intervalMs: Long = BLUETOOTH_BATTERY_SAMPLE_INTERVAL_MS_V1
) {
    private var lastClaimedAtElapsedRealtimeMs: Long? = null

    init {
        require(intervalMs > 0L)
    }

    @Synchronized
    fun claim(nowElapsedRealtimeMs: Long): Boolean {
        require(nowElapsedRealtimeMs >= 0L)
        val previous = lastClaimedAtElapsedRealtimeMs
        if (previous != null && nowElapsedRealtimeMs < previous) {
            throw BluetoothDynamicRouteHealthExceptionV1(
                "CLOCK_REGRESSION",
                "battery sample clock moved backwards"
            )
        }
        if (previous != null && nowElapsedRealtimeMs - previous < intervalMs) return false
        lastClaimedAtElapsedRealtimeMs = nowElapsedRealtimeMs
        return true
    }
}

internal class BluetoothBackendHealthProbeClockV1 {
    private var epochHighWatermarkMs = 0L
    private var elapsedHighWatermarkMs = 0L
    private var failed = false

    @Synchronized
    fun claim(epochMs: Long, elapsedMs: Long) {
        if (
            failed ||
            epochMs < 0L ||
            elapsedMs < 0L ||
            epochMs < epochHighWatermarkMs ||
            elapsedMs < elapsedHighWatermarkMs
        ) {
            failed = true
            throw BluetoothDynamicRouteHealthExceptionV1(
                "CLOCK_REGRESSION",
                "backend health probe clock moved backwards"
            )
        }
        epochHighWatermarkMs = epochMs
        elapsedHighWatermarkMs = elapsedMs
    }
}

object BluetoothBackendHealthProbeTargetResolverV1 {
    fun resolve(savedUrl: String?, sessionBindingCommitment: String?):
        BluetoothBackendHealthProbeTargetV1? {
        val binding = sessionBindingCommitment?.trim()
            ?.takeIf { Regex("^[0-9a-f]{64}$").matches(it) }
            ?: return null
        val uri = savedUrl?.trim()?.takeIf { it.isNotEmpty() }
            ?.let { runCatching { URI(it) }.getOrNull() }
            ?: return null
        if (
            !uri.scheme.equals("https", ignoreCase = true) ||
            uri.host.isNullOrBlank() ||
            uri.userInfo != null ||
            uri.query != null ||
            uri.fragment != null
        ) return null
        val healthUri = URI(
            "https",
            null,
            uri.host,
            uri.port,
            "/api/health",
            null,
            null
        )
        return BluetoothBackendHealthProbeTargetV1(healthUri.toASCIIString(), binding)
    }
}

internal fun readBluetoothBackendHealthBodyBoundedV1(
    source: BufferedSource,
    maximumBytes: Int = BLUETOOTH_BACKEND_HEALTH_MAX_BODY_BYTES_V1
): ByteArray? {
    require(maximumBytes >= 0)
    val buffer = Buffer()
    val readLimit = maximumBytes.toLong() + 1L
    while (buffer.size < readLimit) {
        val read = source.read(buffer, readLimit - buffer.size)
        if (read == -1L) break
        check(read > 0L) { "health response source made no progress" }
    }
    if (buffer.size > maximumBytes.toLong()) {
        buffer.clear()
        return null
    }
    return buffer.readByteArray()
}

fun interface BluetoothBatteryPercentSourceV1 {
    fun currentBatteryPercent(): Double?
}

class AndroidBluetoothBatteryPercentSourceV1(
    private val context: Context
) : BluetoothBatteryPercentSourceV1 {
    override fun currentBatteryPercent(): Double? {
        val intent = context.applicationContext.registerReceiver(
            null,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        ) ?: return null
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level < 0 || scale <= 0) return null
        return ((level * 100.0) / scale).coerceIn(0.0, 100.0)
    }
}

class AndroidBluetoothBackendHealthProbeV1 internal constructor(
    private val signals: BluetoothRouteHealthSignalStoreV1,
    private val batteryPercentSource: BluetoothBatteryPercentSourceV1,
    private val nowEpochMs: () -> Long,
    private val elapsedRealtimeMs: () -> Long,
    private val onFatal: (Throwable) -> Unit
) : AutoCloseable {
    constructor(
        context: Context,
        signals: BluetoothRouteHealthSignalStoreV1,
        onFatal: (Throwable) -> Unit = {}
    ) : this(
        signals,
        AndroidBluetoothBatteryPercentSourceV1(context),
        System::currentTimeMillis,
        SystemClock::elapsedRealtime,
        onFatal
    )

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val standardClient = clientBuilder().build()
    private val localClient = LocalHttpsTrust.configure(clientBuilder()).build()
    private val batterySampleGate = BluetoothBatterySampleGateV1()
    private val clock = BluetoothBackendHealthProbeClockV1()

    private fun clientBuilder(): OkHttpClient.Builder =
        OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(BLUETOOTH_BACKEND_HEALTH_PROBE_TIMEOUT_MS_V1, TimeUnit.MILLISECONDS)
            .readTimeout(BLUETOOTH_BACKEND_HEALTH_PROBE_TIMEOUT_MS_V1, TimeUnit.MILLISECONDS)
            .writeTimeout(BLUETOOTH_BACKEND_HEALTH_PROBE_TIMEOUT_MS_V1, TimeUnit.MILLISECONDS)
            .callTimeout(BLUETOOTH_BACKEND_HEALTH_PROBE_TIMEOUT_MS_V1, TimeUnit.MILLISECONDS)
    private var target: BluetoothBackendHealthProbeTargetV1? = null
    private var linkSession: BluetoothBackendLinkSessionV1? = null
    private var generation = 0L
    private var activeCall: Call? = null
    private var job: Job? = null
    private var closed = false
    private var clockFailed = false
    private var fatalReported = false

    @Synchronized
    fun start() {
        check(!closed)
        if (job?.isActive == true) return
        job = scope.launch {
            while (isActive) {
                try {
                    val cycleStartedAt = captureTime().elapsedRealtimeMs
                    sampleBattery()
                    captureProbe()?.let(::probeOnce)
                    val cycleCompletedAt = captureTime().elapsedRealtimeMs
                    val elapsed = cycleCompletedAt - cycleStartedAt
                    if (elapsed < 0L) clockRegression()
                    delay(
                        (BLUETOOTH_BACKEND_HEALTH_PROBE_INTERVAL_MS_V1 - elapsed)
                            .coerceAtLeast(1L)
                    )
                } catch (_: CancellationException) {
                    break
                } catch (error: Throwable) {
                    failProbe(error)
                    break
                }
            }
        }
    }

    @Synchronized
    fun updateTarget(value: BluetoothBackendHealthProbeTargetV1?) {
        check(!closed)
        check(!clockFailed)
        if (value == target) return
        activeCall?.cancel()
        activeCall = null
        try {
            closeLinkSessionLocked()
        } catch (error: Throwable) {
            failProbe(error)
            throw error
        }
        generation = nextGeneration(generation)
        target = value
        linkSession = value?.let {
            signals.open(nowEpochMs(), elapsedRealtimeMs())
        }
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        activeCall?.cancel()
        activeCall = null
        runCatching { closeLinkSessionLocked() }
            .onFailure { error ->
                signals.failClosed(linkSession)
                if (!fatalReported) {
                    fatalReported = true
                    runCatching { onFatal(error) }
                }
            }
        target = null
        job?.cancel()
        job = null
        scope.cancel()
    }

    private fun sampleBattery() {
        val observedAt = captureTime()
        val observedAtEpochMs = observedAt.epochMs
        val observedAtElapsedRealtimeMs = observedAt.elapsedRealtimeMs
        if (!batterySampleGate.claim(observedAtElapsedRealtimeMs)) return
        val percent = runCatching(batteryPercentSource::currentBatteryPercent).getOrNull()
            ?: return
        if (!signals.observe(percent, observedAtEpochMs, observedAtElapsedRealtimeMs)) {
            throw BluetoothDynamicRouteHealthExceptionV1(
                "BATTERY_SIGNAL_REJECTED",
                "current battery observation was rejected"
            )
        }
    }

    private fun probeOnce(snapshot: ProbeSnapshot) {
        val request = Request.Builder()
            .url(snapshot.target.healthUrl)
            .get()
            .header("Accept", "application/json")
            .cacheControl(CacheControl.FORCE_NETWORK)
            .header("Cache-Control", "no-cache, no-store")
            .build()
        val client = if (LocalHttpsTrust.shouldUseFor(snapshot.target.healthUrl)) {
            localClient
        } else {
            standardClient
        }
        val call = client.newCall(request)
        if (!registerCall(snapshot, call)) {
            call.cancel()
            return
        }
        val startedAt = captureTime()
        val startedAtElapsedRealtimeMs = startedAt.elapsedRealtimeMs
        val success = try {
            call.execute().use { response ->
                val responseBody = response.body ?: return@use false
                val declaredLength = responseBody.contentLength()
                if (declaredLength > BLUETOOTH_BACKEND_HEALTH_MAX_BODY_BYTES_V1) {
                    return@use false
                }
                val bodyBytes = readBluetoothBackendHealthBodyBoundedV1(
                    responseBody.source()
                ) ?: return@use false
                try {
                    BluetoothBackendHealthResponsePolicyV1.accepts(
                        response.isSuccessful,
                        response.isRedirect,
                        responseBody.contentType()?.toString(),
                        bodyBytes.toString(Charsets.UTF_8)
                    )
                } finally {
                    bodyBytes.fill(0)
                }
            }
        } catch (_: Exception) {
            false
        }
        val completedAt = captureTime()
        val completedAtEpochMs = completedAt.epochMs
        val completedAtElapsedRealtimeMs = completedAt.elapsedRealtimeMs
        publishProbeResult(
            snapshot,
            call,
            success,
            completedAtEpochMs,
            startedAtElapsedRealtimeMs,
            completedAtElapsedRealtimeMs
        )
    }

    @Synchronized
    private fun captureProbe(): ProbeSnapshot? {
        if (closed) return null
        return ProbeSnapshot(
            generation,
            target ?: return null,
            linkSession ?: return null
        )
    }

    @Synchronized
    private fun registerCall(snapshot: ProbeSnapshot, call: Call): Boolean {
        if (!isCurrent(snapshot) || activeCall != null) return false
        activeCall = call
        return true
    }

    @Synchronized
    private fun publishProbeResult(
        snapshot: ProbeSnapshot,
        call: Call,
        success: Boolean,
        completedAtEpochMs: Long,
        startedAtElapsedRealtimeMs: Long,
        completedAtElapsedRealtimeMs: Long
    ) {
        if (activeCall !== call) return
        activeCall = null
        if (!isCurrent(snapshot)) return
        val accepted = if (success) {
            signals.reachable(
                snapshot.linkSession,
                (completedAtElapsedRealtimeMs - startedAtElapsedRealtimeMs).toDouble(),
                completedAtEpochMs,
                completedAtElapsedRealtimeMs
            )
        } else {
            signals.unreachable(
                snapshot.linkSession,
                completedAtEpochMs,
                completedAtElapsedRealtimeMs
            )
        }
        if (!accepted) {
            val error = BluetoothDynamicRouteHealthExceptionV1(
                "HEALTH_SIGNAL_REJECTED",
                "current backend health observation was rejected"
            )
            failProbe(error)
            throw error
        }
    }

    private fun isCurrent(snapshot: ProbeSnapshot): Boolean =
        !closed &&
            snapshot.generation == generation &&
            snapshot.target == target &&
            snapshot.linkSession == linkSession

    private fun closeLinkSessionLocked() {
        val session = linkSession ?: return
        linkSession = null
        val observedAt = captureTime()
        val observedAtEpochMs = observedAt.epochMs
        val observedAtElapsedRealtimeMs = observedAt.elapsedRealtimeMs
        if (!signals.close(session, observedAtEpochMs, observedAtElapsedRealtimeMs)) {
            signals.failClosed(session)
            throw BluetoothDynamicRouteHealthExceptionV1(
                "HEALTH_SIGNAL_REJECTED",
                "current backend health session close was rejected"
            )
        }
    }

    @Synchronized
    private fun checkProbeClocks(epochMs: Long, elapsedMs: Long) {
        if (clockFailed) clockRegression()
        try {
            clock.claim(epochMs, elapsedMs)
        } catch (error: Throwable) {
            clockFailed = true
            throw error
        }
    }

    private fun captureTime(): ProbeTime {
        val epochMs = nowEpochMs()
        val elapsedMs = elapsedRealtimeMs()
        checkProbeClocks(epochMs, elapsedMs)
        return ProbeTime(epochMs, elapsedMs)
    }

    @Synchronized
    private fun failProbe(error: Throwable) {
        clockFailed = true
        activeCall?.cancel()
        activeCall = null
        signals.failClosed(linkSession)
        linkSession = null
        target = null
        if (!fatalReported) {
            fatalReported = true
            runCatching { onFatal(error) }
        }
    }

    private fun clockRegression(): Nothing =
        throw BluetoothDynamicRouteHealthExceptionV1(
            "CLOCK_REGRESSION",
            "backend health probe clock moved backwards"
        )

    private fun nextGeneration(current: Long): Long {
        if (current == Long.MAX_VALUE) {
            throw BluetoothDynamicRouteHealthExceptionV1(
                "PROBE_GENERATION_EXHAUSTED",
                "backend health probe generation is exhausted"
            )
        }
        return current + 1L
    }

    private data class ProbeSnapshot(
        val generation: Long,
        val target: BluetoothBackendHealthProbeTargetV1,
        val linkSession: BluetoothBackendLinkSessionV1
    )

    private data class ProbeTime(
        val epochMs: Long,
        val elapsedRealtimeMs: Long
    )
}
