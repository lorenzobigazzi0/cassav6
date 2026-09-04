package com.sentrapa.webkiosk.bluetooth

import com.sentrapa.webkiosk.NotificationClientContext
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothFailoverSessionPolicyTest {
    private val authenticatedSession = NotificationClientContext(
        token = "token-1",
        userId = "user-1",
        deviceUuid = "device-1"
    ).also { context ->
        // Keep this shared test identical while honoring the optional session epoch.
        runCatching {
            NotificationClientContext::class.java
                .getDeclaredField("sessionStartedAt")
                .apply { isAccessible = true }
                .setLong(context, 1_000L)
        }
    }

    @Test
    fun `lab feature starts only for an authenticated session`() {
        assertTrue(shouldStartBluetoothFailoverRuntime(true, authenticatedSession))
        assertFalse(
            shouldStartBluetoothFailoverRuntime(
                true,
                authenticatedSession.copy(token = "")
            )
        )
    }

    @Test
    fun `disabled feature stays stopped for authenticated sessions`() {
        assertFalse(shouldStartBluetoothFailoverRuntime(false, authenticatedSession))
    }
}
