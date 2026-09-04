import assert from "node:assert/strict";
import test from "node:test";

import { buildStationStateLastWriteAudit } from "./v6-station-state-last-write-gate.mjs";

const COUNTERS = Object.freeze({
  enqueued: "stationStateLastWriteEnqueued",
  coalesced: "stationStateLastWriteCoalesced",
  covered: "stationStateLastWriteCoveredByInFlight",
  batches: "stationStateLastWriteBatches",
  flushed: "stationStateLastWriteFlushed",
  retries: "stationStateLastWriteRetries",
  contentionDeferrals: "stationStateLastWriteMysqlLockContentionDeferrals",
  errors: "stationStateLastWriteErrors",
  invalid: "stationStateLastWriteInvalidCandidates",
  future: "stationStateLastWriteFutureTimestampRejected",
  clockRegression: "stationStateLastWriteClockRegressions",
  recoveryWrites: "stationStateLastWriteRecoveryWrites",
  recoveryNoops: "stationStateLastWriteRecoveryNoops",
});

const GAUGES = Object.freeze({
  pending: "stationStateLastWritePendingDepth",
  running: "stationStateLastWriteRunning",
  oldestAgeMs: "stationStateLastWriteOldestAgeMs",
});

function snapshot(counters = {}, gauges = {}) {
  return {
    counters: Object.fromEntries(
      Object.entries(counters).map(([name, value]) => [COUNTERS[name] ?? name, value]),
    ),
    gauges: Object.fromEntries(
      Object.entries(gauges).map(([name, value]) => [GAUGES[name] ?? name, value]),
    ),
  };
}

function enabledAudit(metrics) {
  return buildStationStateLastWriteAudit(metrics, { enabled: true });
}

test("il gate aggrega owner e worker e accetta un flush coalesciuto pulito", () => {
  const metrics = {
    ...snapshot({ enqueued: 2, coalesced: 1, batches: 1, flushed: 2 }),
    workers: [
      {
        role: "api-worker",
        runtimeMetrics: snapshot({
          enqueued: 3,
          covered: 2,
          batches: 1,
          flushed: 3,
          recoveryWrites: 1,
          recoveryNoops: 1,
        }),
      },
    ],
  };

  const audit = enabledAudit(metrics);
  assert.equal(audit.schemaVersion, 2);
  assert.equal(audit.status, "PASS");
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.failures, []);
  assert.deepEqual(audit.counts, {
    enqueued: 5,
    coalesced: 1,
    covered: 2,
    batches: 2,
    flushed: 5,
    retries: 0,
    contentionDeferrals: 0,
    errors: 0,
    invalid: 0,
    future: 0,
    clockRegression: 0,
    recoveryWrites: 1,
    recoveryNoops: 1,
  });
  assert.deepEqual(audit.gauges, { pending: 0, running: 0, oldestAgeMs: 0 });
});

test("recovery e facoltativa ma la coalescenza deve essere osservata", () => {
  const noRecovery = enabledAudit(
    snapshot({ enqueued: 2, covered: 1, batches: 1, flushed: 2 }),
  );
  assert.equal(noRecovery.ok, true);
  assert.equal(noRecovery.counts.recoveryWrites, 0);
  assert.equal(noRecovery.counts.recoveryNoops, 0);

  const noCoalescing = enabledAudit(
    snapshot({ enqueued: 1, batches: 1, flushed: 1 }),
  );
  assert.equal(noCoalescing.ok, false);
  assert.ok(noCoalescing.failures.includes("coalescingObserved"));
});

test("il profilo attivo richiede uno snapshot reale", () => {
  const audit = enabledAudit(null);
  assert.equal(audit.status, "FAIL");
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.includes("snapshotAvailable"));
  assert.ok(audit.failures.includes("workObserved"));
  assert.ok(audit.failures.includes("batchesObserved"));

  const unavailable = enabledAudit({
    ok: false,
    ...snapshot({ enqueued: 2, coalesced: 1, batches: 1, flushed: 2 }),
  });
  assert.equal(unavailable.ok, false);
  assert.ok(unavailable.failures.includes("snapshotAvailable"));
});

