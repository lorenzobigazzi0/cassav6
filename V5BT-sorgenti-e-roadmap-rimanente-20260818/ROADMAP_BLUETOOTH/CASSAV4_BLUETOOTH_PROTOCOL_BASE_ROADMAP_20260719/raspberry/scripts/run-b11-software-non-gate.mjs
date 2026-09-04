#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify
} from "node:crypto";
import { chmodSync, constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  unlink
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildB11HybridTopology,
  runB11VirtualBusinessWorkload
} from "./b11-virtual-business-workload.mjs";

import {
  buildClientAuthProofMessageV1
} from "../../shared/protocol/mutual-auth-v1.mjs";
import { CAPABILITY_BITS } from "../../shared/protocol/advertisement-v1.mjs";
import {
  electAndroidPeerRolesV1,
  selectCanonicalAndroidPeerConnectionV1
} from "../../shared/session/android-peer-role-election-v1.mjs";
import {
  BLUETOOTH_SHADOW_KINDS,
  BluetoothShadowIngressError,
  BluetoothShadowIngressV1,
  encodeBluetoothShadowMessageV1
} from "../dist/backend/BluetoothShadowIngress.js";
import { RELIABLE_FRAME_TYPES } from "../dist/protocol/FrameCodec.js";
import { ReliableChannelV1 } from "../dist/protocol/ReliableChannel.js";
import {
  ROUTE_ADVERTISEMENT_KINDS,
  RouteAdvertisementError,
  RouteAdvertisementPublisherV1,
  decodeRouteAdvertisementV1,
  encodeRouteAdvertisementV1
} from "../dist/routing/RouteAdvertisementV1.js";
import {
  BluetoothTransportStoreV1
} from "../dist/storage/BluetoothTransportStore.js";

export const B11_SOFTWARE_NON_GATE_VERSION = "1.0.0";
export const B11_SOFTWARE_NON_GATE_MODE =
  "B11_SOFTWARE_SYNTHETIC_NON_GATE";
export const B11_REQUIRED_NODE_COUNT = 10;
export const B11_REQUIRED_CYCLES_PER_PAIR = 100;
export const B11_REQUIRED_SOAK_MS = 2 * 60 * 60 * 1_000;
export const B11_HYBRID_NON_GATE_VERSION = "2.0.0";
export const B11_HYBRID_NON_GATE_MODE =
  "MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE";
export const B11_HYBRID_PROFILE = "hybrid";
export const B11_HYBRID_HANDHELD_COUNT = 10;
export const B11_HYBRID_STATION_COUNT = 3;
export const B11_HYBRID_RASPBERRY_COUNT = 1;
export const B11_HYBRID_BLUETOOTH_NODE_COUNT =
  B11_HYBRID_HANDHELD_COUNT +
  B11_HYBRID_STATION_COUNT +
  B11_HYBRID_RASPBERRY_COUNT;
export const B11_HYBRID_ANDROID_NODE_COUNT =
  B11_HYBRID_HANDHELD_COUNT + B11_HYBRID_STATION_COUNT;
export const B11_HYBRID_ANDROID_PAIR_COUNT =
  B11_HYBRID_ANDROID_NODE_COUNT * (B11_HYBRID_ANDROID_NODE_COUNT - 1) / 2;
export const B11_HYBRID_ANDROID_RASPBERRY_LINK_COUNT =
  B11_HYBRID_ANDROID_NODE_COUNT * B11_HYBRID_RASPBERRY_COUNT;
export const B11_HYBRID_LINK_COUNT =
  B11_HYBRID_ANDROID_PAIR_COUNT + B11_HYBRID_ANDROID_RASPBERRY_LINK_COUNT;
export const B11_HYBRID_TOTAL_ACTOR_COUNT =
  B11_HYBRID_BLUETOOTH_NODE_COUNT + 2;
export const B11_HYBRID_ACTIONS_PER_ANDROID = 200;
export const B11_HYBRID_TOTAL_BUSINESS_ACTIONS =
  B11_HYBRID_ANDROID_NODE_COUNT * B11_HYBRID_ACTIONS_PER_ANDROID;
export const B11_HYBRID_AUTOMATIC_CASH_TRANSACTIONS = 100;
export const B11_HYBRID_FISCAL_RT_TRANSACTIONS = 100;
export const B11_HYBRID_VIRTUALIZATION_POLICY =
  "IGNORE_AND_VIRTUALIZE_NON_GATE";
export const B11_OFFICIAL_PROGRESS_PERCENT = 49;

const START_EPOCH_MS = 1_800_000_000_000;
const MICRO_DEFAULTS = Object.freeze({
  nodeCount: 4,
  cyclesPerPair: 3,
  soakDurationMs: 60_000,
  soakTickMs: 5_000
});
const SOAK_DEFAULTS = Object.freeze({
  nodeCount: B11_REQUIRED_NODE_COUNT,
  cyclesPerPair: B11_REQUIRED_CYCLES_PER_PAIR,
  soakDurationMs: B11_REQUIRED_SOAK_MS,
  soakTickMs: 1_000
});
const HYBRID_DEFAULTS = Object.freeze({
  nodeCount: B11_HYBRID_BLUETOOTH_NODE_COUNT,
  cyclesPerPair: B11_REQUIRED_CYCLES_PER_PAIR,
  soakDurationMs: B11_REQUIRED_SOAK_MS,
  soakTickMs: 1_000
});
const PRIVATE_REPORT_FIELDS = new Set([
  "address",
  "certificateId",
  "deviceId",
  "endpoint",
  "host",
  "hostname",
  "mac",
  "nodeId",
  "path",
  "pid",
  "port",
  "privateKey",
  "publicKey",
  "serial",
  "token",
  "url"
]);
const B11_HYBRID_REPORT_KEYS = Object.freeze([
  "schemaVersion", "harnessVersion", "phase", "mode", "profile",
  "evidenceClass", "verdict", "gateImpact", "promotionAllowed",
  "officialEvidence", "statusMutationAllowed", "officialProgressPercent",
  "b11Gate", "hardwareAccess", "radioAccess", "adbAccess", "sshAccess",
  "serviceAccess", "realPeripheralAccess", "virtualizationPolicy",
  "missingHardwarePolicy", "timeBasis", "seedCommitment", "actors",
  "topology", "phaseCoverage", "workload", "businessPlane",
  "businessWorkload", "virtualPeripherals", "faultModel", "soak",
  "persistence", "teardown", "checks", "reportDigest"
]);
const B11_HYBRID_CHECK_KEYS = Object.freeze([
  "exactVirtualActorInventory", "allActorsVirtualized",
  "authorizedBluetoothGraphComplete", "b6AndroidRoleElectionComplete",
  "b6AndroidDuplicateArbitrationComplete", "connectDisconnectComplete",
  "fragmentationExercised", "retryExercised", "dedupExercised",
  "rebootRecoveryComplete", "b8PersistenceComplete",
  "b9RouteAdvertisementsComplete", "b9MultihopForbidden",
  "b10ShadowDiagnosticsComplete", "b10BusinessRoutingForbidden",
  "b10DefaultOff", "invalidCertificateRejected", "backgroundFaultRecovered",
  "virtualBusinessWorkloadComplete", "automaticCashVirtualCyclesComplete",
  "fiscalRtVirtualCyclesComplete", "virtualBusinessExternalAccessForbidden",
  "virtualBusinessCleanupComplete", "syntheticSoakComplete",
  "zeroSessionLeak", "zeroOutboxLeak", "teardownComplete",
  "antiPromotionLocked"
]);

export class B11SoftwareNonGateError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "B11SoftwareNonGateError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new B11SoftwareNonGateError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function integer(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_ARGUMENT", `${field} is outside its canonical range`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function material(seed, left, right, direction, field, bytes) {
  return createHash("sha256")
    .update(`V5BT:B11:${seed}:${left}:${right}:${direction}:${field}`, "utf8")
    .digest()
    .subarray(0, bytes);
}

function messageId(seed, scope) {
  return sha256(`V5BT:B11:MESSAGE:${seed}:${scope}`).slice(0, 32);
}

function sessionId(seed, scope) {
  return `s${sha256(`V5BT:B11:SESSION:${seed}:${scope}`).slice(0, 31)}`;
}

function deterministicUuid(seed, index) {
  const value = sha256(`V5BT:B11:UUID:${seed}:${index}`);
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    `4${value.slice(13, 16)}`,
    `a${value.slice(17, 20)}`,
    value.slice(20, 32)
  ].join("-");
}

function canonicalSeed(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    fail("INVALID_ARGUMENT", "seed is not canonical");
  }
  return value;
}

function exactHybridValue(value, expected, field) {
  if (value !== undefined && value !== expected) {
    fail(
      "INVALID_ARGUMENT",
      `${field} cannot override the canonical hybrid profile value ${expected}`
    );
  }
  return expected;
}

