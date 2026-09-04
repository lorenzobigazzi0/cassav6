package com.sentrapa.cassav6.webkiosk.bluetooth

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.sentrapa.cassav6.webkiosk.BuildConfig
import com.sentrapa.cassav6.webkiosk.KioskPreferences
import com.sentrapa.cassav6.webkiosk.MainActivity
import com.sentrapa.cassav6.webkiosk.NotificationClientContext
import com.sentrapa.cassav6.webkiosk.R

class BluetoothFailoverService : Service() {
    private var stateMachine: BluetoothConnectivityStateMachine? = null
    private var metrics: BluetoothConnectivityMetrics? = null
    private var permissionCoordinator: BluetoothPermissionCoordinator? = null
    private var discoveryCoordinator: BluetoothDiscoveryCoordinator? = null
    private var discoveryReporter: BluetoothDiscoveryLabReporter? = null
    private var gattServer: AndroidGattServer? = null
    private var gattServerReporter: BluetoothGattServerLabReporter? = null
    private var gattClient: AndroidGattClient? = null
    private var gattClientReporter: BluetoothGattClientLabReporter? = null
    private var agentReporter: BluetoothAgentLabReporter? = null
    private var transportStore: AndroidBluetoothTransportStoreV1? = null
    private var transportRuntime: AndroidBluetoothTransportRuntimeV1? = null
    private var transportPortArbiter: BluetoothReliableEndpointArbiterV1? = null
    private var clientReliableDataPlane: GattReliableDataPlaneV1? = null
    private var serverReliableDataPlane: GattReliableDataPlaneV1? = null
    private var peerTrustRuntime: AndroidPeerTrustRuntimeV2? = null
    private var backendHealthProbe: AndroidBluetoothBackendHealthProbeV1? = null
    private var routeHealthProvider: DynamicBluetoothRouteHealthProviderV1? = null
    private val diagnosticCommandBus = BluetoothDiagnosticCommandBusV1()
    @Volatile
    private var connectedDeviceForeground = false
    @Volatile
    private var destroying = false

