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

const SERVICE_DATE = "2099-12-31";
const RESERVATION_AT = new Date(`${SERVICE_DATE}T20:00:00`).getTime();

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
          id: "res_lock_primary_1",
          roomId: "room_pedana",
          serviceDate: SERVICE_DATE,
          reservationAt: RESERVATION_AT,
          customerName: "Cliente Lock",
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

function lockWriteEnv(relationalPath) {
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

async function startLockWriteBackend(t, options = {}) {
  const runDir = await createTempRunDir(options.prefix ?? "rel-reservations-lock-write");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const server = await startBackend(t, {
    runDir,
    stateOverrides: seedReservationState,
    env: options.env ?? lockWriteEnv(relationalPath),
  });
  return { ...server, relationalPath, runDir };
}

async function readRelationalLock(relationalPath) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    return db.prepare("SELECT * FROM reservation_locks WHERE reservation_id = ?").get("res_lock_primary_1");
  } finally {
    closeRelationalConnection(db);
  }
}

async function readRelationalReservation(relationalPath, reservationId = "res_lock_primary_1") {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    return db.prepare("SELECT * FROM reservations WHERE id = ?").get(reservationId);
  } finally {
    closeRelationalConnection(db);
  }
}

async function readRelationalAssignments(relationalPath, reservationId = "res_lock_primary_1") {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    return db
      .prepare("SELECT table_id FROM reservation_table_assignments WHERE reservation_id = ? ORDER BY position ASC")
      .all(reservationId)
      .map((row) => row.table_id);
  } finally {
    closeRelationalConnection(db);
  }
}

async function countRelationalReservations(relationalPath) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    return db.prepare("SELECT COUNT(*) AS count FROM reservations").get().count;
  } finally {
    closeRelationalConnection(db);
  }
}

async function acquireReservationLock(baseUrl, session, deviceUuid) {
  return apiPost(
    baseUrl,
    "/api/pos/reservations/lock/acquire",
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
      reservationId: "res_lock_primary_1",
    })
  );
}

async function releaseReservationLock(baseUrl, session, deviceUuid, lockId) {
  return apiPost(
    baseUrl,
    "/api/pos/reservations/lock/release",
    authPayload(session, deviceUuid, {
      reservationId: "res_lock_primary_1",
      lockId,
    })
  );
}

async function createReservation(baseUrl, session, deviceUuid, payload = {}) {
  return apiPost(
    baseUrl,
    "/api/pos/reservations/create",
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
      reservationAt: RESERVATION_AT + 2 * 60 * 60_000,
      customerName: "Cliente Nuovo",
      customerPhone: "+390009",
      covers: 3,
      assignedTableId: "room_pedana_t06",
      assignedTableIds: ["room_pedana_t06"],
      ...payload,
    })
  );
}

async function updateReservation(baseUrl, session, deviceUuid, lockId, patch) {
  return apiPost(
    baseUrl,
    "/api/pos/reservations/update",
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
      reservationId: "res_lock_primary_1",
      lockId,
      patch,
    })
  );
}

async function deleteReservation(baseUrl, session, deviceUuid, lockId, reservationId = "res_lock_primary_1") {
  return apiPost(
    baseUrl,
    "/api/pos/reservations/delete",
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
      reservationId,
      lockId,
    })
  );
}

async function setReservationStatus(baseUrl, session, deviceUuid, action, reservationId = "res_lock_primary_1") {
  return apiPost(
    baseUrl,
    "/api/pos/reservations/status",
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
      reservationId,
      action,
    })
  );
}

