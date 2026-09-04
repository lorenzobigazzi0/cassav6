package com.sentrapa.cassav6.webkiosk.bluetooth

import java.nio.ByteBuffer
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.UUID
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

enum class BluetoothDirectControlMessageTypeV1(val wireValue: Int) {
    CLIENT_KEY_SHARE(4),
    SERVER_KEY_SHARE(5),
    CLIENT_KEY_CONFIRM(6),
    PING(7),
    PONG(8),
    CLOSE(9),
    CLOSE_ACK(10)
}

enum class BluetoothDirectControlCloseReasonV1(val wireValue: Int) {
    NORMAL(1),
    HEARTBEAT_TIMEOUT(2),
    SERVICE_STOP(3),
    PROTOCOL_ERROR(4);

    companion object {
        internal fun fromWire(value: Int): BluetoothDirectControlCloseReasonV1 =
            entries.firstOrNull { it.wireValue == value }
                ?: throw IllegalArgumentException("undefined close reason")
    }
}

class BluetoothDirectControlClientKeyShareV1 internal constructor(
    val protocolVersion: Int,
    val sessionId: String,
    publicKeySpki: ByteArray,
    clientBinder: ByteArray
) {
    private val publicKeySpkiValue = publicKeySpki.copyOf()
    private val clientBinderValue = clientBinder.copyOf()

    val messageType: BluetoothDirectControlMessageTypeV1
        get() = BluetoothDirectControlMessageTypeV1.CLIENT_KEY_SHARE
    val publicKeySpki: ByteArray
        get() = publicKeySpkiValue.copyOf()
    val clientBinder: ByteArray
        get() = clientBinderValue.copyOf()

    override fun toString(): String =
        "BluetoothDirectControlClientKeyShareV1(protocolVersion=$protocolVersion, " +
            "sessionId=<redacted>, publicKeySpki=<redacted>, clientBinder=<redacted>)"
}

class BluetoothDirectControlServerKeyShareV1 internal constructor(
    val protocolVersion: Int,
    val sessionId: String,
    publicKeySpki: ByteArray,
    confirmation: ByteArray
) {
    private val publicKeySpkiValue = publicKeySpki.copyOf()
    private val confirmationValue = confirmation.copyOf()

    val messageType: BluetoothDirectControlMessageTypeV1
        get() = BluetoothDirectControlMessageTypeV1.SERVER_KEY_SHARE
    val publicKeySpki: ByteArray
        get() = publicKeySpkiValue.copyOf()
    val confirmation: ByteArray
        get() = confirmationValue.copyOf()

    override fun toString(): String =
        "BluetoothDirectControlServerKeyShareV1(protocolVersion=$protocolVersion, " +
            "sessionId=<redacted>, publicKeySpki=<redacted>, confirmation=<redacted>)"
}

class BluetoothDirectControlClientKeyConfirmV1 internal constructor(
    val protocolVersion: Int,
    val sessionId: String,
    confirmation: ByteArray
) {
    private val confirmationValue = confirmation.copyOf()

    val messageType: BluetoothDirectControlMessageTypeV1
        get() = BluetoothDirectControlMessageTypeV1.CLIENT_KEY_CONFIRM
    val confirmation: ByteArray
        get() = confirmationValue.copyOf()

    override fun toString(): String =
        "BluetoothDirectControlClientKeyConfirmV1(protocolVersion=$protocolVersion, " +
            "sessionId=<redacted>, confirmation=<redacted>)"
}

data class BluetoothDirectControlHeartbeatV1(
    val protocolVersion: Int,
    val messageType: BluetoothDirectControlMessageTypeV1,
    val sessionId: String,
    val sequence: Long
) {
    override fun toString(): String =
        "BluetoothDirectControlHeartbeatV1(protocolVersion=$protocolVersion, " +
            "messageType=$messageType, sessionId=<redacted>, sequence=$sequence)"
}

data class BluetoothDirectControlCloseV1(
    val protocolVersion: Int,
    val messageType: BluetoothDirectControlMessageTypeV1,
    val sessionId: String,
    val sequence: Long,
    val reason: BluetoothDirectControlCloseReasonV1
) {
    override fun toString(): String =
        "BluetoothDirectControlCloseV1(protocolVersion=$protocolVersion, " +
            "messageType=$messageType, sessionId=<redacted>, sequence=$sequence, " +
            "reason=$reason)"
}

object BluetoothDirectControlCodecV1 {
    const val PROTOCOL_VERSION = 1
    const val SESSION_ID_BYTES = 16
    const val X25519_SPKI_BYTES = 44
    const val AUTH_BYTES = 32
    const val HEADER_BYTES = 18
    const val CLIENT_KEY_SHARE_WIRE_BYTES = 94
    const val SERVER_KEY_SHARE_WIRE_BYTES = 94
    const val CLIENT_KEY_CONFIRM_WIRE_BYTES = 50
    const val HEARTBEAT_WIRE_BYTES = 54
    const val CLOSE_WIRE_BYTES = 55
    const val MINIMUM_MTU = BluetoothMutualAuthCodecV1.MINIMUM_MTU
    const val MAX_SEQUENCE = 0xffff_ffffL

    const val CLIENT_KEY_SHARE_CONTEXT =
        "CASSA_V6-BT-KEY-CLIENT-SHARE-V1\u0000"
    const val SESSION_KEY_BINDER_CONTEXT =
        "CASSA_V6-BT-KEY-SALT-V1\u0000"
    const val SESSION_TRANSCRIPT_CONTEXT =
        "CASSA_V6-BT-KEY-TRANSCRIPT-V1\u0000"
    const val HKDF_INFO_CONTEXT = "CASSA_V6-BT-KEYS-V1\u0000"
    const val SERVER_CONFIRMATION_CONTEXT =
        "CASSA_V6-BT-KEY-SERVER-CONFIRM-V1\u0000"
    const val CLIENT_CONFIRMATION_CONTEXT =
        "CASSA_V6-BT-KEY-CLIENT-CONFIRM-V1\u0000"
    const val AUTHENTICATED_CONTROL_CONTEXT =
        "CASSA_V6-BT-CONTROL-V1\u0000"

    private val x25519SpkiPrefix = byteArrayOf(
        0x30,
        0x2a,
        0x30,
        0x05,
        0x06,
        0x03,
        0x2b,
        0x65,
        0x6e,
        0x03,
        0x21,
        0x00
    )

    fun normalizeX25519PublicKeySpki(value: ByteArray): ByteArray {
        require(value.size == X25519_SPKI_BYTES) {
            "publicKeySpki must contain exactly $X25519_SPKI_BYTES bytes"
        }
        require(
            value.copyOfRange(0, x25519SpkiPrefix.size)
                .contentEquals(x25519SpkiPrefix)
        ) {
            "publicKeySpki is not canonical X25519 SPKI"
        }
        return value.copyOf()
    }

    fun buildClientKeyShareBinderMessage(
        binding: BluetoothMutualAuthBindingV1,
        clientPublicKeySpki: ByteArray
    ): ByteArray {
        val bindingBytes = authBindingBytes(binding)
        val clientKey = normalizeX25519PublicKeySpki(clientPublicKeySpki)
        val context = CLIENT_KEY_SHARE_CONTEXT.toByteArray(Charsets.UTF_8)
        return try {
            concatenate(context, bindingBytes, clientKey)
        } finally {
            context.fill(0)
            bindingBytes.fill(0)
            clientKey.fill(0)
        }
    }

