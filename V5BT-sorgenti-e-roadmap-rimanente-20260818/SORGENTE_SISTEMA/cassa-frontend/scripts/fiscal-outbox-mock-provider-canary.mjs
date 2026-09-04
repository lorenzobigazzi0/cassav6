#!/usr/bin/env node
import http from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  apiPost,
  authPayload,
  createTempRunDir,
  loginJson,
  startBackend,
} from "../backend/tests/helpers/test-server.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;

function todayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function intOption(value, fallback, { min = 0, max = 1_000_000_000 } = {}) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function moneyOption(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed * 100) / 100;
}

export function parseFiscalOutboxMockProviderCanaryArgs(argv = [], env = process.env) {
  const parsed = {
    idempotencyKey: String(env.FISCAL_OUTBOX_MOCK_CANARY_IDEMPOTENCY_KEY || `fiscal-outbox-mock-canary-${todayStamp()}`).trim(),
    deviceUuid: String(env.FISCAL_OUTBOX_MOCK_CANARY_DEVICE_UUID || "fiscal-outbox-mock-canary-device").trim(),
    amount: moneyOption(env.FISCAL_OUTBOX_MOCK_CANARY_AMOUNT, 1.3),
    output: String(env.FISCAL_OUTBOX_MOCK_CANARY_OUTPUT || "").trim(),
    timeoutMs: intOption(env.FISCAL_OUTBOX_MOCK_CANARY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { min: 1000 }),
    pollMs: intOption(env.FISCAL_OUTBOX_MOCK_CANARY_POLL_MS, 100, { min: 50 }),
    keepRunDir: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? "");
    const readNext = () => String(argv[(index += 1)] ?? "");
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--keep-run-dir") parsed.keepRunDir = true;
    else if (arg === "--idempotency-key") parsed.idempotencyKey = readNext().trim();
    else if (arg.startsWith("--idempotency-key=")) parsed.idempotencyKey = arg.slice("--idempotency-key=".length).trim();
    else if (arg === "--device-uuid") parsed.deviceUuid = readNext().trim();
    else if (arg.startsWith("--device-uuid=")) parsed.deviceUuid = arg.slice("--device-uuid=".length).trim();
    else if (arg === "--amount") parsed.amount = moneyOption(readNext(), parsed.amount);
    else if (arg.startsWith("--amount=")) parsed.amount = moneyOption(arg.slice("--amount=".length), parsed.amount);
    else if (arg === "--output") parsed.output = readNext().trim();
    else if (arg.startsWith("--output=")) parsed.output = arg.slice("--output=".length).trim();
    else if (arg === "--timeout-ms") parsed.timeoutMs = intOption(readNext(), parsed.timeoutMs, { min: 1000 });
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = intOption(arg.slice("--timeout-ms=".length), parsed.timeoutMs, { min: 1000 });
    else if (arg === "--poll-ms") parsed.pollMs = intOption(readNext(), parsed.pollMs, { min: 50 });
    else if (arg.startsWith("--poll-ms=")) parsed.pollMs = intOption(arg.slice("--poll-ms=".length), parsed.pollMs, { min: 50 });
  }

  if (parsed.output) parsed.output = path.resolve(parsed.output);
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/fiscal-outbox-mock-provider-canary.mjs [opzioni]

Avvia un backend temporaneo e un POS fiscale mock locale, esegue un pagamento
ticket fiscale, attende il worker fiscal_outbox e verifica una sola chiamata
provider. Non usa il backend live e non emette documenti fiscali reali.

Opzioni:
  --idempotency-key KEY   default fiscal-outbox-mock-canary-YYYYMMDD
  --device-uuid ID        default fiscal-outbox-mock-canary-device
  --amount EUR            default 1.30
  --output PATH           salva report; .json forza JSON
  --keep-run-dir          non elimina il run dir temporaneo a fine esecuzione
  --json                  output machine-readable
