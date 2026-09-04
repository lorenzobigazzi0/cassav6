import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(cassaRoot, "..");

function envString(name, fallback = "") {
  const value = String(process.env[name] ?? "").trim();
  return value || fallback;
}

function envBool(name, fallback = false) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function parseNumberEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

const options = {
  frontendOrigin: envString("SM_CANARY_FRONTEND_ORIGIN", "https://127.0.0.1:5280").replace(/\/+$/, ""),
  username: envString("SM_CANARY_USERNAME", "amalia"),
  pin: envString("SM_CANARY_PIN", "182018"),
  variant: envString("SM_CANARY_VARIANT", "default-on"),
  mobileDeviceUuid: envString("SM_CANARY_MOBILE_DEVICE_UUID", `sm-canary-mobile-${Date.now()}`),
  stationDeviceUuid: envString("SM_CANARY_STATION_DEVICE_UUID", `sm-canary-station-${Date.now()}`),
  station: envString("SM_CANARY_STATION", "BAR PRINCIPALE"),
  tableId: envString("SM_CANARY_TABLE_ID", ""),
  roomId: envString("SM_CANARY_ROOM_ID", ""),
  productId: envString("SM_CANARY_PRODUCT_ID", "menu_caffetteria_caffe"),
  productName: envString("SM_CANARY_PRODUCT_NAME", "Caffe"),
  productPrice: parseNumberEnv("SM_CANARY_PRODUCT_PRICE", 1.3, { min: 0.01, max: 10_000 }),
  timeoutMs: parseNumberEnv("SM_CANARY_TIMEOUT_MS", 20_000, { min: 1_000, max: 120_000 }),
  readbackTimeoutMs: parseNumberEnv("SM_CANARY_READBACK_TIMEOUT_MS", 8_000, { min: 500, max: 120_000 }),
  readbackIntervalMs: parseNumberEnv("SM_CANARY_READBACK_INTERVAL_MS", 150, { min: 25, max: 5_000 }),
  reportRoot: envString("SM_CANARY_REPORT_ROOT", path.join(repoRoot, "logs")),
  requirePrintingDisabled: envBool("SM_CANARY_REQUIRE_PRINTING_DISABLED", true),
  cleanup: !envBool("SM_CANARY_SKIP_CLEANUP", false),
  insecureTls: String(process.env.SM_CANARY_INSECURE_TLS ?? "1") !== "0",
};

if (options.insecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const runId = envString(
  "SM_CANARY_RUN_ID",
  `state_machine_ab_${options.variant}_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
}

function normalizeStation(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

function stationNameFromEntry(entry) {
  if (typeof entry === "string") return normalizeStation(entry);
  return normalizeStation(entry?.station ?? entry?.stationName ?? entry?.name ?? entry?.id ?? "");
}

function authPayload(session, deviceUuid, extra = {}) {
  return {
    token: session.token,
    userId: session.user?.id,
    username: session.user?.username,
    fullName: session.user?.fullName,
    deviceUuid,
    ...extra,
  };
}

function authHeaders(session, deviceUuid) {
  return {
    Authorization: `Bearer ${session.token}`,
    "X-User-Id": session.user?.id ?? "",
    "X-Device-Uuid": deviceUuid,
    "Content-Type": "application/json",
  };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = options.timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout HTTP ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(pathname, init = {}) {
  const startedAt = performance.now();
  const response = await fetchWithTimeout(`${options.frontendOrigin}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { parseError: true, text: text.slice(0, 500) };
  }
  return {
    pathname,
    method: init.method ?? "GET",
    status: response.status,
    ok: response.ok,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    proxyRole: response.headers.get("x-proxy-backend-role") ?? "",
    desiredProxyRole: response.headers.get("x-proxy-backend-desired-role") ?? "",
    body,
  };
}

async function login(clientApp, deviceUuid) {
  const result = await requestJson("/api/auth/login", {
    method: "POST",
    body: {
      username: options.username,
      pin: options.pin,
      deviceUuid,
      clientApp,
    },
  });
  if (result.status !== 200 || !result.body?.token || !result.body?.user?.id) {
    throw new Error(`login ${clientApp} failed: ${result.status} ${result.body?.error ?? result.body?.code ?? ""}`);
  }
  return result.body;
}

