package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothFailoverFeaturePolicyTest {
    @Test
    fun `master flag disables every secondary feature`() {
        val decision = BluetoothFailoverFeaturePolicy.evaluate(
            enabledInput().copy(
                masterEnabled = false,
                directServerEnabled = true,
                peerLinkEnabled = true
            )
        )

        assertFalse(decision.agentEnabled)
        assertFalse(decision.diagnosticsEnabled)
        assertFalse(decision.discoveryEnabled)
        assertFalse(decision.gattServerEnabled)
        assertFalse(decision.gattServerHelloEnabled)
        assertFalse(decision.gattClientEnabled)
        assertFalse(decision.helloExchangeEnabled)
        assertFalse(decision.mutualAuthEnabled)
        assertFalse(decision.sessionKeyEnabled)
        assertFalse(decision.heartbeatEnabled)
        assertFalse(decision.futureSessionFlagsGuarded)
    }

    @Test
    fun `B3 agent enables only discovery and diagnostics`() {
        val decision = BluetoothFailoverFeaturePolicy.evaluate(enabledInput())

        assertTrue(decision.agentEnabled)
        assertTrue(decision.diagnosticsEnabled)
        assertTrue(decision.discoveryEnabled)
        assertFalse(decision.gattServerEnabled)
        assertFalse(decision.gattServerHelloEnabled)
        assertFalse(decision.gattClientEnabled)
        assertFalse(decision.helloExchangeEnabled)
        assertFalse(decision.mutualAuthEnabled)
        assertFalse(decision.futureSessionFlagsGuarded)
    }

    @Test
    fun `B5 gatt client is additive and remains behind its dedicated flag`() {
        val decision = BluetoothFailoverFeaturePolicy.evaluate(
            enabledInput().copy(
                gattClientEnabled = true,
                helloExchangeEnabled = true
            )
        )

        assertTrue(decision.agentEnabled)
        assertTrue(decision.discoveryEnabled)
        assertTrue(decision.gattClientEnabled)
        assertTrue(decision.helloExchangeEnabled)
        assertFalse(decision.mutualAuthEnabled)
        assertFalse(decision.futureSessionFlagsGuarded)
    }

    @Test
    fun `HELLO cannot start without a GATT endpoint`() {
        val decision = BluetoothFailoverFeaturePolicy.evaluate(
            enabledInput().copy(helloExchangeEnabled = true)
        )

        assertFalse(decision.gattClientEnabled)
        assertFalse(decision.gattServerEnabled)
        assertFalse(decision.gattServerHelloEnabled)
        assertFalse(decision.helloExchangeEnabled)
        assertFalse(decision.mutualAuthEnabled)
    }

    @Test
    fun `mutual auth requires the complete GATT and HELLO chain`() {
        val enabled = BluetoothFailoverFeaturePolicy.evaluate(
            enabledInput().copy(
                gattClientEnabled = true,
                helloExchangeEnabled = true,
                mutualAuthEnabled = true
            )
        )
        val withoutHello = BluetoothFailoverFeaturePolicy.evaluate(
            enabledInput().copy(
                gattClientEnabled = true,
                mutualAuthEnabled = true
            )
        )

        assertTrue(enabled.mutualAuthEnabled)
        assertFalse(withoutHello.mutualAuthEnabled)
    }

    @Test
    fun `B5_7 key and heartbeat flags require the complete authentication chain`() {
        val enabled = BluetoothFailoverFeaturePolicy.evaluate(
            enabledInput().copy(
                gattClientEnabled = true,
                helloExchangeEnabled = true,
                mutualAuthEnabled = true,
                sessionKeyEnabled = true,
                heartbeatEnabled = true
            )
        )
        val withoutAuthentication = BluetoothFailoverFeaturePolicy.evaluate(
            enabledInput().copy(
                gattClientEnabled = true,
                helloExchangeEnabled = true,
                sessionKeyEnabled = true,
                heartbeatEnabled = true
            )
        )

        assertTrue(enabled.sessionKeyEnabled)
        assertTrue(enabled.heartbeatEnabled)
        assertFalse(withoutAuthentication.sessionKeyEnabled)
        assertFalse(withoutAuthentication.heartbeatEnabled)
    }

    @Test
    fun `B5_7 key and heartbeat flags are atomic`() {
        val keyOnly = BluetoothFailoverFeaturePolicy.evaluate(
            enabledInput().copy(
                gattClientEnabled = true,
                helloExchangeEnabled = true,
                mutualAuthEnabled = true,
                sessionKeyEnabled = true
            )
        )
        val heartbeatOnly = BluetoothFailoverFeaturePolicy.evaluate(
            enabledInput().copy(
                gattClientEnabled = true,
                helloExchangeEnabled = true,
                mutualAuthEnabled = true,
                heartbeatEnabled = true
            )
        )

        assertFalse(keyOnly.sessionKeyEnabled)
        assertFalse(keyOnly.heartbeatEnabled)
        assertFalse(heartbeatOnly.sessionKeyEnabled)
        assertFalse(heartbeatOnly.heartbeatEnabled)
    }

    @Test
    fun `direct server is additive and exposes only its HELLO boundary`() {
        val decision = BluetoothFailoverFeaturePolicy.evaluate(
            enabledInput().copy(
                directServerEnabled = true,
                helloExchangeEnabled = true
            )
        )

        assertTrue(decision.agentEnabled)
        assertFalse(decision.futureSessionFlagsGuarded)
        assertTrue(decision.discoveryEnabled)
        assertTrue(decision.gattServerEnabled)
        assertTrue(decision.gattServerHelloEnabled)
        assertFalse(decision.gattClientEnabled)
        assertFalse(decision.helloExchangeEnabled)
        assertFalse(decision.mutualAuthEnabled)
    }

    @Test
    fun `peer link remains guarded until the later session gates`() {
        val decision = BluetoothFailoverFeaturePolicy.evaluate(
            enabledInput().copy(
                directServerEnabled = true,
                peerLinkEnabled = true,
                gattClientEnabled = true,
                helloExchangeEnabled = true
            )
        )

        assertTrue(decision.agentEnabled)
        assertTrue(decision.futureSessionFlagsGuarded)
        assertFalse(decision.discoveryEnabled)
        assertFalse(decision.gattServerEnabled)
        assertFalse(decision.gattServerHelloEnabled)
        assertFalse(decision.gattClientEnabled)
        assertFalse(decision.helloExchangeEnabled)
        assertFalse(decision.mutualAuthEnabled)
    }

    @Test
    fun `A2 peer link opens only with both GATT roles and HELLO`() {
        val decision = BluetoothFailoverFeaturePolicy.evaluate(
            enabledInput().copy(
                directServerEnabled = true,
                peerLinkEnabled = true,
                androidPeerAuthEnabled = true,
                gattClientEnabled = true,
                helloExchangeEnabled = true
            )
        )

        assertTrue(decision.androidPeerAuthEnabled)
        assertFalse(decision.futureSessionFlagsGuarded)
        assertTrue(decision.discoveryEnabled)
        assertTrue(decision.gattServerEnabled)
        assertTrue(decision.gattClientEnabled)
        assertTrue(decision.helloExchangeEnabled)
    }

    private fun enabledInput() = BluetoothFailoverFeatureInput(
        masterEnabled = true,
        labBuild = true,
        diagnosticsEnabled = true,
        identityEnabled = true,
        discoveryEnabled = true,
        directServerEnabled = false,
        peerLinkEnabled = false,
        gattClientEnabled = false,
        helloExchangeEnabled = false,
        mutualAuthEnabled = false
    )
}
