import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  acquireTableLock,
  apiPost,
  authHeaders,
  authPayload,
  createSimpleOrder,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";
import { fireConcurrent } from "./helpers/concurrency-harness.mjs";

async function createDeliveredOrder(baseUrl, session, deviceUuid, options = {}) {
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid,
    tableId: options.tableId ?? "room_pedana_t05",
    roomId: options.roomId ?? "room_pedana",
    tableNumber: options.tableNumber ?? 5,
    lines: options.lines,
  });
  assert.equal(created.response.status, 200);
  const ready = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: created.body.order.id,
      order: {
        ...created.body.order,
        workflowStatus: "ready",
        items: created.body.order.items.map((item) => ({ ...item, done: true })),
      },
      workflowReason: "k6_payment_fixture",
    }),
  );
  assert.equal(ready.response.status, 200);
  const delivered = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: ready.body.order.id,
      order: {
        ...ready.body.order,
        workflowStatus: "delivered",
        items: ready.body.order.items.map((item) => ({ ...item, done: true })),
      },
      workflowReason: "k6_payment_fixture",
    }),
  );
  assert.equal(delivered.response.status, 200);
  return delivered.body.order;
}

async function lockTableForFreeSplit(baseUrl, session, deviceUuid) {
  const locked = await acquireTableLock(
    baseUrl,
    session,
    "room_pedana_t05",
    { deviceUuid, purpose: "payment.free_split" },
  );
  assert.equal(locked.response.status, 200);
}

async function startFreeSplitWritePrimaryBackend(
  t,
  prefix = "k6-free-split",
  extraEnv = {},
) {
  const runDir = await createTempRunDir(prefix);
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY: "1",
      IDEMPOTENCY_STORE_ENABLED: "1",
      EVENT_OUTBOX_ENABLED: "1",
      RUNTIME_METRICS: "1",
      ...extraEnv,
    },
  });
  return { ...backend, relationalPath };
}

async function readRelationalFreeSplitSnapshot(relationalPath, idempotencyKey) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    const transaction = db
      .prepare("SELECT * FROM payment_transactions WHERE idempotency_key = ?")
      .get(idempotencyKey);
    const container = transaction?.container_id
      ? db
          .prepare("SELECT * FROM payment_containers WHERE id = ?")
          .get(transaction.container_id)
      : null;
    const parts = container?.id
      ? db
          .prepare("SELECT * FROM payment_parts WHERE container_id = ? ORDER BY amount_cents ASC, id ASC")
          .all(container.id)
      : [];
    const transactions = container?.id
      ? db
          .prepare("SELECT * FROM payment_transactions WHERE container_id = ? ORDER BY amount_cents ASC, id ASC")
          .all(container.id)
      : [];
    const table = container?.table_id
      ? db
          .prepare("SELECT * FROM table_states WHERE table_id = ?")
          .get(container.table_id)
      : null;
    const bills = container?.table_id
      ? db
          .prepare("SELECT * FROM table_bills WHERE table_id = ? ORDER BY id")
          .all(container.table_id)
      : [];
    const outboxRows = container?.id
      ? db
          .prepare("SELECT * FROM event_outbox WHERE aggregate_id = ? ORDER BY id ASC")
          .all(container.id)
      : [];
    return { transaction, container, parts, transactions, table, bills, outboxRows };
  } finally {
    db.close();
  }
}

async function readPaymentMirrorRow(relationalPath, idempotencyKey) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM payment_mirror_outbox WHERE idempotency_key = ?")
      .get(idempotencyKey) ?? null;
  } finally {
    db.close();
  }
}

async function waitForPaymentMirror(relationalPath, idempotencyKey, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await readPaymentMirrorRow(relationalPath, idempotencyKey);
    if (row?.status === "completed") return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return readPaymentMirrorRow(relationalPath, idempotencyKey);
}

function freeSplitPayload(session, deviceUuid, idempotencyKey, extra = {}) {
  return authPayload(session, deviceUuid, {
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    splitType: "FREE_SPLIT",
    splitMode: "amount",
    idempotencyKey,
    releaseTable: true,
    parts: [
      {
        amountDue: 1.3,
        transactions: [{ method: "CASH", amountPaid: 1.3, cashGiven: 1.3 }],
      },
    ],
    ...extra,
  });
}

