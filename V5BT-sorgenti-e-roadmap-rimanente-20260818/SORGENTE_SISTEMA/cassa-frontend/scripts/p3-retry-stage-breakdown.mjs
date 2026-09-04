#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const parsed = {
    metrics: [],
    metricsDeltas: [],
    logs: [],
    reports: [],
    outputJson: "reports/p3-retry-stage-breakdown.json",
    outputMd: "reports/P3_RETRY_STAGE_BREAKDOWN.md",
    runId: process.env.P3_BREAKDOWN_RUN_ID || new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readNext = () => String(argv[++index] ?? "").trim();
    if (arg === "--metrics") parsed.metrics.push(readNext());
    else if (arg.startsWith("--metrics=")) parsed.metrics.push(arg.slice("--metrics=".length));
    else if (arg === "--metrics-delta") {
      const before = readNext();
      const after = readNext();
      if (before && after) parsed.metricsDeltas.push({ before, after });
    } else if (arg.startsWith("--metrics-delta=")) {
      const [before, after] = arg.slice("--metrics-delta=".length).split(":", 2);
      if (before && after) parsed.metricsDeltas.push({ before, after });
    }
    else if (arg === "--log") parsed.logs.push(readNext());
    else if (arg.startsWith("--log=")) parsed.logs.push(arg.slice("--log=".length));
    else if (arg === "--report") parsed.reports.push(readNext());
    else if (arg.startsWith("--report=")) parsed.reports.push(arg.slice("--report=".length));
    else if (arg === "--output-json") parsed.outputJson = readNext();
    else if (arg.startsWith("--output-json=")) parsed.outputJson = arg.slice("--output-json=".length);
    else if (arg === "--output-md") parsed.outputMd = readNext();
    else if (arg.startsWith("--output-md=")) parsed.outputMd = arg.slice("--output-md=".length);
    else if (arg === "--run-id") parsed.runId = readNext();
    else if (arg.startsWith("--run-id=")) parsed.runId = arg.slice("--run-id=".length);
    else if (arg === "--help" || arg === "-h") parsed.help = true;
  }
  return parsed;
}

function usage() {
  console.log(`Uso:
  node scripts/p3-retry-stage-breakdown.mjs \\
    --metrics reports/owner-runtime.json \\
    --metrics-delta reports/worker-before.json reports/worker-after.json \\
    --metrics reports/worker-5283-runtime.json \\
    --log reports/p3-journal.log \\
    --report logs/loadtest-.../report.json

Produce un JSON e un Markdown con il breakdown P3.13 di stage/cause retry.`);
}

async function readJson(file) {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
}

function unwrapRuntimeMetrics(body) {
  return body?.runtimeMetrics ?? body ?? {};
}

function cloneJson(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function deltaNumber(before, after) {
  const value = Number(after || 0) - Number(before || 0);
  return Number.isFinite(value) ? value : 0;
}

function deltaMetric(before = {}, after = {}) {
  const count = Math.max(0, Math.trunc(deltaNumber(before.count, after.count)));
  const sum = Math.max(0, deltaNumber(before.sum, after.sum));
  if (count <= 0 && sum <= 0) return null;
  return {
    ...cloneJson(after, {}),
    count,
    sum,
    avg: count > 0 ? sum / count : 0,
    p95: Number(after?.p95 || 0),
    max: Number(after?.max || 0),
  };
}

function deltaMetricMap(before = {}, after = {}) {
  const output = {};
  const labels = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const label of labels) {
    const metric = deltaMetric(before?.[label], after?.[label]);
    if (metric) output[label] = metric;
  }
  return output;
}

function deltaNestedMetricSections(before = {}, after = {}) {
  const output = cloneJson(after, {});
  for (const section of ["waitMsByLabel", "runMsByLabel"]) {
    output[section] = deltaMetricMap(before?.[section], after?.[section]);
  }
  return output;
}

