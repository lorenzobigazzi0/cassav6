package com.sentrapa.cassav6.webkiosk.bluetooth

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.floor
import kotlin.math.min

const val ROUTE_ADVERTISEMENT_VERSION_V1 = 1
const val ROUTE_ADVERTISEMENT_WIRE_BYTES_V1 = 12
const val ROUTE_ADVERTISEMENT_MAX_AGE_SECONDS_V1 = 65_535
const val ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET_V1 = 15
const val ROUTE_ADVERTISEMENT_MAX_PUBLISH_INTERVAL_MS_V1 = 5_000L

data class RouteAdvertisementV1(
    val canReachServer: Boolean,
    val routeKind: BluetoothRouteKindV1,
    val serverRttBucket: Int,
    val routeAgeSeconds: Int,
    val queueDepthBucket: Int,
    val batteryBucket: Int,
    val sequence: Long
)

data class RouteAdvertisementBuildInputV1(
    val nowEpochMs: Long,
    val force: Boolean = false,
    val canReachServer: Boolean,
    val routeKind: BluetoothRouteKindV1,
    val serverRttMs: Double?,
    val lastRouteChangeAtEpochMs: Long,
    val queueDepth: Long,
    val batteryPercent: Double?
)

data class RouteAdvertisementPublisherSnapshotV1(
    val sequence: Long,
    val hasPublished: Boolean,
    val publishIntervalMs: Long
)

data class RouteAdvertisementIngressMetricsV1(
    val enabled: Boolean,
    val received: Long,
    val accepted: Long,
    val rejected: Long,
    val persisted: Long,
    val businessMessagesForwarded: Long = 0
)

data class RouteReachabilityV1(
    val known: Boolean,
    val stale: Boolean,
    val canReachServer: Boolean,
    val routeKind: BluetoothRouteKindV1,
    val observedAgeMs: Long?
)

data class RouteAdvertisementEmitResultV1(
    val sent: Boolean,
    val businessMessagesForwarded: Long = 0
)

class RouteAdvertisementExceptionV1(
    val code: String,
    message: String,
    cause: Throwable? = null
) : RuntimeException(message, cause)

private fun routeAdvertisementFailureV1(
    code: String,
    message: String,
    cause: Throwable? = null
): Nothing = throw RouteAdvertisementExceptionV1(code, message, cause)

object RouteAdvertisementCodecV1 {
    fun encode(value: RouteAdvertisementV1): ByteArray {
        validate(value)
        return ByteArray(ROUTE_ADVERTISEMENT_WIRE_BYTES_V1).also { wire ->
            wire[0] = ROUTE_ADVERTISEMENT_VERSION_V1.toByte()
            wire[1] = if (value.canReachServer) 1 else 0
            wire[2] = routeKindCode(value.routeKind).toByte()
            wire[3] = value.serverRttBucket.toByte()
            ByteBuffer.wrap(wire).order(ByteOrder.BIG_ENDIAN).apply {
                putShort(4, value.routeAgeSeconds.toShort())
                putInt(8, value.sequence.toInt())
            }
            wire[6] = value.queueDepthBucket.toByte()
            wire[7] = value.batteryBucket.toByte()
        }
    }

    fun decode(wire: ByteArray): RouteAdvertisementV1 {
        if (wire.size != ROUTE_ADVERTISEMENT_WIRE_BYTES_V1) {
            routeAdvertisementFailureV1(
                "INVALID_ROUTE_LENGTH",
                "route advertisement must be exactly 12 bytes"
            )
        }
        if (wire[0].unsigned() != ROUTE_ADVERTISEMENT_VERSION_V1) {
            routeAdvertisementFailureV1(
                "INVALID_ROUTE_VERSION",
                "route advertisement version is unsupported"
            )
        }
        if (wire[1].unsigned() !in 0..1) {
            routeAdvertisementFailureV1(
                "INVALID_ROUTE_FLAGS",
                "route flags contain reserved bits"
            )
        }
        val buffer = ByteBuffer.wrap(wire).order(ByteOrder.BIG_ENDIAN)
        return RouteAdvertisementV1(
            canReachServer = wire[1].unsigned() == 1,
            routeKind = routeKind(wire[2].unsigned()),
            serverRttBucket = wire[3].unsigned(),
            routeAgeSeconds = buffer.getShort(4).toInt() and 0xffff,
            queueDepthBucket = wire[6].unsigned(),
            batteryBucket = wire[7].unsigned(),
            sequence = buffer.getInt(8).toLong() and 0xffff_ffffL
        ).also(::validate)
    }

