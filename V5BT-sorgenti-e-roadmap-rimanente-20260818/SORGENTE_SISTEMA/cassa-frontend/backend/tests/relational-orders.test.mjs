import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAppStateRepository } from "../db/app-state/index.js";
import {
  createRelationalRuntime,
  openRelationalConnection,
  OrdersRelationalRepository,
  runRelationalMigrations,
  syncOrdersFromAppState,
  syncRelationalShadowAfterAppStateWrite,
} from "../db/relational/index.js";
import { closeRelationalConnection } from "../db/relational/connection.js";
import { RELATIONAL_MIGRATIONS } from "../db/relational/migrations.js";
import { listRelationalOrderWorkflowSnapshot, syncRelationalOrderPrimary } from "../modules/integration/relational-order-create.js";
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

function buildOrdersState() {
  const state = buildTestState();
  state.meta.lastWriteAt = "2026-05-13T16:10:00.000Z";
  state.integration.orders = [
    {
      id: "00042",
      tableId: "room_pedana_t05",
      tableNumber: 5,
      tableLabel: "Tavolo 5",
      roomId: "room_pedana",
      workflowStatus: "prep",
      paymentStatus: "unpaid",
      source: "mobile-frontend",
      total: 17.1,
      station: "BAR PRINCIPALE",
      assignedStationId: "BAR PRINCIPALE",
      createdByUserId: "u_cashier",
      createdByUsername: "cashier",
      createdByDeviceUuid: "device-cashier",
      idempotencyKey: "idem-order-00042",
      createdAt: "2026-05-13T16:00:00.000Z",
      updatedAt: "2026-05-13T16:05:00.000Z",
      revision: 7,
      currentRevision: 7,
      extraOrderField: "preserved",
      items: [
        {
          id: "oi_1",
          lineId: "line_caffe",
          productId: "menu_caffetteria_caffe",
          productNameSnapshot: "Caffe",
          name: "Caffe",
          qty: 1,
          done: true,
          doneQty: 1,
          unitPriceApplied: 1.3,
          listPriceAtTime: 1.3,
          lineTotal: 1.3,
          priceOverrideApplied: true,
          vatRate: 10,
          vatCode: "IVA10",
          departmentId: "bar",
          fiscalDepartment: "1",
          routeStations: ["BAR PRINCIPALE"],
          extraLineField: "first-unit",
        },
        {
          id: "oi_2",
          lineId: "line_caffe",
          productId: "menu_caffetteria_caffe",
          productNameSnapshot: "Caffe",
          name: "Caffe",
          qty: 1,
          done: false,
          doneQty: 0,
          unitPriceApplied: 1.3,
          listPriceAtTime: 1.3,
          lineTotal: 1.3,
          routeStations: ["BAR PRINCIPALE"],
        },
        {
          id: "oi_3",
          lineId: "line_gin",
          productId: "menu_drink_gin_tonic",
          productNameSnapshot: "Gin Tonic",
          name: "Gin Tonic",
          qty: 1,
          deliveredQuantity: 1,
          unitPriceApplied: 10.5,
          listPriceAtTime: 8,
          lineTotal: 10.5,
          selectedVariantId: "gin_premium",
          selectedVariantName: "Gin premium",
          selectedVariantPriceDelta: 2.5,
          variants: { label: "Gin premium", ice: "large" },
          supplements: [{ id: "sup_lime", name: "Lime extra", priceDelta: 0.5 }],
          routeStations: ["COCKTAIL"],
        },
        {
          id: "oi_4",
          lineId: "line_void",
          productId: "menu_snack_patatine",
          productNameSnapshot: "Patatine",
          name: "Patatine",
          qty: 1,
          unitPriceApplied: 4,
          listPriceAtTime: 4,
          lineTotal: 4,
          voidedAt: "2026-05-13T16:04:00.000Z",
          routeStations: ["CUCINA"],
        },
      ],
      lineRoutes: [
        { id: "route_1", lineId: "line_caffe", stationId: "BAR PRINCIPALE" },
        { id: "route_2", lineId: "line_gin", stationId: "COCKTAIL" },
        { id: "route_3", lineId: "line_void", stationId: "CUCINA" },
      ],
      events: [
        {
          id: "order_evt_1",
          type: "status_changed",
          occurredAt: "2026-05-13T16:03:00.000Z",
          actorUserId: "u_cashier",
          payload: { from: "waiting", to: "prep" },
          extraEventField: "preserved",
        },
      ],
    },
  ];
  return state;
}

