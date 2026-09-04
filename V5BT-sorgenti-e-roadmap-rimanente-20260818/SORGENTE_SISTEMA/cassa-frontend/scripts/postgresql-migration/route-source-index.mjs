/**
 * Indice delle sorgenti backend per MIG-030.
 *
 * Risolve `handlerKey` -> funzione -> collezioni app-state lette e scritte,
 * senza eseguire il backend. Tre passaggi, tutti verificabili:
 *
 * 1. il dispatch mappa `"handlerKey": espressione` sia in
 *    `backend/routes/route-handlers.js` sia nelle factory dei moduli, che
 *    restituiscono oggetti gia chiavati per handlerKey;
 * 2. il nome della funzione si risolve su un indice delle definizioni
 *    `function nome(` di tutto il backend; se il nome e definito in piu file la
 *    route e ambigua e va dichiarata a mano;
 * 3. gli handler migrati a P2b non toccano piu `db`: delegano a un modello
 *    iniettato dal composition root (`const { login } = createLoginWriteModel(...)`).
 *    L'indice segue quel salto, altrimenti misurerebbe zero su ogni route gia
 *    migrata.
 *
 * Cio che non si risolve non viene indovinato: resta `unresolved` e il gate
 * pretende una dichiarazione umana.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SKIP_DIRECTORIES = new Set(["node_modules", "tests", "dist", "coverage"]);

/** Collezioni app-state note: tutto il resto e rumore (metodi, variabili locali). */
export const APP_STATE_COLLECTIONS = Object.freeze([
  "auditEvents",
  "automaticCash",
  "cashMovements",
  "commercialBenefits",
  "integration",
  "menuItems",
  "meta",
  "orders",
  "payments",
  "posSettings",
  "printSpoolJobs",
  "reservations",
  "rooms",
  "saleSessions",
  "saleSessionTemplates",
  "sessions",
  "smartCustomers",
  "solarClosures",
  "tableGroups",
  "tables",
  "userGroups",
  "users",
]);

const COLLECTION_SET = new Set(APP_STATE_COLLECTIONS);

/** Alias con cui l'app-state viene passato in giro dentro gli handler. */
const DB_ALIASES = ["db", "nextDb", "sourceDb", "workingDb", "currentDb", "appState"];

function* walkJsFiles(directory) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      yield* walkJsFiles(full);
      continue;
    }
    if (entry.endsWith(".js")) yield full;
  }
}

export function loadBackendSources(appRoot = APP_ROOT) {
  const sources = new Map();
  for (const file of walkJsFiles(join(appRoot, "backend"))) {
    sources.set(relative(appRoot, file).replaceAll("\\", "/"), readFileSync(file, "utf8"));
  }
  return sources;
}

/**
 * `"handlerKey": espressione` nel dispatch e nelle factory dei moduli.
 *
 * Le chiavi con il punto vanno per forza fra virgolette. Quelle senza punto no,
 * e infatti nella mappa di `status.handlers.js` la voce di `health` era scritta
 * `health: handleHealth`: non veniva indicizzata, `resolve("health")` rispondeva
 * "assente dal dispatch" e la sua dichiarazione non e mai stata verificata --
 * mentre la route legge davvero `db.meta`. La seconda espressione recupera
 * quelle voci, restando stretta: chiave identificatore e valore una funzione
 * `handleXxx`, che e la forma di ogni voce di dispatch.
 */
