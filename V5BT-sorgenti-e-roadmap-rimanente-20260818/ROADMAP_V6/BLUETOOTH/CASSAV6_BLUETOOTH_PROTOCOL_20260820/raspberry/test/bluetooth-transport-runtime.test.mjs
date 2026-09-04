import assert from "node:assert/strict";
import test from "node:test";

import { BackendHealthProbe } from "../dist/backend/BackendHealthProbe.js";
import {
  BLUETOOTH_SHADOW_KINDS,
  encodeBluetoothShadowMessageV1
} from "../dist/backend/BluetoothShadowIngress.js";
import {
  RELIABLE_FRAME_TYPES
} from "../dist/protocol/FrameCodec.js";
import {
  ROUTE_ADVERTISEMENT_KINDS,
  RouteAdvertisementPublisherV1,
  decodeRouteAdvertisementV1,
  encodeRouteAdvertisementV1
} from "../dist/routing/RouteAdvertisementV1.js";
import {
  BLUETOOTH_TRANSPORT_RUNTIME_STATES,
  BluetoothTransportRuntimeError,
  BluetoothTransportRuntimeV1
} from "../dist/node/BluetoothTransportRuntimeV1.js";

const START = 1_800_000_000_000;

function streamReader(value) {
  let delivered = false;
  return {
    async read() {
      if (delivered) return { done: true };
      delivered = true;
      return { done: false, value: Buffer.from(value) };
    },
    releaseLock() {}
  };
}

class FakeScheduler {
  handlers = new Set();
  set(handler) {
    this.handlers.add(handler);
    return handler;
  }
  clear(handler) {
    this.handlers.delete(handler);
  }
  run() {
    for (const handler of [...this.handlers]) handler();
  }
}

class FakeStore {
  routes = [];
  routeSequence = 0;
  reserveRouteAdvertisementSequence() {
    this.routeSequence += 1;
    return this.routeSequence;
  }
  routeAdvertisementSequenceHighWatermark() {
    return this.routeSequence;
  }
  storeLastServerAdvertisement(value) {
    const previous = this.routes.at(-1);
    if (previous !== undefined && value.sequence <= previous.sequence) {
      throw new Error("ROUTE_SEQUENCE_REPLAY");
    }
    this.routes.push(value);
  }
  snapshot() {
    return Object.freeze({
      outboxDepth: 0,
      inboxDedupDepth: 0,
      knownPeerCount: 0,
      sessionHistoryCount: 0,
      openSessionCount: 0,
      hasServerAdvertisement: this.routes.length > 0,
      schemaVersion: 3
    });
  }
}

class FakeDataPlane {
  enabled = true;
  bound = true;
  dataSubscribed = true;
  sessionBinds = 1;
  pendingMessages = 0;
  restored = 0;
  resetCalls = 0;
  ticks = 0;
  sent = [];
  async tick() {
    this.ticks += 1;
    return { retried: 0, suspended: 0, expired: 0 };
  }
  async restoreBound() {
    this.restored += 1;
    return 2;
  }
  async sendBound(input) {
    this.sent.push({ ...input, payload: Buffer.from(input.payload) });
    return { messageId: "00112233445566778899aabbccddeeff", durableCommitted: false };
  }
  reset() {
    this.resetCalls += 1;
    this.bound = false;
  }
  snapshot() {
    return Object.freeze({
      enabled: true,
      bound: this.bound,
      dataSubscribed: this.dataSubscribed,
      ackSubscribed: true,
      receivedFragments: 0,
      publishedFragments: 0,
      sessionBinds: this.sessionBinds,
      resets: this.resetCalls,
      failures: 0,
      channel: this.bound
        ? {
            framesTx: 0,
            framesRx: 0,
            messagesTx: 0,
            messagesRx: 0,
            acknowledgementsTx: 0,
            acknowledgementsRx: 0,
            retries: 0,
            duplicates: 0,
            expired: 0,
            deliveryFailures: 0,
            pendingMessages: this.pendingMessages,
            suspendedMessages: 0,
            outboxDepth: 0,
            inboxDedupDepth: 0,
            reassemblyOpenMessages: 0,
            reassemblyBufferedBytes: 0
          }
        : null
    });
  }
}

