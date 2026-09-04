package com.sentrapa.cassav6.webkiosk.bluetooth

import android.content.Context
import android.os.SystemClock
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.LinkedHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString

internal data class AndroidPeerTrustRuntimeConfigV2(
    val enabled: Boolean,
    val directoryUrl: String,
    val tlsSpkiSha256: String,
    val authoritySpkiDerBase64: String
)

internal data class ValidatedAndroidPeerTrustRuntimeConfigV2(
    val authoritySpkiDer: ByteArray
) : AutoCloseable {
    override fun close() {
        authoritySpkiDer.fill(0)
    }
}

internal object AndroidPeerTrustRuntimeConfigValidatorV2 {
    fun validate(
        config: AndroidPeerTrustRuntimeConfigV2
    ): Result<ValidatedAndroidPeerTrustRuntimeConfigV2> = runCatching {
        require(config.enabled)
        val transport = AndroidPeerTrustClientConfigValidatorV1.validate(
            AndroidPeerTrustClientConfigV1(
                enabled = true,
                url = config.directoryUrl,
                tlsSpkiSha256 = config.tlsSpkiSha256
            )
        ).getOrThrow()
        try {
            val authority = requireNotNull(config.authoritySpkiDerBase64.decodeBase64())
                .toByteArray()
            try {
                require(
                    authority.toByteString().base64() ==
                        config.authoritySpkiDerBase64
                )
                require(P256SpkiV2.isCanonicalP256Spki(authority))
                val authorityPin = MessageDigest.getInstance("SHA-256").digest(authority)
                try {
                    require(!MessageDigest.isEqual(authorityPin, transport.tlsPin)) {
                        "peer trust authority and TLS endpoint must use distinct keys"
                    }
                } finally {
                    authorityPin.fill(0)
                }
                ValidatedAndroidPeerTrustRuntimeConfigV2(authority.copyOf())
            } finally {
                authority.fill(0)
            }
        } finally {
            transport.tlsPin.fill(0)
        }
    }
}

internal class AndroidPeerAuthObservationRegistryV2(
    private val maximumAgeMs: Long = MAXIMUM_AGE_MS,
    private val maximumEntries: Int = MAXIMUM_ENTRIES
) {
    private data class Key(val epoch: Long, val alias: String)
    private data class Observation(
        val advertisement: BluetoothAdvertisementV1,
        val observedAtEpochMs: Long
    )

    private val observations = LinkedHashMap<Key, Observation>()

    init {
        require(maximumAgeMs in 1_000L..300_000L)
        require(maximumEntries in 1..256)
    }

    @Synchronized
    fun record(
        advertisement: BluetoothAdvertisementV1,
        aliasEpoch: Long,
        nowEpochMs: Long
    ) {
        require(aliasEpoch >= 0L && nowEpochMs >= 0L)
        val remote = BluetoothAdvertisementCodecV1.validate(advertisement)
        require(remote.nodeKind != BluetoothAdvertisementNodeKind.RASPBERRY)
        val key = Key(aliasEpoch, remote.rotatingAlias)
        observations.remove(key)
        observations[key] = Observation(remote, nowEpochMs)
        prune(nowEpochMs)
        while (observations.size > maximumEntries) {
            observations.remove(observations.keys.first())
        }
    }

    @Synchronized
    fun resolveRemote(
        remoteHello: BluetoothHelloV1,
        aliasEpoch: Long,
        nowEpochMs: Long,
        cache: AndroidPeerTrustCacheV1
    ): BluetoothAdvertisementV1? {
        require(aliasEpoch >= 0L && nowEpochMs >= 0L)
        val hello = BluetoothHelloCodecV1.validate(remoteHello)
        prune(nowEpochMs)
        return observations.entries.asSequence()
            .filter { (key, observation) ->
                key.epoch == aliasEpoch &&
                    observation.advertisement.bootId == hello.bootId &&
                    observation.advertisement.capabilities == hello.capabilities
            }
            .mapNotNull { (key, observation) ->
                cache.resolveActivePeerByAlias(
                    hello.nodeId,
                    key.alias,
                    key.epoch,
                    nowEpochMs
                )?.let { observation.advertisement }
            }
            .distinctBy(BluetoothAdvertisementV1::rotatingAlias)
            .toList()
            .singleOrNull()
    }

    @Synchronized
    fun clear() {
        observations.clear()
    }

    private fun prune(nowEpochMs: Long) {
        observations.entries.removeAll { (_, observation) ->
            nowEpochMs < observation.observedAtEpochMs ||
                nowEpochMs - observation.observedAtEpochMs > maximumAgeMs
        }
    }

    companion object {
        private const val MAXIMUM_AGE_MS = 120_000L
        private const val MAXIMUM_ENTRIES = 64
    }
}

