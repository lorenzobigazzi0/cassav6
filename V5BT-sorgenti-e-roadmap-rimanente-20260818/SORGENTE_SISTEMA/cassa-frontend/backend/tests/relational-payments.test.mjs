import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAppStateRepository } from "../db/app-state/index.js";
import {
  assertRelationalEquivalence,
  createRelationalRuntime,
  normalizeRelationalEquivalenceDomains,
  openRelationalConnection,
  PaymentsRelationalRepository,
  runRelationalMigrations,
  syncPaymentsFromAppState,
  syncRelationalShadowAfterAppStateWrite,
} from "../db/relational/index.js";
import { closeRelationalConnection } from "../db/relational/connection.js";
import {
  buildTestState,
  createTempRunDir,
  readJson,
} from "./helpers/test-server.mjs";

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function isValidState(data) {
  return (
    data &&
    typeof data === "object" &&
    Array.isArray(data.users) &&
    Array.isArray(data.sessions) &&
    data.meta &&
    typeof data.meta === "object"
  );
}

function nowIso() {
  return "2026-05-13T10:00:00.000Z";
}

function relationalConfig(dbPath) {
  return {
    enabled: true,
    mode: "shadow",
    dbPath,
  };
}

async function openMigratedDb(dbPath) {
  const db = await openRelationalConnection(relationalConfig(dbPath));
  await runRelationalMigrations(db, { nowIso });
  return db;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function indexExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
}

function columnExists(db, tableName, columnName) {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => column.name === columnName);
}

function createRepositoryOptions({ dbPath, afterWrite, logger }) {
  return {
    mode: "json",
    dbPath,
    dbTmpPath: `${dbPath}.tmp`,
    defaultJsonDbPath: dbPath,
    legacyJsonDbPath: "",
    sqliteImportJsonPath: "",
    buildInitialState: buildTestState,
    isValidState,
    migrateState: () => false,
    cloneJson,
    nowIso: () => new Date().toISOString(),
    safePathExists: existsSync,
    canInitializeMissingDb: () => true,
    canInitializeExistingEmptyDb: () => true,
    buildEmptyDbInitDeniedMessage: (kind, targetPath) => `${kind} init denied: ${targetPath}`,
    logger: logger ?? { warn() {} },
    afterWrite,
  };
}

function buildPaymentsState() {
  const state = buildTestState();
  state.meta.lastWriteAt = "2026-05-13T14:10:00.000Z";
  state.paymentContainers = [
    {
      id: "pay_container_1",
      tableId: "room_pedana_t05",
      tableNumber: 5,
      tableLabel: "Tavolo 5",
      orderId: "order_1",
      orderIds: ["order_1"],
      billId: "bill_1",
      billIds: ["bill_1"],
      roomId: "room_pedana",
      paymentMethod: "pay_cash",
      amount: 12.34,
      status: "COMPLETED",
      splitType: "SINGLE",
      idempotencyKey: "idem-container-1",
      clientPaymentId: "client-pay-1",
      fiscalDocNo: "fiscal_1",
      fiscalIssuedAt: "2026-05-13T14:04:00.000Z",
      createdAt: "2026-05-13T14:00:00.000Z",
      updatedAt: "2026-05-13T14:04:00.000Z",
      extraContainerField: "preserved",
    },
  ];
  state.paymentParts = [
    {
      id: "part_1",
      paymentId: "pay_container_1",
      partNo: 1,
      amountDue: 12.34,
      status: "PAID",
      extraPartField: "preserved",
    },
  ];
  state.paymentTransactions = [
    {
      id: "tx_1",
      partId: "part_1",
      createdAt: "2026-05-13T14:01:00.000Z",
      method: "CASH",
      amountPaid: 12.34,
      cashGiven: 20,
      changeGiven: 7.66,
      extraTransactionField: "preserved",
    },
  ];
  state.paymentProviderTransactions = [
    {
      transactionId: "ptx_1",
      clientPaymentId: "client-pay-1",
      idempotencyKey: "idem-provider-1",
      status: "settled",
      amount: 12.34,
      currency: "EUR",
      paymentMethodId: "pay_cash",
      providerType: "cash",
      providerPayload: { drawer: "A" },
      settlementResponse: {
        paymentId: "pay_container_1",
        receiptId: "fiscal_1",
      },
      phase: "settled",
      createdAt: "2026-05-13T14:00:30.000Z",
      updatedAt: "2026-05-13T14:04:30.000Z",
      completedAt: "2026-05-13T14:04:30.000Z",
      extraProviderField: "preserved",
    },
  ];
  state.payments = [
    {
      id: "pay_container_1",
      tableId: "room_pedana_t05",
      tableNumber: 5,
      tableLabel: "Tavolo 5",
      roomId: "room_pedana",
      orderId: "order_1",
      orderIds: ["order_1"],
      billId: "bill_1",
      billIds: ["bill_1"],
      amount: 12.34,
      methodId: "pay_cash",
      methodLabel: "Contanti",
      fiscal: true,
      source: "table_payment",
      createdAt: "2026-05-13T14:02:00.000Z",
      idempotencyKey: "idem-payment-1",
      clientPaymentId: "client-pay-1",
      receiptId: "fiscal_1",
      paymentContainerId: "pay_container_1",
      paymentPartId: "part_1",
      paymentTxId: "tx_1",
    },
  ];
  state.fiscalReceipts = [
    {
      id: "fiscal_1",
      paymentId: "pay_container_1",
      command: "print_receipt",
      status: "ok",
      responseCode: "RT_OK",
      responseMessage: "Operazione completata.",
      fiscalStatus: "ISSUED",
      fiscalProvider: "mock",
      fiscalProviderRef: "RT-2026-0001",
      createdAt: "2026-05-13T14:03:00.000Z",
      extraReceiptField: "preserved",
    },
  ];
  return state;
}

