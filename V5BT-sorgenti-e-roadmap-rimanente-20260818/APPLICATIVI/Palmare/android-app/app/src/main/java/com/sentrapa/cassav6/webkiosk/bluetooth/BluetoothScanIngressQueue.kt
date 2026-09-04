package com.sentrapa.cassav6.webkiosk.bluetooth

data class BluetoothScanIngressOffer(
    val accepted: Boolean,
    val shouldScheduleDrain: Boolean,
    val droppedCount: Int
)

data class BluetoothScanIngressBatch<T>(
    val values: List<T>,
    val hasMore: Boolean
)

class BluetoothScanIngressQueue<T>(
    private val maximumPending: Int
) {
    private val queue = ArrayDeque<T>()
    private var nextGeneration = 1L
    private var activeGeneration: Long? = null
    private var drainScheduled = false

    init {
        require(maximumPending > 0)
    }

    @Synchronized
    fun openGeneration(): Long {
        check(activeGeneration == null) {
            "a scan generation is already active"
        }
        val generation = nextGeneration
        nextGeneration =
            if (nextGeneration == Long.MAX_VALUE) 1L else nextGeneration + 1L
        activeGeneration = generation
        return generation
    }

    @Synchronized
    fun offer(generation: Long, value: T): BluetoothScanIngressOffer {
        if (activeGeneration != generation) {
            return BluetoothScanIngressOffer(
                accepted = false,
                shouldScheduleDrain = false,
                droppedCount = 1
            )
        }
        val droppedCount =
            if (queue.size == maximumPending) {
                queue.removeFirst()
                1
            } else {
                0
            }
        queue.addLast(value)
        val shouldScheduleDrain = !drainScheduled
        if (shouldScheduleDrain) drainScheduled = true
        return BluetoothScanIngressOffer(
            accepted = true,
            shouldScheduleDrain = shouldScheduleDrain,
            droppedCount = droppedCount
        )
    }

    @Synchronized
    fun takeBatch(maximumBatchSize: Int): BluetoothScanIngressBatch<T> {
        require(maximumBatchSize > 0)
        val count = minOf(maximumBatchSize, queue.size)
        val values = ArrayList<T>(count)
        repeat(count) {
            values += queue.removeFirst()
        }
        val hasMore = queue.isNotEmpty()
        if (!hasMore) drainScheduled = false
        return BluetoothScanIngressBatch(values, hasMore)
    }

    @Synchronized
    fun invalidateGeneration(generation: Long): Int {
        if (activeGeneration != generation) return 0
        activeGeneration = null
        drainScheduled = false
        val droppedCount = queue.size
        queue.clear()
        return droppedCount
    }

    @Synchronized
    fun cancelScheduledDrain(): Int {
        drainScheduled = false
        val droppedCount = queue.size
        queue.clear()
        return droppedCount
    }

    @Synchronized
    fun pendingCount(): Int = queue.size

    @Synchronized
    fun isGenerationActive(generation: Long): Boolean =
        activeGeneration == generation
}
