import assert from "node:assert/strict";
import test from "node:test";

import {
  RELIABLE_FRAME_TYPES
} from "../dist/protocol/FrameCodec.js";
import {
  BLUETOOTH_SHADOW_KINDS,
  BluetoothShadowIngressError,
  BluetoothShadowIngressV1,
  decodeBluetoothShadowMessageV1,
  encodeBluetoothShadowMessageV1
} from "../dist/backend/BluetoothShadowIngress.js";
import {
  CommandBusShadowAdapterError,
  CommandBusShadowAdapterV1
} from "../dist/backend/CommandBusShadowAdapter.js";

const NOW = 1_800_000_000_000;
const CORRELATION_ID = "00112233445566778899aabbccddeeff";

function shadowValue(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: BLUETOOTH_SHADOW_KINDS.HEALTH,
    correlationId: CORRELATION_ID,
    sentAtEpochMs: NOW - 50,
    lanLatencyMs: 10,
    body: "ok",
    ...overrides
  };
}

function reliableMessage(payload, overrides = {}) {
  return {
    type: RELIABLE_FRAME_TYPES.SHADOW_DIAGNOSTIC,
    flags: 0,
    sequence: 1,
    messageId: "10112233445566778899aabbccddeeff",
    expiresAtEpochMs: NOW + 30_000,
    payload,
    ...overrides
  };
}

test("shadow wire is canonical and accepts only health, ping and test", () => {
  for (const kind of Object.values(BLUETOOTH_SHADOW_KINDS)) {
    const value = shadowValue({ kind });
    const wire = encodeBluetoothShadowMessageV1(value);
    assert.deepEqual(decodeBluetoothShadowMessageV1(wire), value);
    assert.equal(wire.includes(Buffer.from("order", "utf8")), false);
  }
  assert.equal(
    encodeBluetoothShadowMessageV1(shadowValue()).toString("utf8"),
    "{\"schemaVersion\":1,\"kind\":\"HEALTH\"," +
      "\"correlationId\":\"00112233445566778899aabbccddeeff\"," +
      "\"sentAtEpochMs\":1799999999950,\"lanLatencyMs\":10,\"body\":\"ok\"}"
  );
  const nonCanonical = Buffer.from(
    JSON.stringify({
      body: "ok",
      schemaVersion: 1,
      kind: "HEALTH",
      correlationId: CORRELATION_ID,
      sentAtEpochMs: NOW - 50,
      lanLatencyMs: 10
    })
  );
  assert.throws(
    () => decodeBluetoothShadowMessageV1(nonCanonical),
    (error) =>
      error instanceof BluetoothShadowIngressError &&
      error.code === "NON_CANONICAL_SHADOW_JSON"
  );
  assert.throws(
    () => encodeBluetoothShadowMessageV1(shadowValue({ kind: "ORDER_CREATE" })),
    (error) =>
      error instanceof BluetoothShadowIngressError &&
      error.code === "BUSINESS_MESSAGE_REJECTED"
  );
});

test("shadow body rejects unpaired UTF-16 surrogates before UTF-8 encoding", () => {
  for (const body of ["high-\ud800", "low-\udc00"]) {
    assert.throws(
      () => encodeBluetoothShadowMessageV1(shadowValue({ body })),
      (error) =>
        error instanceof BluetoothShadowIngressError &&
        error.code === "INVALID_SHADOW_BODY"
    );
    const wire = Buffer.from(
      JSON.stringify({ ...shadowValue(), body }),
      "utf8"
    );
    assert.throws(
      () => decodeBluetoothShadowMessageV1(wire),
      (error) =>
        error instanceof BluetoothShadowIngressError &&
        error.code === "INVALID_SHADOW_BODY"
    );
  }

  const paired = shadowValue({ body: "paired-\ud83d\ude80" });
  assert.deepEqual(
    decodeBluetoothShadowMessageV1(encodeBluetoothShadowMessageV1(paired)),
    paired
  );
});

test("authenticated ingress measures LAN/BLE latency and suppresses duplicates", async () => {
  const delivered = [];
  const ingress = new BluetoothShadowIngressV1({
    enabled: true,
    now: () => NOW,
    handler(message) {
      delivered.push(message.kind);
    }
  });
  const message = reliableMessage(encodeBluetoothShadowMessageV1(shadowValue()));
  assert.deepEqual(
    await ingress.accept({ authenticated: true, message }),
    { accepted: true, duplicate: false }
  );
  assert.deepEqual(
    await ingress.accept({ authenticated: true, message }),
    { accepted: false, duplicate: true }
  );
  assert.deepEqual(delivered, ["HEALTH"]);
  assert.deepEqual(ingress.snapshot(), {
    enabled: true,
    received: 2,
    accepted: 1,
    duplicates: 1,
    rejected: 0,
    handlerFailures: 0,
    bleLatencyAverageMs: 50,
    lanLatencyAverageMs: 10,
    latencyDeltaAverageMs: 40,
    businessMessagesForwarded: 0
  });
});

