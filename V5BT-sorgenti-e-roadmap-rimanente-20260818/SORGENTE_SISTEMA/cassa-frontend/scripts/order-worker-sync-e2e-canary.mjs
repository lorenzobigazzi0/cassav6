import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(cassaRoot, "..");

function envString(name, fallback) {
  const value = String(process.env[name] ?? "").trim();
  return value || fallback;
}

function envBool(name, fallback = false) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function parseIntEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

const options = {
  frontendOrigin: envString("CANARY_FRONTEND_ORIGIN", "https://127.0.0.1:5280").replace(/\/+$/, ""),
  username: envString("CANARY_USERNAME", "lorenzo"),
  pin: envString("CANARY_PIN", "1234"),
  mobileDeviceUuid: envString("CANARY_MOBILE_DEVICE_UUID", `mp4-sync-mobile-${Date.now()}`),
  stationDeviceUuid: envString("CANARY_STATION_DEVICE_UUID", `mp4-sync-station-${Date.now()}`),
  tableId: envString("CANARY_TABLE_ID", ""),
  roomId: envString("CANARY_ROOM_ID", ""),
  station: envString("CANARY_STATION", "BAR PRINCIPALE"),
  syncWorkflowStatus: envString("CANARY_SYNC_WORKFLOW_STATUS", "prep").toLowerCase(),
  productId: envString("CANARY_PRODUCT_ID", "menu_caffetteria_caffe"),
  productName: envString("CANARY_PRODUCT_NAME", "Caffe"),
  productPrice: Number(envString("CANARY_PRODUCT_PRICE", "1.3")),
  timeoutMs: parseIntEnv("CANARY_TIMEOUT_MS", 15_000, { min: 1_000, max: 120_000 }),
  readbackTimeoutMs: parseIntEnv("CANARY_READBACK_TIMEOUT_MS", 6_000, { min: 500, max: 60_000 }),
  readbackIntervalMs: parseIntEnv("CANARY_READBACK_INTERVAL_MS", 150, { min: 25, max: 5_000 }),
  reportRoot: envString("CANARY_REPORT_ROOT", path.join(repoRoot, "logs")),
  cleanup: !envBool("CANARY_SKIP_CLEANUP", false),
  requireCleanup: envBool("CANARY_REQUIRE_CLEANUP", true),
  requireLineSplit: envBool("CANARY_REQUIRE_LINE_SPLIT", false),
  requireBarReplacement: envBool("CANARY_REQUIRE_BAR_REPLACEMENT", false),
  requireCorrect: envBool("CANARY_REQUIRE_CORRECT", false),
  requireComp: envBool("CANARY_REQUIRE_COMP", false),
  requireTransferResolve: envBool("CANARY_REQUIRE_TRANSFER_RESOLVE", false),
  transferTargetStation: envString("CANARY_TRANSFER_TARGET_STATION", "COCKTAIL"),
  requireTransferForce: envBool("CANARY_REQUIRE_TRANSFER_FORCE", false),
  transferForceTargetStation: envString("CANARY_TRANSFER_FORCE_TARGET_STATION", "CUCINA"),
  requirePriceOverride: envBool("CANARY_REQUIRE_PRICE_OVERRIDE", false),
  priceOverrideUnitPrice: Number(envString("CANARY_PRICE_OVERRIDE_UNIT_PRICE", "2.5")),
  requireStorno: envBool("CANARY_REQUIRE_STORNO", false),
  insecureTls: String(process.env.CANARY_INSECURE_TLS ?? "1") !== "0",
  requirePrintingDisabled: envBool("CANARY_REQUIRE_PRINTING_DISABLED", true),
  expectedCreateProxyRole: envString("CANARY_EXPECT_CREATE_PROXY_ROLE", "api-worker"),
  expectedLineSplitProxyRole: envString("CANARY_EXPECT_LINE_SPLIT_PROXY_ROLE", ""),
  expectedBarReplacementProxyRole: envString("CANARY_EXPECT_BAR_REPLACEMENT_PROXY_ROLE", ""),
  expectedTransferRequestProxyRole: envString("CANARY_EXPECT_TRANSFER_REQUEST_PROXY_ROLE", ""),
  expectedTransferResolveProxyRole: envString("CANARY_EXPECT_TRANSFER_RESOLVE_PROXY_ROLE", ""),
  expectedTransferForceProxyRole: envString("CANARY_EXPECT_TRANSFER_FORCE_PROXY_ROLE", ""),
  expectedPriceOverrideProxyRole: envString("CANARY_EXPECT_PRICE_OVERRIDE_PROXY_ROLE", ""),
  expectedStornoProxyRole: envString("CANARY_EXPECT_STORNO_PROXY_ROLE", ""),
  expectedCorrectProxyRole: envString("CANARY_EXPECT_CORRECT_PROXY_ROLE", ""),
  expectedSyncProxyRole: envString("CANARY_EXPECT_SYNC_PROXY_ROLE", "api-worker"),
  expectedCompProxyRole: envString("CANARY_EXPECT_COMP_PROXY_ROLE", ""),
  expectedCleanupProxyRole: envString("CANARY_EXPECT_CLEANUP_PROXY_ROLE", ""),
};

const CANCEL_CLEANUP_WORKFLOWS = new Set(["prep", "preparing", "waiting"]);

if (options.insecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const runId = envString("CANARY_RUN_ID", `ordersynce2e_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`);

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
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
    throw new Error(`login ${clientApp} fallito: ${result.status} ${result.body?.error ?? result.body?.code ?? ""}`);
  }
  return result.body;
}

