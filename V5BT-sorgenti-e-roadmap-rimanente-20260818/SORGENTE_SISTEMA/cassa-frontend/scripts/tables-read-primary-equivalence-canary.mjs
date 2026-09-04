import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  closeRelationalConnection,
  openRelationalConnection,
  TablesBillsRelationalRepository,
} from "../backend/db/relational/index.js";

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
  frontendOrigin: envString("TABLE_READ_AUDIT_FRONTEND_ORIGIN", "https://127.0.0.1:5280").replace(/\/+$/, ""),
  relationalDbPath: envString("TABLE_READ_AUDIT_RELATIONAL_DB_PATH", "/var/lib/cassav4/backend-relational.sqlite"),
  sampleTables: Math.trunc(envNumber("TABLE_READ_AUDIT_SAMPLE_TABLES", 8, { min: 1, max: 40 })),
  reportRoot: envString("TABLE_READ_AUDIT_REPORT_ROOT", path.join(cassaRoot, "reports")),
  insecureTls: String(process.env.TABLE_READ_AUDIT_INSECURE_TLS ?? "1") !== "0",
};

if (options.insecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const runId = envString(
  "TABLE_READ_AUDIT_RUN_ID",
  `tables_read_primary_equivalence_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`,
);

function round(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function cents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.round(numeric * 100));
}

function occupancyFromStatus(status) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "free") return "free";
  if (normalized === "reserved") return "reserved";
  return "seated";
}

async function requestJson(pathname) {
  const startedAt = performance.now();
  const response = await fetch(`${options.frontendOrigin}${pathname}`, {
    headers: { Accept: "application/json" },
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
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    durationMs: round(performance.now() - startedAt),
    body,
  };
}

async function readRelationalTables() {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: options.relationalDbPath,
  });
  if (!db) throw new Error("relational db unavailable");
  try {
    const repository = new TablesBillsRelationalRepository(db);
    return repository.listTableStates();
  } finally {
    closeRelationalConnection(db);
  }
}

function compareTable(layoutTable, relationalTable) {
  if (!relationalTable) {
    return {
      id: layoutTable.id,
      severity: "error",
      field: "missing",
      layout: true,
      relational: false,
    };
  }
  const checks = [];
  const layoutOccupancy = String(layoutTable.occupancyState ?? "").trim();
  const relationalOccupancy = occupancyFromStatus(relationalTable.status);
  if (String(layoutTable.roomId ?? "") !== String(relationalTable.roomId ?? "")) {
    checks.push({
      id: layoutTable.id,
      severity: "error",
      field: "roomId",
      layout: layoutTable.roomId ?? "",
      relational: relationalTable.roomId ?? "",
    });
  }
  if (layoutOccupancy && layoutOccupancy !== relationalOccupancy) {
    checks.push({
      id: layoutTable.id,
      severity: "error",
      field: "occupancyState",
      layout: layoutOccupancy,
      relational: relationalOccupancy,
      relationalStatus: relationalTable.status ?? "",
    });
  }
  const layoutCovers = Math.max(0, Math.trunc(Number(layoutTable.covers) || 0));
  const relationalCovers = Math.max(0, Math.trunc(Number(relationalTable.covers) || 0));
  if (layoutCovers !== relationalCovers) {
    checks.push({
      id: layoutTable.id,
      severity: "warn",
      field: "covers",
      layout: layoutCovers,
      relational: relationalCovers,
    });
  }
  const layoutDueCents = cents(layoutTable.amountDue);
  const relationalDueCents = Math.max(0, Math.trunc(Number(relationalTable.totalDueCents) || 0));
  if (Math.abs(layoutDueCents - relationalDueCents) > 1) {
    checks.push({
      id: layoutTable.id,
      severity: "error",
      field: "amountDueCents",
      layout: layoutDueCents,
      relational: relationalDueCents,
    });
  }
  return checks;
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

  const lines = [
    "# Tables Read-Primary Equivalence Canary",
    "",
    `Run: \`${runId}\``,
    `Frontend: \`${options.frontendOrigin}\``,
    `Relational DB: \`${options.relationalDbPath}\``,
    `Started: ${result.startedAtIso}`,
    `Finished: ${result.finishedAtIso}`,
    `Duration: ${result.durationMs} ms`,
    `Verdict: **${result.evaluation.passed ? "PASS" : "FAIL"}**`,
    "",
    "## Summary",
    "",
    markdownTable([result.summary], [
      { title: "Layout tables", value: (row) => row.layoutTables },
      { title: "Relational tables", value: (row) => row.relationalTables },
      { title: "Errors", value: (row) => row.errors },
      { title: "Warnings", value: (row) => row.warnings },
      { title: "Scoped samples OK", value: (row) => row.scopedSamplesOk },
    ]),
    "",
  ];
  if (result.differences.length) {
    lines.push("## Differences", "");
    lines.push(markdownTable(result.differences.slice(0, 80), [
      { title: "Severity", value: (row) => row.severity },
      { title: "Table", value: (row) => row.id },
      { title: "Field", value: (row) => row.field },
      { title: "Layout", value: (row) => row.layout },
      { title: "Relational", value: (row) => row.relational },
    ]));
    lines.push("");
  }
  if (result.scopedSamples.length) {
    lines.push("## Scoped Samples", "");
    lines.push(markdownTable(result.scopedSamples, [
      { title: "Type", value: (row) => row.type },
      { title: "Id", value: (row) => row.id },
      { title: "Status", value: (row) => row.status },
      { title: "Source", value: (row) => row.source },
      { title: "OK", value: (row) => row.ok },
    ]));
    lines.push("");
  }
  await fs.writeFile(path.join(reportDir, "REPORT.md"), `${lines.join("\n")}\n`);
  return reportDir;
}