test("migrazione 008_orders crea tabelle orders", async () => {
  const runDir = await createTempRunDir("rel-migrations-orders");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    assert.equal(tableExists(db, "orders"), true);
    assert.equal(columnExists(db, "orders", "revision"), true);
    assert.equal(columnExists(db, "orders", "idempotency_key"), true);
    assert.equal(columnExists(db, "orders", "created_by_user_id"), true);
    assert.equal(columnExists(db, "orders", "created_by_device_uuid"), true);
    assert.equal(tableExists(db, "order_lines"), true);
    assert.equal(tableExists(db, "order_line_variants"), true);
    assert.equal(tableExists(db, "order_events"), true);
    assert.equal(tableExists(db, "order_id_allocator"), true);
    assert.equal(indexExists(db, "idx_orders_table_id"), true);
    assert.equal(indexExists(db, "idx_orders_status"), true);
    assert.equal(indexExists(db, "idx_orders_created_at"), true);
    assert.equal(indexExists(db, "idx_orders_station_id"), true);
    assert.equal(indexExists(db, "idx_orders_idempotency_scope"), true);
    assert.equal(indexExists(db, "idx_order_lines_order_id"), true);
    assert.equal(indexExists(db, "idx_order_lines_product_id"), true);
    assert.equal(indexExists(db, "idx_order_lines_station_id"), true);
    assert.equal(indexExists(db, "idx_order_line_variants_line"), true);
    assert.equal(indexExists(db, "idx_order_events_order"), true);
    assert.equal(indexExists(db, "idx_order_events_type"), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("allocatore ID ordini riserva valori univoci tra connessioni relazionali", async () => {
  const runDir = await createTempRunDir("rel-orders-id-allocator");
  const dbPath = path.join(runDir, "relational.sqlite");
  const firstDb = await openMigratedDb(dbPath);
  const secondDb = await openMigratedDb(dbPath);
  try {
    const firstRepo = new OrdersRelationalRepository(firstDb);
    const secondRepo = new OrdersRelationalRepository(secondDb);
    firstRepo.createOrder({ id: "00042", items: [] });
    assert.equal(firstRepo.allocateNextOrderId(), 43);
    assert.equal(secondRepo.allocateNextOrderId(), 44);
    assert.equal(firstRepo.allocateNextOrderId({ minimumNextOrder: 100 }), 100);
    assert.equal(secondRepo.allocateNextOrderId(), 101);
    assert.equal(firstDb.prepare("SELECT next_value FROM order_id_allocator WHERE scope = ?").get("integration_order").next_value, 102);
  } finally {
    closeRelationalConnection(secondDb);
    closeRelationalConnection(firstDb);
  }
});

test("migrazione 023 indicizza e retrocompila lo scope idempotenza ordini", async () => {
  const runDir = await createTempRunDir("rel-orders-idempotency-migration");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openRelationalConnection(relationalConfig(dbPath));
  try {
    const previousMigrations = RELATIONAL_MIGRATIONS.filter((migration) => migration.version !== "023");
    const idempotencyMigration = RELATIONAL_MIGRATIONS.filter((migration) => migration.version === "023");
    await runRelationalMigrations(db, { migrations: previousMigrations, nowIso });
    db.prepare("INSERT INTO orders (id, status, created_at, raw_json) VALUES (?, ?, ?, ?)").run(
      "legacy-idempotent",
      "waiting",
      "2026-05-13T09:00:00.000Z",
      JSON.stringify({
        id: "legacy-idempotent",
        idempotencyKey: "legacy key con spazi",
        createdByUserId: "u_legacy",
        createdByDeviceUuid: "device-legacy",
      }),
    );
    db.prepare("INSERT INTO orders (id, status, raw_json) VALUES (?, ?, ?)").run(
      "legacy-corrupt",
      "waiting",
      "{json-corrotto",
    );

    await runRelationalMigrations(db, { migrations: idempotencyMigration, nowIso });

    const row = db.prepare("SELECT * FROM orders WHERE id = ?").get("legacy-idempotent");
    const corruptRow = db.prepare("SELECT * FROM orders WHERE id = ?").get("legacy-corrupt");
    const queryPlan = db
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM orders WHERE idempotency_key = ?")
      .all("legacy key con spazi")
      .map((entry) => entry.detail)
      .join(" ");
    assert.equal(row.idempotency_key, "legacy key con spazi");
    assert.equal(row.created_by_user_id, "u_legacy");
    assert.equal(row.created_by_device_uuid, "device-legacy");
    assert.equal(corruptRow.idempotency_key, null);
    assert.match(queryPlan, /idx_orders_idempotency_scope/);
  } finally {
    closeRelationalConnection(db);
  }
});

test("migrazione 017 indicizza orders.updated_at e listOrdersUpdatedSince filtra con COALESCE", async () => {
  const runDir = await createTempRunDir("rel-orders-updated-since");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    assert.equal(indexExists(db, "idx_orders_updated_at"), true);
    const repo = new OrdersRelationalRepository(db);
    repo.createOrder({ id: "00050", tableId: "room_pedana_t01", updatedAt: "2026-05-13T10:00:00.000Z", items: [] });
    repo.createOrder({ id: "00051", tableId: "room_pedana_t02", updatedAt: "2026-05-13T12:00:00.000Z", items: [] });
    repo.createOrder({ id: "00052", tableId: "room_pedana_t03", createdAt: "2026-05-13T13:00:00.000Z", items: [] });
    const since = repo.listOrdersUpdatedSince("2026-05-13T11:00:00.000Z");
    assert.deepEqual(since.map((order) => order.id).sort(), ["00051", "00052"]);
    assert.deepEqual(repo.listOrdersUpdatedSince(""), []);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync orders importa ordine semplice", async () => {
  const runDir = await createTempRunDir("rel-orders-simple");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncOrdersFromAppState(db, buildOrdersState(), { nowIso });
    const order = new OrdersRelationalRepository(db).getOrderById("00042");
    assert.equal(order.id, "00042");
    assert.equal(order.workflowStatus, "prep");
    assert.equal(order.tableId, "room_pedana_t05");
    assert.equal(order.roomId, "room_pedana");
  } finally {
    closeRelationalConnection(db);
  }
});

test("listRelationalOrderWorkflowSnapshot espone sorgente relazionale per orders/sync", async () => {
  const runDir = await createTempRunDir("rel-orders-sync-snapshot");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  const operations = [];
  try {
    syncOrdersFromAppState(db, buildOrdersState(), { nowIso });
    const snapshot = await listRelationalOrderWorkflowSnapshot({
      enabled: true,
      relationalRuntime: {
        db,
        async initialize() {},
      },
      runtimeMetrics: {
        recordOperation(kind, label, durationMs) {
          operations.push({ kind, label, durationMs });
        },
      },
    });

    assert.equal(snapshot.sourceKind, "relational-orders");
    assert.equal(snapshot.externalized, true);
    assert.deepEqual(snapshot.orders.map((order) => order.id), ["00042"]);
    assert.equal(snapshot.orders[0].revision, 7);
    assert.equal(
      operations.some(
        (entry) =>
          entry.kind === "orderWorkflow" &&
          entry.label === "orders.sync.relationalSnapshotRead"
      ),
      true,
    );
  } finally {
    closeRelationalConnection(db);
  }
});

test("listRelationalOrderWorkflowSnapshot limita gli ordini per scope tavolo e ordine", async () => {
  const runDir = await createTempRunDir("rel-orders-sync-snapshot-scope");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildOrdersState();
    state.integration.orders.push(
      {
        ...cloneJson(state.integration.orders[0]),
        id: "00043",
        tableId: "room_pedana_t09",
        tableNumber: 9,
        tableLabel: "Tavolo 9",
        idempotencyKey: "idem-order-00043",
        revision: 1,
        currentRevision: 1,
        createdAt: "2026-05-13T16:01:00.000Z",
        updatedAt: "2026-05-13T16:06:00.000Z",
        events: [{ id: "order_evt_43", type: "status_changed", occurredAt: "2026-05-13T16:06:00.000Z" }],
      },
      {
        ...cloneJson(state.integration.orders[0]),
        id: "00044",
        tableId: "room_pedana_t10",
        tableNumber: 10,
        tableLabel: "Tavolo 10",
        idempotencyKey: "idem-order-00044",
        revision: 1,
        currentRevision: 1,
        createdAt: "2026-05-13T16:02:00.000Z",
        updatedAt: "2026-05-13T16:07:00.000Z",
        events: [{ id: "order_evt_44", type: "status_changed", occurredAt: "2026-05-13T16:07:00.000Z" }],
      },
    );
    syncOrdersFromAppState(db, state, { nowIso });
    const relationalRuntime = {
      db,
      async initialize() {},
    };

    const byTable = await listRelationalOrderWorkflowSnapshot({
      enabled: true,
      relationalRuntime,
      tableId: "room_pedana_t05",
    });
    assert.deepEqual(byTable.orders.map((order) => order.id), ["00042"]);

    const byTables = await listRelationalOrderWorkflowSnapshot({
      enabled: true,
      relationalRuntime,
      tableIds: ["room_pedana_t09", "room_pedana_t10", "room_pedana_t09"],
    });
    assert.deepEqual(byTables.orders.map((order) => order.id), ["00043", "00044"]);

    const repo = new OrdersRelationalRepository(db);
    assert.deepEqual(
      repo.listOrders({ tableIds: ["room_pedana_t09", "room_pedana_t10", "room_pedana_t09"] }).map((order) => order.id),
      ["00043", "00044"],
    );

    const byOrder = await listRelationalOrderWorkflowSnapshot({
      enabled: true,
      orderId: "00044",
      relationalRuntime,
    });
    assert.deepEqual(byOrder.orders.map((order) => order.id), ["00044"]);

    state.integration.orders.push({
      ...cloneJson(state.integration.orders[0]),
      id: "00045",
      tableId: "room_pedana_t11",
      tableNumber: 11,
      tableLabel: "Tavolo 11",
      station: "CUCINA",
      assignedStationId: "CUCINA",
      idempotencyKey: "idem-order-00045",
      revision: 1,
      currentRevision: 1,
      createdAt: "2026-05-13T16:03:00.000Z",
      updatedAt: "2026-05-13T16:08:00.000Z",
      events: [{ id: "order_evt_45", type: "status_changed", occurredAt: "2026-05-13T16:08:00.000Z" }],
    });
    syncOrdersFromAppState(db, state, { nowIso });
    const byStation = await listRelationalOrderWorkflowSnapshot({
      enabled: true,
      orderId: "00045",
      relationalRuntime,
      stationIds: ["BAR PRINCIPALE"],
    });
    assert.equal(byStation.scoped, true);
    assert.deepEqual(byStation.orders.map((order) => order.id), ["00045", "00042", "00043", "00044"]);
    assert.deepEqual(repo.listOrders({ stationIds: ["BAR PRINCIPALE", "CUCINA", "BAR PRINCIPALE"] }).map((order) => order.id), ["00042", "00043", "00044", "00045"]);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P3.55 snapshot workflow light conserva target full e alleggerisce gli ordini di contesto", async () => {
  const runDir = await createTempRunDir("rel-orders-workflow-light-snapshot");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildOrdersState();
    state.integration.orders.push({
      ...cloneJson(state.integration.orders[0]),
      id: "00045",
      tableId: "room_pedana_t11",
      tableNumber: 11,
      tableLabel: "Tavolo 11",
      station: "CUCINA",
      assignedStationId: "CUCINA",
      idempotencyKey: "idem-order-00045",
      revision: 1,
      currentRevision: 1,
      createdAt: "2026-05-13T16:03:00.000Z",
      updatedAt: "2026-05-13T16:08:00.000Z",
      events: [{ id: "order_evt_45", type: "status_changed", occurredAt: "2026-05-13T16:08:00.000Z" }],
    });
    syncOrdersFromAppState(db, state, { nowIso });
    const relationalRuntime = {
      db,
      async initialize() {},
    };

    const snapshot = await listRelationalOrderWorkflowSnapshot({
      enabled: true,
      orderId: "00045",
      relationalRuntime,
      stationIds: ["BAR PRINCIPALE"],
      workflowLight: true,
    });
    const target = snapshot.orders.find((order) => order.id === "00045");
    const context = snapshot.orders.find((order) => order.id === "00042");
    const repoContext = new OrdersRelationalRepository(db)
      .listWorkflowOrders({ stationIds: ["BAR PRINCIPALE"] })
      .find((order) => order.id === "00042");

    assert.deepEqual(snapshot.orders.map((order) => order.id), ["00045", "00042"]);
    assert.equal(target.extraOrderField, "preserved");
    assert.equal(Array.isArray(target.events), true);
    assert.equal(context.extraOrderField, undefined);
    assert.equal(context.workflowStatus, "prep");
    assert.equal(context.paymentStatus, "unpaid");
    assert.equal(context.items[0].done, true);
    assert.equal(context.items[0].priceOverrideApplied, true);
    assert.equal(context.items[0].vatRate, 10);
    assert.equal(context.items[0].vatCode, "IVA10");
    assert.equal(context.items[0].departmentId, "bar");
    assert.equal(context.items[0].fiscalDepartment, "1");
    assert.equal(context.items[0].extraLineField, undefined);
    assert.equal(context.lineRoutes[0].stationId, "BAR PRINCIPALE");
    assert.equal(context.events, undefined);
    assert.equal(repoContext.extraOrderField, undefined);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P3.59 snapshot workflow filtra il contesto station per stati di coda", async () => {
  const runDir = await createTempRunDir("rel-orders-workflow-status-filter");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildOrdersState();
    state.integration.orders.push(
      {
        ...cloneJson(state.integration.orders[0]),
        id: "00045",
        tableId: "room_pedana_t11",
        tableNumber: 11,
        tableLabel: "Tavolo 11",
        station: "CUCINA",
        assignedStationId: "CUCINA",
        workflowStatus: "delivered",
        idempotencyKey: "idem-order-00045",
        revision: 1,
        currentRevision: 1,
        createdAt: "2026-05-13T16:03:00.000Z",
        updatedAt: "2026-05-13T16:08:00.000Z",
        events: [{ id: "order_evt_45", type: "status_changed", occurredAt: "2026-05-13T16:08:00.000Z" }],
      },
      {
        ...cloneJson(state.integration.orders[0]),
        id: "00046",
        tableId: "room_pedana_t12",
        tableNumber: 12,
        tableLabel: "Tavolo 12",
        station: "BAR PRINCIPALE",
        assignedStationId: "BAR PRINCIPALE",
        workflowStatus: "ready",
        idempotencyKey: "idem-order-00046",
        revision: 1,
        currentRevision: 1,
        createdAt: "2026-05-13T16:04:00.000Z",
        updatedAt: "2026-05-13T16:09:00.000Z",
        events: [{ id: "order_evt_46", type: "status_changed", occurredAt: "2026-05-13T16:09:00.000Z" }],
      },
    );
    syncOrdersFromAppState(db, state, { nowIso });
    const snapshot = await listRelationalOrderWorkflowSnapshot({
      enabled: true,
      orderId: "00045",
      relationalRuntime: { db, async initialize() {} },
      stationIds: ["BAR PRINCIPALE"],
      workflowLight: true,
      workflowStatuses: ["waiting", "prep"],
    });

    assert.deepEqual(snapshot.orders.map((order) => order.id), ["00045", "00042"]);
    assert.equal(snapshot.orders[0].workflowStatus, "delivered");
    assert.equal(snapshot.orders[0].extraOrderField, "preserved");
    assert.equal(snapshot.orders.some((order) => order.id === "00046"), false);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync orders importa ordine multi-linea", async () => {
  const runDir = await createTempRunDir("rel-orders-lines");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncOrdersFromAppState(db, buildOrdersState(), { nowIso });
    const lines = new OrdersRelationalRepository(db).listOrderLines("00042");
    assert.deepEqual(lines.map((line) => line.id), ["00042:line_caffe", "00042:line_gin", "00042:line_void"]);
    assert.equal(lines.find((line) => line.id === "00042:line_caffe").quantity, 2);
    assert.equal(lines.find((line) => line.id === "00042:line_gin").productName, "Gin Tonic");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync orders importa varianti e supplementi", async () => {
  const runDir = await createTempRunDir("rel-orders-variants");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncOrdersFromAppState(db, buildOrdersState(), { nowIso });
    const rows = db
      .prepare("SELECT name, variant_id, price_delta_cents FROM order_line_variants WHERE line_id = ? ORDER BY id")
      .all("00042:line_gin");
    assert.equal(rows.some((row) => row.name === "Gin premium" && row.variant_id === "gin_premium"), true);
    assert.equal(rows.some((row) => row.name === "Lime extra" && row.price_delta_cents === 50), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync orders preserva status", async () => {
  const runDir = await createTempRunDir("rel-orders-status");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncOrdersFromAppState(db, buildOrdersState(), { nowIso });
    const order = db.prepare("SELECT status FROM orders WHERE id = '00042'").get();
    const line = db.prepare("SELECT status FROM order_lines WHERE id = '00042:line_caffe'").get();
    assert.equal(order.status, "prep");
    assert.equal(line.status, "prep");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync orders preserva stationId", async () => {
  const runDir = await createTempRunDir("rel-orders-station");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncOrdersFromAppState(db, buildOrdersState(), { nowIso });
    const order = db.prepare("SELECT station_id FROM orders WHERE id = '00042'").get();
    const gin = db.prepare("SELECT station_id FROM order_lines WHERE id = '00042:line_gin'").get();
    assert.equal(order.station_id, "BAR PRINCIPALE");
    assert.equal(gin.station_id, "COCKTAIL");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync orders preserva tableId e roomId", async () => {
  const runDir = await createTempRunDir("rel-orders-table-room");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncOrdersFromAppState(db, buildOrdersState(), { nowIso });
    const row = db.prepare("SELECT table_id, room_id FROM orders WHERE id = '00042'").get();
    assert.equal(row.table_id, "room_pedana_t05");
    assert.equal(row.room_id, "room_pedana");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync orders preserva quantita preparate consegnate cancellate", async () => {
  const runDir = await createTempRunDir("rel-orders-quantities");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncOrdersFromAppState(db, buildOrdersState(), { nowIso });
    const caffe = db
      .prepare("SELECT quantity, prepared_quantity, delivered_quantity, cancelled_quantity FROM order_lines WHERE id = ?")
      .get("00042:line_caffe");
    const gin = db
      .prepare("SELECT quantity, prepared_quantity, delivered_quantity, cancelled_quantity FROM order_lines WHERE id = ?")
      .get("00042:line_gin");
    const voided = db
      .prepare("SELECT quantity, prepared_quantity, delivered_quantity, cancelled_quantity FROM order_lines WHERE id = ?")
      .get("00042:line_void");
    assert.equal(caffe.quantity, 2);
    assert.equal(caffe.prepared_quantity, 1);
    assert.equal(gin.delivered_quantity, 1);
    assert.equal(voided.cancelled_quantity, 1);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync orders converte totali in cents", async () => {
  const runDir = await createTempRunDir("rel-orders-cents");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncOrdersFromAppState(db, buildOrdersState(), { nowIso });
    const order = db.prepare("SELECT total_cents FROM orders WHERE id = '00042'").get();
    const caffe = db
      .prepare("SELECT unit_price_cents, total_cents FROM order_lines WHERE id = '00042:line_caffe'")
      .get();
    const gin = db
      .prepare("SELECT unit_price_cents, total_cents FROM order_lines WHERE id = '00042:line_gin'")
      .get();
    assert.equal(order.total_cents, 1710);
    assert.equal(caffe.unit_price_cents, 130);
    assert.equal(caffe.total_cents, 260);
    assert.equal(gin.unit_price_cents, 1050);
    assert.equal(gin.total_cents, 1050);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync orders raw_json preserva campi extra", async () => {
  const runDir = await createTempRunDir("rel-orders-raw");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncOrdersFromAppState(db, buildOrdersState(), { nowIso });
    const order = db.prepare("SELECT raw_json FROM orders WHERE id = '00042'").get();
    const line = db.prepare("SELECT raw_json FROM order_lines WHERE id = '00042:line_caffe'").get();
    const event = db.prepare("SELECT raw_json FROM order_events WHERE id = 'order_evt_1'").get();
    assert.equal(JSON.parse(order.raw_json).extraOrderField, "preserved");
    assert.equal(JSON.parse(line.raw_json).items[0].extraLineField, "first-unit");
    assert.equal(JSON.parse(event.raw_json).extraEventField, "preserved");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync orders preserva revision nativa", async () => {
  const runDir = await createTempRunDir("rel-orders-revision");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncOrdersFromAppState(db, buildOrdersState(), { nowIso });
    const order = new OrdersRelationalRepository(db).getOrderById("00042");
    const row = db.prepare("SELECT revision FROM orders WHERE id = ?").get("00042");
    assert.equal(row.revision, 7);
    assert.equal(order.revision, 7);
    assert.equal(order.currentRevision, 7);
  } finally {
    closeRelationalConnection(db);
  }
});

test("updateOrderWithRevision applica CAS e incrementa revision", async () => {
  const runDir = await createTempRunDir("rel-orders-revision-cas");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildOrdersState();
    syncOrdersFromAppState(db, state, { nowIso });
    const repo = new OrdersRelationalRepository(db);

    const updated = repo.updateOrderWithRevision("00042", 7, {
      status: "ready",
      updatedAt: "2026-05-13T16:06:00.000Z",
      rawJson: {
        ...state.integration.orders[0],
        idempotencyKey: "idem-order-00042-updated",
        workflowStatus: "ready",
        revision: 8,
        currentRevision: 8,
      },
    });
    const stale = repo.updateOrderWithRevision("00042", 7, { status: "delivered" });
    const current = repo.getOrderById("00042");

    assert.equal(updated.revision, 8);
    assert.equal(updated.workflowStatus, "ready");
    assert.equal(stale, null);
    assert.equal(current.revision, 8);
    assert.equal(current.workflowStatus, "ready");
    assert.equal(repo.findOrderByIdempotencyKey("idem-order-00042"), null);
    assert.equal(repo.findOrderByIdempotencyKey("idem-order-00042-updated")?.id, "00042");
  } finally {
    closeRelationalConnection(db);
  }
});

test("createOrder inserisce grafo ordine relazionale", async () => {
  const runDir = await createTempRunDir("rel-orders-create-primary");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildOrdersState();
    const repo = new OrdersRelationalRepository(db);
    const result = repo.createOrder(state.integration.orders[0]);
    const lines = repo.listOrderLines("00042");
    const events = repo.listOrderEvents("00042");
    const orderRow = db.prepare("SELECT * FROM orders WHERE id = ?").get("00042");
    const lineRaw = db.prepare("SELECT raw_json FROM order_lines WHERE id = ?").get("00042:line_caffe");

    assert.equal(result.inserted, true);
    assert.equal(result.order.id, "00042");
    assert.equal(result.order.revision, 7);
    assert.equal(lines.length, 3);
    assert.equal(events.length, 1);
    assert.equal(orderRow.idempotency_key, "idem-order-00042");
    assert.equal(orderRow.created_by_user_id, "u_cashier");
    assert.equal(orderRow.created_by_device_uuid, "device-cashier");
    assert.equal(JSON.parse(lineRaw.raw_json).items[0].extraLineField, "first-unit");
  } finally {
    closeRelationalConnection(db);
  }
});

