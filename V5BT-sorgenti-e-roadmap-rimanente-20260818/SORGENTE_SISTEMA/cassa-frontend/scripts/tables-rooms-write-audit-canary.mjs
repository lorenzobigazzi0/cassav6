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
  frontendOrigin: envString("ROOM_AUDIT_FRONTEND_ORIGIN", "https://127.0.0.1:5280").replace(/\/+$/, ""),
  managerUsername: envString("ROOM_AUDIT_MANAGER_USERNAME", "amalia"),
  managerPin: envString("ROOM_AUDIT_MANAGER_PIN", "182018"),
  requesterUsername: envString("ROOM_AUDIT_REQUESTER_USERNAME", "lorenzo"),
  requesterPin: envString("ROOM_AUDIT_REQUESTER_PIN", "1234"),
  devices: Math.trunc(envNumber("ROOM_AUDIT_DEVICES", 25, { min: 1, max: 200 })),
  concurrency: Math.trunc(envNumber("ROOM_AUDIT_CONCURRENCY", 10, { min: 1, max: 80 })),
  timeoutMs: Math.trunc(envNumber("ROOM_AUDIT_TIMEOUT_MS", 20_000, { min: 1_000, max: 120_000 })),
  reportRoot: envString("ROOM_AUDIT_REPORT_ROOT", path.join(cassaRoot, "reports")),
  insecureTls: String(process.env.ROOM_AUDIT_INSECURE_TLS ?? "1") !== "0",
  failOnDirtyMissing: String(process.env.ROOM_AUDIT_FAIL_ON_DIRTY_MISSING ?? "0") === "1",
};

if (options.insecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const runId = envString(
  "ROOM_AUDIT_RUN_ID",
  `tables_rooms_write_audit_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`,
);

function round(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
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
    body,
  };
}

async function login(username, pin, deviceUuid, clientApp = "mobile-frontend") {
  const result = await requestJson("/api/auth/login", {
    method: "POST",
    body: { username, pin, deviceUuid, clientApp },
  });
  if (result.status !== 200 || !result.body?.token || !result.body?.user?.id) {
    throw new Error(`login failed ${username}: ${result.status} ${result.body?.error ?? result.body?.code ?? ""}`);
  }
  return { ...result.body, deviceUuid };
}

