import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInitialAppState } from "../../modules/app-state/index.js";
import { hashPin } from "../../auth/password.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
export const backendDir = path.resolve(testDir, "..", "..");
export const cassaRoot = path.resolve(backendDir, "..");
export const projectRoot = path.resolve(cassaRoot, "..");

export const TEST_TOKEN_SECRET = "test-secret-123456789012345678901234567890";

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function waitForHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const expectStatus = options.expectStatus ?? ((status) => status >= 200 && status < 500);
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (expectStatus(response.status, response)) return response;
      lastError = new Error(`Unexpected status ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

export async function waitForHealth(baseUrl, timeoutMs = 10_000) {
  return waitForHttp(`${baseUrl}/api/health`, {
    timeoutMs,
    expectStatus: (status) => status === 200,
  });
}

export function buildTestState(overrides = {}) {
  const now = new Date().toISOString();
  const state = buildInitialAppState();

  state.sessions = [];
  state.auditEvents = [];
  state.saleSessions = [];
  state.integration.notifications = [];
  state.integration.orders = [];
  state.integration.lastOrderNumber = 0;
  state.integration.stationStates = [
    { station: "BAR-1", active: true, realStation: true, stale: false, updatedAt: now },
    { station: "BAR PRINCIPALE", active: true, realStation: true, stale: false, updatedAt: now },
    { station: "COCKTAIL", active: true, realStation: true, stale: false, updatedAt: now },
    { station: "CAFFETTERIA", active: true, realStation: true, stale: false, updatedAt: now },
  ];
  state.posSettings.workstations = [
    {
      id: "workstation_bar_1",
      name: "BAR-1",
      stationName: "BAR-1",
      active: true,
      status: "active",
      roomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      printerIds: [],
    },
    ...(Array.isArray(state.posSettings.workstations) ? state.posSettings.workstations : []),
  ].filter(
    (entry, index, items) =>
      items.findIndex((candidate) => String(candidate?.id ?? "") === String(entry?.id ?? "")) === index
  );
  state.posSettings.orderWorkflow = {
    ...(state.posSettings.orderWorkflow ?? {}),
    deliveryConfirmationEnabled: false,
    requireReadyForDelivery: false,
    requireDeliveredForPayment: false,
  };
  state.posSettings.mobileDevices = [
    ...(Array.isArray(state.posSettings.mobileDevices) ? state.posSettings.mobileDevices : []),
    "pay-mobile-v2-device",
    "pay-table-device",
    "pay-idem-device",
    "pay-over-device",
  ]
    .map((entry) =>
      typeof entry === "string"
        ? {
            id: entry,
            deviceId: entry,
            name: entry,
            fiscalEnabled: true,
            electronicPaymentEnabled: true,
            cashPaymentEnabled: true,
          }
        : entry
    )
    .filter(
      (entry, index, items) =>
        entry &&
        items.findIndex((candidate) => String(candidate?.deviceId ?? candidate?.id ?? "") === String(entry.deviceId ?? entry.id ?? "")) === index
    );
  state.posSettings.fiscalDevices = [
    ...(Array.isArray(state.posSettings.fiscalDevices) ? state.posSettings.fiscalDevices : []),
    {
      id: "rt_test_pos_fiscal",
      name: "RT Test POS Fiscal",
      type: "api",
      fiscalProvider: "pos-fiscal-api",
      apiBaseUrl: "http://127.0.0.1:9",
      statusEndpoint: "/api/fiscal/status",
      receiptEndpoint: "/api/fiscal/receipt",
      reprintEndpoint: "/api/fiscal/reprint",
      paymentMethodIds: ["pay_cash", "pay_card"],
      supportsCash: true,
      supportsElectronic: true,
      supportsReprint: true,
      active: true,
    },
  ].filter(
    (entry, index, items) =>
      entry &&
      items.findIndex((candidate) => String(candidate?.id ?? candidate?.fiscalDeviceId ?? "") === String(entry.id ?? entry.fiscalDeviceId ?? "")) === index
  );

  const extraTableIds = new Set([
    "room_pedana_t05",
    "room_pedana_t06",
    "room_pedana_t07",
    "room_pedana_t08",
    "room_sala_t01",
    "room_sala_t02",
    "sala_terrazza_t01",
  ]);
  state.posSettings.rooms = [
    { id: "room_pedana", roomId: "room_pedana", name: "Pedana", label: "Pedana", enabled: true },
    { id: "room_sala", roomId: "room_sala", name: "Sala", label: "Sala", enabled: true },
    { id: "sala_terrazza", roomId: "sala_terrazza", name: "Terrazza", label: "Terrazza", enabled: true },
    ...(Array.isArray(state.posSettings.rooms) ? state.posSettings.rooms : []),
  ].filter((entry, index, items) => items.findIndex((candidate) => candidate.id === entry.id) === index);
  state.posSettings.tables = [
    {
      id: "room_pedana_t05",
      number: 5,
      type: "Pedana",
      roomId: "room_pedana",
      status: "free",
      covers: 0,
      totalDue: 0,
      pendingBills: [],
    },
    {
      id: "room_pedana_t06",
      number: 6,
      type: "Pedana",
      roomId: "room_pedana",
      status: "free",
      covers: 0,
      totalDue: 0,
      pendingBills: [],
    },
    {
      id: "room_pedana_t07",
      number: 7,
      type: "Pedana",
      roomId: "room_pedana",
      status: "free",
      covers: 0,
      totalDue: 0,
      pendingBills: [],
    },
    {
      id: "room_pedana_t08",
      number: 8,
      type: "Pedana",
      roomId: "room_pedana",
      status: "free",
      covers: 0,
      totalDue: 0,
      pendingBills: [],
    },
    {
      id: "room_sala_t01",
      number: 1,
      type: "Sala",
      roomId: "room_sala",
      status: "free",
      covers: 0,
      totalDue: 0,
      pendingBills: [],
    },
    {
      id: "room_sala_t02",
      number: 2,
      type: "Sala",
      roomId: "room_sala",
      status: "free",
      covers: 0,
      totalDue: 0,
      pendingBills: [],
    },
    {
      id: "sala_terrazza_t01",
      number: 1,
      type: "Terrazza",
      roomId: "sala_terrazza",
      status: "free",
      covers: 0,
      totalDue: 0,
      pendingBills: [],
    },
    ...(Array.isArray(state.posSettings.tables) ? state.posSettings.tables : []).filter(
      (table) => !extraTableIds.has(String(table?.id ?? ""))
    ),
  ];

  state.users = [
    {
      id: "u_admin",
      username: "admin_test",
      fullName: "Admin Test",
      role: "admin",
      roleLabel: "Amministratore",
      permissions: [
        "manage_users",
        "manage_settings",
        "manage_reservations",
        "manage_menu",
        "manage_tables",
        "manage_sale_sessions",
        "approve_room_change",
        "collect_payments",
        "open_drawer",
        "print_orders",
        "fiscal_operations",
        "override_order_price",
        "manage_smart_customers",
        "view_analytics",
      ],
      authorizedRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      enabledRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      pinHash: hashPin("1111"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_cashier",
      username: "cashier",
      fullName: "Cashier Test",
      role: "operator",
      roleLabel: "Operatore",
      permissions: ["collect_payments", "print_orders", "view_analytics", "create_bar_replacement"],
      authorizedRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      enabledRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      pinHash: hashPin("2222"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_waiter",
      username: "waiter",
      fullName: "Waiter Test",
      role: "operator",
      roleLabel: "Operatore",
      permissions: [],
      authorizedRoomIds: ["room_pedana"],
      enabledRoomIds: ["room_pedana"],
      pinHash: hashPin("3333"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_manager",
      username: "manager",
      fullName: "Manager Test",
      role: "responsabile",
      roleLabel: "Responsabile",
      permissions: [
        "manage_settings",
        "manage_reservations",
        "manage_menu",
        "manage_tables",
        "manage_sale_sessions",
        "approve_room_change",
        "collect_payments",
        "fiscal_operations",
        "print_orders",
        "override_order_price",
      ],
      authorizedRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      enabledRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      pinHash: hashPin("4444"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_ultra_admin",
      username: "ultra_admin",
      fullName: "Ultra Admin Test",
      role: "admin",
      roleLabel: "Amministratore",
      permissions: [
        "manage_users",
        "manage_settings",
        "manage_reservations",
        "manage_menu",
        "manage_tables",
        "manage_sale_sessions",
        "approve_room_change",
        "collect_payments",
        "open_drawer",
        "print_orders",
        "fiscal_operations",
        "override_order_price",
        "manage_smart_customers",
        "view_analytics",
      ],
      authorizedRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      enabledRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      pinHash: hashPin("1111"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_ultra_cashier",
      username: "ultra_cashier",
      fullName: "Ultra Cashier Test",
      role: "operator",
      roleLabel: "Operatore",
      permissions: ["collect_payments", "print_orders", "view_analytics", "create_bar_replacement"],
      authorizedRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      enabledRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      pinHash: hashPin("2222"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_ultra_waiter",
      username: "ultra_waiter",
      fullName: "Ultra Waiter Test",
      role: "operator",
      roleLabel: "Operatore",
      permissions: [],
      authorizedRoomIds: ["room_pedana"],
      enabledRoomIds: ["room_pedana"],
      pinHash: hashPin("3333"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_ultra_manager",
      username: "ultra_manager",
      fullName: "Ultra Manager Test",
      role: "responsabile",
      roleLabel: "Responsabile",
      permissions: [
        "manage_settings",
        "manage_reservations",
        "manage_menu",
        "manage_tables",
        "manage_sale_sessions",
        "approve_room_change",
        "collect_payments",
        "fiscal_operations",
        "print_orders",
        "override_order_price",
      ],
      authorizedRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      enabledRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      pinHash: hashPin("4444"),
      createdAt: now,
      updatedAt: now,
    },
  ];

  state.saleSessionTemplates = [
    { id: "shift_day", name: "Diurna", startTime: "08:00", endTime: "20:00", enabled: true },
    { id: "shift_night", name: "Notturna", startTime: "20:00", endTime: "04:00", enabled: true },
  ];

  state.meta.lastWriteAt = now;
  if (typeof overrides === "function") {
    overrides(state);
  }
  return state;
}

export async function createTempRunDir(prefix = "apptocheck-test") {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

export async function writeTestDb(dbPath, overrides = {}) {
  const state = buildTestState(overrides);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function startBackend(t, options = {}) {
  const port = options.port ?? (await freePort());
  const runDir = options.runDir ?? (await createTempRunDir("apptocheck-backend"));
  const dbPath = options.dbPath ?? path.join(runDir, "app-state.json");
  if (!options.preserveDb) {
    await writeTestDb(dbPath, options.stateOverrides);
  }

  const child = spawn(process.execPath, ["backend/server.js"], {
    cwd: cassaRoot,
    env: {
      ...process.env,
      INVOCATION_ID: "",
      JOURNAL_STREAM: "",
      NODE_ENV: "test",
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(port),
      PORT: String(port),
      BACKEND_DB_MODE: "json",
      BACKEND_DB_PATH: dbPath,
      BACKEND_TOKEN_SECRET: TEST_TOKEN_SECRET,
      FISCAL_PROVIDER: "mock",
      PRINTING_ENABLED: "0",
      SMART_CARD_READER_MODE: "push",
      SMART_CARD_PUSH_TOKEN: "test-smart-card-token",
      SMART_CARD_AUTO_DETECT: "0",
      ENABLE_DEBUG_ENDPOINTS: "0",
      ENABLE_MAINTENANCE_ENDPOINTS: "0",
      CORS_ALLOWED_ORIGINS: options.corsAllowedOrigins ?? "",
      ...options.env,
    },
    stdio: options.stdio ?? ["ignore", "ignore", "ignore"],
  });

  t?.after?.(() => {
    if (!child.killed) child.kill();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, options.timeoutMs ?? 10_000);
  return { baseUrl, child, dbPath, port, runDir };
}

export async function startFrontendServer(t, options = {}) {
  const port = options.port ?? (await freePort());
  const child = spawn(process.execPath, ["serve-frontends.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      FRONTEND_HOST: "127.0.0.1",
      FRONTEND_PORT: String(port),
      BACKEND_ORIGIN: options.backendOrigin,
      FRONTEND_ROOT: projectRoot,
      ...options.env,
    },
    stdio: options.stdio ?? ["ignore", "ignore", "ignore"],
  });

  t?.after?.(() => {
    if (!child.killed) child.kill();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHttp(`${baseUrl}/mobile/`, {
    timeoutMs: options.timeoutMs ?? 10_000,
    expectStatus: (status) => status === 200,
  });
  return { baseUrl, child, port };
}

export async function login(baseUrl, username = "cashier", pin = "2222", options = {}) {
  const deviceUuid = options.deviceUuid ?? `${username}-device`;
  const clientApp = options.clientApp ?? "cassa-frontend";
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: JSON.stringify({ username, pin, deviceUuid, clientApp }),
  });
  return response;
}

export async function loginJson(baseUrl, username = "cashier", pin = "2222", options = {}) {
  const response = await login(baseUrl, username, pin, options);
  assert.equal(response.status, 200);
  return response.json();
}

export function authHeaders(session, deviceUuid = "cashier-device") {
  return {
    Authorization: `Bearer ${session.token}`,
    "X-User-Id": session.user.id,
    "X-Device-Uuid": deviceUuid,
    "Content-Type": "application/json",
  };
}

export function authPayload(session, deviceUuid = "cashier-device", extra = {}) {
  return {
    token: session.token,
    userId: session.user.id,
    deviceUuid,
    ...extra,
  };
}

export async function apiPost(baseUrl, pathName, payload = {}, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

export async function acquireTableLock(baseUrl, session, tableId, options = {}) {
  return apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, options.deviceUuid ?? "cashier-device", {
      tableId,
      purpose: options.purpose ?? "test",
    })
  );
}

export async function createSimpleOrder(baseUrl, session, options = {}) {
  const deviceUuid = options.deviceUuid ?? "cashier-device";
  const payload = authPayload(session, deviceUuid, {
    source: options.source ?? "mobile-frontend",
    clientApp: options.clientApp ?? "mobile-frontend",
    tableId: options.tableId ?? "room_pedana_t05",
    roomId: options.roomId ?? "room_pedana",
    tableNumber: options.tableNumber ?? 5,
    lines: options.lines ?? [
      {
        name: "Caffe",
        productId: "menu_caffetteria_caffe",
        qty: 1,
        price: 1.3,
      },
    ],
    ...options.extraPayload,
  });
  return apiPost(baseUrl, "/api/integration/orders/create", payload);
}
