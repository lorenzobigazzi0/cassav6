package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothRadioStartupGateTest {
    @Test
    fun `current success completes startup exactly once`() {
        val gate = BluetoothRadioStartupGate()
        gate.activateAdvertisement(1L)

        assertEquals(
            BluetoothRadioStartupAction.COMPLETE_STARTUP,
            gate.onAdvertisementStarted(1L)
        )
        assertTrue(gate.hasCompletedStartup())
        assertEquals(
            BluetoothRadioStartupAction.IGNORE,
            gate.onAdvertisementStarted(1L)
        )
    }

    @Test
    fun `replacement can complete startup after initial generation becomes stale`() {
        val gate = BluetoothRadioStartupGate()
        gate.activateAdvertisement(1L)
        gate.activateAdvertisement(2L)

        assertEquals(
            BluetoothRadioStartupAction.IGNORE,
            gate.onAdvertisementStarted(1L)
        )
        assertFalse(gate.hasCompletedStartup())
        assertEquals(
            BluetoothRadioStartupAction.COMPLETE_STARTUP,
            gate.onAdvertisementStarted(2L)
        )
        assertTrue(gate.hasCompletedStartup())
    }

    @Test
    fun `replacement after startup records update without completing again`() {
        val gate = BluetoothRadioStartupGate()
        gate.activateAdvertisement(1L)
        gate.onAdvertisementStarted(1L)
        gate.activateAdvertisement(2L)

        assertEquals(
            BluetoothRadioStartupAction.RECORD_REPLACEMENT,
            gate.onAdvertisementStarted(2L)
        )
        assertEquals(
            BluetoothRadioStartupAction.IGNORE,
            gate.onAdvertisementStarted(2L)
        )
        assertTrue(gate.hasCompletedStartup())
    }

    @Test
    fun `stale duplicate and post stop failures are ignored`() {
        val gate = BluetoothRadioStartupGate()
        gate.activateAdvertisement(1L)
        gate.activateAdvertisement(2L)

        assertFalse(gate.shouldHandleFailure(1L))
        assertTrue(gate.shouldHandleFailure(2L))
        gate.onAdvertisementStarted(2L)
        assertFalse(gate.shouldHandleFailure(2L))

        gate.reset()
        assertFalse(gate.hasCompletedStartup())
        assertFalse(gate.shouldHandleFailure(2L))
        assertEquals(
            BluetoothRadioStartupAction.IGNORE,
            gate.onAdvertisementStarted(2L)
        )
    }
}
