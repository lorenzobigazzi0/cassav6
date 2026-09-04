package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

class BluetoothDiscoveryCoordinatorTest {
    @Test
    fun `advertisement state starts at zero and keeps server unreachable`() {
        val state = BluetoothAdvertisementState { 17 }
        val value = state.start(
            BluetoothAdvertisementNodeKind.HANDHELD,
            "aabbccddeeff",
            BluetoothCapabilityBitsV1.B2_FULL_NODE
        )

        assertEquals(17, value.bootId)
        assertEquals(0, value.sequence)
        assertEquals(false, value.serverReachable)
    }

    @Test
    fun `identical semantics do not update sequence`() {
        val state = BluetoothAdvertisementState { 17 }
        val first = state.start(
            BluetoothAdvertisementNodeKind.STATION,
            "aabbccddeeff",
            BluetoothCapabilityBitsV1.B2_FULL_NODE
        )
        val duplicate = state.update(
            "AABBCCDDEEFF",
            BluetoothCapabilityBitsV1.B2_FULL_NODE
        )

        assertEquals(first, duplicate)
    }

    @Test
    fun `reachability transition increments sequence and alias update preserves health`() {
        val state = BluetoothAdvertisementState { 17 }
        val offline = state.start(
            BluetoothAdvertisementNodeKind.HANDHELD,
            "aabbccddeeff",
            BluetoothCapabilityBitsV1.B2_FULL_NODE,
            serverReachable = false
        )
        val online = state.update(
            offline.rotatingAlias,
            offline.capabilities,
            serverReachable = true
        )
        assertEquals(offline.sequence + 1, online.sequence)
        assertTrue(online.serverReachable)

        val rotated = state.update("001122334455", online.capabilities)
        assertTrue(rotated.serverReachable)
        assertEquals(online.sequence + 1, rotated.sequence)
    }

    @Test
    fun `A2 identity readiness is inspect only while Raspberry v1 may provision`() {
        var inspections = 0
        var provisions = 0
        val readiness = BluetoothDiscoveryIdentityReadinessV1(
            object : BluetoothDiscoveryIdentityPortV1 {
                override fun inspectExisting(): Boolean {
                    inspections += 1
                    return false
                }

                override fun provision(): Boolean {
                    provisions += 1
                    return true
                }
            }
        )

        assertFalse(readiness.isReady(androidPeerAuthEnabled = true))
        assertEquals(1, inspections)
        assertEquals(0, provisions)
        assertTrue(readiness.isReady(androidPeerAuthEnabled = false))
        assertEquals(1, inspections)
        assertEquals(1, provisions)
    }

    @Test
    fun `A2 candidate retry uses bounded cooldown without immediate storm`() {
        assertEquals(
            6_000L,
            BluetoothGattCandidateRetryPolicyV1.nextAttemptAt(
                nowElapsedMs = 1_000L,
                accepted = false
            )
        )
        assertEquals(
            31_000L,
            BluetoothGattCandidateRetryPolicyV1.nextAttemptAt(
                nowElapsedMs = 1_000L,
                accepted = true
            )
        )
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothGattCandidateRetryPolicyV1.nextAttemptAt(-1L, false)
        }
    }

    @Test
    fun `sequence wraps modulo 256 while boot and HELLO stay in one lifecycle`() {
        var bootCalls = 0
        val state = BluetoothAdvertisementState {
            bootCalls += 1
            17
        }
        val first = state.start(
            BluetoothAdvertisementNodeKind.HANDHELD,
            "000000000000",
            BluetoothCapabilityBitsV1.B2_FULL_NODE
        )
        var current = first
        for (index in 1..254) {
            current = state.update(
                rotatingAlias = "%012x".format(index),
                capabilities = BluetoothCapabilityBitsV1.B2_FULL_NODE
            )
        }
        assertEquals(254, current.sequence)
        val at255 = state.update(
            "0000000000ff",
            BluetoothCapabilityBitsV1.B2_FULL_NODE
        )
        val atZero = state.update(
            "000000000100",
            BluetoothCapabilityBitsV1.B2_FULL_NODE
        )
        val atOne = state.update(
            "000000000101",
            BluetoothCapabilityBitsV1.B2_FULL_NODE
        )

        assertEquals(listOf(254, 255, 0, 1), listOf(
            current.sequence,
            at255.sequence,
            atZero.sequence,
            atOne.sequence
        ))
        assertTrue(listOf(first, current, at255, atZero, atOne).all {
            it.bootId == first.bootId
        })
        val helloBootIds = listOf(current, at255, atZero, atOne).map {
            BluetoothHelloV1(
                protocolVersion = it.protocolVersion,
                sessionId = "AAECAwQFBgcICQoLDA0ODw",
                nodeId = "11111111-1111-4111-8111-111111111111",
                bootId = it.bootId,
                capabilities = it.capabilities,
                nonce = "ICEiIyQlJicoKSorLC0uLw"
            ).bootId
        }
        assertEquals(listOf(17, 17, 17, 17), helloBootIds)
        assertEquals(1, bootCalls)
        assertFalse(atOne.serverReachable)
    }

    @Test
    fun `boot generator cannot return zero and state starts only once`() {
        assertThrows(IllegalArgumentException::class.java) {
            BluetoothAdvertisementState { 0 }.start(
                BluetoothAdvertisementNodeKind.HANDHELD,
                "aabbccddeeff",
                BluetoothCapabilityBitsV1.B2_FULL_NODE
            )
        }

        val state = BluetoothAdvertisementState { 17 }
        state.start(
            BluetoothAdvertisementNodeKind.HANDHELD,
            "000000000000",
            BluetoothCapabilityBitsV1.B2_FULL_NODE
        )
        assertThrows(IllegalArgumentException::class.java) {
            state.start(
                BluetoothAdvertisementNodeKind.HANDHELD,
                "000000000001",
                BluetoothCapabilityBitsV1.B2_FULL_NODE
            )
        }
    }
}
