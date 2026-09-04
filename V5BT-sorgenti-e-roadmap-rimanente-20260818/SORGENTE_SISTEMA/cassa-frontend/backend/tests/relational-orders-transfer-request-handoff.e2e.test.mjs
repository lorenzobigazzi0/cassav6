import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { once } from "node:events";
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

const DEVICE_UUID = "rel-order-transfer-handoff-manager";

const BASE_ENV = {
  BACKEND_RELATIONAL_ENABLED: "1",
  BACKEND_RELATIONAL_MODE: "shadow",
  BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
  BACKEND_RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY: "1",
  PRINTING_ENABLED: "0",
  RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
};

async function withRelationalDb(relationalPath, callback, options = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: options.readOnly === true });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function transferRequestPayload(manager, orderId, expectedRevision, suffix) {
  return authPayload(manager, DEVICE_UUID, {
    orderId,
    mode: "transfer",
    requesterStation: "COCKTAIL",
    targetStation: "COCKTAIL",
    requesterOperator: "Manager Test",
    requesterRole: "Responsabile",
    expectedRevision,
    idempotencyKey: `mp4bg-transfer-request-${suffix}`,
  });
}

test("[BE][MP-4bg] transfer/request funziona dal relazionale anche senza ordine nel mirror app-state", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-handoff-bootstrap");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const first = await startBackend(t, {
    runDir,
    env: { ...BASE_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });
  const manager = await loginJson(first.baseUrl, "manager", "4444", {
    deviceUuid: DEVICE_UUID,
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(first.baseUrl, manager, {
    deviceUuid: DEVICE_UUID,
    extraPayload: { idempotencyKey: "mp4bg-handoff-bootstrap-create" },
  });
  assert.equal(created.response.status, 200);
  const orderId = created.body.order.id;

  first.child.kill("SIGTERM");
  await once(first.child, "exit");

  const crashedState = await readJson(first.dbPath);
  crashedState.integration.orders = crashedState.integration.orders.filter((order) => order.id !== orderId);
  await fs.writeFile(first.dbPath, `${JSON.stringify(crashedState, null, 2)}\n`, "utf8");

  const second = await startBackend(t, {
    runDir,
    dbPath: first.dbPath,
    preserveDb: true,
    env: {
      ...BASE_ENV,
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_SHADOW_SYNC_ENABLED: "0",
    },
  });
  const managerSecond = await loginJson(second.baseUrl, "manager", "4444", {
    deviceUuid: DEVICE_UUID,
    clientApp: "mobile-frontend",
  });

  const request = await apiPost(
    second.baseUrl,
    "/api/integration/orders/transfer/request",
    transferRequestPayload(managerSecond, orderId, 1, "bootstrap"),
  );
  assert.equal(request.response.status, 200, "la request deve funzionare dal read-model relazionale");
  assert.equal(request.body.order.revision, 2);
  const pending = request.body.order.pendingAuthRequest;
  assert.ok(pending, "pendingAuthRequest deve essere creato");
  assert.equal(pending.toStation, "COCKTAIL");
  assert.equal(pending.toOperator, "Manager Test");
  assert.equal(pending.mode, "transfer");
  assert.ok(pending.fromStation, "fromStation deve arrivare dall'ordine relazionale");

  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT revision, raw_json FROM orders WHERE id = ?").get(orderId),
    { readOnly: true },
  );
  const rawOrder = JSON.parse(relationalOrder.raw_json);
  assert.equal(relationalOrder.revision, 2);
  assert.equal(rawOrder.pendingAuthRequest.toStation, "COCKTAIL");
  assert.equal(rawOrder.pendingAuthRequest.fromStation, pending.fromStation);

  const persisted = await readJson(second.dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === orderId);
  assert.ok(mirrored, "il mirror deve essere reidratato dal relazionale");
  assert.equal(mirrored.pendingAuthRequest?.toStation, "COCKTAIL");
});