    fun buildSessionKeyBinderMessage(
        binding: BluetoothMutualAuthBindingV1,
        clientPublicKeySpki: ByteArray,
        clientBinder: ByteArray,
        serverPublicKeySpki: ByteArray
    ): ByteArray {
        val bindingBytes = authBindingBytes(binding)
        val clientKey = normalizeX25519PublicKeySpki(clientPublicKeySpki)
        val binder = exactCopy(clientBinder, AUTH_BYTES, "clientBinder")
        val serverKey = normalizeX25519PublicKeySpki(serverPublicKeySpki)
        val context = SESSION_KEY_BINDER_CONTEXT.toByteArray(Charsets.UTF_8)
        return try {
            concatenate(context, bindingBytes, clientKey, binder, serverKey)
        } finally {
            context.fill(0)
            bindingBytes.fill(0)
            clientKey.fill(0)
            binder.fill(0)
            serverKey.fill(0)
        }
    }

    fun buildSessionTranscriptHash(
        binding: BluetoothMutualAuthBindingV1,
        clientPublicKeySpki: ByteArray,
        clientBinder: ByteArray,
        serverPublicKeySpki: ByteArray
    ): ByteArray {
        val bindingBytes = authBindingBytes(binding)
        val clientKey = normalizeX25519PublicKeySpki(clientPublicKeySpki)
        val binder = exactCopy(clientBinder, AUTH_BYTES, "clientBinder")
        val serverKey = normalizeX25519PublicKeySpki(serverPublicKeySpki)
        val context = SESSION_TRANSCRIPT_CONTEXT.toByteArray(Charsets.UTF_8)
        return try {
            MessageDigest.getInstance("SHA-256").run {
                update(context)
                update(bindingBytes)
                update(clientKey)
                update(binder)
                digest(serverKey)
            }
        } finally {
            context.fill(0)
            bindingBytes.fill(0)
            clientKey.fill(0)
            binder.fill(0)
            serverKey.fill(0)
        }
    }

    fun deriveSessionKeys(
        sharedSecret: ByteArray,
        sessionKeyBinder: ByteArray,
        transcriptHash: ByteArray
    ): BluetoothDirectControlSessionKeysV1 =
        BluetoothDirectControlSessionKeysV1.derive(
            sharedSecret,
            sessionKeyBinder,
            transcriptHash
        )

    fun encodeClientKeyShare(
        sessionId: String,
        publicKeySpki: ByteArray,
        clientBinder: ByteArray
    ): ByteArray {
        val session = sessionIdBytes(sessionId)
        val publicKey = normalizeX25519PublicKeySpki(publicKeySpki)
        val binder = exactCopy(clientBinder, AUTH_BYTES, "clientBinder")
        return ByteArray(CLIENT_KEY_SHARE_WIRE_BYTES).also { output ->
            try {
                output[0] = PROTOCOL_VERSION.toByte()
                output[1] =
                    BluetoothDirectControlMessageTypeV1.CLIENT_KEY_SHARE
                        .wireValue.toByte()
                session.copyInto(output, destinationOffset = 2)
                publicKey.copyInto(output, destinationOffset = 18)
                binder.copyInto(output, destinationOffset = 62)
            } finally {
                session.fill(0)
                publicKey.fill(0)
                binder.fill(0)
            }
        }
    }

    fun decodeClientKeyShare(
        payload: ByteArray
    ): BluetoothDirectControlClientKeyShareV1 {
        validateHeader(
            payload,
            CLIENT_KEY_SHARE_WIRE_BYTES,
            BluetoothDirectControlMessageTypeV1.CLIENT_KEY_SHARE
        )
        val sessionBytes = payload.copyOfRange(2, 18)
        val publicKey = payload.copyOfRange(18, 62)
        val binder = payload.copyOfRange(62, 94)
        return try {
            BluetoothDirectControlClientKeyShareV1(
                protocolVersion = PROTOCOL_VERSION,
                sessionId = canonicalSessionId(sessionBytes),
                publicKeySpki = normalizeX25519PublicKeySpki(publicKey),
                clientBinder = binder
            )
        } finally {
            sessionBytes.fill(0)
            publicKey.fill(0)
            binder.fill(0)
        }
    }

    fun encodeServerKeyShare(
        sessionId: String,
        publicKeySpki: ByteArray,
        confirmation: ByteArray
    ): ByteArray {
        val session = sessionIdBytes(sessionId)
        val publicKey = normalizeX25519PublicKeySpki(publicKeySpki)
        val proof = exactCopy(confirmation, AUTH_BYTES, "confirmation")
        return ByteArray(SERVER_KEY_SHARE_WIRE_BYTES).also { output ->
            try {
                output[0] = PROTOCOL_VERSION.toByte()
                output[1] =
                    BluetoothDirectControlMessageTypeV1.SERVER_KEY_SHARE
                        .wireValue.toByte()
                session.copyInto(output, destinationOffset = 2)
                publicKey.copyInto(output, destinationOffset = 18)
                proof.copyInto(output, destinationOffset = 62)
            } finally {
                session.fill(0)
                publicKey.fill(0)
                proof.fill(0)
            }
        }
    }

    fun decodeServerKeyShare(
        payload: ByteArray
    ): BluetoothDirectControlServerKeyShareV1 {
        validateHeader(
            payload,
            SERVER_KEY_SHARE_WIRE_BYTES,
            BluetoothDirectControlMessageTypeV1.SERVER_KEY_SHARE
        )
        val sessionBytes = payload.copyOfRange(2, 18)
        val publicKey = payload.copyOfRange(18, 62)
        val confirmation = payload.copyOfRange(62, 94)
        return try {
            BluetoothDirectControlServerKeyShareV1(
                protocolVersion = PROTOCOL_VERSION,
                sessionId = canonicalSessionId(sessionBytes),
                publicKeySpki = normalizeX25519PublicKeySpki(publicKey),
                confirmation = confirmation
            )
        } finally {
            sessionBytes.fill(0)
            publicKey.fill(0)
            confirmation.fill(0)
        }
    }

    fun encodeClientKeyConfirm(
        sessionId: String,
        confirmation: ByteArray
    ): ByteArray {
        val session = sessionIdBytes(sessionId)
        val proof = exactCopy(confirmation, AUTH_BYTES, "confirmation")
        return ByteArray(CLIENT_KEY_CONFIRM_WIRE_BYTES).also { output ->
            try {
                output[0] = PROTOCOL_VERSION.toByte()
                output[1] =
                    BluetoothDirectControlMessageTypeV1.CLIENT_KEY_CONFIRM
                        .wireValue.toByte()
                session.copyInto(output, destinationOffset = 2)
                proof.copyInto(output, destinationOffset = 18)
            } finally {
                session.fill(0)
                proof.fill(0)
            }
        }
    }

    fun decodeClientKeyConfirm(
        payload: ByteArray
    ): BluetoothDirectControlClientKeyConfirmV1 {
        validateHeader(
            payload,
            CLIENT_KEY_CONFIRM_WIRE_BYTES,
            BluetoothDirectControlMessageTypeV1.CLIENT_KEY_CONFIRM
        )
        val sessionBytes = payload.copyOfRange(2, 18)
        val confirmation = payload.copyOfRange(18, 50)
        return try {
            BluetoothDirectControlClientKeyConfirmV1(
                protocolVersion = PROTOCOL_VERSION,
                sessionId = canonicalSessionId(sessionBytes),
                confirmation = confirmation
            )
        } finally {
            sessionBytes.fill(0)
            confirmation.fill(0)
        }
    }

