import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_HEARTBEAT_MISSES_BEFORE_CLOSE,
  DEFAULT_PREFERRED_GATT_MTU,
  DIRECT_SESSION_ID_PATTERN_SOURCE,
  DIRECT_SESSION_DISPOSITIONS,
  DIRECT_SESSION_EVENTS,
  DIRECT_SESSION_PROTOCOL_VERSION,
  DIRECT_SESSION_ROLES,
  DIRECT_SESSION_STATES,
  DirectSessionError,
  DirectSessionV1,
  MAXIMUM_GATT_MTU,
  MINIMUM_GATT_MTU
} from "./direct-session-v1.mjs";

const vectorsUrl = new URL(
  "../../contracts/PROTOCOL_TEST_VECTORS.json",
  import.meta.url
);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8"));
const directSessionVector = vectors.directSession;
const SESSION_ID = directSessionVector.sessionId;

function createSession(role = DIRECT_SESSION_ROLES.ANDROID_CLIENT) {
  let nowMs = 100;
  const session = new DirectSessionV1({
    role,
    clock: () => nowMs
  });
  return {
    session,
    advance(deltaMs = 1) {
      nowMs += deltaMs;
      return nowMs;
    },
    setNow(value) {
      nowMs = value;
    }
  };
}

function dispatch(session, type, fields = {}) {
  return session.dispatch({ type, ...fields });
}

function reachMtuNegotiated(session, role) {
  dispatch(session, DIRECT_SESSION_EVENTS.GATT_CONNECTED);
  if (role === DIRECT_SESSION_ROLES.ANDROID_CLIENT) {
    dispatch(session, DIRECT_SESSION_EVENTS.SERVICES_DISCOVERED);
  }
  dispatch(session, DIRECT_SESSION_EVENTS.MTU_NEGOTIATED, { mtu: 247 });
}

function reachActive(session, role) {
  reachMtuNegotiated(session, role);
  dispatch(session, DIRECT_SESSION_EVENTS.HELLO_ACCEPTED, {
    protocolVersion: 1,
    sessionId: SESSION_ID
  });
  dispatch(session, DIRECT_SESSION_EVENTS.AUTH_STARTED);
  dispatch(session, DIRECT_SESSION_EVENTS.AUTH_VERIFIED);
  dispatch(session, DIRECT_SESSION_EVENTS.SESSION_KEY_ESTABLISHED);
  dispatch(session, DIRECT_SESSION_EVENTS.HEARTBEAT_STARTED);
}

test("defaults and snapshots are frozen, bounded and identity-redacted", () => {
  const { session } = createSession();
  const snapshot = session.snapshot();

  assert.equal(DIRECT_SESSION_PROTOCOL_VERSION, 1);
  assert.equal(DEFAULT_PREFERRED_GATT_MTU, 247);
  assert.equal(DEFAULT_HEARTBEAT_MISSES_BEFORE_CLOSE, 3);
  assert.equal(MINIMUM_GATT_MTU, 23);
  assert.equal(MAXIMUM_GATT_MTU, 517);
  assert.equal(snapshot.state, DIRECT_SESSION_STATES.IDLE);
  assert.equal(snapshot.role, DIRECT_SESSION_ROLES.ANDROID_CLIENT);
  assert.equal(snapshot.sessionBound, false);
  assert.equal(snapshot.active, false);
  assert.equal(Object.hasOwn(snapshot, "sessionId"), false);
  assert.equal(Object.hasOwn(snapshot, "nodeId"), false);
  assert.equal(Object.hasOwn(snapshot, "transportId"), false);
  assert.ok(Object.isFrozen(snapshot));
});

