import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  apiPost,
  acquireTableLock,
  authPayload,
  createSimpleOrder,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";
import { fireConcurrent } from "./helpers/concurrency-harness.mjs";

async function createDeliveredOrder(baseUrl, session, deviceUuid, options = {}) {
  const tableId = options.tableId ?? "room_pedana_t05";
  const lock = await acquireTableLock(baseUrl, session, tableId, {
    deviceUuid,
    purpose: "k5_payment_fixture",
  });
  assert.equal(lock.response.status, 200);
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid,
    tableId,
    roomId: options.roomId ?? "room_pedana",
    tableNumber: options.tableNumber ?? 5,
    lines: options.lines,
  });
  assert.equal(created.response.status, 200);
  const ready = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: created.body.order.id,
      order: {
        ...created.body.order,
        workflowStatus: "ready",
        items: created.body.order.items.map((item) => ({ ...item, done: true })),
      },
      workflowReason: "k5_payment_fixture",
    }),
  );
  assert.equal(ready.response.status, 200);
  const delivered = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: ready.body.order.id,
      order: {
        ...ready.body.order,
        workflowStatus: "delivered",
        items: ready.body.order.items.map((item) => ({ ...item, done: true })),
      },
      workflowReason: "k5_payment_fixture",
    }),
  );
  assert.equal(delivered.response.status, 200);
  return delivered.body.order;
}

async function startTableWritePrimaryBackend(t, prefix = "k5-table", extraEnv = {}) {
  const runDir = await createTempRunDir(prefix);
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY: "1",
      IDEMPOTENCY_STORE_ENABLED: "1",
      EVENT_OUTBOX_ENABLED: "1",
      ...extraEnv,
    },
  });
  return { ...backend, relationalPath };
}

async function readRelationalTablePaymentSnapshot(relationalPath, idempotencyKey) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    const transaction = db
      .prepare("SELECT * FROM payment_transactions WHERE idempotency_key = ?")
      .get(idempotencyKey);
    const container = transaction?.container_id
      ? db.prepare("SELECT * FROM payment_containers WHERE id = ?").get(transaction.container_id)
      : null;
    const table = container?.table_id
      ? db.prepare("SELECT * FROM table_states WHERE table_id = ?").get(container.table_id)
      : null;
    const bills = container?.table_id
      ? db.prepare("SELECT * FROM table_bills WHERE table_id = ? ORDER BY id").all(container.table_id)
      : [];
    const outboxRows = container?.id
      ? db.prepare("SELECT * FROM event_outbox WHERE aggregate_id = ? ORDER BY id ASC").all(container.id)
      : [];
    return { transaction, container, table, bills, outboxRows };
  } finally {
    db.close();
  }
}

function tablePaymentPayload(session, deviceUuid, idempotencyKey, extra = {}) {
  return authPayload(session, deviceUuid, {
    tableId: "room_pedana_t05",
    paymentMethodId: "pay_cash",
    cashGiven: 1.3,
    idempotencyKey,
    ...extra,
  });
}

test("K5 payments/table write-primary crea pagamento e snapshot tavolo relazionale", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startTableWritePrimaryBackend(t, "k5-table-create");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "k5-table-device",
    clientApp: "mobile-frontend",
  });
  await createDeliveredOrder(baseUrl, cashier, "k5-table-device");

  const paid = await apiPost(
    baseUrl,
    "/api/payments/table",
    tablePaymentPayload(cashier, "k5-table-device", "k5-table-create-once"),
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);
  assert.equal(paid.body.relational.writePrimary, true);
  assert.equal(paid.body.table.totalDue, 0);

  const persisted = await readJson(dbPath);
  const table = persisted.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  assert.equal(table.totalDue, 0);
  assert.equal(table.pendingBills.length, 0);

  const snapshot = await readRelationalTablePaymentSnapshot(relationalPath, "k5-table-create-once");
  assert.equal(snapshot.transaction.amount_cents, 130);
  assert.equal(snapshot.container.table_id, "room_pedana_t05");
  assert.equal(snapshot.container.due_cents, 0);
  assert.equal(snapshot.table.total_due_cents, 0);
  assert.equal(snapshot.bills.length, 0);
  assert.equal(snapshot.outboxRows.length, 1);
  const outboxPayload = JSON.parse(snapshot.outboxRows[0].payload_json);
  assert.equal(outboxPayload.reason, "payment_completed");
  assert.equal(outboxPayload.detail.source, "table_payment");
  assert.equal(outboxPayload.detail.relationalWritePrimary, true);
});