    fun encodeHeartbeat(
        messageType: BluetoothDirectControlMessageTypeV1,
        sessionId: String,
        sequence: Long,
        authenticationKey: ByteArray
    ): ByteArray {
        require(
            messageType == BluetoothDirectControlMessageTypeV1.PING ||
                messageType == BluetoothDirectControlMessageTypeV1.PONG
        ) { "message type is not a heartbeat" }
        validateSequence(sequence)
        val session = sessionIdBytes(sessionId)
        val prefix = ByteArray(HEARTBEAT_WIRE_BYTES - AUTH_BYTES)
        var tag: ByteArray? = null
        return try {
            prefix[0] = PROTOCOL_VERSION.toByte()
            prefix[1] = messageType.wireValue.toByte()
            session.copyInto(prefix, destinationOffset = 2)
            ByteBuffer.wrap(prefix).putInt(18, sequence.toInt())
            tag = authenticatedControlTag(authenticationKey, prefix)
            concatenate(prefix, checkNotNull(tag))
        } finally {
            session.fill(0)
            prefix.fill(0)
            tag?.fill(0)
        }
    }

    fun decodeHeartbeat(
        payload: ByteArray,
        authenticationKey: ByteArray,
        expectedMessageType: BluetoothDirectControlMessageTypeV1? = null,
        expectedSequence: Long? = null
    ): BluetoothDirectControlHeartbeatV1 {
        require(payload.size == HEARTBEAT_WIRE_BYTES)
        require(payload[0].toInt() and 0xff == PROTOCOL_VERSION)
        val messageType = heartbeatType(payload[1].toInt() and 0xff)
        if (expectedMessageType != null) {
            require(messageType == expectedMessageType) {
                "heartbeat message type mismatch"
            }
        }
        val sequence =
            ByteBuffer.wrap(payload, 18, 4).int.toLong() and MAX_SEQUENCE
        val expectedTag = authenticatedControlTag(
            authenticationKey,
            payload.copyOfRange(0, 22)
        )
        val candidateTag = payload.copyOfRange(22, 54)
        val sessionBytes = payload.copyOfRange(2, 18)
        return try {
            require(MessageDigest.isEqual(expectedTag, candidateTag)) {
                "heartbeat authentication tag mismatch"
            }
            expectedSequence?.let {
                validateSequence(it)
                require(sequence == it) { "heartbeat sequence mismatch" }
            }
            BluetoothDirectControlHeartbeatV1(
                protocolVersion = PROTOCOL_VERSION,
                messageType = messageType,
                sessionId = canonicalSessionId(sessionBytes),
                sequence = sequence
            )
        } finally {
            expectedTag.fill(0)
            candidateTag.fill(0)
            sessionBytes.fill(0)
        }
    }

    fun encodeClose(
        messageType: BluetoothDirectControlMessageTypeV1,
        sessionId: String,
        sequence: Long,
        reason: BluetoothDirectControlCloseReasonV1,
        authenticationKey: ByteArray
    ): ByteArray {
        require(
            messageType == BluetoothDirectControlMessageTypeV1.CLOSE ||
                messageType == BluetoothDirectControlMessageTypeV1.CLOSE_ACK
        ) { "message type is not a close frame" }
        validateSequence(sequence)
        val session = sessionIdBytes(sessionId)
        val prefix = ByteArray(CLOSE_WIRE_BYTES - AUTH_BYTES)
        var tag: ByteArray? = null
        return try {
            prefix[0] = PROTOCOL_VERSION.toByte()
            prefix[1] = messageType.wireValue.toByte()
            session.copyInto(prefix, destinationOffset = 2)
            ByteBuffer.wrap(prefix).putInt(18, sequence.toInt())
            prefix[22] = reason.wireValue.toByte()
            tag = authenticatedControlTag(authenticationKey, prefix)
            concatenate(prefix, checkNotNull(tag))
        } finally {
            session.fill(0)
            prefix.fill(0)
            tag?.fill(0)
        }
    }

    fun decodeClose(
        payload: ByteArray,
        authenticationKey: ByteArray,
        expectedMessageType: BluetoothDirectControlMessageTypeV1? = null,
        expectedSequence: Long? = null,
        expectedReason: BluetoothDirectControlCloseReasonV1? = null
    ): BluetoothDirectControlCloseV1 {
        require(payload.size == CLOSE_WIRE_BYTES)
        require(payload[0].toInt() and 0xff == PROTOCOL_VERSION)
        val messageType = closeType(payload[1].toInt() and 0xff)
        if (expectedMessageType != null) {
            require(messageType == expectedMessageType) {
                "close message type mismatch"
            }
        }
        val sequence =
            ByteBuffer.wrap(payload, 18, 4).int.toLong() and MAX_SEQUENCE
        val reason = BluetoothDirectControlCloseReasonV1.fromWire(
            payload[22].toInt() and 0xff
        )
        val expectedTag = authenticatedControlTag(
            authenticationKey,
            payload.copyOfRange(0, 23)
        )
        val candidateTag = payload.copyOfRange(23, 55)
        val sessionBytes = payload.copyOfRange(2, 18)
        return try {
            require(MessageDigest.isEqual(expectedTag, candidateTag)) {
                "close authentication tag mismatch"
            }
            expectedSequence?.let {
                validateSequence(it)
                require(sequence == it) { "close sequence mismatch" }
            }
            if (expectedReason != null) {
                require(reason == expectedReason) { "close reason mismatch" }
            }
            BluetoothDirectControlCloseV1(
                protocolVersion = PROTOCOL_VERSION,
                messageType = messageType,
                sessionId = canonicalSessionId(sessionBytes),
                sequence = sequence,
                reason = reason
            )
        } finally {
            expectedTag.fill(0)
            candidateTag.fill(0)
            sessionBytes.fill(0)
        }
    }

