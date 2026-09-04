import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { authHeaders, loginJson, readJson, startBackend } from "./helpers/test-server.mjs";

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

async function startFakeFiscalServer(t, options = {}) {
  const requests = [];
  const issuedByKey = new Map();
  let statusCallCount = 0;
  let receiptResponseDropped = false;
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
        statusCallCount += 1;
        const statusResponse =
          typeof options.statusResponse === "function"
            ? options.statusResponse(statusCallCount)
            : Array.isArray(options.statusResponses)
              ? options.statusResponses[Math.min(statusCallCount - 1, options.statusResponses.length - 1)]
              : null;
        response.end(JSON.stringify(statusResponse ?? { ok: true, fiscalApiEnabled: true }));
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
        const existing = issuedByKey.get(key);
        if (existing) {
          response.end(JSON.stringify({ ok: true, idempotent: true, ...existing }));
          return;
        }
        issuedByKey.set(key, {
          providerRef: "0999-0001",
          movementId: "MFRETRY001",
          receiptDate: "2026-06-04",
          documentNumber: "0001",
        });
        if (
          options.dropFirstReceiptResponse === true &&
          !receiptResponseDropped
        ) {
          receiptResponseDropped = true;
          response.destroy();
          return;
        }
        response.end(
          JSON.stringify({
            ok: true,
            message: "Documento fiscale 0999-0001 emesso correttamente.",
            movement: {
              id: "MFRETRY001",
              documentDate: "2026-06-04",
              documentNumber: "0001",
              rawDocumentInfo: { reference: "0999-0001" },
            },
            document: {
              reference: "0999-0001",
              documentDate: "2026-06-04",
              documentNumber: "0001",
            },
          })
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
    verifyRequests: () =>
      requests.filter(
        (entry) =>
          entry.method === "POST" &&
          entry.url === "/api/fiscal/receipt/verify",
      ),
    statusRequests: () =>
      requests.filter((entry) => entry.method === "GET" && entry.url === "/api/fiscal/status"),
  };
}

function configureFakeFiscalDevice(state, baseUrl) {
  state.posSettings.fiscalDevices = [
    {
      id: "rt_test_pos_fiscal",
      name: "RT Test POS Fiscal",
      type: "api",
      fiscalProvider: "pos-fiscal-api",
      apiBaseUrl: baseUrl,
      statusEndpoint: "/api/fiscal/status",
      verifyEndpoint: "/api/fiscal/receipt/verify",
      receiptEndpoint: "/api/fiscal/receipt",
      reprintEndpoint: "/api/fiscal/reprint",
      paymentMethodIds: ["pay_cash", "pay_card"],
      supportsCash: true,
      supportsElectronic: true,
      supportsReprint: true,
      active: true,
    },
  ];
}

