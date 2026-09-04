package com.sentrapa.cassav6.webkiosk.bluetooth

enum class BluetoothScanProfile {
    STABLE,
    FAILOVER
}

enum class BluetoothAdvertiseMode {
    BALANCED,
    LOW_LATENCY
}

enum class BluetoothDiscoveryPlatformProfile(
    val minimumAndroidApi: Int,
    val formalGateEligible: Boolean
) {
    CERTIFIED(
        minimumAndroidApi = BluetoothDiscoveryPolicy.MIN_ANDROID_API,
        formalGateEligible = true
    ),
    API31_COMPAT_NON_GATE(
        minimumAndroidApi = 31,
        formalGateEligible = false
    );

    companion object {
        fun fromBuildConfiguration(
            api31CompatNonGateBuild: Boolean,
            configuredMinimumAndroidApi: Int
        ): BluetoothDiscoveryPlatformProfile {
            val profile =
                if (api31CompatNonGateBuild) API31_COMPAT_NON_GATE else CERTIFIED
            require(configuredMinimumAndroidApi == profile.minimumAndroidApi) {
                "Bluetooth discovery platform profile mismatch"
            }
            return profile
        }
    }
}

data class BluetoothScanWindow(
    val windowMs: Long,
    val periodMs: Long
) {
    init {
        require(windowMs > 0L)
        require(periodMs > windowMs)
    }

    val idleMs: Long
        get() = periodMs - windowMs
}

object BluetoothDiscoveryPolicy {
    // Formal CASSA_V6 gates remain pinned to API 33. Compatibility is a separate non-gate profile.
    const val MIN_ANDROID_API = 33
    const val STABLE_SCAN_WINDOW_MS = 3_000L
    const val STABLE_SCAN_PERIOD_MS = 30_000L
    const val FAILOVER_SCAN_WINDOW_MS = 8_000L
    const val FAILOVER_SCAN_PERIOD_MS = 10_000L
    const val RSSI_FLOOR_DBM = -88
    const val FRESH_PEER_MS = 5_000L
    const val PEER_EXPIRY_MS = 15_000L
    const val ALIAS_EPOCH_SECONDS = 60L
    const val ADVERTISEMENT_UPDATE_MIN_INTERVAL_MS = 1_000L
    const val ADVERTISEMENT_HEALTH_REFRESH_MS = 500L
    const val RECIPROCAL_DISCOVERY_ADVERTISE_GRACE_MS = 8_000L
    const val MAX_PEER_STREAMS = 1_024
    const val PEER_PRUNE_INTERVAL_MS = 1_000L
    const val NEW_STREAM_ATTEMPT_WINDOW_MS = 10_000L
    const val MAX_NEW_STREAM_ATTEMPTS_PER_WINDOW = 2_048
    const val CAPACITY_REPLACEMENT_RSSI_MARGIN_DB = 6
    const val MAX_PENDING_SCAN_RESULTS = 256
    const val SCAN_INGRESS_BATCH_SIZE = 32
    const val B2_ADVERTISEMENT_CONNECTABLE = false

    fun isAdvertisementConnectable(gattServerActive: Boolean): Boolean =
        gattServerActive || B2_ADVERTISEMENT_CONNECTABLE

    fun scanWindow(profile: BluetoothScanProfile): BluetoothScanWindow =
        when (profile) {
            BluetoothScanProfile.STABLE ->
                BluetoothScanWindow(STABLE_SCAN_WINDOW_MS, STABLE_SCAN_PERIOD_MS)
            BluetoothScanProfile.FAILOVER ->
                BluetoothScanWindow(FAILOVER_SCAN_WINDOW_MS, FAILOVER_SCAN_PERIOD_MS)
        }

    fun scanProfileForPeerPresence(hasActivePeers: Boolean): BluetoothScanProfile =
        if (hasActivePeers) BluetoothScanProfile.STABLE else BluetoothScanProfile.FAILOVER

