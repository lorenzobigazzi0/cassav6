package com.sentrapa.cassav6.webkiosk.bluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import java.util.concurrent.atomic.AtomicLong

const val BLUETOOTH_ADVERTISER_START_CALLBACK_TIMEOUT_MS_V1 = 750L

internal fun interface BluetoothAdvertiserDeadlineScheduleV1 {
    fun schedule(delayMs: Long, operation: () -> Unit): AutoCloseable
}

internal class AndroidHandlerBluetoothAdvertiserDeadlineScheduleV1(
    private val handler: Handler = Handler(Looper.getMainLooper())
) : BluetoothAdvertiserDeadlineScheduleV1 {
    override fun schedule(delayMs: Long, operation: () -> Unit): AutoCloseable {
        val callback = Runnable(operation)
        if (!handler.postDelayed(callback, delayMs)) {
            throw IllegalStateException("advertiser callback deadline was rejected")
        }
        return AutoCloseable { handler.removeCallbacks(callback) }
    }
}

internal enum class BluetoothAdvertiserStartPhaseV1 {
    NEW,
    WAITING_CALLBACK,
    ACTIVE,
    CLOSED
}

internal data class BluetoothAdvertiserStartTokenV1(val generation: Long)

internal data class BluetoothAdvertiserStartDeadlineSnapshotV1(
    val phase: BluetoothAdvertiserStartPhaseV1,
    val deadlineActive: Boolean
)

internal class BluetoothAdvertiserStartDeadlineExceptionV1(
    val code: String,
    message: String
) : RuntimeException(message)

private object BluetoothAdvertiserStartGenerationV1 {
    private val next = AtomicLong(1L)

    fun allocate(): Long {
        while (true) {
            val current = next.get()
            if (current <= 0L || current == Long.MAX_VALUE) {
                throw IllegalStateException("advertiser start generation exhausted")
            }
            if (next.compareAndSet(current, current + 1L)) return current
        }
    }
}

