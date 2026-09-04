#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const result = {
    input: "logs/performance-baseline.ndjson",
    outDir: "reports",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") result.input = argv[++index] ?? result.input;
    else if (arg.startsWith("--input=")) result.input = arg.slice("--input=".length);
    else if (arg === "--out-dir") result.outDir = argv[++index] ?? result.outDir;
    else if (arg.startsWith("--out-dir=")) result.outDir = arg.slice("--out-dir=".length);
    else if (arg === "--help" || arg === "-h") result.help = true;
  }
  return result;
}

function printHelp() {
  console.log(`Usage: node scripts/parse-latency-logs.mjs [--input logs/performance-baseline.ndjson] [--out-dir reports]\n\nLegge NDJSON baseline e produce baseline-summary.json/md con p50/p95/p99, read/write count, error rate e fallback counts.`);
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function percentile(values, q) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (clean.length === 0) return 0;
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil(clean.length * q) - 1));
  return Math.round(clean[index] * 100) / 100;
}

function summary(values) {
  const clean = values.map(Number).filter(Number.isFinite);
  if (clean.length === 0) return { count: 0, avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
  const sum = clean.reduce((total, value) => total + value, 0);
  return {
    count: clean.length,
    avg: Math.round((sum / clean.length) * 100) / 100,
    min: Math.min(...clean),
    max: Math.max(...clean),
    p50: percentile(clean, 0.5),
    p95: percentile(clean, 0.95),
    p99: percentile(clean, 0.99),
  };
}

function parseRecords(inputPath) {
  const absolute = path.resolve(inputPath);
  if (!existsSync(absolute)) {
    throw new Error(`Input non trovato: ${absolute}`);
  }
  const lines = readFileSync(absolute, "utf8").split(/\r?\n/).filter(Boolean);
  const records = [];
  for (const [index, line] of lines.entries()) {
    try {
      const parsed = JSON.parse(line);
      const route = String(parsed.route ?? `${parsed.method ?? ""} ${parsed.path ?? ""}`).trim() || "unknown";
      records.push({ ...parsed, route, __line: index + 1 });
    } catch (error) {
      records.push({ route: "__parse_error__", parseError: true, line: index + 1, raw: line, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return records;
}

function aggregate(records) {
  const routes = new Map();
  const fallbackCounters = {
    fullStateFallbackUsed: 0,
    legacyFallbackUsed: 0,
    wideRefetchAfterEvent: 0,
    dirtyTrackingObservations: 0,
    dirtyTrackingUndeclared: 0,
    dirtyTrackingOverDeclared: 0,
    parseErrors: 0,
  };

  for (const record of records) {
    if (record.parseError) fallbackCounters.parseErrors += 1;
    if (record.fullStateFallbackUsed === true || record.fullStateFallbackUsed === 1) fallbackCounters.fullStateFallbackUsed += 1;
    if (record.legacyFallbackUsed === true || record.legacyFallbackUsed === 1) fallbackCounters.legacyFallbackUsed += 1;
    if (record.wideRefetchAfterEvent === true || record.wideRefetchAfterEvent === 1) fallbackCounters.wideRefetchAfterEvent += 1;
    const undeclaredDirtyDomains = Array.isArray(record.undeclaredDirtyDomains) ? record.undeclaredDirtyDomains : [];
    const overDeclaredDirtyDomains = Array.isArray(record.overDeclaredDirtyDomains) ? record.overDeclaredDirtyDomains : [];
    if (record.dirtyTrackingMode && record.dirtyTrackingMode !== "off") fallbackCounters.dirtyTrackingObservations += 1;
    if (undeclaredDirtyDomains.length > 0) fallbackCounters.dirtyTrackingUndeclared += 1;
    if (overDeclaredDirtyDomains.length > 0) fallbackCounters.dirtyTrackingOverDeclared += 1;
    const route = record.route || "unknown";
    if (!routes.has(route)) {
      routes.set(route, {
        route,
        count: 0,
        errors: 0,
        responseMs: [],
        queueWaitMs: [],
        laneWaitMs: [],
        readDbMs: [],
        writeDbMs: [],
        readDbCount: [],
        writeDbCount: [],
        dirtyTrackingUndeclared: 0,
        dirtyTrackingOverDeclared: 0,
        fullStateFallbackUsed: 0,
      });
    }
    const bucket = routes.get(route);
    bucket.count += 1;
    if (Array.isArray(record.undeclaredDirtyDomains) && record.undeclaredDirtyDomains.length > 0) bucket.dirtyTrackingUndeclared += 1;
    if (Array.isArray(record.overDeclaredDirtyDomains) && record.overDeclaredDirtyDomains.length > 0) bucket.dirtyTrackingOverDeclared += 1;
    if (record.fullStateFallbackUsed === true || record.fullStateFallbackUsed === 1) bucket.fullStateFallbackUsed += 1;
    const status = numberOrNull(record.status ?? record.statusCode);
    if (record.error || (status !== null && status >= 500)) bucket.errors += 1;
    for (const key of ["responseMs", "queueWaitMs", "laneWaitMs", "readDbMs", "writeDbMs", "readDbCount", "writeDbCount"]) {
      const value = numberOrNull(record[key]);
      if (value !== null) bucket[key].push(value);
    }
  }

  const routeSummaries = [...routes.values()].map((bucket) => ({
    route: bucket.route,
    count: bucket.count,
    errorRate: bucket.count > 0 ? Math.round((bucket.errors / bucket.count) * 10000) / 100 : 0,
    responseMs: summary(bucket.responseMs),
    queueWaitMs: summary(bucket.queueWaitMs),
    laneWaitMs: summary(bucket.laneWaitMs),
    readDbMs: summary(bucket.readDbMs),
    writeDbMs: summary(bucket.writeDbMs),
    readDbCount: summary(bucket.readDbCount),
    writeDbCount: summary(bucket.writeDbCount),
    dirtyTrackingUndeclared: bucket.dirtyTrackingUndeclared,
    dirtyTrackingOverDeclared: bucket.dirtyTrackingOverDeclared,
    fullStateFallbackUsed: bucket.fullStateFallbackUsed,
  })).sort((a, b) => b.responseMs.p95 - a.responseMs.p95 || b.count - a.count || a.route.localeCompare(b.route));

  return {
    generatedAt: new Date().toISOString(),
    records: records.length,
    fallbackCounters,
    routes: routeSummaries,
    top: {
      slowestP95: routeSummaries.slice(0, 20),
      mostReads: [...routeSummaries].sort((a, b) => b.readDbCount.avg - a.readDbCount.avg || b.count - a.count).slice(0, 20),
      mostWrites: [...routeSummaries].sort((a, b) => b.writeDbCount.avg - a.writeDbCount.avg || b.count - a.count).slice(0, 20),
      highestErrorRate: [...routeSummaries].sort((a, b) => b.errorRate - a.errorRate || b.count - a.count).slice(0, 20),
      dirtyTrackingUndeclared: [...routeSummaries].sort((a, b) => b.dirtyTrackingUndeclared - a.dirtyTrackingUndeclared || b.count - a.count).slice(0, 20),
      fullStateFallback: [...routeSummaries].sort((a, b) => b.fullStateFallbackUsed - a.fullStateFallbackUsed || b.count - a.count).slice(0, 20),
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Baseline latency summary");
  lines.push("");
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`Records: ${report.records}`);
  lines.push("");
  lines.push("## Fallback counters");
  lines.push("");
  lines.push("| Counter | Value |");
  lines.push("|---|---:|");
  Object.entries(report.fallbackCounters).forEach(([key, value]) => lines.push(`| ${key} | ${value} |`));
  lines.push("");
  lines.push("## Top 20 slowest routes by response p95");
  lines.push("");
  lines.push("| Route | Count | Error % | p50 | p95 | p99 | readDb avg | writeDb avg | queue p95 | lane p95 | dirty undeclared | full fallback |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  report.top.slowestP95.forEach((entry) => {
    lines.push(`| ${entry.route.replace(/\|/g, "\\|")} | ${entry.count} | ${entry.errorRate} | ${entry.responseMs.p50} | ${entry.responseMs.p95} | ${entry.responseMs.p99} | ${entry.readDbCount.avg} | ${entry.writeDbCount.avg} | ${entry.queueWaitMs.p95} | ${entry.laneWaitMs.p95} | ${entry.dirtyTrackingUndeclared} | ${entry.fullStateFallbackUsed} |`);
  });
  lines.push("");
  lines.push("## Top 20 routes by readDb count");
  lines.push("");
  lines.push("| Route | Count | readDb avg | readDb p95 | response p95 |");
  lines.push("|---|---:|---:|---:|---:|");
  report.top.mostReads.forEach((entry) => lines.push(`| ${entry.route.replace(/\|/g, "\\|")} | ${entry.count} | ${entry.readDbCount.avg} | ${entry.readDbCount.p95} | ${entry.responseMs.p95} |`));
  lines.push("");
  lines.push("## Top routes with dirty-tracking undeclared domains");
  lines.push("");
  lines.push("| Route | Count | undeclared observations | full fallback | response p95 |");
  lines.push("|---|---:|---:|---:|---:|");
  report.top.dirtyTrackingUndeclared.filter((entry) => entry.dirtyTrackingUndeclared > 0).forEach((entry) => lines.push(`| ${entry.route.replace(/\|/g, "\\|")} | ${entry.count} | ${entry.dirtyTrackingUndeclared} | ${entry.fullStateFallbackUsed} | ${entry.responseMs.p95} |`));
  lines.push("");
  lines.push("## Top 20 routes by writeDb count");
  lines.push("");
  lines.push("| Route | Count | writeDb avg | writeDb p95 | response p95 |");
  lines.push("|---|---:|---:|---:|---:|");
  report.top.mostWrites.forEach((entry) => lines.push(`| ${entry.route.replace(/\|/g, "\\|")} | ${entry.count} | ${entry.writeDbCount.avg} | ${entry.writeDbCount.p95} | ${entry.responseMs.p95} |`));
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export { parseArgs, parseRecords, aggregate as buildSummary, renderMarkdown as toMarkdown, summary, percentile };

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return 0; }
  const records = parseRecords(args.input);
  const report = aggregate(records);
  const outDir = path.resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "baseline-summary.json");
  const mdPath = path.join(outDir, "baseline-summary.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, renderMarkdown(report), "utf8");
  console.log(`Baseline records: ${records.length}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
