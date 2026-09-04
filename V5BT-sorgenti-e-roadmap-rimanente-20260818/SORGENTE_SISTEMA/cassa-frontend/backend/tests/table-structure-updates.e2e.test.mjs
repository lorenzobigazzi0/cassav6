import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireTableLock,
  apiPost,
  authHeaders,
  authPayload,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

function orderLine(name, price, qty = 1, extra = {}) {
  return {
    name,
    qty,
    unitPrice: price,
    unitPriceApplied: price,
    lineTotal: Math.round(price * qty * 100) / 100,
    totalValue: Math.round(price * qty * 100) / 100,
    ...extra,
  };
}

async function createOrder(baseUrl, session, deviceUuid, options) {
  const { response: lockResponse, body: lockBody } = await acquireTableLock(baseUrl, session, options.tableId, {
    deviceUuid,
    purpose: "order.create",
  });
  assert.equal(
    lockResponse.status,
    200,
    `lock order.create ${options.tableId} failed: ${JSON.stringify(lockBody)}`
  );
  const { response, body } = await apiPost(
    baseUrl,
    "/api/integration/orders/create",
    authPayload(session, deviceUuid, {
      source: "mobile-frontend",
      tableId: options.tableId,
      roomId: options.roomId,
      tableNumber: options.tableNumber,
      covers: options.covers ?? 2,
      total: options.lines.reduce((sum, line) => sum + line.lineTotal, 0),
      lines: options.lines,
    })
  );
  assert.equal(response.status, 200, `create order failed: ${JSON.stringify(body)}`);
  assert.equal(body?.ok, true);
  return body.order;
}

async function moveTable(baseUrl, session, deviceUuid, fromTableId, toTableId) {
  const { response: sourceLockResponse, body: sourceLockBody } = await acquireTableLock(baseUrl, session, fromTableId, {
    deviceUuid,
    purpose: "table.move_source",
  });
  assert.equal(
    sourceLockResponse.status,
    200,
    `lock table.move_source ${fromTableId} failed: ${JSON.stringify(sourceLockBody)}`
  );
  const { response: targetLockResponse, body: targetLockBody } = await acquireTableLock(baseUrl, session, toTableId, {
    deviceUuid,
    purpose: "table.move_target",
  });
  assert.equal(
    targetLockResponse.status,
    200,
    `lock table.move_target ${toTableId} failed: ${JSON.stringify(targetLockBody)}`
  );
  const { response, body } = await apiPost(
    baseUrl,
    "/api/integration/layout/table/move",
    authPayload(session, deviceUuid, {
      fromTableId,
      toTableId,
    }),
    { headers: authHeaders(session, deviceUuid) }
  );
  assert.equal(response.status, 200, `move table failed: ${JSON.stringify(body)}`);
  assert.equal(body?.ok, true);
  return body;
}

async function correctOrder(baseUrl, session, deviceUuid, payload) {
  const { response: lockResponse, body: lockBody } = await acquireTableLock(baseUrl, session, payload.tableId, {
    deviceUuid,
    purpose: "order.correction",
  });
  assert.equal(
    lockResponse.status,
    200,
    `lock order.correction ${payload.tableId} failed: ${JSON.stringify(lockBody)}`
  );
  const { response, body } = await apiPost(
    baseUrl,
    "/api/integration/orders/correct",
    authPayload(session, deviceUuid, payload),
    { headers: authHeaders(session, deviceUuid) }
  );
  assert.equal(response.status, 200, `correct order failed: ${JSON.stringify(body)}`);
  assert.equal(body?.ok, true);
  return body;
}

async function syncOrderStatus(baseUrl, session, deviceUuid, orderId, payload) {
  const { response, body } = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: orderId,
      order: payload,
    }),
    { headers: authHeaders(session, deviceUuid) }
  );
  assert.equal(response.status, 200, `sync order failed: ${JSON.stringify(body)}`);
  assert.equal(body?.ok, true);
  return body;
}

