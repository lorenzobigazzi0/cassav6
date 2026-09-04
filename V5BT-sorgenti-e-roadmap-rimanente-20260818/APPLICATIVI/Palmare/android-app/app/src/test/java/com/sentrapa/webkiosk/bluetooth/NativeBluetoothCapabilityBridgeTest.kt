package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeBluetoothCapabilityBridgeTest {
    @Test
    fun gattServerProbeRequiresDiagnosticLabBuild() {
        assertFalse(shouldAllowGattServerCapabilityProbe(false, false))
        assertFalse(shouldAllowGattServerCapabilityProbe(true, false))
        assertFalse(shouldAllowGattServerCapabilityProbe(false, true))
        assertTrue(shouldAllowGattServerCapabilityProbe(true, true))
    }
}
