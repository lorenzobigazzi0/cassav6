package com.sentrapa.cassav6.webkiosk.bluetooth

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import org.json.JSONObject

const val BLUETOOTH_SHADOW_SCHEMA_VERSION_V1 = 1
const val BLUETOOTH_SHADOW_MAX_BODY_BYTES_V1 = 128
const val BLUETOOTH_SHADOW_MAX_WIRE_BYTES_V1 = 512
const val BLUETOOTH_SHADOW_BUSINESS_TRANSPORT_V1 = "LAN_HTTP_SSE"

enum class BluetoothShadowKindV1 {
    HEALTH,
    PING,
    TEST
}

data class BluetoothShadowMessageV1(
    val schemaVersion: Int = BLUETOOTH_SHADOW_SCHEMA_VERSION_V1,
    val kind: BluetoothShadowKindV1,
    val correlationId: String,
    val sentAtEpochMs: Long,
    val lanLatencyMs: Long?,
    val body: String
)

data class BluetoothShadowAcceptResultV1(
    val accepted: Boolean,
    val duplicate: Boolean
)

data class BluetoothShadowIngressMetricsV1(
    val enabled: Boolean,
    val received: Long,
    val accepted: Long,
    val duplicates: Long,
    val rejected: Long,
    val handlerFailures: Long,
    val bleLatencyAverageMs: Double?,
    val lanLatencyAverageMs: Double?,
    val latencyDeltaAverageMs: Double?,
    val businessMessagesForwarded: Long = 0
)

data class BluetoothShadowEmitResultV1(
    val shadowSent: Boolean,
    val businessTransport: String = BLUETOOTH_SHADOW_BUSINESS_TRANSPORT_V1
)

data class BluetoothCommandBusShadowSnapshotV1(
    val enabled: Boolean,
    val diagnosticsSent: Long,
    val businessRouteAttemptsRejected: Long,
    val businessMessagesForwarded: Long,
    val businessTransport: String,
    val ingress: BluetoothShadowIngressMetricsV1
)

class BluetoothShadowExceptionV1(
    val code: String,
    message: String,
    cause: Throwable? = null
) : RuntimeException(message, cause)

private fun bluetoothShadowFailureV1(
    code: String,
    message: String,
    cause: Throwable? = null
): Nothing = throw BluetoothShadowExceptionV1(code, message, cause)

object BluetoothShadowCodecV1 {
    private val allowedKeys = setOf(
        "schemaVersion",
        "kind",
        "correlationId",
        "sentAtEpochMs",
        "lanLatencyMs",
        "body"
    )

    fun encode(value: BluetoothShadowMessageV1): ByteArray {
        validate(value)
        val encoded = buildString {
            append("{\"schemaVersion\":")
            append(BLUETOOTH_SHADOW_SCHEMA_VERSION_V1)
            append(",\"kind\":")
            append(canonicalJsonString(value.kind.name))
            append(",\"correlationId\":")
            append(canonicalJsonString(value.correlationId))
            append(",\"sentAtEpochMs\":")
            append(value.sentAtEpochMs)
            append(",\"lanLatencyMs\":")
            append(value.lanLatencyMs ?: "null")
            append(",\"body\":")
            append(canonicalJsonString(value.body))
            append('}')
        }.toByteArray(StandardCharsets.UTF_8)
        if (encoded.size > BLUETOOTH_SHADOW_MAX_WIRE_BYTES_V1) {
            encoded.fill(0)
            bluetoothShadowFailureV1(
                "SHADOW_WIRE_TOO_LARGE",
                "shadow message exceeds its wire budget"
            )
        }
        return encoded
    }

