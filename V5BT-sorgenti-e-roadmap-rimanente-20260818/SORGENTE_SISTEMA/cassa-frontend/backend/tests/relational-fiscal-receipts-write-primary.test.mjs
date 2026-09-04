import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  openRelationalConnection,
  PaymentsRelationalRepository,
  runRelationalMigrations,
} from "../db/relational/index.js";
import {
  apiPost,
  authPayload,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";
import { fireConcurrent } from "./helpers/concurrency-harness.mjs";

function nowIso() {
  return "2026-07-02T12:00:00.000Z";
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

async function startFiscalReceiptsWritePrimaryBackend(
  t,
  prefix = "k7-fiscal-receipts",
  extraEnv = {},
) {
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
      IDEMPOTENCY_STORE_ENABLED: "1",
      EVENT_OUTBOX_ENABLED: "1",
      POS_FISCAL_API_JOB_RETRY_DELAY_MS: "60000",
      POS_FISCAL_API_RECOVERY_RETRY_DELAY_MS: "60000",
      POS_FISCAL_API_TIMEOUT_MS: "100",
      ...extraEnv,
    },
  });
  return { ...backend, relationalPath };
}

function fiscalTicketPayload(session, deviceUuid, idempotencyKey, extra = {}) {
  return authPayload(session, deviceUuid, {
    paymentMethodId: "pay_cash",
    cashGiven: 1.3,
    issueFiscal: true,
    fiscalDocType: "RECEIPT",
    idempotencyKey,
    lines: [
      {
        name: "Caffe K7",
        qty: 1,
        unitPrice: 1.3,
        unitPriceApplied: 1.3,
        lineTotal: 1.3,
      },
    ],
    ...extra,
  });
}

async function readFiscalReceiptSnapshot(relationalPath, idempotencyKey) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    const transactions = db
      .prepare("SELECT * FROM payment_transactions WHERE idempotency_key = ? ORDER BY id")
      .all(idempotencyKey);
    const transactionIds = transactions.map((entry) => entry.id);
    const receipts = transactionIds.length
      ? db
          .prepare(
            `SELECT * FROM fiscal_receipts WHERE payment_transaction_id IN (${transactionIds.map(() => "?").join(",")}) ORDER BY id`,
          )
          .all(...transactionIds)
      : [];
    return { transactions, receipts };
  } finally {
    db.close();
  }
}

test("K7 repository fiscal_receipts usa attempt_scope come idempotenza fiscale", async (t) => {
  const runDir = await createTempRunDir("k7-repo-attempt-scope");
  const relationalPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(relationalPath);
  try {
    const repo = new PaymentsRelationalRepository(db);
    const txResult = repo.createPaymentTransaction({
      id: "tx_k7_attempt",
      idempotencyKey: "tx-k7-attempt",
      amountCents: 130,
      status: "settled",
      createdAt: nowIso(),
      rawJson: { id: "tx_k7_attempt" },
    });
    assert.equal(txResult.ok, true);

    const first = repo.createFiscalReceipt({
      id: "fiscal_k7_first",
      paymentTransactionId: "tx_k7_attempt",
      attemptScope: "issue",
      fiscalProvider: "pos-fiscal-api",
      fiscalStatus: "PENDING",
      issuedAt: nowIso(),
      payloadJson: { request: "first" },
      rawJson: { id: "fiscal_k7_first" },
    });
    const replay = repo.createFiscalReceipt({
      id: "fiscal_k7_duplicate",
      paymentTransactionId: "tx_k7_attempt",
      attemptScope: "issue",
      fiscalProvider: "pos-fiscal-api",
      fiscalStatus: "PENDING",
      issuedAt: nowIso(),
      payloadJson: { request: "duplicate" },
      rawJson: { id: "fiscal_k7_duplicate" },
    });

    assert.equal(replay.id, first.id);
    const rows = db
      .prepare("SELECT * FROM fiscal_receipts WHERE payment_transaction_id = ?")
      .all("tx_k7_attempt");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attempt_scope, "issue");
  } finally {
    closeRelationalConnection(db);
  }
});

test("K7 payments/ticket fiscale registra una sola ricevuta relazionale issue", async (t) => {
  const { baseUrl, relationalPath } =
    await startFiscalReceiptsWritePrimaryBackend(t, "k7-ticket-fiscal");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-device",
    clientApp: "mobile-frontend",
  });

  const paid = await apiPost(
    baseUrl,
    "/api/payments/ticket",
    fiscalTicketPayload(cashier, "pay-table-device", "k7-ticket-fiscal-once"),
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);
  assert.equal(paid.body.fiscalPending, true);
  assert.equal(paid.body.relational.writePrimary, true);

  const snapshot = await readFiscalReceiptSnapshot(
    relationalPath,
    "k7-ticket-fiscal-once",
  );
  assert.equal(snapshot.transactions.length, 1);
  assert.equal(snapshot.receipts.length, 1);
  assert.equal(snapshot.receipts[0].payment_transaction_id, snapshot.transactions[0].id);
  assert.equal(snapshot.receipts[0].attempt_scope, "issue");
  assert.equal(snapshot.receipts[0].fiscal_provider, "pos-fiscal-api");
});

test("K7 payments/ticket fiscale concorrente non duplica fiscal_receipts", async (t) => {
  const { baseUrl, dbPath, relationalPath } =
    await startFiscalReceiptsWritePrimaryBackend(t, "k7-ticket-concurrent");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-device",
    clientApp: "mobile-frontend",
  });
  const payload = fiscalTicketPayload(
    cashier,
    "pay-table-device",
    "k7-ticket-concurrent-once",
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
  const bodies = await Promise.all(fulfilled.map((entry) => entry.value.response.json()));
  assert.equal(new Set(bodies.map((body) => body.payment.id)).size, 1);
  assert.equal(bodies.some((body) => body.idempotent === true), true);

  const persisted = await readJson(dbPath);
  assert.equal(
    persisted.paymentContainers.filter(
      (entry) => entry.idempotencyKey === "k7-ticket-concurrent-once",
    ).length,
    1,
  );

  const snapshot = await readFiscalReceiptSnapshot(
    relationalPath,
    "k7-ticket-concurrent-once",
  );
  assert.equal(snapshot.transactions.length, 1);
  assert.equal(snapshot.receipts.length, 1);
  assert.equal(snapshot.receipts[0].attempt_scope, "issue");
});

test("K7 blocca emissione fiscale se il pagamento non e write-primary", async (t) => {
  const runDir = await createTempRunDir("k7-ticket-requires-payment-wp");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY: "1",
    },
  });
  const cashier = await loginJson(backend.baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-device",
    clientApp: "mobile-frontend",
  });

  const paid = await apiPost(
    backend.baseUrl,
    "/api/payments/ticket",
    fiscalTicketPayload(cashier, "pay-table-device", "k7-ticket-no-payment-wp"),
  );

  assert.equal(paid.response.status, 503);
  assert.equal(paid.body.code, "RELATIONAL_FISCAL_PAYMENT_WRITE_PRIMARY_REQUIRED");
  const persisted = await readJson(backend.dbPath);
  assert.equal(persisted.paymentContainers.length, 0);
  assert.equal(persisted.fiscalReceipts.length, 0);
});
