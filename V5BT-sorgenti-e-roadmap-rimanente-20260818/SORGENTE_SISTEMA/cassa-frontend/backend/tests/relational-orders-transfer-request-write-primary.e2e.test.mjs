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

test("[BE][MP-4az] transfer/request scrive primary relazionale con CAS", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-request");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "rel-order-transfer-manager",
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: "rel-order-transfer-manager",
    extraPayload: { idempotencyKey: "mp4az-transfer-request-create" },
  });
  assert.equal(created.response.status, 200);
  const request = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/request",
    authPayload(manager, "rel-order-transfer-manager", {
      orderId: created.body.order.id,
      mode: "transfer",
      requesterStation: "COCKTAIL",
      targetStation: "COCKTAIL",
      requesterOperator: "Manager Test",
      requesterRole: "Responsabile",
      expectedRevision: created.body.order.revision,
    }),
  );

  assert.equal(request.response.status, 200);
  assert.equal(request.body.order.revision, 2);
  assert.equal(request.body.order.currentRevision, 2);
  assert.equal(request.body.order.pendingAuthRequest.toStation, "COCKTAIL");
  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, revision, raw_json FROM orders WHERE id = ?").get(created.body.order.id),
    { readOnly: true },
  );
  const rawOrder = JSON.parse(relationalOrder.raw_json);
  assert.equal(relationalOrder.revision, 2);
  assert.equal(rawOrder.currentRevision, 2);
  assert.equal(rawOrder.pendingAuthRequest.toStation, "COCKTAIL");

  const staleCreated = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: "rel-order-transfer-manager",
    tableId: "room_pedana_t06",
    tableNumber: 6,
    extraPayload: { idempotencyKey: "mp4az-transfer-request-stale-create" },
  });
  assert.equal(staleCreated.response.status, 200);
  await withRelationalDb(relationalPath, (db) => {
    db.prepare("UPDATE orders SET revision = 99 WHERE id = ?").run(staleCreated.body.order.id);
  });
  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/request",
    authPayload(manager, "rel-order-transfer-manager", {
      orderId: staleCreated.body.order.id,
      mode: "transfer",
      requesterStation: "COCKTAIL",
      targetStation: "COCKTAIL",
      requesterOperator: "Manager Test",
      requesterRole: "Responsabile",
      expectedRevision: staleCreated.body.order.revision,
    }),
  );

  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === staleCreated.body.order.id);
  assert.equal(mirrored.revision, 1);
  assert.equal(mirrored.pendingAuthRequest, null);
});
