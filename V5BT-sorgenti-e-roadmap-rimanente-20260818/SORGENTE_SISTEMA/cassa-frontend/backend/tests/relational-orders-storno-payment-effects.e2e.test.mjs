import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  apiPost,
  authPayload,
  createSimpleOrder,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

function roundMoney(value) {
  return Number((Number(value) || 0).toFixed(2));
}

async function withRelationalDb(relationalPath, callback, options = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: options.readOnly === true });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

async function startStornoPaymentEffectsBackend(t, prefix) {
  const runDir = await createTempRunDir(prefix);
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY: "1",
      EVENT_OUTBOX_ENABLED: "1",
      IDEMPOTENCY_STORE_ENABLED: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders,payments,tablesBills",
    },
  });
  return { ...backend, relationalPath };
}

async function createDeliveredOrder(baseUrl, session, deviceUuid, options = {}) {
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid,
    tableId: options.tableId,
    roomId: options.roomId,
    tableNumber: options.tableNumber,
    lines: options.lines,
    extraPayload: options.extraPayload,
  });
  assert.equal(created.response.status, 200);
  const ready = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: created.body.order.id,
      clientApp: "mobile-frontend",
      workflowReason: "storno_payment_effects_ready",
      expectedRevision: created.body.order.revision,
      order: {
        ...created.body.order,
        workflowStatus: "ready",
        items: created.body.order.items.map((item) => ({ ...item, done: true })),
      },
    }),
  );
  assert.equal(ready.response.status, 200);
  const delivered = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: ready.body.order.id,
      clientApp: "mobile-frontend",
      workflowReason: "storno_payment_effects_delivered",
      expectedRevision: ready.body.order.revision,
      order: {
        ...ready.body.order,
        workflowStatus: "delivered",
        items: ready.body.order.items.map((item) => ({ ...item, done: true })),
      },
    }),
  );
  assert.equal(delivered.response.status, 200);
  return delivered.body.order;
}

async function lockTable(baseUrl, session, deviceUuid, tableId, purpose) {
  const locked = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId, purpose }),
  );
  assert.equal(locked.response.status, 200);
  return locked;
}

async function payTable(baseUrl, session, deviceUuid, order, options = {}) {
  await lockTable(baseUrl, session, deviceUuid, order.tableId, "payment.table");
  const paid = await apiPost(
    baseUrl,
    "/api/payments/table",
    authPayload(session, deviceUuid, {
      tableId: order.tableId,
      roomId: order.roomId,
      paymentMethodId: options.paymentMethodId ?? "pay_cash",
      cashGiven: options.cashGiven,
      posProvider: options.posProvider,
      posTxRef: options.posTxRef,
      idempotencyKey: options.idempotencyKey,
    }),
  );
  assert.equal(paid.response.status, 200);
  return paid;
}

async function paidOrderFromState(dbPath, orderId) {
  const state = await readJson(dbPath);
  const order = state.integration.orders.find((entry) => String(entry?.id) === String(orderId));
  assert.ok(order, `ordine ${orderId} non trovato`);
  assert.equal(order.paymentStatus, "paid");
  assert.equal(roundMoney(order.dueAmount), 0);
  return order;
}

async function applyStorno(baseUrl, session, deviceUuid, order, options = {}) {
  await lockTable(baseUrl, session, deviceUuid, order.tableId, "order.comp");
  return apiPost(
    baseUrl,
    "/api/integration/orders/storno",
    authPayload(session, deviceUuid, {
      orderId: order.id,
      tableId: order.tableId,
      roomId: order.roomId,
      originalLineId: options.lineId ?? order.items?.[0]?.lineId,
      quantity: options.quantity ?? 1,
      reason: options.reason ?? "Test storno payment effects",
      expectedRevision: options.expectedRevision ?? order.revision ?? order.currentRevision,
      idempotencyKey: options.idempotencyKey,
    }),
  );
}

