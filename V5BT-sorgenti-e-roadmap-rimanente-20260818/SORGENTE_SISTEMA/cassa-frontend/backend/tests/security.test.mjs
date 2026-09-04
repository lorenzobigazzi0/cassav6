import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildInitialAppState } from "../app-state/initial-state.js";
import { hashPin } from "../auth/password.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(testDir, "..");
const projectRoot = path.resolve(backendDir, "..", "..");

function freePort() {
  return 5300 + Math.trunc(Math.random() * 1000);
}

async function waitForHealth(baseUrl, timeoutMs = 8000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("Backend did not become healthy.");
}

async function writeTestDb(dbPath, mutateState = null) {
  const state = buildInitialAppState();
  const now = new Date().toISOString();
  for (const item of Array.isArray(state.menuItems) ? state.menuItems : []) {
    if (item?.id === "menu_drink_gin_tonic" || item?.id === "menu_drink_gin_lemon") {
      delete item.variants;
      delete item.variantRequired;
    }
  }
  const table = {
    id: "room_pedana_t05",
    number: 5,
    type: "Pedana",
    roomId: "room_pedana",
    status: "payment_due",
    covers: 2,
    totalDue: 10,
    pendingBills: [
      {
        id: "bill_00004",
        orderId: "00004",
        orderIds: ["00004"],
        subtotal: 10,
        createdAt: now,
        lines: [{ name: "Caffe", qty: 1, unitPrice: 10, lineTotal: 10, productId: "coffee", lineId: "line_1" }],
      },
    ],
  };
  const room2Table = {
    id: "room_sala_t01",
    number: 1,
    type: "Sala",
    roomId: "room_sala",
    status: "free",
    covers: 0,
    totalDue: 0,
    pendingBills: [],
  };
  const correctionTable = {
    id: "room_pedana_t06",
    number: 6,
    type: "Pedana",
    roomId: "room_pedana",
    status: "waiting",
    covers: 2,
    totalDue: 1.3,
    pendingBills: [],
  };
  state.posSettings.tables = [table, correctionTable, room2Table, ...(Array.isArray(state.posSettings.tables) ? state.posSettings.tables : [])]
    .filter((entry, index, items) => items.findIndex((candidate) => candidate.id === entry.id) === index);
  state.posSettings.workstations = [
    {
      id: "workstation_bar_1",
      name: "BAR-1",
      stationName: "BAR-1",
      active: true,
      status: "active",
      roomIds: ["room_pedana", "room_sala"],
      printerIds: [],
    },
    ...(Array.isArray(state.posSettings.workstations) ? state.posSettings.workstations : []),
  ].filter(
    (entry, index, items) =>
      items.findIndex((candidate) => String(candidate?.id ?? "") === String(entry?.id ?? "")) === index
  );
  state.integration.stationStates = [
    { station: "BAR-1", active: true, realStation: true, stale: false, updatedAt: now },
    { station: "BAR PRINCIPALE", active: true, realStation: true, stale: false, updatedAt: now },
  ];
  state.integration.orders = [
    {
      id: "00004",
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      tableNumber: 5,
      status: "delivered",
      workflowStatus: "delivered",
      paymentStatus: "unpaid",
      total: 10,
      paidAmount: 0,
      dueAmount: 10,
      revision: 1,
      currentRevision: 1,
      items: [
        {
          id: "oi_1",
          lineId: "line_1",
          productId: "menu_caffetteria_caffe",
          productNameSnapshot: "Caffe",
          name: "Caffe",
          qty: 1,
          unitPriceApplied: 10,
          listPriceAtTime: 10,
          lineTotal: 10,
          routeStations: ["BAR PRINCIPALE"],
          done: true,
        },
      ],
      lines: [{ id: "line_1", productId: "coffee", name: "Caffe", qty: 1, unitPrice: 10, lineTotal: 10 }],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "00005",
      tableId: "room_pedana_t06",
      roomId: "room_pedana",
      tableNumber: 6,
      workflowStatus: "waiting",
      paymentStatus: "unpaid",
      total: 1.3,
      paidAmount: 0,
      dueAmount: 1.3,
      revision: 1,
      currentRevision: 1,
      items: [
        {
          id: "oi_1",
          lineId: "line_1",
          productId: "menu_caffetteria_caffe",
          productNameSnapshot: "Caffe",
          name: "Caffe",
          qty: 1,
          unitPriceApplied: 1.3,
          listPriceAtTime: 1.3,
          lineTotal: 1.3,
          routeStations: ["BAR PRINCIPALE"],
          done: false,
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "00006",
      tableId: "room_pedana_t06",
      roomId: "room_pedana",
      tableNumber: 6,
      workflowStatus: "prep",
      paymentStatus: "unpaid",
      total: 1.3,
      paidAmount: 0,
      dueAmount: 1.3,
      revision: 1,
      currentRevision: 1,
      items: [
        {
          id: "oi_1",
          lineId: "line_1",
          productId: "menu_caffetteria_caffe",
          productNameSnapshot: "Caffe",
          name: "Caffe",
          qty: 1,
          unitPriceApplied: 1.3,
          listPriceAtTime: 1.3,
          lineTotal: 1.3,
          routeStations: ["BAR PRINCIPALE"],
          done: false,
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
  ];
  state.users = [
    {
      id: "u_admin",
      username: "admin_test",
      fullName: "Admin Test",
      role: "admin",
      roleLabel: "Amministratore",
      permissions: ["manage_users"],
      authorizedRoomIds: [],
      enabledRoomIds: [],
      pinHash: hashPin("1111"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_cashier",
      username: "cashier",
      fullName: "Cashier",
      role: "operator",
      roleLabel: "Operatore",
      permissions: [
        "collect_payments",
        "view_analytics",
        "open_drawer",
        "print_orders",
        "fiscal_operations",
        "create_bar_replacement",
      ],
      authorizedRoomIds: ["room_pedana"],
      enabledRoomIds: ["room_pedana", "room_sala"],
      pinHash: hashPin("2222"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_cashier_b",
      username: "cashier_b",
      fullName: "Cashier B",
      role: "operator",
      roleLabel: "Operatore",
      permissions: ["collect_payments", "view_analytics", "create_bar_replacement"],
      authorizedRoomIds: ["room_pedana"],
      enabledRoomIds: ["room_pedana", "room_sala"],
      pinHash: hashPin("4444"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_viewer",
      username: "viewer",
      fullName: "Viewer",
      role: "operator",
      roleLabel: "Operatore",
      permissions: [],
      authorizedRoomIds: ["room_pedana"],
      enabledRoomIds: ["room_pedana", "room_sala"],
      pinHash: hashPin("3333"),
      createdAt: now,
      updatedAt: now,
    },
  ];
  state.meta.lastWriteAt = now;
  if (typeof mutateState === "function") {
    mutateState(state, now);
  }
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function startBackend(t, env = {}, mutateState = null) {
  const port = freePort();
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), `apptocheck-security-${port}-`));
  const dbPath = path.join(runDir, "app-state.json");
  await writeTestDb(dbPath, mutateState);
  const child = spawn(process.execPath, ["backend/server.js"], {
    cwd: path.resolve(projectRoot, "cassa-frontend"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      BACKEND_PORT: String(port),
      BACKEND_DB_MODE: "json",
      BACKEND_DB_PATH: dbPath,
      BACKEND_TOKEN_SECRET: "test-secret-123456789012345678901234567890",
      CORS_ALLOWED_ORIGINS: "http://allowed.example",
      FISCAL_PROVIDER: "mock",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (!child.killed) child.kill();
  });
  child.once("exit", (code) => {
    if (code && code !== 0 && !child.killed) {
      throw new Error(`Backend exited with ${code}`);
    }
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  return { baseUrl, child, dbPath };
}

async function login(
  baseUrl,
  username,
  pin,
  deviceUuid = "test-device",
  clientApp = "cassa",
  extra = {},
) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, pin, deviceUuid, clientApp, ...extra }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function authHeaders(session, deviceUuid = "test-device") {
  return {
    Authorization: `Bearer ${session.token}`,
    "X-User-Id": session.user.id,
    "X-Device-Uuid": deviceUuid,
    "Content-Type": "application/json",
  };
}

async function lockTable(baseUrl, session, deviceUuid, tableId, purpose = "payment.free_split") {
  const response = await fetch(`${baseUrl}/api/tables/lock/acquire`, {
    method: "POST",
    headers: authHeaders(session, deviceUuid),
    body: JSON.stringify({ tableId, purpose }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("health is public and does not expose internal DB path", async (t) => {
  const { baseUrl } = await startBackend(t);
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "cash-backend");
  assert.deepEqual(body.database, { ok: true, mode: "json" });
  assert.deepEqual(body.postgresql, { enabled: false, ok: true });
  assert.equal(Object.hasOwn(body, "fiscal"), false);
  assert.equal(Object.hasOwn(body, "dbPath"), false);
  assert.equal(Object.hasOwn(body, "tokenHash"), false);
});

test("health becomes unavailable when persistence is unreachable", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  await fs.rename(dbPath, `${dbPath}.unreachable`);

  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.deepEqual(body.database, { ok: false });
  assert.equal(Object.hasOwn(body, "fiscal"), false);
  assert.equal(Object.hasOwn(body, "dbPath"), false);
});

test("sensitive endpoints require auth and permissions", async (t) => {
  const { baseUrl } = await startBackend(t);
  let response = await fetch(`${baseUrl}/api/payments/table`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableId: "room_pedana_t05", paymentMethodId: "pay_cash" }),
  });
  assert.equal(response.status, 401);

  const viewer = await login(baseUrl, "viewer", "3333", "viewer-device");
  response = await fetch(`${baseUrl}/api/payments/table`, {
    method: "POST",
    headers: authHeaders(viewer, "viewer-device"),
    body: JSON.stringify({ tableId: "room_pedana_t05", paymentMethodId: "pay_cash" }),
  });
  assert.equal(response.status, 403);

  for (const [pathName, permissionUserStatus] of [
    ["/api/reports/sales", 403],
    ["/api/integration/drawer/open", 403],
    ["/api/integration/print", 403],
    ["/api/fiscal/command", 403],
    ["/api/integration/orders/line/price-override", 403],
    ["/api/actions", 403],
    ["/api/settings/pos/assign-bill", 403],
    ["/api/integration/layout/table/move", 403],
  ]) {
    const denied = await fetch(`${baseUrl}${pathName}`, {
      method: "POST",
      headers: authHeaders(viewer, "viewer-device"),
      body: JSON.stringify({ command: "status", text: "x" }),
    });
    assert.equal(denied.status, permissionUserStatus, pathName);
  }
});

test("same account login only revokes the previous session for the same app and device", async (t) => {
  const { baseUrl } = await startBackend(t);
  const first = await login(baseUrl, "cashier", "2222", "cashier-device-a");

  let response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: authHeaders(first, "cashier-device-a"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);

  const firstRefreshed = await login(baseUrl, "cashier", "2222", "cashier-device-a");
  response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: authHeaders(first, "cashier-device-a"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 401);

  response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: authHeaders(firstRefreshed, "cashier-device-a"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);

  const second = await login(baseUrl, "cashier", "2222", "cashier-device-b");
  response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: authHeaders(firstRefreshed, "cashier-device-a"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: authHeaders(second, "cashier-device-b"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);

  const otherUser = await login(baseUrl, "cashier_b", "4444", "cashier-b-device");
  response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: authHeaders(second, "cashier-device-b"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: authHeaders(otherUser, "cashier-b-device"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
});

test("postazione login dello stesso operatore non revoca altri device", async (t) => {
  const { baseUrl } = await startBackend(t);
  const first = await login(baseUrl, "cashier", "2222", "station-device-a", "postazione");
  const second = await login(baseUrl, "cashier", "2222", "station-device-b", "postazione");

  let response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: authHeaders(first, "station-device-a"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: authHeaders(second, "station-device-b"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);

  const firstRefreshed = await login(baseUrl, "cashier", "2222", "station-device-a", "postazione");
  response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: authHeaders(first, "station-device-a"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 401);

  response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: authHeaders(firstRefreshed, "station-device-a"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
});

test("debug mock-db endpoint is unavailable by default", async (t) => {
  const { baseUrl } = await startBackend(t);
  const response = await fetch(`${baseUrl}/api/mock-db`);
  assert.equal(response.status, 404);
});

test("CORS rejects unknown origins and allows configured origins", async (t) => {
  const { baseUrl } = await startBackend(t);
  const rejected = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "http://evil.example" } });
  assert.equal(rejected.status, 403);

  const allowed = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "http://allowed.example" } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://allowed.example");
});

test("production config rejects missing backend token secret", async () => {
  const child = spawn(process.execPath, ["backend/server.js"], {
    cwd: path.resolve(projectRoot, "cassa-frontend"),
    env: {
      ...process.env,
      NODE_ENV: "production",
      BACKEND_PORT: String(freePort()),
      BACKEND_TOKEN_SECRET: "",
      SMART_CARD_PUSH_TOKEN: "smart-card-token",
      FISCAL_PROVIDER: "real-provider",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
});

test("free split preserves tableId and orderId separately", async (t) => {
  const { baseUrl } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");
  await lockTable(baseUrl, cashier, "cashier-device", "room_pedana_t05");
  const response = await fetch(`${baseUrl}/api/payments/free-split`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      orderId: "00004",
      splitType: "FREE_SPLIT",
      parts: [
        {
          amountDue: 10,
          transactions: [{ method: "CASH", amountPaid: 10, cashGiven: 10 }],
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.payment.tableId, "room_pedana_t05");
  assert.equal(body.payment.orderId, "00004");
  assert.deepEqual(body.payment.orderIds, ["00004"]);
  assert.notEqual(body.payment.orderId, "room_pedana_t05");
});

test("free split rejects overpayment and billIds from another table", async (t) => {
  const { baseUrl } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");

  await lockTable(baseUrl, cashier, "cashier-device", "room_pedana_t05");
  let response = await fetch(`${baseUrl}/api/payments/free-split`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      orderId: "00004",
      splitType: "FREE_SPLIT",
      parts: [
        {
          amountDue: 11,
          transactions: [{ method: "CASH", amountPaid: 11, cashGiven: 11 }],
        },
      ],
    }),
  });
  assert.equal(response.status, 409);
  let body = await response.json();
  assert.equal(body.code, "PAYMENT_OVERPAYMENT");

  await lockTable(baseUrl, cashier, "cashier-device", "room_pedana_t06");
  response = await fetch(`${baseUrl}/api/payments/free-split`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      tableId: "room_pedana_t06",
      roomId: "room_pedana",
      billIds: ["bill_00004"],
      splitType: "FREE_SPLIT",
      parts: [
        {
          amountDue: 10,
          transactions: [{ method: "CASH", amountPaid: 10, cashGiven: 10 }],
        },
      ],
    }),
  });
  assert.equal(response.status, 400);
  body = await response.json();
  assert.equal(body.code, "PAYMENT_BILL_NOT_IN_TABLE");
});

test("mobile room settings expose enabled and authorized separately", async (t) => {
  const { baseUrl } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");
  const response = await fetch(`${baseUrl}/api/pos/rooms`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.rooms.map((room) => room.roomId).sort(),
    [...body.enabledRoomIds].sort(),
  );
  assert.equal(body.rooms.every((room) => room.enabled === true), true);
  const pedana = body.rooms.find((room) => room.roomId === "room_pedana");
  const sala = body.rooms.find((room) => room.roomId === "room_sala");
  assert.equal(pedana.enabled, true);
  assert.equal(pedana.authorized, true);
  assert.equal(pedana.requiresAdminAuth, false);
  assert.equal(sala.enabled, true);
  assert.equal(sala.authorized, false);
  assert.equal(sala.requiresAdminAuth, true);
});

test("custom rooms from areas and table roomId are exposed without hardcoded room names", async (t) => {
  const { baseUrl } = await startBackend(t, {}, (state) => {
    state.posSettings.areas = [
      ...(Array.isArray(state.posSettings.areas) ? state.posSettings.areas : []),
      {
        id: "room_rooftop",
        name: "Rooftop",
        notes: "",
        menuIds: [],
        waiterUserIds: [],
        printerIds: [],
        cashPoints: [],
        workstations: [],
      },
      {
        id: "room_veranda",
        name: "Veranda",
        minimumTables: 2,
        notes: "",
        menuIds: [],
        waiterUserIds: [],
        printerIds: [],
        cashPoints: [],
        workstations: [],
      },
    ];
    state.posSettings.tables.push({
      id: "room_rooftop_t01",
      number: 1,
      type: "Sala",
      roomId: "room_rooftop",
      status: "free",
      covers: 0,
      totalDue: 0,
      pendingBills: [],
    });
    const cashier = state.users.find((user) => user.id === "u_cashier");
    cashier.enabledRoomIds = ["room_pedana", "room_sala", "room_rooftop", "room_veranda"];
    cashier.authorizedRoomIds = ["room_pedana", "room_rooftop", "room_veranda"];
  });
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");

  let response = await fetch(`${baseUrl}/api/pos/rooms`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  const roomsBody = await response.json();
  const rooftop = roomsBody.rooms.find((room) => room.roomId === "room_rooftop");
  const veranda = roomsBody.rooms.find((room) => room.roomId === "room_veranda");
  assert.equal(rooftop?.roomName, "Rooftop");
  assert.equal(rooftop?.authorized, true);
  assert.equal(veranda?.roomName, "Veranda");
  assert.equal(veranda?.authorized, true);

  response = await fetch(`${baseUrl}/api/integration/layout`);
  assert.equal(response.status, 200);
  const layout = await response.json();
  const rooftopTable = layout.tables.find((table) => table.id === "room_rooftop_t01");
  assert.equal(rooftopTable?.roomId, "room_rooftop");
  assert.equal(rooftopTable?.roomName, "Rooftop");
  assert.equal(layout.rooms.find((room) => room.id === "room_veranda")?.tablesCount, 2);
});

test("user management saves enabledRoomIds and keeps authorizedRoomIds inside them", async (t) => {
  const { baseUrl } = await startBackend(t);
  const admin = await login(baseUrl, "admin_test", "1111", "admin-device");

  let response = await fetch(`${baseUrl}/api/settings/pos/users`, {
    method: "POST",
    headers: authHeaders(admin, "admin-device"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  const current = await response.json();
  const users = current.users.map((user) =>
    user.id === "u_cashier"
      ? {
          ...user,
          enabledRoomIds: ["room_sala"],
          authorizedRoomIds: ["room_sala", "room_pedana"],
        }
      : user
  );

  response = await fetch(`${baseUrl}/api/settings/pos/users/save`, {
    method: "POST",
    headers: authHeaders(admin, "admin-device"),
    body: JSON.stringify({ users }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const cashier = body.users.find((user) => user.id === "u_cashier");
  assert.deepEqual(cashier.enabledRoomIds, ["room_sala"]);
  assert.deepEqual(cashier.authorizedRoomIds, ["room_sala"]);
});

test("last selected room is persisted per user and exposed as initial mobile room", async (t) => {
  const { baseUrl } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");

  let response = await fetch(`${baseUrl}/api/pos/room-change/request`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({ targetRoomId: "room_pedana" }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/pos/rooms`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.lastSelectedRoomId, "room_pedana");
  assert.equal(body.initialRoom.roomId, "room_pedana");
  assert.equal(body.initialRoom.requiresAdminAuth, false);
});

test("static server rejects encoded traversal", async (t) => {
  const port = freePort();
  const child = spawn(process.execPath, ["serve-frontends.mjs"], {
    cwd: projectRoot,
    env: { ...process.env, FRONTEND_PORT: String(port), BACKEND_ORIGIN: "http://127.0.0.1:9" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (!child.killed) child.kill();
  });
  await new Promise((resolve, reject) => {
    let stderr = "";
    let timeout;
    const finish = (callback) => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    };
    const onStdout = (chunk) => {
      if (String(chunk).includes("Static server attivo")) {
        finish(resolve);
      }
    };
    const onStderr = (chunk) => {
      stderr += String(chunk);
    };
    const onError = (error) => finish(() => reject(error));
    const onExit = (code, signal) => {
      finish(() => reject(new Error(
        `Static server exited before readiness (code=${code}, signal=${signal}). ${stderr}`.trim()
      )));
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    timeout = setTimeout(() => {
      finish(() => reject(
        new Error(`Static server did not become ready. ${stderr}`.trim())
      ));
    }, 8000);
  });
  const statusCode = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: "/img/%2e%2e/serve-frontends.mjs",
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(statusCode, 400);
});

test("table workLock blocks concurrent mutation and supports force release", async (t) => {
  const { baseUrl } = await startBackend(t);
  const cashierA = await login(baseUrl, "cashier", "2222", "cashier-a");
  const cashierB = await login(baseUrl, "cashier_b", "4444", "cashier-b");
  const admin = await login(baseUrl, "admin_test", "1111", "admin-device");

  let response = await fetch(`${baseUrl}/api/tables/lock/acquire`, {
    method: "POST",
    headers: authHeaders(cashierA, "cashier-a"),
    body: JSON.stringify({ tableId: "room_pedana_t05", purpose: "edit" }),
  });
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.lock.userId, "u_cashier");

  response = await fetch(`${baseUrl}/api/tables/lock/acquire`, {
    method: "POST",
    headers: authHeaders(cashierB, "cashier-b"),
    body: JSON.stringify({ tableId: "room_pedana_t05", purpose: "edit" }),
  });
  assert.equal(response.status, 409);
  body = await response.json();
  assert.equal(body.code, "TABLE_LOCKED");

  response = await fetch(`${baseUrl}/api/tables/lock/acquire`, {
    method: "POST",
    headers: authHeaders(cashierB, "cashier-b"),
    body: JSON.stringify({ tableId: "room_pedana_t06", purpose: "edit" }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/tables/lock/heartbeat`, {
    method: "POST",
    headers: authHeaders(cashierA, "cashier-a"),
    body: JSON.stringify({ tableId: "room_pedana_t05" }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/tables/lock/force-release`, {
    method: "POST",
    headers: authHeaders(admin, "admin-device"),
    body: JSON.stringify({ tableId: "room_pedana_t05" }),
  });
  assert.equal(response.status, 200);
});

test("cancelled mobile order clears due, blocks ready sync, and disables old cash approval flow", async (t) => {
  const { baseUrl } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");
  const admin = await login(baseUrl, "admin_test", "1111", "admin-device");

  let response = await fetch(`${baseUrl}/api/tables/lock/acquire`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({ tableId: "room_pedana_t06", purpose: "order.cancel" }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/integration/orders/cancel`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      orderId: "00005",
      tableId: "room_pedana_t06",
      roomId: "room_pedana",
      expectedRevision: 1,
      reason: "Test annullamento",
    }),
  });
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.order.workflowStatus, "cancelled");
  assert.equal(body.order.paymentStatus, "paid");
  assert.equal(body.order.total, 0);
  assert.equal(body.order.dueAmount, 0);
  assert.equal(
    body.order.items.every((item) => typeof item.voidedAt === "string" && item.voidedAt.length > 0),
    true
  );

  response = await fetch(`${baseUrl}/api/integration/orders?orderId=00005&includeDone=1`, {
    method: "GET",
    headers: authHeaders(cashier, "cashier-device"),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  const cancelled = body.orders.find((order) => order.id === "00005");
  assert.equal(cancelled.workflowStatus, "cancelled");
  assert.equal(cancelled.dueAmount, 0);

  response = await fetch(`${baseUrl}/api/integration/orders/sync`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      id: "00005",
      order: {
        ...cancelled,
        workflowStatus: "ready",
        items: cancelled.items.map((item) => ({ ...item, done: true })),
      },
    }),
  });
  assert.equal(response.status, 409);
  body = await response.json();
  assert.equal(body.code, "ORDER_CANCELLED");

  response = await fetch(`${baseUrl}/api/integration/orders/correct/pending`, {
    method: "GET",
    headers: authHeaders(cashier, "cashier-device"),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.disabled, true);
  assert.deepEqual(body.requests, []);

  response = await fetch(`${baseUrl}/api/integration/orders/correct/resolve`, {
    method: "POST",
    headers: authHeaders(admin, "admin-device"),
    body: JSON.stringify({ requestId: "legacy", decision: "approve" }),
  });
  assert.equal(response.status, 410);
  body = await response.json();
  assert.equal(body.code, "ORDER_CORRECTION_APPROVAL_DISABLED");
});

test("order status sync is authenticated, ignores table workLock, and audits authenticated actor", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");
  const viewer = await login(baseUrl, "viewer", "3333", "viewer-device");

  let response = await fetch(`${baseUrl}/api/tables/lock/acquire`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({ tableId: "room_pedana_t06", purpose: "edit" }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/integration/orders/sync`, {
    method: "POST",
    headers: authHeaders(viewer, "viewer-device"),
    body: JSON.stringify({
      id: "00005",
      userId: "u_admin",
      username: "admin_test",
      order: {
        workflowStatus: "prep",
        station: "BAR PRINCIPALE",
        ownerStation: "BAR PRINCIPALE",
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.order.workflowStatus, "prep");
  assert.equal(body.order.lockedByUserId, "u_viewer");

  const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const statusAudit = persisted.auditEvents.find(
    (entry) => entry.action === "order.status_changed" && entry.entityId === "00005"
  );
  assert.equal(statusAudit.actorUserId, "u_viewer");
  assert.notEqual(statusAudit.actorUserId, "u_admin");

  response = await fetch(`${baseUrl}/api/integration/orders/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "00005",
      order: { workflowStatus: "ready" },
    }),
  });
  assert.equal(response.status, 401);
});

test("order correction after station checkbox keeps only already prepared quantity done", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const persistedSeed = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const order = persistedSeed.integration.orders.find((entry) => entry.id === "00005");
  order.items.push({
    id: "oi_2",
    lineId: "line_2",
    productId: "menu_caffetteria_caffe",
    productNameSnapshot: "Caffe",
    name: "Caffe",
    qty: 1,
    unitPriceApplied: 1.3,
    listPriceAtTime: 1.3,
    lineTotal: 1.3,
    routeStations: ["BAR PRINCIPALE"],
    done: false,
  });
  order.total = 2.6;
  order.dueAmount = 2.6;
  const table = persistedSeed.posSettings.tables.find((entry) => entry.id === "room_pedana_t06");
  table.totalDue = 2.6;
  await fs.writeFile(dbPath, `${JSON.stringify(persistedSeed, null, 2)}\n`, "utf8");

  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");
  const admin = await login(baseUrl, "admin_test", "1111", "admin-device");

  let response = await fetch(`${baseUrl}/api/integration/orders/sync`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      id: "00005",
      order: {
        workflowStatus: "waiting",
        items: [
          {
            id: "oi_1",
            lineId: "line_1",
            productId: "menu_caffetteria_caffe",
            name: "Caffe",
            productNameSnapshot: "Caffe",
            qty: 1,
            unitPriceApplied: 1.3,
            listPriceAtTime: 1.3,
            lineTotal: 1.3,
            routeStations: ["BAR PRINCIPALE"],
            done: true,
            doneQty: 1,
          },
          {
            id: "oi_2",
            lineId: "line_2",
            productId: "menu_caffetteria_caffe",
            name: "Caffe",
            productNameSnapshot: "Caffe",
            qty: 1,
            unitPriceApplied: 1.3,
            listPriceAtTime: 1.3,
            lineTotal: 1.3,
            routeStations: ["BAR PRINCIPALE"],
            done: false,
            doneQty: 0,
          },
        ],
      },
    }),
  });
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.order.items[0].done, true);

  response = await fetch(`${baseUrl}/api/tables/lock/acquire`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({ tableId: "room_pedana_t06", purpose: "correction" }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/integration/orders/correct`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
	      tableId: "room_pedana_t06",
	      orderId: "00005",
	      expectedRevision: body.order.currentRevision ?? body.order.revision ?? 1,
	      changedItems: [{ lineId: "line_1", nextQuantity: 2 }],
	      idempotencyKey: "corr-00005-checkbox-qty",
	    }),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  const lineItems = body.order.items.filter((item) => item.lineId === "line_1");
  assert.equal(lineItems.length, 2);
  assert.equal(lineItems.filter((item) => item.done === true).length, 1);
  assert.equal(lineItems.filter((item) => item.done !== true).length, 1);
  assert.equal(body.correction.changedItems[0].previousPreparedQuantity, 1);
  assert.equal(body.correction.changedItems[0].nextPreparedQuantity, 1);
  assert.equal(body.order.total, 3.9);
});

test("return without replacement preserves removed item on current order", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");

  let response = await fetch(`${baseUrl}/api/tables/lock/acquire`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({ tableId: "room_pedana_t06", purpose: "correction" }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/integration/orders/correct`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      tableId: "room_pedana_t06",
      orderId: "00005",
      expectedRevision: 1,
      removedItems: [{ lineId: "line_1", quantity: 1 }],
      preserveRemovedItems: true,
      recoveryMode: "return_without_replacement",
      reason: "Reso senza sostituzione",
      idempotencyKey: "return_without_replacement-test-00005",
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.order.id, "00005");
  assert.equal(body.order.items.length, 1);
  assert.equal(body.order.items[0].lineId, "line_1");
  assert.equal(body.order.items[0].correctionStatus, "removed");
  assert.ok(body.order.items[0].voidedAt);
  assert.equal(body.order.total, 0);
  assert.equal(body.order.dueAmount, 0);
  assert.equal(body.order.workflowStatus, "waiting");
  assert.equal(body.correction.removedItems[0].preservedInOrder, true);

  const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
  assert.equal(
    persisted.integration.orders.filter((order) => order.id === "00005").length,
    1
  );
});

test("premium alcohol requires a valid enabled variant and preserves selection", async (t) => {
  const { baseUrl } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");

  let response = await fetch(`${baseUrl}/api/integration/orders/create`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      source: "mobile-frontend",
      lines: [
        {
          name: "Gin Mare Capri Mediterraneo",
          productId: "menu_drink_premium_capri",
          qty: 1,
          price: 14,
        },
      ],
    }),
  });
  assert.equal(response.status, 400);
  let body = await response.json();
  assert.equal(body.code, "PREMIUM_ALCOHOL_VARIANT_REQUIRED");
  assert.equal(body.error, "Seleziona una variante per questo alcolico premium.");

  response = await fetch(`${baseUrl}/api/integration/orders/create`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      source: "mobile-frontend",
      broadcastToAllStations: false,
      createdByUserId: "u_admin",
      createdByUsername: "admin_test",
      lines: [
        {
          name: "Gin Mare Capri Mediterraneo",
          productId: "menu_drink_premium_capri",
          qty: 1,
          price: 14,
          variant: "Tonic",
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  const item = body.order.items[0];
  assert.equal(item.productId, "menu_drink_premium_capri");
  assert.equal(item.selectedVariantId, "drink_premium_tonic");
  assert.equal(item.selectedVariantName, "Tonic");
  assert.equal(item.selectedVariantPriceDelta, 0);
  assert.equal(item.unitPriceApplied, 14);
  assert.equal(item.lineTotal, 14);
  assert.equal(item.finalLinePrice, 14);
  assert.equal(body.order.total, 14);
  assert.equal(body.order.createdByUserId, "u_cashier");
  assert.equal(body.order.createdByUsername, "cashier");
  assert.deepEqual(item.routeStations, ["BAR-1"]);
});

test("runtime menu hides mock products when mock mode is disabled and keeps DB products", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");
  const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
  persisted.menuItems.push({
    id: "mock_demo_runtime_item",
    name: "Articolo Demo Mock",
    category: "Demo",
    price: 99,
    enabled: true,
    source: "mock",
  });
  await fs.writeFile(dbPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

  let response = await fetch(`${baseUrl}/api/menu/catalog`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.ok(body.items.some((entry) => entry.id === "menu_caffetteria_caffe"));
  assert.equal(body.items.some((entry) => entry.id === "mock_demo_runtime_item"), false);

  response = await fetch(`${baseUrl}/api/integration/menu`, {
    headers: authHeaders(cashier, "cashier-device"),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.ok(body.products.some((entry) => entry.id === "menu_caffetteria_caffe"));
  assert.equal(body.products.some((entry) => entry.id === "mock_demo_runtime_item"), false);
});

test("premium alcohol catalog is exposed and premium variants price/route to real bar station", async (t) => {
  const { baseUrl } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");

  let response = await fetch(`${baseUrl}/api/integration/menu?station=BAR-1`, {
    headers: authHeaders(cashier, "cashier-device"),
  });
  assert.equal(response.status, 200);
  const menu = await response.json();
  const premiumCategory = menu.categories.find((entry) => entry.id === "cat_drink_premium");
  assert.equal(premiumCategory?.departmentId, "dept_bar");
  assert.equal(menu.categories.some((entry) => entry.id === "cat_alcolici_premium"), false);

  const capriPremium = menu.products.find(
    (entry) => entry.name === "Gin Mare Capri Mediterraneo",
  );
  assert.equal(capriPremium?.price, 14);
  assert.equal(capriPremium?.categoryId, "cat_drink_premium");
  assert.equal(capriPremium?.variantRequired, true);
  assert.ok(capriPremium?.variants?.some((entry) => entry.id === "drink_premium_tonic"));

  const postazioneCapri = menu.postazioneItems.find(
    (entry) => entry.name === "Gin Mare Capri Mediterraneo",
  );
  assert.deepEqual(postazioneCapri?.stations, ["BAR-1"]);

  const ginTonic = menu.products.find((entry) => entry.name === "Gin Tonic");
  assert.ok(ginTonic?.variants?.some((entry) => entry.id === "gin_premium" && entry.priceDelta === 2.5));

  response = await fetch(`${baseUrl}/api/integration/orders/create`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      source: "mobile-frontend",
      broadcastToAllStations: false,
      lines: [
        {
          name: "Gin Tonic",
          productId: "menu_drink_gin_tonic",
          qty: 1,
          price: 8,
          variant: "Gin premium",
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  let body = await response.json();
  let item = body.order.items[0];
  assert.equal(item.unitPriceApplied, 10.5);
  assert.equal(item.lineTotal, 10.5);
  assert.deepEqual(item.routeStations, ["BAR-1"]);
  assert.ok(body.order.tickets.some((entry) => entry.stationId === "BAR-1"));

  response = await fetch(`${baseUrl}/api/integration/orders/create`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      source: "mobile-frontend",
      broadcastToAllStations: false,
      lines: [
        {
          name: "Aperol Spritz",
          productId: "menu_drink_aperol_spritz",
          qty: 1,
          price: 8,
          variant: "Drink premium (+4 EUR)",
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  item = body.order.items[0];
  assert.equal(item.unitPriceApplied, 12);
  assert.equal(item.lineTotal, 12);
  assert.deepEqual(item.routeStations, ["BAR-1"]);
});

test("payment idempotency prevents duplicate free split payment", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");
  await lockTable(baseUrl, cashier, "cashier-device", "room_pedana_t05");
  const payload = {
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    orderId: "00004",
    splitType: "FREE_SPLIT",
    idempotencyKey: "pay-once-00004",
    parts: [
      {
        amountDue: 10,
        transactions: [{ method: "CASH", amountPaid: 10, cashGiven: 10 }],
      },
    ],
  };
  const first = await fetch(`${baseUrl}/api/payments/free-split`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();

  const second = await fetch(`${baseUrl}/api/payments/free-split`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify(payload),
  });
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.idempotent, true);
  assert.equal(secondBody.payment.id, firstBody.payment.id);

  const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const containers = persisted.paymentContainers.filter((entry) => entry.idempotencyKey === "pay-once-00004");
  assert.equal(containers.length, 1);
});

test("fiscal retry on an already paid order updates the existing payment without charging again", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");
  await lockTable(baseUrl, cashier, "cashier-device", "room_pedana_t05");
  const first = await fetch(`${baseUrl}/api/payments/free-split`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      orderId: "00004",
      splitType: "FREE_SPLIT",
      idempotencyKey: "pay-fiscal-replay-source",
      parts: [
        {
          amountDue: 10,
          transactions: [{ method: "CASH", amountPaid: 10, cashGiven: 10 }],
        },
      ],
    }),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();

  const replay = await fetch(`${baseUrl}/api/payments/free-split`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      orderId: "00004",
      splitType: "FREE_SPLIT",
      idempotencyKey: "pay-fiscal-replay-only",
      issueFiscal: true,
      fiscalDocType: "RECEIPT",
      fiscalDocNo: "R-REPLAY-00004",
      parts: [
        {
          amountDue: 10,
          transactions: [{ method: "POS", methodId: "pay_card", amountPaid: 10 }],
        },
      ],
    }),
  });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.fiscalReplay, true);
  assert.equal(replayBody.payment.id, firstBody.payment.id);
  assert.equal(replayBody.payment.fiscalDocNo, "R-REPLAY-00004");

  const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const containers = persisted.paymentContainers.filter((entry) =>
    Array.isArray(entry.orderIds) && entry.orderIds.includes("00004")
  );
  assert.equal(containers.length, 1);
  assert.equal(containers[0].fiscalDocNo, "R-REPLAY-00004");
  const parts = persisted.paymentParts.filter((entry) => entry.paymentId === firstBody.payment.id);
  const partIds = new Set(parts.map((entry) => entry.id));
  const transactions = persisted.paymentTransactions.filter((entry) => partIds.has(entry.partId));
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].method, "CASH");
});

test("bar charge replacement requires reason, preserves order refs, and is idempotent", async (t) => {
  const { baseUrl } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");

  let response = await fetch(`${baseUrl}/api/orders/replacement/bar-charge`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      tableId: "room_pedana_t05",
      orderId: "00004",
      productId: "menu_caffetteria_caffe",
      quantity: 1,
      reason: "",
    }),
  });
  assert.equal(response.status, 400);
  let body = await response.json();
  assert.equal(body.code, "REPLACEMENT_REASON_REQUIRED");

  await fetch(`${baseUrl}/api/tables/lock/acquire`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({ tableId: "room_pedana_t05", purpose: "replacement" }),
  });

  const replacementPayload = {
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    orderId: "00004",
    originalLineId: "line_1",
    productId: "menu_caffetteria_caffe",
    quantity: 1,
    reason: "Caffe rovesciato",
    idempotencyKey: "replacement-00004",
  };
  response = await fetch(`${baseUrl}/api/orders/replacement/bar-charge`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify(replacementPayload),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.replacement.tableId, "room_pedana_t05");
  assert.equal(body.replacement.orderId, "00004");
  assert.deepEqual(body.replacement.orderIds, ["00004"]);
  assert.equal(body.replacement.payable, false);
  assert.equal(body.replacement.customerPrice, 0);
  assert.notEqual(body.replacement.orderId, "room_pedana_t05");
  assert.match(body.printJob.id, /^print_/);
  assert.match(body.orderPrintJob.id, /^print_/);
  assert.equal(body.order.total, 10);

  response = await fetch(`${baseUrl}/api/orders/replacement/bar-charge`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify(replacementPayload),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.idempotent, true);

  response = await fetch(`${baseUrl}/api/reports/sales`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.report.serviceRecovery.replacementsCount, 1);
  assert.equal(body.report.serviceRecovery.replacements[0].reason, "Caffe rovesciato");
});

test("order comp is idempotent and rejects a second non-idempotent comp when nothing is due", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");

  let response = await fetch(`${baseUrl}/api/tables/lock/acquire`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({ tableId: "room_pedana_t05", purpose: "order.comp" }),
  });
  assert.equal(response.status, 200);

  const compPayload = {
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    orderId: "00004",
    originalLineId: "line_1",
    quantity: 1,
    reason: "Errore servizio",
    idempotencyKey: "comp-00004-once",
  };
  response = await fetch(`${baseUrl}/api/integration/orders/comp`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify(compPayload),
  });
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.comp.orderId, "00004");
  assert.equal(body.comp.amount, 10);
  assert.equal(body.order.dueAmount, 0);
  assert.equal(body.order.paymentStatus, "paid");

  response = await fetch(`${baseUrl}/api/integration/orders/comp`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify(compPayload),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.idempotent, true);
  assert.equal(body.comp.idempotencyKey, "comp-00004-once");

  response = await fetch(`${baseUrl}/api/integration/orders/comp`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({ ...compPayload, idempotencyKey: "comp-00004-again" }),
  });
  assert.equal(response.status, 409);
  body = await response.json();
  assert.match(body.error, /Nessun importo pagabile/);

  const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
  assert.equal(persisted.integration.orderComps.length, 1);
});