async function getStationSnapshot() {
  const result = await requestJson(`/api/integration/stations/state?_=${Date.now()}`);
  const configured = Array.isArray(result.body?.configuredStations)
    ? result.body.configuredStations.map(stationNameFromEntry).filter(Boolean)
    : [];
  const stations = Array.isArray(result.body?.stations) ? result.body.stations : [];
  return { result, configured, stations };
}

function stationIsActive(snapshot, station) {
  const target = normalizeStation(station);
  return snapshot.stations.some((entry) => {
    if (normalizeStation(entry?.station ?? entry?.stationName ?? entry?.name) !== target) return false;
    return entry?.active !== false && entry?.stale !== true && entry?.realStation === true;
  });
}

function candidateStations(snapshot) {
  const preferred = normalizeStation(options.station);
  return [
    preferred,
    ...snapshot.configured,
    "BAR PRINCIPALE",
    "BAR-1",
    "CAFFETTERIA",
  ].filter((entry, index, list) => entry && list.indexOf(entry) === index);
}

async function setStationActive(session, station) {
  return requestJson("/api/integration/stations/state", {
    method: "POST",
    headers: authHeaders(session, options.stationDeviceUuid),
    body: authPayload(session, options.stationDeviceUuid, {
      clientApp: "postazione",
      station,
      stationName: station,
      active: true,
      autoPrintOrders: false,
      autoPrintPreconto: false,
      operatorName: session.user?.fullName ?? session.user?.username ?? "",
      operatorUsername: session.user?.username ?? "",
      operatorUserId: session.user?.id ?? "",
      operatorRole: session.user?.roleLabel ?? session.user?.role ?? "Operatore",
    }),
  });
}

async function ensureActiveStation(session) {
  const initial = await getStationSnapshot();
  const attempts = [];
  for (const station of candidateStations(initial)) {
    const result = await setStationActive(session, station);
    attempts.push({ station, status: result.status, code: result.body?.code ?? "", durationMs: result.durationMs });
    if (result.status === 200) {
      return { station, activated: true, attempts, initial: initial.result };
    }
    if (result.status === 409) {
      const fresh = await getStationSnapshot();
      if (stationIsActive(fresh, station)) {
        return { station, activated: false, occupiedButActive: true, attempts, initial: initial.result };
      }
    }
  }
  throw new Error(`no usable active station: ${JSON.stringify(attempts)}`);
}

function selectTable(layout) {
  const tables = Array.isArray(layout?.tables) ? layout.tables : [];
  if (options.tableId) {
    const selected = tables.find((table) => String(table?.id ?? "") === options.tableId);
    if (!selected) throw new Error(`requested table not found: ${options.tableId}`);
    return selected;
  }
  const freeTables = tables.filter((table) => {
    const pending = Array.isArray(table?.pendingBills) ? table.pendingBills.length : 0;
    const amountDue = Number(table?.amountDue ?? table?.totalDue ?? 0) || 0;
    const occupancy = String(table?.occupancyState ?? table?.status ?? "").trim().toLowerCase();
    if (pending > 0 || amountDue > 0.009) return false;
    return !occupancy || ["free", "available", "libero", "seated"].includes(occupancy);
  });
  const preferred =
    freeTables.find((table) => options.roomId && String(table?.roomId ?? "") === options.roomId) ??
    freeTables.find((table) => String(table?.roomId ?? "") === "room_bar") ??
    freeTables.find((table) => !String(table?.roomId ?? "").toLowerCase().includes("attesa")) ??
    freeTables[0];
  if (!preferred) throw new Error("no free table available for state-machine canary");
  return preferred;
}

async function lockTable(session, deviceUuid, table, purpose) {
  return requestJson("/api/tables/lock/acquire", {
    method: "POST",
    headers: authHeaders(session, deviceUuid),
    body: authPayload(session, deviceUuid, {
      tableId: table.id,
      roomId: table.roomId,
      purpose,
    }),
  });
}

async function releaseTable(session, deviceUuid, table) {
  return requestJson("/api/tables/lock/release", {
    method: "POST",
    headers: authHeaders(session, deviceUuid),
    body: authPayload(session, deviceUuid, {
      tableId: table.id,
      roomId: table.roomId,
    }),
  });
}