function deltaRuntimeMetrics(beforeBody, afterBody) {
  const before = unwrapRuntimeMetrics(beforeBody);
  const after = unwrapRuntimeMetrics(afterBody);
  const counters = {};
  for (const key of new Set([...Object.keys(before?.counters ?? {}), ...Object.keys(after?.counters ?? {})])) {
    counters[key] = Math.max(0, deltaNumber(before?.counters?.[key], after?.counters?.[key]));
  }
  const operations = {
    ...(cloneJson(after?.operations, {}) || {}),
    runMsByLabel: deltaMetricMap(before?.operations?.runMsByLabel, after?.operations?.runMsByLabel),
  };
  const queues = {};
  for (const queueName of new Set([...Object.keys(before?.queues ?? {}), ...Object.keys(after?.queues ?? {})])) {
    const beforeQueue = before?.queues?.[queueName] ?? {};
    const afterQueue = after?.queues?.[queueName] ?? {};
    if (
      beforeQueue &&
      afterQueue &&
      (beforeQueue.waitMsByLabel || beforeQueue.runMsByLabel || afterQueue.waitMsByLabel || afterQueue.runMsByLabel)
    ) {
      queues[queueName] = deltaNestedMetricSections(beforeQueue, afterQueue);
    } else {
      queues[queueName] = cloneJson(afterQueue, {});
    }
  }
  const requests = {};
  for (const section of new Set([...Object.keys(before?.requests ?? {}), ...Object.keys(after?.requests ?? {})])) {
    requests[section] = deltaMetricMap(before?.requests?.[section], after?.requests?.[section]);
  }
  return {
    ...cloneJson(after, {}),
    counters,
    operations,
    queues,
    requests,
  };
}

function metricCount(metric) {
  return Math.max(0, Math.trunc(Number(metric?.count) || 0));
}

function metricSum(metric) {
  return Math.max(0, Number(metric?.sum) || 0);
}

function metricAvg(metric) {
  return Math.max(0, Number(metric?.avg) || 0);
}

function metricP95(metric) {
  return Math.max(0, Number(metric?.p95) || 0);
}

function metricMax(metric) {
  return Math.max(0, Number(metric?.max) || 0);
}

function addCount(map, key, value = 1) {
  const safeKey = String(key || "unknown").trim() || "unknown";
  map.set(safeKey, (map.get(safeKey) || 0) + Math.max(0, Number(value) || 0));
}

function addMetric(map, key, metric, source = "") {
  const safeKey = String(key || "unknown").trim() || "unknown";
  const current = map.get(safeKey) || {
    label: safeKey,
    count: 0,
    sum: 0,
    max: 0,
    p95Max: 0,
    sources: new Set(),
  };
  current.count += metricCount(metric);
  current.sum += metricSum(metric);
  current.max = Math.max(current.max, metricMax(metric));
  current.p95Max = Math.max(current.p95Max, metricP95(metric));
  if (source) current.sources.add(source);
  map.set(safeKey, current);
}

function finishMetric(entry) {
  return {
    label: entry.label,
    count: entry.count,
    avgMs: entry.count ? Math.round((entry.sum / entry.count) * 100) / 100 : 0,
    p95MaxMs: entry.p95Max,
    maxMs: entry.max,
    sources: [...entry.sources].sort(),
  };
}

function sortMetrics(map, limit = 20) {
  return [...map.values()]
    .map(finishMetric)
    .filter((entry) => entry.count > 0)
    .sort(
      (left, right) =>
        right.count - left.count ||
        right.p95MaxMs - left.p95MaxMs ||
        right.maxMs - left.maxMs ||
        left.label.localeCompare(right.label),
    )
    .slice(0, limit);
}

function sortCounts(map, limit = 20) {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, limit);
}

