import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  symlinkSync,
  unlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ADVERTISEMENT_SEQUENCE_RELATIONS,
  compareAdvertisementSequence,
  decodeNodeAdvertisement
} from "../../shared/protocol/advertisement-v1.mjs";
import { deriveRotatingAlias } from "../../shared/protocol/rotating-alias-v1.mjs";
import {
  LE_ADVERTISER_STATES,
  LeAdvertiser,
  RaspberryAdvertisementIdentityStoreV1
} from "../dist/bluez/LeAdvertiser.js";

const NODE_ID = "123e4567-e89b-42d3-a456-426614174000";
const START = 1_800_000_000_000;

class FakePort {
  running = false;
  payloads = [];
  stopCalls = 0;
  failReplace = false;

  async start({ payload }) {
    this.running = true;
    this.payloads.push(Buffer.from(payload));
    return this.snapshot();
  }

  async replace(payload) {
    if (this.failReplace) throw new Error("replace failed");
    assert.equal(this.running, true);
    this.payloads.push(Buffer.from(payload));
    return this.snapshot();
  }

  async stop() {
    this.stopCalls += 1;
    this.running = false;
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      state: this.running ? "REGISTERED" : "STOPPED",
      desiredRunning: this.running,
      registered: this.running,
      bluezOwnerAvailable: this.running,
      retryScheduled: false,
      registrationsTotal: this.payloads.length,
      replacementsTotal: Math.max(0, this.payloads.length - 1),
      ownerLossesTotal: 0,
      errorsTotal: 0,
      lastErrorCode: null
    });
  }
}

class FakeScheduler {
  nextId = 1;
  entries = new Map();

  set(handler, delayMs) {
    const id = this.nextId++;
    this.entries.set(id, { handler, delayMs });
    return id;
  }

  clear(id) {
    this.entries.delete(id);
  }

  runNext() {
    const [id, entry] = this.entries.entries().next().value ?? [];
    assert.notEqual(id, undefined);
    this.entries.delete(id);
    entry.handler();
    return entry.delayMs;
  }
}

function health(generation, reachable, observedAtEpochMs = START, overrides = {}) {
  return Object.freeze({
    generation,
    observedAtEpochMs,
    canReachServer: reachable,
    routeKind: reachable ? "LAN" : "NONE",
    serverRttBucket: reachable ? 2 : 15,
    queueDepthBucket: 0,
    batteryBucket: 15,
    ...overrides
  });
}