test("J2 reservations lock acquire write-primary scrive relazionale e mirror app-state", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startLockWriteBackend(t);
  const deviceUuid = "reservation-lock-primary-device";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const first = await acquireReservationLock(baseUrl, session, deviceUuid);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.lock.userId, "u_admin");
  assert.equal(first.body.lock.deviceUuid, deviceUuid);

  const relationalLock = await readRelationalLock(relationalPath);
  assert.equal(relationalLock.lock_id, first.body.lock.lockId);
  assert.equal(relationalLock.user_id, "u_admin");
  assert.equal(relationalLock.device_uuid, deviceUuid);

  const appState = await readJson(dbPath);
  const mirrored = appState.posReservationLocks.find((entry) => entry.reservationId === "res_lock_primary_1");
  assert.equal(mirrored.lockId, first.body.lock.lockId);
  assert.equal(mirrored.userId, "u_admin");
  assert.equal(mirrored.deviceUuid, deviceUuid);

  const second = await acquireReservationLock(baseUrl, session, deviceUuid);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.lock.lockId, first.body.lock.lockId);
  assert.ok(Number(second.body.lock.expiresAt) >= Number(first.body.lock.expiresAt));
});

test("J5 reservations create write-primary crea relazionale e mirror app-state", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-create-primary",
  });
  const deviceUuid = "reservation-create-primary-device";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const created = await createReservation(baseUrl, session, deviceUuid);
  assert.equal(created.response.status, 200);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.version, 4);
  assert.equal(created.body.reservation.customerName, "Cliente Nuovo");
  assert.deepEqual(created.body.reservation.assignedTableIds, ["room_pedana_t06"]);

  const relationalReservation = await readRelationalReservation(relationalPath, created.body.reservation.id);
  assert.equal(relationalReservation.customer_name, "Cliente Nuovo");
  assert.equal(relationalReservation.covers, 3);
  assert.equal(relationalReservation.assigned_table_id, "room_pedana_t06");
  assert.equal(relationalReservation.revision, 4);
  assert.deepEqual(await readRelationalAssignments(relationalPath, created.body.reservation.id), ["room_pedana_t06"]);

  const appState = await readJson(dbPath);
  const state = appState.posReservationStates.find((entry) => entry.key === `room_pedana__${SERVICE_DATE}`);
  assert.equal(state.version, 4);
  assert.equal(state.reservations.length, 2);
  assert.equal(state.reservations.some((entry) => entry.id === created.body.reservation.id), true);
});

test("J5 reservations create write-primary valida disponibilita dal relazionale", async (t) => {
  const { baseUrl, relationalPath } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-create-conflict",
  });
  const deviceUuid = "reservation-create-conflict-device";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const response = await createReservation(baseUrl, session, deviceUuid, {
    reservationAt: RESERVATION_AT + 10 * 60_000,
    assignedTableId: "room_pedana_t05",
    assignedTableIds: ["room_pedana_t05"],
  });
  assert.equal(response.response.status, 409);
  assert.match(response.body.error, /Tavolo gia assegnato/i);
  assert.equal(await countRelationalReservations(relationalPath), 1);
});

test("J5 reservations create write-primary fallisce chiaramente senza DB relazionale", async (t) => {
  const { baseUrl } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-create-missing-db",
    env: { BACKEND_RELATIONAL_RESERVATIONS_CREATE_WRITE_PRIMARY: "1" },
  });
  const deviceUuid = "reservation-create-no-db";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const response = await createReservation(baseUrl, session, deviceUuid);
  assert.equal(response.response.status, 503);
  assert.match(response.body.error, /relazionale prenotazioni non disponibile/i);
});

test("J7 reservations delete write-primary elimina relazionale, lock e mirror app-state", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-delete-primary",
  });
  const deviceUuid = "reservation-delete-primary-owner";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const acquired = await acquireReservationLock(baseUrl, session, deviceUuid);
  assert.equal(acquired.response.status, 200);

  const response = await deleteReservation(baseUrl, session, deviceUuid, acquired.body.lock.lockId);
  assert.equal(response.response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.deleted, true);
  assert.equal(response.body.version, 4);

  assert.equal(await readRelationalReservation(relationalPath), undefined);
  assert.equal(await readRelationalLock(relationalPath), undefined);
  assert.deepEqual(await readRelationalAssignments(relationalPath), []);

  const appState = await readJson(dbPath);
  const state = appState.posReservationStates.find((entry) => entry.key === `room_pedana__${SERVICE_DATE}`);
  assert.equal(state.version, 4);
  assert.equal(state.reservations.some((entry) => entry.id === "res_lock_primary_1"), false);
  assert.equal(appState.posReservationLocks.some((entry) => entry.reservationId === "res_lock_primary_1"), false);
});

