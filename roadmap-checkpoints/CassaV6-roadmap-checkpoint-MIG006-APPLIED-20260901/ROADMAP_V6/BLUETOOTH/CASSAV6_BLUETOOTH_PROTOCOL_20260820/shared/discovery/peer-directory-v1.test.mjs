import assert from "node:assert/strict";
import test from "node:test";

import { encodeNodeAdvertisement } from "../protocol/advertisement-v1.mjs";
import {
  DiscoveryStateError,
  MAX_PEER_STREAMS,
  MAX_NEW_STREAM_ATTEMPTS_PER_WINDOW,
  PEER_NEW_STREAM_WINDOW_MS,
  PEER_AGING_THROUGH_MS,
  PEER_FRESH_BEFORE_MS,
  PEER_OBSERVATION_OUTCOMES,
  PEER_RSSI_FLOOR_DBM,
  PEER_SOFT_STATES,
  PeerDirectoryV1,
  classifyPeerAge
} from "./peer-directory-v1.mjs";

const BASE_ADVERTISEMENT = Object.freeze({
  protocolVersion: 1,
  nodeKind: "handheld",
  rotatingAlias: "aabbccddeeff",
  bootId: 17,
  capabilities: 0x17,
  serverReachable: false,
  sequence: 100
});

function payload(fields = {}) {
  return encodeNodeAdvertisement({ ...BASE_ADVERTISEMENT, ...fields });
}

function createDirectory(initialNowMs = 0, options = {}) {
  let nowMs = initialNowMs;
  const directory = new PeerDirectoryV1({
    clock: () => nowMs,
    ...options
  });
  return {
    directory,
    setNow(value) {
      nowMs = value;
    }
  };
}

function observe(directory, fields = {}, rssiDbm = -60) {
  return directory.observeServiceData({
    payload: payload(fields),
    rssiDbm
  });
}

test("soft-state boundaries keep 15000 ms aging and expire only above it", () => {
  assert.equal(classifyPeerAge(4_999), PEER_SOFT_STATES.FRESH);
  assert.equal(classifyPeerAge(5_000), PEER_SOFT_STATES.AGING);
  assert.equal(classifyPeerAge(15_000), PEER_SOFT_STATES.AGING);
  assert.equal(classifyPeerAge(15_001), PEER_SOFT_STATES.EXPIRED);
  assert.equal(PEER_FRESH_BEFORE_MS, 5_000);
  assert.equal(PEER_AGING_THROUGH_MS, 15_000);
});

test("directory decodes the B1 payload and stores only an anonymous stream", () => {
  const { directory } = createDirectory();
  const result = observe(directory);

  assert.equal(result.accepted, true);
  assert.equal(result.outcome, PEER_OBSERVATION_OUTCOMES.INSERTED);
  assert.equal(result.streamKey, "aabbccddeeff:17");
  assert.deepEqual(result.peer.advertisement, BASE_ADVERTISEMENT);
  assert.equal(Object.hasOwn(result.peer, "nodeId"), false);
  assert.equal(Object.hasOwn(result.peer, "authenticated"), false);
});

test("RSSI floor accepts -88 dBm and rejects values below it", () => {
  const { directory } = createDirectory();

  assert.equal(observe(directory, {}, PEER_RSSI_FLOOR_DBM).accepted, true);
  const rejected = observe(
    directory,
    { rotatingAlias: "000000000001" },
    PEER_RSSI_FLOOR_DBM - 1
  );

  assert.equal(rejected.accepted, false);
  assert.equal(rejected.outcome, PEER_OBSERVATION_OUTCOMES.BELOW_RSSI_FLOOR);
  assert.equal(directory.size, 1);
  assert.equal(directory.metrics().belowRssiFloorTotal, 1);
});

test("identical duplicate refreshes lastSeen and RSSI without a new generation", () => {
  const { directory, setNow } = createDirectory();
  observe(directory, {}, -70);
  setNow(4_999);

  const duplicate = observe(directory, {}, -45);

  assert.equal(
    duplicate.outcome,
    PEER_OBSERVATION_OUTCOMES.DUPLICATE_REFRESHED
  );
  assert.equal(duplicate.peer.firstSeenMs, 0);
  assert.equal(duplicate.peer.lastSeenMs, 4_999);
  assert.equal(duplicate.peer.lastRssiDbm, -45);
  assert.equal(duplicate.peer.acceptedObservations, 2);
  assert.equal(duplicate.peer.semanticGeneration, 1);
});