async function createOrder(session, table) {
  const line = {
    name: options.productName,
    productName: options.productName,
    productId: options.productId,
    qty: 1,
    quantity: 1,
    price: options.productPrice,
    unitPrice: options.productPrice,
    lineTotal: options.productPrice,
  };
  return requestJson("/api/integration/orders/create", {
    method: "POST",
    headers: authHeaders(session, options.mobileDeviceUuid),
    body: authPayload(session, options.mobileDeviceUuid, {
      source: "mobile-frontend",
      clientApp: "mobile-frontend",
      tableId: table.id,
      roomId: table.roomId,
      tableNumber: table.number,
      tableLabel: table.tableName ?? table.label ?? "",
      covers: 1,
      note: `state-machine canary ${runId}`,
      orderNote: `state-machine canary ${runId}`,
      communications: "state-machine canary",
      orderComment: "state-machine canary",
      total: options.productPrice,
      autoPrintOrders: false,
      autoPrintPreconto: false,
      idempotencyKey: `${runId}:create`,
      lines: [line],
    }),
  });
}

function orderForSync(order, workflowStatus, station) {
  const markDone = ["ready", "delivered"].includes(workflowStatus);
  return {
    ...order,
    workflowStatus,
    station: order.station || station,
    ownerStation: order.ownerStation || order.station || station,
    items: Array.isArray(order.items)
      ? order.items.map((item) => ({ ...item, done: markDone ? true : item.done === true }))
      : [],
  };
}

async function syncOrder(session, order, workflowStatus, station) {
  return requestJson("/api/integration/orders/sync", {
    method: "POST",
    headers: authHeaders(session, options.stationDeviceUuid),
    body: authPayload(session, options.stationDeviceUuid, {
      id: order.id,
      clientApp: "postazione",
      workflowReason: `state_machine_ab_canary_${workflowStatus}`,
      order: orderForSync(order, workflowStatus, station),
    }),
  });
}

async function fetchOrder(session, orderId) {
  const params = new URLSearchParams({
    orderId,
    includeDone: "1",
    fresh: String(Date.now()),
  });
  return requestJson(`/api/integration/orders?${params}`, {
    method: "GET",
    headers: authHeaders(session, options.mobileDeviceUuid),
  });
}

async function waitForOrder(session, orderId, allowedWorkflows) {
  const deadline = performance.now() + options.readbackTimeoutMs;
  let attempts = 0;
  let lastResult = null;
  let lastOrder = null;
  while (performance.now() <= deadline) {
    attempts += 1;
    lastResult = await fetchOrder(session, orderId);
    const orders = Array.isArray(lastResult.body?.orders) ? lastResult.body.orders : [];
    lastOrder = orders.find((order) => String(order?.id ?? "") === orderId) ?? null;
    const workflow = String(lastOrder?.workflowStatus ?? "").trim().toLowerCase();
    if (allowedWorkflows.includes(workflow)) {
      return { attempts, result: lastResult, order: lastOrder };
    }
    await sleep(options.readbackIntervalMs);
  }
  return { attempts, result: lastResult, order: lastOrder };
}

function isPaidOrder(order) {
  if (!order || typeof order !== "object") return false;
  const paymentStatus = String(order.paymentStatus ?? "").trim().toLowerCase();
  const dueAmount = Number(order.dueAmount ?? 0);
  const paidAmount = Number(order.paidAmount ?? 0);
  const total = Number(order.total ?? 0);
  if (paymentStatus === "paid") return true;
  return Number.isFinite(dueAmount) && dueAmount <= 0.009 && Number.isFinite(paidAmount) && paidAmount + 0.009 >= total;
}

async function waitForPaidOrder(session, orderId) {
  const deadline = performance.now() + options.readbackTimeoutMs;
  let attempts = 0;
  let lastResult = null;
  let lastOrder = null;
  while (performance.now() <= deadline) {
    attempts += 1;
    lastResult = await fetchOrder(session, orderId);
    const orders = Array.isArray(lastResult.body?.orders) ? lastResult.body.orders : [];
    lastOrder = orders.find((order) => String(order?.id ?? "") === orderId) ?? null;
    if (isPaidOrder(lastOrder)) {
      return { attempts, result: lastResult, order: lastOrder };
    }
    await sleep(options.readbackIntervalMs);
  }
  return { attempts, result: lastResult, order: lastOrder };
}