    fun advertiseMode(profile: BluetoothScanProfile): BluetoothAdvertiseMode =
        when (profile) {
            BluetoothScanProfile.STABLE -> BluetoothAdvertiseMode.BALANCED
            BluetoothScanProfile.FAILOVER -> BluetoothAdvertiseMode.LOW_LATENCY
        }

    fun nextPeerExpiryDelayMs(nowMs: Long, activePeerLastSeenMs: Collection<Long>): Long? {
        require(nowMs >= 0L)
        return activePeerLastSeenMs
            .asSequence()
            .onEach { lastSeenMs ->
                require(lastSeenMs in 0L..nowMs)
            }
            .map { lastSeenMs ->
                lastSeenMs + PEER_EXPIRY_MS + 1L
            }
            .filter { expiryAtMs ->
                expiryAtMs > nowMs
            }
            .minOrNull()
            ?.minus(nowMs)
    }

    fun nextAliasBoundaryDelayMs(nowEpochMs: Long): Long {
        require(nowEpochMs >= 0L)
        val epochMs = ALIAS_EPOCH_SECONDS * 1_000L
        return epochMs - (nowEpochMs % epochMs)
    }
}

internal interface BluetoothDiscoveryIdentityPortV1 {
    fun inspectExisting(): Boolean

    fun provision(): Boolean
}

internal class BluetoothDiscoveryIdentityReadinessV1(
    private val port: BluetoothDiscoveryIdentityPortV1
) {
    fun isReady(androidPeerAuthEnabled: Boolean): Boolean =
        if (androidPeerAuthEnabled) port.inspectExisting() else port.provision()
}

internal object BluetoothGattCandidateRetryPolicyV1 {
    const val REJECTED_RETRY_MS = 5_000L
    const val ACCEPTED_RECHECK_MS = 30_000L

    fun nextAttemptAt(nowElapsedMs: Long, accepted: Boolean): Long {
        require(nowElapsedMs >= 0L)
        val delay = if (accepted) ACCEPTED_RECHECK_MS else REJECTED_RETRY_MS
        require(nowElapsedMs <= Long.MAX_VALUE - delay)
        return nowElapsedMs + delay
    }
}

class BluetoothAdvertisementState(
    private val nextBootId: (Int?) -> Int
) {
    private var value: BluetoothAdvertisementV1? = null

    fun start(
        nodeKind: BluetoothAdvertisementNodeKind,
        rotatingAlias: String,
        capabilities: Int,
        serverReachable: Boolean = false
    ): BluetoothAdvertisementV1 {
        require(value == null) {
            "advertisement lifecycle has already been started"
        }
        val bootId = checkedBootId(nextBootId(null))
        return BluetoothAdvertisementV1(
            protocolVersion = BluetoothAdvertisementCodecV1.PROTOCOL_VERSION,
            nodeKind = nodeKind,
            rotatingAlias = rotatingAlias,
            bootId = bootId,
            capabilities = capabilities,
            serverReachable = serverReachable,
            sequence = 0
        ).let(BluetoothAdvertisementCodecV1::validate).also { value = it }
    }

    fun update(
        rotatingAlias: String,
        capabilities: Int,
        serverReachable: Boolean? = null
    ): BluetoothAdvertisementV1 {
        val current = requireNotNull(value) {
            "advertisement state has not been started"
        }
        val nextServerReachable = serverReachable ?: current.serverReachable
        if (
            current.rotatingAlias.equals(rotatingAlias, ignoreCase = true) &&
            current.capabilities == capabilities &&
            current.serverReachable == nextServerReachable
        ) {
            return current
        }
        val next = current.copy(
            rotatingAlias = rotatingAlias,
            capabilities = capabilities,
            serverReachable = nextServerReachable,
            sequence = (current.sequence + 1) and 0xff
        )
        return BluetoothAdvertisementCodecV1.validate(next).also { value = it }
    }

    fun current(): BluetoothAdvertisementV1? = value

    private fun checkedBootId(candidate: Int): Int {
        require(candidate in 1..255) {
            "bootId generator must return a value between 1 and 255"
        }
        return candidate
    }
}
