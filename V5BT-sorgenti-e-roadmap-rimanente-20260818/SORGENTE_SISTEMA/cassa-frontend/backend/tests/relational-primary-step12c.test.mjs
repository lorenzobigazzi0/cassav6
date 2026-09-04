import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  openRelationalConnection,
  runRelationalMigrations,
  TablesBillsRelationalRepository,
} from "../db/relational/index.js";
import {
  createRelationalScopedTableReader,
  createScopedReadsHandlers,
  resolveScopedReadSourceMeta,
} from "../modules/scoped-reads/index.js";
import { createTempRunDir } from "./helpers/test-server.mjs";

class TestHttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function nowIso() {
  return "2026-07-07T14:00:00.000Z";
}

function relationalConfig(dbPath) {
  return {
    enabled: true,
    mode: "shadow",
    dbPath,
  };
}

async function openMigratedDb(name) {
  const runDir = await createTempRunDir(name);
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openRelationalConnection(relationalConfig(dbPath));
  await runRelationalMigrations(db, { nowIso });
  return db;
}

function buildTable(overrides = {}) {
  return {
    id: "table_step12c_1",
    roomId: "room_step12c",
    number: 1,
    alias: "Tavolo Step 12C",
    status: "occupied",
    covers: 2,
    totalDue: 12,
    revision: 3,
    currentRevision: 3,
    updatedAt: "2026-07-07T13:55:00.000Z",
    pendingBills: [],
    ...overrides,
  };
}

function createSendJsonCapture() {
  const capture = {
    status: null,
    payload: null,
  };
  return {
    capture,
    sendJson(_res, status, payload) {
      capture.status = status;
      capture.payload = payload;
    },
  };
}

function createHandlers(options = {}) {
  const { capture, sendJson } = createSendJsonCapture();
  const handlers = createScopedReadsHandlers({
    HttpError: TestHttpError,
    buildLayoutSnapshot: (db) => ({ tables: db?.posSettings?.tables ?? [] }),
    compareNotifications: () => 0,
    isNotificationGloballyAcknowledged: () => false,
    notificationMatchesTarget: () => true,
    readDb: async () => {
      throw new Error("legacy app-state read should not be used");
    },
    sanitizeNotification: (notification) => notification,
    scopedReadsEnabled: true,
    sendJson,
    ...options,
  });
  return { capture, handlers };
}

test("Step 12C meta considera relational una lettura scoped senza fallback full-state", () => {
  assert.deepEqual(resolveScopedReadSourceMeta("relational"), {
    scopedRead: true,
    source: "relational",
    fullStateFallbackUsed: false,
    redisCacheHit: false,
  });
});

test("Step 12C handler tavolo legge da relazionale prima del layout app-state", async () => {
  const { capture, handlers } = createHandlers({
    relationalTableReader: {
      enabled: true,
      getTable: async (tableId) =>
        tableId === "table_step12c_1" ? buildTable({ aggregateVersion: 3 }) : null,
    },
  });

  await handlers.handleScopedTable(
    { params: { tableId: "table_step12c_1" } },
    {},
    new URL("http://localhost/api/tables/table_step12c_1"),
  );

  assert.equal(capture.status, 200);
  assert.equal(capture.payload.meta.source, "relational");
  assert.equal(capture.payload.meta.fullStateFallbackUsed, false);
  assert.equal(capture.payload.table.id, "table_step12c_1");
  assert.equal(capture.payload.table.alias, "Tavolo Step 12C");
});

test("Step 12C handler tavoli sala legge lista da relazionale", async () => {
  const { capture, handlers } = createHandlers({
    relationalTableReader: {
      enabled: true,
      listRoomTables: async (roomId) =>
        roomId === "room_step12c"
          ? [
              buildTable({ id: "table_step12c_1", number: 1 }),
              buildTable({ id: "table_step12c_2", number: 2 }),
            ]
          : [],
    },
  });

  await handlers.handleScopedRoomTables(
    { params: { roomId: "room_step12c" } },
    {},
    new URL("http://localhost/api/rooms/room_step12c/tables"),
  );

  assert.equal(capture.status, 200);
  assert.equal(capture.payload.meta.source, "relational");
  assert.deepEqual(
    capture.payload.tables.map((table) => table.id),
    ["table_step12c_1", "table_step12c_2"],
  );
});

test("Step 12C adapter scoped legge table_states dal DB relazionale migrato", async () => {
  const db = await openMigratedDb("step12c-relational-table-reader");
  try {
    const repository = new TablesBillsRelationalRepository(db);
    repository.replaceAllFromAppState({
      posSettings: {
        tables: [
          buildTable({
            extraTableField: "preserved-from-raw-json",
            lastEventId: 42,
          }),
        ],
      },
    });
    let initializeCalls = 0;
    const reader = createRelationalScopedTableReader({
      enabled: true,
      relationalRuntime: {
        get db() {
          return db;
        },
        initialize: async () => {
          initializeCalls += 1;
        },
      },
    });

    const table = await reader.getTable("#table_step12c_1");
    const roomTables = await reader.listRoomTables("room_step12c");

    assert.equal(table.id, "table_step12c_1");
    assert.equal(table.tableId, "table_step12c_1");
    assert.equal(table.roomId, "room_step12c");
    assert.equal(table.extraTableField, "preserved-from-raw-json");
    assert.equal(table.aggregateVersion, 3);
    assert.equal(table.lastEventId, 42);
    assert.equal(roomTables.length, 1);
    assert.equal(roomTables[0].id, "table_step12c_1");
    assert.equal(initializeCalls, 2);
  } finally {
    closeRelationalConnection(db);
  }
});