async function maybeLogin(username, pin, deviceUuid) {
  try {
    return await login(username, pin, deviceUuid);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function runtimeMetrics(session, action = "snapshot") {
  const route = action === "reset" ? "/api/monitor/runtime-metrics/reset" : "/api/monitor/runtime-metrics";
  return requestJson(route, {
    method: action === "reset" ? "POST" : "GET",
    headers: authHeaders(session, session.deviceUuid),
    body: action === "reset" ? authPayload(session, session.deviceUuid) : undefined,
  });
}

async function apiPost(session, type, pathname, payload = {}, { allow = [] } = {}) {
  const result = await requestJson(pathname, {
    method: "POST",
    headers: authHeaders(session, session.deviceUuid),
    body: authPayload(session, session.deviceUuid, payload),
  });
  const allowed = result.status >= 200 && result.status < 300 || allow.includes(result.status);
  return {
    type,
    status: result.status,
    ok: allowed,
    durationMs: result.durationMs,
    code: result.body?.code ?? "",
    error: result.body?.error ?? "",
    body: result.body,
  };
}

async function apiGet(session, type, pathname) {
  const result = await requestJson(pathname, {
    method: "GET",
    headers: authHeaders(session, session.deviceUuid),
  });
  return {
    type,
    status: result.status,
    ok: result.status >= 200 && result.status < 300,
    durationMs: result.durationMs,
    code: result.body?.code ?? "",
    error: result.body?.error ?? "",
    body: result.body,
  };
}

function isFreeTable(table) {
  const pending = Array.isArray(table?.pendingBills) ? table.pendingBills.length : 0;
  const amountDue = Number(table?.amountDue ?? table?.totalDue ?? table?.dueAmount ?? 0) || 0;
  const orders = Number(table?.ordersInProgress ?? 0) || 0;
  const occupancy = String(table?.occupancyState ?? table?.status ?? "").trim().toLowerCase();
  return pending <= 0 && amountDue <= 0.009 && orders <= 0 && (!occupancy || ["free", "libero", "available"].includes(occupancy));
}

function selectUsableTables(layoutBody) {
  const tables = Array.isArray(layoutBody?.tables) ? layoutBody.tables : [];
  const nonVirtualTables = tables
    .filter((table) => table?.id && table?.roomId && !String(table.roomId).toLowerCase().includes("attesa"))
    .filter((table) => !String(table.id).toLowerCase().includes("attesa"));
  const usable = nonVirtualTables
    .filter(isFreeTable);
  return usable.length >= 2 ? usable : nonVirtualTables;
}

function findCrossRoomPair(tables, index = 0) {
  const source = tables[index % tables.length];
  const target = tables.find((table, offset) => offset !== index % tables.length && String(table.roomId) !== String(source.roomId));
  return target ? { source, target } : null;
}

function findSameRoomPair(tables, index = 0) {
  const source = tables[index % tables.length];
  const target = tables.find((table, offset) => offset !== index % tables.length && String(table.roomId) === String(source.roomId));
  return target ? { source, target } : null;
}

function groupTablesByRoom(tables) {
  const groups = new Map();
  for (const table of tables) {
    const roomId = String(table?.roomId ?? "").trim();
    if (!roomId) continue;
    if (!groups.has(roomId)) groups.set(roomId, []);
    groups.get(roomId).push(table);
  }
  return groups;
}

function buildSameRoomPairs(tables, limit) {
  const pairs = [];
  for (const group of groupTablesByRoom(tables).values()) {
    for (let index = 0; index + 1 < group.length && pairs.length < limit; index += 2) {
      pairs.push({ source: group[index], target: group[index + 1] });
    }
    if (pairs.length >= limit) break;
  }
  return pairs;
}

function buildCrossRoomPairs(tables, limit) {
  const pairs = [];
  const used = new Set();
  for (const source of tables) {
    if (pairs.length >= limit) break;
    if (used.has(source.id)) continue;
    const target = tables.find((candidate) =>
      !used.has(candidate.id) &&
      String(candidate.id) !== String(source.id) &&
      String(candidate.roomId) !== String(source.roomId)
    );
    if (!target) continue;
    used.add(source.id);
    used.add(target.id);
    pairs.push({ source, target });
  }
  return pairs;
}

async function lockTable(session, table, purpose) {
  return apiPost(session, `lock.${purpose}`, "/api/tables/lock/acquire", {
    tableId: table.id,
    roomId: table.roomId,
    purpose,
  });
}

async function heartbeatTable(session, table, purpose) {
  return apiPost(session, `lock.heartbeat.${purpose}`, "/api/tables/lock/heartbeat", {
    tableId: table.id,
    roomId: table.roomId,
    purpose,
  });
}

async function releaseTable(session, table) {
  return apiPost(session, "lock.release", "/api/tables/lock/release", {
    tableId: table.id,
    roomId: table.roomId,
  }, { allow: [403, 404] });
}

async function syncTable(session, table, status, note) {
  return apiPost(session, `table.sync.${status}`, "/api/integration/layout/table/sync", {
    tableId: table.id,
    roomId: table.roomId,
    tableNumber: table.number,
    occupancyState: status,
    status,
    covers: status === "free" ? 0 : 2,
    note,
  });
}

async function runSyncWithLock(session, table, status, note, { heartbeat = false } = {}) {
  const records = [];
  const lock = await lockTable(session, table, "table.sync");
  records.push(lock);
  if (lock.status === 200) {
    if (heartbeat) records.push(await heartbeatTable(session, table, "table.sync"));
    records.push(await syncTable(session, table, status, note));
    records.push(await releaseTable(session, table));
  }
  return records;
}

async function runLockSyncLifecycle(session, table, index) {
  return runSyncWithLock(session, table, "free", `audit rooms ${runId} ${index}`, { heartbeat: true });
}

async function runTableMoveLifecycle(session, pair, index) {
  const records = [];
  records.push(...await runSyncWithLock(session, pair.source, "free", ""));
  records.push(...await runSyncWithLock(session, pair.target, "free", ""));
  if (records.some((record) => record.ok !== true)) return records;
  records.push(...await runSyncWithLock(session, pair.source, "seated", `audit move source ${runId} ${index}`));
  if (records.some((record) => record.ok !== true)) return records;

  const sourceLock = await lockTable(session, pair.source, "table.move_source");
  const targetLock = await lockTable(session, pair.target, "table.move_target");
  records.push(sourceLock, targetLock);
  if (sourceLock.status !== 200 || targetLock.status !== 200) {
    if (sourceLock.status === 200) records.push(await releaseTable(session, pair.source));
    if (targetLock.status === 200) records.push(await releaseTable(session, pair.target));
    return records;
  }
  let moved = false;
  try {
    const move = await apiPost(session, "table.move", "/api/integration/layout/table/move", {
      fromTableId: pair.source.id,
      toTableId: pair.target.id,
      roomId: pair.source.roomId,
      targetRoomId: pair.target.roomId,
    });
    records.push(move);
    moved = move.status === 200;
  } finally {
    records.push(await releaseTable(session, pair.source));
    records.push(await releaseTable(session, pair.target));
  }
  records.push(...await runSyncWithLock(session, pair.target, "free", ""));
  records.push(...await runSyncWithLock(session, pair.source, "free", ""));
  return records;
}

async function runRoomChangeLifecycle(requester, manager, targetRoomId, index) {
  const records = [];
  const requested = await apiPost(requester, "room.change.request", "/api/pos/room-change/request", { targetRoomId });
  records.push(requested);
  if (requested.body?.status === "pending" && requested.body?.requestId) {
    records.push(await apiPost(manager, index % 2 === 0 ? "room.change.approve" : "room.change.cancel", index % 2 === 0 ? "/api/pos/room-change/approve" : "/api/pos/room-change/cancel", {
      requestId: requested.body.requestId,
      approverUsername: options.managerUsername,
      approverPin: options.managerPin,
    }));
  }
  return records;
}

async function runTableRoomMoveLifecycle(requester, manager, pair, index) {
  const records = [];
  const requested = await apiPost(requester, "table.room_move.request", "/api/integration/layout/table/room-move/request", {
    fromRoomId: pair.source.roomId,
    fromRoomName: pair.source.roomName ?? pair.source.roomId,
    targetRoomId: pair.target.roomId,
    fromTableId: pair.source.id,
    fromTableLabel: String(pair.source.number ?? pair.source.label ?? pair.source.id),
    targetTableIds: [pair.target.id],
    targetTableLabels: [String(pair.target.number ?? pair.target.label ?? pair.target.id)],
  });
  records.push(requested);
  const requestId = requested.body?.request?.requestId ?? "";
  if (requested.body?.status === "pending" && requestId) {
    records.push(await apiPost(manager, "table.room_move.pending", "/api/integration/layout/table/room-move/pending", {
      roomId: pair.target.roomId,
    }));
    records.push(await apiPost(manager, index % 2 === 0 ? "table.room_move.resolve.approve" : "table.room_move.resolve.reject", "/api/integration/layout/table/room-move/resolve", {
      requestId,
      approve: index % 2 === 0,
      roomId: pair.target.roomId,
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
      ok: entries.filter((entry) => entry.ok === true).length,
      errors: entries.filter((entry) => entry.ok !== true).length,
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

function topMetrics(map = {}, labelFilter = /room|table|lock/i, limit = 14) {
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
  const roomLane = metrics?.queues?.roomLane ?? {};
  const appState = metrics?.appState ?? {};
  const requests = metrics?.requests ?? {};
  const dirtyTracking = appState?.dirtyTracking ?? {};
  const dirtySamples = Array.isArray(dirtyTracking.recentSamples)
    ? dirtyTracking.recentSamples
      .filter((sample) => /room|table|lock/i.test(String(sample?.label ?? "")))
      .slice(-30)
    : [];
  return {
    enabled: metrics?.enabled === true,
    counters: metrics?.counters ?? {},
    gauges: metrics?.gauges ?? {},
    appStateRoomWrites: topMetrics(appState.writeRunMsByLabel),
    roomLaneWait: topMetrics(roomLane.waitMsByLabel, /.*/, 16),
    roomLaneRun: topMetrics(roomLane.runMsByLabel, /.*/, 16),
    roomRequests: topMetrics(requests.runMsByRoute, /\/api\/(integration\/layout|pos\/room-change|tables\/lock)/i, 16),
    dirtyMissing: topMetrics(dirtyTracking.missingByLabel, /room|table|lock/i, 16),
    dirtyObservations: topMetrics(dirtyTracking.observationsByLabel, /room|table|lock/i, 16),
    dirtyTrackingModes: [...new Set(dirtySamples.map((sample) => String(sample?.mode ?? "").trim()).filter(Boolean))],
    fullStateFallbackSamples: dirtySamples.filter((sample) => sample?.fullStateFallbackUsed === true).length,
    dirtySamples,
  };
}

function evaluate(records, metricsSummary) {
  const failedRequests = records
    .filter((record) => record.ok !== true)
    .map((record) => ({
      type: record.type,
      status: record.status,
      code: record.code,
      error: record.error,
      durationMs: record.durationMs,
    }));
  const maxLaneP95 = Math.max(
    0,
    ...metricsSummary.roomLaneWait.map((entry) => Number(entry.p95Ms) || 0),
    ...metricsSummary.roomLaneRun.map((entry) => Number(entry.p95Ms) || 0),
  );
  const maxAppStateP95 = Math.max(
    0,
    ...metricsSummary.appStateRoomWrites.map((entry) => Number(entry.p95Ms) || 0),
  );
  const missingDirtyLabels = metricsSummary.dirtyMissing.map((entry) => entry.label);
  const checks = {
    runtimeMetricsEnabled: metricsSummary.enabled === true,
    noFailedRequests: failedRequests.length === 0,
    noRoomDirtyTrackingMissing: !options.failOnDirtyMissing || missingDirtyLabels.length === 0,
    roomLaneP95AtMost5s: maxLaneP95 <= 5_000,
    roomAppStateP95Below5s: maxAppStateP95 < 5_000,
    noFullStateFallback: Number(metricsSummary.counters?.writeDbFullStateFallback ?? 0) === 0,
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
    "# Tables/Rooms Write Audit Canary",
    "",
    `Run: \`${runId}\``,
    `Frontend: \`${options.frontendOrigin}\``,
    `Devices requested: ${options.devices}`,
    `Devices effective: ${result.effectiveDevices}`,
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
    "## Room Lane Wait",
    "",
    result.metricsSummary.roomLaneWait.length ? markdownTable(result.metricsSummary.roomLaneWait, metricColumns) : "_Nessun campione roomLane wait._",
    "",
    "## Room Lane Run",
    "",
    result.metricsSummary.roomLaneRun.length ? markdownTable(result.metricsSummary.roomLaneRun, metricColumns) : "_Nessun campione roomLane run._",
    "",
    "## App-State Writes",
    "",
    result.metricsSummary.appStateRoomWrites.length ? markdownTable(result.metricsSummary.appStateRoomWrites, metricColumns) : "_Nessun write room/table rilevato._",
    "",
    "## Dirty Tracking",
    "",
    `Missing labels: ${result.evaluation.missingDirtyLabels.length ? result.evaluation.missingDirtyLabels.join(", ") : "nessuno"}`,
    `Fail on missing: ${options.failOnDirtyMissing ? "si" : "no"}`,
    `Modes: ${result.metricsSummary.dirtyTrackingModes.length ? result.metricsSummary.dirtyTrackingModes.join(", ") : "n/a"}`,
    `Full-state fallback samples: ${result.metricsSummary.fullStateFallbackSamples}`,
    `writeDbFullStateFallback counter: ${result.metricsSummary.counters?.writeDbFullStateFallback ?? 0}`,
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
  console.log(`[tables-rooms-audit] run=${runId} frontend=${options.frontendOrigin} devices=${options.devices}`);
  const startedAt = performance.now();
  const result = {
    runId,
    startedAtIso: new Date().toISOString(),
    options: { ...options, managerPin: "***", requesterPin: "***" },
  };

  const manager = await login(options.managerUsername, options.managerPin, `room-audit-manager-${runId}`);
  let requesterProbe = await maybeLogin(options.requesterUsername, options.requesterPin, `room-audit-requester-probe-${runId}`);
  if (!requesterProbe?.token) {
    requesterProbe = manager;
    result.requesterFallback = true;
  }
  result.users = {
    manager: manager.user?.username ?? "",
    requester: requesterProbe.user?.username ?? "",
    requesterFallback: result.requesterFallback === true,
  };

  const reset = await runtimeMetrics(manager, "reset");
  result.metricsReset = {
    status: reset.status,
    ok: reset.status === 200,
    enabled: reset.body?.runtimeMetrics?.enabled === true,
  };

  const layoutRecord = await apiGet(manager, "layout.get", `/api/integration/layout?_=${Date.now()}`);
  result.layout = {
    status: layoutRecord.status,
    tables: Array.isArray(layoutRecord.body?.tables) ? layoutRecord.body.tables.length : 0,
  };
  if (layoutRecord.status !== 200) throw new Error(`layout failed: ${layoutRecord.status}`);
  const tables = selectUsableTables(layoutRecord.body);
  if (tables.length < 2) throw new Error("not enough usable tables for rooms audit");
  const sameRoomPairs = buildSameRoomPairs(tables, options.devices);
  const crossRoomPairs = buildCrossRoomPairs(tables, options.devices);
  if (!sameRoomPairs.length) throw new Error("not enough same-room table pairs for rooms audit");
  if (!crossRoomPairs.length) throw new Error("not enough cross-room table pairs for rooms audit");
  const effectiveDevices = Math.min(options.devices, tables.length, sameRoomPairs.length, crossRoomPairs.length);
  result.effectiveDevices = effectiveDevices;
  result.selectedTables = tables.slice(0, Math.min(tables.length, 16)).map((table) => ({
    id: table.id,
    roomId: table.roomId,
    number: table.number,
    occupancyState: table.occupancyState,
  }));
  result.selectedPairs = {
    sameRoom: sameRoomPairs.slice(0, Math.min(sameRoomPairs.length, 8)).map((pair) => ({
      source: { id: pair.source.id, roomId: pair.source.roomId, number: pair.source.number },
      target: { id: pair.target.id, roomId: pair.target.roomId, number: pair.target.number },
    })),
    crossRoom: crossRoomPairs.slice(0, Math.min(crossRoomPairs.length, 8)).map((pair) => ({
      source: { id: pair.source.id, roomId: pair.source.roomId, number: pair.source.number },
      target: { id: pair.target.id, roomId: pair.target.roomId, number: pair.target.number },
    })),
  };

  const sessions = await runPool(
    Array.from({ length: effectiveDevices }, (_, index) => index),
    Math.min(options.concurrency, effectiveDevices),
    async (index) => login(options.managerUsername, options.managerPin, `room-audit-device-${runId}-${index}`),
  );
  const requesterSessions = await runPool(
    Array.from({ length: effectiveDevices }, (_, index) => index),
    Math.min(options.concurrency, effectiveDevices),
    async (index) => {
      if (result.requesterFallback === true) return sessions[index];
      const logged = await maybeLogin(options.requesterUsername, options.requesterPin, `room-audit-requester-${runId}-${index}`);
      return logged?.token ? logged : sessions[index];
    },
  );

  const tasks = sessions.map((session, index) => ({ session, requester: requesterSessions[index], index }));
  const syncResults = await runPool(tasks, options.concurrency, async (task) =>
    runLockSyncLifecycle(task.session, tables[task.index], task.index)
  );
  const tableMoveResults = await runPool(tasks, options.concurrency, async (task) =>
    runTableMoveLifecycle(task.session, sameRoomPairs[task.index], task.index)
  );
  const roomChangeResults = await runPool(tasks, options.concurrency, async (task) => {
    const crossRoomPair = crossRoomPairs[task.index];
    const records = [];
    records.push(...await runRoomChangeLifecycle(task.requester, task.session, crossRoomPair.target.roomId, task.index));
    records.push(...await runTableRoomMoveLifecycle(task.requester, task.session, crossRoomPair, task.index));
    return records;
  });

  const records = [...syncResults, ...tableMoveResults, ...roomChangeResults].flat();
  const snapshot = await runtimeMetrics(manager, "snapshot");
  result.runtimeMetrics = { status: snapshot.status, ok: snapshot.status === 200 };
  result.requestSummary = summarizeRequests(records);
  result.metricsSummary = summarizeMetrics(snapshot.body?.runtimeMetrics ?? null);
  result.evaluation = evaluate(records, result.metricsSummary);
  result.finishedAtIso = new Date().toISOString();
  result.durationMs = round(performance.now() - startedAt);

  const reportDir = await writeReport(result);
  console.log(`[tables-rooms-audit] ${result.evaluation.passed ? "PASS" : "FAIL"} report=${reportDir}`);
  if (!result.evaluation.passed) {
    console.log(`[tables-rooms-audit] failed=${result.evaluation.failed.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[tables-rooms-audit] errore: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
