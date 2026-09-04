import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createSimpleOrder,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

async function readRelationalOrdersSnapshot(relationalPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    return {
      orders: db.prepare("SELECT * FROM orders ORDER BY id ASC").all(),
      lines: db.prepare("SELECT * FROM order_lines ORDER BY id ASC").all(),
      events: db.prepare("SELECT * FROM order_events ORDER BY id ASC").all(),
      tableStates: db.prepare("SELECT * FROM table_states ORDER BY table_id ASC").all(),
    };
  } finally {
    db.close();
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("[BE][I4] order create scrive primary relazionale e ripara retry idempotente", async (t) => {
  const runDir = await createTempRunDir("rel-order-create-i4");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-create-device",
    clientApp: "mobile-frontend",
  });

  const first = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-create-device",
    extraPayload: { idempotencyKey: "i4-order-create-once" },
  });

  assert.equal(first.response.status, 200);
  const orderId = first.body.order.id;
  const firstRelational = await readRelationalOrdersSnapshot(relationalPath);
  assert.equal(firstRelational.orders.length, 1);
  assert.equal(firstRelational.orders[0].id, orderId);
  assert.equal(firstRelational.orders[0].revision, 1);
  assert.equal(firstRelational.lines.length, 1);
  assert.equal(firstRelational.events.some((row) => row.event_type === "order.created"), true);
  const firstTableState = firstRelational.tableStates.find(
    (row) => row.table_id === first.body.order.tableId,
  );
  assert.ok(firstTableState, "orders/create deve persistere lo stato tavolo relazionale");
  assert.equal(firstTableState.revision, 2);
  assert.equal(Number.isFinite(Number(firstTableState.total_due_cents)), true);

  const brokenMirror = await readJson(dbPath);
  brokenMirror.integration.orders = brokenMirror.integration.orders.filter(
    (order) => order.id !== orderId,
  );
  brokenMirror.integration.sequence.order = 1;
  await writeJson(dbPath, brokenMirror);

  const retry = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-create-device",
    extraPayload: { idempotencyKey: "i4-order-create-once" },
  });

  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.order.id, orderId);

  const healedMirror = await readJson(dbPath);
  const healedOrders = healedMirror.integration.orders.filter(
    (order) => order.idempotencyKey === "i4-order-create-once",
  );
  const secondRelational = await readRelationalOrdersSnapshot(relationalPath);
  assert.equal(healedOrders.length, 1);
  assert.equal(healedMirror.integration.sequence.order, Number(orderId) + 1);
  assert.equal(secondRelational.orders.length, 1);
  assert.equal(secondRelational.lines.length, 1);
});
