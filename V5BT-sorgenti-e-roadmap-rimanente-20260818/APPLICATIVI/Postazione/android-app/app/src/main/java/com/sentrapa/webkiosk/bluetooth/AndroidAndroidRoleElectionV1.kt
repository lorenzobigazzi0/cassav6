package com.sentrapa.webkiosk.bluetooth

import java.security.MessageDigest

enum class AndroidAndroidGattRoleV1 {
    SERVER,
    CLIENT,
    REJECTED
}

enum class AndroidAndroidRoleReasonV1 {
    NONE,
    NON_ANDROID_NODE,
    CLIENT_ONLY_NOT_ELIGIBLE,
    FULL_NODE_REQUIRED,
    INVALID_EPOCH,
    EPOCH_MISMATCH,
    INVALID_ALIAS,
    ALIAS_COLLISION
}

data class AndroidAndroidRoleCandidateV1(
    val nodeKind: BluetoothAdvertisementNodeKind,
    val nodeClass: BluetoothNodeClass,
    val rotatingAlias: String,
    val aliasEpoch: Long
)

data class AndroidAndroidRoleDecisionV1(
    val role: AndroidAndroidGattRoleV1,
    val reason: AndroidAndroidRoleReasonV1
)

object AndroidAndroidRoleElectionV1 {
    private val aliasPattern = Regex("^[0-9a-f]{12}$")

    fun elect(
        local: AndroidAndroidRoleCandidateV1,
        remote: AndroidAndroidRoleCandidateV1
    ): AndroidAndroidRoleDecisionV1 {
        if (
            local.nodeKind == BluetoothAdvertisementNodeKind.RASPBERRY ||
            remote.nodeKind == BluetoothAdvertisementNodeKind.RASPBERRY
        ) {
            return rejected(AndroidAndroidRoleReasonV1.NON_ANDROID_NODE)
        }
        if (
            local.nodeClass == BluetoothNodeClass.CLIENT_ONLY ||
            remote.nodeClass == BluetoothNodeClass.CLIENT_ONLY
        ) {
            return rejected(AndroidAndroidRoleReasonV1.CLIENT_ONLY_NOT_ELIGIBLE)
        }
        if (
            local.nodeClass != BluetoothNodeClass.FULL_NODE ||
            remote.nodeClass != BluetoothNodeClass.FULL_NODE
        ) {
            return rejected(AndroidAndroidRoleReasonV1.FULL_NODE_REQUIRED)
        }
        if (local.aliasEpoch < 0L || remote.aliasEpoch < 0L) {
            return rejected(AndroidAndroidRoleReasonV1.INVALID_EPOCH)
        }
        if (local.aliasEpoch != remote.aliasEpoch) {
            return rejected(AndroidAndroidRoleReasonV1.EPOCH_MISMATCH)
        }
        if (
            !aliasPattern.matches(local.rotatingAlias) ||
            !aliasPattern.matches(remote.rotatingAlias)
        ) {
            return rejected(AndroidAndroidRoleReasonV1.INVALID_ALIAS)
        }
        val localAlias = local.rotatingAlias.toLongOrNull(16)
        val remoteAlias = remote.rotatingAlias.toLongOrNull(16)
        if (localAlias == null || remoteAlias == null) {
            return rejected(AndroidAndroidRoleReasonV1.INVALID_ALIAS)
        }
        if (localAlias == remoteAlias) {
            return rejected(AndroidAndroidRoleReasonV1.ALIAS_COLLISION)
        }
        return AndroidAndroidRoleDecisionV1(
            role =
                if (localAlias < remoteAlias) {
                    AndroidAndroidGattRoleV1.SERVER
                } else {
                    AndroidAndroidGattRoleV1.CLIENT
                },
            reason = AndroidAndroidRoleReasonV1.NONE
        )
    }

    private fun rejected(reason: AndroidAndroidRoleReasonV1) =
        AndroidAndroidRoleDecisionV1(
            role = AndroidAndroidGattRoleV1.REJECTED,
            reason = reason
        )
}

class AndroidDirectNodePairKeyV1 private constructor(pairDigest: ByteArray) {
    private val pairDigest = pairDigest.copyOf()

    override fun equals(other: Any?): Boolean =
        other is AndroidDirectNodePairKeyV1 &&
            MessageDigest.isEqual(pairDigest, other.pairDigest)

    override fun hashCode(): Int = pairDigest.contentHashCode()

