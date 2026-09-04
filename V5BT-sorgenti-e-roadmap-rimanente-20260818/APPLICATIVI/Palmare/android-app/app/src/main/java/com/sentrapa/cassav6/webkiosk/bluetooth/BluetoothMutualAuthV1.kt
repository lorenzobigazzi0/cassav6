package com.sentrapa.cassav6.webkiosk.bluetooth

import java.nio.ByteBuffer
import java.util.UUID

data class BluetoothMutualAuthBindingV1(
    val clientHello: BluetoothHelloV1,
    val serverHello: BluetoothHelloV1,
    val deviceCertificateId: String
)

data class BluetoothAuthServerProofV1(
    val protocolVersion: Int,
    val sessionId: String,
    val deviceCertificateId: String,
    val proof: ByteArray
)

interface BluetoothMutualAuthIdentityPort {
    fun sign(message: ByteArray): DeviceSignatureResult

    fun createAuthenticationMac(message: ByteArray): DeviceAuthenticationMacResult

    fun verifyAuthenticationMac(
        message: ByteArray,
        proof: ByteArray
    ): DeviceAuthenticationMacVerificationResult
}

enum class BluetoothMutualAuthExchangeFailure {
    STATE_INVALID,
    IDENTITY_NOT_READY,
    CLIENT_SIGNATURE_INVALID,
    SERVER_PROOF_INVALID,
    SERVER_PROOF_REJECTED,
    FINISH_PROOF_FAILED
}

enum class BluetoothMutualAuthServerProofAudience {
    ACTIVE_BINDING,
    OTHER_BINDING,
    INVALID
}

sealed class BluetoothMutualAuthExchangeResult {
    data class Ready(val payload: ByteArray) : BluetoothMutualAuthExchangeResult()
    data class Failure(
        val reason: BluetoothMutualAuthExchangeFailure
    ) : BluetoothMutualAuthExchangeResult()
}

