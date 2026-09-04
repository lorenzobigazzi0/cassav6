import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITY_BITS } from "../../shared/protocol/advertisement-v1.mjs";
import {
  HELLO_V1_MINIMUM_MTU,
  decodeHelloV1,
  encodeHelloV1
} from "../../shared/protocol/hello-v1.mjs";
import {
  GATT_HELLO_EXCHANGE_STATES,
  GattHelloExchangeError,
  GattHelloExchangeV1
} from "../dist/session/GattHelloExchangeV1.js";

const SERVER_IDENTITY = Object.freeze({
  nodeId: "123e4567-e89b-12d3-a456-426614174000",
  bootId: 54,
  capabilities:
    CAPABILITY_BITS.GATT_SERVER | CAPABILITY_BITS.BACKEND_BRIDGE
});
const DEVICE_A = "/org/bluez/hci0/dev_00_11_22_33_44_55";
const DEVICE_B = "/org/bluez/hci0/dev_00_11_22_33_44_66";
const REQUEST_A = Object.freeze({
  protocolVersion: 1,
  sessionId: "AbCdEfGhIjKlMnOpQrStUg",
  nodeId: "550e8400-e29b-41d4-a716-446655440000",
  bootId: 17,
  capabilities:
    CAPABILITY_BITS.SCAN |
    CAPABILITY_BITS.ADVERTISE |
    CAPABILITY_BITS.GATT_CLIENT |
    CAPABILITY_BITS.LOCAL_DURABILITY,
  nonce: "AAECAwQFBgcICQoLDA0ODw"
});
const REQUEST_B = Object.freeze({
  ...REQUEST_A,
  sessionId: "ZyXwVuTsRqPoNmLkJiHgFA",
  nodeId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  bootId: 18,
  nonce: "EBESExQVFhcYGRobHB0eHw"
});

function deterministicRandom(start = 0x20) {
  let next = start;
  return (length) =>
    Uint8Array.from({ length }, () => {
      const value = next & 0xff;
      next += 1;
      return value;
    });
}

function createExchange(overrides = {}) {
  return new GattHelloExchangeV1({
    enabled: true,
    identity: SERVER_IDENTITY,
    randomBytes: deterministicRandom(),
    ...overrides
  });
}

function assertCode(code) {
  return (error) =>
    error instanceof GattHelloExchangeError && error.code === code;
}

test("server HELLO binds the response to the request without authenticating", () => {
  const exchange = createExchange();
  exchange.write({
    devicePath: DEVICE_A,
    mtu: HELLO_V1_MINIMUM_MTU,
    value: encodeHelloV1(REQUEST_A)
  });

  const response = decodeHelloV1(
    exchange.read({ devicePath: DEVICE_A, offset: 0 })
  );
  assert.equal(response.sessionId, REQUEST_A.sessionId);
  assert.equal(response.nodeId, SERVER_IDENTITY.nodeId);
  assert.equal(response.bootId, SERVER_IDENTITY.bootId);
  assert.equal(response.capabilities, SERVER_IDENTITY.capabilities);
  assert.notEqual(response.nonce, REQUEST_A.nonce);

  assert.deepEqual(exchange.snapshot(), {
    enabled: true,
    activeExchangeCount: 1,
    responseReadyCount: 0,
    responseDeliveredCount: 1,
    failedExchangeCount: 0,
    writesAcceptedTotal: 1,
    readsDeliveredTotal: 1,
    helloExchangedTotal: 1,
    duplicateWritesTotal: 0,
    duplicateReadsTotal: 0,
    bindingConflictsTotal: 0,
    capacityRejectedTotal: 0,
    expiredTotal: 0,
    failuresTotal: 0,
    resetsTotal: 0,
    mutualAuthEnabled: false,
    authStartedTotal: 0,
    clientProofsVerifiedTotal: 0,
    serverProofsIssuedTotal: 0,
    finishProofsVerifiedTotal: 0,
    authDuplicateWritesTotal: 0,
    authReplayRejectedTotal: 0,
    authFailuresTotal: 0,
    authenticatedSessionCount: 0,
    directControlEnabled: false,
    clientKeySharesAcceptedTotal: 0,
    serverKeySharesIssuedTotal: 0,
    clientKeyConfirmationsVerifiedTotal: 0,
    keyEstablishedTotal: 0,
    heartbeatStartedTotal: 0,
    pingsSentTotal: 0,
    pongsVerifiedTotal: 0,
    heartbeatMissesTotal: 0,
    activeSessionsTotal: 0,
    cleanClosesTotal: 0,
    heartbeatTimeoutClosesTotal: 0,
    forcedClosesTotal: 0,
    directControlDuplicateWritesTotal: 0,
    directControlFailuresTotal: 0,
    keyEstablishedSessionCount: 0,
    activeSessionCount: 0,
    closingSessionCount: 0,
    activeTimerCount: 0,
    retainedSecretBufferCount: 0
  });
});

test("concurrent BlueZ connections receive only their bound HELLO response", () => {
  const exchange = createExchange();
  exchange.write({
    devicePath: DEVICE_A,
    mtu: 247,
    value: encodeHelloV1(REQUEST_A)
  });
  exchange.write({
    devicePath: DEVICE_B,
    mtu: 247,
    value: encodeHelloV1(REQUEST_B)
  });

  const responseB = decodeHelloV1(
    exchange.read({ devicePath: DEVICE_B, offset: 0 })
  );
  const responseA = decodeHelloV1(
    exchange.read({ devicePath: DEVICE_A, offset: 0 })
  );
  assert.equal(responseA.sessionId, REQUEST_A.sessionId);
  assert.equal(responseB.sessionId, REQUEST_B.sessionId);
  assert.notEqual(responseA.nonce, responseB.nonce);
  assert.equal(exchange.snapshot().activeExchangeCount, 2);
  assert.equal(exchange.snapshot().authenticatedSessionCount, 0);
});

