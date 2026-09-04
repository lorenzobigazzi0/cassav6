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

async function requestTransfer(baseUrl, manager, order, suffix) {
  const request = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/request",
    authPayload(manager, "rel-order-transfer-resolve-manager", {
      orderId: order.id,
      mode: "transfer",
      requesterStation: "COCKTAIL",
      targetStation: "COCKTAIL",
      requesterOperator: "Manager Test",
      requesterRole: "Responsabile",
      expectedRevision: order.revision,
      idempotencyKey: `mp4ba-transfer-request-${suffix}`,
    }),
  );
  assert.equal(request.response.status, 200);
  return request.body.order;
}

test("[BE][MP-4ba] transfer/resolve scrive primary relazionale con CAS", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-resolve");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "rel-order-transfer-resolve-manager",
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: "rel-order-transfer-resolve-manager",
    extraPayload: { idempotencyKey: "mp4ba-transfer-resolve-create" },
  });
  assert.equal(created.response.status, 200);
  const requestedOrder = await requestTransfer(baseUrl, manager, created.body.order, "ok");
  const resolve = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/resolve",
    authPayload(manager, "rel-order-transfer-resolve-manager", {
      orderId: requestedOrder.id,
      approve: true,
      approverStation: requestedOrder.pendingAuthRequest.fromStation,
      approverOperator: "Owner Test",
      expectedRevision: requestedOrder.revision,
    }),
  );

  assert.equal(resolve.response.status, 200);
  assert.equal(resolve.body.approved, true);
  assert.equal(resolve.body.order.revision, 3);
  assert.equal(resolve.body.order.currentRevision, 3);
  assert.equal(resolve.body.order.pendingAuthRequest, null);
  assert.equal(resolve.body.order.station, "COCKTAIL");
  assert.equal(resolve.body.order.assignmentReason, "manual_transfer");
  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, revision, raw_json FROM orders WHERE id = ?").get(created.body.order.id),
    { readOnly: true },
  );
  const rawOrder = JSON.parse(relationalOrder.raw_json);
  assert.equal(relationalOrder.revision, 3);
  assert.equal(rawOrder.currentRevision, 3);
  assert.equal(rawOrder.pendingAuthRequest, null);
  assert.equal(rawOrder.station, "COCKTAIL");

  const staleCreated = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: "rel-order-transfer-resolve-manager",
    tableId: "room_pedana_t06",
    tableNumber: 6,
    extraPayload: { idempotencyKey: "mp4ba-transfer-resolve-stale-create" },
  });
  assert.equal(staleCreated.response.status, 200);
  const staleRequestedOrder = await requestTransfer(baseUrl, manager, staleCreated.body.order, "stale");
  await withRelationalDb(relationalPath, (db) => {
    db.prepare("UPDATE orders SET revision = 99 WHERE id = ?").run(staleRequestedOrder.id);
  });
  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/resolve",
    authPayload(manager, "rel-order-transfer-resolve-manager", {
      orderId: staleRequestedOrder.id,
      approve: true,
      approverStation: staleRequestedOrder.pendingAuthRequest.fromStation,
      approverOperator: "Owner Test",
      expectedRevision: staleRequestedOrder.revision,
    }),
  );

  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === staleRequestedOrder.id);
  assert.equal(mirrored.revision, 2);
  assert.ok(mirrored.pendingAuthRequest);
});