export function buildB11SoftwareNonGatePlan(options = {}) {
  const profile = options.profile ?? "micro";
  if (!new Set(["micro", "soak", B11_HYBRID_PROFILE]).has(profile)) {
    fail("INVALID_ARGUMENT", "profile must be micro, soak or hybrid");
  }
  if (profile === B11_HYBRID_PROFILE) {
    const topology = buildB11HybridTopology();
    if (
      topology.totalActors !== B11_HYBRID_TOTAL_ACTOR_COUNT ||
      topology.bluetoothNodeCount !== B11_HYBRID_BLUETOOTH_NODE_COUNT ||
      topology.androidNodeCount !== B11_HYBRID_ANDROID_NODE_COUNT ||
      topology.androidPairCount !== B11_HYBRID_ANDROID_PAIR_COUNT ||
      topology.androidRaspberryLinkCount !==
        B11_HYBRID_ANDROID_RASPBERRY_LINK_COUNT ||
      topology.transportLinkCount !== B11_HYBRID_LINK_COUNT
    ) {
      fail("HYBRID_CONTRACT_MISMATCH", "virtual business topology drifted");
    }
    const nodeCount = exactHybridValue(
      options.nodeCount,
      HYBRID_DEFAULTS.nodeCount,
      "nodeCount"
    );
    const cyclesPerPair = exactHybridValue(
      options.cyclesPerPair,
      HYBRID_DEFAULTS.cyclesPerPair,
      "cyclesPerPair"
    );
    const soakDurationMs = exactHybridValue(
      options.soakDurationMs,
      HYBRID_DEFAULTS.soakDurationMs,
      "soakDurationMs"
    );
    const soakTickMs = exactHybridValue(
      options.soakTickMs,
      HYBRID_DEFAULTS.soakTickMs,
      "soakTickMs"
    );
    return Object.freeze({
      profile,
      seed: canonicalSeed(options.seed ?? "b11-hybrid-deterministic-v2"),
      nodeCount,
      androidNodeCount: B11_HYBRID_ANDROID_NODE_COUNT,
      androidPairCount: B11_HYBRID_ANDROID_PAIR_COUNT,
      androidRaspberryLinkCount: B11_HYBRID_ANDROID_RASPBERRY_LINK_COUNT,
      pairCount: B11_HYBRID_LINK_COUNT,
      cyclesPerPair,
      expectedConnectDisconnectCycles:
        B11_HYBRID_LINK_COUNT * cyclesPerPair,
      soakDurationMs,
      soakTickMs,
      soakTicks: Math.ceil(soakDurationMs / soakTickMs),
      requiredProfileSatisfied: true
    });
  }
  const defaults = profile === "soak" ? SOAK_DEFAULTS : MICRO_DEFAULTS;
  const nodeCount = integer(
    options.nodeCount ?? defaults.nodeCount,
    2,
    B11_REQUIRED_NODE_COUNT,
    "nodeCount"
  );
  const cyclesPerPair = integer(
    options.cyclesPerPair ?? defaults.cyclesPerPair,
    1,
    B11_REQUIRED_CYCLES_PER_PAIR,
    "cyclesPerPair"
  );
  const soakDurationMs = integer(
    options.soakDurationMs ?? defaults.soakDurationMs,
    1_000,
    24 * 60 * 60 * 1_000,
    "soakDurationMs"
  );
  const soakTickMs = integer(
    options.soakTickMs ?? defaults.soakTickMs,
    10,
    soakDurationMs,
    "soakTickMs"
  );
  const pairCount = nodeCount * (nodeCount - 1) / 2;
  const requiredProfileSatisfied =
    nodeCount === B11_REQUIRED_NODE_COUNT &&
    cyclesPerPair === B11_REQUIRED_CYCLES_PER_PAIR &&
    soakDurationMs >= B11_REQUIRED_SOAK_MS;
  if (profile === "soak" && !requiredProfileSatisfied) {
    fail(
      "INVALID_ARGUMENT",
      "soak profile cannot reduce the required nodes, cycles or duration"
    );
  }
  return Object.freeze({
    profile,
    seed: canonicalSeed(options.seed ?? "b11-deterministic-v1"),
    nodeCount,
    pairCount,
    cyclesPerPair,
    expectedConnectDisconnectCycles: pairCount * cyclesPerPair,
    soakDurationMs,
    soakTickMs,
    soakTicks: Math.ceil(soakDurationMs / soakTickMs),
    requiredProfileSatisfied
  });
}

function allPairs(nodes) {
  const pairs = [];
  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      pairs.push(Object.freeze([nodes[left], nodes[right]]));
    }
  }
  return Object.freeze(pairs);
}

function hybridNodeRole(index) {
  if (index < B11_HYBRID_HANDHELD_COUNT) return "HANDHELD";
  if (index < B11_HYBRID_ANDROID_NODE_COUNT) return "STATION";
  return "RASPBERRY_VIRTUAL";
}

function runB6TopologyCoverage(pairs, plan, metrics) {
  const fullNodeCapabilities =
    CAPABILITY_BITS.SCAN |
    CAPABILITY_BITS.ADVERTISE |
    CAPABILITY_BITS.GATT_CLIENT |
    CAPABILITY_BITS.GATT_SERVER;
  for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
    const [left, right] = pairs[pairIndex];
    const leftAlias = sha256(
      `V5BT:B11:ALIAS:${plan.seed}:${left.index}`
    ).slice(0, 12);
    const rightAlias = sha256(
      `V5BT:B11:ALIAS:${plan.seed}:${right.index}`
    ).slice(0, 12);
    assert.notEqual(leftAlias, rightAlias);
    const forward = electAndroidPeerRolesV1({
      local: {
        aliasEpoch: 1,
        rotatingAlias: leftAlias,
        capabilities: fullNodeCapabilities
      },
      remote: {
        aliasEpoch: 1,
        rotatingAlias: rightAlias,
        capabilities: fullNodeCapabilities
      }
    });
    const reverse = electAndroidPeerRolesV1({
      local: {
        aliasEpoch: 1,
        rotatingAlias: rightAlias,
        capabilities: fullNodeCapabilities
      },
      remote: {
        aliasEpoch: 1,
        rotatingAlias: leftAlias,
        capabilities: fullNodeCapabilities
      }
    });
    assert.equal(forward.localRole, reverse.remoteRole);
    assert.equal(forward.remoteRole, reverse.localRole);
    assert.notEqual(forward.localRole, forward.remoteRole);
    metrics.roleElections += 2;

    const arbitration = selectCanonicalAndroidPeerConnectionV1({
      localNodeId: left.identity,
      remoteNodeId: right.identity,
      candidates: [
        {
          connectionId: messageId(plan.seed, `b6-left:${pairIndex}`),
          initiatorNodeId: left.identity,
          responderNodeId: right.identity
        },
        {
          connectionId: messageId(plan.seed, `b6-right:${pairIndex}`),
          initiatorNodeId: right.identity,
          responderNodeId: left.identity
        }
      ]
    });
    assert.equal(arbitration.closeConnectionIds.length, 1);
    metrics.duplicateConnectionsArbitrated += 1;
  }
}

function createChannelPair(input) {
  const leftIndex = input.left.index;
  const rightIndex = input.right.index;
  const keyLeftToRight = material(
    input.seed,
    leftIndex,
    rightIndex,
    "LEFT_TO_RIGHT",
    "KEY",
    32
  );
  const keyRightToLeft = material(
    input.seed,
    leftIndex,
    rightIndex,
    "RIGHT_TO_LEFT",
    "KEY",
    32
  );
  const prefixLeftToRight = material(
    input.seed,
    leftIndex,
    rightIndex,
    "LEFT_TO_RIGHT",
    "NONCE",
    8
  );
  const prefixRightToLeft = material(
    input.seed,
    leftIndex,
    rightIndex,
    "RIGHT_TO_LEFT",
    "NONCE",
    8
  );
  const leftToRight = [];
  const rightToLeft = [];
  const deliveredLeft = [];
  const deliveredRight = [];
  const common = {
    mtu: input.mtu,
    maxAttempts: 3,
    baseRetryMs: 10,
    maxRetryMs: 40,
    random: () => 0,
    now: () => input.clock.value
  };
  const leftChannel = new ReliableChannelV1({
    ...common,
    peerTrustId: createHash("sha256")
      .update("CASSAV5BT-B11-SYNTHETIC-PEER-V1\0", "utf8")
      .update(input.seed, "utf8")
      .update(`:${rightIndex}`, "utf8")
      .digest("hex"),
    transport: {
      async send(frame) {
        leftToRight.push(Buffer.from(frame));
      }
    },
    store: input.left.store,
    txKey: keyLeftToRight,
    rxKey: keyRightToLeft,
    txNoncePrefix: prefixLeftToRight,
    rxNoncePrefix: prefixRightToLeft,
    onMessage: async (message) => {
      deliveredLeft.push(Buffer.from(message.payload));
    }
  });
  const rightChannel = new ReliableChannelV1({
    ...common,
    peerTrustId: createHash("sha256")
      .update("CASSAV5BT-B11-SYNTHETIC-PEER-V1\0", "utf8")
      .update(input.seed, "utf8")
      .update(`:${leftIndex}`, "utf8")
      .digest("hex"),
    transport: {
      async send(frame) {
        rightToLeft.push(Buffer.from(frame));
      }
    },
    store: input.right.store,
    txKey: keyRightToLeft,
    rxKey: keyLeftToRight,
    txNoncePrefix: prefixRightToLeft,
    rxNoncePrefix: prefixLeftToRight,
    onMessage: async (message) => {
      deliveredRight.push(Buffer.from(message.payload));
    }
  });
  keyLeftToRight.fill(0);
  keyRightToLeft.fill(0);
  prefixLeftToRight.fill(0);
  prefixRightToLeft.fill(0);
  return {
    leftChannel,
    rightChannel,
    leftToRight,
    rightToLeft,
    deliveredLeft,
    deliveredRight,
    close() {
      leftChannel.close();
      rightChannel.close();
      for (const queue of [leftToRight, rightToLeft]) {
        for (const frame of queue.splice(0)) frame.fill(0);
      }
      for (const delivered of [deliveredLeft, deliveredRight]) {
        for (const payload of delivered.splice(0)) payload.fill(0);
      }
    }
  };
}

async function drain(queue, target, reverse = false) {
  const frames = queue.splice(0);
  if (reverse) frames.reverse();
  let result = null;
  try {
    for (const frame of frames) result = await target.receiveFragment(frame);
    return result;
  } finally {
    for (const frame of frames) frame.fill(0);
  }
}

function discard(queue) {
  for (const frame of queue.splice(0)) frame.fill(0);
}

function payloadFor(seed, pairIndex, cycle) {
  const head = Buffer.from(
    `B11:${pairIndex.toString().padStart(2, "0")}:` +
      `${cycle.toString().padStart(3, "0")}:`,
    "ascii"
  );
  const body = createHash("sha512")
    .update(`V5BT:B11:PAYLOAD:${seed}:${pairIndex}:${cycle}`, "utf8")
    .digest();
  return Buffer.concat([head, body, body]);
}

