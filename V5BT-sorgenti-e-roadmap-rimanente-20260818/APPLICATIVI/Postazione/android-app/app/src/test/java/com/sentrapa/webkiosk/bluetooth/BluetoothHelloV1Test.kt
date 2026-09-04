package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BluetoothHelloV1Test {
    @Test
    fun `frozen HELLO vector matches the shared 51 byte wire format`() {
        val value = request()
        val encoded = BluetoothHelloCodecV1.encode(value)

        assertEquals(51, encoded.size)
        assertEquals(54, BluetoothHelloCodecV1.MINIMUM_MTU)
        assertEquals(
            "0101b09d11f1a12232a53273a942b4ad52550e8400e29b41d4a716446655440000112f000102030405060708090a0b0c0d0e0f",
            encoded.toHex()
        )
        assertEquals(value, BluetoothHelloCodecV1.decode(encoded))
    }

    @Test
    fun `codec rejects malformed lengths bindings and reserved capabilities`() {
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothHelloCodecV1.decode(ByteArray(50))
        }
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothHelloCodecV1.encode(
                request().copy(sessionId = "AbCdEfGhIjKlMnOpQrStUB")
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothHelloCodecV1.encode(
                request().copy(
                    nodeId = "550E8400-E29B-41D4-A716-446655440000"
                )
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothHelloCodecV1.encode(
                request().copy(capabilities = 0x80)
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothHelloCodecV1.encode(
                request().copy(nonce = "AAAAAAAAAAAAAAAAAAAAAA")
            )
        }
    }

    @Test
    fun `binding accepts only the advertised Raspberry incarnation`() {
        var next = 1
        val binding = AndroidHelloExchangeBinding.create(
            localNodeId = request().nodeId,
            localAdvertisement = localAdvertisement(),
            remoteAdvertisement = remoteAdvertisement(),
            randomBytes = { length ->
                ByteArray(length) { (next++ and 0xff).toByte() }
            }
        )
        val outbound = BluetoothHelloCodecV1.decode(binding.requestPayload())
        val response = BluetoothHelloV1(
            protocolVersion = 1,
            sessionId = outbound.sessionId,
            nodeId = "123e4567-e89b-12d3-a456-426614174000",
            bootId = 54,
            capabilities =
                BluetoothCapabilityBitsV1.GATT_SERVER or
                    BluetoothCapabilityBitsV1.BACKEND_BRIDGE,
            nonce = "ICEiIyQlJicoKSorLC0uLw"
        )

        assertEquals(
            response,
            binding.acceptResponse(BluetoothHelloCodecV1.encode(response))
        )
        assertNotEquals(outbound.nonce, response.nonce)

        for (invalid in listOf(
            response.copy(sessionId = "ZyXwVuTsRqPoNmLkJiHgFA"),
            response.copy(bootId = 55),
            response.copy(capabilities = BluetoothCapabilityBitsV1.GATT_SERVER),
            response.copy(nodeId = outbound.nodeId),
            response.copy(nonce = outbound.nonce)
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                binding.acceptResponse(BluetoothHelloCodecV1.encode(invalid))
            }
        }
        binding.clear()
        assertThrows(IllegalStateException::class.java) {
            binding.requestPayload()
        }
    }

    @Test
    fun `Android HELLO accepts offline full node while Raspberry remains reachable only`() {
        val local = localAdvertisement().copy(
            rotatingAlias = "8899aabbccdd",
            serverReachable = false
        )
        val remoteAndroid = BluetoothAdvertisementV1(
            protocolVersion = 1,
            nodeKind = BluetoothAdvertisementNodeKind.STATION,
            rotatingAlias = "001122334455",
            bootId = 54,
            capabilities = BluetoothCapabilityBitsV1.B2_FULL_NODE,
            serverReachable = false,
            sequence = 1
        )
        var entropy = 1
        val binding = AndroidHelloExchangeBinding.createAndroidPeer(
            request().nodeId,
            local,
            remoteAndroid,
            randomBytes = { length ->
                ByteArray(length) { (entropy++ and 0xff).toByte() }
            }
        )
        assertEquals(51, binding.requestPayload().size)
        binding.clear()

        assertThrows(IllegalArgumentException::class.java) {
            AndroidHelloExchangeBinding.create(
                request().nodeId,
                local,
                remoteAdvertisement().copy(serverReachable = false),
                randomBytes = { length -> ByteArray(length) { (it + 1).toByte() } }
            )
        }
    }

    @Test
    fun `identifier entropy is exact and input buffers are cleared`() {
        val source = ByteArray(16) { it.toByte() }
        assertEquals(
            "AAECAwQFBgcICQoLDA0ODw",
            BluetoothHelloCodecV1.generateNonce { source }
        )
        assertArrayEquals(ByteArray(16), source)
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothHelloCodecV1.generateSessionId { ByteArray(15) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothHelloCodecV1.generateNonce { ByteArray(16) }
        }
    }

    private fun request() = BluetoothHelloV1(
        protocolVersion = 1,
        sessionId = "AbCdEfGhIjKlMnOpQrStUg",
        nodeId = "550e8400-e29b-41d4-a716-446655440000",
        bootId = 17,
        capabilities = 47,
        nonce = "AAECAwQFBgcICQoLDA0ODw"
    )

    private fun localAdvertisement() = BluetoothAdvertisementV1(
        protocolVersion = 1,
        nodeKind = BluetoothAdvertisementNodeKind.HANDHELD,
        rotatingAlias = "aabbccddeeff",
        bootId = 17,
        capabilities = BluetoothCapabilityBitsV1.B2_FULL_NODE,
        serverReachable = false,
        sequence = 1
    )

    private fun remoteAdvertisement() = BluetoothAdvertisementV1(
        protocolVersion = 1,
        nodeKind = BluetoothAdvertisementNodeKind.RASPBERRY,
        rotatingAlias = "445566778899",
        bootId = 54,
        capabilities =
            BluetoothCapabilityBitsV1.GATT_SERVER or
                BluetoothCapabilityBitsV1.BACKEND_BRIDGE,
        serverReachable = true,
        sequence = 1
    )

    private fun ByteArray.toHex(): String =
        joinToString(separator = "") { "%02x".format(it.toInt() and 0xff) }
}