test("J7 reservations delete write-primary rifiuta lock di altro device", async (t) => {
  const { baseUrl, relationalPath } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-delete-conflict",
  });
  const owner = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "reservation-delete-owner",
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "reservation-delete-other",
    clientApp: "mobile-frontend",
  });
  const acquired = await acquireReservationLock(baseUrl, owner, "reservation-delete-owner");
  assert.equal(acquired.response.status, 200);

  const response = await deleteReservation(
    baseUrl,
    manager,
    "reservation-delete-other",
    acquired.body.lock.lockId
  );
  assert.equal(response.response.status, 409);
  assert.match(response.body.error, /altro operatore/i);

  const relationalReservation = await readRelationalReservation(relationalPath);
  assert.equal(relationalReservation.id, "res_lock_primary_1");
  assert.equal(relationalReservation.revision, 3);
  const relationalLock = await readRelationalLock(relationalPath);
  assert.equal(relationalLock.lock_id, acquired.body.lock.lockId);
});

test("J7 reservations delete write-primary fallisce chiaramente senza DB relazionale", async (t) => {
  const { baseUrl } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-delete-missing-db",
    env: { BACKEND_RELATIONAL_RESERVATIONS_DELETE_WRITE_PRIMARY: "1" },
  });
  const deviceUuid = "reservation-delete-no-db";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const response = await deleteReservation(baseUrl, session, deviceUuid, "lock_missing");
  assert.equal(response.response.status, 503);
  assert.match(response.body.error, /relazionale prenotazioni non disponibile/i);
});

test("J2 reservations lock acquire write-primary rifiuta lock attivo di altro device", async (t) => {
  const { baseUrl, relationalPath } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-lock-conflict",
  });
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "reservation-lock-owner",
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "reservation-lock-other",
    clientApp: "mobile-frontend",
  });

  const first = await acquireReservationLock(baseUrl, session, "reservation-lock-owner");
  assert.equal(first.response.status, 200);

  const conflict = await acquireReservationLock(baseUrl, manager, "reservation-lock-other");
  assert.equal(conflict.response.status, 409);
  assert.match(conflict.body.error, /altro operatore/i);

  const relationalLock = await readRelationalLock(relationalPath);
  assert.equal(relationalLock.lock_id, first.body.lock.lockId);
  assert.equal(relationalLock.user_id, "u_admin");
  assert.equal(relationalLock.device_uuid, "reservation-lock-owner");
});

test("J2 reservations lock acquire write-primary fallisce chiaramente senza DB relazionale", async (t) => {
  const { baseUrl } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-lock-missing-db",
    env: { BACKEND_RELATIONAL_RESERVATIONS_LOCK_ACQUIRE_WRITE_PRIMARY: "1" },
  });
  const deviceUuid = "reservation-lock-no-db";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const response = await acquireReservationLock(baseUrl, session, deviceUuid);
  assert.equal(response.response.status, 503);
  assert.match(response.body.error, /relazionale prenotazioni non disponibile/i);
});

