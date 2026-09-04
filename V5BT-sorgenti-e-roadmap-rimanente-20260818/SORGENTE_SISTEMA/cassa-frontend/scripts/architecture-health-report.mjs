import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRouteRegistry } from "../backend/routes/index.js";
import {
  RELATIONAL_DOMAINS,
  RELATIONAL_READ_PRIMARY_DOMAINS,
} from "../backend/db/persistence-mode.js";
import { RELATIONAL_MIGRATIONS } from "../backend/db/relational/migrations.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const sourceRoot = path.resolve(cassaRoot, "..");
const backendRoot = path.join(cassaRoot, "backend");
const docsDir = path.join(sourceRoot, "docs", "architecture");

const VERSION = "v4.1.0";
const generatedAt = new Date().toISOString();

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".html",
  ".json",
  ".md",
  ".sql",
]);

const SOURCE_EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "logs",
  "screenshots",
  "test-results",
  "playwright-report",
  ".print-spool",
  ".git",
  ".gradle",
]);

const CODE_SCAN_ROOTS = [
  "cassa-frontend/backend/core",
  "cassa-frontend/backend/modules",
  "cassa-frontend/backend/db",
  "cassa-frontend/backend/routes",
  "cassa-frontend/backend/server.js",
  "cassa-frontend/backend/lib",
  "settings-frontend/dist/assets/settings-app.js",
  "mobile-frontend/src",
  "mobile-frontend/public",
  "postazione/src",
  "postazione/public",
  "serve-frontends.mjs",
];

