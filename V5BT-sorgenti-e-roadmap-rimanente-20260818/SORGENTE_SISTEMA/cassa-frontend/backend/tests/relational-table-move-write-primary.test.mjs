import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  openRelationalConnection,
} from "../db/relational/index.js";
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

function tableMoveEnv(relationalPath) {
  return {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "shadow",
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
    BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY: "1",
    TABLES_RELATIONAL_WRITE_PRIMARY: "1",
  };
}

async function startTableMoveBackend(t, options = {}) {
  const runDir = await createTempRunDir(options.prefix ?? "rel-table-move-write");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const server = await startBackend(t, {
    runDir,
    env: options.env ?? tableMoveEnv(relationalPath),
  });
  return { ...server, relationalPath, runDir };
}

async function readRelationalTables(relationalPath, ids = []) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    const rows = db
      .prepare(`SELECT table_id, status, total_due_cents, revision FROM table_states WHERE table_id IN (${ids.map(() => "?").join(",")}) ORDER BY table_id`)
      .all(...ids);
    const locks = db
      .prepare(`SELECT table_id, revision FROM table_locks WHERE table_id IN (${ids.map(() => "?").join(",")}) ORDER BY table_id`)
      .all(...ids);
    return { rows, locks };
  } finally {
    closeRelationalConnection(db);
  }
}

async function readRelationalOrder(relationalPath, orderId) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    return db
      .prepare("SELECT id, table_id, room_id, revision, raw_json FROM orders WHERE id = ?")
      .get(orderId);
  } finally {
    closeRelationalConnection(db);
  }
}

async function releaseTableLock(baseUrl, session, tableId, deviceUuid) {
  return apiPost(
    baseUrl,
    "/api/tables/lock/release",
    authPayload(session, deviceUuid, { tableId }),
    { headers: authHeaders(session, deviceUuid) }
  );
}

test("J9 table move write-primary aggiorna table_states relazionali con revision", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startTableMoveBackend(t, {
    prefix: "rel-table-move-primary",
  });
  const deviceUuid = "table-move-primary-device";
  const session = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const orderLock = await acquireTableLock(baseUrl, session, "room_pedana_t05", {
    deviceUuid,
    purpose: "order.create",
  });
  assert.equal(orderLock.response.status, 200);
  const order = await createSimpleOrder(baseUrl, session, {
    deviceUuid,
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    tableNumber: 5,
  });
  assert.equal(order.response.status, 200);

  const sourceLock = await acquireTableLock(baseUrl, session, "room_pedana_t05", {
    deviceUuid,
    purpose: "table.move_source",
  });
  assert.equal(sourceLock.response.status, 200);
  const targetLock = await acquireTableLock(baseUrl, session, "room_pedana_t06", {
    deviceUuid,
    purpose: "table.move_target",
  });
  assert.equal(targetLock.response.status, 200);

  const moved = await apiPost(
    baseUrl,
    "/api/integration/layout/table/move",
    authPayload(session, deviceUuid, {
      fromTableId: "room_pedana_t05",
      toTableId: "room_pedana_t06",
    })
  );
  assert.equal(moved.response.status, 200);
  assert.equal(moved.body.movedOrdersCount, 1);

  const relational = await readRelationalTables(relationalPath, ["room_pedana_t05", "room_pedana_t06"]);
  const source = relational.rows.find((row) => row.table_id === "room_pedana_t05");
  const target = relational.rows.find((row) => row.table_id === "room_pedana_t06");
  assert.equal(source.status, "free");
  assert.equal(source.total_due_cents, 0);
  assert.equal(source.revision, 3);
  assert.equal(target.status, "waiting");
  assert.equal(target.total_due_cents, 0);
  assert.equal(target.revision, 2);
  assert.deepEqual(relational.locks, []);

  const relationalOrder = await readRelationalOrder(relationalPath, order.body.order.id);
  assert.equal(relationalOrder.table_id, "room_pedana_t06");
  assert.equal(relationalOrder.room_id, "room_pedana");
  assert.equal(JSON.parse(relationalOrder.raw_json).tableId, "room_pedana_t06");
  assert.equal(relationalOrder.revision, order.body.order.revision + 1);

  const appState = await readJson(dbPath);
  const movedOrder = appState.integration.orders.find((entry) => entry.id === order.body.order.id);
  assert.equal(movedOrder.tableId, "room_pedana_t06");
  assert.equal(appState.posSettings.tables.find((entry) => entry.id === "room_pedana_t05").revision, 3);
  assert.equal(appState.posSettings.tables.find((entry) => entry.id === "room_pedana_t06").revision, 2);
  assert.equal(appState.posSettings.tables.find((entry) => entry.id === "room_pedana_t05").workLock, null);
  assert.equal(appState.posSettings.tables.find((entry) => entry.id === "room_pedana_t06").workLock, null);
});

test("J9 table sync aggiorna table_states relazionali prima del move write-primary", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startTableMoveBackend(t, {
    prefix: "rel-table-sync-before-move",
  });
  const deviceUuid = "table-sync-before-move-device";
  const session = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const syncLock = await acquireTableLock(baseUrl, session, "room_pedana_t05", {
    deviceUuid,
    purpose: "table.sync",
  });
  assert.equal(syncLock.response.status, 200);
  const synced = await apiPost(
    baseUrl,
    "/api/integration/layout/table/sync",
    authPayload(session, deviceUuid, {
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      tableNumber: 5,
      status: "no_orders",
      occupancyState: "seated",
      covers: 2,
    }),
    { headers: authHeaders(session, deviceUuid) }
  );
  assert.equal(synced.response.status, 200);
  assert.equal(synced.body?.table?.revision, 2);
  const released = await releaseTableLock(baseUrl, session, "room_pedana_t05", deviceUuid);
  assert.equal(released.response.status, 200);

  const afterSync = await readRelationalTables(relationalPath, ["room_pedana_t05"]);
  assert.deepEqual(afterSync.rows.map((row) => ({
    table_id: row.table_id,
    status: row.status,
    revision: row.revision,
  })), [
    { table_id: "room_pedana_t05", status: "no_orders", revision: 2 },
  ]);

  const sourceLock = await acquireTableLock(baseUrl, session, "room_pedana_t05", {
    deviceUuid,
    purpose: "table.move_source",
  });
  assert.equal(sourceLock.response.status, 200);
  const targetLock = await acquireTableLock(baseUrl, session, "room_pedana_t06", {
    deviceUuid,
    purpose: "table.move_target",
  });
  assert.equal(targetLock.response.status, 200);
  const moved = await apiPost(
    baseUrl,
    "/api/integration/layout/table/move",
    authPayload(session, deviceUuid, {
      fromTableId: "room_pedana_t05",
      toTableId: "room_pedana_t06",
    }),
    { headers: authHeaders(session, deviceUuid) }
  );
  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));

  const relational = await readRelationalTables(relationalPath, ["room_pedana_t05", "room_pedana_t06"]);
  const source = relational.rows.find((row) => row.table_id === "room_pedana_t05");
  const target = relational.rows.find((row) => row.table_id === "room_pedana_t06");
  assert.equal(source.status, "free");
  assert.equal(source.revision, 3);
  assert.equal(target.status, "free");
  assert.equal(target.revision, 2);

  const appState = await readJson(dbPath);
  assert.equal(appState.posSettings.tables.find((entry) => entry.id === "room_pedana_t05").revision, 3);
  assert.equal(appState.posSettings.tables.find((entry) => entry.id === "room_pedana_t06").revision, 2);
});
