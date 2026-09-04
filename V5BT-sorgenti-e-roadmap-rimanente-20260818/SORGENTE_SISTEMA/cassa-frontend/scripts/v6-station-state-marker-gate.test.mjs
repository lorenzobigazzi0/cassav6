import assert from "node:assert/strict";
import test from "node:test";

import { buildStationStateMarkerLockElisionAudit } from "./v6-station-state-marker-gate.mjs";

function metrics({
  probe = 0,
  applied = 0,
  canonicalFallback = 0,
  stateRead = probe,
  transactionFailures = 0,
} = {}) {
  const runMsByLabel = {};
  for (const [suffix, count] of Object.entries({
    probe,
    applied,
    canonicalFallback,
  })) {
    if (count > 0) {
      runMsByLabel[
        `appStateDomainSplit:integration.stationStates.entries.markerLockElision.${suffix}`
      ] = { count };
    }
  }
  if (stateRead > 0) {
    runMsByLabel[
      "appStateDomainSplit:integration.stationStates.entries.stateRead"
    ] = { count: stateRead, p95: 25, max: 80 };
  }
  if (transactionFailures > 0) {
    runMsByLabel[
      "appStateDomainSplit:integration.stationStates.entries.error.deadlock"
    ] = { count: transactionFailures };
  }
  return { operations: { runMsByLabel } };
}

test("il canary passa solo quando il marker canonico viene realmente saltato", () => {
  const audit = buildStationStateMarkerLockElisionAudit(
    metrics({ probe: 12, applied: 12 }),
    { enabled: true },
  );

  assert.equal(audit.ok, true);
  assert.equal(audit.status, "PASS");
  assert.deepEqual(audit.failures, []);
  assert.equal(audit.stateRead.count, 12);
  assert.deepEqual(audit.reference, { count: 76, p95Ms: 2_500, maxMs: 6_684 });
});

test("il canary rifiuta flag non esercitato e fallback canonico", () => {
  let audit = buildStationStateMarkerLockElisionAudit(metrics(), {
    enabled: true,
  });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.includes("probeObserved"));
  assert.ok(audit.failures.includes("appliedObserved"));

  audit = buildStationStateMarkerLockElisionAudit(
    metrics({ probe: 4, applied: 3, canonicalFallback: 1 }),
    { enabled: true },
  );
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.includes("canonicalMarkerIntact"));
});

test("il canary rifiuta un probe privo di esito contabilizzato", () => {
  const audit = buildStationStateMarkerLockElisionAudit(
    metrics({ probe: 5, applied: 4 }),
    { enabled: true },
  );

  assert.equal(audit.ok, false);
  assert.ok(audit.failures.includes("branchAccounting"));
});

test("il canary rifiuta rollback o errori transazionali station-state", () => {
  const audit = buildStationStateMarkerLockElisionAudit(
    metrics({ probe: 3, applied: 3, transactionFailures: 1 }),
    { enabled: true },
  );

  assert.equal(audit.ok, false);
  assert.ok(audit.failures.includes("noTransactionFailures"));
});

test("il profilo ufficiale richiede assenza completa di attivita diagnostica", () => {
  assert.equal(
    buildStationStateMarkerLockElisionAudit(metrics(), { enabled: false }).ok,
    true,
  );
  const leaked = buildStationStateMarkerLockElisionAudit(
    metrics({ probe: 1, applied: 1 }),
    { enabled: false },
  );
  assert.equal(leaked.ok, false);
  assert.ok(leaked.failures.includes("noDiagnosticProbe"));
  assert.ok(leaked.failures.includes("noDiagnosticApply"));
});

test("snapshot assente fallisce quando il gate e applicabile", () => {
  const audit = buildStationStateMarkerLockElisionAudit(null, {
    enabled: true,
  });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.includes("snapshotAvailable"));

  assert.equal(
    buildStationStateMarkerLockElisionAudit(null, {
      enabled: true,
      applicable: false,
    }).ok,
    true,
  );
});
