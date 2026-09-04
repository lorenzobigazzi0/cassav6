import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  closeRelationalConnection,
  openRelationalConnection,
  PaymentMirrorOutboxRepository,
  runRelationalMigrations,
} from "../db/relational/index.js";
import { createPaymentMirrorWorkerRuntime } from "../modules/payments/payment-mirror-worker.js";
import { createRuntimeMetrics } from "../modules/runtime-metrics.js";
import { createTempRunDir } from "./helpers/test-server.mjs";

function createClock(startIso = "2026-07-14T09:00:00.000Z") {
  let currentMs = Date.parse(startIso);
  return {
    nowIso: () => new Date(currentMs).toISOString(),
    advance(ms) {
      currentMs += Math.trunc(Number(ms) || 0);
      return this.nowIso();
    },
  };
}

async function openMigratedDb(prefix, clock) {
  const runDir = await createTempRunDir(prefix);
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: path.join(runDir, "relational.sqlite"),
  });
  await runRelationalMigrations(db, { nowIso: clock.nowIso });
  return db;
}

function enqueue(repo, id = "pay_1") {
  return repo.enqueue({
    mirrorId: `payment-free-split:${id}`,
    mirrorKind: "payment.free_split",
    aggregateId: id,
    idempotencyKey: `idem_${id}`,
    payloadVersion: 1,
    payload: { version: 1, kind: "payment.free_split", aggregateId: id },
  });
}

async function waitFor(predicate, { attempts = 100, delayMs = 0 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return true;
    await new Promise((resolve) =>
      delayMs > 0 ? setTimeout(resolve, delayMs) : setImmediate(resolve),
    );
  }
  return false;
}