function buildMultiBillMultiMethodPaymentsState() {
  const state = buildTestState();
  state.meta.lastWriteAt = "2026-05-13T15:30:00.000Z";
  state.paymentContainers = [
    {
      id: "pay_container_multi",
      tableId: "room_pedana_t05",
      tableNumber: 5,
      tableLabel: "Tavolo 5",
      orderIds: ["order_1", "order_2"],
      billIds: ["bill_1", "bill_2"],
      roomId: "room_pedana",
      status: "PARTIAL",
      totalCents: 4500,
      paidCents: 3000,
      dueCents: 1500,
      splitType: "MULTI_METHOD",
      idempotencyKey: "idem-container-multi",
      clientPaymentId: "client-pay-multi",
      createdAt: "2026-05-13T15:00:00.000Z",
      updatedAt: "2026-05-13T15:05:00.000Z",
      k0Scenario: "multi-bill-multi-method-partial",
    },
  ];
  state.paymentParts = [
    {
      id: "part_cash",
      paymentId: "pay_container_multi",
      partNo: 1,
      methodId: "pay_cash",
      methodType: "CASH",
      amountCents: 1000,
      fiscalStatus: "ISSUED",
      status: "PAID",
      createdAt: "2026-05-13T15:01:00.000Z",
    },
    {
      id: "part_card",
      paymentId: "pay_container_multi",
      partNo: 2,
      methodId: "pay_card",
      methodType: "CARD",
      amountCents: 2000,
      fiscalStatus: "ISSUED",
      status: "PAID",
      createdAt: "2026-05-13T15:02:00.000Z",
    },
  ];
  state.paymentTransactions = [
    {
      id: "tx_cash",
      paymentContainerId: "pay_container_multi",
      partId: "part_cash",
      idempotencyKey: "idem-tx-cash",
      tableId: "room_pedana_t05",
      billId: "bill_1",
      orderId: "order_1",
      createdAt: "2026-05-13T15:01:10.000Z",
      updatedAt: "2026-05-13T15:01:20.000Z",
      method: "CASH",
      amountCents: 1000,
      status: "settled",
    },
    {
      id: "tx_card",
      paymentContainerId: "pay_container_multi",
      partId: "part_card",
      idempotencyKey: "idem-tx-card",
      tableId: "room_pedana_t05",
      billId: "bill_2",
      orderId: "order_2",
      createdAt: "2026-05-13T15:02:10.000Z",
      updatedAt: "2026-05-13T15:02:20.000Z",
      method: "CARD",
      amountCents: 2000,
      status: "settled",
    },
  ];
  state.paymentProviderTransactions = [];
  state.payments = [];
  state.fiscalReceipts = [
    {
      id: "fiscal_cash",
      paymentId: "pay_container_multi",
      paymentTransactionId: "tx_cash",
      command: "print_receipt",
      status: "ok",
      responseCode: "RT_OK",
      responseMessage: "Contante fiscalizzato.",
      fiscalStatus: "ISSUED",
      fiscalProvider: "mock",
      fiscalProviderRef: "RT-K0-CASH",
      createdAt: "2026-05-13T15:01:30.000Z",
    },
    {
      id: "fiscal_card",
      paymentId: "pay_container_multi",
      paymentTransactionId: "tx_card",
      command: "print_receipt",
      status: "ok",
      responseCode: "RT_OK",
      responseMessage: "Carta fiscalizzata.",
      fiscalStatus: "ISSUED",
      fiscalProvider: "mock",
      fiscalProviderRef: "RT-K0-CARD",
      createdAt: "2026-05-13T15:02:30.000Z",
    },
  ];
  return state;
}

