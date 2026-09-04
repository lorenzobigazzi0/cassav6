package com.sentrapa.webkiosk.bluetooth

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID

enum class AndroidGattServerAccessStatusV1 {
    SUCCESS,
    READ_NOT_PERMITTED,
    WRITE_NOT_PERMITTED,
    INSUFFICIENT_AUTHENTICATION,
    REQUEST_NOT_SUPPORTED,
    INVALID_OFFSET,
    INVALID_ATTRIBUTE_LENGTH,
    BUSY,
    FAILURE
}

class AndroidGattServerOutboundV1(
    val characteristicUuid: UUID,
    value: ByteArray,
    val confirm: Boolean
) : AutoCloseable {
    private var value: ByteArray? = value.copyOf()

    @Synchronized
    fun valueCopy(): ByteArray = checkNotNull(value) {
        "GATT server outbound payload was consumed"
    }.copyOf()

    @Synchronized
    override fun close() {
        value?.fill(0)
        value = null
    }
}

class AndroidGattServerHandlerResultV1 private constructor(
    val status: AndroidGattServerAccessStatusV1,
    value: ByteArray?,
    outbound: AndroidGattServerOutboundV1?,
    val disconnect: Boolean
) : AutoCloseable {
    private var closed = false
    private var value = value?.copyOf()
    private val outbound = outbound?.let {
        val copy = it.valueCopy()
        try {
            AndroidGattServerOutboundV1(
                it.characteristicUuid,
                copy,
                it.confirm
            )
        } finally {
            copy.fill(0)
        }
    }

    @Synchronized
    fun valueCopy(): ByteArray? {
        check(!closed) { "GATT server result was consumed" }
        return value?.copyOf()
    }

    @Synchronized
    fun outboundCopy(): AndroidGattServerOutboundV1? {
        check(!closed) { "GATT server result was consumed" }
        return outbound?.let {
            val copy = it.valueCopy()
            try {
                AndroidGattServerOutboundV1(
                    it.characteristicUuid,
                    copy,
                    it.confirm
                )
            } finally {
                copy.fill(0)
            }
        }
    }

    @Synchronized
    override fun close() {
        if (closed) return
        value?.fill(0)
        value = null
        outbound?.close()
        closed = true
    }

    companion object {
        fun success(
            value: ByteArray? = null,
            outbound: AndroidGattServerOutboundV1? = null
        ) = AndroidGattServerHandlerResultV1(
            AndroidGattServerAccessStatusV1.SUCCESS,
            value,
            outbound,
            disconnect = false
        )

        fun reject(
            status: AndroidGattServerAccessStatusV1,
            disconnect: Boolean = true
        ): AndroidGattServerHandlerResultV1 {
            require(status != AndroidGattServerAccessStatusV1.SUCCESS)
            return AndroidGattServerHandlerResultV1(
                status,
                value = null,
                outbound = null,
                disconnect = disconnect
            )
        }
    }
}

data class AndroidGattServerLocalContextV1(
    val nodeId: String,
    val advertisement: BluetoothAdvertisementV1
)

data class AndroidGattServerSessionHandlerSnapshotV1(
    val enabled: Boolean,
    val helloEnabled: Boolean,
    val sessionCount: Int,
    val secureActiveSessionCount: Int,
    val securePromotionBlockedSessionCount: Int,
    val sessionsAccepted: Long,
    val sessionsRejected: Long,
    val sessionsExpired: Long,
    val helloWritesAccepted: Long,
    val helloReadsCompleted: Long,
    val deniedRequests: Long,
    val protocolFailures: Long
)

interface AndroidGattServerSessionHandlerV1 {
    fun onConnected(peerToken: Long, nowElapsedMs: Long): AndroidGattServerHandlerResultV1

    fun onMtuChanged(
        peerToken: Long,
        mtu: Int,
        nowElapsedMs: Long
    ): AndroidGattServerHandlerResultV1

