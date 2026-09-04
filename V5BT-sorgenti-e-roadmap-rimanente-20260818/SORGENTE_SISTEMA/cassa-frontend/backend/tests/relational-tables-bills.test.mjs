import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAppStateRepository } from "../db/app-state/index.js";
import {
  createRelationalRuntime,
  openRelationalConnection,
  runRelationalMigrations,
  syncRelationalShadowAfterAppStateWrite,
  syncTablesBillsFromAppState,
  TablesBillsRelationalRepository,
} from "../db/relational/index.js";
import { closeRelationalConnection } from "../db/relational/connection.js";
import {
  buildTestState,
  createTempRunDir,
  readJson,
} from "./helpers/test-server.mjs";

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
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function indexExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
}

function columnExists(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName);
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
    buildEmptyDbInitDeniedMessage: (kind, targetPath) => `${kind} init denied: ${targetPath}`,
    logger: logger ?? { warn() {} },
    afterWrite,
  };
}

function buildTablesBillsState() {
  const state = buildTestState();
  state.meta.lastWriteAt = "2026-05-13T17:10:00.000Z";
  state.posSettings.tables = [
    {
      id: "room_pedana_t05",
      number: 5,
      roomId: "room_pedana",
      type: "Pedana",
      status: "free",
      covers: 0,
      totalDue: 0,
      pendingBills: [],
      extraTableField: "free-preserved",
    },
    {
      id: "room_sala_t01",
      number: 1,
      roomId: "room_sala",
      type: "Sala",
      status: "payment_due",
      guestName: "Cliente Test",
      covers: 3,
      totalDue: 8,
      totalPaid: 4,
      note: "Allergia frutta secca",
      updatedAt: "2026-05-13T17:05:00.000Z",
      pendingBills: [
        {
          id: "bill_room_sala_1",
          status: "partial",
          subtotal: 10,
          paidAmount: 4,
          dueAmount: 6,
          createdAt: "2026-05-13T17:00:00.000Z",
          updatedAt: "2026-05-13T17:04:00.000Z",
          orderId: "00041",
          orderIds: ["00041"],
          lines: [
            { name: "Americano", qty: 1, unitPrice: 8, lineTotal: 8 },
            { name: "Caffe", qty: 2, unitPrice: 1, lineTotal: 2 },
          ],
          extraBillField: "bill-preserved",
        },
        {
          id: "bill_room_sala_2",
          subtotal: 2,
          createdAt: "2026-05-13T17:03:00.000Z",
          orderId: "00042",
          orderIds: ["00042"],
          lines: [{ name: "Acqua", qty: 1, unitPrice: 2, lineTotal: 2 }],
        },
      ],
    },
    {
      id: "room_pedana_t06",
      number: 6,
      roomId: "room_pedana",
      type: "Pedana",
      status: "free",
      covers: 0,
      totalDue: 0,
      pendingBills: [],
      workLock: {
        tableId: "room_pedana_t06",
        userId: "u_cashier",
        username: "cashier",
        deviceUuid: "lock-device-1",
        sessionId: "sess_lock_1",
        purpose: "edit",
        acquiredAt: "2026-05-13T17:01:00.000Z",
        heartbeatAt: "2026-05-13T17:02:00.000Z",
        expiresAt: "2026-05-13T17:07:00.000Z",
      },
    },
  ];
  return state;
}

