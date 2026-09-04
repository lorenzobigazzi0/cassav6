package com.sentrapa.cassav6.webkiosk.bluetooth

import java.security.SecureRandom
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.pow

const val RELIABLE_CHANNEL_DEFAULT_TTL_MS = 60_000L
const val RELIABLE_CHANNEL_MINIMUM_TTL_MS = 1_000L
const val RELIABLE_CHANNEL_MAXIMUM_TTL_MS = 24 * 60 * 60 * 1_000L
const val RELIABLE_CHANNEL_DEFAULT_MAX_ATTEMPTS = 5
const val RELIABLE_CHANNEL_DEFAULT_BASE_RETRY_MS = 250L
const val RELIABLE_CHANNEL_DEFAULT_MAX_RETRY_MS = 8_000L

class ReliableOutboxRecordV1(
    val peerTrustId: String,
    val messageId: String,
    val type: ReliableFrameTypeV1,
    val flags: Int,
    payload: ByteArray,
    val createdAtEpochMs: Long,
    val expiresAtEpochMs: Long
) {
    val payload: ByteArray = payload.copyOf()

    internal fun copyRecord(): ReliableOutboxRecordV1 =
        ReliableOutboxRecordV1(
            peerTrustId,
            messageId,
            type,
            flags,
            payload,
            createdAtEpochMs,
            expiresAtEpochMs
        )
}

data class ReliableStorePruneResultV1(
    val expiredOutbox: Int,
    val expiredInbox: Int
)

data class ReliableStoreSnapshotV1(
    val outboxDepth: Int,
    val inboxDedupDepth: Int
)

interface ReliableChannelStoreV1 {
    fun reserveOutboundSequence(): Long

    fun enqueueOutbox(record: ReliableOutboxRecordV1)

    fun completeOutbox(peerTrustId: String, messageId: String)

    fun listOutbox(peerTrustId: String, nowEpochMs: Long): List<ReliableOutboxRecordV1>

    fun hasInbox(peerTrustId: String, messageId: String, nowEpochMs: Long): Boolean

    fun rememberInbox(peerTrustId: String, messageId: String, expiresAtEpochMs: Long)

    fun forgetInbox(peerTrustId: String, messageId: String)

    fun prune(nowEpochMs: Long): ReliableStorePruneResultV1

    fun snapshot(): ReliableStoreSnapshotV1
}

fun interface ReliableChannelTransportV1 {
    fun send(frame: ByteArray)
}

fun interface ReliableChannelMessageHandlerV1 {
    fun onMessage(message: ReliableMessageV1)
}

data class ReliableChannelMetricsV1(
    val framesTx: Long,
    val framesRx: Long,
    val messagesTx: Long,
    val messagesRx: Long,
    val acknowledgementsTx: Long,
    val acknowledgementsRx: Long,
    val retries: Long,
    val duplicates: Long,
    val expired: Long,
    val deliveryFailures: Long,
    val pendingMessages: Int,
    val suspendedMessages: Int,
    val outboxDepth: Int,
    val inboxDedupDepth: Int,
    val reassemblyOpenMessages: Int,
    val reassemblyBufferedBytes: Int
)

data class ReliableChannelSendInputV1(
    val type: ReliableFrameTypeV1,
    val payload: ByteArray,
    val durable: Boolean = false,
    val ttlMs: Long = RELIABLE_CHANNEL_DEFAULT_TTL_MS,
    val messageId: String? = null
)

data class ReliableChannelSendResultV1(
    val messageId: String,
    val durableCommitted: Boolean
)

data class ReliableChannelReceiveResultV1(
    val complete: Boolean,
    val delivered: Boolean,
    val duplicate: Boolean
)

data class ReliableChannelTickResultV1(
    val retried: Int,
    val suspended: Int,
    val expired: Int
)

class ReliableChannelException(
    val code: String,
    message: String,
    cause: Throwable? = null
) : RuntimeException(message, cause)

