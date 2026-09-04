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
  return Math.max(min, Math.min(max, value));
}

const options = {
  frontendOrigin: envString("RSV_AUDIT_FRONTEND_ORIGIN", "https://127.0.0.1:5280").replace(/\/+$/, ""),
  username: envString("RSV_AUDIT_USERNAME", "amalia"),
  pin: envString("RSV_AUDIT_PIN", "182018"),
  devices: Math.trunc(envNumber("RSV_AUDIT_DEVICES", 25, { min: 1, max: 200 })),
  iterations: Math.trunc(envNumber("RSV_AUDIT_ITERATIONS", 1, { min: 1, max: 20 })),
  concurrency: Math.trunc(envNumber("RSV_AUDIT_CONCURRENCY", 12, { min: 1, max: 100 })),
  timeoutMs: Math.trunc(envNumber("RSV_AUDIT_TIMEOUT_MS", 20_000, { min: 1_000, max: 120_000 })),
  reportRoot: envString("RSV_AUDIT_REPORT_ROOT", path.join(cassaRoot, "reports")),
  insecureTls: String(process.env.RSV_AUDIT_INSECURE_TLS ?? "1") !== "0",
  failOnDirtyMissing: String(process.env.RSV_AUDIT_FAIL_ON_DIRTY_MISSING ?? "0") === "1",
};

if (options.insecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const runId = envString(
  "RSV_AUDIT_RUN_ID",
  `reservations_write_audit_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`,
);

function runIdOffsetDays() {
  let hash = 0;
  for (const char of runId) {
    hash = ((hash * 31) + char.charCodeAt(0)) % 997;
  }
  return 30 + (hash % 240);
}

function round(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function percentile(values, pct) {
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1));
  return round(sorted[index]);
}

function authPayload(session, deviceUuid, extra = {}) {
  return {
    token: session.token,
    userId: session.user?.id,
    username: session.user?.username,
    fullName: session.user?.fullName,
    deviceUuid,
    ...extra,
  };
}