internal data class AndroidPeerTrustRuntimeTimeV2(
    val epochMs: Long,
    val elapsedRealtimeMs: Long
)

internal class AndroidPeerTrustRuntimeClockV2 {
    private var epochHighWatermarkMs = 0L
    private var elapsedHighWatermarkMs = 0L
    private var failed = false

    @Synchronized
    fun claim(epochMs: Long, elapsedRealtimeMs: Long): Boolean {
        if (
            failed ||
            epochMs < 0L ||
            elapsedRealtimeMs < 0L ||
            epochMs < epochHighWatermarkMs ||
            elapsedRealtimeMs < elapsedHighWatermarkMs
        ) {
            failed = true
            return false
        }
        epochHighWatermarkMs = epochMs
        elapsedHighWatermarkMs = elapsedRealtimeMs
        return true
    }
}

internal fun interface AndroidPeerTrustRefreshJitterSourceV2 {
    fun nextJitterMs(maximumInclusiveMs: Int): Int
}

internal object AndroidSecurePeerTrustRefreshJitterSourceV2 :
    AndroidPeerTrustRefreshJitterSourceV2 {
    private val random = SecureRandom()

    override fun nextJitterMs(maximumInclusiveMs: Int): Int {
        require(maximumInclusiveMs >= 0)
        return random.nextInt(maximumInclusiveMs + 1)
    }
}

internal class AndroidPeerTrustRefreshBackoffV2(
    private val jitterSource: AndroidPeerTrustRefreshJitterSourceV2 =
        AndroidSecurePeerTrustRefreshJitterSourceV2
) {
    private var failures = 0

    @Synchronized
    fun nextDelayMs(success: Boolean): Long {
        failures = if (success) 0 else minOf(failures + 1, 4)
        val base = if (success) {
            SUCCESS_INTERVAL_MS
        } else {
            minOf(FAILURE_INITIAL_MS shl (failures - 1), FAILURE_MAXIMUM_MS)
        }
        val jitter = jitterSource.nextJitterMs(JITTER_MAXIMUM_MS.toInt())
        require(jitter in 0..JITTER_MAXIMUM_MS.toInt()) {
            "peer trust refresh jitter is outside its public bound"
        }
        return minOf(base + jitter, MAXIMUM_DELAY_MS)
    }

    companion object {
        const val SUCCESS_INTERVAL_MS = 25_000L
        const val FAILURE_INITIAL_MS = 5_000L
        const val FAILURE_MAXIMUM_MS = 30_000L
        const val JITTER_MAXIMUM_MS = 2_000L
        const val MAXIMUM_DELAY_MS = 30_000L
    }
}

internal fun interface AndroidPeerTrustScheduledRefreshCancellationV2 {
    fun cancel()
}

internal interface AndroidPeerTrustRefreshSchedulerV2 : AutoCloseable {
    fun schedule(
        delayMs: Long,
        action: () -> Unit
    ): AndroidPeerTrustScheduledRefreshCancellationV2?
}

internal class AndroidExecutorPeerTrustRefreshSchedulerV2 :
    AndroidPeerTrustRefreshSchedulerV2 {
    private val executor = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "CASSA_V6-PeerTrustRefresh").apply { isDaemon = true }
    }

    override fun schedule(
        delayMs: Long,
        action: () -> Unit
    ): AndroidPeerTrustScheduledRefreshCancellationV2? {
        require(delayMs >= 0L)
        return try {
            val future = executor.schedule(action, delayMs, TimeUnit.MILLISECONDS)
            AndroidPeerTrustScheduledRefreshCancellationV2 {
                future.cancel(false)
            }
        } catch (_: RejectedExecutionException) {
            null
        }
    }

    override fun close() {
        executor.shutdownNow()
    }
}

internal data class AndroidPeerTrustRefreshAttemptV2(
    val attempted: Boolean,
    val refreshSucceeded: Boolean,
    val ready: Boolean,
    val nextLeaseValidationDelayMs: Long? = null
) {
    init {
        require(nextLeaseValidationDelayMs == null || nextLeaseValidationDelayMs > 0L)
        require(!refreshSucceeded || attempted)
        require(!ready || nextLeaseValidationDelayMs != null)
    }
}

