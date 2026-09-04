package com.sentrapa.cassav6.webkiosk

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
            deviceUuid = "device-1",
            sessionStartedAt = 1_000L
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
            deviceUuid = "device-1",
            sessionStartedAt = 1_000L
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
                "sessionStartedAt" to " 1000 ",
                "roomId" to " room-1 ",
                "roomName" to " Sala "
            )
        )

        assertEquals("session-token", context.token)
        assertEquals("user-1", context.userId)
        assertEquals("device-1", context.deviceUuid)
        assertEquals(1_000L, context.sessionStartedAt)
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
                "pos_device_uuid" to "legacy-device",
                "pos_auth_session_started_at" to "1000"
            )
        )

        assertTrue(context.hasAuthenticatedSession)
        assertEquals("legacy-token", context.token)
        assertEquals("legacy-user", context.userId)
    }

    @Test
    fun `page reload storage capture preserves the server session epoch`() {
        assertTrue(NOTIFICATION_CONTEXT_STORAGE_JS.contains("'pos_auth_session_started_at'"))
        assertFalse(NOTIFICATION_CONTEXT_STORAGE_JS.contains("'pos_session_started_at'"))
    }

    @Test
    fun `token rotation changes transport identity`() {
        val first = NotificationClientContext(
            token = "token-1",
            userId = "user-1",
            deviceUuid = "device-1",
            sessionStartedAt = 1_000L
        )
        val second = first.copy(token = "token-2")

        assertNotEquals(first.identityKey, second.identityKey)
    }

    @Test
    fun `always on runtime requires url and authenticated session`() {
        val authenticated = NotificationClientContext(
            token = "token-1",
            userId = "user-1",
            deviceUuid = "device-1",
            sessionStartedAt = 1_000L
        )

        assertTrue(shouldStartAuthenticatedRuntime("https://192.168.1.182:5480/mobile/", authenticated))
        assertFalse(shouldStartAuthenticatedRuntime(null, authenticated))
        assertFalse(
            shouldStartAuthenticatedRuntime(
                "https://192.168.1.182:5480/mobile/",
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

    @Test
    fun `numeric bridge session epoch is parsed without string coercion loss`() {
        val context = NativeSessionContextStore.parse(
            """{"token":"token-1","userId":"user-1","username":"mario","deviceUuid":"device-1","sessionStartedAt":1718000000123}"""
        )

        assertEquals(1_718_000_000_123L, context?.sessionStartedAt)
        assertTrue(context?.hasAuthenticatedSession == true)
    }

    @Test
    fun `missing bridge session epoch is fail closed`() {
        val context = notificationClientContextFromValues(
            mapOf(
                "token" to "token-1",
                "userId" to "user-1",
                "deviceUuid" to "device-1"
            )
        )

        assertFalse(context.hasAuthenticatedSession)
    }

    @Test
    fun `numeric bridge identity fields are rejected`() {
        val context = NativeSessionContextStore.parse(
            """{"token":123,"userId":456,"deviceUuid":789,"sessionStartedAt":1718000000123}"""
        )

        assertFalse(context?.hasAuthenticatedSession == true)
        assertEquals("", context?.token)
        assertEquals("", context?.deviceUuid)
    }
}