async function main() {
  console.log(`[tables-read-audit] run=${runId} frontend=${options.frontendOrigin}`);
  const startedAt = performance.now();
  const result = {
    runId,
    startedAtIso: new Date().toISOString(),
    options,
  };

  const layoutResponse = await requestJson(`/api/integration/layout?_=${Date.now()}`);
  if (layoutResponse.status !== 200 || !Array.isArray(layoutResponse.body?.tables)) {
    throw new Error(`layout unavailable: ${layoutResponse.status}`);
  }
  const layoutTables = layoutResponse.body.tables;
  const relationalTables = await readRelationalTables();
  const relationalById = new Map(relationalTables.map((table) => [String(table.id ?? table.tableId ?? "").trim(), table]));

  const differences = [];
  for (const table of layoutTables) {
    const id = String(table?.id ?? "").trim();
    if (!id) continue;
    const comparison = compareTable(table, relationalById.get(id));
    if (Array.isArray(comparison)) differences.push(...comparison);
    else differences.push(comparison);
  }
  for (const table of relationalTables) {
    const id = String(table?.id ?? table?.tableId ?? "").trim();
    if (id && !layoutTables.some((layoutTable) => String(layoutTable?.id ?? "").trim() === id)) {
      differences.push({
        id,
        severity: "warn",
        field: "extraRelationalTable",
        layout: false,
        relational: true,
      });
    }
  }

  const scopedSamples = [];
  const sampleLayoutTables = layoutTables
    .filter((table) => table?.id && table?.roomId && !String(table.roomId).toLowerCase().includes("attesa"))
    .slice(0, options.sampleTables);
  for (const table of sampleLayoutTables) {
    const tableResponse = await requestJson(`/api/tables/${encodeURIComponent(table.id)}`);
    scopedSamples.push({
      type: "table",
      id: table.id,
      status: tableResponse.status,
      source: tableResponse.body?.meta?.source ?? "",
      ok: tableResponse.status === 200 && String(tableResponse.body?.table?.id ?? "") === String(table.id),
    });
  }
  for (const roomId of [...new Set(sampleLayoutTables.map((table) => String(table.roomId ?? "").trim()).filter(Boolean))]) {
    const roomResponse = await requestJson(`/api/rooms/${encodeURIComponent(roomId)}/tables`);
    scopedSamples.push({
      type: "room",
      id: roomId,
      status: roomResponse.status,
      source: roomResponse.body?.meta?.source ?? "",
      ok: roomResponse.status === 200 && Array.isArray(roomResponse.body?.tables),
    });
  }

  const errors = differences.filter((entry) => entry.severity === "error");
  const warnings = differences.filter((entry) => entry.severity !== "error");
  const scopedSamplesOk = scopedSamples.filter((entry) => entry.ok === true).length;
  result.layout = {
    status: layoutResponse.status,
    durationMs: layoutResponse.durationMs,
  };
  result.summary = {
    layoutTables: layoutTables.length,
    relationalTables: relationalTables.length,
    errors: errors.length,
    warnings: warnings.length,
    scopedSamplesOk: `${scopedSamplesOk}/${scopedSamples.length}`,
  };
  result.differences = differences;
  result.scopedSamples = scopedSamples;
  result.evaluation = {
    passed: errors.length === 0 && scopedSamplesOk === scopedSamples.length,
    checks: {
      layoutAvailable: layoutResponse.status === 200,
      relationalRowsCoverLayout: layoutTables.length > 0 && errors.filter((entry) => entry.field === "missing").length === 0,
      noCriticalDifferences: errors.length === 0,
      scopedSamplesOk: scopedSamplesOk === scopedSamples.length,
    },
  };
  result.finishedAtIso = new Date().toISOString();
  result.durationMs = round(performance.now() - startedAt);

  const reportDir = await writeReport(result);
  console.log(`[tables-read-audit] ${result.evaluation.passed ? "PASS" : "FAIL"} report=${reportDir}`);
  if (!result.evaluation.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[tables-read-audit] errore: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