class AndroidMutualAuthExchangeV1(
    private val identity: BluetoothMutualAuthIdentityPort,
    initialBinding: BluetoothMutualAuthBindingV1
) {
    private var binding: BluetoothMutualAuthBindingV1? =
        BluetoothMutualAuthCodecV1.createBinding(
            initialBinding.clientHello,
            initialBinding.serverHello,
            initialBinding.deviceCertificateId
        )
    private var clientSignature: ByteArray? = null
    private var acceptedServerWire: ByteArray? = null
    private var finishWire: ByteArray? = null
    private var completed = false

    @Synchronized
    fun createClientProof(): BluetoothMutualAuthExchangeResult {
        val current = binding
            ?: return failure(BluetoothMutualAuthExchangeFailure.STATE_INVALID)
        if (completed || finishWire != null) {
            return failure(BluetoothMutualAuthExchangeFailure.STATE_INVALID)
        }
        clientSignature?.let { signature ->
            return ready(
                BluetoothMutualAuthCodecV1.encodeClientProof(
                    current.clientHello.sessionId,
                    current.deviceCertificateId,
                    signature
                )
            )
        }

        val message = BluetoothMutualAuthCodecV1.buildClientProofMessage(current)
        val signatureResult =
            try {
                identity.sign(message)
            } finally {
                message.fill(0)
            }
        val signature = signatureResult.signature
        if (
            signatureResult.status != DeviceIdentityStatus.READY ||
            signature == null
        ) {
            signature?.fill(0)
            clear()
            return failure(
                BluetoothMutualAuthExchangeFailure.IDENTITY_NOT_READY
            )
        }
        if (signature.size != BluetoothMutualAuthCodecV1.SIGNATURE_BYTES) {
            signature.fill(0)
            clear()
            return failure(
                BluetoothMutualAuthExchangeFailure.CLIENT_SIGNATURE_INVALID
            )
        }
        clientSignature = signature.copyOf()
        signature.fill(0)
        return ready(
            BluetoothMutualAuthCodecV1.encodeClientProof(
                current.clientHello.sessionId,
                current.deviceCertificateId,
                checkNotNull(clientSignature)
            )
        )
    }

    @Synchronized
    fun acceptServerProof(
        payload: ByteArray
    ): BluetoothMutualAuthExchangeResult {
        val current = binding
            ?: return failure(BluetoothMutualAuthExchangeFailure.STATE_INVALID)
        val signature = clientSignature
            ?: return failure(BluetoothMutualAuthExchangeFailure.STATE_INVALID)
        if (completed) {
            return failure(BluetoothMutualAuthExchangeFailure.STATE_INVALID)
        }
        if (finishWire != null) {
            return if (acceptedServerWire?.contentEquals(payload) == true) {
                ready(checkNotNull(finishWire).copyOf())
            } else {
                failure(BluetoothMutualAuthExchangeFailure.SERVER_PROOF_REJECTED)
            }
        }

        val server =
            try {
                BluetoothMutualAuthCodecV1.decodeServerProof(payload)
            } catch (_: IllegalArgumentException) {
                clear()
                return failure(
                    BluetoothMutualAuthExchangeFailure.SERVER_PROOF_INVALID
                )
            }
        try {
            if (
                server.sessionId != current.clientHello.sessionId ||
                server.deviceCertificateId != current.deviceCertificateId
            ) {
                clear()
                return failure(
                    BluetoothMutualAuthExchangeFailure.SERVER_PROOF_REJECTED
                )
            }
            val serverMessage =
                BluetoothMutualAuthCodecV1.buildServerProofMessage(
                    current,
                    signature
                )
            val verified =
                try {
                    identity.verifyAuthenticationMac(
                        serverMessage,
                        server.proof
                    )
                } finally {
                    serverMessage.fill(0)
                }
            if (
                verified.status != DeviceIdentityStatus.READY ||
                !verified.verified
            ) {
                clear()
                return failure(
                    BluetoothMutualAuthExchangeFailure.SERVER_PROOF_REJECTED
                )
            }

            val finishMessage =
                BluetoothMutualAuthCodecV1.buildFinishProofMessage(
                    current,
                    signature,
                    server.proof
                )
            val finish =
                try {
                    identity.createAuthenticationMac(finishMessage)
                } finally {
                    finishMessage.fill(0)
                }
            val finishProof = finish.proof
            if (
                finish.status != DeviceIdentityStatus.READY ||
                finishProof == null ||
                finishProof.size != BluetoothMutualAuthCodecV1.PROOF_BYTES
            ) {
                finishProof?.fill(0)
                clear()
                return failure(
                    BluetoothMutualAuthExchangeFailure.FINISH_PROOF_FAILED
                )
            }
            val encoded =
                try {
                    BluetoothMutualAuthCodecV1.encodeFinish(
                        current.clientHello.sessionId,
                        finishProof
                    )
                } finally {
                    finishProof.fill(0)
                }
            acceptedServerWire = payload.copyOf()
            finishWire = encoded.copyOf()
            return ready(encoded)
        } finally {
            server.proof.fill(0)
        }
    }

    @Synchronized
    fun classifyServerProof(
        payload: ByteArray
    ): BluetoothMutualAuthServerProofAudience {
        val current =
            binding ?: return BluetoothMutualAuthServerProofAudience.INVALID
        val server =
            try {
                BluetoothMutualAuthCodecV1.decodeServerProof(payload)
            } catch (_: IllegalArgumentException) {
                return BluetoothMutualAuthServerProofAudience.INVALID
            }
        return try {
            if (
                server.sessionId == current.clientHello.sessionId &&
                server.deviceCertificateId == current.deviceCertificateId
            ) {
                BluetoothMutualAuthServerProofAudience.ACTIVE_BINDING
            } else {
                BluetoothMutualAuthServerProofAudience.OTHER_BINDING
            }
        } finally {
            server.proof.fill(0)
        }
    }

    @Synchronized
    fun directControlBinding(): BluetoothMutualAuthBindingV1? {
        val current = binding ?: return null
        if (finishWire == null || completed) return null
        return BluetoothMutualAuthCodecV1.createBinding(
            current.clientHello,
            current.serverHello,
            current.deviceCertificateId
        )
    }

    @Synchronized
    fun complete(): Boolean {
        if (binding == null || finishWire == null || completed) return false
        completed = true
        clearSensitiveMaterial()
        binding = null
        return true
    }

    @Synchronized
    fun clear() {
        completed = false
        clearSensitiveMaterial()
        binding = null
    }

    private fun clearSensitiveMaterial() {
        clientSignature?.fill(0)
        clientSignature = null
        acceptedServerWire?.fill(0)
        acceptedServerWire = null
        finishWire?.fill(0)
        finishWire = null
    }

    private fun ready(payload: ByteArray) =
        BluetoothMutualAuthExchangeResult.Ready(payload)

    private fun failure(reason: BluetoothMutualAuthExchangeFailure) =
        BluetoothMutualAuthExchangeResult.Failure(reason)
}

