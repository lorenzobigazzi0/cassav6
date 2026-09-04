#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function percentile(values, ratio) {
  const sorted = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

function latencySummary(values) {
  const safe = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);
  return {
    count: safe.length,
    p50ms: percentile(safe, 0.5),
    p95ms: percentile(safe, 0.95),
    p99ms: percentile(safe, 0.99),
    maxMs: safe.length ? Math.max(...safe) : 0,
  };
}

function normalizeArray(value) {
  return [...new Set(Array.isArray(value) ? value.map(String).filter(Boolean) : [])]
    .sort();
}

export const P5_CONTENTION_GATE_THRESHOLDS = Object.freeze({
  maxQueueWaitMs: 5_000,
  maxLaneWaitMs: 5_000,
});

export function evaluateP5ContentionGate(summary, thresholds = P5_CONTENTION_GATE_THRESHOLDS) {
  const routes = Array.isArray(summary?.routes) ? summary.routes : [];
  const observed = {
    requestCount: Math.max(0, Number(summary?.requestCount) || 0),
    invalidBaselineLines: Math.max(0, Number(summary?.invalidBaselineLines) || 0),
    mysqlRetryRequestCount: Math.max(0, Number(summary?.mysqlRetryRequestCount) || 0),
    starvationPromotions: Math.max(0, Number(summary?.logs?.starvationPromotions) || 0),
    deadlockLogLines: Math.max(0, Number(summary?.logs?.deadlockLines) || 0),
    retryLogLines: Math.max(0, Number(summary?.logs?.retryLines) || 0),
    innodbDeadlocks: Math.max(0, Number(summary?.mysql?.innodbDeadlocks) || 0),
    maxQueueWaitMs: routes.reduce(
      (maximum, route) => Math.max(maximum, Number(route?.queueWaitMs?.maxMs) || 0),
      0,
    ),
    maxLaneWaitMs: routes.reduce(
      (maximum, route) => Math.max(maximum, Number(route?.laneWaitMs?.maxMs) || 0),
      0,
    ),
  };
  const failures = [
    [observed.requestCount === 0, "diagnostics_empty"],
    [observed.invalidBaselineLines > 0, "diagnostics_invalid_jsonl"],
    [observed.mysqlRetryRequestCount > 0, "mysql_retry_requests"],
    [observed.starvationPromotions > 0, "mutation_starvation_promotions"],
    [observed.deadlockLogLines > 0, "mysql_deadlock_log_lines"],
    [observed.retryLogLines > 0, "mysql_retry_log_lines"],
    [observed.innodbDeadlocks > 0, "innodb_deadlocks"],
    [observed.maxQueueWaitMs > thresholds.maxQueueWaitMs, "mutation_queue_wait_over_limit"],
    [observed.maxLaneWaitMs > thresholds.maxLaneWaitMs, "mutation_lane_wait_over_limit"],
  ].filter(([failed]) => failed).map(([, code]) => code);
  return {
    ok: failures.length === 0,
    thresholds: { ...thresholds },
    observed,
    failures,
  };
}

async function readJsonLines(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  const records = [];
  let invalidLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      invalidLines += 1;
    }
  }
  return { records, invalidLines };
}

function routeSummary(records) {
  const byRoute = new Map();
  for (const record of records) {
    const route = String(record?.route ?? "unknown").trim() || "unknown";
    if (!byRoute.has(route)) {
      byRoute.set(route, {
        route,
        requests: 0,
        queueWaitMs: [],
        laneWaitMs: [],
        responseMs: [],
        mysqlRetryCount: 0,
        mysqlRetryCodes: new Set(),
        mysqlRetryScopes: new Set(),
      });
    }
    const entry = byRoute.get(route);
    entry.requests += 1;
    entry.queueWaitMs.push(Number(record?.queueWaitMs) || 0);
    entry.laneWaitMs.push(Number(record?.laneWaitMs) || 0);
    entry.responseMs.push(Number(record?.responseMs) || 0);
    entry.mysqlRetryCount += Math.max(0, Number(record?.mysqlRetryCount) || 0);
    normalizeArray(record?.mysqlRetryCodes).forEach((code) => entry.mysqlRetryCodes.add(code));
    normalizeArray(record?.mysqlRetryScopes).forEach((scope) => entry.mysqlRetryScopes.add(scope));
  }
  return [...byRoute.values()]
    .map((entry) => ({
      route: entry.route,
      requests: entry.requests,
      queueWaitMs: latencySummary(entry.queueWaitMs),
      laneWaitMs: latencySummary(entry.laneWaitMs),
      responseMs: latencySummary(entry.responseMs),
      mysqlRetryCount: entry.mysqlRetryCount,
      mysqlRetryCodes: [...entry.mysqlRetryCodes].sort(),
      mysqlRetryScopes: [...entry.mysqlRetryScopes].sort(),
    }))
    .sort(
      (left, right) =>
        right.queueWaitMs.maxMs - left.queueWaitMs.maxMs ||
        right.queueWaitMs.p95ms - left.queueWaitMs.p95ms ||
        right.mysqlRetryCount - left.mysqlRetryCount ||
        left.route.localeCompare(right.route),
    );
}

