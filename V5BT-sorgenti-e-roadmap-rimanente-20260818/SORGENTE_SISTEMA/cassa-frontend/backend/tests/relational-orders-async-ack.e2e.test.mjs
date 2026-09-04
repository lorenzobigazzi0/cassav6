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

async function readRelationalOrder(relationalPath, orderId) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    return db.prepare("SELECT id, status, revision, raw_json FROM orders WHERE id = ?").get(orderId);
  } finally {
    db.close();
  }
}

async function pollMirroredOrder(dbPath, orderId, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    const persisted = await readJson(dbPath).catch(() => null);
    lastSeen = persisted?.integration?.orders?.find((order) => order.id === orderId) ?? null;
    if (lastSeen && predicate(lastSeen)) return lastSeen;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return lastSeen;
}

async function pollMirroredComp(dbPath, idempotencyKey, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    const persisted = await readJson(dbPath).catch(() => null);
    lastSeen = persisted?.integration?.orderComps?.find((entry) => entry.idempotencyKey === idempotencyKey) ?? null;
    if (lastSeen) return lastSeen;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return lastSeen;
}

async function pollMirroredCorrection(dbPath, idempotencyKey, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    const persisted = await readJson(dbPath).catch(() => null);
    lastSeen = persisted?.integration?.orderCorrections?.find((entry) => entry.idempotencyKey === idempotencyKey) ?? null;
    if (lastSeen) return lastSeen;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return lastSeen;
}

async function pollMirroredBarReplacement(dbPath, idempotencyKey, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    const persisted = await readJson(dbPath).catch(() => null);
    lastSeen = persisted?.integration?.barChargeReplacements?.find((entry) => entry.idempotencyKey === idempotencyKey) ?? null;
    if (lastSeen) return lastSeen;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return lastSeen;
}

async function lockForCancel(baseUrl, session, deviceUuid, tableId) {
  const locked = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId, purpose: "order.cancel" }),
  );
  assert.equal(locked.response.status, 200);
}

async function lockForCorrection(baseUrl, session, deviceUuid, tableId) {
  const locked = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId, purpose: "order.correction" }),
  );
  assert.equal(locked.response.status, 200);
}

async function lockForComp(baseUrl, session, deviceUuid, tableId) {
  const locked = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId, purpose: "order.comp" }),
  );
  assert.equal(locked.response.status, 200);
}

async function lockForBarReplacement(baseUrl, session, deviceUuid, tableId) {
  const locked = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId, purpose: "bar_charge_replacement" }),
  );
  assert.equal(locked.response.status, 200);
}

