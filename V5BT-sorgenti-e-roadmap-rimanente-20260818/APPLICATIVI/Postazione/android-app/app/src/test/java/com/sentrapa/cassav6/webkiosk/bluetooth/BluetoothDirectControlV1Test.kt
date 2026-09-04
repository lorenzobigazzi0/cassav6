package com.sentrapa.cassav6.webkiosk.bluetooth

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothDirectControlV1Test {
    private val sessionId = "AbCdEfGhIjKlMnOpQrStUg"
    private val clientHello = BluetoothHelloV1(
        protocolVersion = 1,
        sessionId = sessionId,
        nodeId = "550e8400-e29b-41d4-a716-446655440000",
        bootId = 17,
        capabilities = 47,
        nonce = "AAECAwQFBgcICQoLDA0ODw"
    )
    private val serverHello = BluetoothHelloV1(
        protocolVersion = 1,
        sessionId = sessionId,
        nodeId = "123e4567-e89b-12d3-a456-426614174000",
        bootId = 54,
        capabilities = 72,
        nonce = "ICEiIyQlJicoKSorLC0uLw"
    )
    private val binding = BluetoothMutualAuthCodecV1.createBinding(
        clientHello,
        serverHello,
        "f47ac10b-58cc-4372-a567-0e02b2c3d479"
    )
    private val aliasKey = ByteArray(32) { it.toByte() }
    private val clientPublicKeySpki = hex(
        "302a300506032b656e032100" +
            "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"
    )
    private val serverPublicKeySpki = hex(
        "302a300506032b656e032100" +
            "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f"
    )
    private val sharedSecret = hex(
        "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742"
    )

    @Test
    fun `frozen cross-language contract matches every byte`() {
        assertEquals(1, BluetoothDirectControlCodecV1.PROTOCOL_VERSION)
        assertEquals(101, BluetoothDirectControlCodecV1.MINIMUM_MTU)
        assertEquals(94, BluetoothDirectControlCodecV1.CLIENT_KEY_SHARE_WIRE_BYTES)
        assertEquals(94, BluetoothDirectControlCodecV1.SERVER_KEY_SHARE_WIRE_BYTES)
        assertEquals(50, BluetoothDirectControlCodecV1.CLIENT_KEY_CONFIRM_WIRE_BYTES)
        assertEquals(54, BluetoothDirectControlCodecV1.HEARTBEAT_WIRE_BYTES)
        assertEquals(55, BluetoothDirectControlCodecV1.CLOSE_WIRE_BYTES)
        assertEquals(4, BluetoothDirectControlMessageTypeV1.CLIENT_KEY_SHARE.wireValue)
        assertEquals(10, BluetoothDirectControlMessageTypeV1.CLOSE_ACK.wireValue)
        assertEquals(
            "CASSA_V6-BT-KEY-CLIENT-SHARE-V1\u0000",
            BluetoothDirectControlCodecV1.CLIENT_KEY_SHARE_CONTEXT
        )
        assertEquals(
            "CASSA_V6-BT-CONTROL-V1\u0000",
            BluetoothDirectControlCodecV1.AUTHENTICATED_CONTROL_CONTEXT
        )

        val vector = frozenVector()
        try {
            assertEquals(EXPECTED_CLIENT_BINDER, vector.clientBinder.toHex())
            assertEquals(EXPECTED_SESSION_BINDER, vector.sessionBinder.toHex())
            assertEquals(EXPECTED_TRANSCRIPT_HASH, vector.transcriptHash.toHex())
            val keyCopies = vector.keys.keyCopiesForTest()
            try {
                assertEquals(EXPECTED_C2S, keyCopies[0].toHex())
                assertEquals(EXPECTED_S2C, keyCopies[1].toHex())
                assertEquals(EXPECTED_CLIENT_CONFIRM_KEY, keyCopies[2].toHex())
                assertEquals(EXPECTED_SERVER_CONFIRM_KEY, keyCopies[3].toHex())
            } finally {
                keyCopies.forEach { it.fill(0) }
            }
            assertEquals(EXPECTED_SERVER_CONFIRM, vector.serverConfirmation.toHex())
            assertEquals(EXPECTED_CLIENT_CONFIRM, vector.clientConfirmation.toHex())

            val clientShare = BluetoothDirectControlCodecV1.encodeClientKeyShare(
                sessionId,
                clientPublicKeySpki,
                vector.clientBinder
            )
            val serverShare = BluetoothDirectControlCodecV1.encodeServerKeyShare(
                sessionId,
                serverPublicKeySpki,
                vector.serverConfirmation
            )
            val clientConfirm = BluetoothDirectControlCodecV1.encodeClientKeyConfirm(
                sessionId,
                vector.clientConfirmation
            )
            val ping = vector.keys.encodeClientHeartbeat(
                BluetoothDirectControlMessageTypeV1.PING,
                sessionId,
                0
            )
            val serverKey = vector.keys.keyCopiesForTest()[1]
            val c2sKey = vector.keys.keyCopiesForTest()[0]
            val serverPing = try {
                BluetoothDirectControlCodecV1.encodeHeartbeat(
                    BluetoothDirectControlMessageTypeV1.PING,
                    sessionId,
                    0,
                    serverKey
                )
            } finally {
                serverKey.fill(0)
            }
            val pong = try {
                BluetoothDirectControlCodecV1.encodeHeartbeat(
                    BluetoothDirectControlMessageTypeV1.PONG,
                    sessionId,
                    0,
                    c2sKey
                )
            } finally {
                c2sKey.fill(0)
            }
            val serverKeyForClose = vector.keys.keyCopiesForTest()[1]
            val c2sKeyForClose = vector.keys.keyCopiesForTest()[0]
            val close = try {
                BluetoothDirectControlCodecV1.encodeClose(
                    BluetoothDirectControlMessageTypeV1.CLOSE,
                    sessionId,
                    1,
                    BluetoothDirectControlCloseReasonV1.NORMAL,
                    serverKeyForClose
                )
            } finally {
                serverKeyForClose.fill(0)
            }
            val closeAck = try {
                BluetoothDirectControlCodecV1.encodeClose(
                    BluetoothDirectControlMessageTypeV1.CLOSE_ACK,
                    sessionId,
                    1,
                    BluetoothDirectControlCloseReasonV1.NORMAL,
                    c2sKeyForClose
                )
            } finally {
                c2sKeyForClose.fill(0)
            }
            assertEquals(EXPECTED_CLIENT_SHARE_WIRE, clientShare.toHex())
            assertEquals(EXPECTED_SERVER_SHARE_WIRE, serverShare.toHex())
            assertEquals(EXPECTED_CLIENT_CONFIRM_WIRE, clientConfirm.toHex())
            assertEquals(EXPECTED_PING_WIRE, serverPing.toHex())
            assertEquals(EXPECTED_PONG_WIRE, pong.toHex())
            assertEquals(EXPECTED_CLOSE_WIRE, close.toHex())
            assertEquals(EXPECTED_CLOSE_ACK_WIRE, closeAck.toHex())
            assertFalse(ping.contentEquals(serverPing))

            val decodedClient =
                BluetoothDirectControlCodecV1.decodeClientKeyShare(clientShare)
            assertEquals(sessionId, decodedClient.sessionId)
            assertArrayEquals(clientPublicKeySpki, decodedClient.publicKeySpki)
            assertArrayEquals(vector.clientBinder, decodedClient.clientBinder)
            val decodedServer =
                BluetoothDirectControlCodecV1.decodeServerKeyShare(serverShare)
            assertEquals(sessionId, decodedServer.sessionId)
            assertArrayEquals(serverPublicKeySpki, decodedServer.publicKeySpki)
            assertArrayEquals(vector.serverConfirmation, decodedServer.confirmation)
            val decodedConfirm =
                BluetoothDirectControlCodecV1.decodeClientKeyConfirm(clientConfirm)
            assertArrayEquals(vector.clientConfirmation, decodedConfirm.confirmation)
        } finally {
            vector.close()
        }
    }

    @Test
    fun `authenticated control rejects tamper reflection replay and malformed wire`() {
        val vector = frozenVector()
        try {
            val serverKey = vector.keys.keyCopiesForTest()[1]
            val clientKey = vector.keys.keyCopiesForTest()[0]
            val ping = hex(EXPECTED_PING_WIRE)
            try {
                val decoded = BluetoothDirectControlCodecV1.decodeHeartbeat(
                    ping,
                    serverKey,
                    BluetoothDirectControlMessageTypeV1.PING,
                    0
                )
                assertEquals(0L, decoded.sequence)
                assertEquals(sessionId, decoded.sessionId)

                for (offset in listOf(21, 53)) {
                    val tampered = ping.copyOf()
                    tampered[offset] = (tampered[offset].toInt() xor 1).toByte()
                    assertThrows(IllegalArgumentException::class.java) {
                        BluetoothDirectControlCodecV1.decodeHeartbeat(
                            tampered,
                            serverKey,
                            BluetoothDirectControlMessageTypeV1.PING
                        )
                    }
                }
                assertThrows(IllegalArgumentException::class.java) {
                    BluetoothDirectControlCodecV1.decodeHeartbeat(
                        ping,
                        clientKey,
                        BluetoothDirectControlMessageTypeV1.PING
                    )
                }
                assertThrows(IllegalArgumentException::class.java) {
                    BluetoothDirectControlCodecV1.decodeHeartbeat(
                        ping,
                        serverKey,
                        BluetoothDirectControlMessageTypeV1.PING,
                        1
                    )
                }
            } finally {
                serverKey.fill(0)
                clientKey.fill(0)
            }

            assertThrows(IllegalArgumentException::class.java) {
                BluetoothDirectControlCodecV1.decodeServerKeyShare(ByteArray(93))
            }
            val invalidSpki = clientPublicKeySpki.copyOf().also {
                it[0] = (it[0].toInt() xor 1).toByte()
            }
            assertThrows(IllegalArgumentException::class.java) {
                BluetoothDirectControlCodecV1.normalizeX25519PublicKeySpki(
                    invalidSpki
                )
            }
            assertThrows(IllegalArgumentException::class.java) {
                BluetoothDirectControlCodecV1.encodeHeartbeat(
                    BluetoothDirectControlMessageTypeV1.PING,
                    sessionId,
                    BluetoothDirectControlCodecV1.MAX_SEQUENCE + 1,
                    ByteArray(32)
                )
            }
        } finally {
            vector.close()
        }
    }

    @Test
    fun `JCA X25519 produces canonical matching nonzero secrets`() {
        val client = JcaBluetoothDirectControlKeyAgreementV1.create()
        val server = JcaBluetoothDirectControlKeyAgreementV1.create()
        try {
            val clientPublic = client.publicKeySpki()
            val serverPublic = server.publicKeySpki()
            assertEquals(44, clientPublic.size)
            assertEquals(44, serverPublic.size)
            assertArrayEquals(
                clientPublic,
                BluetoothDirectControlCodecV1.normalizeX25519PublicKeySpki(
                    clientPublic
                )
            )
            val clientSecret = client.deriveSharedSecret(serverPublic)
            val serverSecret = server.deriveSharedSecret(clientPublic)
            try {
                assertArrayEquals(clientSecret, serverSecret)
                assertEquals(32, clientSecret.size)
                assertTrue(clientSecret.any { it.toInt() != 0 })
            } finally {
                clientSecret.fill(0)
                serverSecret.fill(0)
                clientPublic.fill(0)
                serverPublic.fill(0)
            }
        } finally {
            client.close()
            server.close()
        }
        assertThrows(IllegalStateException::class.java) { client.publicKeySpki() }
    }

    @Test
    fun `client orchestrator completes key probe heartbeat and clean close`() {
        val fixedFactory = FixedAgreementFactory()
        val client = AndroidDirectControlClientV1(
            readyIdentity(),
            binding,
            fixedFactory
        )
        val firstShare = ready(client.createClientKeyShare())
        val duplicateShare = ready(client.createClientKeyShare())
        assertEquals(EXPECTED_CLIENT_SHARE_WIRE, firstShare.payload.toHex())
        assertArrayEquals(firstShare.payload, duplicateShare.payload)
        duplicateShare.payload.fill(0)
        assertEquals(
            EXPECTED_CLIENT_SHARE_WIRE,
            ready(client.createClientKeyShare()).payload.toHex()
        )

        val confirm = ready(
            client.acceptServerKeyShare(hex(EXPECTED_SERVER_SHARE_WIRE))
        )
        assertEquals(EXPECTED_CLIENT_CONFIRM_WIRE, confirm.payload.toHex())
        val duplicateConfirm = ready(
            client.acceptServerKeyShare(hex(EXPECTED_SERVER_SHARE_WIRE))
        )
        assertArrayEquals(confirm.payload, duplicateConfirm.payload)
        duplicateConfirm.payload.fill(0)
        assertEquals(
            EXPECTED_CLIENT_CONFIRM_WIRE,
            ready(
                client.acceptServerKeyShare(hex(EXPECTED_SERVER_SHARE_WIRE))
            ).payload.toHex()
        )
        assertTrue(client.completeClientConfirmWrite())
        assertEquals(
            BluetoothDirectControlClientPhaseV1.KEY_ESTABLISHED,
            client.phase
        )
        assertThrows(IllegalStateException::class.java) {
            client.exportReliableChannelMaterialV1()
        }
        assertTrue(fixedFactory.lastAgreement?.closed == true)

        val pong = ready(client.acceptPing(hex(EXPECTED_PING_WIRE)))
        assertEquals(EXPECTED_PONG_WIRE, pong.payload.toHex())
        assertEquals(0L, pong.sequence)
        assertEquals(BluetoothDirectControlClientPhaseV1.PONG_READY, client.phase)
        val duplicatePong = ready(client.acceptPing(hex(EXPECTED_PING_WIRE)))
        assertArrayEquals(pong.payload, duplicatePong.payload)
        duplicatePong.payload.fill(0)
        assertEquals(
            EXPECTED_PONG_WIRE,
            ready(client.acceptPing(hex(EXPECTED_PING_WIRE))).payload.toHex()
        )
        assertTrue(client.completePongWrite())
        assertEquals(BluetoothDirectControlClientPhaseV1.ACTIVE, client.phase)
        val actualMaterial = client.exportReliableChannelMaterialV1()
        val expectedMaterial = deriveReliableChannelMaterialV1(
            hex(EXPECTED_C2S),
            hex(EXPECTED_S2C)
        )
        try {
            assertArrayEquals(
                expectedMaterial.clientToServer.key,
                actualMaterial.clientToServer.key
            )
            assertArrayEquals(
                expectedMaterial.clientToServer.noncePrefix,
                actualMaterial.clientToServer.noncePrefix
            )
            assertArrayEquals(
                expectedMaterial.serverToClient.key,
                actualMaterial.serverToClient.key
            )
            assertArrayEquals(
                expectedMaterial.serverToClient.noncePrefix,
                actualMaterial.serverToClient.noncePrefix
            )
        } finally {
            actualMaterial.close()
            expectedMaterial.close()
        }
        val delayedDuplicatePong =
            ready(client.acceptPing(hex(EXPECTED_PING_WIRE)))
        delayedDuplicatePong.payload.fill(0)
        assertEquals(
            EXPECTED_PONG_WIRE,
            ready(client.acceptPing(hex(EXPECTED_PING_WIRE))).payload.toHex()
        )
        assertTrue(client.completePongWrite())

        val vector = frozenVector()
        val keyCopies = vector.keys.keyCopiesForTest()
        try {
            val pingOne = BluetoothDirectControlCodecV1.encodeHeartbeat(
                BluetoothDirectControlMessageTypeV1.PING,
                sessionId,
                1,
                keyCopies[1]
            )
            val expectedPongOne = BluetoothDirectControlCodecV1.encodeHeartbeat(
                BluetoothDirectControlMessageTypeV1.PONG,
                sessionId,
                1,
                keyCopies[0]
            )
            val pongOne = ready(client.acceptPing(pingOne))
            assertArrayEquals(expectedPongOne, pongOne.payload)
            assertEquals(1L, pongOne.sequence)
            assertTrue(client.completePongWrite())

            val closeTwo = BluetoothDirectControlCodecV1.encodeClose(
                BluetoothDirectControlMessageTypeV1.CLOSE,
                sessionId,
                2,
                BluetoothDirectControlCloseReasonV1.NORMAL,
                keyCopies[1]
            )
            val expectedCloseAckTwo = BluetoothDirectControlCodecV1.encodeClose(
                BluetoothDirectControlMessageTypeV1.CLOSE_ACK,
                sessionId,
                2,
                BluetoothDirectControlCloseReasonV1.NORMAL,
                keyCopies[0]
            )
            val closeAck = ready(client.acceptClose(closeTwo))
            assertArrayEquals(expectedCloseAckTwo, closeAck.payload)
            assertEquals(
                BluetoothDirectControlCloseReasonV1.NORMAL,
                closeAck.closeReason
            )
            assertEquals(BluetoothDirectControlClientPhaseV1.CLOSING, client.phase)
            assertTrue(client.completeCloseAckWrite())
            assertEquals(BluetoothDirectControlClientPhaseV1.CLOSED, client.phase)
            assertThrows(IllegalStateException::class.java) {
                client.exportReliableChannelMaterialV1()
            }
            assertFalse(client.completePongWrite())
        } finally {
            keyCopies.forEach { it.fill(0) }
            vector.close()
        }
    }

    @Test
    fun `client fails closed on confirmation tamper conflict and replay`() {
        val tamperedServer = hex(EXPECTED_SERVER_SHARE_WIRE).also {
            it[it.lastIndex] = (it.last().toInt() xor 1).toByte()
        }
        val rejected = AndroidDirectControlClientV1(
            readyIdentity(),
            binding,
            FixedAgreementFactory()
        )
        ready(rejected.createClientKeyShare())
        assertEquals(
            BluetoothDirectControlFailureV1.SERVER_CONFIRMATION_REJECTED,
            failure(rejected.acceptServerKeyShare(tamperedServer)).reason
        )
        assertEquals(BluetoothDirectControlClientPhaseV1.FAILED, rejected.phase)

        val conflict = AndroidDirectControlClientV1(
            readyIdentity(),
            binding,
            FixedAgreementFactory()
        )
        ready(conflict.createClientKeyShare())
        ready(conflict.acceptServerKeyShare(hex(EXPECTED_SERVER_SHARE_WIRE)))
        val changedDuplicate = hex(EXPECTED_SERVER_SHARE_WIRE).also {
            it[18] = (it[18].toInt() xor 1).toByte()
        }
        assertEquals(
            BluetoothDirectControlFailureV1.SERVER_KEY_SHARE_REJECTED,
            failure(conflict.acceptServerKeyShare(changedDuplicate)).reason
        )
        assertEquals(BluetoothDirectControlClientPhaseV1.FAILED, conflict.phase)

        val replay = AndroidDirectControlClientV1(
            readyIdentity(),
            binding,
            FixedAgreementFactory()
        )
        ready(replay.createClientKeyShare())
        ready(replay.acceptServerKeyShare(hex(EXPECTED_SERVER_SHARE_WIRE)))
        assertTrue(replay.completeClientConfirmWrite())
        val wrongFirstSequence = frozenVector().use { vector ->
            val keyCopies = vector.keys.keyCopiesForTest()
            try {
                BluetoothDirectControlCodecV1.encodeHeartbeat(
                    BluetoothDirectControlMessageTypeV1.PING,
                    sessionId,
                    1,
                    keyCopies[1]
                )
            } finally {
                keyCopies.forEach { it.fill(0) }
            }
        }
        assertEquals(
            BluetoothDirectControlFailureV1.CONTROL_SEQUENCE_MISMATCH,
            failure(replay.acceptPing(wrongFirstSequence)).reason
        )
        assertEquals(BluetoothDirectControlClientPhaseV1.FAILED, replay.phase)

        val overlap = AndroidDirectControlClientV1(
            readyIdentity(),
            binding,
            FixedAgreementFactory()
        )
        ready(overlap.createClientKeyShare())
        ready(overlap.acceptServerKeyShare(hex(EXPECTED_SERVER_SHARE_WIRE)))
        assertTrue(overlap.completeClientConfirmWrite())
        ready(overlap.acceptPing(hex(EXPECTED_PING_WIRE)))
        val pingOneBeforeWrite = frozenVector().use { vector ->
            val keyCopies = vector.keys.keyCopiesForTest()
            try {
                BluetoothDirectControlCodecV1.encodeHeartbeat(
                    BluetoothDirectControlMessageTypeV1.PING,
                    sessionId,
                    1,
                    keyCopies[1]
                )
            } finally {
                keyCopies.forEach { it.fill(0) }
            }
        }
        assertEquals(
            BluetoothDirectControlFailureV1.CONTROL_FRAME_CONFLICT,
            failure(overlap.acceptPing(pingOneBeforeWrite)).reason
        )
        assertEquals(BluetoothDirectControlClientPhaseV1.FAILED, overlap.phase)
    }

    @Test
    fun `keys clear deterministically and logs redact session and key material`() {
        val vector = frozenVector()
        val keysText = vector.keys.toString()
        assertFalse(keysText.contains(EXPECTED_C2S))
        vector.keys.close()
        assertTrue(vector.keys.isClosed)
        assertThrows(IllegalStateException::class.java) {
            vector.keys.encodeClientHeartbeat(
                BluetoothDirectControlMessageTypeV1.PONG,
                sessionId,
                0
            )
        }

        val decoded = BluetoothDirectControlCodecV1.decodeServerKeyShare(
            hex(EXPECTED_SERVER_SHARE_WIRE)
        )
        assertFalse(decoded.toString().contains(sessionId))
        assertFalse(decoded.toString().contains(EXPECTED_SERVER_CONFIRM))
        val client = AndroidDirectControlClientV1(
            readyIdentity(),
            binding,
            FixedAgreementFactory()
        )
        val result = ready(client.createClientKeyShare())
        assertFalse(result.toString().contains(sessionId))
        assertFalse(result.toString().contains(EXPECTED_CLIENT_BINDER))
        assertFalse(client.toString().contains(sessionId))
        client.clear()
        vector.close()
    }

    private fun frozenVector(): FrozenVector {
        val clientBinderMessage =
            BluetoothDirectControlCodecV1.buildClientKeyShareBinderMessage(
                binding,
                clientPublicKeySpki
            )
        val clientBinder = try {
            hmac(aliasKey, clientBinderMessage)
        } finally {
            clientBinderMessage.fill(0)
        }
        val sessionBinderMessage =
            BluetoothDirectControlCodecV1.buildSessionKeyBinderMessage(
                binding,
                clientPublicKeySpki,
                clientBinder,
                serverPublicKeySpki
            )
        val sessionBinder = try {
            hmac(aliasKey, sessionBinderMessage)
        } finally {
            sessionBinderMessage.fill(0)
        }
        val transcriptHash =
            BluetoothDirectControlCodecV1.buildSessionTranscriptHash(
                binding,
                clientPublicKeySpki,
                clientBinder,
                serverPublicKeySpki
            )
        val keys = BluetoothDirectControlCodecV1.deriveSessionKeys(
            sharedSecret,
            sessionBinder,
            transcriptHash
        )
        val serverConfirmation = keys.createServerConfirmation(transcriptHash)
        val clientConfirmation = keys.createClientConfirmation(
            transcriptHash,
            serverConfirmation
        )
        return FrozenVector(
            clientBinder,
            sessionBinder,
            transcriptHash,
            keys,
            serverConfirmation,
            clientConfirmation
        )
    }

    private fun readyIdentity(): BluetoothMutualAuthIdentityPort =
        object : BluetoothMutualAuthIdentityPort {
            override fun sign(message: ByteArray) = DeviceSignatureResult(
                status = DeviceIdentityStatus.READY,
                signature = ByteArray(64)
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

    private fun ready(
        result: BluetoothDirectControlResultV1
    ): BluetoothDirectControlResultV1.Ready =
        result as BluetoothDirectControlResultV1.Ready

    private fun failure(
        result: BluetoothDirectControlResultV1
    ): BluetoothDirectControlResultV1.Failure =
        result as BluetoothDirectControlResultV1.Failure

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

    private inner class FixedAgreementFactory :
        BluetoothDirectControlKeyAgreementFactoryV1 {
        var lastAgreement: FixedAgreement? = null

        override fun create(): BluetoothDirectControlKeyAgreementV1 =
            FixedAgreement().also { lastAgreement = it }
    }

    private inner class FixedAgreement : BluetoothDirectControlKeyAgreementV1 {
        var closed = false

        override fun publicKeySpki(): ByteArray {
            check(!closed)
            return clientPublicKeySpki.copyOf()
        }

        override fun deriveSharedSecret(peerPublicKeySpki: ByteArray): ByteArray {
            check(!closed)
            require(peerPublicKeySpki.contentEquals(serverPublicKeySpki))
            return sharedSecret.copyOf()
        }

        override fun close() {
            closed = true
        }

        override fun toString(): String = "FixedAgreement(keyMaterial=<redacted>)"
    }

    private data class FrozenVector(
        val clientBinder: ByteArray,
        val sessionBinder: ByteArray,
        val transcriptHash: ByteArray,
        val keys: BluetoothDirectControlSessionKeysV1,
        val serverConfirmation: ByteArray,
        val clientConfirmation: ByteArray
    ) : AutoCloseable {
        override fun close() {
            clientBinder.fill(0)
            sessionBinder.fill(0)
            transcriptHash.fill(0)
            keys.close()
            serverConfirmation.fill(0)
            clientConfirmation.fill(0)
        }
    }

    companion object {
        private const val EXPECTED_CLIENT_BINDER =
            "c8c8ba147f2b2dd8cd3c5f84761eb0b7ca874e78f332e3fd264e3ffaac0fbb9a"
        private const val EXPECTED_SESSION_BINDER =
            "3cce5d3245183d6707611692718c1cb5ec8ad44819d358b1c4829b76a18fabe0"
        private const val EXPECTED_TRANSCRIPT_HASH =
            "19e6ed2c5f648e26087e72b69ddbed92e99c3e7cf113940603e85dd2243228f5"
        private const val EXPECTED_C2S =
            "b06244a38b7c26c992cf2159a1ec45aef6e387cb9f51152a27dac15b9cdf25b9"
        private const val EXPECTED_S2C =
            "824c928618fc07dcd522a9f1d249319b4aed7fcba3bd5e2e3109844d9c4a7441"
        private const val EXPECTED_CLIENT_CONFIRM_KEY =
            "23916a1bcd8ef4b818a51a2238a48000bd5ba7caaec07c50202ef6bac8f11e18"
        private const val EXPECTED_SERVER_CONFIRM_KEY =
            "96a8fa8b9f2b7cfc3f381cd0a23671dcdc158f143fe2e80667a001811830a0a3"
        private const val EXPECTED_SERVER_CONFIRM =
            "3b178b1f34f191455afd597361a0fc4f58dd24060e0daef3d2148cc64bbd0a83"
        private const val EXPECTED_CLIENT_CONFIRM =
            "3efba686c36458f708f1d85926d5e392fbc9ae86175650de927789e119dc4658"
        private const val EXPECTED_CLIENT_SHARE_WIRE =
            "010401b09d11f1a12232a53273a942b4ad52302a300506032b656e032100" +
                "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a" +
                EXPECTED_CLIENT_BINDER
        private const val EXPECTED_SERVER_SHARE_WIRE =
            "010501b09d11f1a12232a53273a942b4ad52302a300506032b656e032100" +
                "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f" +
                EXPECTED_SERVER_CONFIRM
        private const val EXPECTED_CLIENT_CONFIRM_WIRE =
            "010601b09d11f1a12232a53273a942b4ad52" + EXPECTED_CLIENT_CONFIRM
        private const val EXPECTED_PING_WIRE =
            "010701b09d11f1a12232a53273a942b4ad5200000000" +
                "5c3656726e75fb1d20c507db3aead8bad8efb29fd12d26c3647d24971b6a78fa"
        private const val EXPECTED_PONG_WIRE =
            "010801b09d11f1a12232a53273a942b4ad5200000000" +
                "f5481c751050b9a8912e62f89fabbaa13b2f3147f96710a1622f7cace32ce6e0"
        private const val EXPECTED_CLOSE_WIRE =
            "010901b09d11f1a12232a53273a942b4ad520000000101" +
                "8f5999db5817d2b422cba32b41829fc894fd4d73d781d5158906974eba725808"
        private const val EXPECTED_CLOSE_ACK_WIRE =
            "010a01b09d11f1a12232a53273a942b4ad520000000101" +
                "67488519a326ce4d621a64f68a128a450667c9f955a8b93854f784ceb805c6dd"
    }
}