test("migrazione 006_payments crea tutte le tabelle payments", async () => {
  const runDir = await createTempRunDir("rel-migrations-payments");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    assert.equal(tableExists(db, "payment_containers"), true);
    assert.equal(tableExists(db, "payment_parts"), true);
    assert.equal(tableExists(db, "payment_transactions"), true);
    assert.equal(tableExists(db, "fiscal_receipts"), true);
    assert.equal(columnExists(db, "payment_containers", "revision"), true);
    assert.equal(columnExists(db, "payment_transactions", "revision"), true);
    assert.equal(indexExists(db, "idx_payment_containers_table_id"), true);
    assert.equal(indexExists(db, "idx_payment_containers_bill_id"), true);
    assert.equal(indexExists(db, "idx_payment_containers_status"), true);
    assert.equal(indexExists(db, "idx_payment_parts_container_id"), true);
    assert.equal(indexExists(db, "idx_payment_transactions_idempotency_key"), true);
    assert.equal(indexExists(db, "idx_payment_transactions_container_id"), true);
    assert.equal(indexExists(db, "idx_payment_transactions_status"), true);
    assert.equal(indexExists(db, "idx_fiscal_receipts_transaction"), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync payments importa payment containers", async () => {
  const runDir = await createTempRunDir("rel-payments-containers");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncPaymentsFromAppState(db, buildPaymentsState(), { nowIso });
    const containers = new PaymentsRelationalRepository(db).listContainers();
    assert.equal(containers.length, 1);
    assert.equal(containers[0].id, "pay_container_1");
    assert.equal(containers[0].tableId, "room_pedana_t05");
    assert.equal(containers[0].billId, "bill_1");
    assert.equal(containers[0].orderId, "order_1");
    assert.equal(containers[0].status, "completed");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync payments importa payment parts", async () => {
  const runDir = await createTempRunDir("rel-payments-parts");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncPaymentsFromAppState(db, buildPaymentsState(), { nowIso });
    const row = db.prepare("SELECT * FROM payment_parts WHERE id = 'part_1'").get();
    assert.equal(row.container_id, "pay_container_1");
    assert.equal(row.method_id, "pay_cash");
    assert.equal(row.method_type, "CASH");
    assert.equal(row.amount_cents, 1234);
    assert.equal(row.fiscal_status, "ISSUED");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync payments importa payment transactions", async () => {
  const runDir = await createTempRunDir("rel-payments-transactions");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncPaymentsFromAppState(db, buildPaymentsState(), { nowIso });
    const transactions = new PaymentsRelationalRepository(db).listTransactions();
    assert.deepEqual(transactions.map((entry) => entry.id), ["ptx_1", "tx_1"]);
    assert.equal(transactions.find((entry) => entry.id === "tx_1").containerId, "pay_container_1");
    assert.equal(transactions.find((entry) => entry.id === "ptx_1").status, "settled");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync payments preserva idempotencyKey", async () => {
  const runDir = await createTempRunDir("rel-payments-idempotency");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncPaymentsFromAppState(db, buildPaymentsState(), { nowIso });
    const transaction = new PaymentsRelationalRepository(db).getTransactionByIdempotencyKey("idem-provider-1");
    assert.equal(transaction.id, "ptx_1");
    assert.equal(transaction.idempotencyKey, "idem-provider-1");
  } finally {
    closeRelationalConnection(db);
  }
});

