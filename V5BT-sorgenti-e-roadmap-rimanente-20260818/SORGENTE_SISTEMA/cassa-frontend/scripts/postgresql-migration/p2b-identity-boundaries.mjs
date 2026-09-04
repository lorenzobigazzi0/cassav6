import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const IDENTITY_BOUNDARIES = Object.freeze([
  {
    method: "POST",
    route: "/api/auth/login",
    handlerKey: "auth.login",
    functionName: "handleLogin",
    sourceFile: "backend/auth/auth.handlers.js",
    domain: "identity",
    reads: ["users", "sessions", "posSettings", "meta"],
    writes: ["users", "sessions", "auditEvents", "meta"],
    crossDomainDependencies: ["audit", "pos-settings/workstations", "redis/session-cache", "notifications"],
    // P2b: lettura, i due intenti di fallimento e la scrittura di sessione passano
    // dal write model iniettato backend/auth/login-write-model.js.
    directReadDbExpected: 0,
    directWriteDbExpected: 0,
  },
  {
    method: "POST",
    route: "/api/auth/logout",
    handlerKey: "auth.logout",
    functionName: "handleLogout",
    sourceFile: "backend/auth/auth.handlers.js",
    domain: "identity",
    reads: ["users", "sessions", "integration.stationStates"],
    writes: ["sessions", "integration", "auditEvents", "meta"],
    crossDomainDependencies: ["audit", "integration/station-presence", "notifications", "redis/session-cache"],
    // P2b: lettura, i tre rami di scrittura e i publish di handoff passano dal
    // write model iniettato backend/auth/logout-write-model.js.
    directReadDbExpected: 0,
    directWriteDbExpected: 0,
  },
  {
    method: "POST",
    route: "/api/auth/session/status",
    handlerKey: "auth.sessionStatus",
    functionName: "handleAuthSessionStatus",
    sourceFile: "backend/auth/auth.handlers.js",
    domain: "identity",
    reads: ["users", "sessions", "integration.stationStates"],
    writes: ["sessions", "integration.stationStates", "meta"],
    crossDomainDependencies: ["integration/station-presence", "redis/session-cache"],
    // P2b: lettura, heartbeat, fast writer puntuali e fallback passano dal
    // write model iniettato backend/auth/session-status-write-model.js.
    directReadDbExpected: 0,
    directWriteDbExpected: 0,
  },
  {
    method: "POST",
    route: "/api/auth/workstation/select",
    handlerKey: "auth.selectWorkstation",
    functionName: "handleSelectWorkstation",
    sourceFile: "backend/auth/auth.handlers.js",
    domain: "identity",
    reads: ["users", "sessions", "posSettings"],
    writes: ["sessions", "auditEvents", "meta"],
    crossDomainDependencies: ["audit", "pos-settings/workstations", "redis/session-cache"],
    // P2b: lettura, doppio percorso di scrittura e cache Redis passano dal write
    // model iniettato backend/auth/select-workstation-write-model.js.
    directReadDbExpected: 0,
    directWriteDbExpected: 0,
  },
  {
    method: "POST",
    route: "/api/auth/change-pin",
    handlerKey: "auth.changePin",
    functionName: "handleChangePin",
    sourceFile: "backend/auth/auth.handlers.js",
    domain: "identity",
    reads: ["users", "sessions"],
    writes: ["users", "auditEvents", "meta"],
    crossDomainDependencies: ["audit"],
    // P2b.4: lettura e i due intenti di scrittura passano dal write model
    // iniettato backend/auth/change-pin-write-model.js.
    directReadDbExpected: 0,
    directWriteDbExpected: 0,
  },
  {
    method: "POST",
    route: "/api/settings/pos/users",
    handlerKey: "users.list",
    functionName: "handlePosSettingsUsers",
    sourceFile: "backend/users/users.handlers.js",
    domain: "identity",
    reads: ["users", "sessions", "userGroups", "posSettings", "meta"],
    writes: [],
    crossDomainDependencies: ["pos-settings", "permissions"],
    // P2b.3: la lettura passa dal reader iniettato backend/users/users-list-read-model.js.
    directReadDbExpected: 0,
    directWriteDbExpected: 0,
  },
  {
    method: "POST",
    route: "/api/settings/pos/users/save",
    handlerKey: "users.save",
    functionName: "handleSavePosSettingsUsers",
    sourceFile: "backend/users/users.handlers.js",
    domain: "identity",
    reads: ["users", "sessions", "userGroups", "posSettings", "meta"],
    writes: ["users", "sessions", "userGroups", "auditEvents", "meta"],
    crossDomainDependencies: ["audit", "pos-settings", "permissions", "redis/session-cache"],
    // P2b: lettura, revoca sessioni, audit e scrittura passano dal write model
    // iniettato backend/users/users-save-write-model.js.
    directReadDbExpected: 0,
    directWriteDbExpected: 0,
  },
]);

function countLines(source) {
  if (!source) return 0;
  const lines = source.split(/\r?\n/);
  return source.endsWith("\n") ? lines.length - 1 : lines.length;
}

