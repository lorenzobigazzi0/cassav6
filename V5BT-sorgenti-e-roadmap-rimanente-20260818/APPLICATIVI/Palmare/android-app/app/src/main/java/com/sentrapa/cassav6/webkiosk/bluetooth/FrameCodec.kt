package com.sentrapa.cassav6.webkiosk.bluetooth

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

enum class ReliableFrameTypeV1(val wireValue: Int) {
    DATA(1),
    ACK(2),
    CLOSE(3),
    ERROR(4),
    ROUTE_ADVERTISEMENT(5),
    SHADOW_DIAGNOSTIC(6);

    companion object {
        internal fun fromWire(value: Int): ReliableFrameTypeV1 =
            entries.firstOrNull { it.wireValue == value }
                ?: reliableFrameFailure(
                    "INVALID_FRAME_TYPE",
                    "frame type is not assigned in protocol v1"
                )
    }
}

object ReliableFrameFlagsV1 {
    const val DURABLE = 1 shl 0
    internal const val ALL_DEFINED = DURABLE
}

class ReliableMessageV1(
    val type: ReliableFrameTypeV1,
    val flags: Int,
    val sequence: Long,
    val messageId: String,
    val expiresAtEpochMs: Long,
    payload: ByteArray
) {
    val payload: ByteArray = payload.copyOf()
}

class ReliableFragmentV1(
    val type: ReliableFrameTypeV1,
    val flags: Int,
    val sequence: Long,
    val fragmentIndex: Int,
    val fragmentCount: Int,
    payload: ByteArray
) {
    val payload: ByteArray = payload.copyOf()
}

data class ReliableFrameEncodeInputV1(
    val type: ReliableFrameTypeV1,
    val flags: Int = 0,
    val sequence: Long,
    val messageId: String,
    val expiresAtEpochMs: Long,
    val payload: ByteArray,
    val mtu: Int,
    val key: ByteArray,
    val noncePrefix: ByteArray
)

data class ReliableFrameDecodeInputV1(
    val fragments: List<ByteArray>,
    val key: ByteArray,
    val noncePrefix: ByteArray,
    val nowEpochMs: Long
)

class ReliableFrameException(
    val code: String,
    message: String,
    cause: Throwable? = null
) : RuntimeException(message, cause)

class ReliableChannelDirectionMaterialV1 internal constructor(
    key: ByteArray,
    noncePrefix: ByteArray
) : AutoCloseable {
    private var keyValue: ByteArray? = key.copyOf()
    private var noncePrefixValue: ByteArray? = noncePrefix.copyOf()

    val key: ByteArray
        @Synchronized get() = open(keyValue).copyOf()

    val noncePrefix: ByteArray
        @Synchronized get() = open(noncePrefixValue).copyOf()

    val isClosed: Boolean
        @Synchronized get() = keyValue == null

    @Synchronized
    override fun close() {
        keyValue?.fill(0)
        keyValue = null
        noncePrefixValue?.fill(0)
        noncePrefixValue = null
    }

    override fun toString(): String =
        "ReliableChannelDirectionMaterialV1(closed=$isClosed, material=<redacted>)"

    private fun open(value: ByteArray?): ByteArray =
        checkNotNull(value) { "reliable channel material has been cleared" }
}

class ReliableChannelMaterialV1 internal constructor(
    val clientToServer: ReliableChannelDirectionMaterialV1,
    val serverToClient: ReliableChannelDirectionMaterialV1
) : AutoCloseable {
    val isClosed: Boolean
        get() = clientToServer.isClosed && serverToClient.isClosed

    override fun close() {
        clientToServer.close()
        serverToClient.close()
    }

    override fun toString(): String =
        "ReliableChannelMaterialV1(closed=$isClosed, material=<redacted>)"
}