test("[BE][P3] async ACK: create/sync/comp/cancel/correct/barReplacement rispondono subito e il mirror app-state converge", async (t) => {
  const runDir = await createTempRunDir("rel-order-async-ack");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_COMP_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY: "1",
      BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
      ORDERS_ASYNC_FLUSH_INTERVAL_MS: "25",
      PRINTING_ENABLED: "0",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "async-ack-cashier",
    clientApp: "mobile-frontend",
  });
  const station = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "async-ack-station",
    clientApp: "postazione",
  });

  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "async-ack-cashier",
    extraPayload: { idempotencyKey: "p3-async-ack-create" },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.ok, true);
  const orderId = created.body.order.id;

  const relationalAfterCreate = await readRelationalOrder(relationalPath, orderId);
  assert.ok(relationalAfterCreate, "l'ordine deve esistere subito nel relazionale (write-primary prima dell'ACK)");
  assert.equal(relationalAfterCreate.revision, 1);

  const mirroredCreate = await pollMirroredOrder(dbPath, orderId, (order) => Boolean(order));
  assert.ok(mirroredCreate, "il mirror app-state deve convergere dopo l'ACK (flush asincrono)");

  const synced = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(station, "async-ack-station", {
      id: orderId,
      clientApp: "postazione",
      workflowReason: "station_ready",
      order: {
        ...created.body.order,
        workflowStatus: "ready",
        items: created.body.order.items.map((item) => ({ ...item, done: true })),
      },
    })
  );
  assert.equal(synced.response.status, 200);
  assert.equal(synced.body.order.revision, 2);
  assert.equal(synced.body.order.currentRevision, 2);

  const relationalAfterSync = await readRelationalOrder(relationalPath, orderId);
  assert.equal(relationalAfterSync.revision, 2, "il relazionale avanza con CAS prima dell'ACK");

  const mirroredSync = await pollMirroredOrder(dbPath, orderId, (order) => Number(order.revision) === 2);
  assert.ok(mirroredSync, "il mirror deve convergere anche dopo il sync");
  assert.equal(Number(mirroredSync.revision), 2);
  assert.equal(mirroredSync.workflowStatus, synced.body.order.workflowStatus);

  await lockForComp(baseUrl, cashier, "async-ack-cashier", synced.body.order.tableId);
  const comped = await apiPost(
    baseUrl,
    "/api/integration/orders/comp",
    authPayload(cashier, "async-ack-cashier", {
      orderId,
      tableId: synced.body.order.tableId,
      roomId: synced.body.order.roomId,
      originalLineId: synced.body.order.items[0].lineId,
      quantity: 1,
      reason: "Async ACK comp",
      idempotencyKey: "p3-async-ack-comp",
    }),
  );
  assert.equal(comped.response.status, 200);
  assert.equal(comped.body.order.revision, 3);
  const relationalAfterComp = await readRelationalOrder(relationalPath, orderId);
  assert.equal(relationalAfterComp.revision, 3, "il relazionale avanza anche per comp prima dell'ACK");
  const mirroredCompOrder = await pollMirroredOrder(dbPath, orderId, (order) => Number(order.revision) === 3 && Number(order.total) === 0);
  assert.ok(mirroredCompOrder, "il mirror deve convergere anche dopo il comp");
  const mirroredComp = await pollMirroredComp(dbPath, "p3-async-ack-comp");
  assert.ok(mirroredComp, "il mirror deve sincronizzare anche orderComps dopo il comp");

  const cancelCreated = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "async-ack-cashier",
    tableId: "room_pedana_t06",
    tableNumber: 6,
    extraPayload: { idempotencyKey: "p3-async-ack-cancel" },
  });
  assert.equal(cancelCreated.response.status, 200);
  const cancelOrderId = cancelCreated.body.order.id;
  assert.ok(await pollMirroredOrder(dbPath, cancelOrderId, (order) => Boolean(order)));
  await lockForCancel(baseUrl, cashier, "async-ack-cashier", cancelCreated.body.order.tableId);
  const cancelled = await apiPost(
    baseUrl,
    "/api/integration/orders/cancel",
    authPayload(cashier, "async-ack-cashier", {
      orderId: cancelOrderId,
      tableId: cancelCreated.body.order.tableId,
      roomId: cancelCreated.body.order.roomId,
      expectedRevision: cancelCreated.body.order.revision,
      reason: "Async ACK cancel",
    }),
  );
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.order.workflowStatus, "cancelled");
  const relationalAfterCancel = await readRelationalOrder(relationalPath, cancelOrderId);
  assert.equal(relationalAfterCancel.revision, 2, "il relazionale avanza anche per cancel prima dell'ACK");
  const mirroredCancel = await pollMirroredOrder(dbPath, cancelOrderId, (order) => Number(order.revision) === 2 && order.workflowStatus === "cancelled");
  assert.ok(mirroredCancel, "il mirror deve convergere anche dopo il cancel");

  const correctionCreated = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "async-ack-cashier",
    tableId: "room_pedana_t07",
    tableNumber: 7,
    extraPayload: { idempotencyKey: "p3-async-ack-correct-create" },
  });
  assert.equal(correctionCreated.response.status, 200);
  const correctionOrderId = correctionCreated.body.order.id;
  assert.ok(await pollMirroredOrder(dbPath, correctionOrderId, (order) => Boolean(order)));
  await lockForCorrection(baseUrl, cashier, "async-ack-cashier", correctionCreated.body.order.tableId);
  const corrected = await apiPost(
    baseUrl,
    "/api/integration/orders/correct",
    authPayload(cashier, "async-ack-cashier", {
      orderId: correctionOrderId,
      tableId: correctionCreated.body.order.tableId,
      roomId: correctionCreated.body.order.roomId,
      expectedRevision: correctionCreated.body.order.revision,
      addedItems: [{ productId: "menu_caffetteria_cappuccino", quantity: 1 }],
      reason: "Async ACK correct",
      idempotencyKey: "p3-async-ack-correct",
    }),
  );
  assert.equal(corrected.response.status, 200);
  assert.equal(corrected.body.order.revision, 2);
  const relationalAfterCorrect = await readRelationalOrder(relationalPath, correctionOrderId);
  assert.equal(relationalAfterCorrect.revision, 2, "il relazionale avanza anche per correct prima dell'ACK");
  const relationalCorrectRaw = JSON.parse(relationalAfterCorrect.raw_json);
  assert.equal(relationalCorrectRaw.lastCorrectionId, corrected.body.correction.correctionId);
  const mirroredCorrectOrder = await pollMirroredOrder(dbPath, correctionOrderId, (order) => Number(order.revision) === 2 && order.lastCorrectionId === corrected.body.correction.correctionId);
  assert.ok(mirroredCorrectOrder, "il mirror deve convergere anche dopo il correct");
  const mirroredCorrection = await pollMirroredCorrection(dbPath, "p3-async-ack-correct");
  assert.ok(mirroredCorrection, "il mirror deve sincronizzare anche orderCorrections dopo il correct");

  const barCreated = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "async-ack-cashier",
    tableId: "room_pedana_t08",
    tableNumber: 8,
    extraPayload: { idempotencyKey: "p3-async-ack-bar-create" },
  });
  assert.equal(barCreated.response.status, 200);
  const barOrderId = barCreated.body.order.id;
  assert.ok(await pollMirroredOrder(dbPath, barOrderId, (order) => Boolean(order)));
  await lockForBarReplacement(baseUrl, cashier, "async-ack-cashier", barCreated.body.order.tableId);
  const barReplacement = await apiPost(
    baseUrl,
    "/api/integration/orders/replacement/bar-charge",
    authPayload(cashier, "async-ack-cashier", {
      orderId: barOrderId,
      tableId: barCreated.body.order.tableId,
      roomId: barCreated.body.order.roomId,
      originalLineId: barCreated.body.order.items[0].lineId,
      productId: barCreated.body.order.items[0].productId,
      quantity: 1,
      reason: "Async ACK bar replacement",
      idempotencyKey: "p3-async-ack-bar-replacement",
    }),
  );
  assert.equal(barReplacement.response.status, 200);
  assert.equal(barReplacement.body.order.revision, 2);
  const relationalAfterBar = await readRelationalOrder(relationalPath, barOrderId);
  assert.equal(relationalAfterBar.revision, 2, "il relazionale avanza anche per barReplacement prima dell'ACK");
  const mirroredBarOrder = await pollMirroredOrder(dbPath, barOrderId, (order) => Number(order.revision) === 2 && order.items.some((item) => item.lineType === "BAR_CHARGE_REPLACEMENT"));
  assert.ok(mirroredBarOrder, "il mirror deve convergere anche dopo il barReplacement");
  const mirroredBarReplacement = await pollMirroredBarReplacement(dbPath, "p3-async-ack-bar-replacement");
  assert.ok(mirroredBarReplacement, "il mirror deve sincronizzare anche barChargeReplacements dopo il barReplacement");
});
