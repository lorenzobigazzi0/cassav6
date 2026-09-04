import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  openRelationalConnection,
  runRelationalMigrations,
  syncPaymentsFromAppState,
} from "../db/relational/index.js";
import {
  apiPost,
  authPayload,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

function nowIso() {
  return "2026-05-13T18:00:00.000Z";
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

function seedFiscalCommandPayment(state) {
  const createdAt = "2026-05-13T17:58:00.000Z";
  state.paymentContainers = [
    {
      id: "pay_k3_fiscal_command",
      tableId: "room_pedana_t05",
      tableNumber: 5,
      tableLabel: "Tavolo 5",
      orderId: "order_k3_fiscal_command",
      orderIds: ["order_k3_fiscal_command"],
      billId: "bill_k3_fiscal_command",
      billIds: ["bill_k3_fiscal_command"],
      roomId: "room_pedana",
      paymentMethod: "pay_cash",
      amount: 15,
      paidCents: 1500,
      dueCents: 0,
      status: "COMPLETED",
      splitType: "SINGLE",
      createdByUserId: "u_manager",
      createdByUsername: "manager",
      collectedByUserId: "u_manager",
      collectedByUsername: "manager",
      createdAt,
      updatedAt: createdAt,
      revision: 1,
    },
  ];
  state.paymentParts = [
    {
      id: "part_k3_fiscal_command",
      paymentId: "pay_k3_fiscal_command",
      partNo: 1,
      amountDue: 15,
      status: "PAID",
    },
  ];
  state.paymentTransactions = [
    {
      id: "tx_k3_fiscal_command",
      partId: "part_k3_fiscal_command",
      paymentContainerId: "pay_k3_fiscal_command",
      createdByUserId: "u_manager",
      createdByUsername: "manager",
      createdAt,
      updatedAt: createdAt,
      method: "CASH",
      amountPaid: 15,
      status: "settled",
      revision: 1,
    },
  ];
  state.paymentProviderTransactions = [];
  state.payments = [
    {
      id: "pay_k3_fiscal_command",
      paymentContainerId: "pay_k3_fiscal_command",
      paymentPartId: "part_k3_fiscal_command",
      paymentTxId: "tx_k3_fiscal_command",
      tableId: "room_pedana_t05",
      tableNumber: 5,
      tableLabel: "Tavolo 5",
      roomId: "room_pedana",
      orderId: "order_k3_fiscal_command",
      orderIds: ["order_k3_fiscal_command"],
      billId: "bill_k3_fiscal_command",
      billIds: ["bill_k3_fiscal_command"],
      amount: 15,
      methodId: "pay_cash",
      methodLabel: "Contanti",
      source: "table_payment",
      createdAt,
      createdByUserId: "u_manager",
      createdByUsername: "manager",
    },
  ];
  state.fiscalReceipts = [];
  state.fiscalEvents = [];
  state.meta.lastWriteAt = createdAt;
}

test("K3 fiscal command write-primary registra retry tecnico senza cambiare saldi", async (t) => {
  const runDir = await createTempRunDir("k3-fiscal-command");
  const relationalPath = path.join(runDir, "relational.sqlite");
  const server = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY: "1",
    },
    stateOverrides: seedFiscalCommandPayment,
  });

  const appState = await readJson(server.dbPath);
  let db = await openMigratedDb(relationalPath);
  try {
    syncPaymentsFromAppState(db, appState, { nowIso });
  } finally {
    closeRelationalConnection(db);
  }

  db = await openMigratedDb(relationalPath);
  const beforeContainer = db
    .prepare(
      "SELECT total_cents, paid_cents, due_cents, revision FROM payment_containers WHERE id = ?",
    )
    .get("pay_k3_fiscal_command");
  const beforeTransaction = db
    .prepare(
      "SELECT amount_cents, status, revision FROM payment_transactions WHERE id = ?",
    )
    .get("tx_k3_fiscal_command");
  closeRelationalConnection(db);

  const manager = await loginJson(server.baseUrl, "manager", "4444", {
    deviceUuid: "k3-fiscal-manager",
    clientApp: "cassa-frontend",
  });
  const issued = await apiPost(
    server.baseUrl,
    "/api/fiscal/command",
    authPayload(manager, "k3-fiscal-manager", {
      command: "print_receipt",
      paymentTransactionId: "tx_k3_fiscal_command",
    }),
  );

  assert.equal(issued.response.status, 200);
  assert.equal(issued.body.ok, true);
  assert.equal(issued.body.relational.writePrimary, true);

  db = await openMigratedDb(relationalPath);
  try {
    const afterContainer = db
      .prepare(
        "SELECT total_cents, paid_cents, due_cents, revision FROM payment_containers WHERE id = ?",
      )
      .get("pay_k3_fiscal_command");
    const afterTransaction = db
      .prepare(
        "SELECT amount_cents, status, revision, raw_json FROM payment_transactions WHERE id = ?",
      )
      .get("tx_k3_fiscal_command");
    const receipt = db
      .prepare(
        "SELECT * FROM fiscal_receipts WHERE payment_transaction_id = ? ORDER BY issued_at DESC LIMIT 1",
      )
      .get("tx_k3_fiscal_command");
    const outbox = db
      .prepare(
        "SELECT * FROM event_outbox WHERE aggregate_type = 'fiscal_receipt' ORDER BY id DESC LIMIT 1",
      )
      .get();

    assert.deepEqual(afterContainer, beforeContainer);
    assert.equal(afterTransaction.amount_cents, beforeTransaction.amount_cents);
    assert.equal(afterTransaction.status, beforeTransaction.status);
    assert.equal(afterTransaction.revision, beforeTransaction.revision + 1);
    assert.equal(receipt.fiscal_provider, "mock");
    assert.equal(receipt.fiscal_status, "ISSUED");
    assert.equal(receipt.payment_transaction_id, "tx_k3_fiscal_command");
    assert.equal(outbox.event_type, "payment.status");
    assert.equal(outbox.aggregate_id, receipt.id);

    const rawTransaction = JSON.parse(afterTransaction.raw_json);
    assert.equal(rawTransaction.fiscalCommandRetry.command, "print_receipt");
    assert.equal(rawTransaction.fiscalCommandRetry.technicalCommand, true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("K3 fiscal command write-primary senza relazionale restituisce 503 esplicito", async (t) => {
  const server = await startBackend(t, {
    env: {
      BACKEND_RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY: "1",
    },
  });
  const manager = await loginJson(server.baseUrl, "manager", "4444", {
    deviceUuid: "k3-fiscal-manager-no-db",
    clientApp: "cassa-frontend",
  });

  const response = await apiPost(
    server.baseUrl,
    "/api/fiscal/command",
    authPayload(manager, "k3-fiscal-manager-no-db", {
      command: "print_receipt",
    }),
  );

  assert.equal(response.response.status, 503);
  const persisted = await readJson(server.dbPath);
  assert.equal(persisted.fiscalEvents.length, 0);
});
