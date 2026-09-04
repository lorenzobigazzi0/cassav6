import assert from "node:assert/strict";
import test from "node:test";

import { IDENTITY_BOUNDARIES } from "./p2b-identity-boundaries.mjs";
import {
  ROUTE_DOMAINS,
  analyzeRouteBoundaries,
  buildRouteBoundariesCsv,
  buildRouteBoundariesReport,
} from "./p2b-route-boundaries.mjs";
import { ROUTE_BOUNDARY_DECLARATIONS } from "./route-domain-map.mjs";

const report = await buildRouteBoundariesReport();

test("MIG-030 copre tutte le route del registry con un dominio del vocabolario target", () => {
  assert.equal(report.metrics.routeCount, 198);
  assert.equal(report.metrics.handlerKeyCount, 193);
  assert.equal(report.behaviorChanged, false);
  assert.equal(report.databaseChanged, false);
  for (const row of report.routes) {
    assert.ok(ROUTE_DOMAINS.includes(row.domain), `${row.handlerKey}: dominio ${row.domain}`);
    assert.ok(row.handlerKey.length > 0);
  }
  // Il vocabolario resta quello degli schemi target, non uno inventato dal gate.
  assert.equal(ROUTE_DOMAINS.length, 14);
  assert.ok(ROUTE_DOMAINS.includes("identity"));
  assert.ok(ROUTE_DOMAINS.includes("reservations"));
});

test("le route non risolvibili staticamente restano poche e tutte motivate", () => {
  const nonRisolte = report.routes.filter((row) => row.resolution !== "resolved");
  assert.ok(nonRisolte.length <= 2, `non risolte: ${nonRisolte.map((r) => r.handlerKey).join(", ")}`);
  for (const row of nonRisolte) {
    assert.ok(row.note.length > 0, `${row.handlerKey} senza nota`);
  }
});

test("il confine identity gia verificato a mano resta coerente con la mappa completa", () => {
  for (const boundary of IDENTITY_BOUNDARIES) {
    const declaration = ROUTE_BOUNDARY_DECLARATIONS[boundary.handlerKey];
    assert.ok(declaration, `${boundary.handlerKey} assente dalla mappa`);
    assert.equal(declaration.domain, boundary.domain);
    // Le due tabelle sono indipendenti: quella identity dichiara le collezioni
    // persistite, questa anche le mutazioni in memoria. La prima deve restare un
    // sottoinsieme della seconda, altrimenti una delle due e sbagliata.
    const collezioni = new Set([...declaration.reads, ...declaration.writes]);
    for (const entry of [...boundary.reads, ...boundary.writes]) {
      const collezione = entry.split(".")[0];
      assert.ok(
        collezioni.has(collezione),
        `${boundary.handlerKey}: ${collezione} dichiarata nel pilot ma assente dalla mappa completa`,
      );
    }
  }
});

// Effetti collaterali infrastrutturali che una lettura puo produrre comunque:
// audit dell'accesso, heartbeat di presenza, scadenza sessione, touch dei
// metadati. Tutto il resto e dato business e non deve comparire su una route
// dichiarata non mutativa.
const COLLEZIONI_INFRASTRUTTURALI = new Set([
  "auditEvents",
  "integration",
  "meta",
  "posSettings",
  "sessions",
]);

test("nessuna route non mutativa dichiara scritture su dati business", () => {
  const violazioni = [];
  for (const row of report.routes) {
    if (row.mutation) continue;
    const business = row.writes.filter((entry) => !COLLEZIONI_INFRASTRUTTURALI.has(entry));
    if (business.length > 0) violazioni.push(`${row.handlerKey} -> ${business.join(", ")}`);
  }
  assert.deepEqual(violazioni, []);
  assert.ok(report.metrics.appStateWritingRouteCount > 0);
  assert.ok(report.metrics.crossDomainRouteCount > 0);
});

test("cross-domain e contenitori legacy restano due misure distinte", () => {
  // Se posSettings e integration finissero fra i domini, quasi ogni route
  // risulterebbe cross-domain e la colonna non direbbe piu nulla: e il difetto
  // corretto in revisione il 2026-09-02.
  assert.ok(
    report.metrics.crossDomainRouteCount < report.metrics.routeCount * 0.6,
    `cross-domain su ${report.metrics.crossDomainRouteCount} di ${report.metrics.routeCount} route: misura di nuovo satura`,
  );
  assert.ok(report.metrics.legacyStoreRouteCount > report.metrics.crossDomainRouteCount);
  for (const row of report.routes) {
    for (const store of row.legacyStores) {
      assert.ok(["posSettings", "integration"].includes(store), `${row.handlerKey}: ${store}`);
      assert.ok(
        row.reads.includes(store) || row.writes.includes(store),
        `${row.handlerKey}: contenitore ${store} non fra letture o scritture`,
      );
    }
  }
});

test("gate MIG-030 fallisce se una route perde la dichiarazione o cambia dominio", () => {
  const registry = [
    { method: "POST", path: "/api/x", handlerKey: "x.one", mutation: true },
    { method: "POST", path: "/api/y", handlerKey: "y.two", mutation: false },
  ];
  const resolveHandler = () => ({ resolution: "resolved", derivedReads: [], derivedWrites: [] });

  assert.throws(
    () =>
      analyzeRouteBoundaries({
        registry,
        declarations: { "x.one": { domain: "sales", crossDomain: [], reads: [], writes: [] } },
        resolveHandler,
      }),
    /y\.two senza dichiarazione/,
  );

  assert.throws(
    () =>
      analyzeRouteBoundaries({
        registry: registry.slice(0, 1),
        declarations: {
          "x.one": { domain: "sales", crossDomain: [], reads: [], writes: [] },
          "z.tre": { domain: "sales", crossDomain: [], reads: [], writes: [] },
        },
        resolveHandler,
      }),
    /z\.tre: dichiarazione senza alcuna route registrata/,
  );

  assert.throws(
    () =>
      analyzeRouteBoundaries({
        registry: registry.slice(0, 1),
        declarations: { "x.one": { domain: "inventato", crossDomain: [], reads: [], writes: [] } },
        resolveHandler,
      }),
    /fuori dal vocabolario target/,
  );
});

test("gate MIG-030 fallisce se l'analisi statica trova un accesso non dichiarato", () => {
  const registry = [{ method: "POST", path: "/api/x", handlerKey: "x.one", mutation: true }];
  assert.throws(
    () =>
      analyzeRouteBoundaries({
        registry,
        declarations: { "x.one": { domain: "sales", crossDomain: [], reads: ["orders"], writes: [] } },
        resolveHandler: () => ({
          resolution: "resolved",
          derivedReads: ["orders", "payments"],
          derivedWrites: ["orders"],
        }),
      }),
    /letture dedotte non dichiarate -> payments[\s\S]*scritture dedotte non dichiarate -> orders/,
  );
});

test("il CSV riporta una riga per route con dominio e collezioni", () => {
  const csv = buildRouteBoundariesCsv(report);
  const righe = csv.trimEnd().split("\n");
  assert.equal(righe.length, report.routes.length + 1);
  assert.match(righe[0], /app_state_reads/);
  assert.match(righe[0], /cross_domain/);
  assert.match(righe[0], /legacy_stores/);
  assert.match(csv, /POST \/api\/auth\/login/);
  assert.match(csv, /POST \/api\/integration\/orders\/create/);
});