internal class BluetoothAdvertiserStartDeadlineV1(
    private val timeoutMs: Long = BLUETOOTH_ADVERTISER_START_CALLBACK_TIMEOUT_MS_V1,
    private val deadlineSchedule: BluetoothAdvertiserDeadlineScheduleV1 =
        AndroidHandlerBluetoothAdvertiserDeadlineScheduleV1(),
    private val nowElapsedMs: () -> Long = SystemClock::elapsedRealtime,
    private val onFatal: (BluetoothAdvertiserStartDeadlineExceptionV1) -> Unit = {}
) : AutoCloseable {
    private val generation = BluetoothAdvertiserStartGenerationV1.allocate()
    private var phase = BluetoothAdvertiserStartPhaseV1.NEW
    private var deadlineElapsedMs: Long? = null
    private var deadlineHandle: AutoCloseable? = null
    private var lastClockMs = -1L

    init {
        require(timeoutMs in 250L..10_000L) {
            "advertiser callback timeout is out of range"
        }
    }

    @Synchronized
    fun start(): BluetoothAdvertiserStartTokenV1 {
        if (phase != BluetoothAdvertiserStartPhaseV1.NEW) {
            terminate(
                "ADVERTISER_START_ALREADY_STARTED",
                "advertiser callback deadline has already started"
            )
        }
        val current = checkedNow()
        if (current > Long.MAX_VALUE - timeoutMs) {
            terminate("CLOCK_OVERFLOW", "advertiser callback deadline overflowed")
        }
        deadlineElapsedMs = current + timeoutMs
        phase = BluetoothAdvertiserStartPhaseV1.WAITING_CALLBACK
        armDeadline(timeoutMs)
        return BluetoothAdvertiserStartTokenV1(generation)
    }

    @Synchronized
    fun started(token: BluetoothAdvertiserStartTokenV1): Boolean {
        if (
            token.generation != generation ||
            phase != BluetoothAdvertiserStartPhaseV1.WAITING_CALLBACK
        ) return false
        assertBeforeDeadline()
        phase = BluetoothAdvertiserStartPhaseV1.ACTIVE
        deadlineElapsedMs = null
        cancelDeadline()
        return true
    }

    @Synchronized
    fun failed(token: BluetoothAdvertiserStartTokenV1): Boolean {
        if (
            token.generation != generation ||
            phase !in setOf(
                BluetoothAdvertiserStartPhaseV1.WAITING_CALLBACK,
                BluetoothAdvertiserStartPhaseV1.ACTIVE
            )
        ) return false
        phase = BluetoothAdvertiserStartPhaseV1.CLOSED
        deadlineElapsedMs = null
        cancelDeadline()
        return true
    }

    @Synchronized
    fun snapshot(): BluetoothAdvertiserStartDeadlineSnapshotV1 =
        BluetoothAdvertiserStartDeadlineSnapshotV1(
            phase = phase,
            deadlineActive = deadlineHandle != null
        )

    @Synchronized
    override fun close() {
        if (phase == BluetoothAdvertiserStartPhaseV1.CLOSED) return
        phase = BluetoothAdvertiserStartPhaseV1.CLOSED
        deadlineElapsedMs = null
        cancelDeadline()
    }

    private fun assertBeforeDeadline() {
        val current = checkedNow()
        val deadline = deadlineElapsedMs
            ?: terminate(
                "ADVERTISER_START_DEADLINE_MISSING",
                "advertiser callback deadline is missing"
            )
        if (current >= deadline) {
            terminate(
                "ADVERTISER_START_CALLBACK_TIMEOUT",
                "advertiser start callback timed out"
            )
        }
    }

    private fun checkedNow(): Long {
        val current = nowElapsedMs()
        if (current < 0L || current < lastClockMs) {
            terminate(
                "CLOCK_REGRESSION",
                "advertiser callback monotonic clock moved backwards"
            )
        }
        lastClockMs = current
        return current
    }

    private fun armDeadline(delayMs: Long) {
        cancelDeadline()
        deadlineHandle = try {
            deadlineSchedule.schedule(delayMs) { handleDeadline(generation) }
        } catch (_: Exception) {
            terminate(
                "DEADLINE_SCHEDULE_FAILED",
                "advertiser callback deadline could not be scheduled"
            )
        }
    }

    private fun handleDeadline(expectedGeneration: Long) {
        var failure: BluetoothAdvertiserStartDeadlineExceptionV1? = null
        synchronized(this) {
            if (
                expectedGeneration != generation ||
                phase != BluetoothAdvertiserStartPhaseV1.WAITING_CALLBACK
            ) return
            val current = nowElapsedMs()
            if (current < 0L || current < lastClockMs) {
                failure = terminateWithoutThrow(
                    "CLOCK_REGRESSION",
                    "advertiser callback monotonic clock moved backwards"
                )
            } else {
                lastClockMs = current
                val deadline = deadlineElapsedMs
                if (deadline == null) {
                    failure = terminateWithoutThrow(
                        "ADVERTISER_START_DEADLINE_MISSING",
                        "advertiser callback deadline is missing"
                    )
                } else if (current >= deadline) {
                    failure = terminateWithoutThrow(
                        "ADVERTISER_START_CALLBACK_TIMEOUT",
                        "advertiser start callback timed out"
                    )
                } else {
                    try {
                        armDeadline(deadline - current)
                    } catch (error: BluetoothAdvertiserStartDeadlineExceptionV1) {
                        failure = error
                    }
                }
            }
        }
        failure?.let { runCatching { onFatal(it) } }
    }

    private fun cancelDeadline() {
        runCatching { deadlineHandle?.close() }
        deadlineHandle = null
    }

    private fun terminate(code: String, message: String): Nothing {
        throw terminateWithoutThrow(code, message)
    }

    private fun terminateWithoutThrow(
        code: String,
        message: String
    ): BluetoothAdvertiserStartDeadlineExceptionV1 {
        phase = BluetoothAdvertiserStartPhaseV1.CLOSED
        deadlineElapsedMs = null
        cancelDeadline()
        return BluetoothAdvertiserStartDeadlineExceptionV1(code, message)
    }
}

internal data class BluetoothAdvertiserStartKey(
    val payload: List<Byte>,
    val connectable: Boolean,
    val advertiseMode: BluetoothAdvertiseMode
)

class BleAdvertiser(context: Context) {
    private val appContext = context.applicationContext
    private val serviceUuid = ParcelUuid.fromString(BluetoothAdvertisementCodecV1.SERVICE_UUID)
    private val callbackOwnership = BluetoothCallbackOwnership<AdvertiseCallback>()
    private var startDeadline: BluetoothAdvertiserStartDeadlineV1? = null
    private var pendingStartKey: BluetoothAdvertiserStartKey? = null
    private var activeStartKey: BluetoothAdvertiserStartKey? = null

    @get:Synchronized
    val isRunning: Boolean
        get() = callbackOwnership.current() != null && activeStartKey != null

