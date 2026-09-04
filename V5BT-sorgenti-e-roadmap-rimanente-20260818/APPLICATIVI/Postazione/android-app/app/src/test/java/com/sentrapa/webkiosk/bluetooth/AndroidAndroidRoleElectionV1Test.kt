package com.sentrapa.webkiosk.bluetooth

import java.io.File
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import org.json.JSONObject

class AndroidAndroidRoleElectionV1Test {
    @Test
    fun `Kotlin election and arbitration consume the common golden vectors`() {
        val golden = JSONObject(goldenFile().readText())
        assertEquals(1, golden.getInt("schemaVersion"))
        assertEquals(FULL_NODE_CAPABILITIES, golden.getInt("fullNodeCapabilities"))
        val roleCases = golden.getJSONArray("roleCases")
        for (index in 0 until roleCases.length()) {
            val vector = roleCases.getJSONObject(index)
            val decision = AndroidAndroidRoleElectionV1.elect(
                goldenCandidate(
                    vector.getString("localAlias"),
                    vector.getLong("localAliasEpoch"),
                    vector.getInt("localCapabilities")
                ),
                goldenCandidate(
                    vector.getString("remoteAlias"),
                    vector.getLong("remoteAliasEpoch"),
                    vector.getInt("remoteCapabilities")
                )
            )
            if (!vector.isNull("expectedError")) {
                assertEquals(
                    vector.getString("name"),
                    vector.getString("expectedError"),
                    decision.reason.name
                )
                assertEquals(AndroidAndroidGattRoleV1.REJECTED, decision.role)
            } else {
                assertEquals(
                    vector.getString("name"),
                    vector.getString("expectedLocalRole"),
                    decision.role.name
                )
                assertEquals(AndroidAndroidRoleReasonV1.NONE, decision.reason)
            }
        }

        val arbitrationCases = golden.getJSONArray("arbitrationCases")
        for (index in 0 until arbitrationCases.length()) {
            val vector = arbitrationCases.getJSONObject(index)
            val existingHex = vector.getString("existingConnectionIdHex")
            val candidateHex = vector.getString("candidateConnectionIdHex")
            val decision = AndroidDuplicateConnectionArbitratorV1.decide(
                session(
                    vector.getString("firstNodeId"),
                    vector.getString("secondNodeId"),
                    hexSessionId(existingHex)
                ),
                session(
                    vector.getString("secondNodeId"),
                    vector.getString("firstNodeId"),
                    hexSessionId(candidateHex)
                )
            )
            assertEquals(
                vector.getString("name"),
                vector.getString("expectedKotlinAction"),
                decision.action.name
            )
            assertEquals(
                vector.getString("name"),
                vector.getString("expectedKotlinReason"),
                decision.reason.name
            )
            val keptHex =
                if (decision.action == AndroidDuplicateConnectionActionV1.REPLACE_EXISTING) {
                    candidateHex
                } else {
                    existingHex
                }
            assertEquals(vector.getString("expectedKeepConnectionIdHex"), keptHex)
        }
    }

    @Test
    fun `lower alias is server and reciprocal decision is client`() {
        val lower = candidate(alias = "00000000000f")
        val higher = candidate(alias = "000000000010")

        assertEquals(
            AndroidAndroidRoleDecisionV1(
                AndroidAndroidGattRoleV1.SERVER,
                AndroidAndroidRoleReasonV1.NONE
            ),
            AndroidAndroidRoleElectionV1.elect(lower, higher)
        )
        assertEquals(
            AndroidAndroidRoleDecisionV1(
                AndroidAndroidGattRoleV1.CLIENT,
                AndroidAndroidRoleReasonV1.NONE
            ),
            AndroidAndroidRoleElectionV1.elect(higher, lower)
        )
    }

    @Test
    fun `aliases from different or invalid epochs are rejected`() {
        assertRejected(
            AndroidAndroidRoleReasonV1.EPOCH_MISMATCH,
            candidate(epoch = 20L),
            candidate(alias = "000000000002", epoch = 21L)
        )
        assertRejected(
            AndroidAndroidRoleReasonV1.INVALID_EPOCH,
            candidate(epoch = -1L),
            candidate(alias = "000000000002")
        )
    }