export function indexHandlerExpressions(sources) {
  const index = new Map();
  const espressioni = [
    /"([a-zA-Z][\w]*\.[\w.]+|[a-zA-Z][\w]*)"\s*:\s*([A-Za-z_$][\w$.]*)\s*[,\n]/g,
    /(?:^|[{,]\s*)([a-zA-Z][\w]*)\s*:\s*(handle[A-Za-z0-9_$]*)\s*[,\n]/gm,
  ];
  for (const [file, source] of sources) {
    for (const espressione of espressioni) {
      for (const match of source.matchAll(espressione)) {
        if (index.has(match[1])) continue;
        index.set(match[1], { file, expression: match[2] });
      }
    }
  }
  return index;
}

/** `function nome(` in tutto il backend, con i file che la definiscono. */
export function indexFunctionDefinitions(sources) {
  const index = new Map();
  for (const [file, source] of sources) {
    for (const match of source.matchAll(
      /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
    )) {
      if (!index.has(match[1])) index.set(match[1], new Set());
      index.get(match[1]).add(file);
    }
  }
  return index;
}

/**
 * `const { login } = createLoginWriteModel({` nel composition root, unito al file
 * che esporta `createLoginWriteModel`: da qui il salto handler -> write model.
 */
export function indexInjectedModels(sources) {
  const factoryFiles = new Map();
  for (const [file, source] of sources) {
    for (const match of source.matchAll(/export\s+function\s+(create[A-Za-z0-9_$]*)\s*\(/g)) {
      factoryFiles.set(match[1], file);
    }
  }
  const index = new Map();
  for (const source of sources.values()) {
    for (const match of source.matchAll(
      /const\s*\{([^}]+)\}\s*=\s*(create[A-Za-z0-9_$]*)\s*\(/g,
    )) {
      const factoryFile = factoryFiles.get(match[2]);
      if (!factoryFile) continue;
      for (const raw of match[1].split(",")) {
        const name = raw.split(":").pop().trim();
        if (!name || index.has(name)) continue;
        index.set(name, { file: factoryFile, factory: match[2] });
      }
    }
  }
  return index;
}

/**
 * Corpo di una funzione, dalla firma alla parentesi graffa che la chiude.
 *
 * La lista parametri va saltata bilanciando le tonde: con i parametri
 * destrutturati (`function login({ payload })`) la prima graffa appartiene al
 * parametro, non al corpo, e prenderla darebbe un corpo vuoto.
 */
export function extractFunctionBody(source, functionName) {
  const start = new RegExp(
    `^[ \\t]*(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\(`,
    "m",
  ).exec(source);
  if (!start) return null;
  let parens = 0;
  let cursor = start.index + start[0].length - 1;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") parens += 1;
    else if (source[cursor] === ")") {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  const openIndex = source.indexOf("{", cursor);
  if (openIndex < 0) return null;
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start.index, index + 1);
    }
  }
  return null;
}

function collectionsFrom(pattern, body) {
  const found = new Set();
  for (const match of body.matchAll(pattern)) {
    const name = match[match.length - 1];
    if (COLLECTION_SET.has(name)) found.add(name);
  }
  return found;
}

const ALIAS_GROUP = DB_ALIASES.join("|");

/**
 * Letture: accesso a una collezione su un alias dell'app-state, escludendo le
 * occorrenze che sono soltanto il bersaglio di una scrittura
 * (`db.auditEvents.push(...)`, `db.meta.lastWriteAt = ...`): quelle sono
 * scritture, non letture, ed e cosi che le classificano le dichiarazioni a mano.
 */
function readsIn(body) {
  return collectionsFrom(
    new RegExp(
      `\\b(?:${ALIAS_GROUP})\\.([A-Za-z_$][\\w$]*)(?!\\s*=(?!=)|\\.[\\w$]+\\s*=(?!=)|\\.(?:push|splice|pop|shift|unshift|sort)\\s*\\()`,
      "g",
    ),
    body,
  );
}

/**
 * Scritture: assegnazioni dirette, mutazioni in place e — fonte primaria perche
 * dichiarata dal codice stesso — i `splitDomains` passati a writeDb e ai fast writer.
 */
function writesIn(body) {
  const found = new Set();
  // Assegnazione diretta (`db.users = …`) o di una sotto-proprieta
  // (`db.meta.lastWriteAt = …`): in entrambi i casi la collezione cambia.
  for (const name of collectionsFrom(
    new RegExp(`\\b(?:${ALIAS_GROUP})\\.([A-Za-z_$][\\w$]*)(?:\\.[\\w$]+|\\[[^\\]]*\\])?\\s*=(?!=)`, "g"),
    body,
  )) {
    found.add(name);
  }
  for (const name of collectionsFrom(
    new RegExp(
      `\\b(?:${ALIAS_GROUP})\\.([A-Za-z_$][\\w$]*)(?:\\[[^\\]]*\\])?\\.(?:push|splice|pop|shift|unshift|sort)\\s*\\(`,
      "g",
    ),
    body,
  )) {
    found.add(name);
  }
  for (const match of body.matchAll(/splitDomains\s*:\s*\[([^\]]*)\]/g)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim().replace(/^["']|["']$/g, "");
      if (COLLECTION_SET.has(name)) found.add(name);
    }
  }
  return found;
}

function countCall(body, name) {
  return (body.match(new RegExp(`\\b${name}\\s*\\(`, "g")) ?? []).length;
}

/**
 * Analizza il corpo di una funzione seguendo, una volta sola per nome, le
 * funzioni definite nello stesso file e i modelli iniettati che invoca.
 */