async function payOrder(session, table, order) {
  const amountDue = roundMoney(Math.max(Number(order?.dueAmount ?? 0) || Number(order?.total ?? 0) || options.productPrice, 0));
  const lock = await lockTable(session, options.mobileDeviceUuid, table, "state_machine_ab.payment");
  if (lock.status !== 200) return { lock };
  try {
    const payment = await requestJson("/api/payments/free-split", {
      method: "POST",
      headers: authHeaders(session, options.mobileDeviceUuid),
      body: authPayload(session, options.mobileDeviceUuid, {
        tableId: table.id,
        roomId: table.roomId,
        orderId: order.id,
        splitType: "FREE_SPLIT",
        splitMode: "single",
        issueFiscal: false,
        releaseTable: false,
        idempotencyKey: `${runId}:payment`,
        parts: [
          {
            amountDue,
            transactions: [
              {
                method: "CASH",
                methodId: "pay_cash",
                methodLabel: "Contanti",
                amountPaid: amountDue,
                cashGiven: amountDue,
              },
            ],
          },
        ],
      }),
    });
    return { lock, payment, amountDue };
  } finally {
    await releaseTable(session, options.mobileDeviceUuid, table);
  }
}

async function printOrder(session, order, kind = "preconto") {
  return requestJson("/api/integration/print", {
    method: "POST",
    headers: authHeaders(session, options.stationDeviceUuid),
    body: authPayload(session, options.stationDeviceUuid, {
      kind,
      orderId: order.id,
      tableId: order.tableId,
      roomId: order.roomId,
      tablePrecontoMode: kind === "preconto" ? "complete" : undefined,
    }),
  });
}

async function cancelOrder(session, table, order) {
  const lock = await lockTable(session, options.mobileDeviceUuid, table, "state_machine_ab.cleanup");
  if (lock.status !== 200) return { lock };
  try {
    const cancel = await requestJson("/api/integration/orders/cancel", {
      method: "POST",
      headers: authHeaders(session, options.mobileDeviceUuid),
      body: authPayload(session, options.mobileDeviceUuid, {
        orderId: order.id,
        tableId: order.tableId,
        roomId: order.roomId ?? table.roomId,
        expectedRevision: order.revision ?? order.currentRevision ?? 1,
        reason: `state-machine cleanup ${runId}`,
        idempotencyKey: `${runId}:cleanup`,
      }),
    });
    return { lock, cancel };
  } finally {
    await releaseTable(session, options.mobileDeviceUuid, table);
  }
}

function compactOrder(order) {
  if (!order || typeof order !== "object") return null;
  return {
    id: order.id ?? "",
    workflowStatus: order.workflowStatus ?? "",
    paymentStatus: order.paymentStatus ?? "",
    orderState: order.orderState ?? null,
    orderStatePath: Array.isArray(order.orderStatePath) ? order.orderStatePath : null,
    total: order.total ?? null,
    paidAmount: order.paidAmount ?? null,
    dueAmount: order.dueAmount ?? null,
    revision: order.revision ?? order.currentRevision ?? null,
    station: order.station ?? "",
    ownerStation: order.ownerStation ?? "",
    tableId: order.tableId ?? "",
    roomId: order.roomId ?? "",
  };
}

function compactResponse(result, extra = {}) {
  return {
    status: result?.status ?? null,
    ok: result?.ok ?? false,
    durationMs: result?.durationMs ?? null,
    proxyRole: result?.proxyRole ?? "",
    desiredProxyRole: result?.desiredProxyRole ?? "",
    code: result?.body?.code ?? "",
    error: result?.body?.error ?? "",
    ...extra,
  };
}

function evaluate(result) {
  const checks = {
    loginOk: result.loginOk === true,
    stationOk: result.station?.ok === true,
    layoutOk: result.layout?.status === 200,
    createOk: result.create?.status === 200 && Boolean(result.orders?.created?.id),
    readyOk:
      result.ready?.status === 200 &&
      ["ready", "delivered"].includes(String(result.orders?.ready?.workflowStatus ?? "").toLowerCase()),
    deliveredOk:
      result.delivered?.status === 200 &&
      String(result.orders?.delivered?.workflowStatus ?? "").toLowerCase() === "delivered",
    paymentOk: result.payment?.status === 200,
    paidReadbackOk: isPaidOrder(result.orders?.paid),
    printOk:
      result.print?.status === 202 &&
      (options.requirePrintingDisabled ? result.print.disabled === true || result.print.code === "PRINTING_DISABLED" : true),
    noFiscalRequested: result.payment?.issueFiscal === false,
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => ok !== true)
    .map(([name]) => name);
  return {
    checks,
    passed: failed.length === 0,
    failed,
  };
}