test("riprende ricevuta POS FAILED retryable senza duplicare documenti gia emessi", async (t) => {
  const fakeFiscal = await startFakeFiscalServer(t, {
    dropFirstReceiptResponse: true,
  });
  const paymentId = "tx_retryable_failed_pos";
  const now = new Date().toISOString();
  const { baseUrl, dbPath } = await startBackend(t, {
    env: {
      POS_FISCAL_API_BASE_URL: fakeFiscal.baseUrl,
      POS_FISCAL_API_JOB_RETRY_DELAY_MS: "10",
      POS_FISCAL_API_RECOVERY_RETRY_DELAY_MS: "10",
      POS_FISCAL_API_TIMEOUT_MS: "1000",
      RUNTIME_METRICS: "1",
    },
    stateOverrides(state) {
      configureFakeFiscalDevice(state, fakeFiscal.baseUrl);
      state.paymentContainers = [
        {
          id: "pay_retryable_failed_pos",
          orderId: "00077",
          orderIds: ["00077"],
          amount: 0.01,
          paymentMethod: "pay_card",
          collectedByUserId: "u_cashier",
          createdAt: now,
          items: [
            {
              name: "Retry fiscale POS",
              qty: 1,
              unitPrice: 0.01,
              lineTotal: 0.01,
              unitPriceApplied: 0.01,
            },
          ],
        },
      ];
      state.payments = [
        {
          id: "pay_retryable_failed_pos",
          paymentContainerId: "pay_retryable_failed_pos",
          paymentTxId: paymentId,
          orderId: "00077",
          orderIds: ["00077"],
          amount: 0.01,
          methodId: "pay_card",
          methodLabel: "Carta",
          createdAt: now,
        },
      ];
      state.paymentTransactions = [
        {
          id: paymentId,
          partId: "part_retryable_failed_pos",
          method: "POS",
          amount: 0.01,
          status: "settled",
          createdAt: now,
        },
      ];
      state.fiscalReceipts = [
        {
          id: "fiscal_retryable_failed_pos",
          paymentId,
          command: "pos_receipt",
          status: "FAILED",
          responseCode: "FISCAL_API_STATUS_ERROR",
          responseMessage: "Scontrino fiscale POS non emesso.",
          fiscalStatus: "FAILED",
          fiscalProvider: "pos-fiscal-api",
          fiscalError: "fetch failed",
          requiresFiscalRetry: true,
          createdAt: now,
        },
        {
          id: "fiscal_already_issued_pos",
          paymentId: "tx_already_issued_pos",
          command: "pos_receipt",
          status: "ISSUED",
          responseCode: "0999-0999",
          responseMessage: "Scontrino fiscale POS emesso.",
          fiscalStatus: "ISSUED",
          fiscalProvider: "pos-fiscal-api",
          fiscalProviderRef: "0999-0999",
          fiscalMovementId: "MFISSUED999",
          requiresFiscalRetry: false,
          createdAt: now,
        },
      ];
      state.fiscalEvents = [
        {
          id: "fiscal_event_retry_payload",
          provider: "pos-fiscal-api",
          paymentId,
          orderId: "00077",
          command: "pos_receipt",
          result: "receipt_error",
          message: "Scontrino fiscale POS non emesso: fetch failed.",
          requiresFiscalRetry: true,
          createdAt: now,
          payload: null,
        },
      ];
      state.meta.lastWriteAt = now;
    },
  });

  const request = await waitForCondition(() => {
    const receipts = fakeFiscal.receiptRequests();
    return receipts.length === 1 ? receipts[0] : null;
  });
  assert.equal(fakeFiscal.statusRequests().length >= 1, true);
  assert.equal(request.body.paymentId, paymentId);
  assert.equal(request.body.paymentMethod, "pos");
  assert.deepEqual(request.body.items, [
    { name: "Pagamento POS comanda 00077", price: "0.01", quantity: "1", department: "1" },
  ]);

  const persisted = await waitForCondition(async () => {
    const snapshot = await readJson(dbPath);
    const currentReceipt = snapshot.fiscalReceipts.find(
      (entry) => entry.id === "fiscal_retryable_failed_pos",
    );
    return currentReceipt?.fiscalStatus === "ISSUED" ? snapshot : null;
  });
  assert.equal(fakeFiscal.receiptRequests().length, 1);
  assert.equal(fakeFiscal.verifyRequests().length >= 2, true);

  const receipt = persisted.fiscalReceipts.find((entry) => entry.id === "fiscal_retryable_failed_pos");
  assert.equal(receipt.fiscalStatus, "ISSUED");
  assert.equal(receipt.requiresFiscalRetry, false);
  assert.equal(receipt.fiscalProviderRef, "0999-0001");
  assert.equal(receipt.fiscalMovementId, "MFRETRY001");
  assert.equal(
    persisted.fiscalEvents.some(
      (entry) =>
        entry.paymentId === paymentId &&
        entry.result === "issued_reconciled",
    ),
    true,
  );
  assert.equal(
    persisted.fiscalReceipts.filter((entry) => entry.paymentId === "tx_already_issued_pos").length,
    1
  );

  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    deviceUuid: "fiscal-retry-metrics-admin",
    clientApp: "cassa-frontend",
  });
  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(admin, "fiscal-retry-metrics-admin"),
  });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.runtimeMetrics.counters.fiscalRetryLaneEnqueued >= 1, true);
  assert.equal(
    metrics.runtimeMetrics.queues.fiscalRetryLane.runMsByLabel[`pos_fiscal_receipt_${paymentId}`]?.count >= 1,
    true,
  );
});

