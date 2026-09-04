import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canDeferPaymentNamedLockAdmission } from "../modules/queue/lane-routing.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(path.join(testDir, "..", "server.js"), "utf8");
const admissionSource = readFileSync(
  path.join(
    testDir,
    "..",
    "modules",
    "queue",
    "payment-lane-admission.js",
  ),
  "utf8",
);

function paymentLaneMutationSource() {
  const start = serverSource.indexOf("async function withPaymentLaneMutation");
  const end = serverSource.indexOf("async function withRoomLaneMutation", start);
  assert.ok(start >= 0 && end > start, "withPaymentLaneMutation non trovata");
  return serverSource.slice(start, end);
}

function paymentLaneRoutingSource() {
  const start = serverSource.indexOf("if (isPaymentLaneRequest");
  const end = serverSource.indexOf(
    "if (posRoomChangeApprovePinProof.shouldPrepare",
    start,
  );
  assert.ok(start >= 0 && end > start, "routing payment lane non trovato");
  return serverSource.slice(start, end);
}

test("la lane pagamenti accoda prima di acquisire la reservation", () => {
  const source = paymentLaneMutationSource();
  assert.match(source, /const enqueue = \(run\) =>/);
  assert.match(source, /paymentLaneQueue\.push\(/);
  assert.match(source, /run,/);
  assert.match(source, /enqueuePaymentLaneTaskWithAdmission\(\{/);
  assert.doesNotMatch(source, /paymentDomainNamedLockCoordinator\.reserveLocal/);
  assert.match(admissionSource, /const runInLane = async \(\) =>/);
  assert.match(admissionSource, /return coordinator\.reserveLocal\(/);
  assert.match(admissionSource, /return enqueue\(runInLane\);/);
});

test("free-split stateless durevole differisce la prenotazione fino al fallback", () => {
  const eligible = {
    relationalWritePrimary: true,
    durableMirror: true,
    statelessMirror: true,
  };
  assert.equal(
    canDeferPaymentNamedLockAdmission("/api/payments/free-split", eligible),
    true,
  );
  assert.equal(
    canDeferPaymentNamedLockAdmission("/api/payments/table", eligible),
    false,
  );
  for (const disabled of Object.keys(eligible)) {
    assert.equal(
      canDeferPaymentNamedLockAdmission("/api/payments/free-split", {
        ...eligible,
        [disabled]: false,
      }),
      false,
    );
  }

  const source = paymentLaneMutationSource();
  assert.match(
    source,
    /deferNamedLockAdmission:\s*options\.deferNamedLockAdmission === true/,
  );
  assert.match(
    paymentLaneRoutingSource(),
    /deferNamedLockAdmission:\s*canDeferPaymentNamedLockAdmission\([\s\S]+?RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY[\s\S]+?PAYMENT_FREE_SPLIT_DURABLE_MIRROR[\s\S]+?PAYMENT_MIRROR_STATELESS_CONSUMER/,
  );
  const orderRoutingSource = serverSource.slice(
    serverSource.indexOf("if (isOrderSyncFastLaneRequest"),
    serverSource.indexOf("if (isPaymentLaneRequest"),
  );
  assert.doesNotMatch(orderRoutingSource, /deferNamedLockAdmission/);
});

test("il task della lane ripristina la prenotazione prima dei writer", () => {
  assert.match(
    admissionSource,
    /coordinator\.runInLocalReservation\(reservation, action\)/,
  );
});

test("il mirror legacy conserva la priorita background all'ammissione", () => {
  const mirrorSource = readFileSync(
    path.join(
      testDir,
      "..",
      "modules",
      "payments",
      "payment-free-split-durable-mirror.js",
    ),
    "utf8",
  );
  assert.match(
    mirrorSource,
    /withPaymentLaneMutation\([\s\S]+?namedLockPriority:\s*["']background["']/,
  );
});

test("il mirror stateless cede al foreground e riceve il wake a lane vuota", () => {
  assert.match(
    serverSource,
    /function hasPaymentMirrorForegroundPressure\(\)\s*\{[\s\S]+?domainLaneRunningCount\(\)\s*>\s*0[\s\S]+?domainLaneQueueDepth\(\)\s*>\s*0[\s\S]+?orderAsyncAppStateFlushQueue\.hasPressure\(\)[\s\S]+?createPaymentFreeSplitDurableMirrorRuntime\(\{[\s\S]+?hasForegroundPressure:\s*hasPaymentMirrorForegroundPressure/,
  );
  assert.match(
    serverSource,
    /foregroundDeferralMaxAgeMs:\s*PAYMENT_MIRROR_FOREGROUND_DEFERRAL_MAX_AGE_MS/,
  );
  assert.match(
    serverSource,
    /BACKEND_PAYMENT_MIRROR_FOREGROUND_IDLE_GRACE_MS,\s*3_000/,
  );
  assert.match(
    serverSource,
    /foregroundIdleGraceMs:\s*PAYMENT_MIRROR_FOREGROUND_IDLE_GRACE_MS/,
  );
  const schedulerStart = serverSource.indexOf(
    "function scheduleNextPaymentLaneTask",
  );
  const schedulerEnd = serverSource.indexOf(
    "function scheduleNextRoomLaneTask",
    schedulerStart,
  );
  assert.ok(
    schedulerStart >= 0 && schedulerEnd > schedulerStart,
    "scheduler payment lane non trovato",
  );
  const schedulerSource = serverSource.slice(schedulerStart, schedulerEnd);
  assert.match(
    schedulerSource,
    /paymentLaneRunning === 0 && paymentLaneQueue\.length === 0[\s\S]+?paymentMirrorWorkerRuntime\.notifyForegroundIdle\(\)/,
  );
});
