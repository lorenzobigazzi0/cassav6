package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class BluetoothAdvertisementV1Test {
    @Test
    fun `frozen ten byte vector encodes and decodes exactly`() {
        val encoded = BluetoothAdvertisementCodecV1.encode(frozenAdvertisement())

        assertArrayEquals("31aabbccddeeff112f66".hexToBytes(), encoded)
        assertEquals(frozenAdvertisement(), BluetoothAdvertisementCodecV1.decode(encoded))
    }

    @Test
    fun `all supported node kinds and reachability values round trip`() {
        for (kind in BluetoothAdvertisementNodeKind.entries) {
            for (reachable in listOf(false, true)) {
                val value = frozenAdvertisement().copy(
                    nodeKind = kind,
                    serverReachable = reachable
                )
                assertEquals(
                    BluetoothAdvertisementCodecV1.validate(value),
                    BluetoothAdvertisementCodecV1.decode(
                        BluetoothAdvertisementCodecV1.encode(value)
                    )
                )
            }
        }
    }

    @Test
    fun `decoder rejects length reserved bits version kind and zero boot id`() {
        val valid = BluetoothAdvertisementCodecV1.encode(frozenAdvertisement())
        val invalid = listOf(
            valid.copyOf(9),
            valid.copyOf().also { it[0] = (it[0].toInt() or 0x80).toByte() },
            valid.copyOf().also { it[0] = 0x32 },
            valid.copyOf().also { it[0] = 0x01 },
            valid.copyOf().also { it[7] = 0 },
            valid.copyOf().also { it[8] = 0x80.toByte() }
        )

        invalid.forEach { payload ->
            assertThrows(IllegalArgumentException::class.java) {
                BluetoothAdvertisementCodecV1.decode(payload)
            }
        }
    }

    @Test
    fun `encoder validates alias capabilities and sequence`() {
        val valid = frozenAdvertisement()
        val invalid = listOf(
            valid.copy(rotatingAlias = "abc"),
            valid.copy(rotatingAlias = "zzbbccddeeff"),
            valid.copy(capabilities = 128),
            valid.copy(sequence = 256),
            valid.copy(bootId = 0)
        )

        invalid.forEach { value ->
            assertThrows(IllegalArgumentException::class.java) {
                BluetoothAdvertisementCodecV1.encode(value)
            }
        }
    }

    @Test
    fun `sequence comparison covers duplicate newer older ambiguous and incomparable`() {
        val reference = frozenAdvertisement()
        assertEquals(
            AdvertisementSequenceRelation.DUPLICATE,
            BluetoothAdvertisementCodecV1.compareSequence(reference, reference)
        )
        assertEquals(
            AdvertisementSequenceRelation.NEWER,
            BluetoothAdvertisementCodecV1.compareSequence(
                reference.copy(sequence = 103),
                reference
            )
        )
        assertEquals(
            AdvertisementSequenceRelation.OLDER,
            BluetoothAdvertisementCodecV1.compareSequence(
                reference.copy(sequence = 101),
                reference
            )
        )
        assertEquals(
            AdvertisementSequenceRelation.AMBIGUOUS,
            BluetoothAdvertisementCodecV1.compareSequence(
                reference.copy(sequence = 230),
                reference
            )
        )
        assertEquals(
            AdvertisementSequenceRelation.INCOMPARABLE,
            BluetoothAdvertisementCodecV1.compareSequence(
                reference.copy(bootId = 18),
                reference
            )
        )
    }

    @Test
    fun `sequence comparison accepts wrap from 255 to zero`() {
        val reference = frozenAdvertisement().copy(sequence = 255)
        assertEquals(
            AdvertisementSequenceRelation.NEWER,
            BluetoothAdvertisementCodecV1.compareSequence(
                reference.copy(sequence = 0),
                reference
            )
        )
        assertEquals(
            AdvertisementSequenceRelation.AMBIGUOUS,
            BluetoothAdvertisementCodecV1.compareSequence(
                reference.copy(sequence = 127),
                reference
            )
        )
    }

    @Test
    fun `build config node kind accepts only app roles`() {
        assertEquals(
            BluetoothAdvertisementNodeKind.HANDHELD,
            BluetoothAdvertisementNodeKind.fromBuildConfig("handheld")
        )
        assertEquals(
            BluetoothAdvertisementNodeKind.STATION,
            BluetoothAdvertisementNodeKind.fromBuildConfig("STATION")
        )
        assertEquals(null, BluetoothAdvertisementNodeKind.fromBuildConfig("raspberry"))
    }

    @Test
    fun `B2 capability bitmap does not claim later milestones`() {
        assertEquals(0x0f, BluetoothCapabilityBitsV1.B2_FULL_NODE)
        assertFalse(
            BluetoothCapabilityBitsV1.B2_FULL_NODE and
                BluetoothCapabilityBitsV1.CONCURRENT_SCAN_ADVERTISE != 0
        )
        assertFalse(
            BluetoothCapabilityBitsV1.B2_FULL_NODE and
                BluetoothCapabilityBitsV1.LOCAL_DURABILITY != 0
        )
        assertFalse(
            BluetoothCapabilityBitsV1.B2_FULL_NODE and
                BluetoothCapabilityBitsV1.BACKEND_BRIDGE != 0
        )
    }

    private fun frozenAdvertisement() = BluetoothAdvertisementV1(
        protocolVersion = 1,
        nodeKind = BluetoothAdvertisementNodeKind.HANDHELD,
        rotatingAlias = "aabbccddeeff",
        bootId = 17,
        capabilities = 47,
        serverReachable = true,
        sequence = 102
    )
}

private fun String.hexToBytes(): ByteArray =
    chunked(2).map { it.toInt(16).toByte() }.toByteArray()
