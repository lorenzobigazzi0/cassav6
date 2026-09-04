import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  apiPost,
  authHeaders,
  authPayload,
  createTempRunDir,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";

const SERVICE_DATE = "2099-12-30";
const RESERVATION_AT = new Date(`${SERVICE_DATE}T20:00:00`).getTime();
const CLIENT_CREATED_AT = RESERVATION_AT - 60_000;
const CLIENT_RESERVATION_ID = "res_offline_replay_0001";
const CLIENT_RESERVATION_AFTER_DELETE_ID = "res_offline_replay_0002";

function seedEmptyReservationDay(state) {
  state.posReservationStates = [
    {
      key: `room_pedana__${SERVICE_DATE}`,
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
      version: 1,
      reservations: [],
    },
  ];
  state.posReservationLocks = [];
}

async function startReplayBackend(t, relational) {
  if (!relational) {
    return startBackend(t, {
      stateOverrides: seedEmptyReservationDay,
    });
  }
  const runDir = await createTempRunDir(
    "reservations-offline-replay-relational",
  );
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  return startBackend(t, {
    runDir,
    stateOverrides: seedEmptyReservationDay,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_RESERVATIONS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_RESERVATIONS_DELETE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_RESERVATIONS_STATUS_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_RESERVATIONS_UPDATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_RESERVATIONS_READS: "1",
    },
  });
}

function replayHeaders(session, deviceUuid, requestId) {
  return {
    ...authHeaders(session, deviceUuid),
    "X-Palmare-Device-Queue": "1",
    "X-Palmare-Offline-Replay": "1",
    "X-Command-Request-Id": requestId,
    "X-Idempotency-Key": `${requestId}:idempotency`,
  };
}

async function replayPost(
  baseUrl,
  session,
  deviceUuid,
  pathName,
  requestId,
  payload,
) {
  return apiPost(
    baseUrl,
    pathName,
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
      ...payload,
    }),
    { headers: replayHeaders(session, deviceUuid, requestId) },
  );
}

async function listReservations(baseUrl, session, deviceUuid) {
  return apiPost(
    baseUrl,
    "/api/pos/reservations/list",
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
    }),
    { headers: authHeaders(session, deviceUuid) },
  );
}

