/**
 * MIG-030 — inventario dei confini route -> dominio su tutte le route.
 *
 * Il pilot identity (`p2b-identity-boundaries.mjs`) copre sette route su 198.
 * Qui il perimetro e l'intero registry: ogni route deve avere un dominio del
 * vocabolario target e, quando ne tocca altri, la marcatura cross-domain.
 *
 * Due fonti, con ruoli diversi e non intercambiabili:
 *
 * - `route-domain-map.mjs` e la **dichiarazione**, autoritativa perche rivista
 *   da una persona;
 * - `route-source-index.mjs` e l'**analisi statica**, che fa da rete: il gate
 *   fallisce se deduce un accesso all'app-state che la dichiarazione non
 *   prevede. Dichiarare piu di quanto l'analisi deduce e invece legittimo, e
 *   documentato in `note`: l'analisi non attraversa le iniezioni a metodo.
 *
 * Il gate non guarda il comportamento a runtime e non modifica nulla.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ROUTE_BOUNDARY_DECLARATIONS } from "./route-domain-map.mjs";
import { buildRouteSourceIndex, loadBackendSources } from "./route-source-index.mjs";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Vocabolario dei domini: gli schemi target di `02_TARGET_ARCHITECTURE.md`. */
export const ROUTE_DOMAINS = Object.freeze([
  "app_meta",
  "identity",
  "configuration",
  "catalog",
  "inventory",
  "commerce",
  "sales",
  "payments",
  "fiscal",
  "reservations",
  "operations",
  "messaging",
  "crm",
  "audit",
]);

const DOMAIN_SET = new Set(ROUTE_DOMAINS);

/** Route che il dispatch espone tramite un wrapper invece che con un identificatore. */
export const WRAPPED_HANDLERS = Object.freeze({
  "integration.print": "handleIntegrationPrint",
  "integration.notificationAck": "handleIntegrationNotificationAck",
});

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function missingFrom(declared, derived) {
  const known = new Set(declared);
  return derived.filter((entry) => !known.has(entry));
}

