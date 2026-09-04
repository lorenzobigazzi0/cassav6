#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  acquireTableLock,
  apiPost,
  authHeaders,
  authPayload,
  cassaRoot,
  loginJson,
  readJson,
  startBackend,
} from "../backend/tests/helpers/test-server.mjs";
import { hashPin } from "../backend/auth/password.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const options = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(cassaRoot, options.outputDir || `logs/mega-sim-400x50-${runId}`);
const reportPath = path.join(outputDir, "report.json");
const childReportPath = path.join(outputDir, "mega-sim-load.json");
const childStdoutPath = path.join(outputDir, "mega-sim-load.stdout.log");
const childStderrPath = path.join(outputDir, "mega-sim-load.stderr.log");
const TABLE_MOVE_SOURCE_ID = "room_pedana_sim_100";
const TABLE_MOVE_TARGET_ID = "room_pedana_sim_101";
const TABLE_MOVE_SOURCE_NUMBER = 100;

function parseArgs(argv) {
  const parsed = {
    devices: Number(process.env.MEGA_400_DEVICES || 400),
    stations: Number(process.env.MEGA_400_STATIONS || 50),
    durationMs: Number(process.env.MEGA_400_DURATION_MS || 45_000),
    thinkMs: Number(process.env.MEGA_400_THINK_MS || 90),
    timeoutMs: Number(process.env.MEGA_400_TIMEOUT_MS || 20_000),
    radioClients: Number(process.env.MEGA_400_RADIO_CLIENTS || 200),
    orders: Number(process.env.MEGA_400_ORDERS || 150),
    mobileProbeDevices: Number(process.env.MEGA_400_MOBILE_PROBES || 400),
    outputDir: process.env.MEGA_400_OUTPUT_DIR || "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--devices") parsed.devices = Number(argv[++index]);
    else if (arg.startsWith("--devices=")) parsed.devices = Number(arg.slice("--devices=".length));
    else if (arg === "--stations") parsed.stations = Number(argv[++index]);
    else if (arg.startsWith("--stations=")) parsed.stations = Number(arg.slice("--stations=".length));
    else if (arg === "--duration-ms") parsed.durationMs = Number(argv[++index]);
    else if (arg.startsWith("--duration-ms=")) parsed.durationMs = Number(arg.slice("--duration-ms=".length));
    else if (arg === "--think-ms") parsed.thinkMs = Number(argv[++index]);
    else if (arg.startsWith("--think-ms=")) parsed.thinkMs = Number(arg.slice("--think-ms=".length));
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number(argv[++index]);
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    else if (arg === "--radio-clients") parsed.radioClients = Number(argv[++index]);
    else if (arg.startsWith("--radio-clients=")) parsed.radioClients = Number(arg.slice("--radio-clients=".length));
    else if (arg === "--orders") parsed.orders = Number(argv[++index]);
    else if (arg.startsWith("--orders=")) parsed.orders = Number(arg.slice("--orders=".length));
    else if (arg === "--mobile-probe-devices") parsed.mobileProbeDevices = Number(argv[++index]);
    else if (arg.startsWith("--mobile-probe-devices=")) {
      parsed.mobileProbeDevices = Number(arg.slice("--mobile-probe-devices=".length));
    } else if (arg === "--output-dir") parsed.outputDir = String(argv[++index] ?? "").trim();
    else if (arg.startsWith("--output-dir=")) parsed.outputDir = arg.slice("--output-dir=".length).trim();
  }
  parsed.devices = clampInt(parsed.devices, 1, 500, 400);
  parsed.stations = clampInt(parsed.stations, 1, 100, 50);
  parsed.durationMs = clampInt(parsed.durationMs, 5_000, 300_000, 45_000);
  parsed.thinkMs = clampInt(parsed.thinkMs, 0, 5_000, 90);
  parsed.timeoutMs = clampInt(parsed.timeoutMs, 2_000, 60_000, 20_000);
  parsed.radioClients = clampInt(parsed.radioClients, 0, parsed.devices, Math.min(200, parsed.devices));
  parsed.orders = clampInt(parsed.orders, 1, 500, 150);
  parsed.mobileProbeDevices = clampInt(parsed.mobileProbeDevices, 1, parsed.devices, parsed.devices);
  return parsed;
}