    internal fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
        val keyCopy = exactCopy(key, AUTH_BYTES, "key")
        return try {
            Mac.getInstance("HmacSHA256").run {
                init(SecretKeySpec(keyCopy, "HmacSHA256"))
                doFinal(message)
            }
        } finally {
            keyCopy.fill(0)
        }
    }

    internal fun exactCopy(
        value: ByteArray,
        expectedLength: Int,
        field: String
    ): ByteArray {
        require(value.size == expectedLength) {
            "$field must contain exactly $expectedLength bytes"
        }
        return value.copyOf()
    }

    internal fun concatenate(vararg values: ByteArray): ByteArray {
        val size = values.fold(0) { total, value ->
            Math.addExact(total, value.size)
        }
        return ByteArray(size).also { output ->
            var offset = 0
            values.forEach { value ->
                value.copyInto(output, destinationOffset = offset)
                offset += value.size
            }
        }
    }

    private fun authBindingBytes(
        binding: BluetoothMutualAuthBindingV1
    ): ByteArray {
        val normalized = BluetoothMutualAuthCodecV1.createBinding(
            binding.clientHello,
            binding.serverHello,
            binding.deviceCertificateId
        )
        val clientHello = BluetoothHelloCodecV1.encode(normalized.clientHello)
        val serverHello = BluetoothHelloCodecV1.encode(normalized.serverHello)
        val certificate = uuidBytes(normalized.deviceCertificateId)
        return try {
            concatenate(clientHello, serverHello, certificate)
        } finally {
            clientHello.fill(0)
            serverHello.fill(0)
            certificate.fill(0)
        }
    }

    private fun authenticatedControlTag(
        authenticationKey: ByteArray,
        wireWithoutTag: ByteArray
    ): ByteArray {
        val context = AUTHENTICATED_CONTROL_CONTEXT.toByteArray(Charsets.UTF_8)
        val message = concatenate(context, wireWithoutTag)
        return try {
            hmacSha256(authenticationKey, message)
        } finally {
            context.fill(0)
            message.fill(0)
        }
    }

    private fun sessionIdBytes(sessionId: String): ByteArray =
        BluetoothHelloCodecV1.canonicalIdentifierBytes(sessionId, "sessionId")

    private fun canonicalSessionId(value: ByteArray): String {
        val sessionId = BluetoothHelloCodecV1.canonicalIdentifier(value)
        BluetoothHelloCodecV1
            .canonicalIdentifierBytes(sessionId, "sessionId")
            .fill(0)
        return sessionId
    }

    private fun uuidBytes(value: String): ByteArray {
        val normalized = UUID.fromString(value).toString()
        require(normalized == value) { "UUID must be canonical and lowercase" }
        val uuid = UUID.fromString(value)
        return ByteBuffer.allocate(16)
            .putLong(uuid.mostSignificantBits)
            .putLong(uuid.leastSignificantBits)
            .array()
    }

    private fun validateHeader(
        payload: ByteArray,
        expectedLength: Int,
        expectedType: BluetoothDirectControlMessageTypeV1
    ) {
        require(payload.size == expectedLength)
        require(payload[0].toInt() and 0xff == PROTOCOL_VERSION)
        require(payload[1].toInt() and 0xff == expectedType.wireValue)
    }

    private fun validateSequence(sequence: Long) {
        require(sequence in 0L..MAX_SEQUENCE) {
            "sequence must be an unsigned 32-bit integer"
        }
    }

    private fun heartbeatType(value: Int): BluetoothDirectControlMessageTypeV1 =
        when (value) {
            BluetoothDirectControlMessageTypeV1.PING.wireValue ->
                BluetoothDirectControlMessageTypeV1.PING
            BluetoothDirectControlMessageTypeV1.PONG.wireValue ->
                BluetoothDirectControlMessageTypeV1.PONG
            else -> throw IllegalArgumentException("invalid heartbeat type")
        }

    private fun closeType(value: Int): BluetoothDirectControlMessageTypeV1 =
        when (value) {
            BluetoothDirectControlMessageTypeV1.CLOSE.wireValue ->
                BluetoothDirectControlMessageTypeV1.CLOSE
            BluetoothDirectControlMessageTypeV1.CLOSE_ACK.wireValue ->
                BluetoothDirectControlMessageTypeV1.CLOSE_ACK
            else -> throw IllegalArgumentException("invalid close type")
        }
}

