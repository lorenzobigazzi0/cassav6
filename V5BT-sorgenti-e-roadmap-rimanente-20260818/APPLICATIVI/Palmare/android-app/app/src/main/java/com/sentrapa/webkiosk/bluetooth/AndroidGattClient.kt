package com.sentrapa.webkiosk.bluetooth

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.core.content.ContextCompat

enum class AndroidGattConnectResult {
    STARTED,
    FEATURE_DISABLED,
    INELIGIBLE_CANDIDATE,
    PERMISSION_REQUIRED,
    BUSY,
    HELLO_NOT_READY,
    AUTH_NOT_READY,
    FAILED
}

enum class AndroidGattClientFailure {
    NONE,
    CONNECT_START_FAILED,
    GATT_STATUS,
    DISCONNECTED,
    SERVICE_DISCOVERY_START_FAILED,
    PROFILE_MISMATCH,
    MTU_REQUEST_FAILED,
    MTU_NEGOTIATION_FAILED,
    HELLO_IDENTITY_NOT_READY,
    HELLO_BINDING_INVALID,
    HELLO_MTU_TOO_SMALL,
    HELLO_WRITE_START_FAILED,
    HELLO_WRITE_FAILED,
    HELLO_WRITE_TIMEOUT,
    HELLO_READ_START_FAILED,
    HELLO_READ_FAILED,
    HELLO_READ_TIMEOUT,
    HELLO_RESPONSE_INVALID,
    AUTH_IDENTITY_NOT_READY,
    AUTH_BINDING_INVALID,
    AUTH_MTU_TOO_SMALL,
    AUTH_SUBSCRIBE_START_FAILED,
    AUTH_SUBSCRIBE_FAILED,
    AUTH_SUBSCRIBE_TIMEOUT,
    AUTH_CLIENT_PROOF_INVALID,
    AUTH_CLIENT_PROOF_WRITE_START_FAILED,
    AUTH_CLIENT_PROOF_WRITE_FAILED,
    AUTH_CLIENT_PROOF_WRITE_TIMEOUT,
    AUTH_SERVER_PROOF_INVALID,
    AUTH_SERVER_PROOF_TIMEOUT,
    AUTH_FINISH_WRITE_START_FAILED,
    AUTH_FINISH_WRITE_FAILED,
    AUTH_FINISH_WRITE_TIMEOUT,
    AUTH_COMPLETION_FAILED,
    KEY_CONTEXT_NOT_READY,
    KEY_CLIENT_SHARE_INVALID,
    KEY_CLIENT_SHARE_WRITE_START_FAILED,
    KEY_CLIENT_SHARE_WRITE_FAILED,
    KEY_CLIENT_SHARE_WRITE_TIMEOUT,
    KEY_SERVER_SHARE_INVALID,
    KEY_SERVER_SHARE_TIMEOUT,
    KEY_CLIENT_CONFIRM_WRITE_START_FAILED,
    KEY_CLIENT_CONFIRM_WRITE_FAILED,
    KEY_CLIENT_CONFIRM_WRITE_TIMEOUT,
    KEY_COMPLETION_FAILED,
    HEARTBEAT_INVALID,
    HEARTBEAT_TIMEOUT,
    HEARTBEAT_PONG_WRITE_START_FAILED,
    HEARTBEAT_PONG_WRITE_FAILED,
    HEARTBEAT_PONG_WRITE_TIMEOUT,
    CLOSE_INVALID,
    CLOSE_ACK_WRITE_START_FAILED,
    CLOSE_ACK_WRITE_FAILED,
    CLOSE_ACK_WRITE_TIMEOUT,
    CLOSE_TIMEOUT,
    RELIABLE_SUBSCRIBE_START_FAILED,
    RELIABLE_SUBSCRIBE_FAILED,
    RELIABLE_SUBSCRIBE_TIMEOUT,
    RELIABLE_OPERATION_FAILED
}

data class AndroidGattClientSnapshot(
    val state: AndroidGattClientState,
    val profileValidated: Boolean,
    val negotiatedMtu: Int?,
    val lastFailure: AndroidGattClientFailure,
    val metrics: AndroidGattClientMetricsSnapshot,
    val helloEnabled: Boolean = false,
    val helloExchanged: Boolean = false,
    val helloDeadlineActive: Boolean = false,
    val mutualAuthEnabled: Boolean = false,
    val mutuallyAuthenticated: Boolean = false,
    val authDeadlineActive: Boolean = false,
    val authenticatedSessionCount: Long = 0L,
    val sessionKeyEnabled: Boolean = false,
    val keyEstablished: Boolean = false,
    val heartbeatEnabled: Boolean = false,
    val active: Boolean = false,
    val directControlDeadlineActive: Boolean = false,
    val reliablePortReady: Boolean = false
) {
    val resourceActive: Boolean
        get() = state !in setOf(
            AndroidGattClientState.IDLE,
            AndroidGattClientState.FAILED,
            AndroidGattClientState.CLOSED
        )
}

private enum class AndroidGattReliableSubscriptionPhaseV1 {
    IDLE,
    DATA_WRITING,
    ACK_WRITING,
    READY
}

