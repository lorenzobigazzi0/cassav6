package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeviceIdentityManagerNamespaceTest {
    @Test
    fun `V5BT identity namespaces are isolated from the previous work name`() {
        assertEquals(
            "CASSAV5BT-BT-ED25519-SELF-TEST-V1",
            privateStringConstant("SIGNING_SELF_TEST_CONTEXT")
        )
        assertEquals(
            "CASSAV5BT-BT-ALIAS-BINDING-V1",
            privateStringConstant("ALIAS_KEY_VERIFIER_CONTEXT")
        )
        assertEquals(
            "cassav5bt.bluetooth.identity.ed25519.v1",
            privateStringConstant("SIGNING_KEY_ALIAS")
        )
        assertEquals(
            "cassav5bt.bluetooth.identity.ec-p256.v2",
            privateStringConstant("P256_SIGNING_KEY_ALIAS")
        )
        assertEquals(
            "CASSAV5BT-BT-ECDSA-P256-SELF-TEST-V2",
            privateStringConstant("P256_SIGNING_SELF_TEST_CONTEXT")
        )
        assertEquals(
            privateStringConstant("SIGNING_KEY_ALIAS"),
            DeviceSigningProfile.ED25519.keyAlias
        )
        assertEquals(
            privateStringConstant("P256_SIGNING_KEY_ALIAS"),
            DeviceSigningProfile.P256.keyAlias
        )
        assertEquals(
            "cassav5bt.bluetooth.identity.alias-hmac.v1",
            privateStringConstant("ALIAS_KEY_ALIAS")
        )
        assertEquals(
            "cassav5bt_bluetooth_identity_v1",
            privateStringConstant("PREFERENCES_NAME")
        )
    }

    @Test
    fun `claim policy permits only unprovisioned and recoverable pending states`() {
        assertNull(
            DeviceEnrollmentClaimPolicy.rejectionStatus(
                DeviceIdentityStatus.ALIAS_KEY_UNPROVISIONED
            )
        )
        assertNull(
            DeviceEnrollmentClaimPolicy.rejectionStatus(
                DeviceIdentityStatus.ENROLLMENT_PENDING
            )
        )
        assertEquals(
            DeviceIdentityStatus.ALIAS_KEY_ALREADY_PROVISIONED,
            DeviceEnrollmentClaimPolicy.rejectionStatus(DeviceIdentityStatus.READY)
        )
        assertEquals(
            DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH,
            DeviceEnrollmentClaimPolicy.rejectionStatus(
                DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH
            )
        )
    }

    @Test
    fun `KeyInfo factory uses the reported Ed25519 algorithm before fallbacks`() {
        assertEquals(
            listOf("EdDSA", "Ed25519", "EC"),
            Ed25519KeyInfoFactoryPolicy.candidates("EdDSA")
        )
        assertEquals(
            listOf("Ed25519", "EC"),
            Ed25519KeyInfoFactoryPolicy.candidates("Ed25519")
        )
        assertEquals(
            listOf("EC", "Ed25519"),
            Ed25519KeyInfoFactoryPolicy.candidates("EC")
        )
        assertEquals(
            listOf("Ed25519", "EC"),
            Ed25519KeyInfoFactoryPolicy.candidates(" ")
        )
    }

    private fun privateStringConstant(name: String): String =
        DeviceIdentityManager::class.java
            .getDeclaredField(name)
            .apply { isAccessible = true }
            .get(null) as String
}
