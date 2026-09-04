import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(cassaRoot, "..");

const runId =
  process.env.STATION_LOAD_RUN_ID ||
  new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const baseUrl = String(process.env.STATION_LOAD_BASE_URL || "http://127.0.0.1:5281").replace(/\/+$/, "");
const devices = Math.max(1, Math.trunc(Number(process.env.STATION_LOAD_DEVICES || 25)));
const requestsPerDevice = Math.max(1, Math.trunc(Number(process.env.STATION_LOAD_REQUESTS_PER_DEVICE || 20)));
const doneHistoryLimit = Math.max(
  0,
  Math.trunc(Number(process.env.STATION_LOAD_DONE_HISTORY_LIMIT || 8)),
);
const stationNames = String(process.env.STATION_LOAD_STATIONS || "BAR PRINCIPALE,BAR SECONDARIA")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const username = String(process.env.STATION_LOAD_USERNAME || "amalia");
const pin = String(process.env.STATION_LOAD_PIN || "182018");
const outputDir = path.resolve(projectRoot, "logs", `station-scoped-load-${runId}-${devices}`);
const reportJsonPath = path.join(outputDir, "report.json");
const reportMdPath = path.join(outputDir, "REPORT.md");

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeLatencies(samples) {
  const values = samples.map((entry) => entry.ms).filter((value) => Number.isFinite(value));
  return {
    count: values.length,
    minMs: values.length ? Math.min(...values) : 0,
    maxMs: values.length ? Math.max(...values) : 0,
    avgMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
  };
}

function authHeaders(session, deviceUuid = "station-load-admin") {
  if (!session?.token || !session?.user?.id) return {};
  return {
    Authorization: `Bearer ${session.token}`,
    "X-User-Id": session.user.id,
    "X-Device-Uuid": deviceUuid,
    "Content-Type": "application/json",
  };
}