test("K5 payments/table concorrenza reale stessa idempotency key fa replay senza doppio incasso", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startTableWritePrimaryBackend(t, "k5-table-concurrent");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "k5-table-device",
    clientApp: "mobile-frontend",
  });
  await createDeliveredOrder(baseUrl, cashier, "k5-table-device");
  const payload = tablePaymentPayload(cashier, "k5-table-device", "k5-table-concurrent-once");

  const results = await fireConcurrent([
    {
      url: `${baseUrl}/api/payments/table`,
      options: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    },
    {
      url: `${baseUrl}/api/payments/table`,
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
    persisted.paymentContainers.filter((entry) => entry.idempotencyKey === "k5-table-concurrent-once").length,
    1,
  );
  const snapshot = await readRelationalTablePaymentSnapshot(relationalPath, "k5-table-concurrent-once");
  assert.equal(snapshot.transaction.amount_cents, 130);
  assert.equal(snapshot.table.total_due_cents, 0);
});

test("K5 payments/table due bill diversi sullo stesso tavolo non si sovrascrivono", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startTableWritePrimaryBackend(t, "k5-table-two-bills");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "k5-table-device",
    clientApp: "mobile-frontend",
  });
  await createDeliveredOrder(baseUrl, cashier, "k5-table-device", {
    lines: [{ name: "Caffe A", productId: "menu_caffetteria_caffe", qty: 1, price: 1.3 }],
  });
  await createDeliveredOrder(baseUrl, cashier, "k5-table-device", {
    lines: [{ name: "Caffe B", productId: "menu_caffetteria_caffe", qty: 1, price: 1.3 }],
  });
  const before = await readJson(dbPath);
  const table = before.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  const billIds = table.pendingBills.map((bill) => String(bill.id ?? "").trim()).filter(Boolean);
  assert.equal(billIds.length, 2);

  const payloadA = tablePaymentPayload(cashier, "k5-table-device", "k5-table-bill-a", {
    billIds: [billIds[0]],
  });
  const payloadB = tablePaymentPayload(cashier, "k5-table-device", "k5-table-bill-b", {
    billIds: [billIds[1]],
  });
  const results = await fireConcurrent([
    {
      url: `${baseUrl}/api/payments/table`,
      options: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payloadA) },
    },
    {
      url: `${baseUrl}/api/payments/table`,
      options: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payloadB) },
    },
  ]);
  const fulfilled = results.filter((entry) => entry.status === "fulfilled");
  assert.equal(fulfilled.length, 2);
  assert.deepEqual(fulfilled.map((entry) => entry.value.response.status).sort(), [200, 200]);

  const persisted = await readJson(dbPath);
  const updatedTable = persisted.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  assert.equal(updatedTable.totalDue, 0);
  assert.equal(updatedTable.pendingBills.length, 0);
  assert.equal(persisted.paymentContainers.filter((entry) => entry.tableId === "room_pedana_t05").length, 2);

  const snapshotA = await readRelationalTablePaymentSnapshot(relationalPath, "k5-table-bill-a");
  const snapshotB = await readRelationalTablePaymentSnapshot(relationalPath, "k5-table-bill-b");
  assert.equal(snapshotA.transaction.amount_cents, 130);
  assert.equal(snapshotB.transaction.amount_cents, 130);
  assert.equal(snapshotB.table.total_due_cents, 0);
  assert.equal(snapshotB.bills.length, 0);
});

test("K5 payments/table write-primary senza relazionale restituisce 503 esplicito", async (t) => {
  const backend = await startBackend(t, {
    env: {
      BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY: "1",
    },
  });
  const cashier = await loginJson(backend.baseUrl, "cashier", "2222", {
    deviceUuid: "k5-table-no-db",
    clientApp: "mobile-frontend",
  });
  await createDeliveredOrder(backend.baseUrl, cashier, "k5-table-no-db");

  const paid = await apiPost(
    backend.baseUrl,
    "/api/payments/table",
    tablePaymentPayload(cashier, "k5-table-no-db", "k5-table-no-db"),
  );

  assert.equal(paid.response.status, 503);
  assert.equal(paid.body.code, "RELATIONAL_PAYMENTS_DB_UNAVAILABLE");
  const persisted = await readJson(backend.dbPath);
  assert.equal(persisted.paymentContainers.length, 0);
});
