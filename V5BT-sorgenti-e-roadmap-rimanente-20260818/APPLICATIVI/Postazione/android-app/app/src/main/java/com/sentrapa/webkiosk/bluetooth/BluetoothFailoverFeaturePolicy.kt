package com.sentrapa.webkiosk.bluetooth

data class BluetoothFailoverFeatureInput(
    val masterEnabled: Boolean,
    val labBuild: Boolean,
    val diagnosticsEnabled: Boolean,
    val identityEnabled: Boolean,
    val discoveryEnabled: Boolean,
    val directServerEnabled: Boolean,
    val peerLinkEnabled: Boolean,
    val androidPeerAuthEnabled: Boolean = false,
    val gattClientEnabled: Boolean,
    val helloExchangeEnabled: Boolean,
    val mutualAuthEnabled: Boolean,
    val sessionKeyEnabled: Boolean = false,
    val heartbeatEnabled: Boolean = false
)

data class BluetoothFailoverFeatureDecision(
    val agentEnabled: Boolean,
    val diagnosticsEnabled: Boolean,
    val discoveryEnabled: Boolean,
    val gattServerEnabled: Boolean,
    val gattServerHelloEnabled: Boolean,
    val gattClientEnabled: Boolean,
    val helloExchangeEnabled: Boolean,
    val mutualAuthEnabled: Boolean,
    val sessionKeyEnabled: Boolean,
    val heartbeatEnabled: Boolean,
    val androidPeerAuthEnabled: Boolean,
    val futureSessionFlagsGuarded: Boolean
)

object BluetoothFailoverFeaturePolicy {
    fun evaluate(input: BluetoothFailoverFeatureInput): BluetoothFailoverFeatureDecision {
        val agentEnabled =
            input.masterEnabled &&
                input.labBuild &&
                input.identityEnabled &&
                input.discoveryEnabled
        val peerAuthChainEnabled =
            agentEnabled &&
                input.peerLinkEnabled &&
                input.androidPeerAuthEnabled &&
                input.directServerEnabled &&
                input.gattClientEnabled &&
                input.helloExchangeEnabled
        val futureSessionFlagsGuarded =
            agentEnabled && input.peerLinkEnabled && !peerAuthChainEnabled
        val gattServerEnabled =
            agentEnabled &&
                !futureSessionFlagsGuarded &&
                input.directServerEnabled
        val gattServerHelloEnabled =
            gattServerEnabled && input.helloExchangeEnabled
        val gattClientEnabled =
            agentEnabled &&
                !futureSessionFlagsGuarded &&
                input.gattClientEnabled
        val helloExchangeEnabled =
            gattClientEnabled && input.helloExchangeEnabled
        val mutualAuthEnabled =
            helloExchangeEnabled && input.mutualAuthEnabled
        val directControlEnabled =
            mutualAuthEnabled &&
                input.sessionKeyEnabled &&
                input.heartbeatEnabled
        return BluetoothFailoverFeatureDecision(
            agentEnabled = agentEnabled,
            diagnosticsEnabled = agentEnabled && input.diagnosticsEnabled,
            discoveryEnabled = agentEnabled && !futureSessionFlagsGuarded,
            gattServerEnabled = gattServerEnabled,
            gattServerHelloEnabled = gattServerHelloEnabled,
            gattClientEnabled = gattClientEnabled,
            helloExchangeEnabled = helloExchangeEnabled,
            mutualAuthEnabled = mutualAuthEnabled,
            sessionKeyEnabled = directControlEnabled,
            heartbeatEnabled = directControlEnabled,
            androidPeerAuthEnabled = peerAuthChainEnabled,
            futureSessionFlagsGuarded = futureSessionFlagsGuarded
        )
    }
}