    fun validate(value: RouteAdvertisementV1) {
        if (!validRttBucket(value.serverRttBucket)) {
            routeAdvertisementFailureV1(
                "INVALID_RTT_BUCKET",
                "server RTT bucket is reserved"
            )
        }
        routeInteger(
            value.routeAgeSeconds.toLong(),
            0,
            ROUTE_ADVERTISEMENT_MAX_AGE_SECONDS_V1.toLong(),
            "routeAgeSeconds"
        )
        routeInteger(value.queueDepthBucket.toLong(), 0, 15, "queueDepthBucket")
        if (!validBatteryBucket(value.batteryBucket)) {
            routeAdvertisementFailureV1(
                "INVALID_BATTERY_BUCKET",
                "battery bucket is reserved"
            )
        }
        routeInteger(value.sequence, 1, 0xffff_ffffL, "sequence")
        if (value.canReachServer && value.routeKind == BluetoothRouteKindV1.NONE) {
            routeAdvertisementFailureV1(
                "INVALID_ROUTE_STATE",
                "NONE cannot claim server reachability"
            )
        }
        if (
            value.canReachServer &&
            value.routeKind == BluetoothRouteKindV1.BLE_DIRECT
        ) {
            routeAdvertisementFailureV1(
                "MULTIHOP_NOT_ALLOWED",
                "B9 does not advertise reachability through another BLE node"
            )
        }
        if (
            !value.canReachServer &&
            value.serverRttBucket != ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET_V1
        ) {
            routeAdvertisementFailureV1(
                "INVALID_ROUTE_STATE",
                "unreachable route must use the unknown RTT bucket"
            )
        }
    }

    private fun routeKindCode(value: BluetoothRouteKindV1): Int = when (value) {
        BluetoothRouteKindV1.NONE -> 0
        BluetoothRouteKindV1.WIFI -> 1
        BluetoothRouteKindV1.LAN -> 2
        BluetoothRouteKindV1.BLE_DIRECT -> 3
    }

    private fun routeKind(value: Int): BluetoothRouteKindV1 = when (value) {
        0 -> BluetoothRouteKindV1.NONE
        1 -> BluetoothRouteKindV1.WIFI
        2 -> BluetoothRouteKindV1.LAN
        3 -> BluetoothRouteKindV1.BLE_DIRECT
        else -> routeAdvertisementFailureV1(
            "INVALID_ROUTE_KIND",
            "route kind code is not assigned"
        )
    }
}

fun serverRttBucketV1(rttMs: Double?): Int {
    if (rttMs == null) return ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET_V1
    if (!rttMs.isFinite() || rttMs < 0.0) {
        routeAdvertisementFailureV1(
            "INVALID_RTT",
            "RTT must be finite and nonnegative"
        )
    }
    val ceilings = doubleArrayOf(10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1_000.0)
    val index = ceilings.indexOfFirst { rttMs <= it }
    return if (index == -1) 7 else index
}

fun queueDepthBucketV1(queueDepth: Long): Int {
    routeInteger(queueDepth, 0, ReliableFrameCodecV1.MAXIMUM_SAFE_CLOCK, "queueDepth")
    if (queueDepth == 0L) return 0
    return min(15, 64 - java.lang.Long.numberOfLeadingZeros(queueDepth))
}

fun batteryBucketV1(percent: Double?): Int {
    if (percent == null) return ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET_V1
    if (!percent.isFinite() || percent < 0.0 || percent > 100.0) {
        routeAdvertisementFailureV1(
            "INVALID_BATTERY",
            "battery percent must be from zero to one hundred"
        )
    }
    return min(10, floor(percent / 10.0).toInt())
}

