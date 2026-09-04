package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothCallbackOwnershipTest {
    private class NotificationCallbackAdapter(
        private val ownership: BluetoothCallbackOwnership<NotificationCallbackAdapter>,
        private val deviceKey: String,
        private val onCompleted: (String) -> Unit
    ) {
        fun onNotificationSent() {
            if (!ownership.isOwner(this)) return
            onCompleted(deviceKey)
        }
    }

    @Test
    fun `stale owner cannot release or replace current owner`() {
        val ownership = BluetoothCallbackOwnership<Any>()
        val first = Any()
        val second = Any()

        ownership.install(first)
        assertSame(first, ownership.clear())
        ownership.install(second)

        assertFalse(ownership.isOwner(first))
        assertFalse(ownership.release(first))
        assertTrue(ownership.isOwner(second))
        assertSame(second, ownership.current())
    }

    @Test
    fun `release succeeds only once for the active owner`() {
        val ownership = BluetoothCallbackOwnership<Any>()
        val owner = Any()

        ownership.install(owner)

        assertTrue(ownership.release(owner))
        assertFalse(ownership.release(owner))
        assertNull(ownership.current())
    }

    @Test
    fun `install rejects concurrent callback ownership`() {
        val ownership = BluetoothCallbackOwnership<Any>()
        ownership.install(Any())

        assertThrows(IllegalStateException::class.java) {
            ownership.install(Any())
        }
    }

    @Test
    fun `any pending notification disconnect rotates ownership before same device reconnects`() {
        assertTrue(
            AndroidGattServerNotificationRestartPolicyV1.requiresRestart(
                disconnectedPeerToken = 7L,
                notificationCallbackPending = true
            )
        )
        assertFalse(
            AndroidGattServerNotificationRestartPolicyV1.requiresRestart(
                disconnectedPeerToken = 7L,
                notificationCallbackPending = false
            )
        )

        val ownership = BluetoothCallbackOwnership<NotificationCallbackAdapter>()
        val completions = mutableListOf<String>()
        val sameDevice = "same-device"
        val lifecycleA = NotificationCallbackAdapter(ownership, sameDevice) {
            completions += "A:$it"
        }
        val lifecycleB = NotificationCallbackAdapter(ownership, sameDevice) {
            completions += "B:$it"
        }
        ownership.install(lifecycleA)
        assertSame(lifecycleA, ownership.clear())
        ownership.install(lifecycleB)

        lifecycleA.onNotificationSent()
        assertTrue(completions.isEmpty())
        lifecycleB.onNotificationSent()
        assertEquals(listOf("B:$sameDevice"), completions)
    }
}
