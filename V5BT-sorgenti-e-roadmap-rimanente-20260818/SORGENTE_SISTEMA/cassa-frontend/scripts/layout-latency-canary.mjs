import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");

function envString(name, fallback = "") {
  const value = String(process.env[name] ?? "").trim();
  return value || fallback;
}

function envNumber(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function envBool(name, fallback = false) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

const options = {
  origin: envString("LAYOUT_LATENCY_ORIGIN", "https://127.0.0.1:5280").replace(/\/+$/, ""),
  metricsOrigin: envString("LAYOUT_LATENCY_METRICS_ORIGIN", "http://127.0.0.1:5281").replace(/\/+$/, ""),
  username: envString("LAYOUT_LATENCY_USERNAME", "amalia"),
  pin: envString("LAYOUT_LATENCY_PIN", "182018"),
  requests: envNumber("LAYOUT_LATENCY_REQUESTS", 120, { min: 1, max: 20_000 }),
  warmup: envNumber("LAYOUT_LATENCY_WARMUP", 5, { min: 0, max: 1_000 }),
  concurrency: envNumber("LAYOUT_LATENCY_CONCURRENCY", 1, { min: 1, max: 256 }),
  delayMs: envNumber("LAYOUT_LATENCY_DELAY_MS", 0, { min: 0, max: 60_000 }),
  timeoutMs: envNumber("LAYOUT_LATENCY_TIMEOUT_MS", 10_000, { min: 500, max: 120_000 }),
  expectedTables: envNumber("LAYOUT_LATENCY_EXPECT_TABLES", 0, { min: 0, max: 10_000 }),
  maxP95Ms: envNumber("LAYOUT_LATENCY_MAX_P95_MS", 0, { min: 0, max: 120_000 }),
  resetMetrics: envBool("LAYOUT_LATENCY_RESET_METRICS", true),
  reportRoot: envString("LAYOUT_LATENCY_REPORT_ROOT", path.join(cassaRoot, "reports")),
  insecureTls: envBool("LAYOUT_LATENCY_INSECURE_TLS", true),
};

if (options.insecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const runId = envString(
  "LAYOUT_LATENCY_RUN_ID",
  `layout_latency_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`,
);

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function percentile(values, ratio) {
  const clean = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!clean.length) return null;
  const index = Math.min(
    clean.length - 1,
    Math.max(0, Math.ceil(clean.length * ratio) - 1),
  );
  return clean[index];
}

function summarizeDurations(samples) {
  const durations = samples
    .map((sample) => Number(sample.durationMs))
    .filter((value) => Number.isFinite(value));
  const sum = durations.reduce((total, value) => total + value, 0);
  return {
    count: durations.length,
    avgMs: round(durations.length ? sum / durations.length : null),
    p50Ms: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    p99Ms: round(percentile(durations, 0.99)),
    minMs: round(durations.length ? Math.min(...durations) : null),
    maxMs: round(durations.length ? Math.max(...durations) : null),
  };
}

function countBy(samples, getter) {
  return samples.reduce((accumulator, sample) => {
    const key = String(getter(sample) ?? "") || "none";
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Timeout HTTP ${options.timeoutMs}ms`)),
    options.timeoutMs,
  );
  try {
    return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(origin, pathname, init = {}) {
  const startedAt = performance.now();
  const response = await fetchWithTimeout(`${origin}${pathname}`, {
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
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    durationMs: performance.now() - startedAt,
    proxyRole: response.headers.get("x-proxy-backend-role") ?? "",
    desiredProxyRole: response.headers.get("x-proxy-backend-desired-role") ?? "",
    bytes: Buffer.byteLength(text),
    body,
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function loginForMetrics() {
  if (!options.metricsOrigin) return null;
  const deviceUuid = `${runId}-metrics`;
  const response = await requestJson(options.metricsOrigin, "/api/auth/login", {
    method: "POST",
    body: {
      username: options.username,
      pin: options.pin,
      deviceUuid,
      clientApp: "mobile-frontend",
    },
  });
  const token = response.body?.token;
  const userId = response.body?.user?.id;
  if (!token || !userId) {
    throw new Error(`login metriche fallito: HTTP ${response.status}`);
  }
  return {
    token,
    userId,
    deviceUuid,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-User-Id": userId,
      "X-Device-Uuid": deviceUuid,
    },
  };
}

async function maybeResetMetrics(session) {
  if (!session || !options.resetMetrics) return null;
  return requestJson(options.metricsOrigin, "/api/monitor/runtime-metrics/reset", {
    method: "POST",
    headers: session.headers,
    body: {},
  });
}

async function readMetrics(session) {
  if (!session) return null;
  const response = await requestJson(options.metricsOrigin, "/api/monitor/runtime-metrics", {
    headers: session.headers,
  });
  return response.body?.runtimeMetrics ?? null;
}

async function probeLayout(index, phase) {
  const pathname = `/api/integration/layout?_layout_latency=${encodeURIComponent(runId)}_${phase}_${index}_${Date.now()}`;
  const startedAt = performance.now();
  try {
    const response = await requestJson(options.origin, pathname);
    const tables = Array.isArray(response.body?.tables) ? response.body.tables.length : null;
    return {
      index,
      phase,
      ok: response.ok,
      status: response.status,
      durationMs: round(response.durationMs),
      proxyRole: response.proxyRole,
      desiredProxyRole: response.desiredProxyRole,
      bytes: response.bytes,
      tables,
      version: response.body?.version ?? null,
    };
  } catch (error) {
    return {
      index,
      phase,
      ok: false,
      status: 0,
      durationMs: round(performance.now() - startedAt),
      proxyRole: "",
      desiredProxyRole: "",
      bytes: 0,
      tables: null,
      error: error?.message ?? String(error),
    };
  } finally {
    await delay(options.delayMs);
  }
}

function buildSummary(samples) {
  const tableCounts = samples
    .map((sample) => Number(sample.tables))
    .filter((value) => Number.isFinite(value));
  const bytes = samples
    .map((sample) => Number(sample.bytes))
    .filter((value) => Number.isFinite(value));
  const okCount = samples.filter((sample) => sample.ok).length;
  return {
    total: samples.length,
    ok: okCount,
    failed: samples.length - okCount,
    durations: summarizeDurations(samples),
    statuses: countBy(samples, (sample) => sample.status),
    proxyRoles: countBy(samples, (sample) => sample.proxyRole),
    desiredProxyRoles: countBy(samples, (sample) => sample.desiredProxyRole),
    tablesMin: tableCounts.length ? Math.min(...tableCounts) : null,
    tablesMax: tableCounts.length ? Math.max(...tableCounts) : null,
    bytesAvg: round(bytes.length ? bytes.reduce((total, value) => total + value, 0) / bytes.length : null),
  };
}

function markdownTable(rows, columns) {
  const header = `| ${columns.map((column) => column.title).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(column.value(row) ?? "")).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

async function writeReport(result) {
  const reportDir = path.join(options.reportRoot, runId);
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const counters = result.metricsAfter?.counters ?? {};
  const summary = result.summary;
  const lines = [
    "# Layout Latency Canary",
    "",
    `Run: \`${runId}\``,
    `Origin: \`${options.origin}\``,
    `Metrics origin: \`${options.metricsOrigin || "disabled"}\``,
    `Started: ${result.startedAtIso}`,
    `Finished: ${result.finishedAtIso}`,
    `Duration: ${result.durationMs} ms`,
    `Verdict: **${result.evaluation.passed ? "PASS" : "FAIL"}**`,
    "",
    "## Options",
    "",
    markdownTable([options], [
      { title: "Requests", value: (row) => row.requests },
      { title: "Warmup", value: (row) => row.warmup },
      { title: "Concurrency", value: (row) => row.concurrency },
      { title: "Delay ms", value: (row) => row.delayMs },
      { title: "Expected tables", value: (row) => row.expectedTables || "n.d." },
      { title: "Max p95 ms", value: (row) => row.maxP95Ms || "n.d." },
    ]),
    "",
    "## Summary",
    "",
    markdownTable([summary], [
      { title: "Total", value: (row) => row.total },
      { title: "OK", value: (row) => row.ok },
      { title: "Failed", value: (row) => row.failed },
      { title: "Avg", value: (row) => row.durations.avgMs },
      { title: "p50", value: (row) => row.durations.p50Ms },
      { title: "p95", value: (row) => row.durations.p95Ms },
      { title: "p99", value: (row) => row.durations.p99Ms },
      { title: "Max", value: (row) => row.durations.maxMs },
      { title: "Tables", value: (row) => `${row.tablesMin ?? "n.d."}-${row.tablesMax ?? "n.d."}` },
    ]),
    "",
    "## Runtime Counters",
    "",
    markdownTable([
      {
        applied: counters.integrationLayoutRelationalTablesApplied ?? 0,
        fallback: counters.integrationLayoutRelationalTablesFallback ?? 0,
        requests: counters.requests ?? 0,
        readDb: counters.readDb ?? 0,
      },
    ], [
      { title: "Relational applied", value: (row) => row.applied },
      { title: "Relational fallback", value: (row) => row.fallback },
      { title: "Requests", value: (row) => row.requests },
      { title: "readDb", value: (row) => row.readDb },
    ]),
    "",
    "## Proxy Roles",
    "",
    "```json",
    JSON.stringify(summary.proxyRoles, null, 2),
    "```",
    "",
  ];
  if (result.errors.length) {
    lines.push("## Errors", "");
    lines.push("```json");
    lines.push(JSON.stringify(result.errors.slice(0, 20), null, 2));
    lines.push("```", "");
  }
  await fs.writeFile(path.join(reportDir, "REPORT.md"), `${lines.join("\n")}\n`);
  return reportDir;
}

async function main() {
  console.log(`[layout-latency] run=${runId} origin=${options.origin} requests=${options.requests} concurrency=${options.concurrency}`);
  const startedAt = performance.now();
  const result = {
    runId,
    startedAtIso: new Date().toISOString(),
    options,
    warmupSamples: [],
    samples: [],
    errors: [],
    metricsBefore: null,
    metricsAfter: null,
    summary: null,
    evaluation: null,
  };

  const session = await loginForMetrics();
  await maybeResetMetrics(session);
  result.metricsBefore = await readMetrics(session);

  for (let index = 0; index < options.warmup; index += 1) {
    result.warmupSamples.push(await probeLayout(index, "warmup"));
  }

  const jobs = Array.from({ length: options.requests }, (_, index) => index);
  result.samples = await mapLimit(jobs, options.concurrency, (index) => probeLayout(index, "measure"));
  result.metricsAfter = await readMetrics(session);

  result.summary = buildSummary(result.samples);
  result.errors = result.samples.filter((sample) => !sample.ok || sample.status !== 200 || sample.tables === null);
  const tableShapeOk =
    options.expectedTables <= 0 ||
    (result.summary.tablesMin === options.expectedTables &&
      result.summary.tablesMax === options.expectedTables);
  const p95Ok =
    options.maxP95Ms <= 0 ||
    (Number.isFinite(Number(result.summary.durations.p95Ms)) &&
      Number(result.summary.durations.p95Ms) <= options.maxP95Ms);
  const fallbackCount =
    Number(result.metricsAfter?.counters?.integrationLayoutRelationalTablesFallback) || 0;
  result.evaluation = {
    passed: result.errors.length === 0 && tableShapeOk && p95Ok && fallbackCount === 0,
    tableShapeOk,
    p95Ok,
    fallbackOk: fallbackCount === 0,
  };
  result.finishedAtIso = new Date().toISOString();
  result.durationMs = round(performance.now() - startedAt);

  const reportDir = await writeReport(result);
  console.log(`[layout-latency] ${result.evaluation.passed ? "PASS" : "FAIL"} report=${reportDir}`);
  console.log(
    `[layout-latency] ok=${result.summary.ok}/${result.summary.total} p95=${result.summary.durations.p95Ms}ms p99=${result.summary.durations.p99Ms}ms applied=${result.metricsAfter?.counters?.integrationLayoutRelationalTablesApplied ?? 0} fallback=${result.metricsAfter?.counters?.integrationLayoutRelationalTablesFallback ?? 0}`,
  );
  if (!result.evaluation.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[layout-latency] errore", error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
