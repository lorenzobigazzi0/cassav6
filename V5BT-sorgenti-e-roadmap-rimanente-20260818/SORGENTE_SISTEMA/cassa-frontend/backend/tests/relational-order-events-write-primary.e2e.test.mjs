import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  createSimpleOrder,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

async function readOrderEventRows(relationalPath, orderId) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM order_events WHERE order_id = ? ORDER BY id ASC")
      .all(orderId);
  } finally {
    db.close();
  }
}

test("[BE][I2] order create appende eventi relazionali idempotenti", async (t) => {
  const runDir = await createTempRunDir("rel-order-events-i2");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDER_EVENTS_WRITE_PRIMARY: "1",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "rel-order-events-device",
    clientApp: "mobile-frontend",
  });

  const first = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-events-device",
    extraPayload: { idempotencyKey: "i2-order-create-once" },
  });
  const second = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "rel-order-events-device",
    extraPayload: { idempotencyKey: "i2-order-create-once" },
  });

  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.order.id, first.body.order.id);

  const persisted = await readJson(dbPath);
  const matchingOrders = persisted.integration.orders.filter(
    (order) => order.idempotencyKey === "i2-order-create-once",
  );
  assert.equal(matchingOrders.length, 1);
  assert.equal(matchingOrders[0].events.some((event) => event.eventType === "order.created"), true);

  const rows = await readOrderEventRows(relationalPath, first.body.order.id);
  assert.equal(rows.filter((row) => row.event_type === "order.created").length, 1);
  assert.equal(rows.filter((row) => row.event_type === "order.line_added").length, 1);
});
