import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
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

async function lockForCancel(baseUrl, session, deviceUuid, tableId) {
  const locked = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId, purpose: "order.cancel" }),
  );
  assert.equal(locked.response.status, 200);
}

test("[BE][I4] order cancel scrive primary relazionale con CAS", async (t) => {
  const runDir = await createTempRunDir("rel-order-cancel-i4");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-cancel-cashier",
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-cancel-cashier",
    extraPayload: { idempotencyKey: "i4-order-cancel" },
  });
  assert.equal(created.response.status, 200);
  await lockForCancel(baseUrl, cashier, "rel-order-cancel-cashier", created.body.order.tableId);
  const cancelled = await apiPost(
    baseUrl,
    "/api/integration/orders/cancel",
    authPayload(cashier, "rel-order-cancel-cashier", {
      orderId: created.body.order.id,
      tableId: created.body.order.tableId,
      roomId: created.body.order.roomId,
      expectedRevision: 1,
      reason: "Test cancel write-primary",
    }),
  );

  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.order.workflowStatus, "cancelled");
  assert.equal(cancelled.body.order.revision, 2);
  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, status, revision, raw_json FROM orders WHERE id = ?").get(created.body.order.id),
    { readOnly: true },
  );
  assert.equal(relationalOrder.status, "cancelled");
  assert.equal(relationalOrder.revision, 2);
  assert.equal(JSON.parse(relationalOrder.raw_json).currentRevision, 2);
  const relationalTableState = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT table_id, total_due_cents, revision FROM table_states WHERE table_id = ?").get(created.body.order.tableId),
    { readOnly: true },
  );
  assert.equal(relationalTableState.revision, 3);
  assert.equal(relationalTableState.total_due_cents, 0);

  const second = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-cancel-cashier",
    tableId: "room_pedana_t06",
    tableNumber: 6,
    extraPayload: { idempotencyKey: "i4-order-cancel-stale" },
  });
  assert.equal(second.response.status, 200);
  await lockForCancel(baseUrl, cashier, "rel-order-cancel-cashier", second.body.order.tableId);
  await withRelationalDb(relationalPath, (db) => {
    db.prepare("UPDATE orders SET revision = 99 WHERE id = ?").run(second.body.order.id);
  });
  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/cancel",
    authPayload(cashier, "rel-order-cancel-cashier", {
      orderId: second.body.order.id,
      tableId: second.body.order.tableId,
      roomId: second.body.order.roomId,
      expectedRevision: 1,
      reason: "Test cancel stale",
    }),
  );

  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === second.body.order.id);
  assert.equal(mirrored.workflowStatus, "waiting");
  assert.equal(mirrored.revision, 99);
});

test("[BE][MP-4ae] order cancel recupera dal relazionale se il mirror app-state non contiene la comanda", async (t) => {
  const runDir = await createTempRunDir("rel-order-cancel-lookup");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const dbPath = path.join(runDir, "app-state.json");
  const env = {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "shadow",
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
    BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_SHADOW_SYNC_ENABLED: "0",
    PRINTING_ENABLED: "0",
    RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
  };
  const firstBackend = await startBackend(t, { runDir, dbPath, env });
  const cashier = await loginJson(firstBackend.baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-cancel-lookup",
    clientApp: "mobile-frontend",
  });
  const created = await createSimpleOrder(firstBackend.baseUrl, cashier, {
    deviceUuid: "rel-order-cancel-lookup",
    extraPayload: { idempotencyKey: "mp4ae-order-cancel-lookup" },
  });
  assert.equal(created.response.status, 200);
  firstBackend.child.kill("SIGTERM");
  await once(firstBackend.child, "exit");

  const mirroredState = await readJson(dbPath);
  mirroredState.integration.orders = mirroredState.integration.orders.filter(
    (order) => order.id !== created.body.order.id,
  );
  await fs.writeFile(dbPath, `${JSON.stringify(mirroredState, null, 2)}\n`, "utf8");

  const secondBackend = await startBackend(t, { runDir, dbPath, preserveDb: true, env });
  const secondSession = await loginJson(secondBackend.baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-cancel-lookup",
    clientApp: "mobile-frontend",
  });
  await lockForCancel(secondBackend.baseUrl, secondSession, "rel-order-cancel-lookup", created.body.order.tableId);
  const cancelled = await apiPost(
    secondBackend.baseUrl,
    "/api/integration/orders/cancel",
    authPayload(secondSession, "rel-order-cancel-lookup", {
      orderId: created.body.order.id,
      tableId: created.body.order.tableId,
      roomId: created.body.order.roomId,
      expectedRevision: 1,
      reason: "Test cancel lookup relazionale",
    }),
  );

  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.order.workflowStatus, "cancelled");
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === created.body.order.id);
  assert.equal(mirrored.workflowStatus, "cancelled");
  assert.equal(mirrored.revision, 2);
});
