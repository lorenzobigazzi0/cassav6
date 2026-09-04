import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  apiPost,
  authPayload,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";
import { fireConcurrent } from "./helpers/concurrency-harness.mjs";

async function startTicketWritePrimaryBackend(t, prefix = "k4-ticket", extraEnv = {}) {
  const runDir = await createTempRunDir(prefix);
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY: "1",
      IDEMPOTENCY_STORE_ENABLED: "1",
      EVENT_OUTBOX_ENABLED: "1",
      ...extraEnv,
    },
  });
  return { ...backend, relationalPath };
}

async function readRelationalSnapshot(relationalPath, idempotencyKey) {
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
    const parts = transaction?.container_id
      ? db
          .prepare("SELECT * FROM payment_parts WHERE container_id = ? ORDER BY id")
          .all(transaction.container_id)
      : [];
    const outboxRows = db
      .prepare(
        "SELECT * FROM event_outbox WHERE aggregate_id = ? ORDER BY id ASC",
      )
      .all(transaction?.container_id ?? transaction?.id ?? "");
    return { transaction, container, parts, outboxRows };
  } finally {
    db.close();
  }
}

function ticketPayload(session, deviceUuid, idempotencyKey, extra = {}) {
  return authPayload(session, deviceUuid, {
    paymentMethodId: "pay_cash",
    cashGiven: 1.3,
    idempotencyKey,
    lines: [
      {
        name: "Caffe K4",
        qty: 1,
        unitPrice: 1.3,
        unitPriceApplied: 1.3,
        lineTotal: 1.3,
      },
    ],
    ...extra,
  });
}

test("K4 payments/ticket write-primary crea righe relazionali e outbox atomico", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startTicketWritePrimaryBackend(
    t,
    "k4-ticket-create",
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "k4-ticket-device",
    clientApp: "mobile-frontend",
  });

  const paid = await apiPost(
    baseUrl,
    "/api/payments/ticket",
    ticketPayload(cashier, "k4-ticket-device", "k4-ticket-create-once"),
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);
  assert.equal(paid.body.relational.writePrimary, true);

  const persisted = await readJson(dbPath);
  assert.equal(
    persisted.paymentContainers.filter(
      (entry) => entry.idempotencyKey === "k4-ticket-create-once",
    ).length,
    1,
  );

  const snapshot = await readRelationalSnapshot(
    relationalPath,
    "k4-ticket-create-once",
  );
  assert.equal(snapshot.transaction.amount_cents, 130);
  assert.equal(snapshot.transaction.status, "settled");
  assert.equal(snapshot.container.paid_cents, 130);
  assert.equal(snapshot.container.due_cents, 0);
  assert.equal(snapshot.parts.length, 1);
  assert.equal(snapshot.parts[0].amount_cents, 130);
  assert.equal(snapshot.outboxRows.length, 1);
  const outboxPayload = JSON.parse(snapshot.outboxRows[0].payload_json);
  assert.equal(outboxPayload.reason, "payment_completed");
  assert.equal(outboxPayload.detail.source, "ticket_payment");
  assert.equal(outboxPayload.detail.relationalWritePrimary, true);
});

test("K4 payments/ticket concorrenza reale stessa idempotency key fa replay senza duplicare", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startTicketWritePrimaryBackend(
    t,
    "k4-ticket-concurrent",
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "k4-ticket-device",
    clientApp: "mobile-frontend",
  });
  const payload = ticketPayload(
    cashier,
    "k4-ticket-device",
    "k4-ticket-concurrent-once",
  );

  const results = await fireConcurrent([
    {
      url: `${baseUrl}/api/payments/ticket`,
      options: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    },
    {
      url: `${baseUrl}/api/payments/ticket`,
      options: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    },
  ]);

  const fulfilled = results.filter((entry) => entry.status === "fulfilled");
  assert.equal(fulfilled.length, 2);
  assert.deepEqual(
    fulfilled.map((entry) => entry.value.response.status).sort(),
    [200, 200],
  );
  const bodies = await Promise.all(
    fulfilled.map((entry) => entry.value.response.json()),
  );
  assert.equal(new Set(bodies.map((body) => body.payment.id)).size, 1);
  assert.equal(bodies.some((body) => body.idempotent === true), true);

  const persisted = await readJson(dbPath);
  assert.equal(
    persisted.paymentContainers.filter(
      (entry) => entry.idempotencyKey === "k4-ticket-concurrent-once",
    ).length,
    1,
  );
  const snapshot = await readRelationalSnapshot(
    relationalPath,
    "k4-ticket-concurrent-once",
  );
  assert.equal(snapshot.transaction.amount_cents, 130);
});

test("K4 payments/ticket write-primary senza relazionale restituisce 503 esplicito", async (t) => {
  const backend = await startBackend(t, {
    env: {
      BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY: "1",
    },
  });
  const cashier = await loginJson(backend.baseUrl, "cashier", "2222", {
    deviceUuid: "k4-ticket-no-db",
    clientApp: "mobile-frontend",
  });

  const paid = await apiPost(
    backend.baseUrl,
    "/api/payments/ticket",
    ticketPayload(cashier, "k4-ticket-no-db", "k4-ticket-no-db"),
  );

  assert.equal(paid.response.status, 503);
  assert.equal(paid.body.code, "RELATIONAL_PAYMENTS_DB_UNAVAILABLE");
  const persisted = await readJson(backend.dbPath);
  assert.equal(persisted.paymentContainers.length, 0);
});
