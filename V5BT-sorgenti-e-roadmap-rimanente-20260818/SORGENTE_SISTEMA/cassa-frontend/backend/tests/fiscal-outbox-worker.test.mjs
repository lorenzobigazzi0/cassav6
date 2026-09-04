import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  FiscalOutboxRepository,
  openRelationalConnection,
  PaymentsRelationalRepository,
  runRelationalMigrations,
} from "../db/relational/index.js";
import {
  buildPosFiscalJobFromFiscalOutboxEntry,
  mapPosFiscalReceiptToOutboxWorkerResult,
  recoverPendingPosFiscalReceiptFromJob,
} from "../modules/fiscal-pos/fiscal-outbox-pos-job.js";
import { createFiscalOutboxPosWorkerRuntime } from "../modules/fiscal-pos/fiscal-outbox-pos-worker-runtime.js";
import { createFiscalOutboxWorker } from "../modules/fiscal-pos/fiscal-outbox-worker.js";
import { createTempRunDir } from "./helpers/test-server.mjs";

function createClock(startIso = "2026-07-07T14:45:00.000Z") {
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

async function openMigratedDb(dbPath, nowIso) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath,
  });
  await runRelationalMigrations(db, { nowIso });
  return db;
}

function enqueueFiscalOutbox(repo, fiscalId, row = {}) {
  return repo.enqueue({
    fiscalId,
    aggregateType: "fiscal_receipt",
    aggregateId: `receipt_${fiscalId}`,
    paymentId: `payment_${fiscalId}`,
    status: "requested",
    payload: {
      receiptId: `receipt_${fiscalId}`,
      source: "step13c.test",
    },
    ...row,
  });
}

