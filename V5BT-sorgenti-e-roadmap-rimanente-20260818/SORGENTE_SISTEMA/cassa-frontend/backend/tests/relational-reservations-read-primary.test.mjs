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
  startBackend,
} from "./helpers/test-server.mjs";

const SERVICE_DATE = "2099-12-31";
const RESERVATION_AT = new Date(`${SERVICE_DATE}T20:00:00`).getTime();
const EXPIRES_AT = new Date(`${SERVICE_DATE}T21:00:00`).getTime();

function seedReservationsState(state) {
  state.meta.lastWriteAt = "2026-05-13T19:10:00.000Z";
  state.posReservationStates = [
    {
      key: `room_pedana__${SERVICE_DATE}`,
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
      version: 7,
      reservations: [
        {
          id: "res_read_primary_1",
          roomId: "room_pedana",
          serviceDate: SERVICE_DATE,
          reservationAt: RESERVATION_AT,
          customerName: "Cliente App State",
          customerPhone: "+390001",
          covers: 4,
          intolerances: "",
          note: "",
          assignedTableId: "room_pedana_t05",
          assignedTableIds: ["room_pedana_t05"],
          createdAt: RESERVATION_AT - 60_000,
          updatedAt: RESERVATION_AT - 30_000,
        },
      ],
    },
  ];
  state.posReservationLocks = [
    {
      reservationId: "res_read_primary_1",
      lockId: "lock_read_primary_1",
      userId: "u_admin",
      deviceUuid: "reservation-read-device",
      expiresAt: EXPIRES_AT,
    },
  ];
}

function reservationsReadEnv(relationalPath) {
  return {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "shadow",
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
    BACKEND_RELATIONAL_RESERVATIONS_READS: "1",
  };
}

async function updateRelationalReservation(relationalPath) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    const reservation = db.prepare("SELECT raw_json FROM reservations WHERE id = ?").get("res_read_primary_1");
    const rawReservation = JSON.parse(reservation.raw_json);
    rawReservation.customerName = "Cliente Relazionale";
    db.prepare("UPDATE reservations SET customer_name = ?, raw_json = ? WHERE id = ?")
      .run("Cliente Relazionale", JSON.stringify(rawReservation), "res_read_primary_1");

    const lock = db.prepare("SELECT raw_json FROM reservation_locks WHERE reservation_id = ?").get("res_read_primary_1");
    const rawLock = JSON.parse(lock.raw_json);
    rawLock.userId = "u_manager";
    rawLock.deviceUuid = "other-reservation-device";
    db.prepare("UPDATE reservation_locks SET user_id = ?, device_uuid = ?, raw_json = ? WHERE reservation_id = ?")
      .run("u_manager", "other-reservation-device", JSON.stringify(rawLock), "res_read_primary_1");
  } finally {
    closeRelationalConnection(db);
  }
}

async function startReservationsReadBackend(t, options = {}) {
  const runDir = await createTempRunDir(options.prefix ?? "rel-reservations-read");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const server = await startBackend(t, {
    runDir,
    stateOverrides: seedReservationsState,
    env: options.env ?? reservationsReadEnv(relationalPath),
  });
  return { ...server, relationalPath, runDir };
}

test("J1 reservations read-primary usa relazionale per list, availability e lock/state", async (t) => {
  const { baseUrl, relationalPath } = await startReservationsReadBackend(t);
  const deviceUuid = "reservation-read-device";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  await updateRelationalReservation(relationalPath);

  const list = await apiPost(
    baseUrl,
    "/api/pos/reservations/list",
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
    })
  );
  assert.equal(list.response.status, 200);
  assert.equal(list.body.reservations[0].customerName, "Cliente Relazionale");
  assert.equal(list.body.version, 7);

  const availability = await apiPost(
    baseUrl,
    "/api/pos/reservations/availability",
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
      reservationAt: RESERVATION_AT + 10 * 60_000,
      tableIds: ["room_pedana_t05"],
    })
  );
  assert.equal(availability.response.status, 200);
  assert.equal(availability.body.items[0].status, "conflict");
  assert.equal(availability.body.items[0].nearestReservation.customerName, "Cliente Relazionale");

  const lockState = await apiPost(
    baseUrl,
    "/api/pos/reservations/lock/state",
    authPayload(session, deviceUuid, {
      reservationId: "res_read_primary_1",
    })
  );
  assert.equal(lockState.response.status, 200);
  assert.equal(lockState.body.locked, true);
  assert.equal(lockState.body.byCurrentSession, false);
});

test("J1 reservations read-primary torna ad app-state se il relazionale non e disponibile", async (t) => {
  const { baseUrl } = await startReservationsReadBackend(t, {
    prefix: "rel-reservations-read-fallback",
    env: { BACKEND_RELATIONAL_RESERVATIONS_READS: "1" },
  });
  const deviceUuid = "reservation-fallback-device";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });

  const list = await apiPost(
    baseUrl,
    "/api/pos/reservations/list",
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate: SERVICE_DATE,
    })
  );
  assert.equal(list.response.status, 200);
  assert.equal(list.body.reservations[0].customerName, "Cliente App State");
});