internal class AndroidPeerTrustRefreshLoopV2(
    private val scheduler: AndroidPeerTrustRefreshSchedulerV2,
    private val refresh: () -> AndroidPeerTrustRefreshAttemptV2,
    private val onTrustStateChanged: (Boolean) -> Unit,
    private val backoff: AndroidPeerTrustRefreshBackoffV2 =
        AndroidPeerTrustRefreshBackoffV2(),
    private val initialDelayMs: Long = INITIAL_DELAY_MS,
    private val retryDelayMs: Long = RETRY_DELAY_MS
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    private val inFlight = AtomicBoolean(false)
    private val manualPending = AtomicBoolean(false)
    private var periodic: AndroidPeerTrustScheduledRefreshCancellationV2? = null

    init {
        require(initialDelayMs >= 0L)
        require(retryDelayMs > 0L)
    }

    @Synchronized
    fun start(): Boolean {
        if (closed.get() || periodic != null) return false
        return schedulePeriodicLocked(initialDelayMs)
    }

    fun requestNow(onComplete: (Boolean) -> Unit = {}): Boolean {
        if (closed.get()) return false
        if (!manualPending.compareAndSet(false, true)) {
            runCatching { onComplete(false) }
            return false
        }
        val scheduled = scheduler.schedule(0L) {
            try {
                runAttempt(periodicAttempt = false, onComplete = onComplete)
            } finally {
                manualPending.set(false)
            }
        }
        if (scheduled == null) {
            manualPending.set(false)
            if (!closed.get()) runCatching { onComplete(false) }
            return false
        }
        if (closed.get()) {
            scheduled.cancel()
            manualPending.set(false)
            return false
        }
        return true
    }

    private fun runAttempt(
        periodicAttempt: Boolean,
        onComplete: (Boolean) -> Unit = {}
    ) {
        if (periodicAttempt) synchronized(this) { periodic = null }
        if (closed.get()) return
        if (!inFlight.compareAndSet(false, true)) {
            if (periodicAttempt) schedulePeriodic(retryDelayMs)
            runCatching { onComplete(false) }
            return
        }
        val result = try {
            refresh()
        } catch (_: Throwable) {
            AndroidPeerTrustRefreshAttemptV2(
                attempted = true,
                refreshSucceeded = false,
                ready = false
            )
        } finally {
            inFlight.set(false)
        }
        if (closed.get()) return
        runCatching { onTrustStateChanged(result.ready) }
        runCatching { onComplete(result.ready) }
        if (periodicAttempt) {
            val policyDelay = if (result.attempted) {
                backoff.nextDelayMs(result.refreshSucceeded)
            } else {
                retryDelayMs
            }
            val delay = if (result.ready) {
                minOf(policyDelay, checkNotNull(result.nextLeaseValidationDelayMs))
            } else {
                policyDelay
            }
            schedulePeriodic(delay)
        }
    }

    private fun schedulePeriodic(delayMs: Long): Boolean = synchronized(this) {
        schedulePeriodicLocked(delayMs)
    }

    private fun schedulePeriodicLocked(delayMs: Long): Boolean {
        if (closed.get() || periodic != null) return false
        val scheduled = scheduler.schedule(delayMs) {
            runAttempt(periodicAttempt = true)
        }
        if (scheduled == null) {
            runCatching { onTrustStateChanged(false) }
            return false
        }
        periodic = scheduled
        if (closed.get()) {
            periodic = null
            scheduled.cancel()
            return false
        }
        return true
    }

    @Synchronized
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        periodic?.cancel()
        periodic = null
        scheduler.close()
    }

    companion object {
        const val INITIAL_DELAY_MS = 1_000L
        const val RETRY_DELAY_MS = 5_000L
    }
}