fun deriveReliableChannelDirectionMaterialV1(
    directionControlKey: ByteArray
): ReliableChannelDirectionMaterialV1 {
    if (directionControlKey.size != ReliableFrameCodecV1.KEY_BYTES) {
        reliableFrameFailure(
            "INVALID_KEY_MATERIAL",
            "directionControlKey must be exactly ${ReliableFrameCodecV1.KEY_BYTES} bytes"
        )
    }
    val controlKey = directionControlKey.copyOf()
    val keyContext = DATA_KEY_CONTEXT.toByteArray(Charsets.US_ASCII)
    val nonceContext = DATA_NONCE_CONTEXT.toByteArray(Charsets.US_ASCII)
    var keyDigest: ByteArray? = null
    var nonceDigest: ByteArray? = null
    var noncePrefix: ByteArray? = null
    return try {
        keyDigest = hmacSha256(controlKey, keyContext)
        nonceDigest = hmacSha256(controlKey, nonceContext)
        noncePrefix = nonceDigest.copyOfRange(
            0,
            ReliableFrameCodecV1.NONCE_PREFIX_BYTES
        )
        ReliableChannelDirectionMaterialV1(
            keyDigest,
            noncePrefix
        )
    } finally {
        controlKey.fill(0)
        keyContext.fill(0)
        nonceContext.fill(0)
        keyDigest?.fill(0)
        nonceDigest?.fill(0)
        noncePrefix?.fill(0)
    }
}

fun deriveReliableChannelMaterialV1(
    clientToServerControlKey: ByteArray,
    serverToClientControlKey: ByteArray
): ReliableChannelMaterialV1 {
    val clientToServer =
        deriveReliableChannelDirectionMaterialV1(clientToServerControlKey)
    return try {
        ReliableChannelMaterialV1(
            clientToServer,
            deriveReliableChannelDirectionMaterialV1(serverToClientControlKey)
        )
    } catch (error: Throwable) {
        clientToServer.close()
        throw error
    }
}

private fun reliableFrameFailure(
    code: String,
    message: String,
    cause: Throwable? = null
): Nothing = throw ReliableFrameException(code, message, cause)

private fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray =
    Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        doFinal(message)
    }

private const val DATA_KEY_CONTEXT = "CASSA_V6-BT-DATA-KEY-V1\u0000"
private const val DATA_NONCE_CONTEXT = "CASSA_V6-BT-DATA-NONCE-V1\u0000"

object ReliableFrameCodecV1 {
    const val VERSION = 1
    const val HEADER_BYTES = 14
    const val AUTH_TAG_BYTES = 16
    const val MESSAGE_ID_BYTES = 16
    const val NONCE_PREFIX_BYTES = 8
    const val KEY_BYTES = 32
    const val MAX_FRAGMENTS = 4_096
    const val MAX_PAYLOAD_BYTES = 16_384
    const val MINIMUM_GATT_MTU = 23
    const val MAXIMUM_GATT_MTU = 517
    const val MAXIMUM_SAFE_CLOCK = 9_007_199_254_740_991L

    private const val ATT_HEADER_BYTES = 3
    private const val MAGIC_0 = 0xc5
    private const val MAGIC_1 = 0xb7
    private const val ENVELOPE_HEADER_BYTES = MESSAGE_ID_BYTES + 8 + 4

    fun encode(input: ReliableFrameEncodeInputV1): List<ByteArray> {
        validateFlags(input.flags)
        validateSequence(input.sequence)
        val fragmentBudget = framePayloadBudget(input.mtu)
        val envelope = encodeEnvelope(
            input.messageId,
            input.expiresAtEpochMs,
            input.payload
        )
        val encryptedBytes = envelope.size + AUTH_TAG_BYTES
        val fragmentCount = (encryptedBytes + fragmentBudget - 1) / fragmentBudget
        if (fragmentCount > MAX_FRAGMENTS) {
            envelope.fill(0)
            reliableFrameFailure(
                "TOO_MANY_FRAGMENTS",
                "message exceeds the fragment count limit"
            )
        }

        val key = exactBytes(input.key, KEY_BYTES, "key")
        val nonce = buildNonce(input.noncePrefix, input.sequence)
        val aad = buildAuthenticatedHeader(
            input.type,
            input.flags,
            input.sequence,
            fragmentCount
        )
        val encrypted = try {
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(
                    Cipher.ENCRYPT_MODE,
                    SecretKeySpec(key, "AES"),
                    GCMParameterSpec(AUTH_TAG_BYTES * 8, nonce)
                )
                updateAAD(aad)
                doFinal(envelope)
            }
        } catch (error: Exception) {
            reliableFrameFailure(
                "ENCRYPTION_FAILED",
                "reliable frame encryption failed",
                error
            )
        } finally {
            envelope.fill(0)
            key.fill(0)
            nonce.fill(0)
            aad.fill(0)
        }

