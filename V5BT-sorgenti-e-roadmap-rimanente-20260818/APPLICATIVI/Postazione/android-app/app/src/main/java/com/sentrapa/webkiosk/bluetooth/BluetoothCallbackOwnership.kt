package com.sentrapa.webkiosk.bluetooth

internal class BluetoothCallbackOwnership<T : Any> {
    private var owner: T? = null

    @Synchronized
    fun install(nextOwner: T) {
        check(owner == null) {
            "a callback owner is already active"
        }
        owner = nextOwner
    }

    @Synchronized
    fun current(): T? = owner

    @Synchronized
    fun isOwner(candidate: T): Boolean = owner === candidate

    @Synchronized
    fun release(candidate: T): Boolean {
        if (owner !== candidate) return false
        owner = null
        return true
    }

    @Synchronized
    fun clear(): T? = owner.also { owner = null }
}
