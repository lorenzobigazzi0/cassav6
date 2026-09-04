package com.sentrapa.cassav6.webkiosk

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeNotificationRequestPolicyTest {
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
}
