package com.sentrapa.webkiosk.bluetooth

data class BluetoothDiscoveryMetricsSnapshot(
    val scanWindowsStarted: Long,
    val concurrentScanAdvertiseWindowsStarted: Long,
    val scanWindowsCompleted: Long,
    val scanFailures: Long,
    val rawCallbacks: Long,
    val uuidMatches: Long,
    val validPayloads: Long,
    val advertisementsStarted: Long,
    val advertisementUpdates: Long,
    val advertisementFailures: Long,
    val invalidPayloads: Long,
    val acceptedObservations: Long,
    val scanIngressDropped: Long,
    val peerExpiryCount: Long,
    val firstObservationOffsetP95Ms: Long?,
    val peerDirectory: BluetoothPeerDirectoryMetrics
)

class BluetoothDiscoveryMetrics(
    private val maximumOffsetSamples: Int = 10_000
) {
    private var scanWindowsStarted = 0L
    private var concurrentScanAdvertiseWindowsStarted = 0L
    private var scanWindowsCompleted = 0L
    private var scanFailures = 0L
    private var rawCallbacks = 0L
    private var uuidMatches = 0L
    private var validPayloads = 0L
    private var advertisementsStarted = 0L
    private var advertisementUpdates = 0L
    private var advertisementFailures = 0L
    private var invalidPayloads = 0L
    private var acceptedObservations = 0L
    private var scanIngressDropped = 0L
    private var peerExpiryCount = 0L
    private val firstObservationOffsets = ArrayDeque<Long>()

    init {
        require(maximumOffsetSamples > 0)
    }

    @Synchronized
    fun recordScanWindowStarted() {
        scanWindowsStarted += 1
    }

    @Synchronized
    fun recordConcurrentScanAdvertiseWindowStarted() {
        concurrentScanAdvertiseWindowsStarted += 1
    }

    @Synchronized
    fun recordScanWindowCompleted() {
        scanWindowsCompleted += 1
    }

    @Synchronized
    fun recordScanFailure() {
        scanFailures += 1
    }

    @Synchronized
    fun recordRawCallback() {
        rawCallbacks += 1
    }

    @Synchronized
    fun recordUuidMatch() {
        uuidMatches += 1
    }

    @Synchronized
    fun recordValidPayload() {
        validPayloads += 1
    }

    @Synchronized
    fun recordAdvertisementStarted() {
        advertisementsStarted += 1
    }

    @Synchronized
    fun recordAdvertisementUpdated() {
        advertisementUpdates += 1
    }

    @Synchronized
    fun recordAdvertisementFailure() {
        advertisementFailures += 1
    }

    @Synchronized
    fun recordInvalidPayload() {
        invalidPayloads += 1
    }

    @Synchronized
    fun recordAcceptedObservation() {
        acceptedObservations += 1
    }

    @Synchronized
    fun recordScanIngressDropped(count: Int = 1) {
        require(count >= 0)
        scanIngressDropped += count
    }

    @Synchronized
    fun recordFirstObservationOffset(offsetMs: Long) {
        require(offsetMs >= 0L)
        if (firstObservationOffsets.size == maximumOffsetSamples) {
            firstObservationOffsets.removeFirst()
        }
        firstObservationOffsets.addLast(offsetMs)
    }

    @Synchronized
    fun recordPeerExpiry(count: Int) {
        require(count >= 0)
        peerExpiryCount += count
    }

    @Synchronized
    fun snapshot(
        peerDirectory: BluetoothPeerDirectoryMetrics =
            BluetoothPeerDirectoryMetrics.EMPTY
    ): BluetoothDiscoveryMetricsSnapshot =
        BluetoothDiscoveryMetricsSnapshot(
            scanWindowsStarted = scanWindowsStarted,
            concurrentScanAdvertiseWindowsStarted =
                concurrentScanAdvertiseWindowsStarted,
            scanWindowsCompleted = scanWindowsCompleted,
            scanFailures = scanFailures,
            rawCallbacks = rawCallbacks,
            uuidMatches = uuidMatches,
            validPayloads = validPayloads,
            advertisementsStarted = advertisementsStarted,
            advertisementUpdates = advertisementUpdates,
            advertisementFailures = advertisementFailures,
            invalidPayloads = invalidPayloads,
            acceptedObservations = acceptedObservations,
            scanIngressDropped = scanIngressDropped,
            peerExpiryCount = maxOf(peerExpiryCount, peerDirectory.expired),
            firstObservationOffsetP95Ms = percentile95(firstObservationOffsets),
            peerDirectory = peerDirectory
        )

    private fun percentile95(values: Collection<Long>): Long? {
        if (values.isEmpty()) return null
        val sorted = values.sorted()
        val index = ((sorted.size * 95 + 99) / 100 - 1).coerceIn(sorted.indices)
        return sorted[index]
    }
}