internal class AndroidPeerTrustRuntimeV2 private constructor(
    context: Context,
    private val configuration: AndroidPeerTrustRuntimeConfigV2,
    authoritySpkiDer: ByteArray,
    private val nowEpochMs: () -> Long = System::currentTimeMillis,
    private val elapsedRealtimeMs: () -> Long = SystemClock::elapsedRealtime,
    private val onTrustStateChanged: (Boolean) -> Unit = {}
) : AutoCloseable {
    private val appContext = context.applicationContext
    private val closed = AtomicBoolean(false)
    private val clock = AndroidPeerTrustRuntimeClockV2()
    private val clockFailureReported = AtomicBoolean(false)
    private val identity = DeviceIdentityManager(appContext, enabled = true)
    private val cache = AndroidPeerTrustCacheV1(
        AndroidAtomicPeerTrustStoreV1(appContext),
        authoritySpkiDer
    )
    private val directoryClient = AndroidPeerTrustDirectoryClientV1(
        AndroidPeerTrustClientConfigV1(
            enabled = true,
            url = configuration.directoryUrl,
            tlsSpkiSha256 = configuration.tlsSpkiSha256
        ),
        cache,
        { claimTime()?.epochMs ?: -1L }
    )
    private val resolver = AndroidGattPeerAuthContextResolverV2(
        identity,
        cache,
        { claimTime()?.epochMs ?: -1L }
    )
    private val observations = AndroidPeerAuthObservationRegistryV2()
    private val lastRefreshAttemptElapsedMs = AtomicLong(Long.MIN_VALUE)
    private val refreshLoop = AndroidPeerTrustRefreshLoopV2(
        scheduler = AndroidExecutorPeerTrustRefreshSchedulerV2(),
        refresh = ::performRefreshAttempt,
        onTrustStateChanged = ::notifyTrustState
    )

    val clientSessionFactory = AndroidGattPeerAuthClientSessionFactoryV2 {
            sessionToken,
            mtu,
            clientHello,
            serverHello,
            clientAdvertisement,
            serverAdvertisement,
            aliasEpoch ->
        if (!isReady()) null else runCatching {
            resolver.createClientSession(
                sessionToken,
                mtu,
                clientHello,
                serverHello,
                clientAdvertisement,
                serverAdvertisement,
                aliasEpoch
            )
        }.getOrNull()
    }

    fun serverSessionFactory(
        localAdvertisementProvider: () -> BluetoothAdvertisementV1?
    ) = AndroidGattPeerAuthServerSessionFactoryV2 {
            peerToken,
            mtu,
            clientHello,
            serverHello ->
        if (!isReady()) return@AndroidGattPeerAuthServerSessionFactoryV2 null
        val now = claimTime()?.epochMs
            ?: return@AndroidGattPeerAuthServerSessionFactoryV2 null
        val epoch = RotatingAliasV1.epoch(
            now / 1_000L,
            BluetoothDiscoveryPolicy.ALIAS_EPOCH_SECONDS
        )
        val clientAdvertisement = runCatching {
            observations.resolveRemote(clientHello, epoch, now, cache)
        }.getOrNull() ?: return@AndroidGattPeerAuthServerSessionFactoryV2 null
        val serverAdvertisement = runCatching {
            localAdvertisementProvider()?.let(BluetoothAdvertisementCodecV1::validate)
        }.getOrNull() ?: return@AndroidGattPeerAuthServerSessionFactoryV2 null
        runCatching {
            resolver.createServerSession(
                peerToken,
                mtu,
                clientHello,
                serverHello,
                clientAdvertisement,
                serverAdvertisement,
                epoch
            )
        }.getOrNull()
    }

    fun isReady(): Boolean {
        if (closed.get()) return false
        val now = claimTime()?.epochMs ?: return false
        return isReadyAt(now)
    }

    private fun isReadyAt(nowEpochMs: Long): Boolean {
        val report = runCatching {
            identity.inspectExistingIdentity()
        }.getOrNull() ?: return false
        val alias = runCatching {
            identity.deriveExistingRotatingAlias(
                nowEpochMs / 1_000L,
                BluetoothDiscoveryPolicy.ALIAS_EPOCH_SECONDS
            )
        }.getOrNull() ?: return false
        if (
            alias.status != DeviceIdentityStatus.READY ||
            alias.alias == null ||
            alias.epoch == null
        ) return false
        return runCatching {
            cache.validateActiveLocalIdentity(
                report,
                alias.alias,
                alias.epoch,
                nowEpochMs
            )
        }.getOrDefault(false)
    }

    fun recordObservation(
        remoteAdvertisement: BluetoothAdvertisementV1,
        aliasEpoch: Long
    ) {
        if (closed.get()) return
        val now = claimTime()?.epochMs ?: return
        runCatching {
            observations.record(remoteAdvertisement, aliasEpoch, now)
        }
    }

    fun refreshAsync(onComplete: (Boolean) -> Unit = {}) {
        if (!closed.get()) refreshLoop.requestNow(onComplete)
    }

    private fun startPeriodicRefresh() {
        refreshLoop.start()
    }

    private fun performRefreshAttempt(): AndroidPeerTrustRefreshAttemptV2 {
        if (closed.get()) return failedRefreshAttempt()
        val time = claimTime()
            ?: return failedRefreshAttempt()
        if (!claimRefreshWindow(time.elapsedRealtimeMs)) {
            return readinessAttempt(attempted = false, refreshSucceeded = false, time)
        }
        val refreshSucceeded = try {
            directoryClient.refresh() is AndroidPeerTrustClientResultV1.Ready
        } catch (_: Throwable) {
            false
        }
        val completed = claimTime() ?: return failedRefreshAttempt(attempted = true)
        return readinessAttempt(
            attempted = true,
            refreshSucceeded = refreshSucceeded,
            time = completed
        )
    }

    private fun readinessAttempt(
        attempted: Boolean,
        refreshSucceeded: Boolean,
        time: AndroidPeerTrustRuntimeTimeV2
    ): AndroidPeerTrustRefreshAttemptV2 {
        val ready = isReadyAt(time.epochMs)
        val deadline = if (ready) {
            cache.activeDirectoryExpiryEpochMs(time.epochMs)?.minus(time.epochMs)
                ?.takeIf { it > 0L }
        } else {
            null
        }
        return if (ready && deadline == null) {
            failedRefreshAttempt(attempted)
        } else {
            AndroidPeerTrustRefreshAttemptV2(
                attempted = attempted,
                refreshSucceeded = refreshSucceeded,
                ready = ready,
                nextLeaseValidationDelayMs = deadline
            )
        }
    }

    private fun failedRefreshAttempt(
        attempted: Boolean = false
    ) = AndroidPeerTrustRefreshAttemptV2(
        attempted = attempted,
        refreshSucceeded = false,
        ready = false
    )

    private fun claimRefreshWindow(nowElapsedRealtimeMs: Long): Boolean {
        while (true) {
            val previous = lastRefreshAttemptElapsedMs.get()
            if (
                previous != Long.MIN_VALUE &&
                nowElapsedRealtimeMs - previous < MINIMUM_REFRESH_INTERVAL_MS
            ) return false
            if (
                lastRefreshAttemptElapsedMs.compareAndSet(
                    previous,
                    nowElapsedRealtimeMs
                )
            ) return true
        }
    }

    private fun claimTime(): AndroidPeerTrustRuntimeTimeV2? {
        if (closed.get()) return null
        val epoch = nowEpochMs()
        val elapsed = elapsedRealtimeMs()
        if (!clock.claim(epoch, elapsed)) {
            if (clockFailureReported.compareAndSet(false, true)) {
                notifyTrustState(false)
            }
            return null
        }
        return AndroidPeerTrustRuntimeTimeV2(epoch, elapsed)
    }

    private fun notifyTrustState(ready: Boolean) {
        if (!closed.get()) runCatching { onTrustStateChanged(ready) }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        try {
            refreshLoop.close()
        } finally {
            try {
                runCatching { directoryClient.close() }
            } finally {
                try {
                    observations.clear()
                } finally {
                    cache.close()
                }
            }
        }
    }

    companion object {
        private const val MINIMUM_REFRESH_INTERVAL_MS = 5_000L

        fun create(
            context: Context,
            configuration: AndroidPeerTrustRuntimeConfigV2,
            nowEpochMs: () -> Long = System::currentTimeMillis,
            elapsedRealtimeMs: () -> Long = SystemClock::elapsedRealtime,
            onTrustStateChanged: (Boolean) -> Unit = {}
        ): Result<AndroidPeerTrustRuntimeV2> = runCatching {
            val validated = AndroidPeerTrustRuntimeConfigValidatorV2
                .validate(configuration)
                .getOrThrow()
            validated.use {
                AndroidPeerTrustRuntimeV2(
                    context,
                    configuration,
                    it.authoritySpkiDer,
                    nowEpochMs,
                    elapsedRealtimeMs,
                    onTrustStateChanged
                ).also(AndroidPeerTrustRuntimeV2::startPeriodicRefresh)
            }
        }
    }
}