object BluetoothMutualAuthCodecV1 {
    const val PROTOCOL_VERSION = 1
    const val SIGNATURE_BYTES = 64
    const val PROOF_BYTES = 32
    const val CLIENT_PROOF_WIRE_BYTES = 98
    const val SERVER_PROOF_WIRE_BYTES = 66
    const val FINISH_WIRE_BYTES = 50
    const val MINIMUM_MTU = CLIENT_PROOF_WIRE_BYTES + 3

    private const val CLIENT_PROOF_TYPE = 1
    private const val SERVER_PROOF_TYPE = 2
    private const val FINISH_TYPE = 3
    private val uuidPattern =
        Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    fun createBinding(
        clientHello: BluetoothHelloV1,
        serverHello: BluetoothHelloV1,
        deviceCertificateId: String
    ): BluetoothMutualAuthBindingV1 {
        val client = BluetoothHelloCodecV1.validate(clientHello)
        val server = BluetoothHelloCodecV1.validate(serverHello)
        require(uuidPattern.matches(deviceCertificateId)) {
            "deviceCertificateId must be a canonical lowercase UUID"
        }
        require(client.sessionId == server.sessionId)
        require(client.nodeId != server.nodeId)
        require(client.nonce != server.nonce)
        require(
            client.capabilities and BluetoothCapabilityBitsV1.GATT_CLIENT != 0
        )
        require(
            server.capabilities and BluetoothCapabilityBitsV1.GATT_SERVER != 0
        )
        return BluetoothMutualAuthBindingV1(
            clientHello = client,
            serverHello = server,
            deviceCertificateId = deviceCertificateId
        )
    }

    fun buildClientProofMessage(
        binding: BluetoothMutualAuthBindingV1
    ): ByteArray = transcriptMessage(
        context = "CASSA_V6-BT-AUTH-CLIENT-V1\u0000",
        binding = binding
    )

    fun buildServerProofMessage(
        binding: BluetoothMutualAuthBindingV1,
        clientSignature: ByteArray
    ): ByteArray {
        val signature = exactCopy(clientSignature, SIGNATURE_BYTES, "clientSignature")
        return try {
            transcriptMessage(
                context = "CASSA_V6-BT-AUTH-SERVER-V1\u0000",
                binding = binding,
                suffixes = arrayOf(signature)
            )
        } finally {
            signature.fill(0)
        }
    }

    fun buildFinishProofMessage(
        binding: BluetoothMutualAuthBindingV1,
        clientSignature: ByteArray,
        serverProof: ByteArray
    ): ByteArray {
        val signature = exactCopy(clientSignature, SIGNATURE_BYTES, "clientSignature")
        val proof = exactCopy(serverProof, PROOF_BYTES, "serverProof")
        return try {
            transcriptMessage(
                context = "CASSA_V6-BT-AUTH-FINISH-V1\u0000",
                binding = binding,
                suffixes = arrayOf(signature, proof)
            )
        } finally {
            signature.fill(0)
            proof.fill(0)
        }
    }

    fun encodeClientProof(
        sessionId: String,
        deviceCertificateId: String,
        signature: ByteArray
    ): ByteArray {
        val session = BluetoothHelloCodecV1.canonicalIdentifierBytes(
            sessionId,
            "sessionId"
        )
        val certificate = uuidBytes(deviceCertificateId)
        val signatureCopy = exactCopy(signature, SIGNATURE_BYTES, "signature")
        return ByteArray(CLIENT_PROOF_WIRE_BYTES).also { output ->
            try {
                output[0] = PROTOCOL_VERSION.toByte()
                output[1] = CLIENT_PROOF_TYPE.toByte()
                session.copyInto(output, destinationOffset = 2)
                certificate.copyInto(output, destinationOffset = 18)
                signatureCopy.copyInto(output, destinationOffset = 34)
            } finally {
                session.fill(0)
                certificate.fill(0)
                signatureCopy.fill(0)
            }
        }
    }

