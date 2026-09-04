package com.sentrapa.cassav6.webkiosk.bluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.ParcelUuid

internal enum class BluetoothControllerScanFilterMode {
    SERVICE_DATA_V1,
    UNFILTERED_ANDROID_12_NON_GATE
}

enum class BluetoothScanDiagnosticEvent {
    RAW_CALLBACK,
    UUID_MATCH
}

internal object BluetoothScanCompatibilityPolicy {
    const val MAX_SOFTWARE_INSPECTIONS_PER_SCAN = 4_096
    const val MAX_SOFTWARE_MATCHES_PER_SCAN =
        BluetoothDiscoveryPolicy.MAX_PENDING_SCAN_RESULTS

    fun controllerFilterMode(
        androidApi: Int,
        platformProfile: BluetoothDiscoveryPlatformProfile
    ): BluetoothControllerScanFilterMode =
        if (
            platformProfile == BluetoothDiscoveryPlatformProfile.API31_COMPAT_NON_GATE &&
            androidApi in 31..32
        ) {
            BluetoothControllerScanFilterMode.UNFILTERED_ANDROID_12_NON_GATE
        } else {
            BluetoothControllerScanFilterMode.SERVICE_DATA_V1
        }
}

internal object BluetoothAdvertisementScanMatcherV1 {
    fun matches(payload: ByteArray?): Boolean {
        if (payload == null || payload.size != BluetoothAdvertisementCodecV1.PAYLOAD_BYTES) {
            return false
        }
        val header = payload[0].toInt() and 0xff
        if (header and 0xc0 != 0) return false
        if (header and 0x07 != BluetoothAdvertisementCodecV1.PROTOCOL_VERSION) return false
        return BluetoothAdvertisementNodeKind.fromWireCode((header shr 3) and 0x03) != null
    }
}

internal class BluetoothSoftwareScanBudget(
    private val maximumInspections: Int =
        BluetoothScanCompatibilityPolicy.MAX_SOFTWARE_INSPECTIONS_PER_SCAN,
    private val maximumMatches: Int =
        BluetoothScanCompatibilityPolicy.MAX_SOFTWARE_MATCHES_PER_SCAN
) {
    private var inspections = 0
    private var matches = 0

    init {
        require(maximumInspections > 0)
        require(maximumMatches > 0)
        require(maximumMatches <= maximumInspections)
    }

    fun tryInspect(): Boolean {
        if (inspections >= maximumInspections) return false
        inspections += 1
        return true
    }

    fun tryAcquireMatch(): Boolean {
        if (matches >= maximumMatches) return false
        matches += 1
        return true
    }
}

class BleScanner(
    context: Context,
    private val platformProfile: BluetoothDiscoveryPlatformProfile
) {
    private val appContext = context.applicationContext
    private val serviceUuid = ParcelUuid.fromString(BluetoothAdvertisementCodecV1.SERVICE_UUID)
    private val callbackOwnership = BluetoothCallbackOwnership<ScanCallback>()

    @get:Synchronized
    val isRunning: Boolean
        get() = callbackOwnership.current() != null

    @SuppressLint("MissingPermission")
    @Synchronized
    fun start(
        profile: BluetoothScanProfile,
        onServiceData: (BluetoothDevice, ByteArray, Int) -> Unit,
        onDiagnostic: (BluetoothScanDiagnosticEvent) -> Unit,
        onFailure: (Int) -> Unit
    ): Boolean {
        if (callbackOwnership.current() != null) return true
        val scanner =
            runCatching {
                val manager =
                    appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
                manager?.adapter?.bluetoothLeScanner
            }.getOrNull() ?: return false
        val controllerFilterMode =
            BluetoothScanCompatibilityPolicy.controllerFilterMode(
                androidApi = android.os.Build.VERSION.SDK_INT,
                platformProfile = platformProfile
            )
        val softwareScanBudget =
            if (
                controllerFilterMode ==
                BluetoothControllerScanFilterMode.UNFILTERED_ANDROID_12_NON_GATE
            ) {
                BluetoothSoftwareScanBudget()
            } else {
                null
            }
        val scanCallback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                synchronized(this@BleScanner) {
                    if (!callbackOwnership.isOwner(this)) return
                    emit(result, softwareScanBudget, onServiceData, onDiagnostic)
                }
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>) {
                results.forEach { result ->
                    synchronized(this@BleScanner) {
                        if (!callbackOwnership.isOwner(this)) return
                        emit(result, softwareScanBudget, onServiceData, onDiagnostic)
                    }
                }
            }

            override fun onScanFailed(errorCode: Int) {
                val owned =
                    synchronized(this@BleScanner) {
                        callbackOwnership.release(this)
                    }
                if (owned) onFailure(errorCode)
            }
        }
        val filters =
            when (controllerFilterMode) {
                BluetoothControllerScanFilterMode.SERVICE_DATA_V1 ->
                    listOf(
                        ScanFilter.Builder()
                            .setServiceData(
                                serviceUuid,
                                byteArrayOf(
                                    BluetoothAdvertisementCodecV1.PROTOCOL_VERSION.toByte()
                                ),
                                byteArrayOf(0x07)
                            )
                            .build()
                    )
                BluetoothControllerScanFilterMode.UNFILTERED_ANDROID_12_NON_GATE ->
                    emptyList()
            }
        val settings = ScanSettings.Builder()
            .setScanMode(
                when (profile) {
                    BluetoothScanProfile.STABLE -> ScanSettings.SCAN_MODE_LOW_POWER
                    BluetoothScanProfile.FAILOVER -> ScanSettings.SCAN_MODE_LOW_LATENCY
                }
            )
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
            .setReportDelay(0L)
            .build()

        return try {
            callbackOwnership.install(scanCallback)
            scanner.startScan(filters, settings, scanCallback)
            true
        } catch (_: SecurityException) {
            callbackOwnership.release(scanCallback)
            false
        } catch (_: RuntimeException) {
            callbackOwnership.release(scanCallback)
            false
        }
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    fun stop() {
        val activeCallback = callbackOwnership.clear() ?: return
        runCatching {
            val manager =
                appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            manager?.adapter?.bluetoothLeScanner?.stopScan(activeCallback)
        }
    }

    private fun emit(
        result: ScanResult,
        softwareScanBudget: BluetoothSoftwareScanBudget?,
        onServiceData: (BluetoothDevice, ByteArray, Int) -> Unit,
        onDiagnostic: (BluetoothScanDiagnosticEvent) -> Unit
    ) {
        notifyDiagnostic(BluetoothScanDiagnosticEvent.RAW_CALLBACK, onDiagnostic)
        if (softwareScanBudget != null && !softwareScanBudget.tryInspect()) return
        val payload = result.scanRecord?.getServiceData(serviceUuid) ?: return
        notifyDiagnostic(BluetoothScanDiagnosticEvent.UUID_MATCH, onDiagnostic)
        if (
            softwareScanBudget != null &&
            (
                !BluetoothAdvertisementScanMatcherV1.matches(payload) ||
                    !softwareScanBudget.tryAcquireMatch()
                )
        ) {
            return
        }
        onServiceData(result.device, payload.copyOf(), result.rssi)
    }

    private fun notifyDiagnostic(
        event: BluetoothScanDiagnosticEvent,
        onDiagnostic: (BluetoothScanDiagnosticEvent) -> Unit
    ) {
        runCatching { onDiagnostic(event) }
    }
}
