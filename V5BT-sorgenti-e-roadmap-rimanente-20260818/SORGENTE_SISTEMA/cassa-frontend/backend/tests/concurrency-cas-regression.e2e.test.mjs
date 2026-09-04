import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  openRelationalConnection,
} from "../db/relational/index.js";
import {
  authPayload,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";
import {
  assertExactlyOneSucceeded,
  fireConcurrent,
} from "./helpers/concurrency-harness.mjs";

const SERVICE_DATE = "2099-12-31";
const RESERVATION_AT = new Date(`${SERVICE_DATE}T20:00:00`).getTime();

function tableLocksEnv(relationalPath) {
  return {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "shadow",
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
    BACKEND_RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY: "1",
  };
}

function reservationsLockEnv(relationalPath) {
  return {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "shadow",
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
    BACKEND_RELATIONAL_RESERVATIONS_CREATE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_RESERVATIONS_DELETE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_RESERVATIONS_LOCK_ACQUIRE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_RESERVATIONS_LOCK_RELEASE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_RESERVATIONS_STATUS_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_RESERVATIONS_UPDATE_WRITE_PRIMARY: "1",
    BACKEND_RELATIONAL_RESERVATIONS_READS: "1",
  };
}

function seedReservationState(state) {
  state.meta.lastWriteAt = "2026-05-13T20:10:00.000Z";
  state.posReservationStates = [
    {
      key: `room_pedana__${SERVICE_DATE}`,
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
      version: 3,
      reservations: [
        {
          id: "res_concurrent_lock_1",
          roomId: "room_pedana",
          serviceDate: SERVICE_DATE,
          reservationAt: RESERVATION_AT,
          customerName: "Cliente Concorrenza",
          covers: 2,
          assignedTableId: "room_pedana_t05",
          assignedTableIds: ["room_pedana_t05"],
          createdAt: RESERVATION_AT - 60_000,
          updatedAt: RESERVATION_AT - 30_000,
        },
      ],
    },
  ];
  state.posReservationLocks = [];
}

async function startRelationalBackend(t, { prefix, envFactory, stateOverrides = null }) {
  const runDir = await createTempRunDir(prefix);
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const server = await startBackend(t, {
    runDir,
    env: envFactory(relationalPath),
    ...(stateOverrides ? { stateOverrides } : {}),
  });
  return { ...server, relationalPath, runDir };
}

function jsonPostRequest(url, payload) {
  return {
    url,
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  };
}

async function settledHttpJson(result) {
  assert.equal(result.status, "fulfilled");
  const response = result.value.response;
  return {
    status: response.status,
    body: await response.clone().json().catch(() => null),
  };
}

async function readRelationalTableLock(relationalPath, tableId) {
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

async function readRelationalReservationLock(relationalPath, reservationId) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    return db
      .prepare("SELECT * FROM reservation_locks WHERE reservation_id = ?")
      .get(reservationId);
  } finally {
    closeRelationalConnection(db);
  }
}

test("K-PRE.2.2 tables lock acquire reale concorrente produce un solo lock e un TABLE_LOCKED", async (t) => {
  const tableId = "room_pedana_t05";
  const { baseUrl, dbPath, relationalPath } = await startRelationalBackend(t, {
    prefix: "kpre2-table-lock-concurrent",
    envFactory: tableLocksEnv,
  });
  const owner = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "kpre2-table-owner",
    clientApp: "mobile-frontend",
  });
  const contender = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "kpre2-table-contender",
    clientApp: "mobile-frontend",
  });

  const results = await fireConcurrent([
    jsonPostRequest(
      `${baseUrl}/api/tables/lock/acquire`,
      authPayload(owner, "kpre2-table-owner", {
        tableId,
        purpose: "kpre2_concurrent_table",
      }),
    ),
    jsonPostRequest(
      `${baseUrl}/api/tables/lock/acquire`,
      authPayload(contender, "kpre2-table-contender", {
        tableId,
        purpose: "kpre2_concurrent_table",
      }),
    ),
  ]);

  assertExactlyOneSucceeded(results);
  const responses = await Promise.all(results.map(settledHttpJson));
  assert.deepEqual(
    responses.map((entry) => entry.status).sort((a, b) => a - b),
    [200, 409],
  );
  const conflict = responses.find((entry) => entry.status === 409);
  assert.equal(conflict.body.code, "TABLE_LOCKED");
  const success = responses.find((entry) => entry.status === 200);
  assert.equal(success.body.lock.tableId, tableId);

  const relationalLock = await readRelationalTableLock(relationalPath, tableId);
  assert.ok(relationalLock, "Lock tavolo assente nel DB relazionale.");
  assert.equal(relationalLock.table_id, tableId);
  assert.ok(["kpre2-table-owner", "kpre2-table-contender"].includes(relationalLock.device_uuid));

  const appState = await readJson(dbPath);
  const table = appState.posSettings.tables.find((entry) => entry.id === tableId);
  assert.equal(table.workLock.deviceUuid, relationalLock.device_uuid);
});

test("K-PRE.2.2 reservation lock acquire reale concorrente produce un solo lock e un conflitto", async (t) => {
  const reservationId = "res_concurrent_lock_1";
  const { baseUrl, dbPath, relationalPath } = await startRelationalBackend(t, {
    prefix: "kpre2-reservation-lock-concurrent",
    envFactory: reservationsLockEnv,
    stateOverrides: seedReservationState,
  });
  const owner = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "kpre2-reservation-owner",
    clientApp: "mobile-frontend",
  });
  const contender = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "kpre2-reservation-contender",
    clientApp: "mobile-frontend",
  });

  const makePayload = (session, deviceUuid) =>
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
      reservationId,
    });

  const results = await fireConcurrent([
    jsonPostRequest(
      `${baseUrl}/api/pos/reservations/lock/acquire`,
      makePayload(owner, "kpre2-reservation-owner"),
    ),
    jsonPostRequest(
      `${baseUrl}/api/pos/reservations/lock/acquire`,
      makePayload(contender, "kpre2-reservation-contender"),
    ),
  ]);

  assertExactlyOneSucceeded(results);
  const responses = await Promise.all(results.map(settledHttpJson));
  assert.deepEqual(
    responses.map((entry) => entry.status).sort((a, b) => a - b),
    [200, 409],
  );
  const conflict = responses.find((entry) => entry.status === 409);
  assert.match(conflict.body.error, /altro operatore/i);
  const success = responses.find((entry) => entry.status === 200);
  assert.equal(success.body.lock.reservationId, reservationId);

  const relationalLock = await readRelationalReservationLock(
    relationalPath,
    reservationId,
  );
  assert.ok(relationalLock, "Lock prenotazione assente nel DB relazionale.");
  assert.equal(relationalLock.reservation_id, reservationId);
  assert.ok(
    ["kpre2-reservation-owner", "kpre2-reservation-contender"].includes(
      relationalLock.device_uuid,
    ),
  );

  const appState = await readJson(dbPath);
  const mirrored = appState.posReservationLocks.find(
    (entry) => entry.reservationId === reservationId,
  );
  assert.equal(mirrored.deviceUuid, relationalLock.device_uuid);
}
);