test("ritenta emissione fiscale finche il server torna ok prima delle 05:00", async (t) => {
  const fakeFiscal = await startFakeFiscalServer(t, {
    statusResponses: [
      { ok: false, fiscalApiEnabled: true, message: "temporaneamente non pronto" },
      { ok: true, fiscalApiEnabled: true },
    ],
  });
  const paymentId = "tx_retry_until_fiscal_ready";
  const now = new Date().toISOString();
  const { dbPath } = await startBackend(t, {
    env: {
      POS_FISCAL_API_BASE_URL: fakeFiscal.baseUrl,
      POS_FISCAL_API_JOB_RETRY_DELAY_MS: "10",
      POS_FISCAL_API_RECOVERY_RETRY_DELAY_MS: "10",
      POS_FISCAL_API_TIMEOUT_MS: "1000",
    },
    stateOverrides(state) {
      configureFakeFiscalDevice(state, fakeFiscal.baseUrl);
      state.paymentContainers = [
        {
          id: "pay_retry_until_fiscal_ready",
          orderId: "00088",
          orderIds: ["00088"],
          amount: 0.01,
          paymentMethod: "pay_card",
          collectedByUserId: "u_cashier",
          createdAt: now,
        },
      ];
      state.payments = [
        {
          id: "pay_retry_until_fiscal_ready",
          paymentContainerId: "pay_retry_until_fiscal_ready",
          paymentTxId: paymentId,
          orderId: "00088",
          orderIds: ["00088"],
          amount: 0.01,
          methodId: "pay_card",
          methodLabel: "Carta",
          createdAt: now,
        },
      ];
      state.paymentTransactions = [
        {
          id: paymentId,
          partId: "part_retry_until_fiscal_ready",
          method: "POS",
          amount: 0.01,
          status: "settled",
          createdAt: now,
        },
      ];
      state.fiscalReceipts = [
        {
          id: "fiscal_retry_until_fiscal_ready",
          paymentId,
          command: "pos_receipt",
          status: "FAILED",
          responseCode: "FISCAL_API_STATUS_NOT_OK",
          responseMessage: "Scontrino fiscale POS non emesso.",
          fiscalStatus: "FAILED",
          fiscalProvider: "pos-fiscal-api",
          fiscalError: "server fiscale non pronto",
          requiresFiscalRetry: true,
          createdAt: now,
        },
      ];
      state.meta.lastWriteAt = now;
    },
  });

  await waitForCondition(() => fakeFiscal.receiptRequests().length === 1);
  assert.equal(fakeFiscal.statusRequests().length >= 2, true);

  const persisted = await waitForCondition(async () => {
    const current = await readJson(dbPath);
    const receipt = current.fiscalReceipts.find((entry) => entry.id === "fiscal_retry_until_fiscal_ready");
    return receipt?.fiscalStatus === "ISSUED" ? current : null;
  });
  const receipt = persisted.fiscalReceipts.find((entry) => entry.id === "fiscal_retry_until_fiscal_ready");
  assert.equal(receipt.fiscalStatus, "ISSUED");
  assert.equal(receipt.requiresFiscalRetry, false);
});

test("non ritenta dopo la finestra delle 05:00 e marca la ricevuta scaduta", async (t) => {
  const fakeFiscal = await startFakeFiscalServer(t);
  const paymentId = "tx_retry_window_expired";
  const oldCreatedAt = "2020-01-01T20:00:00.000Z";
  const { dbPath } = await startBackend(t, {
    env: {
      POS_FISCAL_API_BASE_URL: fakeFiscal.baseUrl,
      POS_FISCAL_API_JOB_RETRY_DELAY_MS: "10",
      POS_FISCAL_API_RECOVERY_RETRY_DELAY_MS: "10",
      POS_FISCAL_API_TIMEOUT_MS: "1000",
    },
    stateOverrides(state) {
      configureFakeFiscalDevice(state, "http://127.0.0.1:9");
      state.paymentContainers = [
        {
          id: "pay_retry_window_expired",
          orderId: "00089",
          orderIds: ["00089"],
          amount: 0.01,
          paymentMethod: "pay_card",
          collectedByUserId: "u_cashier",
          createdAt: oldCreatedAt,
        },
      ];
      state.payments = [
        {
          id: "pay_retry_window_expired",
          paymentContainerId: "pay_retry_window_expired",
          paymentTxId: paymentId,
          orderId: "00089",
          orderIds: ["00089"],
          amount: 0.01,
          methodId: "pay_card",
          methodLabel: "Carta",
          createdAt: oldCreatedAt,
        },
      ];
      state.paymentTransactions = [
        {
          id: paymentId,
          partId: "part_retry_window_expired",
          method: "POS",
          amount: 0.01,
          status: "settled",
          createdAt: oldCreatedAt,
        },
      ];
      state.fiscalReceipts = [
        {
          id: "fiscal_retry_window_expired",
          paymentId,
          command: "pos_receipt",
          status: "FAILED",
          responseCode: "FISCAL_API_STATUS_ERROR",
          responseMessage: "Scontrino fiscale POS non emesso.",
          fiscalStatus: "FAILED",
          fiscalProvider: "pos-fiscal-api",
          fiscalError: "server fiscale non disponibile",
          requiresFiscalRetry: true,
          createdAt: oldCreatedAt,
        },
      ];
      state.meta.lastWriteAt = oldCreatedAt;
    },
  });

  await waitForCondition(async () => {
    const persisted = await readJson(dbPath);
    const receipt = persisted.fiscalReceipts.find((entry) => entry.id === "fiscal_retry_window_expired");
    return receipt?.fiscalStatus === "EXPIRED";
  });
  assert.equal(fakeFiscal.statusRequests().length, 0);
  assert.equal(fakeFiscal.receiptRequests().length, 0);

  const persisted = await readJson(dbPath);
  const event = persisted.fiscalEvents.find((entry) => entry.result === "retry_window_expired");
  assert.ok(event);
});