function message(type, payload) {
  return Object.freeze({
    type,
    flags: 0,
    sequence: 1,
    messageId: "10112233445566778899aabbccddeeff",
    expiresAtEpochMs: START + 60_000,
    payload: Buffer.from(payload)
  });
}

function createRuntime(overrides = {}) {
  let now = START;
  let monotonic = 1_000;
  const scheduler = new FakeScheduler();
  const store = new FakeStore();
  const dataPlane = new FakeDataPlane();
  const shadow = [];
  const fatals = [];
  const healthProbe = new BackendHealthProbe({
    url: "http://127.0.0.1:5381/api/health",
    fetch: async () => ({
      status: 200,
      redirected: false,
      headers: { get: (name) => name === "content-type" ? "application/json" : null },
      body: { getReader: () => streamReader('{"ok":true}') }
    }),
    monotonicNow: () => ++monotonic,
    epochNow: () => now
  });
  const runtime = new BluetoothTransportRuntimeV1({
    routeAdvertisementEnabled: true,
    shadowEnabled: true,
    store,
    healthProbe,
    shadowHandler: async (value) => shadow.push(value),
    routePublisher: new RouteAdvertisementPublisherV1(1_000),
    scheduler,
    tickIntervalMs: 50,
    healthIntervalMs: 1_000,
    now: () => now,
    onFatal: (error) => fatals.push(error),
    ...overrides
  });
  runtime.attachDataPlane(dataPlane);
  return {
    runtime,
    scheduler,
    store,
    dataPlane,
    shadow,
    fatals,
    setNow(value) { now = value; }
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("runtime rejects shadow without route advertisement", () => {
  assert.throws(
    () =>
      createRuntime({
        routeAdvertisementEnabled: false,
        shadowEnabled: true
      }),
    (error) =>
      error instanceof BluetoothTransportRuntimeError &&
      error.code === "INVALID_RUNTIME_CONFIGURATION"
  );
});

test("runtime restores durable state and publishes a bounded route only when bound", async () => {
  const fixture = createRuntime();
  fixture.runtime.start();
  await flush();
  assert.equal(fixture.dataPlane.restored, 1);
  assert.equal(fixture.dataPlane.sent.length, 1);
  assert.equal(fixture.dataPlane.sent[0].type, RELIABLE_FRAME_TYPES.ROUTE_ADVERTISEMENT);
  assert.equal(fixture.dataPlane.sent[0].durable, false);
  assert.equal(fixture.dataPlane.sent[0].ttlMs, 15_000);
  const snapshot = fixture.runtime.snapshot();
  assert.equal(snapshot.state, BLUETOOTH_TRANSPORT_RUNTIME_STATES.RUNNING);
  assert.equal(snapshot.restoredDurableMessages, 2);
  assert.equal(snapshot.routesSent, 1);
  assert.equal(snapshot.routeReachable, true);
  assert.equal(snapshot.businessMessagesForwarded, 0);
  assert.deepEqual(fixture.runtime.metricsSnapshot(), {
    framesTx: 0,
    framesRx: 0,
    retries: 0,
    duplicates: 0,
    outboxDepth: 0
  });
  await fixture.runtime.stop();
  assert.equal(fixture.scheduler.handlers.size, 0);
  assert.equal(fixture.dataPlane.resetCalls, 1);
  assert.deepEqual(fixture.runtime.metricsSnapshot(), {
    framesTx: null,
    framesRx: null,
    retries: null,
    duplicates: null,
    outboxDepth: 0
  });
});

test("runtime persists route observations, accepts diagnostic shadow and rejects business", async () => {
  const fixture = createRuntime();
  fixture.runtime.start();
  await flush();
  const route = encodeRouteAdvertisementV1({
    canReachServer: true,
    routeKind: ROUTE_ADVERTISEMENT_KINDS.WIFI,
    serverRttBucket: 2,
    routeAgeSeconds: 3,
    queueDepthBucket: 0,
    batteryBucket: 8,
    sequence: 1
  });
  await fixture.runtime.handleMessage(
    message(RELIABLE_FRAME_TYPES.ROUTE_ADVERTISEMENT, route)
  );
  assert.equal(fixture.store.routes.length, 1);
  assert.equal(fixture.store.routes[0].routeKind, "WIFI");

  const shadow = encodeBluetoothShadowMessageV1({
    schemaVersion: 1,
    kind: BLUETOOTH_SHADOW_KINDS.HEALTH,
    correlationId: "20112233445566778899aabbccddeeff",
    sentAtEpochMs: START,
    lanLatencyMs: 20,
    body: "ok"
  });
  await fixture.runtime.handleMessage(
    message(RELIABLE_FRAME_TYPES.SHADOW_DIAGNOSTIC, shadow)
  );
  assert.equal(fixture.shadow.length, 1);
  await assert.rejects(
    () => fixture.runtime.handleMessage(
      message(RELIABLE_FRAME_TYPES.DATA, Buffer.from("order"))
    ),
    (error) =>
      error instanceof BluetoothTransportRuntimeError &&
      error.code === "BUSINESS_MESSAGE_FORBIDDEN"
  );
  assert.equal(fixture.runtime.snapshot().businessMessagesRejected, 1);
  assert.equal(fixture.runtime.snapshot().businessMessagesForwarded, 0);
  await fixture.runtime.stop();
});

test("clock regression fails closed, removes the timer and resets session keys", async () => {
  const routeHealth = [];
  const fixture = createRuntime({
    onRouteHealth: async (value) => routeHealth.push(value)
  });
  fixture.runtime.start();
  await flush();
  assert.equal(routeHealth.length, 1);
  assert.equal(routeHealth[0].canReachServer, true);
  assert.equal(routeHealth[0].routeKind, "LAN");
  assert.equal(routeHealth[0].serverRttBucket, 0);
  assert.equal(routeHealth[0].queueDepthBucket, 0);
  assert.equal(routeHealth[0].batteryBucket, 15);
  fixture.setNow(START - 1);
  fixture.scheduler.run();
  await flush();
  assert.equal(
    fixture.runtime.snapshot().state,
    BLUETOOTH_TRANSPORT_RUNTIME_STATES.FAILED
  );
  assert.equal(fixture.runtime.snapshot().tickFailures, 1);
  assert.equal(fixture.scheduler.handlers.size, 0);
  assert.equal(fixture.dataPlane.resetCalls, 1);
  assert.equal(fixture.fatals.length, 1);
  assert.equal(routeHealth.length, 2);
  assert.equal(routeHealth[1].canReachServer, false);
  assert.equal(routeHealth[1].routeKind, "NONE");
  assert.equal(routeHealth[1].generation, 2);
  const serialized = JSON.stringify(fixture.runtime.snapshot().routeHealth);
  assert.equal(serialized.includes("rttMs"), false);
  assert.equal(serialized.includes('"queueDepth":'), false);
  assert.equal(serialized.includes("batteryPercent"), false);
});

test("reachability changes force a route update inside the three-second probe cadence", async () => {
  let reachable = true;
  let epoch = START;
  let monotonic = 10;
  const healthProbe = new BackendHealthProbe({
    url: "http://127.0.0.1:5381/api/health",
    fetch: async () => ({
      status: reachable ? 200 : 503,
      redirected: false,
      headers: { get: (name) => name === "content-type" ? "application/json" : null },
      body: { getReader: () => streamReader('{"ok":true}') }
    }),
    monotonicNow: () => ++monotonic,
    epochNow: () => epoch
  });
  const fixture = createRuntime({
    healthProbe,
    healthIntervalMs: 3_000,
    routePublisher: new RouteAdvertisementPublisherV1(5_000)
  });
  fixture.setNow(epoch);
  fixture.runtime.start();
  await flush();
  assert.equal(fixture.dataPlane.sent.length, 1);
  reachable = false;
  epoch += 3_000;
  fixture.setNow(epoch);
  fixture.scheduler.run();
  await flush();
  assert.equal(fixture.dataPlane.sent.length, 2);
  assert.equal(
    decodeRouteAdvertisementV1(fixture.dataPlane.sent[1].payload).canReachServer,
    false
  );
  await fixture.runtime.stop();
});
