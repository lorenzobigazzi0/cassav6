import assert from "node:assert/strict";
import test from "node:test";

import {
  IDENTITY_BOUNDARIES,
  analyzeIdentityPilotSources,
  buildIdentityBoundariesCsv,
  buildIdentityPilotReport,
} from "./p2b-identity-boundaries.mjs";

test("pilot P2b assegna tutte le sette route identity a un confine esplicito", () => {
  const report = buildIdentityPilotReport();
  assert.equal(report.metrics.routeCount, 7);
  // P2b.3: users.list legge tramite reader iniettato.
  // P2b.4: auth.changePin legge e scrive tramite write model iniettato.
  // P2b: auth.selectWorkstation idem, con doppio percorso di scrittura.
  // P2b: auth.sessionStatus idem, preservando retry serializzato e fast path.
  // P2b: auth.login idem, con i due intenti di fallimento e la revoca sessioni.
  // P2b: auth.logout idem, con i tre rami di scrittura e i publish di handoff.
  // P2b: users.save idem, ultima route del dominio: il gate identity e raggiunto.
  assert.equal(report.metrics.directReadDb, 0);
  assert.equal(report.metrics.directWriteDb, 0);
  assert.equal(report.metrics.crossDomainRouteCount, 7);
  assert.equal(report.behaviorChanged, false);
  assert.equal(report.databaseChanged, false);
  assert.equal(new Set(report.routes.map((row) => `${row.method} ${row.route}`)).size, 7);
});

test("inventario identity dichiara letture, scritture e dipendenze cross-domain", () => {
  for (const boundary of IDENTITY_BOUNDARIES) {
    assert.ok(boundary.reads.length + boundary.writes.length > 0, boundary.route);
    assert.ok(boundary.crossDomainDependencies.length > 0, boundary.route);
    assert.match(boundary.sourceFile, /^backend\/(?:auth|users)\//);
  }
  const csv = buildIdentityBoundariesCsv(buildIdentityPilotReport());
  assert.match(csv, /app_state_reads/);
  assert.match(csv, /POST \/api\/auth\/login/);
  assert.match(csv, /POST \/api\/settings\/pos\/users\/save/);
});

test("gate identity fallisce se un accesso globale cambia senza aggiornare il confine", () => {
  const routeRegistrySource = IDENTITY_BOUNDARIES.map(
    (row) => `route("${row.method}", "${row.route}", "${row.handlerKey}")`,
  ).join("\n");
  const handlerSources = new Map();
  for (const file of new Set(IDENTITY_BOUNDARIES.map((row) => row.sourceFile))) {
    const rows = IDENTITY_BOUNDARIES.filter((row) => row.sourceFile === file);
    handlerSources.set(
      file,
      rows.map((row) => `  async function ${row.functionName}() {\n${"readDb();\n".repeat(row.directReadDbExpected)}${"writeDb();\n".repeat(row.directWriteDbExpected)}  }`).join("\n"),
    );
  }
  // Ora che tutte le route sono a zero, la violazione da simulare e l'opposta:
  // una lettura globale che ricompare in un handler senza aggiornare il confine.
  const senzaLetturaDiretta = IDENTITY_BOUNDARIES.find((row) => row.directReadDbExpected === 0);
  assert.ok(senzaLetturaDiretta, "nessuna route identity dichiara zero letture dirette");
  const fileSorgente = senzaLetturaDiretta.sourceFile;
  handlerSources.set(
    fileSorgente,
    handlerSources
      .get(fileSorgente)
      .replace(
        `  async function ${senzaLetturaDiretta.functionName}() {\n`,
        `  async function ${senzaLetturaDiretta.functionName}() {\nreadDb();\n`,
      ),
  );
  assert.throws(
    () => analyzeIdentityPilotSources({ routeRegistrySource, handlerSources, serverSource: "server\n" }),
    /readDb attesi 0, trovati 1/,
  );
});