`);
}

function createCleanupRegistry() {
  const callbacks = [];
  return {
    after(callback) {
      if (typeof callback === "function") callbacks.push(callback);
    },
    async run() {
      while (callbacks.length > 0) {
        const callback = callbacks.pop();
        try {
          await callback();
        } catch {
          // best effort cleanup
        }
      }
    },
  };
}

async function startFakePosFiscalApi(cleanup) {
  const requests = [];
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
        response.end(JSON.stringify({ ok: true, fiscalApiEnabled: true, provider: "mock-canary" }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/fiscal/receipt") {
        response.end(
          JSON.stringify({
            ok: true,
            message: "Documento fiscale MOCK-CANARY-0001 emesso correttamente.",
            receiptId: "RT-MOCK-CANARY-0001",
            movement: {
              id: "MFCANARY0001",
              documentDate: "2026-07-07",
              documentNumber: "0001",
              rawDocumentInfo: { reference: "MOCK-CANARY-0001" },
            },
            document: {
              reference: "MOCK-CANARY-0001",
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
  cleanup.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    receiptRequests: () =>
      requests.filter((entry) => entry.method === "POST" && entry.url === "/api/fiscal/receipt"),
    statusRequests: () =>
      requests.filter((entry) => entry.method === "GET" && entry.url === "/api/fiscal/status"),
  };
}

function configureMockFiscalDevice(state, baseUrl, deviceUuid) {
  state.posSettings.fiscalDevices = [
    {
      id: "rt_mock_canary_pos_fiscal",
      name: "RT Mock Canary POS Fiscal",
      type: "api",
      fiscalProvider: "pos-fiscal-api",
      apiBaseUrl: baseUrl,
      statusEndpoint: "/api/fiscal/status",
      receiptEndpoint: "/api/fiscal/receipt",
      reprintEndpoint: "/api/fiscal/reprint",
      paymentMethodIds: ["pay_cash"],
      supportsCash: true,
      supportsElectronic: false,
      supportsReprint: true,
      active: true,
      source: "mock-canary",
    },
  ];
  state.posSettings.mobileDevices = [
    ...(Array.isArray(state.posSettings.mobileDevices) ? state.posSettings.mobileDevices : []),
    {
      id: deviceUuid,
      deviceId: deviceUuid,
      name: "Fiscal Outbox Mock Canary",
      fiscalEnabled: true,
      electronicPaymentEnabled: true,
      cashPaymentEnabled: true,
    },
  ].filter(
    (entry, index, items) =>
      entry &&
      items.findIndex((candidate) => String(candidate?.deviceId ?? candidate?.id ?? "") === String(entry.deviceId ?? entry.id ?? "")) === index,
  );
  const methods = Array.isArray(state.posSettings.paymentMethods) ? state.posSettings.paymentMethods : [];
  const hasCash = methods.some((entry) => entry?.id === "pay_cash");
  state.posSettings.paymentMethods = [
    ...methods.map((entry) =>
      entry?.id === "pay_cash"
        ? { ...entry, enabled: true, isFiscal: true, isSmart: false }
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

function fiscalTicketPayload(session, options) {
  return authPayload(session, options.deviceUuid, {
    paymentMethodId: "pay_cash",
    cashGiven: options.amount,
    issueFiscal: true,
    fiscalDocType: "RECEIPT",
    idempotencyKey: options.idempotencyKey,
    lines: [
      {
        name: "Canary fiscale mock",
        qty: 1,
        unitPrice: options.amount,
        unitPriceApplied: options.amount,
        lineTotal: options.amount,
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

async function loadDatabaseSync() {
  const sqliteModule = await import("node:sqlite");
  return sqliteModule.DatabaseSync;
}

async function readCanarySnapshot(relationalPath, idempotencyKey) {
  const DatabaseSync = await loadDatabaseSync();
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

async function waitForIssued(relationalPath, idempotencyKey, options) {
  const startedAt = Date.now();
  let lastSnapshot = null;
  while (Date.now() - startedAt < options.timeoutMs) {
    lastSnapshot = await readCanarySnapshot(relationalPath, idempotencyKey);
    const row = lastSnapshot.fiscalRows[0];
    if (row?.status === "issued") return lastSnapshot;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
  const status = lastSnapshot?.fiscalRows?.[0]?.status ?? "missing";
  throw new Error(`fiscal_outbox non arrivata a issued entro timeout, status=${status}`);
}

export async function runFiscalOutboxMockProviderCanary(options) {
  const cleanup = createCleanupRegistry();
  const startedAt = new Date().toISOString();
  let runDir = "";
  try {
    const fakeFiscalApi = await startFakePosFiscalApi(cleanup);
    runDir = await createTempRunDir("step13m-fiscal-outbox-mock-canary");
    const relationalPath = path.join(runDir, "backend-relational.sqlite");
    const backend = await startBackend(cleanup, {
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
        configureMockFiscalDevice(state, fakeFiscalApi.baseUrl, options.deviceUuid);
      },
    });

    const cashier = await loginJson(backend.baseUrl, "cashier", "2222", {
      deviceUuid: options.deviceUuid,
      clientApp: "fiscal-outbox-mock-canary",
    });
    const paid = await apiPost(
      backend.baseUrl,
      "/api/payments/ticket",
      fiscalTicketPayload(cashier, options),
    );
    if (paid.response.status !== 200 || paid.body?.ok !== true) {
      throw new Error(`pagamento canary fallito: HTTP ${paid.response.status} ${JSON.stringify(paid.body)}`);
    }
    const snapshot = await waitForIssued(relationalPath, options.idempotencyKey, options);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const receiptRequests = fakeFiscalApi.receiptRequests();
    const statusRequests = fakeFiscalApi.statusRequests();
    const issuedRow = snapshot.fiscalRows[0];
    const ok =
      paid.body?.fiscalPending === true &&
      paid.body?.relational?.writePrimary === true &&
      snapshot.transaction?.id &&
      snapshot.receipts.length === 1 &&
      snapshot.receipts[0].fiscal_status === "ISSUED" &&
      issuedRow?.status === "issued" &&
      receiptRequests.length === 1 &&
      statusRequests.length >= 1;

    return {
      ok: Boolean(ok),
      generatedAt: new Date().toISOString(),
      startedAt,
      runDir,
      backend: {
        baseUrl: backend.baseUrl,
        port: backend.port,
      },
      fakeFiscalApi: {
        baseUrl: fakeFiscalApi.baseUrl,
        statusRequests: statusRequests.length,
        receiptRequests: receiptRequests.length,
        lastReceiptIdempotencyKey: receiptRequests[0]?.headers?.["idempotency-key"] ?? "",
      },
      payment: {
        httpStatus: paid.response.status,
        ok: paid.body?.ok === true,
        fiscalPending: paid.body?.fiscalPending === true,
        relationalWritePrimary: paid.body?.relational?.writePrimary === true,
        id: paid.body?.payment?.id ?? "",
      },
      relational: {
        dbPath: relationalPath,
        transactionId: snapshot.transaction?.id ?? "",
        receiptId: snapshot.receipts[0]?.id ?? "",
        receiptStatus: snapshot.receipts[0]?.fiscal_status ?? "",
        fiscalOutboxId: issuedRow?.fiscal_id ?? "",
        fiscalOutboxStatus: issuedRow?.status ?? "",
        fiscalOutboxAttemptCount: issuedRow?.attempt_count ?? null,
        provider: issuedRow?.payload?.worker?.provider ?? snapshot.receipts[0]?.fiscal_provider ?? "",
      },
    };
  } catch (error) {
    return {
      ok: false,
      generatedAt: new Date().toISOString(),
      startedAt,
      runDir,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (!options.keepRunDir) {
      await cleanup.run();
      if (runDir) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        rmSync(runDir, { recursive: true, force: true });
      }
    }
  }
}

export function formatFiscalOutboxMockProviderCanarySummary(summary, { json = false } = {}) {
  if (json) return `${JSON.stringify(summary, null, 2)}\n`;
  const lines = ["Fiscal outbox mock provider canary", "==================================", ""];
  lines.push(`Generated: ${summary.generatedAt}`);
  if (summary.runDir) lines.push(`Run dir: ${summary.runDir}`);
  if (summary.backend?.baseUrl) lines.push(`Backend temp: ${summary.backend.baseUrl}`);
  if (summary.fakeFiscalApi?.baseUrl) lines.push(`Fiscal API mock: ${summary.fakeFiscalApi.baseUrl}`);
  if (summary.error) {
    lines.push("");
    lines.push(`Error: ${summary.error}`);
  }
  if (summary.payment) {
    lines.push("");
    lines.push("Payment");
    lines.push(`- HTTP: ${summary.payment.httpStatus}`);
    lines.push(`- ok: ${summary.payment.ok}`);
    lines.push(`- fiscalPending: ${summary.payment.fiscalPending}`);
    lines.push(`- relationalWritePrimary: ${summary.payment.relationalWritePrimary}`);
    lines.push(`- id: ${summary.payment.id || "-"}`);
  }
  if (summary.relational) {
    lines.push("");
    lines.push("Relational");
    lines.push(`- DB: ${summary.relational.dbPath}`);
    lines.push(`- transaction: ${summary.relational.transactionId || "-"}`);
    lines.push(`- receipt: ${summary.relational.receiptId || "-"} status=${summary.relational.receiptStatus || "-"}`);
    lines.push(`- fiscal_outbox: ${summary.relational.fiscalOutboxId || "-"} status=${summary.relational.fiscalOutboxStatus || "-"}`);
    lines.push(`- provider: ${summary.relational.provider || "-"}`);
  }
  if (summary.fakeFiscalApi) {
    lines.push("");
    lines.push("Provider calls");
    lines.push(`- status: ${summary.fakeFiscalApi.statusRequests}`);
    lines.push(`- receipt: ${summary.fakeFiscalApi.receiptRequests}`);
    lines.push(`- receipt idempotency: ${summary.fakeFiscalApi.lastReceiptIdempotencyKey || "-"}`);
  }
  lines.push("");
  lines.push(summary.ok ? "RESULT: OK" : "RESULT: FAIL");
  return `${lines.join("\n")}\n`;
}

export function writeFiscalOutboxMockProviderCanaryOutput(outputPath, summary, { json = false } = {}) {
  const targetPath = String(outputPath ?? "").trim();
  if (!targetPath) return "";
  const resolvedPath = path.resolve(targetPath);
  const outputAsJson = json || resolvedPath.toLowerCase().endsWith(".json");
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, formatFiscalOutboxMockProviderCanarySummary(summary, { json: outputAsJson }), "utf8");
  return resolvedPath;
}

async function main() {
  const options = parseFiscalOutboxMockProviderCanaryArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const summary = await runFiscalOutboxMockProviderCanary(options);
  process.stdout.write(formatFiscalOutboxMockProviderCanarySummary(summary, { json: options.json }));
  const outputPath = writeFiscalOutboxMockProviderCanaryOutput(options.output, summary, { json: options.json });
  if (outputPath) {
    const message = `[fiscal-outbox-mock-provider-canary] report salvato in ${outputPath}\n`;
    if (options.json) process.stderr.write(message);
    else process.stdout.write(message);
  }
  return summary.ok ? 0 : 2;
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exit(1);
    },
  );
}
