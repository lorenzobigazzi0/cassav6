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

const DEVICE_UUID = "rel-order-transfer-force-audit-manager";

async function withRelationalDb(relationalPath, callback, options = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: options.readOnly === true });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function listForceEvents(relationalPath, orderId) {
  return withRelationalDb(
    relationalPath,
    (db) =>
      db
        .prepare("SELECT id, event_type, actor_user_id, payload_json FROM order_events WHERE order_id = ? AND event_type = 'order.transfer_forced' ORDER BY id ASC")
        .all(orderId),
    { readOnly: true },
  );
}

function listOutboxPayloads(relationalPath) {
  return withRelationalDb(
    relationalPath,
    (db) =>
      db
        .prepare("SELECT event_type, aggregate_id, payload_json FROM event_outbox ORDER BY id ASC")
        .all()
        .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) })),
    { readOnly: true },
  );
}

test("[BE][MP-4bi] transfer/force scrive audit relazionale e notifica outbox", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-force-audit-outbox");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY: "1",
      EVENT_OUTBOX_ENABLED: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE_UUID,
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: DEVICE_UUID,
    extraPayload: { idempotencyKey: "mp4bi-force-audit-create" },
  });
  assert.equal(created.response.status, 200);

  const forced = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/force",
    authPayload(manager, DEVICE_UUID, {
      orderId: created.body.order.id,
      toStation: "COCKTAIL",
      operatorName: "Manager Test",
      operatorRole: "Responsabile",
      expectedRevision: created.body.order.revision,
    }),
  );

  assert.equal(forced.response.status, 200);
  assert.equal(forced.body.order.revision, 2);
  assert.equal(forced.body.order.station, "COCKTAIL");

  const events = await listForceEvents(relationalPath, created.body.order.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, `${created.body.order.id}:order.transfer_forced:2`);
  assert.equal(events[0].actor_user_id, manager.user.id);
  const payload = JSON.parse(events[0].payload_json);
  assert.equal(payload.fromStation, created.body.order.station);
  assert.equal(payload.toStation, "COCKTAIL");
  assert.equal(payload.operatorName, "Manager Test");
  assert.equal(payload.revision, 2);

  const outboxRows = await listOutboxPayloads(relationalPath);
  const forcedOutbox = outboxRows.find((row) => row.payload?.reason === "transfer_forced");
  assert.equal(forcedOutbox?.aggregate_id, created.body.order.id);
  assert.equal(forcedOutbox?.payload?.detail?.orderId, created.body.order.id);
  assert.equal(forcedOutbox?.payload?.detail?.toStation, "COCKTAIL");

  const staleCreated = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: DEVICE_UUID,
    tableId: "room_pedana_t06",
    tableNumber: 6,
    extraPayload: { idempotencyKey: "mp4bi-force-audit-stale-create" },
  });
  assert.equal(staleCreated.response.status, 200);
  await withRelationalDb(relationalPath, (db) => {
    db.prepare("UPDATE orders SET revision = 99 WHERE id = ?").run(staleCreated.body.order.id);
  });
  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/force",
    authPayload(manager, DEVICE_UUID, {
      orderId: staleCreated.body.order.id,
      toStation: "COCKTAIL",
      operatorName: "Manager Test",
      operatorRole: "Responsabile",
      expectedRevision: staleCreated.body.order.revision,
    }),
  );
  assert.equal(stale.response.status, 409);
  assert.equal((await listForceEvents(relationalPath, staleCreated.body.order.id)).length, 0);
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === staleCreated.body.order.id);
  assert.notEqual(mirrored.station, "COCKTAIL");
});
