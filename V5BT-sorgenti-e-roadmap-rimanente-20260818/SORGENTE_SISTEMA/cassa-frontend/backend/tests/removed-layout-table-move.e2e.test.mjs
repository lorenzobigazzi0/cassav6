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
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

const SOURCE_TABLE_ID = "removed_room_sala_t91";
const SOURCE_ROOM_ID = "room_sala";
const TARGET_TABLE_ID = "room_sala_t02";
const DELETED_ROOM_TARGET_ID = "room_pedana_t05";
const DELETED_ROOM_TARGET_ROOM_ID = "room_pedana";

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function removedSourceSnapshot(overrides = {}) {
  const now = Date.now();
  return {
    id: SOURCE_TABLE_ID,
    number: 91,
    roomId: SOURCE_ROOM_ID,
    tableName: "Mario Rossi",
    customerPhone: "3331234567",
    covers: 2,
    occupancyState: "seated",
    reservationAt: null,
    seatedAt: now - 10_000,
    ordersTaken: 1,
    ordersInProgress: 1,
    amountDue: 0,
    note: "Tavolo operativo rimosso",
    allergens: ["Glutine"],
    manualIntolerance: "",
    offlineLifecycle: {
      state: "removed_while_active",
      removedAt: now - 1_000,
      removedFromLayoutVersion: now - 1_000,
      usableUntil: "released",
      requiresDecision: false,
      decision: "keep",
    },
    ...overrides,
  };
}

async function loginManager(baseUrl, deviceUuid) {
  return loginJson(baseUrl, "manager", "4444", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
}

async function lockMoveTarget(baseUrl, session, deviceUuid) {
  const locked = await acquireTableLock(baseUrl, session, TARGET_TABLE_ID, {
    deviceUuid,
    purpose: "table.move_target",
  });
  assert.equal(locked.response.status, 200, JSON.stringify(locked.body));
}

async function moveRemovedSource(baseUrl, session, deviceUuid, snapshot) {
  return apiPost(
    baseUrl,
    "/api/integration/layout/table/move",
    authPayload(session, deviceUuid, {
      roomId: SOURCE_ROOM_ID,
      targetRoomId: SOURCE_ROOM_ID,
      fromTableId: SOURCE_TABLE_ID,
      toTableId: TARGET_TABLE_ID,
      removedSourceSnapshot: snapshot,
    }),
    { headers: authHeaders(session, deviceUuid) },
  );
}

function removeSourceRoomConfiguration(state) {
  state.posSettings.tables = state.posSettings.tables.filter(
    (table) => String(table?.roomId ?? "").trim() !== SOURCE_ROOM_ID,
  );
  state.posSettings.rooms = (state.posSettings.rooms ?? []).filter(
    (room) =>
      String(room?.id ?? room?.roomId ?? "").trim() !== SOURCE_ROOM_ID,
  );
  state.posSettings.areas = (state.posSettings.areas ?? []).filter(
    (room) =>
      String(room?.id ?? room?.roomId ?? "").trim() !== SOURCE_ROOM_ID,
  );
  state.posSettings.activityRoomBindings = (
    state.posSettings.activityRoomBindings ?? []
  ).filter(
    (binding) =>
      String(binding?.roomId ?? "").trim() !== SOURCE_ROOM_ID,
  );

  const manager = state.users.find((user) => user.id === "u_manager");
  manager.role = "operator";
  manager.roleLabel = "Operatore";
  manager.permissions = ["manage_tables", "print_orders"];
  manager.enabledRoomIds = [
    ...new Set([...(manager.enabledRoomIds ?? []), SOURCE_ROOM_ID]),
  ];
  manager.authorizedRoomIds = [
    ...new Set([...(manager.authorizedRoomIds ?? []), SOURCE_ROOM_ID]),
  ];
}

test("sposta una tombstone operativa senza reinserirla nella configurazione", async (t) => {
  const now = Date.now();
  const orderId = "removed-source-order-1";
  const deviceUuid = "removed-source-order-device";
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      state.integration.orders.push({
        id: orderId,
        revision: 1,
        source: "mobile-frontend",
        roomId: SOURCE_ROOM_ID,
        tableId: SOURCE_TABLE_ID,
        table: 91,
        tableNumber: 91,
        tableLabel: "91",
        total: 4.5,
        paidAmount: 0,
        dueAmount: 4.5,
        paymentStatus: "unpaid",
        workflowStatus: "waiting",
        station: "BAR-1",
        receivedAtMs: now - 5_000,
        createdAt: new Date(now - 5_000).toISOString(),
        updatedAt: new Date(now - 5_000).toISOString(),
        items: [
          {
            id: "removed-source-line-1",
            lineId: "removed-source-line-1",
            productId: "menu_caffetteria_caffe",
            name: "Caffe",
            qty: 1,
            unitPriceApplied: 4.5,
            listPriceAtTime: 4.5,
            lineTotal: 4.5,
            routeStations: ["BAR-1"],
          },
        ],
      });
      state.auditEvents.push({
        id: "removed-source-session-opened",
        occurredAt: new Date(now - 10_000).toISOString(),
        actorUserId: "u_manager",
        actorRole: "MANAGER",
        action: "table.session_opened",
        entityType: "table",
        entityId: SOURCE_TABLE_ID,
        roomId: SOURCE_ROOM_ID,
        payload: {
          tableId: SOURCE_TABLE_ID,
          tableNumber: 91,
          seatedAt: now - 10_000,
        },
      });
    },
  });
  const session = await loginManager(baseUrl, deviceUuid);
  const snapshot = removedSourceSnapshot({ seatedAt: now - 10_000 });

  const unlocked = await moveRemovedSource(baseUrl, session, deviceUuid, snapshot);
  assert.equal(unlocked.response.status, 428);
  assert.equal(unlocked.body?.code, "TABLE_LOCK_REQUIRED");

  await lockMoveTarget(baseUrl, session, deviceUuid);
  const moved = await moveRemovedSource(baseUrl, session, deviceUuid, snapshot);
  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body?.ok, true);
  assert.equal(moved.body?.movedOrdersCount, 1);
  assert.equal(moved.body?.fromTable?.id, SOURCE_TABLE_ID);
  assert.equal(moved.body?.fromTable?.status, "free");
  assert.equal(moved.body?.toTable?.id, TARGET_TABLE_ID);

  const db = await readJson(dbPath);
  assert.equal(
    db.posSettings.tables.some((table) => table.id === SOURCE_TABLE_ID),
    false,
  );
  assert.equal(
    db.integration.orders.find((order) => order.id === orderId)?.tableId,
    TARGET_TABLE_ID,
  );
  assert.equal(
    db.integration.orders.find((order) => order.id === orderId)?.roomId,
    SOURCE_ROOM_ID,
  );
  const moveAudits = db.auditEvents.filter(
    (event) => event.entityId === SOURCE_TABLE_ID,
  );
  assert.equal(moveAudits.some((event) => event.action === "table.moved"), true);
  assert.equal(moveAudits.some((event) => event.action === "table.released"), true);
  const printKinds = db.printSpoolJobs
    .filter((job) => job.orderId === orderId)
    .map((job) => job.kind);
  assert.equal(printKinds.includes("table_update"), true);
  assert.equal(printKinds.includes("order"), true);
  assert.equal(printKinds.includes("preconto"), true);
});