async function payTable(baseUrl, session, deviceUuid, tableId, payload = {}) {
  const { response: lockResponse, body: lockBody } = await acquireTableLock(baseUrl, session, tableId, {
    deviceUuid,
    purpose: "payment.table",
  });
  assert.equal(lockResponse.status, 200, `lock payment.table ${tableId} failed: ${JSON.stringify(lockBody)}`);
  const { response, body } = await apiPost(
    baseUrl,
    "/api/payments/table",
    authPayload(session, deviceUuid, {
      tableId,
      paymentMethodId: payload.paymentMethodId ?? "pay_cash",
      roomId: payload.roomId,
      idempotencyKey: payload.idempotencyKey,
      cashGiven: payload.cashGiven,
      amount: payload.amount,
    }),
    { headers: authHeaders(session, deviceUuid) }
  );
  assert.equal(response.status, 200, `pay table failed: ${JSON.stringify(body)}`);
  return body;
}

async function saveGroups(baseUrl, session, deviceUuid, groups, operation) {
  const { response, body } = await apiPost(
    baseUrl,
    "/api/integration/table-groups/save",
    authPayload(session, deviceUuid, {
      groups,
      operation,
    }),
    { headers: authHeaders(session, deviceUuid) }
  );
  assert.equal(response.status, 200, `save groups failed: ${JSON.stringify(body)}`);
  assert.equal(body?.ok, true);
  return body;
}

async function listGroups(baseUrl, session, deviceUuid) {
  const response = await fetch(`${baseUrl}/api/integration/table-groups?_=${Date.now()}`, {
    method: "GET",
    headers: authHeaders(session, deviceUuid),
  });
  const body = await response.json().catch(() => null);
  assert.equal(response.status, 200, `list groups failed: ${JSON.stringify(body)}`);
  assert.equal(body?.ok, true);
  return body;
}

function findOrder(db, orderId) {
  const order = db.integration.orders.find((entry) => String(entry.id) === String(orderId));
  assert.ok(order, `order ${orderId} should exist`);
  return order;
}

function findTable(db, tableId) {
  const table = db.posSettings.tables.find((entry) => String(entry.id) === String(tableId));
  assert.ok(table, `table ${tableId} should exist`);
  return table;
}

function latestJobFor(db, orderId, kind) {
  const jobs = db.printSpoolJobs.filter((job) => job.orderId === orderId && job.kind === kind);
  assert.ok(jobs.length > 0, `expected print job ${kind} for order ${orderId}`);
  return jobs.at(-1);
}