    override fun onCreate() {
        super.onCreate()
        val decision = featureDecision()
        if (
            !decision.agentEnabled ||
            !KioskPreferences.hasAuthenticatedNotificationSession(applicationContext)
        ) {
            sharedStateStore.publish(BluetoothConnectivityState.DISABLED)
            stopSelf()
            return
        }

        stateMachine = BluetoothConnectivityStateMachine(
            initialState = BluetoothConnectivityState.DISABLED,
            futureConnectivityEventsEnabled = false
        )
        metrics = BluetoothConnectivityMetrics()
        permissionCoordinator = BluetoothPermissionCoordinator(applicationContext)
        startAsForegroundService(connectedDeviceEligible = false)
        dispatch(BluetoothConnectivityEvent.START_REQUESTED)

        agentReporter = BluetoothAgentLabReporter(
            context = applicationContext,
            labBuild = BuildConfig.BLUETOOTH_LAB_BUILD,
            diagnosticsEnabled = decision.diagnosticsEnabled,
            agentEnabled = decision.agentEnabled,
            statusProvider = ::agentLabSnapshot
        ).also { it.start() }

        if (decision.futureSessionFlagsGuarded) {
            dispatch(BluetoothConnectivityEvent.FAULT_DETECTED)
            Log.e(TAG, "B5.7 ha bloccato flag di sessione non ancora supportati")
            return
        }

        val peerTrust = if (decision.androidPeerAuthEnabled) {
            AndroidPeerTrustRuntimeV2.create(
                applicationContext,
                AndroidPeerTrustRuntimeConfigV2(
                    enabled = true,
                    directoryUrl = BuildConfig.BLUETOOTH_PEER_TRUST_DIRECTORY_URL,
                    tlsSpkiSha256 =
                        BuildConfig.BLUETOOTH_PEER_TRUST_TLS_SPKI_SHA256,
                    authoritySpkiDerBase64 =
                        BuildConfig.BLUETOOTH_PEER_TRUST_AUTHORITY_SPKI_DER_BASE64
                ),
                onTrustStateChanged = ::onPeerTrustStateChanged
            ).getOrNull()
        } else {
            null
        }
        peerTrustRuntime = peerTrust
        val androidPeerAuthConfigured =
            decision.androidPeerAuthEnabled && peerTrust != null
        val androidPeerAuthReady = {
            androidPeerAuthConfigured && peerTrust?.isReady() == true
        }

        val client = AndroidGattClient(
            context = applicationContext,
            enabled = decision.gattClientEnabled,
            helloEnabled = decision.helloExchangeEnabled,
            mutualAuthEnabled = decision.mutualAuthEnabled,
            sessionKeyEnabled = decision.sessionKeyEnabled,
            heartbeatEnabled = decision.heartbeatEnabled,
            androidPeerAuthEnabled = androidPeerAuthConfigured,
            androidPeerAuthReady = androidPeerAuthReady,
            peerAuthSessionFactory = peerTrust?.clientSessionFactory
        )
        gattClient = client
        gattClientReporter = BluetoothGattClientLabReporter(
            context = applicationContext,
            labBuild = BuildConfig.BLUETOOTH_LAB_BUILD,
            diagnosticsEnabled = decision.diagnosticsEnabled,
            gattClientEnabled = decision.gattClientEnabled,
            statusProvider = client::snapshot
        ).also { it.start() }

        val directServer = AndroidGattServer(
            context = applicationContext,
            enabled = decision.gattServerEnabled,
            helloEnabled = decision.gattServerHelloEnabled,
            localAdvertisementProvider = {
                discoveryCoordinator?.localAdvertisementSnapshot()
            },
            onActiveChanged = { active ->
                discoveryCoordinator?.setGattServerActive(active)
            },
            androidPeerAuthEnabled = androidPeerAuthConfigured,
            androidPeerAuthReady = androidPeerAuthReady,
            peerAuthSessionFactory = peerTrust?.serverSessionFactory {
                discoveryCoordinator?.localAdvertisementSnapshot()
            }
        )
        gattServer = directServer
        gattServerReporter = BluetoothGattServerLabReporter(
            context = applicationContext,
            labBuild = BuildConfig.BLUETOOTH_LAB_BUILD,
            diagnosticsEnabled = decision.diagnosticsEnabled,
            gattServerEnabled = decision.gattServerEnabled,
            statusProvider = directServer::snapshot
        ).also { it.start() }

        startTransportRuntimeBoundary(
            client,
            directServer,
            androidPeerAuthConfigured
        )

        val coordinator = BluetoothDiscoveryCoordinator(
            context = applicationContext,
            discoveryFeatureEnabled = decision.discoveryEnabled,
            identityFeatureEnabled = BuildConfig.BLUETOOTH_IDENTITY_ENABLED,
            nodeKind =
                BluetoothAdvertisementNodeKind.fromBuildConfig(
                    BuildConfig.BLUETOOTH_NODE_KIND
            ),
            onConnectedDeviceEligibilityChanged = ::updateForegroundServiceType,
            gattServerInitiallyActive = directServer.isActive,
            gattClientFeatureEnabled = decision.gattClientEnabled,
            androidPeerAuthEnabled = androidPeerAuthConfigured,
            androidPeerAuthReady = androidPeerAuthReady,
            serverReachableProvider = {
                runCatching {
                    routeHealthProvider?.currentServerReachable() == true
                }.onFailure {
                    onRouteHealthFatal()
                }.getOrDefault(false)
            },
            onGattPeerObserved = { _, remote, _, aliasEpoch ->
                peerTrust?.recordObservation(remote, aliasEpoch)
            },
            onGattCandidate = { device, advertisement, localAdvertisement ->
                client.considerCandidate(
                    device,
                    advertisement,
                    localAdvertisement
                ) == AndroidGattConnectResult.STARTED
            },
            onRuntimeEvent = ::onDiscoveryRuntimeEvent
        )
        discoveryCoordinator = coordinator
        peerTrust?.refreshAsync { ready ->
            if (ready) discoveryCoordinator?.refresh()
        }
        coordinator.setGattServerActive(directServer.isActive)
        discoveryReporter = BluetoothDiscoveryLabReporter(
            context = applicationContext,
            labBuild = BuildConfig.BLUETOOTH_LAB_BUILD,
            diagnosticsEnabled = decision.diagnosticsEnabled,
            statusProvider = coordinator::labStatusSnapshot
        ).also { it.start() }
        refreshAgent()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (
            !featureDecision().agentEnabled ||
            !KioskPreferences.hasAuthenticatedNotificationSession(applicationContext)
        ) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        refreshAgent()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        start(applicationContext)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        destroying = true
        agentReporter?.close()
        agentReporter = null
        discoveryReporter?.close()
        discoveryReporter = null
        discoveryCoordinator?.close()
        discoveryCoordinator = null
        gattServerReporter?.close()
        gattServerReporter = null
        gattServer?.close()
        gattServer = null
        gattClientReporter?.close()
        gattClientReporter = null
        gattClient?.close()
        gattClient = null
        transportRuntime?.close()
        transportRuntime = null
        backendHealthProbe?.close()
        backendHealthProbe = null
        routeHealthProvider = null
        transportPortArbiter?.close()
        transportPortArbiter = null
        clientReliableDataPlane?.close()
        clientReliableDataPlane = null
        serverReliableDataPlane?.close()
        serverReliableDataPlane = null
        transportStore?.close()
        transportStore = null
        peerTrustRuntime?.close()
        peerTrustRuntime = null
        if (stateMachine?.state != BluetoothConnectivityState.STOPPED) {
            dispatch(BluetoothConnectivityEvent.STOP_REQUESTED)
        }
        permissionCoordinator = null
        connectedDeviceForeground = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun refreshAgent() {
        val coordinator = discoveryCoordinator ?: return
        val permissions = permissionCoordinator?.snapshot() ?: return
        val current = stateMachine?.state ?: return
        if (!permissions.allGranted) {
            if (
                gattServer?.snapshot()?.state !in setOf(
                    null,
                    AndroidGattServerState.IDLE,
                    AndroidGattServerState.CLOSED
                )
            ) {
                gattServer?.reset()
            }
            if (
                current != BluetoothConnectivityState.DISABLED &&
                current != BluetoothConnectivityState.STOPPED
            ) {
                dispatch(BluetoothConnectivityEvent.PERMISSIONS_MISSING)
            }
        } else if (current == BluetoothConnectivityState.PERMISSION_REQUIRED) {
            dispatch(BluetoothConnectivityEvent.PERMISSIONS_GRANTED)
        }
        if (permissions.allGranted) gattServer?.start()
        coordinator.refresh()
        peerTrustRuntime?.refreshAsync { ready ->
            if (ready) discoveryCoordinator?.refresh()
        }
        refreshBackendHealthProbeTarget()
        if (BuildConfig.BLUETOOTH_COMMAND_BUS_SHADOW) {
            diagnosticCommandBus.publish(
                BluetoothDiagnosticCommandV1(
                    kind = BluetoothShadowKindV1.HEALTH,
                    body = "agent-health"
                )
            )
        }
    }

    private fun startTransportRuntimeBoundary(
        client: AndroidGattClient,
        server: AndroidGattServer,
        androidPeerAuthConfigured: Boolean
    ) {
        if (
            !BuildConfig.BLUETOOTH_ROUTE_ADVERTISEMENT_ENABLED &&
            !BuildConfig.BLUETOOTH_COMMAND_BUS_SHADOW
        ) return
        if (!androidPeerAuthConfigured) return
        runCatching {
            val store = AndroidBluetoothTransportStoreV1(applicationContext)
            val healthSignals = BluetoothRouteHealthSignalStoreV1()
            val healthProbe = AndroidBluetoothBackendHealthProbeV1(
                applicationContext,
                healthSignals,
                onFatal = { onRouteHealthFatal() }
            )
            val dynamicHealthProvider = DynamicBluetoothRouteHealthProviderV1(
                signalSource = healthSignals,
                routeKindSource = AndroidBluetoothRouteKindSourceV1(applicationContext),
                queueDepthSource = {
                    store.snapshot().outboxDepth.toLong()
                },
                elapsedRealtimeMs = SystemClock::elapsedRealtime
            )
            val multiplexer = BluetoothReliableApplicationPortMultiplexerV1()
            val runtime = AndroidBluetoothTransportRuntimeV1(
                routeAdvertisementEnabled =
                    BuildConfig.BLUETOOTH_ROUTE_ADVERTISEMENT_ENABLED,
                commandBusShadowEnabled = BuildConfig.BLUETOOTH_COMMAND_BUS_SHADOW,
                routeStore = AndroidRouteAdvertisementStoreV1(store),
                shadowHandler = BluetoothShadowHandlerV1 { },
                diagnosticCommandBus = diagnosticCommandBus,
                healthProvider = dynamicHealthProvider,
                onFatal = { onReliableRuntimeFatal() }
            )
            val clientPlane = GattReliableDataPlaneV1(
                contextProvider = client,
                store = store,
                onMessage = runtime,
                enabled = true
            )
            val serverPlane = GattReliableDataPlaneV1(
                contextProvider = server,
                store = store,
                onMessage = runtime,
                enabled = true
            )
            val arbiter = BluetoothReliableEndpointArbiterV1(
                multiplexer,
                runtime
            )
            runtime.attachPort(multiplexer)
            transportStore = store
            routeHealthProvider = dynamicHealthProvider
            backendHealthProbe = healthProbe
            healthProbe.start()
            healthProbe.updateTarget(resolveBackendHealthProbeTarget())
            transportRuntime = runtime
            transportPortArbiter = arbiter
            clientReliableDataPlane = clientPlane
            serverReliableDataPlane = serverPlane
            client.configureReliableDataPlane(
                clientPlane,
                AndroidGattReliablePortListenerV1 { port ->
                    onReliablePortChanged(BluetoothReliableEndpointSourceV1.CLIENT, port)
                }
            )
            server.configureReliableDataPlane(
                serverPlane,
                AndroidGattReliablePortListenerV1 { port ->
                    onReliablePortChanged(BluetoothReliableEndpointSourceV1.SERVER, port)
                }
            )
        }.onFailure { error ->
            transportRuntime?.close()
            transportRuntime = null
            backendHealthProbe?.close()
            backendHealthProbe = null
            routeHealthProvider = null
            transportPortArbiter?.close()
            transportPortArbiter = null
            clientReliableDataPlane?.close()
            clientReliableDataPlane = null
            serverReliableDataPlane?.close()
            serverReliableDataPlane = null
            transportStore?.close()
            transportStore = null
            Log.e(TAG, "Runtime B9/B10 bloccato in modo fail-closed", error)
            dispatchFaultIfAllowed()
        }
    }

    private fun refreshBackendHealthProbeTarget() {
        val probe = backendHealthProbe ?: return
        runCatching {
            probe.updateTarget(resolveBackendHealthProbeTarget())
        }.onFailure {
            onRouteHealthFatal()
        }
    }

    private fun resolveBackendHealthProbeTarget(): BluetoothBackendHealthProbeTargetV1? {
        val session = KioskPreferences.getNotificationClientContext(applicationContext)
        if (!session.hasAuthenticatedSession) return null
        return BluetoothBackendHealthProbeTargetResolverV1.resolve(
            KioskPreferences.getSavedUrl(applicationContext),
            session.sessionBindingKey
        )
    }

    private fun onRouteHealthFatal() {
        runCatching { routeHealthProvider?.snapshot(System.currentTimeMillis()) }
        dispatchFaultIfAllowed()
    }

    private fun onPeerTrustStateChanged(ready: Boolean) {
        if (destroying) return
        val leasesValid = AndroidPeerTrustLeaseBoundaryV2.enforce(
            ready = ready,
            arbiter = transportPortArbiter,
            revalidateClient = {
                gattClient?.revalidatePeerTrustLease() != false
            },
            revalidateServer = {
                gattServer?.revalidatePeerTrustLease() != false
            },
            abortClient = {
                gattClient?.abortReliableSession()
            },
            abortServer = {
                gattServer?.abortReliableSession()
            }
        )
        if (!leasesValid) {
            dispatchFaultIfAllowed()
        }
        runCatching { discoveryCoordinator?.refresh() }
    }

    @Synchronized
    private fun onReliablePortChanged(
        source: BluetoothReliableEndpointSourceV1,
        port: BluetoothReliableApplicationPortV1?
    ): Boolean = transportPortArbiter?.onPortChanged(source, port) == true

    private fun onReliableRuntimeFatal() {
        val source = transportPortArbiter?.onRuntimeFatal() ?: return
        when (source) {
            BluetoothReliableEndpointSourceV1.CLIENT ->
                runCatching {
                    val client = gattClient
                    if (client?.abortReliableSession() != true) client?.close()
                }
            BluetoothReliableEndpointSourceV1.SERVER ->
                runCatching {
                    val server = gattServer
                    if (server?.abortReliableSession() != true) server?.reset()
                }
        }
        dispatchFaultIfAllowed()
    }

    private fun onDiscoveryRuntimeEvent(event: BluetoothDiscoveryRuntimeEvent) {
        if (destroying && event.lifecycle != BluetoothDiscoveryLifecycle.STOPPED) return
        when (event.lifecycle) {
            BluetoothDiscoveryLifecycle.STARTING ->
                when (stateMachine?.state) {
                    BluetoothConnectivityState.BACKOFF ->
                        dispatch(BluetoothConnectivityEvent.BACKOFF_EXPIRED)
                    BluetoothConnectivityState.PERMISSION_REQUIRED ->
                        if (permissionCoordinator?.snapshot()?.allGranted == true) {
                            dispatch(BluetoothConnectivityEvent.PERMISSIONS_GRANTED)
                        }
                    else -> Unit
                }
            BluetoothDiscoveryLifecycle.ACTIVE -> {
                if (stateMachine?.state == BluetoothConnectivityState.PERMISSION_REQUIRED) {
                    if (permissionCoordinator?.snapshot()?.allGranted != true) return
                    dispatch(BluetoothConnectivityEvent.PERMISSIONS_GRANTED)
                }
                dispatch(BluetoothConnectivityEvent.DISCOVERY_READY)
            }
            BluetoothDiscoveryLifecycle.NOT_READY ->
                if (event.readiness == BluetoothDiscoveryReadiness.PERMISSIONS_REQUIRED) {
                    dispatch(BluetoothConnectivityEvent.PERMISSIONS_MISSING)
                } else if (
                    stateMachine?.state != BluetoothConnectivityState.PERMISSION_REQUIRED
                ) {
                    dispatchFaultIfAllowed()
                }
            BluetoothDiscoveryLifecycle.BACKOFF ->
                dispatchBackoffIfAllowed()
            BluetoothDiscoveryLifecycle.STOPPED ->
                dispatch(BluetoothConnectivityEvent.STOP_REQUESTED)
        }
    }

    private fun dispatchFaultIfAllowed() {
        when (stateMachine?.state) {
            BluetoothConnectivityState.STARTING,
            BluetoothConnectivityState.DISCOVERING,
            BluetoothConnectivityState.DIRECT_SERVER,
            BluetoothConnectivityState.PEER_CONNECTED,
            BluetoothConnectivityState.DEGRADED,
            BluetoothConnectivityState.BACKOFF ->
                dispatch(BluetoothConnectivityEvent.FAULT_DETECTED)
            else -> Unit
        }
    }

    private fun dispatchBackoffIfAllowed() {
        when (stateMachine?.state) {
            BluetoothConnectivityState.STARTING,
            BluetoothConnectivityState.DISCOVERING,
            BluetoothConnectivityState.DIRECT_SERVER,
            BluetoothConnectivityState.PEER_CONNECTED,
            BluetoothConnectivityState.DEGRADED,
            BluetoothConnectivityState.BACKOFF ->
                dispatch(BluetoothConnectivityEvent.BACKOFF_REQUESTED)
            else -> Unit
        }
    }

    private fun dispatch(event: BluetoothConnectivityEvent) {
        val machine = stateMachine ?: return
        val result = machine.dispatch(event)
        metrics?.record(result)
        sharedStateStore.publish(result.to)
    }

    private fun agentLabSnapshot(): BluetoothAgentLabRuntimeSnapshot =
        gattServer?.snapshot().let { serverSnapshot ->
            val reliable = transportPortArbiter?.snapshot()
            BluetoothAgentLabRuntimeSnapshot(
                state = stateMachine?.state ?: BluetoothConnectivityState.DISABLED,
                metrics = metrics?.snapshot() ?: EMPTY_METRICS,
                resources = discoveryCoordinator
                    ?.agentResourceSnapshot()
                    ?.copy(
                        gattServerActive = serverSnapshot?.active == true,
                        gattClientActive = gattClient?.isActive == true,
                        sessionCount = serverSnapshot?.sessionCount ?: 0,
                        reliableClientActive = reliable?.clientActive == true,
                        reliableServerActive = reliable?.serverActive == true,
                        reliableArbitrationRejected = reliable?.rejected ?: 0
                    )
                    ?: BluetoothAgentResourceSnapshot(
                        scannerActive = false,
                        advertiserActive = false,
                        gattServerActive = serverSnapshot?.active == true,
                        gattClientActive = gattClient?.isActive == true,
                        sessionCount = serverSnapshot?.sessionCount ?: 0,
                        reliableClientActive = reliable?.clientActive == true,
                        reliableServerActive = reliable?.serverActive == true,
                        reliableArbitrationRejected = reliable?.rejected ?: 0
                    )
            )
        }

    private fun updateForegroundServiceType(eligible: Boolean): Boolean {
        if (destroying) {
            if (!eligible) connectedDeviceForeground = false
            return !eligible
        }
        if (connectedDeviceForeground == eligible) return true
        return try {
            startAsForegroundService(eligible)
            connectedDeviceForeground = eligible
            true
        } catch (error: RuntimeException) {
            Log.e(TAG, "Tipo foreground Bluetooth non applicabile", error)
            false
        }
    }

    private fun startAsForegroundService(connectedDeviceEligible: Boolean) {
        ensureNotificationChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            var serviceTypes = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            if (connectedDeviceEligible) {
                serviceTypes =
                    serviceTypes or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            }
            startForeground(SERVICE_NOTIFICATION_ID, notification, serviceTypes)
        } else {
            startForeground(SERVICE_NOTIFICATION_ID, notification)
        }
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(SERVICE_CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            SERVICE_CHANNEL_ID,
            "CASSA_V6 Bluetooth",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Mantiene attivo il discovery Bluetooth CASSA_V6."
            setSound(null, null)
            enableVibration(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, SERVICE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("CASSA_V6 Bluetooth attivo")
            .setContentText("Discovery locale in esecuzione.")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    companion object {
        private const val TAG = "BluetoothFailoverSvc"
        private const val ACTION_START =
            "com.sentrapa.cassav6.webkiosk.bluetooth.action.START_FAILOVER"
        private const val ACTION_REFRESH =
            "com.sentrapa.cassav6.webkiosk.bluetooth.action.REFRESH_FAILOVER"
        private const val SERVICE_CHANNEL_ID = "cassav6_bluetooth_failover"
        private const val SERVICE_NOTIFICATION_ID = 2_003
        private val sharedStateStore = BluetoothAgentStateStore()
        private val EMPTY_METRICS = BluetoothConnectivityMetricsSnapshot(
            starts = 0L,
            stops = 0L,
            backoffs = 0L,
            transitions = 0L,
            duplicates = 0L,
            invalid = 0L
        )

        fun start(context: Context) {
            val sessionContext = KioskPreferences.getNotificationClientContext(context)
            if (!shouldStartBluetoothFailoverRuntime(BuildConfig.BLUETOOTH_FAILOVER_ENABLED, sessionContext)) return
            startServiceIntent(context, ACTION_START)
        }

        fun refresh(context: Context) {
            val sessionContext = KioskPreferences.getNotificationClientContext(context)
            if (!shouldStartBluetoothFailoverRuntime(BuildConfig.BLUETOOTH_FAILOVER_ENABLED, sessionContext)) return
            startServiceIntent(context, ACTION_REFRESH)
        }

        fun stopForSessionClear(context: Context) {
            val appContext = context.applicationContext
            runCatching {
                appContext.stopService(Intent(appContext, BluetoothFailoverService::class.java))
            }.onFailure { error ->
                Log.w(TAG, "Arresto servizio Bluetooth al logout non riuscito: ${error.message}")
            }
            val notificationManager =
                appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.cancel(SERVICE_NOTIFICATION_ID)
        }

        fun stateSnapshot(): BluetoothAgentStateSnapshot = sharedStateStore.snapshot()

        fun addStateListener(
            listener: (BluetoothAgentStateSnapshot) -> Unit
        ): BluetoothAgentStateSubscription? =
            sharedStateStore.addListener(listener = listener)

        private fun startServiceIntent(context: Context, action: String) {
            val appContext = context.applicationContext
            val intent = Intent(appContext, BluetoothFailoverService::class.java)
                .setAction(action)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ContextCompat.startForegroundService(appContext, intent)
                } else {
                    appContext.startService(intent)
                }
            } catch (error: RuntimeException) {
                Log.e(TAG, "Avvio servizio Bluetooth non riuscito: ${error.message}")
            }
        }

        private fun featureDecision(): BluetoothFailoverFeatureDecision =
            BluetoothFailoverFeaturePolicy.evaluate(
                BluetoothFailoverFeatureInput(
                    masterEnabled = BuildConfig.BLUETOOTH_FAILOVER_ENABLED,
                    labBuild = BuildConfig.BLUETOOTH_LAB_BUILD,
                    diagnosticsEnabled = BuildConfig.BLUETOOTH_DIAGNOSTICS_ENABLED,
                    identityEnabled = BuildConfig.BLUETOOTH_IDENTITY_ENABLED,
                    discoveryEnabled = BuildConfig.BLUETOOTH_DISCOVERY_ENABLED,
                    directServerEnabled = BuildConfig.BLUETOOTH_DIRECT_SERVER_ENABLED,
                    peerLinkEnabled = BuildConfig.BLUETOOTH_PEER_LINK_ENABLED,
                    androidPeerAuthEnabled =
                        BuildConfig.BLUETOOTH_ANDROID_PEER_AUTH_V2_ENABLED,
                    gattClientEnabled = BuildConfig.BLUETOOTH_GATT_CLIENT_ENABLED,
                    helloExchangeEnabled =
                        BuildConfig.BLUETOOTH_HELLO_EXCHANGE_ENABLED,
                    mutualAuthEnabled =
                        BuildConfig.BLUETOOTH_MUTUAL_AUTH_ENABLED,
                    sessionKeyEnabled =
                        BuildConfig.BLUETOOTH_SESSION_KEY_ENABLED,
                    heartbeatEnabled =
                        BuildConfig.BLUETOOTH_HEARTBEAT_ENABLED
                )
            )
    }
}

internal fun shouldStartBluetoothFailoverRuntime(
    featureEnabled: Boolean,
    sessionContext: NotificationClientContext
): Boolean = featureEnabled && sessionContext.hasAuthenticatedSession
