package com.sentrapa.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BluetoothDiagnosticCommandBusV1Test {
    @Test
    fun `typed diagnostics are isolated from business and subscriber failures`() {
        val bus = BluetoothDiagnosticCommandBusV1()
        val received = mutableListOf<BluetoothShadowKindV1>()
        val healthy = bus.subscribe { received += it.kind }
        val failing = bus.subscribe { throw IllegalStateException("expected") }

        val result = bus.publish(
            BluetoothDiagnosticCommandV1(
                kind = BluetoothShadowKindV1.HEALTH,
                body = "health",
                lanLatencyMs = 12
            )
        )

        assertEquals(2, result.subscribers)
        assertEquals(1, result.delivered)
        assertEquals(1, result.failures)
        assertEquals(0, result.businessMessagesForwarded)
        assertEquals(BLUETOOTH_SHADOW_BUSINESS_TRANSPORT_V1, result.businessTransport)
        assertEquals(listOf(BluetoothShadowKindV1.HEALTH), received)
        val snapshot = bus.snapshot()
        assertEquals(2, snapshot.activeSubscribers)
        assertEquals(1, snapshot.published)
        assertEquals(1, snapshot.delivered)
        assertEquals(1, snapshot.failures)
        assertEquals(0, snapshot.businessMessagesForwarded)

        healthy.close()
        failing.close()
        assertEquals(0, bus.snapshot().activeSubscribers)
    }

    @Test
    fun `invalid diagnostic is rejected before publication`() {
        val bus = BluetoothDiagnosticCommandBusV1()
        assertThrows(BluetoothShadowExceptionV1::class.java) {
            bus.publish(
                BluetoothDiagnosticCommandV1(
                    kind = BluetoothShadowKindV1.TEST,
                    body = "invalid\u0000body"
                )
            )
        }
        assertEquals(0, bus.snapshot().published)
    }
}
