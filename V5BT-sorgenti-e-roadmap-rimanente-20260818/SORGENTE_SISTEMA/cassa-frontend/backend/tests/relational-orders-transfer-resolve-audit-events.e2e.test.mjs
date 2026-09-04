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

const DEVICE_UUID = "rel-order-transfer-audit-manager";

const BASE_ENV = {
  BACKEND_RELATIONAL_ENABLED: "1",
  BACKEND_RELATIONAL_MODE: "shadow",
  BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
  BACKEND_RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY: "1",
  BACKEND_RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY: "1",
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

function listTransferResolvedEvents(relationalPath, orderId) {
  return withRelationalDb(
    relationalPath,
    (db) =>
      db
        .prepare("SELECT id, event_type, actor_user_id, payload_json FROM order_events WHERE order_id = ? AND event_type = 'order.transfer_resolved' ORDER BY id ASC")
        .all(orderId),
    { readOnly: true },
  );
}

async function requestTransfer(baseUrl, manager, order, suffix, targetStation = "COCKTAIL") {
  const request = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/request",
    authPayload(manager, DEVICE_UUID, {
      orderId: order.id,
      mode: "transfer",
      requesterStation: targetStation,
      targetStation,
      requesterOperator: "Manager Test",
      requesterRole: "Responsabile",
      expectedRevision: order.revision,
      idempotencyKey: `mp4bf-transfer-request-${suffix}`,
    }),
  );
  assert.equal(request.response.status, 200);
  return request.body.order;
}

function resolveTransferPayload(manager, order, overrides = {}) {
  return authPayload(manager, DEVICE_UUID, {
    orderId: order.id,
    approve: true,
    approverStation: order.pendingAuthRequest?.fromStation ?? "",
    approverOperator: "Owner Test",
    expectedRevision: order.revision,
    ...overrides,
  });
}

test("[BE][MP-4bf] approve scrive un solo audit event deterministico e il retry non duplica", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-audit-approve");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    env: { ...BASE_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE_UUID,
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: DEVICE_UUID,
    extraPayload: { idempotencyKey: "mp4bf-audit-approve-create" },
  });
  assert.equal(created.response.status, 200);
  const requestedOrder = await requestTransfer(baseUrl, manager, created.body.order, "approve");

  const resolvePayload = resolveTransferPayload(manager, requestedOrder);
  const resolve = await apiPost(baseUrl, "/api/integration/orders/transfer/resolve", resolvePayload);
  assert.equal(resolve.response.status, 200);
  assert.equal(resolve.body.approved, true);
  assert.equal(resolve.body.order.revision, 3);

  const events = await listTransferResolvedEvents(relationalPath, requestedOrder.id);
  assert.equal(events.length, 1, "deve esistere esattamente un audit event transfer_resolved");
  assert.equal(events[0].id, `${requestedOrder.id}:order.transfer_resolved:3`);
  assert.equal(events[0].actor_user_id, manager.user.id);
  const payload = JSON.parse(events[0].payload_json);
  assert.equal(payload.approved, true);
  assert.equal(payload.fromStation, requestedOrder.pendingAuthRequest.fromStation);
  assert.equal(payload.toStation, "COCKTAIL");
  assert.equal(payload.mode, "transfer");
  assert.equal(payload.revision, 3);

  const createdEventRow = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT id FROM order_events WHERE order_id = ? AND event_type = 'order.created'").get(requestedOrder.id),
    { readOnly: true },
  );
  assert.ok(createdEventRow, "il ciclo delete+reinsert deve preservare l'evento order.created");

  const retry = await apiPost(baseUrl, "/api/integration/orders/transfer/resolve", resolvePayload);
  assert.equal(retry.response.status, 409, "il retry dopo il successo non trova piu' pending");
  const eventsAfterRetry = await listTransferResolvedEvents(relationalPath, requestedOrder.id);
  assert.equal(eventsAfterRetry.length, 1, "il retry non deve duplicare l'audit event");
});

test("[BE][MP-4bf] deny registra l'esito negato nel payload e chiude il pending", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-audit-deny");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    env: { ...BASE_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE_UUID,
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: DEVICE_UUID,
    extraPayload: { idempotencyKey: "mp4bf-audit-deny-create" },
  });
  assert.equal(created.response.status, 200);
  const requestedOrder = await requestTransfer(baseUrl, manager, created.body.order, "deny");
  const stationBefore = requestedOrder.station;

  const deny = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/resolve",
    resolveTransferPayload(manager, requestedOrder, { approve: false }),
  );
  assert.equal(deny.response.status, 200);
  assert.equal(deny.body.approved, false);
  assert.equal(deny.body.order.pendingAuthRequest, null);
  assert.equal(deny.body.order.station, stationBefore);

  const events = await listTransferResolvedEvents(relationalPath, requestedOrder.id);
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0].payload_json);
  assert.equal(payload.approved, false);
  assert.equal(payload.revision, 3);
});

