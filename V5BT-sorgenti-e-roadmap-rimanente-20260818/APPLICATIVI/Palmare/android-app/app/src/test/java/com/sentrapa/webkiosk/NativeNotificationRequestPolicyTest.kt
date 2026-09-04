package com.sentrapa.webkiosk

import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeNotificationRequestPolicyTest {
    private val currentSession = NotificationClientContext(
        token = "token-b",
        userId = "user-b",
        username = "mario",
        deviceUuid = "device-b",
        sessionStartedAt = 2_000L
    )

    @Test
    fun `matching authenticated session may deliver response`() {
        assertTrue(
            shouldDeliverNativeNotificationResponse(
                requestGeneration = 4L,
                activeGeneration = 4L,
                requestIdentityKey = "token-a|user-a|mario|device-a|room-a",
                activeIdentityKey = "token-a|user-a|mario|device-a|room-a",
                persistedIdentityKey = "token-a|user-a|mario|device-a|room-a",
                activeAuthenticated = true,
                persistedAuthenticated = true
            )
        )
    }

    @Test
    fun `logout rejects response already in flight`() {
        assertFalse(
            shouldDeliverNativeNotificationResponse(
                requestGeneration = 4L,
                activeGeneration = 5L,
                requestIdentityKey = "old-session",
                activeIdentityKey = "logged-out",
                persistedIdentityKey = "logged-out",
                activeAuthenticated = false,
                persistedAuthenticated = false
            )
        )
    }

    @Test
    fun `cleared persisted auth stops transport even when old url and memory remain`() {
        assertTrue(
            shouldRunNativeNotificationTransport(
                isForeground = false,
                savedUrl = "https://192.0.2.1/mobile/",
                activeContext = currentSession,
                persistedContext = currentSession
            )
        )

        assertFalse(
            shouldRunNativeNotificationTransport(
                isForeground = false,
                savedUrl = "https://192.0.2.1/mobile/",
                activeContext = currentSession,
                persistedContext = NotificationClientContext()
            )
        )
    }

    @Test
    fun `session clear registry stops active transport synchronously and no retry is eligible`() {
        val registry = NativeNotificationSessionStopRegistry()
        var stopCount = 0
        val target = NativeNotificationSessionStopTarget { stopCount += 1 }
        registry.register(target)

        assertEquals(1, registry.stopAll())
        assertEquals(1, stopCount)
        assertFalse(
            shouldRunNativeNotificationTransport(
                isForeground = false,
                savedUrl = "https://192.0.2.1/mobile/",
                activeContext = currentSession,
                persistedContext = NotificationClientContext()
            )
        )

        registry.unregister(target)
        assertEquals(0, registry.stopAll())
        assertEquals(1, stopCount)
    }

    @Test
    fun `new identity rejects old session response`() {
        assertFalse(
            shouldDeliverNativeNotificationResponse(
                requestGeneration = 7L,
                activeGeneration = 7L,
                requestIdentityKey = "session-a",
                activeIdentityKey = "session-b",
                persistedIdentityKey = "session-b",
                activeAuthenticated = true,
                persistedAuthenticated = true
            )
        )
    }

    @Test
    fun `persisted identity change closes refresh window`() {
        assertFalse(
            shouldDeliverNativeNotificationResponse(
                requestGeneration = 8L,
                activeGeneration = 8L,
                requestIdentityKey = "session-a",
                activeIdentityKey = "session-a",
                persistedIdentityKey = "session-b",
                activeAuthenticated = true,
                persistedAuthenticated = true
            )
        )
    }

    @Test
    fun `request generation wraps without reusing current maximum`() {
        assertTrue(nextNotificationRequestGeneration(Long.MAX_VALUE) == 0L)
        assertTrue(nextNotificationRequestGeneration(9L) == 10L)
    }

    @Test
    fun `notification predating login is rejected`() {
        assertFalse(isNativeNotificationFreshForSession(1_999L, 2_000L))
    }

    @Test
    fun `notification created in current session is accepted`() {
        assertTrue(isNativeNotificationFreshForSession(2_000L, 2_000L))
    }

    @Test
    fun `native ingress requires exact current audience and session stamp`() {
        assertTrue(
            shouldAcceptNativeNotificationIngress(
                context = currentSession,
                createdAt = 2_100L,
                targetDeviceUuid = "device-b",
                targetSessionStartedAt = 2_000L,
                targetUserId = "user-b",
                targetUsername = null
            )
        )
        assertFalse(
            shouldAcceptNativeNotificationIngress(
                context = currentSession,
                createdAt = 2_100L,
                targetDeviceUuid = "device-a",
                targetSessionStartedAt = 1_000L,
                targetUserId = "user-a",
                targetUsername = null
            )
        )
        assertFalse(
            shouldAcceptNativeNotificationIngress(
                context = currentSession,
                createdAt = 2_100L,
                targetDeviceUuid = "device-b",
                targetSessionStartedAt = null,
                targetUserId = "user-b",
                targetUsername = null
            )
        )
    }

    @Test
    fun `queued command from previous session generation is rejected`() {
        assertFalse(
            shouldProcessNativeNotificationCommand(
                4L,
                5L,
                currentSession.sessionBindingKey,
                currentSession.sessionBindingKey
            )
        )
        assertFalse(
            shouldProcessNativeNotificationCommand(
                5L,
                5L,
                currentSession.sessionBindingKey,
                currentSession.copy(token = "token-c").sessionBindingKey
            )
        )
        assertTrue(
            shouldProcessNativeNotificationCommand(
                5L,
                5L,
                currentSession.sessionBindingKey,
                currentSession.sessionBindingKey
            )
        )
    }

    @Test
    fun `ingress event remains bound to the session that accepted it`() {
        val event = NativeNotificationEvent(
            id = "notification-1",
            tone = NotificationTone.BELL,
            title = "Comanda pronta",
            text = "Tavolo 1",
            createdAt = 2_100L,
            sessionBindingKey = currentSession.sessionBindingKey
        )

        assertTrue(shouldEnqueueNativeNotification(event, currentSession))
        assertFalse(
            shouldEnqueueNativeNotification(
                event,
                currentSession.copy(token = "token-c", sessionStartedAt = 3_000L)
            )
        )
    }

    @Test
    fun `session binding is opaque and changes with token or epoch`() {
        val binding = currentSession.sessionBindingKey

        assertEquals(64, binding.length)
        assertFalse(binding.contains(currentSession.token))
        assertFalse(binding.contains(currentSession.userId))
        assertFalse(binding == currentSession.copy(token = "token-c").sessionBindingKey)
        assertFalse(binding == currentSession.copy(sessionStartedAt = 3_000L).sessionBindingKey)
    }

    @Test
    fun `native requests authenticate in headers without exposing token in query`() {
        val request = applyNotificationSessionHeaders(
            Request.Builder().url(
                "https://127.0.0.1/api/integration/notifications/pull?clientApp=mobile-frontend"
            ),
            currentSession
        ).build()

        assertEquals("Bearer token-b", request.header("Authorization"))
        assertEquals("user-b", request.header("X-User-Id"))
        assertEquals("mario", request.header("X-Username"))
        assertEquals("device-b", request.header("X-Device-Uuid"))
        assertEquals("2000", request.header("X-Session-Started-At"))
        assertFalse(request.url.query.orEmpty().contains(currentSession.token))
    }
}