function clampInt(value, min, max, fallback) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function stationName(index) {
  return `SIM-${String(index + 1).padStart(3, "0")}`;
}

function buildWorkstations(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `workstation_sim_${String(index + 1).padStart(3, "0")}`,
    name: stationName(index),
    stationName: stationName(index),
    enabled: true,
    active: true,
    status: "active",
    roomIds: ["room_pedana", "room_sala", "sala_terrazza"],
    printerIds: [],
  }));
}

function buildExtraTables(count = 180) {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 100;
    return {
      id: `room_pedana_sim_${String(number).padStart(3, "0")}`,
      number,
      type: "Pedana",
      roomId: "room_pedana",
      status: "free",
      covers: 0,
      totalDue: 0,
      pendingBills: [],
    };
  });
}

function buildStationUsers(count) {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    return {
      id: `u_sim_station_${suffix}`,
      username: `sim_station_${suffix}`,
      fullName: `Operatore Sim ${suffix}`,
      role: "operator",
      roleLabel: "Operatore",
      permissions: ["collect_payments", "print_orders", "view_analytics", "create_bar_replacement"],
      authorizedRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      enabledRoomIds: ["room_pedana", "room_sala", "sala_terrazza"],
      pinHash: hashPin("1111"),
      createdAt: now,
      updatedAt: now,
    };
  });
}

function buildRouteLine(index, station = "") {
  const quantity = (index % 3) + 1;
  const price = 1.2 + (index % 5) * 0.4;
  return {
    name: `Sim articolo ${String(index + 1).padStart(3, "0")}`,
    productId: `sim_articolo_${String(index + 1).padStart(3, "0")}`,
    category: "Simulazione",
    qty: quantity,
    unitPrice: price,
    price,
    lineTotal: Math.round(price * quantity * 100) / 100,
    ...(station ? { station, routeStations: [station] } : {}),
  };
}

function buildAuthPayload(session, deviceUuid, extra = {}) {
  return authPayload(session, deviceUuid, {
    clientApp: extra.clientApp || "mobile-frontend",
    ...extra,
  });
}

