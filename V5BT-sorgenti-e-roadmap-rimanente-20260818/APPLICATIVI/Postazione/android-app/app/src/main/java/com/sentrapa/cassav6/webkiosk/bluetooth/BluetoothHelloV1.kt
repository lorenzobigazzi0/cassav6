package com.sentrapa.cassav6.webkiosk.bluetooth

import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.UUID

data class BluetoothHelloV1(
    val protocolVersion: Int,
    val sessionId: String,
    val nodeId: String,
    val bootId: Int,
    val capabilities: Int,
    val nonce: String
)

object BluetoothHelloCodecV1 {
    const val PROTOCOL_VERSION = 1
    const val IDENTIFIER_BYTES = 16
    const val WIRE_BYTES = 51
    const val ATT_HEADER_BYTES = 3
    const val MINIMUM_MTU = WIRE_BYTES + ATT_HEADER_BYTES

    private const val BASE64_URL_ALPHABET =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    private const val ZERO_IDENTIFIER = "AAAAAAAAAAAAAAAAAAAAAA"
    private val identifierPattern = Regex("^[A-Za-z0-9_-]{21}[AQgw]$")
    private val nodeIdPattern =
        Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    private val secureRandom = SecureRandom()

    fun validate(value: BluetoothHelloV1): BluetoothHelloV1 {
        require(value.protocolVersion == PROTOCOL_VERSION) {
            "unsupported HELLO protocol version"
        }
        decodeIdentifier(value.sessionId, "sessionId").fill(0)
        require(nodeIdPattern.matches(value.nodeId)) {
            "nodeId must be a canonical lowercase UUID"
        }
        require(value.bootId in 1..255) {
            "bootId must be between 1 and 255"
        }
        require(value.capabilities in 0..BluetoothCapabilityBitsV1.ALL_DEFINED) {
            "capabilities must use only defined bits"
        }
        decodeIdentifier(value.nonce, "nonce").fill(0)
        require(value.nonce != ZERO_IDENTIFIER) {
            "nonce must not be all zero"
        }
        return value
    }

    fun encode(value: BluetoothHelloV1): ByteArray {
        val normalized = validate(value)
        val sessionId = decodeIdentifier(normalized.sessionId, "sessionId")
        val nonce = decodeIdentifier(normalized.nonce, "nonce")
        return ByteArray(WIRE_BYTES).also { payload ->
            try {
                payload[0] = PROTOCOL_VERSION.toByte()
                sessionId.copyInto(payload, destinationOffset = 1)
                val uuid = UUID.fromString(normalized.nodeId)
                val buffer = ByteBuffer.wrap(payload)
                buffer.position(17)
                buffer.putLong(uuid.mostSignificantBits)
                buffer.putLong(uuid.leastSignificantBits)
                payload[33] = normalized.bootId.toByte()
                payload[34] = normalized.capabilities.toByte()
                nonce.copyInto(payload, destinationOffset = 35)
            } finally {
                sessionId.fill(0)
                nonce.fill(0)
            }
        }
    }

    fun decode(payload: ByteArray): BluetoothHelloV1 {
        require(payload.size == WIRE_BYTES) {
            "HELLO payload must contain exactly $WIRE_BYTES bytes"
        }
        val buffer = ByteBuffer.wrap(payload)
        val protocolVersion = buffer.get().toInt() and 0xff
        val sessionIdBytes = ByteArray(IDENTIFIER_BYTES)
        buffer.get(sessionIdBytes)
        val nodeId = UUID(buffer.long, buffer.long).toString()
        val bootId = buffer.get().toInt() and 0xff
        val capabilities = buffer.get().toInt() and 0xff
        val nonceBytes = ByteArray(IDENTIFIER_BYTES)
        buffer.get(nonceBytes)
        return try {
            validate(
                BluetoothHelloV1(
                    protocolVersion = protocolVersion,
                    sessionId = encodeIdentifier(sessionIdBytes),
                    nodeId = nodeId,
                    bootId = bootId,
                    capabilities = capabilities,
                    nonce = encodeIdentifier(nonceBytes)
                )
            )
        } finally {
            sessionIdBytes.fill(0)
            nonceBytes.fill(0)
        }
    }

    fun generateSessionId(
        randomBytes: (Int) -> ByteArray = ::secureRandomBytes
    ): String = randomIdentifier(randomBytes, allowZero = true)

    fun generateNonce(
        randomBytes: (Int) -> ByteArray = ::secureRandomBytes
    ): String = randomIdentifier(randomBytes, allowZero = false)