test("same sequence with different semantics is rejected without refresh", () => {
  const { directory, setNow } = createDirectory();
  observe(directory, {}, -70);
  setNow(1_000);

  const conflict = observe(directory, { capabilities: 0x07 }, -40);
  const peer = directory.snapshot().peers[0];

  assert.equal(conflict.accepted, false);
  assert.equal(
    conflict.outcome,
    PEER_OBSERVATION_OUTCOMES.SEQUENCE_CONFLICT
  );
  assert.equal(peer.lastSeenMs, 0);
  assert.equal(peer.lastRssiDbm, -70);
  assert.equal(peer.advertisement.capabilities, 0x17);
});

test("newer sequence replaces semantics and handles 255 to 0 wrap", () => {
  const { directory, setNow } = createDirectory();
  observe(directory, { sequence: 255, serverReachable: false });
  setNow(100);

  const newer = observe(directory, {
    sequence: 0,
    serverReachable: true
  });

  assert.equal(newer.outcome, PEER_OBSERVATION_OUTCOMES.NEWER_REPLACED);
  assert.equal(newer.peer.advertisement.sequence, 0);
  assert.equal(newer.peer.advertisement.serverReachable, true);
  assert.equal(newer.peer.semanticGeneration, 2);
  assert.equal(newer.peer.lastSeenMs, 100);
});

test("older sequence is rejected without refreshing lastSeen or RSSI", () => {
  const { directory, setNow } = createDirectory();
  observe(directory, {}, -70);
  setNow(1_000);

  const older = observe(directory, { sequence: 99 }, -40);
  const peer = directory.snapshot().peers[0];

  assert.equal(older.outcome, PEER_OBSERVATION_OUTCOMES.OLDER_REJECTED);
  assert.equal(peer.lastSeenMs, 0);
  assert.equal(peer.lastRssiDbm, -70);
  assert.equal(peer.advertisement.sequence, 100);
});

test("half-range ambiguous sequence is rejected without refresh", () => {
  const { directory, setNow } = createDirectory();
  observe(directory, {}, -70);
  setNow(1_000);

  const ambiguous = observe(directory, { sequence: 228 }, -40);
  const peer = directory.snapshot().peers[0];

  assert.equal(
    ambiguous.outcome,
    PEER_OBSERVATION_OUTCOMES.AMBIGUOUS_REJECTED
  );
  assert.equal(peer.lastSeenMs, 0);
  assert.equal(peer.lastRssiDbm, -70);
});

test("different aliases or boot IDs coexist as independent streams", () => {
  const { directory } = createDirectory();

  observe(directory);
  observe(directory, { rotatingAlias: "aabbccddee00" });
  observe(directory, { bootId: 18 });

  const keys = directory.snapshot().peers.map((peer) => peer.streamKey);
  assert.deepEqual(keys, [
    "aabbccddee00:17",
    "aabbccddeeff:17",
    "aabbccddeeff:18"
  ]);
});

test("invalid payload is rejected by the shared B1 decoder", () => {
  const { directory } = createDirectory();
  const short = directory.observeServiceData({
    payload: new Uint8Array(9),
    rssiDbm: -60
  });
  const reservedHeader = payload();
  reservedHeader[0] |= 0x80;
  const reserved = directory.observeServiceData({
    payload: reservedHeader,
    rssiDbm: -60
  });

  assert.equal(short.outcome, PEER_OBSERVATION_OUTCOMES.INVALID_PAYLOAD);
  assert.equal(short.protocolErrorCode, "INVALID_PAYLOAD_LENGTH");
  assert.equal(reserved.outcome, PEER_OBSERVATION_OUTCOMES.INVALID_PAYLOAD);
  assert.equal(reserved.protocolErrorCode, "RESERVED_HEADER_BITS");
  assert.equal(directory.size, 0);
});

test("age state is visible at all four normative boundaries", () => {
  const { directory, setNow } = createDirectory();
  observe(directory);

  for (const [ageMs, expected] of [
    [4_999, PEER_SOFT_STATES.FRESH],
    [5_000, PEER_SOFT_STATES.AGING],
    [15_000, PEER_SOFT_STATES.AGING],
    [15_001, PEER_SOFT_STATES.EXPIRED]
  ]) {
    setNow(ageMs);
    assert.equal(directory.snapshot().peers[0].state, expected);
  }
});

