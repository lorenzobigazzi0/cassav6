import assert from "node:assert/strict";
import test from "node:test";
import {
  apiPost,
  authPayload,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function createNearReservation(
  baseUrl,
  session,
  deviceUuid,
  overrides = {},
) {
  const reservationAt = overrides.reservationAt ?? Date.now() + 5 * 60_000;
  const payload = authPayload(session, deviceUuid, {
    roomId: "room_pedana",
    serviceDate: localDateKey(new Date(reservationAt)),
    reservationAt,
    customerName: overrides.customerName ?? "Cliente Prenotato",
    customerPhone: "+39 333 1111111",
    covers: 2,
    assignedTableId: "room_pedana_t05",
    assignedTableIds: ["room_pedana_t05"],
  });
  const { response, body } = await apiPost(
    baseUrl,
    "/api/pos/reservations/create",
    payload,
  );
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  return body.reservation;
}

async function fetchLayoutTable(baseUrl, tableId = "room_pedana_t05") {
  const response = await fetch(`${baseUrl}/api/integration/layout`);
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.tables.find((table) => table.id === tableId);
}

async function listReservations(baseUrl, session, deviceUuid, serviceDate) {
  const { response, body } = await apiPost(
    baseUrl,
    "/api/pos/reservations/list",
    authPayload(session, deviceUuid, { roomId: "room_pedana", serviceDate }),
  );
  assert.equal(response.status, 200);
  return body.reservations;
}

test("reservation availability non persiste giornate vuote", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const deviceUuid = "admin-availability-device";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const serviceDate = "2099-12-31";
  const hasEmptyState = (db) =>
    (db.posReservationStates ?? []).some(
      (entry) =>
        entry.roomId === "room_pedana" && entry.serviceDate === serviceDate,
    );

  assert.equal(hasEmptyState(await readJson(dbPath)), false);
  const { response, body } = await apiPost(
    baseUrl,
    "/api/pos/reservations/availability",
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate,
      reservationAt: new Date(`${serviceDate}T20:00:00`).getTime(),
      tableIds: ["room_pedana_t05"],
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 1);
  assert.equal(hasEmptyState(await readJson(dbPath)), false);
});

test("reservation no_show libera un tavolo prenotato e impedisce riattivazioni zombie", async (t) => {
  const { baseUrl } = await startBackend(t);
  const deviceUuid = "admin-reservation-device";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const reservation = await createNearReservation(
    baseUrl,
    session,
    deviceUuid,
    {
      customerName: "No Show Test",
    },
  );

  const reservedTable = await fetchLayoutTable(baseUrl);
  assert.equal(reservedTable.occupancyState, "reserved");

  const { response, body } = await apiPost(
    baseUrl,
    "/api/pos/reservations/status",
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate: reservation.serviceDate,
      reservationId: reservation.id,
      action: "no_show",
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.reservation.status, "no_show");
  assert.equal(body.tablesChanged, true);

  const freeTable = await fetchLayoutTable(baseUrl);
  assert.equal(freeTable.occupancyState, "free");

  const afterRefresh = await fetchLayoutTable(baseUrl);
  assert.equal(afterRefresh.occupancyState, "free");

  const reservations = await listReservations(
    baseUrl,
    session,
    deviceUuid,
    reservation.serviceDate,
  );
  assert.equal(
    reservations.find((entry) => entry.id === reservation.id)?.status,
    "no_show",
  );
});

test("reservation arrived passa il tavolo prenotato ad accomodato senza lasciare la prenotazione attiva", async (t) => {
  const { baseUrl } = await startBackend(t);
  const deviceUuid = "admin-arrived-device";
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const reservation = await createNearReservation(
    baseUrl,
    session,
    deviceUuid,
    {
      customerName: "Arrivati Test",
    },
  );

  const reservedTable = await fetchLayoutTable(baseUrl);
  assert.equal(reservedTable.occupancyState, "reserved");

  const { response, body } = await apiPost(
    baseUrl,
    "/api/pos/reservations/status",
    authPayload(session, deviceUuid, {
      roomId: "room_pedana",
      serviceDate: reservation.serviceDate,
      reservationId: reservation.id,
      action: "arrived",
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.reservation.status, "arrived");
  assert.equal(body.tablesChanged, true);

  const arrivedTable = await fetchLayoutTable(baseUrl);
  assert.equal(arrivedTable.occupancyState, "seated");
  assert.equal(arrivedTable.tableName, "Arrivati Test");

  const reservations = await listReservations(
    baseUrl,
    session,
    deviceUuid,
    reservation.serviceDate,
  );
  assert.equal(
    reservations.find((entry) => entry.id === reservation.id)?.status,
    "arrived",
  );
});
