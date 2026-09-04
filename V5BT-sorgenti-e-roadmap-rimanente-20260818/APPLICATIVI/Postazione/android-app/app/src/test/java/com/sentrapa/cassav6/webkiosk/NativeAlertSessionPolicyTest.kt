package com.sentrapa.cassav6.webkiosk

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeAlertSessionPolicyTest {
    @Test
    fun `authenticated current background signal may emit`() {
        assertTrue(
            shouldEmitNativeAlert(
                sessionActive = true,
                appForeground = false,
                signalGeneration = 8,
                activeGeneration = 8
            )
        )
    }

    @Test
    fun `logout rejects callback already in flight`() {
        assertFalse(
            shouldEmitNativeAlert(
                sessionActive = false,
                appForeground = false,
                signalGeneration = 8,
                activeGeneration = 8
            )
        )
    }

    @Test
    fun `reset rejects queued signal from previous generation`() {
        assertFalse(
            shouldEmitNativeAlert(
                sessionActive = true,
                appForeground = false,
                signalGeneration = 7,
                activeGeneration = 8
            )
        )
    }

    @Test
    fun `foreground state rejects native alert`() {
        assertFalse(
            shouldEmitNativeAlert(
                sessionActive = true,
                appForeground = true,
                signalGeneration = 8,
                activeGeneration = 8
            )
        )
    }
}
