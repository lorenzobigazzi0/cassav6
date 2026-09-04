import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  openRelationalConnection,
} from "../db/relational/index.js";
import {
  apiPost,
  authPayload,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

function tableLocksEnv(relationalPath) {
  return {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "shadow",
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
    BACKEND_RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY: "1",
  };
}

async function startTableLocksBackend(t, options = {}) {
  const runDir = await createTempRunDir(options.prefix ?? "rel-table-locks-write");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const server = await startBackend(t, {
    runDir,
    env: options.env ?? tableLocksEnv(relationalPath),
  });
  return { ...server, relationalPath, runDir };
}

async function readRelationalTableLock(relationalPath, tableId = "room_pedana_t05") {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    return db.prepare("SELECT * FROM table_locks WHERE table_id = ?").get(tableId);
  } finally {
    closeRelationalConnection(db);
  }
}

async function acquireTableLock(baseUrl, session, deviceUuid, tableId = "room_pedana_t05", purpose = "open_table") {
  return apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId, purpose })
  );
}

async function heartbeatTableLock(baseUrl, session, deviceUuid, tableId = "room_pedana_t05") {
  return apiPost(
    baseUrl,
    "/api/tables/lock/heartbeat",
    authPayload(session, deviceUuid, { tableId, purpose: "heartbeat" })
  );
}

async function releaseTableLock(baseUrl, session, deviceUuid, tableId = "room_pedana_t05") {
  return apiPost(
    baseUrl,
    "/api/tables/lock/release",
    authPayload(session, deviceUuid, { tableId })
  );
}

async function forceReleaseTableLock(baseUrl, session, deviceUuid, tableId = "room_pedana_t05") {
  return apiPost(
    baseUrl,
    "/api/tables/lock/force-release",
    authPayload(session, deviceUuid, { tableId })
  );
}

test("J8 table locks write-primary acquire/heartbeat/release aggiorna relazionale e mirror", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startTableLocksBackend(t, {
    prefix: "rel-table-locks-primary",
  });
  const deviceUuid = "table-lock-primary-device";
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const acquired = await acquireTableLock(baseUrl, session, deviceUuid);
  assert.equal(acquired.response.status, 200);
  assert.equal(acquired.body.lock.tableId, "room_pedana_t05");
  assert.equal(acquired.body.lock.userId, "u_cashier");
  assert.equal(acquired.body.lock.revision, 1);

  let relationalLock = await readRelationalTableLock(relationalPath);
  assert.equal(relationalLock.user_id, "u_cashier");
  assert.equal(relationalLock.device_uuid, deviceUuid);
  assert.equal(relationalLock.revision, 1);
  let appState = await readJson(dbPath);
  let table = appState.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  assert.equal(table.workLock.userId, "u_cashier");
  assert.equal(table.workLock.revision, 1);

  const heartbeat = await heartbeatTableLock(baseUrl, session, deviceUuid);
  assert.equal(heartbeat.response.status, 200);
  assert.equal(heartbeat.body.lock.revision, 2);
  relationalLock = await readRelationalTableLock(relationalPath);
  assert.equal(relationalLock.revision, 2);

  const released = await releaseTableLock(baseUrl, session, deviceUuid);
  assert.equal(released.response.status, 200);
  assert.equal(released.body.released, true);
  assert.equal(await readRelationalTableLock(relationalPath), undefined);
  appState = await readJson(dbPath);
  table = appState.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  assert.equal(table.workLock, null);
});

test("J8 table locks write-primary rifiuta lock concorrente", async (t) => {
  const { baseUrl, relationalPath } = await startTableLocksBackend(t, {
    prefix: "rel-table-locks-conflict",
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "table-lock-owner",
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "table-lock-other",
    clientApp: "mobile-frontend",
  });

  const acquired = await acquireTableLock(baseUrl, cashier, "table-lock-owner");
  assert.equal(acquired.response.status, 200);

  const denied = await acquireTableLock(baseUrl, manager, "table-lock-other");
  assert.equal(denied.response.status, 409);
  assert.equal(denied.body.code, "TABLE_LOCKED");
  const relationalLock = await readRelationalTableLock(relationalPath);
  assert.equal(relationalLock.user_id, "u_cashier");
  assert.equal(relationalLock.device_uuid, "table-lock-owner");
});

test("J8 table locks write-primary force release resta vincolato ai permessi", async (t) => {
  const { baseUrl, relationalPath } = await startTableLocksBackend(t, {
    prefix: "rel-table-locks-force",
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "table-lock-force-owner",
    clientApp: "mobile-frontend",
  });
  const waiter = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "table-lock-force-waiter",
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "table-lock-force-manager",
    clientApp: "mobile-frontend",
  });

  const acquired = await acquireTableLock(baseUrl, cashier, "table-lock-force-owner");
  assert.equal(acquired.response.status, 200);

  const denied = await forceReleaseTableLock(baseUrl, waiter, "table-lock-force-waiter");
  assert.equal(denied.response.status, 403);
  let relationalLock = await readRelationalTableLock(relationalPath);
  assert.equal(relationalLock.user_id, "u_cashier");

  const released = await forceReleaseTableLock(baseUrl, manager, "table-lock-force-manager");
  assert.equal(released.response.status, 200);
  assert.equal(released.body.released, true);
  relationalLock = await readRelationalTableLock(relationalPath);
  assert.equal(relationalLock, undefined);
});

test("J8 table locks write-primary fallisce chiaramente senza DB relazionale", async (t) => {
  const { baseUrl } = await startTableLocksBackend(t, {
    prefix: "rel-table-locks-missing-db",
    env: { BACKEND_RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY: "1" },
  });
  const deviceUuid = "table-lock-no-db";
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const response = await acquireTableLock(baseUrl, session, deviceUuid);
  assert.equal(response.response.status, 503);
  assert.match(response.body.error, /relazionale tavoli non disponibile/i);
});
