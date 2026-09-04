#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildFiscalOutboxSmokeSummary } from "./fiscal-outbox-staging-smoke.mjs";
import { buildFiscalOutboxPaymentCanarySummary } from "./fiscal-outbox-payment-canary.mjs";
import { runFiscalOutboxMockProviderCanary } from "./fiscal-outbox-mock-provider-canary.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:5280";
const DEFAULT_TIMEOUT_MS = 8000;

function normalizeUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function intOption(value, fallback, { min = 0, max = 1_000_000_000 } = {}) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function todayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export function parseFiscalOutboxStep13EvidenceArgs(argv = [], env = process.env) {
  const parsed = {
    baseUrl: normalizeUrl(env.FISCAL_OUTBOX_EVIDENCE_BASE_URL || env.STAGING_BASE_URL || env.BASE_URL || DEFAULT_BASE_URL),
    dbPath: String(
      env.FISCAL_OUTBOX_DB_PATH ||
        env.BACKEND_RELATIONAL_DB_PATH ||
        path.resolve("backend", "backend-relational.sqlite"),
    ).trim(),
    outDir: String(env.FISCAL_OUTBOX_EVIDENCE_OUT_DIR || "reports").trim(),
    username: String(env.FISCAL_OUTBOX_EVIDENCE_USERNAME || env.CANARY_USERNAME || "admin").trim(),
    pin: String(env.FISCAL_OUTBOX_EVIDENCE_PIN || env.CANARY_PIN || "1234").trim(),
    timeoutMs: intOption(env.FISCAL_OUTBOX_EVIDENCE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { min: 1000 }),
    skipMock: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? "");
    const readNext = () => String(argv[(index += 1)] ?? "");
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--skip-mock") parsed.skipMock = true;
    else if (arg === "--base-url") parsed.baseUrl = normalizeUrl(readNext());
    else if (arg.startsWith("--base-url=")) parsed.baseUrl = normalizeUrl(arg.slice("--base-url=".length));
    else if (arg === "--db-path") parsed.dbPath = readNext().trim();
    else if (arg.startsWith("--db-path=")) parsed.dbPath = arg.slice("--db-path=".length).trim();
    else if (arg === "--out-dir") parsed.outDir = readNext().trim();
    else if (arg.startsWith("--out-dir=")) parsed.outDir = arg.slice("--out-dir=".length).trim();
    else if (arg === "--username") parsed.username = readNext().trim();
    else if (arg.startsWith("--username=")) parsed.username = arg.slice("--username=".length).trim();
    else if (arg === "--pin") parsed.pin = readNext().trim();
    else if (arg.startsWith("--pin=")) parsed.pin = arg.slice("--pin=".length).trim();
    else if (arg === "--timeout-ms") parsed.timeoutMs = intOption(readNext(), parsed.timeoutMs, { min: 1000 });
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = intOption(arg.slice("--timeout-ms=".length), parsed.timeoutMs, { min: 1000 });
  }

  parsed.dbPath = path.resolve(parsed.dbPath);
  parsed.outDir = path.resolve(parsed.outDir || "reports");
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/fiscal-outbox-step13-evidence.mjs [opzioni]

Genera un report consolidato Step 13:
  1. smoke live read-only con /api/health;
  2. canary live preflight senza pagamento;
  3. canary mock isolato con pagamento reale su backend temporaneo.

Opzioni:
  --base-url URL      backend live/staging, default ${DEFAULT_BASE_URL}
  --db-path PATH      SQLite relazionale letto dallo smoke live
  --out-dir DIR       directory report, default reports
  --username NAME     utente preflight live, default admin
  --pin PIN           PIN preflight live, default 1234
  --skip-mock         non esegue il canary mock isolato
  --json              stampa JSON su stdout
