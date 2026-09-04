import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildInitialAppState } from "../app-state/initial-state.js";
import { hashPin } from "../auth/password.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(testDir, "..");
const projectRoot = path.resolve(backendDir, "..", "..");
const distDir = path.resolve(projectRoot, "cassa-frontend", "dist");

function freePort() {
  return 6400 + Math.trunc(Math.random() * 1000);
}

async function waitForHealth(baseUrl, timeoutMs = 8000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("Backend did not become healthy.");
}

async function waitForPrintKinds(dbPath, orderId, expectedKinds, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const db = await readDb(dbPath);
    const printKinds = db.printSpoolJobs
      .filter((job) => job.orderId === orderId)
      .map((job) => job.kind);
    if (expectedKinds.every((kind) => printKinds.includes(kind))) {
      return { db, printKinds };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const db = await readDb(dbPath);
  return {
    db,
    printKinds: db.printSpoolJobs
      .filter((job) => job.orderId === orderId)
      .map((job) => job.kind),
  };
}

function makeTable(type, number) {
  const idPrefix =
    type === "Terrazza" ? "sala_terrazza" : type === "Sala" ? "room_sala" : "room_pedana";
  return {
    id: `${idPrefix}_t${String(number).padStart(2, "0")}`,
    number,
    type,
    status: "free",
    guestName: "",
    customerPhone: "",
    covers: 0,
    totalDue: 0,
    pendingBills: [],
    reservation: null,
    note: "",
    allergens: [],
    manualIntolerance: "",
  };
}

function continuityTables() {
  return [
    ...Array.from({ length: 30 }, (_, index) => makeTable("Pedana", index + 1)),
    ...Array.from({ length: 20 }, (_, index) => makeTable("Terrazza", index + 1)),
    ...Array.from({ length: 10 }, (_, index) => makeTable("Sala", index + 1)),
  ];
}

function drinkVariants(id) {
  return [
    { id: `${id}_sour`, name: "Sour", priceDelta: 0 },
    { id: `${id}_fizz`, name: "Fizz", priceDelta: 0 },
  ];
}

function premiumVariants(id) {
  return ["Liscio", "Lemon", "Tonic", "Fizz"].map((name) => ({
    id: `${id}_${name.toLowerCase()}`,
    name,
    priceDelta: 0,
  }));
}

function menuItem({
  id,
  name,
  price,
  category,
  department = "Bar",
  section = "",
  variants = [],
  variantRequired = false,
  isPremiumAlcohol = false,
}) {
  return {
    id,
    sku: id.toUpperCase(),
    name,
    price,
    department,
    category,
    section,
    station: "BAR PRINCIPALE",
    stations: ["BAR PRINCIPALE"],
    variants,
    variantRequired,
    requiresVariantSelection: variantRequired,
    isPremiumAlcohol,
  };
}

function continuityMenuItems(existingItems) {
  const additions = [
    menuItem({ id: "menu_caffetteria_caffe", name: "Caffe", price: 1.3, category: "Caffetteria", department: "Caffetteria" }),
    menuItem({ id: "menu_caffetteria_cappuccino", name: "Cappuccino", price: 1.6, category: "Caffetteria", department: "Caffetteria" }),
    menuItem({ id: "menu_caffetteria_latte_macchiato", name: "Latte Macchiato", price: 1.5, category: "Caffetteria", department: "Caffetteria" }),
    menuItem({ id: "menu_drink_bloody_mary", name: "Bloody Mary", price: 8, category: "Drink", variants: drinkVariants("menu_drink_bloody_mary") }),
    menuItem({ id: "menu_drink_americano", name: "Americano", price: 8, category: "Drink", variants: drinkVariants("menu_drink_americano") }),
    menuItem({ id: "menu_drink_caipiroska_fragola", name: "Caipiroska Fragola", price: 9, category: "Drink", variants: drinkVariants("menu_drink_caipiroska_fragola") }),
    menuItem({ id: "menu_apericena_standard", name: "Apericena", price: 12, category: "Apericena", department: "Cucina" }),
    menuItem({ id: "menu_apericena_prenotazione", name: "Apericena Prenotazione", price: 14, category: "Apericena", department: "Cucina" }),
    menuItem({ id: "menu_apericena_premium", name: "Apericena Premium", price: 17, category: "Apericena", department: "Cucina" }),
    menuItem({ id: "menu_drink_premium_capri", name: "Capri", price: 12, category: "Drink Premium", section: "Gin", variants: premiumVariants("menu_drink_premium_capri"), variantRequired: true, isPremiumAlcohol: true }),
    menuItem({ id: "menu_drink_premium_mare", name: "Gin Mare", price: 12, category: "Drink Premium", section: "Gin", variants: premiumVariants("menu_drink_premium_mare"), variantRequired: true, isPremiumAlcohol: true }),
    menuItem({ id: "menu_drink_premium_tanqueray", name: "Tanqueray", price: 10, category: "Drink Premium", section: "Gin", variants: premiumVariants("menu_drink_premium_tanqueray"), variantRequired: true, isPremiumAlcohol: true }),
    menuItem({ id: "menu_drink_premium_tanqueray_0", name: "Tanqueray 0", price: 10, category: "Drink Premium", section: "Gin", variants: premiumVariants("menu_drink_premium_tanqueray_0"), variantRequired: true, isPremiumAlcohol: true }),
    menuItem({ id: "menu_drink_premium_grey_goose", name: "Grey Goose", price: 12, category: "Drink Premium", section: "Vodka", variants: premiumVariants("menu_drink_premium_grey_goose"), variantRequired: true, isPremiumAlcohol: true }),
    menuItem({ id: "menu_drink_premium_absolut", name: "Absolut", price: 10, category: "Drink Premium", section: "Vodka", variants: premiumVariants("menu_drink_premium_absolut"), variantRequired: true, isPremiumAlcohol: true }),
    menuItem({ id: "menu_drink_premium_skyy", name: "SKYY", price: 10, category: "Drink Premium", section: "Vodka", variants: premiumVariants("menu_drink_premium_skyy"), variantRequired: true, isPremiumAlcohol: true }),
  ];
  const byId = new Map((Array.isArray(existingItems) ? existingItems : []).map((item) => [String(item.id), item]));
  for (const item of additions) byId.set(item.id, { ...byId.get(item.id), ...item });
  byId.delete("menu_drink_premium_gin_lemon");
  byId.delete("menu_drink_premium_gin_tonic");
  return [...byId.values()];
}

async function writeContinuityDb(dbPath) {
  const state = buildInitialAppState();
  const now = new Date().toISOString();
  const paymentMethods = [
    { id: "pay_cash", label: "Contanti", enabled: true, isSmart: false, isFiscal: true },
    { id: "pay_card", label: "Carta", enabled: true, isSmart: false, isFiscal: true },
    { id: "pay_smart", label: "Smart", enabled: false, isSmart: true, isFiscal: false },
    { id: "pay_chip", label: "MyConto", enabled: false, isSmart: true, isFiscal: false },
  ];
  state.menuItems = continuityMenuItems(state.menuItems).map((item) => ({
    ...item,
    createdByUserId: item.createdByUserId ?? "system",
    createdAt: item.createdAt ?? now,
    updatedAt: now,
  }));
  state.posSettings = {
    ...state.posSettings,
    tables: continuityTables(),
    paymentMethods,
    printers: [
      {
        id: "printer_bar",
        name: "Stampante Bar",
        host: "127.0.0.1",
        port: 9100,
        purpose: "generic",
        active: true,
      },
    ],
    areas: ["room_pedana", "sala_terrazza", "room_sala"].map((id) => ({
      id,
      name: id === "sala_terrazza" ? "Terrazza" : id === "room_sala" ? "Sala" : "Pedana",
      printerIds: ["printer_bar"],
      cashPoints: [
        {
          id: `${id}_cash`,
          name: `${id} cassa`,
          printerIds: ["printer_bar"],
          fiscalPrinterId: null,
        },
      ],
      workstations: [
        {
          id: `${id}_station`,
          name: "BAR PRINCIPALE",
          stationName: "BAR PRINCIPALE",
          printerIds: ["printer_bar"],
        },
        {
          id: `${id}_station_secondary`,
          name: "BAR SECONDARIA",
          stationName: "BAR SECONDARIA",
          printerIds: ["printer_bar"],
        },
      ],
    })),
    orderWorkflow: {
      deliveryConfirmationEnabled: false,
      requireReadyForDelivery: false,
      requireDeliveredForPayment: false,
    },
  };
  state.users = [
    {
      id: "u_admin",
      username: "admin_test",
      fullName: "Admin Test",
      role: "admin",
      roleLabel: "Amministratore",
      permissions: [
        "manage_users",
        "manage_menu",
        "manage_reservations",
        "manage_settings",
        "manage_tables",
        "collect_payments",
        "print_orders",
        "approve_room_change",
      ],
      authorizedRoomIds: [],
      enabledRoomIds: [],
      allowedPaymentMethodIds: paymentMethods.map((method) => method.id),
      pinHash: hashPin("1111"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_giada",
      username: "giada",
      fullName: "Giada Imperato",
      role: "operator",
      roleLabel: "Operatore",
      permissions: [
        "collect_payments",
        "print_orders",
        "manage_tables",
        "approve_room_change",
        "create_bar_replacement",
        "fiscal_operations",
        "manage_reservations",
      ],
      authorizedRoomIds: ["room_pedana", "sala_terrazza", "room_sala"],
      enabledRoomIds: ["room_pedana", "sala_terrazza", "room_sala"],
      allowedPaymentMethodIds: ["pay_cash", "pay_card"],
      pinHash: hashPin("2222"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_anna",
      username: "anna",
      fullName: "Anna Campana",
      role: "operator",
      roleLabel: "Operatore",
      permissions: [
        "collect_payments",
        "print_orders",
        "manage_tables",
        "approve_room_change",
        "create_bar_replacement",
        "fiscal_operations",
        "manage_reservations",
      ],
      authorizedRoomIds: ["room_pedana", "sala_terrazza", "room_sala"],
      enabledRoomIds: ["room_pedana", "sala_terrazza", "room_sala"],
      allowedPaymentMethodIds: ["pay_cash", "pay_card"],
      pinHash: hashPin("1234"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_station",
      username: "postazione",
      fullName: "Postazione Bar",
      role: "operator",
      roleLabel: "Operatore",
      permissions: ["print_orders", "approve_room_change", "manage_menu"],
      authorizedRoomIds: ["room_pedana", "sala_terrazza", "room_sala"],
      enabledRoomIds: ["room_pedana", "sala_terrazza", "room_sala"],
      allowedPaymentMethodIds: [],
      pinHash: hashPin("3333"),
      createdAt: now,
      updatedAt: now,
    },
  ];
  state.meta.lastWriteAt = now;
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function startBackend(t) {
  const port = freePort();
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), `apptocheck-continuity-${port}-`));
  const dbPath = path.join(runDir, "app-state.json");
  await writeContinuityDb(dbPath);
  const child = spawn(process.execPath, ["backend/server.js"], {
    cwd: path.resolve(projectRoot, "cassa-frontend"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      BACKEND_DB_MODE: "json",
      BACKEND_PORT: String(port),
      BACKEND_DB_PATH: dbPath,
      BACKEND_TOKEN_SECRET: "continuity-secret-12345678901234567890",
      CORS_ALLOWED_ORIGINS: "http://allowed.example",
      FISCAL_PROVIDER: "mock",
      ORDER_READY_TARGET_TIMEOUT_MS: "60000",
      PRINTING_ENABLED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (!child.killed) {
      child.kill();
    }
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 1000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await fs.rm(runDir, { recursive: true, force: true });
  });
  child.once("exit", (code) => {
    if (code && code !== 0 && !child.killed) {
      throw new Error(`Backend exited with ${code}`);
    }
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  return { baseUrl, dbPath };
}

async function readDb(dbPath) {
  return JSON.parse(await fs.readFile(dbPath, "utf8"));
}

async function login(baseUrl, username, pin, deviceUuid, clientApp = "mobile-frontend") {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, pin, deviceUuid, clientApp }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function selectWorkstation(baseUrl, session, deviceUuid, stationName) {
  const workstation = session.availableWorkstations?.find(
    (entry) => entry.stationName === stationName,
  );
  assert.ok(workstation?.id, `la postazione ${stationName} deve essere selezionabile`);
  await api(baseUrl, session, deviceUuid, "POST", "/api/auth/workstation/select", {
    clientApp: "postazione",
    workstationId: workstation.id,
    stationName: workstation.stationName,
  });
}

function authHeaders(session, deviceUuid) {
  return {
    Authorization: `Bearer ${session.token}`,
    "X-User-Id": session.user.id,
    "X-Device-Uuid": deviceUuid,
    "Content-Type": "application/json",
  };
}

async function api(baseUrl, session, deviceUuid, method, route, body = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: authHeaders(session, deviceUuid),
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (response.status !== expectedStatus) {
    assert.fail(`${method} ${route} expected ${expectedStatus}, got ${response.status}: ${text}`);
  }
  return parsed;
}

async function publicApi(baseUrl, route, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  if (response.status !== expectedStatus) {
    assert.fail(`GET ${route} expected ${expectedStatus}, got ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function mobileConsumer(session, deviceUuid) {
  const userPart = String(session.user.id || session.user.username || "anon")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
  const devicePart = String(deviceUuid || "device")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .slice(0, 24);
  return `mobile-frontend:${userPart || "anon"}:${devicePart || "device"}`;
}

async function pullMobileNotifications(baseUrl, session, deviceUuid, extra = {}) {
  const query = new URLSearchParams({
    consumer: mobileConsumer(session, deviceUuid),
    clientApp: "mobile-frontend",
    token: session.token,
    userId: session.user.id,
    username: session.user.username,
    fullName: session.user.fullName,
    deviceUuid,
    roomId: extra.roomId ?? "room_pedana",
    roomName: extra.roomName ?? "Pedana",
  });
  const response = await fetch(`${baseUrl}/api/integration/notifications/pull?${query}`);
  const text = await response.text();
  if (response.status !== 200) {
    assert.fail(`GET notifications/pull expected 200, got ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function ackMobileNotification(
  baseUrl,
  session,
  deviceUuid,
  id,
  extra = {},
  expectedStatus = 200,
) {
  const response = await fetch(`${baseUrl}/api/integration/notifications/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      consumer: mobileConsumer(session, deviceUuid),
      action: "ack",
      userId: session.user.id,
      username: session.user.username,
      fullName: session.user.fullName,
      deviceUuid,
      roomId: extra.roomId ?? "room_pedana",
      roomName: extra.roomName ?? "Pedana",
      clientApp: "mobile-frontend",
    }),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    assert.fail(`POST notifications/ack expected ${expectedStatus}, got ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function lockTable(baseUrl, session, deviceUuid, tableId, purpose) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/tables/lock/acquire", { tableId, purpose });
}

async function releaseTableLock(baseUrl, session, deviceUuid, tableId) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/tables/lock/release", { tableId });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function line(name, price, quantity = 1, extra = {}) {
  return {
    name,
    productName: name,
    qty: quantity,
    quantity,
    price,
    unitPrice: price,
    ...extra,
  };
}

function linesTotal(lines) {
  return Number(
    lines
      .reduce((sum, entry) => sum + (Number(entry.price ?? entry.unitPrice) || 0) * (Number(entry.qty ?? entry.quantity) || 1), 0)
      .toFixed(2)
  );
}

async function createOrder(baseUrl, session, deviceUuid, options) {
  const tableId = options.tableId;
  await lockTable(baseUrl, session, deviceUuid, tableId, "order.create");
  const tableNumber = Number(options.tableNumber ?? tableId.match(/_t(\d+)$/)?.[1] ?? 0);
  const lines = options.lines;
  return api(baseUrl, session, deviceUuid, "POST", "/api/integration/orders/create", {
    source: "mobile-frontend",
    tableId,
    roomId: options.roomId,
    tableNumber,
    covers: options.covers ?? 2,
    apericena: options.apericena ?? 0,
    note: options.note ?? "",
    orderNote: options.note ?? "",
    communications: options.communications ?? "",
    orderComment: options.communications ?? "",
    total: options.total ?? linesTotal(lines),
    lines,
  }, options.expectedStatus ?? 200);
}

async function syncOrder(baseUrl, session, deviceUuid, orderId, order) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/integration/orders/sync", { id: orderId, order });
}

async function readyOrder(baseUrl, session, deviceUuid, orderId, stationName = "BAR PRINCIPALE") {
  return syncOrder(baseUrl, session, deviceUuid, orderId, {
    workflowStatus: "ready",
    station: stationName,
    ownerStation: stationName,
  });
}

async function finishHistoricalStationQueue(
  baseUrl,
  dbPath,
  session,
  deviceUuid,
  stationName,
  historicalOrderIds,
) {
  for (let attempt = 0; attempt <= historicalOrderIds.size; attempt += 1) {
    const db = await readDb(dbPath);
    const preparing = db.integration.orders.find(
      (order) =>
        historicalOrderIds.has(order.id) &&
        order.assignedStationId === stationName &&
        ["waiting", "prep"].includes(order.workflowStatus),
    );
    if (!preparing) return;
    await readyOrder(baseUrl, session, deviceUuid, preparing.id, stationName);
  }
  assert.fail(`impossibile liberare la coda storica di ${stationName}`);
}

async function payFreeSplit(baseUrl, session, deviceUuid, tableId, roomId, orderId, amount, extra = {}) {
  await lockTable(baseUrl, session, deviceUuid, tableId, "payment.free_split");
  return api(baseUrl, session, deviceUuid, "POST", "/api/payments/free-split", {
    tableId,
    roomId,
    orderId,
    splitType: extra.splitType ?? "FREE_SPLIT",
    splitMode: extra.splitMode,
    idempotencyKey: extra.idempotencyKey ?? `pay-${orderId}-${amount}-${Date.now()}`,
    releaseTable: extra.releaseTable,
    articleUnitIds: extra.articleUnitIds,
    note: extra.note,
    parts: [
      {
        amountDue: amount,
        transactions: [
          {
            method: extra.method ?? "CASH",
            methodId: extra.methodId ?? "pay_cash",
            methodLabel: extra.methodLabel ?? "Contanti",
            amountPaid: amount,
            cashGiven: extra.cashGiven ?? amount,
            posProvider: extra.posProvider,
            posTxRef: extra.posTxRef,
            note: extra.txNote,
          },
        ],
      },
    ],
  }, extra.expectedStatus ?? 200);
}

async function compOrderLine(baseUrl, session, deviceUuid, tableId, roomId, orderId, originalLineId, extra = {}) {
  await lockTable(baseUrl, session, deviceUuid, tableId, "order.comp");
  return api(baseUrl, session, deviceUuid, "POST", "/api/integration/orders/comp", {
    tableId,
    roomId,
    orderId,
    originalLineId,
    quantity: extra.quantity ?? 1,
    reason: extra.reason ?? "Test storno",
    sendReplacement: extra.sendReplacement,
    idempotencyKey: extra.idempotencyKey ?? `comp-${orderId}-${originalLineId}-${Date.now()}`,
  }, extra.expectedStatus ?? 200);
}

async function moveTable(baseUrl, session, deviceUuid, fromTableId, toTableId) {
  await lockTable(baseUrl, session, deviceUuid, fromTableId, "table.move_source");
  await lockTable(baseUrl, session, deviceUuid, toTableId, "table.move_target");
  return api(baseUrl, session, deviceUuid, "POST", "/api/integration/layout/table/move", {
    fromTableId,
    toTableId,
  });
}

async function syncTable(baseUrl, session, deviceUuid, body) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/integration/layout/table/sync", body);
}

async function saveGroups(baseUrl, session, deviceUuid, groups, options = {}) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/integration/table-groups/save", {
    groups,
    operation: options.operation,
  });
}

async function printOrder(baseUrl, session, deviceUuid, kind, orderId) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/integration/print", { kind, orderId }, 202);
}

async function upsertStationState(baseUrl, session, deviceUuid, extra = {}) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/integration/stations/state", {
    token: session.token,
    userId: session.user.id,
    deviceUuid,
    clientApp: "postazione",
    station: "BAR PRINCIPALE",
    active: true,
    autoPrintOrders: false,
    autoPrintPreconto: false,
    operatorUserId: session.user.id,
    operatorUsername: session.user.username,
    operatorName: session.user.fullName,
    operatorRole: session.user.roleLabel,
    ...extra,
  });
}