class BluetoothDirectControlSessionKeysV1 private constructor(
    clientToServerControlKey: ByteArray,
    serverToClientControlKey: ByteArray,
    clientConfirmationKey: ByteArray,
    serverConfirmationKey: ByteArray
) : AutoCloseable {
    private var clientToServerControlKeyValue: ByteArray? =
        clientToServerControlKey.copyOf()
    private var serverToClientControlKeyValue: ByteArray? =
        serverToClientControlKey.copyOf()
    private var clientConfirmationKeyValue: ByteArray? =
        clientConfirmationKey.copyOf()
    private var serverConfirmationKeyValue: ByteArray? =
        serverConfirmationKey.copyOf()

    val isClosed: Boolean
        @Synchronized get() = clientToServerControlKeyValue == null

    @Synchronized
    fun createServerConfirmation(transcriptHash: ByteArray): ByteArray {
        val hash = BluetoothDirectControlCodecV1.exactCopy(
            transcriptHash,
            BluetoothDirectControlCodecV1.AUTH_BYTES,
            "transcriptHash"
        )
        val context =
            BluetoothDirectControlCodecV1.SERVER_CONFIRMATION_CONTEXT
                .toByteArray(Charsets.UTF_8)
        val message = BluetoothDirectControlCodecV1.concatenate(context, hash)
        return try {
            BluetoothDirectControlCodecV1.hmacSha256(
                openKey(serverConfirmationKeyValue),
                message
            )
        } finally {
            hash.fill(0)
            context.fill(0)
            message.fill(0)
        }
    }

    @Synchronized
    fun verifyServerConfirmation(
        transcriptHash: ByteArray,
        confirmation: ByteArray
    ): Boolean {
        if (confirmation.size != BluetoothDirectControlCodecV1.AUTH_BYTES) {
            return false
        }
        val expected = createServerConfirmation(transcriptHash)
        return try {
            MessageDigest.isEqual(expected, confirmation)
        } finally {
            expected.fill(0)
        }
    }

    @Synchronized
    fun createClientConfirmation(
        transcriptHash: ByteArray,
        serverConfirmation: ByteArray
    ): ByteArray {
        val hash = BluetoothDirectControlCodecV1.exactCopy(
            transcriptHash,
            BluetoothDirectControlCodecV1.AUTH_BYTES,
            "transcriptHash"
        )
        val server = BluetoothDirectControlCodecV1.exactCopy(
            serverConfirmation,
            BluetoothDirectControlCodecV1.AUTH_BYTES,
            "serverConfirmation"
        )
        val context =
            BluetoothDirectControlCodecV1.CLIENT_CONFIRMATION_CONTEXT
                .toByteArray(Charsets.UTF_8)
        val message =
            BluetoothDirectControlCodecV1.concatenate(context, hash, server)
        return try {
            BluetoothDirectControlCodecV1.hmacSha256(
                openKey(clientConfirmationKeyValue),
                message
            )
        } finally {
            hash.fill(0)
            server.fill(0)
            context.fill(0)
            message.fill(0)
        }
    }

    @Synchronized
    fun encodeClientHeartbeat(
        messageType: BluetoothDirectControlMessageTypeV1,
        sessionId: String,
        sequence: Long
    ): ByteArray = BluetoothDirectControlCodecV1.encodeHeartbeat(
        messageType,
        sessionId,
        sequence,
        openKey(clientToServerControlKeyValue)
    )

    @Synchronized
    fun decodeServerHeartbeat(
        payload: ByteArray,
        expectedMessageType: BluetoothDirectControlMessageTypeV1,
        expectedSequence: Long? = null
    ): BluetoothDirectControlHeartbeatV1 =
        BluetoothDirectControlCodecV1.decodeHeartbeat(
            payload,
            openKey(serverToClientControlKeyValue),
            expectedMessageType,
            expectedSequence
        )

    @Synchronized
    fun encodeClientClose(
        messageType: BluetoothDirectControlMessageTypeV1,
        sessionId: String,
        sequence: Long,
        reason: BluetoothDirectControlCloseReasonV1
    ): ByteArray = BluetoothDirectControlCodecV1.encodeClose(
        messageType,
        sessionId,
        sequence,
        reason,
        openKey(clientToServerControlKeyValue)
    )

    @Synchronized
    fun decodeServerClose(
        payload: ByteArray,
        expectedMessageType: BluetoothDirectControlMessageTypeV1,
        expectedSequence: Long? = null,
        expectedReason: BluetoothDirectControlCloseReasonV1? = null
    ): BluetoothDirectControlCloseV1 = BluetoothDirectControlCodecV1.decodeClose(
        payload,
        openKey(serverToClientControlKeyValue),
        expectedMessageType,
        expectedSequence,
        expectedReason
    )

    @Synchronized
    internal fun keyCopiesForTest(): List<ByteArray> = listOf(
        openKey(clientToServerControlKeyValue).copyOf(),
        openKey(serverToClientControlKeyValue).copyOf(),
        openKey(clientConfirmationKeyValue).copyOf(),
        openKey(serverConfirmationKeyValue).copyOf()
    )

    @Synchronized
    internal fun exportReliableChannelMaterialV1(): ReliableChannelMaterialV1 =
        com.sentrapa.cassav6.webkiosk.bluetooth.deriveReliableChannelMaterialV1(
            openKey(clientToServerControlKeyValue),
            openKey(serverToClientControlKeyValue)
        )

    @Synchronized
    override fun close() {
        clientToServerControlKeyValue?.fill(0)
        clientToServerControlKeyValue = null
        serverToClientControlKeyValue?.fill(0)
        serverToClientControlKeyValue = null
        clientConfirmationKeyValue?.fill(0)
        clientConfirmationKeyValue = null
        serverConfirmationKeyValue?.fill(0)
        serverConfirmationKeyValue = null
    }

    override fun toString(): String =
        "BluetoothDirectControlSessionKeysV1(closed=$isClosed, keys=<redacted>)"

    private fun openKey(value: ByteArray?): ByteArray =
        checkNotNull(value) { "session keys have been cleared" }

    companion object {
        internal fun derive(
            sharedSecret: ByteArray,
            sessionKeyBinder: ByteArray,
            transcriptHash: ByteArray
        ): BluetoothDirectControlSessionKeysV1 {
            val secret = BluetoothDirectControlCodecV1.exactCopy(
                sharedSecret,
                BluetoothDirectControlCodecV1.AUTH_BYTES,
                "sharedSecret"
            )
            val salt = BluetoothDirectControlCodecV1.exactCopy(
                sessionKeyBinder,
                BluetoothDirectControlCodecV1.AUTH_BYTES,
                "sessionKeyBinder"
            )
            val hash = BluetoothDirectControlCodecV1.exactCopy(
                transcriptHash,
                BluetoothDirectControlCodecV1.AUTH_BYTES,
                "transcriptHash"
            )
            val context =
                BluetoothDirectControlCodecV1.HKDF_INFO_CONTEXT
                    .toByteArray(Charsets.UTF_8)
            val info = BluetoothDirectControlCodecV1.concatenate(context, hash)
            var keyMaterial: ByteArray? = null
            return try {
                require(secret.any { it.toInt() != 0 }) {
                    "sharedSecret must not be all zero"
                }
                keyMaterial = hkdfSha256(secret, salt, info, 128)
                BluetoothDirectControlSessionKeysV1(
                    keyMaterial.copyOfRange(0, 32),
                    keyMaterial.copyOfRange(32, 64),
                    keyMaterial.copyOfRange(64, 96),
                    keyMaterial.copyOfRange(96, 128)
                )
            } finally {
                secret.fill(0)
                salt.fill(0)
                hash.fill(0)
                context.fill(0)
                info.fill(0)
                keyMaterial?.fill(0)
            }
        }

        private fun hkdfSha256(
            inputKeyMaterial: ByteArray,
            salt: ByteArray,
            info: ByteArray,
            outputLength: Int
        ): ByteArray {
            require(outputLength in 1..(255 * BluetoothDirectControlCodecV1.AUTH_BYTES))
            val pseudoRandomKey = BluetoothDirectControlCodecV1.hmacSha256(
                salt,
                inputKeyMaterial
            )
            val output = ByteArray(outputLength)
            var previous = ByteArray(0)
            var outputOffset = 0
            var blockIndex = 1
            try {
                while (outputOffset < outputLength) {
                    val input = BluetoothDirectControlCodecV1.concatenate(
                        previous,
                        info,
                        byteArrayOf(blockIndex.toByte())
                    )
                    val block = try {
                        BluetoothDirectControlCodecV1.hmacSha256(
                            pseudoRandomKey,
                            input
                        )
                    } finally {
                        input.fill(0)
                    }
                    previous.fill(0)
                    previous = block
                    val count = minOf(block.size, outputLength - outputOffset)
                    block.copyInto(
                        output,
                        destinationOffset = outputOffset,
                        endIndex = count
                    )
                    outputOffset += count
                    blockIndex += 1
                }
                return output
            } finally {
                pseudoRandomKey.fill(0)
                previous.fill(0)
            }
        }
    }
}

interface BluetoothDirectControlKeyAgreementV1 : AutoCloseable {
    fun publicKeySpki(): ByteArray

    fun deriveSharedSecret(peerPublicKeySpki: ByteArray): ByteArray
}

fun interface BluetoothDirectControlKeyAgreementFactoryV1 {
    fun create(): BluetoothDirectControlKeyAgreementV1
}

object JcaBluetoothDirectControlKeyAgreementFactoryV1 :
    BluetoothDirectControlKeyAgreementFactoryV1 {
    override fun create(): BluetoothDirectControlKeyAgreementV1 =
        JcaBluetoothDirectControlKeyAgreementV1.create()
}

class JcaBluetoothDirectControlKeyAgreementV1 private constructor(
    keyPair: KeyPair,
    publicKeySpki: ByteArray
) : BluetoothDirectControlKeyAgreementV1 {
    private var privateKey: PrivateKey? = keyPair.private
    private var publicKeySpkiValue: ByteArray? = publicKeySpki.copyOf()

    @Synchronized
    override fun publicKeySpki(): ByteArray =
        checkNotNull(publicKeySpkiValue) {
            "X25519 key agreement has been cleared"
        }.copyOf()

    @Synchronized
    override fun deriveSharedSecret(peerPublicKeySpki: ByteArray): ByteArray {
        val localPrivateKey = checkNotNull(privateKey) {
            "X25519 key agreement has been cleared"
        }
        val peerEncoded =
            BluetoothDirectControlCodecV1.normalizeX25519PublicKeySpki(
                peerPublicKeySpki
            )
        return try {
            val peerPublicKey = decodePublicKey(peerEncoded)
            val sharedSecret = agree(localPrivateKey, peerPublicKey)
            if (
                sharedSecret.size != BluetoothDirectControlCodecV1.AUTH_BYTES ||
                sharedSecret.all { it.toInt() == 0 }
            ) {
                sharedSecret.fill(0)
                throw IllegalArgumentException(
                    "X25519 produced an invalid shared secret"
                )
            }
            sharedSecret
        } finally {
            peerEncoded.fill(0)
        }
    }

    @Synchronized
    override fun close() {
        privateKey = null
        publicKeySpkiValue?.fill(0)
        publicKeySpkiValue = null
    }

    override fun toString(): String =
        "JcaBluetoothDirectControlKeyAgreementV1(keyMaterial=<redacted>)"

    private fun decodePublicKey(encoded: ByteArray): PublicKey {
        var lastFailure: Exception? = null
        for (algorithm in ALGORITHMS) {
            try {
                return KeyFactory.getInstance(algorithm).generatePublic(
                    X509EncodedKeySpec(encoded)
                )
            } catch (failure: Exception) {
                lastFailure = failure
            }
        }
        throw IllegalStateException("X25519 public key is unavailable", lastFailure)
    }

    private fun agree(localPrivateKey: PrivateKey, peerPublicKey: PublicKey): ByteArray {
        var lastFailure: Exception? = null
        for (algorithm in ALGORITHMS) {
            try {
                return KeyAgreement.getInstance(algorithm).run {
                    init(localPrivateKey)
                    doPhase(peerPublicKey, true)
                    generateSecret()
                }
            } catch (failure: Exception) {
                lastFailure = failure
            }
        }
        throw IllegalStateException("X25519 key agreement is unavailable", lastFailure)
    }

    companion object {
        private val ALGORITHMS = arrayOf("X25519", "XDH")

        fun create(): JcaBluetoothDirectControlKeyAgreementV1 {
            var lastFailure: Exception? = null
            for (algorithm in ALGORITHMS) {
                try {
                    val keyPair = KeyPairGenerator.getInstance(algorithm).generateKeyPair()
                    val publicKey =
                        BluetoothDirectControlCodecV1.normalizeX25519PublicKeySpki(
                            keyPair.public.encoded
                        )
                    return JcaBluetoothDirectControlKeyAgreementV1(
                        keyPair,
                        publicKey
                    ).also { publicKey.fill(0) }
                } catch (failure: Exception) {
                    lastFailure = failure
                }
            }
            throw IllegalStateException("X25519 key generation is unavailable", lastFailure)
        }
    }
}