async function readRelationalSnapshot(relationalPath, orderId) {
  return withRelationalDb(
    relationalPath,
    (db) => {
      const orderRow = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
      const tableRows = db.prepare("SELECT * FROM table_states ORDER BY table_id").all();
      const containers = db.prepare("SELECT * FROM payment_containers ORDER BY created_at ASC, id ASC").all();
      const parts = db.prepare("SELECT * FROM payment_parts ORDER BY created_at ASC, id ASC").all();
      const transactions = db.prepare("SELECT * FROM payment_transactions ORDER BY created_at ASC, id ASC").all();
      return { orderRow, tableRows, containers, parts, transactions };
    },
    { readOnly: true },
  );
}

test("[BE][MP-4bj] storno contanti pagato e' idempotente e non duplica side effect", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startStornoPaymentEffectsBackend(t, "rel-order-storno-cash-effects");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "storno-cash-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "storno-cash-device", {
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    tableNumber: 5,
  });
  await payTable(baseUrl, cashier, "storno-cash-device", order, {
    paymentMethodId: "pay_cash",
    cashGiven: 1.3,
    idempotencyKey: "mp4bj-cash-payment",
  });
  const paidOrder = await paidOrderFromState(dbPath, order.id);

  const first = await applyStorno(baseUrl, cashier, "storno-cash-device", paidOrder, {
    idempotencyKey: "mp4bj-cash-storno",
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.comp.requestedOperationType, "storno");
  assert.equal(roundMoney(first.body.comp.amount), 1.3);
  assert.equal(roundMoney(first.body.comp.paymentStornoAmount), 1.3);
  assert.equal(roundMoney(first.body.order.total), 0);
  assert.equal(roundMoney(first.body.order.paidAmount), 0);
  assert.equal(roundMoney(first.body.order.dueAmount), 0);
  assert.ok(first.body.stornoPrintJob?.id, "lo storno pagato deve accodare il ticket payment_storno");

  const second = await applyStorno(baseUrl, cashier, "storno-cash-device", first.body.order, {
    lineId: paidOrder.items[0].lineId,
    expectedRevision: first.body.order.revision,
    idempotencyKey: "mp4bj-cash-storno",
  });
  assert.equal(second.response.status, 200);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.comp.id, first.body.comp.id);

  const persisted = await readJson(dbPath);
  assert.equal(persisted.integration.orderComps.filter((entry) => entry.idempotencyKey === "mp4bj-cash-storno").length, 1);
  assert.equal(persisted.paymentContainers.filter((entry) => entry.idempotencyKey === "mp4bj-cash-payment").length, 1);
  assert.equal(persisted.paymentTransactions.length, 1);
  assert.equal(persisted.printSpoolJobs.filter((entry) => entry.kind === "payment_storno" && entry.orderId === first.body.comp.id).length, 1);
  const table = persisted.posSettings.tables.find((entry) => entry.id === paidOrder.tableId);
  assert.equal(roundMoney(table.totalDue), 0);

  const relational = await readRelationalSnapshot(relationalPath, paidOrder.id);
  assert.equal(relational.orderRow.revision, first.body.order.revision);
  assert.equal(relational.orderRow.total_cents, 0);
  assert.equal(relational.containers.length, 1);
  assert.equal(relational.transactions.filter((entry) => String(entry.id ?? "").startsWith("tx_")).length, 1);
  assert.equal(relational.tableRows.find((entry) => entry.table_id === paidOrder.tableId)?.total_due_cents, 0);
});