test("unique index su idempotencyKey impedisce duplicati non null", async () => {
  const runDir = await createTempRunDir("rel-payments-idempotency-unique");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const insert = db.prepare(
      `
        INSERT INTO payment_transactions (
          id,
          idempotency_key,
          amount_cents,
          status
        ) VALUES (?, ?, ?, ?)
      `
    );
    insert.run("tx_a", "idem-dup", 100, "settled");
    assert.throws(() => insert.run("tx_b", "idem-dup", 200, "settled"), /UNIQUE|constraint/i);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync payments preserva fiscal receipts e status", async () => {
  const runDir = await createTempRunDir("rel-payments-fiscal");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncPaymentsFromAppState(db, buildPaymentsState(), { nowIso });
    const row = db.prepare("SELECT * FROM fiscal_receipts WHERE id = 'fiscal_1'").get();
    assert.equal(row.payment_transaction_id, "tx_1");
    assert.equal(row.fiscal_provider, "mock");
    assert.equal(row.fiscal_status, "ISSUED");
    assert.equal(row.fiscal_document_number, "RT-2026-0001");
    assert.equal(row.issued_at, "2026-05-13T14:03:00.000Z");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync payments converte importi in cents coerenti", async () => {
  const runDir = await createTempRunDir("rel-payments-cents");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncPaymentsFromAppState(db, buildPaymentsState(), { nowIso });
    const container = db.prepare("SELECT total_cents, paid_cents, due_cents FROM payment_containers WHERE id = 'pay_container_1'").get();
    const part = db.prepare("SELECT amount_cents FROM payment_parts WHERE id = 'part_1'").get();
    const transaction = db.prepare("SELECT amount_cents FROM payment_transactions WHERE id = 'ptx_1'").get();
    assert.equal(container.total_cents, 1234);
    assert.equal(container.paid_cents, 1234);
    assert.equal(container.due_cents, 0);
    assert.equal(part.amount_cents, 1234);
    assert.equal(transaction.amount_cents, 1234);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync payments raw_json preserva campi extra", async () => {
  const runDir = await createTempRunDir("rel-payments-raw");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncPaymentsFromAppState(db, buildPaymentsState(), { nowIso });
    const container = db.prepare("SELECT raw_json FROM payment_containers WHERE id = 'pay_container_1'").get();
    const provider = db.prepare("SELECT raw_json FROM payment_transactions WHERE id = 'ptx_1'").get();
    assert.equal(JSON.parse(container.raw_json).extraContainerField, "preserved");
    assert.equal(JSON.parse(provider.raw_json).extraProviderField, "preserved");
  } finally {
    closeRelationalConnection(db);
  }
});

test("K2 sync payments preserva revision nativa", async () => {
  const runDir = await createTempRunDir("rel-payments-revision");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  const state = buildPaymentsState();
  state.paymentContainers[0].revision = 4;
  state.paymentContainers[0].currentRevision = 4;
  state.paymentTransactions[0].revision = 6;
  state.paymentTransactions[0].currentRevision = 6;
  state.paymentProviderTransactions[0].revision = 3;
  state.paymentProviderTransactions[0].currentRevision = 3;
  try {
    syncPaymentsFromAppState(db, state, { nowIso });
    const repo = new PaymentsRelationalRepository(db);
    const container = repo.getContainerById("pay_container_1");
    const transaction = repo.getTransactionById("tx_1");
    const provider = repo.getTransactionById("ptx_1");
    assert.equal(container.revision, 4);
    assert.equal(container.currentRevision, 4);
    assert.equal(transaction.revision, 6);
    assert.equal(transaction.currentRevision, 6);
    assert.equal(provider.revision, 3);
    assert.equal(provider.currentRevision, 3);
  } finally {
    closeRelationalConnection(db);
  }
});

