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

async function lockTable(baseUrl, session, deviceUuid, tableId) {
  const result = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId, purpose: "order.cancel" }),
  );
  assert.equal(result.response.status, 200);
}

test("[BE][P3.74] layout non conserva ordini attivi dalla cache di un altro worker", async (t) => {
  const root = await createTempRunDir("rel-layout-orders-primary");
  const relationalPath = path.join(root, "backend-relational.sqlite");
  const commonEnv = {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "shadow",
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
    BACKEND_RELATIONAL_SHADOW_SYNC_ENABLED: "0",
    BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_ORDERS_READ_PRIMARY: "1",
    BACKEND_RELATIONAL_LAYOUT_ORDERS_READ_PRIMARY: "1",
    BACKEND_RELATIONAL_TABLES_READ_PRIMARY: "1",
    BACKEND_RELATIONAL_LAYOUT_TABLES_READ_PRIMARY: "1",
    INTEGRATION_LAYOUT_FAST_CACHE_MS: "1",
    PRINTING_ENABLED: "0",
  };
  const firstRunDir = path.join(root, "worker-a");
  const firstDbPath = path.join(firstRunDir, "app-state.json");
  const first = await startBackend(t, {
    runDir: firstRunDir,
    dbPath: firstDbPath,
    env: commonEnv,
  });
  const firstSession = await loginJson(first.baseUrl, "cashier", "2222", {
    deviceUuid: "layout-worker-a",
    clientApp: "mobile-frontend",
  });
  const created = await createSimpleOrder(first.baseUrl, firstSession, {
    deviceUuid: "layout-worker-a",
    extraPayload: { idempotencyKey: "p3-74-layout-stale-worker" },
  });
  assert.equal(created.response.status, 200);

  const secondRunDir = path.join(root, "worker-b");
  const second = await startBackend(t, {
    runDir: secondRunDir,
    dbPath: path.join(secondRunDir, "app-state.json"),
    env: commonEnv,
  });
  const secondSession = await loginJson(second.baseUrl, "cashier", "2222", {
    deviceUuid: "layout-worker-b",
    clientApp: "mobile-frontend",
  });
  await lockTable(second.baseUrl, secondSession, "layout-worker-b", created.body.order.tableId);
  const cancelled = await apiPost(
    second.baseUrl,
    "/api/integration/orders/cancel",
    authPayload(secondSession, "layout-worker-b", {
      orderId: created.body.order.id,
      tableId: created.body.order.tableId,
      roomId: created.body.order.roomId,
      expectedRevision: 1,
      reason: "P3.74 cross-worker layout",
    }),
  );
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.order.workflowStatus, "cancelled");

  const staleMirror = await readJson(firstDbPath);
  assert.equal(
    staleMirror.integration.orders.find((order) => order.id === created.body.order.id)?.workflowStatus,
    "waiting",
  );
  const layoutResponse = await fetch(`${first.baseUrl}/api/integration/layout`);
  assert.equal(layoutResponse.status, 200);
  const layout = await layoutResponse.json();
  const table = layout.tables.find((entry) => entry.id === created.body.order.tableId);
  assert.ok(table);
  assert.equal(table.ordersInProgress, 0);
  assert.equal((table.orderHistory ?? []).length, 0);
});