        return try {
            List(fragmentCount) { index ->
                val start = index * fragmentBudget
                val end = minOf(start + fragmentBudget, encrypted.size)
                val header = buildHeader(
                    input.type,
                    input.flags,
                    input.sequence,
                    index,
                    fragmentCount
                )
                ByteArray(header.size + end - start).also { wire ->
                    header.copyInto(wire)
                    encrypted.copyInto(wire, header.size, start, end)
                    header.fill(0)
                }
            }
        } finally {
            encrypted.fill(0)
        }
    }

    fun decodeFragment(wire: ByteArray): ReliableFragmentV1 {
        if (wire.size <= HEADER_BYTES) {
            reliableFrameFailure(
                "INVALID_FRAME_LENGTH",
                "frame must contain a header and payload"
            )
        }
        if (
            wire[0].toInt() and 0xff != MAGIC_0 ||
            wire[1].toInt() and 0xff != MAGIC_1
        ) {
            reliableFrameFailure(
                "INVALID_FRAME_MAGIC",
                "frame magic does not match protocol v1"
            )
        }
        if (wire[2].toInt() and 0xff != VERSION) {
            reliableFrameFailure(
                "INVALID_FRAME_VERSION",
                "frame version is unsupported"
            )
        }
        val type = ReliableFrameTypeV1.fromWire(wire[3].toInt() and 0xff)
        val flags = wire[4].toInt() and 0xff
        validateFlags(flags)
        if (wire[5].toInt() and 0xff != 0) {
            reliableFrameFailure(
                "INVALID_FRAME_RESERVED",
                "reserved frame header byte must be zero"
            )
        }
        val buffer = ByteBuffer.wrap(wire).order(ByteOrder.BIG_ENDIAN)
        val sequence = buffer.getInt(6).toLong() and 0xffff_ffffL
        val fragmentIndex = buffer.getShort(10).toInt() and 0xffff
        val fragmentCount = buffer.getShort(12).toInt() and 0xffff
        validateSequence(sequence)
        validateFragmentCount(fragmentCount)
        if (fragmentIndex !in 0 until fragmentCount) {
            reliableFrameFailure(
                "INVALID_FRAME_FIELD",
                "fragmentIndex is outside its canonical range"
            )
        }
        return ReliableFragmentV1(
            type,
            flags,
            sequence,
            fragmentIndex,
            fragmentCount,
            wire.copyOfRange(HEADER_BYTES, wire.size)
        )
    }

    fun decode(input: ReliableFrameDecodeInputV1): ReliableMessageV1 {
        if (input.fragments.isEmpty()) {
            reliableFrameFailure(
                "MISSING_FRAGMENTS",
                "at least one fragment is required"
            )
        }
        validateClock(input.nowEpochMs, allowZero = true)
        val decoded = input.fragments.map(::decodeFragment)
        try {
            val first = decoded.first()
            if (
                decoded.size != first.fragmentCount ||
                decoded.any {
                    it.type != first.type ||
                        it.flags != first.flags ||
                        it.sequence != first.sequence ||
                        it.fragmentCount != first.fragmentCount
                }
            ) {
                reliableFrameFailure(
                    "FRAGMENT_SET_MISMATCH",
                    "fragment set is incomplete or inconsistent"
                )
            }
            val ordered = decoded.sortedBy { it.fragmentIndex }
            ordered.forEachIndexed { index, fragment ->
                if (fragment.fragmentIndex != index) {
                    reliableFrameFailure(
                        "FRAGMENT_SET_MISMATCH",
                        "fragment index is missing or duplicated"
                    )
                }
            }
            val encryptedSize = ordered.sumOf { it.payload.size }
            if (encryptedSize <= AUTH_TAG_BYTES) {
                reliableFrameFailure(
                    "INVALID_CIPHERTEXT_LENGTH",
                    "ciphertext is too short"
                )
            }
            val encrypted = ByteArray(encryptedSize)
            var offset = 0
            ordered.forEach { fragment ->
                fragment.payload.copyInto(encrypted, offset)
                offset += fragment.payload.size
            }
            val key = exactBytes(input.key, KEY_BYTES, "key")
            val nonce = buildNonce(input.noncePrefix, first.sequence)
            val aad = buildAuthenticatedHeader(
                first.type,
                first.flags,
                first.sequence,
                first.fragmentCount
            )
            val plaintext = try {
                Cipher.getInstance("AES/GCM/NoPadding").run {
                    init(
                        Cipher.DECRYPT_MODE,
                        SecretKeySpec(key, "AES"),
                        GCMParameterSpec(AUTH_TAG_BYTES * 8, nonce)
                    )
                    updateAAD(aad)
                    doFinal(encrypted)
                }
            } catch (error: Exception) {
                reliableFrameFailure(
                    "AUTHENTICATION_FAILED",
                    "reliable frame authentication failed",
                    error
                )
            } finally {
                encrypted.fill(0)
                key.fill(0)
                nonce.fill(0)
                aad.fill(0)
            }
            return try {
                decodeEnvelope(first, plaintext, input.nowEpochMs)
            } finally {
                plaintext.fill(0)
            }
        } finally {
            decoded.forEach { it.payload.fill(0) }
        }
    }

    internal fun buildHeader(
        type: ReliableFrameTypeV1,
        flags: Int,
        sequence: Long,
        fragmentIndex: Int,
        fragmentCount: Int
    ): ByteArray {
        validateFlags(flags)
        validateSequence(sequence)
        validateFragmentCount(fragmentCount)
        if (fragmentIndex !in 0 until fragmentCount) {
            reliableFrameFailure(
                "INVALID_FRAME_FIELD",
                "fragmentIndex is outside its canonical range"
            )
        }
        return ByteArray(HEADER_BYTES).also { header ->
            header[0] = MAGIC_0.toByte()
            header[1] = MAGIC_1.toByte()
            header[2] = VERSION.toByte()
            header[3] = type.wireValue.toByte()
            header[4] = flags.toByte()
            header[5] = 0
            ByteBuffer.wrap(header).order(ByteOrder.BIG_ENDIAN).apply {
                putInt(6, sequence.toInt())
                putShort(10, fragmentIndex.toShort())
                putShort(12, fragmentCount.toShort())
            }
        }
    }

    internal fun validateMessageId(value: String): String {
        if (!MESSAGE_ID_PATTERN.matches(value)) {
            reliableFrameFailure(
                "INVALID_MESSAGE_ID",
                "messageId must be 128 bits encoded as lowercase hexadecimal"
            )
        }
        return value
    }

    internal fun messageIdBytes(value: String): ByteArray =
        validateMessageId(value).chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    internal fun ByteArray.toMessageId(): String =
        joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }

    internal fun validateClock(value: Long, allowZero: Boolean = false) {
        val minimum = if (allowZero) 0L else 1L
        if (value !in minimum..MAXIMUM_SAFE_CLOCK) {
            reliableFrameFailure(
                "INVALID_FRAME_FIELD",
                "clock is outside its canonical range"
            )
        }
    }

    private fun buildAuthenticatedHeader(
        type: ReliableFrameTypeV1,
        flags: Int,
        sequence: Long,
        fragmentCount: Int
    ): ByteArray = buildHeader(type, flags, sequence, 0, fragmentCount)

    private fun buildNonce(prefix: ByteArray, sequence: Long): ByteArray {
        val prefixCopy = exactBytes(prefix, NONCE_PREFIX_BYTES, "noncePrefix")
        return ByteArray(12).also { nonce ->
            try {
                prefixCopy.copyInto(nonce)
                ByteBuffer.wrap(nonce).order(ByteOrder.BIG_ENDIAN)
                    .putInt(NONCE_PREFIX_BYTES, sequence.toInt())
            } finally {
                prefixCopy.fill(0)
            }
        }
    }

    private fun encodeEnvelope(
        messageId: String,
        expiresAtEpochMs: Long,
        payload: ByteArray
    ): ByteArray {
        val id = messageIdBytes(messageId)
        validateClock(expiresAtEpochMs)
        if (payload.size > MAX_PAYLOAD_BYTES) {
            id.fill(0)
            reliableFrameFailure(
                "PAYLOAD_TOO_LARGE",
                "payload exceeds the protocol v1 limit"
            )
        }
        return ByteArray(ENVELOPE_HEADER_BYTES + payload.size).also { envelope ->
            try {
                id.copyInto(envelope)
                ByteBuffer.wrap(envelope).order(ByteOrder.BIG_ENDIAN).apply {
                    putLong(MESSAGE_ID_BYTES, expiresAtEpochMs)
                    putInt(MESSAGE_ID_BYTES + 8, payload.size)
                }
                payload.copyInto(envelope, ENVELOPE_HEADER_BYTES)
            } finally {
                id.fill(0)
            }
        }
    }

    private fun decodeEnvelope(
        first: ReliableFragmentV1,
        plaintext: ByteArray,
        nowEpochMs: Long
    ): ReliableMessageV1 {
        if (plaintext.size < ENVELOPE_HEADER_BYTES) {
            reliableFrameFailure(
                "INVALID_ENVELOPE_LENGTH",
                "decrypted envelope is truncated"
            )
        }
        val buffer = ByteBuffer.wrap(plaintext).order(ByteOrder.BIG_ENDIAN)
        val expiresAtEpochMs = buffer.getLong(MESSAGE_ID_BYTES)
        if (expiresAtEpochMs !in 1..MAXIMUM_SAFE_CLOCK) {
            reliableFrameFailure(
                "INVALID_EXPIRY",
                "message expiry exceeds the safe clock range"
            )
        }
        val payloadLength =
            buffer.getInt(MESSAGE_ID_BYTES + 8).toLong() and 0xffff_ffffL
        if (
            payloadLength > MAX_PAYLOAD_BYTES ||
            plaintext.size.toLong() != ENVELOPE_HEADER_BYTES + payloadLength
        ) {
            reliableFrameFailure(
                "INVALID_ENVELOPE_LENGTH",
                "payload length is not canonical"
            )
        }
        if (expiresAtEpochMs <= nowEpochMs) {
            reliableFrameFailure(
                "MESSAGE_EXPIRED",
                "message TTL elapsed before delivery"
            )
        }
        val messageIdBytes = plaintext.copyOfRange(0, MESSAGE_ID_BYTES)
        val payload = plaintext.copyOfRange(ENVELOPE_HEADER_BYTES, plaintext.size)
        return try {
            ReliableMessageV1(
                first.type,
                first.flags,
                first.sequence,
                messageIdBytes.toMessageId(),
                expiresAtEpochMs,
                payload
            )
        } finally {
            messageIdBytes.fill(0)
            payload.fill(0)
        }
    }

    private fun framePayloadBudget(mtu: Int): Int {
        if (mtu !in MINIMUM_GATT_MTU..MAXIMUM_GATT_MTU) {
            reliableFrameFailure(
                "INVALID_FRAME_FIELD",
                "mtu is outside its canonical range"
            )
        }
        val budget = mtu - ATT_HEADER_BYTES - HEADER_BYTES
        if (budget < 1) {
            reliableFrameFailure(
                "MTU_TOO_SMALL",
                "negotiated MTU cannot carry a protocol fragment"
            )
        }
        return budget
    }

    private fun validateSequence(value: Long) {
        if (value !in 1..0xffff_ffffL) {
            reliableFrameFailure(
                "INVALID_FRAME_FIELD",
                "sequence is outside its canonical range"
            )
        }
    }

    private fun validateFragmentCount(value: Int) {
        if (value !in 1..MAX_FRAGMENTS) {
            reliableFrameFailure(
                "INVALID_FRAME_FIELD",
                "fragmentCount is outside its canonical range"
            )
        }
    }

    private fun validateFlags(value: Int) {
        if (value !in 0..0xff) {
            reliableFrameFailure(
                "INVALID_FRAME_FIELD",
                "flags is outside its canonical range"
            )
        }
        if (value and ReliableFrameFlagsV1.ALL_DEFINED.inv() != 0) {
            reliableFrameFailure(
                "INVALID_FRAME_FLAGS",
                "frame contains reserved flags"
            )
        }
    }

    private fun exactBytes(value: ByteArray, expected: Int, field: String): ByteArray {
        if (value.size != expected) {
            reliableFrameFailure(
                "INVALID_KEY_MATERIAL",
                "$field must be exactly $expected bytes"
            )
        }
        return value.copyOf()
    }

    private val MESSAGE_ID_PATTERN = Regex("^[0-9a-f]{32}$")
}