class AndroidGattClient(
    context: Context,
    private val enabled: Boolean,
    private val helloEnabled: Boolean = false,
    private val mutualAuthEnabled: Boolean = false,
    private val sessionKeyEnabled: Boolean = false,
    private val heartbeatEnabled: Boolean = false,
    private val androidPeerAuthEnabled: Boolean = false,
    private val androidPeerAuthReady: () -> Boolean = { androidPeerAuthEnabled },
    private val peerAuthSessionFactory: AndroidGattPeerAuthClientSessionFactoryV2? = null,
    private val preferredMtu: Int = AndroidGattProfileV1.PREFERRED_MTU
) : AutoCloseable, GattReliableSessionContextProviderV1 {
    private val appContext = context.applicationContext
    private val identityManager =
        DeviceIdentityManager(appContext, enabled = helloEnabled)
    private val helloTimeoutHandler = Handler(Looper.getMainLooper())
    private val authTimeoutHandler = Handler(Looper.getMainLooper())
    private val directControlTimeoutHandler = Handler(Looper.getMainLooper())
    private val stateMachine = AndroidGattClientStateMachine()
    private val metrics = AndroidGattClientMetrics()
    private val callbackOwnership = BluetoothCallbackOwnership<BluetoothGattCallback>()
    private var activeGatt: BluetoothGatt? = null
    private var profileValidated = false
    private var negotiatedMtu: Int? = null
    private var lastFailure = AndroidGattClientFailure.NONE
    private var helloBinding: AndroidHelloExchangeBinding? = null
    private var helloCharacteristic: BluetoothGattCharacteristic? = null
    private var mutualAuthCertificateId: String? = null
    private var reliablePeerTrustId: String? = null
    private var mutualAuthExchange: AndroidMutualAuthExchangeV1? = null
    private var peerAuthSession: AndroidGattPeerAuthClientSessionV2? = null
    private var androidPeerCandidate = false
    private var peerAliasEpoch: Long? = null
    private var peerClientAdvertisement: BluetoothAdvertisementV1? = null
    private var peerServerAdvertisement: BluetoothAdvertisementV1? = null
    private var directControlExchange: AndroidDirectControlClientV1? = null
    private var controlRxCharacteristic: BluetoothGattCharacteristic? = null
    private var controlTxCharacteristic: BluetoothGattCharacteristic? = null
    private var authDescriptor: BluetoothGattDescriptor? = null
    private var pendingServerProof: ByteArray? = null
    private var pendingDirectControlIndication: ByteArray? = null
    private var reliableDataPlane: GattReliableDataPlaneV1? = null
    private var reliablePortListener: AndroidGattReliablePortListenerV1? = null
    private var reliableBridge: AndroidGattReliableDataPlaneBridgeV1? = null
    private var reliableQueue: AndroidGattReliableOperationQueueV1? = null
    private var reliableInFlight: AndroidGattReliableQueuedOperationV1? = null
    private var dataRxCharacteristic: BluetoothGattCharacteristic? = null
    private var dataTxCharacteristic: BluetoothGattCharacteristic? = null
    private var ackTxCharacteristic: BluetoothGattCharacteristic? = null
    private var dataDescriptor: BluetoothGattDescriptor? = null
    private var ackDescriptor: BluetoothGattDescriptor? = null
    private var reliableSetupDeadline: AndroidGattReliableSetupDeadlineV1? = null
    private var reliableSetupToken: AndroidGattReliableSetupTokenV1? = null
    private var reliableSubscriptionPhase = AndroidGattReliableSubscriptionPhaseV1.IDLE
    private var reliablePortReady = false
    private var helloDeadlineActive = false
    private var helloTimeoutGeneration = 0L
    private var authDeadlineActive = false
    private var authTimeoutGeneration = 0L
    private var directControlDeadlineActive = false
    private var directControlTimeoutGeneration = 0L

    init {
        require(AndroidGattProfileV1.isValidMtu(preferredMtu))
        require(!helloEnabled || enabled) {
            "HELLO requires the Android GATT client"
        }
        require(!mutualAuthEnabled || helloEnabled) {
            "mutual auth requires HELLO"
        }
        require(!sessionKeyEnabled || mutualAuthEnabled) {
            "session key requires mutual auth"
        }
        require(!heartbeatEnabled || sessionKeyEnabled) {
            "heartbeat requires a session key"
        }
        require(sessionKeyEnabled == heartbeatEnabled) {
            "session key and heartbeat must be enabled together"
        }
        require(!androidPeerAuthEnabled || helloEnabled) {
            "Android peer auth requires HELLO"
        }
        require(!androidPeerAuthEnabled || peerAuthSessionFactory != null) {
            "Android peer auth requires a provisioned session factory"
        }
    }

    @get:Synchronized
    val isActive: Boolean
        get() = snapshot().resourceActive

    @Synchronized
    fun configureReliableDataPlane(
        dataPlane: GattReliableDataPlaneV1,
        listener: AndroidGattReliablePortListenerV1
    ) {
        check(androidPeerAuthEnabled) {
            "reliable Android data plane requires A2 authentication"
        }
        check(
            reliableDataPlane == null &&
                callbackOwnership.current() == null &&
                activeGatt == null &&
                stateMachine.state == AndroidGattClientState.IDLE
        ) { "reliable Android data plane must be configured before connection" }
        reliableDataPlane = dataPlane
        reliablePortListener = listener
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    fun considerCandidate(
        device: BluetoothDevice,
        advertisement: BluetoothAdvertisementV1,
        localAdvertisement: BluetoothAdvertisementV1? = null
    ): AndroidGattConnectResult {
        if (!enabled) return AndroidGattConnectResult.FEATURE_DISABLED
        val remote = runCatching {
            BluetoothAdvertisementCodecV1.validate(advertisement)
        }.getOrNull() ?: return AndroidGattConnectResult.INELIGIBLE_CANDIDATE
        val local = localAdvertisement
        val isAndroidPeer =
            remote.nodeKind != BluetoothAdvertisementNodeKind.RASPBERRY
        val peerAuthReady = isAndroidPeerAuthReady()
        val aliasEpoch = RotatingAliasV1.epoch(
            System.currentTimeMillis() / 1_000L,
            BluetoothDiscoveryPolicy.ALIAS_EPOCH_SECONDS
        )
        val eligible =
            if (isAndroidPeer) {
                local != null && BluetoothGattCandidatePolicy.shouldConnect(
                    BluetoothPeerObservationResult.ADDED,
                    remote,
                    local,
                    peerAuthReady,
                    aliasEpoch
                )
            } else {
                BluetoothGattCandidatePolicy.isEligible(remote)
            }
        if (!eligible) {
            return AndroidGattConnectResult.INELIGIBLE_CANDIDATE
        }
        if (!hasConnectPermission()) return AndroidGattConnectResult.PERMISSION_REQUIRED
        if (callbackOwnership.current() != null || activeGatt != null) {
            return AndroidGattConnectResult.BUSY
        }
        if (
            stateMachine.state == AndroidGattClientState.FAILED ||
            stateMachine.state == AndroidGattClientState.CLOSED
        ) {
            applyEvent(AndroidGattClientEvent.RESET)
        }
        if (stateMachine.state != AndroidGattClientState.IDLE) {
            return AndroidGattConnectResult.BUSY
        }

        clearHelloState()
        clearMutualAuthState()
        clearDirectControlState()
        clearReliableDataPlaneState()
        androidPeerCandidate = isAndroidPeer
        peerAliasEpoch = aliasEpoch.takeIf { isAndroidPeer }
        peerClientAdvertisement = local?.takeIf { isAndroidPeer }
        peerServerAdvertisement = remote.takeIf { isAndroidPeer }
        if (helloEnabled) {
            val identity = runCatching {
                if (isAndroidPeer) {
                    identityManager.inspectExistingIdentity()
                } else {
                    identityManager.provision()
                }
            }.getOrNull()
            val readyIdentity = identity?.takeIf {
                it.status == DeviceIdentityStatus.READY
            }
            val localNodeId =
                readyIdentity?.nodeId
            if (localNodeId == null) {
                lastFailure = AndroidGattClientFailure.HELLO_IDENTITY_NOT_READY
                return AndroidGattConnectResult.HELLO_NOT_READY
            }
            val identityAuthenticationRequired =
                (mutualAuthEnabled && !isAndroidPeer) || isAndroidPeer
            val certificateId =
                if (identityAuthenticationRequired) readyIdentity.certificateId else null
            val signingAlgorithm =
                if (identityAuthenticationRequired) readyIdentity.signingAlgorithm else null
            val signingPublicKeyBase64 =
                if (identityAuthenticationRequired) {
                    readyIdentity.signingPublicKeyBase64
                } else {
                    null
                }
            if (
                identityAuthenticationRequired &&
                (
                    certificateId == null ||
                        signingAlgorithm == null ||
                        signingPublicKeyBase64 == null
                )
            ) {
                lastFailure = AndroidGattClientFailure.AUTH_IDENTITY_NOT_READY
                return AndroidGattConnectResult.AUTH_NOT_READY
            }
            reliablePeerTrustId =
                if (mutualAuthEnabled && !isAndroidPeer) {
                    val publicKey = runCatching {
                        Base64.decode(checkNotNull(signingPublicKeyBase64), Base64.DEFAULT)
                    }.getOrNull()
                    if (publicKey == null) {
                        lastFailure = AndroidGattClientFailure.AUTH_IDENTITY_NOT_READY
                        return AndroidGattConnectResult.AUTH_NOT_READY
                    }
                    try {
                        runCatching {
                            deriveBluetoothPeerTrustIdV1(
                                nodeId = localNodeId,
                                certificateId = checkNotNull(certificateId),
                                publicKeyAlgorithm = checkNotNull(signingAlgorithm),
                                publicKeySpkiDer = publicKey
                            )
                        }.getOrElse {
                            lastFailure = AndroidGattClientFailure.AUTH_IDENTITY_NOT_READY
                            return AndroidGattConnectResult.AUTH_NOT_READY
                        }
                    } finally {
                        publicKey.fill(0)
                    }
                } else {
                    null
                }
            if (local == null) {
                lastFailure = AndroidGattClientFailure.HELLO_BINDING_INVALID
                return AndroidGattConnectResult.HELLO_NOT_READY
            }
            helloBinding =
                runCatching {
                    if (isAndroidPeer) {
                        AndroidHelloExchangeBinding.createAndroidPeer(
                            localNodeId,
                            local,
                            remote
                        )
                    } else {
                        AndroidHelloExchangeBinding.create(
                            localNodeId,
                            local,
                            remote
                        )
                    }
                }.getOrNull()
            if (helloBinding == null) {
                lastFailure = AndroidGattClientFailure.HELLO_BINDING_INVALID
                return AndroidGattConnectResult.HELLO_NOT_READY
            }
            mutualAuthCertificateId = certificateId.takeIf { !isAndroidPeer }
        }
        profileValidated = false
        negotiatedMtu = null
        lastFailure = AndroidGattClientFailure.NONE
        applyEvent(AndroidGattClientEvent.CONNECT_REQUESTED)
        val callback = createCallback()
        callbackOwnership.install(callback)
        val gatt =
            try {
                device.connectGatt(
                    appContext,
                    false,
                    callback,
                    BluetoothDevice.TRANSPORT_LE
                )
            } catch (_: SecurityException) {
                null
            } catch (_: RuntimeException) {
                null
            }
        if (gatt == null) {
            callbackOwnership.release(callback)
            clearHelloState()
            clearMutualAuthState()
            clearDirectControlState()
            clearReliableDataPlaneState()
            lastFailure = AndroidGattClientFailure.CONNECT_START_FAILED
            applyEvent(AndroidGattClientEvent.FAILURE)
            return AndroidGattConnectResult.FAILED
        }
        if (!callbackOwnership.isOwner(callback)) {
            clearHelloState()
            clearMutualAuthState()
            clearDirectControlState()
            clearReliableDataPlaneState()
            closeGatt(gatt, disconnect = false)
            return AndroidGattConnectResult.FAILED
        }
        val callbackGatt = activeGatt
        if (callbackGatt != null && callbackGatt !== gatt) {
            callbackOwnership.release(callback)
            clearHelloState()
            clearMutualAuthState()
            clearDirectControlState()
            clearReliableDataPlaneState()
            closeGatt(gatt, disconnect = false)
            lastFailure = AndroidGattClientFailure.CONNECT_START_FAILED
            applyEvent(AndroidGattClientEvent.FAILURE)
            return AndroidGattConnectResult.FAILED
        }
        activeGatt = gatt
        return AndroidGattConnectResult.STARTED
    }

    private fun isAndroidPeerAuthReady(): Boolean =
        androidPeerAuthEnabled &&
            runCatching(androidPeerAuthReady).getOrDefault(false)

    @Synchronized
    fun snapshot(): AndroidGattClientSnapshot {
        val state = stateMachine.state
        val metricsSnapshot = metrics.snapshot()
        return AndroidGattClientSnapshot(
            state = state,
            profileValidated = profileValidated,
            negotiatedMtu = negotiatedMtu,
            lastFailure = lastFailure,
            metrics = metricsSnapshot,
            helloEnabled = helloEnabled,
            helloExchanged =
                state in setOf(
                    AndroidGattClientState.HELLO_EXCHANGED,
                    AndroidGattClientState.AUTH_SUBSCRIBING,
                    AndroidGattClientState.AUTH_WRITING_CLIENT_PROOF,
                    AndroidGattClientState.AUTH_WAITING_SERVER_PROOF,
                    AndroidGattClientState.AUTH_WRITING_FINISH,
                    AndroidGattClientState.AUTHENTICATED,
                    AndroidGattClientState.KEY_WRITING_CLIENT_SHARE,
                    AndroidGattClientState.KEY_WAITING_SERVER_SHARE,
                    AndroidGattClientState.KEY_WRITING_CLIENT_CONFIRM,
                    AndroidGattClientState.KEY_ESTABLISHED,
                    AndroidGattClientState.ACTIVATION_PROBING,
                    AndroidGattClientState.ACTIVE,
                    AndroidGattClientState.HEARTBEAT_WRITING_PONG,
                    AndroidGattClientState.CLOSING
                ),
            helloDeadlineActive = helloDeadlineActive,
            mutualAuthEnabled = mutualAuthEnabled || androidPeerAuthEnabled,
            mutuallyAuthenticated =
                state in setOf(
                    AndroidGattClientState.AUTHENTICATED,
                    AndroidGattClientState.KEY_WRITING_CLIENT_SHARE,
                    AndroidGattClientState.KEY_WAITING_SERVER_SHARE,
                    AndroidGattClientState.KEY_WRITING_CLIENT_CONFIRM,
                    AndroidGattClientState.KEY_ESTABLISHED,
                    AndroidGattClientState.ACTIVATION_PROBING,
                    AndroidGattClientState.ACTIVE,
                    AndroidGattClientState.HEARTBEAT_WRITING_PONG,
                    AndroidGattClientState.CLOSING
                ),
            authDeadlineActive = authDeadlineActive,
            authenticatedSessionCount =
                if (
                    state in setOf(
                        AndroidGattClientState.AUTHENTICATED,
                        AndroidGattClientState.KEY_WRITING_CLIENT_SHARE,
                        AndroidGattClientState.KEY_WAITING_SERVER_SHARE,
                        AndroidGattClientState.KEY_WRITING_CLIENT_CONFIRM,
                        AndroidGattClientState.KEY_ESTABLISHED,
                        AndroidGattClientState.ACTIVATION_PROBING,
                        AndroidGattClientState.ACTIVE,
                        AndroidGattClientState.HEARTBEAT_WRITING_PONG,
                        AndroidGattClientState.CLOSING
                    )
                ) 1L else 0L,
            sessionKeyEnabled = sessionKeyEnabled || androidPeerAuthEnabled,
            keyEstablished =
                state in setOf(
                    AndroidGattClientState.KEY_ESTABLISHED,
                    AndroidGattClientState.ACTIVATION_PROBING,
                    AndroidGattClientState.ACTIVE,
                    AndroidGattClientState.HEARTBEAT_WRITING_PONG,
                    AndroidGattClientState.CLOSING
                ),
            heartbeatEnabled = heartbeatEnabled,
            active =
                state in setOf(
                    AndroidGattClientState.ACTIVE,
                    AndroidGattClientState.HEARTBEAT_WRITING_PONG
                ),
            directControlDeadlineActive = directControlDeadlineActive,
            reliablePortReady = reliablePortReady
        )
    }

    @Synchronized
    override fun export(sessionToken: Long): GattReliableChannelContextV1 {
        if (
            sessionToken != RELIABLE_SESSION_TOKEN_V1 ||
            !enabled ||
            stateMachine.state != AndroidGattClientState.ACTIVE ||
            !profileValidated ||
            activeGatt == null
        ) {
            gattReliableDataPlaneFailureV1(
                "RELIABLE_CHANNEL_NOT_AUTHORIZED",
                "Android GATT client has no active authenticated data session"
            )
        }
        peerAuthSession?.let { peerSession ->
            return try {
                peerSession.export(sessionToken)
            } catch (error: Throwable) {
                gattReliableDataPlaneFailureV1(
                    "RELIABLE_CHANNEL_NOT_AUTHORIZED",
                    "Android peer A2 context is unavailable",
                    error
                )
            }
        }
        if (!sessionKeyEnabled || !heartbeatEnabled) {
            gattReliableDataPlaneFailureV1(
                "RELIABLE_CHANNEL_NOT_AUTHORIZED",
                "Android GATT client session keys are disabled"
            )
        }
        val mtu = negotiatedMtu
            ?: gattReliableDataPlaneFailureV1(
                "RELIABLE_CHANNEL_NOT_AUTHORIZED",
                "Android GATT client has no negotiated data MTU"
            )
        val material = try {
            checkNotNull(directControlExchange).exportReliableChannelMaterialV1()
        } catch (error: Throwable) {
            gattReliableDataPlaneFailureV1(
                "RELIABLE_CHANNEL_NOT_AUTHORIZED",
                "Android GATT client session material is unavailable",
                error
            )
        }
        val peerTrustId = reliablePeerTrustId
            ?: run {
                material.close()
                gattReliableDataPlaneFailureV1(
                    "RELIABLE_CHANNEL_NOT_AUTHORIZED",
                    "Android GATT client trust context is unavailable"
                )
            }
        return GattReliableChannelContextV1(
            peerTrustId = peerTrustId,
            mtu = mtu,
            role = GattReliableEndpointRoleV1.CLIENT,
            material = material
        )
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    fun revalidatePeerTrustLease(): Boolean {
        if (peerAuthSession == null || !reliablePortReady) return true
        val valid = runCatching {
            peerAuthSession?.export(RELIABLE_SESSION_TOKEN_V1)?.use { }
        }.isSuccess
        if (!valid) close()
        return valid
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    fun abortReliableSession(): Boolean {
        val active =
            callbackOwnership.current() != null ||
                activeGatt != null ||
                reliableQueue != null ||
                reliableBridge != null
        if (!active) return false
        close()
        return true
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    override fun close() {
        cancelHelloTimeout()
        cancelAuthTimeout()
        cancelDirectControlTimeout()
        clearHelloState()
        clearMutualAuthState()
        clearDirectControlState()
        clearReliableDataPlaneState()
        val callback = callbackOwnership.clear()
        val gatt = activeGatt
        activeGatt = null
        val closeTransition = applyEvent(AndroidGattClientEvent.CLOSE_REQUESTED)
        if (closeTransition.to == AndroidGattClientState.CLOSING) {
            applyEvent(AndroidGattClientEvent.DISCONNECTED)
        }
        if (callback != null || gatt != null) {
            closeGatt(gatt, disconnect = true)
        }
    }

    private fun createCallback(): BluetoothGattCallback =
        object : BluetoothGattCallback() {
            @SuppressLint("MissingPermission")
            override fun onConnectionStateChange(
                gatt: BluetoothGatt,
                status: Int,
                newState: Int
            ) {
                synchronized(this@AndroidGattClient) {
                    if (!claimGatt(this, gatt)) return
                    if (status != BluetoothGatt.GATT_SUCCESS) {
                        failAndClose(
                            this,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.GATT_STATUS
                        )
                        return
                    }
                    when (newState) {
                        BluetoothProfile.STATE_CONNECTED -> {
                            val transition =
                                applyEvent(AndroidGattClientEvent.GATT_CONNECTED)
                            if (
                                transition.to !=
                                AndroidGattClientState.DISCOVERING_SERVICES
                            ) {
                                failAndClose(
                                    this,
                                    gatt,
                                    AndroidGattClientEvent.FAILURE,
                                    AndroidGattClientFailure.GATT_STATUS
                                )
                                return
                            }
                            val started =
                                runCatching { gatt.discoverServices() }
                                    .getOrDefault(false)
                            if (!started) {
                                failAndClose(
                                    this,
                                    gatt,
                                    AndroidGattClientEvent.FAILURE,
                                    AndroidGattClientFailure.SERVICE_DISCOVERY_START_FAILED
                                )
                            }
                        }
                        BluetoothProfile.STATE_DISCONNECTED ->
                            failAndClose(
                                this,
                                gatt,
                                AndroidGattClientEvent.DISCONNECTED,
                                AndroidGattClientFailure.DISCONNECTED
                            )
                    }
                }
            }

            @SuppressLint("MissingPermission")
            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                synchronized(this@AndroidGattClient) {
                    if (!claimGatt(this, gatt)) return
                    val service =
                        if (status == BluetoothGatt.GATT_SUCCESS) {
                            gatt.getService(AndroidGattProfileV1.serviceUuid)
                        } else {
                            null
                        }
                    val characteristics =
                        service?.characteristics?.associate {
                            it.uuid to capabilitiesOf(it)
                        }
                    if (
                        service == null ||
                        service.type != BluetoothGattService.SERVICE_TYPE_PRIMARY ||
                        characteristics == null ||
                        !AndroidGattProfileV1.isComplete(
                            service.uuid,
                            characteristics
                        )
                    ) {
                        failAndClose(
                            this,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.PROFILE_MISMATCH
                        )
                        return
                    }
                    profileValidated = true
                    helloCharacteristic =
                        service.getCharacteristic(AndroidGattProfileV1.helloUuid)
                    controlRxCharacteristic =
                        service.getCharacteristic(AndroidGattProfileV1.controlRxUuid)
                    controlTxCharacteristic =
                        service.getCharacteristic(AndroidGattProfileV1.controlTxUuid)
                    authDescriptor =
                        controlTxCharacteristic?.getDescriptor(
                            AndroidGattProfileV1.clientConfigurationDescriptorUuid
                        )
                    dataRxCharacteristic =
                        service.getCharacteristic(AndroidGattProfileV1.dataRxUuid)
                    dataTxCharacteristic =
                        service.getCharacteristic(AndroidGattProfileV1.dataTxUuid)
                    ackTxCharacteristic =
                        service.getCharacteristic(AndroidGattProfileV1.ackTxUuid)
                    dataDescriptor =
                        dataTxCharacteristic?.getDescriptor(
                            AndroidGattProfileV1.clientConfigurationDescriptorUuid
                        )
                    ackDescriptor =
                        ackTxCharacteristic?.getDescriptor(
                            AndroidGattProfileV1.clientConfigurationDescriptorUuid
                        )
                    if (
                        mutualAuthEnabled &&
                        (
                            controlRxCharacteristic == null ||
                                controlTxCharacteristic == null ||
                                authDescriptor == null
                        )
                    ) {
                        failAndClose(
                            this,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.PROFILE_MISMATCH
                        )
                        return
                    }
                    if (
                        reliableDataPlane != null &&
                        (
                            dataRxCharacteristic == null ||
                                dataTxCharacteristic == null ||
                                ackTxCharacteristic == null ||
                                dataDescriptor == null ||
                                ackDescriptor == null
                        )
                    ) {
                        failAndClose(
                            this,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.PROFILE_MISMATCH
                        )
                        return
                    }
                    val transition =
                        applyEvent(AndroidGattClientEvent.SERVICES_VALIDATED)
                    if (
                        transition.to != AndroidGattClientState.NEGOTIATING_MTU
                    ) {
                        failAndClose(
                            this,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.PROFILE_MISMATCH
                        )
                        return
                    }
                    if (!runCatching { gatt.requestMtu(preferredMtu) }.getOrDefault(false)) {
                        failAndClose(
                            this,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.MTU_REQUEST_FAILED
                        )
                    }
                }
            }

            override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
                synchronized(this@AndroidGattClient) {
                    if (!claimGatt(this, gatt)) return
                    if (
                        status != BluetoothGatt.GATT_SUCCESS ||
                        !AndroidGattProfileV1.isValidMtu(mtu)
                    ) {
                        failAndClose(
                            this,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.MTU_NEGOTIATION_FAILED
                        )
                        return
                    }
                    negotiatedMtu = mtu
                    val transition =
                        applyEvent(AndroidGattClientEvent.MTU_NEGOTIATED, mtu)
                    if (transition.to != AndroidGattClientState.READY) {
                        failAndClose(
                            this,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.MTU_NEGOTIATION_FAILED
                        )
                        return
                    }
                    if (!helloEnabled) return
                    if (
                        (
                            (androidPeerCandidate &&
                                mtu < AndroidPeerAuthCodecV2.MINIMUM_MTU) ||
                                (!androidPeerCandidate &&
                                    mutualAuthEnabled &&
                                    mtu < BluetoothMutualAuthCodecV1.MINIMUM_MTU)
                        )
                    ) {
                        failAndClose(
                            this,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.AUTH_MTU_TOO_SMALL
                        )
                        return
                    }
                    if (mtu < BluetoothHelloCodecV1.MINIMUM_MTU) {
                        failAndClose(
                            this,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.HELLO_MTU_TOO_SMALL
                        )
                        return
                    }
                    startHelloWrite(this, gatt)
                }
            }

            @SuppressLint("MissingPermission")
            override fun onCharacteristicWrite(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                status: Int
            ) {
                handleCharacteristicWrite(this, gatt, characteristic, status)
            }

            @Deprecated("Deprecated in Android 13")
            override fun onCharacteristicRead(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                status: Int
            ) {
                handleHelloRead(
                    callback = this,
                    gatt = gatt,
                    characteristic = characteristic,
                    value = characteristic.value ?: ByteArray(0),
                    status = status
                )
            }

            override fun onCharacteristicRead(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                value: ByteArray,
                status: Int
            ) {
                handleHelloRead(
                    callback = this,
                    gatt = gatt,
                    characteristic = characteristic,
                    value = value,
                    status = status
                )
            }

            override fun onDescriptorWrite(
                gatt: BluetoothGatt,
                descriptor: BluetoothGattDescriptor,
                status: Int
            ) {
                if (
                    descriptor === dataDescriptor ||
                    descriptor === ackDescriptor ||
                    descriptor.characteristic?.uuid in setOf(
                        AndroidGattProfileV1.dataTxUuid,
                        AndroidGattProfileV1.ackTxUuid
                    )
                ) {
                    handleReliableDescriptorWrite(this, gatt, descriptor, status)
                } else {
                    handleAuthDescriptorWrite(this, gatt, descriptor, status)
                }
            }

            @Deprecated("Deprecated in Android 13")
            override fun onCharacteristicChanged(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic
            ) {
                val value = characteristic.value ?: ByteArray(0)
                if (
                    characteristic.uuid == AndroidGattProfileV1.dataTxUuid ||
                    characteristic.uuid == AndroidGattProfileV1.ackTxUuid
                ) {
                    handleReliableNotification(this, gatt, characteristic, value)
                } else {
                    handleControlIndication(this, gatt, characteristic, value)
                }
            }

            override fun onCharacteristicChanged(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                value: ByteArray
            ) {
                if (
                    characteristic.uuid == AndroidGattProfileV1.dataTxUuid ||
                    characteristic.uuid == AndroidGattProfileV1.ackTxUuid
                ) {
                    handleReliableNotification(this, gatt, characteristic, value)
                } else {
                    handleControlIndication(this, gatt, characteristic, value)
                }
            }
        }

    @SuppressLint("MissingPermission")
    @Synchronized
    private fun handleCharacteristicWrite(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        status: Int
    ) {
        if (!claimGatt(callback, gatt)) return
        when (characteristic.uuid) {
            AndroidGattProfileV1.helloUuid ->
                handleHelloWrite(callback, gatt, characteristic, status)
            AndroidGattProfileV1.controlRxUuid ->
                handleAuthWrite(callback, gatt, characteristic, status)
            AndroidGattProfileV1.dataRxUuid ->
                handleReliableCharacteristicWrite(
                    callback,
                    gatt,
                    characteristic,
                    status
                )
            else ->
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    if (mutualAuthEnabled || androidPeerCandidate) {
                        AndroidGattClientFailure.AUTH_CLIENT_PROOF_WRITE_FAILED
                    } else {
                        AndroidGattClientFailure.HELLO_WRITE_FAILED
                    }
                )
        }
    }

    @SuppressLint("MissingPermission")
    private fun handleHelloWrite(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        status: Int
    ) {
        if (
            status == BluetoothGatt.GATT_SUCCESS &&
            stateMachine.state in setOf(
                AndroidGattClientState.READING_HELLO,
                AndroidGattClientState.HELLO_EXCHANGED,
                AndroidGattClientState.AUTH_SUBSCRIBING,
                AndroidGattClientState.AUTH_WRITING_CLIENT_PROOF,
                AndroidGattClientState.AUTH_WAITING_SERVER_PROOF,
                AndroidGattClientState.AUTH_WRITING_FINISH,
                AndroidGattClientState.AUTHENTICATED,
                AndroidGattClientState.KEY_WRITING_CLIENT_SHARE,
                AndroidGattClientState.KEY_WAITING_SERVER_SHARE,
                AndroidGattClientState.KEY_WRITING_CLIENT_CONFIRM,
                AndroidGattClientState.KEY_ESTABLISHED,
                AndroidGattClientState.ACTIVATION_PROBING,
                AndroidGattClientState.ACTIVE,
                AndroidGattClientState.HEARTBEAT_WRITING_PONG,
                AndroidGattClientState.CLOSING,
                AndroidGattClientState.CLOSED
            )
        ) {
            return
        }
        if (
            stateMachine.state != AndroidGattClientState.WRITING_HELLO ||
            status != BluetoothGatt.GATT_SUCCESS
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.HELLO_WRITE_FAILED
            )
            return
        }
        cancelHelloTimeout()
        clearCharacteristicValue(characteristic)
        val transition = applyEvent(AndroidGattClientEvent.HELLO_WRITTEN)
        if (
            !transition.changed ||
            transition.to != AndroidGattClientState.READING_HELLO
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.HELLO_WRITE_FAILED
            )
            return
        }
        val started =
            runCatching { gatt.readCharacteristic(characteristic) }
                .getOrDefault(false)
        if (!started) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.HELLO_READ_START_FAILED
            )
            return
        }
        armHelloTimeout(
            callback,
            gatt,
            AndroidGattClientFailure.HELLO_READ_TIMEOUT
        )
    }

    private fun handleAuthWrite(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        status: Int
    ) {
        val state = stateMachine.state
        val failure = when (state) {
            AndroidGattClientState.AUTH_WRITING_FINISH ->
                AndroidGattClientFailure.AUTH_FINISH_WRITE_FAILED
            AndroidGattClientState.KEY_WRITING_CLIENT_SHARE ->
                AndroidGattClientFailure.KEY_CLIENT_SHARE_WRITE_FAILED
            AndroidGattClientState.KEY_WRITING_CLIENT_CONFIRM ->
                AndroidGattClientFailure.KEY_CLIENT_CONFIRM_WRITE_FAILED
            AndroidGattClientState.ACTIVATION_PROBING,
            AndroidGattClientState.HEARTBEAT_WRITING_PONG ->
                AndroidGattClientFailure.HEARTBEAT_PONG_WRITE_FAILED
            AndroidGattClientState.CLOSING ->
                AndroidGattClientFailure.CLOSE_ACK_WRITE_FAILED
            else ->
                AndroidGattClientFailure.AUTH_CLIENT_PROOF_WRITE_FAILED
        }
        if (
            (!mutualAuthEnabled && !androidPeerCandidate) ||
            (state.name.startsWith("KEY_") && !sessionKeyEnabled) ||
            (state in setOf(
                AndroidGattClientState.ACTIVATION_PROBING,
                AndroidGattClientState.HEARTBEAT_WRITING_PONG,
                AndroidGattClientState.CLOSING
            ) && !heartbeatEnabled) ||
            status != BluetoothGatt.GATT_SUCCESS
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                failure
            )
            return
        }
        clearCharacteristicValue(characteristic)
        when (state) {
            AndroidGattClientState.AUTH_WRITING_CLIENT_PROOF -> {
                cancelAuthTimeout()
                if (androidPeerCandidate) {
                    if (!isAndroidPeerAuthReady()) {
                        failAndClose(
                            callback,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.AUTH_IDENTITY_NOT_READY
                        )
                        return
                    }
                    val advanced = runCatching {
                        peerAuthSession?.onClientInitWritten()
                    }.isSuccess && peerAuthSession != null
                    if (!advanced) {
                        failAndClose(
                            callback,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.AUTH_CLIENT_PROOF_WRITE_FAILED
                        )
                        return
                    }
                }
                val transition =
                    applyEvent(AndroidGattClientEvent.AUTH_CLIENT_PROOF_WRITTEN)
                if (
                    !transition.changed ||
                    transition.to !=
                    AndroidGattClientState.AUTH_WAITING_SERVER_PROOF
                ) {
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        AndroidGattClientFailure.AUTH_CLIENT_PROOF_WRITE_FAILED
                    )
                    return
                }
                val earlyProof = pendingServerProof
                pendingServerProof = null
                if (earlyProof == null) {
                    armAuthTimeout(
                        callback,
                        gatt,
                        AndroidGattClientFailure.AUTH_SERVER_PROOF_TIMEOUT
                    )
                } else {
                    if (androidPeerCandidate) {
                        processPeerServerReply(callback, gatt, earlyProof)
                    } else {
                        processServerProof(callback, gatt, earlyProof)
                    }
                    earlyProof.fill(0)
                }
            }
            AndroidGattClientState.AUTH_WRITING_FINISH -> {
                cancelAuthTimeout()
                if (androidPeerCandidate) {
                    if (!isAndroidPeerAuthReady()) {
                        failAndClose(
                            callback,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.AUTH_IDENTITY_NOT_READY
                        )
                        return
                    }
                    val established = runCatching {
                        peerAuthSession?.onClientFinishWritten()
                    }.isSuccess && peerAuthSession != null
                    val transition = if (established) {
                        applyEvent(
                            AndroidGattClientEvent.ANDROID_PEER_SESSION_ESTABLISHED
                        )
                    } else {
                        null
                    }
                    if (
                        transition?.changed != true ||
                        transition.to != AndroidGattClientState.ACTIVE
                    ) {
                        failAndClose(
                            callback,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.AUTH_COMPLETION_FAILED
                        )
                        return
                    }
                    if (reliableDataPlane != null) {
                        startReliableDataSubscriptions(callback, gatt)
                    }
                    return
                }
                val exchange = mutualAuthExchange
                if (exchange == null || !exchange.complete()) {
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        AndroidGattClientFailure.AUTH_COMPLETION_FAILED
                    )
                    return
                }
                val transition =
                    applyEvent(AndroidGattClientEvent.AUTH_FINISH_WRITTEN)
                if (
                    !transition.changed ||
                    transition.to != AndroidGattClientState.AUTHENTICATED
                ) {
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        AndroidGattClientFailure.AUTH_COMPLETION_FAILED
                    )
                    return
                }
                mutualAuthExchange = null
                mutualAuthCertificateId = null
                if (sessionKeyEnabled) {
                    if (directControlExchange == null) {
                        failAndClose(
                            callback,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.KEY_CONTEXT_NOT_READY
                        )
                        return
                    }
                    val keyTransition = applyEvent(
                        AndroidGattClientEvent.SESSION_KEY_START_REQUESTED
                    )
                    if (
                        !keyTransition.changed ||
                        keyTransition.to !=
                        AndroidGattClientState.KEY_WRITING_CLIENT_SHARE
                    ) {
                        failAndClose(
                            callback,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.KEY_CONTEXT_NOT_READY
                        )
                        return
                    }
                    startClientKeyShareWrite(callback, gatt)
                }
            }
            AndroidGattClientState.KEY_WRITING_CLIENT_SHARE -> {
                cancelDirectControlTimeout()
                val transition =
                    applyEvent(AndroidGattClientEvent.CLIENT_KEY_SHARE_WRITTEN)
                if (
                    !transition.changed ||
                    transition.to != AndroidGattClientState.KEY_WAITING_SERVER_SHARE
                ) {
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        AndroidGattClientFailure.KEY_CLIENT_SHARE_WRITE_FAILED
                    )
                    return
                }
                val earlyShare = pendingDirectControlIndication
                pendingDirectControlIndication = null
                if (earlyShare == null) {
                    armDirectControlTimeout(
                        callback,
                        gatt,
                        AndroidGattClientFailure.KEY_SERVER_SHARE_TIMEOUT
                    )
                } else {
                    processServerKeyShare(callback, gatt, earlyShare)
                    earlyShare.fill(0)
                }
            }
            AndroidGattClientState.KEY_WRITING_CLIENT_CONFIRM -> {
                cancelDirectControlTimeout()
                if (directControlExchange?.completeClientConfirmWrite() != true) {
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        AndroidGattClientFailure.KEY_COMPLETION_FAILED
                    )
                    return
                }
                val transition =
                    applyEvent(AndroidGattClientEvent.CLIENT_KEY_CONFIRM_WRITTEN)
                if (
                    !transition.changed ||
                    transition.to != AndroidGattClientState.KEY_ESTABLISHED
                ) {
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        AndroidGattClientFailure.KEY_COMPLETION_FAILED
                    )
                    return
                }
                if (!heartbeatEnabled) return
                val earlyControl = pendingDirectControlIndication
                pendingDirectControlIndication = null
                if (earlyControl == null) {
                    armDirectControlTimeout(
                        callback,
                        gatt,
                        AndroidGattClientFailure.HEARTBEAT_INVALID
                    )
                } else {
                    processDirectControlIndication(callback, gatt, earlyControl)
                    earlyControl.fill(0)
                }
            }
            AndroidGattClientState.ACTIVATION_PROBING,
            AndroidGattClientState.HEARTBEAT_WRITING_PONG -> {
                cancelDirectControlTimeout()
                if (directControlExchange?.completePongWrite() != true) {
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        AndroidGattClientFailure.HEARTBEAT_PONG_WRITE_FAILED
                    )
                    return
                }
                val event =
                    if (state == AndroidGattClientState.ACTIVATION_PROBING) {
                        AndroidGattClientEvent.ACTIVATION_PONG_WRITTEN
                    } else {
                        AndroidGattClientEvent.HEARTBEAT_PONG_WRITTEN
                    }
                val transition = applyEvent(event)
                if (!transition.changed || transition.to != AndroidGattClientState.ACTIVE) {
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        AndroidGattClientFailure.HEARTBEAT_PONG_WRITE_FAILED
                    )
                    return
                }
                val pending = pendingDirectControlIndication
                pendingDirectControlIndication = null
                if (pending != null) {
                    processDirectControlIndication(callback, gatt, pending)
                    pending.fill(0)
                } else {
                    armDirectControlTimeout(
                        callback,
                        gatt,
                        AndroidGattClientFailure.HEARTBEAT_TIMEOUT,
                        HEARTBEAT_IDLE_TIMEOUT_MS
                    )
                }
            }
            AndroidGattClientState.CLOSING -> {
                cancelDirectControlTimeout()
                if (directControlExchange?.completeCloseAckWrite() != true) {
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        AndroidGattClientFailure.CLOSE_ACK_WRITE_FAILED
                    )
                    return
                }
                val transition =
                    applyEvent(AndroidGattClientEvent.CLOSE_ACK_WRITTEN)
                if (!transition.changed || transition.to != AndroidGattClientState.CLOSED) {
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        AndroidGattClientFailure.CLOSE_ACK_WRITE_FAILED
                    )
                    return
                }
                finishCleanClose(callback, gatt)
            }
            else ->
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    failure
                )
        }
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    private fun startHelloWrite(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt
    ) {
        val binding = helloBinding
        val characteristic = helloCharacteristic
        if (binding == null || characteristic == null) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.HELLO_BINDING_INVALID
            )
            return
        }
        val transition =
            applyEvent(AndroidGattClientEvent.HELLO_WRITE_REQUESTED)
        if (
            !transition.changed ||
            transition.to != AndroidGattClientState.WRITING_HELLO
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.HELLO_WRITE_FAILED
            )
            return
        }
        val payload =
            runCatching { binding.requestPayload() }.getOrElse {
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    AndroidGattClientFailure.HELLO_BINDING_INVALID
                )
                return
            }
        val started = writeHelloCharacteristic(gatt, characteristic, payload)
        if (!started) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.HELLO_WRITE_START_FAILED
            )
            return
        }
        armHelloTimeout(
            callback,
            gatt,
            AndroidGattClientFailure.HELLO_WRITE_TIMEOUT
        )
    }

    @SuppressLint("MissingPermission")
    private fun writeHelloCharacteristic(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        payload: ByteArray
    ): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                gatt.writeCharacteristic(
                    characteristic,
                    payload,
                    BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                ) == BluetoothStatusCodes.SUCCESS
            } catch (_: SecurityException) {
                false
            } catch (_: RuntimeException) {
                false
            } finally {
                payload.fill(0)
            }
        } else {
            characteristic.writeType =
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            characteristic.value = payload
            val started =
                runCatching { gatt.writeCharacteristic(characteristic) }
                    .getOrDefault(false)
            if (!started) clearCharacteristicValue(characteristic)
            started
        }
    }

    @Synchronized
    private fun handleHelloRead(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray,
        status: Int
    ) {
        if (!claimGatt(callback, gatt)) return
        if (
            characteristic.uuid == AndroidGattProfileV1.helloUuid &&
            status == BluetoothGatt.GATT_SUCCESS &&
            stateMachine.state == AndroidGattClientState.HELLO_EXCHANGED
        ) {
            return
        }
        if (
            characteristic.uuid != AndroidGattProfileV1.helloUuid ||
            stateMachine.state != AndroidGattClientState.READING_HELLO ||
            status != BluetoothGatt.GATT_SUCCESS
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.HELLO_READ_FAILED
            )
            return
        }
        val payload = value.copyOf()
        var preparedExchange: AndroidMutualAuthExchangeV1? = null
        var preparedPeerSession: AndroidGattPeerAuthClientSessionV2? = null
        val accepted =
            try {
                val binding = checkNotNull(helloBinding)
                binding.acceptResponse(payload)
                if (androidPeerCandidate) {
                    require(isAndroidPeerAuthReady())
                    val pair = binding.helloPair()
                    preparedPeerSession = requireNotNull(peerAuthSessionFactory).create(
                        RELIABLE_SESSION_TOKEN_V1,
                        checkNotNull(negotiatedMtu),
                        pair.first,
                        pair.second,
                        checkNotNull(peerClientAdvertisement),
                        checkNotNull(peerServerAdvertisement),
                        checkNotNull(peerAliasEpoch)
                    )
                    requireNotNull(preparedPeerSession)
                } else if (mutualAuthEnabled) {
                    val authBinding =
                        binding.mutualAuthBinding(
                            checkNotNull(mutualAuthCertificateId)
                        )
                    preparedExchange = AndroidMutualAuthExchangeV1(
                        identity = identityManager,
                        initialBinding = authBinding
                    )
                }
                true
            } catch (_: IllegalArgumentException) {
                false
            } catch (_: IllegalStateException) {
                false
            } finally {
                payload.fill(0)
                clearCharacteristicValue(characteristic)
            }
        if (!accepted) {
            preparedExchange?.clear()
            preparedPeerSession?.close()
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                if (mutualAuthEnabled || androidPeerCandidate) {
                    AndroidGattClientFailure.AUTH_BINDING_INVALID
                } else {
                    AndroidGattClientFailure.HELLO_RESPONSE_INVALID
                }
            )
            return
        }
        cancelHelloTimeout()
        val transition = applyEvent(AndroidGattClientEvent.HELLO_ACCEPTED)
        if (
            !transition.changed ||
            transition.to != AndroidGattClientState.HELLO_EXCHANGED
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.HELLO_RESPONSE_INVALID
            )
            return
        }
        mutualAuthExchange = preparedExchange
        peerAuthSession = preparedPeerSession
        helloBinding?.clear()
        helloBinding = null
        if (mutualAuthEnabled || androidPeerCandidate) {
            startAuthSubscription(callback, gatt)
        }
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    private fun startAuthSubscription(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt
    ) {
        val transmitter = controlTxCharacteristic
        val descriptor = authDescriptor
        if (
            (mutualAuthExchange == null && peerAuthSession == null) ||
            transmitter == null ||
            descriptor == null
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_BINDING_INVALID
            )
            return
        }
        val transition =
            applyEvent(AndroidGattClientEvent.AUTH_SUBSCRIBE_REQUESTED)
        if (
            !transition.changed ||
            transition.to != AndroidGattClientState.AUTH_SUBSCRIBING
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_SUBSCRIBE_START_FAILED
            )
            return
        }
        val notificationEnabled =
            try {
                gatt.setCharacteristicNotification(transmitter, true)
            } catch (_: SecurityException) {
                false
            } catch (_: RuntimeException) {
                false
            }
        if (!notificationEnabled || !writeIndicationDescriptor(gatt, descriptor)) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_SUBSCRIBE_START_FAILED
            )
            return
        }
        armAuthTimeout(
            callback,
            gatt,
            AndroidGattClientFailure.AUTH_SUBSCRIBE_TIMEOUT
        )
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    private fun handleAuthDescriptorWrite(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        descriptor: BluetoothGattDescriptor,
        status: Int
    ) {
        if (!claimGatt(callback, gatt)) return
        val validDescriptor =
            descriptor.uuid ==
                AndroidGattProfileV1.clientConfigurationDescriptorUuid &&
                descriptor.characteristic.uuid == AndroidGattProfileV1.controlTxUuid
        if (
            (!mutualAuthEnabled && !androidPeerCandidate) ||
            !validDescriptor ||
            stateMachine.state != AndroidGattClientState.AUTH_SUBSCRIBING ||
            status != BluetoothGatt.GATT_SUCCESS
        ) {
            clearDescriptorValue(descriptor)
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_SUBSCRIBE_FAILED
            )
            return
        }
        cancelAuthTimeout()
        clearDescriptorValue(descriptor)
        val transition = applyEvent(AndroidGattClientEvent.AUTH_SUBSCRIBED)
        if (
            !transition.changed ||
            transition.to != AndroidGattClientState.AUTH_WRITING_CLIENT_PROOF
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_SUBSCRIBE_FAILED
            )
            return
        }
        startClientProofWrite(callback, gatt)
    }

    @SuppressLint("MissingPermission")
    private fun startClientProofWrite(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt
    ) {
        val characteristic = controlRxCharacteristic
        if (androidPeerCandidate) {
            if (!isAndroidPeerAuthReady()) {
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    AndroidGattClientFailure.AUTH_IDENTITY_NOT_READY
                )
                return
            }
            val outbound = runCatching { peerAuthSession?.start() }.getOrNull()
            val payload = try {
                outbound?.payloadCopy()
            } finally {
                outbound?.close()
            }
            if (
                characteristic == null ||
                outbound?.characteristicUuid != AndroidGattProfileV1.controlRxUuid ||
                payload == null ||
                !writeAuthCharacteristic(gatt, characteristic, payload)
            ) {
                payload?.fill(0)
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    AndroidGattClientFailure.AUTH_CLIENT_PROOF_WRITE_START_FAILED
                )
                return
            }
            armAuthTimeout(
                callback,
                gatt,
                AndroidGattClientFailure.AUTH_CLIENT_PROOF_WRITE_TIMEOUT
            )
            return
        }
        val result =
            runCatching { mutualAuthExchange?.createClientProof() }.getOrNull()
        if (characteristic == null) {
            if (result is BluetoothMutualAuthExchangeResult.Ready) {
                result.payload.fill(0)
            }
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_CLIENT_PROOF_INVALID
            )
            return
        }
        if (result !is BluetoothMutualAuthExchangeResult.Ready) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                if (
                    result is BluetoothMutualAuthExchangeResult.Failure &&
                    result.reason ==
                    BluetoothMutualAuthExchangeFailure.IDENTITY_NOT_READY
                ) {
                    AndroidGattClientFailure.AUTH_IDENTITY_NOT_READY
                } else {
                    AndroidGattClientFailure.AUTH_CLIENT_PROOF_INVALID
                }
            )
            return
        }
        if (!writeAuthCharacteristic(gatt, characteristic, result.payload)) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_CLIENT_PROOF_WRITE_START_FAILED
            )
            return
        }
        armAuthTimeout(
            callback,
            gatt,
            AndroidGattClientFailure.AUTH_CLIENT_PROOF_WRITE_TIMEOUT
        )
    }

    @Synchronized
    private fun handleControlIndication(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray
    ) {
        if (!claimGatt(callback, gatt)) return
        val payload = value.copyOf()
        clearCharacteristicValue(characteristic)
        if (
            (!mutualAuthEnabled && !androidPeerCandidate) ||
            characteristic.uuid != AndroidGattProfileV1.controlTxUuid ||
            payload.size < 2
        ) {
            payload.fill(0)
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_SERVER_PROOF_INVALID
            )
            return
        }
        if (androidPeerCandidate) {
            if (!isAndroidPeerAuthReady()) {
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    AndroidGattClientFailure.AUTH_IDENTITY_NOT_READY
                )
                return
            }
            handlePeerServerReplyIndication(callback, gatt, payload)
            payload.fill(0)
            return
        }
        val messageType = payload[1].toInt() and 0xff
        if (
            messageType ==
            BluetoothDirectControlMessageTypeV1.SERVER_KEY_SHARE.wireValue ||
            messageType == BluetoothDirectControlMessageTypeV1.PING.wireValue ||
            messageType == BluetoothDirectControlMessageTypeV1.CLOSE.wireValue
        ) {
            val featureEnabled =
                if (
                    messageType ==
                    BluetoothDirectControlMessageTypeV1.SERVER_KEY_SHARE.wireValue
                ) {
                    sessionKeyEnabled
                } else {
                    heartbeatEnabled
                }
            if (!featureEnabled) {
                payload.fill(0)
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    AndroidGattClientFailure.KEY_CONTEXT_NOT_READY
                )
                return
            }
            processDirectControlIndication(callback, gatt, payload)
            payload.fill(0)
            return
        }
        handleServerProofIndication(callback, gatt, payload)
        payload.fill(0)
    }

    private fun handlePeerServerReplyIndication(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        payload: ByteArray
    ) {
        if (
            payload.size != AndroidPeerAuthCodecV2.SERVER_REPLY_BYTES ||
            payload[0].toInt() and 0xff != AndroidPeerAuthCodecV2.PROTOCOL_VERSION ||
            payload[1].toInt() and 0xff !=
            AndroidPeerAuthMessageTypeV2.SERVER_REPLY.wire
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_SERVER_PROOF_INVALID
            )
            return
        }
        when (stateMachine.state) {
            AndroidGattClientState.AUTH_WRITING_CLIENT_PROOF -> {
                val pending = pendingServerProof
                if (pending == null) {
                    pendingServerProof = payload.copyOf()
                } else if (!pending.contentEquals(payload)) {
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        AndroidGattClientFailure.AUTH_SERVER_PROOF_INVALID
                    )
                }
            }
            AndroidGattClientState.AUTH_WAITING_SERVER_PROOF ->
                processPeerServerReply(callback, gatt, payload)
            else ->
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    AndroidGattClientFailure.AUTH_SERVER_PROOF_INVALID
                )
        }
    }

    @SuppressLint("MissingPermission")
    private fun processPeerServerReply(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        payload: ByteArray
    ) {
        cancelAuthTimeout()
        val outbound = runCatching {
            peerAuthSession?.onServerReply(AndroidGattProfileV1.controlTxUuid, payload)
        }.getOrNull()
        val finish = try {
            outbound?.payloadCopy()
        } finally {
            outbound?.close()
        }
        if (
            outbound?.characteristicUuid != AndroidGattProfileV1.controlRxUuid ||
            finish == null
        ) {
            finish?.fill(0)
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_SERVER_PROOF_INVALID
            )
            return
        }
        val transition = applyEvent(AndroidGattClientEvent.AUTH_SERVER_PROOF_VERIFIED)
        val characteristic = controlRxCharacteristic
        if (
            !transition.changed ||
            transition.to != AndroidGattClientState.AUTH_WRITING_FINISH ||
            characteristic == null ||
            !writeAuthCharacteristic(gatt, characteristic, finish)
        ) {
            finish.fill(0)
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_FINISH_WRITE_START_FAILED
            )
            return
        }
        armAuthTimeout(
            callback,
            gatt,
            AndroidGattClientFailure.AUTH_FINISH_WRITE_TIMEOUT
        )
    }

    private fun handleServerProofIndication(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        payload: ByteArray
    ) {
        val exchange = mutualAuthExchange
        if (
            payload.size != BluetoothMutualAuthCodecV1.SERVER_PROOF_WIRE_BYTES ||
            exchange == null ||
            exchange.classifyServerProof(payload) !=
            BluetoothMutualAuthServerProofAudience.ACTIVE_BINDING
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_SERVER_PROOF_INVALID
            )
            return
        }
        when (stateMachine.state) {
            AndroidGattClientState.AUTH_WRITING_CLIENT_PROOF -> {
                val pending = pendingServerProof
                if (pending == null) {
                    pendingServerProof = payload.copyOf()
                } else {
                    val duplicate = pending.contentEquals(payload)
                    if (!duplicate) {
                        failAndClose(
                            callback,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.AUTH_SERVER_PROOF_INVALID
                        )
                    }
                }
            }
            AndroidGattClientState.AUTH_WAITING_SERVER_PROOF -> {
                processServerProof(callback, gatt, payload)
            }
            AndroidGattClientState.AUTH_WRITING_FINISH -> {
                val duplicate = exchange.acceptServerProof(payload)
                if (duplicate is BluetoothMutualAuthExchangeResult.Ready) {
                    duplicate.payload.fill(0)
                } else {
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        AndroidGattClientFailure.AUTH_SERVER_PROOF_INVALID
                    )
                }
            }
            else -> {
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    AndroidGattClientFailure.AUTH_SERVER_PROOF_INVALID
                )
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun startClientKeyShareWrite(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt
    ) {
        val characteristic = controlRxCharacteristic
        val result =
            runCatching { directControlExchange?.createClientKeyShare() }
                .getOrNull()
        if (
            characteristic == null ||
            result !is BluetoothDirectControlResultV1.Ready ||
            result.messageType !=
            BluetoothDirectControlMessageTypeV1.CLIENT_KEY_SHARE
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.KEY_CLIENT_SHARE_INVALID
            )
            return
        }
        if (!writeAuthCharacteristic(gatt, characteristic, result.payload)) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.KEY_CLIENT_SHARE_WRITE_START_FAILED
            )
            return
        }
        armDirectControlTimeout(
            callback,
            gatt,
            AndroidGattClientFailure.KEY_CLIENT_SHARE_WRITE_TIMEOUT
        )
    }

    private fun processDirectControlIndication(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        payload: ByteArray
    ) {
        when (payload[1].toInt() and 0xff) {
            BluetoothDirectControlMessageTypeV1.SERVER_KEY_SHARE.wireValue ->
                when (stateMachine.state) {
                    AndroidGattClientState.KEY_WRITING_CLIENT_SHARE ->
                        queueDirectControlIndication(
                            callback,
                            gatt,
                            payload,
                            BluetoothDirectControlCodecV1.SERVER_KEY_SHARE_WIRE_BYTES
                        )
                    AndroidGattClientState.KEY_WAITING_SERVER_SHARE ->
                        processServerKeyShare(callback, gatt, payload)
                    AndroidGattClientState.KEY_WRITING_CLIENT_CONFIRM -> {
                        val duplicate =
                            directControlExchange?.acceptServerKeyShare(payload)
                        if (duplicate !is BluetoothDirectControlResultV1.Ready) {
                            failAndClose(
                                callback,
                                gatt,
                                AndroidGattClientEvent.FAILURE,
                                AndroidGattClientFailure.KEY_SERVER_SHARE_INVALID
                            )
                        }
                    }
                    else ->
                        failAndClose(
                            callback,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.KEY_SERVER_SHARE_INVALID
                        )
                }
            BluetoothDirectControlMessageTypeV1.PING.wireValue ->
                when (stateMachine.state) {
                    AndroidGattClientState.KEY_WRITING_CLIENT_CONFIRM ->
                        queueDirectControlIndication(
                            callback,
                            gatt,
                            payload,
                            BluetoothDirectControlCodecV1.HEARTBEAT_WIRE_BYTES
                        )
                    AndroidGattClientState.KEY_ESTABLISHED,
                    AndroidGattClientState.ACTIVE ->
                        processPing(callback, gatt, payload)
                    AndroidGattClientState.ACTIVATION_PROBING,
                    AndroidGattClientState.HEARTBEAT_WRITING_PONG ->
                        queueDirectControlIndication(
                            callback,
                            gatt,
                            payload,
                            BluetoothDirectControlCodecV1.HEARTBEAT_WIRE_BYTES
                        )
                    else ->
                        failAndClose(
                            callback,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.HEARTBEAT_INVALID
                        )
                }
            BluetoothDirectControlMessageTypeV1.CLOSE.wireValue ->
                when (stateMachine.state) {
                    AndroidGattClientState.KEY_WRITING_CLIENT_CONFIRM,
                    AndroidGattClientState.ACTIVATION_PROBING,
                    AndroidGattClientState.HEARTBEAT_WRITING_PONG ->
                        queueDirectControlIndication(
                            callback,
                            gatt,
                            payload,
                            BluetoothDirectControlCodecV1.CLOSE_WIRE_BYTES
                        )
                    AndroidGattClientState.KEY_ESTABLISHED,
                    AndroidGattClientState.ACTIVE ->
                        processClose(callback, gatt, payload)
                    AndroidGattClientState.CLOSING -> {
                        val duplicate = directControlExchange?.acceptClose(payload)
                        if (duplicate !is BluetoothDirectControlResultV1.Ready) {
                            failAndClose(
                                callback,
                                gatt,
                                AndroidGattClientEvent.FAILURE,
                                AndroidGattClientFailure.CLOSE_INVALID
                            )
                        }
                    }
                    else ->
                        failAndClose(
                            callback,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.CLOSE_INVALID
                        )
                }
            else ->
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    AndroidGattClientFailure.HEARTBEAT_INVALID
                )
        }
    }

    private fun queueDirectControlIndication(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        payload: ByteArray,
        expectedSize: Int
    ) {
        if (payload.size != expectedSize) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.HEARTBEAT_INVALID
            )
            return
        }
        val pending = pendingDirectControlIndication
        if (pending == null) {
            pendingDirectControlIndication = payload.copyOf()
            return
        }
        if (!pending.contentEquals(payload)) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.HEARTBEAT_INVALID
            )
        }
    }

    @SuppressLint("MissingPermission")
    private fun processServerKeyShare(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        payload: ByteArray
    ) {
        cancelDirectControlTimeout()
        val result = directControlExchange?.acceptServerKeyShare(payload)
        if (
            result !is BluetoothDirectControlResultV1.Ready ||
            result.messageType !=
            BluetoothDirectControlMessageTypeV1.CLIENT_KEY_CONFIRM
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.KEY_SERVER_SHARE_INVALID
            )
            return
        }
        val transition =
            applyEvent(AndroidGattClientEvent.SERVER_KEY_SHARE_VERIFIED)
        if (
            !transition.changed ||
            transition.to != AndroidGattClientState.KEY_WRITING_CLIENT_CONFIRM
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.KEY_SERVER_SHARE_INVALID
            )
            return
        }
        val characteristic = controlRxCharacteristic
        if (
            characteristic == null ||
            !writeAuthCharacteristic(gatt, characteristic, result.payload)
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.KEY_CLIENT_CONFIRM_WRITE_START_FAILED
            )
            return
        }
        armDirectControlTimeout(
            callback,
            gatt,
            AndroidGattClientFailure.KEY_CLIENT_CONFIRM_WRITE_TIMEOUT
        )
    }

    @SuppressLint("MissingPermission")
    private fun processPing(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        payload: ByteArray
    ) {
        cancelDirectControlTimeout()
        val activation = stateMachine.state == AndroidGattClientState.KEY_ESTABLISHED
        val result = directControlExchange?.acceptPing(payload)
        if (
            result !is BluetoothDirectControlResultV1.Ready ||
            result.messageType != BluetoothDirectControlMessageTypeV1.PONG
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.HEARTBEAT_INVALID
            )
            return
        }
        val transition = applyEvent(
            if (activation) {
                AndroidGattClientEvent.ACTIVATION_PING_RECEIVED
            } else {
                AndroidGattClientEvent.HEARTBEAT_PING_RECEIVED
            }
        )
        val expectedState =
            if (activation) {
                AndroidGattClientState.ACTIVATION_PROBING
            } else {
                AndroidGattClientState.HEARTBEAT_WRITING_PONG
            }
        if (!transition.changed || transition.to != expectedState) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.HEARTBEAT_INVALID
            )
            return
        }
        val characteristic = controlRxCharacteristic
        if (
            characteristic == null ||
            !writeAuthCharacteristic(gatt, characteristic, result.payload)
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.HEARTBEAT_PONG_WRITE_START_FAILED
            )
            return
        }
        armDirectControlTimeout(
            callback,
            gatt,
            AndroidGattClientFailure.HEARTBEAT_PONG_WRITE_TIMEOUT,
            HEARTBEAT_PONG_WRITE_TIMEOUT_MS
        )
    }

    @SuppressLint("MissingPermission")
    private fun processClose(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        payload: ByteArray
    ) {
        cancelDirectControlTimeout()
        val result = directControlExchange?.acceptClose(payload)
        if (
            result !is BluetoothDirectControlResultV1.Ready ||
            result.messageType != BluetoothDirectControlMessageTypeV1.CLOSE_ACK
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.CLOSE_INVALID
            )
            return
        }
        val transition = applyEvent(AndroidGattClientEvent.CLOSE_FRAME_RECEIVED)
        if (!transition.changed || transition.to != AndroidGattClientState.CLOSING) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.CLOSE_INVALID
            )
            return
        }
        val characteristic = controlRxCharacteristic
        if (
            characteristic == null ||
            !writeAuthCharacteristic(gatt, characteristic, result.payload)
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.CLOSE_ACK_WRITE_START_FAILED
            )
            return
        }
        armDirectControlTimeout(
            callback,
            gatt,
            AndroidGattClientFailure.CLOSE_ACK_WRITE_TIMEOUT,
            CLOSE_ACK_WRITE_TIMEOUT_MS
        )
    }

    @SuppressLint("MissingPermission")
    private fun processServerProof(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        payload: ByteArray
    ) {
        cancelAuthTimeout()
        val result = mutualAuthExchange?.acceptServerProof(payload)
        if (result !is BluetoothMutualAuthExchangeResult.Ready) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_SERVER_PROOF_INVALID
            )
            return
        }
        if (sessionKeyEnabled) {
            val binding = mutualAuthExchange?.directControlBinding()
            if (binding == null) {
                result.payload.fill(0)
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    AndroidGattClientFailure.KEY_CONTEXT_NOT_READY
                )
                return
            }
            directControlExchange?.clear()
            directControlExchange =
                runCatching {
                    AndroidDirectControlClientV1(
                        identity = identityManager,
                        initialBinding = binding
                    )
                }.getOrElse {
                    result.payload.fill(0)
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        AndroidGattClientFailure.KEY_CONTEXT_NOT_READY
                    )
                    return
                }
        }
        val transition =
            applyEvent(AndroidGattClientEvent.AUTH_SERVER_PROOF_VERIFIED)
        if (
            !transition.changed ||
            transition.to != AndroidGattClientState.AUTH_WRITING_FINISH
        ) {
            result.payload.fill(0)
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_SERVER_PROOF_INVALID
            )
            return
        }
        val characteristic = controlRxCharacteristic
        if (
            characteristic == null ||
            !writeAuthCharacteristic(gatt, characteristic, result.payload)
        ) {
            result.payload.fill(0)
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.AUTH_FINISH_WRITE_START_FAILED
            )
            return
        }
        armAuthTimeout(
            callback,
            gatt,
            AndroidGattClientFailure.AUTH_FINISH_WRITE_TIMEOUT
        )
    }

    @SuppressLint("MissingPermission")
    private fun writeIndicationDescriptor(
        gatt: BluetoothGatt,
        descriptor: BluetoothGattDescriptor
    ): Boolean {
        val payload = byteArrayOf(0x02, 0x00)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                gatt.writeDescriptor(descriptor, payload) ==
                    BluetoothStatusCodes.SUCCESS
            } catch (_: SecurityException) {
                false
            } catch (_: RuntimeException) {
                false
            } finally {
                payload.fill(0)
            }
        } else {
            @Suppress("DEPRECATION")
            descriptor.value = payload
            @Suppress("DEPRECATION")
            val started =
                runCatching { gatt.writeDescriptor(descriptor) }
                    .getOrDefault(false)
            if (!started) clearDescriptorValue(descriptor)
            started
        }
    }

    @SuppressLint("MissingPermission")
    private fun writeAuthCharacteristic(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        payload: ByteArray
    ): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                gatt.writeCharacteristic(
                    characteristic,
                    payload,
                    BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                ) == BluetoothStatusCodes.SUCCESS
            } catch (_: SecurityException) {
                false
            } catch (_: RuntimeException) {
                false
            } finally {
                payload.fill(0)
            }
        } else {
            characteristic.writeType =
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            @Suppress("DEPRECATION")
            characteristic.value = payload
            @Suppress("DEPRECATION")
            val started =
                runCatching { gatt.writeCharacteristic(characteristic) }
                    .getOrDefault(false)
            if (!started) clearCharacteristicValue(characteristic)
            started
        }
    }

    @Synchronized
    private fun armHelloTimeout(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        failure: AndroidGattClientFailure
    ) {
        cancelHelloTimeout()
        helloDeadlineActive = true
        val generation = helloTimeoutGeneration
        helloTimeoutHandler.postDelayed(
            {
                synchronized(this@AndroidGattClient) {
                    if (
                        !helloDeadlineActive ||
                        helloTimeoutGeneration != generation ||
                        !callbackOwnership.isOwner(callback) ||
                        activeGatt !== gatt
                    ) {
                        return@synchronized
                    }
                    helloDeadlineActive = false
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        failure
                    )
                }
            },
            HELLO_OPERATION_TIMEOUT_MS
        )
    }

    @Synchronized
    private fun cancelHelloTimeout() {
        helloDeadlineActive = false
        helloTimeoutGeneration =
            if (helloTimeoutGeneration == Long.MAX_VALUE) {
                1L
            } else {
                helloTimeoutGeneration + 1L
            }
        helloTimeoutHandler.removeCallbacksAndMessages(null)
    }

    @Synchronized
    private fun armAuthTimeout(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        failure: AndroidGattClientFailure
    ) {
        cancelAuthTimeout()
        authDeadlineActive = true
        val generation = authTimeoutGeneration
        authTimeoutHandler.postDelayed(
            {
                synchronized(this@AndroidGattClient) {
                    if (
                        !authDeadlineActive ||
                        authTimeoutGeneration != generation ||
                        !callbackOwnership.isOwner(callback) ||
                        activeGatt !== gatt
                    ) {
                        return@synchronized
                    }
                    authDeadlineActive = false
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        failure
                    )
                }
            },
            AUTH_OPERATION_TIMEOUT_MS
        )
    }

    @Synchronized
    private fun cancelAuthTimeout() {
        authDeadlineActive = false
        authTimeoutGeneration =
            if (authTimeoutGeneration == Long.MAX_VALUE) {
                1L
            } else {
                authTimeoutGeneration + 1L
            }
        authTimeoutHandler.removeCallbacksAndMessages(null)
    }

    @Synchronized
    private fun armDirectControlTimeout(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        failure: AndroidGattClientFailure,
        timeoutMs: Long = DIRECT_CONTROL_OPERATION_TIMEOUT_MS
    ) {
        cancelDirectControlTimeout()
        directControlDeadlineActive = true
        val generation = directControlTimeoutGeneration
        directControlTimeoutHandler.postDelayed(
            {
                synchronized(this@AndroidGattClient) {
                    if (
                        !directControlDeadlineActive ||
                        directControlTimeoutGeneration != generation ||
                        !callbackOwnership.isOwner(callback) ||
                        activeGatt !== gatt
                    ) {
                        return@synchronized
                    }
                    directControlDeadlineActive = false
                    failAndClose(
                        callback,
                        gatt,
                        AndroidGattClientEvent.FAILURE,
                        failure
                    )
                }
            },
            timeoutMs
        )
    }

    @Synchronized
    private fun cancelDirectControlTimeout() {
        directControlDeadlineActive = false
        directControlTimeoutGeneration =
            if (directControlTimeoutGeneration == Long.MAX_VALUE) {
                1L
            } else {
                directControlTimeoutGeneration + 1L
            }
        directControlTimeoutHandler.removeCallbacksAndMessages(null)
    }

    @Synchronized
    private fun clearHelloState() {
        helloBinding?.clear()
        helloBinding = null
        helloCharacteristic?.let(::clearCharacteristicValue)
        helloCharacteristic = null
    }

    @Synchronized
    private fun clearMutualAuthState() {
        mutualAuthExchange?.clear()
        mutualAuthExchange = null
        peerAuthSession?.close()
        peerAuthSession = null
        androidPeerCandidate = false
        peerAliasEpoch = null
        peerClientAdvertisement = null
        peerServerAdvertisement = null
        mutualAuthCertificateId = null
        reliablePeerTrustId = null
        pendingServerProof?.fill(0)
        pendingServerProof = null
        controlRxCharacteristic?.let(::clearCharacteristicValue)
        controlRxCharacteristic = null
        controlTxCharacteristic?.let(::clearCharacteristicValue)
        controlTxCharacteristic = null
        authDescriptor?.let(::clearDescriptorValue)
        authDescriptor = null
    }

    @Synchronized
    private fun clearDirectControlState() {
        directControlExchange?.clear()
        directControlExchange = null
        pendingDirectControlIndication?.fill(0)
        pendingDirectControlIndication = null
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    private fun startReliableDataSubscriptions(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt
    ) {
        val plane = reliableDataPlane ?: return
        if (
            stateMachine.state != AndroidGattClientState.ACTIVE ||
            reliableQueue != null ||
            reliableBridge != null
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.RELIABLE_SUBSCRIBE_START_FAILED
            )
            return
        }
        lateinit var queue: AndroidGattReliableOperationQueueV1
        queue = AndroidGattReliableOperationQueueV1(
            starter = { operation, frame ->
                startReliableWrite(gatt, operation, frame)
            },
            onFatal = {
                synchronized(this@AndroidGattClient) {
                    if (claimGatt(callback, gatt)) {
                        failAndClose(
                            callback,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.RELIABLE_OPERATION_FAILED
                        )
                    }
                }
            }
        )
        val bridge = try {
            AndroidGattReliableDataPlaneBridgeV1(
                role = GattReliableEndpointRoleV1.CLIENT,
                sessionToken = RELIABLE_SESSION_TOKEN_V1,
                dataPlane = AndroidGattReliableDataPlaneBindingAdapterV1(plane),
                physicalPublisher = AndroidGattReliablePhysicalPublisherV1 {
                        target,
                        frame ->
                    queue.enqueue(target, frame)
                }
            )
        } catch (_: RuntimeException) {
            queue.close()
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.RELIABLE_SUBSCRIBE_START_FAILED
            )
            return
        }
        reliableQueue = queue
        reliableBridge = bridge
        val setupDeadline = AndroidGattReliableSetupDeadlineV1(
            onFatal = {
                synchronized(this@AndroidGattClient) {
                    if (claimGatt(callback, gatt)) {
                        failAndClose(
                            callback,
                            gatt,
                            AndroidGattClientEvent.FAILURE,
                            AndroidGattClientFailure.RELIABLE_SUBSCRIBE_TIMEOUT
                        )
                    }
                }
            }
        )
        reliableSetupDeadline = setupDeadline
        reliableSetupToken = try {
            setupDeadline.start()
        } catch (_: RuntimeException) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.RELIABLE_SUBSCRIBE_START_FAILED
            )
            return
        }
        reliableSubscriptionPhase = AndroidGattReliableSubscriptionPhaseV1.DATA_WRITING
        if (!startReliableDescriptorWrite(gatt, dataTxCharacteristic, dataDescriptor, false)) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.RELIABLE_SUBSCRIBE_START_FAILED
            )
        }
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    private fun handleReliableDescriptorWrite(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        descriptor: BluetoothGattDescriptor,
        status: Int
    ) {
        if (!claimGatt(callback, gatt)) {
            clearDescriptorValue(descriptor)
            return
        }
        if (
            reliableSubscriptionPhase == AndroidGattReliableSubscriptionPhaseV1.IDLE ||
            reliableSubscriptionPhase == AndroidGattReliableSubscriptionPhaseV1.READY
        ) {
            clearDescriptorValue(descriptor)
            return
        }
        val bridge = reliableBridge
        val expectedDescriptor = when (reliableSubscriptionPhase) {
            AndroidGattReliableSubscriptionPhaseV1.DATA_WRITING ->
                dataDescriptor
            AndroidGattReliableSubscriptionPhaseV1.ACK_WRITING ->
                ackDescriptor
            else -> null
        }
        if (descriptor !== expectedDescriptor) {
            clearDescriptorValue(descriptor)
            if (descriptor !== dataDescriptor && descriptor !== ackDescriptor) return
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.RELIABLE_SUBSCRIBE_FAILED
            )
            return
        }
        val setupDeadline = reliableSetupDeadline
        val setupToken = reliableSetupToken
        if (
            status != BluetoothGatt.GATT_SUCCESS ||
            bridge == null ||
            setupDeadline == null ||
            setupToken == null
        ) {
            clearDescriptorValue(descriptor)
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.RELIABLE_SUBSCRIBE_FAILED
            )
            return
        }
        clearDescriptorValue(descriptor)
        if (reliableSubscriptionPhase == AndroidGattReliableSubscriptionPhaseV1.DATA_WRITING) {
            val ackToken = try {
                setupDeadline.dataWritten(setupToken)
            } catch (_: RuntimeException) {
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    AndroidGattClientFailure.RELIABLE_SUBSCRIBE_FAILED
                )
                return
            }
            if (ackToken == null) return
            runCatching {
                bridge.setTransmitterReady(GattReliableTransmitterV1.DATA, true)
            }.onFailure {
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    AndroidGattClientFailure.RELIABLE_SUBSCRIBE_FAILED
                )
                return
            }
            reliableSetupToken = ackToken
            reliableSubscriptionPhase = AndroidGattReliableSubscriptionPhaseV1.ACK_WRITING
            if (!startReliableDescriptorWrite(gatt, ackTxCharacteristic, ackDescriptor, true)) {
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    AndroidGattClientFailure.RELIABLE_SUBSCRIBE_START_FAILED
                )
            }
            return
        }
        val portToken = try {
            setupDeadline.ackWritten(setupToken)
        } catch (_: RuntimeException) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.RELIABLE_SUBSCRIBE_FAILED
            )
            return
        }
        if (portToken == null) return
        reliableSetupToken = portToken
        val ready = runCatching {
            bridge.setTransmitterReady(GattReliableTransmitterV1.ACK, true)
            val plane = checkNotNull(reliableDataPlane)
            val port = GattReliableApplicationPortV1(plane, RELIABLE_SESSION_TOKEN_V1)
            check(port.available)
            check(reliablePortListener?.onChanged(port) == true)
            reliablePortReady = true
            reliableSubscriptionPhase = AndroidGattReliableSubscriptionPhaseV1.READY
            check(setupDeadline.portReady(portToken))
            reliableSetupToken = null
        }.isSuccess
        if (!ready) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.RELIABLE_SUBSCRIBE_FAILED
            )
        }
    }

    @SuppressLint("MissingPermission")
    private fun startReliableDescriptorWrite(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic?,
        descriptor: BluetoothGattDescriptor?,
        indicate: Boolean
    ): Boolean {
        if (characteristic == null || descriptor == null) return false
        val localEnabled = runCatching {
            gatt.setCharacteristicNotification(characteristic, true)
        }.getOrDefault(false)
        if (!localEnabled) return false
        val payload = (
            if (indicate) {
                BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
            } else {
                BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            }
        ).copyOf()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                gatt.writeDescriptor(descriptor, payload) == BluetoothStatusCodes.SUCCESS
            } catch (_: SecurityException) {
                false
            } catch (_: RuntimeException) {
                false
            } finally {
                payload.fill(0)
            }
        } else {
            descriptor.value = payload
            val started = runCatching { gatt.writeDescriptor(descriptor) }.getOrDefault(false)
            if (!started) clearDescriptorValue(descriptor)
            started
        }
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    private fun startReliableWrite(
        gatt: BluetoothGatt,
        operation: AndroidGattReliableQueuedOperationV1,
        frame: ByteArray
    ): Boolean {
        val characteristic = dataRxCharacteristic ?: return false
        if (
            activeGatt !== gatt ||
            stateMachine.state != AndroidGattClientState.ACTIVE ||
            reliableSubscriptionPhase != AndroidGattReliableSubscriptionPhaseV1.READY ||
            reliableInFlight != null ||
            operation.target != AndroidGattReliablePublishTargetV1(
                AndroidGattProfileV1.dataRxUuid,
                AndroidGattReliableDeliveryV1.WRITE_REQUEST
            )
        ) return false
        val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                gatt.writeCharacteristic(
                    characteristic,
                    frame,
                    BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                ) == BluetoothStatusCodes.SUCCESS
            } catch (_: SecurityException) {
                false
            } catch (_: RuntimeException) {
                false
            }
        } else {
            characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            characteristic.value = frame
            runCatching { gatt.writeCharacteristic(characteristic) }.getOrDefault(false)
        }
        if (started) reliableInFlight = operation
        return started
    }

    @Synchronized
    private fun handleReliableCharacteristicWrite(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        status: Int
    ) {
        if (!claimGatt(callback, gatt)) return
        val operation = reliableInFlight
        val queue = reliableQueue
        if (
            characteristic !== dataRxCharacteristic ||
            operation == null ||
            queue == null
        ) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.RELIABLE_OPERATION_FAILED
            )
            return
        }
        clearCharacteristicValue(characteristic)
        reliableInFlight = null
        runCatching {
            queue.complete(operation, status == BluetoothGatt.GATT_SUCCESS)
        }.onFailure {
            if (claimGatt(callback, gatt)) {
                failAndClose(
                    callback,
                    gatt,
                    AndroidGattClientEvent.FAILURE,
                    AndroidGattClientFailure.RELIABLE_OPERATION_FAILED
                )
            }
        }
    }

    @Synchronized
    private fun handleReliableNotification(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray
    ) {
        if (!claimGatt(callback, gatt)) return
        val acceptedCharacteristic =
            characteristic === dataTxCharacteristic || characteristic === ackTxCharacteristic
        val copy = value.copyOf()
        val accepted = try {
            acceptedCharacteristic &&
                reliableSubscriptionPhase == AndroidGattReliableSubscriptionPhaseV1.READY &&
                runCatching {
                    checkNotNull(reliableBridge).receive(characteristic.uuid, copy)
                }.isSuccess
        } finally {
            copy.fill(0)
        }
        if (!accepted) {
            failAndClose(
                callback,
                gatt,
                AndroidGattClientEvent.FAILURE,
                AndroidGattClientFailure.RELIABLE_OPERATION_FAILED
            )
        }
    }

    @Synchronized
    private fun clearReliableDataPlaneState() {
        val wasReady = reliablePortReady
        reliablePortReady = false
        reliableSubscriptionPhase = AndroidGattReliableSubscriptionPhaseV1.IDLE
        reliableSetupToken = null
        reliableSetupDeadline?.close()
        reliableSetupDeadline = null
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
        dataRxCharacteristic?.let(::clearCharacteristicValue)
        dataRxCharacteristic = null
        dataTxCharacteristic?.let(::clearCharacteristicValue)
        dataTxCharacteristic = null
        ackTxCharacteristic?.let(::clearCharacteristicValue)
        ackTxCharacteristic = null
        dataDescriptor?.let(::clearDescriptorValue)
        dataDescriptor = null
        ackDescriptor?.let(::clearDescriptorValue)
        ackDescriptor = null
        if (wasReady) runCatching { reliablePortListener?.onChanged(null) }
    }

    @Suppress("DEPRECATION")
    private fun clearCharacteristicValue(
        characteristic: BluetoothGattCharacteristic
    ) {
        characteristic.value?.fill(0)
        characteristic.value = ByteArray(0)
    }

    @Suppress("DEPRECATION")
    private fun clearDescriptorValue(descriptor: BluetoothGattDescriptor) {
        descriptor.value?.fill(0)
        descriptor.value = ByteArray(0)
    }

    @Synchronized
    private fun claimGatt(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt
    ): Boolean {
        if (!callbackOwnership.isOwner(callback)) return false
        val current = activeGatt
        if (current != null && current !== gatt) return false
        if (current == null) activeGatt = gatt
        return true
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    private fun finishCleanClose(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt
    ) {
        if (!callbackOwnership.release(callback)) return
        cancelHelloTimeout()
        cancelAuthTimeout()
        cancelDirectControlTimeout()
        clearHelloState()
        clearMutualAuthState()
        clearDirectControlState()
        clearReliableDataPlaneState()
        if (activeGatt === gatt) activeGatt = null
        profileValidated = false
        negotiatedMtu = null
        lastFailure = AndroidGattClientFailure.NONE
        closeGatt(gatt, disconnect = true)
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    private fun failAndClose(
        callback: BluetoothGattCallback,
        gatt: BluetoothGatt,
        event: AndroidGattClientEvent,
        failure: AndroidGattClientFailure
    ) {
        if (!callbackOwnership.release(callback)) return
        cancelHelloTimeout()
        cancelAuthTimeout()
        cancelDirectControlTimeout()
        clearHelloState()
        clearMutualAuthState()
        clearDirectControlState()
        clearReliableDataPlaneState()
        if (activeGatt === gatt) activeGatt = null
        profileValidated = false
        negotiatedMtu = null
        lastFailure = failure
        applyEvent(event)
        closeGatt(gatt, disconnect = event != AndroidGattClientEvent.DISCONNECTED)
    }

    @Synchronized
    private fun applyEvent(
        event: AndroidGattClientEvent,
        mtu: Int? = null
    ): AndroidGattClientTransition {
        val transition = stateMachine.dispatch(event, mtu)
        metrics.record(transition)
        return transition
    }

    private fun capabilitiesOf(
        characteristic: BluetoothGattCharacteristic
    ): Set<AndroidGattCharacteristicCapability> = buildSet {
        val properties = characteristic.properties
        if (properties and BluetoothGattCharacteristic.PROPERTY_READ != 0) {
            add(AndroidGattCharacteristicCapability.READ)
        }
        if (properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) {
            add(AndroidGattCharacteristicCapability.WRITE)
        }
        if (
            properties and
                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0
        ) {
            add(AndroidGattCharacteristicCapability.WRITE_WITHOUT_RESPONSE)
        }
        if (properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) {
            add(AndroidGattCharacteristicCapability.NOTIFY)
        }
        if (properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) {
            add(AndroidGattCharacteristicCapability.INDICATE)
        }
    }

    @SuppressLint("MissingPermission")
    private fun closeGatt(gatt: BluetoothGatt?, disconnect: Boolean) {
        if (gatt == null) return
        if (disconnect) runCatching { gatt.disconnect() }
        runCatching { gatt.close() }
    }

    private fun hasConnectPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            ContextCompat.checkSelfPermission(
                appContext,
                Manifest.permission.BLUETOOTH_CONNECT
            ) == PackageManager.PERMISSION_GRANTED

    companion object {
        const val RELIABLE_SESSION_TOKEN_V1 = 1L
        private const val HELLO_OPERATION_TIMEOUT_MS = 5_000L
        private const val AUTH_OPERATION_TIMEOUT_MS = 5_000L
        private const val DIRECT_CONTROL_OPERATION_TIMEOUT_MS = 5_000L
        private const val CLOSE_ACK_WRITE_TIMEOUT_MS = 2_000L
        private const val HEARTBEAT_PONG_WRITE_TIMEOUT_MS = 2_000L
        private const val HEARTBEAT_IDLE_TIMEOUT_MS = 15_000L
    }
}
