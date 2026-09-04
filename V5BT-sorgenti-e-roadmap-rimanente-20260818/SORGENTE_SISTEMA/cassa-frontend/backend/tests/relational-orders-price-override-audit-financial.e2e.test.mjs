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

const DEVICE_UUID = "rel-order-price-audit-manager";

const BASE_ENV = {
  BACKEND_RELATIONAL_ENABLED: "1",
  BACKEND_RELATIONAL_MODE: "shadow",
  BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
  BACKEND_RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY: "1",
  PRINTING_ENABLED: "0",
  RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
};

async function withRelationalDb(relationalPath, callback, options = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: options.readOnly === true });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function listPriceOverrideEvents(relationalPath, orderId) {
  return withRelationalDb(
    relationalPath,
    (db) =>
      db
        .prepare("SELECT id, event_type, actor_user_id, payload_json FROM order_events WHERE order_id = ? AND event_type = 'order.line_price_overridden' ORDER BY id ASC")
        .all(orderId),
    { readOnly: true },
  );
}

function readTableState(relationalPath, tableId) {
  return withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT table_id, total_due_cents, revision FROM table_states WHERE table_id = ?").get(tableId),
    { readOnly: true },
  );
}

async function lockForPriceOverride(baseUrl, session, tableId) {
  const locked = await acquireTableLock(baseUrl, session, tableId, {
    deviceUuid: DEVICE_UUID,
    purpose: "order.price_override",
  });
  assert.equal(locked.response.status, 200);
}

function overridePayload(manager, order, lineId, overrides = {}) {
  return authPayload(manager, DEVICE_UUID, {
    orderId: order.id,
    lineId,
    unitPriceApplied: 2.5,
    listPriceAtTime: 2.5,
    reason: "Audit financial override",
    expectedRevision: order.revision,
    ...overrides,
  });
}

test("[BE][MP-4bh] override scrive un solo audit event deterministico e preserva l'audit app-state", async (t) => {
  const runDir = await createTempRunDir("rel-order-price-audit");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: { ...BASE_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE_UUID,
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: DEVICE_UUID,
    extraPayload: { idempotencyKey: "mp4bh-price-audit-create" },
  });
  assert.equal(created.response.status, 200);
  const order = created.body.order;
  const lineId = order.items[0].lineId;
  await lockForPriceOverride(baseUrl, manager, order.tableId);

  const payload = overridePayload(manager, order, lineId);
  const override = await apiPost(baseUrl, "/api/integration/orders/line/price-override", payload);
  assert.equal(override.response.status, 200);
  assert.equal(override.body.order.revision, 2);

  const events = await listPriceOverrideEvents(relationalPath, order.id);
  assert.equal(events.length, 1, "deve esistere esattamente un audit event price-override");
  assert.equal(events[0].id, `${order.id}:${lineId}:order.line_price_overridden:2`);
  assert.equal(events[0].actor_user_id, manager.user.id);
  const eventPayload = JSON.parse(events[0].payload_json);
  assert.equal(eventPayload.unitPriceApplied, 2.5);
  assert.equal(eventPayload.previousUnitPrice, order.items[0].unitPriceApplied);
  assert.equal(eventPayload.revision, 2);

  const retry = await apiPost(baseUrl, "/api/integration/orders/line/price-override", payload);
  assert.equal(retry.response.status, 409, "il retry con la stessa expectedRevision deve fallire sul CAS");
  assert.equal((await listPriceOverrideEvents(relationalPath, order.id)).length, 1, "il retry non deve duplicare l'audit event");

  const persisted = await readJson(dbPath);
  const appStateAudit = persisted.auditEvents.filter(
    (event) => event.action === "order.line_price_overridden" && event.entityId === `${order.id}:${lineId}`,
  );
  assert.equal(appStateAudit.length, 1, "l'audit app-state per i report deve restare presente (contratto reports)");
});

test("[BE][MP-4bh] financial-sync da snapshot relazionale aggiorna table_state con revision guard", async (t) => {
  const runDir = await createTempRunDir("rel-order-price-financial");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    env: {
      ...BASE_ENV,
      BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE_UUID,
    clientApp: "mobile-frontend",
  });
  const station = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: `${DEVICE_UUID}-station`,
    clientApp: "postazione",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: DEVICE_UUID,
    extraPayload: { idempotencyKey: "mp4bh-price-financial-create" },
  });
  assert.equal(created.response.status, 200);
  const order = created.body.order;

  // Il dovuto tavolo matura alla consegna: consegna prima dell'override.
  const synced = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(station, `${DEVICE_UUID}-station`, {
      id: order.id,
      clientApp: "postazione",
      workflowReason: "mp4bh_financial_delivered",
      order: { ...order, workflowStatus: "delivered", items: order.items.map((item) => ({ ...item, done: true })) },
    }),
  );
  assert.equal(synced.response.status, 200);
  assert.equal(synced.body.order.workflowStatus, "delivered");
  const tableStateBefore = await readTableState(relationalPath, order.tableId);
  assert.equal(tableStateBefore.total_due_cents, 130, "dopo la consegna il dovuto tavolo riflette il prezzo originale");

  await lockForPriceOverride(baseUrl, manager, order.tableId);
  const override = await apiPost(
    baseUrl,
    "/api/integration/orders/line/price-override",
    overridePayload(manager, synced.body.order, order.items[0].lineId, { unitPriceApplied: 4, listPriceAtTime: 4, expectedRevision: synced.body.order.revision }),
  );
  assert.equal(override.response.status, 200);
  assert.equal(override.body.order.total, 4);

  const tableStateAfter = await readTableState(relationalPath, order.tableId);
  assert.equal(tableStateAfter.total_due_cents, 400, "il dovuto tavolo deve riflettere il nuovo prezzo");
  assert.ok(
    Number(tableStateAfter.revision) > Number(tableStateBefore.revision),
    "la revisione table_state deve avanzare con il guard anti-stale",
  );
});

test("[BE][MP-4bh] 409 stantio: zero audit event, table_state e mirror invariati", async (t) => {
  const runDir = await createTempRunDir("rel-order-price-reject");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: { ...BASE_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE_UUID,
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: DEVICE_UUID,
    extraPayload: { idempotencyKey: "mp4bh-price-reject-create" },
  });
  assert.equal(created.response.status, 200);
  const order = created.body.order;
  await lockForPriceOverride(baseUrl, manager, order.tableId);
  const tableStateBefore = await readTableState(relationalPath, order.tableId);
  await withRelationalDb(relationalPath, (db) => {
    db.prepare("UPDATE orders SET revision = 99 WHERE id = ?").run(order.id);
  });

  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/line/price-override",
    overridePayload(manager, order, order.items[0].lineId),
  );
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");

  assert.equal((await listPriceOverrideEvents(relationalPath, order.id)).length, 0, "nessun audit event sul 409");
  const tableStateAfter = await readTableState(relationalPath, order.tableId);
  assert.equal(tableStateAfter.total_due_cents, tableStateBefore.total_due_cents, "table_state invariato sul 409");
  assert.equal(tableStateAfter.revision, tableStateBefore.revision);
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((entry) => entry.id === order.id);
  assert.equal(mirrored.revision, 1, "mirror non scritto sul 409");
  assert.notEqual(mirrored.items[0].unitPriceApplied, 2.5);
});