enum class BluetoothDirectControlClientPhaseV1 {
    AUTHENTICATED,
    CLIENT_KEY_SHARE_READY,
    CLIENT_CONFIRM_READY,
    KEY_ESTABLISHED,
    PONG_READY,
    ACTIVE,
    CLOSING,
    CLOSED,
    FAILED
}

enum class BluetoothDirectControlFailureV1 {
    STATE_INVALID,
    IDENTITY_NOT_READY,
    CLIENT_KEY_SHARE_FAILED,
    SERVER_KEY_SHARE_INVALID,
    SERVER_KEY_SHARE_REJECTED,
    SERVER_CONFIRMATION_REJECTED,
    KEY_DERIVATION_FAILED,
    CONTROL_FRAME_INVALID,
    CONTROL_SESSION_MISMATCH,
    CONTROL_SEQUENCE_MISMATCH,
    CONTROL_FRAME_CONFLICT
}

sealed class BluetoothDirectControlResultV1 {
    class Ready(
        payload: ByteArray,
        val messageType: BluetoothDirectControlMessageTypeV1,
        val sequence: Long? = null,
        val closeReason: BluetoothDirectControlCloseReasonV1? = null
    ) : BluetoothDirectControlResultV1() {
        private val payloadValue = payload.copyOf()

        val payload: ByteArray
            get() = payloadValue.copyOf()

        override fun toString(): String =
            "BluetoothDirectControlResultV1.Ready(messageType=$messageType, " +
                "sequence=$sequence, closeReason=$closeReason, payload=<redacted>)"
    }

    data class Failure(
        val reason: BluetoothDirectControlFailureV1
    ) : BluetoothDirectControlResultV1()
}

