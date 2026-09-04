import assert from "node:assert/strict";
import test from "node:test";

import { buildAutoPrintOwnerAudit } from "./v6-auto-print-owner-gate.mjs";

function directEvidence() {
  return {
    counters: {
      printSpoolAutoPrintRemoteOwnerHandled: 2,
      printSpoolAutoPrintOwnerDuplicates: 0,
    },
    workers: [{
      role: "api-worker",
      runtimeMetrics: {
        counters: {
          printSpoolAutoPrintOwnerEnqueued: 1,
          printSpoolAutoPrintOwnerCoalesced: 0,
          printSpoolAutoPrintOwnerBatches: 1,
          printSpoolAutoPrintOwnerFlushed: 1,
          printSpoolAutoPrintOwnerRetries: 0,
          printSpoolAutoPrintRemoteOwnerForwarded: 1,
          printSpoolAutoPrintRemoteOwnerAccepted: 1,
          printSpoolAutoPrintRemoteOwnerErrors: 0,
          printSpoolAutoPrintRemoteOwnerTimeouts: 0,
          printSpoolAutoPrintRemoteOwnerForwardedPlans: 1,
          printSpoolAutoPrintRemoteOwnerForwardedJobs: 2,
          printSpoolAutoPrintRemoteOwnerConfirmedPlans: 1,
          printSpoolAutoPrintRemoteOwnerConfirmedJobs: 2,
          printSpoolAutoPrintRemoteOwnerAcceptedJobs: 2,
          printSpoolAutoPrintRemoteOwnerDuplicateJobs: 0,
          printSpoolAutoPrintRemoteOwnerResultMismatches: 0,
          printSpoolAutoPrintRemoteOwnerInvalidPayloads: 0,
          printSpoolAutoPrintRemoteOwnerMisconfigured: 0,
          printLaneEnqueued: 0,
        },
        gauges: {
          printSpoolAutoPrintOwnerPendingDepth: 0,
          printSpoolAutoPrintOwnerRunning: 0,
        },
      },
    }],
  };
}

function evaluate(metrics) {
  return buildAutoPrintOwnerAudit(metrics, {
    applicable: true,
    expectedApiWorkers: 1,
  });
}

test("il gate accetta il percorso diretto exactly-once", () => {
  const audit = evaluate(directEvidence());
  assert.equal(audit.ok, true);
  assert.equal(audit.evidenceMode, "DIRECT_OWNER_ACK");
  assert.deepEqual(audit.failures, []);
});

test("il gate accetta un timeout remoto recuperato con retry e deduplica", () => {
  const metrics = directEvidence();
  const counters = metrics.workers[0].runtimeMetrics.counters;
  counters.printSpoolAutoPrintOwnerRetries = 1;
  counters.printSpoolAutoPrintRemoteOwnerForwarded = 2;
  counters.printSpoolAutoPrintRemoteOwnerErrors = 1;
  counters.printSpoolAutoPrintRemoteOwnerTimeouts = 1;
  counters.printSpoolAutoPrintRemoteOwnerForwardedPlans = 2;
  counters.printSpoolAutoPrintRemoteOwnerForwardedJobs = 4;
  counters.printSpoolAutoPrintRemoteOwnerAcceptedJobs = 0;
  counters.printSpoolAutoPrintRemoteOwnerDuplicateJobs = 2;
  metrics.counters.printSpoolAutoPrintOwnerDuplicates = 2;

  const audit = evaluate(metrics);
  assert.equal(audit.ok, true);
  assert.equal(audit.evidenceMode, "RECOVERED_REMOTE_TIMEOUT");
  assert.equal(audit.checks.exactlyOnceOwnerWrites, true);
  assert.equal(audit.checks.dedupWithinForwardedAttempts, true);
});

