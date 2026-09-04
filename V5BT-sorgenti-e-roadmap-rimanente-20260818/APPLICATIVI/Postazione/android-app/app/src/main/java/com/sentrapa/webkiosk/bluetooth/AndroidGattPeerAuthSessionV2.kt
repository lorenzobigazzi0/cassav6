package com.sentrapa.webkiosk.bluetooth

import java.util.UUID
import okio.ByteString.Companion.decodeBase64

internal enum class AndroidGattPeerAuthPhaseV2 {
    READY,
    CLIENT_INIT_IN_FLIGHT,
    WAITING_SERVER_REPLY,
    CLIENT_FINISH_IN_FLIGHT,
    WAITING_CLIENT_INIT,
    WAITING_CLIENT_FINISH,
    ESTABLISHED,
    FAILED,
    CLOSED
}

internal class AndroidGattPeerAuthOutboundV2(
    val characteristicUuid: UUID,
    payload: ByteArray,
    val indicate: Boolean
) : AutoCloseable {
    private var payload: ByteArray? = payload.copyOf()

    fun payloadCopy(): ByteArray = checkNotNull(payload).copyOf()

    override fun close() {
        payload?.fill(0)
        payload = null
    }
}

internal class AndroidGattPeerReliableSessionV2(
    private val sessionToken: Long,
    val peerTrustId: String,
    private val mtu: Int,
    private val role: GattReliableEndpointRoleV1,
    clientToServerControlKey: ByteArray,
    serverToClientControlKey: ByteArray,
    private val leaseValidator: AndroidPeerTrustLeaseValidatorV2
) : GattReliableSessionContextProviderV1, AutoCloseable {
    private var clientToServer = ByteArray(0)
    private var serverToClient = ByteArray(0)
    private var closed = false

    init {
        require(sessionToken > 0)
        require(BLUETOOTH_PEER_TRUST_ID_PATTERN_V1.matches(peerTrustId))
        require(mtu >= AndroidPeerAuthCodecV2.MINIMUM_MTU)
        require(
            clientToServerControlKey.size == 32 &&
                serverToClientControlKey.size == 32
        )
        require(clientToServerControlKey.any { it.toInt() != 0 })
        require(serverToClientControlKey.any { it.toInt() != 0 })
        clientToServer = clientToServerControlKey.copyOf()
        serverToClient = serverToClientControlKey.copyOf()
    }

    @Synchronized
    override fun export(sessionToken: Long): GattReliableChannelContextV1 {
        check(!closed && sessionToken == this.sessionToken) {
            "A2 GATT session is not authorized"
        }
        if (!leaseValidator.isValid(peerTrustId)) {
            close()
            error("A2 peer trust lease is no longer valid")
        }
        return GattReliableChannelContextV1(
            peerTrustId,
            mtu,
            role,
            deriveReliableChannelMaterialV1(clientToServer, serverToClient)
        )
    }

    @Synchronized
    override fun close() {
        if (closed) return
        clientToServer.fill(0)
        serverToClient.fill(0)
        closed = true
    }

    override fun toString(): String =
        "AndroidGattPeerReliableSessionV2(role=$role, material=<redacted>)"
}

