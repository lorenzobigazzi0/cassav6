#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_READY_AGE_MS = 120000;
const DEFAULT_PROCESSING_AGE_MS = 60000;

function intOption(value, fallback, { min = 0, max = 1_000_000_000 } = {}) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

export function parseFiscalOutboxSmokeArgs(argv = [], env = process.env) {
  const parsed = {
    baseUrl: normalizeUrl(env.FISCAL_OUTBOX_SMOKE_BASE_URL || env.STAGING_BASE_URL || env.BASE_URL || ""),
    dbPath: String(
      env.FISCAL_OUTBOX_DB_PATH ||
        env.BACKEND_RELATIONAL_DB_PATH ||
        path.resolve("backend", "backend-relational.sqlite"),
    ).trim(),
    token: String(env.FISCAL_OUTBOX_SMOKE_TOKEN || env.STAGING_TOKEN || env.RUNTIME_METRICS_TOKEN || "").trim(),
    timeoutMs: intOption(env.FISCAL_OUTBOX_SMOKE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { min: 1000 }),
    maxManualRequired: intOption(env.FISCAL_OUTBOX_MAX_MANUAL_REQUIRED, 0),
    maxFailed: intOption(env.FISCAL_OUTBOX_MAX_FAILED, 0),
    maxStaleReady: intOption(env.FISCAL_OUTBOX_MAX_STALE_READY, 0),
    maxReadyAgeMs: intOption(env.FISCAL_OUTBOX_MAX_READY_AGE_MS, DEFAULT_READY_AGE_MS),
    maxStaleProcessing: intOption(env.FISCAL_OUTBOX_MAX_STALE_PROCESSING, 0),
    maxProcessingAgeMs: intOption(env.FISCAL_OUTBOX_MAX_PROCESSING_AGE_MS, DEFAULT_PROCESSING_AGE_MS),
    output: String(env.FISCAL_OUTBOX_SMOKE_OUTPUT || "").trim(),
    requireBackend: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? "");
    const readNext = () => String(argv[(index += 1)] ?? "");
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--require-backend") parsed.requireBackend = true;
    else if (arg === "--base-url") parsed.baseUrl = normalizeUrl(readNext());
    else if (arg.startsWith("--base-url=")) parsed.baseUrl = normalizeUrl(arg.slice("--base-url=".length));
    else if (arg === "--db-path") parsed.dbPath = readNext().trim();
    else if (arg.startsWith("--db-path=")) parsed.dbPath = arg.slice("--db-path=".length).trim();
    else if (arg === "--token") parsed.token = readNext().trim();
    else if (arg.startsWith("--token=")) parsed.token = arg.slice("--token=".length).trim();
    else if (arg === "--output") parsed.output = readNext().trim();
    else if (arg.startsWith("--output=")) parsed.output = arg.slice("--output=".length).trim();
    else if (arg === "--timeout-ms") parsed.timeoutMs = intOption(readNext(), parsed.timeoutMs, { min: 1000 });
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = intOption(arg.slice("--timeout-ms=".length), parsed.timeoutMs, { min: 1000 });
    else if (arg === "--max-manual-required") parsed.maxManualRequired = intOption(readNext(), parsed.maxManualRequired);
    else if (arg.startsWith("--max-manual-required=")) parsed.maxManualRequired = intOption(arg.slice("--max-manual-required=".length), parsed.maxManualRequired);
    else if (arg === "--max-failed") parsed.maxFailed = intOption(readNext(), parsed.maxFailed);
    else if (arg.startsWith("--max-failed=")) parsed.maxFailed = intOption(arg.slice("--max-failed=".length), parsed.maxFailed);
    else if (arg === "--max-stale-ready") parsed.maxStaleReady = intOption(readNext(), parsed.maxStaleReady);
    else if (arg.startsWith("--max-stale-ready=")) parsed.maxStaleReady = intOption(arg.slice("--max-stale-ready=".length), parsed.maxStaleReady);
    else if (arg === "--max-ready-age-ms") parsed.maxReadyAgeMs = intOption(readNext(), parsed.maxReadyAgeMs);
    else if (arg.startsWith("--max-ready-age-ms=")) parsed.maxReadyAgeMs = intOption(arg.slice("--max-ready-age-ms=".length), parsed.maxReadyAgeMs);
    else if (arg === "--max-stale-processing") parsed.maxStaleProcessing = intOption(readNext(), parsed.maxStaleProcessing);
    else if (arg.startsWith("--max-stale-processing=")) parsed.maxStaleProcessing = intOption(arg.slice("--max-stale-processing=".length), parsed.maxStaleProcessing);
    else if (arg === "--max-processing-age-ms") parsed.maxProcessingAgeMs = intOption(readNext(), parsed.maxProcessingAgeMs);
    else if (arg.startsWith("--max-processing-age-ms=")) parsed.maxProcessingAgeMs = intOption(arg.slice("--max-processing-age-ms=".length), parsed.maxProcessingAgeMs);
  }

  parsed.dbPath = path.resolve(parsed.dbPath);
  if (parsed.output) parsed.output = path.resolve(parsed.output);
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/fiscal-outbox-staging-smoke.mjs --db-path backend/backend-relational.sqlite [opzioni]

  In alternativa, per i default o variabili ambiente:
  npm run smoke:fiscal-outbox-worker

