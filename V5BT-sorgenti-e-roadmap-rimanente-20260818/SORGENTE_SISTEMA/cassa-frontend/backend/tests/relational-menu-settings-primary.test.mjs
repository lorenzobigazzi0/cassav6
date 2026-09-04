import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  normalizeRelationalConfig,
  openRelationalConnection,
} from "../db/relational/index.js";
import { createMenuSettingsRepository } from "../modules/menu-settings/index.js";
import { apiPost, authPayload, createTempRunDir, loginJson, startBackend } from "./helpers/test-server.mjs";

function seedMenuSettingsState(state) {
  state.menuItems = [
    {
      id: "menu_primary_caffe",
      name: "Caffe Primary",
      description: "Espresso test",
      price: 1.3,
      category: "Caffetteria",
      enabled: true,
      available: true,
      variants: [{ id: "large", name: "Grande", priceDelta: 0.5 }],
    },
    {
      id: "menu_primary_gin",
      name: "Gin Primary",
      price: 12,
      category: "Drink Premium",
      enabled: true,
      available: true,
      stationId: "COCKTAIL",
      variantRequired: true,
      variants: [{ id: "gin_premium", name: "Premium", priceDelta: 2.5 }],
    },
    {
      id: "menu_primary_hidden",
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
      { id: "room_pedana", roomId: "room_pedana", name: "Pedana", enabled: true },
      { id: "room_sala", roomId: "room_sala", name: "Sala", enabled: true },
    ],
    areas: [],
    tables: [
      {
        id: "room_pedana_t05",
        roomId: "room_pedana",
        number: 5,
        type: "Pedana",
        status: "free",
        guestName: "",
        covers: 0,
        totalDue: 0,
        pendingBills: [],
      },
      {
        id: "room_sala_t01",
        roomId: "room_sala",
        number: 1,
        type: "Sala",
        status: "free",
        guestName: "",
        covers: 0,
        totalDue: 0,
        pendingBills: [],
      },
    ],
  };
}

function primaryMenuEnv(relationalPath, domains = "menuSettings") {
  return {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "primary",
    BACKEND_RELATIONAL_PRIMARY_DOMAINS: domains,
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
  };
}

async function startSeededBackend(t, options = {}) {
  const runDir = await createTempRunDir(options.prefix ?? "rel-menu-primary");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const server = await startBackend(t, {
    runDir,
    stateOverrides: seedMenuSettingsState,
    env: options.env ?? {},
  });
  return { ...server, relationalPath, runDir };
}

async function startPrimaryMenuBackend(t, options = {}) {
  const runDir = await createTempRunDir(options.prefix ?? "rel-menu-primary");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const server = await startBackend(t, {
    runDir,
    stateOverrides: seedMenuSettingsState,
    env: primaryMenuEnv(relationalPath, options.domains),
  });
  return { ...server, relationalPath, runDir };
}

async function updateRelationalMenuItem(relationalPath, patch) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "primary",
    dbPath: relationalPath,
  });
  try {
    const current = db.prepare("SELECT raw_json FROM menu_items WHERE id = ?").get(patch.id);
    const raw = current?.raw_json ? JSON.parse(current.raw_json) : {};
    const nextRaw = {
      ...raw,
      ...(patch.name ? { name: patch.name } : {}),
      ...(Number.isFinite(Number(patch.price)) ? { price: Number(patch.price) } : {}),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    };
    db.prepare(
      `
        UPDATE menu_items
        SET name = ?, price_cents = ?, active = ?, raw_json = ?
        WHERE id = ?
      `
    ).run(
      nextRaw.name,
      Math.round(Number(nextRaw.price ?? 0) * 100),
      nextRaw.enabled === false ? 0 : 1,
      JSON.stringify(nextRaw),
      patch.id
    );
  } finally {
    closeRelationalConnection(db);
  }
}