test("[BE][MP-4bf] 403 e 409 non scrivono mirror ne' audit event", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-audit-reject");
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
    extraPayload: { idempotencyKey: "mp4bf-audit-reject-create" },
  });
  assert.equal(created.response.status, 200);
  const requestedOrder = await requestTransfer(baseUrl, manager, created.body.order, "reject");

  const forbidden = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/resolve",
    resolveTransferPayload(manager, requestedOrder, { approverStation: "CUCINA" }),
  );
  assert.equal(forbidden.response.status, 403);

  const relationalOrder = await withRelationalDb(
    relationalPath,
    (db) => db.prepare("SELECT revision, raw_json FROM orders WHERE id = ?").get(requestedOrder.id),
    { readOnly: true },
  );
  assert.equal(relationalOrder.revision, 2, "il 403 non deve avanzare la revisione relazionale");
  assert.ok(JSON.parse(relationalOrder.raw_json).pendingAuthRequest, "il pending deve restare aperto dopo il 403");
  assert.equal((await listTransferResolvedEvents(relationalPath, requestedOrder.id)).length, 0);
  const persistedAfter403 = await readJson(dbPath);
  const mirroredAfter403 = persistedAfter403.integration.orders.find((order) => order.id === requestedOrder.id);
  assert.ok(mirroredAfter403.pendingAuthRequest, "il mirror persistito non deve essere toccato dal 403");

  const withoutPending = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: DEVICE_UUID,
    tableId: "room_pedana_t06",
    tableNumber: 6,
    extraPayload: { idempotencyKey: "mp4bf-audit-reject-nopending" },
  });
  assert.equal(withoutPending.response.status, 200);
  const noPending = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/resolve",
    authPayload(manager, DEVICE_UUID, {
      orderId: withoutPending.body.order.id,
      approve: true,
      approverStation: withoutPending.body.order.station,
      approverOperator: "Owner Test",
    }),
  );
  assert.equal(noPending.response.status, 409);
  assert.equal((await listTransferResolvedEvents(relationalPath, withoutPending.body.order.id)).length, 0);
});

test("[BE][MP-4bf] resolve funziona da relazionale anche senza ordine nel mirror app-state", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-audit-bootstrap");
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
    extraPayload: { idempotencyKey: "mp4bf-audit-bootstrap-create" },
  });
  assert.equal(created.response.status, 200);
  const requestedOrder = await requestTransfer(first.baseUrl, manager, created.body.order, "bootstrap");

  first.child.kill("SIGTERM");
  await once(first.child, "exit");

  const crashedState = await readJson(first.dbPath);
  crashedState.integration.orders = crashedState.integration.orders.filter((order) => order.id !== requestedOrder.id);
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

  const resolve = await apiPost(
    second.baseUrl,
    "/api/integration/orders/transfer/resolve",
    authPayload(managerSecond, DEVICE_UUID, {
      orderId: requestedOrder.id,
      approve: true,
      approverStation: requestedOrder.pendingAuthRequest.fromStation,
      approverOperator: "Owner Test",
      expectedRevision: 2,
    }),
  );
  assert.equal(resolve.response.status, 200, "il resolve deve funzionare dal read-model relazionale");
  assert.equal(resolve.body.order.revision, 3);

  const events = await listTransferResolvedEvents(relationalPath, requestedOrder.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, `${requestedOrder.id}:order.transfer_resolved:3`);

  const persisted = await readJson(second.dbPath);
  const mirrored = persisted.integration.orders.find((order) => order.id === requestedOrder.id);
  assert.ok(mirrored, "il mirror deve essere reidratato dal relazionale");
  assert.equal(mirrored.pendingAuthRequest, null);
});

test("[BE][MP-4bf] risoluzioni successive producono id distinti senza perdita", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-audit-sequence");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    env: { ...BASE_ENV, BACKEND_RELATIONAL_DB_PATH: relationalPath },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: DEVICE_UUID,
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: DEVICE_UUID,
    extraPayload: { idempotencyKey: "mp4bf-audit-sequence-create" },
  });
  assert.equal(created.response.status, 200);

  const firstRequested = await requestTransfer(baseUrl, manager, created.body.order, "sequence-1");
  const firstResolve = await apiPost(baseUrl, "/api/integration/orders/transfer/resolve", resolveTransferPayload(manager, firstRequested));
  assert.equal(firstResolve.response.status, 200);
  assert.equal(firstResolve.body.order.revision, 3);

  const secondRequested = await requestTransfer(baseUrl, manager, firstResolve.body.order, "sequence-2", firstRequested.pendingAuthRequest.fromStation);
  assert.equal(secondRequested.revision, 4);
  const secondResolve = await apiPost(baseUrl, "/api/integration/orders/transfer/resolve", resolveTransferPayload(manager, secondRequested));
  assert.equal(secondResolve.response.status, 200);
  assert.equal(secondResolve.body.order.revision, 5);

  const events = await listTransferResolvedEvents(relationalPath, created.body.order.id);
  assert.deepEqual(
    events.map((event) => event.id),
    [
      `${created.body.order.id}:order.transfer_resolved:3`,
      `${created.body.order.id}:order.transfer_resolved:5`,
    ],
  );
});