test("K6 payments/free-split write-primary registra piu quote e outbox atomico", async (t) => {
  const { baseUrl, dbPath, relationalPath } =
    await startFreeSplitWritePrimaryBackend(t, "k6-free-split-create");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "k6-free-split-device",
    clientApp: "mobile-frontend",
  });
  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    deviceUuid: "k6-free-split-admin",
    clientApp: "cassa-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "k6-free-split-device");
  await lockTableForFreeSplit(baseUrl, cashier, "k6-free-split-device");

  const paid = await apiPost(
    baseUrl,
    "/api/payments/free-split",
    freeSplitPayload(cashier, "k6-free-split-device", "k6-free-split-create-once", {
      orderId: order.id,
      parts: [
        {
          amountDue: 0.6,
          transactions: [{ method: "CASH", amountPaid: 0.6, cashGiven: 0.6 }],
        },
        {
          amountDue: 0.7,
          transactions: [{ method: "CASH", amountPaid: 0.7, cashGiven: 0.7 }],
        },
      ],
    }),
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);
  assert.equal(paid.body.relational.writePrimary, true);
  assert.equal(paid.body.relational.paymentTransactionIds.length, 2);
  assert.equal(paid.body.table.totalDue, 0);

  const persisted = await readJson(dbPath);
  const persistedOrder = persisted.integration.orders.find((entry) => entry.id === order.id);
  assert.equal(persistedOrder.dueAmount, 0);
  assert.equal(
    persisted.paymentContainers.filter(
      (entry) => entry.idempotencyKey === "k6-free-split-create-once",
    ).length,
    1,
  );

  const snapshot = await readRelationalFreeSplitSnapshot(
    relationalPath,
    "k6-free-split-create-once",
  );
  assert.equal(snapshot.container.paid_cents, 130);
  assert.equal(snapshot.container.due_cents, 0);
  assert.deepEqual(snapshot.parts.map((entry) => entry.amount_cents), [60, 70]);
  assert.deepEqual(
    snapshot.transactions.map((entry) => entry.amount_cents),
    [60, 70],
  );
  assert.equal(snapshot.table.total_due_cents, 0);
  assert.equal(snapshot.bills.length, 0);
  assert.equal(snapshot.outboxRows.length, 1);
  const outboxPayload = JSON.parse(snapshot.outboxRows[0].payload_json);
  assert.equal(outboxPayload.reason, "payment_completed");
  assert.equal(outboxPayload.detail.source, "free_split");
  assert.equal(outboxPayload.detail.relationalWritePrimary, true);

  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(admin, "k6-free-split-admin"),
  });
  assert.equal(metricsResponse.status, 200);
  const labels = (await metricsResponse.json()).runtimeMetrics.operations.runMsByLabel;
  assert.equal(labels["paymentFreeSplitWorkflow:total.completed"]?.count >= 1, true);
  assert.equal(labels["paymentFreeSplitWorkflow:appState.mirror"]?.count >= 1, true);
  assert.equal(labels["paymentWorkflowStep:payments.freeSplit.paymentRecords"]?.count >= 1, true);
});

test("K6 payments/free-split importo parziale mantiene residuo tavolo coerente", async (t) => {
  const { baseUrl, dbPath, relationalPath } =
    await startFreeSplitWritePrimaryBackend(t, "k6-free-split-partial");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "k6-free-split-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "k6-free-split-device");
  await lockTableForFreeSplit(baseUrl, cashier, "k6-free-split-device");

  const paid = await apiPost(
    baseUrl,
    "/api/payments/free-split",
    freeSplitPayload(cashier, "k6-free-split-device", "k6-free-split-partial-once", {
      orderId: order.id,
      releaseTable: false,
      parts: [
        {
          amountDue: 0.6,
          transactions: [{ method: "CASH", amountPaid: 0.6, cashGiven: 0.6 }],
        },
      ],
    }),
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);
  assert.equal(paid.body.relational.writePrimary, true);
  assert.equal(paid.body.table.totalDue, 0.7);

  const persisted = await readJson(dbPath);
  const persistedOrder = persisted.integration.orders.find((entry) => entry.id === order.id);
  assert.equal(persistedOrder.dueAmount, 0.7);

  const snapshot = await readRelationalFreeSplitSnapshot(
    relationalPath,
    "k6-free-split-partial-once",
  );
  assert.equal(snapshot.container.paid_cents, 60);
  assert.equal(snapshot.table.total_due_cents, 70);
  assert.equal(snapshot.bills.reduce((sum, bill) => sum + bill.due_cents, 0), 70);
});

test("K6 payments/free-split concorrenza reale stessa idempotency key fa replay", async (t) => {
  const { baseUrl, dbPath, relationalPath } =
    await startFreeSplitWritePrimaryBackend(t, "k6-free-split-concurrent");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "k6-free-split-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "k6-free-split-device");
  await lockTableForFreeSplit(baseUrl, cashier, "k6-free-split-device");
  const payload = freeSplitPayload(
    cashier,
    "k6-free-split-device",
    "k6-free-split-concurrent-once",
    { orderId: order.id },
  );

  const results = await fireConcurrent([
    {
      url: `${baseUrl}/api/payments/free-split`,
      options: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    },
    {
      url: `${baseUrl}/api/payments/free-split`,
      options: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    },
  ]);

  const fulfilled = results.filter((entry) => entry.status === "fulfilled");
  assert.equal(fulfilled.length, 2);
  assert.deepEqual(fulfilled.map((entry) => entry.value.response.status).sort(), [200, 200]);
  const bodies = await Promise.all(fulfilled.map((entry) => entry.value.response.json()));
  assert.equal(new Set(bodies.map((body) => body.payment.id)).size, 1);
  assert.equal(bodies.some((body) => body.idempotent === true), true);

  const persisted = await readJson(dbPath);
  assert.equal(
    persisted.paymentContainers.filter(
      (entry) => entry.idempotencyKey === "k6-free-split-concurrent-once",
    ).length,
    1,
  );
  const snapshot = await readRelationalFreeSplitSnapshot(
    relationalPath,
    "k6-free-split-concurrent-once",
  );
  assert.equal(snapshot.transaction.amount_cents, 130);
  assert.equal(snapshot.table.total_due_cents, 0);
});

