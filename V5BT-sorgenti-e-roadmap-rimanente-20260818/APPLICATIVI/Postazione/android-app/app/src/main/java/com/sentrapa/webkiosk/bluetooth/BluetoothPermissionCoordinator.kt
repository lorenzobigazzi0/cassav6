package com.sentrapa.webkiosk.bluetooth

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

data class BluetoothPermissionSnapshot(
    val scanGranted: Boolean,
    val advertiseGranted: Boolean,
    val connectGranted: Boolean
) {
    val allGranted: Boolean
        get() = scanGranted && advertiseGranted && connectGranted
}

class BluetoothPermissionCoordinator(context: Context) {
    private val appContext = context.applicationContext

    fun snapshot(): BluetoothPermissionSnapshot {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return BluetoothPermissionSnapshot(
                scanGranted = true,
                advertiseGranted = true,
                connectGranted = true
            )
        }
        return BluetoothPermissionSnapshot(
            scanGranted = isGranted(Manifest.permission.BLUETOOTH_SCAN),
            advertiseGranted = isGranted(Manifest.permission.BLUETOOTH_ADVERTISE),
            connectGranted = isGranted(Manifest.permission.BLUETOOTH_CONNECT)
        )
    }

    private fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(appContext, permission) ==
            PackageManager.PERMISSION_GRANTED

    companion object {
        fun runtimePermissionsForApi(androidApi: Int): List<String> =
            if (androidApi >= Build.VERSION_CODES.S) {
                listOf(
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_ADVERTISE,
                    Manifest.permission.BLUETOOTH_CONNECT
                )
            } else {
                emptyList()
            }
    }
}
