package com.sentrapa.webkiosk

import java.util.concurrent.CopyOnWriteArraySet

object AppForegroundState {
    private val listeners = CopyOnWriteArraySet<(Boolean) -> Unit>()

    @Volatile
    var isForeground: Boolean = false
        private set

    @Volatile
    private var activityVisible = false

    @Volatile
    private var deviceInteractive = true

    fun markForeground() {
        update(activityVisible = true)
    }

    fun markBackground() {
        update(activityVisible = false)
    }

    fun setDeviceInteractive(isInteractive: Boolean) {
        update(deviceInteractive = isInteractive)
    }

    fun addListener(listener: (Boolean) -> Unit) {
        listeners.add(listener)
        listener(isForeground)
    }

    fun removeListener(listener: (Boolean) -> Unit) {
        listeners.remove(listener)
    }

    @Synchronized
    private fun update(
        activityVisible: Boolean? = null,
        deviceInteractive: Boolean? = null
    ) {
        activityVisible?.let { this.activityVisible = it }
        deviceInteractive?.let { this.deviceInteractive = it }
        val next = this.activityVisible && this.deviceInteractive
        if (isForeground == next) return
        isForeground = next
        listeners.forEach { listener -> runCatching { listener(next) } }
    }
}