test("an expired reference is removed before sequence comparison", () => {
  const { directory, setNow } = createDirectory();
  observe(directory, { sequence: 100 });
  setNow(15_001);

  const recreated = observe(directory, { sequence: 1 });

  assert.equal(recreated.outcome, PEER_OBSERVATION_OUTCOMES.INSERTED);
  assert.equal(recreated.peer.firstSeenMs, 15_001);
  assert.equal(recreated.peer.semanticGeneration, 1);
  const metrics = directory.metrics();
  assert.equal(metrics.expiredRemovedTotal, 1);
  assert.equal(metrics.insertedTotal, 2);
});

test("directory enforces 1024 streams and reports capacity pressure", () => {
  const { directory } = createDirectory();
  for (let index = 0; index < MAX_PEER_STREAMS; index += 1) {
    const result = observe(directory, {
      rotatingAlias: index.toString(16).padStart(12, "0")
    });
    assert.equal(result.accepted, true);
  }

  const rejected = observe(directory, {
    rotatingAlias: "ffffffffffff"
  });
  const metrics = directory.metrics();

  assert.equal(rejected.outcome, PEER_OBSERVATION_OUTCOMES.CAPACITY_REJECTED);
  assert.equal(directory.size, MAX_PEER_STREAMS);
  assert.equal(metrics.capacityRejectedTotal, 1);
  assert.equal(metrics.capacityHighWatermarkStreams, MAX_PEER_STREAMS);
  assert.equal(metrics.capacityLimitStreams, MAX_PEER_STREAMS);
  assert.equal(metrics.capacityUtilization, 1);
  assert.equal(
    metrics.maxNewStreamAttemptsPerWindow,
    MAX_NEW_STREAM_ATTEMPTS_PER_WINDOW
  );
  assert.equal(
    metrics.observationsTotal,
    metrics.acceptedTotal + metrics.rejectedTotal
  );
});

test("capacity pressure replaces only an aging or meaningfully weaker peer", () => {
  const { directory } = createDirectory(0, {
    maxStreams: 2,
    maxNewStreamAttemptsPerWindow: 3
  });
  observe(directory, { rotatingAlias: "000000000001" }, -70);
  observe(directory, { rotatingAlias: "000000000002" }, -60);

  const replacement = observe(
    directory,
    { rotatingAlias: "000000000003" },
    -63
  );

  assert.equal(replacement.accepted, true);
  assert.equal(
    replacement.outcome,
    PEER_OBSERVATION_OUTCOMES.CAPACITY_EVICTED_INSERTED
  );
  assert.equal(replacement.evictedStreamKey, "000000000001:17");
  assert.equal(directory.size, 2);
  assert.equal(directory.metrics().capacityEvictedTotal, 1);
});

test("capacity replacement enforces the exact +6 dB RSSI boundary", () => {
  const acceptedCase = createDirectory(0, {
    maxStreams: 1,
    maxNewStreamAttemptsPerWindow: 2
  }).directory;
  observe(acceptedCase, { rotatingAlias: "000000000001" }, -70);
  const exactMargin = observe(
    acceptedCase,
    { rotatingAlias: "000000000002" },
    -64
  );
  assert.equal(
    exactMargin.outcome,
    PEER_OBSERVATION_OUTCOMES.CAPACITY_EVICTED_INSERTED
  );

  const rejectedCase = createDirectory(0, {
    maxStreams: 1,
    maxNewStreamAttemptsPerWindow: 2
  }).directory;
  observe(rejectedCase, { rotatingAlias: "000000000001" }, -70);
  const belowMargin = observe(
    rejectedCase,
    { rotatingAlias: "000000000002" },
    -65
  );
  assert.equal(
    belowMargin.outcome,
    PEER_OBSERVATION_OUTCOMES.CAPACITY_REJECTED
  );
});