test("disabled, unauthenticated, business and stale ingress fail closed", async () => {
  const payload = encodeBluetoothShadowMessageV1(shadowValue());
  const disabled = new BluetoothShadowIngressV1({
    handler() {},
    now: () => NOW
  });
  await assert.rejects(
    () => disabled.accept({ authenticated: true, message: reliableMessage(payload) }),
    (error) =>
      error instanceof BluetoothShadowIngressError &&
      error.code === "SHADOW_DISABLED"
  );
  const enabled = new BluetoothShadowIngressV1({
    enabled: true,
    handler() {},
    now: () => NOW
  });
  await assert.rejects(
    () => enabled.accept({ authenticated: false, message: reliableMessage(payload) }),
    (error) =>
      error instanceof BluetoothShadowIngressError &&
      error.code === "UNAUTHENTICATED_SHADOW"
  );
  await assert.rejects(
    () =>
      enabled.accept({
        authenticated: true,
        message: reliableMessage(payload, { type: RELIABLE_FRAME_TYPES.DATA })
      }),
    (error) =>
      error instanceof BluetoothShadowIngressError &&
      error.code === "BUSINESS_MESSAGE_REJECTED"
  );
  const stale = reliableMessage(
    encodeBluetoothShadowMessageV1(
      shadowValue({
        correlationId: "20112233445566778899aabbccddeeff",
        sentAtEpochMs: NOW - 30_001
      })
    )
  );
  await assert.rejects(
    () => enabled.accept({ authenticated: true, message: stale }),
    (error) =>
      error instanceof BluetoothShadowIngressError &&
      error.code === "SHADOW_CLOCK_SKEW"
  );
  assert.equal(enabled.snapshot().businessMessagesForwarded, 0);
});

test("handler failure remains retryable and never creates a false acceptance", async () => {
  let fail = true;
  let delivered = 0;
  const ingress = new BluetoothShadowIngressV1({
    enabled: true,
    now: () => NOW,
    handler() {
      if (fail) throw new Error("temporary test failure");
      delivered += 1;
    }
  });
  const message = reliableMessage(encodeBluetoothShadowMessageV1(shadowValue()));
  await assert.rejects(
    () => ingress.accept({ authenticated: true, message }),
    (error) =>
      error instanceof BluetoothShadowIngressError &&
      error.code === "SHADOW_HANDLER_FAILED"
  );
  fail = false;
  assert.equal(
    (await ingress.accept({ authenticated: true, message })).accepted,
    true
  );
  assert.equal(delivered, 1);
  assert.equal(ingress.snapshot().handlerFailures, 1);
});

test("command bus adapter keeps LAN authoritative and rejects business routing", async () => {
  const sent = [];
  const channel = {
    async send(message) {
      sent.push({ ...message, payload: Buffer.from(message.payload) });
      return { messageId: CORRELATION_ID, durableCommitted: false };
    }
  };
  const ingress = new BluetoothShadowIngressV1({
    enabled: true,
    now: () => NOW,
    handler() {}
  });
  const disabled = new CommandBusShadowAdapterV1({
    channel,
    ingress,
    now: () => NOW
  });
  assert.deepEqual(
    await disabled.emitDiagnostic({ kind: "PING", body: "test" }),
    { shadowSent: false, businessTransport: "LAN_HTTP_SSE" }
  );
  assert.equal(sent.length, 0);

  const enabled = new CommandBusShadowAdapterV1({
    enabled: true,
    channel,
    ingress,
    now: () => NOW
  });
  assert.deepEqual(
    await enabled.emitDiagnostic({
      kind: "TEST",
      body: "smoke",
      lanLatencyMs: 12
    }),
    { shadowSent: true, businessTransport: "LAN_HTTP_SSE" }
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, RELIABLE_FRAME_TYPES.SHADOW_DIAGNOSTIC);
  assert.equal(sent[0].durable, false);
  assert.throws(
    () => enabled.routeBusinessCommand({ type: "ORDER_CREATE" }),
    (error) =>
      error instanceof CommandBusShadowAdapterError &&
      error.code === "BUSINESS_ROUTING_FORBIDDEN"
  );
  assert.deepEqual(enabled.snapshot(), {
    enabled: true,
    diagnosticsSent: 1,
    businessRouteAttemptsRejected: 1,
    businessMessagesForwarded: 0,
    businessTransport: "LAN_HTTP_SSE",
    ingress: ingress.snapshot()
  });
});