test("order correction keeps orderId, increments revision, and applies directly in preparation", async (t) => {
  const { baseUrl } = await startBackend(t);
  const cashier = await login(baseUrl, "cashier", "2222", "cashier-device");
  const admin = await login(baseUrl, "admin_test", "1111", "admin-device");

  await fetch(`${baseUrl}/api/tables/lock/acquire`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({ tableId: "room_pedana_t06", purpose: "correction" }),
  });

  let response = await fetch(`${baseUrl}/api/integration/orders/correct`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      tableId: "room_pedana_t06",
      orderId: "00005",
      expectedRevision: 1,
      addedItems: [{ productId: "menu_caffetteria_cappuccino", quantity: 1 }],
      idempotencyKey: "corr-00005-add",
    }),
  });
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.order.id, "00005");
  assert.equal(body.order.revision, 2);
  assert.equal(body.correction.previousRevision, 1);
  assert.equal(body.correction.nextRevision, 2);
  assert.equal(body.order.total, 2.9);
  assert.match(body.printJob.id, /^print_/);
  assert.match(body.precontoPrintJob.id, /^print_/);
  assert.equal(body.correction.precontoPrintJobId, body.precontoPrintJob.id);

  response = await fetch(`${baseUrl}/api/integration/orders/correct`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify({
      tableId: "room_pedana_t06",
      orderId: "00005",
      expectedRevision: 1,
      addedItems: [{ productId: "menu_caffetteria_cappuccino", quantity: 1 }],
      idempotencyKey: "corr-00005-add",
    }),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.idempotent, true);

  const prepCorrectionPayload = {
    tableId: "room_pedana_t06",
    orderId: "00006",
    expectedRevision: 1,
    removedItems: [{ lineId: "line_1", quantity: 1 }],
    requestCashApproval: false,
    idempotencyKey: "corr-00006-remove",
  };
  response = await fetch(`${baseUrl}/api/integration/orders/correct`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify(prepCorrectionPayload),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.order.id, "00006");
  assert.equal(body.order.revision, 2);
  assert.equal(body.correction.statusAtCorrection, "prep");
  assert.equal(body.correction.removedItems.length, 1);
  assert.match(body.printJob.id, /^print_/);
  assert.match(body.precontoPrintJob.id, /^print_/);

  response = await fetch(`${baseUrl}/api/integration/orders/correct`, {
    method: "POST",
    headers: authHeaders(cashier, "cashier-device"),
    body: JSON.stringify(prepCorrectionPayload),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.idempotent, true);
});