class RouteAdvertisementPublisherV1(
    private val publishIntervalMs: Long = ROUTE_ADVERTISEMENT_MAX_PUBLISH_INTERVAL_MS_V1,
    private val sequenceStore: RouteAdvertisementSequenceStoreV1 =
        InMemoryRouteAdvertisementSequenceStoreV1()
) {
    private var lastPublishedAtEpochMs: Long? = null
    private var lastClockEpochMs = 0L

    init {
        routeInteger(
            publishIntervalMs,
            1_000,
            ROUTE_ADVERTISEMENT_MAX_PUBLISH_INTERVAL_MS_V1,
            "publishIntervalMs"
        )
    }

    @Synchronized
    fun build(input: RouteAdvertisementBuildInputV1): ByteArray? {
        routeClock(input.nowEpochMs, "nowEpochMs")
        routeInteger(
            input.lastRouteChangeAtEpochMs,
            0,
            input.nowEpochMs,
            "lastRouteChangeAtEpochMs"
        )
        if (input.nowEpochMs < lastClockEpochMs) {
            routeAdvertisementFailureV1(
                "CLOCK_REGRESSION",
                "route publisher clock moved backwards"
            )
        }
        lastClockEpochMs = input.nowEpochMs
        val previous = lastPublishedAtEpochMs
        if (
            !input.force &&
            previous != null &&
            input.nowEpochMs - previous < publishIntervalMs
        ) {
            return null
        }
        val sequence = sequenceStore.reserveNextSequence()
        routeInteger(sequence, 1, 0xffff_ffffL, "sequence")
        lastPublishedAtEpochMs = input.nowEpochMs
        return RouteAdvertisementCodecV1.encode(
            RouteAdvertisementV1(
                canReachServer = input.canReachServer,
                routeKind = input.routeKind,
                serverRttBucket = serverRttBucketV1(
                    if (input.canReachServer) input.serverRttMs else null
                ),
                routeAgeSeconds = min(
                    ROUTE_ADVERTISEMENT_MAX_AGE_SECONDS_V1,
                    ((input.nowEpochMs - input.lastRouteChangeAtEpochMs) / 1_000L).toInt()
                ),
                queueDepthBucket = queueDepthBucketV1(input.queueDepth),
                batteryBucket = batteryBucketV1(input.batteryPercent),
                sequence = sequence
            )
        )
    }

    @Synchronized
    fun snapshot(): RouteAdvertisementPublisherSnapshotV1 =
        RouteAdvertisementPublisherSnapshotV1(
            sequenceStore.currentSequence(),
            lastPublishedAtEpochMs != null,
            publishIntervalMs
        )
}

interface RouteAdvertisementSequenceStoreV1 {
    fun reserveNextSequence(): Long

    fun currentSequence(): Long
}

class InMemoryRouteAdvertisementSequenceStoreV1(
    initialSequence: Long = 0
) : RouteAdvertisementSequenceStoreV1 {
    private var sequence = initialSequence.also {
        routeInteger(it, 0, 0xffff_ffffL, "initialSequence")
    }

    @Synchronized
    override fun reserveNextSequence(): Long {
        if (sequence >= 0xffff_ffffL) {
            routeAdvertisementFailureV1(
                "SEQUENCE_EXHAUSTED",
                "route advertisement sequence is exhausted"
            )
        }
        sequence += 1
        return sequence
    }

    @Synchronized
    override fun currentSequence(): Long = sequence
}

fun interface RouteAdvertisementChannelV1 {
    fun send(input: ReliableChannelSendInputV1): ReliableChannelSendResultV1
}

class RouteAdvertisementEmitterV1(
    private val publisher: RouteAdvertisementPublisherV1,
    private val channel: RouteAdvertisementChannelV1,
    private val enabled: Boolean = false
) {
    @Synchronized
    fun update(input: RouteAdvertisementBuildInputV1): RouteAdvertisementEmitResultV1 {
        if (!enabled) return RouteAdvertisementEmitResultV1(sent = false)
        val payload = publisher.build(input)
            ?: return RouteAdvertisementEmitResultV1(sent = false)
        try {
            channel.send(
                ReliableChannelSendInputV1(
                    type = ReliableFrameTypeV1.ROUTE_ADVERTISEMENT,
                    payload = payload,
                    durable = false,
                    ttlMs = 15_000
                )
            )
        } finally {
            payload.fill(0)
        }
        return RouteAdvertisementEmitResultV1(sent = true)
    }
}

interface RouteAdvertisementStoreV1 {
    fun storeLastServerAdvertisement(value: BluetoothStoredRouteAdvertisementV1)

    fun lastServerAdvertisement(): BluetoothStoredRouteAdvertisementV1?
}

class AndroidRouteAdvertisementStoreV1(
    private val store: AndroidBluetoothTransportStoreV1
) : RouteAdvertisementStoreV1, RouteAdvertisementSequenceStoreV1 {
    override fun storeLastServerAdvertisement(value: BluetoothStoredRouteAdvertisementV1) {
        store.storeLastServerAdvertisement(value)
    }

    override fun lastServerAdvertisement(): BluetoothStoredRouteAdvertisementV1? =
        store.lastServerAdvertisement()

    override fun reserveNextSequence(): Long =
        store.reserveRouteAdvertisementSequence()

    override fun currentSequence(): Long =
        store.routeAdvertisementSequenceHighWatermark()
}

