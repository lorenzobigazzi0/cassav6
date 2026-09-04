import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(cassaRoot, "..");

function envString(name, fallback = "") {
  const value = String(process.env[name] ?? "").trim();
  return value || fallback;
}

function envNumber(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(String(process.env[name] ?? ""), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function envList(name) {
  return String(process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const options = {
  frontendOrigin: envString("CANARY_FRONTEND_ORIGIN", "https://127.0.0.1:5280").replace(/\/+$/, ""),
  username: envString("CANARY_USERNAME", "lorenzo"),
  pin: envString("CANARY_PIN", "1234"),
  iterations: envNumber("ORDER_E2E_BATCH_ITERATIONS", 12, { min: 1, max: 200 }),
  concurrency: envNumber("ORDER_E2E_BATCH_CONCURRENCY", 1, { min: 1, max: 16 }),
  reportRoot: envString("ORDER_E2E_BATCH_REPORT_ROOT", path.join(repoRoot, "logs")),
  childReportRoot: envString("ORDER_E2E_BATCH_CHILD_REPORT_ROOT", ""),
  tableIds: envList("ORDER_E2E_BATCH_TABLE_IDS"),
  activeStations: envList("ORDER_E2E_BATCH_ACTIVE_STATIONS"),
  stationHeartbeatMs: envNumber("ORDER_E2E_BATCH_STATION_HEARTBEAT_MS", 30_000, { min: 5_000, max: 120_000 }),
  stationCleanupRetries: envNumber("ORDER_E2E_BATCH_STATION_CLEANUP_RETRIES", 5, { min: 1, max: 20 }),
  timeoutMs: envNumber("ORDER_E2E_BATCH_CHILD_TIMEOUT_MS", 120_000, {
    min: 5_000,
    max: 600_000,
  }),
};

if (String(process.env.CANARY_INSECURE_TLS ?? "1") !== "0") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const runId = envString(
  "ORDER_E2E_BATCH_RUN_ID",
  `order_worker_sync_batch_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`,
);

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

function summarize(values) {
  const clean = values.map(Number).filter((value) => Number.isFinite(value));
  const sum = clean.reduce((total, value) => total + value, 0);
  return {
    count: clean.length,
    avgMs: round(clean.length ? sum / clean.length : null),
    p50Ms: round(percentile(clean, 0.5)),
    p95Ms: round(percentile(clean, 0.95)),
    p99Ms: round(percentile(clean, 0.99)),
    minMs: round(clean.length ? Math.min(...clean) : null),
    maxMs: round(clean.length ? Math.max(...clean) : null),
  };
}

function countBy(values) {
  return values.reduce((accumulator, value) => {
    const key = String(value ?? "") || "none";
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

function lastLines(text, limit = 20) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(pathname, init = {}, timeoutMs = options.timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout HTTP ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(`${options.frontendOrigin}${pathname}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { parseError: true, text: text.slice(0, 500) };
    }
    return { status: response.status, ok: response.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

async function loginStation(station, index) {
  const deviceUuid = `${runId}-station-${String(index + 1).padStart(2, "0")}`;
  const login = await requestJson("/api/auth/login", {
    method: "POST",
    body: { username: options.username, pin: options.pin, clientApp: "postazione", deviceUuid },
  });
  if (login.status !== 200 || !login.body?.token || !login.body?.user?.id) {
    throw new Error(`login postazione ${station} fallito: ${login.status} ${login.body?.error ?? ""}`);
  }
  return { station, deviceUuid, session: login.body };
}

function stationStatePayload(entry, active = true) {
  const user = entry.session.user ?? {};
  return {
    token: entry.session.token,
    userId: user.id,
    username: user.username,
    station: entry.station,
    stationName: entry.station,
    active,
    clientApp: "postazione",
    deviceUuid: entry.deviceUuid,
    autoPrintOrders: false,
    autoPrintPreconto: false,
    operatorUserId: user.id,
    operatorUsername: user.username,
    operatorName: user.fullName ?? user.username ?? "Canary station",
    operatorRole: user.roleLabel ?? user.role ?? "Operatore",
  };
}

async function postStationHeartbeat(entry, active = true) {
  const result = await requestJson("/api/integration/stations/state", {
    method: "POST",
    body: stationStatePayload(entry, active),
  });
  return { station: entry.station, deviceUuid: entry.deviceUuid, active, status: result.status, ok: result.ok, error: result.body?.error ?? "" };
}

async function logoutStation(entry) {
  const user = entry.session.user ?? {};
  const result = await requestJson("/api/auth/logout", {
    method: "POST",
    body: {
      token: entry.session.token,
      userId: user.id,
      username: user.username,
      clientApp: "postazione",
      deviceUuid: entry.deviceUuid,
    },
  });
  return { station: entry.station, deviceUuid: entry.deviceUuid, status: result.status, ok: result.ok, error: result.body?.error ?? "" };
}

async function fetchActiveStations() {
  const result = await requestJson(`/api/integration/stations/active?_=${Date.now()}`);
  return Array.isArray(result.body?.stations) ? result.body.stations : [];
}

function ownActiveStations(activeStations, entries) {
  const devices = new Set(entries.map((entry) => entry.deviceUuid));
  return activeStations.filter((station) => devices.has(String(station?.deviceUuid ?? "").trim()));
}

async function startStationHarness() {
  if (options.activeStations.length === 0) {
    return { preflight: { enabled: false, stations: [] }, stop: async () => ({ enabled: false, stations: [] }) };
  }
  const entries = [];
  const activated = [];
  for (const [index, station] of options.activeStations.entries()) {
    const entry = await loginStation(station, index);
    entries.push(entry);
    const heartbeat = await postStationHeartbeat(entry, true);
    if (!heartbeat.ok) throw new Error(`heartbeat postazione ${station} fallito: ${heartbeat.status} ${heartbeat.error}`);
    activated.push(heartbeat);
  }
  const timer = setInterval(() => {
    for (const entry of entries) postStationHeartbeat(entry, true).catch(() => {});
  }, options.stationHeartbeatMs);
  timer.unref?.();
  return {
    preflight: { enabled: true, heartbeatMs: options.stationHeartbeatMs, stations: activated },
    async stop() {
      clearInterval(timer);
      const attempts = [];
      for (let attempt = 1; attempt <= options.stationCleanupRetries; attempt += 1) {
        const stations = [];
        const logouts = [];
        for (const entry of entries) {
          try {
            stations.push(await postStationHeartbeat(entry, false));
          } catch (error) {
            stations.push({ station: entry.station, deviceUuid: entry.deviceUuid, active: false, status: 0, ok: false, error: error?.message ?? String(error) });
          }
          if (attempt === 1) {
            try {
              logouts.push(await logoutStation(entry));
            } catch (error) {
              logouts.push({ station: entry.station, deviceUuid: entry.deviceUuid, status: 0, ok: false, error: error?.message ?? String(error) });
            }
          }
        }
        await sleep(500 * attempt);
        const stillActive = ownActiveStations(await fetchActiveStations(), entries);
        attempts.push({ attempt, stations, logouts, stillActive: stillActive.map((entry) => ({ station: entry.station, deviceUuid: entry.deviceUuid })) });
        if (stillActive.length === 0) return { enabled: true, verified: true, attempts };
      }
      return { enabled: true, verified: false, attempts };
    },
  };
}

function runChild(index, childRunId, childReportRoot) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const env = {
      ...process.env,
      CANARY_RUN_ID: childRunId,
      CANARY_REPORT_ROOT: childReportRoot,
      CANARY_MOBILE_DEVICE_UUID: `${childRunId}-mobile`,
      CANARY_STATION_DEVICE_UUID: `${childRunId}-station`,
      PRINTING_ENABLED: String(process.env.PRINTING_ENABLED ?? "0"),
    };
    if (options.tableIds.length > 0) {
      env.CANARY_TABLE_ID = options.tableIds[(index - 1) % options.tableIds.length];
    }
    if (options.activeStations.length > 0) {
      env.CANARY_STATION = options.activeStations[(index - 1) % options.activeStations.length];
    }
    const child = spawn(process.execPath, [path.join(scriptDir, "order-worker-sync-e2e-canary.mjs")], {
      cwd: cassaRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2_000).unref();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      const reportDir = path.join(childReportRoot, `order-worker-sync-e2e-canary-${childRunId}`);
      let result = null;
      try {
        result = JSON.parse(await fs.readFile(path.join(reportDir, "result.json"), "utf8"));
      } catch (error) {
        result = { error: `result read failed: ${error?.message ?? String(error)}` };
      }
      resolve({
        index,
        childRunId,
        code,
        signal,
        durationMs: round(performance.now() - startedAt),
        reportDir,
        stdoutTail: lastLines(stdout),
        stderrTail: lastLines(stderr),
        result,
      });
    });
  });
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

function extractRunSummary(run) {
  const result = run.result ?? {};
  return {
    index: run.index,
    childRunId: run.childRunId,
    exitCode: run.code,
    signal: run.signal ?? "",
    reportDir: run.reportDir,
    error: result.error ?? "",
    tableId: result.table?.id ?? "",
    createStatus: result.create?.status ?? null,
    createRole: result.create?.proxyRole ?? "",
    createMs: result.create?.durationMs ?? null,
    syncStatus: result.sync?.status ?? null,
    syncRole: result.sync?.proxyRole ?? "",
    syncMs: result.sync?.durationMs ?? null,
    readbackStatus: result.readback?.status ?? null,
    readbackRole: result.readback?.proxyRole ?? "",
    readbackMs: result.readback?.durationMs ?? null,
    cleanupStatus: result.cleanup?.status ?? null,
    cleanupRole: result.cleanup?.proxyRole ?? "",
    cleanupMs: result.cleanup?.durationMs ?? null,
    readbackAttempts: result.readbackAttempts ?? null,
    workflow: result.syncedWorkflowStatus ?? "",
    routeOk:
      result.createRoutedAsExpected === true &&
      result.syncRoutedAsExpected === true &&
      result.cleanupRoutedAsExpected === true,
    workflowOk: result.syncWorkflowOk === true && result.readbackWorkflowOk === true,
    cleanupOk: result.cleanupGateOk === true,
  };
}

function markdownTable(rows, columns) {
  const header = `| ${columns.map((column) => column.title).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(column.value(row) ?? "")).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

async function writeReport(reportDir, result) {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const lines = [
    `# Order Worker Sync E2E Batch ${runId}`,
    "",
    `Started: ${result.startedAtIso}`,
    `Finished: ${result.finishedAtIso}`,
    `Duration: ${result.durationMs} ms`,
    `Verdict: **${result.evaluation.passed ? "PASS" : "FAIL"}**`,
    "",
    "## Summary",
    "",
    markdownTable([result.summary], [
      { title: "Runs", value: (row) => row.total },
      { title: "OK", value: (row) => row.ok },
      { title: "Failed", value: (row) => row.failed },
      { title: "Create p95", value: (row) => row.create.p95Ms },
      { title: "Sync p95", value: (row) => row.sync.p95Ms },
      { title: "Cleanup p95", value: (row) => row.cleanup.p95Ms },
      { title: "Readback p95", value: (row) => row.readback.p95Ms },
    ]),
    "",
    "## Roles",
    "",
    "```json",
    JSON.stringify(result.roles, null, 2),
    "```",
    "",
    "## Station Harness",
    "",
    "```json",
    JSON.stringify(result.stationHarness, null, 2),
    "```",
    "",
    "## Durations",
    "",
    markdownTable([
      { label: "create", ...result.summary.create },
      { label: "sync", ...result.summary.sync },
      { label: "readback", ...result.summary.readback },
      { label: "cleanup", ...result.summary.cleanup },
    ], [
      { title: "Step", value: (row) => row.label },
      { title: "Count", value: (row) => row.count },
      { title: "Avg", value: (row) => row.avgMs },
      { title: "p50", value: (row) => row.p50Ms },
      { title: "p95", value: (row) => row.p95Ms },
      { title: "p99", value: (row) => row.p99Ms },
      { title: "Max", value: (row) => row.maxMs },
    ]),
    "",
  ];
  if (result.failedRuns.length) {
    lines.push("## Failed Runs", "");
    lines.push(markdownTable(result.failedRuns, [
      { title: "Index", value: (row) => row.index },
      { title: "Run", value: (row) => row.childRunId },
      { title: "Error", value: (row) => row.error || `exit ${row.exitCode}` },
    ]));
    lines.push("");
  }
  await fs.writeFile(path.join(reportDir, "REPORT.md"), `${lines.join("\n")}\n`);
}

async function main() {
  const startedAt = performance.now();
  const reportDir = path.join(options.reportRoot, `order-worker-sync-e2e-batch-${runId}`);
  const childReportRoot = options.childReportRoot || path.join(reportDir, "runs");
  console.log(`[order-e2e-batch] run=${runId} iterations=${options.iterations} concurrency=${options.concurrency}`);
  const stationHarness = await startStationHarness();
  let stationCleanup = { enabled: false, stations: [] };
  const jobs = Array.from({ length: options.iterations }, (_, index) => index);
  const runs = await mapLimit(jobs, options.concurrency, (index) => {
    const childRunId = `${runId}_${String(index + 1).padStart(3, "0")}`;
    return runChild(index + 1, childRunId, childReportRoot);
  }).finally(async () => {
    stationCleanup = await stationHarness.stop();
  });
  const rows = runs.map(extractRunSummary);
  const okRows = rows.filter(
    (row) =>
      row.exitCode === 0 &&
      !row.error &&
      row.createStatus === 200 &&
      row.syncStatus === 200 &&
      row.cleanupStatus === 200 &&
      row.routeOk &&
      row.workflowOk &&
      row.cleanupOk,
  );
  const summary = {
    total: rows.length,
    ok: okRows.length,
    failed: rows.length - okRows.length,
    create: summarize(rows.map((row) => row.createMs)),
    sync: summarize(rows.map((row) => row.syncMs)),
    readback: summarize(rows.map((row) => row.readbackMs)),
    cleanup: summarize(rows.map((row) => row.cleanupMs)),
  };
  const result = {
    runId,
    startedAtIso: new Date(Date.now() - Math.round(performance.now() - startedAt)).toISOString(),
    finishedAtIso: new Date().toISOString(),
    durationMs: round(performance.now() - startedAt),
    options,
    stationHarness: { preflight: stationHarness.preflight, cleanup: stationCleanup },
    childReportRoot,
    rows,
    failedRuns: rows.filter((row) => !okRows.includes(row)),
    summary,
    roles: {
      create: countBy(rows.map((row) => row.createRole)),
      sync: countBy(rows.map((row) => row.syncRole)),
      cleanup: countBy(rows.map((row) => row.cleanupRole)),
      readback: countBy(rows.map((row) => row.readbackRole)),
    },
    evaluation: {
      passed: okRows.length === rows.length,
    },
  };
  await writeReport(reportDir, result);
  console.log(`[order-e2e-batch] ${result.evaluation.passed ? "PASS" : "FAIL"} report=${reportDir}`);
  console.log(
    `[order-e2e-batch] ok=${summary.ok}/${summary.total} createP95=${summary.create.p95Ms}ms syncP95=${summary.sync.p95Ms}ms cleanupP95=${summary.cleanup.p95Ms}ms`,
  );
  if (!result.evaluation.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[order-e2e-batch] errore", error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