function assertCondition(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function requestJson(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
  }
  const expected = options.expected || [200];
  if (!expected.includes(response.status)) {
    throw new Error(`${options.label || pathName} HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return { response, body };
}

async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      result[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

function runChild(command, args, childEnv = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(command, args, {
      cwd: cassaRoot,
      env: { ...process.env, ...childEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.once("error", reject);
    child.once("close", async (code, signal) => {
      await Promise.all([
        writeFile(childStdoutPath, stdout, "utf8"),
        writeFile(childStderrPath, stderr, "utf8"),
      ]);
      const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
      if (code !== 0) {
        reject(new Error(`child exit code=${code} signal=${signal || ""} elapsed=${elapsedMs}ms`));
        return;
      }
      resolve({ code, signal, elapsedMs, stdoutLines: stdout.split(/\r?\n/).filter(Boolean).slice(-20) });
    });
  });
}

async function postStationOnline(baseUrl, session, station, deviceUuid) {
  const payload = buildAuthPayload(session, deviceUuid, {
    clientApp: "postazione",
    station,
    stationName: station,
    active: true,
    autoPrintOrders: false,
    autoPrintPreconto: false,
    operatorName: session.user.fullName,
    operatorUsername: session.user.username,
    operatorUserId: session.user.id,
    operatorRole: session.user.roleLabel || session.user.role || "Operatore",
  });
  const { response, body } = await apiPost(baseUrl, "/api/integration/stations/state", payload);
  assert.equal(response.status, 200, `station online ${station}: ${JSON.stringify(body)}`);
  assert.equal(body?.ok, true);
  return body;
}

async function seedActiveStations(baseUrl, stationsCount) {
  const sessions = await mapLimit(Array.from({ length: stationsCount }, (_, index) => index), 20, async (index) => {
    const deviceUuid = `sim-postazione-${String(index + 1).padStart(3, "0")}`;
    const username = `sim_station_${String(index + 1).padStart(3, "0")}`;
    const session = await loginJson(baseUrl, username, "1111", {
      deviceUuid,
      clientApp: "postazione",
    });
    await postStationOnline(baseUrl, session, stationName(index), deviceUuid);
    return { session, deviceUuid, station: stationName(index) };
  });
  return sessions;
}

async function loginMobileProbeSessions(baseUrl, count) {
  const users = [
    ["waiter", "3333"],
    ["cashier", "2222"],
    ["manager", "4444"],
    ["admin_test", "1111"],
  ];
  return mapLimit(Array.from({ length: count }, (_, index) => index), 50, async (index) => {
    const [username, pin] = users[index % users.length];
    const deviceUuid = `sim-mobile-probe-${String(index + 1).padStart(3, "0")}`;
    const session = await loginJson(baseUrl, username, pin, {
      deviceUuid,
      clientApp: "mobile-frontend",
    });
    return { session, deviceUuid, username };
  });
}

async function verifyStations(baseUrl, dbPath) {
  const states = await requestJson(baseUrl, `/api/integration/stations/state?_=${Date.now()}`, {
    label: "stations.state",
  });
  const active = await requestJson(baseUrl, `/api/integration/stations/active?_=${Date.now()}`, {
    label: "stations.active",
  });
  const configuredCount = Array.isArray(states.body?.configuredStations) ? states.body.configuredStations.length : 0;
  const activeCount = Array.isArray(active.body?.stations) ? active.body.stations.length : 0;
  const db = await readJson(dbPath);
  const persisted = Array.isArray(db.integration?.stationStates) ? db.integration.stationStates : [];
  const persistedActiveReal = persisted.filter((entry) => entry?.active !== false && entry?.realStation === true).length;
  assertCondition(configuredCount >= options.stations, "postazioni configurate insufficienti", { configuredCount });
  assertCondition(activeCount >= options.stations, "postazioni attive insufficienti", { activeCount });
  assertCondition(persistedActiveReal >= options.stations, "postazioni persistite tagliate o non reali", {
    persistedActiveReal,
  });
  return { configuredCount, activeCount, persistedCount: persisted.length, persistedActiveReal };
}

async function verifyOccupiedStationConflict(baseUrl) {
  const session = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "sim-conflict-station-device",
    clientApp: "postazione",
  });
  const payload = buildAuthPayload(session, "sim-conflict-station-device", {
    clientApp: "postazione",
    station: stationName(0),
    active: true,
    operatorName: session.user.fullName,
    operatorUsername: session.user.username,
    operatorUserId: session.user.id,
    operatorRole: session.user.roleLabel || session.user.role || "Responsabile",
  });
  const { response, body } = await apiPost(baseUrl, "/api/integration/stations/state", payload);
  assert.equal(response.status, 409, `expected occupied station conflict: ${JSON.stringify(body)}`);
  assert.equal(body?.code, "STATION_ALREADY_OCCUPIED");
  return { status: response.status, code: body.code, station: body.station };
}

async function verifyMobileDetection(baseUrl, dbPath, probeSessions) {
  const waiterSession = probeSessions.find((entry) => entry.username === "waiter") || probeSessions[0];
  const { body } = await requestJson(
    baseUrl,
    `/api/integration/waiters?source=mobile-frontend&includeInactive=1&activeMs=300000&_=${Date.now()}`,
    {
      headers: authHeaders(waiterSession.session, waiterSession.deviceUuid),
      label: "integration.waiters",
    },
  );
  const db = await readJson(dbPath);
  const mobileSessions = (Array.isArray(db.sessions) ? db.sessions : []).filter(
    (entry) => entry?.clientApp === "mobile-frontend",
  );
  const activeMobileSessions = mobileSessions.filter((entry) => {
    const expiresAt = Date.parse(String(entry?.expiresAt ?? ""));
    return !Number.isFinite(expiresAt) || expiresAt > Date.now();
  });
  const waiters = Array.isArray(body?.waiters) ? body.waiters : [];
  assertCondition(activeMobileSessions.length >= options.mobileProbeDevices, "sessioni mobile attive insufficienti", {
    activeMobileSessions: activeMobileSessions.length,
  });
  assertCondition(waiters.length >= 3, "rilevamento utenti mobile troppo povero", {
    waiters: waiters.map((entry) => entry.username),
  });
  return {
    mobileSessions: mobileSessions.length,
    activeMobileSessions: activeMobileSessions.length,
    detectedUsers: waiters.map((entry) => ({
      userId: entry.userId,
      username: entry.username,
      activeNow: entry.activeNow,
      online: entry.online,
    })),
  };
}

async function createLoadBalancedOrders(baseUrl, session, deviceUuid, orderCount) {
  const orders = await mapLimit(Array.from({ length: orderCount }, (_, index) => index), 12, async (index) => {
    const payload = buildAuthPayload(session, deviceUuid, {
      source: "mobile-frontend",
      clientApp: "mobile-frontend",
      roomId: "room_pedana",
      tableId: "",
      tableNumber: 0,
      covers: 2,
      total: 3.5,
      lines: [buildRouteLine(index)],
    });
    const { response, body } = await apiPost(baseUrl, "/api/integration/orders/create", payload, {
      headers: authHeaders(session, deviceUuid),
    });
    assert.equal(response.status, 200, `create load order ${index}: ${JSON.stringify(body)}`);
    assert.equal(body?.ok, true);
    return body.order;
  });
  return orders;
}

function summarizeAssignments(db) {
  const orders = Array.isArray(db.integration?.orders) ? db.integration.orders : [];
  const activeOrders = orders.filter((order) => !["paid", "cancelled"].includes(String(order?.paymentStatus ?? "")));
  const byStation = new Map();
  const missing = [];
  for (const order of activeOrders) {
    const station = String(order?.assignedStationId ?? order?.station ?? "").trim();
    if (!station) {
      missing.push(order?.id);
      continue;
    }
    byStation.set(station, (byStation.get(station) ?? 0) + 1);
  }
  return {
    activeOrders: activeOrders.length,
    stationsUsed: byStation.size,
    missingAssignments: missing,
    topStations: [...byStation.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 12)
      .map(([station, count]) => ({ station, count })),
  };
}

async function verifyLoadBalancing(baseUrl, dbPath, mobileSession) {
  const orders = await createLoadBalancedOrders(
    baseUrl,
    mobileSession.session,
    mobileSession.deviceUuid,
    options.orders,
  );
  const db = await readJson(dbPath);
  const summary = summarizeAssignments(db);
  assertCondition(summary.missingAssignments.length === 0, "alcune comande non hanno postazione", summary);
  assertCondition(summary.stationsUsed >= Math.min(12, options.stations), "load balancing troppo concentrato", summary);
  const configuredStations = new Set(buildWorkstations(options.stations).map((entry) => entry.stationName));
  const invalid = (Array.isArray(db.integration?.orders) ? db.integration.orders : [])
    .map((order) => String(order?.assignedStationId ?? order?.station ?? "").trim())
    .filter(Boolean)
    .filter((station) => !configuredStations.has(station));
  assertCondition(invalid.length === 0, "comande assegnate a postazioni non configurate", {
    invalid: [...new Set(invalid)].slice(0, 10),
  });
  return { createdOrders: orders.length, ...summary };
}

async function createTableOrder(baseUrl, session, deviceUuid) {
  const { response: lockResponse, body: lockBody } = await acquireTableLock(baseUrl, session, TABLE_MOVE_SOURCE_ID, {
    deviceUuid,
    purpose: "order.create",
  });
  assert.equal(lockResponse.status, 200, `lock source table: ${JSON.stringify(lockBody)}`);
  const payload = buildAuthPayload(session, deviceUuid, {
    source: "mobile-frontend",
    clientApp: "mobile-frontend",
    roomId: "room_pedana",
    tableId: TABLE_MOVE_SOURCE_ID,
    tableNumber: TABLE_MOVE_SOURCE_NUMBER,
    covers: 2,
    total: 4.2,
    lines: [buildRouteLine(900)],
  });
  const { response, body } = await apiPost(baseUrl, "/api/integration/orders/create", payload, {
    headers: authHeaders(session, deviceUuid),
  });
  assert.equal(response.status, 200, `create table order: ${JSON.stringify(body)}`);
  assert.equal(body?.ok, true);
  return body.order;
}

async function verifyTransfer(baseUrl, dbPath, order, mobileSession) {
  const db = await readJson(dbPath);
  const current = db.integration.orders.find((entry) => String(entry?.id) === String(order.id));
  const fromStation = String(current?.assignedStationId ?? current?.station ?? "").trim();
  const toStation =
    Array.from({ length: options.stations }, (_, index) => stationName(index)).find((station) => station !== fromStation) ||
    stationName(1);
  const requestPayload = buildAuthPayload(mobileSession.session, mobileSession.deviceUuid, {
    clientApp: "mobile-frontend",
    orderId: order.id,
    mode: "transfer",
    requesterStation: toStation,
    targetStation: toStation,
    requesterOperator: mobileSession.session.user.fullName,
    requesterRole: mobileSession.session.user.roleLabel || mobileSession.session.user.role || "Operatore",
  });
  const request = await apiPost(baseUrl, "/api/integration/orders/transfer/request", requestPayload, {
    headers: authHeaders(mobileSession.session, mobileSession.deviceUuid),
  });
  assert.equal(request.response.status, 200, `transfer request: ${JSON.stringify(request.body)}`);
  assert.equal(request.body?.ok, true);
  const resolvePayload = buildAuthPayload(mobileSession.session, mobileSession.deviceUuid, {
    clientApp: "mobile-frontend",
    orderId: order.id,
    approve: true,
    approverStation: fromStation,
    approverOperator: "Owner Sim",
  });
  const resolved = await apiPost(baseUrl, "/api/integration/orders/transfer/resolve", resolvePayload, {
    headers: authHeaders(mobileSession.session, mobileSession.deviceUuid),
  });
  assert.equal(resolved.response.status, 200, `transfer resolve: ${JSON.stringify(resolved.body)}`);
  assert.equal(resolved.body?.ok, true);
  assert.equal(resolved.body?.approved, true);
  assert.equal(resolved.body?.order?.station, toStation);
  assert.equal(resolved.body?.order?.assignmentReason, "manual_transfer");
  assert.equal(resolved.body?.order?.pendingAuthRequest, null);
  return {
    orderId: order.id,
    fromStation,
    toStation,
    assignmentReason: resolved.body.order.assignmentReason,
  };
}

async function verifyTableMove(baseUrl, dbPath, session, deviceUuid, orderId) {
  const sourceLock = await acquireTableLock(baseUrl, session, TABLE_MOVE_SOURCE_ID, {
    deviceUuid,
    purpose: "table.move_source",
  });
  assert.equal(sourceLock.response.status, 200, `lock move source: ${JSON.stringify(sourceLock.body)}`);
  const targetLock = await acquireTableLock(baseUrl, session, TABLE_MOVE_TARGET_ID, {
    deviceUuid,
    purpose: "table.move_target",
  });
  assert.equal(targetLock.response.status, 200, `lock move target: ${JSON.stringify(targetLock.body)}`);
  const move = await apiPost(
    baseUrl,
    "/api/integration/layout/table/move",
    buildAuthPayload(session, deviceUuid, {
      clientApp: "mobile-frontend",
      fromTableId: TABLE_MOVE_SOURCE_ID,
      toTableId: TABLE_MOVE_TARGET_ID,
    }),
    { headers: authHeaders(session, deviceUuid) },
  );
  assert.equal(move.response.status, 200, `table move: ${JSON.stringify(move.body)}`);
  assert.equal(move.body?.ok, true);
  assertCondition(move.body.movedOrdersCount >= 1, "spostamento tavolo senza comande mosse", move.body);
  const db = await readJson(dbPath);
  const movedOrder = db.integration.orders.find((entry) => String(entry?.id) === String(orderId));
  assert.equal(movedOrder?.tableId, TABLE_MOVE_TARGET_ID);
  return { movedOrdersCount: move.body.movedOrdersCount, orderId, tableId: movedOrder?.tableId };
}

async function verifyNotifications(baseUrl, mobileSession, transferredOrderId) {
  const notificationPayloads = [
    {
      type: "waiter",
      title: "Chiamata cameriere sim",
      description: "Test real-time waiter",
      meta: {
        eventType: "waiter_call",
        targetUserId: mobileSession.session.user.id,
        targetUsername: mobileSession.session.user.username,
        targetDeviceUuid: mobileSession.deviceUuid,
        targetClientApp: "mobile-frontend",
      },
    },
    {
      type: "bell",
      title: "Comanda pronta sim",
      description: "Test real-time bell",
      meta: {
        eventType: "order_ready",
        orderId: transferredOrderId,
        targetUserId: mobileSession.session.user.id,
        targetUsername: mobileSession.session.user.username,
        targetClientApp: "mobile-frontend",
      },
    },
  ];
  const published = [];
  for (const payload of notificationPayloads) {
    const { response, body } = await apiPost(baseUrl, "/api/integration/notifications/publish", payload);
    assert.equal(response.status, 200, `publish notification: ${JSON.stringify(body)}`);
    assert.equal(body?.ok, true);
    published.push(body.notification?.id);
  }
  const query = new URLSearchParams({
    consumer: "mobile-frontend",
    ackConsumer: "mobile-frontend",
    clientApp: "mobile-frontend",
    userId: mobileSession.session.user.id,
    username: mobileSession.session.user.username,
    deviceUuid: mobileSession.deviceUuid,
    _: String(Date.now()),
  });
  const { body } = await requestJson(baseUrl, `/api/integration/notifications/pull?${query}`, {
    headers: authHeaders(mobileSession.session, mobileSession.deviceUuid),
    label: "notifications.pull",
  });
  const items = Array.isArray(body?.items) ? body.items : [];
  const itemIds = new Set(items.map((item) => item.id));
  assertCondition(published.some((id) => itemIds.has(id)), "notifiche pubblicate non consegnate al mobile", {
    published,
    pulled: items.map((item) => ({ id: item.id, type: item.type, title: item.title })),
  });
  return { published, pulled: items.length };
}

async function verifyPauseRebalance(baseUrl, dbPath, stationSessions) {
  const dbBefore = await readJson(dbPath);
  const order = (Array.isArray(dbBefore.integration?.orders) ? dbBefore.integration.orders : []).find((entry) => {
    const station = String(entry?.assignedStationId ?? entry?.station ?? "").trim();
    const workflow = String(entry?.workflowStatus ?? "").trim().toLowerCase();
    const lockStatus = String(entry?.lockStatus ?? "").trim().toLowerCase();
    return (
      station === stationName(0) &&
      entry?.assignmentReason !== "manual_transfer" &&
      !entry?.manuallyTransferredAt &&
      workflow !== "prep" &&
      lockStatus !== "locked"
    );
  });
  if (!order) {
    return { skipped: true, reason: `nessuna comanda aperta su ${stationName(0)}` };
  }
  const stationSession = stationSessions.find((entry) => entry.station === stationName(0));
  const payload = buildAuthPayload(stationSession.session, stationSession.deviceUuid, {
    clientApp: "postazione",
    station: stationSession.station,
    stationName: stationSession.station,
    active: false,
    pauseTransferMode: "transfer",
    operatorName: stationSession.session.user.fullName,
    operatorUsername: stationSession.session.user.username,
    operatorUserId: stationSession.session.user.id,
    operatorRole: stationSession.session.user.roleLabel || stationSession.session.user.role || "Operatore",
  });
  const { response, body } = await apiPost(baseUrl, "/api/integration/stations/state", payload);
  assert.equal(response.status, 200, `pause station: ${JSON.stringify(body)}`);
  assert.equal(body?.ok, true);
  const dbAfter = await readJson(dbPath);
  const movedOrder = dbAfter.integration.orders.find((entry) => String(entry?.id) === String(order.id));
  assertCondition(String(movedOrder?.assignedStationId ?? "") !== stationName(0), "pausa non ha ribilanciato la comanda", {
    orderId: order.id,
    station: movedOrder?.assignedStationId,
    body,
  });
  return {
    orderId: order.id,
    fromStation: stationName(0),
    toStation: movedOrder.assignedStationId,
    responseKeys: Object.keys(body).filter((key) => key !== "station"),
  };
}

async function verifyDbInvariants(dbPath) {
  const db = await readJson(dbPath);
  const stationStates = Array.isArray(db.integration?.stationStates) ? db.integration.stationStates : [];
  const stationKeys = new Set();
  const duplicateStationKeys = [];
  stationStates.forEach((entry) => {
    const key = [
      String(entry?.station ?? "").trim(),
      String(entry?.operatorUserId ?? entry?.operatorUsername ?? entry?.deviceUuid ?? "").trim(),
    ].join("::");
    if (stationKeys.has(key)) duplicateStationKeys.push(key);
    stationKeys.add(key);
  });
  const notifications = Array.isArray(db.integration?.notifications) ? db.integration.notifications : [];
  const notificationIds = notifications.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean);
  const duplicateNotificationIds = notificationIds.filter((id, index) => notificationIds.indexOf(id) !== index);
  const orders = Array.isArray(db.integration?.orders) ? db.integration.orders : [];
  const unresolvedTransfers = orders
    .filter((entry) => entry?.pendingAuthRequest && typeof entry.pendingAuthRequest === "object")
    .map((entry) => entry.id);
  assertCondition(duplicateStationKeys.length === 0, "chiavi postazione duplicate nel DB", {
    duplicateStationKeys: duplicateStationKeys.slice(0, 20),
  });
  assertCondition(duplicateNotificationIds.length === 0, "ID notifica duplicati nel DB", {
    duplicateNotificationIds: [...new Set(duplicateNotificationIds)].slice(0, 20),
  });
  assertCondition(unresolvedTransfers.length === 0, "richieste trasferimento pendenti non risolte", {
    unresolvedTransfers,
  });
  return {
    stationStates: stationStates.length,
    notifications: notifications.length,
    orders: orders.length,
    duplicateStationKeys: duplicateStationKeys.length,
    duplicateNotificationIds: duplicateNotificationIds.length,
    unresolvedTransfers: unresolvedTransfers.length,
  };
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const startedAt = new Date();
  const cleanup = [];
  const fakeTest = { after: (fn) => cleanup.push(fn) };
  const result = {
    ok: false,
    startedAt: startedAt.toISOString(),
    options,
    outputDir,
    checks: {},
  };
  try {
    const backend = await startBackend(fakeTest, {
      stateOverrides(state) {
        state.posSettings.workstations = buildWorkstations(options.stations);
        const tableIds = new Set((state.posSettings.tables || []).map((table) => table.id));
        state.posSettings.tables = [
          ...(Array.isArray(state.posSettings.tables) ? state.posSettings.tables : []),
          ...buildExtraTables().filter((table) => !tableIds.has(table.id)),
        ];
        const existingUserIds = new Set((Array.isArray(state.users) ? state.users : []).map((user) => user.id));
        state.users = [
          ...(Array.isArray(state.users) ? state.users : []),
          ...buildStationUsers(options.stations).filter((user) => !existingUserIds.has(user.id)),
        ];
        state.integration.stationStates = [];
        state.integration.orders = [];
        state.integration.notifications = [];
      },
      env: {
        PRINTING_ENABLED: "0",
        LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "5000",
        LOGIN_RATE_LIMIT_WINDOW_MS: "1000",
        INTEGRATION_MAX_STATION_STATES: "512",
        INTEGRATION_STATION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "0",
        SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "0",
        INTEGRATION_HOT_GET_FAST_CACHE_MS: "0",
        INTEGRATION_LAYOUT_FAST_CACHE_MS: "0",
        INTEGRATION_NOTIFICATION_PULL_FAST_CACHE_MS: "0",
        AUTO_PRINT_ENQUEUE_DELAY_MS: "0",
      },
      timeoutMs: 20_000,
    });
    result.backend = {
      baseUrl: backend.baseUrl,
      dbPath: backend.dbPath,
      runDir: backend.runDir,
    };
    console.log(`[mega-400x50] backend isolato ${backend.baseUrl}`);

    const child = await runChild(
      process.execPath,
      [
        path.join(scriptDir, "mega-sim-100-devices.mjs"),
        "--base-url",
        backend.baseUrl,
        "--username",
        "admin_test",
        "--pin",
        "1111",
        "--devices",
        String(options.devices),
        "--stations",
        String(options.stations),
        "--duration-ms",
        String(options.durationMs),
        "--think-ms",
        String(options.thinkMs),
        "--timeout-ms",
        String(options.timeoutMs),
        "--radio-clients",
        String(options.radioClients),
        "--output",
        childReportPath,
      ],
      { MEGA_SIM_LOGIN_CONCURRENCY: "40" },
    );
    result.checks.load = {
      child,
      reportPath: childReportPath,
      report: await readJson(childReportPath),
    };
    assert.equal(result.checks.load.report?.ok, true, "mega-sim child report not ok");
    console.log("[mega-400x50] carico REST/radio completato");

    const stationSessions = await seedActiveStations(backend.baseUrl, options.stations);
    result.checks.stationsAfterLoad = await verifyStations(backend.baseUrl, backend.dbPath);
    console.log(`[mega-400x50] postazioni attive=${result.checks.stationsAfterLoad.activeCount}`);

    result.checks.occupiedStationConflict = await verifyOccupiedStationConflict(backend.baseUrl);

    const mobileProbeSessions = await loginMobileProbeSessions(backend.baseUrl, options.mobileProbeDevices);
    result.checks.mobileDetection = await verifyMobileDetection(
      backend.baseUrl,
      backend.dbPath,
      mobileProbeSessions,
    );

    const managerSession =
      mobileProbeSessions.find((entry) => entry.username === "manager") || mobileProbeSessions[0];
    result.checks.loadBalancing = await verifyLoadBalancing(
      backend.baseUrl,
      backend.dbPath,
      managerSession,
    );

    const tableOrder = await createTableOrder(
      backend.baseUrl,
      managerSession.session,
      managerSession.deviceUuid,
    );
    result.checks.transfer = await verifyTransfer(
      backend.baseUrl,
      backend.dbPath,
      tableOrder,
      managerSession,
    );
    result.checks.tableMove = await verifyTableMove(
      backend.baseUrl,
      backend.dbPath,
      managerSession.session,
      managerSession.deviceUuid,
      tableOrder.id,
    );
    result.checks.notifications = await verifyNotifications(
      backend.baseUrl,
      managerSession,
      tableOrder.id,
    );
    result.checks.pauseRebalance = await verifyPauseRebalance(
      backend.baseUrl,
      backend.dbPath,
      stationSessions,
    );
    result.checks.dbInvariants = await verifyDbInvariants(backend.dbPath);

    result.ok = true;
    result.finishedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`[mega-400x50] OK report=${reportPath}`);
  } catch (error) {
    result.ok = false;
    result.finishedAt = new Date().toISOString();
    result.error = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : "",
      details: error?.details,
    };
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.error(`[mega-400x50] FAIL report=${reportPath}`);
    console.error(result.error.message);
    process.exitCode = 1;
  } finally {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch {
        // Cleanup best-effort.
      }
    }
  }
}

await main();