test("Step 13C fiscal outbox worker marca issued e pulisce il lock", async () => {
  const runDir = await createTempRunDir("step13c-worker-issued");
  const clock = createClock();
  const relationalPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(relationalPath, () => clock.nowIso());
  try {
    const repo = new FiscalOutboxRepository(db, { nowIso: () => clock.nowIso() });
    enqueueFiscalOutbox(repo, "fiscal_out_worker_issued");
    const processed = [];
    const worker = createFiscalOutboxWorker({
      repository: repo,
      workerId: "worker-issued",
      nowIso: () => clock.nowIso(),
      processClaim: async (entry) => {
        processed.push(entry);
        return {
          status: "issued",
          payload: {
            ...entry.payload,
            providerReceiptId: "RT-STEP13C-1",
          },
        };
      },
    });

    const result = await worker.runOnce();
    const row = repo.getById("fiscal_out_worker_issued");

    assert.equal(result.claimed, true);
    assert.equal(result.status, "issued");
    assert.equal(processed.length, 1);
    assert.equal(processed[0].status, "processing");
    assert.equal(processed[0].lockedBy, "worker-issued");
    assert.equal(row.status, "issued");
    assert.equal(row.lockedBy, null);
    assert.equal(row.lockExpiresAt, null);
    assert.equal(row.issuedAt, clock.nowIso());
    assert.equal(row.payload.providerReceiptId, "RT-STEP13C-1");
    assert.deepEqual(await worker.runOnce(), { claimed: false, status: "idle" });
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 13C fiscal outbox worker applica retry e rispetta next_attempt_at", async () => {
  const runDir = await createTempRunDir("step13c-worker-retry");
  const clock = createClock();
  const relationalPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(relationalPath, () => clock.nowIso());
  try {
    const repo = new FiscalOutboxRepository(db, { nowIso: () => clock.nowIso() });
    enqueueFiscalOutbox(repo, "fiscal_out_worker_retry");
    let attempts = 0;
    const worker = createFiscalOutboxWorker({
      repository: repo,
      workerId: "worker-retry",
      nowIso: () => clock.nowIso(),
      retryDelayMs: 30_000,
      processClaim: async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            status: "retrying",
            errorCode: "FISCAL_TIMEOUT",
            errorMessage: "timeout",
          };
        }
        return { status: "issued" };
      },
    });

    const first = await worker.runOnce();
    const retryRow = repo.getById("fiscal_out_worker_retry");

    assert.equal(first.status, "retrying");
    assert.equal(retryRow.status, "retrying");
    assert.equal(retryRow.attemptCount, 1);
    assert.equal(retryRow.nextAttemptAt, "2026-07-07T14:45:30.000Z");
    assert.equal(retryRow.lockedBy, null);
    assert.deepEqual(await worker.runOnce(), { claimed: false, status: "idle" });

    clock.advance(31_000);
    const second = await worker.runOnce();
    assert.equal(second.status, "issued");
    assert.equal(repo.getById("fiscal_out_worker_retry").status, "issued");
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 13C fiscal outbox worker manda in manual_required al limite tentativi", async () => {
  const runDir = await createTempRunDir("step13c-worker-manual");
  const clock = createClock();
  const relationalPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(relationalPath, () => clock.nowIso());
  try {
    const repo = new FiscalOutboxRepository(db, { nowIso: () => clock.nowIso() });
    enqueueFiscalOutbox(repo, "fiscal_out_worker_manual", {
      attemptCount: 1,
    });
    const worker = createFiscalOutboxWorker({
      repository: repo,
      workerId: "worker-manual",
      nowIso: () => clock.nowIso(),
      maxAttempts: 2,
      processClaim: async () => {
        const error = new Error("provider non raggiungibile");
        error.code = "FISCAL_PROVIDER_DOWN";
        throw error;
      },
    });

    const result = await worker.runOnce();
    const row = repo.getById("fiscal_out_worker_manual");

    assert.equal(result.status, "manual_required");
    assert.equal(row.status, "manual_required");
    assert.equal(row.attemptCount, 2);
    assert.equal(row.nextAttemptAt, null);
    assert.equal(row.lockedBy, null);
    assert.equal(row.lastErrorCode, "FISCAL_PROVIDER_DOWN");
    assert.equal(row.lastErrorMessage, "provider non raggiungibile");
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 13D fiscal outbox costruisce job POS da ricevuta relazionale", () => {
  const entry = {
    fiscalId: "fiscal_out_receipt_1",
    aggregateId: "fiscal_receipt_1",
    paymentId: "tx_step13d_1",
    payload: {
      source: "payments.ticket",
      receiptId: "fiscal_receipt_1",
      paymentTransactionId: "tx_step13d_1",
      paymentContainerId: "pay_step13d_1",
      idempotencyKey: "idem-step13d",
      fiscalProvider: "pos-fiscal-api",
      receipt: {
        id: "fiscal_receipt_1",
        paymentTransactionId: "tx_step13d_1",
        fiscalProvider: "pos-fiscal-api",
        rawJson: {
          id: "fiscal_receipt_1",
          paymentId: "tx_step13d_1",
          command: "pos_receipt",
          fiscalProvider: "pos-fiscal-api",
          fiscalDeviceId: "rt_1",
          fiscalApiBaseUrl: "http://127.0.0.1:8765/",
          fiscalStatusEndpoint: "/api/fiscal/status",
          fiscalReceiptEndpoint: "/api/fiscal/receipt",
          fiscalReprintEndpoint: "/api/fiscal/reprint",
          fiscalRequestId: "fiscal-request-1",
          payloadSnapshot: {
            orderId: "order_1",
            items: [{ name: "Caffe", quantity: 1, price: 1.3 }],
          },
        },
      },
    },
  };

  const result = buildPosFiscalJobFromFiscalOutboxEntry(entry);

  assert.equal(result.ok, true);
  assert.equal(result.receiptId, "fiscal_receipt_1");
  assert.equal(result.job.paymentId, "tx_step13d_1");
  assert.equal(result.job.paymentContainerId, "pay_step13d_1");
  assert.equal(result.job.orderId, "order_1");
  assert.equal(result.job.fiscalDevice.id, "rt_1");
  assert.equal(result.job.fiscalDevice.apiBaseUrl, "http://127.0.0.1:8765");
  assert.equal(result.job.idempotencyKey, "fiscal-request-1");
  assert.equal(result.job.payload.items.length, 1);
  assert.equal(result.job.receiptSnapshot.id, "fiscal_receipt_1");
});

