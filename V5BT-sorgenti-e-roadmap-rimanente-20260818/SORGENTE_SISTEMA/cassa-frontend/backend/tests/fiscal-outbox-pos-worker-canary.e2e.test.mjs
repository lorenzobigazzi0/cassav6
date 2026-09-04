import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import {
  acquireTableLock,
  apiPost,
  authPayload,
  createSimpleOrder,
  createTempRunDir,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";

async function waitForCondition(check, timeoutMs = 7_000, intervalMs = 75) {
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

async function startFakePosFiscalApi(t) {
  const requests = [];
  const issuedByKey = new Map();
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
        response.end(JSON.stringify({ ok: true, fiscalApiEnabled: true }));
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/api/fiscal/receipt/verify"
      ) {
        const key = String(
          body?.idempotencyKey ?? request.headers["idempotency-key"] ?? "",
        );
        const document = issuedByKey.get(key);
        response.end(
          JSON.stringify({
            ok: true,
            authoritative: true,
            operation: "issue",
            idempotencyKey: key,
            found: Boolean(document),
            state: document ? "ISSUED" : "NOT_FOUND",
            ...(document ? { document } : {}),
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/api/fiscal/receipt") {
        const key = String(request.headers["idempotency-key"] ?? "");
        issuedByKey.set(key, {
          providerRef: "CANARY-0001",
          movementId: "MFCANARY0001",
          receiptDate: "2026-07-07",
          documentNumber: "0001",
        });
        response.end(
          JSON.stringify({
            ok: true,
            message: "Documento fiscale CANARY-0001 emesso correttamente.",
            receiptId: "RT-CANARY-0001",
            movement: {
              id: "MFCANARY0001",
              documentDate: "2026-07-07",
              documentNumber: "0001",
              rawDocumentInfo: { reference: "CANARY-0001" },
            },
            document: {
              reference: "CANARY-0001",
              documentDate: "2026-07-07",
              documentNumber: "0001",
            },
          }),
        );
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
    receiptRequests: () =>
      requests.filter((entry) => entry.method === "POST" && entry.url === "/api/fiscal/receipt"),
    statusRequests: () =>
      requests.filter((entry) => entry.method === "GET" && entry.url === "/api/fiscal/status"),
  };
}

function configureCanaryFiscalDevice(state, baseUrl) {
  state.posSettings.fiscalDevices = [
    {
      id: "rt_canary_pos_fiscal",
      name: "RT Canary POS Fiscal",
      type: "api",
      fiscalProvider: "pos-fiscal-api",
      apiBaseUrl: baseUrl,
      statusEndpoint: "/api/fiscal/status",
      verifyEndpoint: "/api/fiscal/receipt/verify",
      receiptEndpoint: "/api/fiscal/receipt",
      reprintEndpoint: "/api/fiscal/reprint",
      paymentMethodIds: ["pay_cash"],
      supportsCash: true,
      supportsElectronic: false,
      supportsReprint: true,
      active: true,
    },
  ];
  state.posSettings.mobileDevices = [
    ...(Array.isArray(state.posSettings.mobileDevices) ? state.posSettings.mobileDevices : []),
    "pay-table-device",
    "pay-mobile-v2-device",
    "step13f-table-device",
    "step13f-free-split-device",
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
        : entry,
    )
    .filter(
      (entry, index, items) =>
        entry &&
        items.findIndex((candidate) => String(candidate?.deviceId ?? candidate?.id ?? "") === String(entry.deviceId ?? entry.id ?? "")) === index,
    );
  const methods = Array.isArray(state.posSettings.paymentMethods)
    ? state.posSettings.paymentMethods
    : [];
  const hasCash = methods.some((entry) => entry?.id === "pay_cash");
  state.posSettings.paymentMethods = [
    ...methods.map((entry) =>
      entry?.id === "pay_cash"
        ? { ...entry, enabled: true, isFiscal: true }
        : entry,
    ),
    ...(hasCash
      ? []
      : [{ id: "pay_cash", label: "Contanti", enabled: true, isSmart: false, isFiscal: true }]),
  ].filter(
    (entry, index, items) =>
      entry &&
      items.findIndex((candidate) => String(candidate?.id ?? "") === String(entry.id ?? "")) === index,
  );
}

function fiscalTicketPayload(session, deviceUuid, idempotencyKey) {
  return authPayload(session, deviceUuid, {
    paymentMethodId: "pay_cash",
    cashGiven: 1.3,
    issueFiscal: true,
    fiscalDocType: "RECEIPT",
    idempotencyKey,
    lines: [
      {
        name: "Caffe Canary",
        qty: 1,
        unitPrice: 1.3,
        unitPriceApplied: 1.3,
        lineTotal: 1.3,
      },
    ],
  });
}

async function createDeliveredOrder(baseUrl, session, deviceUuid, options = {}) {
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid,
    tableId: options.tableId ?? "room_pedana_t05",
    roomId: options.roomId ?? "room_pedana",
    tableNumber: options.tableNumber ?? 5,
    lines: options.lines,
  });
  assert.equal(created.response.status, 200);
  const ready = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: created.body.order.id,
      order: {
        ...created.body.order,
        workflowStatus: "ready",
        items: created.body.order.items.map((item) => ({ ...item, done: true })),
      },
      workflowReason: "step13f_canary_fixture",
    }),
  );
  assert.equal(ready.response.status, 200);
  const delivered = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: ready.body.order.id,
      order: {
        ...ready.body.order,
        workflowStatus: "delivered",
        items: ready.body.order.items.map((item) => ({ ...item, done: true })),
      },
      workflowReason: "step13f_canary_fixture",
    }),
  );
  assert.equal(delivered.response.status, 200);
  return delivered.body.order;
}