test("executable constants match the frozen B5 contract vector", () => {
  assert.deepEqual(directSessionVector, {
    protocolVersion: 1,
    sessionIdEncoding: "base64url-unpadded-128-bit",
    sessionId: "AbCdEfGhIjKlMnOpQrStUg",
    roles: {
      android: "android-client",
      raspberry: "raspberry-server"
    },
    minimumGattMtu: 23,
    preferredGattMtu: 247,
    maximumGattMtu: 517,
    heartbeatMissesBeforeClose: 3,
    androidClientSequence: [
      "GATT_CONNECTED",
      "SERVICES_DISCOVERED",
      "MTU_NEGOTIATED",
      "HELLO_ACCEPTED",
      "AUTH_STARTED",
      "AUTH_VERIFIED",
      "SESSION_KEY_ESTABLISHED",
      "HEARTBEAT_STARTED"
    ],
    raspberryServerSequence: [
      "GATT_CONNECTED",
      "MTU_NEGOTIATED",
      "HELLO_ACCEPTED",
      "AUTH_STARTED",
      "AUTH_VERIFIED",
      "SESSION_KEY_ESTABLISHED",
      "HEARTBEAT_STARTED"
    ]
  });
  assert.equal(
    directSessionVector.roles.android,
    DIRECT_SESSION_ROLES.ANDROID_CLIENT
  );
  assert.equal(
    directSessionVector.roles.raspberry,
    DIRECT_SESSION_ROLES.RASPBERRY_SERVER
  );
  assert.equal(
    Buffer.from(SESSION_ID, "base64url").toString("base64url"),
    SESSION_ID
  );
  assert.match(SESSION_ID, new RegExp(DIRECT_SESSION_ID_PATTERN_SOURCE));
});

test("Android client reaches ACTIVE only through the complete B5 sequence", () => {
  const { session } = createSession(DIRECT_SESSION_ROLES.ANDROID_CLIENT);
  const expectedStates = [
    [DIRECT_SESSION_EVENTS.GATT_CONNECTED, DIRECT_SESSION_STATES.GATT_CONNECTED],
    [
      DIRECT_SESSION_EVENTS.SERVICES_DISCOVERED,
      DIRECT_SESSION_STATES.SERVICES_DISCOVERED
    ],
    [DIRECT_SESSION_EVENTS.MTU_NEGOTIATED, DIRECT_SESSION_STATES.MTU_NEGOTIATED],
    [DIRECT_SESSION_EVENTS.HELLO_ACCEPTED, DIRECT_SESSION_STATES.HELLO_EXCHANGED],
    [DIRECT_SESSION_EVENTS.AUTH_STARTED, DIRECT_SESSION_STATES.AUTHENTICATING],
    [DIRECT_SESSION_EVENTS.AUTH_VERIFIED, DIRECT_SESSION_STATES.AUTHENTICATED],
    [
      DIRECT_SESSION_EVENTS.SESSION_KEY_ESTABLISHED,
      DIRECT_SESSION_STATES.KEY_ESTABLISHED
    ],
    [DIRECT_SESSION_EVENTS.HEARTBEAT_STARTED, DIRECT_SESSION_STATES.ACTIVE]
  ];

  for (const [type, expectedState] of expectedStates) {
    const fields =
      type === DIRECT_SESSION_EVENTS.MTU_NEGOTIATED
        ? { mtu: 247 }
        : type === DIRECT_SESSION_EVENTS.HELLO_ACCEPTED
          ? { protocolVersion: 1, sessionId: SESSION_ID }
          : {};
    const result = dispatch(session, type, fields);
    assert.equal(result.disposition, DIRECT_SESSION_DISPOSITIONS.TRANSITIONED);
    assert.equal(result.to, expectedState);
  }

  assert.equal(session.sessionId, SESSION_ID);
  assert.equal(session.snapshot().active, true);
  assert.equal(session.snapshot().transitionCount, 8);
});

test("Raspberry server skips client-only service discovery but still requires MTU", () => {
  const { session } = createSession(DIRECT_SESSION_ROLES.RASPBERRY_SERVER);

  reachActive(session, DIRECT_SESSION_ROLES.RASPBERRY_SERVER);

  assert.equal(session.state, DIRECT_SESSION_STATES.ACTIVE);
  assert.equal(session.snapshot().transitionCount, 7);
});

test("Raspberry rejects the Android-only service discovery event", () => {
  const { session } = createSession(DIRECT_SESSION_ROLES.RASPBERRY_SERVER);
  dispatch(session, DIRECT_SESSION_EVENTS.GATT_CONNECTED);

  const result = dispatch(session, DIRECT_SESSION_EVENTS.SERVICES_DISCOVERED);

  assert.equal(result.disposition, DIRECT_SESSION_DISPOSITIONS.FAILED_CLOSED);
  assert.equal(result.failureCode, "ROLE_SEQUENCE_VIOLATION");
  assert.equal(session.state, DIRECT_SESSION_STATES.FAILED);
});

