package com.sentrapa.webkiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeSessionContextTest {
    @Test
    fun `notification pull is fail closed without token`() {
        val context = NotificationClientContext(
            userId = "user-1",
            username = "mario",
            deviceUuid = "device-1"
        )

        assertFalse(context.hasAuthenticatedSession)
        assertFalse(context.canPullNotifications)
        assertFalse(context.canUseRadio)
    }

    @Test
    fun `authenticated user and device enable notification pull`() {
        val context = NotificationClientContext(
            token = "session-token",
            userId = "user-1",
            username = "mario",
            deviceUuid = "device-1"
        )

        assertTrue(context.hasAuthenticatedSession)
        assertTrue(context.canPullNotifications)
        assertTrue(context.canUseRadio)
    }

    @Test
    fun `username fallback enables notifications but not authenticated radio`() {
        val context = NotificationClientContext(
            token = "session-token",
            username = "mario",
            deviceUuid = "device-1"
        )

        assertTrue(context.hasAuthenticatedSession)
        assertTrue(context.canPullNotifications)
        assertFalse(context.canUseRadio)
    }

    @Test
    fun `camel case bridge contract is parsed`() {
        val context = notificationClientContextFromValues(
            mapOf(
                "token" to " session-token ",
                "userId" to " user-1 ",
                "username" to " mario ",
                "fullName" to " Mario Rossi ",
                "deviceUuid" to " device-1 ",
                "roomId" to " room-1 ",
                "roomName" to " Sala "
            )
        )

        assertEquals("session-token", context.token)
        assertEquals("user-1", context.userId)
        assertEquals("device-1", context.deviceUuid)
        assertEquals("room-1", context.roomId)
        assertTrue(context.hasAuthenticatedSession)
    }

    @Test
    fun `legacy storage names remain compatible`() {
        val context = notificationClientContextFromValues(
            mapOf(
                "pos_token" to "legacy-token",
                "pos_user_id" to "legacy-user",
                "pos_user" to "mario",
                "pos_device_uuid" to "legacy-device"
            )
        )

        assertTrue(context.hasAuthenticatedSession)
        assertEquals("legacy-token", context.token)
        assertEquals("legacy-user", context.userId)
    }

    @Test
    fun `token rotation changes transport identity`() {
        val first = NotificationClientContext(
            token = "token-1",
            userId = "user-1",
            deviceUuid = "device-1"
        )
        val second = first.copy(token = "token-2")

        assertNotEquals(first.identityKey, second.identityKey)
        assertTrue(Regex("^[0-9a-f]{64}$").matches(first.sessionBindingKey))
        assertFalse(first.sessionBindingKey.contains(first.token))
        assertNotEquals(first.sessionBindingKey, second.sessionBindingKey)
    }

    @Test
    fun `always on runtime requires url and authenticated session`() {
        val authenticated = NotificationClientContext(
            token = "token-1",
            userId = "user-1",
            deviceUuid = "device-1"
        )

        assertTrue(shouldStartAuthenticatedRuntime("https://192.168.1.182:5380/mobile/", authenticated))
        assertFalse(shouldStartAuthenticatedRuntime(null, authenticated))
        assertFalse(
            shouldStartAuthenticatedRuntime(
                "https://192.168.1.182:5380/mobile/",
                authenticated.copy(token = "")
            )
        )
    }

    @Test
    fun `session clear invalidates a previously captured callback epoch`() {
        val epoch = NativeSessionEpoch()
        val captured = epoch.capture()

        epoch.advance()

        assertFalse(epoch.isCurrent(captured))
        assertTrue(epoch.isCurrent(epoch.capture()))
    }

    @Test
    fun `accepted update invalidates sibling callbacks from the same epoch`() {
        val epoch = NativeSessionEpoch()
        val firstCallback = epoch.capture()
        val secondCallback = epoch.capture()

        assertTrue(epoch.isCurrent(firstCallback))
        epoch.advance()

        assertFalse(epoch.isCurrent(secondCallback))
    }
}