Opzioni:
  --base-url URL                 backend staging opzionale; se presente controlla /api/health
  --require-backend              fallisce se --base-url manca o health non passa
  --db-path PATH                 SQLite relazionale da leggere in sola lettura
  --output PATH                  salva il report; .json forza formato JSON
  --max-manual-required N        default 0
  --max-failed N                 default 0
  --max-stale-ready N            default 0
  --max-ready-age-ms MS          default 120000
  --max-stale-processing N       default 0
  --max-processing-age-ms MS     default 60000
  --json                         output machine-readable

Lo smoke e' read-only: non crea pagamenti e non chiama il provider fiscale.
`);
}

async function loadDatabaseSync() {
  const sqliteModule = await import("node:sqlite");
  return sqliteModule.DatabaseSync;
}

function safeJsonParse(value, fallback = null) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function tableExists(db, tableName) {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

function rowsByStatus(db) {
  if (!tableExists(db, "fiscal_outbox")) return [];
  return db
    .prepare(
      `SELECT status, COUNT(*) AS count, MIN(created_at) AS oldest_created_at, MAX(updated_at) AS newest_updated_at
       FROM fiscal_outbox
       GROUP BY status
       ORDER BY status`,
    )
    .all();
}

function rowCount(rows, status) {
  return Number(rows.find((entry) => entry.status === status)?.count ?? 0);
}

function fetchLimitedRows(db, sql, params = []) {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => ({
      ...row,
      payload: safeJsonParse(row.payload_json, null),
      payload_json: undefined,
    }));
}

async function fetchBackendHealth(baseUrl, timeoutMs, token = "") {
  if (!baseUrl) return { skipped: true, ok: true, detail: "base URL non configurata" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const json = safeJsonParse(text, {});
    if (!response.ok || json?.ok !== true) {
      return {
        ok: false,
        detail: `HTTP ${response.status}: ${json?.error || json?.message || text.slice(0, 200)}`,
      };
    }
    return {
      ok: true,
      detail: `${json.service || "backend"} ${json.version || ""}`.trim(),
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildFiscalOutboxSmokeSummary(options = {}) {
  const nowIso = String(options.nowIso ?? new Date().toISOString());
  const readyCutoffIso = new Date(Date.parse(nowIso) - options.maxReadyAgeMs).toISOString();
  const processingCutoffIso = new Date(Date.parse(nowIso) - options.maxProcessingAgeMs).toISOString();
  const checks = [];

  const backendHealth = await fetchBackendHealth(options.baseUrl, options.timeoutMs, options.token);
  if (options.requireBackend && backendHealth.skipped) {
    checks.push({ name: "backend health", ok: false, detail: "base URL obbligatoria ma mancante" });
  } else {
    checks.push({
      name: "backend health",
      ok: backendHealth.ok === true,
      skipped: backendHealth.skipped === true,
      detail: backendHealth.detail,
    });
  }

  if (!existsSync(options.dbPath)) {
    checks.push({ name: "relational db", ok: false, detail: `file non trovato: ${options.dbPath}` });
    return { ok: false, options, checks, statusCounts: {}, samples: {}, generatedAt: nowIso };
  }

  const DatabaseSync = await loadDatabaseSync();
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  try {
    if (!tableExists(db, "fiscal_outbox")) {
      checks.push({ name: "fiscal_outbox table", ok: false, detail: "tabella fiscal_outbox mancante" });
      return { ok: false, options, checks, statusCounts: {}, samples: {}, generatedAt: nowIso };
    }
    checks.push({ name: "fiscal_outbox table", ok: true, detail: "presente" });

    const statuses = rowsByStatus(db);
    const statusCounts = Object.fromEntries(statuses.map((entry) => [entry.status, Number(entry.count)]));
    const manualRequired = rowCount(statuses, "manual_required");
    const failed = rowCount(statuses, "failed");

    const staleReady = fetchLimitedRows(
      db,
      `SELECT * FROM fiscal_outbox
       WHERE status IN ('requested', 'retrying')
         AND created_at <= ?
       ORDER BY created_at ASC, fiscal_id ASC
       LIMIT 20`,
      [readyCutoffIso],
    );
    const staleProcessing = fetchLimitedRows(
      db,
      `SELECT * FROM fiscal_outbox
       WHERE status = 'processing'
         AND (lock_expires_at IS NULL OR lock_expires_at <= ? OR locked_at <= ?)
       ORDER BY COALESCE(lock_expires_at, locked_at, updated_at, created_at) ASC, fiscal_id ASC
       LIMIT 20`,
      [nowIso, processingCutoffIso],
    );
    const duplicateOutboxAggregates = db
      .prepare(
        `SELECT aggregate_type, aggregate_id, COUNT(*) AS count
         FROM fiscal_outbox
         GROUP BY aggregate_type, aggregate_id
         HAVING COUNT(*) > 1
         ORDER BY count DESC, aggregate_type, aggregate_id
         LIMIT 20`,
      )
      .all();
    const duplicateFiscalReceipts = tableExists(db, "fiscal_receipts")
      ? db
          .prepare(
            `SELECT payment_transaction_id, COALESCE(attempt_scope, 'issue') AS attempt_scope, COUNT(*) AS count
             FROM fiscal_receipts
             WHERE payment_transaction_id IS NOT NULL
             GROUP BY payment_transaction_id, COALESCE(attempt_scope, 'issue')
             HAVING COUNT(*) > 1
             ORDER BY count DESC, payment_transaction_id
             LIMIT 20`,
          )
          .all()
      : [];
    const recentManualRequired = fetchLimitedRows(
      db,
      `SELECT * FROM fiscal_outbox
       WHERE status = 'manual_required'
       ORDER BY updated_at DESC, fiscal_id ASC
       LIMIT 10`,
    );

    checks.push({
      name: "manual_required",
      ok: manualRequired <= options.maxManualRequired,
      detail: `${manualRequired}/${options.maxManualRequired}`,
    });
    checks.push({
      name: "failed",
      ok: failed <= options.maxFailed,
      detail: `${failed}/${options.maxFailed}`,
    });
    checks.push({
      name: "ready backlog",
      ok: staleReady.length <= options.maxStaleReady,
      detail: `${staleReady.length}/${options.maxStaleReady} oltre ${options.maxReadyAgeMs}ms`,
    });
    checks.push({
      name: "processing stale",
      ok: staleProcessing.length <= options.maxStaleProcessing,
      detail: `${staleProcessing.length}/${options.maxStaleProcessing} oltre ${options.maxProcessingAgeMs}ms`,
    });
    checks.push({
      name: "duplicate fiscal_outbox aggregate",
      ok: duplicateOutboxAggregates.length === 0,
      detail: `${duplicateOutboxAggregates.length}`,
    });
    checks.push({
      name: "duplicate fiscal_receipts issue scope",
      ok: duplicateFiscalReceipts.length === 0,
      detail: `${duplicateFiscalReceipts.length}`,
    });

    return {
      ok: checks.every((entry) => entry.ok || entry.skipped),
      options,
      generatedAt: nowIso,
      statusCounts,
      statuses,
      checks,
      samples: {
        staleReady,
        staleProcessing,
        duplicateOutboxAggregates,
        duplicateFiscalReceipts,
        recentManualRequired,
      },
    };
  } finally {
    db.close();
  }
}

export function formatFiscalOutboxSmokeSummary(summary, { json = false } = {}) {
  if (json) return `${JSON.stringify(summary, null, 2)}\n`;
  const lines = ["Fiscal outbox worker staging smoke", "====================================", ""];
  lines.push(`DB: ${summary.options.dbPath}`);
  if (summary.options.baseUrl) lines.push(`Backend: ${summary.options.baseUrl}`);
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push("");
  lines.push("Checks");
  for (const check of summary.checks) {
    const status = check.skipped ? "SKIP" : check.ok ? "OK" : "FAIL";
    lines.push(`- [${status}] ${check.name}: ${check.detail ?? ""}`.trimEnd());
  }
  lines.push("");
  lines.push("Status counts");
  const statusNames = Object.keys(summary.statusCounts ?? {}).sort();
  if (statusNames.length === 0) lines.push("- nessuna riga fiscal_outbox");
  else for (const status of statusNames) lines.push(`- ${status}: ${summary.statusCounts[status]}`);
  for (const [name, rows] of Object.entries(summary.samples ?? {})) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    lines.push("");
    lines.push(`${name} sample`);
    for (const row of rows.slice(0, 5)) {
      const id = row.fiscal_id ?? row.aggregate_id ?? row.payment_transaction_id ?? "-";
      const status = row.status ? ` status=${row.status}` : "";
      const error = row.last_error_code ? ` error=${row.last_error_code}` : "";
      lines.push(`- ${id}${status}${error}`);
    }
  }
  lines.push("");
  lines.push(summary.ok ? "RESULT: OK" : "RESULT: FAIL");
  return `${lines.join("\n")}\n`;
}

export function writeFiscalOutboxSmokeOutput(outputPath, summary, { json = false } = {}) {
  const targetPath = String(outputPath ?? "").trim();
  if (!targetPath) return "";
  const resolvedPath = path.resolve(targetPath);
  const outputAsJson = json || resolvedPath.toLowerCase().endsWith(".json");
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, formatFiscalOutboxSmokeSummary(summary, { json: outputAsJson }), "utf8");
  return resolvedPath;
}

async function main() {
  const options = parseFiscalOutboxSmokeArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const summary = await buildFiscalOutboxSmokeSummary(options);
  process.stdout.write(formatFiscalOutboxSmokeSummary(summary, { json: options.json }));
  const outputPath = writeFiscalOutboxSmokeOutput(options.output, summary, { json: options.json });
  if (outputPath) {
    const message = `[fiscal-outbox-smoke] report salvato in ${outputPath}\n`;
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