test("P4.3 migration e repository payment mirror sono idempotenti", async () => {
  const clock = createClock();
  const db = await openMigratedDb("p43-payment-mirror-schema", clock);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'payment_mirror_outbox'").get();
    const readyIndex = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_payment_mirror_outbox_ready'").get();
    const retentionIndex = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_payment_mirror_outbox_terminal'").get();
    assert.equal(table?.name, "payment_mirror_outbox");
    assert.equal(readyIndex?.name, "idx_payment_mirror_outbox_ready");
    assert.equal(retentionIndex?.name, "idx_payment_mirror_outbox_terminal");

    const repo = new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso });
    const first = enqueue(repo);
    const replay = enqueue(repo);
    assert.equal(first.mirrorId, replay.mirrorId);
    assert.equal(repo.countSummary().pending, 1);

    const claimed = repo.claimNext({ workerId: "worker-a", leaseMs: 30_000 });
    assert.equal(claimed.status, "processing");
    assert.equal(claimed.lockedBy, "worker-a");
    assert.equal(repo.claimNext({ workerId: "worker-b" }), null);

    const completed = repo.markCompleted(claimed.mirrorId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.lockedBy, null);
    assert.equal(repo.countSummary().completed, 1);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 retention payment mirror elimina solo terminali scaduti in batch", async () => {
  const clock = createClock();
  const db = await openMigratedDb("p43-payment-mirror-retention", clock);
  try {
    const repo = new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso });
    const completedOld = enqueue(repo, "pay_completed_old");
    repo.markCompleted(completedOld.mirrorId);
    const failedOld = enqueue(repo, "pay_failed_old");
    repo.claimNext({ workerId: "worker-retention" });
    repo.markFailed(failedOld.mirrorId, { terminal: true, errorCode: "FINAL" });
    const processingOld = enqueue(repo, "pay_processing_old");
    repo.claimNext({ workerId: "worker-retention" });
    assert.equal(repo.getById(processingOld.mirrorId).status, "processing");
    enqueue(repo, "pay_pending_old");

    clock.advance(100 * 24 * 60 * 60 * 1000);
    const completedRecent = enqueue(repo, "pay_completed_recent");
    repo.markCompleted(completedRecent.mirrorId);
    const options = {
      completedBefore: new Date(Date.parse(clock.nowIso()) - 30 * 24 * 60 * 60 * 1000).toISOString(),
      failedBefore: new Date(Date.parse(clock.nowIso()) - 90 * 24 * 60 * 60 * 1000).toISOString(),
      limit: 1,
    };

    assert.equal(repo.deleteTerminalBefore(options).deleted, 1);
    assert.equal(repo.deleteTerminalBefore(options).deleted, 1);
    assert.deepEqual(repo.deleteTerminalBefore(options), { deleted: 0, completed: 0, failed: 0 });
    assert.equal(repo.getById(completedOld.mirrorId), null);
    assert.equal(repo.getById(failedOld.mirrorId), null);
    assert.equal(repo.getById("payment-free-split:pay_pending_old").status, "pending");
    assert.equal(repo.getById(processingOld.mirrorId).status, "processing");
    assert.equal(repo.getById(completedRecent.mirrorId).status, "completed");
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 worker espone metriche retention e profondita per stato", async () => {
  const clock = createClock();
  const db = await openMigratedDb("p43-payment-mirror-retention-metrics", clock);
  try {
    const repo = new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso });
    const completed = enqueue(repo, "pay_cleanup_metric");
    repo.markCompleted(completed.mirrorId);
    clock.advance(1_000);
    const metrics = createRuntimeMetrics({ enabled: true });
    const runtime = createPaymentMirrorWorkerRuntime({
      enabled: true,
      relationalRuntime: { db, initialize: async () => {} },
      PaymentMirrorOutboxRepository,
      processClaim: async () => {},
      completedRetentionMs: 100,
      failedRetentionMs: 100,
      cleanupBatchSize: 10,
      nowIso: clock.nowIso,
      runtimeMetrics: metrics,
      logger: { info() {}, warn() {}, error() {} },
    });

    const result = await runtime.runBatch("retention-test");
    assert.equal(result.cleanup.deleted, 1);
    assert.equal(repo.getById(completed.mirrorId), null);
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.counters.paymentMirrorRetentionRuns, 1);
    assert.equal(snapshot.counters.paymentMirrorRetentionDeleted, 1);
    assert.equal(snapshot.gauges.paymentMirrorPendingRows, 0);
    assert.equal(snapshot.gauges.paymentMirrorProcessingRows, 0);
    assert.equal(snapshot.gauges.paymentMirrorCompletedRows, 0);
    assert.equal(snapshot.gauges.paymentMirrorFailedRows, 0);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 payment mirror retry rispetta next_attempt_at", async () => {
  const clock = createClock();
  const db = await openMigratedDb("p43-payment-mirror-retry", clock);
  try {
    const repo = new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso });
    enqueue(repo, "pay_retry");
    const claim = repo.claimNext({ workerId: "worker-a" });
    const retryAt = new Date(Date.parse(clock.nowIso()) + 30_000).toISOString();
    const retrying = repo.markFailed(claim.mirrorId, {
      nextAttemptAt: retryAt,
      errorCode: "MYSQL_TIMEOUT",
      errorMessage: "timeout",
    });
    assert.equal(retrying.status, "retrying");
    assert.equal(retrying.attemptCount, 1);
    assert.equal(repo.claimNext({ workerId: "worker-b" }), null);
    clock.advance(30_001);
    assert.equal(repo.claimNext({ workerId: "worker-b" })?.mirrorId, claim.mirrorId);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 worker completa il mirror e aggiorna metriche", async () => {
  const clock = createClock();
  const db = await openMigratedDb("p43-payment-mirror-worker", clock);
  try {
    const repo = new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso });
    enqueue(repo, "pay_worker");
    const processed = [];
    const metrics = createRuntimeMetrics({ enabled: true });
    const runtime = createPaymentMirrorWorkerRuntime({
      enabled: true,
      relationalRuntime: { db, initialize: async () => {} },
      PaymentMirrorOutboxRepository,
      processClaim: async (entry) => processed.push(entry.mirrorId),
      nowIso: clock.nowIso,
      runtimeMetrics: metrics,
      logger: { info() {}, warn() {}, error() {} },
    });

    const result = await runtime.runBatch("test");
    assert.equal(result.processed, 1);
    assert.deepEqual(processed, ["payment-free-split:pay_worker"]);
    assert.equal(repo.getByAggregate("payment.free_split", "pay_worker").status, "completed");
    assert.equal(metrics.snapshot().counters.paymentMirrorCompleted, 1);
    assert.equal(metrics.snapshot().gauges.paymentMirrorPendingDepth, 0);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 worker non claima durante pressione foreground e misura l'eta redatta", async () => {
  const clock = createClock();
  const db = await openMigratedDb("p43-payment-mirror-foreground-pressure", clock);
  try {
    const repo = new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso });
    enqueue(repo, "pay_pressure");
    clock.advance(20_000);
    let processed = 0;
    const metrics = createRuntimeMetrics({ enabled: true });
    const runtime = createPaymentMirrorWorkerRuntime({
      enabled: true,
      relationalRuntime: { db, initialize: async () => {} },
      PaymentMirrorOutboxRepository,
      processClaim: async () => {
        processed += 1;
      },
      hasForegroundPressure: () => true,
      foregroundDeferralMaxAgeMs: 15_000,
      nowIso: clock.nowIso,
      runtimeMetrics: metrics,
      logger: { info() {}, warn() {}, error() {} },
    });

    const result = await runtime.runBatch("foreground-pressure");
    assert.equal(result.processed, 0);
    assert.equal(result.deferred, true);
    assert.equal(result.deferReason, "foreground-pressure");
    assert.equal(processed, 0);
    assert.equal(repo.getByAggregate("payment.free_split", "pay_pressure").status, "pending");
    assert.equal(repo.countSummary().processing, 0);
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.counters.paymentMirrorClaims, 0);
    assert.equal(snapshot.counters.paymentMirrorForegroundDeferrals, 1);
    assert.equal(snapshot.counters.paymentMirrorForegroundAgedDeferrals, 1);
    assert.equal(snapshot.gauges.paymentMirrorOldestPendingAgeMs, 20_000);
    assert.equal(snapshot.gauges.paymentMirrorForegroundPressure, 1);
    assert.equal(snapshot.gauges.paymentMirrorForegroundDeferralOverdue, 1);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 wake foreground-idle riprende un mirror rimasto pending", async () => {
  const clock = createClock();
  const db = await openMigratedDb("p43-payment-mirror-foreground-idle", clock);
  try {
    const repo = new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso });
    enqueue(repo, "pay_idle_resume");
    let pressure = true;
    const metrics = createRuntimeMetrics({ enabled: true });
    const runtime = createPaymentMirrorWorkerRuntime({
      enabled: true,
      relationalRuntime: { db, initialize: async () => {} },
      PaymentMirrorOutboxRepository,
      processClaim: async () => {},
      hasForegroundPressure: () => pressure,
      foregroundIdleGraceMs: 25,
      nowIso: clock.nowIso,
      runtimeMetrics: metrics,
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal((await runtime.runBatch("busy")).deferred, true);
    pressure = false;
    assert.equal(runtime.notifyForegroundIdle(), true);
    assert.equal((await runtime.runBatch("poll-during-grace")).deferReason, "foreground-idle-grace");
    assert.equal(repo.getByAggregate("payment.free_split", "pay_idle_resume").status, "pending");
    assert.equal(
      await waitFor(
        () =>
          repo.getByAggregate("payment.free_split", "pay_idle_resume")
            ?.status === "completed",
        { delayMs: 2 },
      ),
      true,
    );
    assert.equal(metrics.snapshot().counters.paymentMirrorForegroundIdleWakes, 1);
    assert.ok(metrics.snapshot().counters.paymentMirrorForegroundGraceDeferrals >= 1);
    assert.equal(metrics.snapshot().gauges.paymentMirrorForegroundGraceActive, 0);
    assert.equal(repo.countSummary().processing, 0);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 nuova pressione rinvia la grace e stop cancella il wake", async () => {
  const clock = createClock();
  const db = await openMigratedDb("p43-payment-mirror-grace-reset", clock);
  try {
    const repo = new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso });
    enqueue(repo, "pay_grace_reset");
    let pressure = false;
    let processed = 0;
    const runtime = createPaymentMirrorWorkerRuntime({
      enabled: true,
      foregroundIdleGraceMs: 20,
      relationalRuntime: { db, initialize: async () => {} },
      PaymentMirrorOutboxRepository,
      processClaim: async () => {
        processed += 1;
      },
      hasForegroundPressure: () => pressure,
      nowIso: clock.nowIso,
      runtimeMetrics: createRuntimeMetrics({ enabled: true }),
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(runtime.notifyForegroundIdle(), true);
    pressure = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(processed, 0);
    assert.equal(repo.countSummary().pending, 1);

    pressure = false;
    assert.equal(runtime.notifyForegroundIdle(), true);
    runtime.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(processed, 0);
    assert.equal(repo.countSummary().pending, 1);

    assert.equal((await runtime.drain({ timeoutMs: 1_000 })).drained, true);
    assert.equal(processed, 1);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 wake concorrenti sono coalescenti e non perdono il rerun", async () => {
  const clock = createClock();
  const db = await openMigratedDb("p43-payment-mirror-wake-coalesced", clock);
  try {
    const repo = new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso });
    enqueue(repo, "pay_wake_1");
    enqueue(repo, "pay_wake_2");
    let releaseFirst;
    const firstBlocked = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const processed = [];
    const metrics = createRuntimeMetrics({ enabled: true });
    const runtime = createPaymentMirrorWorkerRuntime({
      enabled: true,
      batchSize: 5,
      foregroundIdleBatchSize: 1,
      relationalRuntime: { db, initialize: async () => {} },
      PaymentMirrorOutboxRepository,
      processClaim: async (entry) => {
        processed.push(entry.mirrorId);
        if (processed.length === 1) await firstBlocked;
      },
      hasForegroundPressure: () => false,
      nowIso: clock.nowIso,
      runtimeMetrics: metrics,
      logger: { info() {}, warn() {}, error() {} },
    });

    const manualRun = runtime.runBatch("manual");
    assert.equal(await waitFor(() => processed.length === 1), true);
    assert.equal(runtime.wake("second"), false);
    assert.equal(runtime.wake("third"), false);
    releaseFirst();
    assert.equal((await manualRun).processed, 1);
    assert.equal(await waitFor(() => repo.countSummary().completed === 2), true);
    assert.deepEqual(processed.sort(), [
      "payment-free-split:pay_wake_1",
      "payment-free-split:pay_wake_2",
    ]);
    assert.ok(metrics.snapshot().counters.paymentMirrorWakeCoalesced >= 1);
    assert.equal(repo.countSummary().processing, 0);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 worker drena il batch idle e ricontrolla il foreground tra claim", async () => {
  const clock = createClock();
  const db = await openMigratedDb("p43-payment-mirror-idle-bounded", clock);
  try {
    const repo = new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso });
    enqueue(repo, "pay_bounded_1");
    enqueue(repo, "pay_bounded_2");
    let pressure = false;
    let processed = 0;
    const runtime = createPaymentMirrorWorkerRuntime({
      enabled: true,
      batchSize: 5,
      relationalRuntime: { db, initialize: async () => {} },
      PaymentMirrorOutboxRepository,
      processClaim: async () => {
        processed += 1;
        pressure = true;
      },
      hasForegroundPressure: () => pressure,
      foregroundIdleGraceMs: 15,
      nowIso: clock.nowIso,
      runtimeMetrics: createRuntimeMetrics({ enabled: true }),
      logger: { info() {}, warn() {}, error() {} },
    });

    const interrupted = await runtime.runBatch("idle-batch-interrupted");
    assert.equal(interrupted.processed, 1);
    assert.equal(interrupted.deferReason, "foreground-pressure");
    assert.deepEqual(repo.countSummary(), {
      pending: 1,
      processing: 0,
      completed: 1,
      failed: 0,
      oldestPendingAt: clock.nowIso(),
    });
    pressure = false;
    assert.equal(
      (await runtime.runBatch("idle-batch-during-grace")).deferReason,
      "foreground-idle-grace",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await runtime.runBatch("idle-batch-resumed")).processed, 1);
    assert.equal(processed, 2);
    assert.equal(repo.countSummary().completed, 2);
    assert.equal(repo.countSummary().processing, 0);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 drain bypassa il gate foreground e non lascia claim processing", async () => {
  const clock = createClock();
  const db = await openMigratedDb("p43-payment-mirror-drain-foreground", clock);
  try {
    const repo = new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso });
    enqueue(repo, "pay_drain_1");
    enqueue(repo, "pay_drain_2");
    enqueue(repo, "pay_drain_3");
    const runtime = createPaymentMirrorWorkerRuntime({
      enabled: true,
      batchSize: 2,
      relationalRuntime: { db, initialize: async () => {} },
      PaymentMirrorOutboxRepository,
      processClaim: async () => {},
      hasForegroundPressure: () => true,
      nowIso: clock.nowIso,
      runtimeMetrics: createRuntimeMetrics({ enabled: true }),
      logger: { info() {}, warn() {}, error() {} },
    });

    const result = await runtime.drain({ timeoutMs: 5_000 });
    assert.equal(result.drained, true);
    assert.deepEqual(repo.countSummary(), {
      pending: 0,
      processing: 0,
      completed: 3,
      failed: 0,
      oldestPendingAt: null,
    });
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 startup reclaim recupera un job lasciato processing da crash", async () => {
  const clock = createClock();
  const db = await openMigratedDb("p43-payment-mirror-crash", clock);
  try {
    const repo = new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso });
    enqueue(repo, "pay_crash");
    assert.equal(repo.claimNext({ workerId: "process-killed" }).status, "processing");
    const runtime = createPaymentMirrorWorkerRuntime({
      enabled: true,
      relationalRuntime: { db, initialize: async () => {} },
      PaymentMirrorOutboxRepository,
      processClaim: async () => {},
      nowIso: clock.nowIso,
      runtimeMetrics: createRuntimeMetrics({ enabled: true }),
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(await runtime.reclaimStartup(), 1);
    assert.equal(repo.getByAggregate("payment.free_split", "pay_crash").status, "retrying");
    assert.equal((await runtime.runBatch("crash-recovery")).processed, 1);
    assert.equal(repo.getByAggregate("payment.free_split", "pay_crash").status, "completed");
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 worker ritenta e poi completa senza perdere il job", async () => {
  const clock = createClock();
  const db = await openMigratedDb("p43-payment-mirror-worker-retry", clock);
  try {
    const repo = new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso });
    enqueue(repo, "pay_worker_retry");
    let attempts = 0;
    const runtime = createPaymentMirrorWorkerRuntime({
      enabled: true,
      relationalRuntime: { db, initialize: async () => {} },
      PaymentMirrorOutboxRepository,
      processClaim: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("temporaneo"), { code: "MYSQL_TIMEOUT" });
      },
      retryBaseMs: 100,
      retryMaxMs: 100,
      nowIso: clock.nowIso,
      runtimeMetrics: createRuntimeMetrics({ enabled: true }),
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal((await runtime.runBatch("first")).results[0].status, "retrying");
    assert.equal(repo.getByAggregate("payment.free_split", "pay_worker_retry").attemptCount, 1);
    clock.advance(101);
    assert.equal((await runtime.runBatch("second")).results[0].status, "completed");
    assert.equal(attempts, 2);
  } finally {
    closeRelationalConnection(db);
  }
});