async function writeReport(reportDir, result) {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const lines = [
    `# State Machine A/B Canary - ${result.variant}`,
    "",
    `- runId: ${result.runId}`,
    `- startedAt: ${result.startedAtIso}`,
    `- finishedAt: ${result.finishedAtIso}`,
    `- frontend: ${options.frontendOrigin}`,
    `- user: ${options.username}`,
    `- station: ${result.station?.station ?? "n.d."}`,
    `- table: ${result.table?.id ?? "n.d."}`,
    `- create: ${result.create?.status ?? "n.d."} (${result.create?.durationMs ?? "n.d."} ms)`,
    `- ready: ${result.ready?.status ?? "n.d."} (${result.ready?.durationMs ?? "n.d."} ms) -> ${result.orders?.ready?.workflowStatus ?? "n.d."}`,
    `- delivered: ${result.delivered?.status ?? "n.d."} (${result.delivered?.durationMs ?? "n.d."} ms) -> ${result.orders?.delivered?.workflowStatus ?? "n.d."}`,
    `- payment: ${result.payment?.status ?? "n.d."} (${result.payment?.durationMs ?? "n.d."} ms)`,
    `- print: ${result.print?.status ?? "n.d."} (${result.print?.durationMs ?? "n.d."} ms) disabled=${result.print?.disabled === true ? "yes" : "no"}`,
    `- gate: ${result.evaluation?.passed ? "PASS" : "FAIL"}`,
    "",
  ];
  if (result.evaluation?.failed?.length) {
    lines.push(`Failed checks: ${result.evaluation.failed.join(", ")}`, "");
  }
  await fs.writeFile(path.join(reportDir, "REPORT.md"), `${lines.join("\n")}\n`);
}