private fun reliableChannelFailure(
    code: String,
    message: String,
    cause: Throwable? = null
): Nothing = throw ReliableChannelException(code, message, cause)

class InMemoryReliableChannelStoreV1 : ReliableChannelStoreV1, AutoCloseable {
    private data class RecordKey(val peerTrustId: String, val messageId: String)

    private var sequence = 0L
    private val outbox = mutableMapOf<RecordKey, ReliableOutboxRecordV1>()
    private val inbox = mutableMapOf<RecordKey, Long>()

    @Synchronized
    override fun reserveOutboundSequence(): Long {
        if (sequence >= 0xffff_ffffL) {
            reliableChannelFailure(
                "SEQUENCE_EXHAUSTED",
                "outbound sequence space is exhausted"
            )
        }
        sequence += 1
        return sequence
    }

    @Synchronized
    override fun enqueueOutbox(record: ReliableOutboxRecordV1) {
        val key = recordKey(record.peerTrustId, record.messageId)
        if (outbox.containsKey(key)) {
            reliableChannelFailure(
                "OUTBOX_CONFLICT",
                "messageId already exists in the outbox"
            )
        }
        outbox[key] = record.copyRecord()
    }

    @Synchronized
    override fun completeOutbox(peerTrustId: String, messageId: String) {
        outbox.remove(recordKey(peerTrustId, messageId))?.payload?.fill(0)
    }

    @Synchronized
    override fun listOutbox(
        peerTrustId: String,
        nowEpochMs: Long
    ): List<ReliableOutboxRecordV1> {
        val normalizedPeerTrustId = validateReliablePeerTrustIdV1(peerTrustId)
        return outbox.values
            .asSequence()
            .filter {
                it.peerTrustId == normalizedPeerTrustId &&
                    it.expiresAtEpochMs > nowEpochMs
            }
            .sortedWith(
                compareBy<ReliableOutboxRecordV1> { it.createdAtEpochMs }
                    .thenBy { it.messageId }
            )
            .map(ReliableOutboxRecordV1::copyRecord)
            .toList()
    }

    @Synchronized
    override fun hasInbox(
        peerTrustId: String,
        messageId: String,
        nowEpochMs: Long
    ): Boolean = inbox[recordKey(peerTrustId, messageId)]?.let { it > nowEpochMs } == true

    @Synchronized
    override fun rememberInbox(
        peerTrustId: String,
        messageId: String,
        expiresAtEpochMs: Long
    ) {
        inbox[recordKey(peerTrustId, messageId)] = expiresAtEpochMs
    }

    @Synchronized
    override fun forgetInbox(peerTrustId: String, messageId: String) {
        inbox.remove(recordKey(peerTrustId, messageId))
    }

    @Synchronized
    override fun prune(nowEpochMs: Long): ReliableStorePruneResultV1 {
        var expiredOutbox = 0
        var expiredInbox = 0
        outbox.entries.toList().forEach { (key, record) ->
            if (record.expiresAtEpochMs <= nowEpochMs) {
                outbox.remove(key)?.payload?.fill(0)
                expiredOutbox += 1
            }
        }
        inbox.entries.toList().forEach { (key, expiresAtEpochMs) ->
            if (expiresAtEpochMs <= nowEpochMs) {
                inbox.remove(key)
                expiredInbox += 1
            }
        }
        return ReliableStorePruneResultV1(expiredOutbox, expiredInbox)
    }

    @Synchronized
    override fun snapshot(): ReliableStoreSnapshotV1 =
        ReliableStoreSnapshotV1(outbox.size, inbox.size)

    @Synchronized
    override fun close() {
        outbox.values.forEach { it.payload.fill(0) }
        outbox.clear()
        inbox.clear()
    }

    private fun recordKey(peerTrustId: String, messageId: String): RecordKey =
        RecordKey(
            validateReliablePeerTrustIdV1(peerTrustId),
            validateChannelMessageId(messageId)
        )
}