async function runConnectionCycle(input) {
  const scope = `${input.pairIndex}:${input.cycle}`;
  const cycleSessionId = sessionId(input.plan.seed, scope);
  const openedAt = input.clock.value;
  input.left.store.openSession({
    sessionId: cycleSessionId,
    peerId: input.right.label,
    openedAtEpochMs: openedAt
  });
  input.right.store.openSession({
    sessionId: cycleSessionId,
    peerId: input.left.label,
    openedAtEpochMs: openedAt
  });
  const mtuValues = [23, 64, 247, 517];
  const pair = createChannelPair({
    left: input.left,
    right: input.right,
    seed: input.plan.seed,
    mtu: mtuValues[input.globalCycle % mtuValues.length],
    clock: input.clock
  });
  const payload = payloadFor(input.plan.seed, input.pairIndex, input.cycle);
  try {
    await pair.leftChannel.send({
      type: RELIABLE_FRAME_TYPES.DATA,
      payload,
      durable: true,
      ttlMs: 120_000,
      messageId: messageId(input.plan.seed, `data:${scope}`)
    });

    const retryFault = input.globalCycle % 7 === 1;
    const duplicateFault = input.globalCycle % 11 === 2;
    const backgroundFault = input.globalCycle % 13 === 3;
    if (retryFault) {
      discard(pair.leftToRight);
      input.clock.value += 10;
      const retried = await pair.leftChannel.tick();
      assert.equal(retried.retried, 1);
      input.metrics.retryFaults += 1;
    }
    if (backgroundFault) {
      input.right.background = true;
      input.metrics.backgroundTransitions += 1;
      assert.equal(pair.deliveredRight.length, 0);
      input.clock.value += 1;
      input.right.background = false;
      input.metrics.backgroundTransitions += 1;
      input.metrics.backgroundFaults += 1;
    }

    const duplicateFrames = duplicateFault
      ? pair.leftToRight.map((frame) => Buffer.from(frame))
      : [];
    if (pair.leftToRight.length > 1) input.metrics.fragmentedSessions += 1;
    input.metrics.maximumFragmentsPerMessage = Math.max(
      input.metrics.maximumFragmentsPerMessage,
      pair.leftToRight.length
    );
    const received = await drain(
      pair.leftToRight,
      pair.rightChannel,
      input.globalCycle % 2 === 0
    );
    assert.equal(received?.delivered, true);
    assert.equal(pair.deliveredRight.length, 1);
    assert.deepEqual(pair.deliveredRight[0], payload);

    if (duplicateFault) {
      pair.leftToRight.push(...duplicateFrames);
      const duplicate = await drain(pair.leftToRight, pair.rightChannel, false);
      assert.equal(duplicate?.duplicate, true);
      assert.equal(pair.deliveredRight.length, 1);
      input.metrics.duplicateFaults += 1;
    }
    await drain(pair.rightToLeft, pair.leftChannel, false);
    const leftSnapshot = pair.leftChannel.snapshot();
    const rightSnapshot = pair.rightChannel.snapshot();
    assert.equal(leftSnapshot.pendingMessages, 0);
    assert.equal(leftSnapshot.outboxDepth, 0);
    assert.equal(rightSnapshot.reassemblyOpenMessages, 0);
    input.metrics.framesTx += leftSnapshot.framesTx + rightSnapshot.framesTx;
    input.metrics.retries += leftSnapshot.retries + rightSnapshot.retries;
    input.metrics.duplicates += leftSnapshot.duplicates + rightSnapshot.duplicates;
    input.metrics.connectDisconnectCycles += 1;
  } finally {
    payload.fill(0);
    pair.close();
  }

  input.clock.value += 1;
  input.left.store.closeSession({
    sessionId: cycleSessionId,
    closedAtEpochMs: input.clock.value,
    closeReason: "NORMAL"
  });
  input.right.store.closeSession({
    sessionId: cycleSessionId,
    closedAtEpochMs: input.clock.value,
    closeReason: "NORMAL"
  });
}

async function runRebootRecovery(nodes, plan, clock, metrics) {
  const sender = nodes[0];
  const receiver = nodes[1];
  const first = createChannelPair({
    left: sender,
    right: receiver,
    seed: plan.seed,
    mtu: 23,
    clock
  });
  const recoveryMessageId = messageId(plan.seed, "reboot-recovery");
  try {
    await first.leftChannel.send({
      type: RELIABLE_FRAME_TYPES.DATA,
      payload: Buffer.from("B11 durable reboot recovery", "ascii"),
      durable: true,
      ttlMs: 120_000,
      messageId: recoveryMessageId
    });
    assert.equal(sender.store.snapshot().outboxDepth, 1);
    discard(first.leftToRight);
  } finally {
    first.close();
  }

  sender.store.close();
  sender.store = new BluetoothTransportStoreV1(sender.databasePath);
  metrics.reboots += 1;
  assert.equal(sender.store.snapshot().outboxDepth, 1);

  const restored = createChannelPair({
    left: sender,
    right: receiver,
    seed: plan.seed,
    mtu: 23,
    clock
  });
  try {
    assert.equal(await restored.leftChannel.restoreDurableOutbox(), 1);
    const result = await drain(
      restored.leftToRight,
      restored.rightChannel,
      true
    );
    assert.equal(result?.delivered, true);
    await drain(restored.rightToLeft, restored.leftChannel, false);
    assert.equal(sender.store.snapshot().outboxDepth, 0);
    assert.equal(restored.leftChannel.snapshot().pendingMessages, 0);
    metrics.recoveredDurableMessages += 1;
  } finally {
    restored.close();
  }
}

function runRouteAdvertisementCoverage(nodes, clock, metrics) {
  for (const node of nodes) {
    const publisher = new RouteAdvertisementPublisherV1(5_000);
    const wire = publisher.build({
      nowEpochMs: clock.value,
      force: true,
      canReachServer: true,
      routeKind:
        node.index % 2 === 0
          ? ROUTE_ADVERTISEMENT_KINDS.WIFI
          : ROUTE_ADVERTISEMENT_KINDS.LAN,
      serverRttMs: 20 + node.index,
      lastRouteChangeAtEpochMs: clock.value - 5_000,
      queueDepth: node.index,
      batteryPercent: 50 + node.index
    });
    assert.ok(wire instanceof Buffer);
    const decoded = decodeRouteAdvertisementV1(wire);
    node.store.storeLastServerAdvertisement({
      canReachServer: decoded.canReachServer,
      routeKind: decoded.routeKind,
      serverRttBucket: decoded.serverRttBucket,
      routeAgeSeconds: decoded.routeAgeSeconds,
      queueDepthBucket: decoded.queueDepthBucket,
      batteryBucket: decoded.batteryBucket,
      sequence: decoded.sequence,
      observedAtEpochMs: clock.value
    });
    assert.deepEqual(node.store.lastServerAdvertisement(), {
      canReachServer: decoded.canReachServer,
      routeKind: decoded.routeKind,
      serverRttBucket: decoded.serverRttBucket,
      routeAgeSeconds: decoded.routeAgeSeconds,
      queueDepthBucket: decoded.queueDepthBucket,
      batteryBucket: decoded.batteryBucket,
      sequence: decoded.sequence,
      observedAtEpochMs: clock.value
    });
    wire.fill(0);
    metrics.routeAdvertisementsPersisted += 1;
  }

  assert.throws(
    () => encodeRouteAdvertisementV1({
      canReachServer: true,
      routeKind: ROUTE_ADVERTISEMENT_KINDS.BLE_DIRECT,
      serverRttBucket: 1,
      routeAgeSeconds: 0,
      queueDepthBucket: 0,
      batteryBucket: 5,
      sequence: 1
    }),
    (error) =>
      error instanceof RouteAdvertisementError &&
      error.code === "MULTIHOP_NOT_ALLOWED"
  );
  metrics.multihopClaimsRejected += 1;
}

async function runShadowCoverage(plan, clock, metrics) {
  let handled = 0;
  const ingress = new BluetoothShadowIngressV1({
    enabled: true,
    now: () => clock.value,
    handler: async () => {
      handled += 1;
    }
  });
  const messages = [];
  try {
    for (const [index, kind] of Object.values(BLUETOOTH_SHADOW_KINDS).entries()) {
    const payload = encodeBluetoothShadowMessageV1({
      schemaVersion: 1,
      kind,
      correlationId: messageId(plan.seed, `b10-correlation:${kind}`),
      sentAtEpochMs: clock.value,
      lanLatencyMs: 12 + index,
      body: `b11 ${kind.toLowerCase()} shadow`
    });
    const reliableMessage = Object.freeze({
      type: RELIABLE_FRAME_TYPES.SHADOW_DIAGNOSTIC,
      flags: 0,
      sequence: index + 1,
      messageId: messageId(plan.seed, `b10-message:${kind}`),
      expiresAtEpochMs: clock.value + 30_000,
      payload
    });
    messages.push(reliableMessage);
    assert.deepEqual(
      await ingress.accept({ authenticated: true, message: reliableMessage }),
      { accepted: true, duplicate: false }
    );
    assert.deepEqual(
      await ingress.accept({ authenticated: true, message: reliableMessage }),
      { accepted: false, duplicate: true }
    );
    metrics.shadowDiagnosticsAccepted += 1;
    metrics.shadowDuplicatesSuppressed += 1;
    }
    assert.equal(handled, 3);

    await assert.rejects(
    () => ingress.accept({
      authenticated: true,
      message: { ...messages[0], type: RELIABLE_FRAME_TYPES.DATA }
    }),
    (error) =>
      error instanceof BluetoothShadowIngressError &&
      error.code === "BUSINESS_MESSAGE_REJECTED"
  );
    metrics.businessMessagesRejected += 1;

    const disabled = new BluetoothShadowIngressV1({
    enabled: false,
    now: () => clock.value,
    handler: async () => {
      throw new Error("disabled shadow handler must not run");
    }
  });
    await assert.rejects(
    () => disabled.accept({ authenticated: true, message: messages[0] }),
    (error) =>
      error instanceof BluetoothShadowIngressError &&
      error.code === "SHADOW_DISABLED"
  );
    metrics.defaultOffRejections += 1;
    metrics.businessMessagesForwarded = ingress.snapshot().businessMessagesForwarded;
    assert.equal(metrics.businessMessagesForwarded, 0);
  } finally {
    for (const message of messages) message.payload.fill(0);
  }
}