test("report scarico elenca non fiscalizzati POS e contanti fuori finestra", async (t) => {
  const oldCreatedAt = "2020-01-01T20:00:00.000Z";
  const { baseUrl } = await startBackend(t, {
    env: {
      POS_FISCAL_API_BASE_URL: "http://127.0.0.1:9",
      POS_FISCAL_API_JOB_RETRY_DELAY_MS: "10",
      POS_FISCAL_API_RECOVERY_RETRY_DELAY_MS: "10",
      POS_FISCAL_API_TIMEOUT_MS: "100",
    },
    stateOverrides(state) {
      configureFakeFiscalDevice(state, "http://127.0.0.1:9");
      state.paymentContainers = [
        {
          id: "pay_report_pos",
          orderId: "00090",
          orderIds: ["00090"],
          tableLabel: "Tavolo 1",
          amount: 0.01,
          paymentMethod: "pay_card",
          collectedByUserId: "u_cashier",
          collectedByUsername: "Cashier Test",
          createdAt: oldCreatedAt,
        },
        {
          id: "pay_report_cash",
          orderId: "00091",
          orderIds: ["00091"],
          tableLabel: "Tavolo 2",
          amount: 0.02,
          paymentMethod: "pay_cash",
          collectedByUserId: "u_cashier",
          collectedByUsername: "Cashier Test",
          createdAt: oldCreatedAt,
        },
      ];
      state.payments = [
        {
          id: "pay_report_pos",
          paymentContainerId: "pay_report_pos",
          paymentTxId: "tx_report_pos",
          orderId: "00090",
          amount: 0.01,
          methodId: "pay_card",
          methodLabel: "Carta",
          collectedByUserId: "u_cashier",
          createdAt: oldCreatedAt,
        },
        {
          id: "pay_report_cash",
          paymentContainerId: "pay_report_cash",
          paymentTxId: "tx_report_cash",
          orderId: "00091",
          amount: 0.02,
          methodId: "pay_cash",
          methodLabel: "Contanti",
          collectedByUserId: "u_cashier",
          createdAt: oldCreatedAt,
        },
      ];
      state.paymentTransactions = [
        {
          id: "tx_report_pos",
          partId: "part_report_pos",
          method: "POS",
          amount: 0.01,
          status: "settled",
          createdAt: oldCreatedAt,
        },
        {
          id: "tx_report_cash",
          partId: "part_report_cash",
          method: "CASH",
          amount: 0.02,
          status: "settled",
          createdAt: oldCreatedAt,
        },
      ];
      state.fiscalReceipts = [
        {
          id: "fiscal_report_pos",
          paymentId: "tx_report_pos",
          command: "pos_receipt",
          status: "FAILED",
          responseCode: "FISCAL_API_STATUS_ERROR",
          fiscalStatus: "FAILED",
          fiscalProvider: "pos-fiscal-api",
          fiscalError: "server fiscale non disponibile",
          requiresFiscalRetry: true,
          createdAt: oldCreatedAt,
        },
        {
          id: "fiscal_report_cash",
          paymentId: "tx_report_cash",
          command: "pos_receipt",
          status: "FAILED",
          responseCode: "FISCAL_API_STATUS_ERROR",
          fiscalStatus: "FAILED",
          fiscalProvider: "pos-fiscal-api",
          fiscalError: "server fiscale non disponibile",
          requiresFiscalRetry: true,
          createdAt: oldCreatedAt,
        },
      ];
      state.meta.lastWriteAt = oldCreatedAt;
    },
  });
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "cashier-report-device",
    clientApp: "mobile-frontend",
  });
  const response = await fetch(`${baseUrl}/api/reports/non-fiscalized`, {
    method: "POST",
    headers: authHeaders(session, "cashier-report-device"),
    body: JSON.stringify({
      token: session.token,
      userId: session.user.id,
      deviceUuid: "cashier-report-device",
      sinceMs: 0,
      expiredOnly: true,
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.report.count, 2);
  assert.equal(body.report.posCount, 1);
  assert.equal(body.report.cashCount, 1);
  assert.equal(body.report.total, 0.03);
  assert.deepEqual(
    body.report.items.map((entry) => entry.transactionId).sort(),
    ["tx_report_cash", "tx_report_pos"]
  );
});