test("findOrderByIdempotencyKey rispetta utente e device", async () => {
  const runDir = await createTempRunDir("rel-orders-idempotency-lookup");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const repo = new OrdersRelationalRepository(db);
    repo.createOrder(buildOrdersState().integration.orders[0]);

    const match = repo.findOrderByIdempotencyKey("idem-order-00042", {
      userId: "u_cashier",
      deviceUuid: "device-cashier",
    });
    const wrongDevice = repo.findOrderByIdempotencyKey("idem-order-00042", {
      userId: "u_cashier",
      deviceUuid: "other-device",
    });

    assert.equal(match.id, "00042");
    assert.equal(wrongDevice, null);
  } finally {
    closeRelationalConnection(db);
  }
});

test("findOrderByIdempotencyKey indicizza anche chiavi con spazi", async () => {
  const runDir = await createTempRunDir("rel-orders-idempotency-fallback");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const repo = new OrdersRelationalRepository(db);
    const order = {
      ...buildOrdersState().integration.orders[0],
      id: "00043",
      idempotencyKey: "idem order con spazio",
      createdByDeviceUuid: "device-cashier",
    };
    repo.createOrder(order);

    const match = repo.findOrderByIdempotencyKey("idem order con spazio", {
      userId: "u_cashier",
      deviceUuid: "device-cashier",
    });

    assert.equal(match.id, "00043");
  } finally {
    closeRelationalConnection(db);
  }
});