    @SuppressLint("MissingPermission")
    @Synchronized
    fun startOrReplace(
        advertisement: BluetoothAdvertisementV1,
        connectable: Boolean = false,
        advertiseMode: BluetoothAdvertiseMode,
        onStarted: () -> Unit,
        onFailure: (Int) -> Unit
    ): Boolean {
        val encoded = BluetoothAdvertisementCodecV1.encode(advertisement)
        val startKey = BluetoothAdvertiserStartKey(
            payload = encoded.asList(),
            connectable = connectable,
            advertiseMode = advertiseMode
        )
        if (
            callbackOwnership.current() != null &&
            (activeStartKey == startKey || pendingStartKey == startKey)
        ) {
            return true
        }
        stop()
        val advertiser =
            runCatching {
                val manager =
                    appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
                manager?.adapter?.bluetoothLeAdvertiser
            }.getOrNull() ?: return false
        lateinit var advertiseCallback: AdvertiseCallback
        lateinit var deadline: BluetoothAdvertiserStartDeadlineV1
        lateinit var token: BluetoothAdvertiserStartTokenV1
        deadline = BluetoothAdvertiserStartDeadlineV1(
            onFatal = {
                handleStartDeadline(advertiseCallback, deadline, onFailure)
            }
        )
        advertiseCallback = object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
                var rejectedCurrentStart = false
                val activated = synchronized(this@BleAdvertiser) {
                    if (
                        !callbackOwnership.isOwner(this) ||
                        startDeadline !== deadline
                    ) {
                        false
                    } else {
                        runCatching { deadline.started(token) }.getOrDefault(false).also {
                            if (it) {
                                pendingStartKey = null
                                activeStartKey = startKey
                            } else {
                                rejectedCurrentStart = releaseOwnedStart(this, deadline)
                            }
                        }
                    }
                }
                if (!activated) {
                    stopAdvertisingCallback(this)
                    if (rejectedCurrentStart) {
                        runCatching {
                            onFailure(AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR)
                        }
                    }
                    return
                }
                val notified = runCatching { onStarted() }.isSuccess
                if (!notified && releaseOwnedStart(this, deadline)) {
                    stopAdvertisingCallback(this)
                    runCatching { onFailure(AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR) }
                }
            }

            override fun onStartFailure(errorCode: Int) {
                val owned =
                    synchronized(this@BleAdvertiser) {
                        if (
                            callbackOwnership.isOwner(this) &&
                            startDeadline === deadline &&
                            deadline.failed(token)
                        ) releaseOwnedStart(this, deadline) else false
                    }
                stopAdvertisingCallback(this)
                if (owned) {
                    runCatching { onFailure(errorCode) }
                }
            }
        }
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(
                when (advertiseMode) {
                    BluetoothAdvertiseMode.BALANCED ->
                        AdvertiseSettings.ADVERTISE_MODE_BALANCED
                    BluetoothAdvertiseMode.LOW_LATENCY ->
                        AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY
                }
            )
            .setConnectable(connectable)
            .setTimeout(0)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .build()
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addServiceData(serviceUuid, encoded)
            .build()

        return try {
            callbackOwnership.install(advertiseCallback)
            startDeadline = deadline
            pendingStartKey = startKey
            activeStartKey = null
            token = deadline.start()
            advertiser.startAdvertising(settings, data, advertiseCallback)
            true
        } catch (_: SecurityException) {
            releaseOwnedStart(advertiseCallback, deadline)
            runCatching { advertiser.stopAdvertising(advertiseCallback) }
            false
        } catch (_: RuntimeException) {
            releaseOwnedStart(advertiseCallback, deadline)
            runCatching { advertiser.stopAdvertising(advertiseCallback) }
            false
        }
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    fun stop() {
        val activeCallback = callbackOwnership.clear()
        startDeadline?.close()
        startDeadline = null
        pendingStartKey = null
        activeStartKey = null
        activeCallback?.let(::stopAdvertisingCallback)
    }

    @Synchronized
    private fun releaseOwnedStart(
        callback: AdvertiseCallback,
        deadline: BluetoothAdvertiserStartDeadlineV1
    ): Boolean {
        if (
            !callbackOwnership.isOwner(callback) ||
            startDeadline !== deadline ||
            !callbackOwnership.release(callback)
        ) return false
        deadline.close()
        startDeadline = null
        pendingStartKey = null
        activeStartKey = null
        return true
    }

    private fun handleStartDeadline(
        callback: AdvertiseCallback,
        deadline: BluetoothAdvertiserStartDeadlineV1,
        onFailure: (Int) -> Unit
    ) {
        val owned = releaseOwnedStart(callback, deadline)
        stopAdvertisingCallback(callback)
        if (owned) {
            runCatching { onFailure(AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR) }
        }
    }

    @SuppressLint("MissingPermission")
    private fun stopAdvertisingCallback(callback: AdvertiseCallback) {
        runCatching {
            val manager =
                appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            manager?.adapter?.bluetoothLeAdvertiser?.stopAdvertising(callback)
        }
    }
}
