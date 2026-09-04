#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateRouteDefinitions } from "../backend/core/router.js";
import { buildRouteRegistry } from "../backend/routes/index.js";
import { auditRepositoryBoundaries } from "./postgresql-migration/mig022-repository-boundary.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const backendRoot = path.join(cassaRoot, "backend");
const serverPath = path.join(backendRoot, "server.js");

const SERVER_SOFT_LIMIT_LINES = 27_500;
const SERVER_MAX_LINES = 40_500;
const FUNCTION_SOFT_LIMIT_LINES = 800;
const MAX_FUNCTION_LINES = 1_500;
const MIN_MODULE_DIRECTORIES = 10;
const AUTH_STATE_MUTATION_PATHS = new Set([
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/session/status",
]);

const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function routeKey(route) {
  return `${String(route?.method ?? "").toUpperCase()} ${String(route?.path ?? "")}`;
}

function countFunctionLines(source) {
  const lines = source.split(/\r?\n/);
  const functions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(line);
    if (!match) continue;
    let depth = 0;
    let started = false;
    let endIndex = index;
    for (let scan = index; scan < lines.length; scan += 1) {
      for (const char of lines[scan]) {
        if (char === "{") {
          depth += 1;
          started = true;
        } else if (char === "}") {
          depth -= 1;
        }
      }
      if (started && depth <= 0) {
        endIndex = scan;
        break;
      }
    }
    functions.push({ name: match[1], start: index + 1, end: endIndex + 1, lines: endIndex - index + 1 });
  }
  return functions;
}

function listModuleDirectories() {
  const modulesRoot = path.join(backendRoot, "modules");
  try {
    return readdirSync(modulesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("."));
  } catch (error) {
    fail(`backend/modules non leggibile: ${error?.message || error}`);
    return [];
  }
}

function assertRouteContracts(routes) {
  const fakeHandlers = Object.fromEntries(
    routes
      .map((route) => String(route?.handlerKey ?? "").trim())
      .filter(Boolean)
      .map((handlerKey) => [handlerKey, () => {}])
  );
  validateRouteDefinitions(routes, fakeHandlers);

  const publicMutations = [];
  for (const route of routes) {
    const key = routeKey(route);
    if (AUTH_STATE_MUTATION_PATHS.has(key) && route.mutation !== true) {
      fail(`${key} scrive sessioni/audit/heartbeat ma non e marcata mutation:true.`);
    }
    if (route.public === true && route.mutation === true) {
      const reason = String(route.publicReason ?? route.riskAccepted ?? "").trim();
      publicMutations.push(key);
      if (route.allowPublicMutation !== true || reason.length < 12) {
        fail(`${key} e una mutazione pubblica senza accettazione rischio esplicita.`);
      }
      const maxBodySize = Number(route.maxBodySize);
      if (!Number.isFinite(maxBodySize) || maxBodySize <= 0 || maxBodySize > 65_536) {
        fail(`${key} e una mutazione pubblica senza maxBodySize <= 65536.`);
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(String(route.method ?? "").toUpperCase()) && route.mutation === false) {
      const reason = String(route.readOnlyReason ?? route.reason ?? route.note ?? "").trim();
      if (route.readOnly !== true || reason.length < 8) {
        fail(`${key} usa mutation:false su metodo non-GET senza readOnly:true/readOnlyReason.`);
      }
    }
  }

  if (publicMutations.length > 6) {
    fail(`Troppe mutazioni pubbliche (${publicMutations.length}): ${publicMutations.join(", ")}`);
  }
  return { publicMutations };
}

function assertServerBudgets() {
  const source = readFileSync(serverPath, "utf8");
  const lines = source.split(/\r?\n/).length;
  if (lines > SERVER_MAX_LINES) {
    fail(`backend/server.js supera il budget monolite: ${lines} righe > ${SERVER_MAX_LINES}.`);
  } else if (lines > SERVER_SOFT_LIMIT_LINES) {
    warn(`backend/server.js resta monolitico: ${lines} righe > ${SERVER_SOFT_LIMIT_LINES}.`);
  }

  for (const entry of countFunctionLines(source).filter((candidate) => candidate.lines > FUNCTION_SOFT_LIMIT_LINES)) {
    const message = `Funzione grande in server.js: ${entry.name} ${entry.lines} righe (${entry.start}-${entry.end}).`;
    if (entry.lines > MAX_FUNCTION_LINES) {
      fail(`${message} Limite hard ${MAX_FUNCTION_LINES}.`);
    } else {
      warn(`${message} Limite soft ${FUNCTION_SOFT_LIMIT_LINES}.`);
    }
  }

  return { lines, largestFunctions: countFunctionLines(source).sort((a, b) => b.lines - a.lines).slice(0, 5) };
}

function assertCoreSecurityHeaders() {
  const source = readFileSync(path.join(backendRoot, "core", "http.js"), "utf8");
  for (const header of [
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "X-Permitted-Cross-Domain-Policies",
    "Permissions-Policy",
  ]) {
    if (!source.includes(header)) fail(`Header sicurezza mancante in backend/core/http.js: ${header}.`);
  }
}

const routes = buildRouteRegistry();
const routeSummary = assertRouteContracts(routes);
const serverSummary = assertServerBudgets();
assertCoreSecurityHeaders();
const repositoryBoundary = await auditRepositoryBoundaries({ appDir: cassaRoot });
for (const violation of repositoryBoundary.violations) {
  fail(`${violation.code} ${violation.file}:${violation.line}.`);
}
const moduleDirs = listModuleDirectories();
if (moduleDirs.length < MIN_MODULE_DIRECTORIES) {
  fail(`Modularizzazione backend insufficiente: ${moduleDirs.length} moduli < ${MIN_MODULE_DIRECTORIES}.`);
}

const queryAuthSource = readFileSync(serverPath, "utf8");
if (!/const\s+queryToken\s*=\s*ALLOW_AUTH_QUERY_TOKEN\s*\?\s*String\(\s*requestUrl\.searchParams\.get\(\s*["']token["']\s*\)/s.test(queryAuthSource)) {
  fail("Auth token da query string non protetto da ALLOW_AUTH_QUERY_TOKEN.");
}

if (warnings.length > 0) {
  for (const message of warnings) console.warn(`[architecture-security-gate] WARN: ${message}`);
}

if (errors.length > 0) {
  for (const message of errors) console.error(`[architecture-security-gate] FAIL: ${message}`);
  process.exit(1);
}

console.log(
  `[architecture-security-gate] OK: ${routes.length} route, ${moduleDirs.length} moduli, server.js ${serverSummary.lines} righe, mutazioni pubbliche=${routeSummary.publicMutations.length}.`
);
console.log(
  `[architecture-security-gate] repository boundary: ${repositoryBoundary.runtimeFiles} file runtime, `
  + `${repositoryBoundary.violations.length} violazioni.`,
);
console.log(
  `[architecture-security-gate] funzioni maggiori: ${serverSummary.largestFunctions
    .map((entry) => `${entry.name}:${entry.lines}`)
    .join(", ")}.`
);
