package com.sentrapa.webkiosk.bluetooth

internal enum class BluetoothRadioStartupAction {
    IGNORE,
    COMPLETE_STARTUP,
    RECORD_REPLACEMENT
}

internal class BluetoothRadioStartupGate {
    private var activeGeneration: Long? = null
    private var successfulGeneration: Long? = null
    private var startupComplete = false

    @Synchronized
    fun activateAdvertisement(generation: Long) {
        require(generation > 0L)
        activeGeneration = generation
    }

    @Synchronized
    fun onAdvertisementStarted(generation: Long): BluetoothRadioStartupAction {
        if (
            activeGeneration != generation ||
            successfulGeneration == generation
        ) {
            return BluetoothRadioStartupAction.IGNORE
        }
        successfulGeneration = generation
        return if (startupComplete) {
            BluetoothRadioStartupAction.RECORD_REPLACEMENT
        } else {
            startupComplete = true
            BluetoothRadioStartupAction.COMPLETE_STARTUP
        }
    }

    @Synchronized
    fun shouldHandleFailure(generation: Long): Boolean =
        activeGeneration == generation && successfulGeneration != generation

    @Synchronized
    fun hasCompletedStartup(): Boolean = startupComplete

    @Synchronized
    fun invalidateAdvertisement(generation: Long) {
        if (activeGeneration == generation) activeGeneration = null
    }

    @Synchronized
    fun reset() {
        activeGeneration = null
        successfulGeneration = null
        startupComplete = false
    }
}
