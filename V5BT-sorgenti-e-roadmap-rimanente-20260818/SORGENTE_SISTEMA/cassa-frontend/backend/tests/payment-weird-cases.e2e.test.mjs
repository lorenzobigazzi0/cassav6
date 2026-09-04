import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { buildInitialAppState } from "../app-state/initial-state.js";
import { hashPin } from "../auth/password.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(testDir, "..");
const projectRoot = path.resolve(backendDir, "..", "..");

function freePort() {
  return 7600 + Math.trunc(Math.random() * 1000);
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

async function waitForCondition(check, timeoutMs = 5000, intervalMs = 50) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError ?? new Error("Condition did not become true before timeout.");
}

async function startFakeFiscalServer(t) {
  const requests = [];
  const issuedByKey = new Map();
  const voidedByKey = new Map();
  let statusResponse = { ok: true, fiscalApiEnabled: true, dryRun: false };
  const server = http.createServer((request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      rawBody += chunk;
    });
    request.on("end", () => {
      let body = null;
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      }
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/api/fiscal/status") {
        response.end(JSON.stringify(statusResponse));
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/api/fiscal/receipt/verify"
      ) {
        const operation =
          String(body?.operation ?? "").toLowerCase() === "void"
            ? "void"
            : "issue";
        const key = String(
          body?.idempotencyKey ?? request.headers["idempotency-key"] ?? "",
        );
        const document =
          operation === "void"
            ? voidedByKey.get(key)
            : issuedByKey.get(key);
        response.end(
          JSON.stringify({
            ok: true,
            authoritative: true,
            operation,
            idempotencyKey: key,
            found: Boolean(document),
            state: document
              ? operation === "void"
                ? "VOIDED"
                : "ISSUED"
              : "NOT_FOUND",
            ...(document ? { document } : {}),
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/api/fiscal/receipt") {
        const key = String(request.headers["idempotency-key"] ?? "");
        const fiscalResponse = {
          ok: true,
          action: "gift_receipt",
          message: "Documento fiscale 0972-0023 emesso correttamente.",
          movement: {
            id: "MF000050",
            documentDate: "2026-05-29",
            documentNumber: "0023",
            rawDocumentInfo: {
              reference: "0972-0023",
            },
          },
          document: {
            reference: "0972-0023",
            documentDate: "2026-05-29",
            documentNumber: "0023",
          },
        };
        issuedByKey.set(key, {
          providerRef: "0972-0023",
          movementId: "MF000050",
          receiptDate: "2026-05-29",
          documentNumber: "0023",
        });
        response.end(JSON.stringify(fiscalResponse));
        return;
      }
      if (request.method === "POST" && request.url === "/api/fiscal/reprint") {
        response.end(JSON.stringify({ ok: true, reprintId: "FISCAL-REPRINT-001" }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/fiscal/void") {
        const key = String(request.headers["idempotency-key"] ?? "");
        const fiscalResponse = {
          ok: true,
          message: "Documento fiscale annullato.",
          movement: {
            id: "MFVOID0001",
            documentDate: "2026-07-17",
            documentNumber: "9001",
            rawDocumentInfo: {
              reference: "VOID-9001",
            },
          },
          document: {
            reference: "VOID-9001",
            documentDate: "2026-07-17",
            documentNumber: "9001",
          },
        };
        voidedByKey.set(key, {
          providerRef: "VOID-9001",
          movementId: "MFVOID0001",
          receiptDate: "2026-07-17",
          documentNumber: "9001",
        });
        response.end(JSON.stringify(fiscalResponse));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ ok: false, error: "not_found" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setStatusResponse: (nextStatus) => {
      statusResponse = { ...nextStatus };
    },
    statusRequests: () => requests.filter((entry) => entry.method === "GET" && entry.url === "/api/fiscal/status"),
    verifyRequests: () => requests.filter((entry) => entry.method === "POST" && entry.url === "/api/fiscal/receipt/verify"),
    receiptRequests: () => requests.filter((entry) => entry.method === "POST" && entry.url === "/api/fiscal/receipt"),
    reprintRequests: () => requests.filter((entry) => entry.method === "POST" && entry.url === "/api/fiscal/reprint"),
    voidRequests: () => requests.filter((entry) => entry.method === "POST" && entry.url === "/api/fiscal/void"),
  };
}

function makeTable(number) {
  return {
    id: `room_pedana_t${String(number).padStart(2, "0")}`,
    number,
    type: "Pedana",
    roomId: "room_pedana",
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

async function writeWeirdPaymentDb(dbPath, options = {}) {
  const state = buildInitialAppState();
  const now = new Date().toISOString();
  const fiscalApiBaseUrl = String(options.fiscalApiBaseUrl ?? "").trim();
  const paymentMethods = [
    { id: "pay_cash", label: "Contanti", enabled: true, isSmart: false, isFiscal: true },
    { id: "pay_card", label: "Carta", enabled: true, isSmart: false, isFiscal: true },
    { id: "pay_voucher", label: "Buono", enabled: false, isSmart: false, isFiscal: false },
  ];
  state.posSettings = {
    ...state.posSettings,
    tables: Array.from({ length: 40 }, (_, index) => makeTable(index + 1)),
    paymentMethods,
    printers: [
      {
        id: "printer_bar_1921681195_9100",
        name: "Stampante bar 192.168.1.100",
        host: "192.168.1.100",
        ip: "192.168.1.100",
        port: 9100,
        purpose: "generic",
        model: "generic_tcp",
        active: true,
      },
    ],
    fiscalDevices: [
      {
        id: "rt_bar_api",
        name: "RT del bar",
        type: "api",
        fiscalProvider: "pos-fiscal-api",
        ...(fiscalApiBaseUrl ? { apiBaseUrl: fiscalApiBaseUrl } : {}),
        statusEndpoint: "/api/fiscal/status",
        verifyEndpoint: "/api/fiscal/receipt/verify",
        receiptEndpoint: "/api/fiscal/receipt",
        reprintEndpoint: "/api/fiscal/reprint",
        voidEndpoint: "/api/fiscal/void",
        paymentMethodIds: ["pay_cash", "pay_card"],
        supportsCash: true,
        supportsElectronic: true,
        supportsReprint: true,
      },
    ],
    mobileDevices: [
      {
        id: "giada-weird-mobile",
        deviceUuid: "giada-weird-mobile",
        label: "Palmare Giada test",
        active: true,
        fiscalEnabled: true,
        cashPaymentEnabled: true,
        electronicPaymentEnabled: true,
      },
    ],
    areas: [
      {
        id: "room_pedana",
        name: "Pedana",
        printerIds: [],
        cashPoints: [{ id: "room_pedana_cash", name: "Pedana cassa", printerIds: [], fiscalPrinterId: null }],
        workstations: [{ id: "room_pedana_station", name: "BAR PRINCIPALE", stationName: "BAR PRINCIPALE", printerIds: [] }],
      },
    ],
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
      permissions: ["manage_users"],
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
      permissions: ["collect_payments", "print_orders", "manage_tables", "fiscal_operations"],
      authorizedRoomIds: ["room_pedana"],
      enabledRoomIds: ["room_pedana"],
      allowedPaymentMethodIds: ["pay_cash", "pay_card"],
      pinHash: hashPin("2222"),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "u_station",
      username: "postazione",
      fullName: "Postazione Bar",
      role: "operator",
      roleLabel: "Operatore",
      permissions: ["print_orders"],
      authorizedRoomIds: ["room_pedana"],
      enabledRoomIds: ["room_pedana"],
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

async function startBackend(t, options = {}) {
  const port = freePort();
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), `apptocheck-payment-weird-${port}-`));
  const dbPath = path.join(runDir, "app-state.json");
  await writeWeirdPaymentDb(dbPath, {
    fiscalApiBaseUrl: options.env?.POS_FISCAL_API_BASE_URL,
  });
  const child = spawn(process.execPath, ["backend/server.js"], {
    cwd: path.resolve(projectRoot, "cassa-frontend"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      BACKEND_DB_MODE: "json",
      BACKEND_PORT: String(port),
      BACKEND_DB_PATH: dbPath,
      BACKEND_TOKEN_SECRET: "payment-weird-secret-12345678901234567890",
      CORS_ALLOWED_ORIGINS: "http://allowed.example",
      FISCAL_PROVIDER: "mock",
      PRINTING_ENABLED: "0",
      CARD_PAYMENT_PROVIDER: "disabled",
      CARD_PAYMENT_MOCK_ENABLED: "0",
      ...(options.env ?? {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (!child.killed) child.kill();
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

async function lockTable(baseUrl, session, deviceUuid, tableId, purpose) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/tables/lock/acquire", { tableId, purpose });
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
  await lockTable(baseUrl, session, deviceUuid, options.tableId, "order.create");
  const tableNumber = Number(options.tableNumber ?? options.tableId.match(/_t(\d+)$/)?.[1] ?? 0);
  const lines = options.lines;
  return api(baseUrl, session, deviceUuid, "POST", "/api/integration/orders/create", {
    source: "mobile-frontend",
    tableId: options.tableId,
    roomId: "room_pedana",
    tableNumber,
    covers: options.covers ?? 2,
    total: options.total ?? linesTotal(lines),
    lines,
  });
}

async function syncOrder(baseUrl, session, deviceUuid, orderId, order) {
  return api(baseUrl, session, deviceUuid, "POST", "/api/integration/orders/sync", { id: orderId, order });
}

async function readyOrder(baseUrl, session, deviceUuid, orderId) {
  return syncOrder(baseUrl, session, deviceUuid, orderId, {
    workflowStatus: "ready",
    station: "BAR PRINCIPALE",
    ownerStation: "BAR PRINCIPALE",
  });
}

async function payFreeSplit(baseUrl, session, deviceUuid, tableId, orderId, amount, extra = {}) {
  await lockTable(baseUrl, session, deviceUuid, tableId, "payment.free_split");
  return api(baseUrl, session, deviceUuid, "POST", "/api/payments/free-split", {
    tableId,
    roomId: "room_pedana",
    orderId,
    splitType: extra.splitType ?? "FREE_SPLIT",
    idempotencyKey: extra.idempotencyKey ?? `pay-${orderId}-${amount}-${Date.now()}-${Math.random()}`,
    releaseTable: extra.releaseTable,
    articleUnitIds: extra.articleUnitIds,
    issueFiscal: extra.issueFiscal,
    fiscalDocType: extra.fiscalDocType,
    fiscalDocNo: extra.fiscalDocNo,
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
          },
        ],
      },
    ],
  }, extra.expectedStatus ?? 200);
}

function findOrder(db, orderId) {
  return (db.integration.orders ?? []).find((entry) => entry.id === orderId);
}

test("weird payment flows stay coherent", async (t) => {
  const fakeFiscal = await startFakeFiscalServer(t);
  const { baseUrl, dbPath } = await startBackend(t, {
    env: {
      POS_FISCAL_API_BASE_URL: fakeFiscal.baseUrl,
      POS_FISCAL_API_TIMEOUT_MS: "1000",
      POS_FISCAL_API_JOB_RETRY_DELAY_MS: "20",
      POS_FISCAL_API_JOB_MAX_ATTEMPTS: "10",
    },
  });
  const mobile = await login(baseUrl, "giada", "2222", "giada-weird-mobile");
  const station = await login(baseUrl, "postazione", "3333", "station-weird", "postazione");
  const admin = await login(baseUrl, "admin_test", "1111", "admin-weird-mobile");

  await t.test("01 zero amount is rejected without mutating the order", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t01",
      lines: [line("Test Zero Amount", 8, 1, { productId: "test_zero_amount" })],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const result = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t01", created.order.id, 0, {
      expectedStatus: 400,
    });
    assert.match(result.error, /Quota #1 non valida/);
    assert.equal(findOrder(await readDb(dbPath), created.order.id).paidAmount, 0);
  });

  await t.test("02 cash received below amount is rejected", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t02",
      lines: [line("Test Cash Short", 8, 1, { productId: "test_cash_short" })],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const result = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t02", created.order.id, 8, {
      cashGiven: 7.99,
      expectedStatus: 400,
    });
    assert.equal(result.code, "CASH_GIVEN_TOO_LOW");
    assert.equal(findOrder(await readDb(dbPath), created.order.id).paidAmount, 0);
  });

  await t.test("03 overpayment above rounding tolerance is rejected", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t03",
      lines: [line("Test Overpay", 8, 1, { productId: "test_overpay" })],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const result = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t03", created.order.id, 8.02, {
      expectedStatus: 409,
    });
    assert.equal(result.code, "PAYMENT_OVERPAYMENT");
    assert.equal(findOrder(await readDb(dbPath), created.order.id).paidAmount, 0);
  });

  await t.test("04 order still waiting cannot be paid", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t04",
      lines: [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })],
    });
    const result = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t04", created.order.id, 1.3, {
      expectedStatus: 409,
    });
    assert.equal(result.code, "ORDER_NOT_PAYABLE");
  });

  await t.test("05 cent payment then residual closes exactly", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t05",
      lines: [line("Test Cent Split", 8, 1, { productId: "test_cent_split" })],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const partial = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t05", created.order.id, 0.01, {
      releaseTable: false,
    });
    assert.equal(partial.table?.totalDue, 7.99);
    assert.equal(partial.table?.amountDue, 7.99);
    let order = findOrder(await readDb(dbPath), created.order.id);
    assert.equal(order.paymentStatus, "partial");
    assert.equal(order.paidAmount, 0.01);
    assert.equal(order.dueAmount, 7.99);
    await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t05", created.order.id, 7.99);
    order = findOrder(await readDb(dbPath), created.order.id);
    assert.equal(order.paymentStatus, "paid");
    assert.equal(order.dueAmount, 0);
  });

  await t.test("06 invalid article unit is rejected as not belonging to the table", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t06",
      lines: [line("Test Bad Article", 8, 1, { productId: "test_bad_article" })],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const result = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t06", created.order.id, 8, {
      articleUnitIds: ["does_not_exist_0_0"],
      expectedStatus: 400,
    });
    assert.equal(result.code, "PAYMENT_ARTICLE_NOT_IN_TABLE");
  });

  await t.test("07 same article unit cannot be paid twice", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t07",
      lines: [
        line("Test Article One", 8, 1, { productId: "test_article_one" }),
        line("Test Article Two", 1.3, 1, { productId: "test_article_two" }),
      ],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const unitId = `${created.order.id}_0_0`;
    await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t07", created.order.id, 8, {
      articleUnitIds: [unitId],
      releaseTable: false,
    });
    const result = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t07", created.order.id, 8, {
      articleUnitIds: [unitId],
      expectedStatus: 409,
    });
    assert.equal(result.code, "PAYMENT_ARTICLE_NOT_PAYABLE");
  });

  await t.test("08 external POS payment works even with internal POS disabled", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t08",
      lines: [line("Test External Pos", 12, 1, { productId: "test_external_pos" })],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const result = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t08", created.order.id, 12, {
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "manuale",
      idempotencyKey: "weird-external-pos",
    });
    assert.equal(result.transactions[0].method, "POS");
    assert.match(result.transactions[0].posTxRef, /^EXT-POS-/);
    const persisted = await readDb(dbPath);
    const providerTransaction = persisted.paymentProviderTransactions.find(
      (entry) => entry.idempotencyKey === "weird-external-pos:part-1:tx-1:pos"
    );
    assert.equal(providerTransaction?.status, "settled");
    assert.equal(providerTransaction?.settlementResponse?.transactionId, result.transactions[0].id);
    const order = findOrder(persisted, created.order.id);
    assert.equal(order.paymentStatus, "paid");
    assert.equal(order.dueAmount, 0);
    const providerAuditActions = persisted.auditEvents
      .filter((entry) => entry.entityId === providerTransaction.transactionId)
      .map((entry) => entry.action);
    assert.deepEqual(providerAuditActions, [
      "payment.provider_settlement_pending",
      "payment.provider_authorized",
      "payment.provider_settled",
    ]);
  });

  await t.test("08b POS overpayment is rejected before provider transaction side effects", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t08",
      lines: [line("Test Pos Overpay", 8, 1, { productId: "test_pos_overpay" })],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const result = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t08", created.order.id, 12, {
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "manuale",
      idempotencyKey: "weird-pos-overpay",
      expectedStatus: 409,
    });
    assert.equal(result.code, "PAYMENT_OVERPAYMENT");
    const persisted = await readDb(dbPath);
    const providerTransaction = persisted.paymentProviderTransactions.find(
      (entry) => entry.idempotencyKey === "weird-pos-overpay:part-1:tx-1:pos"
    );
    assert.equal(providerTransaction, undefined);
    assert.equal(findOrder(persisted, created.order.id).paidAmount, 0);
  });

  await t.test("09 raw POS without provider/ref fails and leaves order unpaid", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t09",
      lines: [line("Test Raw Pos", 12, 1, { productId: "test_raw_pos" })],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const result = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t09", created.order.id, 12, {
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      idempotencyKey: "weird-raw-pos",
      expectedStatus: 501,
    });
    assert.equal(result.code, "CARD_AUTHORIZATION_UNAVAILABLE");
    const persisted = await readDb(dbPath);
    assert.equal(findOrder(persisted, created.order.id).paidAmount, 0);
    const providerTransaction = persisted.paymentProviderTransactions.find(
      (entry) => entry.idempotencyKey === "weird-raw-pos:part-1:tx-1:pos"
    );
    assert.equal(providerTransaction?.status, "failed");
  });

  await t.test("10 fiscal replay after paid order does not create a second transaction", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t10",
      lines: [line("Test Fiscal Replay", 8, 1, { productId: "test_fiscal_replay" })],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const first = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t10", created.order.id, 8, {
      idempotencyKey: "weird-fiscal-source",
    });
    const replay = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t10", created.order.id, 8, {
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      issueFiscal: true,
      fiscalDocType: "RECEIPT",
      fiscalDocNo: "WEIRD-REPLAY-10",
      idempotencyKey: "weird-fiscal-replay",
    });
    assert.equal(replay.fiscalReplay, true);
    assert.equal(replay.payment.id, first.payment.id);
    const persisted = await readDb(dbPath);
    const containers = persisted.paymentContainers.filter((entry) => entry.orderIds?.includes(created.order.id));
    assert.equal(containers.length, 1);
    const partIds = new Set(persisted.paymentParts.filter((entry) => entry.paymentId === first.payment.id).map((entry) => entry.id));
    const txs = persisted.paymentTransactions.filter((entry) => partIds.has(entry.partId));
    assert.equal(txs.length, 1);
    assert.equal(txs[0].method, "CASH");
  });

  await t.test("11 one cent settled POS payment emits one fiscal receipt", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t11",
      lines: [line("Test Fiscal One Cent", 0.01, 1, { productId: "test_fiscal_one_cent" })],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const beforeReceipts = fakeFiscal.receiptRequests().length;
    const result = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t11", created.order.id, 0.01, {
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "manuale",
      posTxRef: "CENT-POS-001",
      issueFiscal: true,
      fiscalDocType: "RECEIPT",
      idempotencyKey: "weird-fiscal-cent-pos",
      releaseTable: false,
    });
    assert.equal(result.transactions[0].method, "POS");
    const receiptRequest = await waitForCondition(() => {
      const receipts = fakeFiscal.receiptRequests();
      return receipts.length === beforeReceipts + 1 ? receipts.at(-1) : null;
    });
    assert.equal(fakeFiscal.statusRequests().length >= 1, true);
    assert.equal(receiptRequest.body.paymentMethod, "pos");
    assert.equal(receiptRequest.body.orderId, created.order.id);
    assert.equal(receiptRequest.body.paymentId, result.transactions[0].id);
    assert.deepEqual(receiptRequest.body.items, [
      {
        name: "Test Fiscal One Cent",
        price: "0.01",
        quantity: "1",
        department: "1",
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fakeFiscal.receiptRequests().length, beforeReceipts + 1);
    const persisted = await readDb(dbPath);
    const receipt = persisted.fiscalReceipts.find(
      (entry) => entry.paymentId === result.transactions[0].id && entry.fiscalProvider === "pos-fiscal-api"
    );
    assert.equal(receipt.fiscalStatus, "ISSUED");
    assert.equal(receipt.requiresFiscalRetry, false);
    assert.equal(receipt.fiscalProviderRef, "0972-0023");
    assert.equal(receipt.fiscalMovementId, "MF000050");
    assert.equal(receipt.fiscalDocumentNumber, "0023");
    assert.equal(receipt.fiscalReceiptDate, "2026-05-29");
  });

  await t.test("12 statistics payment print reprints fiscal receipt without issuing a duplicate", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t12",
      lines: [line("Test Fiscal Reprint", 0.01, 1, { productId: "test_fiscal_reprint" })],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const beforeReceipts = fakeFiscal.receiptRequests().length;
    const beforeReprints = fakeFiscal.reprintRequests().length;
    const paid = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t12", created.order.id, 0.01, {
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "manuale",
      posTxRef: "CENT-POS-REPRINT",
      issueFiscal: true,
      fiscalDocType: "RECEIPT",
      idempotencyKey: "weird-fiscal-reprint-pos",
      releaseTable: false,
    });
    await waitForCondition(() => {
      const receipts = fakeFiscal.receiptRequests();
      return receipts.length === beforeReceipts + 1 ? receipts.at(-1) : null;
    });

    const reprint = await api(
      baseUrl,
      mobile,
      "giada-weird-mobile",
      "POST",
      "/api/reports/payment-movement/reprint",
      {
        type: "payment",
        recordId: `payment:${paid.payment.id}`,
        movementId: paid.payment.id,
        clientApp: "mobile-frontend",
      }
    );
    assert.equal(reprint.ok, true);
    assert.equal(reprint.fiscalReissued, false);
    assert.equal(reprint.fiscalReprintQueued, true);

    const reprintRequest = await waitForCondition(() => {
      const reprints = fakeFiscal.reprintRequests();
      return reprints.length === beforeReprints + 1 ? reprints.at(-1) : null;
    });
    assert.equal(fakeFiscal.receiptRequests().length, beforeReceipts + 1);
    assert.deepEqual(reprintRequest.body, { movementId: "MF000050" });

    const reprintEvent = await waitForCondition(async () => {
      const persisted = await readDb(dbPath);
      return persisted.fiscalEvents.find(
        (entry) =>
          entry.command === "pos_receipt_reprint" &&
          entry.paymentId === paid.transactions[0].id &&
          entry.result === "reprinted"
      );
    });
    assert.equal(reprintEvent.result, "reprinted");
  });

  await t.test("13 cash fiscal receipt uses POS fiscal API and can be reprinted", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t13",
      lines: [line("Test Fiscal Cash", 2, 1, { productId: "test_fiscal_cash" })],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const beforeReceipts = fakeFiscal.receiptRequests().length;
    const beforeReprints = fakeFiscal.reprintRequests().length;
    const paid = await payFreeSplit(baseUrl, mobile, "giada-weird-mobile", "room_pedana_t13", created.order.id, 2, {
      method: "CASH",
      methodId: "pay_cash",
      methodLabel: "Contanti",
      cashGiven: 5,
      issueFiscal: true,
      fiscalDocType: "RECEIPT",
      idempotencyKey: "weird-fiscal-cash-api",
      releaseTable: false,
    });
    assert.equal(paid.transactions[0].method, "CASH");
    const receiptRequest = await waitForCondition(() => {
      const receipts = fakeFiscal.receiptRequests();
      return receipts.length === beforeReceipts + 1 ? receipts.at(-1) : null;
    });
    assert.equal(receiptRequest.body.paymentMethod, "cash");
    assert.equal(receiptRequest.body.orderId, created.order.id);
    assert.equal(receiptRequest.body.paymentId, paid.transactions[0].id);

    const reprint = await api(
      baseUrl,
      mobile,
      "giada-weird-mobile",
      "POST",
      "/api/reports/payment-movement/reprint",
      {
        type: "payment",
        recordId: `payment:${paid.payment.id}`,
        movementId: paid.payment.id,
        clientApp: "mobile-frontend",
      }
    );
    assert.equal(reprint.ok, true);
    assert.equal(reprint.fiscalReissued, false);
    assert.equal(reprint.fiscalReprintQueued, true);

    const reprintRequest = await waitForCondition(() => {
      const reprints = fakeFiscal.reprintRequests();
      return reprints.length === beforeReprints + 1 ? reprints.at(-1) : null;
    });
    assert.equal(fakeFiscal.receiptRequests().length, beforeReceipts + 1);
    assert.deepEqual(reprintRequest.body, { movementId: "MF000050" });
  });

  await t.test("14 void keeps original references and reprints only the cancellation document", async () => {
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t14",
      lines: [line("Test Fiscal Void", 3, 1, { productId: "test_fiscal_void" })],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const beforeReceipts = fakeFiscal.receiptRequests().length;
    const paid = await payFreeSplit(
      baseUrl,
      mobile,
      "giada-weird-mobile",
      "room_pedana_t14",
      created.order.id,
      3,
      {
        method: "CASH",
        methodId: "pay_cash",
        methodLabel: "Contanti",
        issueFiscal: true,
        fiscalDocType: "RECEIPT",
        idempotencyKey: "weird-fiscal-void",
        releaseTable: false,
      },
    );
    await waitForCondition(() =>
      fakeFiscal.receiptRequests().length === beforeReceipts + 1
        ? fakeFiscal.receiptRequests().at(-1)
        : null,
    );
    await waitForCondition(async () => {
      const persisted = await readDb(dbPath);
      return persisted.fiscalReceipts.find(
        (entry) =>
          entry.paymentId === paid.transactions[0].id &&
          entry.fiscalStatus === "ISSUED",
      );
    });

    const beforeVoids = fakeFiscal.voidRequests().length;
    const voided = await api(
      baseUrl,
      admin,
      "admin-weird-mobile",
      "POST",
      "/api/reports/payment-movement/fiscal/void",
      {
        movementId: paid.payment.id,
        reason: "Test annullamento fiscale",
      },
    );
    assert.equal(voided.ok, true);
    assert.equal(voided.receipt.fiscalStatus, "VOIDED");
    assert.equal(voided.receipt.fiscalMovementId, "MF000050");
    assert.equal(voided.receipt.fiscalDocumentNumber, "0023");
    assert.equal(voided.receipt.voidMovementId, "MFVOID0001");
    assert.equal(voided.receipt.voidDocumentNumber, "9001");
    assert.equal(voided.receipt.voidProviderRef, "VOID-9001");
    assert.equal(fakeFiscal.voidRequests().length, beforeVoids + 1);
    assert.deepEqual(fakeFiscal.voidRequests().at(-1).body, {
      movementId: "MF000050",
    });

    const idempotentVoid = await api(
      baseUrl,
      admin,
      "admin-weird-mobile",
      "POST",
      "/api/reports/payment-movement/fiscal/void",
      {
        movementId: paid.payment.id,
        reason: "Retry annullamento fiscale",
      },
    );
    assert.equal(idempotentVoid.idempotent, true);
    assert.equal(fakeFiscal.voidRequests().length, beforeVoids + 1);

    const verifiedVoid = await api(
      baseUrl,
      admin,
      "admin-weird-mobile",
      "POST",
      "/api/reports/payment-movement/fiscal/verify",
      {
        movementId: paid.payment.id,
        operation: "void",
      },
    );
    assert.equal(verifiedVoid.authoritative, true);
    assert.equal(verifiedVoid.state, "VOIDED");
    assert.equal(verifiedVoid.receipt.voidDocumentNumber, "9001");
    assert.equal(fakeFiscal.voidRequests().length, beforeVoids + 1);

    const beforeReprints = fakeFiscal.reprintRequests().length;
    const reprint = await api(
      baseUrl,
      mobile,
      "giada-weird-mobile",
      "POST",
      "/api/reports/payment-movement/reprint",
      {
        type: "payment",
        recordId: `payment:${paid.payment.id}`,
        movementId: paid.payment.id,
        clientApp: "mobile-frontend",
      },
    );
    assert.equal(reprint.fiscalReprintQueued, true);
    assert.equal(reprint.fiscalReprintJobs[0].documentKind, "void");
    const reprintRequest = await waitForCondition(() =>
      fakeFiscal.reprintRequests().length === beforeReprints + 1
        ? fakeFiscal.reprintRequests().at(-1)
        : null,
    );
    assert.deepEqual(reprintRequest.body, { movementId: "MFVOID0001" });

    const persisted = await waitForCondition(async () => {
      const snapshot = await readDb(dbPath);
      return snapshot.fiscalEvents.some(
        (entry) =>
          entry.command === "pos_receipt_reprint" &&
          entry.paymentId === paid.transactions[0].id &&
          entry.result === "reprinted" &&
          entry.payload?.documentKind === "void",
      )
        ? snapshot
        : null;
    });
    const receipt = persisted.fiscalReceipts.find(
      (entry) => entry.paymentId === paid.transactions[0].id,
    );
    assert.equal(receipt.fiscalMovementId, "MF000050");
    assert.equal(receipt.voidMovementId, "MFVOID0001");
    assert.equal(
      persisted.fiscalEvents.some(
        (entry) =>
          entry.command === "pos_receipt_reprint" &&
          entry.paymentId === paid.transactions[0].id &&
          entry.result === "reprinted" &&
          entry.payload?.documentKind === "void",
      ),
      true,
    );
  });

  await t.test("15 dryRun blocca emissione automatica e manuale senza POST fiscale", async () => {
    fakeFiscal.setStatusResponse({
      ok: true,
      fiscalApiEnabled: true,
      dryRun: true,
    });
    const created = await createOrder(baseUrl, mobile, "giada-weird-mobile", {
      tableId: "room_pedana_t15",
      lines: [
        line("Test Fiscal Dry Run", 0.01, 1, {
          productId: "test_fiscal_dry_run",
        }),
      ],
    });
    await readyOrder(baseUrl, station, "station-weird", created.order.id);
    const beforeReceipts = fakeFiscal.receiptRequests().length;
    const paid = await payFreeSplit(
      baseUrl,
      mobile,
      "giada-weird-mobile",
      "room_pedana_t15",
      created.order.id,
      0.01,
      {
        method: "CASH",
        methodId: "pay_cash",
        methodLabel: "Contanti",
        issueFiscal: true,
        fiscalDocType: "RECEIPT",
        idempotencyKey: "weird-fiscal-dry-run",
        releaseTable: false,
      },
    );

    const failedReceipt = await waitForCondition(async () => {
      const persisted = await readDb(dbPath);
      return persisted.fiscalReceipts.find(
        (entry) =>
          entry.paymentId === paid.transactions[0].id &&
          entry.responseCode === "FISCAL_PROVIDER_DRY_RUN",
      );
    });
    assert.equal(failedReceipt.fiscalStatus, "FAILED");
    assert.equal(failedReceipt.requiresFiscalRetry, true);
    assert.equal(fakeFiscal.receiptRequests().length, beforeReceipts);

    const blocked = await api(
      baseUrl,
      mobile,
      "giada-weird-mobile",
      "POST",
      "/api/reports/payment-movement/fiscal/issue",
      { movementId: paid.payment.id },
      503,
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "FISCAL_PROVIDER_DRY_RUN");
    assert.match(blocked.error, /dry-run/i);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fakeFiscal.receiptRequests().length, beforeReceipts);
  });
});
