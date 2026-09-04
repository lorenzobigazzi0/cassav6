import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  FiscalOutboxRepository,
  openRelationalConnection,
  runRelationalMigrations,
} from "../db/relational/index.js";
import {
  apiPost,
  authPayload,
  createTempRunDir,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";
import { fireConcurrent } from "./helpers/concurrency-harness.mjs";

function nowIso() {
  return "2026-07-07T13:30:00.000Z";
}

function createClock(startIso = nowIso()) {
  let currentMs = Date.parse(startIso);
  return {
    nowIso() {
      return new Date(currentMs).toISOString();
    },
    advance(ms) {
      currentMs += Math.trunc(Number(ms) || 0);
      return this.nowIso();
    },
  };
}

async function openMigratedDb(dbPath) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath,
  });
  await runRelationalMigrations(db, { nowIso });
  return db;
}

function tableExists(db, name) {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

function indexExists(db, name) {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name),
  );
}

async function startFiscalOutboxBackend(t, prefix = "step13a-fiscal-outbox") {
  const runDir = await createTempRunDir(prefix);
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY: "1",
      BACKEND_FISCAL_OUTBOX_ENABLED: "1",
      IDEMPOTENCY_STORE_ENABLED: "1",
      EVENT_OUTBOX_ENABLED: "1",
      POS_FISCAL_API_JOB_RETRY_DELAY_MS: "60000",
      POS_FISCAL_API_RECOVERY_RETRY_DELAY_MS: "60000",
      POS_FISCAL_API_TIMEOUT_MS: "100",
    },
  });
  return { ...backend, relationalPath };
}

function fiscalTicketPayload(session, deviceUuid, idempotencyKey) {
  return authPayload(session, deviceUuid, {
    paymentMethodId: "pay_cash",
    cashGiven: 1.3,
    issueFiscal: true,
    fiscalDocType: "RECEIPT",
    idempotencyKey,
    lines: [
      {
        name: "Caffe Step13",
        qty: 1,
        unitPrice: 1.3,
        unitPriceApplied: 1.3,
        lineTotal: 1.3,
      },
    ],
  });
}

async function readFiscalOutboxSnapshot(relationalPath, idempotencyKey) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    const transactions = db
      .prepare("SELECT * FROM payment_transactions WHERE idempotency_key = ? ORDER BY id ASC")
      .all(idempotencyKey);
    const transactionIds = transactions.map((entry) => entry.id);
    const receipts = transactionIds.length
      ? db
          .prepare(
            `SELECT * FROM fiscal_receipts WHERE payment_transaction_id IN (${transactionIds.map(() => "?").join(",")}) ORDER BY id ASC`,
          )
          .all(...transactionIds)
      : [];
    const fiscalRows = receipts.length
      ? db
          .prepare(
            `SELECT * FROM fiscal_outbox WHERE aggregate_id IN (${receipts.map(() => "?").join(",")}) ORDER BY fiscal_id ASC`,
          )
          .all(...receipts.map((entry) => entry.id))
      : [];
    return { transactions, receipts, fiscalRows };
  } finally {
    db.close();
  }
}