test("authentication and key establishment cannot be skipped", () => {
  const { session } = createSession();
  reachMtuNegotiated(session, DIRECT_SESSION_ROLES.ANDROID_CLIENT);

  const result = dispatch(session, DIRECT_SESSION_EVENTS.HEARTBEAT_STARTED);

  assert.equal(result.disposition, DIRECT_SESSION_DISPOSITIONS.FAILED_CLOSED);
  assert.equal(result.failureCode, "INVALID_TRANSITION");
  assert.equal(session.snapshot().active, false);
});

test("lifecycle duplicates are idempotent only at their current boundary", () => {
  const { session } = createSession();
  dispatch(session, DIRECT_SESSION_EVENTS.GATT_CONNECTED);
  assert.equal(
    dispatch(session, DIRECT_SESSION_EVENTS.GATT_CONNECTED).disposition,
    DIRECT_SESSION_DISPOSITIONS.IDEMPOTENT
  );
  dispatch(session, DIRECT_SESSION_EVENTS.SERVICES_DISCOVERED);
  dispatch(session, DIRECT_SESSION_EVENTS.MTU_NEGOTIATED, { mtu: 247 });
  assert.equal(
    dispatch(session, DIRECT_SESSION_EVENTS.MTU_NEGOTIATED, {
      mtu: 247
    }).disposition,
    DIRECT_SESSION_DISPOSITIONS.IDEMPOTENT
  );
  assert.equal(session.snapshot().idempotentEventCount, 2);
});

test("conflicting MTU or HELLO bindings fail the session closed", () => {
  const mtuCase = createSession().session;
  reachMtuNegotiated(mtuCase, DIRECT_SESSION_ROLES.ANDROID_CLIENT);
  const conflictingMtu = dispatch(
    mtuCase,
    DIRECT_SESSION_EVENTS.MTU_NEGOTIATED,
    { mtu: 185 }
  );
  assert.equal(conflictingMtu.failureCode, "MTU_BINDING_CONFLICT");
  assert.equal(mtuCase.state, DIRECT_SESSION_STATES.FAILED);

  const helloCase = createSession().session;
  reachMtuNegotiated(helloCase, DIRECT_SESSION_ROLES.ANDROID_CLIENT);
  dispatch(helloCase, DIRECT_SESSION_EVENTS.HELLO_ACCEPTED, {
    protocolVersion: 1,
    sessionId: SESSION_ID
  });
  const conflictingHello = dispatch(
    helloCase,
    DIRECT_SESSION_EVENTS.HELLO_ACCEPTED,
    {
      protocolVersion: 1,
      sessionId: "ZyXwVuTsRqPoNmLkJiHgFA"
    }
  );
  assert.equal(conflictingHello.failureCode, "SESSION_BINDING_CONFLICT");
  assert.equal(helloCase.state, DIRECT_SESSION_STATES.FAILED);
});

test("protocol version and session identifier are checked before auth", () => {
  const versionCase = createSession().session;
  reachMtuNegotiated(versionCase, DIRECT_SESSION_ROLES.ANDROID_CLIENT);
  const versionResult = dispatch(
    versionCase,
    DIRECT_SESSION_EVENTS.HELLO_ACCEPTED,
    { protocolVersion: 2, sessionId: SESSION_ID }
  );
  assert.equal(versionResult.failureCode, "PROTOCOL_VERSION_MISMATCH");

  const identifierCase = createSession().session;
  reachMtuNegotiated(identifierCase, DIRECT_SESSION_ROLES.ANDROID_CLIENT);
  const identifierResult = dispatch(
    identifierCase,
    DIRECT_SESSION_EVENTS.HELLO_ACCEPTED,
    { protocolVersion: 1, sessionId: "short" }
  );
  assert.equal(identifierResult.failureCode, "INVALID_SESSION_ID");
});

test("session identifier rejects non-canonical encodings of 128 bits", () => {
  const { session } = createSession();
  reachMtuNegotiated(session, DIRECT_SESSION_ROLES.ANDROID_CLIENT);
  const nonCanonical = `${SESSION_ID.slice(0, -1)}v`;

  assert.equal(Buffer.from(nonCanonical, "base64url").byteLength, 16);
  assert.notEqual(
    Buffer.from(nonCanonical, "base64url").toString("base64url"),
    nonCanonical
  );
  const result = dispatch(session, DIRECT_SESSION_EVENTS.HELLO_ACCEPTED, {
    protocolVersion: 1,
    sessionId: nonCanonical
  });
  assert.equal(result.failureCode, "INVALID_SESSION_ID");
  assert.equal(session.state, DIRECT_SESSION_STATES.FAILED);
});