class RouteAdvertisementIngressV1(
    private val store: RouteAdvertisementStoreV1,
    private val enabled: Boolean = false,
    private val now: () -> Long = System::currentTimeMillis
) {
    private var received = 0L
    private var accepted = 0L
    private var rejected = 0L
    private var persisted = 0L
    private var lastClockEpochMs = 0L

    @Synchronized
    fun accept(authenticated: Boolean, message: ReliableMessageV1): RouteAdvertisementV1 {
        received += 1
        if (!enabled) reject("ROUTE_ADVERTISEMENT_DISABLED", "B9 route ingress is disabled")
        if (!authenticated) {
            reject(
                "UNAUTHENTICATED_ROUTE_ADVERTISEMENT",
                "route ingress requires an authenticated reliable session"
            )
        }
        if (message.type != ReliableFrameTypeV1.ROUTE_ADVERTISEMENT) {
            reject(
                "BUSINESS_MESSAGE_REJECTED",
                "route ingress accepts only route advertisements"
            )
        }
        val current = checkedNow()
        val decoded = try {
            RouteAdvertisementCodecV1.decode(message.payload)
        } catch (error: Throwable) {
            rejected += 1
            throw error
        }
        val previous = store.lastServerAdvertisement()
        if (previous != null && decoded.sequence <= previous.sequence) {
            reject(
                "ROUTE_SEQUENCE_REPLAY",
                "route advertisement sequence did not advance"
            )
        }
        val stored = BluetoothStoredRouteAdvertisementV1(
            canReachServer = decoded.canReachServer,
            routeKind = decoded.routeKind,
            serverRttBucket = decoded.serverRttBucket,
            routeAgeSeconds = decoded.routeAgeSeconds,
            queueDepthBucket = decoded.queueDepthBucket,
            batteryBucket = decoded.batteryBucket,
            sequence = decoded.sequence,
            observedAtEpochMs = current
        )
        try {
            store.storeLastServerAdvertisement(stored)
        } catch (error: Throwable) {
            rejected += 1
            if (
                error is BluetoothTransportStoreException &&
                error.code == "ROUTE_SEQUENCE_REPLAY"
            ) {
                routeAdvertisementFailureV1(
                    "ROUTE_SEQUENCE_REPLAY",
                    "route advertisement sequence did not advance",
                    error
                )
            }
            routeAdvertisementFailureV1(
                "ROUTE_PERSISTENCE_FAILED",
                "route advertisement was not committed to the B8 store",
                error
            )
        }
        accepted += 1
        persisted += 1
        return decoded
    }

    @Synchronized
    fun reachability(
        nowEpochMs: Long = now(),
        maximumAgeMs: Long = ROUTE_ADVERTISEMENT_MAX_PUBLISH_INTERVAL_MS_V1
    ): RouteReachabilityV1 {
        routeClock(nowEpochMs, "nowEpochMs")
        routeInteger(maximumAgeMs, 1_000, 60_000, "maximumAgeMs")
        val value = store.lastServerAdvertisement()
            ?: return RouteReachabilityV1(
                known = false,
                stale = true,
                canReachServer = false,
                routeKind = BluetoothRouteKindV1.NONE,
                observedAgeMs = null
            )
        if (value.observedAtEpochMs > nowEpochMs) {
            routeAdvertisementFailureV1(
                "CLOCK_REGRESSION",
                "persisted route observation is newer than the current clock"
            )
        }
        val age = nowEpochMs - value.observedAtEpochMs
        val stale = age > maximumAgeMs
        return RouteReachabilityV1(
            known = true,
            stale = stale,
            canReachServer = value.canReachServer && !stale,
            routeKind = if (stale) BluetoothRouteKindV1.NONE else value.routeKind,
            observedAgeMs = age
        )
    }

    @Synchronized
    fun snapshot(): RouteAdvertisementIngressMetricsV1 =
        RouteAdvertisementIngressMetricsV1(
            enabled = enabled,
            received = received,
            accepted = accepted,
            rejected = rejected,
            persisted = persisted
        )

    private fun checkedNow(): Long {
        val current = now()
        routeClock(current, "clock")
        if (current < lastClockEpochMs) {
            routeAdvertisementFailureV1(
                "CLOCK_REGRESSION",
                "route ingress clock moved backwards"
            )
        }
        lastClockEpochMs = current
        return current
    }

    private fun reject(code: String, message: String): Nothing {
        rejected += 1
        routeAdvertisementFailureV1(code, message)
    }
}

private fun routeInteger(value: Long, minimum: Long, maximum: Long, field: String) {
    if (value !in minimum..maximum) {
        routeAdvertisementFailureV1(
            "INVALID_ROUTE_FIELD",
            "$field is outside its canonical range"
        )
    }
}

private fun routeClock(value: Long, field: String) = routeInteger(
    value,
    0,
    ReliableFrameCodecV1.MAXIMUM_SAFE_CLOCK,
    field
)

private fun validRttBucket(value: Int): Boolean =
    value in 0..7 || value == ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET_V1

private fun validBatteryBucket(value: Int): Boolean =
    value in 0..10 || value == ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET_V1

private fun Byte.unsigned(): Int = toInt() and 0xff
