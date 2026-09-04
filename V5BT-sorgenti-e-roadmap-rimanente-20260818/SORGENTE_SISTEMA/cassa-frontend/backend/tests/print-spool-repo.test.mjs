import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  PrintSpoolRepository,
  closeRelationalConnection,
  openRelationalConnection,
  runRelationalMigrations,
} from "../db/relational/index.js";
import { createTempRunDir } from "./helpers/test-server.mjs";

const BASE = Date.parse("2026-07-07T10:00:00.000Z");

function clockFrom(startMs) {
  let ms = startMs;
  return {
    nowIso: () => new Date(ms).toISOString(),
    advance: (deltaMs) => {
      ms += deltaMs;
    },
    set: (iso) => {
      ms = Date.parse(iso);
    },
  };
}

async function withRepo(name, clock, fn) {
  const runDir = await createTempRunDir(name);
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openRelationalConnection({ enabled: true, mode: "shadow", dbPath });
  try {
    await runRelationalMigrations(db, { nowIso: () => "2026-07-07T10:00:00.000Z" });
    return await fn(new PrintSpoolRepository(db, { nowIso: clock.nowIso }), db);
  } finally {
    closeRelationalConnection(db);
  }
}

function seed(repo, id, extra = {}) {
  return repo.enqueue({ id, status: "queued", orderId: `o-${id}`, printerId: "pr1", payload: { id, kind: "order" }, ...extra });
}

test("enqueueMany inserisce order e preconto in un'unica operazione preservando l'ordine", async () => {
  const clock = clockFrom(BASE);
  await withRepo("ps-enqueue-many", clock, (repo) => {
    const jobs = repo.enqueueMany([
      {
        id: "batch-order",
        status: "queued",
        kind: "order",
        orderId: "order-1",
        printerId: "pr1",
        requestedAt: "2026-07-07T10:00:01.000Z",
        payload: { id: "batch-order", kind: "order" },
      },
      {
        id: "batch-preconto",
        status: "queued",
        kind: "preconto",
        orderId: "order-1",
        printerId: "pr1",
        requestedAt: "2026-07-07T10:00:02.000Z",
        payload: { id: "batch-preconto", kind: "preconto" },
      },
    ]);

    assert.deepEqual(jobs.map((job) => job.id), ["batch-order", "batch-preconto"]);
    assert.deepEqual(jobs.map((job) => job.kind), ["order", "preconto"]);
    assert.equal(repo.countSummary().pending, 2);
    assert.equal(repo.claimNext({ workerId: "w1" })?.id, "batch-order");
    assert.equal(repo.claimNext({ workerId: "w1" })?.id, "batch-preconto");
  });
});

test("enqueueMany valida tutto il batch prima della transazione", async () => {
  const clock = clockFrom(BASE);
  await withRepo("ps-enqueue-many-invalid", clock, (repo) => {
    assert.throws(
      () => repo.enqueueMany([
        { id: "valid-before-invalid", status: "queued" },
        { id: "", status: "queued" },
      ]),
      /richiede un id/,
    );
    assert.equal(repo.getById("valid-before-invalid"), null);
    assert.equal(repo.countSummary().pending, 0);
  });
});

test("migrazione 019 crea print_spool con gli indici", async () => {
  const clock = clockFrom(BASE);
  await withRepo("ps-migration", clock, (_repo, db) => {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='print_spool'").get();
    assert.ok(table, "tabella print_spool presente");
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_print_spool_claim'").get();
    assert.ok(idx, "indice di claim presente");
  });
});

test("claimNext è atomico: due claim prendono job distinti", async () => {
  const clock = clockFrom(BASE);
  await withRepo("ps-claim", clock, (repo) => {
    seed(repo, "p1");
    clock.advance(1000);
    seed(repo, "p2");
    const c1 = repo.claimNext({ workerId: "w1", leaseMs: 30_000 });
    const c2 = repo.claimNext({ workerId: "w2", leaseMs: 30_000 });
    assert.equal(c1.status, "claimed");
    assert.equal(c2.status, "claimed");
    assert.notEqual(c1.id, c2.id);
    // Il più vecchio (p1) va preso per primo (ordine FIFO su requested_at).
    assert.equal(c1.id, "p1");
    assert.equal(repo.claimNext({ workerId: "w3" }), null, "coda vuota → null");
  });
});

