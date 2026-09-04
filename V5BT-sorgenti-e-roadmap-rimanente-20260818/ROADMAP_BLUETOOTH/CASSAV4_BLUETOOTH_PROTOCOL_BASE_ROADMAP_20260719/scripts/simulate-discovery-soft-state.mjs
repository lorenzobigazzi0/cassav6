import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  PEER_SOFT_STATES,
  PeerDirectoryV1
} from "../shared/discovery/peer-directory-v1.mjs";
import {
  SCAN_POLICY_MODES,
  ScanWindowPolicyV1,
  validateScanWindowPolicyV1
} from "../shared/discovery/scan-window-policy-v1.mjs";
import { encodeNodeAdvertisement } from "../shared/protocol/advertisement-v1.mjs";

const rootArgIndex = process.argv.indexOf("--root");
const root = path.resolve(rootArgIndex >= 0 ? process.argv[rootArgIndex + 1] : ".");
const config = JSON.parse(
  fs.readFileSync(path.join(root, "configs", "discovery-policy.json"), "utf8")
);
const scanPolicyConfig = validateScanWindowPolicyV1({
  stable: {
    windowMs: config.stableScanWindowMs,
    periodMs: config.stableScanPeriodMs
  },
  failover: {
    windowMs: config.failoverScanWindowMs,
    periodMs: config.failoverScanPeriodMs
  }
});

let nowMs = 0;
const clock = () => nowMs;
const scanPolicy = new ScanWindowPolicyV1({
  clock,
  initialMode: SCAN_POLICY_MODES.FAILOVER,
  policy: scanPolicyConfig
});
const directory = new PeerDirectoryV1({ clock });
const failover = scanPolicyConfig.failover;
const cycles = 100;
const latenciesMs = [];

const baseAdvertisement = {
  protocolVersion: 1,
  nodeKind: "station",
  rotatingAlias: "102030405060",
  bootId: 23,
  capabilities: 0x1f,
  serverReachable: false,
  sequence: 0
};

for (let cycle = 0; cycle < cycles; cycle += 1) {
  // One hundred 100 ms phase steps cover the complete 10-second period.
  const phaseMs = (cycle * 100) % failover.periodMs;
  const observationAtMs = cycle * failover.periodMs + phaseMs;
  nowMs = observationAtMs;
  const arrivalState = scanPolicy.evaluate();
  const latencyMs = arrivalState.timeUntilNextScanMs;
  latenciesMs.push(latencyMs);

  nowMs = observationAtMs + latencyMs;
  if (latencyMs > 0) {
    assert.equal(scanPolicy.evaluate().scanning, true);
  }

  const result = directory.observeServiceData({
    payload: encodeNodeAdvertisement({
      ...baseAdvertisement,
      sequence: cycle
    }),
    rssiDbm: -60
  });
  assert.equal(result.accepted, true);
}

function nearestRankPercentile(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(percentile * sorted.length) - 1;
  return sorted[index];
}

const localP95Ms = nearestRankPercentile(latenciesMs, 0.95);
const dutyCycle = failover.windowMs / failover.periodMs;
const theoreticalP95Ms = Math.round(
  Math.max(0, 0.95 - dutyCycle) * failover.periodMs
);
const theoreticalWorstCaseMs = failover.periodMs - failover.windowMs;
const lastSeenMs = directory.snapshot().peers[0].lastSeenMs;
const directoryMetricsAtCompletion = directory.metrics();

const softStateBoundaries = [];
for (const [ageMs, expectedState] of [
  [4_999, PEER_SOFT_STATES.FRESH],
  [5_000, PEER_SOFT_STATES.AGING],
  [15_000, PEER_SOFT_STATES.AGING],
  [15_001, PEER_SOFT_STATES.EXPIRED]
]) {
  nowMs = lastSeenMs + ageMs;
  const actualState = directory.snapshot().peers[0].state;
  assert.equal(actualState, expectedState);
  softStateBoundaries.push({ ageMs, state: actualState });
}

const pruning = directory.pruneExpired();
const scanMetrics = scanPolicy.metrics();
const directoryMetricsAfterPruning = directory.metrics();

assert.equal(latenciesMs.length, cycles);
assert.equal(localP95Ms, 1_500);
assert.equal(theoreticalP95Ms, 1_500);
assert.equal(theoreticalWorstCaseMs, 2_000);
assert.ok(localP95Ms <= failover.windowMs);
assert.equal(directoryMetricsAtCompletion.acceptedTotal, cycles);
assert.equal(directoryMetricsAtCompletion.insertedTotal, 1);
assert.equal(directoryMetricsAtCompletion.newerReplacedTotal, cycles - 1);
assert.equal(directoryMetricsAtCompletion.rejectedTotal, 0);
assert.equal(pruning.removed, 1);
assert.equal(directoryMetricsAfterPruning.currentStreams, 0);

console.log(
  JSON.stringify(
    {
      ok: true,
      product: "V5BT",
      scope: "shared-offline-discovery-core",
      failoverCycles: cycles,
      failoverPolicy: {
        windowMs: failover.windowMs,
        periodMs: failover.periodMs,
        dutyCycle,
        nonContinuous: failover.windowMs < failover.periodMs
      },
      scanAvailabilityWaitMs: {
        localDeterministicP95: localP95Ms,
        theoreticalUniformPhaseP95: theoreticalP95Ms,
        theoreticalWorstCaseScanWait: theoreticalWorstCaseMs,
        roadmapTargetP95: 8_000,
        schedulerGate: localP95Ms <= 8_000 ? "PASS" : "FAIL",
        physicalGate: "PENDING"
      },
      softStateBoundaries,
      directoryMetricsAtCompletion,
      directoryMetricsAfterPruning,
      scanMetrics
    },
    null,
    2
  )
);