class AndroidGattPeerAuthClientSessionV2 internal constructor(
    private val sessionToken: Long,
    private val mtu: Int,
    private val exchange: AndroidPeerAuthClientExchangeV2,
    private val leaseValidator: AndroidPeerTrustLeaseValidatorV2
) : GattReliableSessionContextProviderV1, AutoCloseable {
    private var phase = AndroidGattPeerAuthPhaseV2.READY
    private var reliable: AndroidGattPeerReliableSessionV2? = null

    @Synchronized
    internal fun start(): AndroidGattPeerAuthOutboundV2 {
        requirePhase(AndroidGattPeerAuthPhaseV2.READY)
        require(mtu >= AndroidPeerAuthCodecV2.MINIMUM_MTU)
        val payload = failClosed { exchange.start() }
        phase = AndroidGattPeerAuthPhaseV2.CLIENT_INIT_IN_FLIGHT
        return AndroidGattPeerAuthOutboundV2(
            AndroidGattProfileV1.controlRxUuid,
            payload,
            indicate = false
        ).also { payload.fill(0) }
    }

    @Synchronized
    internal fun onClientInitWritten() {
        requirePhase(AndroidGattPeerAuthPhaseV2.CLIENT_INIT_IN_FLIGHT)
        phase = AndroidGattPeerAuthPhaseV2.WAITING_SERVER_REPLY
    }

    @Synchronized
    internal fun onServerReply(
        characteristicUuid: UUID,
        payload: ByteArray
    ): AndroidGattPeerAuthOutboundV2 {
        requirePhase(AndroidGattPeerAuthPhaseV2.WAITING_SERVER_REPLY)
        require(characteristicUuid == AndroidGattProfileV1.controlTxUuid)
        val finish = failClosed { exchange.acceptServerReply(payload) }
        phase = AndroidGattPeerAuthPhaseV2.CLIENT_FINISH_IN_FLIGHT
        return AndroidGattPeerAuthOutboundV2(
            AndroidGattProfileV1.controlRxUuid,
            finish,
            indicate = false
        ).also { finish.fill(0) }
    }

    @Synchronized
    internal fun onClientFinishWritten() {
        requirePhase(AndroidGattPeerAuthPhaseV2.CLIENT_FINISH_IN_FLIGHT)
        val material = failClosed { exchange.confirmFinishTransmitted() }
        reliable = try {
            material.handoffToGattSession(
                sessionToken,
                mtu,
                GattReliableEndpointRoleV1.CLIENT,
                leaseValidator
            )
        } finally {
            material.close()
        }
        phase = AndroidGattPeerAuthPhaseV2.ESTABLISHED
    }

    @Synchronized
    override fun export(sessionToken: Long): GattReliableChannelContextV1 {
        requirePhase(AndroidGattPeerAuthPhaseV2.ESTABLISHED)
        return try {
            checkNotNull(reliable).export(sessionToken)
        } catch (error: Throwable) {
            close()
            throw error
        }
    }

    @Synchronized
    internal fun snapshot(): AndroidGattPeerAuthPhaseV2 = phase

    @Synchronized
    override fun close() {
        if (phase == AndroidGattPeerAuthPhaseV2.CLOSED) return
        exchange.close()
        reliable?.close()
        reliable = null
        phase = AndroidGattPeerAuthPhaseV2.CLOSED
    }

    private fun requirePhase(expected: AndroidGattPeerAuthPhaseV2) {
        check(phase == expected) { "A2 client GATT phase mismatch" }
    }

    private fun <T> failClosed(action: () -> T): T = try {
        action()
    } catch (error: Throwable) {
        phase = AndroidGattPeerAuthPhaseV2.FAILED
        exchange.close()
        reliable?.close()
        reliable = null
        throw error
    }
}

class AndroidGattPeerAuthServerSessionV2 internal constructor(
    private val sessionToken: Long,
    private val mtu: Int,
    private val exchange: AndroidPeerAuthServerExchangeV2,
    private val leaseValidator: AndroidPeerTrustLeaseValidatorV2
) : GattReliableSessionContextProviderV1, AutoCloseable {
    private var phase = AndroidGattPeerAuthPhaseV2.WAITING_CLIENT_INIT
    private var reliable: AndroidGattPeerReliableSessionV2? = null

    @Synchronized
    internal fun onClientWrite(
        characteristicUuid: UUID,
        payload: ByteArray
    ): AndroidGattPeerAuthOutboundV2? {
        require(characteristicUuid == AndroidGattProfileV1.controlRxUuid)
        return when (phase) {
            AndroidGattPeerAuthPhaseV2.WAITING_CLIENT_INIT -> {
                val reply = failClosed { exchange.acceptClientInit(payload) }
                phase = AndroidGattPeerAuthPhaseV2.WAITING_CLIENT_FINISH
                AndroidGattPeerAuthOutboundV2(
                    AndroidGattProfileV1.controlTxUuid,
                    reply,
                    indicate = true
                ).also { reply.fill(0) }
            }
            AndroidGattPeerAuthPhaseV2.WAITING_CLIENT_FINISH -> {
                val material = failClosed { exchange.acceptClientFinish(payload) }
                reliable = try {
                    material.handoffToGattSession(
                        sessionToken,
                        mtu,
                        GattReliableEndpointRoleV1.SERVER,
                        leaseValidator
                    )
                } finally {
                    material.close()
                }
                phase = AndroidGattPeerAuthPhaseV2.ESTABLISHED
                null
            }
            else -> error("A2 server GATT phase mismatch")
        }
    }

    @Synchronized
    override fun export(sessionToken: Long): GattReliableChannelContextV1 {
        check(phase == AndroidGattPeerAuthPhaseV2.ESTABLISHED) {
            "A2 server GATT session is not established"
        }
        return try {
            checkNotNull(reliable).export(sessionToken)
        } catch (error: Throwable) {
            close()
            throw error
        }
    }

    @Synchronized
    internal fun snapshot(): AndroidGattPeerAuthPhaseV2 = phase

    @Synchronized
    override fun close() {
        if (phase == AndroidGattPeerAuthPhaseV2.CLOSED) return
        exchange.close()
        reliable?.close()
        reliable = null
        phase = AndroidGattPeerAuthPhaseV2.CLOSED
    }

    private fun <T> failClosed(action: () -> T): T = try {
        action()
    } catch (error: Throwable) {
        phase = AndroidGattPeerAuthPhaseV2.FAILED
        exchange.close()
        reliable?.close()
        reliable = null
        throw error
    }
}