function classifyOperationLabel(label) {
  const value = String(label || "");
  const normalized = value.replace(/^appStateWriteRetry:/, "");
  const result = {
    label: value,
    family: "other",
    domain: "",
    scope: "",
    stage: "",
    cause: "",
    retry: value.startsWith("appStateWriteRetry:"),
    rollback: false,
    error: false,
    outcome: "",
  };

  const retryMatch = normalized.match(/^(?<scope>.+?)\.stage\.(?<stage>[^.]+)\.(?<cause>[^.]+)$/);
  if (retryMatch?.groups) {
    result.family = "appStateWriteRetry";
    result.scope = retryMatch.groups.scope;
    result.stage = retryMatch.groups.stage;
    result.cause = retryMatch.groups.cause;
    result.retry = true;
    return result;
  }

  const splitMatch = normalized.match(
    /^appStateDomainSplit:(?<domain>[^.]+(?:\.[^.]+)?)\.(?<scope>.+?)\.(?<kind>errorStage|error|rollback|outcome)(?:\.(?<detail>.+))?$/,
  );
  if (splitMatch?.groups) {
    const { domain, scope, kind, detail = "" } = splitMatch.groups;
    result.family = `appStateDomainSplit.${kind}`;
    result.domain = domain;
    result.scope = scope;
    result.rollback = kind === "rollback";
    result.error = kind === "error" || kind === "errorStage";
    if (kind === "errorStage") {
      const parts = detail.split(".").filter(Boolean);
      result.stage = parts[0] || "unknown";
      result.cause = parts.slice(1).join(".") || "unknown";
    } else if (kind === "rollback") {
      const causeMatch = detail.match(/^cause\.(.+)$/);
      result.cause = causeMatch?.[1] || detail || "unknown";
    } else if (kind === "error") {
      result.cause = detail || "unknown";
    } else if (kind === "outcome") {
      result.outcome = detail || "unknown";
    }
    return result;
  }

  const phaseMatch = normalized.match(/^appStateDomainSplit:(?<domain>[^.]+(?:\.[^.]+)?)\.(?<scope>.+?)\.(?<stage>ensure|getPool|getConnection|beginTransaction|stateRead|upsertChangedRows|insertRows|deleteRows|commit|rollback|release|total|collect|compare)$/);
  if (phaseMatch?.groups) {
    result.family = "appStateDomainSplit.stageTiming";
    result.domain = phaseMatch.groups.domain;
    result.scope = phaseMatch.groups.scope;
    result.stage = phaseMatch.groups.stage;
    result.rollback = result.stage === "rollback";
    return result;
  }

  if (/transient|deadlock|lock wait|rollback/i.test(value)) {
    result.family = "unparsedRetryLike";
    result.cause = /deadlock/i.test(value) ? "deadlock" : /lock wait/i.test(value) ? "lockWait" : "transient";
    result.retry = /retry/i.test(value);
    result.rollback = /rollback/i.test(value);
  }
  return result;
}

function collectFromMetrics(file, body, acc) {
  const runtimeMetrics = body?.runtimeMetrics ?? body;
  const operations = runtimeMetrics?.operations?.runMsByLabel ?? {};
  const counters = runtimeMetrics?.counters ?? {};
  const queues = runtimeMetrics?.queues ?? {};
  const requests = runtimeMetrics?.requests ?? {};
  const source = path.basename(file);

  acc.sources.metrics.push(file);
  for (const [name, value] of Object.entries(counters)) {
    if (/retry|rollback|deadlock|transient|error|failed/i.test(name)) {
      addCount(acc.counters, name, value);
    }
  }
  for (const [label, metric] of Object.entries(operations)) {
    const info = classifyOperationLabel(label);
    if (
      info.family !== "other" ||
      /retry|rollback|deadlock|transient|errorStage|error|outcome|appStateDomainSplit/i.test(label)
    ) {
      addMetric(acc.operationLabels, label, metric, source);
      if (info.stage) addMetric(acc.byStage, info.stage, metric, source);
      if (info.cause) addMetric(acc.byCause, info.cause, metric, source);
      if (info.domain) addMetric(acc.byDomain, info.domain, metric, source);
      if (info.scope) addMetric(acc.byScope, `${info.domain || "appState"}.${info.scope}`, metric, source);
      if (info.retry) addMetric(acc.retryLabels, label, metric, source);
      if (info.rollback) addMetric(acc.rollbackLabels, label, metric, source);
      if (info.error) addMetric(acc.errorLabels, label, metric, source);
      if ((info.retry || info.rollback || info.error) && info.stage) {
        addMetric(acc.retryStages, info.stage, metric, source);
      }
    }
  }

  for (const [queueName, queue] of Object.entries(queues)) {
    for (const section of ["waitMsByLabel", "runMsByLabel"]) {
      for (const [label, metric] of Object.entries(queue?.[section] ?? {})) {
        if (/orders|integration|appState|retry|rollback|transient|deadlock/i.test(label)) {
          addMetric(acc.queueLabels, `${queueName}.${section}.${label}`, metric, source);
        }
      }
    }
  }
  for (const [section, entries] of Object.entries(requests)) {
    for (const [label, metric] of Object.entries(entries ?? {})) {
      if (/orders|integration|payments|stations|tables/i.test(label)) {
        addMetric(acc.requestLabels, `${section}.${label}`, metric, source);
      }
    }
  }
}

