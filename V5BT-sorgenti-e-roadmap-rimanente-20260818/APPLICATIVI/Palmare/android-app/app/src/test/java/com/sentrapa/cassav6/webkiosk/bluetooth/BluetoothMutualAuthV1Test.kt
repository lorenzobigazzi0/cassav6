package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class BluetoothMutualAuthV1Test {
    private val clientHello = BluetoothHelloV1(
        protocolVersion = 1,
        sessionId = "AbCdEfGhIjKlMnOpQrStUg",
        nodeId = "550e8400-e29b-41d4-a716-446655440000",
        bootId = 17,
        capabilities = 47,
        nonce = "AAECAwQFBgcICQoLDA0ODw"
    )
    private val serverHello = BluetoothHelloV1(
        protocolVersion = 1,
        sessionId = clientHello.sessionId,
        nodeId = "123e4567-e89b-12d3-a456-426614174000",
        bootId = 54,
        capabilities = 72,
        nonce = "ICEiIyQlJicoKSorLC0uLw"
    )
    private val certificateId = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
    private val signature = hex(
        "0a6c5762007c06c377c202f056767adcc29ca44f20ceb204b53d756584a174f6" +
            "c6364e4c22ca1aea3f7bd8f5da22a307508b8e5650afbfb3450b57ec761f9a0a"
    )
    private val serverProof = hex(
        "46ab85f21f2d3ce6a5cfe9de877a30dc5ef5bbd549a98ad21b9e9fa1a0e576f7"
    )

    @Test
    fun `frozen contract matches Raspberry byte for byte`() {
        val binding = BluetoothMutualAuthCodecV1.createBinding(
            clientHello,
            serverHello,
            certificateId
        )
        assertEquals(101, BluetoothMutualAuthCodecV1.MINIMUM_MTU)
        assertArrayEquals(
            hex(
                "4341535341563542542d42542d415554482d434c49454e542d563100" +
                    "0101b09d11f1a12232a53273a942b4ad52550e8400e29b41d4a716446655440000112f" +
                    "000102030405060708090a0b0c0d0e0f" +
                    "0101b09d11f1a12232a53273a942b4ad52123e4567e89b12d3a4564266141740003648" +
                    "202122232425262728292a2b2c2d2e2f" +
                    "f47ac10b58cc4372a5670e02b2c3d479"
            ),
            BluetoothMutualAuthCodecV1.buildClientProofMessage(binding)
        )
        assertArrayEquals(
            hex(
                "010101b09d11f1a12232a53273a942b4ad52" +
                    "f47ac10b58cc4372a5670e02b2c3d479" +
                    signature.toHex()
            ),
            BluetoothMutualAuthCodecV1.encodeClientProof(
                clientHello.sessionId,
                certificateId,
                signature
            )
        )
        assertArrayEquals(
            hex(
                "4341535341563542542d42542d415554482d5345525645522d563100" +
                    "0101b09d11f1a12232a53273a942b4ad52550e8400e29b41d4a716446655440000112f" +
                    "000102030405060708090a0b0c0d0e0f" +
                    "0101b09d11f1a12232a53273a942b4ad52123e4567e89b12d3a4564266141740003648" +
                    "202122232425262728292a2b2c2d2e2f" +
                    "f47ac10b58cc4372a5670e02b2c3d479" +
                    signature.toHex()
            ),
            BluetoothMutualAuthCodecV1.buildServerProofMessage(
                binding,
                signature
            )
        )

        val serverWire = hex(
            "010201b09d11f1a12232a53273a942b4ad52" +
                "f47ac10b58cc4372a5670e02b2c3d479" +
                serverProof.toHex()
        )
        val decoded = BluetoothMutualAuthCodecV1.decodeServerProof(serverWire)
        assertEquals(clientHello.sessionId, decoded.sessionId)
        assertEquals(certificateId, decoded.deviceCertificateId)
        assertArrayEquals(serverProof, decoded.proof)
        assertArrayEquals(
            hex(
                "4341535341563542542d42542d415554482d46494e4953482d563100" +
                    "0101b09d11f1a12232a53273a942b4ad52550e8400e29b41d4a716446655440000112f" +
                    "000102030405060708090a0b0c0d0e0f" +
                    "0101b09d11f1a12232a53273a942b4ad52123e4567e89b12d3a4564266141740003648" +
                    "202122232425262728292a2b2c2d2e2f" +
                    "f47ac10b58cc4372a5670e02b2c3d479" +
                    signature.toHex() +
                    serverProof.toHex()
            ),
            BluetoothMutualAuthCodecV1.buildFinishProofMessage(
                binding,
                signature,
                serverProof
            )
        )
        val finishProof = hex(
            "dd4d22205f8f06400b0c2513255b67a9d7b25b4e4be5850e2164206d7c103e68"
        )
        assertArrayEquals(
            hex(
                "010301b09d11f1a12232a53273a942b4ad52" +
                    finishProof.toHex()
            ),
            BluetoothMutualAuthCodecV1.encodeFinish(
                clientHello.sessionId,
                finishProof
            )
        )
    }

    @Test
    fun `wire and transcript reject unbound or malformed material`() {
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothMutualAuthCodecV1.createBinding(
                clientHello,
                serverHello.copy(sessionId = "ZyXwVuTsRqPoNmLkJiHgFA"),
                certificateId
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothMutualAuthCodecV1.decodeServerProof(ByteArray(65))
        }
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothMutualAuthCodecV1.encodeClientProof(
                clientHello.sessionId,
                certificateId,
                ByteArray(63)
            )
        }
    }

    @Test
    fun `exchange verifies Raspberry and clears material after completion`() {
        val aliasKey = ByteArray(32) { it.toByte() }
        val identity = object : BluetoothMutualAuthIdentityPort {
            override fun sign(message: ByteArray) =
                DeviceSignatureResult(
                    status = DeviceIdentityStatus.READY,
                    signature = signature.copyOf()
                )

            override fun createAuthenticationMac(message: ByteArray) =
                DeviceAuthenticationMacResult(
                    status = DeviceIdentityStatus.READY,
                    proof = hmac(aliasKey, message)
                )

            override fun verifyAuthenticationMac(
                message: ByteArray,
                proof: ByteArray
            ) = DeviceAuthenticationMacVerificationResult(
                status = DeviceIdentityStatus.READY,
                verified = MessageDigest.isEqual(hmac(aliasKey, message), proof)
            )
        }
        val exchange = AndroidMutualAuthExchangeV1(
            identity,
            BluetoothMutualAuthCodecV1.createBinding(
                clientHello,
                serverHello,
                certificateId
            )
        )
        val client =
            exchange.createClientProof() as BluetoothMutualAuthExchangeResult.Ready
        assertEquals(98, client.payload.size)
        assertNull(exchange.directControlBinding())
        val serverWire = hex(
            "010201b09d11f1a12232a53273a942b4ad52" +
                "f47ac10b58cc4372a5670e02b2c3d479" +
                serverProof.toHex()
        )
        val finish =
            exchange.acceptServerProof(serverWire)
                as BluetoothMutualAuthExchangeResult.Ready
        assertEquals(50, finish.payload.size)
        assertEquals(
            BluetoothMutualAuthCodecV1.createBinding(
                clientHello,
                serverHello,
                certificateId
            ),
            exchange.directControlBinding()
        )
        assertTrue(exchange.complete())
        assertNull(exchange.directControlBinding())
        assertEquals(
            BluetoothMutualAuthExchangeFailure.STATE_INVALID,
            (
                exchange.createClientProof()
                    as BluetoothMutualAuthExchangeResult.Failure
                ).reason
        )

        val rejected = AndroidMutualAuthExchangeV1(
            identity,
            BluetoothMutualAuthCodecV1.createBinding(
                clientHello,
                serverHello,
                certificateId
            )
        )
        rejected.createClientProof()
        serverWire[serverWire.lastIndex] =
            (serverWire.last().toInt() xor 0x01).toByte()
        assertEquals(
            BluetoothMutualAuthExchangeFailure.SERVER_PROOF_REJECTED,
            (
                rejected.acceptServerProof(serverWire)
                    as BluetoothMutualAuthExchangeResult.Failure
                ).reason
        )
        aliasKey.fill(0)
    }

    private fun hmac(key: ByteArray, message: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(key, "HmacSHA256"))
            doFinal(message)
        }

    private fun hex(value: String): ByteArray {
        require(value.length % 2 == 0)
        return ByteArray(value.length / 2) { index ->
            value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }

    private fun ByteArray.toHex(): String =
        joinToString(separator = "") { "%02x".format(it.toInt() and 0xff) }
}
