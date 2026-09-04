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

const SPOOL_ENV = {
  BACKEND_RELATIONAL_ENABLED: "1",
  BACKEND_RELATIONAL_MODE: "shadow",
  EVENT_OUTBOX_ENABLED: "1",
  REALTIME_REPLAY_ENABLED: "1",
  PRINT_SPOOL_SQL_PRIMARY: "1",
  PRINT_CIRCUIT_BREAKER: "1",
  RUNTIME_METRICS: "1",
  PRINTING_ENABLED: "0",
};

async function openSpoolDb(relationalPath) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(relationalPath);
}

async function readSpoolRows(relationalPath) {
  const db = await openSpoolDb(relationalPath);
  try {
    return db.prepare("SELECT * FROM print_spool ORDER BY requested_at ASC").all();
  } finally {
    db.close();
  }
}

async function replay(baseUrl, afterEventId = 0) {
  const response = await fetch(`${baseUrl}/api/realtime/replay?afterEventId=${afterEventId}`, {
    cache: "no-store",
  });
  return response.json();
}

test("[BE][STEP6] una stampa richiesta è durabile in print_spool + evento print.status", async (t) => {
  const runDir = await createTempRunDir("print-spool-durable");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: { ...SPOOL_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });

  const cashier = await loginJson(backend.baseUrl, "cashier", "2222", {
    deviceUuid: "spool-cashier",
    clientApp: "mobile-frontend",
  });
  const created = await createSimpleOrder(backend.baseUrl, cashier, { deviceUuid: "spool-cashier" });
  assert.ok(created.body?.order?.id, "ordine creato");
  const orderId = created.body.order.id;

  const printResult = await apiPost(
    backend.baseUrl,
    "/api/integration/print",
    authPayload(cashier, "spool-cashier", { kind: "order", orderId }),
    { headers: authHeaders(cashier, "spool-cashier") },
  );
  // Stampa accettata in modo asincrono (non blocca la GUI).
  assert.ok(
    printResult.response.status >= 200 && printResult.response.status < 300,
    `stampa inattesa: ${printResult.response.status}`,
  );

  // Il job è durabile nella coda relazionale print_spool.
  const rows = await readSpoolRows(relationalPath);
  const requestedJob = rows.find((row) => row.id === printResult.body?.jobId);
  assert.ok(requestedJob, "job richiesto durabile in print_spool");
  assert.equal(requestedJob.order_id, orderId);

  // Eventi print.requested + print.status emessi e recuperabili via replay.
  const replayed = await replay(backend.baseUrl, 0);
  const requestedEvents = replayed.events.filter(
    (e) => e.type === "print.requested" && e.payload?.jobId === printResult.body?.jobId,
  );
  assert.ok(requestedEvents.length >= 1, "almeno un evento print.requested");
  assert.equal(requestedEvents[0].aggregateType, "print");
  assert.equal(requestedEvents[0].payload.orderId, orderId);
  const printEvents = replayed.events.filter(
    (e) => e.type === "print.status" && e.payload?.jobId === printResult.body?.jobId,
  );
  assert.ok(printEvents.length >= 1, "almeno un evento print.status");
  assert.equal(printEvents[0].aggregateType, "print");
  assert.equal(printEvents[0].payload.orderId, orderId);
});

test("[BE][STEP6] crash recovery: al riavvio i job 'claimed' orfani tornano in coda", async (t) => {
  const runDir = await createTempRunDir("print-spool-reclaim");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const first = await startBackend(t, {
    runDir,
    env: { ...SPOOL_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });
  await first.child.kill?.();

  // Simula un crash mid-claim: un job resta 'claimed' con lease valido nel DB.
  const db = await openSpoolDb(relationalPath);
  try {
    db.prepare(
      `INSERT INTO print_spool (
        id, status, kind, order_id, printer_id, payload_json, attempt_count,
        claimed_by, claimed_at, lease_expires_at, requested_at, updated_at
      ) VALUES ('orphan-1','claimed','order','o-1','pr1','{}',0,'dead-worker',
        '2026-07-07T10:00:00.000Z','2999-01-01T00:00:00.000Z',
        '2026-07-07T10:00:00.000Z','2026-07-07T10:00:00.000Z')`,
    ).run();
  } finally {
    db.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Riavvio sullo stesso DB relazionale.
  const second = await startBackend(t, {
    runDir,
    preserveDb: true,
    dbPath: first.dbPath,
    env: { ...SPOOL_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const rows = await readSpoolRows(relationalPath);
  const orphan = rows.find((r) => r.id === "orphan-1");
  assert.ok(orphan, "il job orfano esiste ancora");
  assert.equal(orphan.status, "queued", "al riavvio il job claimed orfano è tornato in coda");
  assert.equal(orphan.claimed_by, null);
  void second;
});
