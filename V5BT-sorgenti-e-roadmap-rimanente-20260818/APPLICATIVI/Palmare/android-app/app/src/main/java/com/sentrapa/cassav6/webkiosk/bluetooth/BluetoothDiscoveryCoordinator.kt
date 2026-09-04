package com.sentrapa.cassav6.webkiosk.bluetooth

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import java.security.SecureRandom
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class BluetoothDiscoveryCoordinator(
    context: Context,
    private val discoveryFeatureEnabled: Boolean,
    private val identityFeatureEnabled: Boolean,
    private val platformProfile: BluetoothDiscoveryPlatformProfile =
        BluetoothDiscoveryPlatformProfile.CERTIFIED,
    private val nodeKind: BluetoothAdvertisementNodeKind?,
    private val onConnectedDeviceEligibilityChanged: (Boolean) -> Boolean,
    gattServerInitiallyActive: Boolean = false,
    private val gattClientFeatureEnabled: Boolean = false,
    private val androidPeerAuthEnabled: Boolean = false,
    private val androidPeerAuthReady: () -> Boolean = { androidPeerAuthEnabled },
    private val serverReachableProvider: () -> Boolean = { false },
    private val onGattPeerObserved:
        (
            BluetoothDevice,
            BluetoothAdvertisementV1,
            BluetoothAdvertisementV1,
            Long
        ) -> Unit = { _, _, _, _ -> },
    private val onGattCandidate:
        (
            BluetoothDevice,
            BluetoothAdvertisementV1,
            BluetoothAdvertisementV1
        ) -> Boolean = { _, _, _ -> false },
    private val onRuntimeEvent: (BluetoothDiscoveryRuntimeEvent) -> Unit = {}
) {
    private val appContext = context.applicationContext
    private val workerThread = HandlerThread("CASSA_V6-BluetoothDiscovery").apply { start() }
    private val worker = Handler(workerThread.looper)
    private val identityManager = DeviceIdentityManager(appContext, identityFeatureEnabled)
    private val identityReadiness = BluetoothDiscoveryIdentityReadinessV1(
        object : BluetoothDiscoveryIdentityPortV1 {
            override fun inspectExisting(): Boolean =
                identityManager.inspectExistingIdentity().status == DeviceIdentityStatus.READY

            override fun provision(): Boolean =
                identityManager.provision().status == DeviceIdentityStatus.READY
        }
    )
    private val capabilityProbe = BluetoothCapabilityProbe(appContext)
    private val scanner = BleScanner(appContext, platformProfile)
    private val advertiser = BleAdvertiser(appContext)
    private val directory = BluetoothPeerDirectory()
    private val metrics = BluetoothDiscoveryMetrics()
    private val scanIngress =
        BluetoothScanIngressQueue<PendingScanResult>(
            BluetoothDiscoveryPolicy.MAX_PENDING_SCAN_RESULTS
        )
    private val secureRandom = SecureRandom()
    private val closed = AtomicBoolean(false)
    private var adapterReceiverRegistered = false
    @Volatile
    private var radioActive = false
    @Volatile
    private var gattServerActive = gattServerInitiallyActive
    private var connectedDeviceEligible = false
    @Volatile
    private var scanProfile = BluetoothScanProfile.FAILOVER
    private var scanScheduler: BluetoothScanWindowScheduler? = null
    private var scanGeneration: Long? = null
    private var scanWindowStartedAtMs: Long? = null
    private var scanWindowEndsAtMs: Long? = null
    private var nextDirectoryPruneAtMs = 0L
    private var lastAdvertisementUpdateMs = Long.MIN_VALUE
    private var pendingAdvertisementGeneration: Long? = null
    private var nextAdvertisementGeneration = 1L
    private val radioStartupGate = BluetoothRadioStartupGate()
    private val advertisingHysteresis = BluetoothAdvertisingHysteresis()
    private val advertisingTimerSlot = BluetoothAdvertisingTimerSlot()
    private var advertisementState: BluetoothAdvertisementState? = null
    private data class PendingGattCandidate(
        val device: BluetoothDevice,
        val advertisement: BluetoothAdvertisementV1,
        val observedAtElapsedMs: Long,
        val nextAttemptAtElapsedMs: Long
    )
    private val pendingGattCandidates =
        LinkedHashMap<BluetoothPeerStreamKey, PendingGattCandidate>()
    private var lastPeerAuthReady = false

    @Volatile
    var readiness: BluetoothDiscoveryReadiness =
        BluetoothDiscoveryReadiness.DISCOVERY_FEATURE_DISABLED
        private set

    private val adapterStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == BluetoothAdapter.ACTION_STATE_CHANGED) refresh()
        }
    }
    private val advanceScanSchedule = Runnable { advanceScanSchedule() }
    private val checkPeerExpiry = Runnable {
        nextDirectoryPruneAtMs = 0L
        advanceScanSchedule()
    }
    private val drainScanIngress = Runnable { drainScanIngress() }
    private val rotateAlias = Runnable { rotateAdvertisement() }
    private val refreshAdvertisementHealth = Runnable { refreshAdvertisementHealth() }
    private val retryRefresh = Runnable { refreshInternal() }
    private val retryGattCandidates = Runnable { retryGattCandidatesNow() }

    init {
        if (discoveryFeatureEnabled && identityFeatureEnabled) {
            ContextCompat.registerReceiver(
                appContext,
                adapterStateReceiver,
                IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED),
                ContextCompat.RECEIVER_EXPORTED
            )
            adapterReceiverRegistered = true
        }
    }

    fun refresh() {
        if (!closed.get()) worker.post { refreshInternal() }
    }

    fun setScanProfile(profile: BluetoothScanProfile) {
        if (closed.get()) return
        worker.post { applyScanProfile(profile) }
    }

    fun setGattServerActive(active: Boolean) {
        if (closed.get()) return
        worker.post { applyGattServerActive(active) }
    }

    @Synchronized
    internal fun localAdvertisementSnapshot(): BluetoothAdvertisementV1? =
        advertisementState?.current()

    fun metricsSnapshot(): BluetoothDiscoveryMetricsSnapshot =
        metrics.snapshot(directory.metrics())

    internal fun labStatusSnapshot(): BluetoothDiscoveryLabRuntimeSnapshot =
        BluetoothDiscoveryLabRuntimeSnapshot(
            readiness = readiness,
            radioActive = radioActive,
            scanProfile = scanProfile,
            activePeerCount = directory.activePeerCount(SystemClock.elapsedRealtime()),
            metrics = metricsSnapshot()
        )

    internal fun agentResourceSnapshot(): BluetoothAgentResourceSnapshot =
        BluetoothAgentResourceSnapshot(
            scannerActive = scanner.isRunning,
            advertiserActive = advertiser.isRunning
        )

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        val cleanupGate = BluetoothDiscoveryCleanupGate()
        val cleanup = {
            cleanupGate.runOnce {
                stopRadio()
                if (adapterReceiverRegistered) {
                    runCatching { appContext.unregisterReceiver(adapterStateReceiver) }
                    adapterReceiverRegistered = false
                }
                emitRuntimeEvent(BluetoothDiscoveryLifecycle.STOPPED)
            }
        }
        if (Looper.myLooper() == worker.looper) {
            cleanup()
            workerThread.quitSafely()
            return
        }
        val posted = worker.post {
            cleanup()
            workerThread.quitSafely()
        }
        val completedInTime =
            posted && cleanupGate.await(CLOSE_TIMEOUT_MS)
        val requiresFallback =
            BluetoothDiscoveryClosePolicy.requiresSynchronousFallback(
                posted,
                completedInTime
            )
        if (requiresFallback) {
            worker.removeCallbacksAndMessages(null)
            val claimedCleanup = cleanup()
            if (!claimedCleanup) cleanupGate.awaitCompletionUninterruptibly()
            workerThread.quitSafely()
        }
    }

    private fun refreshInternal() {
        if (closed.get()) return
        worker.removeCallbacks(retryRefresh)
        emitRuntimeEvent(BluetoothDiscoveryLifecycle.STARTING)
        if (!discoveryFeatureEnabled) {
            applyNotReady(BluetoothDiscoveryReadiness.DISCOVERY_FEATURE_DISABLED)
            return
        }
        if (!identityFeatureEnabled) {
            applyNotReady(BluetoothDiscoveryReadiness.IDENTITY_FEATURE_DISABLED)
            return
        }
        if (Build.VERSION.SDK_INT < platformProfile.minimumAndroidApi) {
            applyNotReady(BluetoothDiscoveryReadiness.PLATFORM_UNSUPPORTED)
            return
        }
        if (nodeKind == null) {
            applyNotReady(BluetoothDiscoveryReadiness.CAPABILITY_NOT_FULL_NODE)
            return
        }

        val identityReady = runCatching {
            identityReadiness.isReady(androidPeerAuthEnabled)
        }.getOrDefault(false)
        if (!identityReady) {
            applyNotReady(BluetoothDiscoveryReadiness.IDENTITY_NOT_READY)
            return
        }

        val capability =
            runCatching { capabilityProbe.probe(probeGattServer = false) }.getOrNull()
        if (capability == null) {
            applyNotReady(BluetoothDiscoveryReadiness.BLE_HARDWARE_UNAVAILABLE)
            return
        }
        val input = BluetoothDiscoveryPrerequisiteInput(
            discoveryFeatureEnabled = discoveryFeatureEnabled,
            identityFeatureEnabled = identityFeatureEnabled,
            androidApi = Build.VERSION.SDK_INT,
            platformProfile = platformProfile,
            identityReady = true,
            bluetoothLeFeature = capability.bluetoothLeFeature,
            adapterPresent = capability.adapterPresent,
            adapterEnabled = capability.adapterEnabled == true,
            scanPermission = capability.scanPermission,
            advertisePermission = capability.advertisePermission,
            connectPermission = capability.connectPermission,
            nodeClass = BluetoothDiscoveryNodeClassifier.classifyNonInvasively(
                scannerAvailable = capability.scannerAvailable,
                advertiserAvailable = capability.advertiserAvailable,
                gattClientAvailable = capability.gattClientAvailable
            )
        )
        val nextReadiness = BluetoothDiscoveryPrerequisitePolicy.evaluate(input)
        if (nextReadiness != BluetoothDiscoveryReadiness.READY) {
            applyNotReady(nextReadiness)
            return
        }

        readiness = BluetoothDiscoveryReadiness.READY
        if (closed.get()) return
        if (!setConnectedDeviceEligible(true)) {
            failRadioAndRetry()
            return
        }
        if (!radioActive) startRadio()
        refreshGattCandidateReadiness()
    }

    @Synchronized
    private fun startRadio() {
        if (closed.get()) return
        val kind = nodeKind ?: run {
            applyNotReady(BluetoothDiscoveryReadiness.CAPABILITY_NOT_FULL_NODE)
            return
        }
        val alias = deriveAlias() ?: run {
            applyNotReady(BluetoothDiscoveryReadiness.IDENTITY_NOT_READY)
            return
        }
        val state = BluetoothAdvertisementState(::nextBootId)
        val advertisement = state.start(
            nodeKind = kind,
            rotatingAlias = alias,
            capabilities = BluetoothCapabilityBitsV1.B2_FULL_NODE,
            serverReachable = currentServerReachable()
        )
        advertisementState = state
        radioActive = true
        cancelAdvertisingDowngrade()
        val advertisingDecision =
            runCatching {
                advertisingHysteresis.start(SystemClock.elapsedRealtime())
            }.getOrElse {
                metrics.recordAdvertisementFailure()
                failRadioAndRetry()
                return
            }
        if (!startOrReplaceAdvertisement(advertisement, advertisingDecision.mode)) return
        scheduleAliasRotation()
        scheduleAdvertisementHealthRefresh()
    }

    private fun handleAdvertisementStarted(advertisementGeneration: Long) {
        if (!radioActive || closed.get()) return
        if (pendingAdvertisementGeneration != advertisementGeneration) return
        pendingAdvertisementGeneration = null
        lastAdvertisementUpdateMs = SystemClock.elapsedRealtime()
        when (radioStartupGate.onAdvertisementStarted(advertisementGeneration)) {
            BluetoothRadioStartupAction.IGNORE -> Unit
            BluetoothRadioStartupAction.RECORD_REPLACEMENT ->
                metrics.recordAdvertisementUpdated()
            BluetoothRadioStartupAction.COMPLETE_STARTUP -> {
                metrics.recordAdvertisementStarted()
                val nowMs = SystemClock.elapsedRealtime()
                scanScheduler = BluetoothScanWindowScheduler(scanProfile, nowMs)
                advanceScanSchedule()
                if (radioActive && !closed.get()) {
                    emitRuntimeEvent(BluetoothDiscoveryLifecycle.ACTIVE)
                }
            }
        }
    }

    private fun advanceScanSchedule() {
        if (
            !radioActive ||
            closed.get() ||
            !radioStartupGate.hasCompletedStartup()
        ) {
            return
        }
        worker.removeCallbacks(advanceScanSchedule)
        worker.removeCallbacks(checkPeerExpiry)
        val nowMs = SystemClock.elapsedRealtime()
        val scheduler =
            scanScheduler ?: BluetoothScanWindowScheduler(scanProfile, nowMs).also {
                scanScheduler = it
            }
        val decision =
            runCatching { scheduler.evaluate(nowMs) }.getOrElse {
                metrics.recordScanFailure()
                failRadioAndRetry()
                return
            }
        if (nowMs >= nextDirectoryPruneAtMs) {
            directory.pruneExpired(nowMs)
            nextDirectoryPruneAtMs =
                nowMs + BluetoothDiscoveryPolicy.PEER_PRUNE_INTERVAL_MS
        }
        val activePeers = directory.snapshot(nowMs)
        val desiredProfile =
            BluetoothDiscoveryPolicy.scanProfileForPeerPresence(
                activePeers.isNotEmpty()
            )
        if (desiredProfile != scanProfile) {
            applyScanProfile(desiredProfile)
            return
        }
        schedulePeerExpiryCheck(nowMs, activePeers)
        when (decision.command) {
            BluetoothScanCommand.START -> {
                if (!startScanWindow(decision)) return
            }
            BluetoothScanCommand.STOP ->
                stopScanWindow()
            BluetoothScanCommand.RESTART -> {
                stopScanWindow()
                if (!startScanWindow(decision)) return
            }
            BluetoothScanCommand.NONE -> Unit
        }
        if (!radioActive || closed.get()) return
        val remainingMs =
            decision.nextTransitionAtMs - SystemClock.elapsedRealtime()
        worker.postDelayed(advanceScanSchedule, remainingMs.coerceAtLeast(1L))
    }

    @Synchronized
    private fun startScanWindow(decision: BluetoothScanDecision): Boolean {
        if (closed.get() || !radioActive) return false
        val generation = scanIngress.openGeneration()
        scanGeneration = generation
        scanWindowStartedAtMs = decision.evaluatedAtMs
        scanWindowEndsAtMs = decision.windowEndAtMs
        metrics.recordScanWindowStarted()
        val accepted = scanner.start(
            profile = scanProfile,
            onServiceData = { device, payload, rssi ->
                enqueueScanResult(generation, device, payload, rssi)
            },
            onDiagnostic = { event ->
                when (event) {
                    BluetoothScanDiagnosticEvent.RAW_CALLBACK ->
                        metrics.recordRawCallback()
                    BluetoothScanDiagnosticEvent.UUID_MATCH ->
                        metrics.recordUuidMatch()
                }
            },
            onFailure = {
                worker.post {
                    if (
                        scanGeneration != generation ||
                        !scanIngress.isGenerationActive(generation)
                    ) {
                        return@post
                    }
                    metrics.recordScanFailure()
                    failRadioAndRetry()
                }
            }
        )
        if (!accepted) {
            invalidateScanGeneration()
            metrics.recordScanFailure()
            failRadioAndRetry()
            return false
        }
        if (advertiser.isRunning) {
            metrics.recordConcurrentScanAdvertiseWindowStarted()
        }
        return true
    }

    private fun stopScanWindow(
        drainPendingBeforeInvalidation: Boolean = false
    ) {
        val wasRunning = scanner.isRunning
        scanner.stop()
        if (drainPendingBeforeInvalidation) {
            drainPendingScanIngressBeforeProfileTransition()
        }
        invalidateScanGeneration()
        scanWindowStartedAtMs = null
        scanWindowEndsAtMs = null
        if (wasRunning) metrics.recordScanWindowCompleted()
    }

    private fun enqueueScanResult(
        generation: Long,
        device: BluetoothDevice,
        payload: ByteArray,
        rssi: Int
    ) {
        if (closed.get()) {
            metrics.recordScanIngressDropped()
            return
        }
        val offer = scanIngress.offer(
            generation,
            PendingScanResult(generation, device, payload, rssi)
        )
        if (offer.droppedCount > 0) {
            metrics.recordScanIngressDropped(offer.droppedCount)
        }
        if (!offer.accepted || !offer.shouldScheduleDrain) return
        if (!worker.post(drainScanIngress)) {
            val droppedCount = scanIngress.cancelScheduledDrain()
            if (droppedCount > 0) metrics.recordScanIngressDropped(droppedCount)
        }
    }

    private fun drainScanIngress() {
        if (closed.get() || !radioActive) {
            val droppedCount = scanIngress.cancelScheduledDrain()
            if (droppedCount > 0) metrics.recordScanIngressDropped(droppedCount)
            return
        }
        val batch =
            scanIngress.takeBatch(BluetoothDiscoveryPolicy.SCAN_INGRESS_BATCH_SIZE)
        var discoveredPeer = false
        batch.values.forEach { result ->
            if (handleServiceData(result)) discoveredPeer = true
        }
        if (discoveredPeer && scanProfile != BluetoothScanProfile.STABLE) {
            applyScanProfile(BluetoothScanProfile.STABLE)
            return
        }
        if (discoveredPeer) {
            schedulePeerExpiryCheck(SystemClock.elapsedRealtime())
        }
        if (batch.hasMore && !worker.post(drainScanIngress)) {
            val droppedCount = scanIngress.cancelScheduledDrain()
            if (droppedCount > 0) metrics.recordScanIngressDropped(droppedCount)
        }
    }

    private fun handleServiceData(result: PendingScanResult): Boolean {
        val windowEndsAtMs = scanWindowEndsAtMs
        val generationActive =
            scanGeneration == result.generation &&
                scanIngress.isGenerationActive(result.generation)
        if (
            closed.get() ||
            !radioActive ||
            !generationActive ||
            windowEndsAtMs == null ||
            SystemClock.elapsedRealtime() >= windowEndsAtMs
        ) {
            metrics.recordScanIngressDropped()
            return false
        }
        val advertisement =
            try {
                BluetoothAdvertisementCodecV1.decode(result.payload)
            } catch (_: IllegalArgumentException) {
                metrics.recordInvalidPayload()
                return false
            }
        metrics.recordValidPayload()
        val nowMs = SystemClock.elapsedRealtime()
        val observation = directory.observe(advertisement, result.rssi, nowMs)
        val accepted = when (observation.result) {
            BluetoothPeerObservationResult.ADDED,
            BluetoothPeerObservationResult.CAPACITY_EVICTED_ADDED -> {
                metrics.recordAcceptedObservation()
                scanWindowStartedAtMs?.let { startedAtMs ->
                    metrics.recordFirstObservationOffset(nowMs - startedAtMs)
                }
                true
            }
            BluetoothPeerObservationResult.UPDATED,
            BluetoothPeerObservationResult.DUPLICATE_REFRESHED -> {
                metrics.recordAcceptedObservation()
                true
            }
            else -> false
        }
        if (accepted) {
            when (scheduleAdvertisingDowngrade(nowMs)) {
                AdvertisingDowngradeScheduleResult.ACCEPTED -> Unit
                AdvertisingDowngradeScheduleResult.ABORTED -> return false
                AdvertisingDowngradeScheduleResult.FAILED -> {
                    metrics.recordAdvertisementFailure()
                    failRadioAndRetry()
                    return false
                }
            }
        }
        val localAdvertisement = advertisementState?.current()
        if (localAdvertisement != null) {
            val peerAuthReady =
                androidPeerAuthEnabled &&
                    runCatching(androidPeerAuthReady).getOrDefault(false)
            val aliasEpoch = RotatingAliasV1.epoch(
                System.currentTimeMillis() / 1_000L,
                BluetoothDiscoveryPolicy.ALIAS_EPOCH_SECONDS
            )
            if (
                androidPeerAuthEnabled &&
                advertisement.nodeKind != BluetoothAdvertisementNodeKind.RASPBERRY
            ) {
                runCatching {
                    onGattPeerObserved(
                        result.device,
                        advertisement,
                        localAdvertisement,
                        aliasEpoch
                    )
                }
            }
            if (gattClientFeatureEnabled) {
                if (advertisement.nodeKind == BluetoothAdvertisementNodeKind.RASPBERRY) {
                    if (
                        BluetoothGattCandidatePolicy.shouldConnect(
                            observation.result,
                            advertisement,
                            localAdvertisement,
                            peerAuthReady,
                            aliasEpoch
                        )
                    ) {
                        runCatching {
                            onGattCandidate(
                                result.device,
                                advertisement,
                                localAdvertisement
                            )
                        }
                    }
                } else if (androidPeerAuthEnabled) {
                    rememberGattCandidate(result.device, advertisement, nowMs)
                    if (peerAuthReady) {
                        attemptGattCandidate(
                            BluetoothPeerStreamKey(
                                advertisement.rotatingAlias,
                                advertisement.bootId
                            ),
                            localAdvertisement,
                            aliasEpoch,
                            nowMs
                        )
                    }
                }
            }
        }
        return accepted
    }

    private fun applyScanProfile(profile: BluetoothScanProfile) {
        if (scanProfile == profile) return
        if (radioActive && radioStartupGate.hasCompletedStartup() && scanner.isRunning) {
            stopScanWindow(drainPendingBeforeInvalidation = true)
        }
        scanProfile = profile
        if (!radioActive || !radioStartupGate.hasCompletedStartup()) return
        val nowMs = SystemClock.elapsedRealtime()
        if (profile == BluetoothScanProfile.FAILOVER) {
            cancelAdvertisingDowngrade()
            val advertisingDecision =
                runCatching {
                    advertisingHysteresis.enterFailover(nowMs)
                }.getOrElse {
                    metrics.recordAdvertisementFailure()
                    failRadioAndRetry()
                    return
                }
            if (
                advertisingDecision.action ==
                    BluetoothAdvertisingHysteresisAction.APPLY_LOW_LATENCY
            ) {
                val advertisement = advertisementState?.current() ?: run {
                    metrics.recordAdvertisementFailure()
                    failRadioAndRetry()
                    return
                }
                if (
                    !startOrReplaceAdvertisement(
                        advertisement,
                        advertisingDecision.mode
                    )
                ) return
            }
        }
        worker.removeCallbacks(advanceScanSchedule)
        val scheduler =
            scanScheduler ?: BluetoothScanWindowScheduler(profile, nowMs).also {
                scanScheduler = it
            }
        scheduler.setProfile(profile, nowMs)
        advanceScanSchedule()
    }

    private fun drainPendingScanIngressBeforeProfileTransition() {
        // The scanner is stopped first, so this queue cannot refill mid-transition.
        worker.removeCallbacks(drainScanIngress)
        while (scanIngress.pendingCount() > 0) {
            val batch =
                scanIngress.takeBatch(
                    BluetoothDiscoveryPolicy.SCAN_INGRESS_BATCH_SIZE
                )
            batch.values.forEach(::handleServiceData)
        }
    }

    private fun schedulePeerExpiryCheck(
        nowMs: Long,
        activePeers: List<BluetoothPeerRecord> = directory.snapshot(nowMs)
    ) {
        worker.removeCallbacks(checkPeerExpiry)
        val delayMs =
            BluetoothDiscoveryPolicy.nextPeerExpiryDelayMs(
                nowMs,
                activePeers.map(BluetoothPeerRecord::lastSeenMs)
            ) ?: return
        worker.postDelayed(checkPeerExpiry, delayMs.coerceAtLeast(1L))
    }

    private fun invalidateScanGeneration() {
        worker.removeCallbacks(drainScanIngress)
        val generation = scanGeneration ?: return
        scanGeneration = null
        val droppedCount = scanIngress.invalidateGeneration(generation)
        if (droppedCount > 0) metrics.recordScanIngressDropped(droppedCount)
    }

    @Synchronized
    private fun rotateAdvertisement() {
        if (!radioActive || closed.get()) return
        if (pendingAdvertisementGeneration != null) {
            worker.postDelayed(
                rotateAlias,
                BluetoothDiscoveryPolicy.ADVERTISEMENT_HEALTH_REFRESH_MS
            )
            return
        }
        val elapsedMs = SystemClock.elapsedRealtime()
        val rateLimitRemaining =
            BluetoothDiscoveryPolicy.ADVERTISEMENT_UPDATE_MIN_INTERVAL_MS -
                (elapsedMs - lastAdvertisementUpdateMs)
        if (rateLimitRemaining > 0L) {
            worker.postDelayed(rotateAlias, rateLimitRemaining)
            return
        }
        val alias = deriveAlias() ?: run {
            applyNotReady(BluetoothDiscoveryReadiness.IDENTITY_NOT_READY)
            return
        }
        val state = advertisementState ?: return
        val previous = state.current()
        val next = state.update(
            rotatingAlias = alias,
            capabilities = BluetoothCapabilityBitsV1.B2_FULL_NODE,
            serverReachable = currentServerReachable()
        )
        if (next != previous) {
            val advertiseMode = advertisingHysteresis.snapshot().mode
            if (!startOrReplaceAdvertisement(next, advertiseMode)) return
        }
        scheduleAliasRotation()
    }

    @Synchronized
    private fun refreshAdvertisementHealth() {
        if (!radioActive || closed.get()) return
        if (
            pendingAdvertisementGeneration != null ||
            !radioStartupGate.hasCompletedStartup()
        ) {
            scheduleAdvertisementHealthRefresh()
            return
        }
        val state = advertisementState ?: return
        val previous = state.current() ?: return
        val desiredServerReachable = currentServerReachable()
        if (previous.serverReachable != desiredServerReachable) {
            val elapsedMs = SystemClock.elapsedRealtime()
            val rateLimitRemaining =
                BluetoothDiscoveryPolicy.ADVERTISEMENT_UPDATE_MIN_INTERVAL_MS -
                    (elapsedMs - lastAdvertisementUpdateMs)
            if (rateLimitRemaining > 0L) {
                worker.postDelayed(refreshAdvertisementHealth, rateLimitRemaining)
                return
            }
        }
        val next = state.update(
            rotatingAlias = previous.rotatingAlias,
            capabilities = previous.capabilities,
            serverReachable = desiredServerReachable
        )
        if (next != previous) {
            if (
                !startOrReplaceAdvertisement(
                    next,
                    advertisingHysteresis.snapshot().mode
                )
            ) return
        }
        scheduleAdvertisementHealthRefresh()
    }

    private fun scheduleAdvertisementHealthRefresh() {
        worker.removeCallbacks(refreshAdvertisementHealth)
        if (!radioActive || closed.get()) return
        if (
            !worker.postDelayed(
                refreshAdvertisementHealth,
                BluetoothDiscoveryPolicy.ADVERTISEMENT_HEALTH_REFRESH_MS
            )
        ) {
            metrics.recordAdvertisementFailure()
            failRadioAndRetry()
        }
    }

    private fun currentServerReachable(): Boolean =
        runCatching(serverReachableProvider).getOrDefault(false)

    private fun refreshGattCandidateReadiness() {
        val ready = androidPeerAuthEnabled &&
            runCatching(androidPeerAuthReady).getOrDefault(false)
        if (ready && !lastPeerAuthReady) retryGattCandidatesNow()
        lastPeerAuthReady = ready
    }

    private fun rememberGattCandidate(
        device: BluetoothDevice,
        advertisement: BluetoothAdvertisementV1,
        observedAtElapsedMs: Long
    ) {
        val key = BluetoothPeerStreamKey(
            advertisement.rotatingAlias,
            advertisement.bootId
        )
        val previous = pendingGattCandidates[key]
        pendingGattCandidates[key] = PendingGattCandidate(
            device,
            advertisement,
            observedAtElapsedMs,
            previous?.nextAttemptAtElapsedMs ?: observedAtElapsedMs
        )
    }

    private fun retryGattCandidatesNow() {
        worker.removeCallbacks(retryGattCandidates)
        if (!radioActive || closed.get() || !androidPeerAuthEnabled) return
        if (!runCatching(androidPeerAuthReady).getOrDefault(false)) return
        val nowMs = SystemClock.elapsedRealtime()
        val localAdvertisement = advertisementState?.current() ?: return
        val aliasEpoch = RotatingAliasV1.epoch(
            System.currentTimeMillis() / 1_000L,
            BluetoothDiscoveryPolicy.ALIAS_EPOCH_SECONDS
        )
        pendingGattCandidates.entries.removeAll { (_, candidate) ->
            nowMs < candidate.observedAtElapsedMs ||
                nowMs - candidate.observedAtElapsedMs >
                    BluetoothDiscoveryPolicy.PEER_EXPIRY_MS
        }
        pendingGattCandidates.keys.toList().forEach { key ->
            attemptGattCandidate(key, localAdvertisement, aliasEpoch, nowMs)
        }
        val nextAt = pendingGattCandidates.values.minOfOrNull {
            it.nextAttemptAtElapsedMs
        } ?: return
        worker.postDelayed(retryGattCandidates, (nextAt - nowMs).coerceAtLeast(1L))
    }

    private fun attemptGattCandidate(
        key: BluetoothPeerStreamKey,
        localAdvertisement: BluetoothAdvertisementV1,
        aliasEpoch: Long,
        nowMs: Long
    ) {
        val candidate = pendingGattCandidates[key] ?: return
        if (nowMs < candidate.nextAttemptAtElapsedMs) return
        if (
            !BluetoothGattCandidatePolicy.shouldConnect(
                BluetoothPeerObservationResult.ADDED,
                candidate.advertisement,
                localAdvertisement,
                androidPeerAuthEnabled = true,
                aliasEpoch = aliasEpoch
            )
        ) {
            pendingGattCandidates.remove(key)
            return
        }
        val accepted = runCatching {
            onGattCandidate(
                candidate.device,
                candidate.advertisement,
                localAdvertisement
            )
        }.getOrDefault(false)
        pendingGattCandidates[key] = candidate.copy(
            nextAttemptAtElapsedMs =
                BluetoothGattCandidateRetryPolicyV1.nextAttemptAt(
                    nowMs,
                    accepted
                )
        )
        worker.removeCallbacks(retryGattCandidates)
        worker.postDelayed(
            retryGattCandidates,
            if (accepted) {
                BluetoothGattCandidateRetryPolicyV1.ACCEPTED_RECHECK_MS
            } else {
                BluetoothGattCandidateRetryPolicyV1.REJECTED_RETRY_MS
            }
        )
    }

    private fun startOrReplaceAdvertisement(
        advertisement: BluetoothAdvertisementV1,
        advertiseMode: BluetoothAdvertiseMode
    ): Boolean {
        val advertisementGeneration = activateAdvertisementGeneration()
        pendingAdvertisementGeneration = advertisementGeneration
        val accepted = advertiser.startOrReplace(
            advertisement = advertisement,
            connectable =
                BluetoothDiscoveryPolicy.isAdvertisementConnectable(gattServerActive),
            advertiseMode = advertiseMode,
            onStarted = {
                worker.post {
                    handleAdvertisementStarted(advertisementGeneration)
                }
            },
            onFailure = {
                worker.post {
                    if (
                        !radioActive ||
                        closed.get() ||
                        !radioStartupGate.shouldHandleFailure(advertisementGeneration)
                    ) {
                        return@post
                    }
                    if (pendingAdvertisementGeneration == advertisementGeneration) {
                        pendingAdvertisementGeneration = null
                    }
                    metrics.recordAdvertisementFailure()
                    failRadioAndRetry()
                }
            }
        )
        if (!accepted) {
            invalidateAdvertisementGeneration(advertisementGeneration)
            if (pendingAdvertisementGeneration == advertisementGeneration) {
                pendingAdvertisementGeneration = null
            }
            metrics.recordAdvertisementFailure()
            failRadioAndRetry()
            return false
        }
        return true
    }

    private fun applyGattServerActive(active: Boolean) {
        if (closed.get() || gattServerActive == active) return
        gattServerActive = active
        val advertisement = advertisementState?.current() ?: return
        if (!radioActive || !radioStartupGate.hasCompletedStartup()) return
        startOrReplaceAdvertisement(
            advertisement,
            advertisingHysteresis.snapshot().mode
        )
    }

    private fun scheduleAdvertisingDowngrade(
        observedAtMs: Long
    ): AdvertisingDowngradeScheduleResult {
        if (!radioActive || closed.get()) {
            return AdvertisingDowngradeScheduleResult.ABORTED
        }
        val decision =
            runCatching {
                advertisingHysteresis.onAcceptedObservation(observedAtMs)
            }.getOrElse {
                return AdvertisingDowngradeScheduleResult.FAILED
            }
        return scheduleAdvertisingDowngrade(decision)
    }

    private fun scheduleAdvertisingDowngrade(
        decision: BluetoothAdvertisingHysteresisDecision
    ): AdvertisingDowngradeScheduleResult {
        val deadlineMs =
            decision.downgradeAtMs
                ?: return AdvertisingDowngradeScheduleResult.ACCEPTED
        if (advertisingTimerSlot.hasPending()) {
            return AdvertisingDowngradeScheduleResult.ACCEPTED
        }
        val expectedGeneration = decision.generation
        lateinit var downgrade: Runnable
        downgrade = Runnable {
            handleAdvertisingDowngrade(expectedGeneration, downgrade)
        }
        if (!advertisingTimerSlot.reserve(downgrade)) {
            return AdvertisingDowngradeScheduleResult.ACCEPTED
        }
        val delayMs =
            (deadlineMs - SystemClock.elapsedRealtime()).coerceAtLeast(0L)
        val postResult = classifyAdvertisingDowngradePost(
            posted = worker.postDelayed(downgrade, delayMs),
            radioActive = radioActive,
            closed = closed.get()
        )
        if (postResult != AdvertisingDowngradeScheduleResult.ACCEPTED) {
            advertisingTimerSlot.releaseIfCurrent(downgrade)
            return postResult
        }
        return AdvertisingDowngradeScheduleResult.ACCEPTED
    }

    @Synchronized
    private fun handleAdvertisingDowngrade(
        expectedGeneration: Long,
        source: Runnable
    ) {
        advertisingTimerSlot.releaseIfCurrent(source)
        if (!radioActive || closed.get()) return
        val evaluated =
            runCatching {
                advertisingHysteresis.onDowngradeTimer(
                    expectedGeneration,
                    SystemClock.elapsedRealtime()
                )
            }.getOrElse {
                metrics.recordAdvertisementFailure()
                failRadioAndRetry()
                return
            }
        if (
            evaluated.action ==
                BluetoothAdvertisingHysteresisAction.APPLY_BALANCED
        ) {
            val advertisement = advertisementState?.current() ?: run {
                metrics.recordAdvertisementFailure()
                failRadioAndRetry()
                return
            }
            if (!startOrReplaceAdvertisement(advertisement, evaluated.mode)) return
        }
        when (scheduleAdvertisingDowngrade(evaluated)) {
            AdvertisingDowngradeScheduleResult.ACCEPTED,
            AdvertisingDowngradeScheduleResult.ABORTED -> Unit
            AdvertisingDowngradeScheduleResult.FAILED -> {
                metrics.recordAdvertisementFailure()
                failRadioAndRetry()
            }
        }
    }

    private fun cancelAdvertisingDowngrade() {
        advertisingTimerSlot.cancel()?.let(worker::removeCallbacks)
    }

    private fun scheduleAliasRotation() {
        worker.removeCallbacks(rotateAlias)
        val delayMs = BluetoothDiscoveryPolicy.nextAliasBoundaryDelayMs(
            System.currentTimeMillis()
        )
        worker.postDelayed(rotateAlias, delayMs)
    }

    private fun deriveAlias(): String? {
        val timestampSeconds = System.currentTimeMillis() / 1_000L
        val result = identityManager.deriveRotatingAlias(
            timestampSeconds = timestampSeconds,
            epochSeconds = BluetoothDiscoveryPolicy.ALIAS_EPOCH_SECONDS
        )
        return result.alias.takeIf { result.status == DeviceIdentityStatus.READY }
    }

    private fun nextBootId(previous: Int?): Int {
        var candidate: Int
        do {
            candidate = secureRandom.nextInt(255) + 1
        } while (candidate == previous)
        return candidate
    }

    private fun activateAdvertisementGeneration(): Long {
        val generation = nextAdvertisementGeneration
        nextAdvertisementGeneration =
            if (nextAdvertisementGeneration == Long.MAX_VALUE) {
                1L
            } else {
                nextAdvertisementGeneration + 1L
            }
        radioStartupGate.activateAdvertisement(generation)
        return generation
    }

    private fun invalidateAdvertisementGeneration(generation: Long? = null) {
        if (generation == null) radioStartupGate.reset()
        else radioStartupGate.invalidateAdvertisement(generation)
    }

    private fun applyNotReady(nextReadiness: BluetoothDiscoveryReadiness) {
        readiness = nextReadiness
        stopRadio()
        emitRuntimeEvent(BluetoothDiscoveryLifecycle.NOT_READY)
    }

    private fun failRadioAndRetry() {
        stopRadio()
        emitRuntimeEvent(BluetoothDiscoveryLifecycle.BACKOFF)
        if (!closed.get()) worker.postDelayed(retryRefresh, RETRY_DELAY_MS)
    }

    @Synchronized
    private fun stopRadio() {
        worker.removeCallbacks(advanceScanSchedule)
        worker.removeCallbacks(checkPeerExpiry)
        worker.removeCallbacks(rotateAlias)
        worker.removeCallbacks(refreshAdvertisementHealth)
        worker.removeCallbacks(retryGattCandidates)
        cancelAdvertisingDowngrade()
        advertisingHysteresis.stop()
        stopScanWindow()
        invalidateAdvertisementGeneration()
        pendingAdvertisementGeneration = null
        advertiser.stop()
        directory.clear()
        scanScheduler = null
        scanProfile = BluetoothScanProfile.FAILOVER
        nextDirectoryPruneAtMs = 0L
        scanWindowStartedAtMs = null
        scanWindowEndsAtMs = null
        advertisementState = null
        pendingGattCandidates.clear()
        lastPeerAuthReady = false
        radioActive = false
        setConnectedDeviceEligible(false)
    }

    @Synchronized
    private fun setConnectedDeviceEligible(eligible: Boolean): Boolean {
        if (eligible && closed.get()) return false
        if (connectedDeviceEligible == eligible) return true
        if (!eligible) {
            runCatching { onConnectedDeviceEligibilityChanged(false) }
            connectedDeviceEligible = false
            return true
        }
        val accepted =
            runCatching { onConnectedDeviceEligibilityChanged(true) }
                .getOrDefault(false)
        if (accepted) connectedDeviceEligible = true
        return accepted
    }

    private fun emitRuntimeEvent(lifecycle: BluetoothDiscoveryLifecycle) {
        runCatching {
            onRuntimeEvent(
                BluetoothDiscoveryRuntimeEvent(
                    lifecycle = lifecycle,
                    readiness = readiness
                )
            )
        }
    }

    companion object {
        private const val RETRY_DELAY_MS = 10_000L
        private const val CLOSE_TIMEOUT_MS = 5_000L
    }

    private data class PendingScanResult(
        val generation: Long,
        val device: BluetoothDevice,
        val payload: ByteArray,
        val rssi: Int
    )
}

internal object BluetoothDiscoveryClosePolicy {
    fun requiresSynchronousFallback(
        posted: Boolean,
        completedInTime: Boolean
    ): Boolean = !posted || !completedInTime
}

internal class BluetoothDiscoveryCleanupGate {
    private val started = AtomicBoolean(false)
    private val completed = CountDownLatch(1)

    fun runOnce(cleanup: () -> Unit): Boolean {
        if (!started.compareAndSet(false, true)) return false
        try {
            cleanup()
        } finally {
            completed.countDown()
        }
        return true
    }

    fun await(timeoutMs: Long): Boolean {
        require(timeoutMs >= 0L)
        return try {
            completed.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
    }

    fun awaitCompletionUninterruptibly() {
        var interrupted = false
        while (true) {
            try {
                completed.await()
                break
            } catch (_: InterruptedException) {
                interrupted = true
            }
        }
        if (interrupted) Thread.currentThread().interrupt()
    }
}