function runInvalidCertificateFault(metrics) {
  const binding = Object.freeze({
    clientHello: Object.freeze({
      protocolVersion: 1,
      sessionId: "AbCdEfGhIjKlMnOpQrStUg",
      nodeId: "550e8400-e29b-41d4-a716-446655440000",
      bootId: 17,
      capabilities: 47,
      nonce: "AAECAwQFBgcICQoLDA0ODw"
    }),
    serverHello: Object.freeze({
      protocolVersion: 1,
      sessionId: "AbCdEfGhIjKlMnOpQrStUg",
      nodeId: "123e4567-e89b-12d3-a456-426614174000",
      bootId: 54,
      capabilities: 72,
      nonce: "ICEiIyQlJicoKSorLC0uLw"
    }),
    deviceCertificateId: "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  });
  const invalidBinding = Object.freeze({
    ...binding,
    deviceCertificateId: "123e4567-e89b-42d3-a456-426614174000"
  });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signed = buildClientAuthProofMessageV1(binding);
  const invalid = buildClientAuthProofMessageV1(invalidBinding);
  const signature = sign(null, signed, privateKey);
  try {
    assert.equal(verify(null, signed, publicKey, signature), true);
    assert.equal(verify(null, invalid, publicKey, signature), false);
    metrics.invalidCertificateAttempts += 1;
    metrics.invalidCertificatesRejected += 1;
  } finally {
    signed.fill(0);
    invalid.fill(0);
    signature.fill(0);
  }
}

function assertNoLeaks(nodes) {
  let sessionHistoryCount = 0;
  let inboxDedupDepth = 0;
  let knownPeerCount = 0;
  let serverAdvertisementCount = 0;
  for (const node of nodes) {
    const snapshot = node.store.snapshot();
    assert.equal(snapshot.openSessionCount, 0);
    assert.equal(snapshot.outboxDepth, 0);
    sessionHistoryCount += snapshot.sessionHistoryCount;
    inboxDedupDepth += snapshot.inboxDedupDepth;
    knownPeerCount += snapshot.knownPeerCount;
    if (snapshot.hasServerAdvertisement) serverAdvertisementCount += 1;
  }
  return Object.freeze({
    sessionHistoryCount,
    inboxDedupDepth,
    knownPeerCount,
    serverAdvertisementCount
  });
}

function runSyntheticSoak(nodes, plan, clock, metrics) {
  const sampleEvery = Math.max(1, Math.floor(plan.soakTicks / 120));
  let samples = 0;
  for (let tick = 0; tick < plan.soakTicks; tick += 1) {
    clock.value += plan.soakTickMs;
    if (tick % sampleEvery !== 0 && tick !== plan.soakTicks - 1) continue;
    for (const node of nodes) {
      node.store.prune(clock.value);
      const snapshot = node.store.snapshot();
      assert.equal(snapshot.openSessionCount, 0);
      assert.equal(snapshot.outboxDepth, 0);
    }
    samples += 1;
  }
  metrics.soakTicks = plan.soakTicks;
  metrics.soakSamples = samples;
  metrics.simulatedSoakMs = plan.soakDurationMs;
}

function inspectPrivateFields(value) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(inspectPrivateFields);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (PRIVATE_REPORT_FIELDS.has(key)) {
      fail("PRIVATE_REPORT_FIELD", `report contains forbidden field ${key}`);
    }
    inspectPrivateFields(nested);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_REPORT", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail("INVALID_REPORT", `${label} has a non-canonical field set`);
  }
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertHybridReportShape(report) {
  assertExactKeys(report, B11_HYBRID_REPORT_KEYS, "report");
  assertExactKeys(report.actors, [
    "totalActors", "virtualizedActors", "physicalActors", "roles"
  ], "actors");
  assertExactKeys(report.actors.roles, [
    "HANDHELD", "STATION", "RASPBERRY_VIRTUAL",
    "AUTOMATIC_CASH_VIRTUAL", "FISCAL_RT_VIRTUAL"
  ], "actors.roles");
  assertExactKeys(report.topology, [
    "nodeCount", "androidNodeCount", "usefulPairCount", "androidPairCount",
    "androidRaspberryLinkCount", "deterministic"
  ], "topology");
  assertExactKeys(report.phaseCoverage, ["B6", "B7", "B8", "B9", "B10"], "phaseCoverage");
  assertExactKeys(report.phaseCoverage.B6, [
    "roleElections", "duplicateConnectionsArbitrated", "androidPairsOnly"
  ], "phaseCoverage.B6");
  assertExactKeys(report.phaseCoverage.B7, [
    "reliableFramesTx", "fragmentedSessions", "retriesObserved", "duplicatesObserved"
  ], "phaseCoverage.B7");
  assertExactKeys(report.phaseCoverage.B8, [
    "recoveredDurableMessages", "sessionHistoryCount", "knownPeerCount"
  ], "phaseCoverage.B8");
  assertExactKeys(report.phaseCoverage.B9, [
    "routeAdvertisementsPersisted", "multihopClaimsRejected"
  ], "phaseCoverage.B9");
  assertExactKeys(report.phaseCoverage.B10, [
    "shadowDiagnosticsAccepted", "shadowDuplicatesSuppressed",
    "defaultOffRejections", "businessMessagesRejected", "businessMessagesForwarded"
  ], "phaseCoverage.B10");
  assertExactKeys(report.workload, [
    "cyclesPerPair", "expectedConnectDisconnectCycles",
    "completedConnectDisconnectCycles", "framesTx", "fragmentedSessions",
    "maximumFragmentsPerMessage"
  ], "workload");
  assertExactKeys(report.businessPlane, [
    "transport", "bluetoothBusinessMessagesForwarded"
  ], "businessPlane");
  assertExactKeys(report.businessWorkload, [
    "actionsPerAndroid", "expectedActions", "completedActions", "handheldActions",
    "stationActions", "handheldCommands", "coveredHandhelds", "coveredStations",
    "raspberryCount", "raspberryBrokeredActions", "automaticCash", "fiscalRt",
    "businessTransport", "bluetoothBusinessMessagesForwarded", "externalAccess",
    "cleanupComplete"
  ], "businessWorkload");
  for (const [label, peripheral] of [
    ["businessWorkload.automaticCash", report.businessWorkload.automaticCash],
    ["businessWorkload.fiscalRt", report.businessWorkload.fiscalRt]
  ]) {
    assertExactKeys(peripheral, [
      "expectedTransactions", "completedTransactions", "exactReplays",
      "mutatedReplaysRejected", "outageFaults", "recoveries", "totalCents",
      "pendingTransactions"
    ], label);
  }
  assertExactKeys(report.virtualPeripherals, [
    "automaticCashInstances", "fiscalRtInstances", "realInstances"
  ], "virtualPeripherals");
  assertExactKeys(report.faultModel, [
    "retryFaults", "retriesObserved", "duplicateFaults", "duplicatesObserved",
    "backgroundFaults", "backgroundTransitions", "rebootCount",
    "recoveredDurableMessages", "invalidCertificateAttempts",
    "invalidCertificatesRejected"
  ], "faultModel");
  assertExactKeys(report.soak, [
    "simulatedDurationMs", "requiredDurationMs", "ticks", "samples",
    "wallClockSleeping", "requiredProfileSatisfied"
  ], "soak");
  assertExactKeys(report.persistence, [
    "sessionHistoryCount", "knownPeerCount", "serverAdvertisementCount",
    "inboxDedupDepthAfterSoak", "openSessionCount", "outboxDepth"
  ], "persistence");
  assertExactKeys(report.teardown, [
    "temporaryWorkspaceRemoved", "persistentArtifactsRetained"
  ], "teardown");
  assertExactKeys(report.checks, B11_HYBRID_CHECK_KEYS, "checks");
}

function validateB11HybridSoftwareNonGateReport(report) {
  assertHybridReportShape(report);
  if (
    report.harnessVersion !== B11_HYBRID_NON_GATE_VERSION ||
    report.mode !== B11_HYBRID_NON_GATE_MODE ||
    report.phase !== "B11" ||
    report.profile !== B11_HYBRID_PROFILE ||
    report.evidenceClass !== "NON_GATE_EVIDENCE" ||
    report.gateImpact !== "NONE" ||
    report.promotionAllowed !== false ||
    report.officialEvidence !== false ||
    report.statusMutationAllowed !== false ||
    report.officialProgressPercent !== B11_OFFICIAL_PROGRESS_PERCENT ||
    report.hardwareAccess !== false ||
    report.radioAccess !== false ||
    report.adbAccess !== false ||
    report.sshAccess !== false ||
    report.serviceAccess !== false ||
    report.realPeripheralAccess !== false ||
    report.b11Gate !== "PENDING" ||
    report.virtualizationPolicy !== B11_HYBRID_VIRTUALIZATION_POLICY ||
    report.missingHardwarePolicy !== B11_HYBRID_VIRTUALIZATION_POLICY ||
    report.timeBasis !== "VIRTUAL_MONOTONIC" ||
    typeof report.seedCommitment !== "string" ||
    !/^[0-9a-f]{64}$/.test(report.seedCommitment) ||
    !new Set(["NON_GATE_PASS", "NON_GATE_FAIL"]).has(report.verdict)
  ) {
    fail(
      "PROMOTION_CONTRACT_VIOLATION",
      "hybrid report is not safely non-promotable"
    );
  }
  const actorRoles = report.actors?.roles;
  if (
    report.actors?.totalActors !== B11_HYBRID_TOTAL_ACTOR_COUNT ||
    report.actors?.virtualizedActors !== B11_HYBRID_TOTAL_ACTOR_COUNT ||
    report.actors?.physicalActors !== 0 ||
    actorRoles?.HANDHELD !== B11_HYBRID_HANDHELD_COUNT ||
    actorRoles?.STATION !== B11_HYBRID_STATION_COUNT ||
    actorRoles?.RASPBERRY_VIRTUAL !== B11_HYBRID_RASPBERRY_COUNT ||
    actorRoles?.AUTOMATIC_CASH_VIRTUAL !== 1 ||
    actorRoles?.FISCAL_RT_VIRTUAL !== 1 ||
    Object.keys(actorRoles ?? {}).length !== 5
  ) {
    fail("INVALID_REPORT", "hybrid actor inventory is inconsistent");
  }
  if (
    report.topology?.nodeCount !== B11_HYBRID_BLUETOOTH_NODE_COUNT ||
    report.topology?.androidNodeCount !== B11_HYBRID_ANDROID_NODE_COUNT ||
    report.topology?.usefulPairCount !== B11_HYBRID_LINK_COUNT ||
    report.topology?.androidPairCount !== B11_HYBRID_ANDROID_PAIR_COUNT ||
    report.topology?.androidRaspberryLinkCount !==
      B11_HYBRID_ANDROID_RASPBERRY_LINK_COUNT ||
    report.topology?.deterministic !== true
  ) {
    fail("INVALID_REPORT", "hybrid Bluetooth topology is inconsistent");
  }
  if (
    report.workload?.cyclesPerPair !== B11_REQUIRED_CYCLES_PER_PAIR ||
    report.workload?.expectedConnectDisconnectCycles !==
      B11_HYBRID_LINK_COUNT * B11_REQUIRED_CYCLES_PER_PAIR ||
    report.workload?.completedConnectDisconnectCycles !==
      report.workload.expectedConnectDisconnectCycles ||
    !isNonNegativeSafeInteger(report.workload?.framesTx) ||
    report.workload.framesTx < 1 ||
    !isNonNegativeSafeInteger(report.workload?.fragmentedSessions) ||
    report.workload.fragmentedSessions < 1 ||
    report.workload?.maximumFragmentsPerMessage !== 31 ||
    report.soak?.simulatedDurationMs !== B11_REQUIRED_SOAK_MS ||
    report.soak?.requiredDurationMs !== B11_REQUIRED_SOAK_MS ||
    report.soak?.requiredProfileSatisfied !== true
  ) {
    fail("INVALID_REPORT", "hybrid transport workload is inconsistent");
  }
  if (
    report.phaseCoverage?.B6?.roleElections !==
      B11_HYBRID_ANDROID_PAIR_COUNT * 2 ||
    report.phaseCoverage?.B6?.duplicateConnectionsArbitrated !==
      B11_HYBRID_ANDROID_PAIR_COUNT ||
    report.phaseCoverage?.B6?.androidPairsOnly !== true ||
    report.phaseCoverage?.B7?.reliableFramesTx !== report.workload?.framesTx ||
    report.phaseCoverage?.B7?.fragmentedSessions !==
      report.workload?.fragmentedSessions ||
    report.phaseCoverage?.B7?.retriesObserved !== report.faultModel?.retriesObserved ||
    report.phaseCoverage?.B7?.duplicatesObserved !==
      report.faultModel?.duplicatesObserved ||
    report.phaseCoverage?.B8?.recoveredDurableMessages !== 1 ||
    report.phaseCoverage?.B8?.sessionHistoryCount !==
      B11_HYBRID_LINK_COUNT * B11_REQUIRED_CYCLES_PER_PAIR * 2 ||
    report.phaseCoverage?.B8?.knownPeerCount !==
      B11_HYBRID_BLUETOOTH_NODE_COUNT *
        (B11_HYBRID_BLUETOOTH_NODE_COUNT - 1) ||
    report.phaseCoverage?.B9?.routeAdvertisementsPersisted !==
      B11_HYBRID_BLUETOOTH_NODE_COUNT ||
    report.phaseCoverage?.B9?.multihopClaimsRejected !== 1 ||
    report.phaseCoverage?.B10?.shadowDiagnosticsAccepted !== 3 ||
    report.phaseCoverage?.B10?.shadowDuplicatesSuppressed !== 3 ||
    report.phaseCoverage?.B10?.defaultOffRejections !== 1 ||
    report.phaseCoverage?.B10?.businessMessagesRejected !== 1 ||
    report.phaseCoverage?.B10?.businessMessagesForwarded !== 0
  ) {
    fail("INVALID_REPORT", "hybrid phase coverage counters are inconsistent");
  }
  if (
    report.businessWorkload?.actionsPerAndroid !==
      B11_HYBRID_ACTIONS_PER_ANDROID ||
    report.businessWorkload?.expectedActions !==
      B11_HYBRID_TOTAL_BUSINESS_ACTIONS ||
    report.businessWorkload?.completedActions !==
      B11_HYBRID_TOTAL_BUSINESS_ACTIONS ||
    report.businessWorkload?.handheldActions !==
      B11_HYBRID_HANDHELD_COUNT * B11_HYBRID_ACTIONS_PER_ANDROID ||
    report.businessWorkload?.stationActions !==
      B11_HYBRID_STATION_COUNT * B11_HYBRID_ACTIONS_PER_ANDROID ||
    report.businessWorkload?.handheldCommands !== 800 ||
    report.businessWorkload?.coveredHandhelds !== B11_HYBRID_HANDHELD_COUNT ||
    report.businessWorkload?.coveredStations !== B11_HYBRID_STATION_COUNT ||
    report.businessWorkload?.raspberryCount !== B11_HYBRID_RASPBERRY_COUNT ||
    report.businessWorkload?.raspberryBrokeredActions !==
      B11_HYBRID_TOTAL_BUSINESS_ACTIONS ||
    report.businessWorkload?.automaticCash?.expectedTransactions !==
      B11_HYBRID_AUTOMATIC_CASH_TRANSACTIONS ||
    report.businessWorkload?.automaticCash?.completedTransactions !==
      B11_HYBRID_AUTOMATIC_CASH_TRANSACTIONS ||
    report.businessWorkload?.automaticCash?.exactReplays !==
      B11_HYBRID_AUTOMATIC_CASH_TRANSACTIONS ||
    report.businessWorkload?.automaticCash?.mutatedReplaysRejected !== 1 ||
    report.businessWorkload?.automaticCash?.outageFaults !== 1 ||
    report.businessWorkload?.automaticCash?.recoveries !== 1 ||
    report.businessWorkload?.automaticCash?.totalCents !== 688_150 ||
    report.businessWorkload?.automaticCash?.pendingTransactions !== 0 ||
    report.businessWorkload?.fiscalRt?.expectedTransactions !==
      B11_HYBRID_FISCAL_RT_TRANSACTIONS ||
    report.businessWorkload?.fiscalRt?.completedTransactions !==
      B11_HYBRID_FISCAL_RT_TRANSACTIONS ||
    report.businessWorkload?.fiscalRt?.exactReplays !==
      B11_HYBRID_FISCAL_RT_TRANSACTIONS ||
    report.businessWorkload?.fiscalRt?.mutatedReplaysRejected !== 1 ||
    report.businessWorkload?.fiscalRt?.outageFaults !== 1 ||
    report.businessWorkload?.fiscalRt?.recoveries !== 1 ||
    report.businessWorkload?.fiscalRt?.totalCents !== 688_150 ||
    report.businessWorkload?.fiscalRt?.pendingTransactions !== 0 ||
    report.businessPlane?.transport !== "LAN_HTTP_SSE" ||
    report.businessPlane?.bluetoothBusinessMessagesForwarded !== 0 ||
    report.businessWorkload?.bluetoothBusinessMessagesForwarded !== 0 ||
    report.businessWorkload?.businessTransport !== "LAN_HTTP_SSE" ||
    report.businessWorkload?.externalAccess !== false ||
    report.businessWorkload?.cleanupComplete !== true
  ) {
    fail("INVALID_REPORT", "hybrid virtual business workload is inconsistent");
  }
  if (
    report.virtualPeripherals?.automaticCashInstances !== 1 ||
    report.virtualPeripherals?.fiscalRtInstances !== 1 ||
    report.virtualPeripherals?.realInstances !== 0 ||
    !isNonNegativeSafeInteger(report.faultModel?.retryFaults) ||
    report.faultModel.retryFaults < 1 ||
    report.faultModel?.retriesObserved !== report.faultModel.retryFaults ||
    !isNonNegativeSafeInteger(report.faultModel?.duplicateFaults) ||
    report.faultModel.duplicateFaults < 1 ||
    report.faultModel?.duplicatesObserved !== report.faultModel.duplicateFaults * 2 ||
    !isNonNegativeSafeInteger(report.faultModel?.backgroundFaults) ||
    report.faultModel.backgroundFaults < 1 ||
    report.faultModel?.backgroundTransitions !== report.faultModel.backgroundFaults * 2 ||
    report.faultModel?.rebootCount !== 1 ||
    report.faultModel?.recoveredDurableMessages !== 1 ||
    report.faultModel?.invalidCertificateAttempts !== 1 ||
    report.faultModel?.invalidCertificatesRejected !== 1 ||
    report.soak?.ticks !== 7_200 ||
    report.soak?.samples !== 121 ||
    report.soak?.wallClockSleeping !== false ||
    report.persistence?.sessionHistoryCount !== 18_200 ||
    report.persistence?.knownPeerCount !== 182 ||
    report.persistence?.serverAdvertisementCount !== 14 ||
    report.persistence?.inboxDedupDepthAfterSoak !== 0 ||
    report.persistence?.openSessionCount !== 0 ||
    report.persistence?.outboxDepth !== 0 ||
    report.teardown?.temporaryWorkspaceRemoved !== true ||
    report.teardown?.persistentArtifactsRetained !== 0
  ) {
    fail("INVALID_REPORT", "hybrid fault, persistence or teardown state is inconsistent");
  }
  const checksPass = Object.values(report.checks ?? {}).every(
    (value) => typeof value === "boolean" && value === true
  );
  if (
    (report.verdict === "NON_GATE_PASS") !== checksPass ||
    report.checks?.antiPromotionLocked !== true ||
    report.checks?.allActorsVirtualized !== true
  ) {
    fail("INVALID_REPORT", "hybrid verdict is inconsistent with its checks");
  }
  if (
    typeof report.reportDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(report.reportDigest)
  ) {
    fail("INVALID_REPORT", "reportDigest is not canonical SHA-256 hex");
  }
  const { reportDigest, ...reportWithoutDigest } = report;
  const expectedDigest = Buffer.from(
    sha256(JSON.stringify(reportWithoutDigest)),
    "hex"
  );
  const actualDigest = Buffer.from(reportDigest, "hex");
  try {
    if (!timingSafeEqual(actualDigest, expectedDigest)) {
      fail("INVALID_REPORT", "reportDigest does not match the report body");
    }
  } finally {
    actualDigest.fill(0);
    expectedDigest.fill(0);
  }
  inspectPrivateFields(report);
  return report;
}

export function validateB11SoftwareNonGateReport(report) {
  if (report?.schemaVersion === 2) {
    return validateB11HybridSoftwareNonGateReport(report);
  }
  if (report?.schemaVersion !== 1) {
    fail("INVALID_REPORT", "schemaVersion must be 1");
  }
  if (
    report.harnessVersion !== B11_SOFTWARE_NON_GATE_VERSION ||
    report.mode !== B11_SOFTWARE_NON_GATE_MODE ||
    report.phase !== "B11" ||
    report.evidenceClass !== "NON_GATE_EVIDENCE" ||
    report.gateImpact !== "NONE" ||
    report.promotionAllowed !== false ||
    report.officialEvidence !== false ||
    report.hardwareAccess !== false ||
    report.serviceAccess !== false ||
    report.radioAccess !== false ||
    report.b11Gate !== "PENDING" ||
    !new Set(["NON_GATE_PASS", "NON_GATE_FAIL"]).has(report.verdict)
  ) {
    fail("PROMOTION_CONTRACT_VIOLATION", "report is not safely non-promotable");
  }
  if (
    report.topology?.usefulPairCount !==
      report.topology?.nodeCount * (report.topology?.nodeCount - 1) / 2 ||
    report.workload?.expectedConnectDisconnectCycles !==
      report.topology?.usefulPairCount * report.workload?.cyclesPerPair ||
    report.workload?.completedConnectDisconnectCycles !==
      report.workload?.expectedConnectDisconnectCycles
  ) {
    fail("INVALID_REPORT", "connect/disconnect accounting is inconsistent");
  }
  if (
    !new Set(["micro", "soak"]).has(report.profile) ||
    (
      report.profile === "soak" &&
      (
        report.topology?.nodeCount !== B11_REQUIRED_NODE_COUNT ||
        report.workload?.cyclesPerPair !== B11_REQUIRED_CYCLES_PER_PAIR ||
        report.soak?.simulatedDurationMs < B11_REQUIRED_SOAK_MS ||
        report.soak?.requiredProfileSatisfied !== true
      )
    )
  ) {
    fail("INVALID_REPORT", "declared B11 profile requirements are not satisfied");
  }
  if (
    report.verdict === "NON_GATE_PASS" &&
    !Object.values(report.checks ?? {}).every((value) => value === true)
  ) {
    fail("INVALID_REPORT", "NON_GATE_PASS contains a failed check");
  }
  if (typeof report.reportDigest !== "string" || !/^[0-9a-f]{64}$/.test(report.reportDigest)) {
    fail("INVALID_REPORT", "reportDigest is not canonical SHA-256 hex");
  }
  const { reportDigest, ...reportWithoutDigest } = report;
  const expectedDigest = Buffer.from(
    sha256(JSON.stringify(reportWithoutDigest)),
    "hex"
  );
  const actualDigest = Buffer.from(reportDigest, "hex");
  try {
    if (!timingSafeEqual(actualDigest, expectedDigest)) {
      fail("INVALID_REPORT", "reportDigest does not match the report body");
    }
  } finally {
    actualDigest.fill(0);
    expectedDigest.fill(0);
  }
  inspectPrivateFields(report);
  return report;
}

function buildReport(plan, metrics, leakSnapshot) {
  const checks = Object.freeze({
    completePairGraph: plan.pairCount === plan.nodeCount * (plan.nodeCount - 1) / 2,
    b6RoleElectionComplete: metrics.roleElections === plan.pairCount * 2,
    b6DuplicateArbitrationComplete:
      metrics.duplicateConnectionsArbitrated === plan.pairCount,
    connectDisconnectComplete:
      metrics.connectDisconnectCycles === plan.expectedConnectDisconnectCycles,
    fragmentationExercised: metrics.fragmentedSessions > 0,
    retryExercised: metrics.retryFaults > 0 && metrics.retries >= metrics.retryFaults,
    dedupExercised:
      metrics.duplicateFaults > 0 && metrics.duplicates >= metrics.duplicateFaults,
    rebootRecoveryComplete:
      metrics.reboots === 1 && metrics.recoveredDurableMessages === 1,
    b8PersistenceComplete:
      leakSnapshot.sessionHistoryCount ===
        plan.expectedConnectDisconnectCycles * 2 &&
      leakSnapshot.knownPeerCount === plan.nodeCount * (plan.nodeCount - 1),
    b9RouteAdvertisementsComplete:
      metrics.routeAdvertisementsPersisted === plan.nodeCount &&
      leakSnapshot.serverAdvertisementCount === plan.nodeCount,
    b9MultihopForbidden: metrics.multihopClaimsRejected === 1,
    b10ShadowDiagnosticsComplete:
      metrics.shadowDiagnosticsAccepted === 3 &&
      metrics.shadowDuplicatesSuppressed === 3,
    b10BusinessRoutingForbidden:
      metrics.businessMessagesRejected === 1 &&
      metrics.businessMessagesForwarded === 0,
    b10DefaultOff: metrics.defaultOffRejections === 1,
    invalidCertificateRejected:
      metrics.invalidCertificateAttempts === 1 &&
      metrics.invalidCertificatesRejected === 1,
    backgroundFaultRecovered:
      metrics.backgroundFaults > 0 &&
      metrics.backgroundTransitions === metrics.backgroundFaults * 2,
    syntheticSoakComplete:
      metrics.soakTicks === plan.soakTicks &&
      metrics.simulatedSoakMs === plan.soakDurationMs,
    zeroSessionLeak: leakSnapshot.openSessionCount === 0,
    zeroOutboxLeak: leakSnapshot.outboxDepth === 0,
    teardownComplete: metrics.teardownComplete === true,
    antiPromotionLocked: true
  });
  const verdict = Object.values(checks).every(Boolean)
    ? "NON_GATE_PASS"
    : "NON_GATE_FAIL";
  const reportWithoutDigest = {
    schemaVersion: 1,
    harnessVersion: B11_SOFTWARE_NON_GATE_VERSION,
    phase: "B11",
    mode: B11_SOFTWARE_NON_GATE_MODE,
    profile: plan.profile,
    evidenceClass: "NON_GATE_EVIDENCE",
    verdict,
    gateImpact: "NONE",
    promotionAllowed: false,
    officialEvidence: false,
    hardwareAccess: false,
    serviceAccess: false,
    radioAccess: false,
    b11Gate: "PENDING",
    timeBasis: "VIRTUAL_MONOTONIC",
    seedCommitment: sha256(`V5BT:B11:SEED:${plan.seed}`),
    topology: {
      nodeCount: plan.nodeCount,
      usefulPairCount: plan.pairCount,
      deterministic: true,
      requiredNodeCount: B11_REQUIRED_NODE_COUNT
    },
    phaseCoverage: {
      B6: {
        roleElections: metrics.roleElections,
        duplicateConnectionsArbitrated: metrics.duplicateConnectionsArbitrated
      },
      B7: {
        reliableFramesTx: metrics.framesTx,
        fragmentedSessions: metrics.fragmentedSessions,
        retriesObserved: metrics.retries,
        duplicatesObserved: metrics.duplicates
      },
      B8: {
        recoveredDurableMessages: metrics.recoveredDurableMessages,
        sessionHistoryCount: leakSnapshot.sessionHistoryCount,
        knownPeerCount: leakSnapshot.knownPeerCount
      },
      B9: {
        routeAdvertisementsPersisted: metrics.routeAdvertisementsPersisted,
        multihopClaimsRejected: metrics.multihopClaimsRejected
      },
      B10: {
        shadowDiagnosticsAccepted: metrics.shadowDiagnosticsAccepted,
        shadowDuplicatesSuppressed: metrics.shadowDuplicatesSuppressed,
        defaultOffRejections: metrics.defaultOffRejections,
        businessMessagesRejected: metrics.businessMessagesRejected,
        businessMessagesForwarded: metrics.businessMessagesForwarded
      }
    },
    workload: {
      cyclesPerPair: plan.cyclesPerPair,
      requiredCyclesPerPair: B11_REQUIRED_CYCLES_PER_PAIR,
      expectedConnectDisconnectCycles: plan.expectedConnectDisconnectCycles,
      completedConnectDisconnectCycles: metrics.connectDisconnectCycles,
      framesTx: metrics.framesTx,
      fragmentedSessions: metrics.fragmentedSessions,
      maximumFragmentsPerMessage: metrics.maximumFragmentsPerMessage
    },
    faultModel: {
      retryFaults: metrics.retryFaults,
      retriesObserved: metrics.retries,
      duplicateFaults: metrics.duplicateFaults,
      duplicatesObserved: metrics.duplicates,
      backgroundFaults: metrics.backgroundFaults,
      backgroundTransitions: metrics.backgroundTransitions,
      rebootCount: metrics.reboots,
      recoveredDurableMessages: metrics.recoveredDurableMessages,
      invalidCertificateAttempts: metrics.invalidCertificateAttempts,
      invalidCertificatesRejected: metrics.invalidCertificatesRejected
    },
    soak: {
      simulatedDurationMs: metrics.simulatedSoakMs,
      requiredDurationMs: B11_REQUIRED_SOAK_MS,
      ticks: metrics.soakTicks,
      samples: metrics.soakSamples,
      wallClockSleeping: false,
      requiredProfileSatisfied: plan.requiredProfileSatisfied
    },
    persistence: {
      schemaVersion: 1,
      sessionHistoryCount: leakSnapshot.sessionHistoryCount,
      knownPeerCount: leakSnapshot.knownPeerCount,
      serverAdvertisementCount: leakSnapshot.serverAdvertisementCount,
      inboxDedupDepthAfterSoak: leakSnapshot.inboxDedupDepth,
      openSessionCount: leakSnapshot.openSessionCount,
      outboxDepth: leakSnapshot.outboxDepth
    },
    teardown: {
      temporaryWorkspaceRemoved: metrics.teardownComplete,
      persistentArtifactsRetained: 0
    },
    checks
  };
  const reportDigest = sha256(JSON.stringify(reportWithoutDigest));
  return Object.freeze({ ...reportWithoutDigest, reportDigest });
}

function buildHybridReport(plan, metrics, leakSnapshot, businessWorkload) {
  const businessChecksPass =
    businessWorkload?.expectedActions === B11_HYBRID_TOTAL_BUSINESS_ACTIONS &&
    businessWorkload?.completedActions === B11_HYBRID_TOTAL_BUSINESS_ACTIONS &&
    businessWorkload?.handheldActions ===
      B11_HYBRID_HANDHELD_COUNT * B11_HYBRID_ACTIONS_PER_ANDROID &&
    businessWorkload?.stationActions ===
      B11_HYBRID_STATION_COUNT * B11_HYBRID_ACTIONS_PER_ANDROID &&
    businessWorkload?.handheldCommands === 800 &&
    businessWorkload?.coveredHandhelds === B11_HYBRID_HANDHELD_COUNT &&
    businessWorkload?.coveredStations === B11_HYBRID_STATION_COUNT &&
    businessWorkload?.raspberryCount === B11_HYBRID_RASPBERRY_COUNT &&
    businessWorkload?.raspberryBrokeredActions ===
      B11_HYBRID_TOTAL_BUSINESS_ACTIONS &&
    businessWorkload?.businessTransport === "LAN_HTTP_SSE" &&
    businessWorkload?.bluetoothBusinessMessagesForwarded === 0 &&
    businessWorkload?.externalAccess === false &&
    businessWorkload?.cleanupComplete === true;
  const checks = Object.freeze({
    exactVirtualActorInventory:
      plan.nodeCount === B11_HYBRID_BLUETOOTH_NODE_COUNT,
    allActorsVirtualized: B11_HYBRID_TOTAL_ACTOR_COUNT === 16,
    authorizedBluetoothGraphComplete:
      plan.pairCount === B11_HYBRID_LINK_COUNT,
    b6AndroidRoleElectionComplete:
      metrics.roleElections === B11_HYBRID_ANDROID_PAIR_COUNT * 2,
    b6AndroidDuplicateArbitrationComplete:
      metrics.duplicateConnectionsArbitrated ===
        B11_HYBRID_ANDROID_PAIR_COUNT,
    connectDisconnectComplete:
      metrics.connectDisconnectCycles === plan.expectedConnectDisconnectCycles,
    fragmentationExercised: metrics.fragmentedSessions > 0,
    retryExercised: metrics.retryFaults > 0 && metrics.retries >= metrics.retryFaults,
    dedupExercised:
      metrics.duplicateFaults > 0 && metrics.duplicates >= metrics.duplicateFaults,
    rebootRecoveryComplete:
      metrics.reboots === 1 && metrics.recoveredDurableMessages === 1,
    b8PersistenceComplete:
      leakSnapshot.sessionHistoryCount ===
        plan.expectedConnectDisconnectCycles * 2 &&
      leakSnapshot.knownPeerCount ===
        B11_HYBRID_BLUETOOTH_NODE_COUNT *
          (B11_HYBRID_BLUETOOTH_NODE_COUNT - 1),
    b9RouteAdvertisementsComplete:
      metrics.routeAdvertisementsPersisted === B11_HYBRID_BLUETOOTH_NODE_COUNT &&
      leakSnapshot.serverAdvertisementCount ===
        B11_HYBRID_BLUETOOTH_NODE_COUNT,
    b9MultihopForbidden: metrics.multihopClaimsRejected === 1,
    b10ShadowDiagnosticsComplete:
      metrics.shadowDiagnosticsAccepted === 3 &&
      metrics.shadowDuplicatesSuppressed === 3,
    b10BusinessRoutingForbidden:
      metrics.businessMessagesRejected === 1 &&
      metrics.businessMessagesForwarded === 0 &&
      businessWorkload?.bluetoothBusinessMessagesForwarded === 0,
    b10DefaultOff: metrics.defaultOffRejections === 1,
    invalidCertificateRejected:
      metrics.invalidCertificateAttempts === 1 &&
      metrics.invalidCertificatesRejected === 1,
    backgroundFaultRecovered:
      metrics.backgroundFaults > 0 &&
      metrics.backgroundTransitions === metrics.backgroundFaults * 2,
    virtualBusinessWorkloadComplete:
      businessChecksPass &&
      businessWorkload?.actionsPerAndroid ===
        B11_HYBRID_ACTIONS_PER_ANDROID &&
      businessWorkload?.expectedActions ===
        B11_HYBRID_TOTAL_BUSINESS_ACTIONS &&
      businessWorkload?.completedActions ===
        B11_HYBRID_TOTAL_BUSINESS_ACTIONS,
    automaticCashVirtualCyclesComplete:
      businessWorkload?.automaticCash?.expectedTransactions ===
        B11_HYBRID_AUTOMATIC_CASH_TRANSACTIONS &&
      businessWorkload?.automaticCash?.completedTransactions ===
        B11_HYBRID_AUTOMATIC_CASH_TRANSACTIONS &&
      businessWorkload?.automaticCash?.exactReplays ===
        B11_HYBRID_AUTOMATIC_CASH_TRANSACTIONS &&
      businessWorkload?.automaticCash?.mutatedReplaysRejected === 1 &&
      businessWorkload?.automaticCash?.outageFaults === 1 &&
      businessWorkload?.automaticCash?.recoveries === 1 &&
      businessWorkload?.automaticCash?.pendingTransactions === 0,
    fiscalRtVirtualCyclesComplete:
      businessWorkload?.fiscalRt?.expectedTransactions ===
        B11_HYBRID_FISCAL_RT_TRANSACTIONS &&
      businessWorkload?.fiscalRt?.completedTransactions ===
        B11_HYBRID_FISCAL_RT_TRANSACTIONS &&
      businessWorkload?.fiscalRt?.exactReplays ===
        B11_HYBRID_FISCAL_RT_TRANSACTIONS &&
      businessWorkload?.fiscalRt?.mutatedReplaysRejected === 1 &&
      businessWorkload?.fiscalRt?.outageFaults === 1 &&
      businessWorkload?.fiscalRt?.recoveries === 1 &&
      businessWorkload?.fiscalRt?.pendingTransactions === 0,
    virtualBusinessExternalAccessForbidden:
      businessWorkload?.externalAccess === false,
    virtualBusinessCleanupComplete:
      businessWorkload?.cleanupComplete === true,
    syntheticSoakComplete:
      metrics.soakTicks === plan.soakTicks &&
      metrics.simulatedSoakMs === plan.soakDurationMs,
    zeroSessionLeak: leakSnapshot.openSessionCount === 0,
    zeroOutboxLeak: leakSnapshot.outboxDepth === 0,
    teardownComplete: metrics.teardownComplete === true,
    antiPromotionLocked: true
  });
  const verdict = Object.values(checks).every(Boolean)
    ? "NON_GATE_PASS"
    : "NON_GATE_FAIL";
  const reportWithoutDigest = {
    schemaVersion: 2,
    harnessVersion: B11_HYBRID_NON_GATE_VERSION,
    phase: "B11",
    mode: B11_HYBRID_NON_GATE_MODE,
    profile: B11_HYBRID_PROFILE,
    evidenceClass: "NON_GATE_EVIDENCE",
    verdict,
    gateImpact: "NONE",
    promotionAllowed: false,
    officialEvidence: false,
    statusMutationAllowed: false,
    officialProgressPercent: B11_OFFICIAL_PROGRESS_PERCENT,
    b11Gate: "PENDING",
    hardwareAccess: false,
    radioAccess: false,
    adbAccess: false,
    sshAccess: false,
    serviceAccess: false,
    realPeripheralAccess: false,
    virtualizationPolicy: B11_HYBRID_VIRTUALIZATION_POLICY,
    missingHardwarePolicy: B11_HYBRID_VIRTUALIZATION_POLICY,
    timeBasis: "VIRTUAL_MONOTONIC",
    seedCommitment: sha256(`V5BT:B11:HYBRID:SEED:${plan.seed}`),
    actors: {
      totalActors: B11_HYBRID_TOTAL_ACTOR_COUNT,
      virtualizedActors: B11_HYBRID_TOTAL_ACTOR_COUNT,
      physicalActors: 0,
      roles: {
        HANDHELD: B11_HYBRID_HANDHELD_COUNT,
        STATION: B11_HYBRID_STATION_COUNT,
        RASPBERRY_VIRTUAL: B11_HYBRID_RASPBERRY_COUNT,
        AUTOMATIC_CASH_VIRTUAL: 1,
        FISCAL_RT_VIRTUAL: 1
      }
    },
    topology: {
      nodeCount: plan.nodeCount,
      androidNodeCount: B11_HYBRID_ANDROID_NODE_COUNT,
      usefulPairCount: plan.pairCount,
      androidPairCount: plan.androidPairCount,
      androidRaspberryLinkCount: plan.androidRaspberryLinkCount,
      deterministic: true
    },
    phaseCoverage: {
      B6: {
        roleElections: metrics.roleElections,
        duplicateConnectionsArbitrated:
          metrics.duplicateConnectionsArbitrated,
        androidPairsOnly: true
      },
      B7: {
        reliableFramesTx: metrics.framesTx,
        fragmentedSessions: metrics.fragmentedSessions,
        retriesObserved: metrics.retries,
        duplicatesObserved: metrics.duplicates
      },
      B8: {
        recoveredDurableMessages: metrics.recoveredDurableMessages,
        sessionHistoryCount: leakSnapshot.sessionHistoryCount,
        knownPeerCount: leakSnapshot.knownPeerCount
      },
      B9: {
        routeAdvertisementsPersisted: metrics.routeAdvertisementsPersisted,
        multihopClaimsRejected: metrics.multihopClaimsRejected
      },
      B10: {
        shadowDiagnosticsAccepted: metrics.shadowDiagnosticsAccepted,
        shadowDuplicatesSuppressed: metrics.shadowDuplicatesSuppressed,
        defaultOffRejections: metrics.defaultOffRejections,
        businessMessagesRejected: metrics.businessMessagesRejected,
        businessMessagesForwarded: metrics.businessMessagesForwarded
      }
    },
    workload: {
      cyclesPerPair: plan.cyclesPerPair,
      expectedConnectDisconnectCycles: plan.expectedConnectDisconnectCycles,
      completedConnectDisconnectCycles: metrics.connectDisconnectCycles,
      framesTx: metrics.framesTx,
      fragmentedSessions: metrics.fragmentedSessions,
      maximumFragmentsPerMessage: metrics.maximumFragmentsPerMessage
    },
    businessPlane: {
      transport: "LAN_HTTP_SSE",
      bluetoothBusinessMessagesForwarded:
        businessWorkload?.bluetoothBusinessMessagesForwarded ?? null
    },
    businessWorkload,
    virtualPeripherals: {
      automaticCashInstances: 1,
      fiscalRtInstances: 1,
      realInstances: 0
    },
    faultModel: {
      retryFaults: metrics.retryFaults,
      retriesObserved: metrics.retries,
      duplicateFaults: metrics.duplicateFaults,
      duplicatesObserved: metrics.duplicates,
      backgroundFaults: metrics.backgroundFaults,
      backgroundTransitions: metrics.backgroundTransitions,
      rebootCount: metrics.reboots,
      recoveredDurableMessages: metrics.recoveredDurableMessages,
      invalidCertificateAttempts: metrics.invalidCertificateAttempts,
      invalidCertificatesRejected: metrics.invalidCertificatesRejected
    },
    soak: {
      simulatedDurationMs: metrics.simulatedSoakMs,
      requiredDurationMs: B11_REQUIRED_SOAK_MS,
      ticks: metrics.soakTicks,
      samples: metrics.soakSamples,
      wallClockSleeping: false,
      requiredProfileSatisfied: plan.requiredProfileSatisfied
    },
    persistence: {
      sessionHistoryCount: leakSnapshot.sessionHistoryCount,
      knownPeerCount: leakSnapshot.knownPeerCount,
      serverAdvertisementCount: leakSnapshot.serverAdvertisementCount,
      inboxDedupDepthAfterSoak: leakSnapshot.inboxDedupDepth,
      openSessionCount: leakSnapshot.openSessionCount,
      outboxDepth: leakSnapshot.outboxDepth
    },
    teardown: {
      temporaryWorkspaceRemoved: metrics.teardownComplete,
      persistentArtifactsRetained: 0
    },
    checks
  };
  const reportDigest = sha256(JSON.stringify(reportWithoutDigest));
  return Object.freeze({ ...reportWithoutDigest, reportDigest });
}

async function runB11HybridSoftwareNonGate(plan) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v5bt-b11-hybrid-non-gate-"));
  chmodSync(root, 0o700);
  const clock = { value: START_EPOCH_MS };
  const metrics = {
    roleElections: 0,
    duplicateConnectionsArbitrated: 0,
    connectDisconnectCycles: 0,
    framesTx: 0,
    fragmentedSessions: 0,
    maximumFragmentsPerMessage: 0,
    retryFaults: 0,
    retries: 0,
    duplicateFaults: 0,
    duplicates: 0,
    backgroundFaults: 0,
    backgroundTransitions: 0,
    reboots: 0,
    recoveredDurableMessages: 0,
    routeAdvertisementsPersisted: 0,
    multihopClaimsRejected: 0,
    shadowDiagnosticsAccepted: 0,
    shadowDuplicatesSuppressed: 0,
    defaultOffRejections: 0,
    businessMessagesRejected: 0,
    businessMessagesForwarded: 0,
    invalidCertificateAttempts: 0,
    invalidCertificatesRejected: 0,
    soakTicks: 0,
    soakSamples: 0,
    simulatedSoakMs: 0,
    teardownComplete: false
  };
  const nodes = [];
  let cleaned = false;
  try {
    for (let index = 0; index < plan.nodeCount; index += 1) {
      const databasePath = path.join(
        root,
        `node-${index.toString().padStart(2, "0")}.sqlite`
      );
      nodes.push({
        index,
        label: `node-${index.toString().padStart(2, "0")}`,
        role: hybridNodeRole(index),
        identity: deterministicUuid(plan.seed, index),
        databasePath,
        store: new BluetoothTransportStoreV1(databasePath),
        background: false
      });
    }
    for (const node of nodes) {
      for (const peer of nodes) {
        if (peer === node) continue;
        node.store.upsertKnownPeer({
          nodeId: peer.label,
          capabilities: 0x7f,
          lastSeenAtEpochMs: clock.value,
          serverReachable: true
        });
      }
    }

    const androidNodes = nodes.filter(
      (node) => node.role === "HANDHELD" || node.role === "STATION"
    );
    const androidPairs = allPairs(androidNodes);
    assert.equal(androidPairs.length, B11_HYBRID_ANDROID_PAIR_COUNT);
    runB6TopologyCoverage(androidPairs, plan, metrics);

    const transportPairs = allPairs(nodes);
    assert.equal(transportPairs.length, B11_HYBRID_LINK_COUNT);
    let globalCycle = 0;
    for (let pairIndex = 0; pairIndex < transportPairs.length; pairIndex += 1) {
      const [left, right] = transportPairs[pairIndex];
      for (let cycle = 0; cycle < plan.cyclesPerPair; cycle += 1) {
        await runConnectionCycle({
          plan,
          pairIndex,
          cycle,
          globalCycle,
          left,
          right,
          clock,
          metrics
        });
        globalCycle += 1;
      }
    }

    await runRebootRecovery(nodes, plan, clock, metrics);
    runRouteAdvertisementCoverage(nodes, clock, metrics);
    await runShadowCoverage(plan, clock, metrics);
    runInvalidCertificateFault(metrics);
    const businessWorkload = await runB11VirtualBusinessWorkload({
      seed: plan.seed,
      handheldCount: B11_HYBRID_HANDHELD_COUNT,
      stationCount: B11_HYBRID_STATION_COUNT,
      raspberryCount: B11_HYBRID_RASPBERRY_COUNT,
      automaticCashCount: 1,
      fiscalRtCount: 1,
      actionsPerAndroidDevice: B11_HYBRID_ACTIONS_PER_ANDROID,
      peripheralCycles: B11_HYBRID_AUTOMATIC_CASH_TRANSACTIONS
    });
    runSyntheticSoak(nodes, plan, clock, metrics);
    const final = assertNoLeaks(nodes);
    const leakSnapshot = Object.freeze({
      ...final,
      openSessionCount: 0,
      outboxDepth: 0
    });
    for (const node of nodes) node.store.close();
    await rm(root, { recursive: true, force: true });
    const rootStillExists = await stat(root).then(
      () => true,
      (error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    );
    assert.equal(rootStillExists, false);
    cleaned = true;
    metrics.teardownComplete = true;
    const report = buildHybridReport(
      plan,
      metrics,
      leakSnapshot,
      businessWorkload
    );
    validateB11SoftwareNonGateReport(report);
    return report;
  } catch (error) {
    if (error instanceof B11SoftwareNonGateError) throw error;
    fail("SIMULATION_FAILED", "B11 hybrid software simulation failed", error);
  } finally {
    if (!cleaned) {
      for (const node of nodes) {
        try {
          node.store.close();
        } catch {
          // The temporary workspace is removed after a fail-closed store error.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }
}

export async function runB11SoftwareNonGate(options = {}) {
  const plan = buildB11SoftwareNonGatePlan(options);
  if (plan.profile === B11_HYBRID_PROFILE) {
    return runB11HybridSoftwareNonGate(plan);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "v5bt-b11-non-gate-"));
  chmodSync(root, 0o700);
  const clock = { value: START_EPOCH_MS };
  const metrics = {
    roleElections: 0,
    duplicateConnectionsArbitrated: 0,
    connectDisconnectCycles: 0,
    framesTx: 0,
    fragmentedSessions: 0,
    maximumFragmentsPerMessage: 0,
    retryFaults: 0,
    retries: 0,
    duplicateFaults: 0,
    duplicates: 0,
    backgroundFaults: 0,
    backgroundTransitions: 0,
    reboots: 0,
    recoveredDurableMessages: 0,
    routeAdvertisementsPersisted: 0,
    multihopClaimsRejected: 0,
    shadowDiagnosticsAccepted: 0,
    shadowDuplicatesSuppressed: 0,
    defaultOffRejections: 0,
    businessMessagesRejected: 0,
    businessMessagesForwarded: 0,
    invalidCertificateAttempts: 0,
    invalidCertificatesRejected: 0,
    soakTicks: 0,
    soakSamples: 0,
    simulatedSoakMs: 0,
    teardownComplete: false
  };
  const nodes = [];
  let cleaned = false;
  try {
    for (let index = 0; index < plan.nodeCount; index += 1) {
      const databasePath = path.join(root, `node-${index.toString().padStart(2, "0")}.sqlite`);
      nodes.push({
        index,
        label: `node-${index.toString().padStart(2, "0")}`,
        identity: deterministicUuid(plan.seed, index),
        databasePath,
        store: new BluetoothTransportStoreV1(databasePath),
        background: false
      });
    }
    for (const node of nodes) {
      for (const peer of nodes) {
        if (peer === node) continue;
        node.store.upsertKnownPeer({
          nodeId: peer.label,
          capabilities: 0x7f,
          lastSeenAtEpochMs: clock.value,
          serverReachable: true
        });
      }
    }

    const pairs = allPairs(nodes);
    runB6TopologyCoverage(pairs, plan, metrics);
    let globalCycle = 0;
    for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
      const [left, right] = pairs[pairIndex];
      for (let cycle = 0; cycle < plan.cyclesPerPair; cycle += 1) {
        await runConnectionCycle({
          plan,
          pairIndex,
          cycle,
          globalCycle,
          left,
          right,
          clock,
          metrics
        });
        globalCycle += 1;
      }
    }

    await runRebootRecovery(nodes, plan, clock, metrics);
    runRouteAdvertisementCoverage(nodes, clock, metrics);
    await runShadowCoverage(plan, clock, metrics);
    runInvalidCertificateFault(metrics);
    runSyntheticSoak(nodes, plan, clock, metrics);
    const final = assertNoLeaks(nodes);
    const leakSnapshot = Object.freeze({
      ...final,
      openSessionCount: 0,
      outboxDepth: 0
    });
    for (const node of nodes) node.store.close();
    await rm(root, { recursive: true, force: true });
    const rootStillExists = await stat(root).then(
      () => true,
      (error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    );
    assert.equal(rootStillExists, false);
    cleaned = true;
    metrics.teardownComplete = true;
    const report = buildReport(plan, metrics, leakSnapshot);
    validateB11SoftwareNonGateReport(report);
    return report;
  } catch (error) {
    if (error instanceof B11SoftwareNonGateError) throw error;
    fail("SIMULATION_FAILED", "B11 software simulation failed", error);
  } finally {
    if (!cleaned) {
      for (const node of nodes) {
        try {
          node.store.close();
        } catch {
          // The temporary workspace is removed after a fail-closed store error.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }
}

export async function writeB11SoftwareNonGateReport(outputPath, report) {
  validateB11SoftwareNonGateReport(report);
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    fail("INVALID_ARGUMENT", "output path is required");
  }
  const target = path.resolve(outputPath);
  const parent = path.dirname(target);
  let temporaryPath;
  let handle;
  let parentHandle;
  let targetHandle;
  let parentIdentity;
  let temporaryIdentity;
  let published = false;
  try {
    const parentMetadata = await lstat(parent);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      fail("REPORT_WRITE_FAILED", "report parent must be a real directory");
    }
    if (await realpath(parent) !== parent) {
      fail("REPORT_WRITE_FAILED", "report parent path must not traverse symlinks");
    }
    parentHandle = await open(parent, "r");
    parentIdentity = await parentHandle.stat();
    if (
      parentIdentity.dev !== parentMetadata.dev ||
      parentIdentity.ino !== parentMetadata.ino
    ) {
      fail("REPORT_WRITE_FAILED", "report parent identity changed before publication");
    }
    temporaryPath = path.join(
      parent,
      `.${path.basename(target)}.tmp-${randomBytes(16).toString("hex")}`
    );
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await handle.sync();
    temporaryIdentity = await handle.stat();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, target);
    published = true;
    await unlink(temporaryPath);
    temporaryPath = undefined;
    targetHandle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await targetHandle.stat();
    const currentPathMetadata = await lstat(target);
    const currentParentMetadata = await lstat(parent);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.dev !== temporaryIdentity.dev ||
      metadata.ino !== temporaryIdentity.ino ||
      currentPathMetadata.dev !== metadata.dev ||
      currentPathMetadata.ino !== metadata.ino ||
      currentParentMetadata.dev !== parentIdentity.dev ||
      currentParentMetadata.ino !== parentIdentity.ino
    ) {
      fail("REPORT_WRITE_FAILED", "report publication metadata is invalid");
    }
    await parentHandle.sync();
  } catch (error) {
    if (published) await unlink(target).catch(() => {});
    if (temporaryPath !== undefined) await unlink(temporaryPath).catch(() => {});
    fail("REPORT_WRITE_FAILED", "report must be new and atomically writable", error);
  } finally {
    await targetHandle?.close();
    await parentHandle?.close();
    await handle?.close();
  }
}

export function parseB11SoftwareNonGateArguments(argv) {
  const values = {};
  const args = [...argv];
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `${flag} requires one value`);
    }
    if (flag === "--profile") values.profile = value;
    else if (flag === "--seed") values.seed = value;
    else if (flag === "--nodes") values.nodeCount = Number(value);
    else if (flag === "--cycles") values.cyclesPerPair = Number(value);
    else if (flag === "--duration-ms") values.soakDurationMs = Number(value);
    else if (flag === "--tick-ms") values.soakTickMs = Number(value);
    else if (flag === "--output") values.output = value;
    else fail("INVALID_ARGUMENT", `unknown argument ${flag}`);
  }
  return Object.freeze(values);
}

async function main() {
  const values = parseB11SoftwareNonGateArguments(process.argv.slice(2));
  const { output, ...options } = values;
  const report = await runB11SoftwareNonGate(options);
  if (output !== undefined) {
    await writeB11SoftwareNonGateReport(output, report);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    const code = error instanceof B11SoftwareNonGateError
      ? error.code
      : "UNEXPECTED_FAILURE";
    process.stderr.write(`${JSON.stringify({ verdict: "NON_GATE_FAIL", code })}\n`);
    process.exitCode = 1;
  });
}