    @Test
    fun `alias collision and noncanonical alias fail closed`() {
        assertRejected(
            AndroidAndroidRoleReasonV1.ALIAS_COLLISION,
            candidate(alias = "aabbccddeeff"),
            candidate(alias = "aabbccddeeff")
        )
        assertRejected(
            AndroidAndroidRoleReasonV1.INVALID_ALIAS,
            candidate(alias = "AABBCCDDEEFF"),
            candidate(alias = "000000000002")
        )
        assertRejected(
            AndroidAndroidRoleReasonV1.INVALID_ALIAS,
            candidate(alias = "not-an-alias"),
            candidate(alias = "000000000002")
        )
    }

    @Test
    fun `CLIENT_ONLY and unsupported capability classes never elect a role`() {
        assertRejected(
            AndroidAndroidRoleReasonV1.CLIENT_ONLY_NOT_ELIGIBLE,
            candidate(nodeClass = BluetoothNodeClass.CLIENT_ONLY),
            candidate(alias = "000000000002")
        )
        assertRejected(
            AndroidAndroidRoleReasonV1.CLIENT_ONLY_NOT_ELIGIBLE,
            candidate(),
            candidate(
                alias = "000000000002",
                nodeClass = BluetoothNodeClass.CLIENT_ONLY
            )
        )
        assertRejected(
            AndroidAndroidRoleReasonV1.FULL_NODE_REQUIRED,
            candidate(nodeClass = BluetoothNodeClass.UNSUPPORTED),
            candidate(alias = "000000000002")
        )
    }

    @Test
    fun `Raspberry participants remain outside Android Android election`() {
        assertRejected(
            AndroidAndroidRoleReasonV1.NON_ANDROID_NODE,
            candidate(),
            candidate(
                alias = "000000000002",
                nodeKind = BluetoothAdvertisementNodeKind.RASPBERRY
            )
        )
    }

    @Test
    fun `A2 resolver role boundary accepts offline elected pair and rejects inversion`() {
        val client = offlineAdvertisement(
            BluetoothAdvertisementNodeKind.HANDHELD,
            "8899aabbccdd"
        )
        val server = offlineAdvertisement(
            BluetoothAdvertisementNodeKind.STATION,
            "001122334455"
        )
        requireAndroidPeerRoleElectionV2(client, server, 20L)

        assertThrows(IllegalArgumentException::class.java) {
            requireAndroidPeerRoleElectionV2(server, client, 20L)
        }
        assertThrows(IllegalArgumentException::class.java) {
            requireAndroidPeerRoleElectionV2(
                client,
                server.copy(rotatingAlias = client.rotatingAlias),
                20L
            )
        }
    }

    @Test
    fun `ordered node pair key is direction independent and validates identities`() {
        val forward = AndroidDirectNodePairKeyV1.fromOrNull(NODE_A, NODE_B)
        val reverse = AndroidDirectNodePairKeyV1.fromOrNull(NODE_B, NODE_A)
        val other = AndroidDirectNodePairKeyV1.fromOrNull(NODE_A, NODE_C)

        assertEquals(forward, reverse)
        assertNotEquals(forward, other)
        assertNull(AndroidDirectNodePairKeyV1.fromOrNull(NODE_A, NODE_A))
        assertNull(AndroidDirectNodePairKeyV1.fromOrNull(NODE_A.uppercase(), NODE_B))
    }

    @Test
    fun `duplicate arbitration retains the numerically lower session id`() {
        val low = sessionId(1)
        val high = sessionId(2)
        val existing = session(NODE_A, NODE_B, high)
        val candidate = session(NODE_B, NODE_A, low)

        assertEquals(
            AndroidDuplicateConnectionDecisionV1(
                AndroidDuplicateConnectionActionV1.REPLACE_EXISTING,
                AndroidDuplicateConnectionReasonV1.LOWER_SESSION_ID
            ),
            AndroidDuplicateConnectionArbitratorV1.decide(existing, candidate)
        )
        assertEquals(
            AndroidDuplicateConnectionDecisionV1(
                AndroidDuplicateConnectionActionV1.KEEP_EXISTING,
                AndroidDuplicateConnectionReasonV1.LOWER_SESSION_ID
            ),
            AndroidDuplicateConnectionArbitratorV1.decide(candidate, existing)
        )
    }