function authHeaders(session, deviceUuid) {
  return {
    Authorization: `Bearer ${session.token}`,
    "X-User-Id": session.user?.id ?? "",
    "X-Device-Uuid": deviceUuid,
    "Content-Type": "application/json",
  };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = options.timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout HTTP ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(pathname, init = {}) {
  const startedAt = performance.now();
  const response = await fetchWithTimeout(`${options.frontendOrigin}${pathname}`, {
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
    pathname,
    method: init.method ?? "GET",
    status: response.status,
    ok: response.ok,
    durationMs: round(performance.now() - startedAt),
    proxyRole: response.headers.get("x-proxy-backend-role") ?? "",
    desiredProxyRole: response.headers.get("x-proxy-backend-desired-role") ?? "",
    body,
  };
}

async function login(deviceIndex) {
  const deviceUuid = `rsv-audit-mobile-${runId}-${deviceIndex}`;
  const result = await requestJson("/api/auth/login", {
    method: "POST",
    body: {
      username: options.username,
      pin: options.pin,
      deviceUuid,
      clientApp: "mobile-frontend",
    },
  });
  if (result.status !== 200 || !result.body?.token || !result.body?.user?.id) {
    throw new Error(`login failed for device ${deviceIndex}: ${result.status} ${result.body?.error ?? result.body?.code ?? ""}`);
  }
  return { ...result.body, deviceUuid };
}

async function runtimeMetrics(session, action = "snapshot") {
  const route = action === "reset" ? "/api/monitor/runtime-metrics/reset" : "/api/monitor/runtime-metrics";
  return requestJson(route, {
    method: action === "reset" ? "POST" : "GET",
    headers: authHeaders(session, session.deviceUuid),
    body: action === "reset" ? authPayload(session, session.deviceUuid) : undefined,
  });
}

function selectTables(layoutBody) {
  const tables = Array.isArray(layoutBody?.tables) ? layoutBody.tables : [];
  const usable = tables.filter((table) => {
    const id = String(table?.id ?? "").trim();
    const roomId = String(table?.roomId ?? "").trim();
    if (!id || !roomId) return false;
    if (roomId.toLowerCase().includes("attesa")) return false;
    const pending = Array.isArray(table?.pendingBills) ? table.pendingBills.length : 0;
    const amountDue = Number(table?.amountDue ?? table?.totalDue ?? 0) || 0;
    return pending <= 0 && amountDue <= 0.009;
  });
  return usable.length ? usable : tables.filter((table) => table?.id && table?.roomId);
}

function reservationSlot(deviceIndex, iteration, kind = 0) {
  const base = new Date();
  base.setDate(base.getDate() + runIdOffsetDays() + iteration + (kind * 7));
  base.setHours(18, 0, 0, 0);
  return base.getTime() + (deviceIndex * 180) * 60_000;
}

async function reservationRequest(session, type, pathname, payload) {
  const result = await requestJson(pathname, {
    method: "POST",
    headers: authHeaders(session, session.deviceUuid),
    body: authPayload(session, session.deviceUuid, payload),
  });
  return {
    type,
    status: result.status,
    ok: result.ok,
    durationMs: result.durationMs,
    code: result.body?.code ?? "",
    error: result.body?.error ?? "",
    body: result.body,
  };
}

async function createReservation(session, table, deviceIndex, iteration, kind = 0) {
  const reservationAt = reservationSlot(deviceIndex, iteration, kind);
  const serviceDate = localDateKey(reservationAt);
  const result = await reservationRequest(session, "reservation.create", "/api/pos/reservations/create", {
    roomId: table.roomId,
    serviceDate,
    reservationAt,
    customerName: `Audit Prenotazione ${deviceIndex}-${iteration}-${kind}`,
    customerPhone: `333${String(7000000 + deviceIndex * 100 + iteration * 10 + kind).slice(-7)}`,
    covers: 2 + ((deviceIndex + kind) % 4),
    assignedTableId: table.id,
    assignedTableIds: [table.id],
    note: `write audit ${runId}`,
  });
  const reservation = result.body?.reservation ?? null;
  return { result, reservation, roomId: table.roomId, serviceDate, reservationAt };
}

async function runReservationLifecycle(session, table, deviceIndex, iteration) {
  const records = [];
  const create = await createReservation(session, table, deviceIndex, iteration, 0);
  records.push(create.result);
  const reservationId = create.reservation?.id;
  if (create.result.status !== 200 || !reservationId) return records;

  records.push(await reservationRequest(session, "reservation.list", "/api/pos/reservations/list", {
    roomId: create.roomId,
    serviceDate: create.serviceDate,
  }));
  records.push(await reservationRequest(session, "reservation.availability", "/api/pos/reservations/availability", {
    roomId: create.roomId,
    serviceDate: create.serviceDate,
    reservationAt: create.reservationAt,
    reservationIdToIgnore: reservationId,
    tableIds: [table.id],
  }));

  const lock = await reservationRequest(session, "reservation.lock.acquire", "/api/pos/reservations/lock/acquire", {
    roomId: create.roomId,
    serviceDate: create.serviceDate,
    reservationId,
  });
  records.push(lock);
  const lockId = lock.body?.lock?.lockId ?? "";
  if (lock.status === 200 && lockId) {
    records.push(await reservationRequest(session, "reservation.update", "/api/pos/reservations/update", {
      roomId: create.roomId,
      serviceDate: create.serviceDate,
      reservationId,
      lockId,
      patch: {
        reservationAt: create.reservationAt + 30 * 60_000,
        customerName: `Audit Prenotazione aggiornata ${deviceIndex}-${iteration}`,
        customerPhone: `333${String(8000000 + deviceIndex * 100 + iteration).slice(-7)}`,
        covers: 3 + (deviceIndex % 3),
        intolerances: deviceIndex % 2 ? "senza glutine" : "",
        note: `write audit update ${runId}`,
        assignedTableId: table.id,
        assignedTableIds: [table.id],
      },
    }));
    records.push(await reservationRequest(session, "reservation.lock.release", "/api/pos/reservations/lock/release", {
      reservationId,
      lockId,
    }));
  }

  records.push(await reservationRequest(session, "reservation.status.cancelled", "/api/pos/reservations/status", {
    roomId: create.roomId,
    serviceDate: create.serviceDate,
    reservationId,
    action: "cancelled",
  }));

  const deletion = await createReservation(session, table, deviceIndex, iteration, 1);
  records.push({ ...deletion.result, type: "reservation.create.forDelete" });
  const deleteId = deletion.reservation?.id;
  if (deletion.result.status !== 200 || !deleteId) return records;
  const deleteLock = await reservationRequest(session, "reservation.lock.acquire.forDelete", "/api/pos/reservations/lock/acquire", {
    roomId: deletion.roomId,
    serviceDate: deletion.serviceDate,
    reservationId: deleteId,
  });
  records.push(deleteLock);
  const deleteLockId = deleteLock.body?.lock?.lockId ?? "";
  if (deleteLock.status === 200 && deleteLockId) {
    records.push(await reservationRequest(session, "reservation.delete", "/api/pos/reservations/delete", {
      roomId: deletion.roomId,
      serviceDate: deletion.serviceDate,
      reservationId: deleteId,
      lockId: deleteLockId,
    }));
  }
  return records;
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarizeRequests(records) {
  const groups = new Map();
  for (const record of records) {
    const type = String(record?.type ?? "unknown");
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(record);
  }
  return Object.fromEntries([...groups.entries()].map(([type, entries]) => {
    const durations = entries.map((entry) => entry.durationMs);
    return [type, {
      count: entries.length,
      ok: entries.filter((entry) => entry.status >= 200 && entry.status < 300).length,
      errors: entries.filter((entry) => !(entry.status >= 200 && entry.status < 300)).length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: round(Math.max(...durations.filter((value) => Number.isFinite(value)), 0)),
      statuses: entries.reduce((acc, entry) => {
        const key = String(entry.status ?? "unknown");
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    }];
  }));
}

function topReservationMetrics(map = {}, labelFilter = /reservation/i, limit = 12) {
  return Object.entries(map)
    .filter(([label, metric]) => labelFilter.test(label) && Number(metric?.count ?? 0) > 0)
    .map(([label, metric]) => ({
      label,
      count: Number(metric.count) || 0,
      avgMs: Number(metric.avg) || 0,
      p50Ms: Number(metric.p50) || 0,
      p95Ms: Number(metric.p95) || 0,
      p99Ms: Number(metric.p99) || 0,
      maxMs: round(metric.max),
      over: Number(metric.over) || 0,
    }))
    .sort((left, right) =>
      right.p95Ms - left.p95Ms ||
      right.maxMs - left.maxMs ||
      right.count - left.count ||
      left.label.localeCompare(right.label)
    )
    .slice(0, limit);
}

function summarizeMetrics(metrics) {
  const reservationLane = metrics?.queues?.reservationLane ?? {};
  const appState = metrics?.appState ?? {};
  const requests = metrics?.requests ?? {};
  const dirtyTracking = appState?.dirtyTracking ?? {};
  const appStateReservationWrites = topReservationMetrics(appState.writeRunMsByLabel);
  const reservationLaneWait = topReservationMetrics(reservationLane.waitMsByLabel, /.*/, 12);
  const reservationLaneRun = topReservationMetrics(reservationLane.runMsByLabel, /.*/, 12);
  const reservationRequests = topReservationMetrics(requests.runMsByRoute, /\/api\/(pos|public)\/reservations/i, 12);
  const dirtyMissing = topReservationMetrics(dirtyTracking.missingByLabel, /reservation/i, 12);
  const dirtyObservations = topReservationMetrics(dirtyTracking.observationsByLabel, /reservation/i, 12);
  const dirtySamples = Array.isArray(dirtyTracking.recentSamples)
    ? dirtyTracking.recentSamples
      .filter((sample) => /reservation/i.test(String(sample?.label ?? "")))
      .slice(-20)
    : [];
  const dirtyTrackingModes = [...new Set(dirtySamples.map((sample) => String(sample?.mode ?? "").trim()).filter(Boolean))];
  const fullStateFallbackSamples = dirtySamples.filter((sample) => sample?.fullStateFallbackUsed === true).length;
  return {
    enabled: metrics?.enabled === true,
    counters: metrics?.counters ?? {},
    gauges: metrics?.gauges ?? {},
    appStateReservationWrites,
    reservationLaneWait,
    reservationLaneRun,
    reservationRequests,
    dirtyMissing,
    dirtyObservations,
    dirtySamples,
    dirtyTrackingModes,
    fullStateFallbackSamples,
    globalAppStateWrite: appState.writeRunMs ?? null,
  };
}

function evaluate(records, metricsSummary) {
  const failedRequests = records
    .filter((record) => !(record.status >= 200 && record.status < 300))
    .map((record) => ({
      type: record.type,
      status: record.status,
      code: record.code,
      error: record.error,
      durationMs: record.durationMs,
    }));
  const maxLaneP95 = Math.max(
    0,
    ...metricsSummary.reservationLaneWait.map((entry) => Number(entry.p95Ms) || 0),
    ...metricsSummary.reservationLaneRun.map((entry) => Number(entry.p95Ms) || 0),
  );
  const maxAppStateP95 = Math.max(
    0,
    ...metricsSummary.appStateReservationWrites.map((entry) => Number(entry.p95Ms) || 0),
  );
  const missingDirtyLabels = metricsSummary.dirtyMissing.map((entry) => entry.label);
  const checks = {
    runtimeMetricsEnabled: metricsSummary.enabled === true,
    noFailedRequests: failedRequests.length === 0,
    noReservationDirtyTrackingMissing: !options.failOnDirtyMissing || missingDirtyLabels.length === 0,
    reservationLaneP95AtMost5s: maxLaneP95 <= 5_000,
    reservationAppStateP95Below5s: maxAppStateP95 < 5_000,
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => ok !== true)
    .map(([name]) => name);
  return {
    passed: failed.length === 0,
    checks,
    failed,
    failedRequests,
    maxLaneP95,
    maxAppStateP95,
    missingDirtyLabels,
    dirtyTrackingWarnings: {
      failOnDirtyMissing: options.failOnDirtyMissing,
      missingDirtyLabels,
      modes: metricsSummary.dirtyTrackingModes,
      fullStateFallbackSamples: metricsSummary.fullStateFallbackSamples,
    },
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
  const requestRows = Object.entries(result.requestSummary)
    .map(([type, value]) => ({ type, ...value }))
    .sort((left, right) => right.p95Ms - left.p95Ms || left.type.localeCompare(right.type));
  const metricColumns = [
    { title: "Label", value: (row) => row.label },
    { title: "Count", value: (row) => row.count },
    { title: "p95 ms", value: (row) => row.p95Ms },
    { title: "max ms", value: (row) => row.maxMs },
  ];
  const lines = [
    "# Reservations Write Audit Canary",
    "",
    `Run: \`${runId}\``,
    `Frontend: \`${options.frontendOrigin}\``,
    `Devices: ${options.devices}`,
    `Iterations: ${options.iterations}`,
    `Concurrency: ${options.concurrency}`,
    `Started: ${result.startedAtIso}`,
    `Finished: ${result.finishedAtIso}`,
    `Duration: ${result.durationMs} ms`,
    `Verdict: **${result.evaluation.passed ? "PASS" : "FAIL"}**`,
    "",
    "## Request Summary",
    "",
    markdownTable(requestRows, [
      { title: "Type", value: (row) => row.type },
      { title: "Count", value: (row) => row.count },
      { title: "OK", value: (row) => row.ok },
      { title: "Errors", value: (row) => row.errors },
      { title: "p95 ms", value: (row) => row.p95Ms },
      { title: "max ms", value: (row) => row.maxMs },
    ]),
    "",
    "## Reservation Lane Wait",
    "",
    result.metricsSummary.reservationLaneWait.length
      ? markdownTable(result.metricsSummary.reservationLaneWait, metricColumns)
      : "_Nessun campione reservationLane wait._",
    "",
    "## Reservation Lane Run",
    "",
    result.metricsSummary.reservationLaneRun.length
      ? markdownTable(result.metricsSummary.reservationLaneRun, metricColumns)
      : "_Nessun campione reservationLane run._",
    "",
    "## App-State Writes",
    "",
    result.metricsSummary.appStateReservationWrites.length
      ? markdownTable(result.metricsSummary.appStateReservationWrites, metricColumns)
      : "_Nessun write app-state reservation rilevato._",
    "",
    "## Dirty Tracking",
    "",
    `Missing labels: ${result.evaluation.missingDirtyLabels.length ? result.evaluation.missingDirtyLabels.join(", ") : "nessuno"}`,
    `Fail on missing: ${options.failOnDirtyMissing ? "si" : "no"}`,
    `Modes: ${result.metricsSummary.dirtyTrackingModes.length ? result.metricsSummary.dirtyTrackingModes.join(", ") : "n/a"}`,
    `Full-state fallback samples: ${result.metricsSummary.fullStateFallbackSamples}`,
    `Recent reservation samples: ${result.metricsSummary.dirtySamples.length}`,
    "",
  ];
  if (result.evaluation.failedRequests.length) {
    lines.push("## Failed Requests", "");
    lines.push(markdownTable(result.evaluation.failedRequests, [
      { title: "Type", value: (row) => row.type },
      { title: "Status", value: (row) => row.status },
      { title: "Code", value: (row) => row.code },
      { title: "Error", value: (row) => row.error },
      { title: "ms", value: (row) => row.durationMs },
    ]));
    lines.push("");
  }
  await fs.writeFile(path.join(reportDir, "REPORT.md"), `${lines.join("\n")}\n`);
  return reportDir;
}

async function main() {
  console.log(`[reservations-audit] run=${runId} frontend=${options.frontendOrigin} devices=${options.devices}`);
  const startedAt = performance.now();
  const result = {
    runId,
    startedAtIso: new Date().toISOString(),
    options: { ...options, pin: "***" },
  };

  const admin = await login("admin");
  result.adminUser = {
    id: admin.user?.id ?? "",
    username: admin.user?.username ?? "",
    role: admin.user?.role ?? admin.user?.roleLabel ?? "",
  };

  const reset = await runtimeMetrics(admin, "reset");
  result.metricsReset = {
    status: reset.status,
    ok: reset.status === 200,
    enabled: reset.body?.runtimeMetrics?.enabled === true,
  };

  const layout = await requestJson(`/api/integration/layout?_=${Date.now()}`);
  result.layout = {
    status: layout.status,
    tables: Array.isArray(layout.body?.tables) ? layout.body.tables.length : 0,
  };
  if (layout.status !== 200) {
    throw new Error(`layout unavailable: ${layout.status} ${layout.body?.error ?? layout.body?.code ?? ""}`);
  }
  const tables = selectTables(layout.body);
  if (!tables.length) throw new Error("no usable tables for reservation write audit");
  result.selectedTables = tables.slice(0, 12).map((table) => ({
    id: table.id,
    roomId: table.roomId,
    number: table.number,
    label: table.tableName ?? table.label ?? "",
  }));

  const sessions = await runPool(
    Array.from({ length: options.devices }, (_, index) => index),
    Math.min(options.concurrency, options.devices),
    async (deviceIndex) => login(deviceIndex),
  );
  result.login = {
    sessions: sessions.length,
  };

  const tasks = [];
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    for (let deviceIndex = 0; deviceIndex < sessions.length; deviceIndex += 1) {
      tasks.push({ session: sessions[deviceIndex], deviceIndex, iteration });
    }
  }

  const taskResults = await runPool(tasks, options.concurrency, async (task) => {
    const table = tables[(task.deviceIndex + task.iteration) % tables.length];
    try {
      return await runReservationLifecycle(task.session, table, task.deviceIndex, task.iteration);
    } catch (error) {
      return [{
        type: "reservation.lifecycle.exception",
        status: 0,
        ok: false,
        durationMs: 0,
        code: "EXCEPTION",
        error: error instanceof Error ? error.message : String(error),
      }];
    }
  });
  const records = taskResults.flat();
  const snapshot = await runtimeMetrics(admin, "snapshot");
  result.runtimeMetrics = {
    status: snapshot.status,
    ok: snapshot.status === 200,
  };
  result.requestSummary = summarizeRequests(records);
  result.metricsSummary = summarizeMetrics(snapshot.body?.runtimeMetrics ?? null);
  result.evaluation = evaluate(records, result.metricsSummary);
  result.finishedAtIso = new Date().toISOString();
  result.durationMs = round(performance.now() - startedAt);

  const reportDir = await writeReport(result);
  console.log(`[reservations-audit] ${result.evaluation.passed ? "PASS" : "FAIL"} report=${reportDir}`);
  if (!result.evaluation.passed) {
    console.log(`[reservations-audit] failed=${result.evaluation.failed.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[reservations-audit] errore: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
