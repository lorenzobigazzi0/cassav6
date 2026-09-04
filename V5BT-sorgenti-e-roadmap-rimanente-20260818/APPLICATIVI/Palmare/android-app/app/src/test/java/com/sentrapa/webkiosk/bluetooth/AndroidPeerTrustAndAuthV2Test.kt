package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.PriorityQueue
import java.util.concurrent.atomic.AtomicBoolean

class AndroidPeerTrustAndAuthV2Test {
    @Test
    fun `peer trust transport is disabled or exact HTTPS SPKI pinned`() {
        val pin = "sha256/${Base64.getEncoder().encodeToString(ByteArray(32) { 1 })}"
        assertTrue(
            AndroidPeerTrustClientConfigValidatorV1.validate(
                AndroidPeerTrustClientConfigV1(
                    true,
                    "https://192.168.1.79:9443/v1/peer-trust-directory",
                    pin
                )
            ).isSuccess
        )
        for (invalid in listOf(
            "http://192.168.1.79:9443/v1/peer-trust-directory",
            "https://192.168.1.79:9443/v2/peer-trust-directory",
            "https://user@192.168.1.79:9443/v1/peer-trust-directory",
            "https://192.168.1.79:9443/v1/peer-trust-directory?x=1"
        )) {
            assertTrue(
                AndroidPeerTrustClientConfigValidatorV1.validate(
                    AndroidPeerTrustClientConfigV1(true, invalid, pin)
                ).isFailure
            )
        }
        assertTrue(
            AndroidPeerTrustClientConfigValidatorV1.validate(
                AndroidPeerTrustClientConfigV1(
                    true,
                    "https://192.168.1.79:9443/v1/peer-trust-directory",
                    "sha256/${Base64.getEncoder().encodeToString(ByteArray(32))}"
                )
            ).isFailure
        )
    }

    @Test
    fun `runtime config keeps TLS and signing authority pins separate`() {
        val authority = p256KeyPair().public.encoded
        val tlsPin = ByteArray(32) { 7 }
        val config = AndroidPeerTrustRuntimeConfigV2(
            enabled = true,
            directoryUrl =
                "https://192.168.1.79:9443/v1/peer-trust-directory",
            tlsSpkiSha256 = "sha256/${Base64.getEncoder().encodeToString(tlsPin)}",
            authoritySpkiDerBase64 = Base64.getEncoder().encodeToString(authority)
        )
        val accepted = AndroidPeerTrustRuntimeConfigValidatorV2.validate(config)
        assertTrue(accepted.isSuccess)
        accepted.getOrThrow().close()

        val authorityPin = MessageDigest.getInstance("SHA-256").digest(authority)
        assertTrue(
            AndroidPeerTrustRuntimeConfigValidatorV2.validate(
                config.copy(
                    tlsSpkiSha256 =
                        "sha256/${Base64.getEncoder().encodeToString(authorityPin)}"
                )
            ).isFailure
        )
        authority.fill(0)
        authorityPin.fill(0)
        tlsPin.fill(0)
    }

    @Test
    fun `runtime clock regression latches until a new lifecycle`() {
        val clock = AndroidPeerTrustRuntimeClockV2()
        assertTrue(clock.claim(1_000L, 500L))
        assertTrue(clock.claim(1_001L, 501L))
        assertFalse(clock.claim(1_000L, 502L))
        assertFalse(clock.claim(2_000L, 2_000L))

        val nextLifecycle = AndroidPeerTrustRuntimeClockV2()
        assertTrue(nextLifecycle.claim(900L, 100L))
    }

