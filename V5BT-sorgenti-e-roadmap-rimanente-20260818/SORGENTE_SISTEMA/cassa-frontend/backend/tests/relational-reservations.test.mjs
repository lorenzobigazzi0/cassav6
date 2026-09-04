import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAppStateRepository } from "../db/app-state/index.js";
import {
  createRelationalRuntime,
  openRelationalConnection,
  runRelationalMigrations,
  syncReservationsFromAppState,
  ReservationsRelationalRepository,
} from "../db/relational/index.js";
import { closeRelationalConnection } from "../db/relational/connection.js";
import { buildTestState, createTempRunDir } from "./helpers/test-server.mjs";

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function isValidState(data) {
  return (
    data &&
    typeof data === "object" &&
    Array.isArray(data.users) &&
    Array.isArray(data.sessions) &&
    data.meta &&
    typeof data.meta === "object"
  );
}

function nowIso() {
  return "2026-05-13T10:00:00.000Z";
}

function relationalConfig(dbPath) {
  return {
    enabled: true,
    mode: "shadow",
    dbPath,
  };
}

async function openMigratedDb(dbPath) {
  const db = await openRelationalConnection(relationalConfig(dbPath));
  await runRelationalMigrations(db, { nowIso });
  return db;
}

function tableExists(db, name) {
  return Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name),
  );
}

function indexExists(db, name) {
  return Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get(name),
  );
}

function createRepositoryOptions({ dbPath, afterWrite, logger }) {
  return {
    mode: "json",
    dbPath,
    dbTmpPath: `${dbPath}.tmp`,
    defaultJsonDbPath: dbPath,
    legacyJsonDbPath: "",
    sqliteImportJsonPath: "",
    buildInitialState: buildTestState,
    isValidState,
    migrateState: () => false,
    cloneJson,
    nowIso: () => new Date().toISOString(),
    safePathExists: existsSync,
    canInitializeMissingDb: () => true,
    canInitializeExistingEmptyDb: () => true,
    buildEmptyDbInitDeniedMessage: (kind, targetPath) =>
      `${kind} init denied: ${targetPath}`,
    logger: logger ?? { warn() {} },
    afterWrite,
  };
}

function buildReservationsState() {
  const state = buildTestState();
  state.meta.lastWriteAt = "2026-05-13T19:10:00.000Z";
  state.posReservationStates = [
    {
      key: "room_sala:2026-05-13",
      roomId: "room_sala",
      serviceDate: "2026-05-13",
      version: 4,
      reservations: [
        {
          id: "res_sala_1",
          roomId: "room_sala",
          serviceDate: "2026-05-13",
          reservationAt: 1778691600000,
          customerName: "Cliente Uno",
          customerPhone: "+390001",
          covers: 4,
          intolerances: "lattosio",
          note: "Terrazza se possibile",
          assignedTableId: "room_sala_t01",
          assignedTableIds: ["room_sala_t01", "room_sala_t02"],
          createdAt: 1778688000000,
          updatedAt: 1778688600000,
          extraReservationField: "preserved",
        },
        {
          id: "res_sala_2",
          roomId: "room_sala",
          serviceDate: "2026-05-13",
          reservationAt: 1778695200000,
          customerName: "Cliente Due",
          covers: 2,
          status: "cancelled",
          assignedTableIds: ["room_sala_t03"],
          createdAt: 1778689000000,
          updatedAt: 1778690000000,
          cancelledAt: 1778690100000,
        },
      ],
    },
  ];
  state.posReservationLocks = [
    {
      reservationId: "res_sala_1",
      lockId: "lock_res_sala_1",
      userId: "u_cashier",
      deviceUuid: "device-res-1",
      expiresAt: 1778697000000,
      extraLockField: "lock-preserved",
    },
    {
      reservationId: "missing_reservation",
      lockId: "lock_orphan",
      userId: "u_cashier",
      deviceUuid: "device-res-1",
      expiresAt: 1778697000000,
    },
  ];
  state.posRoomChangeRequests = [
    {
      requestId: "room_req_1",
      userId: "u_cashier",
      sessionId: "sess_cashier",
      deviceUuid: "device-res-1",
      targetRoomId: "room_sala",
      targetRoomName: "Sala",
      createdAt: 1778687000000,
      extraRoomRequestField: "preserved",
    },
  ];
  state.posTableRoomMoveRequests = [
    {
      requestId: "table_room_req_1",
      requesterUserId: "u_cashier",
      requesterUsername: "cashier",
      requesterFullName: "Cassiere",
      requesterDeviceUuid: "device-res-1",
      fromRoomId: "room_pedana",
      fromRoomName: "Pedana",
      targetRoomId: "room_sala",
      targetRoomName: "Sala",
      fromTableId: "room_pedana_t05",
      fromTableLabel: "Tavolo 5",
      targetTableIds: ["room_sala_t01", "room_sala_t02"],
      targetTableLabels: ["Sala 1", "Sala 2"],
      sourceLeafCount: 1,
      targetTableCount: 2,
      adjustCoversDelta: 1,
      status: "pending",
      createdAt: 1778687000000,
      expiresAt: 1778687600000,
      extraMoveField: "preserved",
    },
  ];
  return state;
}

