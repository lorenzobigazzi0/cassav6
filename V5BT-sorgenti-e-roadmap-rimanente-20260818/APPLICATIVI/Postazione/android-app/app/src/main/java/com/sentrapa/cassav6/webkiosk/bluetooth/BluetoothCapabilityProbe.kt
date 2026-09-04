package com.sentrapa.cassav6.webkiosk.bluetooth

import android.Manifest
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

data class BluetoothCapabilityReport(
    val manufacturer: String,
    val model: String,
    val androidApi: Int,
    val bluetoothLeFeature: Boolean,
    val adapterPresent: Boolean,
    val adapterEnabled: Boolean?,
    val scanPermission: Boolean,
    val advertisePermission: Boolean,
    val connectPermission: Boolean,
    val scannerAvailable: Boolean?,
    val advertiserAvailable: Boolean?,
    val gattClientAvailable: Boolean?,
    val multipleAdvertisementSupported: Boolean?,
    val offloadedFilteringSupported: Boolean?,
    val offloadedScanBatchingSupported: Boolean?,
    val gattServerOpen: Boolean?,
    val assessment: BluetoothCapabilityAssessment
) {
    fun toJson(): String {
        val capabilities = assessment.capabilities
        return JSONObject()
            .put("manufacturer", manufacturer)
            .put("model", model)
            .put("androidApi", androidApi)
            .put("bluetoothLeFeature", bluetoothLeFeature)
            .put("adapterPresent", adapterPresent)
            .put("adapterEnabled", jsonValue(adapterEnabled))
            .put("scanPermission", scanPermission)
            .put("advertisePermission", advertisePermission)
            .put("connectPermission", connectPermission)
            .put("scannerAvailable", jsonValue(scannerAvailable))
            .put("advertiserAvailable", jsonValue(advertiserAvailable))
            .put("gattClientAvailable", jsonValue(gattClientAvailable))
            .put("multipleAdvertisementSupported", jsonValue(multipleAdvertisementSupported))
            .put("offloadedFilteringSupported", jsonValue(offloadedFilteringSupported))
            .put("offloadedScanBatchingSupported", jsonValue(offloadedScanBatchingSupported))
            .put("gattServerOpen", jsonValue(gattServerOpen))
            .put("probeStatus", assessment.status.name)
            .put("scan", jsonValue(capabilities?.scan))
            .put("advertise", jsonValue(capabilities?.advertise))
            .put("gattClient", jsonValue(capabilities?.gattClient))
            .put("gattServer", jsonValue(capabilities?.gattServer))
            .put("classification", jsonValue(assessment.classification?.name))
            .put("b0GateComplete", false)
            .put(
                "pendingFieldTests",
                JSONArray(
                    listOf(
                        "SCAN_ADVERTISE_CONCURRENT",
                        "WIFI_BLE_COEXISTENCE",
                        "BACKGROUND_FOREGROUND"
                    )
                )
            )
            .toString()
    }
}

class BluetoothCapabilityProbe(context: Context) {
    private val appContext = context.applicationContext
    private val bluetoothManager =
        appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

