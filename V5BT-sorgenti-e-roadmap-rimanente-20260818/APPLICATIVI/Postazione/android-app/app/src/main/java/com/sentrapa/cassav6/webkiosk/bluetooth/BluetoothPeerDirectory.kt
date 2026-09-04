package com.sentrapa.cassav6.webkiosk.bluetooth

data class BluetoothPeerStreamKey(
    val rotatingAlias: String,
    val bootId: Int
)

enum class BluetoothPeerFreshness {
    FRESH,
    AGING,
    EXPIRED
}

data class BluetoothPeerRecord(
    val key: BluetoothPeerStreamKey,
    val advertisement: BluetoothAdvertisementV1,
    val rssi: Int,
    val firstSeenMs: Long,
    val lastSeenMs: Long,
    val generation: Long
) {
    fun freshness(nowMs: Long): BluetoothPeerFreshness {
        require(nowMs >= lastSeenMs) {
            "monotonic clock must not move backwards"
        }
        val ageMs = nowMs - lastSeenMs
        return when {
            ageMs < BluetoothDiscoveryPolicy.FRESH_PEER_MS ->
                BluetoothPeerFreshness.FRESH
            ageMs <= BluetoothDiscoveryPolicy.PEER_EXPIRY_MS ->
                BluetoothPeerFreshness.AGING
            else ->
                BluetoothPeerFreshness.EXPIRED
        }
    }
}

enum class BluetoothPeerObservationResult {
    ADDED,
    CAPACITY_EVICTED_ADDED,
    UPDATED,
    DUPLICATE_REFRESHED,
    BELOW_RSSI_FLOOR,
    OLDER_REJECTED,
    AMBIGUOUS_REJECTED,
    CONFLICT_REJECTED,
    DIRECTORY_FULL,
    NEW_STREAM_ATTEMPT_RATE_REJECTED,
    CLOCK_REGRESSION
}

data class BluetoothPeerDirectoryMetrics(
    val added: Long,
    val updated: Long,
    val duplicateRefreshes: Long,
    val belowRssiFloor: Long,
    val olderRejected: Long,
    val ambiguousRejected: Long,
    val conflicts: Long,
    val directoryFull: Long,
    val newStreamAttemptRateRejected: Long,
    val capacityEvicted: Long,
    val clockRegressions: Long,
    val expired: Long,
    val prunePasses: Long,
    val newStreamAttempts: Long,
    val newStreamsAccepted: Long,
    val newStreamAttemptWindowsStarted: Long,
    val capacityHighWatermark: Int
) {
    companion object {
        val EMPTY = BluetoothPeerDirectoryMetrics(
            added = 0L,
            updated = 0L,
            duplicateRefreshes = 0L,
            belowRssiFloor = 0L,
            olderRejected = 0L,
            ambiguousRejected = 0L,
            conflicts = 0L,
            directoryFull = 0L,
            newStreamAttemptRateRejected = 0L,
            capacityEvicted = 0L,
            clockRegressions = 0L,
            expired = 0L,
            prunePasses = 0L,
            newStreamAttempts = 0L,
            newStreamsAccepted = 0L,
            newStreamAttemptWindowsStarted = 0L,
            capacityHighWatermark = 0
        )
    }
}

data class BluetoothPeerObservation(
    val result: BluetoothPeerObservationResult,
    val record: BluetoothPeerRecord? = null
)