test("J6 reservations status write-primary aggiorna relazionale, mirror e rimuove lock", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-status-primary",
  });
  const deviceUuid = "reservation-status-primary-owner";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const acquired = await acquireReservationLock(baseUrl, session, deviceUuid);
  assert.equal(acquired.response.status, 200);

  const response = await setReservationStatus(baseUrl, session, deviceUuid, "no_show");
  assert.equal(response.response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.version, 4);
  assert.equal(response.body.reservation.status, "no_show");
  assert.ok(Number(response.body.reservation.releasedAt) > 0);
  assert.ok(Number(response.body.reservation.noShowAt) > 0);

  const relationalReservation = await readRelationalReservation(relationalPath);
  assert.equal(relationalReservation.status, "no_show");
  assert.equal(relationalReservation.revision, 4);
  assert.ok(Number(relationalReservation.released_at_ms) > 0);
  assert.ok(Number(relationalReservation.no_show_at_ms) > 0);
  assert.equal(await readRelationalLock(relationalPath), undefined);

  const appState = await readJson(dbPath);
  const state = appState.posReservationStates.find((entry) => entry.key === `room_pedana__${SERVICE_DATE}`);
  assert.equal(state.version, 4);
  assert.equal(state.reservations[0].status, "no_show");
  assert.equal(appState.posReservationLocks.some((entry) => entry.reservationId === "res_lock_primary_1"), false);
});

test("J6 reservations status write-primary rifiuta lock attivo di altro device", async (t) => {
  const { baseUrl, relationalPath } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-status-conflict",
  });
  const owner = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "reservation-status-owner",
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "reservation-status-other",
    clientApp: "mobile-frontend",
  });
  const acquired = await acquireReservationLock(baseUrl, owner, "reservation-status-owner");
  assert.equal(acquired.response.status, 200);

  const response = await setReservationStatus(baseUrl, manager, "reservation-status-other", "cancelled");
  assert.equal(response.response.status, 409);
  assert.match(response.body.error, /altro operatore/i);

  const relationalReservation = await readRelationalReservation(relationalPath);
  assert.equal(relationalReservation.status, "booked");
  assert.equal(relationalReservation.revision, 3);
  const relationalLock = await readRelationalLock(relationalPath);
  assert.equal(relationalLock.lock_id, acquired.body.lock.lockId);
});

test("J6 reservations status write-primary fallisce chiaramente senza DB relazionale", async (t) => {
  const { baseUrl } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-status-missing-db",
    env: { BACKEND_RELATIONAL_RESERVATIONS_STATUS_WRITE_PRIMARY: "1" },
  });
  const deviceUuid = "reservation-status-no-db";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const response = await setReservationStatus(baseUrl, session, deviceUuid, "released");
  assert.equal(response.response.status, 503);
  assert.match(response.body.error, /relazionale prenotazioni non disponibile/i);
});

test("J4 reservations update write-primary aggiorna relazionale e mirror app-state", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-update-primary",
  });
  const deviceUuid = "reservation-update-primary-owner";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const acquired = await acquireReservationLock(baseUrl, session, deviceUuid);
  assert.equal(acquired.response.status, 200);

  const updated = await updateReservation(
    baseUrl,
    session,
    deviceUuid,
    acquired.body.lock.lockId,
    {
      customerName: "Cliente Aggiornato",
      covers: 5,
      note: "Nota aggiornata",
      assignedTableId: "room_pedana_t06",
      assignedTableIds: ["room_pedana_t06"],
    }
  );
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.ok, true);
  assert.equal(updated.body.version, 4);
  assert.equal(updated.body.reservation.customerName, "Cliente Aggiornato");
  assert.equal(updated.body.reservation.covers, 5);
  assert.deepEqual(updated.body.reservation.assignedTableIds, ["room_pedana_t06"]);

  const relationalReservation = await readRelationalReservation(relationalPath);
  assert.equal(relationalReservation.customer_name, "Cliente Aggiornato");
  assert.equal(relationalReservation.covers, 5);
  assert.equal(relationalReservation.note, "Nota aggiornata");
  assert.equal(relationalReservation.assigned_table_id, "room_pedana_t06");
  assert.equal(relationalReservation.revision, 4);
  assert.deepEqual(await readRelationalAssignments(relationalPath), ["room_pedana_t06"]);

  const appState = await readJson(dbPath);
  const state = appState.posReservationStates.find((entry) => entry.key === `room_pedana__${SERVICE_DATE}`);
  assert.equal(state.version, 4);
  assert.equal(state.reservations[0].customerName, "Cliente Aggiornato");
  assert.equal(state.reservations[0].assignedTableId, "room_pedana_t06");
  assert.deepEqual(state.reservations[0].assignedTableIds, ["room_pedana_t06"]);
});