internal data class AndroidGattPeerAuthResolvedContextV2(
    val binding: AndroidPeerAuthBindingV2,
    val localIdentity: AndroidPeerLocalIdentityV2,
    val trustedRemote: AndroidResolvedPeerTrustV1
)

internal class ExistingOnlyDeviceIdentitySignerV2(
    private val identity: DeviceIdentityManager
) : BluetoothMutualAuthIdentityPort {
    override fun sign(message: ByteArray): DeviceSignatureResult =
        identity.signWithExistingIdentity(message)

    override fun createAuthenticationMac(
        message: ByteArray
    ): DeviceAuthenticationMacResult =
        DeviceAuthenticationMacResult(DeviceIdentityStatus.FEATURE_DISABLED)

    override fun verifyAuthenticationMac(
        message: ByteArray,
        proof: ByteArray
    ): DeviceAuthenticationMacVerificationResult =
        DeviceAuthenticationMacVerificationResult(DeviceIdentityStatus.FEATURE_DISABLED)
}

fun interface AndroidGattPeerAuthServerSessionFactoryV2 {
    fun create(
        peerToken: Long,
        mtu: Int,
        clientHello: BluetoothHelloV1,
        serverHello: BluetoothHelloV1
    ): AndroidGattPeerAuthServerSessionV2?
}

fun interface AndroidGattPeerAuthClientSessionFactoryV2 {
    fun create(
        sessionToken: Long,
        mtu: Int,
        clientHello: BluetoothHelloV1,
        serverHello: BluetoothHelloV1,
        clientAdvertisement: BluetoothAdvertisementV1,
        serverAdvertisement: BluetoothAdvertisementV1,
        aliasEpoch: Long
    ): AndroidGattPeerAuthClientSessionV2?
}