test("retry/backoff: failed_retryable non è riclaimato prima di next_retry_at", async () => {
  const clock = clockFrom(BASE);
  await withRepo("ps-retry", clock, (repo) => {
    seed(repo, "p1");
    const claimed = repo.claimNext({ workerId: "w1", leaseMs: 30_000 });
    assert.equal(claimed.id, "p1");
    const failed = repo.markFailed("p1", { retryable: true, retryDelayMs: 60_000, errorMessage: "timeout" });
    assert.equal(failed.status, "failed_retryable");
    assert.equal(failed.attemptCount, 1);
    assert.ok(failed.nextRetryAt);

    // Prima del retry time → non claimabile.
    clock.advance(30_000);
    assert.equal(repo.claimNext({ workerId: "w1" }), null, "non ancora pronto per retry");

    // Dopo il retry time → riclaimato.
    clock.advance(40_000);
    const reclaimed = repo.claimNext({ workerId: "w1", leaseMs: 30_000 });
    assert.equal(reclaimed?.id, "p1");
    assert.equal(reclaimed.status, "claimed");
  });
});

test("markFailed non-retryable termina come failed_final", async () => {
  const clock = clockFrom(BASE);
  await withRepo("ps-final", clock, (repo) => {
    seed(repo, "p1");
    repo.claimNext({ workerId: "w1" });
    const failed = repo.markFailed("p1", { retryable: false, errorMessage: "config" });
    assert.equal(failed.status, "failed_final");
    assert.ok(failed.terminalAt);
    assert.equal(repo.claimNext({ workerId: "w1" }), null, "un job terminale non è più claimabile");
  });
});

test("reclaim lease scaduto (crash worker) riporta il job in coda", async () => {
  const clock = clockFrom(BASE);
  await withRepo("ps-reclaim-lease", clock, (repo) => {
    seed(repo, "p1");
    const claimed = repo.claimNext({ workerId: "w1", leaseMs: 30_000 });
    assert.equal(claimed.status, "claimed");
    // Prima della scadenza lease → nessun reclaim.
    clock.advance(10_000);
    assert.equal(repo.reclaimExpiredLeases(), 0);
    // Dopo la scadenza → reclaim.
    clock.advance(40_000);
    assert.equal(repo.reclaimExpiredLeases(), 1);
    assert.equal(repo.getById("p1").status, "queued");
  });
});

test("reclaimAllClaimed (startup) riporta in coda ogni job claimed", async () => {
  const clock = clockFrom(BASE);
  await withRepo("ps-reclaim-all", clock, (repo) => {
    seed(repo, "p1");
    seed(repo, "p2");
    repo.claimNext({ workerId: "w1", leaseMs: 300_000 });
    // Lease ancora valido, ma allo startup il worker precedente è morto.
    assert.equal(repo.reclaimAllClaimed(), 1);
    assert.equal(repo.getById("p1").status, "queued");
  });
});

test("markConfirmed + retention terminale", async () => {
  const clock = clockFrom(BASE);
  await withRepo("ps-retention", clock, (repo) => {
    seed(repo, "p1");
    repo.claimNext({ workerId: "w1" });
    repo.markSent("p1");
    const confirmed = repo.markConfirmed("p1");
    assert.equal(confirmed.status, "confirmed");
    assert.ok(confirmed.terminalAt);
    const summary = repo.countSummary();
    assert.equal(summary.terminal, 1);
    assert.equal(summary.pending, 0);
    // Retention: cancella i terminali prima di un cutoff futuro.
    clock.advance(60_000);
    const deleted = repo.deleteTerminalBefore(clock.nowIso());
    assert.equal(deleted, 1);
    assert.equal(repo.getById("p1"), null);
  });
});
