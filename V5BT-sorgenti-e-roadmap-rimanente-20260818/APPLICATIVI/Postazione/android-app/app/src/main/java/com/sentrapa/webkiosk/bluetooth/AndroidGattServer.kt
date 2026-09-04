package com.sentrapa.webkiosk.bluetooth

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import java.util.UUID

enum class AndroidGattServerState {
    IDLE,
    OPENING,
    PUBLISHING,
    ACTIVE,
    FAILED,
    CLOSED
}

data class AndroidGattServerMetricsSnapshot(
    val openAttempts: Long,
    val serversOpened: Long,
    val serviceAddRequests: Long,
    val servicesPublished: Long,
    val connectionsAccepted: Long,
    val connectionsRejected: Long,
    val disconnects: Long,
    val mtuChanges: Long,
    val reads: Long,
    val writes: Long,
    val descriptorReads: Long,
    val descriptorWrites: Long,
    val notificationsStarted: Long,
    val notificationsCompleted: Long,
    val deniedRequests: Long,
    val failures: Long,
    val resets: Long,
    val closes: Long
)

data class AndroidGattServerSnapshot(
    val state: AndroidGattServerState,
    val enabled: Boolean,
    val active: Boolean,
    val servicePublished: Boolean,
    val sessionCount: Int,
    val helloEnabled: Boolean,
    val metrics: AndroidGattServerMetricsSnapshot,
    val handler: AndroidGattServerSessionHandlerSnapshotV1,
    val reliablePortReady: Boolean = false
)

