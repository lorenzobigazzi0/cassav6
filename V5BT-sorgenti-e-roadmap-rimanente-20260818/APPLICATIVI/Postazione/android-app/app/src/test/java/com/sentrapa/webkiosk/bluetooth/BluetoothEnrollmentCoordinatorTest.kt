package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothEnrollmentCoordinatorTest {
    @Test
    fun `pipeline performs strict parse claim network and import once`() {
        val identity = FakeIdentity()
        val network = FakeNetwork()
        val result = pipeline(identity, network).process(validQr())

        assertEquals(BluetoothEnrollmentAttemptStatus.READY, result.status)
        assertEquals(DeviceIdentityStatus.READY, result.identityStatus)
        assertEquals(1, identity.claimCalls)
        assertEquals(1, identity.importCalls)
        assertEquals(1, network.calls)
    }

    @Test
    fun `invalid or mismatched QR never reaches identity or network`() {
        val identity = FakeIdentity()
        val network = FakeNetwork()
        val invalid = validQr().decodeToString()
            .replace("\"token\":\"$TOKEN\"", "\"token\":\"bad\"")
            .encodeToByteArray()
        assertEquals(
            BluetoothEnrollmentAttemptStatus.INPUT_INVALID,
            pipeline(identity, network).process(invalid).status
        )
        val mismatched = validQr().decodeToString()
            .replace(ENDPOINT_ID, "other-endpoint")
            .encodeToByteArray()
        assertEquals(
            BluetoothEnrollmentAttemptStatus.ENDPOINT_MISMATCH,
            pipeline(identity, network).process(mismatched).status
        )
        assertEquals(0, identity.claimCalls)
        assertEquals(0, network.calls)
    }

    @Test
    fun `already ready identity is not reported as a fresh enrollment`() {
        val identity = FakeIdentity(
            inspectStatus = DeviceIdentityStatus.READY
        )
        val network = FakeNetwork()
        val result = pipeline(identity, network).process(validQr())

        assertEquals(
            BluetoothEnrollmentAttemptStatus.ALREADY_PROVISIONED,
            result.status
        )
        assertEquals(0, identity.claimCalls)
        assertEquals(0, network.calls)
    }

    @Test
    fun `closed publication gate keeps CLOSED terminal and suppresses callback`() {
        val gate = BluetoothEnrollmentPublicationGate()
        var status = BluetoothEnrollmentAttemptStatus.IDLE
        var callbackCount = 0

        assertTrue(
            gate.close {
                status = BluetoothEnrollmentAttemptStatus.CLOSED
            }
        )
        assertFalse(
            gate.ifOpen {
                status = BluetoothEnrollmentAttemptStatus.READY
                callbackCount += 1
            }
        )
        assertEquals(BluetoothEnrollmentAttemptStatus.CLOSED, status)
        assertEquals(0, callbackCount)
        assertTrue(gate.isClosed)
    }

    @Test
    fun `recoverable pending identity retries the exact staged request`() {
        val identity = FakeIdentity(
            inspectStatus = DeviceIdentityStatus.ENROLLMENT_PENDING
        )
        val network = FakeNetwork()
        val result = pipeline(identity, network).process(validQr())

        assertEquals(BluetoothEnrollmentAttemptStatus.READY, result.status)
        assertEquals(DeviceIdentityStatus.READY, result.identityStatus)
        assertEquals(1, identity.claimCalls)
        assertEquals(1, identity.importCalls)
        assertEquals(1, network.calls)
    }

    @Test
    fun `identity client and import failures stay distinct and redacted`() {
        val identityFailure = FakeIdentity(
            claimResult = BluetoothEnrollmentClaimResult.Failure(
                DeviceIdentityStatus.ED25519_UNSUPPORTED
            )
        )
        val identityResult =
            pipeline(identityFailure, FakeNetwork()).process(validQr())
        assertEquals(
            BluetoothEnrollmentAttemptStatus.IDENTITY_FAILED,
            identityResult.status
        )
        assertEquals(
            DeviceIdentityStatus.ED25519_UNSUPPORTED,
            identityResult.identityStatus
        )

        val clientFailure = BluetoothEnrollmentAttempt(
            status = BluetoothEnrollmentAttemptStatus.CLIENT_FAILED,
            clientStatus =
                BluetoothEnrollmentClientStatus.TLS_AUTHENTICATION_FAILED,
            httpStatus = 403
        )
        val networkResult = pipeline(
            FakeIdentity(),
            FakeNetwork(
                BluetoothEnrollmentClientResult.Failure(
                    BluetoothEnrollmentClientStatus.TLS_AUTHENTICATION_FAILED,
                    httpStatus = 403
                )
            )
        ).process(validQr())
        assertEquals(clientFailure, networkResult)

        val importResult = pipeline(
            FakeIdentity(importStatus = DeviceIdentityStatus.ENROLLMENT_RESPONSE_INVALID),
            FakeNetwork()
        ).process(validQr())
        assertEquals(
            BluetoothEnrollmentAttemptStatus.IMPORT_FAILED,
            importResult.status
        )
        val json = importResult.toRedactedJson()
        assertFalse(json.contains(TOKEN))
        assertFalse(json.contains(NODE_ID))
        assertFalse(json.contains(ALIAS_KEY))
        assertTrue(json.contains("ENROLLMENT_RESPONSE_INVALID"))

        val storageJson = BluetoothEnrollmentAttempt(
            BluetoothEnrollmentAttemptStatus.STORAGE_FAILED
        ).toRedactedJson()
        assertTrue(storageJson.contains("\"status\":\"STORAGE_FAILED\""))
        assertFalse(storageJson.contains(TOKEN))
    }

    @Test
    fun `all crash points retain the only processing handle for recovery`() {
        val crashPoints = linkedMapOf(
            "before POST" to BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.INTERRUPTED
            ),
            "server commit before response" to BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.CLIENT_FAILED,
                clientStatus = BluetoothEnrollmentClientStatus.NETWORK_FAILED
            ),
            "response before pending binding" to BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.IMPORT_FAILED,
                identityStatus = DeviceIdentityStatus.STORAGE_ERROR
            ),
            "pending before HMAC import" to BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.IMPORT_FAILED,
                identityStatus = DeviceIdentityStatus.ALIAS_KEY_IMPORT_FAILED
            ),
            "HMAC import before READY" to BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.IMPORT_FAILED,
                identityStatus = DeviceIdentityStatus.ENROLLMENT_PENDING
            ),
            "close" to BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.CLOSED
            )
        )

        crashPoints.forEach { (point, attempt) ->
            assertEquals(
                point,
                BluetoothEnrollmentRecoveryDisposition.RETAIN,
                BluetoothEnrollmentRecoveryPolicy.disposition(attempt)
            )
        }
    }

    @Test
    fun `only persisted success consumes while terminal rejects quarantine`() {
        listOf(
            BluetoothEnrollmentAttempt(BluetoothEnrollmentAttemptStatus.READY),
            BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.ALREADY_PROVISIONED
            )
        ).forEach { attempt ->
            assertEquals(
                BluetoothEnrollmentRecoveryDisposition.CONSUME,
                BluetoothEnrollmentRecoveryPolicy.disposition(attempt)
            )
        }
        listOf(
            BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.INPUT_INVALID
            ),
            BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.ENDPOINT_MISMATCH
            ),
            BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.IDENTITY_FAILED,
                identityStatus =
                    DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH
            ),
            BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.IDENTITY_FAILED,
                identityStatus = DeviceIdentityStatus.NODE_ID_INVALID
            )
        ).forEach { attempt ->
            assertEquals(
                BluetoothEnrollmentRecoveryDisposition.QUARANTINE,
                BluetoothEnrollmentRecoveryPolicy.disposition(attempt)
            )
        }
        assertEquals(
            BluetoothEnrollmentRecoveryDisposition.RETAIN,
            BluetoothEnrollmentRecoveryPolicy.disposition(
                BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.CLIENT_FAILED,
                    clientStatus = BluetoothEnrollmentClientStatus.HTTP_REJECTED,
                    httpStatus = 503
                )
            )
        )
        listOf(
            BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.CLIENT_FAILED,
                clientStatus = BluetoothEnrollmentClientStatus.NETWORK_FAILED
            ),
            BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.CLIENT_FAILED,
                clientStatus =
                    BluetoothEnrollmentClientStatus.TLS_AUTHENTICATION_FAILED
            ),
            BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.CLIENT_FAILED,
                clientStatus = BluetoothEnrollmentClientStatus.HTTP_REJECTED,
                httpStatus = 500
            )
        ).forEach { attempt ->
            assertEquals(
                BluetoothEnrollmentRecoveryDisposition.RETAIN,
                BluetoothEnrollmentRecoveryPolicy.disposition(attempt)
            )
        }
        assertEquals(
            BluetoothEnrollmentRecoveryDisposition.QUARANTINE,
            BluetoothEnrollmentRecoveryPolicy.disposition(
                BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.CLIENT_FAILED,
                    clientStatus = BluetoothEnrollmentClientStatus.HTTP_REJECTED,
                    httpStatus = 403
                )
            )
        )
        listOf(
            DeviceIdentityStatus.ANDROID_KEYSTORE_UNAVAILABLE,
            DeviceIdentityStatus.STORAGE_ERROR,
            DeviceIdentityStatus.PROVISIONING_FAILED,
            DeviceIdentityStatus.CRYPTO_OPERATION_FAILED
        ).forEach { identityStatus ->
            assertEquals(
                BluetoothEnrollmentRecoveryDisposition.RETAIN,
                BluetoothEnrollmentRecoveryPolicy.disposition(
                    BluetoothEnrollmentAttempt(
                        BluetoothEnrollmentAttemptStatus.IDENTITY_FAILED,
                        identityStatus = identityStatus
                    )
                )
            )
        }
    }

    @Test
    fun `recovery window permissions links and bounded size fail closed`() {
        val now = 20_000_000L
        assertTrue(
            BluetoothEnrollmentRecoveryPolicy.isWithinRecoveryWindow(
                now,
                now - BluetoothEnrollmentRecoveryPolicy.RECOVERY_WINDOW_MILLIS
            )
        )
        val claimedAt = 10_000_000L
        val responseLostAfterPreCommitDelay =
            claimedAt +
                BluetoothEnrollmentRecoveryPolicy.TOKEN_VALIDITY_BUDGET_MILLIS +
                BluetoothEnrollmentRecoveryPolicy.SERVER_RECOVERY_WINDOW_MILLIS
        assertTrue(
            BluetoothEnrollmentRecoveryPolicy.isWithinRecoveryWindow(
                responseLostAfterPreCommitDelay,
                claimedAt
            )
        )
        assertFalse(
            BluetoothEnrollmentRecoveryPolicy.isWithinRecoveryWindow(
                now,
                now - BluetoothEnrollmentRecoveryPolicy.RECOVERY_WINDOW_MILLIS - 1
            )
        )
        assertFalse(
            BluetoothEnrollmentRecoveryPolicy.isWithinRecoveryWindow(
                now,
                now + 1
            )
        )
        assertTrue(
            BluetoothEnrollmentRecoveryPolicy.isSecureFile(
                isRegularFile = true,
                linkCount = 1,
                permissionBits = 0x180,
                byteCount = 512
            )
        )
        listOf(
            arrayOf(false, 1L, 0x180, 10L),
            arrayOf(true, 2L, 0x180, 10L),
            arrayOf(true, 1L, 0x1a0, 10L),
            arrayOf(true, 1L, 0x180, 0L),
            arrayOf(true, 1L, 0x180, 513L)
        ).forEach { values ->
            assertFalse(
                BluetoothEnrollmentRecoveryPolicy.isSecureFile(
                    isRegularFile = values[0] as Boolean,
                    linkCount = values[1] as Long,
                    permissionBits = values[2] as Int,
                    byteCount = values[3] as Long
                )
            )
        }
    }

    @Test
    fun `single flight rejects duplicate refresh until completion`() {
        val gate = BluetoothEnrollmentSingleFlightGate()
        assertTrue(gate.tryStart())
        assertFalse(gate.tryStart())
        gate.finish()
        assertTrue(gate.tryStart())
        gate.finish()
    }

    @Test
    fun `claim durability syncs source and target around atomic rename`() {
        val events = mutableListOf<String>()

        val committed = BluetoothEnrollmentClaimDurability.commit(
            syncSource = { events += "sync-source"; true },
            rename = { events += "rename"; true },
            stampTarget = { events += "stamp-target"; true },
            restrictTarget = { events += "restrict-target"; true },
            syncTarget = { events += "sync-target"; true },
            syncDirectory = { events += "sync-directory"; true }
        )

        assertTrue(committed)
        assertEquals(
            listOf(
                "sync-source",
                "rename",
                "stamp-target",
                "restrict-target",
                "sync-target",
                "sync-directory"
            ),
            events
        )
    }

    @Test
    fun `claim durability fails closed before rename when source fsync fails`() {
        val events = mutableListOf<String>()

        val committed = BluetoothEnrollmentClaimDurability.commit(
            syncSource = { events += "sync-source"; false },
            rename = { events += "rename"; true },
            stampTarget = { events += "stamp-target"; true },
            restrictTarget = { events += "restrict-target"; true },
            syncTarget = { events += "sync-target"; true },
            syncDirectory = { events += "sync-directory"; true }
        )

        assertFalse(committed)
        assertEquals(listOf("sync-source"), events)
    }

    @Test
    fun `claim durability reports post-rename sync failure without continuing`() {
        val events = mutableListOf<String>()

        val committed = BluetoothEnrollmentClaimDurability.commit(
            syncSource = { events += "sync-source"; true },
            rename = { events += "rename"; true },
            stampTarget = { events += "stamp-target"; true },
            restrictTarget = { events += "restrict-target"; true },
            syncTarget = { events += "sync-target"; false },
            syncDirectory = { events += "sync-directory"; true }
        )

        assertFalse(committed)
        assertEquals(
            listOf(
                "sync-source",
                "rename",
                "stamp-target",
                "restrict-target",
                "sync-target"
            ),
            events
        )
    }

    private fun pipeline(
        identity: FakeIdentity,
        network: FakeNetwork
    ) = BluetoothEnrollmentPipeline(ENDPOINT_ID, identity, network)

    private fun validQr(): ByteArray =
        (
            "{\"version\":1,\"enrollmentEndpointId\":\"$ENDPOINT_ID\"," +
                "\"token\":\"$TOKEN\"}"
            ).encodeToByteArray()

    private class FakeIdentity(
        private val inspectStatus: DeviceIdentityStatus =
            DeviceIdentityStatus.ALIAS_KEY_UNPROVISIONED,
        private val claimResult: BluetoothEnrollmentClaimResult =
            BluetoothEnrollmentClaimResult.Ready(REQUEST),
        private val importStatus: DeviceIdentityStatus =
            DeviceIdentityStatus.READY
    ) : BluetoothEnrollmentIdentityPort {
        var claimCalls = 0
        var importCalls = 0

        override fun inspect(): DeviceIdentityReport =
            DeviceIdentityReport(enabled = true, status = inspectStatus)

        override fun createClaim(
            qr: BluetoothEnrollmentQrV1
        ): BluetoothEnrollmentClaimResult {
            claimCalls += 1
            return claimResult
        }

        override fun importResponse(
            fields: Map<String, Any?>
        ): DeviceIdentityReport {
            importCalls += 1
            return DeviceIdentityReport(enabled = true, status = importStatus)
        }
    }

    private class FakeNetwork(
        private val result: BluetoothEnrollmentClientResult =
            BluetoothEnrollmentClientResult.Ready(RESPONSE)
    ) : BluetoothEnrollmentNetworkPort {
        var calls = 0

        override fun enroll(
            request: BluetoothEnrollmentRequestV1
        ): BluetoothEnrollmentClientResult {
            calls += 1
            return result
        }
    }

    companion object {
        private const val ENDPOINT_ID = "raspberry-lab-v5bt"
        private const val TOKEN =
            "c5e1_SkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSko"
        private const val NODE_ID = "550e8400-e29b-41d4-a716-446655440000"
        private const val PUBLIC_KEY_SPKI =
            "MCowBQYDK2VwAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
        private const val ALIAS_KEY =
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        private val REQUEST = BluetoothEnrollmentRequestV1(
            protocolVersion = 1,
            enrollmentEndpointId = ENDPOINT_ID,
            token = TOKEN,
            nodeId = NODE_ID,
            publicKeySpkiDerBase64 = PUBLIC_KEY_SPKI,
            proofSignatureBase64 = "A".repeat(86) + "=="
        )
        private val RESPONSE = linkedMapOf<String, Any?>(
            "protocolVersion" to 1,
            "nodeId" to NODE_ID,
            "certificateId" to
                "123e4567-e89b-42d3-a456-426614174000",
            "publicKeyAlgorithm" to "Ed25519",
            "publicKeySpkiDerBase64" to PUBLIC_KEY_SPKI,
            "aliasKeyAlgorithm" to "HMAC-SHA256",
            "aliasKeyEncoding" to "base64url-unpadded",
            "aliasKeyBase64url" to ALIAS_KEY,
            "enrolledAt" to "2026-07-19T16:00:00.000Z"
        )
    }
}