async function postazioneAction(baseUrl, session, deviceUuid, payload, expectedStatus = 200) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/actions", payload, expectedStatus);
}

async function reservationCreate(baseUrl, session, deviceUuid, payload, expectedStatus = 200) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/pos/reservations/create", payload, expectedStatus);
}

async function reservationList(baseUrl, session, deviceUuid, payload, expectedStatus = 200) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/pos/reservations/list", payload, expectedStatus);
}

async function reservationAvailability(baseUrl, session, deviceUuid, payload, expectedStatus = 200) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/pos/reservations/availability", payload, expectedStatus);
}

async function reservationLockAcquire(baseUrl, session, deviceUuid, payload, expectedStatus = 200) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/pos/reservations/lock/acquire", payload, expectedStatus);
}

async function reservationUpdate(baseUrl, session, deviceUuid, payload, expectedStatus = 200) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/pos/reservations/update", payload, expectedStatus);
}

async function reservationDelete(baseUrl, session, deviceUuid, payload, expectedStatus = 200) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/pos/reservations/delete", payload, expectedStatus);
}

async function correctOrder(baseUrl, session, deviceUuid, payload, expectedStatus = 200) {
  await lockTable(baseUrl, session, deviceUuid, payload.tableId, "order.correction");
  return api(baseUrl, session, deviceUuid, "POST", "/api/integration/orders/correct", payload, expectedStatus);
}

async function cancelOrder(baseUrl, session, deviceUuid, payload, expectedStatus = 200) {
  await lockTable(baseUrl, session, deviceUuid, payload.tableId, "order.cancel");
  return api(baseUrl, session, deviceUuid, "POST", "/api/integration/orders/cancel", payload, expectedStatus);
}

async function cleanupContinuityRuntimeDb(dbPath) {
  const db = await readDb(dbPath);
  const now = new Date().toISOString();
  if (db.integration && typeof db.integration === "object") {
    db.integration.orders = [];
    db.integration.notifications = [];
    db.integration.tableGroups = [];
    db.integration.itemAvailability = {};
    db.integration.recentBellClaims = [];
    db.integration.orderComps = [];
    db.integration.orderCorrections = [];
    db.integration.orderCorrectionRequests = [];
    db.integration.lastWriteAt = now;
  }
  db.paymentContainers = [];
  db.payments = [];
  db.printSpoolJobs = [];
  db.tableLocks = [];
  db.posReservationLocks = [];
  db.posReservations = [];
  db.posReservationStates = [];
  if (db.posSettings && Array.isArray(db.posSettings.tables)) {
    db.posSettings.tables = db.posSettings.tables.map((table) => ({
      ...table,
      status: "free",
      occupancyState: "free",
      guestName: "",
      customerPhone: "",
      covers: 0,
      totalDue: 0,
      pendingBills: [],
      reservation: null,
      note: "",
      allergens: [],
      manualIntolerance: "",
    }));
  }
  db.meta = { ...(db.meta ?? {}), lastWriteAt: now };
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  return db;
}

function findOrder(db, orderId) {
  const order = db.integration.orders.find((entry) => String(entry.id) === String(orderId));
  assert.ok(order, `order ${orderId} should exist`);
  return order;
}

function findTable(db, tableId) {
  const table = db.posSettings.tables.find((entry) => entry.id === tableId);
  assert.ok(table, `table ${tableId} should exist`);
  return table;
}

function latestJobFor(db, orderId, kind) {
  const jobs = db.printSpoolJobs.filter((job) => job.orderId === orderId && (!kind || job.kind === kind));
  assert.ok(jobs.length > 0, `expected print job for order ${orderId} kind ${kind}`);
  return jobs.at(-1);
}