function canonicalCatalog(body) {
  return {
    categories: [...(body.categories ?? [])].sort(),
    items: (body.items ?? [])
      .map((item) => ({
        id: item.id,
        name: item.name,
        price: item.price,
        category: item.category,
        enabled: item.enabled,
        variantRequired: item.variantRequired === true,
        variants: (item.variants ?? [])
          .map((variant) => ({
            id: variant.id,
            name: variant.name,
            priceDelta: variant.priceDelta,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function canonicalPaymentMethods(body) {
  return (body.paymentMethods ?? [])
    .map((method) => ({
      id: method.id,
      label: method.label,
      enabled: method.enabled,
      isFiscal: method.isFiscal,
      isSmart: method.isSmart,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalRooms(body) {
  return (body.rooms ?? [])
    .map((room) => ({
      roomId: room.roomId,
      roomName: room.roomName,
      enabled: room.enabled,
      authorized: room.authorized,
      requiresAdminAuth: room.requiresAdminAuth,
    }))
    .sort((left, right) => left.roomId.localeCompare(right.roomId));
}

async function fetchCatalog(baseUrl, deviceUuid) {
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const catalog = await apiPost(baseUrl, "/api/menu/catalog", authPayload(session, deviceUuid));
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.body.ok, true);
  return { catalog: catalog.body, session };
}

test("BACKEND_RELATIONAL_PRIMARY_DOMAINS accetta menuSettings", () => {
  const config = normalizeRelationalConfig({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "primary",
      BACKEND_RELATIONAL_PRIMARY_DOMAINS: "menuSettings",
      BACKEND_RELATIONAL_DB_PATH: "tmp-rel.sqlite",
    },
  });
  assert.equal(config.primaryDomains.has("menuSettings"), true);
});

test("/api/menu/catalog app-state e relazionale primary sono semanticamente equivalenti", async (t) => {
  const appStateServer = await startSeededBackend(t, { prefix: "rel-menu-app-state" });
  const primaryServer = await startPrimaryMenuBackend(t, { prefix: "rel-menu-primary-eq" });

  const appStateCatalog = await fetchCatalog(appStateServer.baseUrl, "catalog-app-state");
  const primaryCatalog = await fetchCatalog(primaryServer.baseUrl, "catalog-primary");

  assert.deepEqual(canonicalCatalog(primaryCatalog.catalog), canonicalCatalog(appStateCatalog.catalog));
  assert.equal(canonicalCatalog(primaryCatalog.catalog).items.some((item) => item.id === "menu_primary_hidden"), false);
  assert.equal(
    canonicalCatalog(primaryCatalog.catalog).items.find((item) => item.id === "menu_primary_gin").variantRequired,
    true
  );
  assert.equal(
    canonicalCatalog(primaryCatalog.catalog).items.find((item) => item.id === "menu_primary_caffe").price,
    1.3
  );

  const appPayments = await fetch(`${appStateServer.baseUrl}/api/settings/payment-methods`).then((response) => response.json());
  const relPayments = await fetch(`${primaryServer.baseUrl}/api/settings/payment-methods`).then((response) => response.json());
  assert.deepEqual(canonicalPaymentMethods(relPayments), canonicalPaymentMethods(appPayments));

  const appRooms = await apiPost(
    appStateServer.baseUrl,
    "/api/pos/rooms",
    authPayload(appStateCatalog.session, "catalog-app-state")
  );
  const relRooms = await apiPost(
    primaryServer.baseUrl,
    "/api/pos/rooms",
    authPayload(primaryCatalog.session, "catalog-primary")
  );
  assert.equal(appRooms.response.status, 200);
  assert.equal(relRooms.response.status, 200);
  assert.deepEqual(canonicalRooms(relRooms.body), canonicalRooms(appRooms.body));
});

test("/api/menu/catalog legge dal relazionale quando menuSettings primary e attivo", async (t) => {
  const { baseUrl, relationalPath } = await startPrimaryMenuBackend(t, { prefix: "rel-menu-primary-read" });
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "catalog-rel-read",
    clientApp: "mobile-frontend",
  });
  await updateRelationalMenuItem(relationalPath, {
    id: "menu_primary_caffe",
    name: "Caffe Relazionale",
    price: 2.5,
  });

  const response = await apiPost(baseUrl, "/api/menu/catalog", authPayload(session, "catalog-rel-read"));
  assert.equal(response.response.status, 200);
  const catalog = response.body;
  const coffee = catalog.items.find((item) => item.id === "menu_primary_caffe");
  assert.equal(coffee.name, "Caffe Relazionale");
  assert.equal(coffee.price, 2.5);
});

test("/api/menu/catalog resta app-state quando menuSettings primary non e attivo", async (t) => {
  const runDir = await createTempRunDir("rel-menu-primary-off");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    stateOverrides: seedMenuSettingsState,
    env: primaryMenuEnv(relationalPath, "users"),
  });
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "catalog-app-state-read",
    clientApp: "mobile-frontend",
  });
  await updateRelationalMenuItem(relationalPath, {
    id: "menu_primary_caffe",
    name: "Caffe Relazionale Ignorato",
    price: 2.5,
  });

  const response = await apiPost(baseUrl, "/api/menu/catalog", authPayload(session, "catalog-app-state-read"));
  assert.equal(response.response.status, 200);
  const catalog = response.body;
  const coffee = catalog.items.find((item) => item.id === "menu_primary_caffe");
  assert.equal(coffee.name, "Caffe Primary");
  assert.equal(coffee.price, 1.3);
});

test("errore relazionale primary menuSettings produce messaggio chiaro", () => {
  const repository = createMenuSettingsRepository({
    relationalRuntime: {
      db: null,
      isPrimaryDomain(domain) {
        return domain === "menuSettings";
      },
    },
  });
  assert.throws(
    () => repository.getMenuItems({ menuItems: [] }),
    /DB relazionale primary non disponibile per menuSettings/i
  );
});
