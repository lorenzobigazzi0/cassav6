package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class P256IdentityV2Test {
    @Test
    fun `identity profiles keep v1 and v2 algorithm bindings distinct`() {
        assertEquals(
            DeviceSigningProfile.ED25519,
            DeviceSigningProfile.fromProtocolVersion(1)
        )
        assertEquals(
            DeviceSigningProfile.P256,
            DeviceSigningProfile.fromProtocolVersion(2)
        )
        assertEquals(
            DeviceSigningProfile.P256,
            DeviceSigningProfile.fromPublicKeyAlgorithm("EC-P256")
        )
        assertEquals(null, DeviceSigningProfile.fromProtocolVersion(3))
    }

    @Test
    fun `API31 selects P256 while API33 keeps legacy Ed25519`() {
        assertEquals(
            DeviceSigningProfile.P256,
            DeviceSigningProfilePolicy.select(31, emptySet())
        )
        assertEquals(
            DeviceSigningProfile.ED25519,
            DeviceSigningProfilePolicy.select(33, emptySet())
        )
        assertEquals(
            DeviceSigningProfile.P256,
            DeviceSigningProfilePolicy.select(
                36,
                setOf(DeviceSigningProfile.P256)
            )
        )
        assertEquals(
            null,
            DeviceSigningProfilePolicy.select(
                31,
                setOf(DeviceSigningProfile.ED25519)
            )
        )
        assertEquals(
            null,
            DeviceSigningProfilePolicy.select(
                36,
                DeviceSigningProfile.entries.toSet()
            )
        )
    }

    @Test
    fun `P-256 SPKI is exact canonical DER and padded base64`() {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec(P256SpkiV2.CURVE_NAME))
        val spki = generator.generateKeyPair().public.encoded
        val base64 = Base64.getEncoder().encodeToString(spki)

        assertEquals(P256SpkiV2.DER_BYTES, spki.size)
        assertEquals(P256SpkiV2.BASE64_LENGTH, base64.length)
        assertTrue(base64.endsWith("=="))
        assertTrue(P256SpkiV2.isCanonicalP256Spki(spki))
        assertArrayEquals(spki, P256SpkiV2.decodeCanonicalBase64(base64))
        assertEquals(
            64,
            P256SpkiV2.sha256Fingerprint(spki).length
        )

        assertThrows(IllegalArgumentException::class.java) {
            P256SpkiV2.decodeCanonicalBase64(base64.dropLast(1))
        }
        assertFalse(
            P256SpkiV2.isCanonicalP256Spki(
                spki.copyOf().apply { this[22] = 0x08 }
            )
        )
    }

    @Test
    fun `JCA DER signature becomes fixed low-S P1363 and verifies`() {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec(P256SpkiV2.CURVE_NAME))
        val keyPair = generator.generateKeyPair()
        val message = "CASSA_V6-P256-ROUNDTRIP".encodeToByteArray()
        val signer = Signature.getInstance(P256EcdsaSignatureV2.JCA_SIGNATURE_ALGORITHM)
        signer.initSign(keyPair.private)
        signer.update(message)

        val p1363 = P256EcdsaSignatureV2.derToCanonicalP1363(signer.sign())
        assertEquals(P256EcdsaSignatureV2.P1363_BYTES, p1363.size)
        assertTrue(P256EcdsaSignatureV2.isCanonicalP1363(p1363))

        val verifier = Signature.getInstance(P256EcdsaSignatureV2.JCA_SIGNATURE_ALGORITHM)
        verifier.initVerify(keyPair.public)
        verifier.update(message)
        assertTrue(verifier.verify(P256EcdsaSignatureV2.canonicalP1363ToDer(p1363)))
    }

    @Test
    fun `high-S DER normalizes to frozen cross-language low-S fixture`() {
        val highS = P256EcdsaSignatureV2.CURVE_ORDER.subtract(BigInteger.ONE)
        val der = encodeDer(BigInteger.ONE, highS)
        val expected = ByteArray(64).apply {
            this[31] = 1
            this[63] = 1
        }

        val normalized = P256EcdsaSignatureV2.derToCanonicalP1363(der)
        assertArrayEquals(expected, normalized)
        assertEquals(
            "3006020101020101",
            P256EcdsaSignatureV2.canonicalP1363ToDer(normalized).toHex()
        )
    }

    @Test
    fun `codec rejects noncanonical DER invalid scalars and high-S P1363`() {
        listOf(
            byteArrayOf(),
            hex("300702020001020101"),
            hex("3006020100020101"),
            hex("308106020101020101"),
            hex("300602010102010100")
        ).forEach { invalid ->
            assertThrows(IllegalArgumentException::class.java) {
                P256EcdsaSignatureV2.derToCanonicalP1363(invalid)
            }
        }

        assertThrows(IllegalArgumentException::class.java) {
            P256EcdsaSignatureV2.canonicalP1363ToDer(ByteArray(63))
        }
        assertThrows(IllegalArgumentException::class.java) {
            P256EcdsaSignatureV2.canonicalP1363ToDer(ByteArray(64))
        }
        val highS = ByteArray(64).apply {
            this[31] = 1
            val encoded = unsigned(P256EcdsaSignatureV2.CURVE_ORDER.subtract(BigInteger.ONE))
            encoded.copyInto(this, destinationOffset = 64 - encoded.size)
        }
        assertThrows(IllegalArgumentException::class.java) {
            P256EcdsaSignatureV2.canonicalP1363ToDer(highS)
        }
    }

    private fun encodeDer(r: BigInteger, s: BigInteger): ByteArray {
        val encodedR = positiveInteger(r)
        val encodedS = positiveInteger(s)
        val length = 2 + encodedR.size + 2 + encodedS.size
        return byteArrayOf(0x30, length.toByte(), 0x02, encodedR.size.toByte()) +
            encodedR + byteArrayOf(0x02, encodedS.size.toByte()) + encodedS
    }

    private fun positiveInteger(value: BigInteger): ByteArray {
        val encoded = unsigned(value)
        return if (encoded[0].toInt() and 0x80 != 0) {
            byteArrayOf(0) + encoded
        } else {
            encoded
        }
    }

    private fun unsigned(value: BigInteger): ByteArray =
        value.toByteArray().let { encoded ->
            if (encoded.size > 1 && encoded[0] == 0.toByte()) {
                encoded.copyOfRange(1, encoded.size)
            } else {
                encoded
            }
        }

    private fun hex(value: String): ByteArray =
        ByteArray(value.length / 2) { index ->
            value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
}