test("continuity e2e battery across table, order, apericena, split payment and print flows", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  let mobile = await login(baseUrl, "giada", "2222", "giada-mobile", "mobile-frontend");
  const annaMobile = await login(baseUrl, "anna", "1234", "anna-mobile", "mobile-frontend");
  const station = await login(baseUrl, "postazione", "3333", "station-main", "postazione");
  const admin = await login(baseUrl, "admin_test", "1111", "admin-device", "cassa");
  await selectWorkstation(baseUrl, station, "station-main", "BAR PRINCIPALE");
  await upsertStationState(baseUrl, station, "station-main");

  await t.test("01 menu catalog has premium drinks, apericena prices and no removed premium aliases", async () => {
    const menu = await publicApi(baseUrl, "/api/integration/menu");
    const products = [...(menu.products ?? []), ...(menu.postazioneItems ?? [])];
    const byName = new Map(products.map((item) => [String(item.name).toLowerCase(), item]));
    assert.equal(byName.get("bloody mary")?.price, 8);
    assert.equal(byName.get("latte macchiato")?.price, 1.5);
    assert.equal(byName.get("gin mare")?.price, 12);
    assert.equal(byName.get("grey goose")?.price, 12);
    assert.equal(byName.get("absolut")?.price, 10);
    assert.equal(byName.get("skyy")?.price, 10);
    assert.equal(byName.has("gin lemon premium"), false);
    assert.equal(byName.has("gin tonic premium"), false);
    for (const name of ["gin mare", "grey goose", "absolut", "skyy"]) {
      const item = byName.get(name);
      assert.equal(item.variantRequired, true, name);
      assert.deepEqual(item.variants.map((variant) => variant.name), ["Liscio", "Lemon", "Tonic", "Fizz"]);
    }
  });

  await t.test("02 weird characters order is visible to postazione without mojibake", async () => {
    const body = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t01",
      roomId: "room_pedana",
      tableNumber: 1,
      note: "Senza glutine, caffe macchiato, prezzo EUR, Sofia & Leo <ok>",
      communications: "Compleanno: non urlare il nome.",
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary", note: "Poco ghiaccio / no tabasco" })],
    });
    const orders = await publicApi(
      baseUrl,
      `/api/integration/orders?station=BAR%20PRINCIPALE&includeDone=1&operatorUserId=${encodeURIComponent(station.user.id)}&deviceUuid=station-main`
    );
    const visible = orders.orders.find((order) => order.id === body.order.id);
    assert.ok(visible);
    assert.doesNotMatch(JSON.stringify(visible), /Ã|Â|�/);
    const { db, printKinds } = await waitForPrintKinds(dbPath, body.order.id, ["order", "preconto"]);
    assert.equal(findTable(db, "room_pedana_t01").covers, 2);
    assert.ok(printKinds.includes("order"), "new mobile order should auto-print the comanda");
    assert.ok(printKinds.includes("preconto"), "new mobile order should auto-print the preconto with the comanda");
  });

  await t.test("03 ready order auto-delivers, becomes payable, cash mobile payment closes it and prints receipt", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t02",
      roomId: "room_pedana",
      tableNumber: 2,
      lines: [line("Americano", 8, 1, { productId: "menu_drink_americano" })],
    });
    const ready = await readyOrder(baseUrl, station, "station-main", created.order.id);
    assert.equal(ready.order.workflowStatus, "delivered");
    const paid = await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t02", "room_pedana", created.order.id, 8, {
      idempotencyKey: "scenario-03-pay",
    });
    assert.equal(paid.payment.status, "COMPLETED");
    assert.ok((paid.paymentReceiptJobs ?? []).length >= 1);
    const db = await readDb(dbPath);
    assert.equal(findOrder(db, created.order.id).paymentStatus, "paid");
    assert.equal(findTable(db, "room_pedana_t02").totalDue, 0);
    const receipt = db.printSpoolJobs.find((job) => job.id === paid.paymentReceiptJobs[0].id);
    assert.match(receipt.textPreview, /PAGAMENTO CONTANTI/);
    assert.ok(paid.transactions?.[0]?.id);
    assert.match(receipt.textPreview, /ID TX/);
    assert.match(receipt.textPreview, new RegExp(escapeRegExp(paid.transactions[0].id.toUpperCase())));
  });

  await t.test("04 preparation order cannot be paid until station marks it ready", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t03",
      roomId: "room_pedana",
      tableNumber: 3,
      lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
    });
    await syncOrder(baseUrl, station, "station-main", created.order.id, { workflowStatus: "prep" });
    const denied = await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t03", "room_pedana", created.order.id, 1.6, {
      expectedStatus: 409,
      idempotencyKey: "scenario-04-denied",
    });
    assert.equal(denied.code, "ORDER_NOT_PAYABLE");
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    const paid = await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t03", "room_pedana", created.order.id, 1.6, {
      idempotencyKey: "scenario-04-paid",
    });
    assert.equal(paid.payment.status, "COMPLETED");
  });

  await t.test("05 moving a simple open table updates digital order and manual reprints", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t04",
      roomId: "room_pedana",
      tableNumber: 4,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    const moved = await moveTable(baseUrl, mobile, "giada-mobile", "room_pedana_t04", "sala_terrazza_t01");
    assert.equal(moved.movedOrdersCount, 1);
    const orderPrint = await printOrder(baseUrl, mobile, "giada-mobile", "order", created.order.id);
    const precontoPrint = await printOrder(baseUrl, mobile, "giada-mobile", "preconto", created.order.id);
    const db = await readDb(dbPath);
    const movedOrder = findOrder(db, created.order.id);
    assert.equal(movedOrder.tableId, "sala_terrazza_t01");
    assert.equal(movedOrder.roomId, "sala_terrazza");
    assert.match(latestJobFor(db, created.order.id, "order").textPreview, /TAV\. 1/);
    assert.match(latestJobFor(db, created.order.id, "preconto").textPreview, /Tavolo 1|TAV\. ?1/i);
    assert.match(orderPrint.jobId, /^print_/);
    assert.match(precontoPrint.jobId, /^print_/);
  });

  await t.test("06 merge and split after an order keep manual print labels current", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      tableNumber: 5,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    const merged = await saveGroups(baseUrl, mobile, "giada-mobile", [
      { id: "room_pedana_t05", type: "complex", children: [{ id: "room_pedana_t05", type: "simple" }, { id: "room_pedana_t06", type: "simple" }] },
    ], { operation: "merge" });
    assert.ok(merged.printJobs.length >= 1);
    assert.ok(merged.printJobs[0].updatePrintJobId);
    assert.ok(merged.printJobs[0].orderPrintJobId);
    assert.ok(merged.printJobs[0].precontoPrintJobId);
    let db = await readDb(dbPath);
    assert.match(latestJobFor(db, created.order.id, "table_update").textPreview, /UNIONE TAVOLI/);
    assert.match(latestJobFor(db, created.order.id, "order").textPreview, /TAV\. 5\/6/);
    await printOrder(baseUrl, mobile, "giada-mobile", "order", created.order.id);
    db = await readDb(dbPath);
    assert.match(latestJobFor(db, created.order.id, "order").textPreview, /TAV\. 5\/6/);
    const split = await saveGroups(baseUrl, mobile, "giada-mobile", [], { operation: "split" });
    assert.ok(split.printJobs.length >= 1);
    assert.ok(split.printJobs[0].updatePrintJobId);
    assert.ok(split.printJobs[0].orderPrintJobId);
    assert.ok(split.printJobs[0].precontoPrintJobId);
    db = await readDb(dbPath);
    assert.match(latestJobFor(db, created.order.id, "table_update").textPreview, /DISTACCO TAVOLI/);
    assert.match(latestJobFor(db, created.order.id, "order").textPreview, /TAV\. 5/);
    await printOrder(baseUrl, mobile, "giada-mobile", "order", created.order.id);
    db = await readDb(dbPath);
    assert.match(latestJobFor(db, created.order.id, "order").textPreview, /TAV\. 5/);
    assert.doesNotMatch(latestJobFor(db, created.order.id, "order").textPreview, /TAV\. 5\/6/);
  });

  await t.test("06b correction from a merged table root can modify an order on a linked child table", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t06",
      roomId: "room_pedana",
      tableNumber: 6,
      lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
    });
    await saveGroups(baseUrl, mobile, "giada-mobile", [
      { id: "room_pedana_t05", type: "complex", children: [{ id: "room_pedana_t05", type: "simple" }, { id: "room_pedana_t06", type: "simple" }] },
    ]);
    const corrected = await correctOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      tableLabel: "5/6",
      orderId: created.order.id,
      expectedRevision: 1,
      changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2 }],
      reason: "Modifica da tavolo unito",
      idempotencyKey: "scenario-06b-linked-table-correction",
    });
    assert.equal(corrected.order.tableId, "room_pedana_t06");
    assert.equal(corrected.order.total, 3.2);
    assert.equal(corrected.correction.tableLabel, "5/6");
    assert.equal(corrected.correction.changedItems[0].nextQuantity, 2);
    await saveGroups(baseUrl, mobile, "giada-mobile", []);
  });

  await t.test("07 complex table can move to another room and become a new complex table", async () => {
    await saveGroups(baseUrl, mobile, "giada-mobile", [
      { id: "room_pedana_t07", type: "complex", children: [{ id: "room_pedana_t07", type: "simple" }, { id: "room_pedana_t08", type: "simple" }] },
    ]);
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t07",
      roomId: "room_pedana",
      tableNumber: 7,
      lines: [line("Apericena", 12, 2, { productId: "menu_apericena_standard" })],
      apericena: 2,
      total: 24,
    });
    await moveTable(baseUrl, mobile, "giada-mobile", "room_pedana_t07", "sala_terrazza_t02");
    await saveGroups(baseUrl, mobile, "giada-mobile", [
      { id: "sala_terrazza_t02", type: "complex", children: [{ id: "sala_terrazza_t02", type: "simple" }, { id: "sala_terrazza_t03", type: "simple" }] },
    ]);
    const orders = await publicApi(baseUrl, `/api/integration/orders?includeDone=1`);
    const visible = orders.orders.find((order) => order.id === created.order.id);
    assert.equal(visible.tableId, "sala_terrazza_t02");
    assert.equal(visible.tableLabel, "2/3");
    await printOrder(baseUrl, mobile, "giada-mobile", "order", created.order.id);
    const db = await readDb(dbPath);
    assert.match(latestJobFor(db, created.order.id, "order").textPreview, /TAV\. 2\/3/);
  });

  await t.test("07b moved order can be corrected from the new room and keeps labels/due coherent", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t04",
      roomId: "room_sala",
      tableNumber: 4,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
    });
    const moved = await moveTable(baseUrl, mobile, "giada-mobile", "room_sala_t04", "sala_terrazza_t04");
    assert.equal(moved.movedOrdersCount, 1);
    const corrected = await correctOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t04",
      roomId: "sala_terrazza",
      orderId: created.order.id,
      expectedRevision: 1,
      changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2 }],
      reason: "Modifica dopo cambio sala",
      idempotencyKey: "scenario-07b-move-room-correction",
    });
    assert.equal(corrected.order.tableId, "sala_terrazza_t04");
    assert.equal(corrected.order.roomId, "sala_terrazza");
    assert.equal(corrected.order.total, 16);
    assert.equal(corrected.order.dueAmount, 16);
    assert.equal(corrected.correction.tableLabel, "4");
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t04", "sala_terrazza", created.order.id, 16, {
      idempotencyKey: "scenario-07b-close-after-correction",
    });
    const db = await readDb(dbPath);
    assert.equal(findOrder(db, created.order.id).paymentStatus, "paid");
    assert.equal(findTable(db, "room_sala_t04").totalDue, 0);
    assert.equal(findTable(db, "sala_terrazza_t04").totalDue, 0);
  });

  await t.test("08 partial free split keeps the order partial then a second split closes it", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t09",
      roomId: "room_pedana",
      tableNumber: 9,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" }), line("Americano", 8, 1, { productId: "menu_drink_americano" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    const partialPayment = await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t09", "room_pedana", created.order.id, 7.5, {
      idempotencyKey: "scenario-08-partial",
      releaseTable: false,
    });
    assert.equal(partialPayment.table?.id, "room_pedana_t09");
    assert.equal(partialPayment.table?.amountDue, 8.5);
    let db = await readDb(dbPath);
    assert.equal(findOrder(db, created.order.id).paymentStatus, "partial");
    assert.equal(findOrder(db, created.order.id).dueAmount, 8.5);
    assert.equal(findTable(db, "room_pedana_t09").totalDue, 8.5);
    const finalPayment = await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t09", "room_pedana", created.order.id, 8.5, {
      idempotencyKey: "scenario-08-final",
    });
    assert.equal(finalPayment.table?.id, "room_pedana_t09");
    assert.equal(finalPayment.table?.amountDue, 0);
    db = await readDb(dbPath);
    assert.equal(findOrder(db, created.order.id).paymentStatus, "paid");
    assert.equal(findTable(db, "room_pedana_t09").totalDue, 0);
  });

  await t.test("09 article split pays one selected line and keeps the rest due", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t10",
      roomId: "room_pedana",
      tableNumber: 10,
      lines: [line("Caffe", 1.3, 2, { productId: "menu_caffetteria_caffe" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    let db = await readDb(dbPath);
    const bill = findTable(db, "room_pedana_t10").pendingBills[0];
    await lockTable(baseUrl, mobile, "giada-mobile", "room_pedana_t10", "payment.table");
    await api(baseUrl, mobile, "giada-mobile", "POST", "/api/payments/table", {
      tableId: "room_pedana_t10",
      roomId: "room_pedana",
      paymentMethodId: "pay_cash",
      splitMode: "article",
      lineSelections: [{ billId: bill.id, lineIndex: 0, qty: 1 }],
      cashGiven: 1.3,
      idempotencyKey: "scenario-09-line",
    });
    db = await readDb(dbPath);
    assert.equal(findOrder(db, created.order.id).paymentStatus, "partial");
    assert.equal(findOrder(db, created.order.id).dueAmount, 1.3);
    assert.deepEqual(findOrder(db, created.order.id).paidArticleUnits, [`${created.order.id}_0_0`]);
    const articlePayment = db.paymentContainers.find((payment) => payment.idempotencyKey === "scenario-09-line");
    assert.equal(articlePayment?.splitMode, "article");
    assert.deepEqual(articlePayment?.articleUnitIds, [`${created.order.id}_0_0`]);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t10", "room_pedana", created.order.id, 1.3, {
      idempotencyKey: "scenario-09-final",
    });
    db = await readDb(dbPath);
    assert.equal(findOrder(db, created.order.id).paymentStatus, "paid");
  });

  await t.test("09b mobile article split keeps remaining items visible after every payment", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t12",
      roomId: "room_pedana",
      tableNumber: 12,
      lines: [
        line("Caffe", 1.3, 2, { productId: "menu_caffetteria_caffe" }),
        line("Americano", 8, 1, { productId: "menu_drink_americano" }),
      ],
    });
    const orderId = created.order.id;
    await readyOrder(baseUrl, station, "station-main", orderId);

    const remainingLineNames = async () => {
      const db = await readDb(dbPath);
      return findTable(db, "room_pedana_t12").pendingBills.flatMap((bill) =>
        bill.lines.map((entry) => `${entry.name}:${entry.qty}:${entry.lineTotal}`)
      );
    };
    const assertNoResidualOnly = async () => {
      const lines = await remainingLineNames();
      assert.ok(lines.length > 0, "remaining article list should not be empty while an amount is still due");
      assert.equal(lines.some((entry) => entry.startsWith("Residuo comanda")), false);
      return lines;
    };

    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t12", "room_pedana", orderId, 1.3, {
      idempotencyKey: "scenario-09b-caffe-1",
      releaseTable: false,
      articleUnitIds: [`${orderId}_0_0`],
    });
    let db = await readDb(dbPath);
    let order = findOrder(db, orderId);
    assert.equal(order.paymentStatus, "partial");
    assert.deepEqual(order.paidArticleUnits, [`${orderId}_0_0`]);
    let lines = await assertNoResidualOnly();
    assert.ok(lines.includes("Caffe:1:1.3"));
    assert.ok(lines.includes("Americano:1:8"));

    const layoutAfterFirstPayment = await publicApi(baseUrl, "/api/integration/layout");
    const layoutTable = layoutAfterFirstPayment.tables.find((entry) => entry.id === "room_pedana_t12");
    assert.ok(layoutTable, "layout should expose table 12");
    const layoutLines = layoutTable.pendingBills.flatMap((bill) => bill.lines.map((entry) => `${entry.name}:${entry.qty}`));
    assert.ok(layoutLines.includes("Caffe:1"));
    assert.ok(layoutLines.includes("Americano:1"));

    const currentPreconto = await api(baseUrl, mobile, "giada-mobile", "POST", "/api/integration/print", {
      kind: "preconto",
      tablePreconto: true,
      tablePrecontoMode: "current",
      tableId: "room_pedana_t12",
      roomId: "room_pedana",
      tableNumber: 12,
      tableLabel: "12",
      orderIds: [orderId],
      ignoreWorkstationRouting: true,
      clientApp: "mobile-table-preconto-test",
    }, 202);
    assert.match(currentPreconto.jobId, /^print_/);
    db = await readDb(dbPath);
    const currentPrecontoText = latestJobFor(db, "preconto_tavolo_room_pedana_t12", "preconto").textPreview;
    assert.match(currentPrecontoText, /Caffe/);
    assert.match(currentPrecontoText, /Americano/);
    assert.match(currentPrecontoText, /9,30|9\.30/);
    assert.doesNotMatch(currentPrecontoText, /10,60|10\.60/);
    assert.doesNotMatch(currentPrecontoText, /GIA'? PAGATO/i);
    assert.equal((currentPrecontoText.match(/Caffe/g) ?? []).length, 1);

    const completePreconto = await api(baseUrl, mobile, "giada-mobile", "POST", "/api/integration/print", {
      kind: "preconto",
      tablePreconto: true,
      tablePrecontoMode: "complete",
      tableId: "room_pedana_t12",
      roomId: "room_pedana",
      tableNumber: 12,
      tableLabel: "12",
      orderIds: [orderId],
      ignoreWorkstationRouting: true,
      clientApp: "mobile-table-preconto-test",
    }, 202);
    assert.match(completePreconto.jobId, /^print_/);
    db = await readDb(dbPath);
    const completePrecontoText = latestJobFor(db, "preconto_tavolo_room_pedana_t12", "preconto").textPreview;
    assert.match(completePrecontoText, /10,60|10\.60/);

    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t12", "room_pedana", orderId, 8, {
      idempotencyKey: "scenario-09b-americano",
      releaseTable: false,
      articleUnitIds: [`${orderId}_1_0`],
    });
    db = await readDb(dbPath);
    order = findOrder(db, orderId);
    assert.equal(order.paymentStatus, "partial");
    assert.deepEqual(order.paidArticleUnits.sort(), [`${orderId}_0_0`, `${orderId}_1_0`].sort());
    lines = await assertNoResidualOnly();
    assert.deepEqual(lines, ["Caffe:1:1.3"]);

    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t12", "room_pedana", orderId, 1.3, {
      idempotencyKey: "scenario-09b-caffe-2",
      releaseTable: false,
      articleUnitIds: [`${orderId}_0_1`],
    });
    db = await readDb(dbPath);
    order = findOrder(db, orderId);
    assert.equal(order.paymentStatus, "paid");
    assert.deepEqual(findTable(db, "room_pedana_t12").pendingBills, []);
  });

  await t.test("09c table-level article split pays the order owning the selected unit", async () => {
    const first = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t20",
      roomId: "room_pedana",
      tableNumber: 20,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    const second = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t20",
      roomId: "room_pedana",
      tableNumber: 20,
      lines: [
        line("Americano", 8, 1, { productId: "menu_drink_americano" }),
        line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" }),
      ],
    });
    await readyOrder(baseUrl, station, "station-main", first.order.id);
    await readyOrder(baseUrl, station, "station-main", second.order.id);

    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t20", "room_pedana", undefined, 8, {
      idempotencyKey: "scenario-09c-second-order-article",
      releaseTable: false,
      articleUnitIds: [`${second.order.id}_0_0`],
    });

    const db = await readDb(dbPath);
    const firstOrder = findOrder(db, first.order.id);
    const secondOrder = findOrder(db, second.order.id);
    assert.equal(firstOrder.paymentStatus, "unpaid");
    assert.equal(firstOrder.dueAmount, 1.3);
    assert.equal(secondOrder.paymentStatus, "partial");
    assert.equal(secondOrder.dueAmount, 1.6);
    assert.deepEqual(secondOrder.paidArticleUnits, [`${second.order.id}_0_0`]);

    const lines = findTable(db, "room_pedana_t20").pendingBills.flatMap((bill) =>
      bill.lines.map((entry) => `${bill.orderId}:${entry.name}:${entry.qty}:${entry.lineTotal}`)
    );
    assert.ok(lines.includes(`${first.order.id}:Caffe:1:1.3`));
    assert.ok(lines.includes(`${second.order.id}:Cappuccino:1:1.6`));
    assert.equal(lines.some((entry) => entry.includes("Residuo comanda")), false);

    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t20", "room_pedana", first.order.id, 1.3, {
      idempotencyKey: "scenario-09c-cleanup-first",
      releaseTable: false,
    });
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t20", "room_pedana", second.order.id, 1.6, {
      idempotencyKey: "scenario-09c-cleanup-second",
    });
  });

  await t.test("09d amount or roman partial payment locks article split for the remaining due", async () => {
    const tableId = "sala_terrazza_t04";
    const roomId = "sala_terrazza";
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId,
      roomId,
      tableNumber: 4,
      lines: [
        line("Caffe", 1.3, 2, { productId: "menu_caffetteria_caffe" }),
        line("Americano", 8, 1, { productId: "menu_drink_americano" }),
      ],
    });
    const orderId = created.order.id;
    await readyOrder(baseUrl, station, "station-main", orderId);

    const started = await payFreeSplit(baseUrl, mobile, "giada-mobile", tableId, roomId, orderId, 4, {
      idempotencyKey: "scenario-09d-start-amount",
      releaseTable: false,
      splitMode: "amount",
    });
    assert.equal(started.table?.paymentArticleSplitLocked, true);
    assert.equal(started.table?.paymentFlowMode, "amount");

    const lockedLayout = await publicApi(baseUrl, "/api/integration/layout");
    const lockedTable = lockedLayout.tables.find((entry) => entry.id === tableId);
    assert.equal(lockedTable?.paymentArticleSplitLocked, true);
    assert.equal(lockedTable?.paymentFlowMode, "amount");

    const rejected = await payFreeSplit(baseUrl, mobile, "giada-mobile", tableId, roomId, orderId, 1.3, {
      idempotencyKey: "scenario-09d-reject-article",
      releaseTable: false,
      articleUnitIds: [`${orderId}_0_0`],
      expectedStatus: 409,
    });
    assert.equal(rejected.code, "PAYMENT_ARTICLE_SPLIT_LOCKED");

    await payFreeSplit(baseUrl, mobile, "giada-mobile", tableId, roomId, orderId, 6.6, {
      idempotencyKey: "scenario-09d-finish-single",
      splitType: "SINGLE",
      splitMode: "single",
    });

    const db = await readDb(dbPath);
    assert.equal(findOrder(db, orderId).paymentStatus, "paid");
    assert.equal(findTable(db, tableId).totalDue, 0);
  });

  await t.test("10 bill split pays one order on a shared table and leaves the other payable", async () => {
    const first = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t11",
      roomId: "room_pedana",
      tableNumber: 11,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    const second = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t11",
      roomId: "room_pedana",
      tableNumber: 11,
      lines: [line("Latte Macchiato", 1.5, 1, { productId: "menu_caffetteria_latte_macchiato" })],
    });
    await readyOrder(baseUrl, station, "station-main", first.order.id);
    await readyOrder(baseUrl, station, "station-main", second.order.id);
    let db = await readDb(dbPath);
    const firstBill = findTable(db, "room_pedana_t11").pendingBills.find((bill) => bill.orderId === first.order.id);
    assert.ok(firstBill);
    await lockTable(baseUrl, mobile, "giada-mobile", "room_pedana_t11", "payment.table");
    await api(baseUrl, mobile, "giada-mobile", "POST", "/api/payments/table", {
      tableId: "room_pedana_t11",
      roomId: "room_pedana",
      paymentMethodId: "pay_cash",
      billIds: [firstBill.id],
      cashGiven: 1.3,
      idempotencyKey: "scenario-10-first-bill",
    });
    db = await readDb(dbPath);
    assert.equal(findOrder(db, first.order.id).paymentStatus, "paid");
    assert.equal(findOrder(db, second.order.id).paymentStatus, "unpaid");
    assert.equal(findTable(db, "room_pedana_t11").totalDue, 1.5);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t11", "room_pedana", second.order.id, 1.5, {
      idempotencyKey: "scenario-10-second",
    });
  });

  await t.test("11 waiting correction updates notes, covers and apericena without item changes", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t12",
      roomId: "room_pedana",
      tableNumber: 12,
      covers: 2,
      apericena: 1,
      total: 13.3,
      note: "vecchia nota",
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    const corrected = await correctOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t12",
      roomId: "room_pedana",
      orderId: created.order.id,
      expectedRevision: 1,
      note: "nota aggiornata leggibile",
      communications: "portare tutto insieme",
      covers: 3,
      apericena: 2,
      reason: "Cambio coperti",
      idempotencyKey: "scenario-11-correction",
    });
    assert.equal(corrected.order.covers, 3);
    assert.equal(corrected.order.apericena, 2);
    assert.equal(corrected.order.note, "nota aggiornata leggibile");
    assert.equal(corrected.order.communications, "portare tutto insieme");
    assert.equal(corrected.order.total, 25.3);
  });

  await t.test("12 removing inline apericena updates apericena count and total", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t13",
      roomId: "room_pedana",
      tableNumber: 13,
      apericena: 2,
      total: 24,
      lines: [line("Apericena", 12, 2, { productId: "menu_apericena_standard" })],
    });
    const corrected = await correctOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t13",
      roomId: "room_pedana",
      orderId: created.order.id,
      expectedRevision: 1,
      removedItems: [{ lineId: created.order.items[0].lineId, quantity: 1 }],
      reason: "Un apericena in meno",
      idempotencyKey: "scenario-12-remove-apericena",
    });
    assert.equal(corrected.order.apericena, 1);
    assert.equal(corrected.order.total, 12);
    assert.equal(corrected.correction.removedItems[0].productName, "Apericena");
  });

  await t.test("13 preparation correction applies directly and prints modification plus updated preconto", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t14",
      roomId: "room_pedana",
      tableNumber: 14,
      lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
    });
    const prepped = await syncOrder(baseUrl, station, "station-main", created.order.id, { workflowStatus: "prep" });
    const corrected = await correctOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t14",
      roomId: "room_pedana",
      orderId: created.order.id,
      expectedRevision: prepped.order.currentRevision ?? prepped.order.revision ?? 1,
      changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2 }],
      reason: "Aggiunta in preparazione",
      idempotencyKey: "scenario-13-prep-correction",
    });
    assert.equal(corrected.order.revision, 3);
    assert.equal(corrected.correction.statusAtCorrection, "prep");
    assert.match(corrected.printJob.id, /^print_/);
    assert.match(corrected.precontoPrintJob.id, /^print_/);
    const db = await readDb(dbPath);
    assert.match(latestJobFor(db, created.order.id, "order_correction").textPreview, /MODIFICA COMANDA/);
  });

  await t.test("13b correction variants, supplements and added catalog items keep final prices", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t02",
      roomId: "room_pedana",
      tableNumber: 2,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    const corrected = await correctOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t02",
      roomId: "room_pedana",
      orderId: created.order.id,
      expectedRevision: 1,
      changedItems: [
        {
          lineId: created.order.items[0].lineId,
          nextQuantity: 1,
          nextVariant: "Sour",
          nextModifiers: { Variante: "Sour", Supplemento: "Menu Apericena" },
          nextUnitPrice: 12,
        },
      ],
      addedItems: [
        {
          productId: "menu_drink_premium_mare",
          quantity: 1,
          unitPrice: 12,
          modifiers: { Variante: "Tonic" },
          note: "poco ghiaccio",
        },
      ],
      reason: "Varianti da modifica mobile",
      idempotencyKey: "scenario-13b-variant-dropdown-correction",
    });
    assert.equal(corrected.order.total, 24);
    const changedLine = corrected.order.items.find((item) => item.lineId === created.order.items[0].lineId);
    assert.equal(changedLine.unitPriceApplied, 12);
    assert.equal(changedLine.variant, "Sour");
    assert.equal(changedLine.variants.Supplemento, "Menu Apericena");
    const addedLine = corrected.order.items.find((item) => item.productId === "menu_drink_premium_mare");
    assert.equal(addedLine.productNameSnapshot, "Gin Mare");
    assert.equal(addedLine.unitPriceApplied, 12);
    assert.equal(addedLine.variant, "Tonic");
  });

  await t.test("13c correction finds order with numeric hash id alias", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t05",
      roomId: "sala_terrazza",
      tableNumber: 5,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
    });
    const numericAlias = String(created.order.id).replace(/^0+/, "") || created.order.id;
    const corrected = await correctOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t05",
      roomId: "sala_terrazza",
      orderId: `#${numericAlias}`,
      expectedRevision: 1,
      changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2 }],
      reason: "Alias id comanda",
      idempotencyKey: "scenario-13c-alias-correction",
    });
    assert.equal(corrected.order.id, created.order.id);
    assert.equal(corrected.order.items.filter((item) => item.lineId === created.order.items[0].lineId).length, 2);
  });

  await t.test("14 checkbox-prepared units stay prepared when quantity increases", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t15",
      roomId: "room_pedana",
      tableNumber: 15,
      lines: [line("Caffe", 1.3, 2, { productId: "menu_caffetteria_caffe" })],
    });
    const items = created.order.items.map((item, index) => ({ ...item, done: index === 0, doneQty: index === 0 ? 1 : 0 }));
    const synced = await syncOrder(baseUrl, station, "station-main", created.order.id, { workflowStatus: "waiting", items });
    const corrected = await correctOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t15",
      roomId: "room_pedana",
      orderId: created.order.id,
      expectedRevision: synced.order.currentRevision ?? synced.order.revision ?? 1,
      changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 3 }],
      reason: "Aggiunto caffe",
      idempotencyKey: "scenario-14-checkbox",
    });
    const lineItems = corrected.order.items.filter((item) => item.lineId === created.order.items[0].lineId);
    assert.equal(lineItems.length, 3);
    assert.equal(lineItems.filter((item) => item.done === true).length, 1);
    assert.equal(corrected.correction.changedItems[0].previousPreparedQuantity, 1);
    assert.equal(corrected.correction.changedItems[0].nextPreparedQuantity, 1);
  });

  await t.test("15 ready unpaid order allows modification and abbuono then remaining payment", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t16",
      roomId: "room_pedana",
      tableNumber: 16,
      lines: [line("Bloody Mary", 8, 3, { productId: "menu_drink_bloody_mary" })],
    });
    const ready = await readyOrder(baseUrl, station, "station-main", created.order.id);
    const corrected = await correctOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t16",
      roomId: "room_pedana",
      orderId: created.order.id,
      expectedRevision: ready.order.currentRevision ?? ready.order.revision ?? 1,
      removedItems: [{ lineId: created.order.items[0].lineId, quantity: 1 }],
      reason: "Rimosso drink prima del pagamento",
      idempotencyKey: "scenario-15-ready-correction",
    });
    assert.equal(corrected.order.workflowStatus, "delivered");
    assert.equal(corrected.order.paymentStatus, "unpaid");
    assert.equal(corrected.order.dueAmount, 16);
    const listed = await api(
      baseUrl,
      mobile,
      "giada-mobile",
      "GET",
      "/api/integration/orders?includeDone=1&includeTransferred=1&currentSessionOnly=1"
    );
    const listedOrder = listed.orders.find((order) => order.id === created.order.id);
    assert.equal(listedOrder.canCorrectOrder, true);
    assert.equal(listedOrder.correctionBlockedReason, null);
    const cancelRejected = await cancelOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t16",
      roomId: "room_pedana",
      orderId: created.order.id,
      expectedRevision: corrected.order.currentRevision,
      reason: "Tentativo annullo dopo pronta",
      idempotencyKey: "scenario-15-cancel-delivered",
    }, 409);
    assert.equal(cancelRejected.code, "ORDER_CANCEL_NOT_ALLOWED");
    await lockTable(baseUrl, mobile, "giada-mobile", "room_pedana_t16", "order.comp");
    const comped = await api(baseUrl, mobile, "giada-mobile", "POST", "/api/integration/orders/comp", {
      tableId: "room_pedana_t16",
      roomId: "room_pedana",
      orderId: created.order.id,
      originalLineId: created.order.items[0].lineId,
      quantity: 1,
      reason: "Errore servizio",
      idempotencyKey: "scenario-15-comp",
	    });
	    assert.equal(comped.comp.amount, 8);
	    assert.equal(comped.order.total, 8);
	    assert.equal(comped.order.paidAmount, 0);
	    assert.equal(comped.order.dueAmount, 8);
	    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t16", "room_pedana", created.order.id, 8, {
	      idempotencyKey: "scenario-15-pay",
    });
  });

  await t.test("16 paid order rejects later correction, but comp prints storno and duplicate payment stays blocked", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t17",
      roomId: "room_pedana",
      tableNumber: 17,
      lines: [line("Americano", 8, 1, { productId: "menu_drink_americano" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t17", "room_pedana", created.order.id, 8, {
      idempotencyKey: "scenario-16-pay",
    });
    const correction = await correctOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t17",
      roomId: "room_pedana",
      orderId: created.order.id,
      expectedRevision: 1,
      addedItems: [{ productId: "menu_caffetteria_caffe", quantity: 1 }],
      idempotencyKey: "scenario-16-correction",
    }, 409);
    assert.equal(correction.code, "ORDER_ALREADY_PAID");
	    await lockTable(baseUrl, mobile, "giada-mobile", "room_pedana_t17", "order.comp");
	    const comp = await api(baseUrl, mobile, "giada-mobile", "POST", "/api/integration/orders/comp", {
	      tableId: "room_pedana_t17",
      roomId: "room_pedana",
      orderId: created.order.id,
      originalLineId: created.order.items[0].lineId,
      quantity: 1,
	      reason: "Troppo tardi",
	      idempotencyKey: "scenario-16-comp",
	    });
	    assert.equal(comp.comp.amount, 8);
	    assert.equal(comp.order.total, 0);
	    assert.equal(comp.order.paidAmount, 0);
	    assert.equal(comp.order.dueAmount, 0);
	    assert.equal(comp.order.paymentStatus, "paid");
	    assert.match(comp.stornoPrintJob.id, /^print_/);
	    assert.equal(comp.comp.paymentReferences.length, 1);
	    assert.equal(comp.comp.paymentReferences[0].method, "CASH");
	    assert.equal(comp.comp.paymentReferences[0].action, "cash_refund");
	    assert.equal(comp.comp.refundPlan.mode, "single_payment");
	    assert.equal(comp.comp.refundPlan.amount, 8);
	    assert.equal(comp.comp.refundPlan.allocations[0].method, "CASH");
	    assert.equal(comp.comp.refundPlan.allocations[0].action, "cash_refund");
	    const db = await readDb(dbPath);
	    const stornoJob = db.printSpoolJobs.find((job) => job.id === comp.stornoPrintJob.id);
	    assert.ok(stornoJob, "paid comp should persist a storno print job");
	    assert.equal(stornoJob.kind, "payment_storno");
	    assert.match(stornoJob.textPreview, /STORNO PAGAMENTO/);
	    assert.match(stornoJob.textPreview, /PAGAMENTI DA STORNARE/);
	    assert.match(stornoJob.textPreview, /MODALITA/);
	    assert.match(stornoJob.textPreview, /RIMBORSO CONTANTI/);
	    assert.match(stornoJob.textPreview, /ID STORNO/);
	    const secondPayment = await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t17", "room_pedana", created.order.id, 8, {
	      idempotencyKey: "scenario-16-pay-again",
      expectedStatus: 409,
    });
	    assert.ok(["PAYMENT_NOT_PAYABLE", "ORDER_NOT_PAYABLE"].includes(secondPayment.code));
  });

  await t.test("16b article comp keeps a trace to the exact article payment transaction", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t20",
      roomId: "room_pedana",
      tableNumber: 20,
      lines: [
        line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" }),
        line("Americano", 8, 1, { productId: "menu_drink_americano" }),
      ],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    const americanoUnitId = `${created.order.id}_1_0`;
    const paid = await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t20", "room_pedana", created.order.id, 8, {
      idempotencyKey: "scenario-16b-article-pos",
      releaseTable: false,
      articleUnitIds: [americanoUnitId],
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "test-pos",
      posTxRef: "ARTICLE-REFUND-16B",
    });
    await lockTable(baseUrl, mobile, "giada-mobile", "room_pedana_t20", "order.comp");
    const comp = await api(baseUrl, mobile, "giada-mobile", "POST", "/api/integration/orders/comp", {
      tableId: "room_pedana_t20",
      roomId: "room_pedana",
      orderId: created.order.id,
      originalLineId: created.order.items[1].lineId,
      quantity: 1,
      reason: "Caduto",
      idempotencyKey: "scenario-16b-comp",
    });
    assert.equal(comp.order.total, 1.3);
    assert.equal(comp.order.paidAmount, 0);
    assert.equal(comp.order.dueAmount, 1.3);
    assert.equal(comp.comp.refundPlan.mode, "article_transaction");
    assert.equal(comp.comp.refundPlan.amount, 8);
    assert.deepEqual(comp.comp.refundPlan.articleUnitIds, [americanoUnitId]);
    const allocation = comp.comp.refundPlan.allocations[0];
    assert.equal(allocation.paymentId, paid.payment.id);
    assert.equal(allocation.method, "POS");
    assert.equal(allocation.action, "pos_void_full_transaction");
    assert.equal(allocation.voidAmount, 8);
    assert.equal(allocation.rechargeAmount, 0);
    assert.deepEqual(allocation.articleUnitIds, [americanoUnitId]);
    assert.ok(allocation.transactionIds.includes(paid.transactions[0].id));
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t20", "room_pedana", created.order.id, 1.3, {
      idempotencyKey: "scenario-16b-cleanup",
    });
  });

  await t.test("16c cash paid order comp records a cash refund and keeps net paid coherent", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t06",
      roomId: "sala_terrazza",
      tableNumber: 6,
      lines: [
        line("Prodotto 9", 9, 1, { productId: "test_cash_keep" }),
        line("Prodotto 12", 12, 1, { productId: "test_cash_refund" }),
      ],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t06", "sala_terrazza", created.order.id, 21, {
      idempotencyKey: "scenario-16c-cash-pay",
    });
    const comp = await compOrderLine(
      baseUrl,
      mobile,
      "giada-mobile",
      "sala_terrazza_t06",
      "sala_terrazza",
      created.order.id,
      created.order.items[1].lineId,
      { reason: "Reso cash", idempotencyKey: "scenario-16c-comp" }
    );
    assert.equal(comp.order.total, 9);
    assert.equal(comp.order.paidAmount, 9);
    assert.equal(comp.order.dueAmount, 0);
    assert.equal(comp.comp.refundPlan.mode, "single_payment");
    assert.equal(comp.comp.refundPlan.allocations[0].method, "CASH");
    assert.equal(comp.comp.refundPlan.allocations[0].action, "cash_refund");
    assert.equal(comp.comp.refundPlan.allocations[0].refundAmount, 12);
    assert.match(comp.stornoPrintJob.id, /^print_/);
  });

  await t.test("16d card paid order comp asks to void full POS transaction and recharge the remainder", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t07",
      roomId: "sala_terrazza",
      tableNumber: 7,
      lines: [
        line("Prodotto 9", 9, 1, { productId: "test_card_keep" }),
        line("Prodotto 12", 12, 1, { productId: "test_card_refund" }),
      ],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    const paid = await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t07", "sala_terrazza", created.order.id, 21, {
      idempotencyKey: "scenario-16d-card-pay",
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "test-pos",
      posTxRef: "SCENARIO-16D-POS",
    });
    const comp = await compOrderLine(
      baseUrl,
      mobile,
      "giada-mobile",
      "sala_terrazza_t07",
      "sala_terrazza",
      created.order.id,
      created.order.items[1].lineId,
      { reason: "Reso carta", idempotencyKey: "scenario-16d-comp" }
    );
    const allocation = comp.comp.refundPlan.allocations[0];
    assert.equal(comp.order.total, 9);
    assert.equal(comp.order.paidAmount, 9);
    assert.equal(allocation.paymentId, paid.payment.id);
    assert.equal(allocation.method, "POS");
    assert.equal(allocation.action, "pos_void_full_transaction_and_recharge_remaining");
    assert.equal(allocation.refundAmount, 12);
    assert.equal(allocation.voidAmount, 21);
    assert.equal(allocation.rechargeAmount, 9);
    assert.ok(allocation.transactionIds.includes(paid.transactions[0].id));
  });

  await t.test("16e roman paid comp splits the financial refund across the paid shares", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t08",
      roomId: "sala_terrazza",
      tableNumber: 8,
      lines: [
        line("Prodotto 9 A", 9, 1, { productId: "test_roman_keep_a" }),
        line("Prodotto 9 B", 9, 1, { productId: "test_roman_keep_b" }),
        line("Prodotto 12", 12, 1, { productId: "test_roman_refund" }),
      ],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t08", "sala_terrazza", created.order.id, 10, {
      splitMode: "roman",
      releaseTable: false,
      idempotencyKey: "scenario-16e-roman-pos-1",
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "test-pos",
      posTxRef: "SCENARIO-16E-POS-1",
    });
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t08", "sala_terrazza", created.order.id, 10, {
      splitMode: "roman",
      releaseTable: false,
      idempotencyKey: "scenario-16e-roman-pos-2",
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "test-pos",
      posTxRef: "SCENARIO-16E-POS-2",
    });
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t08", "sala_terrazza", created.order.id, 10, {
      splitMode: "roman",
      idempotencyKey: "scenario-16e-roman-cash-3",
    });
    const comp = await compOrderLine(
      baseUrl,
      mobile,
      "giada-mobile",
      "sala_terrazza_t08",
      "sala_terrazza",
      created.order.id,
      created.order.items[2].lineId,
      { reason: "Reso alla romana", idempotencyKey: "scenario-16e-comp" }
    );
    const allocations = comp.comp.refundPlan.allocations;
    assert.equal(comp.order.total, 18);
    assert.equal(comp.order.paidAmount, 18);
    assert.equal(comp.comp.refundPlan.mode, "roman_proportional");
    assert.deepEqual(allocations.map((allocation) => allocation.refundAmount), [4, 4, 4]);
    assert.deepEqual(allocations.map((allocation) => allocation.method), ["POS", "POS", "CASH"]);
    assert.equal(allocations[0].voidAmount, 10);
    assert.equal(allocations[0].rechargeAmount, 6);
    assert.equal(allocations[1].voidAmount, 10);
    assert.equal(allocations[1].rechargeAmount, 6);
    assert.equal(allocations[2].action, "cash_refund");
  });

  await t.test("16f article payment covering multiple items still traces the comped unit and recharges POS residual", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t09",
      roomId: "sala_terrazza",
      tableNumber: 9,
      lines: [
        line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" }),
        line("Americano", 8, 1, { productId: "menu_drink_americano" }),
        line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" }),
      ],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    const americanoUnitId = `${created.order.id}_1_0`;
    const bloodyUnitId = `${created.order.id}_2_0`;
    const paid = await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t09", "sala_terrazza", created.order.id, 16, {
      idempotencyKey: "scenario-16f-article-pos",
      releaseTable: false,
      articleUnitIds: [americanoUnitId, bloodyUnitId],
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "test-pos",
      posTxRef: "SCENARIO-16F-POS",
    });
    const comp = await compOrderLine(
      baseUrl,
      mobile,
      "giada-mobile",
      "sala_terrazza_t09",
      "sala_terrazza",
      created.order.id,
      created.order.items[1].lineId,
      { reason: "Reso articolo pagato con altro articolo", idempotencyKey: "scenario-16f-comp" }
    );
    const allocation = comp.comp.refundPlan.allocations[0];
    assert.equal(comp.order.total, 9.3);
    assert.equal(comp.order.paidAmount, 8);
    assert.equal(comp.order.dueAmount, 1.3);
    assert.equal(comp.comp.refundPlan.mode, "article_transaction");
    assert.equal(allocation.paymentId, paid.payment.id);
    assert.deepEqual(allocation.articleUnitIds, [americanoUnitId]);
    assert.equal(allocation.action, "pos_void_full_transaction_and_recharge_remaining");
    assert.equal(allocation.voidAmount, 16);
    assert.equal(allocation.rechargeAmount, 8);
    assert.ok(allocation.transactionIds.includes(paid.transactions[0].id));
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t09", "sala_terrazza", created.order.id, 1.3, {
      idempotencyKey: "scenario-16f-cleanup",
    });
  });

  await t.test("16g unpaid comp lowers due without creating a financial refund or storno print", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t10",
      roomId: "sala_terrazza",
      tableNumber: 10,
      lines: [
        line("Americano", 8, 1, { productId: "menu_drink_americano" }),
        line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" }),
      ],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    const comp = await compOrderLine(
      baseUrl,
      mobile,
      "giada-mobile",
      "sala_terrazza_t10",
      "sala_terrazza",
      created.order.id,
      created.order.items[0].lineId,
      { reason: "Reso prima del pagamento", idempotencyKey: "scenario-16g-comp" }
    );
    assert.equal(comp.order.total, 8);
    assert.equal(comp.order.paidAmount, 0);
    assert.equal(comp.order.dueAmount, 8);
    assert.equal(comp.comp.paidAmount, 0);
    assert.equal(comp.comp.unpaidAmount, 8);
    assert.equal(comp.comp.refundPlan.status, "not_required");
    assert.deepEqual(comp.comp.refundPlan.allocations, []);
    assert.equal(comp.stornoPrintJob, null);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t10", "sala_terrazza", created.order.id, 8, {
      idempotencyKey: "scenario-16g-cleanup",
    });
  });

  await t.test("17 abbuono with zero-price replacement creates a non-payable reorder and print", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t18",
      roomId: "room_pedana",
      tableNumber: 18,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" }), line("Americano", 8, 1, { productId: "menu_drink_americano" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await lockTable(baseUrl, mobile, "giada-mobile", "room_pedana_t18", "order.comp");
    const comped = await api(baseUrl, mobile, "giada-mobile", "POST", "/api/integration/orders/comp", {
      tableId: "room_pedana_t18",
      roomId: "room_pedana",
      orderId: created.order.id,
      originalLineId: created.order.items[0].lineId,
      quantity: 1,
      reason: "Rifatto drink",
      sendReplacement: true,
      idempotencyKey: "scenario-17-comp-replace",
	    });
	    assert.equal(comped.comp.amount, 0);
	    assert.equal(comped.order.total, 16);
	    assert.equal(comped.order.dueAmount, 16);
	    assert.equal(comped.order.paidAmount, 0);
	    assert.equal(comped.replacement.customerPrice, 0);
    assert.equal(comped.replacementOrder.total, 0);
    assert.match(comped.printJob.id, /^print_/);
    assert.match(comped.orderPrintJob.id, /^print_/);
    const db = await readDb(dbPath);
    const replacementTagJob = db.printSpoolJobs.find((job) => job.id === comped.printJob.id);
    const replacementOrderJob = db.printSpoolJobs.find((job) => job.id === comped.orderPrintJob.id);
    assert.ok(replacementTagJob, "replacement tag print job should be persisted");
    assert.ok(replacementOrderJob, "replacement order print job should be persisted");
    assert.ok(
      db.printSpoolJobs.findIndex((job) => job.id === comped.printJob.id) <
        db.printSpoolJobs.findIndex((job) => job.id === comped.orderPrintJob.id),
      "replacement order print should be queued after replacement tag"
    );
    assert.equal(replacementOrderJob.kind, "order");
    assert.match(replacementTagJob.textPreview, /ARTICOLO SOSTITUITO/);
    assert.match(replacementOrderJob.textPreview, /COMANDA/);
    assert.match(replacementOrderJob.textPreview, /BLOODY MARY/);
    const report = await api(baseUrl, admin, "admin-device", "POST", "/api/reports/sales", {});
    assert.ok(report.report.serviceRecovery.comps.some((entry) => entry.id === comped.comp.id));
    assert.ok(report.report.serviceRecovery.replacements.some((entry) => entry.id === comped.replacement.id));
    assert.ok(report.report.serviceRecovery.comps.some((entry) => entry.paidAmount > 0 && entry.refundPlan));
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t18", "room_pedana", created.order.id, 8, {
      idempotencyKey: "scenario-17-pay-rest",
    });
  });

  await t.test("18 cash mobile payment receipt is routed to the configured preparation printer", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t19",
      roomId: "room_pedana",
      tableNumber: 19,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    const paid = await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t19", "room_pedana", created.order.id, 1.3, {
      idempotencyKey: "scenario-18-cash-receipt",
      cashGiven: 2,
      note: "cena tavolo 19",
    });
    const db = await readDb(dbPath);
    const receipt = db.printSpoolJobs.find((job) => job.id === paid.paymentReceiptJobs[0].id);
    assert.equal(receipt.printerId, "printer_bar");
    assert.equal(receipt.kind, "payment");
    assert.match(receipt.textPreview, /PAGAMENTO CONTANTI/);
    assert.match(receipt.textPreview, /RESTO/);
    assert.match(receipt.textPreview, /NOTA/);
    assert.match(receipt.textPreview, /CENA TAVOLO 19/);
    assert.ok(paid.transactions?.[0]?.id);
    assert.match(receipt.textPreview, /ID TX/);
    assert.match(receipt.textPreview, new RegExp(escapeRegExp(paid.transactions[0].id.toUpperCase())));
    assert.equal(db.paymentContainers.find((payment) => payment.id === paid.payment.id)?.note, "cena tavolo 19");
    assert.ok(db.payments.some((payment) => payment.paymentContainerId === paid.payment.id && payment.note === "cena tavolo 19"));
  });

  await t.test("18b card mobile payment receipt prints the payment note", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t19",
      roomId: "room_pedana",
      tableNumber: 19,
      lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    const paid = await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_pedana_t19", "room_pedana", created.order.id, 1.6, {
      idempotencyKey: "scenario-18b-card-note-receipt",
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "test-pos",
      posTxRef: "TEST-POS-NOTE-18B",
      note: "nota pos cliente",
    });
    const db = await readDb(dbPath);
    const receipt = db.printSpoolJobs.find((job) => job.id === paid.paymentReceiptJobs[0].id);
    assert.equal(receipt.kind, "payment");
    assert.match(receipt.textPreview, /PAGAMENTO ELETTRONICO/);
    assert.ok(paid.transactions?.[0]?.id);
    assert.match(receipt.textPreview, /ID TX/);
    assert.match(receipt.textPreview, new RegExp(escapeRegExp(paid.transactions[0].id.toUpperCase())));
    assert.match(receipt.textPreview, /NOTA/);
    assert.match(receipt.textPreview, /NOTA POS CLIENTE/);
    assert.equal(db.paymentContainers.find((payment) => payment.id === paid.payment.id)?.note, "nota pos cliente");
    assert.ok(db.payments.some((payment) => payment.paymentContainerId === paid.payment.id && payment.note === "nota pos cliente"));
  });

  await t.test("19 gin and vodka premium products are searchable through their section metadata", async () => {
    const menu = await publicApi(baseUrl, "/api/integration/menu");
    const products = [...(menu.products ?? []), ...(menu.postazioneItems ?? [])];
    const ginMatches = products.filter((item) => /gin/i.test(`${item.name} ${item.section ?? ""}`));
    const vodkaMatches = products.filter((item) => /vodka/i.test(`${item.name} ${item.section ?? ""}`));
    assert.ok(ginMatches.some((item) => item.name === "Gin Mare"));
    assert.ok(vodkaMatches.some((item) => item.name === "Grey Goose"));
    assert.ok(vodkaMatches.some((item) => item.name === "Absolut"));
    assert.ok(vodkaMatches.some((item) => item.name === "SKYY"));
    assert.equal(products.some((item) => String(item.section).toLowerCase() === "codka"), false);
  });

  await t.test("20 ready pickup targets sender, hands off in-room on logout and rejects the stale session", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_pedana_t20",
      roomId: "room_pedana",
      tableNumber: 20,
      lines: [line("Americano", 8, 1, { productId: "menu_drink_americano" })],
    });

    await readyOrder(baseUrl, station, "station-main", created.order.id);

    const annaBefore = await pullMobileNotifications(baseUrl, annaMobile, "anna-mobile");
    assert.equal(
      annaBefore.items.some((notification) => notification.meta?.orderId === created.order.id),
      false,
      "before timeout the ready pickup should not be proposed to another waiter"
    );

    const giadaBefore = await pullMobileNotifications(baseUrl, mobile, "giada-mobile");
    const targeted = giadaBefore.items.find((notification) => notification.meta?.orderId === created.order.id);
    assert.ok(targeted, "the waiter who sent the order should receive the pickup first");
    assert.equal(targeted.meta.targetUserId, "u_giada");

    const dbBeforeEscalation = await readDb(dbPath);
    const notificationIndex = dbBeforeEscalation.integration.notifications.findIndex(
      (notification) => notification.id === targeted.id
    );
    assert.ok(notificationIndex >= 0, "ready notification should be pending before pickup ack");
    const rawNotification = dbBeforeEscalation.integration.notifications[notificationIndex];
    const timeoutDelta = Number(rawNotification.meta?.bellEscalateAtMs) - Number(rawNotification.createdAt);
    assert.ok(timeoutDelta >= 59_000 && timeoutDelta <= 65_000, `expected 60s escalation, got ${timeoutDelta}`);

    const loggedOut = await api(baseUrl, mobile, "giada-mobile", "POST", "/api/auth/logout", {
      clientApp: "mobile-frontend",
    });
    assert.equal(loggedOut.loggedOut, true);

    const annaAfter = await pullMobileNotifications(baseUrl, annaMobile, "anna-mobile");
    const escalated = annaAfter.items.find((notification) => notification.id === targeted.id);
    assert.ok(escalated, "after logout the pickup should be handed off in the same room");
    assert.equal(escalated.meta.targetUserId, undefined);
    assert.equal(escalated.meta.targetUsername, undefined);
    assert.deepEqual(escalated.meta.targetUserIds, ["u_anna"]);
    assert.equal(escalated.meta.targetFallbackScope, "same_room");
    assert.equal(escalated.meta.targetFallbackReason, "target_logout");
    assert.equal(escalated.meta.originalTargetUserId, "u_giada");

    const annaAck = await ackMobileNotification(baseUrl, annaMobile, "anna-mobile", targeted.id);
    assert.equal(annaAck.acknowledged, true);
    assert.equal(annaAck.conflict, false);

    const giadaAfterClaim = await pullMobileNotifications(baseUrl, mobile, "giada-mobile");
    assert.equal(
      giadaAfterClaim.items.some(
        (notification) =>
          notification.meta?.orderId === created.order.id ||
          notification.meta?.sourceNotificationId === targeted.id
      ),
      false,
      "after first pickup ack every related mobile pickup notification must disappear for other waiters"
    );

    const giadaLateAck = await ackMobileNotification(
      baseUrl,
      mobile,
      "giada-mobile",
      targeted.id,
      {},
      401,
    );
    assert.equal(giadaLateAck.code, "NOTIFICATION_SESSION_REVOKED");

    const dbAfterAck = await readDb(dbPath);
    assert.equal(
      dbAfterAck.integration.notifications.some((notification) => notification.id === targeted.id),
      false,
      "one-shot pickup notification should disappear after the first confirmation"
    );
    assert.equal(
      dbAfterAck.integration.notifications.some(
        (notification) =>
          notification.meta?.eventType === "bell_claimed_by_other" &&
          notification.meta?.sourceNotificationId === targeted.id
      ),
      false,
      "pickup ack must not leave a secondary mobile claimed notification"
    );
    const claim = dbAfterAck.integration.recentBellClaims.find(
      (entry) => entry.notificationId === targeted.id
    );
    assert.equal(claim.claimedByUserId, "u_anna");
    const updatedOrder = dbAfterAck.integration.orders.find((order) => order.id === created.order.id);
    assert.equal(updatedOrder.waiter, "Anna Campana");
    mobile = await login(baseUrl, "giada", "2222", "giada-mobile", "mobile-frontend");
  });

  await t.test("21 current static frontend assets have no obvious mojibake or unreadably pale hardcoded text", async () => {
    const assetNames = await fs.readdir(path.join(distDir, "assets"));
    const textAssets = assetNames.filter((name) => /\.(?:js|css)$/.test(name));
    assert.ok(textAssets.length > 0);
    for (const name of textAssets) {
      const content = await fs.readFile(path.join(distDir, "assets", name), "utf8");
      assert.doesNotMatch(content, /Ã|Â|�/, name);
      assert.doesNotMatch(content, /color:\s*rgba\(255,\s*255,\s*255,\s*\.3\)/i, name);
    }
  });

  const fullSimulation = {};
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const serviceDate = tomorrow.toISOString().slice(0, 10);
  const reservationAt = Date.parse(`${serviceDate}T20:30:00.000+02:00`);

  await t.test("22 full simulation opens two bills and pays half of each with different methods", async () => {
    const first = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t01",
      roomId: "room_sala",
      tableNumber: 1,
      covers: 3,
      note: "Primo conto: allergia frutta secca",
      communications: "Cliente chiede conto separato",
      lines: [line("Americano", 8, 2, { productId: "menu_drink_americano", variant: "Sour" })],
    });
    await readyOrder(baseUrl, station, "station-main", first.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_sala_t01", "room_sala", first.order.id, 8, {
      idempotencyKey: "full-22-first-half-cash",
      releaseTable: false,
      note: "prima meta tavolo 1",
    });

    const second = await createOrder(baseUrl, annaMobile, "anna-mobile", {
      tableId: "sala_terrazza_t12",
      roomId: "sala_terrazza",
      tableNumber: 12,
      covers: 4,
      note: "Secondo conto con POS",
      lines: [line("Bloody Mary", 8, 3, { productId: "menu_drink_bloody_mary", variant: "Fizz" })],
    });
    await readyOrder(baseUrl, station, "station-main", second.order.id);
    await payFreeSplit(baseUrl, annaMobile, "anna-mobile", "sala_terrazza_t12", "sala_terrazza", second.order.id, 12, {
      idempotencyKey: "full-22-second-half-card",
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "test-pos",
      posTxRef: "FULL-22-SECOND-HALF",
      releaseTable: false,
      note: "meta pagata con carta",
    });

    fullSimulation.firstOrderId = first.order.id;
    fullSimulation.secondOrderId = second.order.id;
    let db = await readDb(dbPath);
    assert.equal(findOrder(db, first.order.id).paymentStatus, "partial");
    assert.equal(findOrder(db, first.order.id).dueAmount, 8);
    assert.equal(findOrder(db, second.order.id).paymentStatus, "partial");
    assert.equal(findOrder(db, second.order.id).dueAmount, 12);
  });

  await t.test("23 returns to the first bill, closes it, frees value and reoccupies with a new order", async () => {
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_sala_t01", "room_sala", fullSimulation.firstOrderId, 8, {
      idempotencyKey: "full-23-close-first",
      note: "chiusura primo conto",
    });
    let db = await readDb(dbPath);
    assert.equal(findOrder(db, fullSimulation.firstOrderId).paymentStatus, "paid");
    assert.equal(findTable(db, "room_sala_t01").totalDue, 0);

    const reopened = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t01",
      roomId: "room_sala",
      tableNumber: 1,
      covers: 2,
      note: "Tavolo rioccupato dopo chiusura",
      lines: [
        line("Latte Macchiato", 1.5, 2, { productId: "menu_caffetteria_latte_macchiato" }),
        line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" }),
      ],
    });
    await readyOrder(baseUrl, station, "station-main", reopened.order.id);
    fullSimulation.reopenedOrderId = reopened.order.id;
    db = await readDb(dbPath);
    assert.equal(findOrder(db, reopened.order.id).paymentStatus, "unpaid");
    assert.equal(findTable(db, "room_sala_t01").totalDue, 4.3);
  });

  await t.test("24 leaves second bill partial while the reopened first table orders again, then closes second", async () => {
    const extra = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t01",
      roomId: "room_sala",
      tableNumber: 1,
      covers: 2,
      note: "Ordine aggiunto prima di chiudere il secondo tavolo",
      lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
    });
    await readyOrder(baseUrl, station, "station-main", extra.order.id);
    fullSimulation.reopenedExtraOrderId = extra.order.id;
    let db = await readDb(dbPath);
    assert.equal(findOrder(db, fullSimulation.secondOrderId).paymentStatus, "partial");
    assert.equal(findTable(db, "room_sala_t01").totalDue, 5.9);

    await payFreeSplit(baseUrl, annaMobile, "anna-mobile", "sala_terrazza_t12", "sala_terrazza", fullSimulation.secondOrderId, 12, {
      idempotencyKey: "full-24-close-second",
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "test-pos",
      posTxRef: "FULL-24-CLOSE-SECOND",
      note: "chiusura secondo conto",
    });
    db = await readDb(dbPath);
    assert.equal(findOrder(db, fullSimulation.secondOrderId).paymentStatus, "paid");
    assert.equal(findTable(db, "sala_terrazza_t12").totalDue, 0);
  });

  await t.test("25 merge and split a live table without losing pending bills or table labels", async () => {
    await saveGroups(baseUrl, mobile, "giada-mobile", [
      { id: "room_sala_t01", type: "complex", children: [{ id: "room_sala_t01", type: "simple" }, { id: "room_sala_t02", type: "simple" }] },
    ]);
    await printOrder(baseUrl, mobile, "giada-mobile", "preconto", fullSimulation.reopenedOrderId);
    let db = await readDb(dbPath);
    assert.equal(findTable(db, "room_sala_t01").totalDue, 5.9);
    assert.match(latestJobFor(db, fullSimulation.reopenedOrderId, "preconto").textPreview, /1\/2|TAVOLO 1\/2/i);

    await saveGroups(baseUrl, mobile, "giada-mobile", []);
    await printOrder(baseUrl, mobile, "giada-mobile", "preconto", fullSimulation.reopenedOrderId);
    db = await readDb(dbPath);
    assert.match(latestJobFor(db, fullSimulation.reopenedOrderId, "preconto").textPreview, /Tavolo 1|TAV\. ?1/i);
  });

  await t.test("26 moves a half-paid table across rooms, keeps due coherent, closes it and reorders", async () => {
    const moving = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t03",
      roomId: "room_sala",
      tableNumber: 3,
      covers: 3,
      lines: [line("Americano", 8, 3, { productId: "menu_drink_americano" })],
    });
    await readyOrder(baseUrl, station, "station-main", moving.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_sala_t03", "room_sala", moving.order.id, 12, {
      idempotencyKey: "full-26-half-before-move",
      releaseTable: false,
    });
    const moved = await moveTable(baseUrl, mobile, "giada-mobile", "room_sala_t03", "sala_terrazza_t11");
    assert.equal(moved.movedOrdersCount, 1);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t11", "sala_terrazza", moving.order.id, 12, {
      idempotencyKey: "full-26-close-after-move",
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "test-pos",
      posTxRef: "FULL-26-CLOSE",
    });

    const afterMove = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t11",
      roomId: "sala_terrazza",
      tableNumber: 11,
      covers: 2,
      note: "Riordino dopo spostamento",
      lines: [line("Gin Mare", 12, 1, { productId: "menu_drink_premium_mare", variant: "Tonic" })],
    });
    await readyOrder(baseUrl, station, "station-main", afterMove.order.id);
    fullSimulation.movedReorderId = afterMove.order.id;
    const db = await readDb(dbPath);
    assert.equal(findOrder(db, moving.order.id).paymentStatus, "paid");
    assert.equal(findOrder(db, afterMove.order.id).dueAmount, 12);
  });

  await t.test("27 modifies a waiting order with notes and variants, then marks ready and applies bar comp", async () => {
    const editable = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t13",
      roomId: "sala_terrazza",
      tableNumber: 13,
      covers: 2,
      note: "Nota iniziale comanda",
      communications: "Commento iniziale",
      lines: [line("Bloody Mary", 8, 2, { productId: "menu_drink_bloody_mary", variant: "Sour" })],
    });
    const corrected = await correctOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t13",
      roomId: "sala_terrazza",
      orderId: editable.order.id,
      expectedRevision: 1,
      changedItems: [
        {
          lineId: editable.order.items[0].lineId,
          nextVariant: "Fizz",
          nextNote: "Meno spezie, bicchiere freddo",
          nextQuantity: 2,
          nextUnitPrice: 8,
        },
      ],
      addedItems: [
        {
          productId: "menu_drink_premium_absolut",
          productName: "Absolut",
          quantity: 1,
          variant: "Lemon",
          note: "Aggiunta in modifica",
          unitPrice: 10,
        },
      ],
      nextOrderNote: "Nota comanda aggiornata",
      nextOrderComment: "Commento comanda aggiornato",
      idempotencyKey: "full-27-correction",
    });
    assert.equal(corrected.order.total, 26);
    await readyOrder(baseUrl, station, "station-main", editable.order.id);
    await lockTable(baseUrl, mobile, "giada-mobile", "sala_terrazza_t13", "order.comp");
    const comped = await api(baseUrl, mobile, "giada-mobile", "POST", "/api/integration/orders/comp", {
      tableId: "sala_terrazza_t13",
      roomId: "sala_terrazza",
      orderId: editable.order.id,
      originalLineId: editable.order.items[0].lineId,
      quantity: 1,
      reason: "Drink caduto durante il servizio",
      idempotencyKey: "full-27-comp",
	    });
	    assert.equal(comped.comp.amount, 8);
	    assert.equal(comped.order.total, 18);
	    assert.equal(comped.order.paidAmount, 0);
	    assert.equal(comped.order.dueAmount, 18);
	    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t13", "sala_terrazza", editable.order.id, 18, {
	      idempotencyKey: "full-27-pay-after-comp",
      note: "pagato dopo reso bar",
    });
  });

  await t.test("28 payment notes persist in receipt jobs and payment statistics source data", async () => {
    const noteText = "nota pagamento visibile statistiche";
    const paid = await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t11", "sala_terrazza", fullSimulation.movedReorderId, 12, {
      idempotencyKey: "full-28-note-pay",
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "test-pos",
      posTxRef: "FULL-28-NOTE",
      note: noteText,
    });
    const db = await readDb(dbPath);
    const receipt = db.printSpoolJobs.find((job) => job.id === paid.paymentReceiptJobs[0].id);
    assert.match(receipt.textPreview, /NOTA/);
    assert.match(receipt.textPreview, /NOTA PAGAMENTO VISIBILE STATISTICHE/);
    assert.equal(db.paymentContainers.find((entry) => entry.id === paid.payment.id)?.note, noteText);
    assert.ok(db.payments.some((entry) => entry.paymentContainerId === paid.payment.id && entry.note === noteText));
  });

  await t.test("29 reservations create, list, availability conflict and update with lock", async () => {
    const created = await reservationCreate(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationAt,
      customerName: "Cliente Simulazione",
      customerPhone: "333000111",
      covers: 5,
      intolerances: ["glutine"],
      note: "Torta portata dal cliente",
      assignedTableId: "room_sala_t04",
    });
    fullSimulation.reservationId = created.reservation.id;
    const listed = await reservationList(baseUrl, mobile, "giada-mobile", { roomId: "room_sala", serviceDate });
    assert.ok(listed.reservations.some((entry) => entry.id === created.reservation.id));
    const availability = await reservationAvailability(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationAt,
      tableIds: ["room_sala_t04", "room_sala_t05"],
    });
    assert.equal(availability.items.find((entry) => entry.tableId === "room_sala_t04")?.status, "conflict");
    const nearAvailability = await reservationAvailability(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationAt: reservationAt + 59 * 60 * 1000,
      tableIds: ["room_sala_t04"],
    });
    assert.equal(nearAvailability.items.find((entry) => entry.tableId === "room_sala_t04")?.status, "conflict");
    const sequentialAvailability = await reservationAvailability(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationAt: reservationAt + 60 * 60 * 1000,
      tableIds: ["room_sala_t04"],
    });
    assert.notEqual(
      sequentialAvailability.items.find((entry) => entry.tableId === "room_sala_t04")?.status,
      "conflict"
    );
    const spacedReservationAt = reservationAt + 4 * 60 * 60 * 1000;
    await reservationCreate(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationAt: spacedReservationAt,
      customerName: "Cliente Spaziatura Base",
      customerPhone: "333000222",
      covers: 2,
      assignedTableId: "room_sala_t06",
    });
    await reservationCreate(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationAt: spacedReservationAt + 59 * 60 * 1000,
      customerName: "Cliente Troppo Vicino",
      customerPhone: "333000223",
      covers: 2,
      assignedTableId: "room_sala_t06",
    }, 409);
    const spacedCreated = await reservationCreate(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationAt: spacedReservationAt + 60 * 60 * 1000,
      customerName: "Cliente Spaziato",
      customerPhone: "333000224",
      covers: 2,
      assignedTableId: "room_sala_t06",
    });
    assert.equal(spacedCreated.reservation.assignedTableId, "room_sala_t06");

    const locked = await reservationLockAcquire(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationId: created.reservation.id,
    });
    const updated = await reservationUpdate(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationId: created.reservation.id,
      lockId: locked.lock.lockId,
      patch: {
        reservationAt: reservationAt + 30 * 60 * 1000,
        customerName: "Cliente Simulazione Aggiornato",
        customerPhone: "333000111",
        covers: 6,
        intolerances: ["glutine", "lattosio"],
        note: "Aggiornata durante test",
        assignedTableId: "room_sala_t04",
      },
    });
    assert.equal(updated.reservation.covers, 6);
    assert.equal(updated.reservation.note, "Aggiornata durante test");
  });

  await t.test("30 reservations can be deleted and disappear from the room history", async () => {
    const locked = await reservationLockAcquire(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationId: fullSimulation.reservationId,
    });
    const deleted = await reservationDelete(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationId: fullSimulation.reservationId,
      lockId: locked.lock.lockId,
    });
    assert.equal(deleted.deleted, true);
    const listed = await reservationList(baseUrl, mobile, "giada-mobile", { roomId: "room_sala", serviceDate });
    assert.equal(listed.reservations.some((entry) => entry.id === fullSimulation.reservationId), false);
  });

  await t.test("31 exhausted item is hidden as unavailable and cannot be ordered", async () => {
    await postazioneAction(baseUrl, station, "station-main", {
      type: "item_disable",
      itemName: "Bloody Mary",
      scope: "global",
      station: "BAR PRINCIPALE",
    });
    const menu = await publicApi(baseUrl, "/api/integration/menu?station=BAR%20PRINCIPALE");
    const item = [...(menu.products ?? []), ...(menu.postazioneItems ?? [])].find((entry) => entry.name === "Bloody Mary");
    assert.equal(item?.available, false);
    const rejected = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t06",
      roomId: "room_sala",
      tableNumber: 6,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
      expectedStatus: 409,
    });
    assert.equal(rejected.code, "ITEM_UNAVAILABLE");
  });

  await t.test("32 re-enabled item returns orderable and payable", async () => {
    await postazioneAction(baseUrl, station, "station-main", {
      type: "item_enable",
      itemName: "Bloody Mary",
      scope: "global",
      station: "BAR PRINCIPALE",
    });
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t06",
      roomId: "room_sala",
      tableNumber: 6,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_sala_t06", "room_sala", created.order.id, 8, {
      idempotencyKey: "full-32-reenabled-pay",
    });
    const db = await readDb(dbPath);
    assert.equal(findOrder(db, created.order.id).paymentStatus, "paid");
  });

  await t.test("33 paused station warns on order and returned station can complete it", async () => {
    await upsertStationState(baseUrl, station, "station-main", { active: false });
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t07",
      roomId: "room_sala",
      tableNumber: 7,
      lines: [line("Americano", 8, 1, { productId: "menu_drink_americano" })],
    });
    assert.equal(created.pausedStationWarning?.code, "station_paused_only_target");
    const returned = await upsertStationState(baseUrl, station, "station-main", { active: true });
    assert.equal(returned.station.active, true);
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_sala_t07", "room_sala", created.order.id, 8, {
      idempotencyKey: "full-33-pay-after-return",
    });
  });

  await t.test("34 active operators on distinct stations receive load-balanced orders", async () => {
    const annaStation = await login(baseUrl, "anna", "1234", "station-anna", "postazione");
    await selectWorkstation(baseUrl, annaStation, "station-anna", "BAR SECONDARIA");
    const historicalOrderIds = new Set(
      (await readDb(dbPath)).integration.orders.map((order) => order.id),
    );
    await upsertStationState(baseUrl, station, "station-main", { active: true });
    await upsertStationState(baseUrl, annaStation, "station-anna", {
      station: "BAR SECONDARIA",
      active: true,
    });
    await finishHistoricalStationQueue(
      baseUrl,
      dbPath,
      annaStation,
      "station-anna",
      "BAR SECONDARIA",
      historicalOrderIds,
    );
    const first = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t08",
      roomId: "room_sala",
      tableNumber: 8,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    const second = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t09",
      roomId: "room_sala",
      tableNumber: 9,
      lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
    });
    const mainList = await publicApi(
      baseUrl,
      `/api/integration/orders?station=BAR%20PRINCIPALE&includeDone=1&operatorUserId=${encodeURIComponent(station.user.id)}&deviceUuid=station-main`
    );
    const annaList = await publicApi(
      baseUrl,
      `/api/integration/orders?station=BAR%20SECONDARIA&includeDone=1&operatorUserId=${encodeURIComponent(annaStation.user.id)}&deviceUuid=station-anna`
    );
    const dbAfterCreate = await readDb(dbPath);
    const firstOrder = findOrder(dbAfterCreate, first.order.id);
    const secondOrder = findOrder(dbAfterCreate, second.order.id);
    assert.ok(firstOrder.assignedStationId, "first order should be assigned to an active station");
    assert.ok(secondOrder.assignedStationId, "second order should be assigned to an active station");
    for (const orderId of [first.order.id, second.order.id]) {
      const visibleCount =
        (mainList.orders.some((entry) => entry.id === orderId) ? 1 : 0) +
        (annaList.orders.some((entry) => entry.id === orderId) ? 1 : 0);
      assert.equal(visibleCount, 1, `order ${orderId} should be visible to exactly one station operator`);
    }
    const stationSessionByName = new Map([
      ["BAR PRINCIPALE", { session: station, deviceUuid: "station-main" }],
      ["BAR SECONDARIA", { session: annaStation, deviceUuid: "station-anna" }],
    ]);
    for (const createdOrder of [firstOrder, secondOrder]) {
      const stationContext = stationSessionByName.get(createdOrder.assignedStationId);
      assert.ok(stationContext, `expected station context for ${createdOrder.assignedStationId}`);
      await readyOrder(
        baseUrl,
        stationContext.session,
        stationContext.deviceUuid,
        createdOrder.id,
        createdOrder.assignedStationId
      );
    }
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_sala_t08", "room_sala", first.order.id, 1.3, {
      idempotencyKey: "full-34-pay-first",
    });
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_sala_t09", "room_sala", second.order.id, 1.6, {
      idempotencyKey: "full-34-pay-second",
    });
    await upsertStationState(baseUrl, annaStation, "station-anna", {
      station: "BAR SECONDARIA",
      active: false,
    });
  });

  await t.test("35 preparation queue advances automatically from ready order to next received order", async () => {
    const queueStation = await login(baseUrl, "anna", "1234", "station-queue", "postazione");
    await selectWorkstation(baseUrl, queueStation, "station-queue", "BAR SECONDARIA");
    const historicalOrderIds = new Set(
      (await readDb(dbPath)).integration.orders.map((order) => order.id),
    );
    await upsertStationState(baseUrl, station, "station-main", { active: false });
    await upsertStationState(baseUrl, queueStation, "station-queue", {
      station: "BAR SECONDARIA",
      active: true,
    });
    await finishHistoricalStationQueue(
      baseUrl,
      dbPath,
      queueStation,
      "station-queue",
      "BAR SECONDARIA",
      historicalOrderIds,
    );
    const first = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t10",
      roomId: "room_sala",
      tableNumber: 10,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    await finishHistoricalStationQueue(
      baseUrl,
      dbPath,
      queueStation,
      "station-queue",
      "BAR SECONDARIA",
      historicalOrderIds,
    );
    const second = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t14",
      roomId: "sala_terrazza",
      tableNumber: 14,
      lines: [line("Latte Macchiato", 1.5, 1, { productId: "menu_caffetteria_latte_macchiato" })],
    });
    await finishHistoricalStationQueue(
      baseUrl,
      dbPath,
      queueStation,
      "station-queue",
      "BAR SECONDARIA",
      historicalOrderIds,
    );
    let db = await readDb(dbPath);
    const firstBefore = findOrder(db, first.order.id);
    const secondBefore = findOrder(db, second.order.id);
    assert.equal(firstBefore.assignedStationId, "BAR SECONDARIA");
    assert.equal(secondBefore.assignedStationId, "BAR SECONDARIA");
    assert.ok(["prep", "waiting"].includes(firstBefore.workflowStatus));
    assert.ok(["prep", "waiting"].includes(secondBefore.workflowStatus));
    assert.equal(
      [firstBefore, secondBefore].filter((order) => order.workflowStatus === "prep").length,
      1,
      "only one order should be in preparation for the same active station lane"
    );
    const preparingOrder = firstBefore.workflowStatus === "prep" ? firstBefore : secondBefore;
    const waitingOrder = preparingOrder.id === first.order.id ? secondBefore : firstBefore;
    await readyOrder(baseUrl, queueStation, "station-queue", preparingOrder.id, "BAR SECONDARIA");
    db = await readDb(dbPath);
    assert.equal(findOrder(db, waitingOrder.id).workflowStatus, "prep");
    await readyOrder(baseUrl, queueStation, "station-queue", waitingOrder.id, "BAR SECONDARIA");
    await payFreeSplit(baseUrl, mobile, "giada-mobile", preparingOrder.tableId, preparingOrder.roomId, preparingOrder.id, preparingOrder.total, {
      idempotencyKey: `full-35-pay-${preparingOrder.id}`,
    });
    await payFreeSplit(baseUrl, mobile, "giada-mobile", waitingOrder.tableId, waitingOrder.roomId, waitingOrder.id, waitingOrder.total, {
      idempotencyKey: `full-35-pay-${waitingOrder.id}`,
    });
    await upsertStationState(baseUrl, queueStation, "station-queue", {
      station: "BAR SECONDARIA",
      active: false,
    });
    await upsertStationState(baseUrl, station, "station-main", { active: true });
  });

  await t.test("35b station selection handoff demotes previous order without auto-promoting it back", async () => {
    const handoffStation = await login(baseUrl, "anna", "1234", "station-handoff", "postazione");
    await selectWorkstation(baseUrl, handoffStation, "station-handoff", "BAR SECONDARIA");
    const historicalOrderIds = new Set(
      (await readDb(dbPath)).integration.orders.map((order) => order.id),
    );
    await upsertStationState(baseUrl, station, "station-main", { active: false });
    await upsertStationState(baseUrl, handoffStation, "station-handoff", {
      station: "BAR SECONDARIA",
      active: true,
    });
    await finishHistoricalStationQueue(
      baseUrl,
      dbPath,
      handoffStation,
      "station-handoff",
      "BAR SECONDARIA",
      historicalOrderIds,
    );
    const first = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t10",
      roomId: "room_sala",
      tableNumber: 10,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    await finishHistoricalStationQueue(
      baseUrl,
      dbPath,
      handoffStation,
      "station-handoff",
      "BAR SECONDARIA",
      historicalOrderIds,
    );
    const second = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t14",
      roomId: "sala_terrazza",
      tableNumber: 14,
      lines: [line("Latte Macchiato", 1.5, 1, { productId: "menu_caffetteria_latte_macchiato" })],
    });
    await finishHistoricalStationQueue(
      baseUrl,
      dbPath,
      handoffStation,
      "station-handoff",
      "BAR SECONDARIA",
      historicalOrderIds,
    );
    let db = await readDb(dbPath);
    const firstBefore = findOrder(db, first.order.id);
    const secondBefore = findOrder(db, second.order.id);
    const previous = firstBefore.workflowStatus === "prep" ? firstBefore : secondBefore;
    const next = previous.id === first.order.id ? secondBefore : firstBefore;
    assert.equal(previous.assignedStationId, "BAR SECONDARIA");
    assert.equal(next.assignedStationId, "BAR SECONDARIA");
    assert.equal(previous.workflowStatus, "prep");
    assert.equal(next.workflowStatus, "waiting");

    const released = await api(baseUrl, handoffStation, "station-handoff", "POST", "/api/integration/orders/sync", {
      id: previous.id,
      workflowReason: "selected_order_blur_empty",
      order: {
        ...previous,
        workflowStatus: "waiting",
        ownerStation: null,
        ownerOperator: null,
        ownerRole: null,
        ownerAtMs: null,
        lockedByStationId: null,
        lockedByUserId: null,
        lockedAt: null,
        lockStatus: "unlocked",
      },
    });
    assert.equal(released.order.workflowStatus, "waiting");
    db = await readDb(dbPath);
    assert.equal(findOrder(db, previous.id).workflowStatus, "waiting");

    const promoted = await api(baseUrl, handoffStation, "station-handoff", "POST", "/api/integration/orders/sync", {
      id: next.id,
      workflowReason: "selected_order",
      order: {
        ...next,
        workflowStatus: "prep",
        ownerStation: "BAR SECONDARIA",
        ownerOperator: "Anna Campana",
        ownerRole: "Operatore",
        ownerAtMs: Date.now(),
      },
    });
    assert.equal(promoted.order.workflowStatus, "prep");
    db = await readDb(dbPath);
    assert.equal(findOrder(db, previous.id).workflowStatus, "waiting");
    assert.equal(findOrder(db, next.id).workflowStatus, "prep");

    await readyOrder(baseUrl, handoffStation, "station-handoff", previous.id, "BAR SECONDARIA");
    await readyOrder(baseUrl, handoffStation, "station-handoff", next.id, "BAR SECONDARIA");
    await payFreeSplit(baseUrl, mobile, "giada-mobile", previous.tableId, previous.roomId, previous.id, previous.total, {
      idempotencyKey: `full-35b-pay-${previous.id}`,
    });
    await payFreeSplit(baseUrl, mobile, "giada-mobile", next.tableId, next.roomId, next.id, next.total, {
      idempotencyKey: `full-35b-pay-${next.id}`,
    });
    await upsertStationState(baseUrl, handoffStation, "station-handoff", {
      station: "BAR SECONDARIA",
      active: false,
    });
    await upsertStationState(baseUrl, station, "station-main", { active: true });
  });

  await t.test("36 totals above 999 stay payable and table covers up to 100 are accepted", async () => {
    const high = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t16",
      roomId: "sala_terrazza",
      tableNumber: 16,
      covers: 100,
      lines: [line("Apericena Premium", 17, 60, { productId: "menu_apericena_premium" })],
      total: 1020,
    });
    await readyOrder(baseUrl, station, "station-main", high.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t16", "sala_terrazza", high.order.id, 510, {
      idempotencyKey: "full-36-high-half",
      releaseTable: false,
    });
    let db = await readDb(dbPath);
    assert.equal(findOrder(db, high.order.id).dueAmount, 510);
    assert.equal(findTable(db, "sala_terrazza_t16").totalDue, 510);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t16", "sala_terrazza", high.order.id, 510, {
      idempotencyKey: "full-36-high-close",
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "test-pos",
      posTxRef: "FULL-36-HIGH",
    });
    db = await readDb(dbPath);
    assert.equal(findOrder(db, high.order.id).paymentStatus, "paid");
  });

  await t.test("37 alla romana style rounded payments close without residual cents", async () => {
    const roman = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t17",
      roomId: "sala_terrazza",
      tableNumber: 17,
      lines: [line("Tanqueray", 10, 1, { productId: "menu_drink_premium_tanqueray", variant: "Tonic" })],
    });
    await readyOrder(baseUrl, station, "station-main", roman.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t17", "sala_terrazza", roman.order.id, 3.35, {
      idempotencyKey: "full-37-roman-1",
      releaseTable: false,
      note: "quota 1 di 3",
    });
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t17", "sala_terrazza", roman.order.id, 3.35, {
      idempotencyKey: "full-37-roman-2",
      releaseTable: false,
      note: "quota 2 di 3",
    });
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t17", "sala_terrazza", roman.order.id, 3.3, {
      idempotencyKey: "full-37-roman-3",
      note: "quota finale",
    });
    const db = await readDb(dbPath);
    assert.equal(findOrder(db, roman.order.id).paymentStatus, "paid");
    assert.equal(findOrder(db, roman.order.id).dueAmount, 0);
  });

  await t.test("38 duplicate payment idempotency does not double-charge or reopen due", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t18",
      roomId: "sala_terrazza",
      tableNumber: 18,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    const first = await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t18", "sala_terrazza", created.order.id, 1.3, {
      idempotencyKey: "full-38-idempotent",
    });
    const second = await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t18", "sala_terrazza", created.order.id, 1.3, {
      idempotencyKey: "full-38-idempotent",
    });
    assert.equal(second.idempotent, true);
    assert.equal(second.payment.id, first.payment.id);
    const db = await readDb(dbPath);
    const payments = db.paymentContainers.filter((entry) => entry.idempotencyKey === "full-38-idempotent");
    assert.equal(payments.length, 1);
    assert.equal(findOrder(db, created.order.id).paymentStatus, "paid");
  });

  await t.test("39 order cancellation prints cancellation ticket, clears due and blocks payment", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t19",
      roomId: "sala_terrazza",
      tableNumber: 19,
      lines: [line("Americano", 8, 1, { productId: "menu_drink_americano" })],
    });
    const cancelled = await cancelOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t19",
      roomId: "sala_terrazza",
      orderId: created.order.id,
      expectedRevision: 1,
      reason: "Cliente annulla prima della preparazione",
    });
    assert.equal(cancelled.order.workflowStatus, "cancelled");
    assert.equal(cancelled.order.paymentStatus, "paid");
    const rejected = await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t19", "sala_terrazza", created.order.id, 8, {
      idempotencyKey: "full-39-pay-cancelled",
      expectedStatus: 409,
    });
    assert.equal(rejected.code, "ORDER_NOT_PAYABLE");
    const db = await readDb(dbPath);
    const cancelJob = db.printSpoolJobs.find((job) => job.id === cancelled.printJob.id);
    assert.equal(cancelJob.kind, "order_cancellation");
    assert.match(cancelJob.textPreview, /ANNULLA COMANDA|ANNULLAMENTO|COMANDA ANNULLATA/i);
    assert.equal(findTable(db, "sala_terrazza_t19").totalDue, 0);
  });

  await t.test("40 station pause state clears after heartbeat returns online", async () => {
    await upsertStationState(baseUrl, station, "station-main", { active: false });
    let state = await publicApi(baseUrl, "/api/integration/stations/state");
    const paused = state.stations.find((entry) => entry.deviceUuid === "station-main");
    assert.equal(paused?.active, false);
    await upsertStationState(baseUrl, station, "station-main", { active: true });
    state = await publicApi(baseUrl, "/api/integration/stations/state");
    const online = state.stations.find((entry) => entry.deviceUuid === "station-main");
    assert.equal(online?.active, true);
    assert.notEqual(online?.stale, true);
  });

  await t.test("41 table lock held by one waiter blocks another and release restores access", async () => {
    await lockTable(baseUrl, mobile, "giada-mobile", "room_sala_t10", "manual-edge-lock");
    const conflict = await api(baseUrl, annaMobile, "anna-mobile", "POST", "/api/tables/lock/acquire", {
      tableId: "room_sala_t10",
      purpose: "manual-edge-lock",
    }, 409);
    assert.match(conflict.error, /Tavolo|blocco|occupato|modifica/i);
    const released = await releaseTableLock(baseUrl, mobile, "giada-mobile", "room_sala_t10");
    assert.equal(released.released, true);
    const acquired = await lockTable(baseUrl, annaMobile, "anna-mobile", "room_sala_t10", "manual-edge-lock");
    assert.equal(acquired.ok, true);
    await releaseTableLock(baseUrl, annaMobile, "anna-mobile", "room_sala_t10");
  });

  await t.test("42 payment lock prevents a second waiter from collecting the same table", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t10",
      roomId: "room_sala",
      tableNumber: 10,
      lines: [line("Americano", 8, 1, { productId: "menu_drink_americano" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await lockTable(baseUrl, mobile, "giada-mobile", "room_sala_t10", "payment.free_split");
    const rejected = await api(baseUrl, annaMobile, "anna-mobile", "POST", "/api/payments/free-split", {
      tableId: "room_sala_t10",
      roomId: "room_sala",
      orderId: created.order.id,
      splitType: "FREE_SPLIT",
      idempotencyKey: "strange-42-conflict",
      parts: [
        {
          amountDue: 8,
          transactions: [{ method: "CASH", methodId: "pay_cash", methodLabel: "Contanti", amountPaid: 8, cashGiven: 8 }],
        },
      ],
    }, 409);
    assert.match(rejected.error, /Tavolo|blocco|modifica|occupato/i);
    await releaseTableLock(baseUrl, mobile, "giada-mobile", "room_sala_t10");
    await payFreeSplit(baseUrl, annaMobile, "anna-mobile", "room_sala_t10", "room_sala", created.order.id, 8, {
      idempotencyKey: "strange-42-pay-after-release",
    });
    await releaseTableLock(baseUrl, annaMobile, "anna-mobile", "room_sala_t10");
    const db = await readDb(dbPath);
    assert.equal(findOrder(db, created.order.id).paymentStatus, "paid");
  });

  await t.test("43 stale correction revision is rejected, then valid correction is idempotent", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t10",
      roomId: "room_sala",
      tableNumber: 10,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    const stale = await correctOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t10",
      roomId: "room_sala",
      orderId: created.order.id,
      expectedRevision: 99,
      changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2, nextUnitPrice: 1.3 }],
      idempotencyKey: "strange-43-stale",
    }, 409);
    assert.equal(stale.code, "REVISION_CONFLICT");

    const validPayload = {
      tableId: "room_sala_t10",
      roomId: "room_sala",
      orderId: created.order.id,
      expectedRevision: 1,
      changedItems: [{ lineId: created.order.items[0].lineId, nextQuantity: 2, nextUnitPrice: 1.3 }],
      nextOrderNote: "correzione valida e idempotente",
      idempotencyKey: "strange-43-valid",
    };
    const valid = await correctOrder(baseUrl, mobile, "giada-mobile", validPayload);
    const repeated = await correctOrder(baseUrl, mobile, "giada-mobile", validPayload);
    assert.equal(valid.order.total, 2.6);
    assert.equal(repeated.idempotent, true);
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_sala_t10", "room_sala", created.order.id, 2.6, {
      idempotencyKey: "strange-43-pay",
    });
    await releaseTableLock(baseUrl, mobile, "giada-mobile", "room_sala_t10");
  });

  await t.test("44 station-specific disable on an unrelated station does not block the real target", async () => {
    await postazioneAction(baseUrl, station, "station-main", {
      type: "item_disable",
      itemName: "Americano",
      scope: "station",
      station: "COCKTAIL",
    });
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t10",
      roomId: "room_sala",
      tableNumber: 10,
      lines: [line("Americano", 8, 1, { productId: "menu_drink_americano" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_sala_t10", "room_sala", created.order.id, 8, {
      idempotencyKey: "strange-44-pay",
    });
    await releaseTableLock(baseUrl, mobile, "giada-mobile", "room_sala_t10");
    await postazioneAction(baseUrl, station, "station-main", {
      type: "item_enable",
      itemName: "Americano",
      scope: "station",
      station: "COCKTAIL",
    });
  });

  await t.test("45 station-specific disable on the real target blocks then re-enable restores", async () => {
    await postazioneAction(baseUrl, station, "station-main", {
      type: "item_disable",
      itemName: "Cappuccino",
      scope: "station",
      station: "BAR PRINCIPALE",
    });
    const menu = await publicApi(baseUrl, "/api/integration/menu?station=BAR%20PRINCIPALE");
    const item = [...(menu.products ?? []), ...(menu.postazioneItems ?? [])].find((entry) => entry.name === "Cappuccino");
    assert.equal(item?.available, false);
    const rejected = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t10",
      roomId: "room_sala",
      tableNumber: 10,
      lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
      expectedStatus: 409,
    });
    assert.equal(rejected.code, "ITEM_UNAVAILABLE");
    await postazioneAction(baseUrl, station, "station-main", {
      type: "item_enable",
      itemName: "Cappuccino",
      scope: "station",
      station: "BAR PRINCIPALE",
    });
    const restored = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "room_sala_t10",
      roomId: "room_sala",
      tableNumber: 10,
      lines: [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })],
    });
    await readyOrder(baseUrl, station, "station-main", restored.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "room_sala_t10", "room_sala", restored.order.id, 1.6, {
      idempotencyKey: "strange-45-pay",
    });
    await releaseTableLock(baseUrl, mobile, "giada-mobile", "room_sala_t10");
  });

  await t.test("46 over-comp quantity is rejected and valid comp still closes the line", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t20",
      roomId: "sala_terrazza",
      tableNumber: 20,
      lines: [line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await lockTable(baseUrl, mobile, "giada-mobile", "sala_terrazza_t20", "order.comp");
    const overLimit = await api(baseUrl, mobile, "giada-mobile", "POST", "/api/integration/orders/comp", {
      tableId: "sala_terrazza_t20",
      roomId: "sala_terrazza",
      orderId: created.order.id,
      originalLineId: created.order.items[0].lineId,
      quantity: 99,
      reason: "Richiesta quantita oltre disponibilita",
      idempotencyKey: "strange-46-comp",
    }, 400);
    assert.equal(overLimit.code, "ORDER_COMP_QUANTITY_EXCEEDS_AVAILABLE");
    assert.equal(overLimit.details?.availableQuantity, 1);
    const listedBeforeComp = await publicApi(
      baseUrl,
      `/api/integration/orders?includeDone=1&orderId=${encodeURIComponent(created.order.id)}`
    );
    const beforeCompOrder = listedBeforeComp.orders.find((order) => order.id === created.order.id);
    assert.equal(beforeCompOrder?.compAvailability?.byLine?.[created.order.items[0].lineId]?.availableQuantity, 1);
    const comped = await api(baseUrl, mobile, "giada-mobile", "POST", "/api/integration/orders/comp", {
      tableId: "sala_terrazza_t20",
      roomId: "sala_terrazza",
      orderId: created.order.id,
      originalLineId: created.order.items[0].lineId,
      quantity: 1,
      reason: "Richiesta valida",
      idempotencyKey: "strange-46-comp-valid",
    });
    assert.equal(comped.comp.quantity, 1);
    assert.equal(comped.order.total, 0);
    assert.equal(comped.order.paidAmount, 0);
    assert.equal(comped.order.dueAmount, 0);
    const listedAfterComp = await publicApi(
      baseUrl,
      `/api/integration/orders?includeDone=1&orderId=${encodeURIComponent(created.order.id)}`
    );
    const afterCompOrder = listedAfterComp.orders.find((order) => order.id === created.order.id);
    assert.equal(afterCompOrder?.compAvailability?.byLine?.[created.order.items[0].lineId]?.availableQuantity, 0);
    await printOrder(baseUrl, mobile, "giada-mobile", "preconto", `#${created.order.id}`);
    await printOrder(baseUrl, mobile, "giada-mobile", "order", created.order.id);
    let db = await readDb(dbPath);
    assert.equal(latestJobFor(db, created.order.id, "preconto").orderId, created.order.id);
    assert.match(latestJobFor(db, created.order.id, "preconto").textPreview, /0,00|0\.00/);
    assert.doesNotMatch(latestJobFor(db, created.order.id, "preconto").textPreview, /BLOODY MARY|8,00|8\.00/);
    assert.doesNotMatch(latestJobFor(db, created.order.id, "order").textPreview, /BLOODY MARY/);
    await lockTable(baseUrl, mobile, "giada-mobile", "sala_terrazza_t20", "order.comp");
    const rejected = await api(baseUrl, mobile, "giada-mobile", "POST", "/api/integration/orders/comp", {
      tableId: "sala_terrazza_t20",
      roomId: "sala_terrazza",
      orderId: created.order.id,
      originalLineId: created.order.items[0].lineId,
      quantity: 1,
      reason: "Secondo reso non idempotente",
      idempotencyKey: "strange-46-comp-again",
    }, 409);
    assert.match(rejected.error, /Nessun importo|pagabile/i);
    await releaseTableLock(baseUrl, mobile, "giada-mobile", "sala_terrazza_t20");
  });

  await t.test("47 partially paid delivered order cannot be cancelled and remains payable", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t20",
      roomId: "sala_terrazza",
      tableNumber: 20,
      lines: [line("Americano", 8, 2, { productId: "menu_drink_americano" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t20", "sala_terrazza", created.order.id, 8, {
      idempotencyKey: "strange-47-partial",
      releaseTable: false,
    });
    const rejected = await cancelOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t20",
      roomId: "sala_terrazza",
      orderId: created.order.id,
      expectedRevision: 1,
      reason: "Tentativo annullo dopo acconto",
    }, 409);
    assert.equal(rejected.code, "ORDER_CANCEL_NOT_ALLOWED");
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t20", "sala_terrazza", created.order.id, 8, {
      idempotencyKey: "strange-47-final",
    });
    await releaseTableLock(baseUrl, mobile, "giada-mobile", "sala_terrazza_t20");
  });

  await t.test("48 moving an already paid table does not move historical paid orders", async () => {
    const paid = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t20",
      roomId: "sala_terrazza",
      tableNumber: 20,
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    await readyOrder(baseUrl, station, "station-main", paid.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t20", "sala_terrazza", paid.order.id, 1.3, {
      idempotencyKey: "strange-48-pay",
    });
    const moved = await moveTable(baseUrl, mobile, "giada-mobile", "sala_terrazza_t20", "sala_terrazza_t15");
    assert.equal(moved.movedOrdersCount, 0);
    await releaseTableLock(baseUrl, mobile, "giada-mobile", "sala_terrazza_t20");
    await releaseTableLock(baseUrl, mobile, "giada-mobile", "sala_terrazza_t15");
    const db = await readDb(dbPath);
    assert.equal(findOrder(db, paid.order.id).tableId, "sala_terrazza_t20");
    assert.equal(findTable(db, "sala_terrazza_t15").totalDue, 0);
  });

  await t.test("49 reservation lock conflict blocks another waiter and delete leaves no reservation", async () => {
    const edgeReservationAt = reservationAt + 2 * 60 * 60 * 1000;
    const created = await reservationCreate(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationAt: edgeReservationAt,
      customerName: "Cliente Lock Edge",
      customerPhone: "333999222",
      covers: 2,
      intolerances: [],
      note: "Lock conflict",
      assignedTableId: "room_sala_t05",
    });
    const locked = await reservationLockAcquire(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationId: created.reservation.id,
    });
    const conflict = await reservationLockAcquire(baseUrl, annaMobile, "anna-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationId: created.reservation.id,
    }, 409);
    assert.match(conflict.error, /modifica|operatore/i);
    const fakeUpdate = await reservationUpdate(baseUrl, annaMobile, "anna-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationId: created.reservation.id,
      lockId: "fake-lock",
      patch: { note: "non deve salvare" },
    }, 409);
    assert.match(fakeUpdate.error, /Blocco|modifica|scaduto/i);
    await reservationDelete(baseUrl, mobile, "giada-mobile", {
      roomId: "room_sala",
      serviceDate,
      reservationId: created.reservation.id,
      lockId: locked.lock.lockId,
    });
    const listed = await reservationList(baseUrl, mobile, "giada-mobile", { roomId: "room_sala", serviceDate });
    assert.equal(listed.reservations.some((entry) => entry.id === created.reservation.id), false);
  });

  await t.test("50 out-of-order article-unit payments keep remaining real items visible", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t15",
      roomId: "sala_terrazza",
      tableNumber: 15,
      lines: [
        line("Caffe", 1.3, 3, { productId: "menu_caffetteria_caffe" }),
        line("Americano", 8, 1, { productId: "menu_drink_americano" }),
      ],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t15", "sala_terrazza", created.order.id, 1.3, {
      idempotencyKey: "strange-50-caffe-last-unit",
      releaseTable: false,
      articleUnitIds: [`${created.order.id}_0_2`],
    });
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t15", "sala_terrazza", created.order.id, 1.3, {
      idempotencyKey: "strange-50-caffe-first-unit",
      releaseTable: false,
      articleUnitIds: [`${created.order.id}_0_0`],
    });
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t15", "sala_terrazza", created.order.id, 8, {
      idempotencyKey: "strange-50-americano",
      releaseTable: false,
      articleUnitIds: [`${created.order.id}_1_0`],
    });
    let db = await readDb(dbPath);
    const remainingLines = findTable(db, "sala_terrazza_t15").pendingBills.flatMap((bill) =>
      bill.lines.map((entry) => `${entry.name}:${entry.qty}:${entry.lineTotal}`)
    );
    assert.deepEqual(remainingLines, ["Caffe:1:1.3"]);
    await payFreeSplit(baseUrl, mobile, "giada-mobile", "sala_terrazza_t15", "sala_terrazza", created.order.id, 1.3, {
      idempotencyKey: "strange-50-final-caffe",
      articleUnitIds: [`${created.order.id}_0_1`],
    });
    await releaseTableLock(baseUrl, mobile, "giada-mobile", "sala_terrazza_t15");
    db = await readDb(dbPath);
    assert.equal(findOrder(db, created.order.id).paymentStatus, "paid");
  });

  await t.test("51 mixed cash and card transactions in one payment close exactly and keep notes", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-mobile", {
      tableId: "sala_terrazza_t16",
      roomId: "sala_terrazza",
      tableNumber: 16,
      lines: [line("Americano", 8, 1, { productId: "menu_drink_americano" })],
    });
    await readyOrder(baseUrl, station, "station-main", created.order.id);
    await lockTable(baseUrl, mobile, "giada-mobile", "sala_terrazza_t16", "payment.free_split");
    const paid = await api(baseUrl, mobile, "giada-mobile", "POST", "/api/payments/free-split", {
      tableId: "sala_terrazza_t16",
      roomId: "sala_terrazza",
      orderId: created.order.id,
      splitType: "FREE_SPLIT",
      idempotencyKey: "strange-51-mixed",
      note: "pagamento misto contanti carta",
      parts: [
        {
          amountDue: 8,
          transactions: [
            { method: "CASH", methodId: "pay_cash", methodLabel: "Contanti", amountPaid: 3, cashGiven: 3, note: "quota cash" },
            {
              method: "POS",
              methodId: "pay_card",
              methodLabel: "Carta",
              amountPaid: 5,
              posProvider: "test-pos",
              posTxRef: "STRANGE-51-MIXED",
              note: "quota carta",
            },
          ],
        },
      ],
    });
    assert.equal(paid.payment.status, "COMPLETED");
    const db = await readDb(dbPath);
    assert.equal(findOrder(db, created.order.id).paymentStatus, "paid");
    assert.equal(db.payments.filter((entry) => entry.paymentContainerId === paid.payment.id).length, 2);
    assert.ok(db.payments.some((entry) => entry.note === "quota cash"));
    assert.ok(db.payments.some((entry) => entry.note === "quota carta"));
    assert.equal(paid.transactions.length, 2);
    assert.ok((paid.paymentReceiptJobs ?? []).length >= 2);
    const receiptTexts = paid.paymentReceiptJobs
      .map((job) => db.printSpoolJobs.find((entry) => entry.id === job.id)?.textPreview ?? "")
      .join("\n");
    for (const tx of paid.transactions) {
      assert.match(receiptTexts, /ID TX/);
      assert.match(receiptTexts, new RegExp(escapeRegExp(tx.id.toUpperCase())));
    }
  });

  await t.test("52 table release clears seated metadata and stays free in public layout", async () => {
    const tableId = "sala_terrazza_t01";
    await lockTable(baseUrl, mobile, "giada-mobile", tableId, "table.sync");
    await syncTable(baseUrl, mobile, "giada-mobile", {
      tableId,
      roomId: "sala_terrazza",
      status: "no_orders",
      occupancyState: "seated",
      tableName: "Tavolo 1",
      covers: 4,
      note: "nota da cancellare",
      allergens: ["glutine"],
      manualIntolerance: "lattosio",
      seatedAt: Date.now(),
    });

    await syncTable(baseUrl, mobile, "giada-mobile", {
      tableId,
      roomId: "sala_terrazza",
      status: "free",
      occupancyState: "free",
      tableName: "",
      covers: 0,
    });

    const db = await readDb(dbPath);
    const table = findTable(db, tableId);
    assert.equal(table.status, "free");
    assert.equal(table.guestName, "");
    assert.equal(table.covers, 0);
    assert.equal(table.totalDue, 0);
    assert.deepEqual(table.pendingBills, []);
    assert.equal(table.note, "");
    assert.deepEqual(table.allergens, []);
    assert.equal(table.manualIntolerance, "");
    assert.equal(table.seatedAt, null);
    assert.equal(table.workLock, null);

    const layout = await publicApi(baseUrl, "/api/integration/layout");
    const layoutTable = layout.tables.find((entry) => entry.id === tableId);
    assert.equal(layoutTable.occupancyState, "free");
    assert.equal(layoutTable.amountDue, 0);
    assert.equal(layoutTable.covers, 0);
  });

  await t.test("53 cleanup removes simulated orders, payments, reservations, locks and table dues", async () => {
    await cleanupContinuityRuntimeDb(dbPath);
    const db = await readDb(dbPath);
    assert.deepEqual(db.integration.orders, []);
    assert.deepEqual(db.paymentContainers, []);
    assert.deepEqual(db.payments, []);
    assert.deepEqual(db.printSpoolJobs, []);
    assert.deepEqual(db.tableLocks, []);
    assert.deepEqual(db.posReservationStates, []);
    assert.deepEqual(db.integration.orderComps, []);
    assert.deepEqual(db.integration.orderCorrections, []);
    assert.equal(db.posSettings.tables.every((table) => Number(table.totalDue) === 0), true);
    assert.equal(db.posSettings.tables.every((table) => Array.isArray(table.pendingBills) && table.pendingBills.length === 0), true);
  });
});
