import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SCAN_WINDOW_POLICY_V1,
  MAX_SCAN_PERIOD_MS,
  SCAN_POLICY_MODES,
  ScanPolicyError,
  ScanWindowPolicyV1,
  validateScanWindowPolicyV1
} from "./scan-window-policy-v1.mjs";

function createPolicy(initialNowMs = 0, options = {}) {
  let nowMs = initialNowMs;
  const policy = new ScanWindowPolicyV1({
    clock: () => nowMs,
    ...options
  });
  return {
    policy,
    setNow(value) {
      nowMs = value;
    }
  };
}

test("default stable and failover schedules are frozen and non-continuous", () => {
  assert.deepEqual(DEFAULT_SCAN_WINDOW_POLICY_V1, {
    stable: { windowMs: 3_000, periodMs: 30_000 },
    failover: { windowMs: 8_000, periodMs: 10_000 }
  });
  for (const schedule of Object.values(DEFAULT_SCAN_WINDOW_POLICY_V1)) {
    assert.ok(schedule.windowMs < schedule.periodMs);
  }
});

test("stable schedule uses exact 3000/30000 boundaries", () => {
  const { policy, setNow } = createPolicy();

  setNow(0);
  assert.equal(policy.evaluate().scanning, true);
  setNow(2_999);
  assert.equal(policy.evaluate().scanning, true);
  setNow(3_000);
  assert.equal(policy.evaluate().scanning, false);
  setNow(29_999);
  assert.equal(policy.evaluate().scanning, false);
  setNow(30_000);
  assert.equal(policy.evaluate().scanning, true);
});

test("failover schedule uses exact 8000/10000 boundaries", () => {
  const { policy, setNow } = createPolicy(100);
  policy.setMode(SCAN_POLICY_MODES.FAILOVER);

  setNow(8_099);
  assert.equal(policy.evaluate().scanning, true);
  setNow(8_100);
  assert.equal(policy.evaluate().scanning, false);
  setNow(10_099);
  assert.equal(policy.evaluate().scanning, false);
  setNow(10_100);
  assert.equal(policy.evaluate().scanning, true);
});

test("entering failover opens a new aggressive window immediately", () => {
  const { policy, setNow } = createPolicy();
  setNow(5_000);
  assert.equal(policy.evaluate().scanning, false);

  setNow(7_000);
  assert.deepEqual(policy.setMode(SCAN_POLICY_MODES.FAILOVER), {
    changed: true,
    mode: SCAN_POLICY_MODES.FAILOVER,
    modeStartedAtMs: 7_000
  });
  const state = policy.evaluate();

  assert.equal(state.scanning, true);
  assert.equal(state.command, "start");
  assert.equal(state.windowStartAtMs, 7_000);
  assert.equal(state.windowEndAtMs, 15_000);
});

test("policy reports next transition and delay until the next scan", () => {
  const { policy, setNow } = createPolicy();

  setNow(1_000);
  const active = policy.evaluate();
  assert.equal(active.nextTransitionAtMs, 3_000);
  assert.equal(active.timeUntilNextScanMs, 0);

  setNow(10_000);
  const idle = policy.evaluate();
  assert.equal(idle.nextTransitionAtMs, 30_000);
  assert.equal(idle.nextScanStartAtMs, 30_000);
  assert.equal(idle.timeUntilNextScanMs, 20_000);
});

test("commands and metrics describe observed scanner transitions", () => {
  const { policy, setNow } = createPolicy();

  assert.equal(policy.evaluate().command, "start");
  setNow(1_000);
  assert.equal(policy.evaluate().command, "none");
  setNow(3_000);
  assert.equal(policy.evaluate().command, "stop");
  setNow(30_000);
  assert.equal(policy.evaluate().command, "start");

  const metrics = policy.metrics();
  assert.equal(metrics.evaluationsTotal, 4);
  assert.equal(metrics.stableEvaluationsTotal, 4);
  assert.equal(metrics.scanningDecisionsTotal, 3);
  assert.equal(metrics.idleDecisionsTotal, 1);
  assert.equal(metrics.startCommandsTotal, 2);
  assert.equal(metrics.stopCommandsTotal, 1);
  assert.equal(metrics.restartCommandsTotal, 0);
  assert.equal(metrics.missedBoundaryRecoveriesTotal, 0);
  assert.equal(metrics.observedStateTransitionsTotal, 3);
  assert.equal(metrics.nonContinuousWindows, true);
});