function analyzeBody({ file, body, sources, functionIndex, modelIndex, visited, depth }) {
  const reads = readsIn(body);
  const writes = writesIn(body);
  let directReadDb = countCall(body, "readDb");
  let directWriteDb = countCall(body, "writeDb");
  const followed = [];
  if (depth <= 0) return { reads, writes, directReadDb, directWriteDb, followed };

  // Gli argomenti si guardano in lookahead: consumarli farebbe perdere le
  // chiamate annidate, come `sendJson(res, 200, await saveUsersList(payload))`.
  for (const match of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\((?=([^)]*))/g)) {
    const name = match[1];
    if (visited.has(name) || name === "readDb" || name === "writeDb") continue;
    const model = modelIndex.get(name);
    // Una funzione che non riceve l'app-state non puo leggerlo: seguirla
    // significherebbe attribuire alla route le collezioni toccate dai
    // sanitizer, che trasformano dati gia letti. I modelli iniettati sono
    // l'eccezione: possiedono l'app-state per chiusura, non per argomento.
    // L'alias deve arrivare intero: `sanitizePosSettings(db.posSettings)` riceve
    // una fetta gia estratta, non l'app-state, e non va seguito.
    const riceveAppState = new RegExp(`\\b(?:${ALIAS_GROUP})\\b(?!\\s*\\.)`).test(match[2]);
    if (!model && !riceveAppState) continue;
    const sites = functionIndex.get(name);
    let targetFile = null;
    if (model) {
      // Modello iniettato dal composition root: e li che vive l'app-state.
      targetFile = model.file;
    } else if (sites?.has(file)) {
      // Helper privato dello stesso file.
      targetFile = file;
    } else if (sites?.size === 1) {
      // Helper condiviso e iniettato (validateSessionContext, appendAuditEvent,
      // touchSettingsMetadata...): tocca l'app-state per conto della route.
      targetFile = [...sites][0];
    }
    if (!targetFile) continue;
    const targetBody = extractFunctionBody(sources.get(targetFile) ?? "", name);
    if (!targetBody) continue;
    visited.add(name);
    followed.push(`${targetFile}#${name}`);
    const nested = analyzeBody({
      file: targetFile,
      body: targetBody,
      sources,
      functionIndex,
      modelIndex,
      visited,
      depth: depth - 1,
    });
    nested.reads.forEach((entry) => reads.add(entry));
    nested.writes.forEach((entry) => writes.add(entry));
    directReadDb += nested.directReadDb;
    directWriteDb += nested.directWriteDb;
    followed.push(...nested.followed);
  }
  return { reads, writes, directReadDb, directWriteDb, followed };
}

export function buildRouteSourceIndex(sources, { depth = 3 } = {}) {
  const handlerExpressions = indexHandlerExpressions(sources);
  const functionIndex = indexFunctionDefinitions(sources);
  const modelIndex = indexInjectedModels(sources);

  function resolve(handlerKey) {
    const entry = handlerExpressions.get(handlerKey);
    if (!entry) return { resolution: "unresolved", reason: "handlerKey assente dal dispatch" };
    const functionName = entry.expression.includes(".")
      ? entry.expression.split(".").pop()
      : entry.expression;
    const sites = functionIndex.get(functionName);
    if (!sites || sites.size === 0) {
      return { resolution: "unresolved", reason: `definizione di ${functionName} non trovata` };
    }
    if (sites.size > 1) {
      return {
        resolution: "unresolved",
        reason: `${functionName} definita in piu file: ${[...sites].join(" | ")}`,
      };
    }
    const file = [...sites][0];
    const body = extractFunctionBody(sources.get(file) ?? "", functionName);
    if (!body) {
      return { resolution: "unresolved", reason: `corpo di ${functionName} non estraibile` };
    }
    const analysis = analyzeBody({
      file,
      body,
      sources,
      functionIndex,
      modelIndex,
      visited: new Set([functionName]),
      depth,
    });
    return {
      resolution: "resolved",
      sourceFile: file,
      functionName,
      derivedReads: [...analysis.reads].sort(),
      derivedWrites: [...analysis.writes].sort(),
      directReadDb: analysis.directReadDb,
      directWriteDb: analysis.directWriteDb,
      followed: analysis.followed,
    };
  }

  /**
   * Analizza una funzione per nome, saltando il dispatch. Serve alle route che
   * il registry espone tramite un wrapper (`commandInboxPilot.wrap(...)`) invece
   * che con un identificatore semplice: la funzione sottostante esiste, e solo
   * la voce del dispatch a non essere risolvibile.
   */
  function resolveFunction(functionName) {
    const sites = functionIndex.get(functionName);
    if (!sites || sites.size !== 1) return null;
    const file = [...sites][0];
    const body = extractFunctionBody(sources.get(file) ?? "", functionName);
    if (!body) return null;
    const analysis = analyzeBody({
      file,
      body,
      sources,
      functionIndex,
      modelIndex,
      visited: new Set([functionName]),
      depth,
    });
    return {
      sourceFile: file,
      functionName,
      derivedReads: [...analysis.reads].sort(),
      derivedWrites: [...analysis.writes].sort(),
      directReadDb: analysis.directReadDb,
      directWriteDb: analysis.directWriteDb,
    };
  }

  return { resolve, resolveFunction, handlerExpressions, functionIndex, modelIndex };
}

export { APP_ROOT };