test("Step 13D recupera la ricevuta pendente dal payload outbox durabile", () => {
  const db = { fiscalReceipts: [] };
  const job = {
    paymentId: "tx_recover_pending",
    receiptSnapshot: {
      id: "fiscal_recover_pending",
      paymentId: "tx_recover_pending",
      fiscalStatus: "PENDING",
    },
  };
  const findReceipt = (state, paymentId) =>
    state.fiscalReceipts.find((entry) => entry.paymentId === paymentId) ?? null;
  const sanitizeReceipt = (receipt) => ({ ...receipt });

  const recovered = recoverPendingPosFiscalReceiptFromJob(db, job, {
    findReceipt,
    sanitizeReceipt,
  });
  const replayed = recoverPendingPosFiscalReceiptFromJob(db, job, {
    findReceipt,
    sanitizeReceipt,
  });

  assert.equal(recovered.id, "fiscal_recover_pending");
  assert.equal(replayed, recovered);
  assert.equal(db.fiscalReceipts.length, 1);
});

test("Step 13D fiscal outbox rifiuta provider non POS invece di emettere", () => {
  const result = buildPosFiscalJobFromFiscalOutboxEntry({
    fiscalId: "fiscal_out_unsupported",
    paymentId: "tx_unsupported",
    payload: {
      fiscalProvider: "legacy-middleware",
      receipt: {
        rawJson: {
          command: "print_receipt",
          payloadSnapshot: {
            items: [{ name: "Caffe", quantity: 1, price: 1.3 }],
          },
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported_provider");
  assert.equal(result.errorCode, "FISCAL_OUTBOX_UNSUPPORTED_PROVIDER");
});

test("Step 13D fiscal_receipts relazionale aggiorna esito POS senza duplicare", async () => {
  const runDir = await createTempRunDir("step13d-fiscal-receipt-update");
  const clock = createClock();
  const relationalPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(relationalPath, () => clock.nowIso());
  try {
    const repo = new PaymentsRelationalRepository(db);
    repo.createPaymentTransaction({
      id: "tx_step13d_update",
      amountCents: 130,
      status: "settled",
      createdAt: clock.nowIso(),
      rawJson: { id: "tx_step13d_update" },
    });
    repo.createFiscalReceipt({
      id: "fiscal_step13d_update",
      paymentTransactionId: "tx_step13d_update",
      attemptScope: "issue",
      fiscalProvider: "pos-fiscal-api",
      fiscalStatus: "PENDING",
      issuedAt: clock.nowIso(),
      payloadJson: { request: "queued" },
      rawJson: { id: "fiscal_step13d_update", fiscalStatus: "PENDING" },
    });

    const updated = repo.updateFiscalReceipt("fiscal_step13d_update", {
      fiscalStatus: "ISSUED",
      fiscalDocumentNumber: "RT-10",
      issuedAt: "2026-07-07T14:46:00.000Z",
      payloadJson: { response: "ok" },
      rawJson: { id: "fiscal_step13d_update", fiscalStatus: "ISSUED" },
    });
    const rows = db
      .prepare("SELECT * FROM fiscal_receipts WHERE payment_transaction_id = ?")
      .all("tx_step13d_update");

    assert.equal(rows.length, 1);
    assert.equal(updated.id, "fiscal_step13d_update");
    assert.equal(updated.fiscalStatus, "ISSUED");
    assert.equal(updated.fiscalDocumentNumber, "RT-10");
    assert.equal(updated.issuedAt, "2026-07-07T14:46:00.000Z");
    assert.equal(updated.payload.response, "ok");
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 13D mappa retry provider POS in retry outbox", () => {
  const result = mapPosFiscalReceiptToOutboxWorkerResult({
    entry: {
      payload: { receiptId: "fiscal_retry" },
    },
    job: { paymentId: "tx_retry" },
    issueResult: { retry: true, delayMs: 45_000 },
  });

  assert.equal(result.status, "retrying");
  assert.equal(result.errorCode, "POS_FISCAL_RETRY");
  assert.equal(result.retryDelayMs, 45_000);
  assert.equal(result.payload.worker.paymentId, "tx_retry");
});

test("Step 13D fiscal outbox preferisce la ricevuta emessa al mirror app-state stale", async () => {
  const runDir = await createTempRunDir("step13d-fiscal-issued-read-after-write");
  const clock = createClock();
  const relationalPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(relationalPath, () => clock.nowIso());
  try {
    const payments = new PaymentsRelationalRepository(db);
    payments.createPaymentTransaction({
      id: "tx_step13d_race",
      amountCents: 130,
      status: "settled",
      createdAt: clock.nowIso(),
      rawJson: { id: "tx_step13d_race" },
    });
    payments.createFiscalReceipt({
      id: "fiscal_step13d_race",
      paymentTransactionId: "tx_step13d_race",
      attemptScope: "issue",
      fiscalProvider: "pos-fiscal-api",
      fiscalStatus: "PENDING",
      issuedAt: clock.nowIso(),
      payloadJson: {},
      rawJson: { fiscalStatus: "PENDING" },
    });

    const staleReceipt = {
      id: "fiscal_step13d_race",
      paymentId: "tx_step13d_race",
      fiscalStatus: "PENDING",
    };
    const issuedReceipt = {
      ...staleReceipt,
      fiscalStatus: "ISSUED",
      status: "ISSUED",
      fiscalDocumentNumber: "MOCK-0001",
      fiscalProviderRef: "MOCK-0001",
      issuedAt: clock.nowIso(),
    };
    const runtime = createFiscalOutboxPosWorkerRuntime({
      enabled: true,
      relationalRuntime: { db, initialize: async () => undefined },
      FiscalOutboxRepository,
      PaymentsRelationalRepository,
      nowIso: () => clock.nowIso(),
      readDb: async () => ({ fiscalReceipts: [staleReceipt] }),
      ensureFiscalTrackingArrays: () => undefined,
      findPosFiscalReceiptByPaymentId: () => staleReceipt,
      issueQueuedPosFiscalReceipt: async () => ({
        issued: true,
        receipt: issuedReceipt,
      }),
    });

    const result = await runtime.processClaim({
      aggregateId: "fiscal_step13d_race",
      paymentId: "tx_step13d_race",
      payload: {
        receiptId: "fiscal_step13d_race",
        paymentTransactionId: "tx_step13d_race",
        fiscalProvider: "pos-fiscal-api",
        receipt: {
          id: "fiscal_step13d_race",
          paymentId: "tx_step13d_race",
          command: "pos_receipt",
          fiscalProvider: "pos-fiscal-api",
          fiscalDeviceId: "rt_mock",
          fiscalApiBaseUrl: "http://127.0.0.1:9290",
          payloadSnapshot: {
            orderId: "order_race",
            items: [{ name: "Caffe", quantity: 1, price: 1.3 }],
          },
        },
      },
    });

    assert.equal(result.status, "issued");
    const persisted = payments.getFiscalReceiptById("fiscal_step13d_race");
    assert.equal(persisted.fiscalStatus, "ISSUED");
    assert.equal(persisted.fiscalDocumentNumber, "MOCK-0001");
  } finally {
    closeRelationalConnection(db);
  }
});
