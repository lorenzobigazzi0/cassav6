#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

function parseArgs(argv) {
  const parsed = {
    input: path.join(projectRoot, "reports", "runtime-metrics-snapshot.json"),
    outDir: path.join(projectRoot, "reports"),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--input") { parsed.input = path.resolve(String(argv[index + 1] ?? parsed.input)); index += 1; }
    else if (arg.startsWith("--input=")) parsed.input = path.resolve(arg.slice("--input=".length));
    else if (arg === "--out-dir") { parsed.outDir = path.resolve(String(argv[index + 1] ?? parsed.outDir)); index += 1; }
    else if (arg.startsWith("--out-dir=")) parsed.outDir = path.resolve(arg.slice("--out-dir=".length));
  }
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/analyze-dirty-tracking-snapshot.mjs --input reports/runtime-metrics-snapshot.json --out-dir reports

Legge uno snapshot prodotto da scripts/collect-runtime-metrics.mjs e genera:
  reports/dirty-tracking-summary.json
  reports/dirty-tracking-summary.md
`);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function topHistogramEntries(entries = {}, limit = 20) {
  return Object.entries(asObject(entries))
    .map(([label, metric]) => ({
      label,
      count: Math.max(0, Math.trunc(Number(metric?.count) || 0)),
      p95: Math.max(0, Math.trunc(Number(metric?.p95) || 0)),
      p99: Math.max(0, Math.trunc(Number(metric?.p99) || 0)),
      max: Math.max(0, Math.trunc(Number(metric?.max) || 0)),
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || b.p99 - a.p99 || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export function buildDirtyTrackingSummary(snapshot = {}) {
  const counters = asObject(snapshot.counters);
  const dirty = asObject(asObject(snapshot.appState).dirtyTracking);
  const recentSamples = asArray(dirty.recentSamples);
  const missingSamples = recentSamples.filter((sample) => asArray(sample.missingDeclaredDomains).length > 0);
  const fullFallbackCount = Math.max(0, Math.trunc(Number(counters.writeDbFullStateFallback) || 0));
  const observations = Math.max(0, Math.trunc(Number(counters.appStateDirtyTrackingObservations) || 0));
  const missing = Math.max(0, Math.trunc(Number(counters.appStateDirtyTrackingMissing) || 0));
  return {
    generatedAt: new Date().toISOString(),
    sourceGeneratedAtMs: Math.max(0, Math.trunc(Number(snapshot.generatedAtMs) || 0)),
    observations,
    missingDeclarations: missing,
    overDeclared: Math.max(0, Math.trunc(Number(counters.appStateDirtyTrackingOverDeclared) || 0)),
    fullFallbackCount,
    missingRatePct: observations > 0 ? Math.round((missing / observations) * 10_000) / 100 : 0,
    topObservationLabels: topHistogramEntries(dirty.observationsByLabel, 20),
    topMissingLabels: topHistogramEntries(dirty.missingByLabel, 20),
    changedDomainHistogram: dirty.changedDomains ?? null,
    declaredDomainHistogram: dirty.declaredDomains ?? null,
    recentMissingSamples: missingSamples.slice(-20),
  };
}

function mdTable(rows, columns) {
  if (!rows.length) return "_Nessun dato._\n";
  const header = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((col) => String(row[col] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
  return `${[header, sep, ...body].join("\n")}\n`;
}

export function toMarkdown(summary) {
  const lines = [
    "# Dirty tracking shadow summary",
    "",
    `Generato: ${summary.generatedAt}`,
    "",
    "## Sintesi",
    "",
    `- Osservazioni: ${summary.observations}`,
    `- Missing declarations: ${summary.missingDeclarations}`,
    `- Over-declared: ${summary.overDeclared}`,
    `- Missing rate: ${summary.missingRatePct}%`,
    `- Full-state fallback count: ${summary.fullFallbackCount}`,
    "",
    "## Top label osservate",
    "",
    mdTable(summary.topObservationLabels, ["label", "count", "p95", "p99", "max"]),
    "",
    "## Top label con domini non dichiarati",
    "",
    mdTable(summary.topMissingLabels, ["label", "count", "p95", "p99", "max"]),
    "",
    "## Campioni recenti con missing declarations",
    "",
  ];
  if (!summary.recentMissingSamples.length) {
    lines.push("_Nessun campione recente con missing declarations._");
  } else {
    for (const sample of summary.recentMissingSamples) {
      lines.push(
        `- ${sample.label}: missing=${asArray(sample.missingDeclaredDomains).join(",") || "-"}; declared=${asArray(sample.declaredDomains).join(",") || "-"}; changed=${asArray(sample.changedDomains).join(",") || "-"}`,
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  let snapshot;
  try {
    snapshot = JSON.parse(await fs.readFile(options.input, "utf8"));
  } catch (error) {
    console.error(`[dirty-tracking] impossibile leggere ${options.input}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const summary = buildDirtyTrackingSummary(snapshot);
  await fs.mkdir(options.outDir, { recursive: true });
  await fs.writeFile(path.join(options.outDir, "dirty-tracking-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(options.outDir, "dirty-tracking-summary.md"), toMarkdown(summary), "utf8");
  console.log(`[dirty-tracking] report scritto in ${options.outDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