    fun onRead(
        peerToken: Long,
        characteristicUuid: UUID,
        offset: Int,
        nowElapsedMs: Long
    ): AndroidGattServerHandlerResultV1

    fun onWrite(
        peerToken: Long,
        characteristicUuid: UUID,
        offset: Int,
        preparedWrite: Boolean,
        value: ByteArray,
        nowElapsedMs: Long
    ): AndroidGattServerHandlerResultV1

    fun onSubscriptionChanged(
        peerToken: Long,
        characteristicUuid: UUID,
        enabled: Boolean,
        indicate: Boolean,
        nowElapsedMs: Long
    ): AndroidGattServerHandlerResultV1

    fun onReliableActivity(
        peerToken: Long,
        nowElapsedMs: Long
    ): AndroidGattServerHandlerResultV1

    fun onDisconnected(peerToken: Long)

    fun expire(nowElapsedMs: Long): Set<Long>

    fun reset()

    fun exportReliableContext(peerToken: Long): GattReliableChannelContextV1

    fun snapshot(): AndroidGattServerSessionHandlerSnapshotV1
}

class V5btGattServerSessionHandlerV1(
    private val enabled: Boolean,
    private val helloEnabled: Boolean,
    private val localContextProvider: () -> AndroidGattServerLocalContextV1?,
    private val randomBytes: (Int) -> ByteArray = {
        ByteArray(it).also(SecureRandom()::nextBytes)
    },
    private val androidPeerAuthEnabled: Boolean = false,
    private val androidPeerAuthReady: () -> Boolean = { androidPeerAuthEnabled },
    private val peerAuthSessionFactory: AndroidGattPeerAuthServerSessionFactoryV2? = null,
    private val maximumSessions: Int = MAXIMUM_SESSIONS,
    private val sessionIdleTimeoutMs: Long = SESSION_IDLE_TIMEOUT_MS
) : AndroidGattServerSessionHandlerV1 {
    private data class HelloResponse(
        val clientHello: BluetoothHelloV1,
        val serverHello: BluetoothHelloV1,
        val wire: ByteArray
    )

    private data class Session(
        var mtu: Int = AndroidGattProfileV1.MINIMUM_MTU,
        var lastActivityMs: Long,
        var deadlineMs: Long,
        var requestDigest: ByteArray? = null,
        var helloResponse: ByteArray? = null,
        var clientHello: BluetoothHelloV1? = null,
        var serverHello: BluetoothHelloV1? = null,
        var controlIndicationSubscribed: Boolean = false,
        var dataNotificationSubscribed: Boolean = false,
        var ackIndicationSubscribed: Boolean = false,
        var peerAuth: AndroidGattPeerAuthServerSessionV2? = null
    ) {
        fun clear() {
            requestDigest?.fill(0)
            helloResponse?.fill(0)
            requestDigest = null
            helloResponse = null
            clientHello = null
            serverHello = null
            controlIndicationSubscribed = false
            dataNotificationSubscribed = false
            ackIndicationSubscribed = false
            peerAuth?.close()
            peerAuth = null
        }
    }

    private val sessions = LinkedHashMap<Long, Session>()
    private var sessionsAccepted = 0L
    private var sessionsRejected = 0L
    private var sessionsExpired = 0L
    private var helloWritesAccepted = 0L
    private var helloReadsCompleted = 0L
    private var deniedRequests = 0L
    private var protocolFailures = 0L

    init {
        require(!helloEnabled || enabled)
        require(!androidPeerAuthEnabled || helloEnabled)
        require(!androidPeerAuthEnabled || peerAuthSessionFactory != null)
        require(maximumSessions in 1..64)
        require(sessionIdleTimeoutMs in 1_000L..60_000L)
    }

    @Synchronized
    override fun onConnected(
        peerToken: Long,
        nowElapsedMs: Long
    ): AndroidGattServerHandlerResultV1 {
        requirePeerToken(peerToken)
        requireClock(nowElapsedMs)
        expireInternal(nowElapsedMs)
        if (!enabled || sessions.containsKey(peerToken) || sessions.size >= maximumSessions) {
            sessionsRejected += 1L
            return AndroidGattServerHandlerResultV1.reject(
                AndroidGattServerAccessStatusV1.BUSY
            )
        }
        sessions[peerToken] = Session(
            lastActivityMs = nowElapsedMs,
            deadlineMs = deadline(nowElapsedMs)
        )
        sessionsAccepted += 1L
        return AndroidGattServerHandlerResultV1.success()
    }

    @Synchronized
    override fun onMtuChanged(
        peerToken: Long,
        mtu: Int,
        nowElapsedMs: Long
    ): AndroidGattServerHandlerResultV1 {
        val session = activeSession(peerToken, nowElapsedMs) ?: return missingSession()
        if (!AndroidGattProfileV1.isValidMtu(mtu)) {
            protocolFailures += 1L
            removeSession(peerToken)
            return AndroidGattServerHandlerResultV1.reject(
                AndroidGattServerAccessStatusV1.FAILURE
            )
        }
        session.mtu = mtu
        session.lastActivityMs = nowElapsedMs
        session.deadlineMs = deadline(nowElapsedMs)
        return AndroidGattServerHandlerResultV1.success()
    }

    @Synchronized
    override fun onRead(
        peerToken: Long,
        characteristicUuid: UUID,
        offset: Int,
        nowElapsedMs: Long
    ): AndroidGattServerHandlerResultV1 {
        val session = activeSession(peerToken, nowElapsedMs) ?: return missingSession()
        if (characteristicUuid != AndroidGattProfileV1.helloUuid || !helloEnabled) {
            return denyAndRemove(peerToken)
        }
        val response = session.helloResponse
            ?: return rejectAndRemove(
                peerToken,
                AndroidGattServerAccessStatusV1.REQUEST_NOT_SUPPORTED
            )
        if (offset !in 0..response.size) {
            return rejectAndRemove(
                peerToken,
                AndroidGattServerAccessStatusV1.INVALID_OFFSET
            )
        }
        session.lastActivityMs = nowElapsedMs
        session.deadlineMs = deadline(nowElapsedMs)
        helloReadsCompleted += 1L
        return AndroidGattServerHandlerResultV1.success(
            response.copyOfRange(offset, response.size)
        )
    }

    @Synchronized
    override fun onWrite(
        peerToken: Long,
        characteristicUuid: UUID,
        offset: Int,
        preparedWrite: Boolean,
        value: ByteArray,
        nowElapsedMs: Long
    ): AndroidGattServerHandlerResultV1 {
        val session = activeSession(peerToken, nowElapsedMs) ?: return missingSession()
        if (characteristicUuid == AndroidGattProfileV1.controlRxUuid) {
            return handlePeerAuthWrite(
                peerToken,
                session,
                offset,
                preparedWrite,
                value,
                nowElapsedMs
            )
        }
        if (characteristicUuid != AndroidGattProfileV1.helloUuid || !helloEnabled) {
            return denyAndRemove(peerToken)
        }
        if (preparedWrite || offset != 0) {
            return rejectAndRemove(
                peerToken,
                AndroidGattServerAccessStatusV1.INVALID_OFFSET
            )
        }
        if (value.size != BluetoothHelloCodecV1.WIRE_BYTES) {
            return rejectAndRemove(
                peerToken,
                AndroidGattServerAccessStatusV1.INVALID_ATTRIBUTE_LENGTH
            )
        }
        if (session.mtu < BluetoothHelloCodecV1.MINIMUM_MTU) {
            return rejectAndRemove(
                peerToken,
                AndroidGattServerAccessStatusV1.REQUEST_NOT_SUPPORTED
            )
        }

        val digest = MessageDigest.getInstance("SHA-256").digest(value)
        val priorDigest = session.requestDigest
        if (priorDigest != null) {
            val duplicate = MessageDigest.isEqual(priorDigest, digest)
            digest.fill(0)
            return if (duplicate && session.helloResponse != null) {
                session.lastActivityMs = nowElapsedMs
                session.deadlineMs = deadline(nowElapsedMs)
                AndroidGattServerHandlerResultV1.success()
            } else {
                protocolFailures += 1L
                removeSession(peerToken)
                AndroidGattServerHandlerResultV1.reject(
                    AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION
                )
            }
        }

        val response = createHelloResponse(value)
        if (response == null) {
            digest.fill(0)
            protocolFailures += 1L
            removeSession(peerToken)
            return AndroidGattServerHandlerResultV1.reject(
                AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION
            )
        }
        session.requestDigest = digest
        session.helloResponse = response.wire
        session.clientHello = response.clientHello
        session.serverHello = response.serverHello
        session.lastActivityMs = nowElapsedMs
        session.deadlineMs = deadline(nowElapsedMs)
        helloWritesAccepted += 1L
        return AndroidGattServerHandlerResultV1.success()
    }

    @Synchronized
    override fun onSubscriptionChanged(
        peerToken: Long,
        characteristicUuid: UUID,
        enabled: Boolean,
        indicate: Boolean,
        nowElapsedMs: Long
    ): AndroidGattServerHandlerResultV1 {
        val session = activeSession(peerToken, nowElapsedMs) ?: return missingSession()
        if (!isAndroidPeerAuthReady() || !enabled) return denyAndRemove(peerToken)
        when (characteristicUuid) {
            AndroidGattProfileV1.controlTxUuid -> {
                if (
                    !indicate ||
                    session.helloResponse == null ||
                    session.mtu < AndroidPeerAuthCodecV2.MINIMUM_MTU
                ) return denyAndRemove(peerToken)
                session.controlIndicationSubscribed = true
            }
            AndroidGattProfileV1.dataTxUuid -> {
                if (
                    indicate ||
                    session.peerAuth?.snapshot() != AndroidGattPeerAuthPhaseV2.ESTABLISHED
                ) return denyAndRemove(peerToken)
                session.dataNotificationSubscribed = true
            }
            AndroidGattProfileV1.ackTxUuid -> {
                if (
                    !indicate ||
                    session.peerAuth?.snapshot() != AndroidGattPeerAuthPhaseV2.ESTABLISHED
                ) return denyAndRemove(peerToken)
                session.ackIndicationSubscribed = true
            }
            else -> return denyAndRemove(peerToken)
        }
        session.lastActivityMs = nowElapsedMs
        session.deadlineMs = deadline(nowElapsedMs)
        return AndroidGattServerHandlerResultV1.success()
    }

    @Synchronized
    override fun onReliableActivity(
        peerToken: Long,
        nowElapsedMs: Long
    ): AndroidGattServerHandlerResultV1 {
        val session = activeSession(peerToken, nowElapsedMs) ?: return missingSession()
        if (
            session.peerAuth?.snapshot() != AndroidGattPeerAuthPhaseV2.ESTABLISHED ||
            !session.dataNotificationSubscribed ||
            !session.ackIndicationSubscribed
        ) return denyAndRemove(peerToken)
        session.lastActivityMs = nowElapsedMs
        session.deadlineMs = deadline(nowElapsedMs)
        return AndroidGattServerHandlerResultV1.success()
    }

    @Synchronized
    override fun onDisconnected(peerToken: Long) {
        requirePeerToken(peerToken)
        removeSession(peerToken)
    }

    @Synchronized
    override fun expire(nowElapsedMs: Long): Set<Long> {
        requireClock(nowElapsedMs)
        return expireInternal(nowElapsedMs)
    }

    @Synchronized
    override fun reset() {
        sessions.values.forEach(Session::clear)
        sessions.clear()
    }

    @Synchronized
    override fun exportReliableContext(
        peerToken: Long
    ): GattReliableChannelContextV1 {
        requirePeerToken(peerToken)
        check(isAndroidPeerAuthReady()) { "A2 server trust is not ready" }
        val auth = sessions[peerToken]?.peerAuth
            ?: error("A2 server session is unavailable")
        return auth.export(peerToken)
    }

    @Synchronized
    override fun snapshot(): AndroidGattServerSessionHandlerSnapshotV1 =
        AndroidGattServerSessionHandlerSnapshotV1(
            enabled = enabled,
            helloEnabled = helloEnabled,
            sessionCount = sessions.size,
            secureActiveSessionCount =
                sessions.values.count {
                    it.peerAuth?.snapshot() == AndroidGattPeerAuthPhaseV2.ESTABLISHED
                },
            securePromotionBlockedSessionCount =
                sessions.values.count {
                    it.helloResponse != null &&
                        it.peerAuth?.snapshot() != AndroidGattPeerAuthPhaseV2.ESTABLISHED
                },
            sessionsAccepted = sessionsAccepted,
            sessionsRejected = sessionsRejected,
            sessionsExpired = sessionsExpired,
            helloWritesAccepted = helloWritesAccepted,
            helloReadsCompleted = helloReadsCompleted,
            deniedRequests = deniedRequests,
            protocolFailures = protocolFailures
        )

    private fun handlePeerAuthWrite(
        peerToken: Long,
        session: Session,
        offset: Int,
        preparedWrite: Boolean,
        value: ByteArray,
        nowElapsedMs: Long
    ): AndroidGattServerHandlerResultV1 {
        if (
            !isAndroidPeerAuthReady() ||
            preparedWrite ||
            offset != 0 ||
            !session.controlIndicationSubscribed ||
            session.mtu < AndroidPeerAuthCodecV2.MINIMUM_MTU
        ) {
            return rejectAndRemove(
                peerToken,
                if (preparedWrite || offset != 0) {
                    AndroidGattServerAccessStatusV1.INVALID_OFFSET
                } else {
                    AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION
                }
            )
        }
        val clientHello = session.clientHello
            ?: return rejectAndRemove(
                peerToken,
                AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION
            )
        val serverHello = session.serverHello
            ?: return rejectAndRemove(
                peerToken,
                AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION
            )
        val auth = session.peerAuth ?: run {
            if (
                value.size != AndroidPeerAuthCodecV2.CLIENT_INIT_BYTES ||
                value[0].toInt() and 0xff != AndroidPeerAuthCodecV2.PROTOCOL_VERSION ||
                value[1].toInt() and 0xff !=
                AndroidPeerAuthMessageTypeV2.CLIENT_INIT.wire
            ) {
                return rejectAndRemove(
                    peerToken,
                    AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION
                )
            }
            runCatching {
                peerAuthSessionFactory?.create(
                    peerToken,
                    session.mtu,
                    clientHello,
                    serverHello
                )
            }.getOrNull() ?: return rejectAndRemove(
                peerToken,
                AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION
            )
        }
        val outbound = runCatching {
            auth.onClientWrite(AndroidGattProfileV1.controlRxUuid, value)
        }.getOrElse {
            auth.close()
            return rejectAndRemove(
                peerToken,
                AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION
            )
        }
        session.peerAuth = auth
        session.lastActivityMs = nowElapsedMs
        session.deadlineMs = deadline(nowElapsedMs)
        var serverOutbound: AndroidGattServerOutboundV1? = null
        return try {
            serverOutbound = outbound?.let {
                val payload = it.payloadCopy()
                try {
                    AndroidGattServerOutboundV1(
                        it.characteristicUuid,
                        payload,
                        confirm = it.indicate
                    )
                } finally {
                    payload.fill(0)
                }
            }
            AndroidGattServerHandlerResultV1.success(outbound = serverOutbound)
        } finally {
            serverOutbound?.close()
            outbound?.close()
        }
    }

    private fun isAndroidPeerAuthReady(): Boolean =
        androidPeerAuthEnabled &&
            runCatching(androidPeerAuthReady).getOrDefault(false)

    private fun createHelloResponse(value: ByteArray): HelloResponse? = runCatching {
        val request = BluetoothHelloCodecV1.decode(value)
        require(
            request.capabilities and BluetoothCapabilityBitsV1.GATT_CLIENT != 0
        )
        val local = requireNotNull(localContextProvider())
        val advertisement = BluetoothAdvertisementCodecV1.validate(local.advertisement)
        require(advertisement.nodeKind != BluetoothAdvertisementNodeKind.RASPBERRY)
        require(
            advertisement.capabilities and BluetoothCapabilityBitsV1.GATT_SERVER != 0
        )
        require(request.nodeId != local.nodeId)
        val nonce = generateDistinctNonce(request.nonce)
        val response = BluetoothHelloV1(
                protocolVersion = BluetoothHelloCodecV1.PROTOCOL_VERSION,
                sessionId = request.sessionId,
                nodeId = local.nodeId,
                bootId = advertisement.bootId,
                capabilities = advertisement.capabilities,
                nonce = nonce
            )
        HelloResponse(
            request,
            response,
            BluetoothHelloCodecV1.encode(response)
        )
    }.getOrNull()

    private fun generateDistinctNonce(remoteNonce: String): String {
        repeat(3) {
            val candidate = BluetoothHelloCodecV1.generateNonce(randomBytes)
            if (candidate != remoteNonce) return candidate
        }
        error("random source reused the remote nonce")
    }

    private fun activeSession(peerToken: Long, nowElapsedMs: Long): Session? {
        requirePeerToken(peerToken)
        requireClock(nowElapsedMs)
        val session = sessions[peerToken] ?: return null
        if (nowElapsedMs < session.lastActivityMs) {
            protocolFailures += 1L
            removeSession(peerToken)
            return null
        }
        if (nowElapsedMs > session.deadlineMs) {
            sessionsExpired += 1L
            removeSession(peerToken)
            return null
        }
        return session
    }

    private fun expireInternal(nowElapsedMs: Long): Set<Long> {
        val regressive = sessions
            .filterValues { session -> nowElapsedMs < session.lastActivityMs }
            .keys
            .toSet()
        val expired = sessions
            .filterValues { session ->
                nowElapsedMs >= session.lastActivityMs &&
                    nowElapsedMs > session.deadlineMs
            }
            .keys
            .toSet()
        (regressive + expired).forEach(::removeSession)
        protocolFailures += regressive.size.toLong()
        sessionsExpired += expired.size.toLong()
        return regressive + expired
    }

    private fun deadline(nowElapsedMs: Long): Long =
        if (nowElapsedMs > Long.MAX_VALUE - sessionIdleTimeoutMs) {
            Long.MAX_VALUE
        } else {
            nowElapsedMs + sessionIdleTimeoutMs
        }

    private fun denyAndRemove(peerToken: Long): AndroidGattServerHandlerResultV1 {
        deniedRequests += 1L
        removeSession(peerToken)
        return AndroidGattServerHandlerResultV1.reject(
            AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION
        )
    }

    private fun rejectAndRemove(
        peerToken: Long,
        status: AndroidGattServerAccessStatusV1
    ): AndroidGattServerHandlerResultV1 {
        protocolFailures += 1L
        removeSession(peerToken)
        return AndroidGattServerHandlerResultV1.reject(status)
    }

    private fun missingSession(): AndroidGattServerHandlerResultV1 {
        deniedRequests += 1L
        return AndroidGattServerHandlerResultV1.reject(
            AndroidGattServerAccessStatusV1.INSUFFICIENT_AUTHENTICATION
        )
    }

    private fun removeSession(peerToken: Long) {
        sessions.remove(peerToken)?.clear()
    }

    private fun requirePeerToken(peerToken: Long) {
        require(peerToken > 0L)
    }

    private fun requireClock(nowElapsedMs: Long) {
        require(nowElapsedMs >= 0L)
    }

    companion object {
        const val MAXIMUM_SESSIONS = 8
        const val SESSION_IDLE_TIMEOUT_MS = 15_000L
    }
}