test("P4.3 payments/free-split ACK relazionale e mirror durevole post-risposta", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startFreeSplitWritePrimaryBackend(
    t,
    "p43-free-split-durable-mirror",
    {
      BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR: "1",
      BACKEND_PAYMENT_MIRROR_WORKER_INTERVAL_MS: "20",
    },
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "p43-free-split-device",
    clientApp: "mobile-frontend",
  });
  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    deviceUuid: "p43-free-split-admin",
    clientApp: "cassa-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "p43-free-split-device");
  await lockTableForFreeSplit(baseUrl, cashier, "p43-free-split-device");
  const idempotencyKey = "p43-free-split-durable-once";

  const paid = await apiPost(
    baseUrl,
    "/api/payments/free-split",
    freeSplitPayload(cashier, "p43-free-split-device", idempotencyKey, { orderId: order.id }),
  );
  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.relational.writePrimary, true);

  const mirror = await waitForPaymentMirror(relationalPath, idempotencyKey);
  assert.equal(mirror?.status, "completed");
  assert.equal(mirror?.attempt_count, 0);
  const payload = JSON.parse(mirror.payload_json);
  assert.equal(payload.kind, "payment.free_split");
  assert.equal(payload.aggregateId, paid.body.payment.id);

  const persisted = await readJson(dbPath);
  assert.equal(
    persisted.paymentContainers.some((entry) => entry.id === paid.body.payment.id),
    true,
  );
  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(admin, "p43-free-split-admin"),
  });
  const metrics = (await metricsResponse.json()).runtimeMetrics;
  assert.equal(metrics.counters.paymentMirrorEnqueued, 1);
  assert.equal(metrics.counters.paymentMirrorCompleted, 1);
  assert.equal(metrics.counters.paymentMirrorSyncFallbacks, 0);
  assert.equal(metrics.operations.runMsByLabel["paymentFreeSplitWorkflow:appState.mirror.enqueued"]?.count, 1);
  assert.equal(metrics.operations.runMsByLabel["paymentMirrorWorker:payment.freeSplit.completed"]?.count, 1);
});

test("P4.3 rollback relazionale annulla insieme pagamento, realtime e mirror", async (t) => {
  const { baseUrl, relationalPath } = await startFreeSplitWritePrimaryBackend(
    t,
    "p43-free-split-atomic-rollback",
    { BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR: "1" },
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "p43-rollback-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "p43-rollback-device");
  await lockTableForFreeSplit(baseUrl, cashier, "p43-rollback-device");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath);
  db.exec(`
    CREATE TRIGGER p43_fail_table_snapshot
    BEFORE INSERT ON table_states
    WHEN NEW.table_id = 'room_pedana_t05'
    BEGIN
      SELECT RAISE(ABORT, 'p43 forced rollback');
    END;
  `);
  db.close();
  const idempotencyKey = "p43-free-split-rollback-once";

  const paid = await apiPost(
    baseUrl,
    "/api/payments/free-split",
    freeSplitPayload(cashier, "p43-rollback-device", idempotencyKey, { orderId: order.id }),
  );
  assert.notEqual(paid.response.status, 200);

  const verify = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    assert.equal(
      verify.prepare("SELECT COUNT(*) AS count FROM payment_transactions WHERE idempotency_key = ?").get(idempotencyKey).count,
      0,
    );
    assert.equal(
      verify.prepare("SELECT COUNT(*) AS count FROM payment_mirror_outbox WHERE idempotency_key = ?").get(idempotencyKey).count,
      0,
    );
    assert.equal(
      verify.prepare("SELECT COUNT(*) AS count FROM event_outbox WHERE aggregate_id LIKE 'pay_%'").get().count,
      0,
    );
    assert.equal(
      verify.prepare("SELECT COUNT(*) AS count FROM table_states WHERE table_id = 'room_pedana_t05'").get().count,
      1,
    );
  } finally {
    verify.close();
  }
});

test("K6 payments/free-split write-primary senza relazionale restituisce 503", async (t) => {
  const backend = await startBackend(t, {
    env: {
      BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY: "1",
    },
  });
  const cashier = await loginJson(backend.baseUrl, "cashier", "2222", {
    deviceUuid: "k6-free-split-no-db",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(backend.baseUrl, cashier, "k6-free-split-no-db");

  const paid = await apiPost(
    backend.baseUrl,
    "/api/payments/free-split",
    freeSplitPayload(cashier, "k6-free-split-no-db", "k6-free-split-no-db", {
      orderId: order.id,
    }),
  );

  assert.equal(paid.response.status, 503);
  assert.equal(paid.body.code, "RELATIONAL_PAYMENTS_DB_UNAVAILABLE");
  const persisted = await readJson(backend.dbPath);
  assert.equal(persisted.paymentContainers.length, 0);
});