test("spostamento tavolo rifiutato da preflight non entra nella room lane", async (t) => {
  const deviceUuid = "table-move-preflight-mobile";
  const { baseUrl } = await startBackend(t, { env: { RUNTIME_METRICS: "1" } });
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  await createOrder(baseUrl, session, deviceUuid, {
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    tableNumber: 5,
    lines: [orderLine("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
  });
  await createOrder(baseUrl, session, deviceUuid, {
    tableId: "room_pedana_t06",
    roomId: "room_pedana",
    tableNumber: 6,
    lines: [orderLine("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
  });
  const reset = await apiPost(baseUrl, "/api/monitor/runtime-metrics/reset", authPayload(session, deviceUuid, { clientApp: "mobile-frontend" }));
  assert.equal(reset.response.status, 200);
  const rejected = await apiPost(
    baseUrl,
    "/api/integration/layout/table/move",
    authPayload(session, deviceUuid, { fromTableId: "room_pedana_t05", toTableId: "room_pedana_t06" }),
    { headers: authHeaders(session, deviceUuid) }
  );
  assert.equal(rejected.response.status, 409);
  assert.match(rejected.body?.error ?? "", /destinazione/);
  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, { headers: authHeaders(session, deviceUuid) });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.runtimeMetrics.counters.roomLaneEnqueued, 0);
});

test("unione e distacco tavoli ristampano aggiornamento, comanda e preconto con label corrente", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "table-structure-mobile",
    clientApp: "mobile-frontend",
  });
  const order = await createOrder(baseUrl, session, "table-structure-mobile", {
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    tableNumber: 5,
    lines: [orderLine("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
  });

  const merge = await saveGroups(
    baseUrl,
    session,
    "table-structure-mobile",
    [
      {
        id: "room_pedana_t05",
        type: "complex",
        children: [
          { id: "room_pedana_t05", type: "simple" },
          { id: "room_pedana_t06", type: "simple" },
        ],
      },
    ],
    "merge"
  );
  assert.equal(merge.printJobs.length, 1);
  assert.ok(merge.printJobs[0].updatePrintJobId);
  assert.ok(merge.printJobs[0].orderPrintJobId);
  assert.ok(merge.printJobs[0].precontoPrintJobId);
  const listedMerge = await listGroups(baseUrl, session, "table-structure-mobile");
  assert.equal(listedMerge.groups.length, 1);
  let db = await readJson(dbPath);
  assert.match(latestJobFor(db, order.id, "table_update").textPreview, /UNIONE TAVOLI/);
  assert.match(latestJobFor(db, order.id, "order").textPreview, /TAV\. 5\/6/);
  assert.match(latestJobFor(db, order.id, "preconto").textPreview, /5\/6/);

  const split = await saveGroups(baseUrl, session, "table-structure-mobile", [], "split");
  assert.equal(split.printJobs.length, 1);
  assert.ok(split.printJobs[0].updatePrintJobId);
  assert.ok(split.printJobs[0].orderPrintJobId);
  assert.ok(split.printJobs[0].precontoPrintJobId);
  db = await readJson(dbPath);
  assert.match(latestJobFor(db, order.id, "table_update").textPreview, /DISTACCO TAVOLI/);
  assert.match(latestJobFor(db, order.id, "order").textPreview, /TAV\. 5/);
  assert.doesNotMatch(latestJobFor(db, order.id, "order").textPreview, /TAV\. 5\/6/);
});

test("comanda spostata in altra sala resta modificabile dal nuovo tavolo e aggiorna il dovuto", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "table-move-correction-mobile",
    clientApp: "mobile-frontend",
  });
  const order = await createOrder(baseUrl, session, "table-move-correction-mobile", {
    tableId: "room_sala_t01",
    roomId: "room_sala",
    tableNumber: 1,
    lines: [orderLine("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
  });

  const moved = await moveTable(baseUrl, session, "table-move-correction-mobile", "room_sala_t01", "sala_terrazza_t01");
  assert.equal(moved.movedOrdersCount, 1);

  const corrected = await correctOrder(baseUrl, session, "table-move-correction-mobile", {
    tableId: "sala_terrazza_t01",
    roomId: "sala_terrazza",
    orderId: order.id,
    expectedRevision: 1,
    changedItems: [{ lineId: order.items[0].lineId, nextQuantity: 2 }],
    reason: "Modifica dopo cambio sala",
    idempotencyKey: "table-move-correction-after-room-change",
  });
  assert.equal(corrected.order.tableId, "sala_terrazza_t01");
  assert.equal(corrected.order.roomId, "sala_terrazza");
  assert.equal(corrected.order.total, 2.6);
  assert.equal(corrected.order.dueAmount, 2.6);

  const db = await readJson(dbPath);
  assert.equal(findOrder(db, order.id).tableId, "sala_terrazza_t01");
  assert.equal(findTable(db, "room_sala_t01").totalDue, 0);
  assert.equal(findTable(db, "sala_terrazza_t01").totalDue, 0);
  assert.equal(findTable(db, "sala_terrazza_t01").pendingBills.length, 0);
  assert.match(latestJobFor(db, order.id, "order_correction").textPreview, /MODIFICA COMANDA/);

  await syncOrderStatus(baseUrl, session, "table-move-correction-mobile", order.id, {
    workflowStatus: "ready",
    station: "BAR-1",
    ownerStation: "BAR-1",
  });
  const readyDb = await readJson(dbPath);
  assert.equal(findTable(readyDb, "room_sala_t01").totalDue, 0);
  assert.equal(findTable(readyDb, "sala_terrazza_t01").totalDue, 2.6);
  assert.equal(findTable(readyDb, "sala_terrazza_t01").pendingBills.length, 1);
});