test("exact retries are idempotent while a conflicting binding fails closed", () => {
  const exchange = createExchange();
  const encodedA = encodeHelloV1(REQUEST_A);
  exchange.write({ devicePath: DEVICE_A, mtu: 247, value: encodedA });
  exchange.write({ devicePath: DEVICE_A, mtu: 247, value: encodedA });
  const first = exchange.read({ devicePath: DEVICE_A, offset: 0 });
  const duplicate = exchange.read({ devicePath: DEVICE_A, offset: 0 });
  assert.deepEqual(duplicate, first);

  assert.throws(
    () =>
      exchange.write({
        devicePath: DEVICE_A,
        mtu: 247,
        value: encodeHelloV1(REQUEST_B)
      }),
    assertCode("HELLO_BINDING_CONFLICT")
  );
  assert.throws(
    () => exchange.read({ devicePath: DEVICE_A, offset: 0 }),
    assertCode("HELLO_RESPONSE_NOT_READY")
  );
  const snapshot = exchange.snapshot();
  assert.equal(snapshot.duplicateWritesTotal, 1);
  assert.equal(snapshot.duplicateReadsTotal, 1);
  assert.equal(snapshot.bindingConflictsTotal, 1);
  assert.equal(snapshot.failedExchangeCount, 1);
});

test("HELLO rejects invalid MTU, payload, role, duplicate session and capacity", () => {
  const tooSmall = createExchange();
  assert.throws(
    () =>
      tooSmall.write({
        devicePath: DEVICE_A,
        mtu: HELLO_V1_MINIMUM_MTU - 1,
        value: encodeHelloV1(REQUEST_A)
      }),
    assertCode("HELLO_MTU_TOO_SMALL")
  );

  const malformed = createExchange();
  assert.throws(
    () =>
      malformed.write({
        devicePath: DEVICE_A,
        mtu: 247,
        value: new Uint8Array(50)
      }),
    assertCode("INVALID_WIRE_LENGTH")
  );

  const wrongRole = createExchange();
  assert.throws(
    () =>
      wrongRole.write({
        devicePath: DEVICE_A,
        mtu: 247,
        value: encodeHelloV1({ ...REQUEST_A, capabilities: 0 })
      }),
    assertCode("INVALID_CLIENT_BINDING")
  );

  const duplicateSession = createExchange();
  duplicateSession.write({
    devicePath: DEVICE_A,
    mtu: 247,
    value: encodeHelloV1(REQUEST_A)
  });
  assert.throws(
    () =>
      duplicateSession.write({
        devicePath: DEVICE_B,
        mtu: 247,
        value: encodeHelloV1({ ...REQUEST_B, sessionId: REQUEST_A.sessionId })
      }),
    assertCode("DUPLICATE_SESSION")
  );

  const capacity = createExchange({ maxActiveExchanges: 1 });
  capacity.write({
    devicePath: DEVICE_A,
    mtu: 247,
    value: encodeHelloV1(REQUEST_A)
  });
  assert.throws(
    () =>
      capacity.write({
        devicePath: DEVICE_B,
        mtu: 247,
        value: encodeHelloV1(REQUEST_B)
      }),
    assertCode("HELLO_CAPACITY_REACHED")
  );
  assert.equal(capacity.snapshot().capacityRejectedTotal, 1);
});

test("expiry and reset release responses and snapshots remain identity-redacted", () => {
  let nowMs = 0;
  const exchange = createExchange({
    clock: () => nowMs,
    exchangeTtlMs: 1_000
  });
  exchange.write({
    devicePath: DEVICE_A,
    mtu: 247,
    value: encodeHelloV1(REQUEST_A)
  });
  nowMs = 1_001;
  assert.throws(
    () => exchange.read({ devicePath: DEVICE_A, offset: 0 }),
    assertCode("HELLO_RESPONSE_NOT_READY")
  );
  assert.equal(exchange.snapshot().expiredTotal, 1);
  assert.equal(exchange.snapshot().activeExchangeCount, 0);

  exchange.write({
    devicePath: DEVICE_B,
    mtu: 247,
    value: encodeHelloV1(REQUEST_B)
  });
  exchange.reset();
  assert.equal(exchange.snapshot().activeExchangeCount, 0);
  assert.equal(exchange.snapshot().resetsTotal, 1);

  const serialized = JSON.stringify(exchange.snapshot());
  for (const forbidden of [
    DEVICE_A,
    DEVICE_B,
    REQUEST_A.nodeId,
    REQUEST_A.sessionId,
    REQUEST_A.nonce,
    SERVER_IDENTITY.nodeId
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("disabled HELLO owns no identity and rejects every operation", () => {
  const exchange = new GattHelloExchangeV1({ enabled: false });
  assert.throws(
    () =>
      exchange.write({
        devicePath: DEVICE_A,
        mtu: 247,
        value: encodeHelloV1(REQUEST_A)
      }),
    assertCode("FEATURE_DISABLED")
  );
  assert.equal(exchange.snapshot().enabled, false);
  assert.equal(exchange.snapshot().activeExchangeCount, 0);
});
