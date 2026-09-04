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

async function lockForBarReplacement(baseUrl, session, deviceUuid, tableId) {
  const locked = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, {
      tableId,
      purpose: "bar_charge_replacement",
    }),
  );
  assert.equal(locked.response.status, 200);
}

test("[BE][MP-4ar] bar-charge replacement scrive primary relazionale con CAS", async (t) => {
  const runDir = await createTempRunDir("rel-order-bar-repl-i4");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-bar-repl-cashier",
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-bar-repl-cashier",
    extraPayload: { idempotencyKey: "i4-order-bar-repl-create" },
  });
  assert.equal(created.response.status, 200);
  await lockForBarReplacement(
    baseUrl,
    cashier,
    "rel-order-bar-repl-cashier",
    created.body.order.tableId,
  );
  const replaced = await apiPost(
    baseUrl,
    "/api/integration/orders/replacement/bar-charge",
    authPayload(cashier, "rel-order-bar-repl-cashier", {
      orderId: created.body.order.id,
      tableId: created.body.order.tableId,
      roomId: created.body.order.roomId,
      originalLineId: created.body.order.items[0].lineId,
      productId: created.body.order.items[0].productId,
      quantity: 1,
      reason: "Test bar replacement write-primary",
      idempotencyKey: "i4-order-bar-repl",
    }),
  );

  assert.equal(replaced.response.status, 200);
  assert.equal(replaced.body.order.revision, 2);
  assert.equal(replaced.body.order.currentRevision, 2);
  assert.equal(replaced.body.order.total, created.body.order.total);
  assert.equal(replaced.body.order.dueAmount, created.body.order.dueAmount);
  assert.equal(replaced.body.replacement.orderId, created.body.order.id);
  assert.equal(replaced.body.replacement.payable, false);
  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, total_cents, revision, raw_json FROM orders WHERE id = ?").get(created.body.order.id),
    { readOnly: true },
  );
  const relationalLines = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT COUNT(*) AS count FROM order_lines WHERE order_id = ?").get(created.body.order.id),
    { readOnly: true },
  );
  const rawOrder = JSON.parse(relationalOrder.raw_json);
  assert.equal(relationalOrder.revision, 2);
  assert.equal(relationalOrder.total_cents, 130);
  assert.equal(rawOrder.currentRevision, 2);
  assert.equal(rawOrder.revision, 2);
  assert.equal(relationalLines.count, 2);
  assert.ok(
    rawOrder.items.some((item) => item.lineType === "BAR_CHARGE_REPLACEMENT"),
    "il raw_json relazionale deve includere la riga di sostituzione banco",
  );

  const second = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-bar-repl-cashier",
    tableId: "room_pedana_t06",
    tableNumber: 6,
    extraPayload: { idempotencyKey: "i4-order-bar-repl-stale-create" },
  });
  assert.equal(second.response.status, 200);
  await lockForBarReplacement(
    baseUrl,
    cashier,
    "rel-order-bar-repl-cashier",
    second.body.order.tableId,
  );
  await withRelationalDb(relationalPath, (db) => {
    const escapedOrderId = String(second.body.order.id).replaceAll("'", "''");
    db.exec(`
      CREATE TRIGGER force_bar_replacement_cas_miss
      BEFORE UPDATE OF revision ON orders
      WHEN OLD.id = '${escapedOrderId}'
      BEGIN
        UPDATE orders SET revision = OLD.revision + 1 WHERE id = OLD.id;
        SELECT RAISE(IGNORE);
      END;
    `);
  });
  const stale = await apiPost(
    baseUrl,
    "/api/orders/replacement/bar-charge",
    authPayload(cashier, "rel-order-bar-repl-cashier", {
      orderId: second.body.order.id,
      tableId: second.body.order.tableId,
      roomId: second.body.order.roomId,
      originalLineId: second.body.order.items[0].lineId,
      productId: second.body.order.items[0].productId,
      quantity: 1,
      reason: "Test bar replacement stale",
      idempotencyKey: "i4-order-bar-repl-stale",
    }),
  );

  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === second.body.order.id);
  assert.equal(mirrored.revision, 1);
  assert.equal(mirrored.items.length, 1);
  assert.equal(
    persisted.integration.barChargeReplacements.some(
      (entry) => entry.idempotencyKey === "i4-order-bar-repl-stale",
    ),
    false,
  );
});