    internal fun canonicalIdentifierBytes(
        value: String,
        field: String
    ): ByteArray = decodeIdentifier(value, field)

    internal fun canonicalIdentifier(value: ByteArray): String {
        require(value.size == IDENTIFIER_BYTES)
        return encodeIdentifier(value)
    }

    private fun secureRandomBytes(length: Int): ByteArray =
        ByteArray(length).also(secureRandom::nextBytes)

    private fun randomIdentifier(
        randomBytes: (Int) -> ByteArray,
        allowZero: Boolean
    ): String {
        val value = randomBytes(IDENTIFIER_BYTES)
        require(value.size == IDENTIFIER_BYTES) {
            "random source returned the wrong byte count"
        }
        return try {
            val encoded = encodeIdentifier(value)
            require(allowZero || encoded != ZERO_IDENTIFIER) {
                "random source returned an all-zero nonce"
            }
            encoded
        } finally {
            value.fill(0)
        }
    }

    private fun decodeIdentifier(value: String, field: String): ByteArray {
        require(identifierPattern.matches(value)) {
            "$field must be canonical unpadded base64url"
        }
        val output = ByteArray(IDENTIFIER_BYTES)
        var outputIndex = 0
        var buffered = 0
        var bufferedBits = 0
        for (character in value) {
            val encoded = BASE64_URL_ALPHABET.indexOf(character)
            require(encoded >= 0) {
                "$field contains an invalid base64url character"
            }
            buffered = (buffered shl 6) or encoded
            bufferedBits += 6
            while (bufferedBits >= 8) {
                bufferedBits -= 8
                require(outputIndex < output.size) {
                    "$field contains too many bytes"
                }
                output[outputIndex] =
                    ((buffered shr bufferedBits) and 0xff).toByte()
                outputIndex += 1
                buffered =
                    if (bufferedBits == 0) {
                        0
                    } else {
                        buffered and ((1 shl bufferedBits) - 1)
                    }
            }
        }
        require(
            outputIndex == IDENTIFIER_BYTES &&
                bufferedBits == 4 &&
                buffered == 0
        ) {
            "$field is not canonical base64url"
        }
        return output
    }

    private fun encodeIdentifier(value: ByteArray): String {
        require(value.size == IDENTIFIER_BYTES)
        val result = StringBuilder(22)
        var index = 0
        while (index + 2 < value.size) {
            val first = value[index].toInt() and 0xff
            val second = value[index + 1].toInt() and 0xff
            val third = value[index + 2].toInt() and 0xff
            result.append(BASE64_URL_ALPHABET[first ushr 2])
            result.append(
                BASE64_URL_ALPHABET[((first and 0x03) shl 4) or (second ushr 4)]
            )
            result.append(
                BASE64_URL_ALPHABET[((second and 0x0f) shl 2) or (third ushr 6)]
            )
            result.append(BASE64_URL_ALPHABET[third and 0x3f])
            index += 3
        }
        if (index < value.size) {
            val first = value[index].toInt() and 0xff
            result.append(BASE64_URL_ALPHABET[first ushr 2])
            result.append(BASE64_URL_ALPHABET[(first and 0x03) shl 4])
        }
        return result.toString()
    }
}