test("replaceOrderWithRevision sostituisce grafo ordine con CAS", async () => {
  const runDir = await createTempRunDir("rel-orders-sync-cas");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildOrdersState();
    const repo = new OrdersRelationalRepository(db);
    repo.createOrder(state.integration.orders[0]);
    const nextOrder = {
      ...state.integration.orders[0],
      workflowStatus: "ready",
      revision: 8,
      currentRevision: 8,
      updatedAt: "2026-05-13T16:06:00.000Z",
      items: state.integration.orders[0].items.slice(0, 2).map((item) => ({ ...item, done: true, doneQty: 1 })),
      events: [
        ...state.integration.orders[0].events,
        { id: "order_evt_ready", type: "order.ready", occurredAt: "2026-05-13T16:06:00.000Z" },
      ],
    };

    const recordedMetrics = [];
    const updated = await syncRelationalOrderPrimary({
      enabled: true,
      metricScope: "test",
      order: nextOrder,
      previousRevision: 7,
      relationalRuntime: { db, async initialize() {} },
      runtimeMetrics: {
        recordOperation(family, label, durationMs) {
          recordedMetrics.push({ family, label, durationMs });
        },
      },
    });
    const stale = repo.replaceOrderWithRevision({ ...nextOrder, workflowStatus: "delivered" }, 7);
    const lines = repo.listOrderLines("00042");
    const events = repo.listOrderEvents("00042");

    assert.equal(updated.order.revision, 8);
    assert.equal(updated.order.workflowStatus, "ready");
    assert.equal(stale, null);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].quantity, 2);
    assert.equal(events.some((event) => event.id === "order_evt_ready"), true);
    const internalLabels = recordedMetrics
      .filter((entry) => entry.family === "orderRelationalWriteInternal")
      .map((entry) => entry.label);
    for (const label of [
      "test.requireDb",
      "test.mapRows",
      "test.casUpdate",
      "test.deleteChildren",
      "test.insertChildren",
      "test.hydrateResult",
      "test.transaction.beginImmediate",
      "test.transaction.body",
      "test.transaction.commit",
      "test.total",
    ]) {
      assert.equal(internalLabels.includes(label), true, `metrica interna mancante: ${label}`);
    }
  } finally {
    closeRelationalConnection(db);
  }
});

