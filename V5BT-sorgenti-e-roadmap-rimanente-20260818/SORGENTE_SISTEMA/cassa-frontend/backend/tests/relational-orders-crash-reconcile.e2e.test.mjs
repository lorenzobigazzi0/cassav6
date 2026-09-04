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

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const ASYNC_ACK_ENV = {
  BACKEND_RELATIONAL_ENABLED: "1",
  BACKEND_RELATIONAL_MODE: "shadow",
  BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
  BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY: "1",
  BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH: "1",
  PRINTING_ENABLED: "0",
};

async function pollMirroredOrder(dbPath, orderId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const persisted = await readJson(dbPath).catch(() => null);
    const order = persisted?.integration?.orders?.find((entry) => entry.id === orderId) ?? null;
    if (order) return { order, persisted };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { order: null, persisted: await readJson(dbPath).catch(() => null) };
}

test("[BE][P3] crash dopo ACK: la riconciliazione all'avvio ripristina l'ordine dal relazionale", async (t) => {
  const runDir = await createTempRunDir("rel-order-crash-reconcile");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const first = await startBackend(t, {
    runDir,
    env: {
      ...ASYNC_ACK_ENV,
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      // Trattiene il flush mirror per simulare il crash nella finestra asincrona.
      ORDERS_ASYNC_FLUSH_INTERVAL_MS: "300000",
    },
  });
  const cashier = await loginJson(first.baseUrl, "cashier", "2222", {
    deviceUuid: "crash-reconcile-cashier",
    clientApp: "mobile-frontend",
  });
  const created = await createSimpleOrder(first.baseUrl, cashier, {
    deviceUuid: "crash-reconcile-cashier",
    extraPayload: { idempotencyKey: "p3-crash-reconcile" },
  });
  assert.equal(created.response.status, 200);
  const orderId = created.body.order.id;

  first.child.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Simula la finestra di crash asincrona: l'ordine e' durevole nel relazionale
  // (write-primary prima dell'ACK) ma il mirror app-state su disco non lo ha.
  const crashedState = await readJson(first.dbPath);
  crashedState.integration.orders = crashedState.integration.orders.filter((order) => order.id !== orderId);
  if (crashedState.integration.sequence && typeof crashedState.integration.sequence === "object") {
    crashedState.integration.sequence.order = 1;
  }
  await writeJson(first.dbPath, crashedState);

  const second = await startBackend(t, {
    runDir,
    dbPath: first.dbPath,
    preserveDb: true,
    env: {
      ...ASYNC_ACK_ENV,
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      ORDERS_ASYNC_FLUSH_INTERVAL_MS: "25",
    },
  });

  const { order: reconciled, persisted } = await pollMirroredOrder(second.dbPath, orderId);
  assert.ok(reconciled, "dopo il riavvio la riconciliazione deve ripristinare l'ordine nel mirror app-state");
  assert.equal(Number(reconciled.revision ?? reconciled.currentRevision ?? 1), 1, "la revision relazionale va preservata");
  assert.ok(
    Number(persisted.integration.sequence.order) >= Number(orderId) + 1,
    `la sequence ordini deve avanzare oltre l'id riconciliato (attesa >= ${Number(orderId) + 1}, attuale ${persisted.integration.sequence.order})`,
  );
});
