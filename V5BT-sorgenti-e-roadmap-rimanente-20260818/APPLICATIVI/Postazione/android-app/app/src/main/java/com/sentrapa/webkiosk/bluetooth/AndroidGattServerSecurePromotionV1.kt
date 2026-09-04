package com.sentrapa.webkiosk.bluetooth

enum class AndroidGattServerPeerTrustStatusV1 {
    UNAVAILABLE,
    REJECTED,
    TRUSTED
}

fun interface AndroidGattServerPeerTrustPortV1 {
    /**
     * Implementations must resolve this opaque pair through independently provisioned trust.
     * Local enrollment material alone is not peer trust.
     */
    fun statusFor(nodePair: AndroidDirectNodePairKeyV1): AndroidGattServerPeerTrustStatusV1
}

object UnavailableAndroidGattServerPeerTrustPortV1 :
    AndroidGattServerPeerTrustPortV1 {
    override fun statusFor(
        nodePair: AndroidDirectNodePairKeyV1
    ): AndroidGattServerPeerTrustStatusV1 =
        AndroidGattServerPeerTrustStatusV1.UNAVAILABLE
}

data class AndroidGattServerSecureReadinessV1(
    val mutualAuthenticationComplete: Boolean,
    val directControlKeysAvailable: Boolean,
    val reliableChannelAttached: Boolean,
    val durableStoreAttached: Boolean
)

enum class AndroidGattServerSecureSessionStateV1 {
    BLOCKED,
    ACTIVE
}

enum class AndroidGattServerSecureBlockerV1 {
    NONE,
    NODE_PAIR_UNAVAILABLE,
    PEER_TRUST_UNAVAILABLE,
    PEER_TRUST_REJECTED,
    MUTUAL_AUTHENTICATION_INCOMPLETE,
    DIRECT_CONTROL_KEYS_UNAVAILABLE,
    RELIABLE_CHANNEL_UNATTACHED,
    DURABLE_STORE_UNATTACHED
}

data class AndroidGattServerSecurePromotionDecisionV1(
    val state: AndroidGattServerSecureSessionStateV1,
    val blocker: AndroidGattServerSecureBlockerV1
)

/**
 * Fail-closed boundary between a GATT/HELLO session and authenticated B6 transport.
 * It intentionally carries neither credentials nor key material.
 */
class AndroidGattServerSecurePromotionBoundaryV1(
    private val peerTrust: AndroidGattServerPeerTrustPortV1 =
        UnavailableAndroidGattServerPeerTrustPortV1
) {
    fun evaluate(
        nodePair: AndroidDirectNodePairKeyV1?,
        readiness: AndroidGattServerSecureReadinessV1
    ): AndroidGattServerSecurePromotionDecisionV1 {
        if (nodePair == null) {
            return blocked(AndroidGattServerSecureBlockerV1.NODE_PAIR_UNAVAILABLE)
        }
        val trustStatus = runCatching { peerTrust.statusFor(nodePair) }
            .getOrDefault(AndroidGattServerPeerTrustStatusV1.UNAVAILABLE)
        when (trustStatus) {
            AndroidGattServerPeerTrustStatusV1.UNAVAILABLE ->
                return blocked(AndroidGattServerSecureBlockerV1.PEER_TRUST_UNAVAILABLE)
            AndroidGattServerPeerTrustStatusV1.REJECTED ->
                return blocked(AndroidGattServerSecureBlockerV1.PEER_TRUST_REJECTED)
            AndroidGattServerPeerTrustStatusV1.TRUSTED -> Unit
        }
        if (!readiness.mutualAuthenticationComplete) {
            return blocked(
                AndroidGattServerSecureBlockerV1.MUTUAL_AUTHENTICATION_INCOMPLETE
            )
        }
        if (!readiness.directControlKeysAvailable) {
            return blocked(
                AndroidGattServerSecureBlockerV1.DIRECT_CONTROL_KEYS_UNAVAILABLE
            )
        }
        if (!readiness.reliableChannelAttached) {
            return blocked(
                AndroidGattServerSecureBlockerV1.RELIABLE_CHANNEL_UNATTACHED
            )
        }
        if (!readiness.durableStoreAttached) {
            return blocked(
                AndroidGattServerSecureBlockerV1.DURABLE_STORE_UNATTACHED
            )
        }
        return AndroidGattServerSecurePromotionDecisionV1(
            AndroidGattServerSecureSessionStateV1.ACTIVE,
            AndroidGattServerSecureBlockerV1.NONE
        )
    }

    private fun blocked(blocker: AndroidGattServerSecureBlockerV1) =
        AndroidGattServerSecurePromotionDecisionV1(
            AndroidGattServerSecureSessionStateV1.BLOCKED,
            blocker
        )
}
