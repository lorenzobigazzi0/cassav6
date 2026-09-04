#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:5280";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_AMOUNT = 1.3;

function normalizeUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function boolEnv(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
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

function todayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export function parseFiscalOutboxPaymentCanaryArgs(argv = [], env = process.env) {
  const parsed = {
    baseUrl: normalizeUrl(env.FISCAL_OUTBOX_CANARY_BASE_URL || env.STAGING_BASE_URL || env.BASE_URL || DEFAULT_BASE_URL),
    dbPath: String(
      env.FISCAL_OUTBOX_DB_PATH ||
        env.BACKEND_RELATIONAL_DB_PATH ||
        path.resolve("backend", "backend-relational.sqlite"),
    ).trim(),
    username: String(env.FISCAL_OUTBOX_CANARY_USERNAME || env.CANARY_USERNAME || "admin").trim(),
    pin: String(env.FISCAL_OUTBOX_CANARY_PIN || env.CANARY_PIN || "1234").trim(),
    deviceUuid: String(env.FISCAL_OUTBOX_CANARY_DEVICE_UUID || "fiscal-outbox-canary-device").trim(),
    clientApp: String(env.FISCAL_OUTBOX_CANARY_CLIENT_APP || "fiscal-outbox-canary").trim(),
    idempotencyKey: String(env.FISCAL_OUTBOX_CANARY_IDEMPOTENCY_KEY || `fiscal-outbox-canary-${todayStamp()}`).trim(),
    paymentMethodId: String(env.FISCAL_OUTBOX_CANARY_PAYMENT_METHOD_ID || "pay_cash").trim(),
    itemName: String(env.FISCAL_OUTBOX_CANARY_ITEM_NAME || "Canary fiscale staging").trim(),
    amount: moneyOption(env.FISCAL_OUTBOX_CANARY_AMOUNT, DEFAULT_AMOUNT),
    output: String(env.FISCAL_OUTBOX_CANARY_OUTPUT || "").trim(),
    execute: boolEnv(env.FISCAL_OUTBOX_CANARY_EXECUTE, false),
    allowRealFiscal: boolEnv(env.FISCAL_OUTBOX_CANARY_ALLOW_REAL_FISCAL, false),
    timeoutMs: intOption(env.FISCAL_OUTBOX_CANARY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { min: 1000 }),
    pollMs: intOption(env.FISCAL_OUTBOX_CANARY_POLL_MS, 500, { min: 100 }),
    pollAttempts: intOption(env.FISCAL_OUTBOX_CANARY_POLL_ATTEMPTS, 20, { min: 1, max: 300 }),
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? "");
    const readNext = () => String(argv[(index += 1)] ?? "");
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--execute") parsed.execute = true;
    else if (arg === "--allow-real-fiscal") parsed.allowRealFiscal = true;
    else if (arg === "--base-url") parsed.baseUrl = normalizeUrl(readNext());
    else if (arg.startsWith("--base-url=")) parsed.baseUrl = normalizeUrl(arg.slice("--base-url=".length));
    else if (arg === "--db-path") parsed.dbPath = readNext().trim();
    else if (arg.startsWith("--db-path=")) parsed.dbPath = arg.slice("--db-path=".length).trim();
    else if (arg === "--username") parsed.username = readNext().trim();
    else if (arg.startsWith("--username=")) parsed.username = arg.slice("--username=".length).trim();
    else if (arg === "--pin") parsed.pin = readNext().trim();
    else if (arg.startsWith("--pin=")) parsed.pin = arg.slice("--pin=".length).trim();
    else if (arg === "--device-uuid") parsed.deviceUuid = readNext().trim();
    else if (arg.startsWith("--device-uuid=")) parsed.deviceUuid = arg.slice("--device-uuid=".length).trim();
    else if (arg === "--idempotency-key") parsed.idempotencyKey = readNext().trim();
    else if (arg.startsWith("--idempotency-key=")) parsed.idempotencyKey = arg.slice("--idempotency-key=".length).trim();
    else if (arg === "--payment-method-id") parsed.paymentMethodId = readNext().trim();
    else if (arg.startsWith("--payment-method-id=")) parsed.paymentMethodId = arg.slice("--payment-method-id=".length).trim();
    else if (arg === "--amount") parsed.amount = moneyOption(readNext(), parsed.amount);
    else if (arg.startsWith("--amount=")) parsed.amount = moneyOption(arg.slice("--amount=".length), parsed.amount);
    else if (arg === "--output") parsed.output = readNext().trim();
    else if (arg.startsWith("--output=")) parsed.output = arg.slice("--output=".length).trim();
    else if (arg === "--timeout-ms") parsed.timeoutMs = intOption(readNext(), parsed.timeoutMs, { min: 1000 });
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = intOption(arg.slice("--timeout-ms=".length), parsed.timeoutMs, { min: 1000 });
    else if (arg === "--poll-ms") parsed.pollMs = intOption(readNext(), parsed.pollMs, { min: 100 });
    else if (arg.startsWith("--poll-ms=")) parsed.pollMs = intOption(arg.slice("--poll-ms=".length), parsed.pollMs, { min: 100 });
    else if (arg === "--poll-attempts") parsed.pollAttempts = intOption(readNext(), parsed.pollAttempts, { min: 1, max: 300 });
    else if (arg.startsWith("--poll-attempts=")) parsed.pollAttempts = intOption(arg.slice("--poll-attempts=".length), parsed.pollAttempts, { min: 1, max: 300 });
  }

  parsed.dbPath = path.resolve(parsed.dbPath);
  if (parsed.output) parsed.output = path.resolve(parsed.output);
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/fiscal-outbox-payment-canary.mjs --base-url http://127.0.0.1:5280 [opzioni]

Default: preflight read-only. Il pagamento viene creato solo con --execute.

Opzioni:
  --execute                    crea il pagamento fiscale se il provider e' safe
  --allow-real-fiscal          autorizza esplicitamente provider non mock/staging
  --base-url URL               backend staging, default ${DEFAULT_BASE_URL}
  --db-path PATH               SQLite relazionale per verifica fiscal_outbox
  --username NAME              default admin
  --pin PIN                    default 1234
  --device-uuid ID             default fiscal-outbox-canary-device
  --idempotency-key KEY        default fiscal-outbox-canary-YYYYMMDD
  --payment-method-id ID       default pay_cash
  --amount EUR                 default ${DEFAULT_AMOUNT}
  --output PATH                salva report; .json forza JSON
  --json                       output machine-readable

Safety gate:
  senza --allow-real-fiscal, l'esecuzione e' bloccata se i fiscal devices
  attivi non sono chiaramente mock/staging/test/sandbox.
`);
}

async function fetchJson(baseUrl, pathName, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${pathName}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { response, json, text };
  } finally {
    clearTimeout(timeout);
  }
}

function safeStrings(values) {
  return values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

export function classifyFiscalDeviceSafety(device = {}) {
  const status = String(device.status ?? "").trim().toLowerCase();
  const active = device.active !== false && status !== "disabled" && status !== "inactive";
  const provider = String(device.fiscalProvider ?? device.provider ?? "").trim().toLowerCase();
  const type = String(device.type ?? device.kind ?? "").trim().toLowerCase();
  const apiBaseUrl = String(device.apiBaseUrl ?? device.fiscalApiBaseUrl ?? "").trim().toLowerCase();
  const joined = safeStrings([
    provider,
    type,
    apiBaseUrl,
    device.statusEndpoint,
    device.receiptEndpoint,
    device.reprintEndpoint,
    device.source,
  ])
    .join(" ")
    .toLowerCase();

  if (!active) {
    return { active: false, safe: true, reason: "device non attivo" };
  }
  if (provider === "mock" || provider.includes("mock")) {
    return { active: true, safe: true, reason: "provider mock" };
  }
  if (/(^|[^a-z])(staging|stage|test|sandbox|simulator|simulato)([^a-z]|$)/i.test(joined)) {
    return { active: true, safe: true, reason: "provider staging/test/sandbox" };
  }
  return {
    active: true,
    safe: false,
    reason: `provider non classificato safe: ${provider || type || "sconosciuto"}`,
  };
}

export function evaluateFiscalSafety(snapshot = {}, { allowRealFiscal = false } = {}) {
  const fiscalDevices = Array.isArray(snapshot.fiscalDevices) ? snapshot.fiscalDevices : [];
  const activeResults = fiscalDevices.map((device) => ({
    id: String(device.id ?? "").trim(),
    name: String(device.name ?? device.label ?? "").trim(),
    provider: String(device.fiscalProvider ?? device.provider ?? "").trim(),
    apiBaseUrl: String(device.apiBaseUrl ?? device.fiscalApiBaseUrl ?? "").trim(),
    ...classifyFiscalDeviceSafety(device),
  })).filter((entry) => entry.active);

  if (allowRealFiscal) {
    return {
      ok: true,
      mode: "explicit-real-fiscal-allowed",
      reason: "--allow-real-fiscal impostato",
      activeDevices: activeResults,
    };
  }
  if (snapshot.demoMode === true) {
    return {
      ok: true,
      mode: "demo",
      reason: "demoMode attivo",
      activeDevices: activeResults,
    };
  }
  if (activeResults.length === 0) {
    return {
      ok: false,
      mode: "blocked",
      reason: "nessun fiscal device attivo rilevato",
      activeDevices: activeResults,
    };
  }
  const unsafe = activeResults.filter((entry) => !entry.safe);
  if (unsafe.length > 0) {
    return {
      ok: false,
      mode: "blocked",
      reason: unsafe.map((entry) => `${entry.id || entry.name || "device"}: ${entry.reason}`).join("; "),
      activeDevices: activeResults,
    };
  }
  return {
    ok: true,
    mode: "safe",
    reason: "tutti i fiscal device attivi sono mock/staging",
    activeDevices: activeResults,
  };
}

function buildAuthPayload(session, options, extra = {}) {
  return {
    token: session?.token,
    userId: session?.user?.id,
    deviceUuid: options.deviceUuid,
    ...extra,
  };
}

function buildPaymentPayload(session, options) {
  return buildAuthPayload(session, options, {
    paymentMethodId: options.paymentMethodId,
    cashGiven: options.amount,
    issueFiscal: true,
    fiscalDocType: "RECEIPT",
    idempotencyKey: options.idempotencyKey,
    lines: [
      {
        name: options.itemName,
        qty: 1,
        unitPrice: options.amount,
        unitPriceApplied: options.amount,
        lineTotal: options.amount,
      },
    ],
  });
}

async function login(options) {
  const { response, json, text } = await fetchJson(options.baseUrl, "/api/auth/login", {
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      username: options.username,
      pin: options.pin,
      deviceUuid: options.deviceUuid,
      clientApp: options.clientApp,
    },
  });
  if (!response.ok || json?.token == null || json?.user?.id == null) {
    throw new Error(`login fallito: HTTP ${response.status} ${text || ""}`.trim());
  }
  return json;
}

async function readConfigurationSnapshot(session, options) {
  const { response, json, text } = await fetchJson(options.baseUrl, "/api/settings/configuration/snapshot", {
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: buildAuthPayload(session, options),
  });
  if (!response.ok || json?.ok !== true) {
    throw new Error(`configuration snapshot fallito: HTTP ${response.status} ${text || ""}`.trim());
  }
  return json;
}

async function checkHealth(options) {
  const { response, json, text } = await fetchJson(options.baseUrl, "/api/health", {
    timeoutMs: options.timeoutMs,
  });
  if (!response.ok || json?.ok !== true) {
    throw new Error(`health fallito: HTTP ${response.status} ${text || ""}`.trim());
  }
  return json;
}

async function postPayment(session, options) {
  const payload = buildPaymentPayload(session, options);
  const { response, json, text } = await fetchJson(options.baseUrl, "/api/payments/ticket", {
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: payload,
  });
  return {
    ok: response.ok && json?.ok === true,
    status: response.status,
    body: json,
    text,
  };
}

async function loadDatabaseSync() {
  const sqliteModule = await import("node:sqlite");
  return sqliteModule.DatabaseSync;
}

function tableExists(db, tableName) {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

async function readFiscalOutboxSnapshot(dbPath, idempotencyKey) {
  if (!existsSync(dbPath)) return { skipped: true, reason: "DB relazionale non trovato" };
  const DatabaseSync = await loadDatabaseSync();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const requiredTables = ["payment_transactions", "fiscal_receipts", "fiscal_outbox"];
    const missingTables = requiredTables.filter((tableName) => !tableExists(db, tableName));
    if (missingTables.length > 0) {
      return { skipped: true, reason: `tabelle mancanti: ${missingTables.join(", ")}` };
    }
    const transactions = db
      .prepare("SELECT * FROM payment_transactions WHERE idempotency_key = ? ORDER BY id ASC")
      .all(idempotencyKey);
    const transactionIds = transactions.map((entry) => entry.id);
    const receipts = transactionIds.length
      ? db
          .prepare(
            `SELECT * FROM fiscal_receipts WHERE payment_transaction_id IN (${transactionIds.map(() => "?").join(",")}) ORDER BY id ASC`,
          )
          .all(...transactionIds)
      : [];
    const outbox = receipts.length
      ? db
          .prepare(
            `SELECT * FROM fiscal_outbox WHERE aggregate_id IN (${receipts.map(() => "?").join(",")}) ORDER BY fiscal_id ASC`,
          )
          .all(...receipts.map((entry) => entry.id))
      : [];
    return {
      skipped: false,
      transactions,
      receipts,
      outbox,
    };
  } finally {
    db.close();
  }
}

async function pollFiscalOutboxSnapshot(options) {
  let snapshot = null;
  for (let attempt = 1; attempt <= options.pollAttempts; attempt += 1) {
    snapshot = await readFiscalOutboxSnapshot(options.dbPath, options.idempotencyKey);
    if (snapshot.skipped || snapshot.outbox?.length > 0) {
      return { attempts: attempt, snapshot };
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
  return { attempts: options.pollAttempts, snapshot };
}

export async function buildFiscalOutboxPaymentCanarySummary(options) {
  const checks = [];
  const summary = {
    ok: false,
    generatedAt: new Date().toISOString(),
    options: {
      baseUrl: options.baseUrl,
      dbPath: options.dbPath,
      username: options.username,
      deviceUuid: options.deviceUuid,
      idempotencyKey: options.idempotencyKey,
      paymentMethodId: options.paymentMethodId,
      amount: options.amount,
      execute: options.execute,
      allowRealFiscal: options.allowRealFiscal,
    },
    checks,
    safety: null,
    payment: {
      status: "not_started",
    },
    fiscalOutbox: null,
  };

  try {
    const health = await checkHealth(options);
    checks.push({ name: "backend health", ok: true, detail: `${health.service ?? "backend"} ${health.version ?? ""}`.trim() });
    const session = await login(options);
    checks.push({ name: "login", ok: true, detail: `${session.user?.username ?? options.username}` });
    const snapshot = await readConfigurationSnapshot(session, options);
    checks.push({ name: "configuration snapshot", ok: true, detail: `fiscalDevices=${Array.isArray(snapshot.fiscalDevices) ? snapshot.fiscalDevices.length : 0}` });
    const safety = evaluateFiscalSafety(snapshot, { allowRealFiscal: options.allowRealFiscal });
    summary.safety = safety;
    checks.push({ name: "fiscal safety gate", ok: safety.ok, blocked: !safety.ok, detail: safety.reason });

    if (!options.execute) {
      summary.payment = {
        status: "skipped_preflight",
        detail: "pagamento non eseguito: manca --execute",
      };
      summary.ok = true;
      return summary;
    }

    if (!safety.ok) {
      summary.payment = {
        status: "blocked_safety",
        detail: safety.reason,
      };
      summary.ok = false;
      return summary;
    }

    const payment = await postPayment(session, options);
    summary.payment = {
      status: payment.ok ? "posted" : "failed",
      httpStatus: payment.status,
      ok: payment.ok,
      fiscalPending: payment.body?.fiscalPending === true,
      relationalWritePrimary: payment.body?.relational?.writePrimary === true,
      paymentId: payment.body?.payment?.id ?? payment.body?.paymentId ?? null,
      error: payment.ok ? "" : payment.body?.error ?? payment.text ?? "",
    };
    checks.push({ name: "payment post", ok: payment.ok, detail: `HTTP ${payment.status}` });
    const fiscalOutbox = await pollFiscalOutboxSnapshot(options);
    summary.fiscalOutbox = fiscalOutbox;
    const outboxRows = fiscalOutbox.snapshot?.outbox ?? [];
    const hasOutboxRow = Array.isArray(outboxRows) && outboxRows.length > 0;
    checks.push({
      name: "fiscal_outbox row",
      ok: hasOutboxRow,
      detail: fiscalOutbox.snapshot?.skipped ? fiscalOutbox.snapshot.reason : `${outboxRows.length} righe`,
    });
    summary.ok = payment.ok && hasOutboxRow;
    return summary;
  } catch (error) {
    checks.push({ name: "canary exception", ok: false, detail: error instanceof Error ? error.message : String(error) });
    summary.payment = {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
    summary.ok = false;
    return summary;
  }
}

export function formatFiscalOutboxPaymentCanarySummary(summary, { json = false } = {}) {
  if (json) return `${JSON.stringify(summary, null, 2)}\n`;
  const lines = ["Fiscal outbox payment canary", "=============================", ""];
  lines.push(`Backend: ${summary.options.baseUrl}`);
  lines.push(`DB: ${summary.options.dbPath}`);
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Mode: ${summary.options.execute ? "EXECUTE" : "PREFLIGHT"}`);
  lines.push("");
  lines.push("Checks");
  for (const check of summary.checks) {
    const status = check.blocked ? "BLOCK" : check.ok ? "OK" : "FAIL";
    lines.push(`- [${status}] ${check.name}: ${check.detail ?? ""}`.trimEnd());
  }
  lines.push("");
  lines.push(`Safety: ${summary.safety?.mode ?? "unknown"} - ${summary.safety?.reason ?? ""}`.trimEnd());
  if (Array.isArray(summary.safety?.activeDevices) && summary.safety.activeDevices.length > 0) {
    for (const device of summary.safety.activeDevices) {
      lines.push(`- device ${device.id || device.name || "-"} provider=${device.provider || "-"} safe=${device.safe ? "yes" : "no"} reason=${device.reason}`);
    }
  }
  lines.push("");
  lines.push(`Payment: ${summary.payment?.status ?? "unknown"} ${summary.payment?.detail ?? ""}`.trimEnd());
  if (summary.payment?.httpStatus) lines.push(`Payment HTTP: ${summary.payment.httpStatus}`);
  if (summary.payment?.paymentId) lines.push(`Payment ID: ${summary.payment.paymentId}`);
  const outboxRows = summary.fiscalOutbox?.snapshot?.outbox ?? [];
  if (Array.isArray(outboxRows) && outboxRows.length > 0) {
    lines.push("");
    lines.push("Fiscal outbox rows");
    for (const row of outboxRows.slice(0, 5)) {
      lines.push(`- ${row.fiscal_id} status=${row.status} aggregate=${row.aggregate_id}`);
    }
  }
  lines.push("");
  lines.push(summary.ok ? "RESULT: OK" : "RESULT: FAIL");
  return `${lines.join("\n")}\n`;
}

export function writeFiscalOutboxPaymentCanaryOutput(outputPath, summary, { json = false } = {}) {
  const targetPath = String(outputPath ?? "").trim();
  if (!targetPath) return "";
  const resolvedPath = path.resolve(targetPath);
  const outputAsJson = json || resolvedPath.toLowerCase().endsWith(".json");
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, formatFiscalOutboxPaymentCanarySummary(summary, { json: outputAsJson }), "utf8");
  return resolvedPath;
}

async function main() {
  const options = parseFiscalOutboxPaymentCanaryArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const summary = await buildFiscalOutboxPaymentCanarySummary(options);
  process.stdout.write(formatFiscalOutboxPaymentCanarySummary(summary, { json: options.json }));
  const outputPath = writeFiscalOutboxPaymentCanaryOutput(options.output, summary, { json: options.json });
  if (outputPath) {
    const message = `[fiscal-outbox-payment-canary] report salvato in ${outputPath}\n`;
    if (options.json) process.stderr.write(message);
    else process.stdout.write(message);
  }
  if (!options.execute) return 0;
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