test("migrazioni prenotazioni creano tabelle, indici e versione aggregata", async () => {
  const runDir = await createTempRunDir("rel-migrations-reservations");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    assert.equal(tableExists(db, "reservations"), true);
    assert.equal(tableExists(db, "reservation_table_assignments"), true);
    assert.equal(tableExists(db, "reservation_locks"), true);
    assert.equal(tableExists(db, "room_change_requests"), true);
    assert.equal(tableExists(db, "table_room_move_requests"), true);
    assert.equal(tableExists(db, "reservation_state_versions"), true);
    assert.equal(indexExists(db, "idx_reservations_room_date"), true);
    assert.equal(indexExists(db, "idx_reservation_assignments_table"), true);
    assert.equal(indexExists(db, "idx_reservation_locks_expires"), true);
    assert.equal(indexExists(db, "idx_room_change_requests_status"), true);
    assert.equal(
      indexExists(db, "idx_table_room_move_requests_target_room"),
      true,
    );
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync reservations importa prenotazioni multi-tavolo", async () => {
  const runDir = await createTempRunDir("rel-reservations-sync");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncReservationsFromAppState(db, buildReservationsState(), { nowIso });
    const repo = new ReservationsRelationalRepository(db);
    const reservation = repo.getReservation("res_sala_1");
    assert.equal(reservation.roomId, "room_sala");
    assert.equal(reservation.serviceDate, "2026-05-13");
    assert.equal(reservation.customerName, "Cliente Uno");
    assert.equal(reservation.assignedTableId, "room_sala_t01");
    assert.deepEqual(reservation.assignedTableIds, [
      "room_sala_t01",
      "room_sala_t02",
    ]);
    assert.equal(reservation.extraReservationField, "preserved");
    assert.equal(repo.getReservationStateVersion("room_sala", "2026-05-13"), 4);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync reservations importa lock e filtra lock orfani", async () => {
  const runDir = await createTempRunDir("rel-reservations-locks");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncReservationsFromAppState(db, buildReservationsState(), { nowIso });
    const repo = new ReservationsRelationalRepository(db);
    const lock = repo.getReservationLock("res_sala_1");
    assert.equal(lock.lockId, "lock_res_sala_1");
    assert.equal(lock.deviceUuid, "device-res-1");
    assert.equal(lock.extraLockField, "lock-preserved");
    assert.equal(repo.getReservationLock("missing_reservation"), null);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync reservations importa richieste cambio sala e spostamento tavolo", async () => {
  const runDir = await createTempRunDir("rel-reservations-requests");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncReservationsFromAppState(db, buildReservationsState(), { nowIso });
    const repo = new ReservationsRelationalRepository(db);
    const roomRequests = repo.listRoomChangeRequests({ status: "pending" });
    const moveRequests = repo.listTableRoomMoveRequests({
      targetRoomId: "room_sala",
    });
    assert.equal(roomRequests[0].requestId, "room_req_1");
    assert.equal(roomRequests[0].extraRoomRequestField, "preserved");
    assert.equal(moveRequests[0].requestId, "table_room_req_1");
    assert.deepEqual(moveRequests[0].targetTableIds, [
      "room_sala_t01",
      "room_sala_t02",
    ]);
    assert.equal(moveRequests[0].extraMoveField, "preserved");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync reservations aggiorna relational_sync_state", async () => {
  const runDir = await createTempRunDir("rel-reservations-sync-state");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const result = syncReservationsFromAppState(db, buildReservationsState(), {
      nowIso,
    });
    const row = db
      .prepare(
        "SELECT * FROM relational_sync_state WHERE domain = 'reservations'",
      )
      .get();
    assert.equal(row.source_last_write_at, "2026-05-13T19:10:00.000Z");
    assert.equal(row.row_count, result.rowCount);
    assert.equal(row.checksum, result.checksum);
    assert.equal(row.synced_at, "2026-05-13T10:00:00.000Z");
    assert.equal(result.rowCount, 9);
  } finally {
    closeRelationalConnection(db);
  }
});

test("writeDb in shadow mode richiama sync reservations dopo scrittura app-state", async () => {
  const runDir = await createTempRunDir("rel-reservations-write-hook");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
    defaultDbPath: relationalPath,
    logger: { warn() {} },
    nowIso,
  });
  await runtime.initialize();
  const repository = createAppStateRepository(
    createRepositoryOptions({
      dbPath: appStatePath,
      afterWrite: (appState) => runtime.syncAfterAppStateWrite(appState),
    }),
  );

  try {
    await repository.writeDb(buildReservationsState());
    const reservation = runtime.db
      .prepare("SELECT customer_name FROM reservations WHERE id = 'res_sala_1'")
      .get();
    const syncState = runtime.db
      .prepare(
        "SELECT * FROM relational_sync_state WHERE domain = 'reservations'",
      )
      .get();
    assert.equal(reservation.customer_name, "Cliente Uno");
    assert.equal(syncState.row_count, 9);
  } finally {
    runtime.close();
  }
});