test("updateOrderLocationWithRevision aggiorna solo posizione e revisione", async () => {
  const runDir = await createTempRunDir("rel-orders-location-cas");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildOrdersState();
    const initialOrder = state.integration.orders[0];
    const repo = new OrdersRelationalRepository(db);
    repo.createOrder(initialOrder);
    const initialLines = repo.listOrderLines(initialOrder.id);
    const expectedRevision = repo.getOrderById(initialOrder.id).revision;

    const updated = repo.updateOrderLocationWithRevision(
      initialOrder.id,
      expectedRevision,
      {
        tableId: "table_destination",
        roomId: "room_destination",
        tableNumber: 12,
        tableLabel: "12",
        logicalTableLabel: "12",
        lastTableTransferAtMs: 123456,
        updatedAt: "2026-07-16T14:45:00.000Z",
      },
    );
    const stale = repo.updateOrderLocationWithRevision(
      initialOrder.id,
      expectedRevision,
      { tableId: "table_stale" },
    );

    assert.equal(updated.tableId, "table_destination");
    assert.equal(updated.roomId, "room_destination");
    assert.equal(updated.tableNumber, 12);
    assert.equal(updated.lastTableTransferAtMs, 123456);
    assert.equal(updated.revision, expectedRevision + 1);
    assert.equal(stale, null);
    assert.deepEqual(repo.listOrderLines(initialOrder.id), initialLines);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync orders aggiorna relational_sync_state", async () => {
  const runDir = await createTempRunDir("rel-orders-sync-state");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const result = syncOrdersFromAppState(db, buildOrdersState(), { nowIso });
    const row = db.prepare("SELECT * FROM relational_sync_state WHERE domain = 'orders'").get();
    assert.equal(row.source_last_write_at, "2026-05-13T16:10:00.000Z");
    assert.equal(row.row_count, result.rowCount);
    assert.equal(row.checksum, result.checksum);
    assert.equal(row.synced_at, "2026-05-13T10:00:00.000Z");
    assert.equal(result.rowCount > 1, true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("append order events relazionale e idempotente", async () => {
  const runDir = await createTempRunDir("rel-orders-events-append");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildOrdersState();
    syncOrdersFromAppState(db, state, { nowIso });
    const repo = new OrdersRelationalRepository(db);
    const event = {
      id: "00042:order.created",
      eventType: "order.created",
      occurredAt: "2026-05-13T16:00:00.000Z",
      actorUserId: "u_cashier",
      payload: { orderId: "00042" },
    };

    const first = repo.appendOrderEvents(state.integration.orders[0], [event]);
    const second = repo.appendOrderEvents(state.integration.orders[0], [event]);
    const rows = repo.listOrderEvents("00042").filter((row) => row.id === "00042:order.created");

    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eventType, "order.created");
  } finally {
    closeRelationalConnection(db);
  }
});

test("writeDb in shadow mode richiama sync orders dopo scrittura app-state", async () => {
  const runDir = await createTempRunDir("rel-orders-write-hook");
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
    await repository.writeDb(buildOrdersState());
    const row = runtime.db.prepare("SELECT id, total_cents FROM orders WHERE id = '00042'").get();
    assert.equal(row.id, "00042");
    assert.equal(row.total_cents, 1710);
    const syncState = runtime.db.prepare("SELECT * FROM relational_sync_state WHERE domain = 'orders'").get();
    assert.equal(syncState.row_count > 0, true);
  } finally {
    runtime.close();
  }
});

test("runtime shadow I0 verifica equivalenza orders dopo sync", async () => {
  const runDir = await createTempRunDir("rel-orders-shadow-equivalence");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
    defaultDbPath: relationalPath,
    logger: { warn() {} },
    nowIso,
  });

  try {
    const result = await runtime.syncAfterAppStateWrite(buildOrdersState());
    assert.equal(result.equivalence.orders.matches, true);
    assert.equal(result.equivalence.orders.appState.rowCount, result.equivalence.orders.relational.rowCount);
  } finally {
    runtime.close();
  }
});

test("errore sync orders in shadow non rompe writeDb", async () => {
  const runDir = await createTempRunDir("rel-orders-write-error");
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
  const state = buildOrdersState();
  state.integration.orders.push({
    ...state.integration.orders[0],
    total: 1,
    updatedAt: "2026-05-13T16:06:00.000Z",
  });

  try {
    await repository.writeDb(state);
    const persisted = await readJson(appStatePath);
    assert.equal(persisted.integration.orders.length, 2);
    assert.equal(warnings.some((message) => /Sync relazionale shadow app-state fallita/i.test(message)), true);
  } finally {
    runtime.close();
  }
});
