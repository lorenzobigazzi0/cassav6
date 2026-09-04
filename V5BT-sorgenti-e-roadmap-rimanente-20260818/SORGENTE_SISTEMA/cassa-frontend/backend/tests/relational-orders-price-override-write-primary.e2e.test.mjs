import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  acquireTableLock,
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

async function lockForPriceOverride(baseUrl, session, tableId) {
  const locked = await acquireTableLock(baseUrl, session, tableId, {
    deviceUuid: "rel-order-price-manager",
    purpose: "order.price_override",
  });
  assert.equal(locked.response.status, 200);
}

test("[BE][MP-4bb] line/price-override scrive primary relazionale con CAS", async (t) => {
  const runDir = await createTempRunDir("rel-order-price-override");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "rel-order-price-manager",
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: "rel-order-price-manager",
    extraPayload: { idempotencyKey: "mp4bb-price-override-create" },
  });
  assert.equal(created.response.status, 200);
  const lineId = created.body.order.items[0].lineId;
  await lockForPriceOverride(baseUrl, manager, created.body.order.tableId);
  const override = await apiPost(
    baseUrl,
    "/api/integration/orders/line/price-override",
    authPayload(manager, "rel-order-price-manager", {
      orderId: created.body.order.id,
      lineId,
      unitPriceApplied: 2.5,
      listPriceAtTime: 2.5,
      reason: "Test override prezzo",
      expectedRevision: created.body.order.revision,
    }),
  );

  assert.equal(override.response.status, 200);
  assert.equal(override.body.order.revision, 2);
  assert.equal(override.body.order.currentRevision, 2);
  assert.equal(override.body.order.total, 2.5);
  assert.equal(override.body.order.dueAmount, 2.5);
  assert.equal(override.body.order.items[0].unitPriceApplied, 2.5);
  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, revision, raw_json FROM orders WHERE id = ?").get(created.body.order.id),
    { readOnly: true },
  );
  const rawOrder = JSON.parse(relationalOrder.raw_json);
  assert.equal(relationalOrder.revision, 2);
  assert.equal(rawOrder.currentRevision, 2);
  assert.equal(rawOrder.total, 2.5);
  assert.equal(rawOrder.items[0].unitPriceApplied, 2.5);

  const staleCreated = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: "rel-order-price-manager",
    tableId: "room_pedana_t06",
    tableNumber: 6,
    extraPayload: { idempotencyKey: "mp4bb-price-override-stale-create" },
  });
  assert.equal(staleCreated.response.status, 200);
  await lockForPriceOverride(baseUrl, manager, staleCreated.body.order.tableId);
  await withRelationalDb(relationalPath, (db) => {
    db.prepare("UPDATE orders SET revision = 99 WHERE id = ?").run(staleCreated.body.order.id);
  });
  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/line/price-override",
    authPayload(manager, "rel-order-price-manager", {
      orderId: staleCreated.body.order.id,
      lineId: staleCreated.body.order.items[0].lineId,
      unitPriceApplied: 2.5,
      listPriceAtTime: 2.5,
      reason: "Test override stale",
      expectedRevision: staleCreated.body.order.revision,
    }),
  );

  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === staleCreated.body.order.id);
  assert.equal(mirrored.revision, 1);
  assert.equal(mirrored.total, staleCreated.body.order.total);
  assert.notEqual(mirrored.items[0].unitPriceApplied, 2.5);
});