    @Test
    fun `duplicate arbitration is idempotent and rejects unrelated or invalid candidates`() {
        val existing = session(NODE_A, NODE_B, sessionId(1))
        assertEquals(
            AndroidDuplicateConnectionDecisionV1(
                AndroidDuplicateConnectionActionV1.KEEP_EXISTING,
                AndroidDuplicateConnectionReasonV1.SAME_SESSION
            ),
            AndroidDuplicateConnectionArbitratorV1.decide(
                existing,
                existing.copy(localNodeId = NODE_B, remoteNodeId = NODE_A)
            )
        )
        assertEquals(
            AndroidDuplicateConnectionReasonV1.NODE_PAIR_MISMATCH,
            AndroidDuplicateConnectionArbitratorV1.decide(
                existing,
                session(NODE_A, NODE_C, sessionId(2))
            ).reason
        )
        assertEquals(
            AndroidDuplicateConnectionReasonV1.INVALID_SESSION_ID,
            AndroidDuplicateConnectionArbitratorV1.decide(
                existing,
                session(NODE_A, NODE_B, "invalid")
            ).reason
        )
        assertEquals(
            AndroidDuplicateConnectionActionV1.REJECT_CANDIDATE,
            AndroidDuplicateConnectionArbitratorV1.decide(
                existing,
                session(NODE_A, NODE_B, "invalid")
            ).action
        )
    }

    private fun candidate(
        alias: String = "000000000001",
        epoch: Long = 20L,
        nodeClass: BluetoothNodeClass = BluetoothNodeClass.FULL_NODE,
        nodeKind: BluetoothAdvertisementNodeKind = BluetoothAdvertisementNodeKind.HANDHELD
    ) = AndroidAndroidRoleCandidateV1(nodeKind, nodeClass, alias, epoch)

    private fun offlineAdvertisement(
        kind: BluetoothAdvertisementNodeKind,
        alias: String
    ) = BluetoothAdvertisementV1(
        protocolVersion = BluetoothAdvertisementCodecV1.PROTOCOL_VERSION,
        nodeKind = kind,
        rotatingAlias = alias,
        bootId = 1,
        capabilities = BluetoothCapabilityBitsV1.B2_FULL_NODE,
        serverReachable = false,
        sequence = 1
    )

    private fun session(
        localNodeId: String,
        remoteNodeId: String,
        sessionId: String
    ) = AndroidDirectSessionCandidateV1(localNodeId, remoteNodeId, sessionId)

    private fun sessionId(fill: Int): String =
        BluetoothHelloCodecV1.generateSessionId { length ->
            ByteArray(length) { fill.toByte() }
        }

    private fun goldenCandidate(
        alias: String,
        epoch: Long,
        capabilities: Int
    ): AndroidAndroidRoleCandidateV1 = candidate(
        alias = alias,
        epoch = epoch,
        nodeClass =
            when (capabilities) {
                FULL_NODE_CAPABILITIES -> BluetoothNodeClass.FULL_NODE
                CLIENT_ONLY_CAPABILITIES -> BluetoothNodeClass.CLIENT_ONLY
                else -> BluetoothNodeClass.UNSUPPORTED
            }
    )

    private fun hexSessionId(value: String): String {
        require(Regex("^[0-9a-f]{32}$").matches(value))
        val bytes = ByteArray(value.length / 2) { index ->
            value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
        return try {
            Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        } finally {
            bytes.fill(0)
        }
    }

    private fun goldenFile(): File {
        val relative =
            "ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/" +
                "contracts/golden-vectors/android-peer-role-election-v1.json"
        return listOf(
            File("../../../$relative"),
            File("../../../../$relative")
        ).firstOrNull(File::isFile)
            ?: error("common Android peer role golden vector is missing")
    }

    private fun assertRejected(
        reason: AndroidAndroidRoleReasonV1,
        local: AndroidAndroidRoleCandidateV1,
        remote: AndroidAndroidRoleCandidateV1
    ) {
        assertEquals(
            AndroidAndroidRoleDecisionV1(AndroidAndroidGattRoleV1.REJECTED, reason),
            AndroidAndroidRoleElectionV1.elect(local, remote)
        )
    }

    companion object {
        private const val FULL_NODE_CAPABILITIES = 0x0f
        private const val CLIENT_ONLY_CAPABILITIES = 0x05
        private const val NODE_A = "123e4567-e89b-12d3-a456-426614174000"
        private const val NODE_B = "550e8400-e29b-41d4-a716-446655440000"
        private const val NODE_C = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
    }
}
