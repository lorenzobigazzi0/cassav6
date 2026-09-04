import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRouteRegistry } from "../backend/routes/index.js";
import { createRouteRegistry } from "../backend/core/router.js";
import { auditRepositoryBoundaries } from "./postgresql-migration/mig022-repository-boundary.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const serverPath = path.join(appDir, "backend", "server.js");
const reportPathArgIndex = process.argv.findIndex((arg) => arg === "--report");
const reportPath = reportPathArgIndex >= 0 ? path.resolve(process.argv[reportPathArgIndex + 1] ?? "") : null;

const MONOLITH_SOFT_LIMIT_LINES = 10_000;
const MONOLITH_HARD_LIMIT_LINES = 40_500;
const FUNCTION_SOFT_LIMIT_LINES = 400;
const FUNCTION_HARD_LIMIT_LINES = 1_500;
const PUBLIC_MUTATION_BODY_LIMIT = 65_536;

function routeKey(route) {
  return `${String(route?.method ?? "").toUpperCase()} ${String(route?.path ?? "")}`;
}

function parseLargeFunctions(source) {
  const lines = source.split(/\r?\n/);
  const patterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/,
    /^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/,
  ];
  const functions = [];
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match) {
        functions.push({ name: match[1], line: index + 1 });
        return;
      }
    }
  });
  return functions
    .map((entry, index) => {
      const next = functions[index + 1]?.line ?? lines.length + 1;
      return {
        ...entry,
        lines: next - entry.line,
      };
    })
    .filter((entry) => entry.lines >= FUNCTION_SOFT_LIMIT_LINES)
    .sort((left, right) => right.lines - left.lines);
}

function validatePublicMutationRoutes(routes) {
  const findings = [];
  const publicMutations = routes.filter((route) => route.public === true && route.mutation === true);
  for (const route of publicMutations) {
    const key = routeKey(route);
    const maxBodySize = Number(route.maxBodySize);
    if (route.allowPublicMutation !== true) {
      findings.push({ severity: "P1", message: `${key}: public mutation senza allowPublicMutation:true.` });
    }
    if (typeof route.publicReason !== "string" || route.publicReason.trim().length < 12) {
      findings.push({ severity: "P1", message: `${key}: public mutation senza publicReason operativo.` });
    }
    if (!Number.isFinite(maxBodySize) || maxBodySize <= 0 || maxBodySize > PUBLIC_MUTATION_BODY_LIMIT) {
      findings.push({ severity: "P1", message: `${key}: public mutation senza maxBodySize <= ${PUBLIC_MUTATION_BODY_LIMIT}.` });
    }
  }
  return { publicMutations, findings };
}

function validateRouteRegistry(routes) {
  const findings = [];
  const routeKeys = new Set();
  for (const route of routes) {
    const key = routeKey(route);
    if (routeKeys.has(key)) {
      findings.push({ severity: "P1", message: `${key}: route duplicata.` });
    }
    routeKeys.add(key);
  }
  const publicReads = routes.filter((route) => route.public === true && route.mutation !== true);
  return { findings, publicReads };
}

