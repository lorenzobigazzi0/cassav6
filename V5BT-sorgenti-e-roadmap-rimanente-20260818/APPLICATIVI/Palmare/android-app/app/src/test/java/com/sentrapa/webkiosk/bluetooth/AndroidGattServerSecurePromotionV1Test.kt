package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidGattServerSecurePromotionV1Test {
    @Test
    fun `default boundary cannot promote a HELLO session`() {
        assertDecision(
            AndroidGattServerSecureSessionStateV1.BLOCKED,
            AndroidGattServerSecureBlockerV1.PEER_TRUST_UNAVAILABLE,
            AndroidGattServerSecurePromotionBoundaryV1().evaluate(pair(), ready())
        )
    }

    @Test
    fun `missing pair and trust rejection fail closed before protocol readiness`() {
        val trusted = boundary(AndroidGattServerPeerTrustStatusV1.TRUSTED)
        assertDecision(
            AndroidGattServerSecureSessionStateV1.BLOCKED,
            AndroidGattServerSecureBlockerV1.NODE_PAIR_UNAVAILABLE,
            trusted.evaluate(null, ready())
        )
        assertDecision(
            AndroidGattServerSecureSessionStateV1.BLOCKED,
            AndroidGattServerSecureBlockerV1.PEER_TRUST_REJECTED,
            boundary(AndroidGattServerPeerTrustStatusV1.REJECTED).evaluate(
                pair(),
                ready()
            )
        )
    }

    @Test
    fun `trust resolver failure is indistinguishable from unavailable trust`() {
        val boundary = AndroidGattServerSecurePromotionBoundaryV1 {
            error("registry unavailable")
        }
        assertDecision(
            AndroidGattServerSecureSessionStateV1.BLOCKED,
            AndroidGattServerSecureBlockerV1.PEER_TRUST_UNAVAILABLE,
            boundary.evaluate(pair(), ready())
        )
    }

    @Test
    fun `every secure transport prerequisite is mandatory in order`() {
        val boundary = boundary(AndroidGattServerPeerTrustStatusV1.TRUSTED)
        val cases = listOf(
            ready().copy(mutualAuthenticationComplete = false) to
                AndroidGattServerSecureBlockerV1.MUTUAL_AUTHENTICATION_INCOMPLETE,
            ready().copy(directControlKeysAvailable = false) to
                AndroidGattServerSecureBlockerV1.DIRECT_CONTROL_KEYS_UNAVAILABLE,
            ready().copy(reliableChannelAttached = false) to
                AndroidGattServerSecureBlockerV1.RELIABLE_CHANNEL_UNATTACHED,
            ready().copy(durableStoreAttached = false) to
                AndroidGattServerSecureBlockerV1.DURABLE_STORE_UNATTACHED
        )

        cases.forEach { (readiness, blocker) ->
            assertDecision(
                AndroidGattServerSecureSessionStateV1.BLOCKED,
                blocker,
                boundary.evaluate(pair(), readiness)
            )
        }
    }

    @Test
    fun `only provisioned trust and complete secure transport promote ACTIVE`() {
        assertDecision(
            AndroidGattServerSecureSessionStateV1.ACTIVE,
            AndroidGattServerSecureBlockerV1.NONE,
            boundary(AndroidGattServerPeerTrustStatusV1.TRUSTED).evaluate(
                pair(),
                ready()
            )
        )
    }

    private fun boundary(status: AndroidGattServerPeerTrustStatusV1) =
        AndroidGattServerSecurePromotionBoundaryV1 { status }

    private fun pair() = requireNotNull(
        AndroidDirectNodePairKeyV1.fromOrNull(NODE_A, NODE_B)
    )

    private fun ready() = AndroidGattServerSecureReadinessV1(
        mutualAuthenticationComplete = true,
        directControlKeysAvailable = true,
        reliableChannelAttached = true,
        durableStoreAttached = true
    )

    private fun assertDecision(
        state: AndroidGattServerSecureSessionStateV1,
        blocker: AndroidGattServerSecureBlockerV1,
        actual: AndroidGattServerSecurePromotionDecisionV1
    ) {
        assertEquals(state, actual.state)
        assertEquals(blocker, actual.blocker)
    }

    companion object {
        private const val NODE_A = "123e4567-e89b-12d3-a456-426614174000"
        private const val NODE_B = "550e8400-e29b-41d4-a716-446655440000"
    }
}