async function main() {
  console.log(`[state-machine-ab] variant=${options.variant} frontend=${options.frontendOrigin}`);
  const result = {
    runId,
    variant: options.variant,
    startedAtIso: new Date().toISOString(),
    options: { ...options, pin: "***" },
    loginOk: false,
  };
  let mobile = null;
  let stationSession = null;
  let table = null;
  let lastOrder = null;

  try {
    mobile = await login("mobile-frontend", options.mobileDeviceUuid);
    stationSession = await login("postazione", options.stationDeviceUuid);
    result.loginOk = true;

    const station = await ensureActiveStation(stationSession);
    result.station = {
      ok: true,
      station: station.station,
      activated: station.activated === true,
      occupiedButActive: station.occupiedButActive === true,
      attempts: station.attempts,
    };

    const layout = await requestJson("/api/integration/layout");
    result.layout = compactResponse(layout, {
      tables: Array.isArray(layout.body?.tables) ? layout.body.tables.length : 0,
      bodyOnError: layout.status === 200 ? undefined : layout.body,
    });
    if (layout.status !== 200) throw new Error(`layout failed: ${layout.status}`);
    table = selectTable(layout.body);
    result.table = {
      id: table.id,
      roomId: table.roomId,
      roomName: table.roomName,
      number: table.number,
    };

    result.lockCreate = await lockTable(mobile, options.mobileDeviceUuid, table, "state_machine_ab.create");
    if (result.lockCreate.status !== 200) throw new Error(`create lock failed: ${result.lockCreate.status}`);
    try {
      const created = await createOrder(mobile, table);
      const createdOrder = created.body?.order ?? null;
      result.create = compactResponse(created, { order: compactOrder(createdOrder) });
      if (created.status !== 200 || !createdOrder?.id) {
        throw new Error(`create failed: ${created.status} ${created.body?.error ?? created.body?.code ?? ""}`);
      }
      lastOrder = createdOrder;
    } finally {
      result.unlockCreate = await releaseTable(mobile, options.mobileDeviceUuid, table);
    }

    const ready = await syncOrder(stationSession, lastOrder, "ready", result.station.station);
    const readyOrder = ready.body?.order ?? null;
    result.ready = compactResponse(ready, { order: compactOrder(readyOrder) });
    if (ready.status !== 200 || !readyOrder?.id) {
      throw new Error(`ready sync failed: ${ready.status} ${ready.body?.error ?? ready.body?.code ?? ""}`);
    }
    lastOrder = readyOrder;
    const readyReadback = await waitForOrder(mobile, lastOrder.id, ["ready", "delivered"]);
    result.readyReadback = compactResponse(readyReadback.result, {
      attempts: readyReadback.attempts,
      order: compactOrder(readyReadback.order),
    });
    if (readyReadback.order) lastOrder = readyReadback.order;

    const delivered = await syncOrder(stationSession, lastOrder, "delivered", result.station.station);
    const deliveredOrder = delivered.body?.order ?? null;
    result.delivered = compactResponse(delivered, { order: compactOrder(deliveredOrder) });
    if (delivered.status !== 200 || !deliveredOrder?.id) {
      throw new Error(`delivered sync failed: ${delivered.status} ${delivered.body?.error ?? delivered.body?.code ?? ""}`);
    }
    lastOrder = deliveredOrder;
    const deliveredReadback = await waitForOrder(mobile, lastOrder.id, ["delivered"]);
    result.deliveredReadback = compactResponse(deliveredReadback.result, {
      attempts: deliveredReadback.attempts,
      order: compactOrder(deliveredReadback.order),
    });
    if (deliveredReadback.order) lastOrder = deliveredReadback.order;

    const paymentResult = await payOrder(mobile, table, lastOrder);
    result.paymentLock = compactResponse(paymentResult.lock);
    result.payment = compactResponse(paymentResult.payment, {
      amountDue: paymentResult.amountDue,
      issueFiscal: false,
      paymentState:
        paymentResult.payment?.body?.payment?.paymentState ??
        paymentResult.payment?.body?.paymentState ??
        null,
      paymentStatus:
        paymentResult.payment?.body?.payment?.paymentStatus ??
        paymentResult.payment?.body?.paymentStatus ??
        null,
    });
    if (paymentResult.payment?.status !== 200) {
      throw new Error(`payment failed: ${paymentResult.payment?.status ?? "n.d."} ${paymentResult.payment?.body?.error ?? paymentResult.payment?.body?.code ?? ""}`);
    }

    const paidReadback = await waitForPaidOrder(mobile, lastOrder.id);
    result.paidReadback = compactResponse(paidReadback.result, {
      attempts: paidReadback.attempts,
      order: compactOrder(paidReadback.order),
    });
    if (paidReadback.order) lastOrder = paidReadback.order;

    const print = await printOrder(stationSession, lastOrder, "preconto");
    result.print = compactResponse(print, {
      accepted: print.body?.accepted === true,
      disabled: print.body?.disabled === true,
      queued: print.body?.queued === true,
      statusText: print.body?.status ?? "",
      jobId: print.body?.jobId ?? "",
      printState: print.body?.printState ?? null,
    });
    if (print.status !== 202) {
      throw new Error(`print request failed: ${print.status} ${print.body?.error ?? print.body?.code ?? ""}`);
    }

    if (options.cleanup) {
      const cleanup = await cancelOrder(mobile, table, lastOrder);
      result.cleanupLock = compactResponse(cleanup.lock);
      result.cleanup = compactResponse(cleanup.cancel, {
        order: compactOrder(cleanup.cancel?.body?.order ?? null),
      });
    }

    result.orders = {
      created: result.create?.order ?? null,
      ready: result.readyReadback?.order ?? result.ready?.order ?? null,
      delivered: result.deliveredReadback?.order ?? result.delivered?.order ?? null,
      paid: result.paidReadback?.order ?? null,
    };
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (lastOrder) result.lastOrder = compactOrder(lastOrder);
  } finally {
    result.finishedAtIso = new Date().toISOString();
    result.evaluation = evaluate(result);
    const reportDir = path.join(options.reportRoot, `state-machine-ab-canary-${runId}`);
    result.reportDir = reportDir;
    await writeReport(reportDir, result);
    console.log(`[state-machine-ab] report=${reportDir}`);
    console.log(`[state-machine-ab] gate=${result.evaluation.passed ? "PASS" : "FAIL"} failed=${result.evaluation.failed.join(",") || "-"}`);
    if (!result.evaluation.passed) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[state-machine-ab] fatal", error);
  process.exitCode = 1;
});