function collectFromLog(file, text, acc) {
  acc.sources.logs.push(file);
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!/retry|rollback|deadlock|transient|lock wait|errore|error|warning|warn/i.test(line)) continue;
    const stage = line.match(/stage[.:= ]+([a-zA-Z0-9_-]+)/i)?.[1] || line.match(/errorStage[.:= ]+([a-zA-Z0-9_-]+)/i)?.[1] || "";
    const label = line.match(/(appStateWriteRetry:[^ ]+|appStateDomainSplit:[^ ]+)/)?.[1] || "";
    const fallbackStage = /\[db:orders-async-flush\]|orders-async-flush|flush mirror/i.test(line)
      ? "ordersAsyncFlush"
      : "";
    const cause =
      line.match(/(deadlock|lock wait|transientDbError|transient|timeout|REVISION_CONFLICT|revisionConflict|no_eligible_active_station)/i)?.[1] ||
      (line.includes("Record has changed since last read") ? "revisionConflict" : "") ||
      "unknown";
    const resolvedStage = stage || fallbackStage;
    if (resolvedStage) addCount(acc.logStages, resolvedStage);
    if (cause) addCount(acc.logCauses, cause);
    if (label) addCount(acc.logLabels, label);
    acc.logMatches.push(line.slice(0, 500));
  }
}

function collectFromReport(file, body, acc) {
  acc.sources.reports.push(file);
  const runtimeMetrics = body?.runtimeMetrics ?? body?.summary?.runtimeMetrics ?? null;
  if (runtimeMetrics) collectFromMetrics(`${file}:runtimeMetrics`, { runtimeMetrics }, acc);
  const recorder = body?.recorder ?? body?.summary?.recorder ?? null;
  for (const [name, bucket] of Object.entries(recorder?.http ?? {})) {
    if (bucket?.fail || /order|station|payment|lock/i.test(name)) {
      addCount(acc.reportHttpCounts, `${name}.count`, bucket?.count || 0);
      if (bucket?.fail) addCount(acc.reportHttpFailures, name, bucket.fail);
    }
  }
  for (const finding of body?.consistency?.findings ?? body?.summary?.consistency?.findings ?? []) {
    addCount(acc.reportFindings, String(finding));
  }
}

function makeAccumulator() {
  return {
    sources: { metrics: [], logs: [], reports: [] },
    counters: new Map(),
    operationLabels: new Map(),
    byStage: new Map(),
    retryStages: new Map(),
    byCause: new Map(),
    byDomain: new Map(),
    byScope: new Map(),
    retryLabels: new Map(),
    rollbackLabels: new Map(),
    errorLabels: new Map(),
    queueLabels: new Map(),
    requestLabels: new Map(),
    logStages: new Map(),
    logCauses: new Map(),
    logLabels: new Map(),
    logMatches: [],
    reportHttpCounts: new Map(),
    reportHttpFailures: new Map(),
    reportFindings: new Map(),
  };
}

function buildSummary(options, acc) {
  const byStage = sortMetrics(acc.byStage, 20);
  const retryStages = sortMetrics(acc.retryStages, 20);
  const byCause = sortMetrics(acc.byCause, 20);
  const rollbackLabels = sortMetrics(acc.rollbackLabels, 20);
  const retryLabels = sortMetrics(acc.retryLabels, 20);
  const errorLabels = sortMetrics(acc.errorLabels, 20);
  const logCauses = sortCounts(acc.logCauses, 20);
  const dominantStage =
    retryStages.find((entry) => !["total", "outcome"].includes(entry.label)) ||
    sortCounts(acc.logStages, 20)[0] ||
    null;
  const dominantCause = byCause[0] || logCauses[0] || null;
  const retryLikeCount =
    retryLabels.reduce((sum, entry) => sum + entry.count, 0) +
    rollbackLabels.reduce((sum, entry) => sum + entry.count, 0) +
    errorLabels.reduce((sum, entry) => sum + entry.count, 0) +
    logCauses.reduce((sum, entry) => sum + entry.count, 0);
  return {
    runId: options.runId,
    generatedAt: new Date().toISOString(),
    sources: acc.sources,
    verdict: {
      retryLikeCount,
      dominantStage: dominantStage?.label || null,
      dominantCause: dominantCause?.label || null,
      needsP314Fix: retryLikeCount > 0,
      p3GateClean: retryLikeCount === 0,
    },
    counters: sortCounts(acc.counters, 30),
    byStage,
    retryStages,
    byCause,
    byDomain: sortMetrics(acc.byDomain, 20),
    byScope: sortMetrics(acc.byScope, 20),
    retryLabels,
    rollbackLabels,
    errorLabels,
    queueLabels: sortMetrics(acc.queueLabels, 20),
    requestLabels: sortMetrics(acc.requestLabels, 20),
    logs: {
      causes: logCauses,
      stages: sortCounts(acc.logStages, 20),
      labels: sortCounts(acc.logLabels, 20),
      sample: acc.logMatches.slice(0, 40),
      totalMatches: acc.logMatches.length,
    },
    reports: {
      httpCounts: sortCounts(acc.reportHttpCounts, 30),
      httpFailures: sortCounts(acc.reportHttpFailures, 30),
      findings: sortCounts(acc.reportFindings, 20),
    },
  };
}

