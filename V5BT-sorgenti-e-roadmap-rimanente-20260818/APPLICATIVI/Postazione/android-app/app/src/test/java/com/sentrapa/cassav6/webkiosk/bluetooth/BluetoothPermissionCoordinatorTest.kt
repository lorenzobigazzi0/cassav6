package com.sentrapa.cassav6.webkiosk.bluetooth

import android.Manifest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothPermissionCoordinatorTest {
    @Test
    fun `runtime permission set starts at Android 12`() {
        assertEquals(
            emptyList<String>(),
            BluetoothPermissionCoordinator.runtimePermissionsForApi(30)
        )
        assertEquals(
            listOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT
            ),
            BluetoothPermissionCoordinator.runtimePermissionsForApi(31)
        )
    }

    @Test
    fun `all three nearby permissions are mandatory`() {
        assertTrue(BluetoothPermissionSnapshot(true, true, true).allGranted)
        assertFalse(BluetoothPermissionSnapshot(false, true, true).allGranted)
        assertFalse(BluetoothPermissionSnapshot(true, false, true).allGranted)
        assertFalse(BluetoothPermissionSnapshot(true, true, false).allGranted)
    }
}