class AndroidGattServer(
    context: Context,
    private val enabled: Boolean,
    private val helloEnabled: Boolean,
    private val localAdvertisementProvider: () -> BluetoothAdvertisementV1?,
    private val onActiveChanged: (Boolean) -> Unit = {},
    private val androidPeerAuthEnabled: Boolean = false,
    private val androidPeerAuthReady: () -> Boolean = { androidPeerAuthEnabled },
    private val peerAuthSessionFactory: AndroidGattPeerAuthServerSessionFactoryV2? = null,
    sessionHandler: AndroidGattServerSessionHandlerV1? = null,
    private val nowElapsedMs: () -> Long = SystemClock::elapsedRealtime
) : AutoCloseable, GattReliableSessionContextProviderV1 {
    private enum class SubscriptionMode {
        NOTIFY,
        INDICATE
    }

    private data class Peer(
        val token: Long,
        val subscriptions: MutableMap<UUID, SubscriptionMode> = LinkedHashMap()
    )

    private val appContext = context.applicationContext
    private val bluetoothManager =
        appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val identityManager = DeviceIdentityManager(appContext, enabled = helloEnabled)
    private val callbackOwnership = BluetoothCallbackOwnership<BluetoothGattServerCallback>()
    private val expiryHandler = Handler(Looper.getMainLooper())
    private val handler = sessionHandler ?: V5btGattServerSessionHandlerV1(
        enabled = enabled,
        helloEnabled = helloEnabled,
        localContextProvider = ::localContext,
        androidPeerAuthEnabled = androidPeerAuthEnabled,
        androidPeerAuthReady = androidPeerAuthReady,
        peerAuthSessionFactory = peerAuthSessionFactory
    )
    private val peers = LinkedHashMap<BluetoothDevice, Peer>()
    private val devicesByToken = LinkedHashMap<Long, BluetoothDevice>()
    private val characteristics = LinkedHashMap<UUID, BluetoothGattCharacteristic>()
    private val pendingNotifications = LinkedHashMap<Long, ByteArray>()
    private var reliableDataPlane: GattReliableDataPlaneV1? = null
    private var reliablePortListener: AndroidGattReliablePortListenerV1? = null
    private var reliableBridge: AndroidGattReliableDataPlaneBridgeV1? = null
    private var reliableQueue: AndroidGattReliableOperationQueueV1? = null
    private var reliableInFlight: AndroidGattReliableQueuedOperationV1? = null
    private var reliablePeerToken: Long? = null
    private var reliablePortReady = false
    private var server: BluetoothGattServer? = null
    private var service: BluetoothGattService? = null
    private var state = AndroidGattServerState.IDLE
    private var servicePublished = false
    private var nextPeerToken = 1L
    private var activeReported = false
    private var openAttempts = 0L
    private var serversOpened = 0L
    private var serviceAddRequests = 0L
    private var servicesPublished = 0L
    private var connectionsAccepted = 0L
    private var connectionsRejected = 0L
    private var disconnects = 0L
    private var mtuChanges = 0L
    private var reads = 0L
    private var writes = 0L
    private var descriptorReads = 0L
    private var descriptorWrites = 0L
    private var notificationsStarted = 0L
    private var notificationsCompleted = 0L
    private var deniedRequests = 0L
    private var failures = 0L
    private var resets = 0L
    private var closes = 0L
    private var releasingServer = false

    private val expireSessions = object : Runnable {
        override fun run() {
            expireSessionsNow()
            synchronized(this@AndroidGattServer) {
                if (state == AndroidGattServerState.ACTIVE) {
                    expiryHandler.postDelayed(this, SESSION_EXPIRY_POLL_MS)
                }
            }
        }
    }

    init {
        require(!helloEnabled || enabled)
        require(!androidPeerAuthEnabled || helloEnabled)
        require(!androidPeerAuthEnabled || peerAuthSessionFactory != null)
    }

    @get:Synchronized
    val isActive: Boolean
        get() = state == AndroidGattServerState.ACTIVE && servicePublished

    @Synchronized
    fun configureReliableDataPlane(
        dataPlane: GattReliableDataPlaneV1,
        listener: AndroidGattReliablePortListenerV1
    ) {
        check(androidPeerAuthEnabled) {
            "reliable Android data plane requires A2 authentication"
        }
        check(reliableDataPlane == null && server == null && state == AndroidGattServerState.IDLE) {
            "reliable Android data plane must be configured before server start"
        }
        reliableDataPlane = dataPlane
        reliablePortListener = listener
    }

    @Synchronized
    override fun export(sessionToken: Long): GattReliableChannelContextV1 =
        try {
            if (reliablePeerToken != sessionToken || !reliablePortReady) {
                gattReliableDataPlaneFailureV1(
                    "RELIABLE_CHANNEL_NOT_AUTHORIZED",
                    "Android GATT server has no active authenticated data session"
                )
            }
            handler.exportReliableContext(sessionToken)
        } catch (error: Throwable) {
            if (error is GattReliableDataPlaneExceptionV1) throw error
            gattReliableDataPlaneFailureV1(
                "RELIABLE_CHANNEL_NOT_AUTHORIZED",
                "Android GATT server A2 context is unavailable",
                error
            )
        }

    @SuppressLint("MissingPermission")
    @Synchronized
    fun start(): Boolean {
        if (!enabled || state == AndroidGattServerState.CLOSED) return false
        if (server != null) return state in setOf(
            AndroidGattServerState.PUBLISHING,
            AndroidGattServerState.ACTIVE
        )
        if (!hasConnectPermission()) {
            failures += 1L
            state = AndroidGattServerState.FAILED
            return false
        }
        val manager = bluetoothManager ?: run {
            failures += 1L
            state = AndroidGattServerState.FAILED
            return false
        }
        openAttempts += 1L
        state = AndroidGattServerState.OPENING
        val callback = createCallback()
        callbackOwnership.install(callback)
        val opened = try {
            manager.openGattServer(appContext, callback)
        } catch (_: SecurityException) {
            null
        } catch (_: RuntimeException) {
            null
        }
        if (opened == null) {
            callbackOwnership.release(callback)
            failures += 1L
            state = AndroidGattServerState.FAILED
            return false
        }
        server = opened
        serversOpened += 1L
        val profile = createProfileService()
        if (profile == null) {
            failAndRelease(opened)
            return false
        }
        service = profile
        state = AndroidGattServerState.PUBLISHING
        serviceAddRequests += 1L
        val accepted = try {
            opened.addService(profile)
        } catch (_: SecurityException) {
            false
        } catch (_: RuntimeException) {
            false
        }
        if (!accepted) {
            failAndRelease(opened)
            return false
        }
        return true
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    fun revalidatePeerTrustLease(): Boolean {
        val token = reliablePeerToken ?: return true
        if (!reliablePortReady) return true
        val valid = runCatching {
            handler.exportReliableContext(token).use { }
        }.isSuccess
        if (!valid) abortReliableSession()
        return valid
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    fun abortReliableSession(): Boolean {
        val token = reliablePeerToken ?: return false
        val device = devicesByToken[token]
        val peer = device?.let(peers::get)
        if (device == null || peer == null || peer.token != token) {
            clearReliableDataPlaneState(token)
            return false
        }
        disconnectPeer(device, peer)
        return true
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    fun reset() {
        if (state == AndroidGattServerState.CLOSED) return
        releaseServer(permanent = false)
        resets += 1L
        state = AndroidGattServerState.IDLE
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    override fun close() {
        if (state == AndroidGattServerState.CLOSED) return
        releaseServer(permanent = true)
        closes += 1L
        state = AndroidGattServerState.CLOSED
    }

    @Synchronized
    fun snapshot(): AndroidGattServerSnapshot {
        val handlerSnapshot = handler.snapshot()
        return AndroidGattServerSnapshot(
            state = state,
            enabled = enabled,
            active = isActive,
            servicePublished = servicePublished,
            sessionCount = handlerSnapshot.sessionCount,
            helloEnabled = helloEnabled,
            metrics = AndroidGattServerMetricsSnapshot(
                openAttempts = openAttempts,
                serversOpened = serversOpened,
                serviceAddRequests = serviceAddRequests,
                servicesPublished = servicesPublished,
                connectionsAccepted = connectionsAccepted,
                connectionsRejected = connectionsRejected,
                disconnects = disconnects,
                mtuChanges = mtuChanges,
                reads = reads,
                writes = writes,
                descriptorReads = descriptorReads,
                descriptorWrites = descriptorWrites,
                notificationsStarted = notificationsStarted,
                notificationsCompleted = notificationsCompleted,
                deniedRequests = deniedRequests,
                failures = failures,
                resets = resets,
                closes = closes
            ),
            handler = handlerSnapshot,
            reliablePortReady = reliablePortReady
        )
    }

    private fun createCallback(): BluetoothGattServerCallback =
        object : BluetoothGattServerCallback() {
            override fun onServiceAdded(status: Int, addedService: BluetoothGattService) {
                synchronized(this@AndroidGattServer) {
                    if (!callbackOwnership.isOwner(this)) return
                    handleServiceAdded(status, addedService)
                }
            }

            override fun onConnectionStateChange(
                device: BluetoothDevice,
                status: Int,
                newState: Int
            ) {
                synchronized(this@AndroidGattServer) {
                    if (!callbackOwnership.isOwner(this)) return
                    handleConnectionStateChange(device, status, newState)
                }
            }

            override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
                synchronized(this@AndroidGattServer) {
                    if (!callbackOwnership.isOwner(this)) return
                    val peer = peers[device] ?: return
                    mtuChanges += 1L
                    val result = invokeHandler {
                        handler.onMtuChanged(peer.token, mtu, safeNow())
                    }
                    result.use {
                        recordAccess(it)
                        processResult(device, peer, it)
                    }
                }
            }

            override fun onCharacteristicReadRequest(
                device: BluetoothDevice,
                requestId: Int,
                offset: Int,
                characteristic: BluetoothGattCharacteristic
            ) {
                synchronized(this@AndroidGattServer) {
                    if (!callbackOwnership.isOwner(this)) return
                    reads += 1L
                    val peer = peers[device]
                    val result = if (peer == null) {
                        missingPeerResult()
                    } else if (characteristics[characteristic.uuid] !== characteristic) {
                        AndroidGattServerHandlerResultV1.reject(
                            AndroidGattServerAccessStatusV1.REQUEST_NOT_SUPPORTED
                        )
                    } else {
                        invokeHandler {
                            handler.onRead(peer.token, characteristic.uuid, offset, safeNow())
                        }
                    }
                    result.use {
                        recordAccess(it)
                        respond(device, requestId, it, responseOffset = offset)
                        if (peer != null) processResult(device, peer, it)
                    }
                }
            }

            override fun onCharacteristicWriteRequest(
                device: BluetoothDevice,
                requestId: Int,
                characteristic: BluetoothGattCharacteristic,
                preparedWrite: Boolean,
                responseNeeded: Boolean,
                offset: Int,
                value: ByteArray
            ) {
                synchronized(this@AndroidGattServer) {
                    if (!callbackOwnership.isOwner(this)) return
                    writes += 1L
                    if (
                        characteristic.uuid == AndroidGattProfileV1.dataRxUuid &&
                        reliableDataPlane != null
                    ) {
                        handleReliableWrite(
                            device,
                            requestId,
                            characteristic,
                            preparedWrite,
                            responseNeeded,
                            offset,
                            value
                        )
                        return
                    }
                    val input = value.copyOf()
                    val peer = peers[device]
                    val result = try {
                        if (peer == null) {
                            missingPeerResult()
                        } else if (characteristics[characteristic.uuid] !== characteristic) {
                            AndroidGattServerHandlerResultV1.reject(
                                AndroidGattServerAccessStatusV1.REQUEST_NOT_SUPPORTED
                            )
                        } else {
                            invokeHandler {
                                handler.onWrite(
                                    peer.token,
                                    characteristic.uuid,
                                    offset,
                                    preparedWrite,
                                    input,
                                    safeNow()
                                )
                            }
                        }
                    } finally {
                        input.fill(0)
                    }
                    result.use {
                        recordAccess(it)
                        if (responseNeeded) respond(device, requestId, it)
                        if (peer != null) processResult(device, peer, it)
                    }
                }
            }

            override fun onDescriptorReadRequest(
                device: BluetoothDevice,
                requestId: Int,
                offset: Int,
                descriptor: BluetoothGattDescriptor
            ) {
                synchronized(this@AndroidGattServer) {
                    if (!callbackOwnership.isOwner(this)) return
                    descriptorReads += 1L
                    handleDescriptorRead(device, requestId, offset, descriptor)
                }
            }

            override fun onDescriptorWriteRequest(
                device: BluetoothDevice,
                requestId: Int,
                descriptor: BluetoothGattDescriptor,
                preparedWrite: Boolean,
                responseNeeded: Boolean,
                offset: Int,
                value: ByteArray
            ) {
                synchronized(this@AndroidGattServer) {
                    if (!callbackOwnership.isOwner(this)) return
                    descriptorWrites += 1L
                    handleDescriptorWrite(
                        device,
                        requestId,
                        descriptor,
                        preparedWrite,
                        responseNeeded,
                        offset,
                        value
                    )
                }
            }

            override fun onNotificationSent(device: BluetoothDevice, status: Int) {
                synchronized(this@AndroidGattServer) {
                    if (!callbackOwnership.isOwner(this)) return
                    val peer = peers[device] ?: return
                    pendingNotifications.remove(peer.token)?.fill(0)
                    val operation = reliableInFlight
                        ?.takeIf { reliablePeerToken == peer.token }
                    val queue = reliableQueue
                    if (operation != null && queue != null) {
                        reliableInFlight = null
                        runCatching {
                            queue.complete(
                                operation,
                                status == BluetoothGatt.GATT_SUCCESS
                            )
                        }.onFailure {
                            if (peers[device] === peer) disconnectPeer(device, peer)
                        }
                        if (status == BluetoothGatt.GATT_SUCCESS) {
                            notificationsCompleted += 1L
                        }
                        return
                    }
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        notificationsCompleted += 1L
                    } else {
                        failures += 1L
                        disconnectPeer(device, peer)
                    }
                }
            }

            override fun onExecuteWrite(
                device: BluetoothDevice,
                requestId: Int,
                execute: Boolean
            ) {
                synchronized(this@AndroidGattServer) {
                    if (!callbackOwnership.isOwner(this)) return
                    val peer = peers[device]
                    val result = AndroidGattServerHandlerResultV1.reject(
                        AndroidGattServerAccessStatusV1.REQUEST_NOT_SUPPORTED
                    )
                    result.use {
                        recordAccess(it)
                        respond(device, requestId, it)
                    }
                    if (peer != null) disconnectPeer(device, peer)
                }
            }
        }

    @SuppressLint("MissingPermission")
    private fun handleServiceAdded(status: Int, addedService: BluetoothGattService) {
        val activeServer = server ?: return
        if (
            state != AndroidGattServerState.PUBLISHING ||
            status != BluetoothGatt.GATT_SUCCESS ||
            !isCompleteProfile(addedService)
        ) {
            failAndRelease(activeServer)
            return
        }
        servicePublished = true
        servicesPublished += 1L
        state = AndroidGattServerState.ACTIVE
        publishActive(true)
        expiryHandler.removeCallbacks(expireSessions)
        expiryHandler.postDelayed(expireSessions, SESSION_EXPIRY_POLL_MS)
    }

    @SuppressLint("MissingPermission")
    private fun handleConnectionStateChange(
        device: BluetoothDevice,
        status: Int,
        newState: Int
    ) {
        if (newState == BluetoothProfile.STATE_DISCONNECTED) {
            peers[device]?.let { disconnectPeer(device, it, cancelConnection = false) }
            return
        }
        if (
            status != BluetoothGatt.GATT_SUCCESS ||
            newState != BluetoothProfile.STATE_CONNECTED ||
            !isActive ||
            peers.containsKey(device)
        ) {
            connectionsRejected += 1L
            runCatching { server?.cancelConnection(device) }
            return
        }
        val token = allocatePeerToken() ?: run {
            connectionsRejected += 1L
            runCatching { server?.cancelConnection(device) }
            return
        }
        val result = invokeHandler { handler.onConnected(token, safeNow()) }
        result.use {
            if (it.status != AndroidGattServerAccessStatusV1.SUCCESS) {
                connectionsRejected += 1L
                runCatching { server?.cancelConnection(device) }
                return
            }
        }
        val peer = Peer(token)
        peers[device] = peer
        devicesByToken[token] = device
        connectionsAccepted += 1L
    }

    @SuppressLint("MissingPermission")
    private fun handleDescriptorRead(
        device: BluetoothDevice,
        requestId: Int,
        offset: Int,
        descriptor: BluetoothGattDescriptor
    ) {
        val peer = peers[device]
        val characteristic = descriptor.characteristic
        val characteristicUuid = characteristic?.uuid
        if (
            peer == null ||
            descriptor.uuid != AndroidGattProfileV1.clientConfigurationDescriptorUuid ||
            characteristicUuid == null ||
            characteristics[characteristicUuid] !== characteristic ||
            offset != 0
        ) {
            val result = if (offset != 0) {
                AndroidGattServerHandlerResultV1.reject(
                    AndroidGattServerAccessStatusV1.INVALID_OFFSET
                )
            } else {
                missingPeerResult()
            }
            result.use {
                recordAccess(it)
                respond(device, requestId, it, responseOffset = offset)
                if (peer != null && it.disconnect) disconnectPeer(device, peer)
            }
            return
        }
        val value = when (peer.subscriptions[characteristicUuid]) {
            SubscriptionMode.NOTIFY -> BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            SubscriptionMode.INDICATE -> BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
            null -> BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
        }
        AndroidGattServerHandlerResultV1.success(value).use {
            respond(device, requestId, it)
        }
    }

    @SuppressLint("MissingPermission")
    private fun handleDescriptorWrite(
        device: BluetoothDevice,
        requestId: Int,
        descriptor: BluetoothGattDescriptor,
        preparedWrite: Boolean,
        responseNeeded: Boolean,
        offset: Int,
        value: ByteArray
    ) {
        val peer = peers[device]
        val characteristic = descriptor.characteristic
        val characteristicUuid = characteristic?.uuid
        val knownDescriptor =
            descriptor.uuid == AndroidGattProfileV1.clientConfigurationDescriptorUuid &&
                characteristicUuid != null &&
                characteristics[characteristicUuid] === characteristic
        if (peer == null || !knownDescriptor || preparedWrite || offset != 0) {
            val status = if (preparedWrite || offset != 0) {
                AndroidGattServerAccessStatusV1.INVALID_OFFSET
            } else {
                AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION
            }
            val result = AndroidGattServerHandlerResultV1.reject(status)
            result.use {
                recordAccess(it)
                if (responseNeeded) respond(device, requestId, it)
            }
            if (peer != null) disconnectPeer(device, peer)
            return
        }
        if (value.contentEquals(BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE)) {
            val disabledUuid = checkNotNull(characteristicUuid)
            peer.subscriptions.remove(disabledUuid)
            if (responseNeeded) {
                AndroidGattServerHandlerResultV1.success().use {
                    respond(device, requestId, it)
                }
            }
            if (
                disabledUuid == AndroidGattProfileV1.dataTxUuid ||
                disabledUuid == AndroidGattProfileV1.ackTxUuid
            ) {
                disconnectPeer(device, peer)
            }
            return
        }
        val mode = when {
            value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) ->
                SubscriptionMode.NOTIFY
            value.contentEquals(BluetoothGattDescriptor.ENABLE_INDICATION_VALUE) ->
                SubscriptionMode.INDICATE
            else -> null
        }
        if (mode == null) {
            val result = AndroidGattServerHandlerResultV1.reject(
                AndroidGattServerAccessStatusV1.INVALID_ATTRIBUTE_LENGTH
            )
            result.use {
                recordAccess(it)
                if (responseNeeded) respond(device, requestId, it)
            }
            disconnectPeer(device, peer)
            return
        }
        val targetUuid = checkNotNull(characteristicUuid)
        val result = invokeHandler {
            handler.onSubscriptionChanged(
                peer.token,
                targetUuid,
                enabled = true,
                indicate = mode == SubscriptionMode.INDICATE,
                nowElapsedMs = safeNow()
            )
        }
        var activateReliable = false
        result.use {
            recordAccess(it)
            if (it.status == AndroidGattServerAccessStatusV1.SUCCESS) {
                peer.subscriptions[targetUuid] = mode
                activateReliable =
                    reliableDataPlane != null &&
                    peer.subscriptions[AndroidGattProfileV1.dataTxUuid] ==
                        SubscriptionMode.NOTIFY &&
                    peer.subscriptions[AndroidGattProfileV1.ackTxUuid] ==
                        SubscriptionMode.INDICATE
            }
            if (responseNeeded) respond(device, requestId, it)
            processResult(device, peer, it)
        }
        if (activateReliable && peers[device] === peer) {
            tryActivateReliablePeer(device, peer)
        }
    }

    @SuppressLint("MissingPermission")
    private fun handleReliableWrite(
        device: BluetoothDevice,
        requestId: Int,
        characteristic: BluetoothGattCharacteristic,
        preparedWrite: Boolean,
        responseNeeded: Boolean,
        offset: Int,
        value: ByteArray
    ) {
        val peer = peers[device]
        if (
            peer == null ||
            characteristic !== characteristics[AndroidGattProfileV1.dataRxUuid] ||
            preparedWrite ||
            !responseNeeded ||
            offset != 0 ||
            reliablePeerToken != peer.token ||
            !reliablePortReady
        ) {
            val result = AndroidGattServerHandlerResultV1.reject(
                if (preparedWrite || offset != 0) {
                    AndroidGattServerAccessStatusV1.INVALID_OFFSET
                } else {
                    AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION
                }
            )
            result.use {
                recordAccess(it)
                if (responseNeeded) respond(device, requestId, it)
            }
            if (peer != null) disconnectPeer(device, peer)
            return
        }
        val activity = invokeHandler {
            handler.onReliableActivity(peer.token, safeNow())
        }
        var authorized = false
        activity.use {
            recordAccess(it)
            authorized = it.status == AndroidGattServerAccessStatusV1.SUCCESS
            if (!authorized) {
                respond(device, requestId, it)
                processResult(device, peer, it)
            }
        }
        if (!authorized || peers[device] !== peer) return
        val input = value.copyOf()
        val received = try {
            runCatching {
                checkNotNull(reliableBridge).receive(
                    AndroidGattProfileV1.dataRxUuid,
                    input
                )
            }.isSuccess
        } finally {
            input.fill(0)
        }
        AndroidGattServerHandlerResultV1.success().use {
            respond(device, requestId, it)
        }
        if (!received) disconnectPeer(device, peer)
    }

    private fun tryActivateReliablePeer(device: BluetoothDevice, peer: Peer) {
        val plane = reliableDataPlane ?: return
        if (reliablePeerToken == peer.token && reliablePortReady) return
        if (reliablePeerToken != null || reliableQueue != null || reliableBridge != null) {
            disconnectPeer(device, peer)
            return
        }
        val authorized = runCatching {
            handler.exportReliableContext(peer.token).use { context ->
                check(context.role == GattReliableEndpointRoleV1.SERVER)
            }
        }.isSuccess
        if (!authorized) {
            disconnectPeer(device, peer)
            return
        }
        lateinit var queue: AndroidGattReliableOperationQueueV1
        queue = AndroidGattReliableOperationQueueV1(
            starter = { operation, frame ->
                startReliablePublish(device, peer, operation, frame)
            },
            onFatal = {
                synchronized(this@AndroidGattServer) {
                    if (peers[device] === peer) disconnectPeer(device, peer)
                }
            }
        )
        val bridge = try {
            AndroidGattReliableDataPlaneBridgeV1(
                role = GattReliableEndpointRoleV1.SERVER,
                sessionToken = peer.token,
                dataPlane = AndroidGattReliableDataPlaneBindingAdapterV1(plane),
                physicalPublisher = AndroidGattReliablePhysicalPublisherV1 {
                        target,
                        frame ->
                    queue.enqueue(target, frame)
                }
            ).also {
                it.setTransmitterReady(GattReliableTransmitterV1.DATA, true)
                it.setTransmitterReady(GattReliableTransmitterV1.ACK, true)
            }
        } catch (_: RuntimeException) {
            queue.close()
            disconnectPeer(device, peer)
            return
        }
        reliableQueue = queue
        reliableBridge = bridge
        reliablePeerToken = peer.token
        reliablePortReady = true
        val published = runCatching {
            val port = GattReliableApplicationPortV1(plane, peer.token)
            check(port.available)
            check(reliablePortListener?.onChanged(port) == true)
        }.isSuccess
        if (!published) disconnectPeer(device, peer)
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    private fun startReliablePublish(
        device: BluetoothDevice,
        peer: Peer,
        operation: AndroidGattReliableQueuedOperationV1,
        frame: ByteArray
    ): Boolean {
        if (
            !isActive ||
            peers[device] !== peer ||
            reliablePeerToken != peer.token ||
            !reliablePortReady ||
            reliableInFlight != null ||
            pendingNotifications.containsKey(peer.token)
        ) return false
        val target = operation.target
        val expectedMode = when (target.delivery) {
            AndroidGattReliableDeliveryV1.NOTIFY -> SubscriptionMode.NOTIFY
            AndroidGattReliableDeliveryV1.INDICATE -> SubscriptionMode.INDICATE
            AndroidGattReliableDeliveryV1.WRITE_REQUEST -> return false
        }
        if (peer.subscriptions[target.characteristicUuid] != expectedMode) return false
        val characteristic = characteristics[target.characteristicUuid] ?: return false
        val confirm = target.delivery == AndroidGattReliableDeliveryV1.INDICATE
        val payload = frame.copyOf()
        if (payload.size !in 1..MAXIMUM_ATT_VALUE_BYTES) {
            payload.fill(0)
            return false
        }
        val accepted = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                server?.notifyCharacteristicChanged(
                    device,
                    characteristic,
                    confirm,
                    payload
                ) == BluetoothStatusCodes.SUCCESS
            } else {
                characteristic.value = payload
                server?.notifyCharacteristicChanged(
                    device,
                    characteristic,
                    confirm
                ) == true
            }
        } catch (_: SecurityException) {
            false
        } catch (_: RuntimeException) {
            false
        }
        if (!accepted) {
            payload.fill(0)
            return false
        }
        pendingNotifications[peer.token] = payload
        reliableInFlight = operation
        notificationsStarted += 1L
        return true
    }

    @Synchronized
    private fun clearReliableDataPlaneState(expectedPeerToken: Long? = null) {
        if (expectedPeerToken != null && reliablePeerToken != expectedPeerToken) return
        val wasReady = reliablePortReady
        reliablePortReady = false
        reliablePeerToken = null
        reliableInFlight = null
        reliableQueue?.close()
        reliableQueue = null
        val bridge = reliableBridge
        reliableBridge = null
        if (bridge != null) {
            bridge.close()
        } else {
            runCatching { reliableDataPlane?.reset() }
        }
        if (wasReady) runCatching { reliablePortListener?.onChanged(null) }
    }

    @SuppressLint("MissingPermission")
    private fun respond(
        device: BluetoothDevice,
        requestId: Int,
        result: AndroidGattServerHandlerResultV1,
        responseOffset: Int = 0
    ) {
        val payload = result.valueCopy()
        val sent = try {
            server?.sendResponse(
                device,
                requestId,
                androidStatus(result.status),
                responseOffset,
                payload
            ) == true
        } catch (_: SecurityException) {
            false
        } catch (_: RuntimeException) {
            false
        } finally {
            payload?.fill(0)
        }
        if (!sent) failures += 1L
    }

    private fun processResult(
        device: BluetoothDevice,
        peer: Peer,
        result: AndroidGattServerHandlerResultV1
    ) {
        result.outboundCopy()?.use { outbound ->
            if (!publishOutbound(device, peer, outbound)) failures += 1L
        }
        if (result.disconnect) disconnectPeer(device, peer)
    }

    @SuppressLint("MissingPermission")
    private fun publishOutbound(
        device: BluetoothDevice,
        peer: Peer,
        outbound: AndroidGattServerOutboundV1
    ): Boolean {
        if (!isActive || pendingNotifications.containsKey(peer.token)) return false
        val mode = peer.subscriptions[outbound.characteristicUuid] ?: return false
        if (outbound.confirm != (mode == SubscriptionMode.INDICATE)) return false
        val characteristic = characteristics[outbound.characteristicUuid] ?: return false
        val payload = outbound.valueCopy()
        if (payload.isEmpty() || payload.size > MAXIMUM_ATT_VALUE_BYTES) {
            payload.fill(0)
            return false
        }
        val accepted = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                server?.notifyCharacteristicChanged(
                    device,
                    characteristic,
                    outbound.confirm,
                    payload
                ) == BluetoothStatusCodes.SUCCESS
            } else {
                characteristic.value = payload
                server?.notifyCharacteristicChanged(
                    device,
                    characteristic,
                    outbound.confirm
                ) == true
            }
        } catch (_: SecurityException) {
            false
        } catch (_: RuntimeException) {
            false
        }
        if (!accepted) {
            payload.fill(0)
            return false
        }
        pendingNotifications[peer.token] = payload
        notificationsStarted += 1L
        return true
    }

    @SuppressLint("MissingPermission")
    private fun disconnectPeer(
        device: BluetoothDevice,
        peer: Peer,
        cancelConnection: Boolean = true
    ) {
        if (peers.remove(device) == null) return
        val notificationCallbackPending =
            pendingNotifications.containsKey(peer.token) ||
                (reliablePeerToken == peer.token && reliableInFlight != null)
        val restartForStaleNotificationCallback =
            !releasingServer &&
                state == AndroidGattServerState.ACTIVE &&
                AndroidGattServerNotificationRestartPolicyV1.requiresRestart(
                    peer.token,
                    notificationCallbackPending
                )
        clearReliableDataPlaneState(peer.token)
        devicesByToken.remove(peer.token)
        pendingNotifications.remove(peer.token)?.fill(0)
        peer.subscriptions.clear()
        runCatching { handler.onDisconnected(peer.token) }
            .onFailure { failures += 1L }
        disconnects += 1L
        if (cancelConnection) runCatching { server?.cancelConnection(device) }
        if (restartForStaleNotificationCallback) {
            failures += 1L
            releaseServer(permanent = false)
            if (!closedByLifecycle()) start()
        }
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    private fun expireSessionsNow() {
        if (state != AndroidGattServerState.ACTIVE) return
        val expired = runCatching { handler.expire(safeNow()) }.getOrElse {
            failures += 1L
            devicesByToken.keys.toSet()
        }
        expired.forEach { token ->
            val device = devicesByToken[token] ?: return@forEach
            val peer = peers[device] ?: return@forEach
            disconnectPeer(device, peer)
        }
    }

    private fun createProfileService(): BluetoothGattService? = runCatching {
        val profile = BluetoothGattService(
            AndroidGattProfileV1.serviceUuid,
            BluetoothGattService.SERVICE_TYPE_PRIMARY
        )
        characteristics.clear()
        AndroidGattProfileV1.characteristics.forEach { (uuid, capabilities) ->
            val characteristic = BluetoothGattCharacteristic(
                uuid,
                androidProperties(capabilities),
                androidPermissions(capabilities)
            )
            if (
                AndroidGattCharacteristicCapability.NOTIFY in capabilities ||
                AndroidGattCharacteristicCapability.INDICATE in capabilities
            ) {
                check(
                    characteristic.addDescriptor(
                        BluetoothGattDescriptor(
                            AndroidGattProfileV1.clientConfigurationDescriptorUuid,
                            BluetoothGattDescriptor.PERMISSION_READ or
                                BluetoothGattDescriptor.PERMISSION_WRITE
                        )
                    )
                )
            }
            check(profile.addCharacteristic(characteristic))
            characteristics[uuid] = characteristic
        }
        check(isCompleteProfile(profile))
        profile
    }.getOrNull()

    private fun isCompleteProfile(profile: BluetoothGattService): Boolean {
        if (profile.uuid != AndroidGattProfileV1.serviceUuid) return false
        val observed = profile.characteristics.associate { characteristic ->
            characteristic.uuid to androidCapabilities(characteristic.properties)
        }
        if (!AndroidGattProfileV1.isComplete(profile.uuid, observed)) return false
        return profile.characteristics.all { characteristic ->
            val capabilities = AndroidGattProfileV1.characteristics[characteristic.uuid]
                ?: return@all false
            val requiresCccd =
                AndroidGattCharacteristicCapability.NOTIFY in capabilities ||
                    AndroidGattCharacteristicCapability.INDICATE in capabilities
            val cccd = characteristic.getDescriptor(
                AndroidGattProfileV1.clientConfigurationDescriptorUuid
            )
            requiresCccd == (cccd != null)
        }
    }

    private fun localContext(): AndroidGattServerLocalContextV1? {
        val identity = runCatching {
            if (androidPeerAuthEnabled) {
                identityManager.inspectExistingIdentity()
            } else {
                identityManager.provision()
            }
        }.getOrNull()
            ?.takeIf { it.status == DeviceIdentityStatus.READY }
            ?: return null
        val nodeId = identity.nodeId ?: return null
        val advertisement = localAdvertisementProvider() ?: return null
        return AndroidGattServerLocalContextV1(nodeId, advertisement)
    }

    @SuppressLint("MissingPermission")
    private fun failAndRelease(activeServer: BluetoothGattServer) {
        failures += 1L
        releaseServer(activeServer, permanent = false)
        state = AndroidGattServerState.FAILED
    }

    @SuppressLint("MissingPermission")
    private fun releaseServer(permanent: Boolean) {
        releaseServer(server, permanent)
    }

    @SuppressLint("MissingPermission")
    private fun releaseServer(activeServer: BluetoothGattServer?, permanent: Boolean) {
        if (releasingServer) return
        releasingServer = true
        try {
            expiryHandler.removeCallbacks(expireSessions)
            publishActive(false)
            peers.entries.toList().forEach { (device, peer) ->
                disconnectPeer(device, peer)
            }
            clearReliableDataPlaneState()
            runCatching { handler.reset() }
                .onFailure { failures += 1L }
            pendingNotifications.values.forEach { it.fill(0) }
            pendingNotifications.clear()
            devicesByToken.clear()
            characteristics.clear()
            service = null
            servicePublished = false
            server = null
            callbackOwnership.clear()
            if (activeServer != null) {
                runCatching { activeServer.clearServices() }
                runCatching { activeServer.close() }
            }
            if (!permanent) state = AndroidGattServerState.IDLE
        } finally {
            releasingServer = false
        }
    }

    private fun closedByLifecycle(): Boolean =
        state == AndroidGattServerState.CLOSED || !enabled

    private fun publishActive(active: Boolean) {
        if (activeReported == active) return
        activeReported = active
        runCatching { onActiveChanged(active) }
    }

    private fun missingPeerResult(): AndroidGattServerHandlerResultV1 {
        return AndroidGattServerHandlerResultV1.reject(
            AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION
        )
    }

    private fun invokeHandler(
        operation: () -> AndroidGattServerHandlerResultV1
    ): AndroidGattServerHandlerResultV1 = try {
        operation()
    } catch (_: RuntimeException) {
        failures += 1L
        AndroidGattServerHandlerResultV1.reject(
            AndroidGattServerAccessStatusV1.FAILURE
        )
    }

    private fun recordAccess(result: AndroidGattServerHandlerResultV1) {
        if (result.status != AndroidGattServerAccessStatusV1.SUCCESS) {
            deniedRequests += 1L
        }
    }

    private fun allocatePeerToken(): Long? {
        if (nextPeerToken <= 0L || nextPeerToken == Long.MAX_VALUE) return null
        return nextPeerToken.also { nextPeerToken += 1L }
    }

    private fun safeNow(): Long = nowElapsedMs().also { require(it >= 0L) }

    private fun hasConnectPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            ContextCompat.checkSelfPermission(
                appContext,
                Manifest.permission.BLUETOOTH_CONNECT
            ) == PackageManager.PERMISSION_GRANTED

    private fun androidStatus(status: AndroidGattServerAccessStatusV1): Int =
        when (status) {
            AndroidGattServerAccessStatusV1.SUCCESS -> BluetoothGatt.GATT_SUCCESS
            AndroidGattServerAccessStatusV1.READ_NOT_PERMITTED ->
                BluetoothGatt.GATT_READ_NOT_PERMITTED
            AndroidGattServerAccessStatusV1.WRITE_NOT_PERMITTED ->
                BluetoothGatt.GATT_WRITE_NOT_PERMITTED
            AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION ->
                BluetoothGatt.GATT_INSUFFICIENT_AUTHENTICATION
            AndroidGattServerAccessStatusV1.REQUEST_NOT_SUPPORTED ->
                BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED
            AndroidGattServerAccessStatusV1.INVALID_OFFSET ->
                BluetoothGatt.GATT_INVALID_OFFSET
            AndroidGattServerAccessStatusV1.INVALID_ATTRIBUTE_LENGTH ->
                BluetoothGatt.GATT_INVALID_ATTRIBUTE_LENGTH
            AndroidGattServerAccessStatusV1.BUSY,
            AndroidGattServerAccessStatusV1.FAILURE -> BluetoothGatt.GATT_FAILURE
        }

    private fun androidProperties(
        capabilities: Set<AndroidGattCharacteristicCapability>
    ): Int = capabilities.fold(0) { value, capability ->
        value or when (capability) {
            AndroidGattCharacteristicCapability.READ ->
                BluetoothGattCharacteristic.PROPERTY_READ
            AndroidGattCharacteristicCapability.WRITE ->
                BluetoothGattCharacteristic.PROPERTY_WRITE
            AndroidGattCharacteristicCapability.WRITE_WITHOUT_RESPONSE ->
                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE
            AndroidGattCharacteristicCapability.NOTIFY ->
                BluetoothGattCharacteristic.PROPERTY_NOTIFY
            AndroidGattCharacteristicCapability.INDICATE ->
                BluetoothGattCharacteristic.PROPERTY_INDICATE
        }
    }

    private fun androidPermissions(
        capabilities: Set<AndroidGattCharacteristicCapability>
    ): Int {
        var permissions = 0
        if (AndroidGattCharacteristicCapability.READ in capabilities) {
            permissions = permissions or BluetoothGattCharacteristic.PERMISSION_READ
        }
        if (
            AndroidGattCharacteristicCapability.WRITE in capabilities ||
            AndroidGattCharacteristicCapability.WRITE_WITHOUT_RESPONSE in capabilities
        ) {
            permissions = permissions or BluetoothGattCharacteristic.PERMISSION_WRITE
        }
        return permissions
    }

    private fun androidCapabilities(properties: Int): Set<AndroidGattCharacteristicCapability> =
        buildSet {
            if (properties and BluetoothGattCharacteristic.PROPERTY_READ != 0) {
                add(AndroidGattCharacteristicCapability.READ)
            }
            if (properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) {
                add(AndroidGattCharacteristicCapability.WRITE)
            }
            if (properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) {
                add(AndroidGattCharacteristicCapability.WRITE_WITHOUT_RESPONSE)
            }
            if (properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) {
                add(AndroidGattCharacteristicCapability.NOTIFY)
            }
            if (properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) {
                add(AndroidGattCharacteristicCapability.INDICATE)
            }
        }

    companion object {
        private const val SESSION_EXPIRY_POLL_MS = 1_000L
        private const val MAXIMUM_ATT_VALUE_BYTES =
            AndroidGattProfileV1.MAXIMUM_MTU - BluetoothHelloCodecV1.ATT_HEADER_BYTES
    }
}

internal object AndroidGattServerNotificationRestartPolicyV1 {
    fun requiresRestart(
        disconnectedPeerToken: Long,
        notificationCallbackPending: Boolean
    ): Boolean =
        disconnectedPeerToken > 0L &&
            notificationCallbackPending
}
