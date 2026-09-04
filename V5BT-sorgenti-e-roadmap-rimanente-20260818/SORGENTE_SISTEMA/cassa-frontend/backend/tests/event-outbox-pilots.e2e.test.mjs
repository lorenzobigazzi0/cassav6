import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  apiPost,
  authHeaders,
  authPayload,
  createSimpleOrder,
  createTempRunDir,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";

const PILOT_ENV = {
  BACKEND_RELATIONAL_ENABLED: "1",
  BACKEND_RELATIONAL_MODE: "shadow",
  EVENT_OUTBOX_ENABLED: "1",
  REALTIME_REPLAY_ENABLED: "1",
  COMMAND_INBOX_ENABLED: "1",
  COMMAND_INBOX_MODE: "enforce_pilot",
  RUNTIME_METRICS: "1",
  PRINTING_ENABLED: "0",
};

async function readOutboxRows(relationalPath, eventType) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM event_outbox WHERE event_type = ? ORDER BY id ASC")
      .all(eventType);
  } finally {
    db.close();
  }
}

async function replay(baseUrl, afterEventId = 0) {
  const response = await fetch(
    `${baseUrl}/api/realtime/replay?afterEventId=${afterEventId}`,
    { cache: "no-store" },
  );
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

test("[BE][STEP5] notification.acked durabile, replay e dedup su retry idempotente", async (t) => {
  const runDir = await createTempRunDir("event-outbox-pilot-ack");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: { ...PILOT_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
    stateOverrides: (state) => {
      state.integration.notifications = [
        {
          id: "n-e2e-1",
          type: "general",
          title: "Test",
          description: "Evento outbox pilota",
          createdAt: new Date().toISOString(),
          ackedBy: [],
          meta: { orderId: "" },
        },
      ];
    },
  });

  const ackHeaders = {
    "Content-Type": "application/json",
    "X-Command-Request-Id": "e2e-ack-req-1",
    "X-Idempotency-Key": "e2e-device:ack:1",
  };
  const ackBody = {
    id: "n-e2e-1",
    action: "ack",
    consumer: "postazione",
    clientApp: "postazione",
  };

  const first = await fetch(`${backend.baseUrl}/api/integration/notifications/ack`, {
    method: "POST",
    headers: ackHeaders,
    body: JSON.stringify(ackBody),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.acknowledged, true);

  // L'evento è durabile nell'outbox relazionale e recuperabile via replay.
  const replayed = await replay(backend.baseUrl, 0);
  assert.equal(replayed.status, 200);
  const ackedEvents = replayed.json.events.filter((e) => e.type === "notification.acked");
  assert.equal(ackedEvents.length, 1, "un solo evento notification.acked dopo il primo ack");
  assert.equal(ackedEvents[0].aggregateType, "notification");
  assert.equal(ackedEvents[0].aggregateId, "n-e2e-1");
  assert.ok(Number.isInteger(ackedEvents[0].eventId));

  // Retry idempotente (Step 4): replay del comando, NESSUN secondo evento.
  const retry = await fetch(`${backend.baseUrl}/api/integration/notifications/ack`, {
    method: "POST",
    headers: ackHeaders,
    body: JSON.stringify(ackBody),
  });
  assert.equal(retry.status, 200);

  const durableRows = await readOutboxRows(relationalPath, "notification.acked");
  assert.equal(durableRows.length, 1, "il retry idempotente non deve duplicare l'evento");

  // Replay dall'ultimo id visto → nulla di nuovo (dedup lato client).
  const lastId = ackedEvents[0].eventId;
  const afterLast = await replay(backend.baseUrl, lastId);
  assert.equal(
    afterLast.json.events.filter((e) => e.type === "notification.acked").length,
    0,
  );
});

test("[BE][STEP5] print.requested durabile per ristampa comanda", async (t) => {
  const runDir = await createTempRunDir("event-outbox-pilot-print");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: { ...PILOT_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });

  const cashier = await loginJson(backend.baseUrl, "cashier", "2222", {
    deviceUuid: "print-pilot-cashier",
    clientApp: "mobile-frontend",
  });
  const created = await createSimpleOrder(backend.baseUrl, cashier, {
    deviceUuid: "print-pilot-cashier",
  });
  assert.ok(
    created.response.status === 200 || created.response.status === 202,
    `create ordine inatteso: ${created.response.status}`,
  );
  const orderId = created.body.order.id;
  assert.ok(orderId, "l'ordine creato deve avere un id");

  const printResult = await apiPost(
    backend.baseUrl,
    "/api/integration/print",
    authPayload(cashier, "print-pilot-cashier", { kind: "order", orderId }),
    {
      headers: {
        ...authHeaders(cashier, "print-pilot-cashier"),
        "X-Command-Request-Id": "e2e-print-req-1",
        "X-Idempotency-Key": "e2e-device:print:1",
      },
    },
  );
  // La stampa è dispatch asincrono → 202 accepted. L'evento print.requested è
  // emesso comunque, prima dei rami di stampa, appena l'ordine risulta presente.
  assert.ok(
    printResult.response.status >= 200 && printResult.response.status < 300,
    `stampa inattesa: ${printResult.response.status}`,
  );

  const durableRows = await readOutboxRows(relationalPath, "print.requested");
  assert.equal(durableRows.length, 1, "una richiesta di stampa emette un evento print.requested");
  const payload = JSON.parse(durableRows[0].payload_json);
  assert.equal(payload.kind, "order");
  assert.equal(payload.orderId, orderId);

  const replayed = await replay(backend.baseUrl, 0);
  const printEvents = replayed.json.events.filter((e) => e.type === "print.requested");
  assert.equal(printEvents.length, 1);
  assert.equal(printEvents[0].aggregateId, orderId);
});