test("pagamento conto unico su tavoli uniti chiude le comande pagabili di tutto il gruppo", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "table-group-payment-mobile",
    clientApp: "mobile-frontend",
  });
  const firstOrder = await createOrder(baseUrl, session, "table-group-payment-mobile", {
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    tableNumber: 5,
    lines: [orderLine("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
  });
  const secondOrder = await createOrder(baseUrl, session, "table-group-payment-mobile", {
    tableId: "room_pedana_t06",
    roomId: "room_pedana",
    tableNumber: 6,
    lines: [orderLine("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
  });
  await syncOrderStatus(baseUrl, session, "table-group-payment-mobile", firstOrder.id, {
    workflowStatus: "ready",
    station: "BAR-1",
    ownerStation: "BAR-1",
  });
  await syncOrderStatus(baseUrl, session, "table-group-payment-mobile", secondOrder.id, {
    workflowStatus: "ready",
    station: "BAR-1",
    ownerStation: "BAR-1",
  });
  await saveGroups(
    baseUrl,
    session,
    "table-group-payment-mobile",
    [
      {
        id: "room_pedana_t05",
        type: "complex",
        children: [
          { id: "room_pedana_t05", type: "simple" },
          { id: "room_pedana_t06", type: "simple" },
        ],
      },
    ],
    "merge"
  );

  const paid = await payTable(baseUrl, session, "table-group-payment-mobile", "room_pedana_t05", {
    roomId: "room_pedana",
    idempotencyKey: "pay-merged-table-5-6",
    cashGiven: 2.9,
  });

  assert.equal(paid.payment.amount, 2.9);
  assert.deepEqual(new Set(paid.payment.orderIds), new Set([firstOrder.id, secondOrder.id]));
  assert.equal(paid.table.totalDue, 0);
  const db = await readJson(dbPath);
  assert.equal(findOrder(db, firstOrder.id).paymentStatus, "paid");
  assert.equal(findOrder(db, secondOrder.id).paymentStatus, "paid");
  assert.equal(findTable(db, "room_pedana_t05").totalDue, 0);
  assert.equal(findTable(db, "room_pedana_t06").totalDue, 0);
});

test("pagamento tavolo unito ignora le comande gia pagate e salda solo il residuo", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "table-group-paid-residual-mobile",
    clientApp: "mobile-frontend",
  });
  const paidOrder = await createOrder(baseUrl, session, "table-group-paid-residual-mobile", {
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    tableNumber: 5,
    lines: [orderLine("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
  });
  await syncOrderStatus(baseUrl, session, "table-group-paid-residual-mobile", paidOrder.id, {
    workflowStatus: "ready",
    station: "BAR-1",
    ownerStation: "BAR-1",
  });
  await payTable(baseUrl, session, "table-group-paid-residual-mobile", "room_pedana_t05", {
    roomId: "room_pedana",
    idempotencyKey: "pay-before-merge-table-5",
    cashGiven: 1.3,
  });
  const residualOrder = await createOrder(baseUrl, session, "table-group-paid-residual-mobile", {
    tableId: "room_pedana_t06",
    roomId: "room_pedana",
    tableNumber: 6,
    lines: [orderLine("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
  });
  await syncOrderStatus(baseUrl, session, "table-group-paid-residual-mobile", residualOrder.id, {
    workflowStatus: "ready",
    station: "BAR-1",
    ownerStation: "BAR-1",
  });
  await saveGroups(
    baseUrl,
    session,
    "table-group-paid-residual-mobile",
    [
      {
        id: "room_pedana_t05",
        type: "complex",
        children: [
          { id: "room_pedana_t05", type: "simple" },
          { id: "room_pedana_t06", type: "simple" },
        ],
      },
    ],
    "merge"
  );

  const paid = await payTable(baseUrl, session, "table-group-paid-residual-mobile", "room_pedana_t05", {
    roomId: "room_pedana",
    idempotencyKey: "pay-merged-residual-table-5-6",
    cashGiven: 1.6,
  });

  assert.equal(paid.payment.amount, 1.6);
  assert.deepEqual(paid.payment.orderIds, [residualOrder.id]);
  const db = await readJson(dbPath);
  assert.equal(findOrder(db, paidOrder.id).paymentStatus, "paid");
  assert.equal(findOrder(db, residualOrder.id).paymentStatus, "paid");
  assert.equal(findTable(db, "room_pedana_t05").totalDue, 0);
  assert.equal(findTable(db, "room_pedana_t06").totalDue, 0);
});
