import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  openRelationalConnection,
  OrdersRelationalRepository,
  runRelationalMigrations,
  TablesBillsRelationalRepository,
} from "../db/relational/index.js";
import { RELATIONAL_MIGRATIONS } from "../db/relational/migrations.js";
import { mapOrderToRelationalRow } from "../db/relational/orders.repo.js";
import { mapTableStateToRelationalRow } from "../db/relational/tables-bills.repo.js";
import { createTempRunDir } from "./helpers/test-server.mjs";

function nowIso() {
  return "2026-07-07T12:00:00.000Z";
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

function columnExists(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName);
}

function indexExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
}

test("Step 12A registra la migrazione aggregate_versions", () => {
  const migration = RELATIONAL_MIGRATIONS.find((entry) => entry.version === "020");
  assert.equal(migration?.name, "aggregate_versions");
  assert.equal(migration?.fileName, "020_aggregate_versions.sql");
});

test("Step 12A aggiunge last_event_id a ordini e tavoli", async () => {
  const runDir = await createTempRunDir("step12-aggregate-schema");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    assert.equal(columnExists(db, "orders", "last_event_id"), true);
    assert.equal(columnExists(db, "table_states", "last_event_id"), true);
    assert.equal(indexExists(db, "idx_orders_last_event_id"), true);
    assert.equal(indexExists(db, "idx_table_states_last_event_id"), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 12A conserva versioning e lastEventId sugli ordini relazionali", async () => {
  const runDir = await createTempRunDir("step12-order-last-event");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const order = {
      id: "ord_step12",
      tableId: "table_1",
      roomId: "room_main",
      workflowStatus: "prep",
      source: "mobile",
      total: 12.5,
      revision: 4,
      currentRevision: 4,
      lastEventId: 91,
      createdAt: "2026-07-07T11:55:00.000Z",
      updatedAt: "2026-07-07T11:56:00.000Z",
      items: [],
    };
    assert.equal(mapOrderToRelationalRow(order).lastEventId, 91);

    const repo = new OrdersRelationalRepository(db);
    repo.createOrder(order);
    const persisted = repo.getOrderById("ord_step12");
    assert.equal(persisted.revision, 4);
    assert.equal(persisted.currentRevision, 4);
    assert.equal(persisted.aggregateVersion, 4);
    assert.equal(persisted.lastEventId, 91);

    const replaced = repo.replaceOrderWithRevision(
      { ...order, revision: 5, currentRevision: 5, lastEventId: 92, total: 13 },
      4
    );
    assert.equal(replaced.order.revision, 5);
    assert.equal(replaced.order.aggregateVersion, 5);
    assert.equal(replaced.order.lastEventId, 92);
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 12A conserva versioning e lastEventId sui tavoli relazionali", async () => {
  const runDir = await createTempRunDir("step12-table-last-event");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const table = {
      id: "table_step12",
      roomId: "room_main",
      status: "occupied",
      covers: 2,
      totalDue: 18,
      revision: 7,
      currentRevision: 7,
      lastEventId: 104,
      updatedAt: "2026-07-07T11:57:00.000Z",
      pendingBills: [],
    };
    assert.equal(mapTableStateToRelationalRow(table).lastEventId, 104);

    const repo = new TablesBillsRelationalRepository(db);
    repo.replaceAllFromAppState({ posSettings: { tables: [table] } });
    const persisted = repo.getTableState("table_step12");
    assert.equal(persisted.revision, 7);
    assert.equal(persisted.currentRevision, 7);
    assert.equal(persisted.aggregateVersion, 7);
    assert.equal(persisted.lastEventId, 104);
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 12A event envelope espone aggregateVersion dal payload", async () => {
  const serverSource = await fs.readFile(path.resolve("backend/server.js"), "utf8");
  assert.match(serverSource, /function resolveRealtimeAggregateVersion\(event\)/);
  assert.match(serverSource, /aggregateVersion:\s*resolveRealtimeAggregateVersion\(event\)/);
  assert.doesNotMatch(serverSource, /aggregateVersion:\s*null/);
});