    @Test
    fun `refresh jitter covers its bounds and backoff remains capped`() {
        val values = ArrayDeque(listOf(0, 2_000, 0, 2_000, 2_000, 2_000))
        val cadence = AndroidPeerTrustRefreshBackoffV2 {
            values.removeFirst()
        }
        assertEquals(25_000L, cadence.nextDelayMs(success = true))
        assertEquals(27_000L, cadence.nextDelayMs(success = true))
        assertEquals(5_000L, cadence.nextDelayMs(success = false))
        assertEquals(12_000L, cadence.nextDelayMs(success = false))
        assertEquals(22_000L, cadence.nextDelayMs(success = false))
        assertEquals(30_000L, cadence.nextDelayMs(success = false))

        repeat(128) {
            assertTrue(
                AndroidSecurePeerTrustRefreshJitterSourceV2
                    .nextJitterMs(2_000) in 0..2_000
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            AndroidPeerTrustRefreshBackoffV2 { 2_001 }
                .nextDelayMs(success = true)
        }
    }

    @Test
    fun `periodic scheduler advances revisions across three alias epochs and cancels`() {
        val scheduler = VirtualRefreshScheduler()
        var directoryRevision = 0L
        var directoryAliasEpoch = -1L
        var activeRefreshes = 0
        var maximumActiveRefreshes = 0
        val readiness = mutableListOf<Boolean>()
        val loop = AndroidPeerTrustRefreshLoopV2(
            scheduler = scheduler,
            refresh = {
                activeRefreshes += 1
                maximumActiveRefreshes = maxOf(
                    maximumActiveRefreshes,
                    activeRefreshes
                )
                directoryRevision += 1L
                directoryAliasEpoch = scheduler.nowMs /
                    (BluetoothDiscoveryPolicy.ALIAS_EPOCH_SECONDS * 1_000L)
                activeRefreshes -= 1
                AndroidPeerTrustRefreshAttemptV2(
                    attempted = true,
                    refreshSucceeded = true,
                    ready = true,
                    nextLeaseValidationDelayMs = 120_000L
                )
            },
            onTrustStateChanged = readiness::add,
            backoff = AndroidPeerTrustRefreshBackoffV2 { 0 }
        )
        assertTrue(loop.start())

        repeat(38) {
            scheduler.advanceBy(5_000L)
            val currentEpoch = scheduler.nowMs /
                (BluetoothDiscoveryPolicy.ALIAS_EPOCH_SECONDS * 1_000L)
            assertTrue(currentEpoch in directoryAliasEpoch..directoryAliasEpoch + 1L)
            assertTrue(readiness.last())
        }
        assertTrue(scheduler.nowMs >= 180_000L)
        assertTrue(directoryRevision >= 8L)
        assertEquals(1, maximumActiveRefreshes)
        assertTrue(readiness.all { it })

        val revisionAtClose = directoryRevision
        loop.close()
        scheduler.advanceBy(180_000L)
        assertEquals(revisionAtClose, directoryRevision)
        assertTrue(scheduler.closed)
    }

    @Test
    fun `periodic scheduler revalidates at the exact local lease expiry`() {
        val scheduler = VirtualRefreshScheduler()
        var attempts = 0
        val states = mutableListOf<Boolean>()
        val loop = AndroidPeerTrustRefreshLoopV2(
            scheduler = scheduler,
            refresh = {
                attempts += 1
                if (attempts == 1) {
                    AndroidPeerTrustRefreshAttemptV2(
                        attempted = true,
                        refreshSucceeded = true,
                        ready = true,
                        nextLeaseValidationDelayMs = 1_000L
                    )
                } else {
                    AndroidPeerTrustRefreshAttemptV2(
                        attempted = true,
                        refreshSucceeded = false,
                        ready = false
                    )
                }
            },
            onTrustStateChanged = states::add,
            backoff = AndroidPeerTrustRefreshBackoffV2 { 0 },
            initialDelayMs = 0L
        )
        assertTrue(loop.start())
        scheduler.advanceBy(0L)
        assertEquals(listOf(true), states)
        scheduler.advanceBy(999L)
        assertEquals(1, attempts)
        scheduler.advanceBy(1L)
        assertEquals(2, attempts)
        assertEquals(listOf(true, false), states)
        loop.close()
    }

    @Test
    fun `manual refresh burst keeps at most one request pending`() {
        val scheduler = VirtualRefreshScheduler()
        var fetches = 0
        val completions = mutableListOf<Boolean>()
        val loop = AndroidPeerTrustRefreshLoopV2(
            scheduler = scheduler,
            refresh = {
                fetches += 1
                AndroidPeerTrustRefreshAttemptV2(
                    attempted = true,
                    refreshSucceeded = true,
                    ready = true,
                    nextLeaseValidationDelayMs = 120_000L
                )
            },
            onTrustStateChanged = {},
            backoff = AndroidPeerTrustRefreshBackoffV2 { 0 }
        )
        var accepted = 0
        repeat(100) {
            if (loop.requestNow(completions::add)) accepted += 1
        }
        assertEquals(1, accepted)
        assertEquals(1, scheduler.pendingTasks)
        assertEquals(0, fetches)
        assertEquals(99, completions.count { !it })

        scheduler.advanceBy(0L)
        assertEquals(1, fetches)
        assertEquals(1, completions.count { it })
        assertEquals(0, scheduler.pendingTasks)
        loop.close()
    }

    @Test
    fun `signed directory imports monotonically and resolves only active alias window`() {
        val authority = p256KeyPair()
        val client = p256KeyPair()
        val server = p256KeyPair()
        val store = MemoryTrustStore()
        val cache = AndroidPeerTrustCacheV1(store, authority.public.encoded)
        val first = signedDirectory(authority, client, server, revision = 7)
        assertEquals(7, cache.importSignedDirectory(first, NOW_MS))
        val resolved = cache.resolveActivePeer(
            SERVER_NODE,
            SERVER_CERT,
            SERVER_ALIAS,
            ALIAS_EPOCH,
            NOW_MS
        )
        assertNotNull(resolved)
        assertTrue(BLUETOOTH_PEER_TRUST_ID_PATTERN_V1.matches(resolved!!.peerTrustId))
        assertEquals(7, cache.importSignedDirectory(first, NOW_MS))

        val rollback = signedDirectory(authority, client, server, revision = 6)
        val failure = assertThrows(AndroidPeerTrustExceptionV1::class.java) {
            cache.importSignedDirectory(rollback, NOW_MS)
        }
        assertEquals("REVISION_ROLLBACK", failure.code)
        assertEquals(
            null,
            cache.resolveActivePeer(
                SERVER_NODE,
                SERVER_CERT,
                "001122334455",
                ALIAS_EPOCH,
                NOW_MS
            )
        )
        assertFalse(first.decodeToString().contains("aliasKey"))
        cache.close()
    }

    @Test
    fun `expired signed cache permits only a valid higher revision replacement`() {
        val authority = p256KeyPair()
        val client = p256KeyPair()
        val server = p256KeyPair()
        val store = MemoryTrustStore()
        val cache = AndroidPeerTrustCacheV1(store, authority.public.encoded)
        val beforeExpiry = InstantFixture.parse("2026-08-18T10:30:00.000Z")
        val afterExpiry = InstantFixture.parse("2026-08-18T12:00:00.000Z")
        val expired = signedDirectory(
            authority,
            client,
            server,
            revision = 7,
            issuedAt = "2026-08-18T10:00:00.000Z",
            expiresAt = "2026-08-18T11:00:00.000Z"
        )
        assertEquals(7L, cache.importSignedDirectory(expired, beforeExpiry))

        val rollback = signedDirectory(authority, client, server, revision = 6)
        val rollbackFailure = assertThrows(AndroidPeerTrustExceptionV1::class.java) {
            cache.importSignedDirectory(rollback, afterExpiry)
        }
        assertEquals("REVISION_ROLLBACK", rollbackFailure.code)
        assertArrayEquals(expired, store.snapshot())

        val replacement = signedDirectory(authority, client, server, revision = 8)
        assertEquals(8L, cache.importSignedDirectory(replacement, afterExpiry))
        assertArrayEquals(replacement, store.snapshot())

        val invalid = signedDirectory(authority, client, server, revision = 9)
        invalid[invalid.lastIndex - 4] = (invalid[invalid.lastIndex - 4].toInt() xor 1).toByte()
        assertThrows(AndroidPeerTrustExceptionV1::class.java) {
            cache.importSignedDirectory(invalid, afterExpiry)
        }
        assertArrayEquals(replacement, store.snapshot())
        cache.close()
    }

    @Test
    fun `peer trust commitment is stable and cross field bound`() {
        val key = p256KeyPair().public.encoded
        val baseline = deriveBluetoothPeerTrustIdV1(
            CLIENT_NODE,
            CLIENT_CERT,
            "EC-P256",
            key
        )
        assertEquals(
            baseline,
            deriveBluetoothPeerTrustIdV1(
                CLIENT_NODE,
                CLIENT_CERT,
                "EC-P256",
                key
            )
        )
        assertNotEquals(
            baseline,
            deriveBluetoothPeerTrustIdV1(
                CLIENT_NODE,
                "55555555-5555-4555-8555-555555555555",
                "EC-P256",
                key
            )
        )
    }

    @Test
    fun `peer trust lease is invalidated by revocation removal and expiry`() {
        val authority = p256KeyPair()
        val client = p256KeyPair()
        val server = p256KeyPair()

        fun activeLeaseCache(): Triple<AndroidPeerTrustCacheV1, MemoryTrustStore, AndroidResolvedPeerTrustV1> {
            val store = MemoryTrustStore()
            val cache = AndroidPeerTrustCacheV1(store, authority.public.encoded)
            cache.importSignedDirectory(
                signedDirectory(authority, client, server, revision = 7),
                NOW_MS
            )
            return Triple(
                cache,
                store,
                checkNotNull(
                    cache.resolveActivePeer(
                        SERVER_NODE,
                        SERVER_CERT,
                        SERVER_ALIAS,
                        ALIAS_EPOCH,
                        NOW_MS
                    )
                )
            )
        }

        val (revokedCache, _, revokedLease) = activeLeaseCache()
        assertTrue(revokedCache.validateActivePeerLease(revokedLease, NOW_MS))
        revokedCache.importSignedDirectory(
            signedDirectory(
                authority,
                client,
                server,
                revision = 8,
                serverStatus = AndroidPeerTrustStatusV1.REVOKED
            ),
            NOW_MS
        )
        assertFalse(revokedCache.validateActivePeerLease(revokedLease, NOW_MS))
        revokedCache.close()

        val (removedCache, _, removedLease) = activeLeaseCache()
        removedCache.importSignedDirectory(
            signedDirectory(
                authority,
                client,
                server,
                revision = 8,
                includeServer = false
            ),
            NOW_MS
        )
        assertFalse(removedCache.validateActivePeerLease(removedLease, NOW_MS))
        assertFalse(
            removedCache.validateActivePeerLease(
                removedLease,
                removedLease.directoryExpiresAtEpochMs
            )
        )
        removedCache.close()
    }

    @Test
    fun `lease revocation releases arbiter and closes both authenticated sessions`() {
        listOf("revoked", "removed", "expired").forEachIndexed { index, scenario ->
            val authority = p256KeyPair()
            val clientKeys = p256KeyPair()
            val serverKeys = p256KeyPair()
            val cache = AndroidPeerTrustCacheV1(
                MemoryTrustStore(),
                authority.public.encoded
            )
            cache.importSignedDirectory(
                signedDirectory(authority, clientKeys, serverKeys, revision = 7),
                NOW_MS
            )
            val trustedClient = checkNotNull(
                cache.resolveActivePeer(
                    CLIENT_NODE,
                    CLIENT_CERT,
                    CLIENT_ALIAS,
                    ALIAS_EPOCH,
                    NOW_MS
                )
            )
            val trustedServer = checkNotNull(
                cache.resolveActivePeer(
                    SERVER_NODE,
                    SERVER_CERT,
                    SERVER_ALIAS,
                    ALIAS_EPOCH,
                    NOW_MS
                )
            )
            var now = NOW_MS
            val sessions = establishedSessions(
                clientKeys,
                serverKeys,
                trustedClient,
                trustedServer,
                AndroidPeerTrustLeaseValidatorV2 {
                    cache.validateActivePeerLease(trustedServer, now)
                },
                AndroidPeerTrustLeaseValidatorV2 {
                    cache.validateActivePeerLease(trustedClient, now)
                }
            )
            sessions.client.export(SESSION_TOKEN).close()
            sessions.server.export(SESSION_TOKEN).close()

            when (scenario) {
                "revoked" -> cache.importSignedDirectory(
                    signedDirectory(
                        authority,
                        clientKeys,
                        serverKeys,
                        revision = 8,
                        serverStatus = AndroidPeerTrustStatusV1.REVOKED
                    ),
                    now
                )
                "removed" -> cache.importSignedDirectory(
                    signedDirectory(
                        authority,
                        clientKeys,
                        serverKeys,
                        revision = 8,
                        includeServer = false
                    ),
                    now
                )
                "expired" -> {
                    now = trustedServer.directoryExpiresAtEpochMs
                    assertThrows(IllegalStateException::class.java) {
                        sessions.client.export(SESSION_TOKEN)
                    }
                }
            }

            val runtime = LeaseTestRuntime()
            val arbiter = BluetoothReliableEndpointArbiterV1(
                BluetoothReliableApplicationPortMultiplexerV1(),
                runtime
            )
            val port = LeaseTestPort()
            assertTrue(
                arbiter.onPortChanged(
                    BluetoothReliableEndpointSourceV1.CLIENT,
                    port
                )
            )
            var clientAborts = 0
            var serverAborts = 0
            val valid = AndroidPeerTrustLeaseBoundaryV2.enforce(
                ready = scenario != "expired",
                arbiter = arbiter,
                revalidateClient = {
                    runCatching {
                        sessions.client.export(SESSION_TOKEN).close()
                    }.isSuccess
                },
                revalidateServer = {
                    runCatching {
                        sessions.server.export(SESSION_TOKEN).close()
                    }.isSuccess
                },
                abortClient = {
                    clientAborts += 1
                    sessions.client.close()
                },
                abortServer = {
                    serverAborts += 1
                    sessions.server.close()
                }
            )
            assertFalse("scenario $index must fail closed", valid)
            assertFalse(arbiter.snapshot().clientActive)
            assertEquals(1L, arbiter.snapshot().released)
            assertTrue(port.resets >= 1)
            assertEquals(1, clientAborts)
            assertEquals(1, serverAborts)
            assertEquals(
                AndroidGattPeerAuthPhaseV2.CLOSED,
                sessions.client.snapshot()
            )
            assertEquals(
                AndroidGattPeerAuthPhaseV2.CLOSED,
                sessions.server.snapshot()
            )
            assertThrows(IllegalStateException::class.java) {
                sessions.client.export(SESSION_TOKEN)
            }
            assertThrows(IllegalStateException::class.java) {
                sessions.server.export(SESSION_TOKEN)
            }
            arbiter.close()
            cache.close()
        }
    }

    @Test
    fun `A2 authenticates both Android identities and hands material off only after finish`() {
        val clientKeys = p256KeyPair()
        val serverKeys = p256KeyPair()
        val binding = binding()
        val clientLocal = local(CLIENT_NODE, CLIENT_CERT, clientKeys)
        val serverLocal = local(SERVER_NODE, SERVER_CERT, serverKeys)
        val trustedClient = resolved(
            CLIENT_NODE,
            CLIENT_CERT,
            CLIENT_ALIAS,
            clientKeys
        )
        val trustedServer = resolved(
            SERVER_NODE,
            SERVER_CERT,
            SERVER_ALIAS,
            serverKeys
        )
        val client = AndroidPeerAuthClientExchangeV2(
            binding,
            clientLocal,
            trustedServer
        )
        val server = AndroidPeerAuthServerExchangeV2(
            binding,
            serverLocal,
            trustedClient
        )
        assertThrows(IllegalStateException::class.java) {
            client.confirmFinishTransmitted()
        }
        val clientInit = client.start()
        assertEquals(AndroidPeerAuthCodecV2.CLIENT_INIT_BYTES, clientInit.size)
        val serverReply = server.acceptClientInit(clientInit)
        assertEquals(AndroidPeerAuthCodecV2.SERVER_REPLY_BYTES, serverReply.size)
        val clientFinish = client.acceptServerReply(serverReply)
        assertEquals(AndroidPeerAuthCodecV2.CLIENT_FINISH_BYTES, clientFinish.size)
        val serverMaterial = server.acceptClientFinish(clientFinish)
        val clientMaterial = client.confirmFinishTransmitted()
        assertEquals(trustedServer.peerTrustId, clientMaterial.peerTrustId)
        assertEquals(trustedClient.peerTrustId, serverMaterial.peerTrustId)
        val clientReliable = clientMaterial.takeReliableChannelMaterial()
        val serverReliable = serverMaterial.takeReliableChannelMaterial()
        assertArrayEquals(
            clientReliable.clientToServer.key,
            serverReliable.clientToServer.key
        )
        assertArrayEquals(
            clientReliable.serverToClient.noncePrefix,
            serverReliable.serverToClient.noncePrefix
        )
        clientReliable.close()
        serverReliable.close()
        client.close()
        server.close()
    }

    @Test
    fun `A2 binding changes alter signed transcript and wrong confirmation stays closed`() {
        val agreement = JcaBluetoothDirectControlKeyAgreementV1.create()
        val baseline = AndroidPeerAuthCodecV2.clientSignatureMessage(
            binding(),
            agreement.publicKeySpki()
        )
        val changed = AndroidPeerAuthCodecV2.clientSignatureMessage(
            AndroidPeerAuthBindingV2.create(
                binding().clientHello,
                binding().serverHello,
                CLIENT_CERT,
                SERVER_CERT,
                ALIAS_EPOCH + 1,
                CLIENT_ALIAS,
                SERVER_ALIAS
            ),
            agreement.publicKeySpki()
        )
        assertFalse(MessageDigest.isEqual(baseline, changed))
        val schedule = AndroidPeerAuthKeyScheduleV2.derive(
            ByteArray(32) { 1 },
            ByteArray(32) { 2 }
        )
        val serverProof = schedule.createServerConfirmation()
        assertFalse(schedule.verifyClientConfirmation(serverProof, ByteArray(32)))
        assertThrows(IllegalStateException::class.java) {
            schedule.promote("0".repeat(64))
        }
        schedule.close()
        agreement.close()
        baseline.fill(0)
        changed.fill(0)
        serverProof.fill(0)
    }

    @Test
    fun `A2 GATT sessions export independent peer-bound contexts only after finish`() {
        val clientKeys = p256KeyPair()
        val serverKeys = p256KeyPair()
        val binding = binding()
        val trustedClient = resolved(
            CLIENT_NODE,
            CLIENT_CERT,
            CLIENT_ALIAS,
            clientKeys
        )
        val trustedServer = resolved(
            SERVER_NODE,
            SERVER_CERT,
            SERVER_ALIAS,
            serverKeys
        )
        val clientLeaseValid = AtomicBoolean(true)
        val serverLeaseValid = AtomicBoolean(true)
        val client = AndroidGattPeerAuthClientSessionV2(
            SESSION_TOKEN,
            AndroidPeerAuthCodecV2.MINIMUM_MTU,
            AndroidPeerAuthClientExchangeV2(
                binding,
                local(CLIENT_NODE, CLIENT_CERT, clientKeys),
                trustedServer
            ),
            AndroidPeerTrustLeaseValidatorV2 { clientLeaseValid.get() }
        )
        val server = AndroidGattPeerAuthServerSessionV2(
            SESSION_TOKEN,
            AndroidPeerAuthCodecV2.MINIMUM_MTU,
            AndroidPeerAuthServerExchangeV2(
                binding,
                local(SERVER_NODE, SERVER_CERT, serverKeys),
                trustedClient
            ),
            AndroidPeerTrustLeaseValidatorV2 { serverLeaseValid.get() }
        )
        assertThrows(IllegalStateException::class.java) {
            client.export(SESSION_TOKEN)
        }
        val initOutbound = client.start()
        val init = initOutbound.payloadCopy()
        initOutbound.close()
        client.onClientInitWritten()
        val replyOutbound = server.onClientWrite(
            AndroidGattProfileV1.controlRxUuid,
            init
        )!!
        init.fill(0)
        val reply = replyOutbound.payloadCopy()
        replyOutbound.close()
        val finishOutbound = client.onServerReply(
            AndroidGattProfileV1.controlTxUuid,
            reply
        )
        reply.fill(0)
        val finish = finishOutbound.payloadCopy()
        finishOutbound.close()
        assertThrows(IllegalStateException::class.java) {
            client.export(SESSION_TOKEN)
        }
        assertEquals(
            null,
            server.onClientWrite(AndroidGattProfileV1.controlRxUuid, finish)
        )
        finish.fill(0)
        client.onClientFinishWritten()

        val clientFirst = client.export(SESSION_TOKEN)
        val clientSecond = client.export(SESSION_TOKEN)
        val serverContext = server.export(SESSION_TOKEN)
        assertEquals(trustedServer.peerTrustId, clientFirst.peerTrustId)
        assertEquals(trustedClient.peerTrustId, serverContext.peerTrustId)
        val expectedKey = clientSecond.material.clientToServer.key
        val serverKey = serverContext.material.clientToServer.key
        assertArrayEquals(expectedKey, serverKey)
        expectedKey.fill(0)
        serverKey.fill(0)
        clientFirst.close()
        assertFalse(clientSecond.material.isClosed)
        clientSecond.close()
        serverContext.close()
        clientLeaseValid.set(false)
        serverLeaseValid.set(false)
        assertThrows(IllegalStateException::class.java) {
            client.export(SESSION_TOKEN)
        }
        assertThrows(IllegalStateException::class.java) {
            server.export(SESSION_TOKEN)
        }
        client.close()
        assertThrows(IllegalStateException::class.java) {
            client.export(SESSION_TOKEN)
        }
        server.close()
    }

    @Test
    fun `A2 key schedule rejects invalid sizes and zero shared secret`() {
        assertThrows(IllegalArgumentException::class.java) {
            AndroidPeerAuthKeyScheduleV2.derive(ByteArray(32) { 1 }, ByteArray(31))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AndroidPeerAuthKeyScheduleV2.derive(ByteArray(32), ByteArray(32) { 2 })
        }
    }

    @Test
    fun `closed A2 material can never derive or hand off zeroed keys`() {
        val material = AndroidPeerAuthenticatedMaterialV2(
            "a".repeat(64),
            ByteArray(32) { 1 },
            ByteArray(32) { 2 }
        )
        material.close()
        material.close()
        assertThrows(IllegalStateException::class.java) {
            material.takeReliableChannelMaterial()
        }
        assertThrows(IllegalStateException::class.java) {
            material.handoffToGattSession(
                SESSION_TOKEN,
                AndroidPeerAuthCodecV2.MINIMUM_MTU,
                GattReliableEndpointRoleV1.CLIENT,
                AndroidPeerTrustLeaseValidatorV2 { true }
            )
        }
    }

    @Test
    fun `GATT server result payload ownership is explicit and close is final`() {
        val source = ByteArray(32) { (it + 1).toByte() }
        val outbound = AndroidGattServerOutboundV1(
            AndroidGattProfileV1.controlTxUuid,
            source,
            confirm = true
        )
        val result = AndroidGattServerHandlerResultV1.success(outbound = outbound)
        source.fill(0)
        outbound.close()
        assertThrows(IllegalStateException::class.java) { outbound.valueCopy() }
        val ownedCopy = result.outboundCopy()!!
        assertEquals(32, ownedCopy.valueCopy().size)
        ownedCopy.close()
        result.close()
        assertThrows(IllegalStateException::class.java) { result.outboundCopy() }
        result.close()
    }

    private fun binding(): AndroidPeerAuthBindingV2 =
        AndroidPeerAuthBindingV2.create(
            clientHello = BluetoothHelloV1(
                1,
                "AAECAwQFBgcICQoLDA0ODw",
                CLIENT_NODE,
                7,
                BluetoothCapabilityBitsV1.GATT_CLIENT,
                "AAECAwQFBgcICQoLDA0ODw"
            ),
            serverHello = BluetoothHelloV1(
                1,
                "AAECAwQFBgcICQoLDA0ODw",
                SERVER_NODE,
                8,
                BluetoothCapabilityBitsV1.GATT_SERVER,
                "ICEiIyQlJicoKSorLC0uLw"
            ),
            clientCertificateId = CLIENT_CERT,
            serverCertificateId = SERVER_CERT,
            aliasEpoch = ALIAS_EPOCH,
            clientAlias = CLIENT_ALIAS,
            serverAlias = SERVER_ALIAS
        )

    private data class EstablishedSessions(
        val client: AndroidGattPeerAuthClientSessionV2,
        val server: AndroidGattPeerAuthServerSessionV2
    )

    private fun establishedSessions(
        clientKeys: KeyPair,
        serverKeys: KeyPair,
        trustedClient: AndroidResolvedPeerTrustV1,
        trustedServer: AndroidResolvedPeerTrustV1,
        clientLeaseValidator: AndroidPeerTrustLeaseValidatorV2,
        serverLeaseValidator: AndroidPeerTrustLeaseValidatorV2
    ): EstablishedSessions {
        val client = AndroidGattPeerAuthClientSessionV2(
            SESSION_TOKEN,
            AndroidPeerAuthCodecV2.MINIMUM_MTU,
            AndroidPeerAuthClientExchangeV2(
                binding(),
                local(CLIENT_NODE, CLIENT_CERT, clientKeys),
                trustedServer
            ),
            clientLeaseValidator
        )
        val server = AndroidGattPeerAuthServerSessionV2(
            SESSION_TOKEN,
            AndroidPeerAuthCodecV2.MINIMUM_MTU,
            AndroidPeerAuthServerExchangeV2(
                binding(),
                local(SERVER_NODE, SERVER_CERT, serverKeys),
                trustedClient
            ),
            serverLeaseValidator
        )
        val initOutbound = client.start()
        val init = initOutbound.payloadCopy()
        initOutbound.close()
        client.onClientInitWritten()
        val replyOutbound = checkNotNull(
            server.onClientWrite(AndroidGattProfileV1.controlRxUuid, init)
        )
        init.fill(0)
        val reply = replyOutbound.payloadCopy()
        replyOutbound.close()
        val finishOutbound = client.onServerReply(
            AndroidGattProfileV1.controlTxUuid,
            reply
        )
        reply.fill(0)
        val finish = finishOutbound.payloadCopy()
        finishOutbound.close()
        assertEquals(
            null,
            server.onClientWrite(AndroidGattProfileV1.controlRxUuid, finish)
        )
        finish.fill(0)
        client.onClientFinishWritten()
        return EstablishedSessions(client, server)
    }

    private fun local(
        nodeId: String,
        certificateId: String,
        keys: KeyPair
    ) = AndroidPeerLocalIdentityV2(
        nodeId,
        certificateId,
        "EC-P256",
        keys.public.encoded,
        TestIdentity(keys)
    )

    private fun resolved(
        nodeId: String,
        certificateId: String,
        alias: String,
        keys: KeyPair
    ): AndroidResolvedPeerTrustV1 {
        val entry = AndroidPeerTrustEntryV1(
            nodeId,
            certificateId,
            "EC-P256",
            Base64.getEncoder().encodeToString(keys.public.encoded),
            AndroidPeerTrustStatusV1.ACTIVE,
            alias,
            if (alias == CLIENT_ALIAS) "111122223333" else "555566667777"
        )
        return AndroidResolvedPeerTrustV1(
            entry,
            7,
            InstantFixture.parse("2026-08-19T10:00:00.000Z"),
            ALIAS_EPOCH,
            alias,
            deriveBluetoothPeerTrustIdV1(
                nodeId,
                certificateId,
                "EC-P256",
                keys.public.encoded
            )
        )
    }

    private fun signedDirectory(
        authority: KeyPair,
        client: KeyPair,
        server: KeyPair,
        revision: Long,
        issuedAt: String = "2026-08-18T10:00:00.000Z",
        expiresAt: String = "2026-08-19T10:00:00.000Z",
        serverStatus: AndroidPeerTrustStatusV1 = AndroidPeerTrustStatusV1.ACTIVE,
        includeServer: Boolean = true
    ): ByteArray {
        val unsigned = AndroidPeerTrustDirectoryV1(
            issuerId = "raspberry-lab-v5bt",
            revision = revision,
            issuedAt = issuedAt,
            expiresAt = expiresAt,
            aliasEpoch = ALIAS_EPOCH,
            authorityKeyId = sha256Hex(authority.public.encoded),
            devices = buildList {
                add(entry(CLIENT_NODE, CLIENT_CERT, CLIENT_ALIAS, client))
                if (includeServer) {
                    add(
                        entry(
                            SERVER_NODE,
                            SERVER_CERT,
                            SERVER_ALIAS,
                            server,
                            serverStatus
                        )
                    )
                }
            },
            signatureBase64 = ""
        )
        val message = AndroidPeerTrustDirectoryCodecV1.signingMessage(unsigned)
        val signature = signP256(authority, message)
        message.fill(0)
        return AndroidPeerTrustDirectoryCodecV1.encode(
            unsigned.copy(
                signatureBase64 = Base64.getEncoder().encodeToString(signature)
            )
        ).also { signature.fill(0) }
    }

    private fun entry(
        nodeId: String,
        certificateId: String,
        alias: String,
        key: KeyPair,
        status: AndroidPeerTrustStatusV1 = AndroidPeerTrustStatusV1.ACTIVE
    ) = AndroidPeerTrustEntryV1(
        nodeId,
        certificateId,
        "EC-P256",
        Base64.getEncoder().encodeToString(key.public.encoded),
        status,
        alias.takeIf { status == AndroidPeerTrustStatusV1.ACTIVE },
        (if (alias == CLIENT_ALIAS) "111122223333" else "555566667777")
            .takeIf { status == AndroidPeerTrustStatusV1.ACTIVE }
    )

    private fun p256KeyPair(): KeyPair = KeyPairGenerator.getInstance("EC").run {
        initialize(ECGenParameterSpec(P256SpkiV2.CURVE_NAME))
        generateKeyPair()
    }

    private fun signP256(keys: KeyPair, message: ByteArray): ByteArray =
        Signature.getInstance(P256EcdsaSignatureV2.JCA_SIGNATURE_ALGORITHM).run {
            initSign(keys.private)
            update(message)
            P256EcdsaSignatureV2.derToCanonicalP1363(sign())
        }

    private fun sha256Hex(value: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(value).joinToString("") {
            "%02x".format(it.toInt() and 0xff)
        }

    private class MemoryTrustStore : AndroidPeerTrustStoreV1 {
        private var value: ByteArray? = null
        override fun read(): ByteArray? = value?.copyOf()
        override fun writeAtomically(value: ByteArray) {
            this.value?.fill(0)
            this.value = value.copyOf()
        }

        fun snapshot(): ByteArray = checkNotNull(value).copyOf()
    }

    private class VirtualRefreshScheduler : AndroidPeerTrustRefreshSchedulerV2 {
        private data class Task(
            val dueAtMs: Long,
            val order: Long,
            val action: () -> Unit,
            var cancelled: Boolean = false
        )

        private val tasks = PriorityQueue<Task>(
            compareBy<Task> { it.dueAtMs }.thenBy { it.order }
        )
        private var nextOrder = 0L
        var nowMs = 0L
            private set
        var closed = false
            private set
        val pendingTasks: Int
            get() = tasks.count { !it.cancelled }

        override fun schedule(
            delayMs: Long,
            action: () -> Unit
        ): AndroidPeerTrustScheduledRefreshCancellationV2? {
            if (closed) return null
            val task = Task(nowMs + delayMs, nextOrder++, action)
            tasks += task
            return AndroidPeerTrustScheduledRefreshCancellationV2 {
                task.cancelled = true
            }
        }

        fun advanceBy(deltaMs: Long) {
            require(deltaMs >= 0L)
            val target = nowMs + deltaMs
            while (true) {
                val next = tasks.peek() ?: break
                if (next.dueAtMs > target) break
                val task = tasks.remove()
                nowMs = task.dueAtMs
                if (!task.cancelled && !closed) task.action()
            }
            nowMs = target
        }

        override fun close() {
            closed = true
            tasks.forEach { it.cancelled = true }
            tasks.clear()
        }
    }

    private class LeaseTestRuntime : BluetoothReliableRuntimeLifecycleV1 {
        override fun start(): Boolean = true
        override fun suspendForLinkLoss() = Unit
    }

    private class LeaseTestPort : BluetoothReliableApplicationPortV1 {
        var resets = 0
        override val available: Boolean = true

        override fun send(
            input: ReliableChannelSendInputV1
        ): ReliableChannelSendResultV1 = error("not used")

        override fun restoreBound(): Int = 0

        override fun tick(): ReliableChannelTickResultV1 =
            ReliableChannelTickResultV1(0, 0, 0)

        override fun reset() {
            resets += 1
        }

        override fun snapshot(): BluetoothReliableApplicationPortSnapshotV1 =
            BluetoothReliableApplicationPortSnapshotV1(
                available = true,
                bound = true,
                publishedFragments = 0,
                receivedFragments = 0,
                failures = 0
            )
    }

    private class TestIdentity(private val keys: KeyPair) :
        BluetoothMutualAuthIdentityPort {
        override fun sign(message: ByteArray): DeviceSignatureResult =
            DeviceSignatureResult(DeviceIdentityStatus.READY, signP256Static(keys, message))

        override fun createAuthenticationMac(
            message: ByteArray
        ): DeviceAuthenticationMacResult =
            DeviceAuthenticationMacResult(DeviceIdentityStatus.CRYPTO_OPERATION_FAILED)

        override fun verifyAuthenticationMac(
            message: ByteArray,
            proof: ByteArray
        ): DeviceAuthenticationMacVerificationResult =
            DeviceAuthenticationMacVerificationResult(
                DeviceIdentityStatus.CRYPTO_OPERATION_FAILED
            )
    }

    companion object {
        private const val CLIENT_NODE =
            "11111111-1111-4111-8111-111111111111"
        private const val CLIENT_CERT =
            "22222222-2222-4222-8222-222222222222"
        private const val SERVER_NODE =
            "33333333-3333-4333-8333-333333333333"
        private const val SERVER_CERT =
            "44444444-4444-4444-8444-444444444444"
        private const val CLIENT_ALIAS = "001122334455"
        private const val SERVER_ALIAS = "8899aabbccdd"
        private const val ALIAS_EPOCH = 2_977_320L
        private const val SESSION_TOKEN = 17L
        private val NOW_MS = InstantFixture.parse("2026-08-18T12:00:00.000Z")

        private fun signP256Static(keys: KeyPair, message: ByteArray): ByteArray =
            Signature.getInstance(P256EcdsaSignatureV2.JCA_SIGNATURE_ALGORITHM)
                .run {
                    initSign(keys.private)
                    update(message)
                    P256EcdsaSignatureV2.derToCanonicalP1363(sign())
                }
    }
}

private object InstantFixture {
    fun parse(value: String): Long = java.time.Instant.parse(value).toEpochMilli()
}