test("migrazione 009_tables_bills crea tabelle", async () => {
  const runDir = await createTempRunDir("rel-migrations-tables-bills");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    assert.equal(tableExists(db, "table_states"), true);
    assert.equal(tableExists(db, "table_bills"), true);
    assert.equal(tableExists(db, "table_locks"), true);
    assert.equal(indexExists(db, "idx_table_states_room"), true);
    assert.equal(indexExists(db, "idx_table_states_status"), true);
    assert.equal(indexExists(db, "idx_table_bills_table"), true);
    assert.equal(indexExists(db, "idx_table_bills_status"), true);
    assert.equal(indexExists(db, "idx_table_locks_user"), true);
    assert.equal(indexExists(db, "idx_table_locks_expires"), true);
    assert.equal(columnExists(db, "table_states", "revision"), true);
    assert.equal(columnExists(db, "table_locks", "revision"), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync tablesBills importa tavolo libero", async () => {
  const runDir = await createTempRunDir("rel-tables-free");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncTablesBillsFromAppState(db, buildTablesBillsState(), { nowIso });
    const table = new TablesBillsRelationalRepository(db).getTableState("room_pedana_t05");
    assert.equal(table.tableId, "room_pedana_t05");
    assert.equal(table.roomId, "room_pedana");
    assert.equal(table.status, "free");
    assert.equal(table.totalDueCents, 0);
    assert.equal(table.extraTableField, "free-preserved");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync tablesBills importa tavolo occupato", async () => {
  const runDir = await createTempRunDir("rel-tables-occupied");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncTablesBillsFromAppState(db, buildTablesBillsState(), { nowIso });
    const table = new TablesBillsRelationalRepository(db).getTableState("room_sala_t01");
    assert.equal(table.status, "payment_due");
    assert.equal(table.covers, 3);
    assert.equal(table.customerName, "Cliente Test");
    assert.equal(table.notes, "Allergia frutta secca");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync tablesBills importa pending bills", async () => {
  const runDir = await createTempRunDir("rel-tables-bills");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncTablesBillsFromAppState(db, buildTablesBillsState(), { nowIso });
    const bills = new TablesBillsRelationalRepository(db).listBillsByTable("room_sala_t01");
    assert.deepEqual(bills.map((bill) => bill.id), ["bill_room_sala_1", "bill_room_sala_2"]);
    assert.equal(bills[0].tableId, "room_sala_t01");
    assert.equal(bills[0].extraBillField, "bill-preserved");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync tablesBills importa importi pagati e residui", async () => {
  const runDir = await createTempRunDir("rel-tables-paid-due");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncTablesBillsFromAppState(db, buildTablesBillsState(), { nowIso });
    const table = db
      .prepare("SELECT total_due_cents, total_paid_cents FROM table_states WHERE table_id = 'room_sala_t01'")
      .get();
    const bill = db
      .prepare("SELECT status, total_cents, paid_cents, due_cents FROM table_bills WHERE id = 'bill_room_sala_1'")
      .get();
    assert.equal(table.total_due_cents, 800);
    assert.equal(table.total_paid_cents, 400);
    assert.equal(bill.status, "partial");
    assert.equal(bill.total_cents, 1000);
    assert.equal(bill.paid_cents, 400);
    assert.equal(bill.due_cents, 600);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync tablesBills importa lock tavolo", async () => {
  const runDir = await createTempRunDir("rel-tables-lock");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncTablesBillsFromAppState(db, buildTablesBillsState(), { nowIso });
    const lock = new TablesBillsRelationalRepository(db).getTableLock("room_pedana_t06");
    assert.equal(lock.userId, "u_cashier");
    assert.equal(lock.acquiredAt, "2026-05-13T17:01:00.000Z");
    assert.equal(lock.heartbeatAt, "2026-05-13T17:02:00.000Z");
    assert.equal(lock.expiresAt, "2026-05-13T17:07:00.000Z");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync tablesBills preserva deviceUuid del lock", async () => {
  const runDir = await createTempRunDir("rel-tables-lock-device");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncTablesBillsFromAppState(db, buildTablesBillsState(), { nowIso });
    const lock = db.prepare("SELECT device_uuid, raw_json FROM table_locks WHERE table_id = 'room_pedana_t06'").get();
    assert.equal(lock.device_uuid, "lock-device-1");
    assert.equal(JSON.parse(lock.raw_json).sessionId, "sess_lock_1");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync tablesBills converte importi in cents", async () => {
  const runDir = await createTempRunDir("rel-tables-cents");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncTablesBillsFromAppState(db, buildTablesBillsState(), { nowIso });
    const rows = db.prepare("SELECT id, total_cents, paid_cents, due_cents FROM table_bills ORDER BY id").all();
    assert.deepEqual(
      rows.map((row) => [row.id, row.total_cents, row.paid_cents, row.due_cents]),
      [
        ["bill_room_sala_1", 1000, 400, 600],
        ["bill_room_sala_2", 200, 0, 200],
      ]
    );
  } finally {
    closeRelationalConnection(db);
  }
});

