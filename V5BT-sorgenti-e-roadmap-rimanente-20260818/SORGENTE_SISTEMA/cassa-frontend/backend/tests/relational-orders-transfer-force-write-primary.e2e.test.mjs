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

test("[BE][MP-4bc] transfer/force scrive primary relazionale con CAS", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-force");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "rel-order-transfer-force-manager",
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: "rel-order-transfer-force-manager",
    extraPayload: { idempotencyKey: "mp4bc-transfer-force-create" },
  });
  assert.equal(created.response.status, 200);
  const forced = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/force",
    authPayload(manager, "rel-order-transfer-force-manager", {
      orderId: created.body.order.id,
      toStation: "COCKTAIL",
      operatorName: "Manager Test",
      operatorRole: "Responsabile",
      expectedRevision: created.body.order.revision,
    }),
  );

  assert.equal(forced.response.status, 200);
  assert.equal(forced.body.order.revision, 2);
  assert.equal(forced.body.order.currentRevision, 2);
  assert.equal(forced.body.order.station, "COCKTAIL");
  assert.equal(forced.body.order.assignedStationId, "COCKTAIL");
  assert.equal(forced.body.order.pendingAuthRequest, null);
  assert.equal(forced.body.order.assignmentReason, "manual_transfer");
  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, revision, raw_json FROM orders WHERE id = ?").get(created.body.order.id),
    { readOnly: true },
  );
  const rawOrder = JSON.parse(relationalOrder.raw_json);
  assert.equal(relationalOrder.revision, 2);
  assert.equal(rawOrder.currentRevision, 2);
  assert.equal(rawOrder.station, "COCKTAIL");
  assert.equal(rawOrder.assignmentReason, "manual_transfer");

  const staleCreated = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: "rel-order-transfer-force-manager",
    tableId: "room_pedana_t06",
    tableNumber: 6,
    extraPayload: { idempotencyKey: "mp4bc-transfer-force-stale-create" },
  });
  assert.equal(staleCreated.response.status, 200);
  await withRelationalDb(relationalPath, (db) => {
    db.prepare("UPDATE orders SET revision = 99 WHERE id = ?").run(staleCreated.body.order.id);
  });
  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/force",
    authPayload(manager, "rel-order-transfer-force-manager", {
      orderId: staleCreated.body.order.id,
      toStation: "COCKTAIL",
      operatorName: "Manager Test",
      operatorRole: "Responsabile",
      expectedRevision: staleCreated.body.order.revision,
    }),
  );

  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === staleCreated.body.order.id);
  assert.equal(mirrored.revision, 1);
  assert.notEqual(mirrored.station, "COCKTAIL");
  assert.notEqual(mirrored.assignmentReason, "manual_transfer");
});
