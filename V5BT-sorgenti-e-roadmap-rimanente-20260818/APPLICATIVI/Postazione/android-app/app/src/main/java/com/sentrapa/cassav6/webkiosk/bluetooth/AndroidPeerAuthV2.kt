package com.sentrapa.cassav6.webkiosk.bluetooth

import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

internal enum class AndroidPeerAuthMessageTypeV2(val wire: Int) {
    CLIENT_INIT(1), SERVER_REPLY(2), CLIENT_FINISH(3)
}

internal data class AndroidPeerAuthBindingV2 private constructor(
    val clientHello: BluetoothHelloV1,
    val serverHello: BluetoothHelloV1,
    val clientCertificateId: String,
    val serverCertificateId: String,
    val aliasEpoch: Long,
    val clientAlias: String,
    val serverAlias: String,
    val clientRole: String,
    val serverRole: String,
    val orderedNodeIds: List<String>
) {
    companion object {
        private val uuidPattern = Regex(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-" +
                "[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        )
        private val aliasPattern = Regex("^[0-9a-f]{12}$")

        fun create(
            clientHello: BluetoothHelloV1,
            serverHello: BluetoothHelloV1,
            clientCertificateId: String,
            serverCertificateId: String,
            aliasEpoch: Long,
            clientAlias: String,
            serverAlias: String,
            clientRole: String = "CLIENT",
            serverRole: String = "SERVER"
        ): AndroidPeerAuthBindingV2 {
            val client = BluetoothHelloCodecV1.validate(clientHello)
            val server = BluetoothHelloCodecV1.validate(serverHello)
            require(client.sessionId == server.sessionId)
            require(client.nodeId != server.nodeId && client.nonce != server.nonce)
            require(uuidPattern.matches(clientCertificateId))
            require(uuidPattern.matches(serverCertificateId))
            require(clientCertificateId != serverCertificateId)
            require(aliasEpoch >= 0)
            require(aliasPattern.matches(clientAlias))
            require(aliasPattern.matches(serverAlias) && clientAlias != serverAlias)
            require(clientRole == "CLIENT" && serverRole == "SERVER")
            return AndroidPeerAuthBindingV2(
                client, server, clientCertificateId, serverCertificateId,
                aliasEpoch, clientAlias, serverAlias, clientRole, serverRole,
                listOf(client.nodeId, server.nodeId).sorted()
            )
        }
    }
}

internal data class AndroidPeerAuthClientInitV2(
    val sessionId: String,
    val clientCertificateId: String,
    val serverCertificateId: String,
    val clientEphemeralSpki: ByteArray,
    val clientSignature: ByteArray
)

internal data class AndroidPeerAuthServerReplyV2(
    val sessionId: String,
    val clientCertificateId: String,
    val serverCertificateId: String,
    val serverEphemeralSpki: ByteArray,
    val serverSignature: ByteArray,
    val serverConfirmation: ByteArray
)

internal data class AndroidPeerAuthClientFinishV2(
    val sessionId: String,
    val clientConfirmation: ByteArray
)

internal object AndroidPeerAuthCodecV2 {
    const val PROTOCOL_VERSION = 2
    const val CLIENT_INIT_BYTES = 158
    const val SERVER_REPLY_BYTES = 190
    const val CLIENT_FINISH_BYTES = 50
    const val MINIMUM_MTU = SERVER_REPLY_BYTES + 3

    private const val BINDING_CONTEXT =
        "CASSA_V6-BT-ANDROID-A2-BINDING-V2\u0000"
    private const val CLIENT_SIGNATURE_CONTEXT =
        "CASSA_V6-BT-ANDROID-A2-CLIENT-SIGN-V2\u0000"
    private const val SERVER_SIGNATURE_CONTEXT =
        "CASSA_V6-BT-ANDROID-A2-SERVER-SIGN-V2\u0000"
    private const val TRANSCRIPT_CONTEXT =
        "CASSA_V6-BT-ANDROID-A2-TRANSCRIPT-V2\u0000"
    internal const val HKDF_CONTEXT =
        "CASSA_V6-BT-ANDROID-A2-KEYS-V2\u0000"
    internal const val SERVER_CONFIRM_CONTEXT =
        "CASSA_V6-BT-ANDROID-A2-SERVER-CONFIRM-V2\u0000"
    internal const val CLIENT_CONFIRM_CONTEXT =
        "CASSA_V6-BT-ANDROID-A2-CLIENT-CONFIRM-V2\u0000"

    fun clientSignatureMessage(
        binding: AndroidPeerAuthBindingV2,
        clientEphemeralSpki: ByteArray
    ): ByteArray {
        val bound = bindingBytes(binding)
        val key = BluetoothDirectControlCodecV1.normalizeX25519PublicKeySpki(
            clientEphemeralSpki
        )
        val context = CLIENT_SIGNATURE_CONTEXT.encodeToByteArray()
        return try {
            concatenate(context, bound, key)
        } finally {
            context.fill(0)
            bound.fill(0)
            key.fill(0)
        }
    }

    fun serverSignatureMessage(
        binding: AndroidPeerAuthBindingV2,
        clientEphemeralSpki: ByteArray,
        clientSignature: ByteArray,
        serverEphemeralSpki: ByteArray
    ): ByteArray {
        val bound = bindingBytes(binding)
        val clientKey = BluetoothDirectControlCodecV1.normalizeX25519PublicKeySpki(
            clientEphemeralSpki
        )
        val clientProof = exact(clientSignature, 64, "clientSignature")
        val serverKey = BluetoothDirectControlCodecV1.normalizeX25519PublicKeySpki(
            serverEphemeralSpki
        )
        val context = SERVER_SIGNATURE_CONTEXT.encodeToByteArray()
        return try {
            concatenate(context, bound, clientKey, clientProof, serverKey)
        } finally {
            context.fill(0)
            bound.fill(0)
            clientKey.fill(0)
            clientProof.fill(0)
            serverKey.fill(0)
        }
    }

    fun transcriptHash(
        binding: AndroidPeerAuthBindingV2,
        clientEphemeralSpki: ByteArray,
        clientSignature: ByteArray,
        serverEphemeralSpki: ByteArray,
        serverSignature: ByteArray
    ): ByteArray {
        val message = serverSignatureMessage(
            binding,
            clientEphemeralSpki,
            clientSignature,
            serverEphemeralSpki
        )
        val proof = exact(serverSignature, 64, "serverSignature")
        val context = TRANSCRIPT_CONTEXT.encodeToByteArray()
        return try {
            MessageDigest.getInstance("SHA-256").run {
                update(context)
                update(message)
                digest(proof)
            }
        } finally {
            context.fill(0)
            message.fill(0)
            proof.fill(0)
        }
    }

    fun encodeClientInit(value: AndroidPeerAuthClientInitV2): ByteArray =
        encodeCommon(
            AndroidPeerAuthMessageTypeV2.CLIENT_INIT,
            value.sessionId,
            value.clientCertificateId,
            value.serverCertificateId,
            value.clientEphemeralSpki,
            value.clientSignature,
            null
        )

    fun decodeClientInit(value: ByteArray): AndroidPeerAuthClientInitV2 {
        header(value, CLIENT_INIT_BYTES, AndroidPeerAuthMessageTypeV2.CLIENT_INIT)
        return AndroidPeerAuthClientInitV2(
            sessionId(value.copyOfRange(2, 18)),
            uuid(value, 18),
            uuid(value, 34),
            value.copyOfRange(50, 94).also {
                BluetoothDirectControlCodecV1.normalizeX25519PublicKeySpki(it).fill(0)
            },
            value.copyOfRange(94, 158)
        )
    }

    fun encodeServerReply(value: AndroidPeerAuthServerReplyV2): ByteArray =
        encodeCommon(
            AndroidPeerAuthMessageTypeV2.SERVER_REPLY,
            value.sessionId,
            value.clientCertificateId,
            value.serverCertificateId,
            value.serverEphemeralSpki,
            value.serverSignature,
            value.serverConfirmation
        )

    fun decodeServerReply(value: ByteArray): AndroidPeerAuthServerReplyV2 {
        header(value, SERVER_REPLY_BYTES, AndroidPeerAuthMessageTypeV2.SERVER_REPLY)
        return AndroidPeerAuthServerReplyV2(
            sessionId(value.copyOfRange(2, 18)),
            uuid(value, 18),
            uuid(value, 34),
            value.copyOfRange(50, 94).also {
                BluetoothDirectControlCodecV1.normalizeX25519PublicKeySpki(it).fill(0)
            },
            value.copyOfRange(94, 158),
            value.copyOfRange(158, 190)
        )
    }

    fun encodeClientFinish(value: AndroidPeerAuthClientFinishV2): ByteArray {
        val session = BluetoothHelloCodecV1.canonicalIdentifierBytes(
            value.sessionId,
            "sessionId"
        )
        val confirmation = exact(value.clientConfirmation, 32, "clientConfirmation")
        return ByteArray(CLIENT_FINISH_BYTES).also { output ->
            try {
                output[0] = PROTOCOL_VERSION.toByte()
                output[1] = AndroidPeerAuthMessageTypeV2.CLIENT_FINISH.wire.toByte()
                session.copyInto(output, 2)
                confirmation.copyInto(output, 18)
            } finally {
                session.fill(0)
                confirmation.fill(0)
            }
        }
    }

    fun decodeClientFinish(value: ByteArray): AndroidPeerAuthClientFinishV2 {
        header(value, CLIENT_FINISH_BYTES, AndroidPeerAuthMessageTypeV2.CLIENT_FINISH)
        return AndroidPeerAuthClientFinishV2(
            sessionId(value.copyOfRange(2, 18)),
            value.copyOfRange(18, 50)
        )
    }

    private fun encodeCommon(
        type: AndroidPeerAuthMessageTypeV2,
        sessionId: String,
        clientCertificateId: String,
        serverCertificateId: String,
        ephemeralSpki: ByteArray,
        signature: ByteArray,
        confirmation: ByteArray?
    ): ByteArray {
        val session = BluetoothHelloCodecV1.canonicalIdentifierBytes(
            sessionId,
            "sessionId"
        )
        val clientCertificate = uuidBytes(clientCertificateId)
        val serverCertificate = uuidBytes(serverCertificateId)
        val key = BluetoothDirectControlCodecV1.normalizeX25519PublicKeySpki(
            ephemeralSpki
        )
        val proof = exact(signature, 64, "signature")
        val confirm = confirmation?.let { exact(it, 32, "confirmation") }
        val size = if (confirm == null) CLIENT_INIT_BYTES else SERVER_REPLY_BYTES
        return ByteArray(size).also { output ->
            try {
                output[0] = PROTOCOL_VERSION.toByte()
                output[1] = type.wire.toByte()
                session.copyInto(output, 2)
                clientCertificate.copyInto(output, 18)
                serverCertificate.copyInto(output, 34)
                key.copyInto(output, 50)
                proof.copyInto(output, 94)
                confirm?.copyInto(output, 158)
            } finally {
                session.fill(0)
                clientCertificate.fill(0)
                serverCertificate.fill(0)
                key.fill(0)
                proof.fill(0)
                confirm?.fill(0)
            }
        }
    }

    private fun bindingBytes(binding: AndroidPeerAuthBindingV2): ByteArray {
        val clientHello = BluetoothHelloCodecV1.encode(binding.clientHello)
        val serverHello = BluetoothHelloCodecV1.encode(binding.serverHello)
        val clientCertificate = uuidBytes(binding.clientCertificateId)
        val serverCertificate = uuidBytes(binding.serverCertificateId)
        val lowNode = uuidBytes(binding.orderedNodeIds[0])
        val highNode = uuidBytes(binding.orderedNodeIds[1])
        val epoch = ByteBuffer.allocate(8).putLong(binding.aliasEpoch).array()
        val aliases = hex(binding.clientAlias + binding.serverAlias)
        val roles = "CLIENT\u0000SERVER\u0000".encodeToByteArray()
        val context = BINDING_CONTEXT.encodeToByteArray()
        return try {
            concatenate(
                context, clientHello, serverHello, clientCertificate,
                serverCertificate, lowNode, highNode, epoch, aliases, roles
            )
        } finally {
            listOf(
                context, clientHello, serverHello, clientCertificate,
                serverCertificate, lowNode, highNode, epoch, aliases, roles
            ).forEach { it.fill(0) }
        }
    }

    internal fun exact(value: ByteArray, length: Int, field: String): ByteArray {
        require(value.size == length) { "$field must contain exactly $length bytes" }
        return value.copyOf()
    }

    internal fun concatenate(vararg values: ByteArray): ByteArray {
        val output = ByteArray(values.fold(0) { total, bytes ->
            Math.addExact(total, bytes.size)
        })
        var offset = 0
        values.forEach { bytes ->
            bytes.copyInto(output, offset)
            offset += bytes.size
        }
        return output
    }

    private fun header(
        value: ByteArray,
        size: Int,
        type: AndroidPeerAuthMessageTypeV2
    ) {
        require(value.size == size)
        require(value[0].toInt() and 0xff == PROTOCOL_VERSION)
        require(value[1].toInt() and 0xff == type.wire)
    }

    private fun sessionId(bytes: ByteArray): String = try {
        BluetoothHelloCodecV1.canonicalIdentifier(bytes).also {
            BluetoothHelloCodecV1.canonicalIdentifierBytes(it, "sessionId").fill(0)
        }
    } finally {
        bytes.fill(0)
    }

    private fun uuid(value: ByteArray, offset: Int): String =
        ByteBuffer.wrap(value, offset, 16).run { UUID(long, long).toString() }

    private fun uuidBytes(value: String): ByteArray {
        val parsed = UUID.fromString(value)
        require(parsed.toString() == value)
        return ByteBuffer.allocate(16)
            .putLong(parsed.mostSignificantBits)
            .putLong(parsed.leastSignificantBits)
            .array()
    }

    private fun hex(value: String): ByteArray {
        require(value.length % 2 == 0 && value.matches(Regex("^[0-9a-f]+$")))
        return ByteArray(value.length / 2) { index ->
            value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }
}

internal class AndroidPeerLocalIdentityV2(
    val nodeId: String,
    val certificateId: String,
    val publicKeyAlgorithm: String,
    publicKeySpkiDer: ByteArray,
    val signer: BluetoothMutualAuthIdentityPort
) {
    val peerTrustId: String = deriveBluetoothPeerTrustIdV1(
        nodeId,
        certificateId,
        publicKeyAlgorithm,
        publicKeySpkiDer
    )
}

internal class AndroidPeerAuthenticatedMaterialV2(
    val peerTrustId: String,
    clientToServerControlKey: ByteArray,
    serverToClientControlKey: ByteArray
) : AutoCloseable {
    private var clientToServer = clientToServerControlKey.copyOf()
    private var serverToClient = serverToClientControlKey.copyOf()
    private var consumed = false
    private var closed = false

    @Synchronized
    fun takeReliableChannelMaterial(): ReliableChannelMaterialV1 {
        check(!consumed && !closed) { "A2 reliable material is unavailable" }
        val output = deriveReliableChannelMaterialV1(clientToServer, serverToClient)
        consumed = true
        close()
        return output
    }

    @Synchronized
    fun handoffToGattSession(
        sessionToken: Long,
        mtu: Int,
        role: GattReliableEndpointRoleV1,
        leaseValidator: AndroidPeerTrustLeaseValidatorV2
    ): AndroidGattPeerReliableSessionV2 {
        check(!consumed && !closed) { "A2 reliable material is unavailable" }
        val output = AndroidGattPeerReliableSessionV2(
            sessionToken,
            peerTrustId,
            mtu,
            role,
            clientToServer,
            serverToClient,
            leaseValidator
        )
        consumed = true
        close()
        return output
    }

    @Synchronized
    override fun close() {
        if (closed) return
        clientToServer.fill(0)
        serverToClient.fill(0)
        closed = true
    }

    override fun toString(): String =
        "AndroidPeerAuthenticatedMaterialV2(peerTrustId=<redacted>, material=<redacted>)"
}

internal class AndroidPeerAuthKeyScheduleV2 private constructor(
    material: ByteArray,
    transcriptHash: ByteArray
) : AutoCloseable {
    private var clientToServer: ByteArray? = material.copyOfRange(0, 32)
    private var serverToClient: ByteArray? = material.copyOfRange(32, 64)
    private var clientConfirmation: ByteArray? = material.copyOfRange(64, 96)
    private var serverConfirmation: ByteArray? = material.copyOfRange(96, 128)
    private var transcript: ByteArray? = transcriptHash.copyOf()
    private var confirmed = false

    @Synchronized
    fun createServerConfirmation(): ByteArray = mac(
        open(serverConfirmation),
        AndroidPeerAuthCodecV2.SERVER_CONFIRM_CONTEXT.encodeToByteArray(),
        open(transcript)
    )

    @Synchronized
    fun verifyServerConfirmation(value: ByteArray): Boolean {
        if (value.size != 32) return false
        val expected = createServerConfirmation()
        return try {
            MessageDigest.isEqual(expected, value)
        } finally {
            expected.fill(0)
        }
    }

    @Synchronized
    fun createClientConfirmation(serverProof: ByteArray): ByteArray {
        val server = AndroidPeerAuthCodecV2.exact(serverProof, 32, "serverConfirmation")
        var message: ByteArray? = null
        return try {
            message = AndroidPeerAuthCodecV2.concatenate(open(transcript), server)
            mac(
                open(clientConfirmation),
                AndroidPeerAuthCodecV2.CLIENT_CONFIRM_CONTEXT.encodeToByteArray(),
                checkNotNull(message)
            )
        } finally {
            server.fill(0)
            message?.fill(0)
        }
    }

    @Synchronized
    fun verifyClientConfirmation(
        serverProof: ByteArray,
        clientProof: ByteArray
    ): Boolean {
        if (clientProof.size != 32) return false
        val expected = createClientConfirmation(serverProof)
        return try {
            MessageDigest.isEqual(expected, clientProof).also {
                if (it) confirmed = true
            }
        } finally {
            expected.fill(0)
        }
    }

    @Synchronized
    fun confirmClientFinishTransmitted() {
        checkNotNull(transcript) { "A2 keys were cleared" }
        confirmed = true
    }

    @Synchronized
    fun promote(peerTrustId: String): AndroidPeerAuthenticatedMaterialV2 {
        check(confirmed) { "A2 confirmation is required before key handoff" }
        require(BLUETOOTH_PEER_TRUST_ID_PATTERN_V1.matches(peerTrustId))
        val output = AndroidPeerAuthenticatedMaterialV2(
            peerTrustId,
            open(clientToServer),
            open(serverToClient)
        )
        close()
        return output
    }

    @Synchronized
    override fun close() {
        listOf(
            clientToServer, serverToClient, clientConfirmation,
            serverConfirmation, transcript
        ).forEach { it?.fill(0) }
        clientToServer = null
        serverToClient = null
        clientConfirmation = null
        serverConfirmation = null
        transcript = null
        confirmed = false
    }

    private fun open(value: ByteArray?): ByteArray =
        checkNotNull(value) { "A2 keys were cleared" }

    private fun mac(key: ByteArray, context: ByteArray, message: ByteArray): ByteArray =
        try {
            Mac.getInstance("HmacSHA256").run {
                init(SecretKeySpec(key, "HmacSHA256"))
                update(context)
                doFinal(message)
            }
        } finally {
            context.fill(0)
        }

    companion object {
        fun derive(
            sharedSecret: ByteArray,
            transcriptHash: ByteArray
        ): AndroidPeerAuthKeyScheduleV2 {
            require(sharedSecret.size == 32) { "sharedSecret must contain exactly 32 bytes" }
            require(transcriptHash.size == 32) {
                "transcriptHash must contain exactly 32 bytes"
            }
            val secret = AndroidPeerAuthCodecV2.exact(sharedSecret, 32, "sharedSecret")
            val transcript = AndroidPeerAuthCodecV2.exact(
                transcriptHash,
                32,
                "transcriptHash"
            )
            var context: ByteArray? = null
            var info: ByteArray? = null
            var material: ByteArray? = null
            return try {
                require(secret.any { it.toInt() != 0 })
                context = AndroidPeerAuthCodecV2.HKDF_CONTEXT.encodeToByteArray()
                info = AndroidPeerAuthCodecV2.concatenate(context, transcript)
                material = hkdf(secret, transcript, checkNotNull(info), 128)
                AndroidPeerAuthKeyScheduleV2(material, transcript)
            } finally {
                secret.fill(0)
                transcript.fill(0)
                context?.fill(0)
                info?.fill(0)
                material?.fill(0)
            }
        }

        private fun hkdf(
            inputKey: ByteArray,
            salt: ByteArray,
            info: ByteArray,
            length: Int
        ): ByteArray {
            val prk = hmac(salt, inputKey)
            val output = ByteArray(length)
            var previous = ByteArray(0)
            var offset = 0
            var block = 1
            try {
                while (offset < output.size) {
                    val input = AndroidPeerAuthCodecV2.concatenate(
                        previous,
                        info,
                        byteArrayOf(block.toByte())
                    )
                    val next = try {
                        hmac(prk, input)
                    } finally {
                        input.fill(0)
                    }
                    previous.fill(0)
                    previous = next
                    val count = minOf(next.size, output.size - offset)
                    next.copyInto(output, offset, 0, count)
                    offset += count
                    block += 1
                }
                return output
            } finally {
                prk.fill(0)
                previous.fill(0)
            }
        }

        private fun hmac(key: ByteArray, value: ByteArray): ByteArray =
            Mac.getInstance("HmacSHA256").run {
                init(SecretKeySpec(key, "HmacSHA256"))
                doFinal(value)
            }
    }
}

internal class AndroidPeerAuthClientExchangeV2(
    private val binding: AndroidPeerAuthBindingV2,
    private val localIdentity: AndroidPeerLocalIdentityV2,
    private val trustedServer: AndroidResolvedPeerTrustV1,
    private val keyAgreementFactory: BluetoothDirectControlKeyAgreementFactoryV1 =
        JcaBluetoothDirectControlKeyAgreementFactoryV1
) : AutoCloseable {
    private var agreement: BluetoothDirectControlKeyAgreementV1? = null
    private var clientEphemeral: ByteArray? = null
    private var clientSignature: ByteArray? = null
    private var serverConfirmation: ByteArray? = null
    private var schedule: AndroidPeerAuthKeyScheduleV2? = null

    init {
        require(localIdentity.nodeId == binding.clientHello.nodeId)
        require(localIdentity.certificateId == binding.clientCertificateId)
        require(trustedServer.entry.nodeId == binding.serverHello.nodeId)
        require(trustedServer.entry.certificateId == binding.serverCertificateId)
        require(trustedServer.observedEpoch == binding.aliasEpoch)
        require(trustedServer.observedAlias == binding.serverAlias)
    }

    @Synchronized
    fun start(): ByteArray {
        check(agreement == null && schedule == null)
        var nextAgreement: BluetoothDirectControlKeyAgreementV1? = null
        var ephemeral: ByteArray? = null
        var proof: ByteArray? = null
        var committed = false
        try {
            nextAgreement = keyAgreementFactory.create()
            ephemeral = nextAgreement.publicKeySpki()
            val message = AndroidPeerAuthCodecV2.clientSignatureMessage(
                binding,
                ephemeral
            )
            val result = try {
                localIdentity.signer.sign(message)
            } finally {
                message.fill(0)
            }
            proof = result.signature
            val readyProof = proof
            if (
                result.status != DeviceIdentityStatus.READY ||
                readyProof == null ||
                readyProof.size != 64
            ) throw IllegalStateException("local A2 client signature failed")
            val readyEphemeral = checkNotNull(ephemeral)
            val encoded = AndroidPeerAuthCodecV2.encodeClientInit(
                AndroidPeerAuthClientInitV2(
                    binding.clientHello.sessionId,
                    binding.clientCertificateId,
                    binding.serverCertificateId,
                    readyEphemeral,
                    readyProof
                )
            )
            clientEphemeral = readyEphemeral.copyOf()
            clientSignature = readyProof.copyOf()
            agreement = nextAgreement
            committed = true
            return encoded
        } finally {
            ephemeral?.fill(0)
            proof?.fill(0)
            if (!committed) {
                nextAgreement?.close()
                clearTransient()
            }
        }
    }

    @Synchronized
    fun acceptServerReply(payload: ByteArray): ByteArray {
        val response = AndroidPeerAuthCodecV2.decodeServerReply(payload)
        var nextSchedule: AndroidPeerAuthKeyScheduleV2? = null
        var finish: ByteArray? = null
        try {
            require(schedule == null)
            require(response.sessionId == binding.clientHello.sessionId)
            require(response.clientCertificateId == binding.clientCertificateId)
            require(response.serverCertificateId == binding.serverCertificateId)
            val clientKey = checkNotNull(clientEphemeral)
            val clientProof = checkNotNull(clientSignature)
            val signatureMessage = AndroidPeerAuthCodecV2.serverSignatureMessage(
                binding,
                clientKey,
                clientProof,
                response.serverEphemeralSpki
            )
            val verified = try {
                AndroidPeerTrustDirectoryCodecV1.verifyPeerSignature(
                    trustedServer.entry,
                    signatureMessage,
                    response.serverSignature
                )
            } finally {
                signatureMessage.fill(0)
            }
            require(verified) { "trusted A2 server signature is invalid" }
            val transcript = AndroidPeerAuthCodecV2.transcriptHash(
                binding,
                clientKey,
                clientProof,
                response.serverEphemeralSpki,
                response.serverSignature
            )
            val secret = checkNotNull(agreement).deriveSharedSecret(
                response.serverEphemeralSpki
            )
            val derivedSchedule = try {
                AndroidPeerAuthKeyScheduleV2.derive(secret, transcript)
            } finally {
                secret.fill(0)
                transcript.fill(0)
            }
            nextSchedule = derivedSchedule
            require(derivedSchedule.verifyServerConfirmation(response.serverConfirmation)) {
                "A2 server key confirmation is invalid"
            }
            finish = derivedSchedule.createClientConfirmation(
                response.serverConfirmation
            )
            val encoded = AndroidPeerAuthCodecV2.encodeClientFinish(
                AndroidPeerAuthClientFinishV2(binding.clientHello.sessionId, finish)
            )
            serverConfirmation = response.serverConfirmation.copyOf()
            schedule = derivedSchedule
            nextSchedule = null
            return encoded
        } finally {
            nextSchedule?.close()
            finish?.fill(0)
            response.serverEphemeralSpki.fill(0)
            response.serverSignature.fill(0)
            response.serverConfirmation.fill(0)
        }
    }

    @Synchronized
    fun confirmFinishTransmitted(): AndroidPeerAuthenticatedMaterialV2 {
        val active = checkNotNull(schedule) { "A2 client finish is not ready" }
        active.confirmClientFinishTransmitted()
        val material = active.promote(trustedServer.peerTrustId)
        schedule = null
        clearTransient()
        return material
    }

    @Synchronized
    override fun close() {
        schedule?.close()
        schedule = null
        clearTransient()
    }

    private fun clearTransient() {
        agreement?.close()
        agreement = null
        clientEphemeral?.fill(0)
        clientEphemeral = null
        clientSignature?.fill(0)
        clientSignature = null
        serverConfirmation?.fill(0)
        serverConfirmation = null
    }
}

internal class AndroidPeerAuthServerExchangeV2(
    private val binding: AndroidPeerAuthBindingV2,
    private val localIdentity: AndroidPeerLocalIdentityV2,
    private val trustedClient: AndroidResolvedPeerTrustV1,
    private val keyAgreementFactory: BluetoothDirectControlKeyAgreementFactoryV1 =
        JcaBluetoothDirectControlKeyAgreementFactoryV1
) : AutoCloseable {
    private var schedule: AndroidPeerAuthKeyScheduleV2? = null
    private var serverConfirmation: ByteArray? = null

    init {
        require(localIdentity.nodeId == binding.serverHello.nodeId)
        require(localIdentity.certificateId == binding.serverCertificateId)
        require(trustedClient.entry.nodeId == binding.clientHello.nodeId)
        require(trustedClient.entry.certificateId == binding.clientCertificateId)
        require(trustedClient.observedEpoch == binding.aliasEpoch)
        require(trustedClient.observedAlias == binding.clientAlias)
    }

    @Synchronized
    fun acceptClientInit(payload: ByteArray): ByteArray {
        check(schedule == null)
        val request = AndroidPeerAuthCodecV2.decodeClientInit(payload)
        var agreement: BluetoothDirectControlKeyAgreementV1? = null
        var serverEphemeral: ByteArray? = null
        var serverSignature: ByteArray? = null
        var nextSchedule: AndroidPeerAuthKeyScheduleV2? = null
        var confirm: ByteArray? = null
        try {
            require(request.sessionId == binding.clientHello.sessionId)
            require(request.clientCertificateId == binding.clientCertificateId)
            require(request.serverCertificateId == binding.serverCertificateId)
            val clientMessage = AndroidPeerAuthCodecV2.clientSignatureMessage(
                binding,
                request.clientEphemeralSpki
            )
            val verified = try {
                AndroidPeerTrustDirectoryCodecV1.verifyPeerSignature(
                    trustedClient.entry,
                    clientMessage,
                    request.clientSignature
                )
            } finally {
                clientMessage.fill(0)
            }
            require(verified) { "trusted A2 client signature is invalid" }
            agreement = keyAgreementFactory.create()
            serverEphemeral = agreement.publicKeySpki()
            val serverMessage = AndroidPeerAuthCodecV2.serverSignatureMessage(
                binding,
                request.clientEphemeralSpki,
                request.clientSignature,
                serverEphemeral
            )
            val signatureResult = try {
                localIdentity.signer.sign(serverMessage)
            } finally {
                serverMessage.fill(0)
            }
            serverSignature = signatureResult.signature
            val readySignature = serverSignature
            if (
                signatureResult.status != DeviceIdentityStatus.READY ||
                readySignature == null ||
                readySignature.size != 64
            ) throw IllegalStateException("local A2 server signature failed")
            val readyEphemeral = checkNotNull(serverEphemeral)
            val transcript = AndroidPeerAuthCodecV2.transcriptHash(
                binding,
                request.clientEphemeralSpki,
                request.clientSignature,
                readyEphemeral,
                readySignature
            )
            val secret = agreement.deriveSharedSecret(request.clientEphemeralSpki)
            val derivedSchedule = try {
                AndroidPeerAuthKeyScheduleV2.derive(secret, transcript)
            } finally {
                secret.fill(0)
                transcript.fill(0)
            }
            nextSchedule = derivedSchedule
            confirm = derivedSchedule.createServerConfirmation()
            val encoded = AndroidPeerAuthCodecV2.encodeServerReply(
                AndroidPeerAuthServerReplyV2(
                    binding.clientHello.sessionId,
                    binding.clientCertificateId,
                    binding.serverCertificateId,
                    readyEphemeral,
                    readySignature,
                    checkNotNull(confirm)
                )
            )
            serverConfirmation = checkNotNull(confirm).copyOf()
            schedule = derivedSchedule
            nextSchedule = null
            return encoded
        } finally {
            agreement?.close()
            nextSchedule?.close()
            request.clientEphemeralSpki.fill(0)
            request.clientSignature.fill(0)
            serverEphemeral?.fill(0)
            serverSignature?.fill(0)
            confirm?.fill(0)
        }
    }

    @Synchronized
    fun acceptClientFinish(payload: ByteArray): AndroidPeerAuthenticatedMaterialV2 {
        val finish = AndroidPeerAuthCodecV2.decodeClientFinish(payload)
        try {
            require(finish.sessionId == binding.clientHello.sessionId)
            val active = checkNotNull(schedule) { "A2 server reply is not ready" }
            require(
                active.verifyClientConfirmation(
                    checkNotNull(serverConfirmation),
                    finish.clientConfirmation
                )
            ) { "A2 client key confirmation is invalid" }
            val material = active.promote(trustedClient.peerTrustId)
            schedule = null
            serverConfirmation?.fill(0)
            serverConfirmation = null
            return material
        } finally {
            finish.clientConfirmation.fill(0)
        }
    }

    @Synchronized
    override fun close() {
        schedule?.close()
        schedule = null
        serverConfirmation?.fill(0)
        serverConfirmation = null
    }
}