test("J4 reservations update write-primary rifiuta lock di altro device", async (t) => {
  const { baseUrl, relationalPath } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-update-conflict",
  });
  const owner = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "reservation-update-owner",
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "reservation-update-other",
    clientApp: "mobile-frontend",
  });
  const acquired = await acquireReservationLock(baseUrl, owner, "reservation-update-owner");
  assert.equal(acquired.response.status, 200);

  const response = await updateReservation(
    baseUrl,
    manager,
    "reservation-update-other",
    acquired.body.lock.lockId,
    { customerName: "Intruso" }
  );
  assert.equal(response.response.status, 409);
  assert.match(response.body.error, /altro operatore/i);

  const relationalReservation = await readRelationalReservation(relationalPath);
  assert.equal(relationalReservation.customer_name, "Cliente Lock");
  assert.equal(relationalReservation.revision, 3);
});

test("J4 reservations update write-primary fallisce chiaramente senza DB relazionale", async (t) => {
  const { baseUrl } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-update-missing-db",
    env: { BACKEND_RELATIONAL_RESERVATIONS_UPDATE_WRITE_PRIMARY: "1" },
  });
  const deviceUuid = "reservation-update-no-db";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const response = await updateReservation(baseUrl, session, deviceUuid, "lock_missing", {
    customerName: "Cliente Offline",
  });
  assert.equal(response.response.status, 503);
  assert.match(response.body.error, /relazionale prenotazioni non disponibile/i);
});

test("J3 reservations lock release write-primary rimuove relazionale e mirror app-state", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-lock-release",
  });
  const deviceUuid = "reservation-lock-release-owner";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const acquired = await acquireReservationLock(baseUrl, session, deviceUuid);
  assert.equal(acquired.response.status, 200);

  const released = await releaseReservationLock(baseUrl, session, deviceUuid, acquired.body.lock.lockId);
  assert.equal(released.response.status, 200);
  assert.equal(released.body.released, true);
  assert.equal(await readRelationalLock(relationalPath), undefined);
  const appState = await readJson(dbPath);
  assert.equal(appState.posReservationLocks.some((entry) => entry.reservationId === "res_lock_primary_1"), false);
});

test("J3 reservations lock release write-primary non rimuove lock di altro device", async (t) => {
  const { baseUrl, relationalPath } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-lock-release-conflict",
  });
  const owner = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "reservation-lock-release-owner",
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "reservation-lock-release-other",
    clientApp: "mobile-frontend",
  });
  const acquired = await acquireReservationLock(baseUrl, owner, "reservation-lock-release-owner");
  assert.equal(acquired.response.status, 200);

  const released = await releaseReservationLock(
    baseUrl,
    manager,
    "reservation-lock-release-other",
    acquired.body.lock.lockId
  );
  assert.equal(released.response.status, 200);
  assert.equal(released.body.released, false);
  const relationalLock = await readRelationalLock(relationalPath);
  assert.equal(relationalLock.lock_id, acquired.body.lock.lockId);
  assert.equal(relationalLock.user_id, "u_admin");
});

test("J3 reservations lock release write-primary fallisce chiaramente senza DB relazionale", async (t) => {
  const { baseUrl } = await startLockWriteBackend(t, {
    prefix: "rel-reservations-release-missing-db",
    env: { BACKEND_RELATIONAL_RESERVATIONS_LOCK_RELEASE_WRITE_PRIMARY: "1" },
  });
  const deviceUuid = "reservation-lock-release-no-db";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const response = await releaseReservationLock(baseUrl, session, deviceUuid, "lock_missing");
  assert.equal(response.response.status, 503);
  assert.match(response.body.error, /relazionale prenotazioni non disponibile/i);
});