test("table move updates digital order, prints update tickets, and manual reprint uses updated table", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const admin = await login(baseUrl, "admin_test", "1111", "admin-device");

  for (const [tableId, purpose] of [
    ["room_pedana_t06", "table.move_source"],
    ["room_sala_t01", "table.move_target"],
  ]) {
    const lockResponse = await fetch(`${baseUrl}/api/tables/lock/acquire`, {
      method: "POST",
      headers: authHeaders(admin, "admin-device"),
      body: JSON.stringify({ tableId, purpose }),
    });
    assert.equal(lockResponse.status, 200);
  }

  const response = await fetch(`${baseUrl}/api/integration/layout/table/move`, {
    method: "POST",
    headers: authHeaders(admin, "admin-device"),
    body: JSON.stringify({
      fromTableId: "room_pedana_t06",
      toTableId: "room_sala_t01",
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.movedOrdersCount, 2);
  assert.equal(body.toTable.id, "room_sala_t01");
  assert.equal(body.fromTable.status, "free");
  assert.equal(Array.isArray(body.tableMovePrintJobs), true);
  assert.equal(body.tableMovePrintJobs.length, 2);

  let persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const movedOrders = persisted.integration.orders.filter((order) => ["00005", "00006"].includes(order.id));
  assert.equal(movedOrders.length, 2);
  for (const order of movedOrders) {
    assert.equal(order.tableId, "room_sala_t01");
    assert.equal(order.roomId, "room_sala");
    assert.equal(order.tableNumber, 1);
  }
  const movedPrintJobs = persisted.printSpoolJobs.filter((job) => ["00005", "00006"].includes(job.orderId));
  const updatePrintJobs = movedPrintJobs.filter((job) => job.kind === "table_update");
  const movedPrecontoPrintJobs = movedPrintJobs.filter((job) => job.kind === "preconto");
  assert.equal(updatePrintJobs.length, 2);
  assert.equal(movedPrecontoPrintJobs.length, 2);
  assert.match(updatePrintJobs[0]?.textPreview ?? "", /AGGIORNAMENTO/);
  assert.match(updatePrintJobs[0]?.textPreview ?? "", /SPOSTATO DA/);
  assert.match(updatePrintJobs[0]?.textPreview ?? "", /TAV\. 6 PEDANA/);
  assert.match(updatePrintJobs[0]?.textPreview ?? "", /TAV\. 1 SALA/);
  assert.equal(
    persisted.auditEvents.some((entry) => entry.action === "table.move_refresh_printed"),
    false
  );

  const printResponse = await fetch(`${baseUrl}/api/integration/print`, {
    method: "POST",
    headers: authHeaders(admin, "admin-device"),
    body: JSON.stringify({
      kind: "order",
      orderId: "00005",
    }),
  });
  assert.equal(printResponse.status, 202);
  const printBody = await printResponse.json();
  assert.equal(printBody.accepted, true);
  assert.equal(printBody.async, true);
  assert.match(printBody.jobId, /^print_/);

  persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const manualPrintJob = persisted.printSpoolJobs.find((job) => job.id === printBody.jobId);
  assert.equal(manualPrintJob?.kind, "order");
  assert.equal(manualPrintJob?.orderId, "00005");
  assert.match(manualPrintJob?.textPreview ?? "", /#5/);
});

test("login rate limiting and fiscal provider fail closed", async (t) => {
  const { baseUrl } = await startBackend(t, {
    LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "2",
    LOGIN_RATE_LIMIT_WINDOW_MS: "60000",
  });

  for (const expectedStatus of [401, 401, 429]) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "cashier", pin: "9999", deviceUuid: "rate-device" }),
    });
    assert.equal(response.status, expectedStatus);
  }

  const fiscalBackend = await startBackend(t, {
    FISCAL_PROVIDER: "real-provider",
  });
  const cashier = await login(fiscalBackend.baseUrl, "cashier", "2222", "fiscal-device");
  const response = await fetch(`${fiscalBackend.baseUrl}/api/fiscal/command`, {
    method: "POST",
    headers: authHeaders(cashier, "fiscal-device"),
    body: JSON.stringify({ command: "print_receipt" }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "FISCAL_PROVIDER_UNAVAILABLE");
});