test("repository tablesBills verifica il residuo tavolo senza esporre SQL al chiamante", async () => {
  const runDir = await createTempRunDir("rel-tables-due-invariant");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncTablesBillsFromAppState(db, buildTablesBillsState(), { nowIso });
    const repository = new TablesBillsRelationalRepository(db);

    assert.deepEqual(repository.verifyDueInvariant(["room_sala_t01"]), {
      ok: true,
      summaries: [{
        billsDueCents: 800,
        tableDueCents: 800,
        tableId: "room_sala_t01",
      }],
    });

    db.prepare("UPDATE table_states SET total_due_cents = 799 WHERE table_id = ?")
      .run("room_sala_t01");
    assert.deepEqual(repository.verifyDueInvariant(["room_sala_t01"]), {
      ok: false,
      reason: "due_mismatch",
      tableId: "room_sala_t01",
      summary: {
        billsDueCents: 800,
        tableDueCents: 799,
        tableId: "room_sala_t01",
      },
      summaries: [{
        billsDueCents: 800,
        tableDueCents: 799,
        tableId: "room_sala_t01",
      }],
    });
    assert.deepEqual(repository.verifyDueInvariant(["missing"]), {
      ok: false,
      reason: "missing_table",
      tableId: "missing",
      summaries: [],
    });
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync tablesBills aggiorna relational_sync_state", async () => {
  const runDir = await createTempRunDir("rel-tables-sync-state");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const result = syncTablesBillsFromAppState(db, buildTablesBillsState(), { nowIso });
    const row = db.prepare("SELECT * FROM relational_sync_state WHERE domain = 'tablesBills'").get();
    assert.equal(row.source_last_write_at, "2026-05-13T17:10:00.000Z");
    assert.equal(row.row_count, result.rowCount);
    assert.equal(row.checksum, result.checksum);
    assert.equal(row.synced_at, "2026-05-13T10:00:00.000Z");
    assert.equal(result.rowCount, 6);
  } finally {
    closeRelationalConnection(db);
  }
});

test("writeDb in shadow mode richiama sync tablesBills dopo scrittura app-state", async () => {
  const runDir = await createTempRunDir("rel-tables-write-hook");
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
    })
  );

  try {
    await repository.writeDb(buildTablesBillsState());
    const table = runtime.db.prepare("SELECT total_due_cents FROM table_states WHERE table_id = 'room_sala_t01'").get();
    const syncState = runtime.db.prepare("SELECT * FROM relational_sync_state WHERE domain = 'tablesBills'").get();
    assert.equal(table.total_due_cents, 800);
    assert.equal(syncState.row_count, 6);
  } finally {
    runtime.close();
  }
});

test("errore sync tablesBills in shadow non rompe writeDb", async () => {
  const runDir = await createTempRunDir("rel-tables-write-error");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const warnings = [];
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
    defaultDbPath: relationalPath,
    logger: {
      warn(message) {
        warnings.push(String(message));
      },
    },
    nowIso,
  });
  const repository = createAppStateRepository(
    createRepositoryOptions({
      dbPath: appStatePath,
      afterWrite: (appState) => syncRelationalShadowAfterAppStateWrite(appState, runtime),
    })
  );
  const state = buildTablesBillsState();
  state.posSettings.tables[1].pendingBills.push({
    ...state.posSettings.tables[1].pendingBills[0],
    subtotal: 1,
  });

  try {
    await repository.writeDb(state);
    const persisted = await readJson(appStatePath);
    assert.equal(persisted.posSettings.tables.find((table) => table.id === "room_sala_t01").pendingBills.length, 3);
    assert.equal(warnings.some((message) => /Sync relazionale shadow app-state fallita/i.test(message)), true);
  } finally {
    runtime.close();
  }
});