class BluetoothPeerDirectory(
    private val rssiFloorDbm: Int = BluetoothDiscoveryPolicy.RSSI_FLOOR_DBM,
    private val maximumStreams: Int = BluetoothDiscoveryPolicy.MAX_PEER_STREAMS,
    private val pruneIntervalMs: Long = BluetoothDiscoveryPolicy.PEER_PRUNE_INTERVAL_MS,
    private val newStreamAttemptWindowMs: Long =
        BluetoothDiscoveryPolicy.NEW_STREAM_ATTEMPT_WINDOW_MS,
    private val maximumNewStreamAttemptsPerWindow: Int =
        BluetoothDiscoveryPolicy.MAX_NEW_STREAM_ATTEMPTS_PER_WINDOW,
    private val replacementRssiMarginDb: Int =
        BluetoothDiscoveryPolicy.CAPACITY_REPLACEMENT_RSSI_MARGIN_DB
) {
    private val peers = linkedMapOf<BluetoothPeerStreamKey, BluetoothPeerRecord>()
    private var lastClockMs: Long? = null
    private var nextPruneAtMs: Long? = null
    private var newStreamAttemptWindowStartedAtMs: Long? = null
    private var newStreamAttemptsInWindow = 0
    private var nextGeneration = 1L
    private var added = 0L
    private var updated = 0L
    private var duplicateRefreshes = 0L
    private var belowRssiFloor = 0L
    private var olderRejected = 0L
    private var ambiguousRejected = 0L
    private var conflicts = 0L
    private var directoryFull = 0L
    private var newStreamAttemptRateRejected = 0L
    private var capacityEvicted = 0L
    private var clockRegressions = 0L
    private var expired = 0L
    private var prunePasses = 0L
    private var newStreamAttempts = 0L
    private var newStreamsAccepted = 0L
    private var newStreamAttemptWindowsStarted = 0L
    private var capacityHighWatermark = 0

    init {
        require(rssiFloorDbm in -127..0)
        require(maximumStreams in 1..BluetoothDiscoveryPolicy.MAX_PEER_STREAMS)
        require(pruneIntervalMs in 1..BluetoothDiscoveryPolicy.PEER_EXPIRY_MS)
        require(newStreamAttemptWindowMs in 1..60_000L)
        require(
            maximumNewStreamAttemptsPerWindow in
                maximumStreams..(BluetoothDiscoveryPolicy.MAX_PEER_STREAMS * 16)
        )
        require(replacementRssiMarginDb in 0..100)
    }

    @Synchronized
    fun observe(
        advertisementValue: BluetoothAdvertisementV1,
        rssi: Int,
        observedAtMs: Long
    ): BluetoothPeerObservation {
        if (!acceptClock(observedAtMs)) {
            clockRegressions += 1
            return BluetoothPeerObservation(BluetoothPeerObservationResult.CLOCK_REGRESSION)
        }
        if (rssi < rssiFloorDbm) {
            belowRssiFloor += 1
            return BluetoothPeerObservation(BluetoothPeerObservationResult.BELOW_RSSI_FLOOR)
        }

        val advertisement = BluetoothAdvertisementCodecV1.validate(advertisementValue)
        val key = BluetoothPeerStreamKey(
            rotatingAlias = advertisement.rotatingAlias,
            bootId = advertisement.bootId
        )
        maybePruneExpired(observedAtMs)
        var current = peers[key]
        if (
            current != null &&
            current.freshness(observedAtMs) == BluetoothPeerFreshness.EXPIRED
        ) {
            peers.remove(key)
            expired += 1
            current = null
        }
        if (current == null) {
            if (!acceptNewStreamAttempt(observedAtMs)) {
                newStreamAttemptRateRejected += 1
                return BluetoothPeerObservation(
                    BluetoothPeerObservationResult.NEW_STREAM_ATTEMPT_RATE_REJECTED
                )
            }
            var evicted = false
            if (peers.size >= maximumStreams) {
                val oldest = oldestPeer()
                if (
                    oldest != null &&
                    oldest.freshness(observedAtMs) == BluetoothPeerFreshness.EXPIRED
                ) {
                    peers.remove(oldest.key)
                    expired += 1
                }
                if (peers.size >= maximumStreams) {
                    val candidate = selectReplacementCandidate(observedAtMs, rssi)
                    if (candidate == null) {
                        directoryFull += 1
                        return BluetoothPeerObservation(
                            BluetoothPeerObservationResult.DIRECTORY_FULL
                        )
                    }
                    peers.remove(candidate.key)
                    capacityEvicted += 1
                    evicted = true
                }
            }
            val record = BluetoothPeerRecord(
                key = key,
                advertisement = advertisement,
                rssi = rssi,
                firstSeenMs = observedAtMs,
                lastSeenMs = observedAtMs,
                generation = nextGeneration++
            )
            peers[key] = record
            added += 1
            newStreamsAccepted += 1
            capacityHighWatermark = maxOf(capacityHighWatermark, peers.size)
            return BluetoothPeerObservation(
                if (evicted) {
                    BluetoothPeerObservationResult.CAPACITY_EVICTED_ADDED
                } else {
                    BluetoothPeerObservationResult.ADDED
                },
                record
            )
        }

        return when (
            BluetoothAdvertisementCodecV1.compareSequence(advertisement, current.advertisement)
        ) {
            AdvertisementSequenceRelation.DUPLICATE -> {
                if (advertisement != current.advertisement) {
                    conflicts += 1
                    BluetoothPeerObservation(BluetoothPeerObservationResult.CONFLICT_REJECTED)
                } else {
                    val refreshed = current.copy(rssi = rssi, lastSeenMs = observedAtMs)
                    peers[key] = refreshed
                    duplicateRefreshes += 1
                    BluetoothPeerObservation(
                        BluetoothPeerObservationResult.DUPLICATE_REFRESHED,
                        refreshed
                    )
                }
            }
            AdvertisementSequenceRelation.NEWER -> {
                val replacement = current.copy(
                    advertisement = advertisement,
                    rssi = rssi,
                    lastSeenMs = observedAtMs,
                    generation = nextGeneration++
                )
                peers[key] = replacement
                updated += 1
                BluetoothPeerObservation(BluetoothPeerObservationResult.UPDATED, replacement)
            }
            AdvertisementSequenceRelation.OLDER -> {
                olderRejected += 1
                BluetoothPeerObservation(BluetoothPeerObservationResult.OLDER_REJECTED)
            }
            AdvertisementSequenceRelation.AMBIGUOUS -> {
                ambiguousRejected += 1
                BluetoothPeerObservation(BluetoothPeerObservationResult.AMBIGUOUS_REJECTED)
            }
            AdvertisementSequenceRelation.INCOMPARABLE -> {
                conflicts += 1
                BluetoothPeerObservation(BluetoothPeerObservationResult.CONFLICT_REJECTED)
            }
        }
    }

    @Synchronized
    fun snapshot(nowMs: Long): List<BluetoothPeerRecord> {
        if (!acceptClock(nowMs)) {
            clockRegressions += 1
            return emptyList()
        }
        return peers.values
            .filter { it.freshness(nowMs) != BluetoothPeerFreshness.EXPIRED }
            .sortedWith(
                compareByDescending<BluetoothPeerRecord> { it.lastSeenMs }
                    .thenBy { it.key.rotatingAlias }
                    .thenBy { it.key.bootId }
            )
    }

    @Synchronized
    fun pruneExpired(nowMs: Long): Int {
        if (!acceptClock(nowMs)) {
            clockRegressions += 1
            return 0
        }
        return pruneExpiredInternal(nowMs).also {
            nextPruneAtMs = nowMs + pruneIntervalMs
        }
    }

    @Synchronized
    fun clear() {
        peers.clear()
        lastClockMs = null
        nextPruneAtMs = null
        newStreamAttemptWindowStartedAtMs = null
        newStreamAttemptsInWindow = 0
    }

    @Synchronized
    fun metrics(): BluetoothPeerDirectoryMetrics =
        BluetoothPeerDirectoryMetrics(
            added = added,
            updated = updated,
            duplicateRefreshes = duplicateRefreshes,
            belowRssiFloor = belowRssiFloor,
            olderRejected = olderRejected,
            ambiguousRejected = ambiguousRejected,
            conflicts = conflicts,
            directoryFull = directoryFull,
            newStreamAttemptRateRejected = newStreamAttemptRateRejected,
            capacityEvicted = capacityEvicted,
            clockRegressions = clockRegressions,
            expired = expired,
            prunePasses = prunePasses,
            newStreamAttempts = newStreamAttempts,
            newStreamsAccepted = newStreamsAccepted,
            newStreamAttemptWindowsStarted = newStreamAttemptWindowsStarted,
            capacityHighWatermark = capacityHighWatermark
        )

    @Synchronized
    fun activePeerCount(nowMs: Long): Int {
        require(nowMs >= 0L)
        return peers.values.count { peer ->
            nowMs >= peer.lastSeenMs &&
                nowMs - peer.lastSeenMs <= BluetoothDiscoveryPolicy.PEER_EXPIRY_MS
        }
    }

    private fun acceptClock(nowMs: Long): Boolean {
        if (nowMs < 0L) return false
        val previous = lastClockMs
        if (previous != null && nowMs < previous) return false
        lastClockMs = nowMs
        return true
    }

    private fun pruneExpiredInternal(nowMs: Long): Int {
        prunePasses += 1
        val keys = peers.values
            .filter { it.freshness(nowMs) == BluetoothPeerFreshness.EXPIRED }
            .map { it.key }
        keys.forEach(peers::remove)
        expired += keys.size
        return keys.size
    }

    private fun maybePruneExpired(nowMs: Long) {
        val next = nextPruneAtMs
        if (next != null && nowMs < next) return
        pruneExpiredInternal(nowMs)
        nextPruneAtMs = nowMs + pruneIntervalMs
    }

    private fun acceptNewStreamAttempt(nowMs: Long): Boolean {
        val windowStartedAt = newStreamAttemptWindowStartedAtMs
        if (
            windowStartedAt == null ||
            nowMs - windowStartedAt >= newStreamAttemptWindowMs
        ) {
            newStreamAttemptWindowStartedAtMs = nowMs
            newStreamAttemptsInWindow = 0
            newStreamAttemptWindowsStarted += 1
        }
        if (newStreamAttemptsInWindow >= maximumNewStreamAttemptsPerWindow) return false
        newStreamAttemptsInWindow += 1
        newStreamAttempts += 1
        return true
    }

    private fun oldestPeer(): BluetoothPeerRecord? =
        peers.values.minWithOrNull(
            compareBy<BluetoothPeerRecord> { it.lastSeenMs }
                .thenBy { it.rssi }
                .thenBy { it.key.rotatingAlias }
                .thenBy { it.key.bootId }
        )

    private fun selectReplacementCandidate(
        nowMs: Long,
        incomingRssi: Int
    ): BluetoothPeerRecord? {
        val candidate = oldestPeer() ?: return null
        val canReplace =
            candidate.freshness(nowMs) == BluetoothPeerFreshness.AGING ||
                incomingRssi >= candidate.rssi + replacementRssiMarginDb
        return candidate.takeIf { canReplace }
    }
}