    fun decode(wire: ByteArray): BluetoothShadowMessageV1 {
        if (wire.size !in 2..BLUETOOTH_SHADOW_MAX_WIRE_BYTES_V1) {
            bluetoothShadowFailureV1(
                "INVALID_SHADOW_WIRE",
                "shadow wire length is invalid"
            )
        }
        val parsed = try {
            JSONObject(wire.toString(StandardCharsets.UTF_8))
        } catch (error: Throwable) {
            bluetoothShadowFailureV1(
                "INVALID_SHADOW_JSON",
                "shadow wire is not valid JSON",
                error
            )
        }
        val keys = mutableSetOf<String>()
        parsed.keys().forEachRemaining(keys::add)
        if (keys != allowedKeys) {
            bluetoothShadowFailureV1(
                "INVALID_SHADOW_KEYS",
                "shadow JSON fields are not exact"
            )
        }
        val schemaVersion = jsonInteger(
            parsed.opt("schemaVersion"),
            0,
            Int.MAX_VALUE.toLong(),
            "schemaVersion"
        ).toInt()
        val rawKind = parsed.opt("kind") as? String
            ?: bluetoothShadowFailureV1(
                "BUSINESS_MESSAGE_REJECTED",
                "only health, ping and test are allowed"
            )
        val kind = runCatching { BluetoothShadowKindV1.valueOf(rawKind) }
            .getOrElse {
                bluetoothShadowFailureV1(
                    "BUSINESS_MESSAGE_REJECTED",
                    "only health, ping and test are allowed"
                )
            }
        val correlationId = parsed.opt("correlationId") as? String
            ?: bluetoothShadowFailureV1(
                "INVALID_CORRELATION_ID",
                "correlationId must be canonical lowercase hex"
            )
        val sentAtEpochMs = jsonInteger(
            parsed.opt("sentAtEpochMs"),
            0,
            ReliableFrameCodecV1.MAXIMUM_SAFE_CLOCK,
            "sentAtEpochMs"
        )
        val rawLatency = parsed.opt("lanLatencyMs")
        val lanLatencyMs = if (rawLatency == null || rawLatency === JSONObject.NULL) {
            null
        } else {
            jsonInteger(rawLatency, 0, 60_000, "lanLatencyMs")
        }
        val body = parsed.opt("body") as? String
            ?: bluetoothShadowFailureV1(
                "INVALID_SHADOW_BODY",
                "shadow body is not canonical printable UTF-8"
            )
        val value = BluetoothShadowMessageV1(
            schemaVersion,
            kind,
            correlationId,
            sentAtEpochMs,
            lanLatencyMs,
            body
        )
        validate(value)
        val canonical = encode(value)
        try {
            if (!MessageDigest.isEqual(canonical, wire)) {
                bluetoothShadowFailureV1(
                    "NON_CANONICAL_SHADOW_JSON",
                    "shadow JSON serialization is not canonical"
                )
            }
        } finally {
            canonical.fill(0)
        }
        return value
    }

    fun validate(value: BluetoothShadowMessageV1) {
        if (value.schemaVersion != BLUETOOTH_SHADOW_SCHEMA_VERSION_V1) {
            bluetoothShadowFailureV1(
                "INVALID_SHADOW_VERSION",
                "shadow message version is unsupported"
            )
        }
        if (!Regex("^[0-9a-f]{32}$").matches(value.correlationId)) {
            bluetoothShadowFailureV1(
                "INVALID_CORRELATION_ID",
                "correlationId must be canonical lowercase hex"
            )
        }
        shadowInteger(
            value.sentAtEpochMs,
            0,
            ReliableFrameCodecV1.MAXIMUM_SAFE_CLOCK,
            "sentAtEpochMs"
        )
        value.lanLatencyMs?.let {
            shadowInteger(it, 0, 60_000, "lanLatencyMs")
        }
        if (
            value.body.toByteArray(StandardCharsets.UTF_8).size >
            BLUETOOTH_SHADOW_MAX_BODY_BYTES_V1 ||
            value.body.any { it.code in 0..31 || it.code == 127 } ||
            hasUnpairedSurrogate(value.body)
        ) {
            bluetoothShadowFailureV1(
                "INVALID_SHADOW_BODY",
                "shadow body is not canonical printable UTF-8"
            )
        }
    }

    private fun jsonInteger(
        value: Any?,
        minimum: Long,
        maximum: Long,
        field: String
    ): Long {
        val number = value as? Number
            ?: bluetoothShadowFailureV1(
                "INVALID_SHADOW_FIELD",
                "$field is outside its canonical range"
            )
        val asDouble = number.toDouble()
        val asLong = number.toLong()
        if (
            !asDouble.isFinite() ||
            asDouble != asLong.toDouble() ||
            asLong !in minimum..maximum
        ) {
            bluetoothShadowFailureV1(
                "INVALID_SHADOW_FIELD",
                "$field is outside its canonical range"
            )
        }
        return asLong
    }

