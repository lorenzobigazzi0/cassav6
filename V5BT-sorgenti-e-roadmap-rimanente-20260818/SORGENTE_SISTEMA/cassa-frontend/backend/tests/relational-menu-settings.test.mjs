import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAppStateRepository } from "../db/app-state/index.js";
import {
  createRelationalRuntime,
  MenuSettingsRelationalRepository,
  openRelationalConnection,
  runRelationalMigrations,
  syncMenuSettingsFromAppState,
  syncRelationalShadowAfterAppStateWrite,
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

function buildMenuSettingsState() {
  const state = buildTestState();
  state.meta.lastWriteAt = "2026-05-13T15:10:00.000Z";
  state.menuItems = [
    {
      id: "menu_test_caffe",
      name: "Caffe Test",
      description: "Espresso di prova",
      price: 1.3,
      category: "Caffetteria",
      enabled: true,
      available: true,
      stations: ["CAFFETTERIA"],
      variants: [{ id: "large", name: "Grande", priceDelta: 0.5 }],
      extraItemField: "preserved",
    },
    {
      id: "menu_test_gin",
      name: "Gin Test",
      price: 12,
      category: "Drink Premium",
      enabled: true,
      available: true,
      stationId: "COCKTAIL",
      stations: ["COCKTAIL"],
      variantRequired: true,
      variants: [{ id: "gin_premium", name: "Premium", priceDelta: 2.5 }],
    },
    {
      id: "menu_test_hidden",
      name: "Bibita Nascosta",
      price: 4,
      category: "Bibite",
      enabled: false,
      available: false,
    },
  ];
  state.posSettings = {
    ...state.posSettings,
    paymentMethods: [
      { id: "pay_cash", label: "Contanti", enabled: true, isFiscal: true },
      { id: "pay_card", label: "Carta", enabled: false, isFiscal: true },
    ],
    rooms: [
      { id: "room_pedana", roomId: "room_pedana", name: "Pedana", enabled: true, extraRoomField: "preserved" },
      { id: "room_sala", roomId: "room_sala", name: "Sala", enabled: false },
    ],
    areas: [],
    tables: [
      {
        id: "room_pedana_t05",
        roomId: "room_pedana",
        number: 5,
        name: "Tavolo 5",
        enabled: true,
        x: 10,
        y: 20,
        shape: "square",
        extraTableField: "preserved",
      },
      {
        id: "room_sala_t01",
        roomId: "room_sala",
        number: 1,
        name: "Sala 1",
        enabled: false,
      },
    ],
  };
  return state;
}

test("migrazione 007_menu_settings crea tabelle", async () => {
  const runDir = await createTempRunDir("rel-migrations-menu-settings");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    assert.equal(tableExists(db, "menu_categories"), true);
    assert.equal(tableExists(db, "menu_items"), true);
    assert.equal(tableExists(db, "menu_item_variants"), true);
    assert.equal(tableExists(db, "payment_methods"), true);
    assert.equal(tableExists(db, "pos_rooms"), true);
    assert.equal(tableExists(db, "pos_tables"), true);
    assert.equal(indexExists(db, "idx_menu_items_category"), true);
    assert.equal(indexExists(db, "idx_menu_items_active_available"), true);
    assert.equal(indexExists(db, "idx_menu_item_variants_item"), true);
    assert.equal(indexExists(db, "idx_pos_tables_room"), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync menuSettings importa categorie", async () => {
  const runDir = await createTempRunDir("rel-menu-categories");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncMenuSettingsFromAppState(db, buildMenuSettingsState(), { nowIso });
    const categories = new MenuSettingsRelationalRepository(db).listCategories();
    assert.deepEqual(categories.map((entry) => entry.id), [
      "cat_caffetteria",
      "cat_drink_premium",
      "cat_bibite",
    ]);
    assert.equal(categories.find((entry) => entry.id === "cat_bibite").active, false);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync menuSettings importa prodotti", async () => {
  const runDir = await createTempRunDir("rel-menu-items");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncMenuSettingsFromAppState(db, buildMenuSettingsState(), { nowIso });
    const repo = new MenuSettingsRelationalRepository(db);
    const item = repo.getMenuItemById("menu_test_caffe");
    assert.equal(item.name, "Caffe Test");
    assert.equal(item.categoryId, "cat_caffetteria");
    assert.equal(item.department, "caffetteria");
    assert.deepEqual(item.stations, ["CAFFETTERIA"]);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync menuSettings importa varianti", async () => {
  const runDir = await createTempRunDir("rel-menu-variants");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncMenuSettingsFromAppState(db, buildMenuSettingsState(), { nowIso });
    const rows = db.prepare("SELECT * FROM menu_item_variants ORDER BY id").all();
    assert.deepEqual(rows.map((entry) => entry.id), ["gin_premium", "large"]);
    assert.equal(rows.find((entry) => entry.id === "large").price_delta_cents, 50);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync menuSettings importa payment methods", async () => {
  const runDir = await createTempRunDir("rel-menu-payment-methods");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncMenuSettingsFromAppState(db, buildMenuSettingsState(), { nowIso });
    const methods = new MenuSettingsRelationalRepository(db).listPaymentMethods();
    assert.deepEqual(methods.map((entry) => entry.id), ["pay_cash", "pay_card"]);
    assert.equal(methods.find((entry) => entry.id === "pay_cash").fiscal, true);
    assert.equal(methods.find((entry) => entry.id === "pay_card").active, false);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync menuSettings importa rooms e tables", async () => {
  const runDir = await createTempRunDir("rel-menu-rooms-tables");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncMenuSettingsFromAppState(db, buildMenuSettingsState(), { nowIso });
    const repo = new MenuSettingsRelationalRepository(db);
    const rooms = repo.listRooms();
    const tables = repo.listTables({ roomId: "room_pedana" });
    assert.equal(rooms.some((entry) => entry.id === "room_pedana" && entry.active === true), true);
    assert.equal(rooms.some((entry) => entry.id === "room_sala" && entry.active === false), true);
    assert.deepEqual(tables.map((entry) => entry.id), ["room_pedana_t05"]);
    assert.equal(tables[0].layout.x, 10);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync menuSettings converte prezzo item in cents coerente", async () => {
  const runDir = await createTempRunDir("rel-menu-price-cents");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncMenuSettingsFromAppState(db, buildMenuSettingsState(), { nowIso });
    const row = db.prepare("SELECT price_cents FROM menu_items WHERE id = 'menu_test_caffe'").get();
    assert.equal(row.price_cents, 130);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync menuSettings preserva variante obbligatoria", async () => {
  const runDir = await createTempRunDir("rel-menu-required-variant");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncMenuSettingsFromAppState(db, buildMenuSettingsState(), { nowIso });
    const row = db.prepare("SELECT required FROM menu_item_variants WHERE id = 'gin_premium'").get();
    assert.equal(row.required, 1);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync menuSettings preserva prodotto disabilitato e unavailable", async () => {
  const runDir = await createTempRunDir("rel-menu-disabled");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncMenuSettingsFromAppState(db, buildMenuSettingsState(), { nowIso });
    const row = db.prepare("SELECT active, available FROM menu_items WHERE id = 'menu_test_hidden'").get();
    assert.equal(row.active, 0);
    assert.equal(row.available, 0);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync menuSettings raw_json preserva campi extra", async () => {
  const runDir = await createTempRunDir("rel-menu-raw");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncMenuSettingsFromAppState(db, buildMenuSettingsState(), { nowIso });
    const item = db.prepare("SELECT raw_json FROM menu_items WHERE id = 'menu_test_caffe'").get();
    const room = db.prepare("SELECT raw_json FROM pos_rooms WHERE id = 'room_pedana'").get();
    const table = db.prepare("SELECT raw_json FROM pos_tables WHERE id = 'room_pedana_t05'").get();
    assert.equal(JSON.parse(item.raw_json).extraItemField, "preserved");
    assert.equal(JSON.parse(room.raw_json).extraRoomField, "preserved");
    assert.equal(JSON.parse(table.raw_json).extraTableField, "preserved");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync menuSettings aggiorna relational_sync_state", async () => {
  const runDir = await createTempRunDir("rel-menu-sync-state");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const result = syncMenuSettingsFromAppState(db, buildMenuSettingsState(), { nowIso });
    const row = db.prepare("SELECT * FROM relational_sync_state WHERE domain = 'menuSettings'").get();
    assert.equal(row.source_last_write_at, "2026-05-13T15:10:00.000Z");
    assert.equal(row.row_count, 14);
    assert.equal(row.checksum, result.checksum);
    assert.equal(row.synced_at, "2026-05-13T10:00:00.000Z");
  } finally {
    closeRelationalConnection(db);
  }
});

test("errore sync menuSettings in shadow non rompe writeDb", async () => {
  const runDir = await createTempRunDir("rel-menu-write-error");
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
  const state = buildMenuSettingsState();
  state.menuItems.push({
    ...state.menuItems[0],
    name: "Duplicato",
    price: 2,
  });

  try {
    await repository.writeDb(state);
    const persisted = await readJson(appStatePath);
    assert.equal(persisted.menuItems.length, 4);
    assert.equal(warnings.some((message) => /Sync relazionale shadow app-state fallita/i.test(message)), true);
  } finally {
    runtime.close();
  }
});