class ReliableChannelV1(
    private val transport: ReliableChannelTransportV1,
    peerTrustId: String,
    private val mtu: Int,
    txKey: ByteArray,
    rxKey: ByteArray,
    txNoncePrefix: ByteArray,
    rxNoncePrefix: ByteArray,
    private val onMessage: ReliableChannelMessageHandlerV1,
    private val store: ReliableChannelStoreV1 = InMemoryReliableChannelStoreV1(),
    private val maxAttempts: Int = RELIABLE_CHANNEL_DEFAULT_MAX_ATTEMPTS,
    private val baseRetryMs: Long = RELIABLE_CHANNEL_DEFAULT_BASE_RETRY_MS,
    private val maxRetryMs: Long = RELIABLE_CHANNEL_DEFAULT_MAX_RETRY_MS,
    private val random: () -> Double = Math::random,
    private val now: () -> Long = System::currentTimeMillis,
    private val messageIdGenerator: () -> String = ::randomMessageId
) : AutoCloseable {
    private data class PendingMessage(
        val record: ReliableOutboxRecordV1,
        val sequence: Long,
        val frames: List<ByteArray>,
        var attempts: Int,
        var nextAttemptAtEpochMs: Long?,
        var suspended: Boolean
    )

    private val txKey = txKey.copyOf()
    private val rxKey = rxKey.copyOf()
    private val txNoncePrefix = txNoncePrefix.copyOf()
    private val rxNoncePrefix = rxNoncePrefix.copyOf()
    private val peerTrustId = validateReliablePeerTrustIdV1(peerTrustId)
    private val reassembler = ReliableFrameReassemblerV1()
    private val pending = linkedMapOf<String, PendingMessage>()
    private var closed = false
    private var lastNowEpochMs = 0L
    private var framesTx = 0L
    private var framesRx = 0L
    private var messagesTx = 0L
    private var messagesRx = 0L
    private var acknowledgementsTx = 0L
    private var acknowledgementsRx = 0L
    private var retries = 0L
    private var duplicates = 0L
    private var expired = 0L
    private var deliveryFailures = 0L

    init {
        if (mtu !in ReliableFrameCodecV1.MINIMUM_GATT_MTU..ReliableFrameCodecV1.MAXIMUM_GATT_MTU) {
            wipeKeys()
            reliableChannelFailure(
                "INVALID_CHANNEL_CONFIG",
                "mtu is outside its canonical range"
            )
        }
        validateChannelInteger(maxAttempts.toLong(), 1, 20, "maxAttempts")
        validateChannelInteger(baseRetryMs, 10, 60_000, "baseRetryMs")
        validateChannelInteger(maxRetryMs, baseRetryMs, 300_000, "maxRetryMs")
        if (
            this.txKey.size != ReliableFrameCodecV1.KEY_BYTES ||
            this.rxKey.size != ReliableFrameCodecV1.KEY_BYTES ||
            this.txNoncePrefix.size != ReliableFrameCodecV1.NONCE_PREFIX_BYTES ||
            this.rxNoncePrefix.size != ReliableFrameCodecV1.NONCE_PREFIX_BYTES
        ) {
            wipeKeys()
            reliableChannelFailure(
                "INVALID_KEY_MATERIAL",
                "channel keys or nonce prefixes are invalid"
            )
        }
    }

    @Synchronized
    fun send(input: ReliableChannelSendInputV1): ReliableChannelSendResultV1 {
        assertOpen()
        if (input.type == ReliableFrameTypeV1.ACK) {
            reliableChannelFailure(
                "ACK_RESERVED",
                "ACK messages are created only by the channel"
            )
        }
        val current = checkedNow()
        validateChannelInteger(
            input.ttlMs,
            RELIABLE_CHANNEL_MINIMUM_TTL_MS,
            RELIABLE_CHANNEL_MAXIMUM_TTL_MS,
            "ttlMs"
        )
        if (current > ReliableFrameCodecV1.MAXIMUM_SAFE_CLOCK - input.ttlMs) {
            reliableChannelFailure(
                "INVALID_CHANNEL_CONFIG",
                "message expiry exceeds the safe clock range"
            )
        }
        val messageId = validateChannelMessageId(
            input.messageId ?: messageIdGenerator()
        )
        if (pending.containsKey(messageId)) {
            reliableChannelFailure(
                "OUTBOX_CONFLICT",
                "messageId already exists in the pending channel"
            )
        }
        val flags = if (input.durable) ReliableFrameFlagsV1.DURABLE else 0
        val record = ReliableOutboxRecordV1(
            peerTrustId,
            messageId,
            input.type,
            flags,
            input.payload,
            current,
            current + input.ttlMs
        )
        return try {
            if (input.durable) store.enqueueOutbox(record)
            val prepared = prepare(record)
            pending[messageId] = prepared
            try {
                transmit(prepared, current, retry = false)
            } catch (error: Throwable) {
                if (!input.durable && prepared.attempts >= maxAttempts) {
                    discardPending(messageId)
                }
                throw error
            }
            ReliableChannelSendResultV1(messageId, input.durable)
        } finally {
            record.payload.fill(0)
        }
    }

    @Synchronized
    fun restoreDurableOutbox(): Int {
        assertOpen()
        val current = checkedNow()
        var restored = 0
        store.listOutbox(peerTrustId, current).forEach { record ->
            try {
                if (record.peerTrustId != peerTrustId) {
                    reliableChannelFailure(
                        "PEER_TRUST_MISMATCH",
                        "durable record is bound to another peer trust context"
                    )
                }
                if (pending.containsKey(record.messageId)) return@forEach
                val prepared = prepare(record)
                pending[record.messageId] = prepared
                transmit(prepared, current, retry = false)
                restored += 1
            } finally {
                record.payload.fill(0)
            }
        }
        return restored
    }

    @Synchronized
    fun receiveFragment(frame: ByteArray): ReliableChannelReceiveResultV1 {
        assertOpen()
        val current = checkedNow()
        framesRx += 1
        val fragments = reassembler.accept(frame, current)
            ?: return ReliableChannelReceiveResultV1(
                complete = false,
                delivered = false,
                duplicate = false
            )
        val message = try {
            ReliableFrameCodecV1.decode(
                ReliableFrameDecodeInputV1(
                    fragments,
                    rxKey,
                    rxNoncePrefix,
                    current
                )
            )
        } catch (error: ReliableFrameException) {
            if (error.code == "MESSAGE_EXPIRED") expired += 1
            throw error
        } finally {
            fragments.forEach { it.fill(0) }
        }
        try {
            if (message.type == ReliableFrameTypeV1.ACK) {
                acceptAcknowledgement(message)
                return ReliableChannelReceiveResultV1(
                    complete = true,
                    delivered = false,
                    duplicate = false
                )
            }
            if (store.hasInbox(peerTrustId, message.messageId, current)) {
                duplicates += 1
                sendAcknowledgement(message.messageId, message.expiresAtEpochMs)
                return ReliableChannelReceiveResultV1(
                    complete = true,
                    delivered = false,
                    duplicate = true
                )
            }
            store.rememberInbox(peerTrustId, message.messageId, message.expiresAtEpochMs)
            try {
                onMessage.onMessage(message)
            } catch (error: Throwable) {
                store.forgetInbox(peerTrustId, message.messageId)
                deliveryFailures += 1
                reliableChannelFailure(
                    "DELIVERY_FAILED",
                    "upper-layer delivery rejected the message",
                    error
                )
            }
            messagesRx += 1
            sendAcknowledgement(message.messageId, message.expiresAtEpochMs)
            return ReliableChannelReceiveResultV1(
                complete = true,
                delivered = true,
                duplicate = false
            )
        } finally {
            message.payload.fill(0)
        }
    }

    @Synchronized
    fun tick(): ReliableChannelTickResultV1 {
        assertOpen()
        val current = checkedNow()
        val pruned = store.prune(current)
        expired += pruned.expiredOutbox + pruned.expiredInbox
        reassembler.prune(current)
        var retried = 0
        var suspended = 0
        var expiredNow = 0
        pending.entries.toList().forEach { (messageId, value) ->
            if (value.record.expiresAtEpochMs <= current) {
                if (value.record.flags and ReliableFrameFlagsV1.DURABLE != 0) {
                    store.completeOutbox(peerTrustId, messageId)
                }
                discardPending(messageId)
                expired += 1
                expiredNow += 1
                return@forEach
            }
            val retryAt = value.nextAttemptAtEpochMs
            if (value.suspended || retryAt == null || retryAt > current) return@forEach
            if (value.attempts >= maxAttempts) {
                value.suspended = true
                value.nextAttemptAtEpochMs = null
                deliveryFailures += 1
                suspended += 1
                if (value.record.flags and ReliableFrameFlagsV1.DURABLE == 0) {
                    discardPending(messageId)
                }
                return@forEach
            }
            transmit(value, current, retry = true)
            retried += 1
        }
        return ReliableChannelTickResultV1(retried, suspended, expiredNow)
    }

    @Synchronized
    fun resumeSuspended(): Int {
        assertOpen()
        val current = checkedNow()
        var resumed = 0
        pending.values.forEach { value ->
            if (!value.suspended) return@forEach
            value.suspended = false
            value.attempts = 0
            value.nextAttemptAtEpochMs = current
            resumed += 1
        }
        return resumed
    }

    @Synchronized
    fun snapshot(): ReliableChannelMetricsV1 {
        val storeSnapshot = store.snapshot()
        val reassembly = reassembler.snapshot()
        return ReliableChannelMetricsV1(
            framesTx,
            framesRx,
            messagesTx,
            messagesRx,
            acknowledgementsTx,
            acknowledgementsRx,
            retries,
            duplicates,
            expired,
            deliveryFailures,
            pending.size,
            pending.values.count { it.suspended },
            storeSnapshot.outboxDepth,
            storeSnapshot.inboxDedupDepth,
            reassembly.openMessages,
            reassembly.bufferedBytes
        )
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        reassembler.clear()
        pending.keys.toList().forEach(::discardPending)
        wipeKeys()
    }

    private fun prepare(record: ReliableOutboxRecordV1): PendingMessage {
        val sequence = store.reserveOutboundSequence()
        val frames = ReliableFrameCodecV1.encode(
            ReliableFrameEncodeInputV1(
                record.type,
                record.flags,
                sequence,
                record.messageId,
                record.expiresAtEpochMs,
                record.payload,
                mtu,
                txKey,
                txNoncePrefix
            )
        )
        return PendingMessage(
            record.copyRecord(),
            sequence,
            frames,
            attempts = 0,
            nextAttemptAtEpochMs = record.createdAtEpochMs,
            suspended = false
        )
    }

    private fun transmit(value: PendingMessage, current: Long, retry: Boolean) {
        value.attempts += 1
        if (retry) retries += 1
        try {
            value.frames.forEach { frame ->
                transport.send(frame.copyOf())
                framesTx += 1
            }
            if (!retry) messagesTx += 1
        } finally {
            value.nextAttemptAtEpochMs = current + retryDelay(value.attempts)
        }
    }

    private fun sendAcknowledgement(
        acknowledgedMessageId: String,
        remoteExpiry: Long
    ) {
        val current = checkedNow()
        if (current > ReliableFrameCodecV1.MAXIMUM_SAFE_CLOCK - 1_000) {
            reliableChannelFailure(
                "INVALID_CHANNEL_CONFIG",
                "ACK expiry exceeds the safe clock range"
            )
        }
        val ackId = validateChannelMessageId(messageIdGenerator())
        val ackPayload = ReliableFrameCodecV1.messageIdBytes(acknowledgedMessageId)
        val frames = try {
            ReliableFrameCodecV1.encode(
                ReliableFrameEncodeInputV1(
                    type = ReliableFrameTypeV1.ACK,
                    sequence = store.reserveOutboundSequence(),
                    messageId = ackId,
                    expiresAtEpochMs = maxOf(current + 1_000, remoteExpiry),
                    payload = ackPayload,
                    mtu = mtu,
                    key = txKey,
                    noncePrefix = txNoncePrefix
                )
            )
        } finally {
            ackPayload.fill(0)
        }
        try {
            frames.forEach { frame ->
                transport.send(frame.copyOf())
                framesTx += 1
            }
            acknowledgementsTx += 1
        } finally {
            frames.forEach { it.fill(0) }
        }
    }

    private fun acceptAcknowledgement(message: ReliableMessageV1) {
        if (message.payload.size != ReliableFrameCodecV1.MESSAGE_ID_BYTES) {
            reliableChannelFailure(
                "INVALID_ACK",
                "ACK payload must contain exactly one messageId"
            )
        }
        val acknowledgedMessageId = message.payload.toLowerHex()
        val value = pending[acknowledgedMessageId]
        if (value == null) {
            duplicates += 1
            return
        }
        if (value.record.flags and ReliableFrameFlagsV1.DURABLE != 0) {
            store.completeOutbox(peerTrustId, acknowledgedMessageId)
        }
        discardPending(acknowledgedMessageId)
        acknowledgementsRx += 1
    }

    private fun retryDelay(attempts: Int): Long {
        val exponential = min(
            maxRetryMs.toDouble(),
            baseRetryMs.toDouble() * 2.0.pow(maxOf(0, attempts - 1))
        ).toLong()
        val randomValue = random()
        if (!randomValue.isFinite() || randomValue < 0.0 || randomValue >= 1.0) {
            reliableChannelFailure(
                "INVALID_RANDOM_SOURCE",
                "retry random source must return [0,1)"
            )
        }
        return exponential + floor(exponential * 0.25 * randomValue).toLong()
    }

    private fun discardPending(messageId: String) {
        val value = pending.remove(messageId) ?: return
        value.record.payload.fill(0)
        value.frames.forEach { it.fill(0) }
    }

    private fun checkedNow(): Long {
        val current = now()
        validateChannelInteger(
            current,
            0,
            ReliableFrameCodecV1.MAXIMUM_SAFE_CLOCK,
            "clock"
        )
        if (current < lastNowEpochMs) {
            reliableChannelFailure(
                "CLOCK_REGRESSION",
                "channel clock moved backwards"
            )
        }
        lastNowEpochMs = current
        return current
    }

    private fun assertOpen() {
        if (closed) {
            reliableChannelFailure(
                "CHANNEL_CLOSED",
                "reliable channel is closed"
            )
        }
    }

    private fun wipeKeys() {
        txKey.fill(0)
        rxKey.fill(0)
        txNoncePrefix.fill(0)
        rxNoncePrefix.fill(0)
    }
}

private fun validateChannelInteger(
    value: Long,
    minimum: Long,
    maximum: Long,
    field: String
) {
    if (value !in minimum..maximum) {
        reliableChannelFailure(
            "INVALID_CHANNEL_CONFIG",
            "$field is outside its canonical range"
        )
    }
}

private fun validateChannelMessageId(value: String): String {
    if (!Regex("^[0-9a-f]{32}$").matches(value)) {
        reliableChannelFailure(
            "INVALID_MESSAGE_ID",
            "messageId must be canonical lowercase hex"
        )
    }
    return value
}

private fun validateReliablePeerTrustIdV1(value: String): String {
    if (!Regex("^[0-9a-f]{64}$").matches(value)) {
        reliableChannelFailure(
            "INVALID_PEER_TRUST_ID",
            "peerTrustId must be a canonical V1 trust commitment"
        )
    }
    return value
}

private fun randomMessageId(): String {
    val value = ByteArray(ReliableFrameCodecV1.MESSAGE_ID_BYTES)
    return try {
        SecureRandom().nextBytes(value)
        value.toLowerHex()
    } finally {
        value.fill(0)
    }
}

private fun ByteArray.toLowerHex(): String =
    joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