    private fun canonicalJsonString(value: String): String = buildString {
        append('"')
        value.forEach { character ->
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                else -> append(character)
            }
        }
        append('"')
    }

    private fun hasUnpairedSurrogate(value: String): Boolean {
        var index = 0
        while (index < value.length) {
            val character = value[index]
            when {
                Character.isHighSurrogate(character) -> {
                    if (
                        index + 1 >= value.length ||
                        !Character.isLowSurrogate(value[index + 1])
                    ) {
                        return true
                    }
                    index += 2
                }
                Character.isLowSurrogate(character) -> return true
                else -> index += 1
            }
        }
        return false
    }
}

fun interface BluetoothShadowHandlerV1 {
    fun onDiagnostic(message: BluetoothShadowMessageV1)
}

class BluetoothShadowIngressV1(
    private val handler: BluetoothShadowHandlerV1,
    private val enabled: Boolean = false,
    private val maximumClockSkewMs: Long = 30_000,
    private val dedupTtlMs: Long = 5 * 60_000,
    private val now: () -> Long = System::currentTimeMillis
) {
    private val seen = mutableMapOf<String, Long>()
    private var received = 0L
    private var accepted = 0L
    private var duplicates = 0L
    private var rejected = 0L
    private var handlerFailures = 0L
    private var bleLatencyTotalMs = 0.0
    private var lanLatencyTotalMs = 0.0
    private var latencySamples = 0L
    private var lanLatencySamples = 0L
    private var lastNowEpochMs = 0L

    init {
        shadowInteger(maximumClockSkewMs, 1_000, 300_000, "maximumClockSkewMs")
        shadowInteger(dedupTtlMs, 1_000, 3_600_000, "dedupTtlMs")
    }

    @Synchronized
    fun accept(
        authenticated: Boolean,
        message: ReliableMessageV1
    ): BluetoothShadowAcceptResultV1 {
        received += 1
        if (!enabled) reject("SHADOW_DISABLED", "Bluetooth command-bus shadow is disabled")
        if (!authenticated) {
            reject(
                "UNAUTHENTICATED_SHADOW",
                "shadow ingress requires an authenticated session"
            )
        }
        if (message.type != ReliableFrameTypeV1.SHADOW_DIAGNOSTIC) {
            reject(
                "BUSINESS_MESSAGE_REJECTED",
                "non-diagnostic reliable type is forbidden"
            )
        }
        val current = checkedNow()
        prune(current)
        val decoded = try {
            BluetoothShadowCodecV1.decode(message.payload)
        } catch (error: Throwable) {
            rejected += 1
            throw error
        }
        val latency = current - decoded.sentAtEpochMs
        if (latency < 0 || latency > maximumClockSkewMs) {
            reject(
                "SHADOW_CLOCK_SKEW",
                "shadow message falls outside the clock window"
            )
        }
        val seenUntil = seen[decoded.correlationId]
        if (seenUntil != null && seenUntil > current) {
            duplicates += 1
            return BluetoothShadowAcceptResultV1(false, true)
        }
        seen[decoded.correlationId] = current + dedupTtlMs
        try {
            handler.onDiagnostic(decoded)
        } catch (error: Throwable) {
            seen.remove(decoded.correlationId)
            handlerFailures += 1
            bluetoothShadowFailureV1(
                "SHADOW_HANDLER_FAILED",
                "diagnostic shadow handler failed",
                error
            )
        }
        accepted += 1
        latencySamples += 1
        bleLatencyTotalMs += latency.toDouble()
        decoded.lanLatencyMs?.let {
            lanLatencySamples += 1
            lanLatencyTotalMs += it.toDouble()
        }
        return BluetoothShadowAcceptResultV1(true, false)
    }

    @Synchronized
    fun snapshot(): BluetoothShadowIngressMetricsV1 {
        val bleAverage = if (latencySamples == 0L) {
            null
        } else {
            bleLatencyTotalMs / latencySamples.toDouble()
        }
        val lanAverage = if (lanLatencySamples == 0L) {
            null
        } else {
            lanLatencyTotalMs / lanLatencySamples.toDouble()
        }
        return BluetoothShadowIngressMetricsV1(
            enabled,
            received,
            accepted,
            duplicates,
            rejected,
            handlerFailures,
            bleAverage,
            lanAverage,
            if (bleAverage == null || lanAverage == null) null else bleAverage - lanAverage
        )
    }

    private fun checkedNow(): Long {
        val current = now()
        shadowInteger(
            current,
            0,
            ReliableFrameCodecV1.MAXIMUM_SAFE_CLOCK,
            "clock"
        )
        if (current < lastNowEpochMs) {
            bluetoothShadowFailureV1(
                "CLOCK_REGRESSION",
                "shadow ingress clock moved backwards"
            )
        }
        lastNowEpochMs = current
        return current
    }

    private fun prune(current: Long) {
        seen.entries.removeAll { it.value <= current }
    }

    private fun reject(code: String, message: String): Nothing {
        rejected += 1
        bluetoothShadowFailureV1(code, message)
    }
}