test("il profilo attivo rifiuta il vecchio lock bloccante", () => {
  const audit = buildStationStateLastWriteAudit(
    snapshot({ enqueued: 2, coalesced: 1, batches: 1, flushed: 2 }),
    { enabled: true, nowaitEnabled: false },
  );
  assert.equal(audit.flushLockMode, "BLOCKING");
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.includes("flushLockModeNowait"));
});

test("il profilo attivo rifiuta mismatch di cardinalita", () => {
  let audit = enabledAudit(
    snapshot({ enqueued: 3, coalesced: 1, batches: 1, flushed: 2 }),
  );
  assert.ok(audit.failures.includes("enqueueFlushMatch"));

  audit = enabledAudit(
    snapshot({ enqueued: 2, coalesced: 1, batches: 3, flushed: 2 }),
  );
  assert.ok(audit.failures.includes("batchCardinality"));
});

test("il profilo attivo accetta deferral NOWAIT interamente recuperati", () => {
  const audit = enabledAudit(
    snapshot({
      enqueued: 2,
      coalesced: 1,
      batches: 1,
      flushed: 2,
      retries: 1,
      contentionDeferrals: 1,
    }),
  );
  assert.equal(audit.ok, true);
  assert.equal(audit.counts.contentionDeferrals, 1);
  assert.equal(audit.checks.retryAccounting, true);
});

test("il profilo attivo rifiuta retry non coperti dai deferral o dagli errori", () => {
  const audit = enabledAudit(
    snapshot({
      enqueued: 2,
      coalesced: 1,
      batches: 1,
      flushed: 2,
      retries: 2,
      contentionDeferrals: 1,
    }),
  );
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.includes("retryAccounting"));
});

test("il profilo attivo rifiuta errori, timestamp anomali e code non drenate", () => {
  const counterCases = [
    ["errors", "noErrors"],
    ["invalid", "noInvalidCandidates"],
    ["future", "noFutureTimestamps"],
    ["clockRegression", "noClockRegressions"],
  ];
  for (const [counterName, failedCheck] of counterCases) {
    const audit = enabledAudit(
      snapshot({
        enqueued: 2,
        coalesced: 1,
        batches: 1,
        flushed: 2,
        [counterName]: 1,
      }),
    );
    assert.equal(audit.ok, false, counterName);
    assert.ok(audit.failures.includes(failedCheck), counterName);
  }

  for (const [gaugeName, failedCheck] of [
    ["pending", "noPending"],
    ["running", "notRunning"],
    ["oldestAgeMs", "noOldestAge"],
  ]) {
    const audit = enabledAudit(
      snapshot(
        { enqueued: 2, coalesced: 1, batches: 1, flushed: 2 },
        { [gaugeName]: 1 },
      ),
    );
    assert.equal(audit.ok, false, gaugeName);
    assert.ok(audit.failures.includes(failedCheck), gaugeName);
  }
});

test("il profilo spento richiede tutti i contatori e gauge specifici a zero", () => {
  const clean = buildStationStateLastWriteAudit(snapshot(), { enabled: false });
  assert.equal(clean.status, "PASS");
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.failures, []);

  for (const counterName of Object.keys(COUNTERS)) {
    const audit = buildStationStateLastWriteAudit(
      { workers: [{ runtimeMetrics: snapshot({ [counterName]: 1 }) }] },
      { enabled: false },
    );
    assert.equal(audit.ok, false, counterName);
  }
  for (const gaugeName of Object.keys(GAUGES)) {
    const audit = buildStationStateLastWriteAudit(
      snapshot({}, { [gaugeName]: 1 }),
      { enabled: false },
    );
    assert.equal(audit.ok, false, gaugeName);
  }
});

test("un gate non applicabile resta informativo", () => {
  const audit = buildStationStateLastWriteAudit(null, {
    enabled: true,
    applicable: false,
  });
  assert.equal(audit.status, "NOT_APPLICABLE");
  assert.equal(audit.ok, true);
  assert.ok(audit.failures.includes("snapshotAvailable"));
});