async function lockTableForPayment(baseUrl, session, deviceUuid) {
  const locked = await acquireTableLock(
    baseUrl,
    session,
    "room_pedana_t05",
    { deviceUuid, purpose: "payment" },
  );
  assert.equal(locked.response.status, 200);
}

function tablePaymentPayload(session, deviceUuid, idempotencyKey) {
  return authPayload(session, deviceUuid, {
    tableId: "room_pedana_t05",
    paymentMethodId: "pay_cash",
    cashGiven: 1.3,
    issueFiscal: true,
    fiscalDocType: "RECEIPT",
    idempotencyKey,
  });
}

function freeSplitPayload(session, deviceUuid, orderId, idempotencyKey) {
  return authPayload(session, deviceUuid, {
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    orderId,
    splitType: "FREE_SPLIT",
    splitMode: "amount",
    amount: 1.3,
    idempotencyKey,
    clientPaymentId: idempotencyKey,
    releaseTable: true,
    paymentMethod: "cash",
    receiptType: "scontrino",
    issueFiscal: true,
    fiscalDocType: "RECEIPT",
    parts: [
      {
        amountDue: 1.3,
        transactions: [
          {
            method: "CASH",
            methodId: "pay_cash",
            methodLabel: "Contanti",
            amountPaid: 1.3,
            cashGiven: 1.3,
          },
        ],
      },
    ],
  });
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function readCanarySnapshot(relationalPath, idempotencyKey) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    const transaction = db
      .prepare("SELECT * FROM payment_transactions WHERE idempotency_key = ?")
      .get(idempotencyKey);
    const receipts = transaction
      ? db
          .prepare("SELECT * FROM fiscal_receipts WHERE payment_transaction_id = ? ORDER BY id")
          .all(transaction.id)
      : [];
    const fiscalRows = receipts.length
      ? db
          .prepare(
            `SELECT * FROM fiscal_outbox WHERE aggregate_type = 'fiscal_receipt' AND aggregate_id IN (${receipts.map(() => "?").join(",")}) ORDER BY fiscal_id`,
          )
          .all(...receipts.map((entry) => entry.id))
          .map((entry) => ({ ...entry, payload: parseJson(entry.payload_json, {}) }))
      : [];
    return { transaction, receipts, fiscalRows };
  } finally {
    db.close();
  }
}

async function startCanaryBackend(t, fiscalApiBaseUrl) {
  const runDir = await createTempRunDir("step13e-fiscal-outbox-canary");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY: "1",
      BACKEND_FISCAL_OUTBOX_ENABLED: "1",
      BACKEND_FISCAL_OUTBOX_WORKER_ENABLED: "1",
      BACKEND_FISCAL_OUTBOX_WORKER_INTERVAL_MS: "250",
      BACKEND_FISCAL_OUTBOX_WORKER_BATCH_SIZE: "5",
      IDEMPOTENCY_STORE_ENABLED: "1",
      EVENT_OUTBOX_ENABLED: "1",
      POS_FISCAL_API_JOB_RETRY_DELAY_MS: "60000",
      POS_FISCAL_API_RECOVERY_RETRY_DELAY_MS: "500",
      POS_FISCAL_API_TIMEOUT_MS: "1000",
    },
    stateOverrides(state) {
      configureCanaryFiscalDevice(state, fiscalApiBaseUrl);
    },
  });
  return { ...backend, relationalPath };
}