test("[BE][MP-4bg] due request concorrenti con la stessa revisione: un 200 e un 409 dal CAS", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-handoff-cas");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: { ...BASE_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE_UUID,
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: DEVICE_UUID,
    extraPayload: { idempotencyKey: "mp4bg-handoff-cas-create" },
  });
  assert.equal(created.response.status, 200);
  const orderId = created.body.order.id;

  const [first, second] = await Promise.all([
    apiPost(baseUrl, "/api/integration/orders/transfer/request", transferRequestPayload(manager, orderId, 1, "cas-a")),
    apiPost(baseUrl, "/api/integration/orders/transfer/request", transferRequestPayload(manager, orderId, 1, "cas-b")),
  ]);
  const statuses = [first.response.status, second.response.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409], "esattamente una request vince e una perde sul CAS");
  const loser = first.response.status === 409 ? first : second;
  assert.equal(loser.body.code, "REVISION_CONFLICT");

  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT revision, raw_json FROM orders WHERE id = ?").get(orderId),
    { readOnly: true },
  );
  assert.equal(relationalOrder.revision, 2, "la revisione avanza di 1, non di 2");
  const rawOrder = JSON.parse(relationalOrder.raw_json);
  assert.ok(rawOrder.pendingAuthRequest, "resta esattamente la pending del vincitore");

  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === orderId);
  assert.equal(Number(mirrored.revision), 2);
  assert.ok(mirrored.pendingAuthRequest);
});

test("[BE][MP-4bg] sequence.order stantio nel mirror non causa collisioni id dopo il riavvio", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-handoff-sequence");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const first = await startBackend(t, {
    runDir,
    env: { ...BASE_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });
  const manager = await loginJson(first.baseUrl, "manager", "4444", {
    deviceUuid: DEVICE_UUID,
    clientApp: "mobile-frontend",
  });
  const created = await createSimpleOrder(first.baseUrl, manager, {
    deviceUuid: DEVICE_UUID,
    extraPayload: { idempotencyKey: "mp4bg-sequence-create" },
  });
  assert.equal(created.response.status, 200);
  const existingId = created.body.order.id;

  first.child.kill("SIGTERM");
  await once(first.child, "exit");

  // Simula il clobber cross-process: il contatore ordini torna indietro mentre
  // l'ordine resta allocato nel relazionale.
  const crashedState = await readJson(first.dbPath);
  crashedState.integration.sequence.order = Number(existingId);
  await fs.writeFile(first.dbPath, `${JSON.stringify(crashedState, null, 2)}\n`, "utf8");

  const second = await startBackend(t, {
    runDir,
    dbPath: first.dbPath,
    preserveDb: true,
    env: {
      ...BASE_ENV,
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_SHADOW_SYNC_ENABLED: "0",
    },
  });
  const managerSecond = await loginJson(second.baseUrl, "manager", "4444", {
    deviceUuid: DEVICE_UUID,
    clientApp: "mobile-frontend",
  });
  const afterRestart = await createSimpleOrder(second.baseUrl, managerSecond, {
    deviceUuid: DEVICE_UUID,
    tableId: "room_pedana_t06",
    tableNumber: 6,
    extraPayload: { idempotencyKey: "mp4bg-sequence-create-after" },
  });
  assert.equal(afterRestart.response.status, 200, "la create non deve collidere con id gia' allocati nel relazionale");
  assert.ok(Number(afterRestart.body.order.id) > Number(existingId), "il nuovo id deve superare il massimo relazionale");
});

test("[BE][MP-4bg] request con revisione stantia: 409 senza pending e senza mirror", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-handoff-stale");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: { ...BASE_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE_UUID,
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: DEVICE_UUID,
    extraPayload: { idempotencyKey: "mp4bg-handoff-stale-create" },
  });
  assert.equal(created.response.status, 200);
  const orderId = created.body.order.id;
  await withRelationalDb(relationalPath, (db) => {
    db.prepare("UPDATE orders SET revision = 99 WHERE id = ?").run(orderId);
  });

  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/request",
    transferRequestPayload(manager, orderId, 1, "stale"),
  );
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "REVISION_CONFLICT");

  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT revision, raw_json FROM orders WHERE id = ?").get(orderId),
    { readOnly: true },
  );
  assert.equal(relationalOrder.revision, 99, "la revisione relazionale resta invariata");
  assert.equal(JSON.parse(relationalOrder.raw_json).pendingAuthRequest ?? null, null);

  const persisted = await readJson(dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === orderId);
  assert.equal(mirrored.pendingAuthRequest ?? null, null, "nessuna pending nel mirror dopo il 409");
});