test("il gate accetta il timeout precedente alla scrittura recuperato dal retry", () => {
  const metrics = directEvidence();
  const counters = metrics.workers[0].runtimeMetrics.counters;
  counters.printSpoolAutoPrintOwnerRetries = 1;
  counters.printSpoolAutoPrintRemoteOwnerForwarded = 2;
  counters.printSpoolAutoPrintRemoteOwnerErrors = 1;
  counters.printSpoolAutoPrintRemoteOwnerTimeouts = 1;
  counters.printSpoolAutoPrintRemoteOwnerForwardedPlans = 2;
  counters.printSpoolAutoPrintRemoteOwnerForwardedJobs = 4;

  assert.equal(evaluate(metrics).ok, true);
});

test("il gate rifiuta errori non-timeout o privi del retry corrispondente", () => {
  const nonTimeout = directEvidence();
  let counters = nonTimeout.workers[0].runtimeMetrics.counters;
  counters.printSpoolAutoPrintOwnerRetries = 1;
  counters.printSpoolAutoPrintRemoteOwnerForwarded = 2;
  counters.printSpoolAutoPrintRemoteOwnerErrors = 1;
  counters.printSpoolAutoPrintRemoteOwnerForwardedPlans = 2;
  counters.printSpoolAutoPrintRemoteOwnerForwardedJobs = 4;
  let audit = evaluate(nonTimeout);
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.includes("remoteTimeoutsOnly"));

  const noRetry = structuredClone(nonTimeout);
  counters = noRetry.workers[0].runtimeMetrics.counters;
  counters.printSpoolAutoPrintRemoteOwnerTimeouts = 1;
  counters.printSpoolAutoPrintOwnerRetries = 0;
  audit = evaluate(noRetry);
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.includes("everyErrorRetried"));
});

test("il gate rifiuta scritture locali, code residue e input non affidabile", () => {
  const cases = [
    ["printLaneEnqueued", 1, "noApiWorkerLocalWrites", "counters"],
    ["printSpoolAutoPrintOwnerPendingDepth", 1, "queuesDrained", "gauges"],
    ["printSpoolAutoPrintRemoteOwnerMisconfigured", 1, "correctlyConfigured", "counters"],
    ["printSpoolAutoPrintRemoteOwnerInvalidPayloads", 1, "noInvalidPayloads", "counters"],
    ["printSpoolAutoPrintRemoteOwnerResultMismatches", 1, "noResultMismatches", "counters"],
  ];
  for (const [metric, value, failedCheck, collection] of cases) {
    const metrics = directEvidence();
    metrics.workers[0].runtimeMetrics[collection][metric] = value;
    const audit = evaluate(metrics);
    assert.equal(audit.ok, false, metric);
    assert.ok(audit.failures.includes(failedCheck), metric);
  }
});

test("il gate rifiuta mismatch di coda, risposta o persistenza owner", () => {
  const cases = [
    ["printSpoolAutoPrintOwnerEnqueued", 2, "enqueueFlushMatch"],
    ["printSpoolAutoPrintRemoteOwnerConfirmedPlans", 2, "confirmedPlanCardinality"],
    ["printSpoolAutoPrintRemoteOwnerAcceptedJobs", 1, "confirmedJobCardinality"],
  ];
  for (const [metric, value, failedCheck] of cases) {
    const metrics = directEvidence();
    metrics.workers[0].runtimeMetrics.counters[metric] = value;
    const audit = evaluate(metrics);
    assert.equal(audit.ok, false, metric);
    assert.ok(audit.failures.includes(failedCheck), metric);
  }

  const ownerMismatch = directEvidence();
  ownerMismatch.counters.printSpoolAutoPrintRemoteOwnerHandled = 1;
  const audit = evaluate(ownerMismatch);
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.includes("exactlyOnceOwnerWrites"));
});

test("un gate non applicabile resta informativo senza promuovere evidenze", () => {
  const audit = buildAutoPrintOwnerAudit({}, {
    applicable: false,
    expectedApiWorkers: 2,
  });
  assert.equal(audit.ok, true);
  assert.ok(audit.failures.length > 0);
});