test("sposta il tavolo attivo anche dopo la rimozione dell'intera sala", async (t) => {
  const now = Date.now();
  const orderId = "removed-room-source-order-1";
  const deviceUuid = "removed-room-source-device";
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      removeSourceRoomConfiguration(state);
      state.integration.orders.push({
        id: orderId,
        revision: 1,
        source: "mobile-frontend",
        roomId: SOURCE_ROOM_ID,
        tableId: SOURCE_TABLE_ID,
        table: 91,
        tableNumber: 91,
        tableLabel: "91",
        total: 4.5,
        paidAmount: 0,
        dueAmount: 4.5,
        paymentStatus: "unpaid",
        workflowStatus: "waiting",
        station: "BAR-1",
        receivedAtMs: now - 5_000,
        createdAt: new Date(now - 5_000).toISOString(),
        updatedAt: new Date(now - 5_000).toISOString(),
        items: [
          {
            id: "removed-room-source-line-1",
            lineId: "removed-room-source-line-1",
            productId: "menu_caffetteria_caffe",
            name: "Caffe",
            qty: 1,
            unitPriceApplied: 4.5,
            listPriceAtTime: 4.5,
            lineTotal: 4.5,
            routeStations: ["BAR-1"],
          },
        ],
      });
      state.auditEvents.push({
        id: "removed-room-source-session-opened",
        occurredAt: new Date(now - 10_000).toISOString(),
        actorUserId: "u_manager",
        actorRole: "OPERATOR",
        action: "table.session_opened",
        entityType: "table",
        entityId: SOURCE_TABLE_ID,
        roomId: SOURCE_ROOM_ID,
        payload: {
          tableId: SOURCE_TABLE_ID,
          tableNumber: 91,
          roomId: SOURCE_ROOM_ID,
          seatedAt: now - 10_000,
        },
      });
    },
  });
  const session = await loginManager(baseUrl, deviceUuid);
  const locked = await acquireTableLock(
    baseUrl,
    session,
    DELETED_ROOM_TARGET_ID,
    { deviceUuid, purpose: "table.move_target" },
  );
  assert.equal(locked.response.status, 200, JSON.stringify(locked.body));

  const moved = await apiPost(
    baseUrl,
    "/api/integration/layout/table/move",
    authPayload(session, deviceUuid, {
      roomId: SOURCE_ROOM_ID,
      targetRoomId: DELETED_ROOM_TARGET_ROOM_ID,
      fromTableId: SOURCE_TABLE_ID,
      toTableId: DELETED_ROOM_TARGET_ID,
      removedSourceSnapshot: removedSourceSnapshot({
        seatedAt: now - 10_000,
      }),
    }),
    { headers: authHeaders(session, deviceUuid) },
  );
  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body?.movedOrdersCount, 1);
  assert.equal(moved.body?.toTable?.id, DELETED_ROOM_TARGET_ID);

  const db = await readJson(dbPath);
  assert.equal(
    db.posSettings.tables.some((table) => table.id === SOURCE_TABLE_ID),
    false,
  );
  assert.equal(
    (db.posSettings.rooms ?? []).some(
      (room) =>
        String(room?.id ?? room?.roomId ?? "").trim() === SOURCE_ROOM_ID,
    ),
    false,
  );
  const order = db.integration.orders.find((entry) => entry.id === orderId);
  assert.equal(order?.tableId, DELETED_ROOM_TARGET_ID);
  assert.equal(order?.roomId, DELETED_ROOM_TARGET_ROOM_ID);
});