test("K2 updateContainerWithRevision applica CAS e incrementa revision", async () => {
  const runDir = await createTempRunDir("rel-payments-container-cas");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  const state = buildPaymentsState();
  state.paymentContainers[0].revision = 4;
  try {
    syncPaymentsFromAppState(db, state, { nowIso });
    const repo = new PaymentsRelationalRepository(db);
    const updated = repo.updateContainerWithRevision("pay_container_1", 4, {
      status: "partial",
      paidCents: 1000,
      dueCents: 234,
      updatedAt: "2026-05-13T14:05:00.000Z",
      rawJson: { ...state.paymentContainers[0], status: "PARTIAL", revision: 5, currentRevision: 5 },
    });
    const stale = repo.updateContainerWithRevision("pay_container_1", 4, { status: "completed" });
    const current = repo.getContainerById("pay_container_1");

    assert.equal(updated.revision, 5);
    assert.equal(updated.currentRevision, 5);
    assert.equal(updated.status, "partial");
    assert.equal(updated.paidCents, 1000);
    assert.equal(updated.dueCents, 234);
    assert.equal(stale, null);
    assert.equal(current.revision, 5);
    assert.equal(current.status, "partial");
  } finally {
    closeRelationalConnection(db);
  }
});

test("K2 updateTransactionWithRevision applica CAS e incrementa revision", async () => {
  const runDir = await createTempRunDir("rel-payments-transaction-cas");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  const state = buildPaymentsState();
  state.paymentTransactions[0].revision = 6;
  try {
    syncPaymentsFromAppState(db, state, { nowIso });
    const repo = new PaymentsRelationalRepository(db);
    const updated = repo.updateTransactionWithRevision("tx_1", 6, {
      status: "refunded",
      amountCents: 1000,
      updatedAt: "2026-05-13T14:06:00.000Z",
      rawJson: { ...state.paymentTransactions[0], status: "refunded", amountPaid: 10, revision: 7, currentRevision: 7 },
    });
    const stale = repo.updateTransactionWithRevision("tx_1", 6, { status: "settled" });
    const current = repo.getTransactionById("tx_1");

    assert.equal(updated.revision, 7);
    assert.equal(updated.currentRevision, 7);
    assert.equal(updated.status, "refunded");
    assert.equal(updated.amountCents, 1000);
    assert.equal(stale, null);
    assert.equal(current.revision, 7);
    assert.equal(current.status, "refunded");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync payments aggiorna relational_sync_state", async () => {
  const runDir = await createTempRunDir("rel-payments-sync-state");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const result = syncPaymentsFromAppState(db, buildPaymentsState(), { nowIso });
    const row = db.prepare("SELECT * FROM relational_sync_state WHERE domain = 'payments'").get();
    assert.equal(row.source_last_write_at, "2026-05-13T14:10:00.000Z");
    assert.equal(row.row_count, 5);
    assert.equal(row.checksum, result.checksum);
    assert.equal(row.synced_at, "2026-05-13T10:00:00.000Z");
  } finally {
    closeRelationalConnection(db);
  }
});

test("K0 normalizza alias payments e fiscal sul dominio pagamenti", () => {
  assert.deepEqual(normalizeRelationalEquivalenceDomains("payments,fiscal"), ["payments"]);
  assert.deepEqual(normalizeRelationalEquivalenceDomains("fiscal_receipts"), ["payments"]);
});

test("K0 verifica equivalenza payments dopo sync multi-bill multi-metodo parziale", async () => {
  const runDir = await createTempRunDir("rel-payments-k0-equivalence");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  const state = buildMultiBillMultiMethodPaymentsState();
  try {
    syncPaymentsFromAppState(db, state, { nowIso });
    const comparison = assertRelationalEquivalence(state, db, "payments");
    assert.equal(comparison.payments.matches, true);
    assert.equal(comparison.payments.appState.rowCount, 7);
    assert.equal(comparison.payments.relational.rowCount, 7);

    const container = db.prepare("SELECT total_cents, paid_cents, due_cents FROM payment_containers WHERE id = ?").get(
      "pay_container_multi"
    );
    assert.equal(container.total_cents, 4500);
    assert.equal(container.paid_cents, 3000);
    assert.equal(container.due_cents, 1500);
  } finally {
    closeRelationalConnection(db);
  }
});