function selectTable(layout) {
  const tables = Array.isArray(layout?.tables) ? layout.tables : [];
  if (options.tableId) {
    const selected = tables.find((table) => String(table?.id ?? "") === options.tableId);
    if (!selected) throw new Error(`tavolo richiesto non trovato: ${options.tableId}`);
    return selected;
  }
  const freeTables = tables.filter((table) => {
    const pending = Array.isArray(table?.pendingBills) ? table.pendingBills.length : 0;
    const amountDue = Number(table?.amountDue ?? table?.totalDue ?? 0) || 0;
    const occupancy = String(table?.occupancyState ?? table?.status ?? "").trim().toLowerCase();
    return pending === 0 && amountDue <= 0 && (!occupancy || ["free", "available", "libero"].includes(occupancy));
  });
  const preferred =
    freeTables.find((table) => String(table?.roomId ?? "") === options.roomId && options.roomId) ??
    freeTables.find((table) => String(table?.roomId ?? "") === "room_bar") ??
    freeTables.find((table) => !String(table?.roomId ?? "").includes("attesa")) ??
    freeTables[0];
  if (!preferred) throw new Error("nessun tavolo libero disponibile per il canary");
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
    productId: options.productId,
    qty: options.requireLineSplit ? 2 : 1,
    price: options.productPrice,
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
      note: `canary orders/sync ${runId}`,
      orderNote: `canary orders/sync ${runId}`,
      communications: "canary multiprocess e2e",
      orderComment: "canary multiprocess e2e",
      total: options.productPrice * line.qty,
      autoPrintOrders: false,
      autoPrintPreconto: false,
      idempotencyKey: `${runId}:create`,
      lines: [line],
    }),
  });
}

async function lineSplitOrder(session, table, order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const line = items.find((item) => !item?.voidedAt && item?.lineId) ?? items[0] ?? null;
  const lock = await lockTable(session, options.mobileDeviceUuid, table, "order.line_split");
  if (lock.status !== 200) return lock;
  try {
    return await requestJson("/api/integration/orders/line/split", {
      method: "POST",
      headers: authHeaders(session, options.mobileDeviceUuid),
      body: authPayload(session, options.mobileDeviceUuid, {
        orderId: order.id,
        tableId: order.tableId,
        roomId: order.roomId ?? table.roomId,
        lineId: line?.lineId ?? "",
        qty: 1,
        markDelivered: false,
        expectedRevision: order.revision ?? order.currentRevision ?? 1,
      }),
    });
  } finally {
    await releaseTable(session, options.mobileDeviceUuid, table);
  }
}

async function syncOrder(session, order) {
  const markDone = ["ready", "delivered"].includes(options.syncWorkflowStatus);
  return requestJson("/api/integration/orders/sync", {
    method: "POST",
    headers: authHeaders(session, options.stationDeviceUuid),
    body: authPayload(session, options.stationDeviceUuid, {
      id: order.id,
      clientApp: "postazione",
      workflowReason: "mp4_order_worker_sync_e2e_canary",
      order: {
        ...order,
        workflowStatus: options.syncWorkflowStatus,
        station: order.station || options.station,
        ownerStation: order.ownerStation || order.station || options.station,
        items: Array.isArray(order.items)
          ? order.items.map((item) => ({ ...item, done: markDone ? true : item.done === true }))
          : [],
      },
    }),
  });
}

async function correctOrder(session, table, order) {
  const lock = await lockTable(session, options.mobileDeviceUuid, table, "mp4.order.sync.canary.correct");
  if (lock.status !== 200) return lock;
  try {
    return await requestJson("/api/integration/orders/correct", {
      method: "POST",
      headers: authHeaders(session, options.mobileDeviceUuid),
      body: authPayload(session, options.mobileDeviceUuid, {
        orderId: order.id,
        tableId: order.tableId,
        roomId: order.roomId ?? table.roomId,
        expectedRevision: order.revision ?? order.currentRevision ?? 1,
        addedItems: [{ productId: "menu_caffetteria_cappuccino", quantity: 1 }],
        reason: `Correct canary ${runId}`,
        idempotencyKey: `${runId}:correct`,
      }),
    });
  } finally {
    await releaseTable(session, options.mobileDeviceUuid, table);
  }
}

async function barReplacementOrder(session, table, order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const line =
    items.find((item) => !item?.voidedAt && item?.lineType !== "BAR_CHARGE_REPLACEMENT") ??
    items[0] ??
    null;
  const lock = await lockTable(session, options.mobileDeviceUuid, table, "bar_charge_replacement");
  if (lock.status !== 200) return lock;
  try {
    return await requestJson("/api/integration/orders/replacement/bar-charge", {
      method: "POST",
      headers: authHeaders(session, options.mobileDeviceUuid),
      body: authPayload(session, options.mobileDeviceUuid, {
        orderId: order.id,
        tableId: order.tableId,
        roomId: order.roomId ?? table.roomId,
        originalLineId: line?.lineId ?? "",
        productId: line?.productId ?? options.productId,
        quantity: 1,
        reason: `Bar replacement canary ${runId}`,
        idempotencyKey: `${runId}:bar-replacement`,
      }),
    });
  } finally {
    await releaseTable(session, options.mobileDeviceUuid, table);
  }
}

async function priceOverrideOrder(session, table, order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const line = items.find((item) => !item?.voidedAt && item?.lineId) ?? items[0] ?? null;
  const lock = await lockTable(session, options.mobileDeviceUuid, table, "order.price_override");
  if (lock.status !== 200) return lock;
  try {
    return await requestJson("/api/integration/orders/line/price-override", {
      method: "POST",
      headers: authHeaders(session, options.mobileDeviceUuid),
      body: authPayload(session, options.mobileDeviceUuid, {
        orderId: order.id,
        lineId: line?.lineId ?? "",
        unitPriceApplied: options.priceOverrideUnitPrice,
        listPriceAtTime: options.priceOverrideUnitPrice,
        reason: `Price override canary ${runId}`,
        expectedRevision: order.revision ?? order.currentRevision ?? 1,
      }),
    });
  } finally {
    await releaseTable(session, options.mobileDeviceUuid, table);
  }
}

