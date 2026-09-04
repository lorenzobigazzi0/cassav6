import assert from "node:assert/strict";
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
import { OrdersRelationalRepository } from "../db/relational/index.js";

async function withRelationalDb(relationalPath, callback, options = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: options.readOnly === true });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

async function lockForLineSplit(baseUrl, session, deviceUuid, tableId) {
  const locked = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, {
      tableId,
      purpose: "order.line_split",
    }),
  );
  assert.equal(locked.response.status, 200);
}

async function readTableState(relationalPath, tableId) {
  return withRelationalDb(
    relationalPath,
    (db) =>
      db
        .prepare(
          "SELECT table_id, room_id, status, covers, total_due_cents, total_paid_cents, revision, raw_json FROM table_states WHERE table_id = ?",
        )
        .get(tableId),
    { readOnly: true },
  );
}

test("[BE][MP-4au] line split scrive primary relazionale con CAS", async (t) => {
  const runDir = await createTempRunDir("rel-order-line-split-i4");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-line-split-cashier",
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-line-split-cashier",
    lines: [
      {
        name: "Caffe",
        productId: "menu_caffetteria_caffe",
        qty: 2,
        price: 1.3,
      },
    ],
    extraPayload: { idempotencyKey: "i4-order-line-split-create" },
  });
  assert.equal(created.response.status, 200);
  const originalLineId = created.body.order.items[0].lineId;
  await lockForLineSplit(
    baseUrl,
    cashier,
    "rel-order-line-split-cashier",
    created.body.order.tableId,
  );
  const tableStateBeforeSplit = await readTableState(relationalPath, created.body.order.tableId);
  assert.ok(tableStateBeforeSplit, "la creazione ordine deve avere table_state relazionale");
  const split = await apiPost(
    baseUrl,
    "/api/integration/orders/line/split",
    authPayload(cashier, "rel-order-line-split-cashier", {
      orderId: created.body.order.id,
      lineId: originalLineId,
      qty: 1,
      markDelivered: true,
      expectedRevision: created.body.order.revision,
    }),
  );

  assert.equal(split.response.status, 200);
  assert.equal(split.body.order.revision, 2);
  assert.equal(split.body.order.currentRevision, 2);
  assert.notEqual(split.body.newLineId, originalLineId);
  assert.equal(split.body.order.total, created.body.order.total);
  assert.equal(split.body.order.dueAmount, created.body.order.dueAmount);
  assert.equal(
    split.body.order.items.filter((item) => item.lineId === originalLineId).length,
    1,
  );
  assert.equal(
    split.body.order.items.filter((item) => item.lineId === split.body.newLineId).length,
    1,
  );
  assert.ok(
    split.body.order.items.some((item) => item.lineId === split.body.newLineId && item.done === true),
    "la riga splittata deve poter essere marcata consegnata",
  );
  assert.deepEqual(
    await readTableState(relationalPath, created.body.order.tableId),
    tableStateBeforeSplit,
    "line/split non deve modificare il table_state finanziario",
  );

  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, total_cents, revision, raw_json FROM orders WHERE id = ?").get(created.body.order.id),
    { readOnly: true },
  );
  const relationalLines = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, raw_json FROM order_lines WHERE order_id = ? ORDER BY id ASC").all(created.body.order.id),
    { readOnly: true },
  );
  const rawOrder = JSON.parse(relationalOrder.raw_json);
  assert.equal(relationalOrder.revision, 2);
  assert.equal(relationalOrder.total_cents, 260);
  assert.equal(rawOrder.currentRevision, 2);
  assert.equal(rawOrder.revision, 2);
  assert.equal(relationalLines.length, 2);
  assert.ok(rawOrder.items.some((item) => item.lineId === originalLineId));
  assert.ok(rawOrder.items.some((item) => item.lineId === split.body.newLineId && item.done === true));

  const missingMirror = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-line-split-cashier",
    tableId: "room_pedana_t07",
    tableNumber: 7,
    lines: [
      {
        name: "Caffe",
        productId: "menu_caffetteria_caffe",
        qty: 2,
        price: 1.3,
      },
    ],
    extraPayload: { idempotencyKey: "i4-order-line-split-missing-mirror-create" },
  });
  assert.equal(missingMirror.response.status, 200);
  const missingMirrorRelational = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, revision, raw_json FROM orders WHERE id = ?").get(missingMirror.body.order.id),
    { readOnly: true },
  );
  assert.equal(missingMirrorRelational.id, missingMirror.body.order.id);
  assert.equal(missingMirrorRelational.revision, 1);
  await lockForLineSplit(
    baseUrl,
    cashier,
    "rel-order-line-split-cashier",
    missingMirror.body.order.tableId,
  );
  const appStateWithStaleMirror = await readJson(dbPath);
  const staleMirrorOrder = appStateWithStaleMirror.integration.orders.find(
    (order) => order.id === missingMirror.body.order.id,
  );
  assert.ok(staleMirrorOrder);
  staleMirrorOrder.items = staleMirrorOrder.items.slice(0, 1);
  await fs.writeFile(dbPath, `${JSON.stringify(appStateWithStaleMirror, null, 2)}\n`, "utf8");
  const missingMirrorRelationalBeforeSplit = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id, revision, raw_json FROM orders WHERE id = ?").get(missingMirror.body.order.id),
    { readOnly: true },
  );
  assert.equal(missingMirrorRelationalBeforeSplit.id, missingMirror.body.order.id);
  const missingMirrorRawBeforeSplit = JSON.parse(missingMirrorRelationalBeforeSplit.raw_json);
  assert.equal(missingMirrorRawBeforeSplit.items.length, 2);
  assert.equal(
    missingMirrorRawBeforeSplit.items.filter((item) => item.lineId === missingMirror.body.order.items[0].lineId).length,
    2,
  );
  const hydratedMissingMirrorBeforeSplit = await withRelationalDb(
    relationalPath,
    (db) => new OrdersRelationalRepository(db).getOrderById(missingMirror.body.order.id),
    { readOnly: true },
  );
  assert.equal(
    hydratedMissingMirrorBeforeSplit.items.filter((item) => item.lineId === missingMirror.body.order.items[0].lineId).length,
    2,
  );
  const splitFromRelationalReadModel = await apiPost(
    baseUrl,
    "/api/integration/orders/line/split",
    authPayload(cashier, "rel-order-line-split-cashier", {
      orderId: missingMirror.body.order.id,
      lineId: missingMirror.body.order.items[0].lineId,
      qty: 2,
      markDelivered: true,
      expectedRevision: missingMirror.body.order.revision,
    }),
  );
  assert.equal(
    splitFromRelationalReadModel.response.status,
    200,
    JSON.stringify(splitFromRelationalReadModel.body),
  );
  assert.equal(splitFromRelationalReadModel.body.order.revision, 2);
  assert.notEqual(
    splitFromRelationalReadModel.body.newLineId,
    missingMirror.body.order.items[0].lineId,
  );
  const restoredMirrorState = await readJson(dbPath);
  const restoredMirror = restoredMirrorState.integration.orders.find(
    (order) => order.id === missingMirror.body.order.id,
  );
  assert.equal(restoredMirror.revision, 2);
  assert.equal(restoredMirror.items.length, 2);
  assert.equal(
    restoredMirror.items.filter((item) => item.lineId === splitFromRelationalReadModel.body.newLineId).length,
    2,
  );

  const second = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-line-split-cashier",
    tableId: "room_pedana_t08",
    tableNumber: 8,
    lines: [
      {
        name: "Caffe",
        productId: "menu_caffetteria_caffe",
        qty: 2,
        price: 1.3,
      },
    ],
    extraPayload: { idempotencyKey: "i4-order-line-split-stale-create" },
  });
  assert.equal(second.response.status, 200);
  await lockForLineSplit(
    baseUrl,
    cashier,
    "rel-order-line-split-cashier",
    second.body.order.tableId,
  );
  await withRelationalDb(relationalPath, (db) => {
    db.prepare("UPDATE orders SET revision = 99 WHERE id = ?").run(second.body.order.id);
  });
  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/line/split",
    authPayload(cashier, "rel-order-line-split-cashier", {
      orderId: second.body.order.id,
      lineId: second.body.order.items[0].lineId,
      qty: 1,
      markDelivered: true,
      expectedRevision: second.body.order.revision,
    }),
  );

  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");
  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === second.body.order.id);
  assert.equal(mirrored.revision, 1);
  assert.equal(mirrored.items.length, 2);
  assert.equal(new Set(mirrored.items.map((item) => item.lineId)).size, 1);
});