test("an aging least-recent peer can be replaced even by a weaker signal", () => {
  const { directory, setNow } = createDirectory(0, {
    maxStreams: 2,
    maxNewStreamAttemptsPerWindow: 3
  });
  observe(directory, { rotatingAlias: "000000000001" }, -50);
  setNow(1);
  observe(directory, { rotatingAlias: "000000000002" }, -60);
  setNow(5_000);

  const replacement = observe(
    directory,
    { rotatingAlias: "000000000003" },
    -80
  );
  assert.equal(
    replacement.outcome,
    PEER_OBSERVATION_OUTCOMES.CAPACITY_EVICTED_INSERTED
  );
  assert.equal(replacement.evictedStreamKey, "000000000001:17");
});

test("new anonymous stream churn is bounded and resets in the next window", () => {
  const { directory, setNow } = createDirectory(0, {
    maxStreams: 2,
    maxNewStreamAttemptsPerWindow: 3
  });
  observe(directory, { rotatingAlias: "000000000001" }, -70);
  observe(directory, { rotatingAlias: "000000000002" }, -60);
  observe(directory, { rotatingAlias: "000000000003" }, -50);

  const limited = observe(
    directory,
    { rotatingAlias: "000000000004" },
    -40
  );
  assert.equal(
    limited.outcome,
    PEER_OBSERVATION_OUTCOMES.NEW_STREAM_RATE_REJECTED
  );
  assert.equal(directory.metrics().newStreamRateRejectedTotal, 1);

  setNow(PEER_NEW_STREAM_WINDOW_MS);
  const nextWindow = observe(
    directory,
    { rotatingAlias: "000000000004" },
    -40
  );
  assert.equal(nextWindow.accepted, true);
  assert.equal(
    nextWindow.outcome,
    PEER_OBSERVATION_OUTCOMES.CAPACITY_EVICTED_INSERTED
  );
  assert.equal(directory.metrics().newStreamWindowsStartedTotal, 2);
});

test("a rejected-alias flood is throttled before repeated prune work", () => {
  const { directory } = createDirectory(0, {
    maxStreams: 2,
    maxNewStreamAttemptsPerWindow: 3
  });
  observe(directory, { rotatingAlias: "000000000001" }, -60);
  observe(directory, { rotatingAlias: "000000000002" }, -60);

  for (let index = 3; index <= 1_002; index += 1) {
    observe(
      directory,
      { rotatingAlias: index.toString(16).padStart(12, "0") },
      -80
    );
  }

  const metrics = directory.metrics();
  assert.equal(metrics.capacityRejectedTotal, 1);
  assert.equal(metrics.newStreamRateRejectedTotal, 999);
  assert.equal(metrics.newStreamAttemptsTotal, 3);
  assert.equal(metrics.prunePassesTotal, 1);
});

test("automatic expiry pruning is cadence-limited", () => {
  const { directory, setNow } = createDirectory();
  observe(directory);
  setNow(100);
  observe(directory);
  setNow(999);
  observe(directory);
  assert.equal(directory.metrics().prunePassesTotal, 1);

  setNow(1_000);
  observe(directory);
  assert.equal(directory.metrics().prunePassesTotal, 2);
});

test("expired streams are pruned and release capacity", () => {
  const { directory, setNow } = createDirectory();
  observe(directory);
  setNow(15_001);

  const pruning = directory.pruneExpired();

  assert.deepEqual(pruning, {
    prunedAtMs: 15_001,
    removed: 1,
    remaining: 0,
    removedStreamKeys: ["aabbccddeeff:17"]
  });
  assert.equal(directory.metrics().expiredRemovedTotal, 1);
});

test("accepted refresh keeps the expiry order aligned with lastSeen", () => {
  const { directory, setNow } = createDirectory();
  observe(directory, { rotatingAlias: "000000000001" });
  observe(directory, { rotatingAlias: "000000000002" });
  setNow(14_000);
  observe(directory, { rotatingAlias: "000000000001" });
  setNow(16_000);

  const pruning = directory.pruneExpired();

  assert.deepEqual(pruning.removedStreamKeys, ["000000000002:17"]);
  assert.deepEqual(
    directory.snapshot().peers.map((peer) => peer.streamKey),
    ["000000000001:17"]
  );
});

test("clock regression is rejected and counted", () => {
  const { directory, setNow } = createDirectory(10);
  observe(directory);
  setNow(9);

  assert.throws(
    () => directory.snapshot(),
    (error) =>
      error instanceof DiscoveryStateError &&
      error.code === "MONOTONIC_CLOCK_REGRESSION"
  );

  setNow(10);
  assert.equal(directory.metrics().clockRegressionTotal, 1);
});