export function analyzeRouteBoundaries({ registry, declarations, resolveHandler }) {
  const rows = [];
  const problems = [];
  const seenKeys = new Set();

  for (const route of registry) {
    const handlerKey = route.handlerKey;
    const declaration = declarations[handlerKey];
    if (!declaration) {
      problems.push(`${route.method} ${route.path}: handlerKey ${handlerKey} senza dichiarazione`);
      continue;
    }
    if (!DOMAIN_SET.has(declaration.domain)) {
      problems.push(`${handlerKey}: dominio "${declaration.domain}" fuori dal vocabolario target`);
    }
    for (const domain of declaration.crossDomain ?? []) {
      if (!DOMAIN_SET.has(domain)) {
        problems.push(`${handlerKey}: dominio cross "${domain}" fuori dal vocabolario target`);
      }
      if (domain === declaration.domain) {
        problems.push(`${handlerKey}: dominio primario ripetuto fra i cross-domain`);
      }
    }

    const analysis = resolveHandler(handlerKey);
    const resolution = analysis?.resolution ?? "unresolved";
    if (resolution === "unresolved" && (declaration.note ?? "").length === 0) {
      problems.push(
        `${handlerKey}: route non risolvibile staticamente e priva di nota che giustifichi la dichiarazione`,
      );
    }
    if (resolution === "resolved") {
      const readsMancanti = missingFrom(declaration.reads ?? [], analysis.derivedReads);
      const writesMancanti = missingFrom(declaration.writes ?? [], analysis.derivedWrites);
      if (readsMancanti.length > 0) {
        problems.push(`${handlerKey}: letture dedotte non dichiarate -> ${readsMancanti.join(", ")}`);
      }
      if (writesMancanti.length > 0) {
        problems.push(`${handlerKey}: scritture dedotte non dichiarate -> ${writesMancanti.join(", ")}`);
      }
    }

    seenKeys.add(handlerKey);
    rows.push({
      method: route.method,
      path: route.path,
      handlerKey,
      domain: declaration.domain,
      crossDomain: declaration.crossDomain ?? [],
      legacyStores: declaration.legacyStores ?? [],
      reads: declaration.reads ?? [],
      writes: declaration.writes ?? [],
      mutation: route.mutation === true,
      authRequired: route.authRequired === true,
      permission: route.permission ?? "",
      admin: route.admin === true,
      public: route.public === true,
      service: route.service ?? "",
      resolution,
      sourceFile: analysis?.sourceFile ?? "",
      note: declaration.note ?? "",
    });
  }

  for (const handlerKey of Object.keys(declarations)) {
    if (!seenKeys.has(handlerKey)) {
      problems.push(`${handlerKey}: dichiarazione senza alcuna route registrata`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Confini route non coerenti:\n- ${problems.join("\n- ")}`);
  }

  const domains = {};
  for (const row of rows) domains[row.domain] = (domains[row.domain] ?? 0) + 1;

  return {
    schemaVersion: 1,
    generatedForDate: "2026-09-02",
    status: "MIG030_ROUTE_BOUNDARIES_DECLARED",
    behaviorChanged: false,
    databaseChanged: false,
    routes: rows,
    metrics: {
      routeCount: rows.length,
      handlerKeyCount: seenKeys.size,
      domainCount: Object.keys(domains).length,
      routesPerDomain: domains,
      crossDomainRouteCount: rows.filter((row) => row.crossDomain.length > 0).length,
      legacyStoreRouteCount: rows.filter((row) => row.legacyStores.length > 0).length,
      unresolvedRouteCount: rows.filter((row) => row.resolution !== "resolved").length,
      mutationRouteCount: rows.filter((row) => row.mutation).length,
      appStateWritingRouteCount: rows.filter((row) => row.writes.length > 0).length,
    },
    nextGate: "MIG-031: estrazione delle route senza logica da server.js, sotto 25.000 righe",
  };
}

export function buildRouteBoundariesReport(appRoot = APP_ROOT) {
  const sources = loadBackendSources(appRoot);
  const index = buildRouteSourceIndex(sources);
  const registryUrl = pathToFileURL(resolve(appRoot, "backend/routes/index.js")).href;
  return import(registryUrl).then(({ buildRouteRegistry }) =>
    analyzeRouteBoundaries({
      registry: buildRouteRegistry(),
      declarations: ROUTE_BOUNDARY_DECLARATIONS,
      resolveHandler: (handlerKey) => {
        const wrapped = WRAPPED_HANDLERS[handlerKey];
        if (wrapped) {
          const analysis = index.resolveFunction(wrapped);
          return analysis ? { ...analysis, resolution: "resolved" } : { resolution: "unresolved" };
        }
        return index.resolve(handlerKey);
      },
    }),
  );
}

export function buildRouteBoundariesCsv(report) {
  const header = [
    "route",
    "handler_key",
    "domain",
    "cross_domain",
    "legacy_stores",
    "app_state_reads",
    "app_state_writes",
    "mutation",
    "auth_required",
    "permission",
    "resolution",
    "source_file",
    "note",
  ];
  const lines = report.routes.map((row) =>
    [
      `${row.method} ${row.path}`,
      row.handlerKey,
      row.domain,
      row.crossDomain.join("|"),
      row.legacyStores.join("|"),
      row.reads.join("|"),
      row.writes.join("|"),
      row.mutation ? "true" : "false",
      row.authRequired ? "true" : "false",
      row.permission,
      row.resolution,
      row.sourceFile,
      row.note,
    ]
      .map(csvCell)
      .join(","),
  );
  return `${header.map(csvCell).join(",")}\n${lines.join("\n")}\n`;
}

export async function writeRouteBoundariesArtifacts({ appRoot = APP_ROOT, outputDirectory } = {}) {
  const report = await buildRouteBoundariesReport(appRoot);
  const destination = outputDirectory
    ? resolve(outputDirectory)
    : resolve(appRoot, "reports/postgresql-migration/p2b");
  mkdirSync(destination, { recursive: true });
  const csvPath = resolve(destination, "server-route-boundaries.csv");
  const jsonPath = resolve(destination, "route-boundaries-baseline-20260902.json");
  writeFileSync(csvPath, buildRouteBoundariesCsv(report), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return {
    csvPath: relative(appRoot, csvPath).replaceAll("\\", "/"),
    jsonPath: relative(appRoot, jsonPath).replaceAll("\\", "/"),
    report,
  };
}

export { APP_ROOT };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await writeRouteBoundariesArtifacts();
  process.stdout.write(
    `${JSON.stringify({ csvPath: result.csvPath, jsonPath: result.jsonPath, metrics: result.report.metrics }, null, 2)}\n`,
  );
}