    fun probe(probeGattServer: Boolean = false): BluetoothCapabilityReport {
        val adapter = bluetoothManager?.adapter
        val bluetoothLeFeature = appContext.packageManager.hasSystemFeature(
            PackageManager.FEATURE_BLUETOOTH_LE
        )
        val scanPermission = hasScanPermission()
        val advertisePermission = hasAdvertisePermission()
        val connectPermission = hasConnectPermission()
        val adapterEnabled =
            if (adapter != null && connectPermission) {
                runCatching { adapter.isEnabled }.getOrNull()
            } else {
                null
            }
        val bluetoothReady = bluetoothLeFeature && adapter != null && adapterEnabled == true
        val scannerAvailable =
            if (bluetoothReady && scanPermission) {
                runCatching { adapter?.bluetoothLeScanner != null }.getOrNull()
            } else if (!bluetoothLeFeature || adapter == null) {
                false
            } else {
                null
            }
        val advertiserAvailable =
            if (bluetoothReady && advertisePermission && connectPermission) {
                runCatching { adapter?.bluetoothLeAdvertiser != null }.getOrNull()
            } else if (!bluetoothLeFeature || adapter == null) {
                false
            } else {
                null
            }
        val gattClientAvailable =
            when {
                !bluetoothLeFeature || adapter == null -> false
                bluetoothReady && connectPermission -> true
                else -> null
            }
        val gattServerOpen =
            when {
                !bluetoothLeFeature || adapter == null -> false
                bluetoothReady && connectPermission && probeGattServer ->
                    openAndCloseGattServerProbe()
                else -> null
            }
        val assessment = BluetoothCapabilityAssessmentPolicy.assess(
            BluetoothCapabilityObservation(
                bluetoothLeFeature = bluetoothLeFeature,
                adapterPresent = adapter != null,
                adapterEnabled = adapterEnabled,
                scanPermission = scanPermission,
                advertisePermission = advertisePermission,
                connectPermission = connectPermission,
                scannerAvailable = scannerAvailable,
                advertiserAvailable = advertiserAvailable,
                gattClientAvailable = gattClientAvailable,
                gattServerOpen = gattServerOpen
            )
        )

        return BluetoothCapabilityReport(
            manufacturer = Build.MANUFACTURER.orEmpty(),
            model = Build.MODEL.orEmpty(),
            androidApi = Build.VERSION.SDK_INT,
            bluetoothLeFeature = bluetoothLeFeature,
            adapterPresent = adapter != null,
            adapterEnabled = adapterEnabled,
            scanPermission = scanPermission,
            advertisePermission = advertisePermission,
            connectPermission = connectPermission,
            scannerAvailable = scannerAvailable,
            advertiserAvailable = advertiserAvailable,
            gattClientAvailable = gattClientAvailable,
            multipleAdvertisementSupported =
                if (bluetoothReady && advertisePermission && connectPermission) {
                    runCatching { adapter?.isMultipleAdvertisementSupported }.getOrNull()
                } else {
                    null
                },
            offloadedFilteringSupported =
                if (bluetoothReady && scanPermission && connectPermission) {
                    runCatching { adapter?.isOffloadedFilteringSupported }.getOrNull()
                } else {
                    null
                },
            offloadedScanBatchingSupported =
                if (bluetoothReady && scanPermission && connectPermission) {
                    runCatching { adapter?.isOffloadedScanBatchingSupported }.getOrNull()
                } else {
                    null
                },
            gattServerOpen = gattServerOpen,
            assessment = assessment
        )
    }

    private fun openAndCloseGattServerProbe(): Boolean {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            ContextCompat.checkSelfPermission(
                appContext,
                Manifest.permission.BLUETOOTH_CONNECT
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }

        var server: BluetoothGattServer? = null
        return try {
            server = bluetoothManager?.openGattServer(
                appContext,
                object : BluetoothGattServerCallback() {}
            )
            server != null
        } catch (_: SecurityException) {
            false
        } finally {
            try {
                server?.close()
            } catch (_: SecurityException) {
                // Permission can be revoked between opening and closing the probe.
            }
        }
    }

    private fun hasScanPermission(): Boolean =
        when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
                hasPermission(Manifest.permission.BLUETOOTH_SCAN)
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
                hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
            else ->
                hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) ||
                    hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
        }

    private fun hasAdvertisePermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            hasPermission(Manifest.permission.BLUETOOTH_ADVERTISE)

    private fun hasConnectPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            hasPermission(Manifest.permission.BLUETOOTH_CONNECT)

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(appContext, permission) ==
            PackageManager.PERMISSION_GRANTED
}

private fun jsonValue(value: Any?): Any = value ?: JSONObject.NULL