internal class AndroidGattPeerAuthContextResolverV2(
    private val identity: DeviceIdentityManager,
    private val cache: AndroidPeerTrustCacheV1,
    private val nowEpochMs: () -> Long = System::currentTimeMillis,
    private val epochSeconds: Long = BluetoothDiscoveryPolicy.ALIAS_EPOCH_SECONDS
) {
    fun createClientSession(
        sessionToken: Long,
        mtu: Int,
        clientHello: BluetoothHelloV1,
        serverHello: BluetoothHelloV1,
        clientAdvertisement: BluetoothAdvertisementV1,
        serverAdvertisement: BluetoothAdvertisementV1,
        aliasEpoch: Long
    ): AndroidGattPeerAuthClientSessionV2 {
        val context = resolve(
            GattReliableEndpointRoleV1.CLIENT,
            clientHello,
            serverHello,
            clientAdvertisement,
            serverAdvertisement,
            aliasEpoch
        )
        return AndroidGattPeerAuthClientSessionV2(
            sessionToken,
            mtu,
            AndroidPeerAuthClientExchangeV2(
                context.binding,
                context.localIdentity,
                context.trustedRemote
            ),
            leaseValidator(context.trustedRemote)
        )
    }

    fun createServerSession(
        sessionToken: Long,
        mtu: Int,
        clientHello: BluetoothHelloV1,
        serverHello: BluetoothHelloV1,
        clientAdvertisement: BluetoothAdvertisementV1,
        serverAdvertisement: BluetoothAdvertisementV1,
        aliasEpoch: Long
    ): AndroidGattPeerAuthServerSessionV2 {
        val context = resolve(
            GattReliableEndpointRoleV1.SERVER,
            clientHello,
            serverHello,
            clientAdvertisement,
            serverAdvertisement,
            aliasEpoch
        )
        return AndroidGattPeerAuthServerSessionV2(
            sessionToken,
            mtu,
            AndroidPeerAuthServerExchangeV2(
                context.binding,
                context.localIdentity,
                context.trustedRemote
            ),
            leaseValidator(context.trustedRemote)
        )
    }

    fun resolve(
        localRole: GattReliableEndpointRoleV1,
        clientHello: BluetoothHelloV1,
        serverHello: BluetoothHelloV1,
        clientAdvertisement: BluetoothAdvertisementV1,
        serverAdvertisement: BluetoothAdvertisementV1,
        aliasEpoch: Long
    ): AndroidGattPeerAuthResolvedContextV2 {
        val client = BluetoothHelloCodecV1.validate(clientHello)
        val server = BluetoothHelloCodecV1.validate(serverHello)
        val clientAd = validateAndroidFullNode(clientAdvertisement, client)
        val serverAd = validateAndroidFullNode(serverAdvertisement, server)
        val now = nowEpochMs()
        require(now >= 0L)
        val expectedEpoch = RotatingAliasV1.epoch(now / 1_000L, epochSeconds)
        require(aliasEpoch == expectedEpoch)
        requireAndroidPeerRoleElectionV2(clientAd, serverAd, aliasEpoch)
        val trustedClient = requireNotNull(
            cache.resolveActivePeerByAlias(
                client.nodeId,
                clientAd.rotatingAlias,
                aliasEpoch,
                now
            )
        )
        val trustedServer = requireNotNull(
            cache.resolveActivePeerByAlias(
                server.nodeId,
                serverAd.rotatingAlias,
                aliasEpoch,
                now
            )
        )
        val report = identity.inspectExistingIdentity()
        require(report.status == DeviceIdentityStatus.READY)
        val localHello = if (localRole == GattReliableEndpointRoleV1.CLIENT) {
            client
        } else {
            server
        }
        val localTrust = if (localRole == GattReliableEndpointRoleV1.CLIENT) {
            trustedClient
        } else {
            trustedServer
        }
        val remoteTrust = if (localRole == GattReliableEndpointRoleV1.CLIENT) {
            trustedServer
        } else {
            trustedClient
        }
        require(report.nodeId == localHello.nodeId)
        require(report.certificateId == localTrust.entry.certificateId)
        require(report.signingAlgorithm == localTrust.entry.publicKeyAlgorithm)
        val publicKey = requireNotNull(
            requireNotNull(report.signingPublicKeyBase64).decodeBase64()
        ).toByteArray()
        val directoryPublicKey = requireNotNull(
            localTrust.entry.publicKeySpkiDerBase64.decodeBase64()
        ).toByteArray()
        val localIdentity = try {
            require(publicKey.contentEquals(directoryPublicKey))
            AndroidPeerLocalIdentityV2(
                localHello.nodeId,
                requireNotNull(report.certificateId),
                requireNotNull(report.signingAlgorithm),
                publicKey,
                ExistingOnlyDeviceIdentitySignerV2(identity)
            )
        } finally {
            publicKey.fill(0)
            directoryPublicKey.fill(0)
        }
        val binding = AndroidPeerAuthBindingV2.create(
            client,
            server,
            trustedClient.entry.certificateId,
            trustedServer.entry.certificateId,
            aliasEpoch,
            clientAd.rotatingAlias,
            serverAd.rotatingAlias
        )
        return AndroidGattPeerAuthResolvedContextV2(
            binding,
            localIdentity,
            remoteTrust
        )
    }

    private fun validateAndroidFullNode(
        advertisement: BluetoothAdvertisementV1,
        hello: BluetoothHelloV1
    ): BluetoothAdvertisementV1 {
        val value = BluetoothAdvertisementCodecV1.validate(advertisement)
        require(value.nodeKind != BluetoothAdvertisementNodeKind.RASPBERRY)
        require(
            value.capabilities and BluetoothCapabilityBitsV1.B2_FULL_NODE ==
                BluetoothCapabilityBitsV1.B2_FULL_NODE
        )
        require(value.bootId == hello.bootId && value.capabilities == hello.capabilities)
        return value
    }

    private fun leaseValidator(
        lease: AndroidResolvedPeerTrustV1
    ) = AndroidPeerTrustLeaseValidatorV2 { peerTrustId ->
        peerTrustId == lease.peerTrustId &&
            runCatching {
                cache.validateActivePeerLease(
                    lease,
                    nowEpochMs()
                )
            }.getOrDefault(false)
    }
}

internal fun requireAndroidPeerRoleElectionV2(
    clientAdvertisement: BluetoothAdvertisementV1,
    serverAdvertisement: BluetoothAdvertisementV1,
    aliasEpoch: Long
) {
    fun candidate(advertisement: BluetoothAdvertisementV1) =
        AndroidAndroidRoleCandidateV1(
            nodeKind = advertisement.nodeKind,
            nodeClass = BluetoothNodeClass.FULL_NODE,
            rotatingAlias = advertisement.rotatingAlias,
            aliasEpoch = aliasEpoch
        )
    require(
        AndroidAndroidRoleElectionV1.elect(
            candidate(clientAdvertisement),
            candidate(serverAdvertisement)
        ).role == AndroidAndroidGattRoleV1.CLIENT
    )
    require(
        AndroidAndroidRoleElectionV1.elect(
            candidate(serverAdvertisement),
            candidate(clientAdvertisement)
        ).role == AndroidAndroidGattRoleV1.SERVER
    )
}

internal fun interface AndroidPeerTrustLeaseValidatorV2 {
    fun isValid(peerTrustId: String): Boolean
}