test("Step 13A migration crea fiscal_outbox e repository idempotente", async (t) => {
  const runDir = await createTempRunDir("step13a-repo");
  const relationalPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(relationalPath);
  try {
    assert.equal(tableExists(db, "fiscal_outbox"), true);
    assert.equal(indexExists(db, "idx_fiscal_outbox_status_next"), true);
    assert.equal(indexExists(db, "idx_fiscal_outbox_aggregate"), true);
    assert.equal(indexExists(db, "idx_fiscal_outbox_lease"), true);

    const repo = new FiscalOutboxRepository(db, { nowIso });
    const first = repo.enqueue({
      fiscalId: "fiscal_out_test_1",
      aggregateType: "fiscal_receipt",
      aggregateId: "fiscal_receipt_1",
      paymentId: "tx_step13a_1",
      status: "requested",
      payload: { receiptId: "fiscal_receipt_1" },
    });
    const replay = repo.enqueue({
      fiscalId: "fiscal_out_test_1",
      aggregateType: "fiscal_receipt",
      aggregateId: "fiscal_receipt_1",
      paymentId: "tx_step13a_1",
      status: "requested",
      payload: { ignored: true },
    });

    assert.equal(replay.fiscalId, first.fiscalId);
    assert.equal(repo.listReady({ nowIso }).length, 1);

    const processing = repo.markProcessing(first.fiscalId, { lockedBy: "worker-1" });
    assert.equal(processing.status, "processing");
    assert.equal(processing.lockedBy, "worker-1");

    const failed = repo.markFailed(first.fiscalId, {
      errorCode: "FISCAL_TIMEOUT",
      errorMessage: "timeout",
      nextAttemptAt: "2026-07-07T13:31:00.000Z",
    });
    assert.equal(failed.status, "retrying");
    assert.equal(failed.attemptCount, 1);
    assert.equal(failed.lockedBy, null);
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 13B fiscal_outbox claim FIFO con lease non duplica il lavoro", async (t) => {
  const runDir = await createTempRunDir("step13b-claim");
  const relationalPath = path.join(runDir, "relational.sqlite");
  const clock = createClock();
  const db = await openMigratedDb(relationalPath);
  try {
    const repo = new FiscalOutboxRepository(db, { nowIso: () => clock.nowIso() });
    repo.enqueue({
      fiscalId: "fiscal_out_claim_1",
      aggregateType: "fiscal_receipt",
      aggregateId: "receipt_claim_1",
      status: "requested",
      payload: { receiptId: "receipt_claim_1" },
    });
    clock.advance(1000);
    repo.enqueue({
      fiscalId: "fiscal_out_claim_2",
      aggregateType: "fiscal_receipt",
      aggregateId: "receipt_claim_2",
      status: "requested",
      payload: { receiptId: "receipt_claim_2" },
    });

    const first = repo.claimNext({ workerId: "worker-a", leaseMs: 30_000 });
    const second = repo.claimNext({ workerId: "worker-b", leaseMs: 30_000 });

    assert.equal(first.fiscalId, "fiscal_out_claim_1");
    assert.equal(first.status, "processing");
    assert.equal(first.lockedBy, "worker-a");
    assert.ok(first.lockExpiresAt);
    assert.equal(second.fiscalId, "fiscal_out_claim_2");
    assert.equal(second.lockedBy, "worker-b");
    assert.equal(repo.claimNext({ workerId: "worker-c" }), null);
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 13B fiscal_outbox retry rispetta next_attempt_at e poi riclaima", async (t) => {
  const runDir = await createTempRunDir("step13b-retry");
  const relationalPath = path.join(runDir, "relational.sqlite");
  const clock = createClock();
  const db = await openMigratedDb(relationalPath);
  try {
    const repo = new FiscalOutboxRepository(db, { nowIso: () => clock.nowIso() });
    repo.enqueue({
      fiscalId: "fiscal_out_retry_1",
      aggregateType: "fiscal_receipt",
      aggregateId: "receipt_retry_1",
      status: "requested",
      payload: { receiptId: "receipt_retry_1" },
    });

    const claimed = repo.claimNext({ workerId: "worker-a", leaseMs: 30_000 });
    assert.equal(claimed.status, "processing");
    const retryAt = new Date(Date.parse(clock.nowIso()) + 60_000).toISOString();
    const failed = repo.markFailed("fiscal_out_retry_1", {
      errorCode: "FISCAL_TIMEOUT",
      errorMessage: "timeout",
      nextAttemptAt: retryAt,
    });
    assert.equal(failed.status, "retrying");
    assert.equal(failed.attemptCount, 1);
    assert.equal(failed.lockedBy, null);

    clock.advance(30_000);
    assert.equal(repo.claimNext({ workerId: "worker-b" }), null);
    clock.advance(31_000);
    const reclaimed = repo.claimNext({ workerId: "worker-b" });
    assert.equal(reclaimed.fiscalId, "fiscal_out_retry_1");
    assert.equal(reclaimed.status, "processing");
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 13B fiscal_outbox recupera processing con lease scaduto e startup reclaim", async (t) => {
  const runDir = await createTempRunDir("step13b-reclaim");
  const relationalPath = path.join(runDir, "relational.sqlite");
  const clock = createClock();
  const db = await openMigratedDb(relationalPath);
  try {
    const repo = new FiscalOutboxRepository(db, { nowIso: () => clock.nowIso() });
    repo.enqueue({
      fiscalId: "fiscal_out_reclaim_1",
      aggregateType: "fiscal_receipt",
      aggregateId: "receipt_reclaim_1",
      status: "requested",
      payload: { receiptId: "receipt_reclaim_1" },
    });
    repo.enqueue({
      fiscalId: "fiscal_out_reclaim_2",
      aggregateType: "fiscal_receipt",
      aggregateId: "receipt_reclaim_2",
      status: "requested",
      payload: { receiptId: "receipt_reclaim_2" },
    });

    repo.claimNext({ workerId: "worker-a", leaseMs: 30_000 });
    clock.advance(10_000);
    assert.equal(repo.reclaimExpiredLeases(), 0);
    clock.advance(31_000);
    assert.equal(repo.reclaimExpiredLeases(), 1);
    assert.equal(repo.getById("fiscal_out_reclaim_1").status, "retrying");

    repo.claimNext({ workerId: "worker-b", leaseMs: 300_000 });
    assert.equal(repo.reclaimAllProcessing(), 1);
    assert.equal(repo.getById("fiscal_out_reclaim_1").status, "retrying");
    const summary = repo.countSummary();
    assert.equal(summary.pending, 2);
    assert.equal(summary.processing, 0);
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 13A payments/ticket fiscale accoda fiscal_outbox nella stessa transazione relazionale", async (t) => {
  const { baseUrl, relationalPath } = await startFiscalOutboxBackend(t, "step13a-ticket");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-device",
    clientApp: "mobile-frontend",
  });

  const paid = await apiPost(
    baseUrl,
    "/api/payments/ticket",
    fiscalTicketPayload(cashier, "pay-table-device", "step13a-ticket-once"),
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);
  assert.equal(paid.body.relational.writePrimary, true);
  assert.equal(paid.body.fiscalPending, true);

  const snapshot = await readFiscalOutboxSnapshot(relationalPath, "step13a-ticket-once");
  assert.equal(snapshot.transactions.length, 1);
  assert.equal(snapshot.receipts.length, 1);
  assert.equal(snapshot.fiscalRows.length, 1);
  assert.equal(snapshot.fiscalRows[0].aggregate_type, "fiscal_receipt");
  assert.equal(snapshot.fiscalRows[0].aggregate_id, snapshot.receipts[0].id);
  assert.equal(snapshot.fiscalRows[0].payment_id, snapshot.transactions[0].id);
  assert.match(snapshot.fiscalRows[0].status, /^(requested|processing|issued|retrying)$/);
  const payload = JSON.parse(snapshot.fiscalRows[0].payload_json);
  assert.equal(payload.source, "payments.ticket");
  assert.equal(payload.receiptId, snapshot.receipts[0].id);
});

test("Step 13A doppio tap ticket fiscale non duplica fiscal_outbox", async (t) => {
  const { baseUrl, relationalPath } = await startFiscalOutboxBackend(t, "step13a-concurrent");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-device",
    clientApp: "mobile-frontend",
  });
  const payload = fiscalTicketPayload(
    cashier,
    "pay-table-device",
    "step13a-concurrent-once",
  );

  const results = await fireConcurrent([
    {
      url: `${baseUrl}/api/payments/ticket`,
      options: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    },
    {
      url: `${baseUrl}/api/payments/ticket`,
      options: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    },
  ]);

  const fulfilled = results.filter((entry) => entry.status === "fulfilled");
  assert.equal(fulfilled.length, 2);
  assert.deepEqual(fulfilled.map((entry) => entry.value.response.status).sort(), [200, 200]);

  const snapshot = await readFiscalOutboxSnapshot(relationalPath, "step13a-concurrent-once");
  assert.equal(snapshot.transactions.length, 1);
  assert.equal(snapshot.receipts.length, 1);
  assert.equal(snapshot.fiscalRows.length, 1);
});
