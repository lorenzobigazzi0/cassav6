/**
 * Avanzamento P2b per dominio: quante route toccano ancora `readDb`/`writeDb`
 * dentro il corpo del handler.
 *
 * Il conteggio e a profondita zero di proposito. Il criterio di P2b non e che il
 * dominio smetta di leggere l'app-state -- deve leggerlo, e ancora la sorgente
 * di verita -- ma che a farlo sia un reader o un write model, non il handler
 * HTTP. Seguire le chiamate rimetterebbe dentro il conteggio proprio i modelli
 * che l'estrazione ha creato.
 */
import { ROUTE_BOUNDARY_DECLARATIONS } from "./route-domain-map.mjs";
import { buildRouteSourceIndex, loadBackendSources } from "./route-source-index.mjs";

const sources = loadBackendSources();
const { resolve } = buildRouteSourceIndex(sources, { depth: 0 });

const perDominio = new Map();
for (const [handlerKey, dichiarazione] of Object.entries(ROUTE_BOUNDARY_DECLARATIONS)) {
  const dominio = dichiarazione.domain;
  if (!perDominio.has(dominio)) {
    perDominio.set(dominio, { route: 0, readDb: 0, writeDb: 0, file: new Set(), residue: [] });
  }
  const voce = perDominio.get(dominio);
  voce.route += 1;

  const esito = resolve(handlerKey);
  if (esito.resolution !== "resolved") continue;
  if (esito.directReadDb === 0 && esito.directWriteDb === 0) continue;

  voce.readDb += esito.directReadDb;
  voce.writeDb += esito.directWriteDb;
  voce.file.add(esito.sourceFile);
  voce.residue.push(`${handlerKey} (${esito.directReadDb}R/${esito.directWriteDb}W) ${esito.sourceFile}`);
}

const righe = [...perDominio.entries()]
  .map(([dominio, v]) => ({ dominio, ...v, file: v.file.size }))
  .sort((a, b) => a.readDb + a.writeDb - (b.readDb + b.writeDb) || a.dominio.localeCompare(b.dominio));

console.log("dominio          route  readDb  writeDb  file");
for (const r of righe) {
  console.log(
    r.dominio.padEnd(16) +
      String(r.route).padStart(5) +
      String(r.readDb).padStart(8) +
      String(r.writeDb).padStart(9) +
      String(r.file).padStart(6),
  );
}

const dettaglio = process.argv.slice(2).filter((a) => !a.startsWith("--"));
for (const dominio of dettaglio) {
  console.log(`\n${dominio}:`);
  for (const riga of perDominio.get(dominio)?.residue ?? []) console.log("  " + riga);
}