test("[BE][MP-4bj] storno POS parziale persiste supersede e riaddebito senza duplicati", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startStornoPaymentEffectsBackend(t, "rel-order-storno-pos-effects");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "storno-pos-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "storno-pos-device", {
    tableId: "room_pedana_t07",
    roomId: "room_pedana",
    tableNumber: 7,
    lines: [
      {
        name: "Caffe",
        productId: "menu_caffetteria_caffe",
        qty: 2,
        price: 1.3,
      },
    ],
  });
  await payTable(baseUrl, cashier, "storno-pos-device", order, {
    paymentMethodId: "pay_card",
    posProvider: "POS Test",
    posTxRef: "POS-TX-MP4BJ",
    idempotencyKey: "mp4bj-pos-payment",
  });
  const paidOrder = await paidOrderFromState(dbPath, order.id);

  const first = await applyStorno(baseUrl, cashier, "storno-pos-device", paidOrder, {
    quantity: 1,
    idempotencyKey: "mp4bj-pos-storno",
  });
  assert.equal(first.response.status, 200);
  assert.equal(roundMoney(first.body.comp.amount), 1.3);
  assert.equal(roundMoney(first.body.comp.paymentVoidAmount), 2.6);
  assert.equal(roundMoney(first.body.comp.paymentRechargeAmount), 1.3);
  assert.equal(roundMoney(first.body.order.total), 1.3);
  assert.equal(roundMoney(first.body.order.paidAmount), 1.3);
  assert.equal(roundMoney(first.body.order.dueAmount), 0);

  const second = await applyStorno(baseUrl, cashier, "storno-pos-device", first.body.order, {
    lineId: paidOrder.items[0].lineId,
    quantity: 1,
    expectedRevision: first.body.order.revision,
    idempotencyKey: "mp4bj-pos-storno",
  });
  assert.equal(second.response.status, 200);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.comp.id, first.body.comp.id);

  const persisted = await readJson(dbPath);
  assert.equal(persisted.integration.orderComps.filter((entry) => entry.idempotencyKey === "mp4bj-pos-storno").length, 1);
  const original = persisted.paymentContainers.find((entry) => entry.idempotencyKey === "mp4bj-pos-payment");
  assert.ok(original?.supersededByPaymentId, "il pagamento POS originale deve essere superseded");
  assert.equal(roundMoney(original.voidedAmount), 2.6);
  assert.equal(roundMoney(original.rechargeAmount), 1.3);
  const recharge = persisted.paymentContainers.find((entry) => entry.originalPaymentId === original.id);
  assert.ok(recharge, "lo storno POS parziale deve creare un riaddebito residuo");
  assert.equal(roundMoney(recharge.amount), 1.3);
  assert.equal(recharge.adjustmentKind, "pos_recharge_after_full_void");
  assert.equal(persisted.paymentContainers.filter((entry) => entry.originalPaymentId === original.id).length, 1);
  assert.equal(persisted.paymentTransactions.filter((entry) => String(entry.note ?? "").includes(first.body.comp.id)).length, 1);

  const relational = await readRelationalSnapshot(relationalPath, paidOrder.id);
  const relationalOriginal = relational.containers.find((entry) => entry.id === original.id);
  assert.ok(relationalOriginal, "il pagamento originale deve restare nel relazionale");
  assert.equal(JSON.parse(relationalOriginal.raw_json).supersededByPaymentId, original.supersededByPaymentId);
  const relationalRecharge = relational.containers.find((entry) => entry.id === recharge.id);
  assert.ok(relationalRecharge, "il riaddebito residuo deve essere persistito nel relazionale");
  assert.equal(relationalRecharge.total_cents, 130);
  assert.equal(relational.transactions.some((entry) => entry.id === persisted.paymentTransactions.find((tx) => String(tx.note ?? "").includes(first.body.comp.id))?.id), true);
});

test("[BE][MP-4bj] storno stale non produce comp, pagamenti o print job", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startStornoPaymentEffectsBackend(t, "rel-order-storno-stale-effects");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "storno-stale-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "storno-stale-device", {
    tableId: "room_pedana_t08",
    roomId: "room_pedana",
    tableNumber: 8,
  });
  await payTable(baseUrl, cashier, "storno-stale-device", order, {
    paymentMethodId: "pay_cash",
    cashGiven: 1.3,
    idempotencyKey: "mp4bj-stale-payment",
  });
  const paidOrder = await paidOrderFromState(dbPath, order.id);
  await withRelationalDb(relationalPath, (db) => {
    db.prepare("UPDATE orders SET revision = 99 WHERE id = ?").run(paidOrder.id);
  });

  const stale = await applyStorno(baseUrl, cashier, "storno-stale-device", paidOrder, {
    idempotencyKey: "mp4bj-stale-storno",
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");

  const persisted = await readJson(dbPath);
  assert.equal(persisted.integration.orderComps.some((entry) => entry.idempotencyKey === "mp4bj-stale-storno"), false);
  assert.equal(persisted.printSpoolJobs.some((entry) => entry.kind === "payment_storno"), false);
  assert.equal(persisted.paymentContainers.length, 1);
  assert.equal(persisted.paymentTransactions.length, 1);
});