function formatReport(summary) {
  const lines = [];
  lines.push("# Backend architecture/security audit");
  lines.push("");
  lines.push(`- server.js lines: ${summary.serverLines}`);
  lines.push(`- route totali: ${summary.routeCount}`);
  lines.push(`- route pubbliche read/login: ${summary.publicReadCount}`);
  lines.push(`- route pubbliche mutative: ${summary.publicMutationCount}`);
  lines.push(`- file runtime nel gate repository: ${summary.repositoryBoundary.runtimeFiles}`);
  lines.push(`- violazioni confine SQL/repository: ${summary.repositoryBoundary.violations.length}`);
  lines.push(`- finding bloccanti: ${summary.blockingFindings.length}`);
  lines.push(`- warning architetturali: ${summary.warnings.length}`);
  lines.push("");
  lines.push("## Public mutations approved");
  lines.push("");
  for (const route of summary.publicMutations) {
    lines.push(`- ${routeKey(route)} — maxBodySize=${route.maxBodySize}; reason=${route.publicReason}`);
  }
  if (summary.publicMutations.length === 0) lines.push("- Nessuna.");
  lines.push("");
  lines.push("## Large functions");
  lines.push("");
  for (const fn of summary.largeFunctions.slice(0, 20)) {
    lines.push(`- ${fn.name} (${fn.lines} lines) @ backend/server.js:${fn.line}`);
  }
  if (summary.largeFunctions.length === 0) lines.push("- Nessuna funzione sopra soglia.");
  lines.push("");
  lines.push("## Blocking findings");
  lines.push("");
  for (const finding of summary.blockingFindings) lines.push(`- ${finding.severity}: ${finding.message}`);
  if (summary.blockingFindings.length === 0) lines.push("- Nessuno.");
  lines.push("");
  lines.push("## Warnings");
  lines.push("");
  for (const warning of summary.warnings) lines.push(`- ${warning.severity}: ${warning.message}`);
  if (summary.warnings.length === 0) lines.push("- Nessuno.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const source = await fs.readFile(serverPath, "utf8");
const serverLines = source.split(/\r?\n/).length;
const routes = buildRouteRegistry();
// Re-run core validation with a stub handler map so this script also detects policy regressions.
const handlers = Object.fromEntries(routes.map((route) => [route.handlerKey, () => {}]).filter(([key]) => key));
createRouteRegistry(routes, handlers);

const { publicMutations, findings: mutationFindings } = validatePublicMutationRoutes(routes);
const { findings: routeFindings, publicReads } = validateRouteRegistry(routes);
const largeFunctions = parseLargeFunctions(source);
const warnings = [];
const repositoryBoundary = await auditRepositoryBoundaries({ appDir });
for (const violation of repositoryBoundary.violations) {
  mutationFindings.push({
    severity: "P1",
    message: `${violation.code} ${violation.file}:${violation.line}.`,
  });
}

const forbiddenServerHelperDefinitions = [
  "function safeTokenEquals(",
  "function extractBearerToken(",
  "function readHeaderValue(",
  "function normalizeIpAddress(",
  "function isPrivateNetworkAddress(",
  "async function fetchWithTimeout(",
];
for (const signature of forbiddenServerHelperDefinitions) {
  if (source.includes(signature)) {
    mutationFindings.push({
      severity: "P1",
      message: `${signature} non deve rientrare nel monolite: usare backend/core/security.js.`,
    });
  }
}
if (!source.includes('from "./core/security.js"')) {
  mutationFindings.push({ severity: "P1", message: "backend/server.js deve importare gli helper di sicurezza da backend/core/security.js." });
}
if (!source.includes('from "./core/http-client.js"')) {
  mutationFindings.push({ severity: "P1", message: "backend/server.js deve importare fetchWithTimeout da backend/core/http-client.js." });
}

if (serverLines > MONOLITH_HARD_LIMIT_LINES) {
  mutationFindings.push({ severity: "P1", message: `backend/server.js supera il limite hard di ${MONOLITH_HARD_LIMIT_LINES} righe (${serverLines}).` });
} else if (serverLines > MONOLITH_SOFT_LIMIT_LINES) {
  warnings.push({ severity: "P2", message: `backend/server.js resta monolitico: ${serverLines} righe. Continuare estrazione per domini.` });
}

for (const fn of largeFunctions) {
  if (fn.lines > FUNCTION_HARD_LIMIT_LINES) {
    mutationFindings.push({ severity: "P1", message: `${fn.name} supera ${FUNCTION_HARD_LIMIT_LINES} righe (${fn.lines}) in backend/server.js:${fn.line}.` });
  } else {
    warnings.push({ severity: "P2", message: `${fn.name} e' sopra ${FUNCTION_SOFT_LIMIT_LINES} righe (${fn.lines}) in backend/server.js:${fn.line}.` });
  }
}

const blockingFindings = [...routeFindings, ...mutationFindings].filter((finding) => finding.severity === "P0" || finding.severity === "P1");
const summary = {
  serverLines,
  routeCount: routes.length,
  publicReadCount: publicReads.length,
  publicMutationCount: publicMutations.length,
  publicMutations,
  largeFunctions,
  repositoryBoundary,
  blockingFindings,
  warnings,
};

const report = formatReport(summary);
if (reportPath) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, report, "utf8");
}

process.stdout.write(report);
if (blockingFindings.length > 0) {
  process.exitCode = 1;
}