function renderTable(rows, columns) {
  if (!rows.length) return "_nessun dato_";
  const header = `| ${columns.map((column) => column.title).join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((row) => `| ${columns.map((column) => String(column.value(row)).replace(/\|/g, "\\|")).join(" | ")} |`)
    .join("\n");
  return `${header}\n${sep}\n${body}`;
}

function renderMarkdown(summary) {
  const metricColumns = [
    { title: "label", value: (row) => row.label },
    { title: "count", value: (row) => row.count },
    { title: "avg ms", value: (row) => row.avgMs },
    { title: "p95 max", value: (row) => row.p95MaxMs },
    { title: "max", value: (row) => row.maxMs },
    { title: "sources", value: (row) => row.sources.join(", ") },
  ];
  return `# P3.13 retry/stage breakdown

Run: \`${summary.runId}\`  
Generato: ${summary.generatedAt}

## Verdetto

- Retry-like osservati: ${summary.verdict.retryLikeCount}
- Stage dominante: ${summary.verdict.dominantStage || "nessuno"}
- Causa dominante: ${summary.verdict.dominantCause || "nessuna"}
- Gate P3 pulito: ${summary.verdict.p3GateClean ? "SI" : "NO"}
- Richiede P3.14 mirato: ${summary.verdict.needsP314Fix ? "SI" : "NO"}

## Stage

${renderTable(summary.byStage, metricColumns)}

## Cause

${renderTable(summary.byCause, metricColumns)}

## Retry Stages

${renderTable(summary.retryStages, metricColumns)}

## Retry Labels

${renderTable(summary.retryLabels, metricColumns)}

## Rollback Labels

${renderTable(summary.rollbackLabels, metricColumns)}

## Error Labels

${renderTable(summary.errorLabels, metricColumns)}

## Queue/Request Pressure

### Queue

${renderTable(summary.queueLabels, metricColumns)}

### Request

${renderTable(summary.requestLabels, metricColumns)}

## Log Matches

- Totale righe log matchate: ${summary.logs.totalMatches}
- Cause log: ${summary.logs.causes.map((entry) => `${entry.label}=${entry.count}`).join(", ") || "nessuna"}
- Stage log: ${summary.logs.stages.map((entry) => `${entry.label}=${entry.count}`).join(", ") || "nessuno"}

## Report HTTP Failures

${renderTable(summary.reports.httpFailures, [
    { title: "label", value: (row) => row.label },
    { title: "count", value: (row) => row.count },
  ])}

## Sources

- Metrics: ${summary.sources.metrics.join(", ") || "nessuno"}
- Logs: ${summary.sources.logs.join(", ") || "nessuno"}
- Reports: ${summary.sources.reports.join(", ") || "nessuno"}
`;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

const acc = makeAccumulator();
for (const file of options.metrics) {
  collectFromMetrics(file, await readJson(file), acc);
}
for (const entry of options.metricsDeltas) {
  const before = await readJson(entry.before);
  const after = await readJson(entry.after);
  collectFromMetrics(
    `${path.basename(entry.before)}->${path.basename(entry.after)}`,
    { runtimeMetrics: deltaRuntimeMetrics(before, after) },
    acc,
  );
}
for (const file of options.reports) {
  collectFromReport(file, await readJson(file), acc);
}
for (const file of options.logs) {
  collectFromLog(file, await fs.readFile(file, "utf8"), acc);
}

const summary = buildSummary(options, acc);
await fs.mkdir(path.dirname(options.outputJson), { recursive: true });
await fs.mkdir(path.dirname(options.outputMd), { recursive: true });
await fs.writeFile(options.outputJson, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await fs.writeFile(options.outputMd, renderMarkdown(summary), "utf8");
console.log(JSON.stringify({
  ok: true,
  outputJson: options.outputJson,
  outputMd: options.outputMd,
  verdict: summary.verdict,
}, null, 2));
