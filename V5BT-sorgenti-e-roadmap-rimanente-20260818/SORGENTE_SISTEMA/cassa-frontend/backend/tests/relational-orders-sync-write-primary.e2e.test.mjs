import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  apiPost,
  authHeaders,
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

test("[BE][I4] order sync scrive primary relazionale con CAS", async (t) => {
  const runDir = await createTempRunDir("rel-order-sync-i4");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
      RUNTIME_METRICS: "1",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-sync-cashier",
    clientApp: "mobile-frontend",
  });
  const station = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-sync-station",
    clientApp: "postazione",
  });
  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    deviceUuid: "rel-order-sync-admin",
    clientApp: "cassa-frontend",
  });
  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-sync-cashier",
    extraPayload: { idempotencyKey: "i4-order-sync" },
  });
  assert.equal(created.response.status, 200);

  const synced = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(station, "rel-order-sync-station", {
      id: created.body.order.id,
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
  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, status, revision, raw_json FROM orders WHERE id = ?").get(created.body.order.id),
    { readOnly: true },
  );
  const relationalLine = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT prepared_quantity FROM order_lines WHERE order_id = ?").get(created.body.order.id),
    { readOnly: true },
  );
  assert.equal(relationalOrder.revision, 2);
  assert.equal(relationalOrder.status, synced.body.order.workflowStatus);
  assert.equal(JSON.parse(relationalOrder.raw_json).currentRevision, 2);
  assert.equal(relationalLine.prepared_quantity, 1);
  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(admin, "rel-order-sync-admin"),
  });
  assert.equal(metricsResponse.status, 200);
  const metricsBody = await metricsResponse.json();
  assert.equal(
    metricsBody.runtimeMetrics.operations.runMsByLabel[
      "orderWorkflow:orders.sync.relationalSnapshotRead"
    ]?.count >= 1,
    true,
  );

  await withRelationalDb(relationalPath, (db) => {
    const row = db.prepare("SELECT raw_json FROM orders WHERE id = ?").get(created.body.order.id);
    const raw = JSON.parse(row.raw_json);
    raw.workflowStatus = "waiting";
    raw.revision = 99;
    raw.currentRevision = 99;
    db.prepare("UPDATE orders SET status = ?, revision = ?, raw_json = ? WHERE id = ?").run(
      "waiting",
      99,
      JSON.stringify(raw),
      created.body.order.id,
    );
  });
  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(station, "rel-order-sync-station", {
      id: created.body.order.id,
      clientApp: "postazione",
      workflowReason: "station_ready",
      order: {
        ...created.body.order,
        workflowStatus: "ready",
        items: created.body.order.items.map((item) => ({ ...item, done: true })),
      },
    })
  );

  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === created.body.order.id);
  assert.equal(mirrored.revision, 2);
});