async function exerciseReplaySequence(t, relational) {
  const { baseUrl } = await startReplayBackend(t, relational);
  const deviceUuid = relational
    ? "offline-replay-relational"
    : "offline-replay-app-state";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const createPayload = {
    expectedVersion: 1,
    clientReservationId: CLIENT_RESERVATION_ID,
    clientCreatedAt: CLIENT_CREATED_AT,
    reservationAt: RESERVATION_AT,
    customerName: "Cliente offline",
    covers: 2,
    assignedTableId: null,
    assignedTableIds: [],
  };
  const created = await replayPost(
    baseUrl,
    session,
    deviceUuid,
    "/api/pos/reservations/create",
    "reservation-create-1",
    createPayload,
  );
  assert.equal(created.response.status, 200);
  assert.equal(created.body.version, 2);
  assert.equal(created.body.reservation.id, CLIENT_RESERVATION_ID);
  assert.equal(created.body.reservation.updatedAt, CLIENT_CREATED_AT);

  const duplicateCreate = await replayPost(
    baseUrl,
    session,
    deviceUuid,
    "/api/pos/reservations/create",
    "reservation-create-1",
    createPayload,
  );
  assert.equal(duplicateCreate.response.status, 200);
  assert.equal(duplicateCreate.body.replayed, true);

  const updatePayload = {
    reservationId: CLIENT_RESERVATION_ID,
    expectedVersion: 2,
    expectedUpdatedAt: CLIENT_CREATED_AT,
    resultUpdatedAt: CLIENT_CREATED_AT + 1,
    patch: { customerName: "Cliente offline aggiornato", covers: 3 },
  };
  const updated = await replayPost(
    baseUrl,
    session,
    deviceUuid,
    "/api/pos/reservations/update",
    "reservation-update-1",
    updatePayload,
  );
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.version, 3);
  assert.equal(
    updated.body.reservation.customerName,
    "Cliente offline aggiornato",
  );
  assert.equal(updated.body.reservation.updatedAt, CLIENT_CREATED_AT + 1);

  const duplicateUpdate = await replayPost(
    baseUrl,
    session,
    deviceUuid,
    "/api/pos/reservations/update",
    "reservation-update-1",
    updatePayload,
  );
  assert.equal(duplicateUpdate.response.status, 200);
  assert.equal(duplicateUpdate.body.replayed, true);

  const statusPayload = {
    reservationId: CLIENT_RESERVATION_ID,
    expectedVersion: 3,
    expectedUpdatedAt: CLIENT_CREATED_AT + 1,
    resultUpdatedAt: CLIENT_CREATED_AT + 2,
    action: "arrived",
  };
  const status = await replayPost(
    baseUrl,
    session,
    deviceUuid,
    "/api/pos/reservations/status",
    "reservation-status-1",
    statusPayload,
  );
  assert.equal(status.response.status, 200);
  assert.equal(status.body.version, 4);
  assert.equal(status.body.reservation.status, "arrived");
  assert.equal(status.body.reservation.updatedAt, CLIENT_CREATED_AT + 2);

  const duplicateStatus = await replayPost(
    baseUrl,
    session,
    deviceUuid,
    "/api/pos/reservations/status",
    "reservation-status-1",
    statusPayload,
  );
  assert.equal(duplicateStatus.response.status, 200);
  assert.equal(duplicateStatus.body.replayed, true);

  const staleUpdate = await replayPost(
    baseUrl,
    session,
    deviceUuid,
    "/api/pos/reservations/update",
    "reservation-update-stale",
    {
      ...updatePayload,
      patch: { customerName: "Sovrascrittura vietata" },
    },
  );
  assert.equal(staleUpdate.response.status, 409);
  assert.equal(staleUpdate.body.code, "RESERVATION_OFFLINE_REPLAY_CONFLICT");

  const listedBeforeDelete = await listReservations(
    baseUrl,
    session,
    deviceUuid,
  );
  assert.equal(listedBeforeDelete.response.status, 200);
  assert.equal(listedBeforeDelete.body.reservations.length, 1);
  assert.equal(
    listedBeforeDelete.body.reservations[0].customerName,
    "Cliente offline aggiornato",
  );
  assert.equal(
    "offlineReplay" in listedBeforeDelete.body.reservations[0],
    false,
  );

  const deletePayload = {
    reservationId: CLIENT_RESERVATION_ID,
    expectedVersion: 4,
    expectedUpdatedAt: CLIENT_CREATED_AT + 2,
  };
  const deleted = await replayPost(
    baseUrl,
    session,
    deviceUuid,
    "/api/pos/reservations/delete",
    "reservation-delete-1",
    deletePayload,
  );
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.deleted, true);
  assert.equal(deleted.body.version, 5);

  const duplicateDelete = await replayPost(
    baseUrl,
    session,
    deviceUuid,
    "/api/pos/reservations/delete",
    "reservation-delete-1",
    deletePayload,
  );
  assert.equal(duplicateDelete.response.status, 200);
  assert.equal(duplicateDelete.body.replayed, true);

  const listedAfterDelete = await listReservations(
    baseUrl,
    session,
    deviceUuid,
  );
  assert.equal(listedAfterDelete.response.status, 200);
  assert.equal(listedAfterDelete.body.version, 5);
  assert.deepEqual(listedAfterDelete.body.reservations, []);

  const createdAfterDelete = await replayPost(
    baseUrl,
    session,
    deviceUuid,
    "/api/pos/reservations/create",
    "reservation-create-after-delete",
    {
      expectedVersion: 5,
      clientReservationId: CLIENT_RESERVATION_AFTER_DELETE_ID,
      clientCreatedAt: CLIENT_CREATED_AT + 3,
      reservationAt: RESERVATION_AT + 3_600_000,
      customerName: "Cliente dopo eliminazione",
      covers: 4,
      assignedTableId: null,
      assignedTableIds: [],
    },
  );
  assert.equal(createdAfterDelete.response.status, 200);
  assert.equal(createdAfterDelete.body.version, 6);
  assert.equal(
    createdAfterDelete.body.reservation.id,
    CLIENT_RESERVATION_AFTER_DELETE_ID,
  );

  const listedAfterRecreate = await listReservations(
    baseUrl,
    session,
    deviceUuid,
  );
  assert.equal(listedAfterRecreate.response.status, 200);
  assert.equal(listedAfterRecreate.body.version, 6);
  assert.deepEqual(
    listedAfterRecreate.body.reservations.map((entry) => entry.id),
    [CLIENT_RESERVATION_AFTER_DELETE_ID],
  );
}

test("replay prenotazioni FIFO e idempotente su app-state", async (t) => {
  await exerciseReplaySequence(t, false);
});

test("replay prenotazioni FIFO e idempotente su write-primary relazionale", async (t) => {
  await exerciseReplaySequence(t, true);
});
