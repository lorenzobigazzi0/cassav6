package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothShadowV1Test {
    @Test
    fun `shadow wire is canonical and limited to health ping and test`() {
        BluetoothShadowKindV1.entries.forEach { kind ->
            val value = shadowValue(kind = kind)
            val wire = BluetoothShadowCodecV1.encode(value)
            assertEquals(value, BluetoothShadowCodecV1.decode(wire))
            assertFalse(wire.toString(Charsets.UTF_8).contains("order"))
        }
        assertArrayEquals(
            EXPECTED_WIRE.toByteArray(),
            BluetoothShadowCodecV1.encode(shadowValue())
        )

        val nonCanonical = (
            "{\"body\":\"ok\",\"schemaVersion\":1,\"kind\":\"HEALTH\"," +
                "\"correlationId\":\"$CORRELATION_ID\"," +
                "\"sentAtEpochMs\":${NOW - 50},\"lanLatencyMs\":10}"
            ).toByteArray()
        assertShadowError("NON_CANONICAL_SHADOW_JSON") {
            BluetoothShadowCodecV1.decode(nonCanonical)
        }
        val business = EXPECTED_WIRE
            .replace("\"HEALTH\"", "\"ORDER_CREATE\"")
            .toByteArray()
        assertShadowError("BUSINESS_MESSAGE_REJECTED") {
            BluetoothShadowCodecV1.decode(business)
        }
    }

    @Test
    fun `authenticated ingress measures latency and suppresses replay`() {
        val delivered = mutableListOf<BluetoothShadowKindV1>()
        val ingress = BluetoothShadowIngressV1(
            handler = { delivered += it.kind },
            enabled = true,
            now = { NOW }
        )
        val message = reliableMessage(BluetoothShadowCodecV1.encode(shadowValue()))

        assertEquals(BluetoothShadowAcceptResultV1(true, false), ingress.accept(true, message))
        assertEquals(BluetoothShadowAcceptResultV1(false, true), ingress.accept(true, message))
        assertEquals(listOf(BluetoothShadowKindV1.HEALTH), delivered)
        assertEquals(
            BluetoothShadowIngressMetricsV1(
                enabled = true,
                received = 2,
                accepted = 1,
                duplicates = 1,
                rejected = 0,
                handlerFailures = 0,
                bleLatencyAverageMs = 50.0,
                lanLatencyAverageMs = 10.0,
                latencyDeltaAverageMs = 40.0
            ),
            ingress.snapshot()
        )
    }

    @Test
    fun `disabled unauthenticated business and stale ingress fail closed`() {
        val payload = BluetoothShadowCodecV1.encode(shadowValue())
        val disabled = BluetoothShadowIngressV1(handler = {}, now = { NOW })
        assertShadowError("SHADOW_DISABLED") {
            disabled.accept(true, reliableMessage(payload))
        }
        val enabled = BluetoothShadowIngressV1(
            handler = {},
            enabled = true,
            now = { NOW }
        )
        assertShadowError("UNAUTHENTICATED_SHADOW") {
            enabled.accept(false, reliableMessage(payload))
        }
        assertShadowError("BUSINESS_MESSAGE_REJECTED") {
            enabled.accept(
                true,
                reliableMessage(payload, type = ReliableFrameTypeV1.DATA)
            )
        }
        val stale = BluetoothShadowCodecV1.encode(
            shadowValue(
                correlationId = "20112233445566778899aabbccddeeff",
                sentAtEpochMs = NOW - 30_001
            )
        )
        assertShadowError("SHADOW_CLOCK_SKEW") {
            enabled.accept(true, reliableMessage(stale))
        }
        assertEquals(0, enabled.snapshot().businessMessagesForwarded)
    }

    @Test
    fun `handler failure remains retryable`() {
        var failing = true
        var delivered = 0
        val ingress = BluetoothShadowIngressV1(
            handler = {
                if (failing) error("temporary diagnostic failure")
                delivered += 1
            },
            enabled = true,
            now = { NOW }
        )
        val message = reliableMessage(BluetoothShadowCodecV1.encode(shadowValue()))

        assertShadowError("SHADOW_HANDLER_FAILED") { ingress.accept(true, message) }
        failing = false
        assertTrue(ingress.accept(true, message).accepted)
        assertEquals(1, delivered)
        assertEquals(1, ingress.snapshot().handlerFailures)
    }

    @Test
    fun `command bus adapter keeps HTTP SSE authoritative and flag off by default`() {
        val sent = mutableListOf<ReliableChannelSendInputV1>()
        val channel = BluetoothShadowChannelV1 { input ->
            sent += input.copy(payload = input.payload.copyOf())
            ReliableChannelSendResultV1(CORRELATION_ID, false)
        }
        val ingress = BluetoothShadowIngressV1(
            handler = {},
            enabled = true,
            now = { NOW }
        )
        val disabled = BluetoothCommandBusShadowAdapterV1(
            channel = channel,
            ingress = ingress,
            now = { NOW },
            correlationIdGenerator = { CORRELATION_ID }
        )
        assertEquals(
            BluetoothShadowEmitResultV1(false),
            disabled.emitDiagnostic(BluetoothShadowKindV1.PING, "test")
        )
        assertTrue(sent.isEmpty())

        val enabled = BluetoothCommandBusShadowAdapterV1(
            channel = channel,
            ingress = ingress,
            enabled = true,
            now = { NOW },
            correlationIdGenerator = { CORRELATION_ID }
        )
        assertEquals(
            BluetoothShadowEmitResultV1(true),
            enabled.emitDiagnostic(BluetoothShadowKindV1.TEST, "smoke", 12)
        )
        assertEquals(1, sent.size)
        assertEquals(ReliableFrameTypeV1.SHADOW_DIAGNOSTIC, sent.single().type)
        assertFalse(sent.single().durable)
        assertEquals(30_000, sent.single().ttlMs)
        assertShadowError("BUSINESS_ROUTING_FORBIDDEN") {
            enabled.routeBusinessCommand()
        }
        val snapshot = enabled.snapshot()
        assertTrue(snapshot.enabled)
        assertEquals(1, snapshot.diagnosticsSent)
        assertEquals(1, snapshot.businessRouteAttemptsRejected)
        assertEquals(0, snapshot.businessMessagesForwarded)
        assertEquals(BLUETOOTH_SHADOW_BUSINESS_TRANSPORT_V1, snapshot.businessTransport)
        sent.forEach { it.payload.fill(0) }
    }

    @Test
    fun `body bounds controls and exact keys are enforced`() {
        assertShadowError("INVALID_SHADOW_BODY") {
            BluetoothShadowCodecV1.encode(shadowValue(body = "x\ny"))
        }
        assertShadowError("INVALID_SHADOW_BODY") {
            BluetoothShadowCodecV1.encode(shadowValue(body = "x".repeat(129)))
        }
        val extraKey = EXPECTED_WIRE.dropLast(1) + ",\"order\":1}"
        assertShadowError("INVALID_SHADOW_KEYS") {
            BluetoothShadowCodecV1.decode(extraKey.toByteArray())
        }
    }

    private fun shadowValue(
        kind: BluetoothShadowKindV1 = BluetoothShadowKindV1.HEALTH,
        correlationId: String = CORRELATION_ID,
        sentAtEpochMs: Long = NOW - 50,
        body: String = "ok"
    ): BluetoothShadowMessageV1 = BluetoothShadowMessageV1(
        kind = kind,
        correlationId = correlationId,
        sentAtEpochMs = sentAtEpochMs,
        lanLatencyMs = 10,
        body = body
    )

    private fun reliableMessage(
        payload: ByteArray,
        type: ReliableFrameTypeV1 = ReliableFrameTypeV1.SHADOW_DIAGNOSTIC
    ): ReliableMessageV1 = ReliableMessageV1(
        type,
        0,
        1,
        "10112233445566778899aabbccddeeff",
        NOW + 30_000,
        payload
    )

    private fun assertShadowError(code: String, operation: () -> Unit) {
        val error = assertThrows(BluetoothShadowExceptionV1::class.java) {
            operation()
        }
        assertEquals(code, error.code)
    }

    companion object {
        private const val NOW = 1_800_000_000_000L
        private const val CORRELATION_ID = "00112233445566778899aabbccddeeff"
        private const val EXPECTED_WIRE =
            "{\"schemaVersion\":1,\"kind\":\"HEALTH\"," +
                "\"correlationId\":\"00112233445566778899aabbccddeeff\"," +
                "\"sentAtEpochMs\":1799999999950,\"lanLatencyMs\":10,\"body\":\"ok\"}"
    }
}