test("K0 assertRelationalEquivalence blocca fiscal alias non equivalente", async () => {
  const runDir = await createTempRunDir("rel-payments-k0-fiscal-mismatch");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  const state = buildMultiBillMultiMethodPaymentsState();
  try {
    syncPaymentsFromAppState(db, state, { nowIso });
    const before = assertRelationalEquivalence(state, db, "fiscal");
    assert.equal(before.payments.matches, true);

    db.prepare("UPDATE fiscal_receipts SET fiscal_status = ? WHERE id = ?").run("TAMPERED", "fiscal_card");

    assert.throws(
      () => assertRelationalEquivalence(state, db, "fiscal"),
      /Equivalenza relazionale shadow fallita per payments/
    );
  } finally {
    closeRelationalConnection(db);
  }
});

test("K0 runtime shadow verifica equivalenza payments con alias fiscal attivo", async () => {
  const runDir = await createTempRunDir("rel-payments-k0-runtime-equivalence");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "payments,fiscal",
    },
    defaultDbPath: relationalPath,
    logger: { warn() {} },
    nowIso,
  });
  await runtime.initialize();
  const repository = createAppStateRepository(
    createRepositoryOptions({
      dbPath: appStatePath,
      afterWrite: (appState) => runtime.syncAfterAppStateWrite(appState),
    })
  );

  try {
    await repository.writeDb(buildMultiBillMultiMethodPaymentsState());
    const result = await runtime.syncAfterAppStateWrite(await readJson(appStatePath));
    assert.equal(result.equivalence.payments.matches, true);
    assert.equal(result.equivalence.payments.appState.rowCount, 7);
  } finally {
    runtime.close();
  }
});

test("writeDb in shadow mode richiama sync payments dopo scrittura app-state", async () => {
  const runDir = await createTempRunDir("rel-payments-write-hook");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
    defaultDbPath: relationalPath,
    logger: { warn() {} },
    nowIso,
  });
  await runtime.initialize();
  const repository = createAppStateRepository(
    createRepositoryOptions({
      dbPath: appStatePath,
      afterWrite: (appState) => runtime.syncAfterAppStateWrite(appState),
    })
  );

  try {
    await repository.writeDb(buildPaymentsState());
    const rows = runtime.db.prepare("SELECT id FROM payment_transactions ORDER BY id").all();
    assert.deepEqual(rows.map((row) => row.id), ["ptx_1", "tx_1"]);
    const syncState = runtime.db.prepare("SELECT * FROM relational_sync_state WHERE domain = 'payments'").get();
    assert.equal(syncState.row_count, 5);
  } finally {
    runtime.close();
  }
});

test("errore sync payments in shadow non rompe writeDb", async () => {
  const runDir = await createTempRunDir("rel-payments-write-error");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const warnings = [];
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
    defaultDbPath: relationalPath,
    logger: {
      warn(message) {
        warnings.push(String(message));
      },
    },
    nowIso,
  });
  const repository = createAppStateRepository(
    createRepositoryOptions({
      dbPath: appStatePath,
      afterWrite: (appState) => syncRelationalShadowAfterAppStateWrite(appState, runtime),
    })
  );
  const state = buildPaymentsState();
  state.paymentContainers.push({
    ...state.paymentContainers[0],
    amount: 1,
    createdAt: "2026-05-13T14:06:00.000Z",
  });

  try {
    await repository.writeDb(state);
    const persisted = await readJson(appStatePath);
    assert.equal(persisted.paymentContainers.length, 2);
    assert.equal(warnings.some((message) => /Sync relazionale shadow app-state fallita/i.test(message)), true);
  } finally {
    runtime.close();
  }
});
