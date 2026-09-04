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

async function lockForStorno(baseUrl, session, deviceUuid, tableId) {
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
      expectedRevision: order.revision,
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

test("[BE][MP-4bd] orders/storno scrive primary relazionale con CAS dedicato", async (t) => {
  const runDir = await createTempRunDir("rel-order-storno");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-storno-cashier",
    clientApp: "mobile-frontend",
  });
  const station = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-storno-station",
    clientApp: "postazione",
  });

  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-storno-cashier",
    extraPayload: { idempotencyKey: "mp4bd-storno-create" },
  });
  assert.equal(created.response.status, 200);
  const readyOrder = await markReady(baseUrl, station, "rel-order-storno-station", created.body.order);
  await lockForStorno(baseUrl, cashier, "rel-order-storno-cashier", readyOrder.tableId);
  const storno = await apiPost(
    baseUrl,
    "/api/integration/orders/storno",
    authPayload(cashier, "rel-order-storno-cashier", {
      orderId: readyOrder.id,
      tableId: readyOrder.tableId,
      roomId: readyOrder.roomId,
      originalLineId: readyOrder.items[0].lineId,
      quantity: 1,
      reason: "Test storno write-primary",
      expectedRevision: readyOrder.revision,
      idempotencyKey: "mp4bd-storno",
    }),
  );

  assert.equal(storno.response.status, 200);
  assert.equal(storno.body.order.revision, 3);
  assert.equal(storno.body.order.currentRevision, 3);
  assert.equal(storno.body.order.total, 0);
  assert.equal(storno.body.order.dueAmount, 0);
  assert.equal(storno.body.comp.requestedOperationType, "storno");
  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, total_cents, revision, raw_json FROM orders WHERE id = ?").get(readyOrder.id),
    { readOnly: true },
  );
  const rawOrder = JSON.parse(relationalOrder.raw_json);
  assert.equal(relationalOrder.revision, 3);
  assert.equal(relationalOrder.total_cents, 0);
  assert.equal(rawOrder.currentRevision, 3);
  assert.equal(rawOrder.totalAdjustedByComps, true);

  const staleCreated = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-storno-cashier",
    tableId: "room_pedana_t06",
    tableNumber: 6,
    extraPayload: { idempotencyKey: "mp4bd-storno-stale-create" },
  });
  assert.equal(staleCreated.response.status, 200);
  const staleReady = await markReady(baseUrl, station, "rel-order-storno-station", staleCreated.body.order);
  await lockForStorno(baseUrl, cashier, "rel-order-storno-cashier", staleReady.tableId);
  await withRelationalDb(relationalPath, (db) => {
    db.prepare("UPDATE orders SET revision = 99 WHERE id = ?").run(staleReady.id);
  });
  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/storno",
    authPayload(cashier, "rel-order-storno-cashier", {
      orderId: staleReady.id,
      tableId: staleReady.tableId,
      roomId: staleReady.roomId,
      originalLineId: staleReady.items[0].lineId,
      quantity: 1,
      reason: "Test storno stale",
      expectedRevision: staleReady.revision,
      idempotencyKey: "mp4bd-storno-stale",
    }),
  );

  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === staleReady.id);
  assert.equal(mirrored.revision, 2);
  assert.equal(mirrored.lastCompId, undefined);
  assert.equal(persisted.integration.orderComps.some((entry) => entry.idempotencyKey === "mp4bd-storno-stale"), false);
});
