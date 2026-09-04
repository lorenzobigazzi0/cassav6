package com.sentrapa.cassav6.webkiosk.bluetooth

enum class BluetoothAdvertisementNodeKind(val wireCode: Int) {
    RASPBERRY(1),
    HANDHELD(2),
    STATION(3);

    companion object {
        fun fromWireCode(code: Int): BluetoothAdvertisementNodeKind? =
            entries.firstOrNull { it.wireCode == code }

        fun fromBuildConfig(value: String): BluetoothAdvertisementNodeKind? =
            when (value.trim().lowercase()) {
                "handheld" -> HANDHELD
                "station" -> STATION
                else -> null
            }
    }
}

data class BluetoothAdvertisementV1(
    val protocolVersion: Int,
    val nodeKind: BluetoothAdvertisementNodeKind,
    val rotatingAlias: String,
    val bootId: Int,
    val capabilities: Int,
    val serverReachable: Boolean,
    val sequence: Int
)

enum class AdvertisementSequenceRelation {
    INCOMPARABLE,
    DUPLICATE,
    NEWER,
    OLDER,
    AMBIGUOUS
}

object BluetoothCapabilityBitsV1 {
    const val SCAN = 0x01
    const val ADVERTISE = 0x02
    const val GATT_CLIENT = 0x04
    const val GATT_SERVER = 0x08
    const val CONCURRENT_SCAN_ADVERTISE = 0x10
    const val LOCAL_DURABILITY = 0x20
    const val BACKEND_BRIDGE = 0x40
    const val ALL_DEFINED = 0x7f

    const val B2_FULL_NODE =
        SCAN or ADVERTISE or GATT_CLIENT or GATT_SERVER
}

object BluetoothAdvertisementCodecV1 {
    const val PROTOCOL_VERSION = 1
    const val PAYLOAD_BYTES = 10
    const val SERVICE_UUID = "3c9734f1-46cb-5672-96e9-e7a03a710f95"

    private val aliasPattern = Regex("^[0-9a-fA-F]{12}$")

    fun encode(value: BluetoothAdvertisementV1): ByteArray {
        val normalized = validate(value)
        return ByteArray(PAYLOAD_BYTES).also { payload ->
            payload[0] = (
                normalized.protocolVersion or
                    (normalized.nodeKind.wireCode shl 3) or
                    (if (normalized.serverReachable) 0x20 else 0)
                ).toByte()
            normalized.rotatingAlias.hexToByteArray().copyInto(payload, 1)
            payload[7] = normalized.bootId.toByte()
            payload[8] = normalized.capabilities.toByte()
            payload[9] = normalized.sequence.toByte()
        }
    }

    fun decode(payload: ByteArray): BluetoothAdvertisementV1 {
        require(payload.size == PAYLOAD_BYTES) {
            "v1 advertisement payload must contain exactly $PAYLOAD_BYTES bytes"
        }
        val header = payload[0].toInt() and 0xff
        require(header and 0xc0 == 0) {
            "v1 advertisement header reserved bits must be zero"
        }
        val capabilities = payload[8].toInt() and 0xff
        require(capabilities and 0x80 == 0) {
            "v1 capability reserved bit must be zero"
        }
        val protocolVersion = header and 0x07
        require(protocolVersion == PROTOCOL_VERSION) {
            "unsupported advertisement protocol version"
        }
        val nodeKind = BluetoothAdvertisementNodeKind.fromWireCode((header shr 3) and 0x03)
        requireNotNull(nodeKind) {
            "unsupported advertisement node kind"
        }

        return validate(
            BluetoothAdvertisementV1(
                protocolVersion = protocolVersion,
                nodeKind = nodeKind,
                rotatingAlias = payload.copyOfRange(1, 7).toHex(),
                bootId = payload[7].toInt() and 0xff,
                capabilities = capabilities,
                serverReachable = header and 0x20 != 0,
                sequence = payload[9].toInt() and 0xff
            )
        )
    }

    fun validate(value: BluetoothAdvertisementV1): BluetoothAdvertisementV1 {
        require(value.protocolVersion == PROTOCOL_VERSION) {
            "protocolVersion must be $PROTOCOL_VERSION"
        }
        require(aliasPattern.matches(value.rotatingAlias)) {
            "rotatingAlias must contain exactly 12 hexadecimal characters"
        }
        require(value.bootId in 1..255) {
            "bootId must be between 1 and 255"
        }
        require(value.capabilities in 0..BluetoothCapabilityBitsV1.ALL_DEFINED) {
            "capabilities must use only the seven defined bits"
        }
        require(value.sequence in 0..255) {
            "sequence must be between 0 and 255"
        }
        return value.copy(rotatingAlias = value.rotatingAlias.lowercase())
    }

    fun compareSequence(
        candidateValue: BluetoothAdvertisementV1,
        referenceValue: BluetoothAdvertisementV1
    ): AdvertisementSequenceRelation {
        val candidate = validate(candidateValue)
        val reference = validate(referenceValue)
        if (
            candidate.rotatingAlias != reference.rotatingAlias ||
            candidate.bootId != reference.bootId
        ) {
            return AdvertisementSequenceRelation.INCOMPARABLE
        }
        val distance = (candidate.sequence - reference.sequence + 256) % 256
        return when (distance) {
            0 -> AdvertisementSequenceRelation.DUPLICATE
            128 -> AdvertisementSequenceRelation.AMBIGUOUS
            in 1..127 -> AdvertisementSequenceRelation.NEWER
            else -> AdvertisementSequenceRelation.OLDER
        }
    }
}

private fun String.hexToByteArray(): ByteArray =
    chunked(2).map { it.toInt(16).toByte() }.toByteArray()