data class ReliableFrameReassemblySnapshotV1(
    val openMessages: Int,
    val bufferedBytes: Int
)

class ReliableFrameReassemblerV1(
    private val maximumOpenMessages: Int = 32,
    private val maximumBufferedBytes: Int = 256 * 1024
) {
    private data class FragmentSet(
        val type: ReliableFrameTypeV1,
        val flags: Int,
        val sequence: Long,
        val fragmentCount: Int,
        val createdAtEpochMs: Long,
        var totalBytes: Int = 0,
        val fragments: MutableMap<Int, ByteArray> = mutableMapOf()
    )

    private val sets = mutableMapOf<String, FragmentSet>()
    private var bufferedBytes = 0

    init {
        if (maximumOpenMessages !in 1..256) {
            reliableFrameFailure(
                "INVALID_FRAME_FIELD",
                "maximumOpenMessages is outside its canonical range"
            )
        }
        if (maximumBufferedBytes !in 1_024..4 * 1024 * 1024) {
            reliableFrameFailure(
                "INVALID_FRAME_FIELD",
                "maximumBufferedBytes is outside its canonical range"
            )
        }
    }

    @Synchronized
    fun accept(wire: ByteArray, nowEpochMs: Long): List<ByteArray>? {
        ReliableFrameCodecV1.validateClock(nowEpochMs, allowZero = true)
        val fragment = ReliableFrameCodecV1.decodeFragment(wire)
        try {
            val key = "${fragment.type.wireValue}:${fragment.sequence}"
            var set = sets[key]
            if (set == null) {
                if (sets.size >= maximumOpenMessages) {
                    reliableFrameFailure(
                        "REASSEMBLY_CAPACITY_REACHED",
                        "too many incomplete messages"
                    )
                }
                set = FragmentSet(
                    fragment.type,
                    fragment.flags,
                    fragment.sequence,
                    fragment.fragmentCount,
                    nowEpochMs
                )
                sets[key] = set
            }
            if (
                set.flags != fragment.flags ||
                set.fragmentCount != fragment.fragmentCount
            ) {
                drop(key, set)
                reliableFrameFailure(
                    "FRAGMENT_SET_MISMATCH",
                    "fragment conflicts with buffered metadata"
                )
            }
            val existing = set.fragments[fragment.fragmentIndex]
            if (existing != null) {
                if (!MessageDigest.isEqual(existing, fragment.payload)) {
                    drop(key, set)
                    reliableFrameFailure(
                        "FRAGMENT_CONFLICT",
                        "duplicate fragment contains different bytes"
                    )
                }
                return null
            }
            if (bufferedBytes + fragment.payload.size > maximumBufferedBytes) {
                drop(key, set)
                reliableFrameFailure(
                    "REASSEMBLY_BYTE_LIMIT",
                    "incomplete messages exceed byte budget"
                )
            }
            val copy = fragment.payload.copyOf()
            set.fragments[fragment.fragmentIndex] = copy
            set.totalBytes += copy.size
            bufferedBytes += copy.size
            if (set.fragments.size != set.fragmentCount) return null

            val result = List(set.fragmentCount) { index ->
                val payload = set.fragments[index]
                    ?: run {
                        drop(key, set)
                        reliableFrameFailure(
                            "FRAGMENT_SET_MISMATCH",
                            "completed set has a missing fragment"
                        )
                    }
                val header = ReliableFrameCodecV1.buildHeader(
                    set.type,
                    set.flags,
                    set.sequence,
                    index,
                    set.fragmentCount
                )
                ByteArray(header.size + payload.size).also { output ->
                    header.copyInto(output)
                    payload.copyInto(output, header.size)
                    header.fill(0)
                }
            }
            drop(key, set)
            return result
        } finally {
            fragment.payload.fill(0)
        }
    }

    @Synchronized
    fun prune(nowEpochMs: Long, maximumAgeMs: Long = 30_000): Int {
        ReliableFrameCodecV1.validateClock(nowEpochMs, allowZero = true)
        if (maximumAgeMs !in 1..300_000) {
            reliableFrameFailure(
                "INVALID_FRAME_FIELD",
                "maximumAgeMs is outside its canonical range"
            )
        }
        var removed = 0
        sets.entries.toList().forEach { (key, set) ->
            if (nowEpochMs - set.createdAtEpochMs >= maximumAgeMs) {
                drop(key, set)
                removed += 1
            }
        }
        return removed
    }

    @Synchronized
    fun clear() {
        sets.entries.toList().forEach { (key, set) -> drop(key, set) }
    }

    @Synchronized
    fun snapshot(): ReliableFrameReassemblySnapshotV1 =
        ReliableFrameReassemblySnapshotV1(sets.size, bufferedBytes)

    private fun drop(key: String, set: FragmentSet) {
        sets.remove(key)
        bufferedBytes -= set.totalBytes
        set.fragments.values.forEach { it.fill(0) }
        set.fragments.clear()
    }
}
