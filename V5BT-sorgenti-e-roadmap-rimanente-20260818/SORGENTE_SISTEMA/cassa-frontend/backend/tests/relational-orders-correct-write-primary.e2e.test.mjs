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

async function lockForCorrection(baseUrl, session, deviceUuid, tableId) {
  const locked = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId, purpose: "order.correction" }),
  );
  assert.equal(locked.response.status, 200);
}

test("[BE][I4] order correct scrive primary relazionale con CAS", async (t) => {
  const runDir = await createTempRunDir("rel-order-correct-i4");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-correct-cashier",
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-correct-cashier",
    extraPayload: { idempotencyKey: "i4-order-correct-create" },
  });
  assert.equal(created.response.status, 200);
  await lockForCorrection(baseUrl, cashier, "rel-order-correct-cashier", created.body.order.tableId);
  const corrected = await apiPost(
    baseUrl,
    "/api/integration/orders/correct",
    authPayload(cashier, "rel-order-correct-cashier", {
      orderId: created.body.order.id,
      tableId: created.body.order.tableId,
      roomId: created.body.order.roomId,
      expectedRevision: 1,
      addedItems: [{ productId: "menu_caffetteria_cappuccino", quantity: 1 }],
      changedItems: [
        {
          lineId: created.body.order.items[0].lineId,
          nextQuantity: 1,
          nextUnitPrices: [0],
        },
      ],
      idempotencyKey: "i4-order-correct",
    }),
  );

  assert.equal(corrected.response.status, 200);
  assert.equal(corrected.body.order.revision, 2);
  assert.equal(corrected.body.correction.previousRevision, 1);
  assert.equal(corrected.body.correction.nextRevision, 2);
  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, revision, raw_json FROM orders WHERE id = ?").get(created.body.order.id),
    { readOnly: true },
  );
  const relationalLines = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT COUNT(*) AS count FROM order_lines WHERE order_id = ?").get(created.body.order.id),
    { readOnly: true },
  );
  const rawOrder = JSON.parse(relationalOrder.raw_json);
  assert.equal(relationalOrder.revision, 2);
  assert.equal(rawOrder.currentRevision, 2);
  assert.equal(rawOrder.lastCorrectionId, corrected.body.correction.correctionId);
  const zeroPriceItem = rawOrder.items.find(
    (item) => item.lineId === created.body.order.items[0].lineId,
  );
  assert.equal(zeroPriceItem.unitPriceApplied, 0);
  assert.equal(zeroPriceItem.lineTotal, 0);
  assert.equal(zeroPriceItem.priceOverrideApplied, true);
  assert.equal(relationalLines.count, 2);
  const second = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-correct-cashier",
    tableId: "room_pedana_t06",
    tableNumber: 6,
    extraPayload: { idempotencyKey: "i4-order-correct-stale-create" },
  });
  assert.equal(second.response.status, 200);
  await lockForCorrection(baseUrl, cashier, "rel-order-correct-cashier", second.body.order.tableId);
  await withRelationalDb(relationalPath, (db) => {
    db.prepare("UPDATE orders SET revision = 99 WHERE id = ?").run(second.body.order.id);
  });
  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/correct",
    authPayload(cashier, "rel-order-correct-cashier", {
      orderId: second.body.order.id,
      tableId: second.body.order.tableId,
      roomId: second.body.order.roomId,
      expectedRevision: 1,
      addedItems: [{ productId: "menu_caffetteria_cappuccino", quantity: 1 }],
      idempotencyKey: "i4-order-correct-stale",
    }),
  );

  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === second.body.order.id);
  assert.equal(mirrored.revision, 1);
  assert.equal(mirrored.lastCorrectionId, null);
});