class AndroidDirectControlClientV1(
    private val identity: BluetoothMutualAuthIdentityPort,
    initialBinding: BluetoothMutualAuthBindingV1,
    private val keyAgreementFactory: BluetoothDirectControlKeyAgreementFactoryV1 =
        JcaBluetoothDirectControlKeyAgreementFactoryV1
) {
    private var binding: BluetoothMutualAuthBindingV1? =
        BluetoothMutualAuthCodecV1.createBinding(
            initialBinding.clientHello,
            initialBinding.serverHello,
            initialBinding.deviceCertificateId
        )
    private var phaseValue = BluetoothDirectControlClientPhaseV1.AUTHENTICATED
    private var keyAgreement: BluetoothDirectControlKeyAgreementV1? = null
    private var clientPublicKeySpki: ByteArray? = null
    private var clientBinder: ByteArray? = null
    private var clientKeyShareWire: ByteArray? = null
    private var acceptedServerKeyShareWire: ByteArray? = null
    private var clientKeyConfirmWire: ByteArray? = null
    private var sessionKeys: BluetoothDirectControlSessionKeysV1? = null
    private var nextServerSequence = 0L
    private var acceptedControlWire: ByteArray? = null
    private var controlResponseWire: ByteArray? = null
    private var acceptedControlType: BluetoothDirectControlMessageTypeV1? = null
    private var acceptedControlSequence: Long? = null
    private var acceptedCloseReason: BluetoothDirectControlCloseReasonV1? = null

    val phase: BluetoothDirectControlClientPhaseV1
        @Synchronized get() = phaseValue

    val sessionId: String
        @Synchronized get() =
            binding?.clientHello?.sessionId
                ?: sessionIdValue

    private val sessionIdValue = initialBinding.clientHello.sessionId

    @Synchronized
    internal fun exportReliableChannelMaterialV1(): ReliableChannelMaterialV1 {
        if (phaseValue != BluetoothDirectControlClientPhaseV1.ACTIVE) {
            throw IllegalStateException(
                "reliable channel material requires an ACTIVE direct-control session"
            )
        }
        return checkNotNull(sessionKeys) {
            "ACTIVE direct-control session has no session keys"
        }.exportReliableChannelMaterialV1()
    }

    @Synchronized
    fun createClientKeyShare(): BluetoothDirectControlResultV1 {
        clientKeyShareWire?.let { wire ->
            if (phaseValue == BluetoothDirectControlClientPhaseV1.CLIENT_KEY_SHARE_READY) {
                return ready(
                    wire,
                    BluetoothDirectControlMessageTypeV1.CLIENT_KEY_SHARE
                )
            }
        }
        val currentBinding = binding
            ?: return failure(BluetoothDirectControlFailureV1.STATE_INVALID)
        if (phaseValue != BluetoothDirectControlClientPhaseV1.AUTHENTICATED) {
            return failure(BluetoothDirectControlFailureV1.STATE_INVALID)
        }

        var agreement: BluetoothDirectControlKeyAgreementV1? = null
        var publicKey: ByteArray? = null
        var binderMessage: ByteArray? = null
        var binderProof: ByteArray? = null
        return try {
            agreement = keyAgreementFactory.create()
            publicKey = BluetoothDirectControlCodecV1.normalizeX25519PublicKeySpki(
                agreement.publicKeySpki()
            )
            binderMessage =
                BluetoothDirectControlCodecV1.buildClientKeyShareBinderMessage(
                    currentBinding,
                    publicKey
                )
            val result = identity.createAuthenticationMac(binderMessage)
            binderProof = result.proof
            if (
                result.status != DeviceIdentityStatus.READY ||
                binderProof == null ||
                binderProof.size != BluetoothDirectControlCodecV1.AUTH_BYTES
            ) {
                return failClosed(BluetoothDirectControlFailureV1.IDENTITY_NOT_READY)
            }
            val wire = BluetoothDirectControlCodecV1.encodeClientKeyShare(
                currentBinding.clientHello.sessionId,
                publicKey,
                binderProof
            )
            keyAgreement = agreement
            agreement = null
            clientPublicKeySpki = publicKey.copyOf()
            clientBinder = binderProof.copyOf()
            clientKeyShareWire = wire.copyOf()
            phaseValue = BluetoothDirectControlClientPhaseV1.CLIENT_KEY_SHARE_READY
            ready(wire, BluetoothDirectControlMessageTypeV1.CLIENT_KEY_SHARE)
        } catch (_: Exception) {
            failClosed(BluetoothDirectControlFailureV1.CLIENT_KEY_SHARE_FAILED)
        } finally {
            agreement?.close()
            publicKey?.fill(0)
            binderMessage?.fill(0)
            binderProof?.fill(0)
        }
    }

    @Synchronized
    fun acceptServerKeyShare(
        payload: ByteArray
    ): BluetoothDirectControlResultV1 {
        if (phaseValue == BluetoothDirectControlClientPhaseV1.CLIENT_CONFIRM_READY) {
            return if (acceptedServerKeyShareWire?.contentEquals(payload) == true) {
                ready(
                    checkNotNull(clientKeyConfirmWire),
                    BluetoothDirectControlMessageTypeV1.CLIENT_KEY_CONFIRM
                )
            } else {
                failClosed(
                    BluetoothDirectControlFailureV1.SERVER_KEY_SHARE_REJECTED
                )
            }
        }
        if (phaseValue != BluetoothDirectControlClientPhaseV1.CLIENT_KEY_SHARE_READY) {
            return failure(BluetoothDirectControlFailureV1.STATE_INVALID)
        }
        val currentBinding = binding
            ?: return failClosed(BluetoothDirectControlFailureV1.STATE_INVALID)
        val clientKey = clientPublicKeySpki
            ?: return failClosed(BluetoothDirectControlFailureV1.STATE_INVALID)
        val binder = clientBinder
            ?: return failClosed(BluetoothDirectControlFailureV1.STATE_INVALID)
        val agreement = keyAgreement
            ?: return failClosed(BluetoothDirectControlFailureV1.STATE_INVALID)
        val server = try {
            BluetoothDirectControlCodecV1.decodeServerKeyShare(payload)
        } catch (_: IllegalArgumentException) {
            return failClosed(
                BluetoothDirectControlFailureV1.SERVER_KEY_SHARE_INVALID
            )
        }
        if (server.sessionId != currentBinding.clientHello.sessionId) {
            return failClosed(
                BluetoothDirectControlFailureV1.SERVER_KEY_SHARE_REJECTED
            )
        }

        var serverKey: ByteArray? = null
        var serverConfirmation: ByteArray? = null
        var binderMessage: ByteArray? = null
        var sessionBinder: ByteArray? = null
        var transcriptHash: ByteArray? = null
        var sharedSecret: ByteArray? = null
        var derivedKeys: BluetoothDirectControlSessionKeysV1? = null
        var clientConfirmation: ByteArray? = null
        return try {
            serverKey = server.publicKeySpki
            serverConfirmation = server.confirmation
            binderMessage = BluetoothDirectControlCodecV1.buildSessionKeyBinderMessage(
                currentBinding,
                clientKey,
                binder,
                serverKey
            )
            val binderResult = identity.createAuthenticationMac(binderMessage)
            sessionBinder = binderResult.proof
            if (
                binderResult.status != DeviceIdentityStatus.READY ||
                sessionBinder == null ||
                sessionBinder.size != BluetoothDirectControlCodecV1.AUTH_BYTES
            ) {
                return failClosed(BluetoothDirectControlFailureV1.IDENTITY_NOT_READY)
            }
            transcriptHash = BluetoothDirectControlCodecV1.buildSessionTranscriptHash(
                currentBinding,
                clientKey,
                binder,
                serverKey
            )
            sharedSecret = agreement.deriveSharedSecret(serverKey)
            derivedKeys = BluetoothDirectControlCodecV1.deriveSessionKeys(
                sharedSecret,
                sessionBinder,
                transcriptHash
            )
            if (
                !derivedKeys.verifyServerConfirmation(
                    transcriptHash,
                    serverConfirmation
                )
            ) {
                return failClosed(
                    BluetoothDirectControlFailureV1.SERVER_CONFIRMATION_REJECTED
                )
            }
            clientConfirmation = derivedKeys.createClientConfirmation(
                transcriptHash,
                serverConfirmation
            )
            val wire = BluetoothDirectControlCodecV1.encodeClientKeyConfirm(
                currentBinding.clientHello.sessionId,
                clientConfirmation
            )
            sessionKeys = derivedKeys
            derivedKeys = null
            acceptedServerKeyShareWire = payload.copyOf()
            clientKeyConfirmWire = wire.copyOf()
            keyAgreement?.close()
            keyAgreement = null
            phaseValue = BluetoothDirectControlClientPhaseV1.CLIENT_CONFIRM_READY
            ready(wire, BluetoothDirectControlMessageTypeV1.CLIENT_KEY_CONFIRM)
        } catch (_: Exception) {
            failClosed(BluetoothDirectControlFailureV1.KEY_DERIVATION_FAILED)
        } finally {
            serverKey?.fill(0)
            serverConfirmation?.fill(0)
            binderMessage?.fill(0)
            sessionBinder?.fill(0)
            transcriptHash?.fill(0)
            sharedSecret?.fill(0)
            derivedKeys?.close()
            clientConfirmation?.fill(0)
        }
    }

    @Synchronized
    fun completeClientConfirmWrite(): Boolean {
        if (
            phaseValue == BluetoothDirectControlClientPhaseV1.KEY_ESTABLISHED ||
            phaseValue == BluetoothDirectControlClientPhaseV1.ACTIVE
        ) {
            return true
        }
        if (
            phaseValue != BluetoothDirectControlClientPhaseV1.CLIENT_CONFIRM_READY ||
            sessionKeys == null
        ) {
            return false
        }
        clearHandshakeMaterial()
        binding = null
        phaseValue = BluetoothDirectControlClientPhaseV1.KEY_ESTABLISHED
        return true
    }

    @Synchronized
    fun acceptPing(payload: ByteArray): BluetoothDirectControlResultV1 {
        duplicateControlResponse(
            payload,
            BluetoothDirectControlMessageTypeV1.PING
        )?.let { return it }
        if (phaseValue == BluetoothDirectControlClientPhaseV1.PONG_READY) {
            return failClosed(
                BluetoothDirectControlFailureV1.CONTROL_FRAME_CONFLICT
            )
        }
        if (
            phaseValue != BluetoothDirectControlClientPhaseV1.KEY_ESTABLISHED &&
            phaseValue != BluetoothDirectControlClientPhaseV1.ACTIVE
        ) {
            return failure(BluetoothDirectControlFailureV1.STATE_INVALID)
        }
        val keys = sessionKeys
            ?: return failClosed(BluetoothDirectControlFailureV1.STATE_INVALID)
        val ping = try {
            keys.decodeServerHeartbeat(
                payload,
                BluetoothDirectControlMessageTypeV1.PING
            )
        } catch (_: IllegalArgumentException) {
            return failClosed(BluetoothDirectControlFailureV1.CONTROL_FRAME_INVALID)
        }
        if (ping.sessionId != sessionIdValue) {
            return failClosed(
                BluetoothDirectControlFailureV1.CONTROL_SESSION_MISMATCH
            )
        }
        if (ping.sequence != nextServerSequence) {
            return failClosed(
                BluetoothDirectControlFailureV1.CONTROL_SEQUENCE_MISMATCH
            )
        }
        val pong = try {
            keys.encodeClientHeartbeat(
                BluetoothDirectControlMessageTypeV1.PONG,
                sessionIdValue,
                ping.sequence
            )
        } catch (_: Exception) {
            return failClosed(BluetoothDirectControlFailureV1.CONTROL_FRAME_INVALID)
        }
        rememberControlResponse(
            payload,
            pong,
            BluetoothDirectControlMessageTypeV1.PING,
            ping.sequence,
            null
        )
        nextServerSequence = incrementSequence(nextServerSequence)
        phaseValue = BluetoothDirectControlClientPhaseV1.PONG_READY
        return ready(
            pong,
            BluetoothDirectControlMessageTypeV1.PONG,
            ping.sequence
        )
    }

    @Synchronized
    fun completePongWrite(): Boolean {
        if (phaseValue == BluetoothDirectControlClientPhaseV1.ACTIVE) return true
        if (phaseValue != BluetoothDirectControlClientPhaseV1.PONG_READY) {
            return false
        }
        phaseValue = BluetoothDirectControlClientPhaseV1.ACTIVE
        return true
    }

    @Synchronized
    fun acceptClose(payload: ByteArray): BluetoothDirectControlResultV1 {
        duplicateControlResponse(
            payload,
            BluetoothDirectControlMessageTypeV1.CLOSE
        )?.let { return it }
        if (phaseValue == BluetoothDirectControlClientPhaseV1.CLOSING) {
            return failClosed(
                BluetoothDirectControlFailureV1.CONTROL_FRAME_CONFLICT
            )
        }
        if (
            phaseValue != BluetoothDirectControlClientPhaseV1.KEY_ESTABLISHED &&
            phaseValue != BluetoothDirectControlClientPhaseV1.PONG_READY &&
            phaseValue != BluetoothDirectControlClientPhaseV1.ACTIVE
        ) {
            return failure(BluetoothDirectControlFailureV1.STATE_INVALID)
        }
        val keys = sessionKeys
            ?: return failClosed(BluetoothDirectControlFailureV1.STATE_INVALID)
        val close = try {
            keys.decodeServerClose(
                payload,
                BluetoothDirectControlMessageTypeV1.CLOSE
            )
        } catch (_: IllegalArgumentException) {
            return failClosed(BluetoothDirectControlFailureV1.CONTROL_FRAME_INVALID)
        }
        if (close.sessionId != sessionIdValue) {
            return failClosed(
                BluetoothDirectControlFailureV1.CONTROL_SESSION_MISMATCH
            )
        }
        if (close.sequence != nextServerSequence) {
            return failClosed(
                BluetoothDirectControlFailureV1.CONTROL_SEQUENCE_MISMATCH
            )
        }
        val closeAck = try {
            keys.encodeClientClose(
                BluetoothDirectControlMessageTypeV1.CLOSE_ACK,
                sessionIdValue,
                close.sequence,
                close.reason
            )
        } catch (_: Exception) {
            return failClosed(BluetoothDirectControlFailureV1.CONTROL_FRAME_INVALID)
        }
        rememberControlResponse(
            payload,
            closeAck,
            BluetoothDirectControlMessageTypeV1.CLOSE,
            close.sequence,
            close.reason
        )
        nextServerSequence = incrementSequence(nextServerSequence)
        phaseValue = BluetoothDirectControlClientPhaseV1.CLOSING
        return ready(
            closeAck,
            BluetoothDirectControlMessageTypeV1.CLOSE_ACK,
            close.sequence,
            close.reason
        )
    }

    @Synchronized
    fun completeCloseAckWrite(): Boolean {
        if (phaseValue == BluetoothDirectControlClientPhaseV1.CLOSED) return true
        if (phaseValue != BluetoothDirectControlClientPhaseV1.CLOSING) {
            return false
        }
        clearMaterial()
        phaseValue = BluetoothDirectControlClientPhaseV1.CLOSED
        return true
    }

    @Synchronized
    fun clear() {
        clearMaterial()
        phaseValue = BluetoothDirectControlClientPhaseV1.CLOSED
    }

    override fun toString(): String =
        "AndroidDirectControlClientV1(phase=$phase, sessionId=<redacted>, " +
            "keyMaterial=<redacted>)"

    private fun duplicateControlResponse(
        payload: ByteArray,
        messageType: BluetoothDirectControlMessageTypeV1
    ): BluetoothDirectControlResultV1.Ready? {
        val accepted = acceptedControlWire ?: return null
        if (acceptedControlType != messageType) return null
        if (!accepted.contentEquals(payload)) return null
        val response = controlResponseWire ?: return null
        val responseType =
            if (messageType == BluetoothDirectControlMessageTypeV1.PING) {
                BluetoothDirectControlMessageTypeV1.PONG
            } else {
                BluetoothDirectControlMessageTypeV1.CLOSE_ACK
            }
        return ready(
            response,
            responseType,
            acceptedControlSequence,
            acceptedCloseReason
        )
    }

    private fun rememberControlResponse(
        request: ByteArray,
        response: ByteArray,
        requestType: BluetoothDirectControlMessageTypeV1,
        sequence: Long,
        closeReason: BluetoothDirectControlCloseReasonV1?
    ) {
        acceptedControlWire?.fill(0)
        controlResponseWire?.fill(0)
        acceptedControlWire = request.copyOf()
        controlResponseWire = response.copyOf()
        acceptedControlType = requestType
        acceptedControlSequence = sequence
        acceptedCloseReason = closeReason
    }

    private fun clearHandshakeMaterial() {
        keyAgreement?.close()
        keyAgreement = null
        clientPublicKeySpki?.fill(0)
        clientPublicKeySpki = null
        clientBinder?.fill(0)
        clientBinder = null
        clientKeyShareWire?.fill(0)
        clientKeyShareWire = null
        acceptedServerKeyShareWire?.fill(0)
        acceptedServerKeyShareWire = null
        clientKeyConfirmWire?.fill(0)
        clientKeyConfirmWire = null
    }

    private fun clearMaterial() {
        clearHandshakeMaterial()
        sessionKeys?.close()
        sessionKeys = null
        acceptedControlWire?.fill(0)
        acceptedControlWire = null
        controlResponseWire?.fill(0)
        controlResponseWire = null
        acceptedControlType = null
        acceptedControlSequence = null
        acceptedCloseReason = null
        binding = null
    }

    private fun failClosed(
        reason: BluetoothDirectControlFailureV1
    ): BluetoothDirectControlResultV1.Failure {
        clearMaterial()
        phaseValue = BluetoothDirectControlClientPhaseV1.FAILED
        return failure(reason)
    }

    private fun incrementSequence(value: Long): Long =
        (value + 1L) and BluetoothDirectControlCodecV1.MAX_SEQUENCE

    private fun ready(
        payload: ByteArray,
        messageType: BluetoothDirectControlMessageTypeV1,
        sequence: Long? = null,
        closeReason: BluetoothDirectControlCloseReasonV1? = null
    ) = BluetoothDirectControlResultV1.Ready(
        payload.copyOf(),
        messageType,
        sequence,
        closeReason
    )

    private fun failure(reason: BluetoothDirectControlFailureV1) =
        BluetoothDirectControlResultV1.Failure(reason)
}