    fun decodeServerProof(payload: ByteArray): BluetoothAuthServerProofV1 {
        validateHeader(payload, SERVER_PROOF_WIRE_BYTES, SERVER_PROOF_TYPE)
        val sessionBytes = payload.copyOfRange(2, 18)
        val certificateBytes = payload.copyOfRange(18, 34)
        return try {
            val sessionId =
                BluetoothHelloCodecV1.canonicalIdentifier(sessionBytes)
            BluetoothHelloCodecV1
                .canonicalIdentifierBytes(sessionId, "sessionId")
                .fill(0)
            BluetoothAuthServerProofV1(
                protocolVersion = PROTOCOL_VERSION,
                sessionId = sessionId,
                deviceCertificateId = uuidText(certificateBytes),
                proof = payload.copyOfRange(34, 66)
            )
        } finally {
            sessionBytes.fill(0)
            certificateBytes.fill(0)
        }
    }

    fun encodeFinish(sessionId: String, proof: ByteArray): ByteArray {
        val session = BluetoothHelloCodecV1.canonicalIdentifierBytes(
            sessionId,
            "sessionId"
        )
        val proofCopy = exactCopy(proof, PROOF_BYTES, "proof")
        return ByteArray(FINISH_WIRE_BYTES).also { output ->
            try {
                output[0] = PROTOCOL_VERSION.toByte()
                output[1] = FINISH_TYPE.toByte()
                session.copyInto(output, destinationOffset = 2)
                proofCopy.copyInto(output, destinationOffset = 18)
            } finally {
                session.fill(0)
                proofCopy.fill(0)
            }
        }
    }

    private fun transcriptMessage(
        context: String,
        binding: BluetoothMutualAuthBindingV1,
        suffixes: Array<ByteArray> = emptyArray()
    ): ByteArray {
        val normalized = createBinding(
            binding.clientHello,
            binding.serverHello,
            binding.deviceCertificateId
        )
        val contextBytes = context.toByteArray(Charsets.UTF_8)
        val clientHello = BluetoothHelloCodecV1.encode(normalized.clientHello)
        val serverHello = BluetoothHelloCodecV1.encode(normalized.serverHello)
        val certificate = uuidBytes(normalized.deviceCertificateId)
        return try {
            concatenate(
                arrayOf(contextBytes, clientHello, serverHello, certificate) +
                    suffixes
            )
        } finally {
            contextBytes.fill(0)
            clientHello.fill(0)
            serverHello.fill(0)
            certificate.fill(0)
        }
    }

    private fun validateHeader(
        payload: ByteArray,
        expectedLength: Int,
        expectedType: Int
    ) {
        require(payload.size == expectedLength)
        require(payload[0].toInt() and 0xff == PROTOCOL_VERSION)
        require(payload[1].toInt() and 0xff == expectedType)
    }

    private fun uuidBytes(value: String): ByteArray {
        require(uuidPattern.matches(value)) {
            "UUID must be canonical and lowercase"
        }
        val uuid = UUID.fromString(value)
        return ByteBuffer.allocate(16)
            .putLong(uuid.mostSignificantBits)
            .putLong(uuid.leastSignificantBits)
            .array()
    }

    private fun uuidText(value: ByteArray): String {
        require(value.size == 16)
        val buffer = ByteBuffer.wrap(value)
        val result = UUID(buffer.long, buffer.long).toString()
        require(uuidPattern.matches(result))
        return result
    }

    private fun exactCopy(
        value: ByteArray,
        expectedLength: Int,
        field: String
    ): ByteArray {
        require(value.size == expectedLength) {
            "$field must contain exactly $expectedLength bytes"
        }
        return value.copyOf()
    }

    private fun concatenate(values: Array<ByteArray>): ByteArray {
        val size = values.fold(0) { total, value ->
            Math.addExact(total, value.size)
        }
        return ByteArray(size).also { output ->
            var offset = 0
            for (value in values) {
                value.copyInto(output, destinationOffset = offset)
                offset += value.size
            }
        }
    }
}