function extractFunctionSource(source, functionName) {
  const startPattern = new RegExp(`^\\s*(?:async\\s+)?function\\s+${functionName}\\s*\\(`, "m");
  const match = startPattern.exec(source);
  if (!match) throw new Error(`Funzione identity non trovata: ${functionName}`);
  const tail = source.slice(match.index + match[0].length);
  const nextFunction = /\n\s{2}(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.exec(tail);
  const returnBlock = /\n\s{2}return\s*\{/.exec(tail);
  const candidates = [nextFunction?.index, returnBlock?.index].filter(Number.isInteger);
  const end = candidates.length > 0 ? Math.min(...candidates) : tail.length;
  return source.slice(match.index, match.index + match[0].length + end);
}

function countCall(source, callName) {
  return (source.match(new RegExp(`\\b${callName}\\s*\\(`, "g")) ?? []).length;
}

function assertRouteRegistered(routeRegistrySource, boundary) {
  const routeAt = routeRegistrySource.indexOf(`"${boundary.route}"`);
  if (routeAt < 0) throw new Error(`Route identity non registrata: ${boundary.route}`);
  const nearby = routeRegistrySource.slice(Math.max(0, routeAt - 80), routeAt + 160);
  if (!nearby.includes(`"${boundary.method}"`) || !nearby.includes(`"${boundary.handlerKey}"`)) {
    throw new Error(`Contratto route/handler identity divergente: ${boundary.method} ${boundary.route}`);
  }
}

export function analyzeIdentityPilotSources({ routeRegistrySource, handlerSources, serverSource }) {
  const seenRoutes = new Set();
  const rows = IDENTITY_BOUNDARIES.map((boundary) => {
    const routeId = `${boundary.method} ${boundary.route}`;
    if (seenRoutes.has(routeId)) throw new Error(`Route identity duplicata: ${routeId}`);
    seenRoutes.add(routeId);
    assertRouteRegistered(routeRegistrySource, boundary);

    const source = handlerSources.get(boundary.sourceFile);
    if (typeof source !== "string") throw new Error(`Sorgente identity mancante: ${boundary.sourceFile}`);
    const functionSource = extractFunctionSource(source, boundary.functionName);
    const directReadDb = countCall(functionSource, "readDb");
    const directWriteDb = countCall(functionSource, "writeDb");
    if (directReadDb !== boundary.directReadDbExpected) {
      throw new Error(`${routeId}: readDb attesi ${boundary.directReadDbExpected}, trovati ${directReadDb}`);
    }
    if (directWriteDb !== boundary.directWriteDbExpected) {
      throw new Error(`${routeId}: writeDb attesi ${boundary.directWriteDbExpected}, trovati ${directWriteDb}`);
    }
    if (boundary.reads.length === 0 && boundary.writes.length === 0) {
      throw new Error(`${routeId}: confine app-state non dichiarato`);
    }
    if (boundary.crossDomainDependencies.length === 0) {
      throw new Error(`${routeId}: dipendenze cross-domain non dichiarate`);
    }
    return { ...boundary, directReadDb, directWriteDb };
  });

  const handlerFiles = [...new Set(rows.map((row) => row.sourceFile))];
  return {
    schemaVersion: 1,
    generatedForDate: "2026-09-01",
    status: "P2B_IDENTITY_SEVEN_OF_SEVEN_SCOPED_GATE_MET",
    behaviorChanged: false,
    databaseChanged: false,
    routes: rows,
    metrics: {
      routeCount: rows.length,
      extractedHandlerFileCount: handlerFiles.length,
      extractedHandlerLines: handlerFiles.reduce(
        (total, file) => total + countLines(handlerSources.get(file)),
        0,
      ),
      serverLines: countLines(serverSource),
      directReadDb: rows.reduce((total, row) => total + row.directReadDb, 0),
      directWriteDb: rows.reduce((total, row) => total + row.directWriteDb, 0),
      crossDomainRouteCount: rows.filter((row) => row.crossDomainDependencies.length > 0).length,
    },
    // Gate identity raggiunto: sette route su sette a zero accessi globali.
    // Il seguito e MIG-030, che estende l'inventario dei confini a tutte le route.
    nextGate: "MIG-030: inventario confini route -> dominio su tutte le route, non solo identity",
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildIdentityBoundariesCsv(report) {
  const header = [
    "route",
    "domain",
    "app_state_reads",
    "app_state_writes",
    "cross_domain_dependencies",
    "handler",
    "source_file",
    "direct_readDb",
    "direct_writeDb",
  ];
  const lines = report.routes.map((row) =>
    [
      `${row.method} ${row.route}`,
      row.domain,
      row.reads.join("|"),
      row.writes.join("|"),
      row.crossDomainDependencies.join("|"),
      row.functionName,
      row.sourceFile,
      row.directReadDb,
      row.directWriteDb,
    ].map(csvCell).join(","),
  );
  return `${header.map(csvCell).join(",")}\n${lines.join("\n")}\n`;
}

export function buildIdentityPilotReport(appRoot = APP_ROOT) {
  const handlerFiles = [...new Set(IDENTITY_BOUNDARIES.map((row) => row.sourceFile))];
  const handlerSources = new Map(
    handlerFiles.map((file) => [file, readFileSync(resolve(appRoot, file), "utf8")]),
  );
  return analyzeIdentityPilotSources({
    routeRegistrySource: readFileSync(resolve(appRoot, "backend/routes/index.js"), "utf8"),
    handlerSources,
    serverSource: readFileSync(resolve(appRoot, "backend/server.js"), "utf8"),
  });
}

export function writeIdentityPilotArtifacts({ appRoot = APP_ROOT, outputDirectory } = {}) {
  const report = buildIdentityPilotReport(appRoot);
  const destination = outputDirectory
    ? resolve(outputDirectory)
    : resolve(appRoot, "reports/postgresql-migration/p2b");
  mkdirSync(destination, { recursive: true });
  const csvPath = resolve(destination, "identity-route-boundaries.csv");
  const jsonPath = resolve(destination, "identity-pilot-baseline-20260901.json");
  writeFileSync(csvPath, buildIdentityBoundariesCsv(report), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return {
    csvPath: relative(appRoot, csvPath).replaceAll("\\", "/"),
    jsonPath: relative(appRoot, jsonPath).replaceAll("\\", "/"),
    report,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = writeIdentityPilotArtifacts();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