async function assertFiscalOutboxIssued({
  relationalPath,
  fakeFiscalApi,
  idempotencyKey,
  expectedContainerId,
  expectedReceiptCalls = 1,
}) {
  const issued = await waitForCondition(async () => {
    const snapshot = await readCanarySnapshot(relationalPath, idempotencyKey);
    const row = snapshot.fiscalRows[0];
    if (row?.status === "issued") return snapshot;
    return null;
  });

  assert.equal(issued.transaction.container_id, expectedContainerId);
  assert.equal(issued.receipts.length, 1);
  assert.equal(issued.receipts[0].fiscal_status, "ISSUED");
  assert.equal(issued.receipts[0].fiscal_provider, "pos-fiscal-api");
  assert.equal(issued.receipts[0].fiscal_document_number, "0001");
  assert.equal(issued.fiscalRows.length, 1);
  assert.equal(issued.fiscalRows[0].status, "issued");
  assert.equal(issued.fiscalRows[0].attempt_count, 0);
  assert.equal(issued.fiscalRows[0].last_error_code, null);
  assert.equal(issued.fiscalRows[0].payload.worker.provider, "pos-fiscal-api");

  await new Promise((resolve) => setTimeout(resolve, 400));
  const receiptRequests = fakeFiscalApi.receiptRequests();
  assert.equal(receiptRequests.length, expectedReceiptCalls);
  assert.ok(fakeFiscalApi.statusRequests().length >= expectedReceiptCalls);
  const lastReceiptRequest = receiptRequests[receiptRequests.length - 1];
  assert.equal(lastReceiptRequest.body.items.length, 1);
  assert.notEqual(lastReceiptRequest.headers["idempotency-key"], idempotencyKey);
  assert.match(lastReceiptRequest.headers["idempotency-key"], /^pos_fiscal_/);
  assert.equal(lastReceiptRequest.headers["x-fiscal-device-id"], "rt_canary_pos_fiscal");
  return issued;
}

test("Step 13E canary fiscale POS ticket: outbox worker emette una sola volta", async (t) => {
  const fakeFiscalApi = await startFakePosFiscalApi(t);
  const { baseUrl, relationalPath } = await startCanaryBackend(t, fakeFiscalApi.baseUrl);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-device",
    clientApp: "mobile-frontend",
  });
  const idempotencyKey = "step13e-canary-ticket-once";

  const paid = await apiPost(
    baseUrl,
    "/api/payments/ticket",
    fiscalTicketPayload(cashier, "pay-table-device", idempotencyKey),
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);
  assert.equal(paid.body.fiscalPending, true);
  assert.equal(paid.body.relational.writePrimary, true);

  await assertFiscalOutboxIssued({
    relationalPath,
    fakeFiscalApi,
    idempotencyKey,
    expectedContainerId: paid.body.payment.id,
  });
});

test("Step 13F canary fiscale POS tavolo: outbox worker emette una sola volta", async (t) => {
  const fakeFiscalApi = await startFakePosFiscalApi(t);
  const { baseUrl, relationalPath } = await startCanaryBackend(t, fakeFiscalApi.baseUrl);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "step13f-table-device",
    clientApp: "mobile-frontend",
  });
  await createDeliveredOrder(baseUrl, cashier, "step13f-table-device");
  await lockTableForPayment(baseUrl, cashier, "step13f-table-device");
  const idempotencyKey = "step13f-canary-table-once";

  const paid = await apiPost(
    baseUrl,
    "/api/payments/table",
    tablePaymentPayload(cashier, "step13f-table-device", idempotencyKey),
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);
  assert.equal(paid.body.fiscalPending, true);
  assert.equal(paid.body.relational.writePrimary, true);

  await assertFiscalOutboxIssued({
    relationalPath,
    fakeFiscalApi,
    idempotencyKey,
    expectedContainerId: paid.body.payment.id,
  });
});

test("Step 13F canary fiscale POS split libero: outbox worker emette una sola volta", async (t) => {
  const fakeFiscalApi = await startFakePosFiscalApi(t);
  const { baseUrl, relationalPath } = await startCanaryBackend(t, fakeFiscalApi.baseUrl);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "step13f-free-split-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "step13f-free-split-device");
  await lockTableForPayment(baseUrl, cashier, "step13f-free-split-device");
  const idempotencyKey = "step13f-canary-free-split-once";

  const paid = await apiPost(
    baseUrl,
    "/api/payments/free-split",
    freeSplitPayload(cashier, "step13f-free-split-device", order.id, idempotencyKey),
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);
  assert.equal(paid.body.fiscalPending, true);
  assert.equal(paid.body.relational.writePrimary, true);

  await assertFiscalOutboxIssued({
    relationalPath,
    fakeFiscalApi,
    idempotencyKey,
    expectedContainerId: paid.body.payment.id,
  });
});