test("MTU accepts the exact Bluetooth bounds and rejects values outside them", () => {
  for (const mtu of [MINIMUM_GATT_MTU, MAXIMUM_GATT_MTU]) {
    const session = createSession().session;
    dispatch(session, DIRECT_SESSION_EVENTS.GATT_CONNECTED);
    dispatch(session, DIRECT_SESSION_EVENTS.SERVICES_DISCOVERED);
    assert.equal(
      dispatch(session, DIRECT_SESSION_EVENTS.MTU_NEGOTIATED, { mtu }).to,
      DIRECT_SESSION_STATES.MTU_NEGOTIATED
    );
  }

  for (const mtu of [MINIMUM_GATT_MTU - 1, MAXIMUM_GATT_MTU + 1]) {
    const session = createSession().session;
    dispatch(session, DIRECT_SESSION_EVENTS.GATT_CONNECTED);
    dispatch(session, DIRECT_SESSION_EVENTS.SERVICES_DISCOVERED);
    assert.throws(
      () => dispatch(session, DIRECT_SESSION_EVENTS.MTU_NEGOTIATED, { mtu }),
      (error) =>
        error instanceof DirectSessionError && error.code === "INVALID_MTU"
    );
    assert.equal(session.state, DIRECT_SESSION_STATES.SERVICES_DISCOVERED);
  }
});

test("matching PING and PONG update liveness without changing ACTIVE", () => {
  const { session } = createSession();
  reachActive(session, DIRECT_SESSION_ROLES.ANDROID_CLIENT);

  const ping = dispatch(session, DIRECT_SESSION_EVENTS.PING_SENT, {
    sequence: 17
  });
  assert.equal(ping.disposition, DIRECT_SESSION_DISPOSITIONS.UPDATED);
  assert.equal(session.snapshot().pingPending, true);

  const duplicate = dispatch(session, DIRECT_SESSION_EVENTS.PING_SENT, {
    sequence: 17
  });
  assert.equal(duplicate.disposition, DIRECT_SESSION_DISPOSITIONS.IDEMPOTENT);

  const pong = dispatch(session, DIRECT_SESSION_EVENTS.PONG_RECEIVED, {
    sequence: 17
  });
  assert.equal(pong.disposition, DIRECT_SESSION_DISPOSITIONS.UPDATED);
  assert.equal(session.state, DIRECT_SESSION_STATES.ACTIVE);
  assert.equal(session.snapshot().pingPending, false);
  assert.equal(session.snapshot().heartbeatMisses, 0);
});

test("three explicit heartbeat misses request deterministic close", () => {
  const { session } = createSession();
  reachActive(session, DIRECT_SESSION_ROLES.ANDROID_CLIENT);
  dispatch(session, DIRECT_SESSION_EVENTS.PING_SENT, { sequence: 1 });

  for (let count = 1; count <= 2; count += 1) {
    const missed = dispatch(session, DIRECT_SESSION_EVENTS.HEARTBEAT_MISSED);
    assert.equal(missed.disposition, DIRECT_SESSION_DISPOSITIONS.UPDATED);
    assert.equal(missed.heartbeatMisses, count);
    assert.equal(session.state, DIRECT_SESSION_STATES.ACTIVE);
  }
  const terminalMiss = dispatch(
    session,
    DIRECT_SESSION_EVENTS.HEARTBEAT_MISSED
  );
  assert.equal(terminalMiss.to, DIRECT_SESSION_STATES.CLOSING);
  assert.equal(terminalMiss.closeReason, "HEARTBEAT_TIMEOUT");
  assert.equal(session.snapshot().pingPending, false);
});

test("unsolicited or mismatched PONG fails closed", () => {
  const unsolicited = createSession().session;
  reachActive(unsolicited, DIRECT_SESSION_ROLES.ANDROID_CLIENT);
  const unsolicitedResult = dispatch(
    unsolicited,
    DIRECT_SESSION_EVENTS.PONG_RECEIVED,
    { sequence: 1 }
  );
  assert.equal(unsolicitedResult.failureCode, "UNSOLICITED_PONG");

  const mismatch = createSession().session;
  reachActive(mismatch, DIRECT_SESSION_ROLES.ANDROID_CLIENT);
  dispatch(mismatch, DIRECT_SESSION_EVENTS.PING_SENT, { sequence: 1 });
  const mismatchResult = dispatch(
    mismatch,
    DIRECT_SESSION_EVENTS.PONG_RECEIVED,
    { sequence: 2 }
  );
  assert.equal(mismatchResult.failureCode, "PONG_SEQUENCE_MISMATCH");
  assert.equal(mismatch.state, DIRECT_SESSION_STATES.FAILED);
});