test("trasferisce la prenotazione attiva della tombstone sul tavolo destinazione", async (t) => {
  const now = Date.now();
  const reservationAt = now + 10 * 60_000;
  const reservationId = "removed-source-reservation-1";
  const deviceUuid = "removed-source-reservation-device";
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      const serviceDate = localDateKey(reservationAt);
      state.posReservationStates = [
        {
          key: `${SOURCE_ROOM_ID}::${serviceDate}`,
          roomId: SOURCE_ROOM_ID,
          serviceDate,
          version: 1,
          reservations: [
            {
              id: reservationId,
              roomId: SOURCE_ROOM_ID,
              serviceDate,
              status: "booked",
              reservationAt,
              customerName: "Giulia Verdi",
              customerPhone: "3337654321",
              covers: 3,
              intolerances: "Lattosio",
              note: "Compleanno",
              assignedTableId: SOURCE_TABLE_ID,
              assignedTableIds: [SOURCE_TABLE_ID],
              createdAt: now - 60_000,
              updatedAt: now - 60_000,
            },
          ],
        },
      ];
    },
  });
  const session = await loginManager(baseUrl, deviceUuid);
  await lockMoveTarget(baseUrl, session, deviceUuid);

  const moved = await moveRemovedSource(
    baseUrl,
    session,
    deviceUuid,
    removedSourceSnapshot({
      tableName: "Giulia Verdi",
      customerPhone: "3337654321",
      covers: 3,
      occupancyState: "reserved",
      reservationAt,
      seatedAt: null,
      ordersTaken: 0,
      ordersInProgress: 0,
      offlineLifecycle: {
        state: "removed_while_active",
        removedAt: now - 1_000,
        removedFromLayoutVersion: now - 1_000,
        usableUntil: "released",
        requiresDecision: true,
        decision: "pending",
      },
    }),
  );

  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body?.movedOrdersCount, 0);
  assert.equal(moved.body?.toTable?.status, "reserved");
  assert.equal(moved.body?.toTable?.reservationAt, reservationAt);
  assert.equal(moved.body?.toTable?.guestName, "Giulia Verdi");

  const db = await readJson(dbPath);
  assert.equal(
    db.posSettings.tables.some((table) => table.id === SOURCE_TABLE_ID),
    false,
  );
  const reservation = db.posReservationStates
    .flatMap((state) => state.reservations)
    .find((entry) => entry.id === reservationId);
  assert.deepEqual(reservation.assignedTableIds, [TARGET_TABLE_ID]);
  assert.equal(reservation.assignedTableId, TARGET_TABLE_ID);
});