function toRel(filePath) {
  return path.relative(sourceRoot, filePath).split(path.sep).join("/");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort((a, b) => String(a).localeCompare(String(b)));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function lineCount(filePath) {
  const text = await readText(filePath);
  if (!text) return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

async function walkFiles(root, options = {}) {
  const files = [];
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : Infinity;
  const excludedDirs = options.excludedDirs ?? SOURCE_EXCLUDED_DIRS;
  const includeFile = options.includeFile ?? (() => true);

  async function walk(current, depth) {
    if (depth > maxDepth) return;
    const stat = await fs.stat(current).catch(() => null);
    if (!stat) return;
    if (stat.isFile()) {
      if (includeFile(current)) files.push(current);
      return;
    }
    if (!stat.isDirectory()) return;
    const base = path.basename(current);
    if (depth > 0 && excludedDirs.has(base)) return;
    const entries = await fs.readdir(current);
    for (const entry of entries) {
      await walk(path.join(current, entry), depth + 1);
    }
  }

  await walk(root, 0);
  return files.sort((a, b) => toRel(a).localeCompare(toRel(b)));
}

async function listExistingScanFiles() {
  const output = [];
  for (const relRoot of CODE_SCAN_ROOTS) {
    const root = path.join(sourceRoot, relRoot);
    if (!(await exists(root))) continue;
    const stat = await fs.stat(root);
    if (stat.isFile()) {
      output.push(root);
      continue;
    }
    const files = await walkFiles(root, {
      includeFile(filePath) {
        const ext = path.extname(filePath);
        if (![".js", ".mjs", ".ts", ".tsx", ".json"].includes(ext)) return false;
        const rel = toRel(filePath);
        return !rel.includes("/tests/") && !rel.includes("/node_modules/");
      },
    });
    output.push(...files);
  }
  return uniqueSorted(output.map(toRel)).map((rel) => path.join(sourceRoot, rel));
}

async function collectSourceMetrics() {
  const sourceFiles = await walkFiles(sourceRoot, {
    includeFile(filePath) {
      const ext = path.extname(filePath);
      if (!SOURCE_EXTENSIONS.has(ext)) return false;
      const rel = toRel(filePath);
      if (rel.includes("/node_modules/") || rel.includes("/dist/")) return false;
      if (rel.includes("/logs/") || rel.includes("/screenshots/")) return false;
      if (/app-state\..*\.json$/.test(path.basename(filePath))) return false;
      return true;
    },
  });

  const serverPath = path.join(backendRoot, "server.js");
  const serverText = await readText(serverPath);
  const serverNamedFunctions = (serverText.match(/\b(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*\(/g) ?? []).length;
  const serverArrowFunctions = (serverText.match(/\b(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g) ?? []).length;
  const serverLongFunctionHints = (serverText.match(/\n(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*\(/g) ?? []).length;

  const backendTestCount = (await walkFiles(path.join(backendRoot, "tests"), {
    includeFile: (filePath) => filePath.endsWith(".mjs"),
  })).length;

  const packageFiles = await walkFiles(sourceRoot, {
    includeFile: (filePath) => path.basename(filePath) === "package.json",
  });

  return {
    sourceFilesWithoutRuntime: sourceFiles.length,
    packageFiles: packageFiles.map(toRel),
    backend: {
      serverLines: await lineCount(serverPath),
      serverNamedFunctionDeclarations: serverNamedFunctions,
      serverArrowFunctionDeclarationsApprox: serverArrowFunctions,
      serverFunctionHintsApprox: serverLongFunctionHints,
      backendTestFiles: backendTestCount,
    },
  };
}

async function collectModuleInventory() {
  const modulesRoot = path.join(backendRoot, "modules");
  const moduleNames = (await fs.readdir(modulesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const modules = [];
  for (const name of moduleNames) {
    const moduleDir = path.join(modulesRoot, name);
    const files = await walkFiles(moduleDir, {
      maxDepth: 2,
      includeFile: (filePath) => [".js", ".mjs", ".md"].includes(path.extname(filePath)),
    });
    const relFiles = files.map(toRel);
    modules.push({
      name,
      fileCount: files.length,
      hasRoutes: relFiles.some((file) => file.endsWith(".routes.js")),
      hasHandlers: relFiles.some((file) => file.endsWith(".handlers.js")),
      hasDomain: relFiles.some((file) => file.endsWith(".domain.js")),
      hasService: relFiles.some((file) => file.endsWith(".service.js")),
      hasRepository: relFiles.some((file) => file.includes(".repository.js") || file.includes(".repo.js")),
      hasStateMachine: relFiles.some((file) => file.includes("state-machine")),
      hasGateway: relFiles.some((file) => file.includes(".gateway.js")),
      files: relFiles,
    });
  }

  return {
    count: modules.length,
    modules,
  };
}

async function routeSourceMap(handlerKeys) {
  const routeFiles = [
    path.join(backendRoot, "routes", "index.js"),
    ...(await walkFiles(path.join(backendRoot, "modules"), {
      maxDepth: 3,
      includeFile: (filePath) => filePath.endsWith(".routes.js"),
    })),
  ];
  const sources = new Map();
  const routeTexts = [];
  for (const filePath of routeFiles) {
    routeTexts.push({ filePath, text: await readText(filePath) });
  }
  for (const handlerKey of handlerKeys) {
    const pattern = new RegExp(`["']${escapeRegExp(handlerKey)}["']`);
    const matches = routeTexts
      .filter(({ text }) => pattern.test(text))
      .map(({ filePath }) => toRel(filePath));
    sources.set(handlerKey, matches);
  }
  return sources;
}

function policyLabel(route) {
  if (route.public === true) return "public";
  if (route.debug === true) return `debug:${route.permission ?? ""}`;
  if (route.admin === true) return "admin";
  if (route.service) return `service:${route.service}`;
  if (route.permission) return `permission:${route.permission}`;
  if (route.authRequired === true) return "authenticated";
  return "unspecified";
}

async function collectRouteMap() {
  const routes = buildRouteRegistry();
  const handlerKeys = uniqueSorted(routes.map((route) => route.handlerKey).filter(Boolean));
  const sources = await routeSourceMap(handlerKeys);

  const routeMap = routes.map((route) => {
    const sourceFiles = sources.get(route.handlerKey) ?? [];
    const directRootRegistry = sourceFiles.length === 1 && sourceFiles[0] === "cassa-frontend/backend/routes/index.js";
    return {
      method: route.method,
      path: route.path,
      handlerKey: route.handlerKey,
      mutation: route.mutation,
      policy: policyLabel(route),
      sourceFiles,
      directRootRegistry,
      publicMutation: route.public === true && route.mutation === true,
      nonGetReadOnly:
        !["GET", "HEAD", "OPTIONS"].includes(String(route.method).toUpperCase()) &&
        route.mutation === false,
      maxBodySize: route.maxBodySize ?? null,
    };
  });

  const byMethod = {};
  const byPolicy = {};
  const byMutation = { mutative: 0, readOnly: 0 };
  for (const route of routeMap) {
    byMethod[route.method] = (byMethod[route.method] ?? 0) + 1;
    byPolicy[route.policy] = (byPolicy[route.policy] ?? 0) + 1;
    byMutation[route.mutation ? "mutative" : "readOnly"] += 1;
  }

  return {
    summary: {
      totalRoutes: routeMap.length,
      handlerKeys: handlerKeys.length,
      byMethod,
      byPolicy,
      byMutation,
      publicMutations: routeMap.filter((route) => route.publicMutation).length,
      nonGetReadOnly: routeMap.filter((route) => route.nonGetReadOnly).length,
      directRootRegistryRoutes: routeMap.filter((route) => route.directRootRegistry).length,
    },
    routes: routeMap,
    directRootRegistryRoutes: routeMap.filter((route) => route.directRootRegistry),
  };
}

async function collectDbMap() {
  const relationalMigrationFiles = [];
  for (const migration of RELATIONAL_MIGRATIONS) {
    const filePath = path.join(backendRoot, "db", "relational", "migrations", migration.fileName);
    const sql = await readText(filePath);
    const tables = [];
    const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"]?)([A-Za-z0-9_]+)\1/gi;
    let match = null;
    while ((match = tableRegex.exec(sql))) {
      tables.push(match[2]);
    }
    relationalMigrationFiles.push({
      ...migration,
      file: toRel(filePath),
      tables: uniqueSorted(tables),
    });
  }

  const dbFiles = await walkFiles(path.join(backendRoot, "db"), {
    maxDepth: 4,
    includeFile: (filePath) => [".js", ".sql"].includes(path.extname(filePath)),
  });

  const splitRepos = dbFiles
    .map(toRel)
    .filter((file) => file.includes("/app-state/") && file.endsWith(".repository.js"));

  const relationalRepos = dbFiles
    .map(toRel)
    .filter((file) => file.includes("/relational/") && file.endsWith(".repo.js"));

  const serverText = await readText(path.join(backendRoot, "server.js"));
  const domainDefaultsMatch = serverText.match(/MYSQL_APP_STATE_DOMAIN_DEFAULTS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\);/);
  const mysqlAppStateDomainDefaults = domainDefaultsMatch
    ? uniqueSorted(Array.from(domainDefaultsMatch[1].matchAll(/["']([^"']+)["']/g)).map((entry) => entry[1]))
    : [];

  const splitModeEnvVars = uniqueSorted(
    Array.from(serverText.matchAll(/process\.env\.(BACKEND_[A-Z0-9_]*(?:SPLIT|TABLE_LOCKS|APP_STATE)[A-Z0-9_]*)/g)).map(
      (entry) => entry[1],
    ),
  );

  return {
    relationalDomains: Array.from(RELATIONAL_DOMAINS),
    relationalReadPrimaryDomains: Array.from(RELATIONAL_READ_PRIMARY_DOMAINS),
    relationalMigrations: relationalMigrationFiles,
    relationalRepos,
    splitRepos,
    mysqlAppStateDomainDefaults,
    splitModeEnvVars,
  };
}

function categorizeEnvVar(name) {
  if (name.includes("MYSQL") || name.includes("DB") || name.includes("RELATIONAL")) return "db";
  if (name.includes("FISCAL")) return "fiscal";
  if (name.includes("AUTOMATIC_CASH")) return "automatic-cash";
  if (name.includes("PRINT") || name.includes("PRINTER") || name.includes("CUPS")) return "printing";
  if (name.includes("BATTERY")) return "battery";
  if (name.includes("RADIO")) return "radio";
  if (name.includes("SESSION") || name.includes("TOKEN") || name.includes("AUTH")) return "auth-session";
  if (name.includes("HOST") || name.includes("PORT") || name.includes("URL")) return "network";
  return "other";
}

async function collectConfigSurface() {
  const files = await listExistingScanFiles();
  const envUsage = new Map();
  const ipRefs = new Map();
  const urlRefs = new Map();

  for (const filePath of files) {
    const rel = toRel(filePath);
    const text = await readText(filePath);
    const lines = text.split("\n");

    for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      const name = match[1];
      const current = envUsage.get(name) ?? { name, category: categorizeEnvVar(name), count: 0, files: new Set() };
      current.count += 1;
      current.files.add(rel);
      envUsage.set(name, current);
    }

    lines.forEach((line, index) => {
      const ips = line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [];
      for (const ip of ips) {
        const entry = ipRefs.get(ip) ?? { ip, count: 0, refs: [] };
        entry.count += 1;
        if (entry.refs.length < 12) {
          entry.refs.push({ file: rel, line: index + 1, text: line.trim().slice(0, 180) });
        }
        ipRefs.set(ip, entry);
      }

      const urls = line.match(/https?:\/\/[A-Za-z0-9._:-]+/g) ?? [];
      for (const url of urls) {
        const entry = urlRefs.get(url) ?? { url, count: 0, refs: [] };
        entry.count += 1;
        if (entry.refs.length < 8) {
          entry.refs.push({ file: rel, line: index + 1, text: line.trim().slice(0, 180) });
        }
        urlRefs.set(url, entry);
      }
    });
  }

  const envVars = Array.from(envUsage.values()).map((entry) => ({
    ...entry,
    files: Array.from(entry.files).sort(),
  }));

  const byCategory = {};
  for (const entry of envVars) {
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
  }

  return {
    envVars: envVars.sort((a, b) => a.name.localeCompare(b.name)),
    envByCategory: byCategory,
    hardcodedIps: Array.from(ipRefs.values()).sort((a, b) => b.count - a.count || a.ip.localeCompare(b.ip)),
    hardcodedUrls: Array.from(urlRefs.values()).sort((a, b) => b.count - a.count || a.url.localeCompare(b.url)),
  };
}

async function collectHistoricalDeviceSnapshot() {
  const appStateFiles = (await fs.readdir(backendRoot))
    .filter((name) => /^app-state\..*\.json$/.test(name))
    .sort((left, right) => {
      const leftTs = left.match(/(\d{14})/)?.[1] ?? "";
      const rightTs = right.match(/(\d{14})/)?.[1] ?? "";
      if (leftTs || rightTs) return leftTs.localeCompare(rightTs);
      return left.localeCompare(right);
    });
  const latest = appStateFiles.at(-1);
  if (!latest) {
    return { source: null, note: "Nessuno snapshot app-state storico trovato." };
  }

  const filePath = path.join(backendRoot, latest);
  try {
    const raw = JSON.parse(await readText(filePath));
    const posSettings = raw.posSettings ?? raw?.data?.posSettings ?? {};
    const automaticCash = posSettings.automaticCash ?? posSettings.automaticCashSettings ?? {};
    return {
      source: toRel(filePath),
      note: "Snapshot storico, non prova di stato live corrente.",
      printers: Array.isArray(posSettings.printers)
        ? posSettings.printers.map((printer) => ({
            id: printer.id ?? null,
            name: printer.name ?? null,
            host: printer.host ?? printer.ip ?? null,
            port: printer.port ?? null,
            purpose: printer.purpose ?? null,
            active: printer.active !== false,
          }))
        : [],
      fiscalDevices: Array.isArray(posSettings.fiscalDevices)
        ? posSettings.fiscalDevices.map((device) => ({
            id: device.id ?? null,
            name: device.name ?? null,
            provider: device.fiscalProvider ?? device.provider ?? null,
            apiBaseUrl: device.apiBaseUrl ?? device.fiscalApiBaseUrl ?? null,
            active: device.active !== false,
          }))
        : [],
      mobileDevicesCount: Array.isArray(posSettings.mobileDevices) ? posSettings.mobileDevices.length : 0,
      mobileDeviceSamples: Array.isArray(posSettings.mobileDevices)
        ? posSettings.mobileDevices.slice(0, 5).map((device) => ({
            id: device.id ?? device.deviceId ?? null,
            name: device.deviceName ?? device.name ?? null,
            fiscalEnabled: device.fiscalEnabled ?? null,
            electronicPaymentEnabled: device.electronicPaymentEnabled ?? null,
            cashPaymentEnabled: device.cashPaymentEnabled ?? null,
          }))
        : [],
      workstationsCount: Array.isArray(posSettings.workstations) ? posSettings.workstations.length : 0,
      workstationSamples: Array.isArray(posSettings.workstations)
        ? posSettings.workstations.slice(0, 8).map((station) => ({
            id: station.id ?? null,
            name: station.name ?? null,
            active: station.active ?? null,
            type: station.type ?? station.kind ?? null,
          }))
        : [],
      automaticCash: {
        enabled: automaticCash.enabled ?? automaticCash.active ?? null,
        gatewayBaseUrl:
          automaticCash.gatewayBaseUrl ??
          automaticCash.apiBaseUrl ??
          automaticCash.baseUrl ??
          automaticCash.gateway?.baseUrl ??
          null,
        mode: automaticCash.autoCashFloatMode ?? automaticCash.mode ?? null,
        hasConfigSet: Boolean(automaticCash.configSet || automaticCash.cashFloatConfigSet || automaticCash.fundConfigurations),
      },
    };
  } catch (error) {
    return {
      source: toRel(filePath),
      note: `Snapshot storico non parsabile: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function collectArchitectureDebt({ sourceMetrics, moduleInventory, routeMap, dbMap, configSurface }) {
  const debts = [];
  const missingModules = ["print-spool", "fiscal-pos", "stations", "realtime", "observability", "adapters"].filter(
    (name) => !moduleInventory.modules.some((module) => module.name === name),
  );
  const directCriticalRoutes = routeMap.directRootRegistryRoutes.filter((route) =>
    /^(payments|fiscal|smart|integration|tables|pos\.roomChange)/.test(route.handlerKey),
  );
  const sourceIps = configSurface.hardcodedIps.filter((entry) => !["127.0.0.1", "0.0.0.0"].includes(entry.ip));
  const hasOutbox = dbMap.relationalMigrations.some((migration) => migration.tables.includes("event_outbox"));
  const hasIdempotency = dbMap.relationalMigrations.some((migration) => migration.tables.includes("idempotency_keys"));

  if (sourceMetrics.backend.serverLines > 15000) {
    debts.push({
      severity: "P1",
      area: "backend-monolith",
      title: "server.js ancora troppo grande",
      evidence: `${sourceMetrics.backend.serverLines} righe in cassa-frontend/backend/server.js.`,
      recommendation: "Continuare estrazione domain/service/handler per pagamenti, ordini, fiscalita', stampa e integration.",
    });
  }

  if (directCriticalRoutes.length > 0) {
    debts.push({
      severity: "P1",
      area: "route-handlers",
      title: "Route critiche ancora dichiarate nel registry root",
      evidence: `${directCriticalRoutes.length} route critiche dirette: ${directCriticalRoutes
        .slice(0, 12)
        .map((route) => route.handlerKey)
        .join(", ")}${directCriticalRoutes.length > 12 ? ", ..." : ""}.`,
      recommendation: "Spostare prima funzioni pure e service, poi handler e route modulari con contratti invariati.",
    });
  }

  if (missingModules.length > 0) {
    debts.push({
      severity: "P1",
      area: "module-boundaries",
      title: "Moduli architetturali target mancanti",
      evidence: `Mancano ancora: ${missingModules.join(", ")}.`,
      recommendation: "Creare prima print-spool/fiscal-pos/realtime come moduli incrementali senza cambiare API.",
    });
  }

  if (!hasOutbox) {
    debts.push({
      severity: "P1",
      area: "db-realtime",
      title: "event_outbox non presente nelle migrazioni relazionali",
      evidence: "Le migrazioni 001-009 non dichiarano una tabella event_outbox.",
      recommendation: "Introdurre outbox transazionale per notifiche, radio, battery, stampa e side effect asincroni.",
    });
  }

  if (!hasIdempotency) {
    debts.push({
      severity: "P1",
      area: "idempotency",
      title: "idempotency_keys non presente nelle migrazioni relazionali",
      evidence: "Le migrazioni 001-009 non dichiarano una tabella idempotency_keys.",
      recommendation: "Centralizzare idempotenza per pagamenti, ordini, fiscalita', cassa automatica e stampa.",
    });
  }

  if (sourceIps.length > 0) {
    debts.push({
      severity: "P2",
      area: "configuration",
      title: "IP operativi ancora presenti nel sorgente",
      evidence: sourceIps
        .slice(0, 6)
        .map((entry) => `${entry.ip} (${entry.count})`)
        .join(", "),
      recommendation: "Spostare gli IP in DB/config effettiva e lasciare nel codice solo fallback di sviluppo dichiarati.",
    });
  }

  return debts;
}

function summarizeTop(items, formatter, limit = 10) {
  return items.slice(0, limit).map(formatter);
}

function renderMarkdown(report) {
  const topHardcodedIps = summarizeTop(
    report.configSurface.hardcodedIps,
    (entry) => `- ${entry.ip}: ${entry.count} occorrenze`,
    8,
  ).join("\n");

  const directRoutes = summarizeTop(
    report.routes.directRootRegistryRoutes,
    (route) => `- ${route.method} ${route.path} -> ${route.handlerKey}`,
    25,
  ).join("\n");

  const debts = report.architectureDebt
    .map(
      (debt) =>
        `### ${debt.severity} - ${debt.title}\n\n` +
        `Area: ${debt.area}\n\n` +
        `Evidenza: ${debt.evidence}\n\n` +
        `Azione: ${debt.recommendation}`,
    )
    .join("\n\n");

  const migrations = report.db.relationalMigrations
    .map((migration) => `- ${migration.version}_${migration.name}: ${migration.tables.join(", ") || "nessuna tabella"}`)
    .join("\n");

  const printers = (report.historicalDeviceSnapshot.printers ?? [])
    .map((printer) => `- ${printer.name || printer.id}: ${printer.host || "-"}:${printer.port || "-"} active=${printer.active}`)
    .join("\n");

  const fiscalDevices = (report.historicalDeviceSnapshot.fiscalDevices ?? [])
    .map((device) => `- ${device.name || device.id}: ${device.apiBaseUrl || "-"} provider=${device.provider || "-"} active=${device.active}`)
    .join("\n");

  return `# Phase 0 Baseline ${VERSION}

Generated at: ${report.generatedAt}

## Scope

- Source root: \`${report.paths.sourceRoot}\`
- Cassa root: \`${report.paths.cassaRoot}\`
- Git status: ${report.git.available ? "available" : `not available (${report.git.error})`}
- Historical device snapshot: ${report.historicalDeviceSnapshot.source || "none"}
- Snapshot note: ${report.historicalDeviceSnapshot.note}

## Metrics

- Source files without runtime/dist/log snapshots: ${report.sourceMetrics.sourceFilesWithoutRuntime}
- Backend server lines: ${report.sourceMetrics.backend.serverLines}
- Backend named function declarations: ${report.sourceMetrics.backend.serverNamedFunctionDeclarations}
- Backend arrow function declarations approx: ${report.sourceMetrics.backend.serverArrowFunctionDeclarationsApprox}
- Backend test files: ${report.sourceMetrics.backend.backendTestFiles}
- Backend modules: ${report.modules.count}
- Route registry entries: ${report.routes.summary.totalRoutes}
- Handler keys in route registry: ${report.routes.summary.handlerKeys}
- Public mutations: ${report.routes.summary.publicMutations}
- Non-GET read-only routes: ${report.routes.summary.nonGetReadOnly}
- Direct root registry routes: ${report.routes.summary.directRootRegistryRoutes}

## Routes

By method:

\`\`\`json
${JSON.stringify(report.routes.summary.byMethod, null, 2)}
\`\`\`

By policy:

\`\`\`json
${JSON.stringify(report.routes.summary.byPolicy, null, 2)}
\`\`\`

Direct root registry routes, first 25:

${directRoutes || "- none"}

Full route map: \`${report.artifacts.routeMap}\`

## DB And Domains

Relational domains:

- ${report.db.relationalDomains.join("\n- ")}

Read-primary domains:

- ${report.db.relationalReadPrimaryDomains.join("\n- ")}

Migrations:

${migrations}

MySQL app-state domain defaults:

- ${report.db.mysqlAppStateDomainDefaults.join("\n- ")}

Split repositories:

- ${report.db.splitRepos.join("\n- ")}

DB/domain map: \`${report.artifacts.dbMap}\`

## Config And Device Surface

Env vars by category:

\`\`\`json
${JSON.stringify(report.configSurface.envByCategory, null, 2)}
\`\`\`

Hardcoded IPs, top:

${topHardcodedIps || "- none"}

Historical printers:

${printers || "- none"}

Historical fiscal devices:

${fiscalDevices || "- none"}

Historical automatic cash:

\`\`\`json
${JSON.stringify(report.historicalDeviceSnapshot.automaticCash ?? {}, null, 2)}
\`\`\`

Config surface map: \`${report.artifacts.configSurface}\`

## Architecture Debt P0/P1/P2

${debts || "Nessun debito architetturale rilevato dallo script."}

## Phase 0 Gate Commands

Run from \`cassa-frontend\`:

\`\`\`bash
npm run check:backend
npm run audit:architecture-security
npm run gate:architecture-security
node --test backend/tests/route-policy-architecture.test.mjs
node --test backend/tests/security-architecture.test.mjs
\`\`\`
`;
}

function collectGitStatus() {
  try {
    const output = execFileSync("git", ["status", "--short"], {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { available: true, statusShort: output.trim().split("\n").filter(Boolean) };
  } catch (error) {
    return {
      available: false,
      error: error?.code === "ENOENT" ? "git command not found" : String(error?.message ?? error),
    };
  }
}

async function main() {
  await fs.mkdir(docsDir, { recursive: true });

  const [
    sourceMetrics,
    moduleInventory,
    routes,
    db,
    configSurface,
    historicalDeviceSnapshot,
  ] = await Promise.all([
    collectSourceMetrics(),
    collectModuleInventory(),
    collectRouteMap(),
    collectDbMap(),
    collectConfigSurface(),
    collectHistoricalDeviceSnapshot(),
  ]);

  const report = {
    version: VERSION,
    generatedAt,
    paths: {
      sourceRoot,
      cassaRoot,
      backendRoot,
    },
    git: collectGitStatus(),
    sourceMetrics,
    modules: moduleInventory,
    routes,
    db,
    configSurface,
    historicalDeviceSnapshot,
    architectureDebt: [],
    artifacts: {
      reportMarkdown: `docs/architecture/PHASE0_BASELINE_${VERSION}.md`,
      fullJson: `docs/architecture/phase0-baseline-${VERSION}.json`,
      routeMap: `docs/architecture/route-map-${VERSION}.json`,
      dbMap: `docs/architecture/db-domain-map-${VERSION}.json`,
      configSurface: `docs/architecture/config-surface-${VERSION}.json`,
    },
  };
  report.architectureDebt = collectArchitectureDebt({
    sourceMetrics,
    moduleInventory,
    routeMap: routes,
    dbMap: db,
    configSurface,
  });

  await fs.writeFile(
    path.join(docsDir, `route-map-${VERSION}.json`),
    JSON.stringify(routes, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(docsDir, `db-domain-map-${VERSION}.json`),
    JSON.stringify(db, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(docsDir, `config-surface-${VERSION}.json`),
    JSON.stringify(
      {
        configSurface,
        historicalDeviceSnapshot,
      },
      null,
      2,
    ) + "\n",
  );
  await fs.writeFile(
    path.join(docsDir, `phase0-baseline-${VERSION}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
  await fs.writeFile(path.join(docsDir, `PHASE0_BASELINE_${VERSION}.md`), renderMarkdown(report));

  console.log(JSON.stringify({
    ok: true,
    version: VERSION,
    generatedAt,
    report: report.artifacts.reportMarkdown,
    routes: routes.summary.totalRoutes,
    modules: moduleInventory.count,
    serverLines: sourceMetrics.backend.serverLines,
    architectureDebt: report.architectureDebt.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