class AndroidHelloExchangeBinding private constructor(
    request: BluetoothHelloV1,
    private val expectedRemoteBootId: Int,
    private val expectedRemoteCapabilities: Int
) {
    private var pendingRequest: BluetoothHelloV1? = request
    private var acceptedResponse: BluetoothHelloV1? = null

    @Synchronized
    fun requestPayload(): ByteArray =
        BluetoothHelloCodecV1.encode(
            checkNotNull(pendingRequest) {
                "HELLO binding has already been cleared"
            }
        )

    @Synchronized
    fun acceptResponse(payload: ByteArray): BluetoothHelloV1 {
        val request = checkNotNull(pendingRequest) {
            "HELLO binding has already been cleared"
        }
        val response = BluetoothHelloCodecV1.decode(payload)
        require(response.sessionId == request.sessionId) {
            "HELLO session binding mismatch"
        }
        require(response.nodeId != request.nodeId) {
            "HELLO peer identity matches the local identity"
        }
        require(response.bootId == expectedRemoteBootId) {
            "HELLO boot binding mismatch"
        }
        require(response.capabilities == expectedRemoteCapabilities) {
            "HELLO capability binding mismatch"
        }
        require(
            response.capabilities and BluetoothCapabilityBitsV1.GATT_SERVER != 0
        ) {
            "HELLO peer is not a GATT server"
        }
        require(response.nonce != request.nonce) {
            "HELLO peers reused the same nonce"
        }
        acceptedResponse = response
        return response
    }

    @Synchronized
    fun mutualAuthBinding(
        deviceCertificateId: String
    ): BluetoothMutualAuthBindingV1 =
        BluetoothMutualAuthCodecV1.createBinding(
            clientHello =
                checkNotNull(pendingRequest) {
                    "HELLO binding has already been cleared"
                },
            serverHello =
                checkNotNull(acceptedResponse) {
                    "HELLO response has not been accepted"
                },
            deviceCertificateId = deviceCertificateId
        )

    @Synchronized
    fun helloPair(): Pair<BluetoothHelloV1, BluetoothHelloV1> =
        checkNotNull(pendingRequest) {
            "HELLO binding has already been cleared"
        } to checkNotNull(acceptedResponse) {
            "HELLO response has not been accepted"
        }

    @Synchronized
    fun clear() {
        acceptedResponse = null
        pendingRequest = null
    }

    companion object {
        fun create(
            localNodeId: String,
            localAdvertisement: BluetoothAdvertisementV1,
            remoteAdvertisement: BluetoothAdvertisementV1,
            randomBytes: (Int) -> ByteArray = {
                ByteArray(it).also(SecureRandom()::nextBytes)
            }
        ): AndroidHelloExchangeBinding {
            return createValidated(
                localNodeId,
                localAdvertisement,
                remoteAdvertisement,
                androidPeer = false,
                randomBytes = randomBytes
            )
        }

        fun createAndroidPeer(
            localNodeId: String,
            localAdvertisement: BluetoothAdvertisementV1,
            remoteAdvertisement: BluetoothAdvertisementV1,
            randomBytes: (Int) -> ByteArray = {
                ByteArray(it).also(SecureRandom()::nextBytes)
            }
        ): AndroidHelloExchangeBinding = createValidated(
            localNodeId,
            localAdvertisement,
            remoteAdvertisement,
            androidPeer = true,
            randomBytes = randomBytes
        )

        private fun createValidated(
            localNodeId: String,
            localAdvertisement: BluetoothAdvertisementV1,
            remoteAdvertisement: BluetoothAdvertisementV1,
            androidPeer: Boolean,
            randomBytes: (Int) -> ByteArray
        ): AndroidHelloExchangeBinding {
            val local = BluetoothAdvertisementCodecV1.validate(localAdvertisement)
            val remote = BluetoothAdvertisementCodecV1.validate(remoteAdvertisement)
            require(local.nodeKind != BluetoothAdvertisementNodeKind.RASPBERRY)
            require(local.capabilities and BluetoothCapabilityBitsV1.GATT_CLIENT != 0)
            require(remote.capabilities and BluetoothCapabilityBitsV1.GATT_SERVER != 0)
            if (androidPeer) {
                require(remote.nodeKind != BluetoothAdvertisementNodeKind.RASPBERRY)
                require(
                    local.capabilities and BluetoothCapabilityBitsV1.B2_FULL_NODE ==
                        BluetoothCapabilityBitsV1.B2_FULL_NODE
                )
                require(
                    remote.capabilities and BluetoothCapabilityBitsV1.B2_FULL_NODE ==
                        BluetoothCapabilityBitsV1.B2_FULL_NODE
                )
            } else {
                require(remote.nodeKind == BluetoothAdvertisementNodeKind.RASPBERRY)
                require(remote.serverReachable)
            }
            val sessionId = BluetoothHelloCodecV1.generateSessionId(randomBytes)
            val nonce = BluetoothHelloCodecV1.generateNonce(randomBytes)
            require(sessionId != nonce) {
                "HELLO session and nonce entropy must be independent"
            }
            return AndroidHelloExchangeBinding(
                request =
                    BluetoothHelloCodecV1.validate(
                        BluetoothHelloV1(
                            protocolVersion = BluetoothHelloCodecV1.PROTOCOL_VERSION,
                            sessionId = sessionId,
                            nodeId = localNodeId,
                            bootId = local.bootId,
                            capabilities = local.capabilities,
                            nonce = nonce
                        )
                    ),
                expectedRemoteBootId = remote.bootId,
                expectedRemoteCapabilities = remote.capabilities
            )
        }
    }
}