test("rifiuta una falsa tombstone senza evidenza operativa server", async (t) => {
  const deviceUuid = "removed-source-invalid-device";
  const { baseUrl } = await startBackend(t);
  const session = await loginManager(baseUrl, deviceUuid);
  await lockMoveTarget(baseUrl, session, deviceUuid);

  const rejected = await moveRemovedSource(
    baseUrl,
    session,
    deviceUuid,
    removedSourceSnapshot({
      ordersTaken: 0,
      ordersInProgress: 0,
      amountDue: 0,
    }),
  );

  assert.equal(rejected.response.status, 409);
  assert.equal(
    rejected.body?.code,
    "REMOVED_SOURCE_OPERATIONAL_EVIDENCE_MISSING",
  );
});

test("sposta la prenotazione anche nel relazionale senza ricreare la tombstone", async (t) => {
  const now = Date.now();
  const reservationAt = now + 10 * 60_000;
  const serviceDate = localDateKey(reservationAt);
  const reservationId = "removed-source-relational-reservation-1";
  const deviceUuid = "removed-source-relational-device";
  const runDir = await createTempRunDir("removed-source-relational-move");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_RESERVATIONS_READS: "1",
      BACKEND_RELATIONAL_RESERVATIONS_UPDATE_WRITE_PRIMARY: "1",
      TABLES_RELATIONAL_WRITE_PRIMARY: "1",
    },
    stateOverrides(state) {
      state.posReservationStates = [
        {
          key: `${SOURCE_ROOM_ID}::${serviceDate}`,
          roomId: SOURCE_ROOM_ID,
          serviceDate,
          version: 3,
          reservations: [
            {
              id: reservationId,
              roomId: SOURCE_ROOM_ID,
              serviceDate,
              status: "booked",
              reservationAt,
              customerName: "Anna Relazionale",
              customerPhone: "3339999999",
              covers: 2,
              intolerances: "",
              note: "Persistenza relazionale",
              assignedTableId: SOURCE_TABLE_ID,
              assignedTableIds: [SOURCE_TABLE_ID],
              createdAt: now - 60_000,
              updatedAt: now - 60_000,
            },
          ],
        },
      ];
    },
  });
  const session = await loginManager(baseUrl, deviceUuid);
  await lockMoveTarget(baseUrl, session, deviceUuid);

  const moved = await moveRemovedSource(
    baseUrl,
    session,
    deviceUuid,
    removedSourceSnapshot({
      tableName: "Anna Relazionale",
      customerPhone: "3339999999",
      occupancyState: "reserved",
      reservationAt,
      seatedAt: null,
      ordersTaken: 0,
      ordersInProgress: 0,
      offlineLifecycle: {
        state: "removed_while_active",
        removedAt: now - 1_000,
        removedFromLayoutVersion: now - 1_000,
        usableUntil: "released",
        requiresDecision: true,
        decision: "pending",
      },
    }),
  );
  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body?.toTable?.status, "reserved");

  const relationalDb = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    const reservation = relationalDb
      .prepare(
        "SELECT assigned_table_id, revision FROM reservations WHERE id = ?",
      )
      .get(reservationId);
    assert.equal(reservation.assigned_table_id, TARGET_TABLE_ID);
    assert.equal(reservation.revision, 4);
    const assignments = relationalDb
      .prepare(
        "SELECT table_id FROM reservation_table_assignments WHERE reservation_id = ? ORDER BY position",
      )
      .all(reservationId)
      .map((row) => row.table_id);
    assert.deepEqual(assignments, [TARGET_TABLE_ID]);
    assert.equal(
      relationalDb
        .prepare("SELECT COUNT(*) AS count FROM table_states WHERE table_id = ?")
        .get(SOURCE_TABLE_ID).count,
      0,
    );
    assert.equal(
      relationalDb
        .prepare("SELECT status FROM table_states WHERE table_id = ?")
        .get(TARGET_TABLE_ID).status,
      "reserved",
    );
  } finally {
    closeRelationalConnection(relationalDb);
  }

  const listed = await apiPost(
    baseUrl,
    "/api/pos/reservations/list",
    authPayload(session, deviceUuid, {
      roomId: SOURCE_ROOM_ID,
      serviceDate,
    }),
  );
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body?.reservations?.[0]?.assignedTableIds, [
    TARGET_TABLE_ID,
  ]);

  const appState = await readJson(dbPath);
  assert.equal(
    appState.posSettings.tables.some((table) => table.id === SOURCE_TABLE_ID),
    false,
  );
});
