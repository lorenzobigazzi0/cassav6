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

async function withRelationalDb(relationalPath, callback, options = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: options.readOnly === true });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

async function lockForComp(baseUrl, session, deviceUuid, tableId) {
  const locked = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId, purpose: "order.comp" }),
  );
  assert.equal(locked.response.status, 200);
}

async function markReady(baseUrl, session, deviceUuid, order) {
  const synced = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: order.id,
      clientApp: "postazione",
      workflowReason: "station_ready",
      order: {
        ...order,
        workflowStatus: "ready",
        items: order.items.map((item) => ({ ...item, done: true })),
      },
    }),
  );
  assert.equal(synced.response.status, 200);
  return synced.body.order;
}

test("[BE][I4] order comp scrive primary relazionale con CAS", async (t) => {
  const runDir = await createTempRunDir("rel-order-comp-i4");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_COMP_WRITE_PRIMARY: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-comp-cashier",
    clientApp: "mobile-frontend",
  });
  const station = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-comp-station",
    clientApp: "postazione",
  });

  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-comp-cashier",
    extraPayload: { idempotencyKey: "i4-order-comp-create" },
  });
  assert.equal(created.response.status, 200);
  const readyOrder = await markReady(baseUrl, station, "rel-order-comp-station", created.body.order);
  await lockForComp(baseUrl, cashier, "rel-order-comp-cashier", readyOrder.tableId);
  const comped = await apiPost(
    baseUrl,
    "/api/integration/orders/comp",
    authPayload(cashier, "rel-order-comp-cashier", {
      orderId: readyOrder.id,
      tableId: readyOrder.tableId,
      roomId: readyOrder.roomId,
      originalLineId: readyOrder.items[0].lineId,
      quantity: 1,
      reason: "Test comp write-primary",
      idempotencyKey: "i4-order-comp",
    }),
  );

  assert.equal(comped.response.status, 200);
  assert.equal(comped.body.order.revision, 3);
  assert.equal(comped.body.order.total, 0);
  assert.equal(comped.body.order.dueAmount, 0);
  assert.equal(comped.body.comp.orderId, created.body.order.id);
  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, total_cents, revision, raw_json FROM orders WHERE id = ?").get(readyOrder.id),
    { readOnly: true },
  );
  const rawOrder = JSON.parse(relationalOrder.raw_json);
  assert.equal(relationalOrder.revision, 3);
  assert.equal(relationalOrder.total_cents, 0);
  assert.equal(rawOrder.currentRevision, 3);
  assert.equal(rawOrder.total, 0);
  assert.equal(rawOrder.totalAdjustedByComps, true);

  const second = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-comp-cashier",
    tableId: "room_pedana_t06",
    tableNumber: 6,
    extraPayload: { idempotencyKey: "i4-order-comp-stale-create" },
  });
  assert.equal(second.response.status, 200);
  const secondReady = await markReady(baseUrl, station, "rel-order-comp-station", second.body.order);
  await lockForComp(baseUrl, cashier, "rel-order-comp-cashier", secondReady.tableId);
  await withRelationalDb(relationalPath, (db) => {
    db.prepare("UPDATE orders SET revision = 99 WHERE id = ?").run(secondReady.id);
  });
  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/comp",
    authPayload(cashier, "rel-order-comp-cashier", {
      orderId: secondReady.id,
      tableId: secondReady.tableId,
      roomId: secondReady.roomId,
      originalLineId: secondReady.items[0].lineId,
      quantity: 1,
      reason: "Test comp stale",
      idempotencyKey: "i4-order-comp-stale",
    }),
  );

  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === secondReady.id);
  assert.equal(mirrored.revision, 2);
  assert.equal(mirrored.lastCompId, undefined);
  assert.equal(persisted.integration.orderComps.some((entry) => entry.idempotencyKey === "i4-order-comp-stale"), false);
});