async function fetchJson(url, options = {}) {
  const timeoutMs = Math.max(1_000, Math.trunc(Number(options.timeoutMs || 10_000)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    return {
      ok: response.ok,
      status: response.status,
      body,
      ms: performance.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function login() {
  try {
    const result = await fetchJson(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        pin,
        deviceUuid: "station-load-admin",
        clientApp: "cassa-frontend",
      }),
    });
    if (!result.ok || !result.body?.token) return null;
    return result.body;
  } catch {
    return null;
  }
}

async function runtimeMetrics(session, action = "snapshot") {
  if (!session?.token) return null;
  const route = action === "reset" ? "/api/monitor/runtime-metrics/reset" : "/api/monitor/runtime-metrics";
  const method = action === "reset" ? "POST" : "GET";
  try {
    const result = await fetchJson(`${baseUrl}${route}`, {
      method,
      headers: authHeaders(session),
      body: method === "POST" ? JSON.stringify({}) : undefined,
    });
    return {
      ok: result.ok,
      status: result.status,
      body: result.body,
      runtimeMetrics: result.body?.runtimeMetrics ?? null,
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function counterDelta(after, before, name) {
  return Number(after?.counters?.[name] || 0) - Number(before?.counters?.[name] || 0);
}

function buildStationUrl(station, deviceIndex, iteration) {
  const params = new URLSearchParams({
    station,
    includeDone: "1",
    includeTransferred: "1",
    doneHistoryLimit: String(doneHistoryLimit),
    deviceUuid: `station-load-${deviceIndex}`,
    _: `${Date.now()}-${deviceIndex}-${iteration}`,
  });
  return `${baseUrl}/api/integration/orders?${params.toString()}`;
}

async function runWorker(deviceIndex, samples, errors) {
  for (let iteration = 0; iteration < requestsPerDevice; iteration += 1) {
    const station = stationNames[deviceIndex % stationNames.length] || "BAR PRINCIPALE";
    const startedAt = performance.now();
    try {
      const result = await fetchJson(buildStationUrl(station, deviceIndex, iteration), {
        method: "GET",
        headers: { "X-Client-App": "postazione" },
        timeoutMs: 15_000,
      });
      samples.push({
        deviceIndex,
        iteration,
        station,
        status: result.status,
        ok: result.ok && result.body?.ok === true,
        count: Array.isArray(result.body?.orders) ? result.body.orders.length : null,
        ms: result.ms,
      });
      if (!result.ok || result.body?.ok !== true) {
        errors.push({ deviceIndex, iteration, station, status: result.status, body: result.body });
      }
    } catch (error) {
      errors.push({ deviceIndex, iteration, station, error: error?.message || String(error) });
      samples.push({ deviceIndex, iteration, station, status: 0, ok: false, ms: performance.now() - startedAt });
    }
  }
}

function pickQueueSummary(metrics) {
  const last = metrics?.queues?.lastSample ?? null;
  return {
    lastSample: last,
    orderLaneWaitLabels: Object.keys(metrics?.queues?.orderLane?.waitMsByLabel ?? {}),
    orderLaneRunLabels: Object.keys(metrics?.queues?.orderLane?.runMsByLabel ?? {}),
  };
}

function formatNumber(value) {
  return Number(value || 0).toFixed(1);
}

function buildMarkdown(report) {
  const lines = [];
  lines.push(`# Station Scoped Orders Load - ${report.devices} device`);
  lines.push("");
  lines.push(`- Run ID: ${report.runId}`);
  lines.push(`- Base URL: ${report.baseUrl}`);
  lines.push(`- Stazioni: ${report.stationNames.join(", ")}`);
  lines.push(`- Storico consegnate per postazione: ${report.doneHistoryLimit}`);
  lines.push(`- Richieste: ${report.totalRequests}`);
  lines.push(`- Errori: ${report.errors.length}`);
  lines.push("");
  lines.push("## Latenza");
  lines.push("");
  lines.push(`- p50: ${formatNumber(report.latency.p50Ms)} ms`);
  lines.push(`- p95: ${formatNumber(report.latency.p95Ms)} ms`);
  lines.push(`- p99: ${formatNumber(report.latency.p99Ms)} ms`);
  lines.push(`- max: ${formatNumber(report.latency.maxMs)} ms`);
  lines.push("");
  lines.push("## Runtime Metrics Delta");
  lines.push("");
  lines.push(`- requests: ${report.metricsDelta.requests}`);
  lines.push(`- readDb: ${report.metricsDelta.readDb}`);
  lines.push(`- writeDb: ${report.metricsDelta.writeDb}`);
  lines.push(`- orderLaneEnqueued: ${report.metricsDelta.orderLaneEnqueued}`);
  lines.push(`- dbMutationEnqueued: ${report.metricsDelta.dbMutationEnqueued}`);
  lines.push("");
  lines.push("## Queue Last Sample");
  lines.push("");
  lines.push(`- orderLaneDepth: ${report.queueSummary.lastSample?.orderLaneDepth ?? "n/a"}`);
  lines.push(`- orderLaneRunning: ${report.queueSummary.lastSample?.orderLaneRunning ?? "n/a"}`);
  lines.push(`- dbDepth: ${report.queueSummary.lastSample?.dbDepth ?? "n/a"}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

await fs.mkdir(outputDir, { recursive: true });
const session = await login();
const reset = await runtimeMetrics(session, "reset");
const before = reset?.runtimeMetrics ?? (await runtimeMetrics(session, "snapshot"))?.runtimeMetrics ?? null;
const samples = [];
const errors = [];
const startedAtMs = Date.now();

await Promise.all(Array.from({ length: devices }, (_, index) => runWorker(index, samples, errors)));

const after = (await runtimeMetrics(session, "snapshot"))?.runtimeMetrics ?? null;
const latency = summarizeLatencies(samples);
const report = {
  runId,
  baseUrl,
  devices,
  requestsPerDevice,
  totalRequests: devices * requestsPerDevice,
  stationNames,
  doneHistoryLimit,
  startedAtMs,
  endedAtMs: Date.now(),
  durationMs: Date.now() - startedAtMs,
  loginOk: Boolean(session?.token),
  resetOk: reset?.ok === true,
  latency,
  statusCounts: samples.reduce((acc, entry) => {
    const key = String(entry.status ?? 0);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {}),
  errors: errors.slice(0, 50),
  metricsDelta: {
    requests: counterDelta(after, before, "requests"),
    readDb: counterDelta(after, before, "readDb"),
    writeDb: counterDelta(after, before, "writeDb"),
    orderLaneEnqueued: counterDelta(after, before, "orderLaneEnqueued"),
    dbMutationEnqueued: counterDelta(after, before, "dbMutationEnqueued"),
  },
  queueSummary: pickQueueSummary(after),
  metricsAvailable: Boolean(after),
};

await fs.writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(reportMdPath, buildMarkdown(report), "utf8");
console.log(JSON.stringify({
  reportJsonPath,
  reportMdPath,
  devices: report.devices,
  totalRequests: report.totalRequests,
  errors: report.errors.length,
  latency: report.latency,
  metricsDelta: report.metricsDelta,
}, null, 2));