`);
}

function buildLiveSmokeOptions(options) {
  return {
    baseUrl: options.baseUrl,
    dbPath: options.dbPath,
    token: "",
    timeoutMs: options.timeoutMs,
    maxManualRequired: 0,
    maxFailed: 0,
    maxStaleReady: 0,
    maxReadyAgeMs: 120000,
    maxStaleProcessing: 0,
    maxProcessingAgeMs: 60000,
    requireBackend: true,
  };
}

function buildLivePreflightOptions(options) {
  const stamp = todayStamp();
  return {
    baseUrl: options.baseUrl,
    dbPath: options.dbPath,
    username: options.username,
    pin: options.pin,
    deviceUuid: "fiscal-outbox-step13-evidence-device",
    clientApp: "fiscal-outbox-step13-evidence",
    idempotencyKey: `fiscal-outbox-step13-evidence-live-${stamp}`,
    paymentMethodId: "pay_cash",
    itemName: "Evidenza fiscale Step 13",
    amount: 1.3,
    execute: false,
    allowRealFiscal: false,
    timeoutMs: options.timeoutMs,
    pollMs: 500,
    pollAttempts: 20,
  };
}

function buildMockCanaryOptions() {
  const stamp = todayStamp();
  return {
    idempotencyKey: `fiscal-outbox-step13-evidence-mock-${stamp}`,
    deviceUuid: "fiscal-outbox-step13-evidence-mock-device",
    amount: 1.3,
    timeoutMs: 10000,
    pollMs: 100,
    keepRunDir: false,
  };
}

function livePreflightIsSafe(summary) {
  return summary?.ok === true && summary?.payment?.status === "skipped_preflight";
}

function summarizeStatus(summary) {
  return summary?.ok === true ? "OK" : "FAIL";
}

export async function buildFiscalOutboxStep13Evidence(options) {
  const generatedAt = new Date().toISOString();
  const liveSmoke = await buildFiscalOutboxSmokeSummary(buildLiveSmokeOptions(options));
  const livePaymentPreflight = await buildFiscalOutboxPaymentCanarySummary(buildLivePreflightOptions(options));
  const mockProviderCanary = options.skipMock
    ? { ok: true, skipped: true, reason: "--skip-mock impostato" }
    : await runFiscalOutboxMockProviderCanary(buildMockCanaryOptions());

  const checks = [
    {
      name: "live smoke",
      ok: liveSmoke.ok === true,
      detail: summarizeStatus(liveSmoke),
    },
    {
      name: "live payment preflight",
      ok: livePreflightIsSafe(livePaymentPreflight),
      detail: `${livePaymentPreflight?.payment?.status ?? "unknown"}; safety=${livePaymentPreflight?.safety?.mode ?? "unknown"}`,
    },
    {
      name: "mock provider canary",
      ok: mockProviderCanary.ok === true,
      skipped: mockProviderCanary.skipped === true,
      detail: mockProviderCanary.skipped ? mockProviderCanary.reason : summarizeStatus(mockProviderCanary),
    },
  ];

  return {
    ok: checks.every((entry) => entry.ok === true || entry.skipped === true),
    generatedAt,
    options: {
      baseUrl: options.baseUrl,
      dbPath: options.dbPath,
      outDir: options.outDir,
      username: options.username,
      skipMock: options.skipMock,
    },
    checks,
    liveSmoke,
    livePaymentPreflight,
    mockProviderCanary,
  };
}

export function formatFiscalOutboxStep13EvidenceMarkdown(summary) {
  const lines = ["# Fiscal outbox Step 13 evidence", ""];
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Backend: ${summary.options.baseUrl}`);
  lines.push(`DB: ${summary.options.dbPath}`);
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push(summary.ok ? "RESULT: OK" : "RESULT: FAIL");
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  for (const check of summary.checks) {
    const status = check.skipped ? "SKIP" : check.ok ? "OK" : "FAIL";
    lines.push(`- [${status}] ${check.name}: ${check.detail ?? ""}`);
  }
  lines.push("");
  lines.push("## Live Smoke");
  lines.push("");
  lines.push(`- result: ${summarizeStatus(summary.liveSmoke)}`);
  lines.push(`- backend health: ${summary.liveSmoke?.checks?.find((entry) => entry.name === "backend health")?.detail ?? "-"}`);
  lines.push(`- fiscal_outbox table: ${summary.liveSmoke?.checks?.find((entry) => entry.name === "fiscal_outbox table")?.detail ?? "-"}`);
  lines.push(`- manual_required: ${summary.liveSmoke?.statusCounts?.manual_required ?? 0}`);
  lines.push(`- failed: ${summary.liveSmoke?.statusCounts?.failed ?? 0}`);
  lines.push("");
  lines.push("## Live Payment Preflight");
  lines.push("");
  lines.push(`- result: ${summarizeStatus(summary.livePaymentPreflight)}`);
  lines.push(`- payment: ${summary.livePaymentPreflight?.payment?.status ?? "unknown"}`);
  lines.push(`- safety: ${summary.livePaymentPreflight?.safety?.mode ?? "unknown"} - ${summary.livePaymentPreflight?.safety?.reason ?? ""}`);
  const activeDevices = summary.livePaymentPreflight?.safety?.activeDevices ?? [];
  for (const device of activeDevices) {
    lines.push(`- device ${device.id || device.name || "-"} provider=${device.provider || "-"} safe=${device.safe ? "yes" : "no"} reason=${device.reason}`);
  }
  lines.push("");
  lines.push("## Mock Provider Canary");
  lines.push("");
  if (summary.mockProviderCanary?.skipped) {
    lines.push(`- skipped: ${summary.mockProviderCanary.reason}`);
  } else {
    lines.push(`- result: ${summarizeStatus(summary.mockProviderCanary)}`);
    lines.push(`- payment HTTP: ${summary.mockProviderCanary?.payment?.httpStatus ?? "-"}`);
    lines.push(`- fiscalPending: ${summary.mockProviderCanary?.payment?.fiscalPending ?? "-"}`);
    lines.push(`- relationalWritePrimary: ${summary.mockProviderCanary?.payment?.relationalWritePrimary ?? "-"}`);
    lines.push(`- receipt status: ${summary.mockProviderCanary?.relational?.receiptStatus ?? "-"}`);
    lines.push(`- fiscal_outbox status: ${summary.mockProviderCanary?.relational?.fiscalOutboxStatus ?? "-"}`);
    lines.push(`- provider receipt calls: ${summary.mockProviderCanary?.fakeFiscalApi?.receiptRequests ?? "-"}`);
  }
  lines.push("");
  lines.push("## Safety");
  lines.push("");
  lines.push("- Il preflight live non crea pagamenti.");
  lines.push("- Il canary mock usa backend temporaneo e provider fiscale mock locale.");
  lines.push("- Nessun documento fiscale reale viene emesso da questo report.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function writeFiscalOutboxStep13Evidence(summary, outDir) {
  const targetDir = path.resolve(String(outDir ?? "reports").trim() || "reports");
  mkdirSync(targetDir, { recursive: true });
  const jsonPath = path.join(targetDir, "fiscal-outbox-step13-evidence.json");
  const mdPath = path.join(targetDir, "fiscal-outbox-step13-evidence.md");
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, formatFiscalOutboxStep13EvidenceMarkdown(summary), "utf8");
  return { jsonPath, mdPath };
}

async function main() {
  const options = parseFiscalOutboxStep13EvidenceArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const summary = await buildFiscalOutboxStep13Evidence(options);
  const output = writeFiscalOutboxStep13Evidence(summary, options.outDir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, output }, null, 2)}\n`);
  } else {
    process.stdout.write(formatFiscalOutboxStep13EvidenceMarkdown(summary));
    process.stdout.write(`[fiscal-outbox-step13-evidence] JSON: ${output.jsonPath}\n`);
    process.stdout.write(`[fiscal-outbox-step13-evidence] Markdown: ${output.mdPath}\n`);
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