function fixture(overrides = {}) {
  let epoch = START;
  let monotonic = 10_000;
  const port = new FakePort();
  const scheduler = new FakeScheduler();
  const fatals = [];
  const advertiser = new LeAdvertiser({
    adapterName: "hci0",
    identity: Object.freeze({
      bootId: 23,
      deriveRotatingAlias(timestampSeconds) {
        const epochNumber = Math.floor(timestampSeconds / 60);
        return (epochNumber % 0x1_0000_0000_0000)
          .toString(16)
          .padStart(12, "0");
      }
    }),
    capabilities: 0x48,
    port,
    scheduler,
    epochNow: () => epoch,
    monotonicNow: () => monotonic,
    freshnessMs: 3_500,
    onFatal: (error) => fatals.push(error),
    ...overrides
  });
  return {
    advertiser,
    port,
    scheduler,
    fatals,
    setEpoch(value) { epoch = value; },
    setMonotonic(value) { monotonic = value; },
    advance(value) { epoch += value; monotonic += value; }
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("private identity persists one alias key and rotates boot on each lifecycle", () => {
  const directory = mkdtempSync(join(tmpdir(), "v6-advertiser-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "identity.json");
  const firstRandom = (length) =>
    length === 32 ? Buffer.alloc(32, 0x11) : Buffer.from([4]);
  const firstStore = new RaspberryAdvertisementIdentityStoreV1({
    path,
    nodeId: NODE_ID,
    randomBytes: firstRandom
  });
  const first = firstStore.beginBoot();
  assert.equal(first.bootId, 5);
  const expectedAlias = deriveRotatingAlias({
    aliasKey: Buffer.alloc(32, 0x11),
    nodeId: NODE_ID,
    timestampSeconds: Math.floor(START / 1_000),
    epochSeconds: 60
  });
  assert.equal(first.deriveRotatingAlias(Math.floor(START / 1_000)), expectedAlias);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.deepEqual(firstStore.snapshot(), {
    active: true,
    schemaVersion: 1,
    exposesAliasKey: false,
    exposesBootId: false
  });
  assert.equal(firstStore.toString().includes(expectedAlias), false);
  firstStore.close();

  const secondStore = new RaspberryAdvertisementIdentityStoreV1({
    path,
    nodeId: NODE_ID,
    randomBytes: () => Buffer.from([4])
  });
  const second = secondStore.beginBoot();
  assert.equal(second.bootId, 6);
  assert.equal(second.deriveRotatingAlias(Math.floor(START / 1_000)), expectedAlias);
  secondStore.close();
});

test("private identity refuses symlinks instead of replacing them", () => {
  const directory = mkdtempSync(join(tmpdir(), "v6-advertiser-link-"));
  chmodSync(directory, 0o700);
  const target = join(directory, "target.json");
  const path = join(directory, "identity.json");
  symlinkSync(target, path);
  const store = new RaspberryAdvertisementIdentityStoreV1({
    path,
    nodeId: NODE_ID,
    randomBytes: (length) => Buffer.alloc(length, 1)
  });
  assert.throws(() => store.beginBoot(), /cannot open advertisement identity/);
});

test("private identity refuses a symlink substituted between read and commit", () => {
  const directory = mkdtempSync(join(tmpdir(), "v6-advertiser-race-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "identity.json");
  const target = join(directory, "target.json");
  const firstStore = new RaspberryAdvertisementIdentityStoreV1({
    path,
    nodeId: NODE_ID,
    randomBytes: (length) =>
      length === 32 ? Buffer.alloc(32, 0x33) : Buffer.from([4])
  });
  firstStore.beginBoot();
  firstStore.close();

  let substituted = false;
  const secondStore = new RaspberryAdvertisementIdentityStoreV1({
    path,
    nodeId: NODE_ID,
    randomBytes: () => {
      if (!substituted) {
        unlinkSync(path);
        symlinkSync(target, path);
        substituted = true;
      }
      return Buffer.from([5]);
    }
  });
  assert.throws(
    () => secondStore.beginBoot(),
    /advertisement identity changed during commit/
  );
  assert.equal(lstatSync(path).isSymbolicLink(), true);
});

test("dynamic health updates only the discovery bit while snapshots retain redacted buckets", async () => {
  const value = fixture();
  await value.advertiser.start();
  assert.equal(decodeNodeAdvertisement(value.port.payloads[0]).serverReachable, false);

  await value.advertiser.updateRouteHealth(health(1, true));
  let decoded = decodeNodeAdvertisement(value.port.payloads.at(-1));
  assert.equal(decoded.serverReachable, true);
  assert.equal(decoded.sequence, 1);

  await value.advertiser.updateRouteHealth(
    health(2, true, START, { queueDepthBucket: 7, batteryBucket: 4 })
  );
  assert.equal(value.port.payloads.length, 2);
  assert.equal(value.advertiser.snapshot().queueDepthBucket, 7);
  assert.equal(value.advertiser.snapshot().batteryBucket, 4);
  assert.equal(JSON.stringify(value.advertiser.snapshot()).includes("rotatingAlias"), false);
  assert.equal(JSON.stringify(value.advertiser.snapshot()).includes("bootId"), false);

  await value.advertiser.updateRouteHealth(health(3, false));
  decoded = decodeNodeAdvertisement(value.port.payloads.at(-1));
  assert.equal(decoded.serverReachable, false);
  assert.equal(decoded.sequence, 2);
  await value.advertiser.stop();
});

test("health freshness timer downgrades a stale true advertisement fail closed", async () => {
  const value = fixture();
  await value.advertiser.updateRouteHealth(health(1, true));
  await value.advertiser.start();
  assert.equal(decodeNodeAdvertisement(value.port.payloads.at(-1)).serverReachable, true);
  value.advance(3_501);
  value.scheduler.runNext();
  await flush();
  const decoded = decodeNodeAdvertisement(value.port.payloads.at(-1));
  assert.equal(decoded.serverReachable, false);
  assert.equal(decoded.sequence, 1);
  assert.equal(value.advertiser.snapshot().staleDowngradesTotal, 1);
  await value.advertiser.stop();
});

test("clock or generation regression disconnects the port and reports one fatal", async () => {
  const value = fixture();
  await value.advertiser.start();
  await value.advertiser.updateRouteHealth(health(1, true));
  await assert.rejects(
    () => value.advertiser.updateRouteHealth(health(1, false)),
    /generation or clock regressed/
  );
  assert.equal(value.advertiser.snapshot().state, LE_ADVERTISER_STATES.FAILED);
  assert.equal(value.port.running, false);
  assert.equal(value.fatals.length, 1);
});

test("replacement failure disconnects instead of leaving a stale reachable bit", async () => {
  const value = fixture();
  await value.advertiser.start();
  value.port.failReplace = true;
  await assert.rejects(
    () => value.advertiser.updateRouteHealth(health(1, true)),
    /replace failed/
  );
  assert.equal(value.port.running, false);
  assert.equal(value.advertiser.snapshot().serverReachable, false);
  assert.equal(value.fatals.length, 1);
});

test("discovery sequence wraps 254 to 255 to 0 to 1 with one stable boot", async () => {
  const value = fixture();
  await value.advertiser.start();
  for (let generation = 1; generation <= 257; generation += 1) {
    await value.advertiser.updateRouteHealth(
      health(generation, generation % 2 === 1)
    );
  }
  const decoded = value.port.payloads.map((payload) =>
    decodeNodeAdvertisement(payload)
  );
  assert.deepEqual(decoded.slice(-4).map((item) => item.sequence), [254, 255, 0, 1]);
  assert.deepEqual(new Set(decoded.map((item) => item.bootId)), new Set([23]));

  const reference = decoded.at(-3);
  const wrapped = decoded.at(-2);
  assert.equal(
    compareAdvertisementSequence(wrapped, reference),
    ADVERTISEMENT_SEQUENCE_RELATIONS.NEWER
  );
  assert.equal(
    compareAdvertisementSequence({ ...reference, sequence: 254 }, reference),
    ADVERTISEMENT_SEQUENCE_RELATIONS.OLDER
  );
  assert.equal(
    compareAdvertisementSequence({ ...reference, sequence: 127 }, reference),
    ADVERTISEMENT_SEQUENCE_RELATIONS.AMBIGUOUS
  );
  await value.advertiser.stop();
});