async function readBackendLogCounts(reportDir, names) {
  const logFiles = names.filter(
    (name) => name.startsWith("backend") && name.endsWith(".log"),
  );
  let starvationPromotions = 0;
  let deadlockLines = 0;
  let retryLines = 0;
  for (const name of logFiles) {
    const text = await fs.readFile(path.join(reportDir, name), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.includes("promozione anti-starvation")) starvationPromotions += 1;
      if (/deadlock|ER_LOCK_DEADLOCK/i.test(line)) deadlockLines += 1;
      if (/Retry MySQL|Write app-state MySQL in retry/.test(line)) retryLines += 1;
    }
  }
  return { logFiles, starvationPromotions, deadlockLines, retryLines };
}

function renderMarkdown(summary) {
  const routes = summary.routes.slice(0, 20);
  return `# P5 contention report

- Directory: ${summary.reportDir}
- Richieste diagnostiche: ${summary.requestCount}
- File baseline: ${summary.baselineFiles.length}
- Righe JSONL non valide: ${summary.invalidBaselineLines}
- Promozioni anti-starvation: ${summary.logs.starvationPromotions}
- Righe deadlock: ${summary.logs.deadlockLines}
- Righe retry MySQL: ${summary.logs.retryLines}
- Deadlock InnoDB nel run: ${summary.mysql.innodbDeadlocks}
- Attese lock InnoDB nel run: ${summary.mysql.innodbRowLockWaits}
- Gate contesa: ${summary.gate.ok ? "VERDE" : `ROSSO (${summary.gate.failures.join(", ")})`}
- Attesa massima coda/lane: ${summary.gate.observed.maxQueueWaitMs}/${summary.gate.observed.maxLaneWaitMs} ms

## Route per attesa mutation

| Route | Richieste | Coda p95 | Coda p99 | Coda max | Lane p95 | Risposta p95 | Retry MySQL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${routes.map((entry) => `| ${entry.route.replace(/\|/g, "\\|")} | ${entry.requests} | ${entry.queueWaitMs.p95ms} | ${entry.queueWaitMs.p99ms} | ${entry.queueWaitMs.maxMs} | ${entry.laneWaitMs.p95ms} | ${entry.responseMs.p95ms} | ${entry.mysqlRetryCount} |`).join("\n") || "| n/d | 0 | 0 | 0 | 0 | 0 | 0 | 0 |"}
`;
}

export async function analyzeP5ContentionDirectory(reportDir) {
  const resolvedDir = path.resolve(reportDir);
  const names = await fs.readdir(resolvedDir);
  const baselineFiles = names
    .filter((name) => name === "backend-baseline.jsonl" || name.endsWith("-baseline.jsonl"))
    .sort();
  const records = [];
  let invalidBaselineLines = 0;
  for (const name of baselineFiles) {
    const parsed = await readJsonLines(path.join(resolvedDir, name));
    invalidBaselineLines += parsed.invalidLines;
    parsed.records.forEach((record) => records.push({ ...record, sourceFile: name }));
  }
  const logs = await readBackendLogCounts(resolvedDir, names);
  let mysqlStatusDelta = {};
  try {
    const report = JSON.parse(
      await fs.readFile(path.join(resolvedDir, "report.json"), "utf8"),
    );
    mysqlStatusDelta = report?.monitor?.mysqlStatusDelta ?? {};
  } catch {
    mysqlStatusDelta = {};
  }
  const summary = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    reportDir: resolvedDir,
    baselineFiles,
    invalidBaselineLines,
    requestCount: records.length,
    mysqlRetryRequestCount: records.filter(
      (record) => Number(record?.mysqlRetryCount) > 0,
    ).length,
    routes: routeSummary(records),
    logs,
    mysql: {
      innodbDeadlocks: Number(mysqlStatusDelta.Innodb_deadlocks) || 0,
      innodbRowLockWaits: Number(mysqlStatusDelta.Innodb_row_lock_waits) || 0,
      innodbRowLockTimeMs: Number(mysqlStatusDelta.Innodb_row_lock_time) || 0,
    },
  };
  summary.gate = evaluateP5ContentionGate(summary);
  const jsonPath = path.join(resolvedDir, "p5-contention-report.json");
  const markdownPath = path.join(resolvedDir, "P5_CONTENTION_REPORT.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, renderMarkdown(summary), "utf8");
  return { summary, jsonPath, markdownPath };
}

const executedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (executedPath === import.meta.url) {
  const reportDir = process.argv[2];
  if (!reportDir) throw new Error("Uso: node scripts/p5-contention-report.mjs <report-dir>");
  const result = await analyzeP5ContentionDirectory(reportDir);
  console.log(JSON.stringify({
    ok: result.summary.gate.ok,
    jsonPath: result.jsonPath,
    markdownPath: result.markdownPath,
    requestCount: result.summary.requestCount,
    mysqlRetryRequestCount: result.summary.mysqlRetryRequestCount,
    starvationPromotions: result.summary.logs.starvationPromotions,
    deadlockLogLines: result.summary.logs.deadlockLines,
    innodbDeadlocks: result.summary.mysql.innodbDeadlocks,
    maxQueueWaitMs: result.summary.gate.observed.maxQueueWaitMs,
    maxLaneWaitMs: result.summary.gate.observed.maxLaneWaitMs,
    gateFailures: result.summary.gate.failures,
  }, null, 2));
}