    companion object {
        private const val CONTEXT = "V5BT-ANDROID-NODE-PAIR-V1\u0000"

        fun fromOrNull(
            firstNodeId: String,
            secondNodeId: String
        ): AndroidDirectNodePairKeyV1? {
            if (
                !RotatingAliasV1.isCanonicalNodeId(firstNodeId) ||
                !RotatingAliasV1.isCanonicalNodeId(secondNodeId) ||
                firstNodeId == secondNodeId
            ) {
                return null
            }
            val lower = minOf(firstNodeId, secondNodeId)
            val upper = maxOf(firstNodeId, secondNodeId)
            val material = "$CONTEXT$lower\u0000$upper".toByteArray(Charsets.UTF_8)
            val digest = try {
                MessageDigest.getInstance("SHA-256").digest(material)
            } finally {
                material.fill(0)
            }
            return try {
                AndroidDirectNodePairKeyV1(digest)
            } finally {
                digest.fill(0)
            }
        }
    }
}

data class AndroidDirectSessionCandidateV1(
    val localNodeId: String,
    val remoteNodeId: String,
    val sessionId: String
)

enum class AndroidDuplicateConnectionActionV1 {
    KEEP_EXISTING,
    REPLACE_EXISTING,
    REJECT_CANDIDATE
}

enum class AndroidDuplicateConnectionReasonV1 {
    SAME_SESSION,
    LOWER_SESSION_ID,
    INVALID_NODE_PAIR,
    NODE_PAIR_MISMATCH,
    INVALID_SESSION_ID
}

data class AndroidDuplicateConnectionDecisionV1(
    val action: AndroidDuplicateConnectionActionV1,
    val reason: AndroidDuplicateConnectionReasonV1
)

object AndroidDuplicateConnectionArbitratorV1 {
    fun decide(
        existing: AndroidDirectSessionCandidateV1,
        candidate: AndroidDirectSessionCandidateV1
    ): AndroidDuplicateConnectionDecisionV1 {
        val existingPair = AndroidDirectNodePairKeyV1.fromOrNull(
            existing.localNodeId,
            existing.remoteNodeId
        ) ?: return reject(AndroidDuplicateConnectionReasonV1.INVALID_NODE_PAIR)
        val candidatePair = AndroidDirectNodePairKeyV1.fromOrNull(
            candidate.localNodeId,
            candidate.remoteNodeId
        ) ?: return reject(AndroidDuplicateConnectionReasonV1.INVALID_NODE_PAIR)
        if (existingPair != candidatePair) {
            return reject(AndroidDuplicateConnectionReasonV1.NODE_PAIR_MISMATCH)
        }

        val existingSession = decodeSessionId(existing.sessionId)
            ?: return reject(AndroidDuplicateConnectionReasonV1.INVALID_SESSION_ID)
        val candidateSession = decodeSessionId(candidate.sessionId)
            ?: run {
                existingSession.fill(0)
                return reject(AndroidDuplicateConnectionReasonV1.INVALID_SESSION_ID)
            }
        return try {
            when (compareUnsigned(existingSession, candidateSession)) {
                0 -> AndroidDuplicateConnectionDecisionV1(
                    AndroidDuplicateConnectionActionV1.KEEP_EXISTING,
                    AndroidDuplicateConnectionReasonV1.SAME_SESSION
                )
                in Int.MIN_VALUE until 0 -> AndroidDuplicateConnectionDecisionV1(
                    AndroidDuplicateConnectionActionV1.KEEP_EXISTING,
                    AndroidDuplicateConnectionReasonV1.LOWER_SESSION_ID
                )
                else -> AndroidDuplicateConnectionDecisionV1(
                    AndroidDuplicateConnectionActionV1.REPLACE_EXISTING,
                    AndroidDuplicateConnectionReasonV1.LOWER_SESSION_ID
                )
            }
        } finally {
            existingSession.fill(0)
            candidateSession.fill(0)
        }
    }

    private fun decodeSessionId(value: String): ByteArray? =
        runCatching {
            BluetoothHelloCodecV1.canonicalIdentifierBytes(value, "sessionId")
        }.getOrNull()

    private fun compareUnsigned(first: ByteArray, second: ByteArray): Int {
        require(first.size == second.size)
        for (index in first.indices) {
            val difference =
                (first[index].toInt() and 0xff) -
                    (second[index].toInt() and 0xff)
            if (difference != 0) return difference
        }
        return 0
    }

    private fun reject(reason: AndroidDuplicateConnectionReasonV1) =
        AndroidDuplicateConnectionDecisionV1(
            AndroidDuplicateConnectionActionV1.REJECT_CANDIDATE,
            reason
        )
}