test("clean close is two-phase, idempotent and resettable only when terminal", () => {
  const { session } = createSession();
  reachActive(session, DIRECT_SESSION_ROLES.ANDROID_CLIENT);

  const requested = dispatch(session, DIRECT_SESSION_EVENTS.CLOSE_REQUESTED, {
    reason: "LOCAL_CLOSE"
  });
  assert.equal(requested.to, DIRECT_SESSION_STATES.CLOSING);
  assert.equal(
    dispatch(session, DIRECT_SESSION_EVENTS.CLOSE_REQUESTED, {
      reason: "LOCAL_CLOSE"
    }).disposition,
    DIRECT_SESSION_DISPOSITIONS.IDEMPOTENT
  );
  const closed = dispatch(session, DIRECT_SESSION_EVENTS.TRANSPORT_CLOSED);
  assert.equal(closed.to, DIRECT_SESSION_STATES.CLOSED);
  assert.equal(session.snapshot().closeReason, "LOCAL_CLOSE");

  const reset = dispatch(session, DIRECT_SESSION_EVENTS.RESET);
  assert.equal(reset.to, DIRECT_SESSION_STATES.IDLE);
  assert.equal(session.sessionId, null);
  assert.equal(session.snapshot().negotiatedMtu, null);
});

test("terminal sessions cannot be reopened without reset", () => {
  const { session } = createSession();
  dispatch(session, DIRECT_SESSION_EVENTS.CLOSE_REQUESTED);

  const reopen = dispatch(session, DIRECT_SESSION_EVENTS.GATT_CONNECTED);

  assert.equal(reopen.disposition, DIRECT_SESSION_DISPOSITIONS.REJECTED);
  assert.equal(session.state, DIRECT_SESSION_STATES.CLOSED);
});

test("event objects reject unknown fields before sensitive data can enter state", () => {
  const { session } = createSession();

  assert.throws(
    () =>
      session.dispatch({
        type: DIRECT_SESSION_EVENTS.GATT_CONNECTED,
        nodeId: "must-not-enter"
      }),
    (error) =>
      error instanceof DirectSessionError &&
      error.code === "INVALID_EVENT_FIELDS"
  );
  assert.equal(session.state, DIRECT_SESSION_STATES.IDLE);
});

test("a regressing monotonic clock fails the session closed", () => {
  const { session, setNow } = createSession();
  dispatch(session, DIRECT_SESSION_EVENTS.GATT_CONNECTED);
  setNow(99);

  assert.throws(
    () => dispatch(session, DIRECT_SESSION_EVENTS.SERVICES_DISCOVERED),
    (error) =>
      error instanceof DirectSessionError &&
      error.code === "MONOTONIC_CLOCK_REGRESSION"
  );
  assert.equal(session.state, DIRECT_SESSION_STATES.FAILED);
  assert.equal(
    session.snapshot().failureCode,
    "MONOTONIC_CLOCK_REGRESSION"
  );
});

test("constructor rejects invalid roles and unsafe policy bounds", () => {
  assert.throws(
    () => new DirectSessionV1({ role: "peer" }),
    (error) =>
      error instanceof DirectSessionError &&
      error.code === "INVALID_SESSION_ROLE"
  );
  assert.throws(
    () =>
      new DirectSessionV1({
        role: DIRECT_SESSION_ROLES.ANDROID_CLIENT,
        preferredMtu: 22
      }),
    (error) =>
      error instanceof DirectSessionError &&
      error.code === "INVALID_PREFERRED_MTU"
  );
  assert.throws(
    () =>
      new DirectSessionV1({
        role: DIRECT_SESSION_ROLES.ANDROID_CLIENT,
        heartbeatMissesBeforeClose: 0
      }),
    (error) =>
      error instanceof DirectSessionError &&
      error.code === "INVALID_HEARTBEAT_MISSES_BEFORE_CLOSE"
  );
});