test("a delayed evaluation restarts scanning after an unobserved idle boundary", () => {
  const { policy, setNow } = createPolicy();

  assert.equal(policy.evaluate().command, "start");
  setNow(31_000);
  const recovered = policy.evaluate();

  assert.equal(recovered.scanning, true);
  assert.equal(recovered.windowIndex, 1);
  assert.equal(recovered.command, "restart");
  const metrics = policy.metrics();
  assert.equal(metrics.restartCommandsTotal, 1);
  assert.equal(metrics.missedBoundaryRecoveriesTotal, 1);
  assert.equal(metrics.startCommandsTotal, 2);
  assert.equal(metrics.stopCommandsTotal, 1);
  assert.equal(metrics.observedStateTransitionsTotal, 3);
});

test("changing mode while scanning restarts against the new window boundary", () => {
  const { policy, setNow } = createPolicy();

  assert.equal(policy.evaluate().command, "start");
  setNow(1_000);
  policy.setMode(SCAN_POLICY_MODES.FAILOVER);
  const restarted = policy.evaluate();

  assert.equal(restarted.scanning, true);
  assert.equal(restarted.command, "restart");
  assert.equal(restarted.windowStartAtMs, 1_000);
});

test("reselecting the same mode does not reset its schedule", () => {
  const { policy, setNow } = createPolicy();
  setNow(2_000);

  assert.deepEqual(policy.setMode(SCAN_POLICY_MODES.STABLE), {
    changed: false,
    mode: SCAN_POLICY_MODES.STABLE,
    modeStartedAtMs: 0
  });
  setNow(3_000);
  assert.equal(policy.evaluate().scanning, false);
  assert.equal(policy.metrics().modeChangesTotal, 0);
});

test("continuous or malformed scan schedules are rejected", () => {
  assert.throws(
    () =>
      validateScanWindowPolicyV1({
        stable: { windowMs: 30_000, periodMs: 30_000 },
        failover: { windowMs: 8_000, periodMs: 10_000 }
      }),
    (error) =>
      error instanceof ScanPolicyError &&
      error.code === "CONTINUOUS_SCAN_FORBIDDEN"
  );
  assert.throws(
    () =>
      validateScanWindowPolicyV1({
        stable: { windowMs: 3_000, periodMs: 30_000 },
        failover: { windowMs: 0, periodMs: 10_000 }
      }),
    (error) =>
      error instanceof ScanPolicyError &&
      error.code === "INVALID_SCAN_SCHEDULE"
  );
  assert.throws(
    () =>
      validateScanWindowPolicyV1({
        stable: {
          windowMs: 3_000,
          periodMs: 30_000,
          continuous: false
        },
        failover: { windowMs: 8_000, periodMs: 10_000 }
      }),
    (error) =>
      error instanceof ScanPolicyError &&
      error.code === "INVALID_SCAN_SCHEDULE_FIELDS"
  );
  assert.throws(
    () =>
      validateScanWindowPolicyV1({
        stable: {
          windowMs: 3_000,
          periodMs: Number.MAX_SAFE_INTEGER
        },
        failover: { windowMs: 8_000, periodMs: 10_000 }
      }),
    (error) =>
      error instanceof ScanPolicyError &&
      error.code === "INVALID_SCAN_SCHEDULE"
  );
  const inheritedStable = Object.create({
    stable: { windowMs: 3_000, periodMs: 30_000 }
  });
  inheritedStable.failover = { windowMs: 8_000, periodMs: 10_000 };
  assert.throws(
    () => validateScanWindowPolicyV1(inheritedStable),
    (error) =>
      error instanceof ScanPolicyError &&
      error.code === "INVALID_SCAN_SCHEDULE"
  );
  assert.equal(MAX_SCAN_PERIOD_MS, 3_600_000);
});

test("injected clock must remain monotonic", () => {
  const { policy, setNow } = createPolicy(10);
  policy.evaluate();
  setNow(9);

  assert.throws(
    () => policy.evaluate(),
    (error) =>
      error instanceof ScanPolicyError &&
      error.code === "MONOTONIC_CLOCK_REGRESSION"
  );
  assert.equal(policy.metrics().clockRegressionTotal, 1);
});