async function transferRequestOrder(session, order) {
  return requestJson("/api/integration/orders/transfer/request", {
    method: "POST",
    headers: authHeaders(session, options.mobileDeviceUuid),
    body: authPayload(session, options.mobileDeviceUuid, {
      orderId: order.id,
      mode: "transfer",
      requesterStation: options.transferTargetStation,
      targetStation: options.transferTargetStation,
      requesterOperator: "Canary Transfer",
      requesterRole: "Responsabile",
      expectedRevision: order.revision ?? order.currentRevision ?? 1,
      idempotencyKey: `${runId}:transfer-request`,
    }),
  });
}

async function transferResolveOrder(session, order) {
  const pending = order?.pendingAuthRequest ?? {};
  return requestJson("/api/integration/orders/transfer/resolve", {
    method: "POST",
    headers: authHeaders(session, options.mobileDeviceUuid),
    body: authPayload(session, options.mobileDeviceUuid, {
      orderId: order.id,
      approve: true,
      approverStation: pending.fromStation ?? order.station ?? options.station,
      approverOperator: "Canary Approver",
      expectedRevision: order.revision ?? order.currentRevision ?? 1,
    }),
  });
}

async function transferForceOrder(session, order) {
  return requestJson("/api/integration/orders/transfer/force", {
    method: "POST",
    headers: authHeaders(session, options.mobileDeviceUuid),
    body: authPayload(session, options.mobileDeviceUuid, {
      orderId: order.id,
      fromStation: order.station ?? order.ownerStation ?? options.station,
      toStation: options.transferForceTargetStation,
      operatorName: "Canary Force",
      operatorRole: "Responsabile",
      expectedRevision: order.revision ?? order.currentRevision ?? 1,
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

async function waitForOrderReadback(session, orderId) {
  const deadline = performance.now() + options.readbackTimeoutMs;
  let attempts = 0;
  let lastResult = null;
  let lastOrder = null;
  while (performance.now() <= deadline) {
    attempts += 1;
    lastResult = await fetchOrder(session, orderId);
    const readbackOrders = Array.isArray(lastResult.body?.orders) ? lastResult.body.orders : [];
    lastOrder = readbackOrders.find((order) => String(order?.id ?? "") === orderId) ?? null;
    const workflow = String(lastOrder?.workflowStatus ?? "").trim().toLowerCase();
    if ([options.syncWorkflowStatus, "ready", "delivered"].includes(workflow)) {
      return { attempts, result: lastResult, order: lastOrder };
    }
    await sleep(options.readbackIntervalMs);
  }
  return { attempts, result: lastResult, order: lastOrder };
}

async function cancelOrder(session, table, order) {
  const lock = await lockTable(session, options.mobileDeviceUuid, table, "mp4.order.sync.canary.cleanup");
  if (lock.status !== 200) return lock;
  try {
    return await requestJson("/api/integration/orders/cancel", {
      method: "POST",
      headers: authHeaders(session, options.mobileDeviceUuid),
      body: authPayload(session, options.mobileDeviceUuid, {
        orderId: order.id,
        tableId: order.tableId,
        roomId: order.roomId ?? table.roomId,
        expectedRevision: order.revision ?? order.currentRevision ?? 1,
        reason: `Pulizia canary ${runId}`,
        idempotencyKey: `${runId}:cancel`,
      }),
    });
  } finally {
    await releaseTable(session, options.mobileDeviceUuid, table);
  }
}

async function compOrder(session, table, order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const line = items.find((item) => !item?.voidedAt && !item?.compedAt) ?? items[0] ?? null;
  const lock = await lockTable(session, options.mobileDeviceUuid, table, "mp4.order.sync.canary.comp");
  if (lock.status !== 200) return lock;
  try {
    return await requestJson("/api/integration/orders/comp", {
      method: "POST",
      headers: authHeaders(session, options.mobileDeviceUuid),
      body: authPayload(session, options.mobileDeviceUuid, {
        orderId: order.id,
        tableId: order.tableId,
        roomId: order.roomId ?? table.roomId,
        originalLineId: line?.lineId ?? "",
        productId: line?.productId ?? options.productId,
        quantity: 1,
        reason: `Comp canary ${runId}`,
        idempotencyKey: `${runId}:comp`,
      }),
    });
  } finally {
    await releaseTable(session, options.mobileDeviceUuid, table);
  }
}

async function payTable(session, table, order) {
  const amountDue = roundMoney(
    Math.max(
      Number(order?.dueAmount ?? 0) ||
        Number(order?.total ?? 0) ||
        options.productPrice,
      0,
    ),
  );
  const lock = await lockTable(session, options.mobileDeviceUuid, table, "payment.free_split");
  if (lock.status !== 200) return lock;
  try {
    return await requestJson("/api/payments/free-split", {
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
        idempotencyKey: `${runId}:payment-table`,
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
  } finally {
    await releaseTable(session, options.mobileDeviceUuid, table);
  }
}

async function stornoOrder(session, table, order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const line = items.find((item) => !item?.voidedAt && !item?.compedAt && item?.lineId) ?? items[0] ?? null;
  const lock = await lockTable(session, options.mobileDeviceUuid, table, "order.comp");
  if (lock.status !== 200) return lock;
  try {
    return await requestJson("/api/integration/orders/storno", {
      method: "POST",
      headers: authHeaders(session, options.mobileDeviceUuid),
      body: authPayload(session, options.mobileDeviceUuid, {
        orderId: order.id,
        tableId: order.tableId,
        roomId: order.roomId ?? table.roomId,
        originalLineId: line?.lineId ?? "",
        productId: line?.productId ?? options.productId,
        quantity: 1,
        reason: `Storno canary ${runId}`,
        expectedRevision: order.revision ?? order.currentRevision ?? 1,
        idempotencyKey: `${runId}:storno`,
      }),
    });
  } finally {
    await releaseTable(session, options.mobileDeviceUuid, table);
  }
}

async function writeReport(reportDir, result) {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const lines = [
    `# Canary orders/sync e2e ${runId}`,
    "",
    `Data: ${new Date().toISOString()}`,
    "",
    "## Configurazione",
    "",
    `- frontend origin: ${options.frontendOrigin}`,
    `- user: ${options.username}`,
    `- table: ${result.table?.id ?? "n.d."} (${result.table?.roomName ?? result.table?.roomId ?? "-"})`,
    `- sync workflow target: ${options.syncWorkflowStatus}`,
    `- printing guard required: ${result.requirePrintingDisabled ? "yes" : "no"}`,
    `- printing guard confirmed: ${result.printingDisabledConfirmed ? "yes" : "no"}`,
    `- line split required: ${result.lineSplitRequired ? "yes" : "no"}`,
    `- storno required: ${result.stornoRequired ? "yes" : "no"}`,
    "",
    "## Esito",
    "",
    `- login mobile/station: ${result.loginOk ? "yes" : "no"}`,
    `- create status: ${result.create?.status ?? "n.d."}`,
    `- create proxy role: ${result.create?.proxyRole || "n.d."}`,
    `- created order: ${result.createdOrderId || "n.d."}`,
    `- line split attempted: ${result.lineSplitAttempted ? "yes" : "no"}`,
    `- line split status: ${result.lineSplit?.status ?? "n.d."}`,
    `- line split proxy role: ${result.lineSplit?.proxyRole || "n.d."}`,
    `- line split new line: ${result.lineSplitNewLineId || "n.d."}`,
    `- line split order: ${result.lineSplitOrderId || "n.d."}`,
    `- line split revision: ${result.lineSplitRevision ?? "n.d."}`,
    `- bar replacement attempted: ${result.barReplacementAttempted ? "yes" : "no"}`,
    `- bar replacement status: ${result.barReplacement?.status ?? "n.d."}`,
    `- bar replacement proxy role: ${result.barReplacement?.proxyRole || "n.d."}`,
    `- bar replacement record: ${result.barReplacementId || "n.d."}`,
    `- bar replacement order: ${result.barReplacementOrderId || "n.d."}`,
    `- bar replacement revision: ${result.barReplacementRevision ?? "n.d."}`,
    `- correct attempted: ${result.correctAttempted ? "yes" : "no"}`,
    `- correct status: ${result.correct?.status ?? "n.d."}`,
    `- correct proxy role: ${result.correct?.proxyRole || "n.d."}`,
    `- corrected order: ${result.correctedOrderId || "n.d."}`,
    `- corrected revision: ${result.correctedRevision ?? "n.d."}`,
    `- price override attempted: ${result.priceOverrideAttempted ? "yes" : "no"}`,
    `- price override status: ${result.priceOverride?.status ?? "n.d."}`,
    `- price override proxy role: ${result.priceOverride?.proxyRole || "n.d."}`,
    `- price overridden order: ${result.priceOverriddenOrderId || "n.d."}`,
    `- price overridden revision: ${result.priceOverriddenRevision ?? "n.d."}`,
    `- price overridden total: ${result.priceOverriddenTotal ?? "n.d."}`,
    `- transfer resolve attempted: ${result.transferResolveAttempted ? "yes" : "no"}`,
    `- transfer request status: ${result.transferRequest?.status ?? "n.d."}`,
    `- transfer request proxy role: ${result.transferRequest?.proxyRole || "n.d."}`,
    `- transfer resolve status: ${result.transferResolve?.status ?? "n.d."}`,
    `- transfer resolve proxy role: ${result.transferResolve?.proxyRole || "n.d."}`,
    `- transfer resolved order: ${result.transferResolvedOrderId || "n.d."}`,
    `- transfer resolved revision: ${result.transferResolvedRevision ?? "n.d."}`,
    `- transfer resolved station: ${result.transferResolvedStation || "n.d."}`,
    `- transfer force attempted: ${result.transferForceAttempted ? "yes" : "no"}`,
    `- transfer force status: ${result.transferForce?.status ?? "n.d."}`,
    `- transfer force proxy role: ${result.transferForce?.proxyRole || "n.d."}`,
    `- transfer forced order: ${result.transferForcedOrderId || "n.d."}`,
    `- transfer forced revision: ${result.transferForcedRevision ?? "n.d."}`,
    `- transfer forced station: ${result.transferForcedStation || "n.d."}`,
    `- sync status: ${result.sync?.status ?? "n.d."}`,
    `- sync proxy role: ${result.sync?.proxyRole || "n.d."}`,
    `- synced order: ${result.syncedOrderId || "n.d."}`,
    `- synced workflow: ${result.syncedWorkflowStatus || "n.d."}`,
    `- synced revision: ${result.syncedRevision ?? "n.d."}`,
    `- readback status: ${result.readback?.status ?? "n.d."}`,
    `- readback found: ${result.readbackFound ? "yes" : "no"}`,
    `- readback workflow: ${result.readbackWorkflowStatus || "n.d."}`,
    `- readback attempts: ${result.readbackAttempts ?? "n.d."}`,
    `- comp attempted: ${result.compAttempted ? "yes" : "no"}`,
    `- comp status: ${result.comp?.status ?? "n.d."}`,
    `- comp proxy role: ${result.comp?.proxyRole || "n.d."}`,
    `- comped order: ${result.compedOrderId || "n.d."}`,
    `- comped total/due: ${result.compedTotal ?? "n.d."}/${result.compedDueAmount ?? "n.d."}`,
    `- pre-storno payment attempted: ${result.tablePaymentAttempted ? "yes" : "no"}`,
    `- pre-storno payment status: ${result.tablePayment?.status ?? "n.d."}`,
    `- pre-storno payment route: ${result.tablePayment?.pathname || "n.d."}`,
    `- pre-storno payment proxy role: ${result.tablePayment?.proxyRole || "n.d."}`,
    `- storno attempted: ${result.stornoAttempted ? "yes" : "no"}`,
    `- storno status: ${result.storno?.status ?? "n.d."}`,
    `- storno proxy role: ${result.storno?.proxyRole || "n.d."}`,
    `- storno comp: ${result.stornoCompId || "n.d."}`,
    `- storno order: ${result.stornoOrderId || "n.d."}`,
    `- storno revision: ${result.stornoRevision ?? "n.d."}`,
    `- storno total/due: ${result.stornoTotal ?? "n.d."}/${result.stornoDueAmount ?? "n.d."}`,
    `- storno print job: ${result.stornoPrintJobId || "n.d."}`,
    `- cleanup attempted: ${result.cleanupAttempted ? "yes" : "no"}`,
    `- cleanup status: ${result.cleanup?.status ?? "n.d."}`,
    `- cleanup proxy role: ${result.cleanup?.proxyRole || "n.d."}`,
    `- cleanup required: ${result.cleanupRequired ? "yes" : "no"}`,
    "",
    "## Gate",
    "",
    `- expected create proxy role: ${options.expectedCreateProxyRole}`,
    `- expected line split proxy role: ${options.expectedLineSplitProxyRole || "n.d."}`,
    `- expected bar replacement proxy role: ${options.expectedBarReplacementProxyRole || "n.d."}`,
    `- expected correct proxy role: ${options.expectedCorrectProxyRole || "n.d."}`,
    `- expected sync proxy role: ${options.expectedSyncProxyRole}`,
    `- expected comp proxy role: ${options.expectedCompProxyRole || "n.d."}`,
    `- expected cleanup proxy role: ${options.expectedCleanupProxyRole || "n.d."}`,
    `- create routed as expected: ${result.createRoutedAsExpected ? "yes" : "no"}`,
    `- line split routed as expected: ${result.lineSplitRoutedAsExpected ? "yes" : "no"}`,
    `- line split gate ok: ${result.lineSplitGateOk ? "yes" : "no"}`,
    `- bar replacement routed as expected: ${result.barReplacementRoutedAsExpected ? "yes" : "no"}`,
    `- bar replacement gate ok: ${result.barReplacementGateOk ? "yes" : "no"}`,
    `- correct routed as expected: ${result.correctRoutedAsExpected ? "yes" : "no"}`,
    `- correct gate ok: ${result.correctGateOk ? "yes" : "no"}`,
    `- expected price override proxy role: ${options.expectedPriceOverrideProxyRole || "n.d."}`,
    `- price override routed as expected: ${result.priceOverrideRoutedAsExpected ? "yes" : "no"}`,
    `- price override gate ok: ${result.priceOverrideGateOk ? "yes" : "no"}`,
    `- expected transfer request proxy role: ${options.expectedTransferRequestProxyRole || "n.d."}`,
    `- expected transfer resolve proxy role: ${options.expectedTransferResolveProxyRole || "n.d."}`,
    `- transfer request routed as expected: ${result.transferRequestRoutedAsExpected ? "yes" : "no"}`,
    `- transfer resolve routed as expected: ${result.transferResolveRoutedAsExpected ? "yes" : "no"}`,
    `- transfer resolve gate ok: ${result.transferResolveGateOk ? "yes" : "no"}`,
    `- expected transfer force proxy role: ${options.expectedTransferForceProxyRole || "n.d."}`,
    `- transfer force routed as expected: ${result.transferForceRoutedAsExpected ? "yes" : "no"}`,
    `- transfer force gate ok: ${result.transferForceGateOk ? "yes" : "no"}`,
    `- expected storno proxy role: ${options.expectedStornoProxyRole || "n.d."}`,
    `- storno routed as expected: ${result.stornoRoutedAsExpected ? "yes" : "no"}`,
    `- storno gate ok: ${result.stornoGateOk ? "yes" : "no"}`,
    `- sync routed as expected: ${result.syncRoutedAsExpected ? "yes" : "no"}`,
    `- comp routed as expected: ${result.compRoutedAsExpected ? "yes" : "no"}`,
    `- comp gate ok: ${result.compGateOk ? "yes" : "no"}`,
    `- cleanup routed as expected: ${result.cleanupRoutedAsExpected ? "yes" : "no"}`,
    `- sync workflow ok: ${result.syncWorkflowOk ? "yes" : "no"}`,
    `- readback workflow ok: ${result.readbackWorkflowOk ? "yes" : "no"}`,
    `- cleanup gate ok: ${result.cleanupGateOk ? "yes" : "no"}`,
    "",
  ];
  await fs.writeFile(path.join(reportDir, "REPORT.md"), `${lines.join("\n")}\n`);
}

async function main() {
  console.log(`[orders-sync-e2e] frontend=${options.frontendOrigin} user=${options.username}`);
  const result = {
    runId,
    startedAtIso: new Date().toISOString(),
    options: { ...options, pin: "***" },
    requirePrintingDisabled: options.requirePrintingDisabled,
    cleanupRequired: options.requireCleanup,
    lineSplitRequired: options.requireLineSplit,
    barReplacementRequired: options.requireBarReplacement,
    correctRequired: options.requireCorrect,
    compRequired: options.requireComp,
    transferResolveRequired: options.requireTransferResolve,
    transferForceRequired: options.requireTransferForce,
    priceOverrideRequired: options.requirePriceOverride,
    stornoRequired: options.requireStorno,
    printingDisabledConfirmed: String(process.env.PRINTING_ENABLED ?? "").trim() === "0",
    loginOk: false,
  };
  let mobile = null;
  let station = null;
  let selectedTable = null;
  let createdOrder = null;
  let syncedOrder = null;
  try {
    if (options.requirePrintingDisabled && !result.printingDisabledConfirmed) {
      throw new Error("canary e2e bloccato: rilancia con PRINTING_ENABLED=0 dopo restart del sistema senza stampa reale");
    }
    if (options.cleanup && options.requireCleanup && !CANCEL_CLEANUP_WORKFLOWS.has(options.syncWorkflowStatus)) {
      throw new Error(
        `canary e2e bloccato: CANARY_SYNC_WORKFLOW_STATUS=${options.syncWorkflowStatus} non e compatibile con cleanup via cancel; usa prep o CANARY_SKIP_CLEANUP=1`,
      );
    }

    mobile = await login("mobile-frontend", options.mobileDeviceUuid);
    station = await login("postazione", options.stationDeviceUuid);
    result.loginOk = true;

    const layout = await requestJson("/api/integration/layout");
    result.layout = {
      status: layout.status,
      proxyRole: layout.proxyRole,
      ...(layout.status === 200 ? {} : { body: layout.body }),
    };
    selectedTable = selectTable(layout.body);
    result.table = {
      id: selectedTable.id,
      roomId: selectedTable.roomId,
      roomName: selectedTable.roomName,
      number: selectedTable.number,
    };

    result.lockCreate = await lockTable(mobile, options.mobileDeviceUuid, selectedTable, "mp4.order.sync.canary.create");
    if (result.lockCreate.status !== 200) {
      throw new Error(`lock create fallito: ${result.lockCreate.status}`);
    }
    try {
      result.create = await createOrder(mobile, selectedTable);
    } finally {
      result.unlockCreate = await releaseTable(mobile, options.mobileDeviceUuid, selectedTable);
    }
    createdOrder = result.create.body?.order ?? null;
    if (result.create.status !== 200 || !createdOrder?.id) {
      throw new Error(`create fallita: ${result.create.status} ${result.create.body?.error ?? result.create.body?.code ?? ""}`);
    }
    result.createdOrderId = createdOrder.id;
    result.createRoutedAsExpected =
      !options.expectedCreateProxyRole ||
      result.create.proxyRole === options.expectedCreateProxyRole;
    result.createRoutedToOwner = result.create.proxyRole === "api-owner";

    let orderForSync = createdOrder;
    if (options.requireLineSplit) {
      result.lineSplitAttempted = true;
      result.lineSplit = await lineSplitOrder(mobile, selectedTable, orderForSync);
      result.lineSplitOk = result.lineSplit.status === 200;
      result.lineSplitRoutedAsExpected =
        !options.expectedLineSplitProxyRole || result.lineSplit.proxyRole === options.expectedLineSplitProxyRole;
      const lineSplitOrderResult = result.lineSplit.body?.order ?? null;
      result.lineSplitNewLineId = result.lineSplit.body?.newLineId ?? "";
      result.lineSplitOrderId = lineSplitOrderResult?.id ?? "";
      result.lineSplitRevision = lineSplitOrderResult?.revision ?? lineSplitOrderResult?.currentRevision ?? null;
      if (result.lineSplit.status !== 200 || !lineSplitOrderResult?.id) {
        throw new Error(`line split fallita: ${result.lineSplit.status} ${result.lineSplit.body?.error ?? result.lineSplit.body?.code ?? ""}`);
      }
      orderForSync = lineSplitOrderResult;
    } else {
      result.lineSplitAttempted = false;
      result.lineSplitOk = true;
      result.lineSplitRoutedAsExpected = true;
    }
    result.lineSplitGateOk = options.requireLineSplit ? result.lineSplitOk === true : true;

    if (options.requireBarReplacement) {
      result.barReplacementAttempted = true;
      result.barReplacement = await barReplacementOrder(mobile, selectedTable, orderForSync);
      result.barReplacementOk = result.barReplacement.status === 200;
      result.barReplacementRoutedAsExpected =
        !options.expectedBarReplacementProxyRole ||
        result.barReplacement.proxyRole === options.expectedBarReplacementProxyRole;
      const barReplacementOrderResult = result.barReplacement.body?.order ?? null;
      result.barReplacementId = result.barReplacement.body?.replacement?.id ?? "";
      result.barReplacementOrderId = barReplacementOrderResult?.id ?? "";
      result.barReplacementRevision =
        barReplacementOrderResult?.revision ?? barReplacementOrderResult?.currentRevision ?? null;
      if (result.barReplacement.status !== 200 || !barReplacementOrderResult?.id) {
        throw new Error(
          `bar replacement fallita: ${result.barReplacement.status} ${result.barReplacement.body?.error ?? result.barReplacement.body?.code ?? ""}`,
        );
      }
      orderForSync = barReplacementOrderResult;
    } else {
      result.barReplacementAttempted = false;
      result.barReplacementOk = true;
      result.barReplacementRoutedAsExpected = true;
    }
    result.barReplacementGateOk = options.requireBarReplacement ? result.barReplacementOk === true : true;

    if (options.requireCorrect) {
      result.correctAttempted = true;
      result.correct = await correctOrder(mobile, selectedTable, orderForSync);
      result.correctOk = result.correct.status === 200;
      result.correctRoutedAsExpected = !options.expectedCorrectProxyRole || result.correct.proxyRole === options.expectedCorrectProxyRole;
      const correctedOrder = result.correct.body?.order ?? null;
      result.correctedOrderId = correctedOrder?.id ?? "";
      result.correctedRevision = correctedOrder?.revision ?? correctedOrder?.currentRevision ?? null;
      if (result.correct.status !== 200 || !correctedOrder?.id) {
        throw new Error(`correct fallita: ${result.correct.status} ${result.correct.body?.error ?? result.correct.body?.code ?? ""}`);
      }
      orderForSync = correctedOrder;
    } else {
      result.correctAttempted = false;
      result.correctOk = true;
      result.correctRoutedAsExpected = true;
    }
    result.correctGateOk = options.requireCorrect ? result.correctOk === true : true;

    if (options.requirePriceOverride) {
      result.priceOverrideAttempted = true;
      result.priceOverride = await priceOverrideOrder(mobile, selectedTable, orderForSync);
      result.priceOverrideOk = result.priceOverride.status === 200;
      result.priceOverrideRoutedAsExpected =
        !options.expectedPriceOverrideProxyRole ||
        result.priceOverride.proxyRole === options.expectedPriceOverrideProxyRole;
      const priceOverriddenOrder = result.priceOverride.body?.order ?? null;
      result.priceOverriddenOrderId = priceOverriddenOrder?.id ?? "";
      result.priceOverriddenRevision = priceOverriddenOrder?.revision ?? priceOverriddenOrder?.currentRevision ?? null;
      result.priceOverriddenTotal = priceOverriddenOrder?.total ?? null;
      if (result.priceOverride.status !== 200 || !priceOverriddenOrder?.id) {
        throw new Error(
          `price override fallita: ${result.priceOverride.status} ${result.priceOverride.body?.error ?? result.priceOverride.body?.code ?? ""}`,
        );
      }
      orderForSync = priceOverriddenOrder;
    } else {
      result.priceOverrideAttempted = false;
      result.priceOverrideOk = true;
      result.priceOverrideRoutedAsExpected = true;
    }
    result.priceOverrideGateOk = options.requirePriceOverride ? result.priceOverrideOk === true : true;

    if (options.requireTransferResolve) {
      result.transferResolveAttempted = true;
      result.transferRequest = await transferRequestOrder(mobile, orderForSync);
      result.transferRequestOk = result.transferRequest.status === 200;
      result.transferRequestRoutedAsExpected =
        !options.expectedTransferRequestProxyRole ||
        result.transferRequest.proxyRole === options.expectedTransferRequestProxyRole;
      const transferRequestedOrder = result.transferRequest.body?.order ?? null;
      result.transferRequestedRevision = transferRequestedOrder?.revision ?? transferRequestedOrder?.currentRevision ?? null;
      if (result.transferRequest.status !== 200 || !transferRequestedOrder?.pendingAuthRequest) {
        throw new Error(
          `transfer request fallita: ${result.transferRequest.status} ${result.transferRequest.body?.error ?? result.transferRequest.body?.code ?? ""}`,
        );
      }
      result.transferResolve = await transferResolveOrder(mobile, transferRequestedOrder);
      result.transferResolveOk = result.transferResolve.status === 200;
      result.transferResolveRoutedAsExpected =
        !options.expectedTransferResolveProxyRole ||
        result.transferResolve.proxyRole === options.expectedTransferResolveProxyRole;
      const transferResolvedOrder = result.transferResolve.body?.order ?? null;
      result.transferResolvedOrderId = transferResolvedOrder?.id ?? "";
      result.transferResolvedRevision = transferResolvedOrder?.revision ?? transferResolvedOrder?.currentRevision ?? null;
      result.transferResolvedStation = transferResolvedOrder?.station ?? "";
      if (result.transferResolve.status !== 200 || !transferResolvedOrder?.id) {
        throw new Error(
          `transfer resolve fallita: ${result.transferResolve.status} ${result.transferResolve.body?.error ?? result.transferResolve.body?.code ?? ""}`,
        );
      }
      orderForSync = transferResolvedOrder;
    } else {
      result.transferResolveAttempted = false;
      result.transferRequestOk = true;
      result.transferResolveOk = true;
      result.transferRequestRoutedAsExpected = true;
      result.transferResolveRoutedAsExpected = true;
    }
    result.transferResolveGateOk = options.requireTransferResolve
      ? result.transferRequestOk === true && result.transferResolveOk === true
      : true;

    if (options.requireTransferForce) {
      result.transferForceAttempted = true;
      result.transferForce = await transferForceOrder(mobile, orderForSync);
      result.transferForceOk = result.transferForce.status === 200;
      result.transferForceRoutedAsExpected =
        !options.expectedTransferForceProxyRole ||
        result.transferForce.proxyRole === options.expectedTransferForceProxyRole;
      const transferForcedOrder = result.transferForce.body?.order ?? null;
      result.transferForcedOrderId = transferForcedOrder?.id ?? "";
      result.transferForcedRevision = transferForcedOrder?.revision ?? transferForcedOrder?.currentRevision ?? null;
      result.transferForcedStation = transferForcedOrder?.station ?? "";
      if (result.transferForce.status !== 200 || !transferForcedOrder?.id) {
        throw new Error(
          `transfer force fallita: ${result.transferForce.status} ${result.transferForce.body?.error ?? result.transferForce.body?.code ?? ""}`,
        );
      }
      orderForSync = transferForcedOrder;
    } else {
      result.transferForceAttempted = false;
      result.transferForceOk = true;
      result.transferForceRoutedAsExpected = true;
    }
    result.transferForceGateOk = options.requireTransferForce ? result.transferForceOk === true : true;

    result.sync = await syncOrder(station, orderForSync);
    syncedOrder = result.sync.body?.order ?? null;
    if (result.sync.status !== 200 || !syncedOrder?.id) {
      throw new Error(`sync fallita: ${result.sync.status} ${result.sync.body?.error ?? result.sync.body?.code ?? ""}`);
    }
    result.syncedOrderId = syncedOrder.id;

    const readback = await waitForOrderReadback(mobile, syncedOrder.id);
    result.readback = readback.result;
    result.readbackAttempts = readback.attempts;
    const readbackOrder = readback.order;
    result.readbackFound = Boolean(readbackOrder);
    result.readbackWorkflowStatus = readbackOrder?.workflowStatus ?? "";
    result.syncedWorkflowStatus = syncedOrder.workflowStatus ?? "";
    result.syncedRevision = syncedOrder.revision ?? syncedOrder.currentRevision ?? null;
    result.syncRoutedAsExpected = result.sync.proxyRole === options.expectedSyncProxyRole;
    result.syncRoutedToWorker = result.sync.proxyRole === "api-worker";
    result.syncWorkflowOk = [options.syncWorkflowStatus, "ready", "delivered"].includes(String(syncedOrder.workflowStatus ?? ""));
    result.readbackWorkflowOk = [options.syncWorkflowStatus, "ready", "delivered"].includes(String(readbackOrder?.workflowStatus ?? ""));

    if (options.requireComp) {
      result.compAttempted = true;
      result.comp = await compOrder(mobile, selectedTable, readbackOrder ?? syncedOrder);
      result.compOk = result.comp.status === 200;
      result.compRoutedAsExpected = !options.expectedCompProxyRole || result.comp.proxyRole === options.expectedCompProxyRole;
      const compedOrder = result.comp.body?.order ?? null;
      result.compedOrderId = compedOrder?.id ?? "";
      result.compedRevision = compedOrder?.revision ?? compedOrder?.currentRevision ?? null;
      result.compedTotal = compedOrder?.total ?? null;
      result.compedDueAmount = compedOrder?.dueAmount ?? null;
    } else {
      result.compAttempted = false;
      result.compOk = true;
      result.compRoutedAsExpected = true;
    }
    result.compGateOk = options.requireComp ? result.compOk === true : true;

    if (options.requireStorno) {
      const orderForStorno = result.comp?.body?.order ?? readbackOrder ?? syncedOrder;
      result.tablePaymentAttempted = true;
      result.tablePayment = await payTable(mobile, selectedTable, orderForStorno);
      result.tablePaymentOk = result.tablePayment.status === 200;
      if (result.tablePayment.status !== 200) {
        throw new Error(
          `pagamento pre-storno fallito: ${result.tablePayment.status} ${result.tablePayment.body?.error ?? result.tablePayment.body?.code ?? ""}`,
        );
      }
      const paidReadback = await waitForOrderReadback(mobile, orderForStorno.id);
      const paidOrder = paidReadback.order ?? orderForStorno;
      result.stornoAttempted = true;
      result.storno = await stornoOrder(mobile, selectedTable, paidOrder);
      result.stornoOk = result.storno.status === 200;
      result.stornoRoutedAsExpected =
        !options.expectedStornoProxyRole || result.storno.proxyRole === options.expectedStornoProxyRole;
      const stornoOrderResult = result.storno.body?.order ?? null;
      result.stornoCompId = result.storno.body?.comp?.id ?? "";
      result.stornoPrintJobId = result.storno.body?.stornoPrintJob?.id ?? "";
      result.stornoOrderId = stornoOrderResult?.id ?? "";
      result.stornoRevision = stornoOrderResult?.revision ?? stornoOrderResult?.currentRevision ?? null;
      result.stornoTotal = stornoOrderResult?.total ?? null;
      result.stornoDueAmount = stornoOrderResult?.dueAmount ?? null;
      if (result.storno.status !== 200 || !stornoOrderResult?.id || !result.stornoCompId) {
        throw new Error(
          `storno fallito: ${result.storno.status} ${result.storno.body?.error ?? result.storno.body?.code ?? ""}`,
        );
      }
    } else {
      result.tablePaymentAttempted = false;
      result.tablePaymentOk = true;
      result.stornoAttempted = false;
      result.stornoOk = true;
      result.stornoRoutedAsExpected = true;
    }
    result.stornoGateOk = options.requireStorno ? result.tablePaymentOk === true && result.stornoOk === true : true;

    if (options.cleanup) {
      result.cleanupAttempted = true;
      result.cleanup = await cancelOrder(mobile, selectedTable, result.storno?.body?.order ?? result.comp?.body?.order ?? readbackOrder ?? syncedOrder);
      result.cleanupOk = result.cleanup.status === 200;
      result.cleanupRoutedAsExpected = !options.expectedCleanupProxyRole || result.cleanup.proxyRole === options.expectedCleanupProxyRole;
    } else {
      result.cleanupAttempted = false;
      result.cleanupOk = true;
      result.cleanupRoutedAsExpected = true;
    }
    result.cleanupGateOk = options.requireCleanup ? result.cleanupOk === true : true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (createdOrder && !result.createdOrderId) result.createdOrderId = createdOrder.id;
    if (syncedOrder && !result.syncedOrderId) result.syncedOrderId = syncedOrder.id;
  }

  const reportDir = path.join(options.reportRoot, `order-worker-sync-e2e-canary-${runId}`);
  await writeReport(reportDir, result);
  console.log(`[orders-sync-e2e] report=${reportDir}`);
  console.log(
    `[orders-sync-e2e] createRole=${result.create?.proxyRole || "n.d."} lineSplitRole=${result.lineSplit?.proxyRole || "n.d."} barReplacementRole=${result.barReplacement?.proxyRole || "n.d."} correctRole=${result.correct?.proxyRole || "n.d."} priceOverrideRole=${result.priceOverride?.proxyRole || "n.d."} transferRequestRole=${result.transferRequest?.proxyRole || "n.d."} transferResolveRole=${result.transferResolve?.proxyRole || "n.d."} transferForceRole=${result.transferForce?.proxyRole || "n.d."} syncRole=${result.sync?.proxyRole || "n.d."} compRole=${result.comp?.proxyRole || "n.d."} stornoRole=${result.storno?.proxyRole || "n.d."} cleanupRole=${result.cleanup?.proxyRole || "n.d."} workflow=${result.syncedWorkflowStatus || "n.d."} lineSplit=${result.lineSplitOk} barReplacement=${result.barReplacementOk} correct=${result.correctOk} priceOverride=${result.priceOverrideOk} transferResolve=${result.transferResolveOk} transferForce=${result.transferForceOk} comp=${result.compOk} storno=${result.stornoOk} cleanup=${result.cleanupOk}`,
  );

  if (!result.createRoutedAsExpected || !result.lineSplitRoutedAsExpected || !result.barReplacementRoutedAsExpected || !result.correctRoutedAsExpected || !result.priceOverrideRoutedAsExpected || !result.transferRequestRoutedAsExpected || !result.transferResolveRoutedAsExpected || !result.transferForceRoutedAsExpected || !result.syncRoutedAsExpected || !result.compRoutedAsExpected || !result.stornoRoutedAsExpected || !result.cleanupRoutedAsExpected || !result.syncWorkflowOk || !result.readbackFound || !result.readbackWorkflowOk || !result.lineSplitGateOk || !result.barReplacementGateOk || !result.correctGateOk || !result.priceOverrideGateOk || !result.transferResolveGateOk || !result.transferForceGateOk || !result.compGateOk || !result.stornoGateOk || !result.cleanupGateOk) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[orders-sync-e2e] errore", error);
  process.exitCode = 1;
});