fun interface BluetoothShadowChannelV1 {
    fun send(input: ReliableChannelSendInputV1): ReliableChannelSendResultV1
}

class ReliableBluetoothShadowChannelV1(
    private val channel: ReliableChannelV1
) : BluetoothShadowChannelV1 {
    override fun send(input: ReliableChannelSendInputV1): ReliableChannelSendResultV1 =
        channel.send(input)
}

class BluetoothCommandBusShadowAdapterV1(
    private val channel: BluetoothShadowChannelV1,
    private val ingress: BluetoothShadowIngressV1,
    private val enabled: Boolean = false,
    private val now: () -> Long = System::currentTimeMillis,
    private val correlationIdGenerator: () -> String = ::randomShadowCorrelationIdV1
) {
    private var diagnosticsSent = 0L
    private var businessRouteAttemptsRejected = 0L

    @Synchronized
    fun emitDiagnostic(
        kind: BluetoothShadowKindV1,
        body: String,
        lanLatencyMs: Long? = null
    ): BluetoothShadowEmitResultV1 {
        if (!enabled) return BluetoothShadowEmitResultV1(false)
        val payload = BluetoothShadowCodecV1.encode(
            BluetoothShadowMessageV1(
                kind = kind,
                correlationId = correlationIdGenerator(),
                sentAtEpochMs = now(),
                lanLatencyMs = lanLatencyMs,
                body = body
            )
        )
        try {
            channel.send(
                ReliableChannelSendInputV1(
                    type = ReliableFrameTypeV1.SHADOW_DIAGNOSTIC,
                    payload = payload,
                    durable = false,
                    ttlMs = 30_000
                )
            )
            diagnosticsSent += 1
        } finally {
            payload.fill(0)
        }
        return BluetoothShadowEmitResultV1(true)
    }

    fun ingest(message: ReliableMessageV1): BluetoothShadowAcceptResultV1 =
        ingress.accept(authenticated = true, message = message)

    @Synchronized
    fun routeBusinessCommand(): Nothing {
        businessRouteAttemptsRejected += 1
        bluetoothShadowFailureV1(
            "BUSINESS_ROUTING_FORBIDDEN",
            "B10 never routes business commands over Bluetooth"
        )
    }

    @Synchronized
    fun snapshot(): BluetoothCommandBusShadowSnapshotV1 =
        BluetoothCommandBusShadowSnapshotV1(
            enabled = enabled,
            diagnosticsSent = diagnosticsSent,
            businessRouteAttemptsRejected = businessRouteAttemptsRejected,
            businessMessagesForwarded = 0,
            businessTransport = BLUETOOTH_SHADOW_BUSINESS_TRANSPORT_V1,
            ingress = ingress.snapshot()
        )
}

private fun shadowInteger(value: Long, minimum: Long, maximum: Long, field: String) {
    if (value !in minimum..maximum) {
        bluetoothShadowFailureV1(
            "INVALID_SHADOW_FIELD",
            "$field is outside its canonical range"
        )
    }
}

private fun randomShadowCorrelationIdV1(): String {
    val value = ByteArray(ReliableFrameCodecV1.MESSAGE_ID_BYTES)
    return try {
        SecureRandom().nextBytes(value)
        value.joinToString(separator = "") { byte ->
            "%02x".format(byte.toInt() and 0xff)
        }
    } finally {
        value.fill(0)
    }
}
