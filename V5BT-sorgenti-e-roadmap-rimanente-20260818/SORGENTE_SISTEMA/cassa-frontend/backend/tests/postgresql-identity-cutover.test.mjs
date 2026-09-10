// MIG-040 — Anello 6: i quattro innesti della commutazione.
//
// I quattro sono, nell'ordine del documento MIG040_ANELLO6_COMMUTAZIONE.md:
//
//   §1.4  `buildFullyExternalizedAppStateDomains` rimette `users`/`userGroups` nell'insieme
//         esternalizzato quando identity e' >= primary (D31 punto 6, la «bomba»)
//   §2.1  `hydrateAppStateSplitDomains` chiama `identityPostgresStore.hydrateAppState`,
//         ultima e sovrascrivente, solo da primary in su
//   §2.2  la vista secondaria `userView` passata alla costruzione del write-through (S-CMP-3)
//   §1.5  `stripIdentityForPrimaryWrite`, che tiene l'identity — pinHash compresi — FUORI dal
//         blob MariaDB e riscrive il marcatore `meta.appStateSplitDomains`
//
// COME SI PROVANO TRE FUNZIONI CHE VIVONO IN server.js SENZA AVVIARE server.js. Il file e'
// un modulo di 31.700 righe che al primo import apre pool, timer e route: importarlo qui
// sarebbe impossibile e inutile. Si estrae il TESTO della funzione dal sorgente vero e lo si
// compila con le sue dipendenze passate come parametri. Cio' che si misura e' quindi il
// codice committato, non una sua parafrasi: se qualcuno toglie un innesto, il test lo vede.
// E' la stessa strada, portata dal solo statico al comportamentale, del test
// «il write-through e' l'ultimo passo dell'hook beforeWrite»
// (postgresql-identity-write-through.test.mjs:1019).
//
// LA PROVA DI INERZIA (§6). Per ognuna delle tre funzioni si compila anche la variante
// SENZA gli innesti — ottenuta cancellando dal testo le righe guardate da
// `identityPostgresStore?.isPrimaryDomain?.` — e si verifica che, con le liste di D31 vuote
// (`identityPostgresStore === null`), le due varianti diano lo stesso risultato su una
// batteria di ingressi. La stessa coppia deve invece DIVERGERE con lo store a primary: una
// prova di inerzia che non sa distinguere le due varianti non prova niente.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as postgresql from "../db/postgresql/index.js";
import { buildInitialAppState } from "../modules/app-state/index.js";

const {
  createPostgresqlIdentityStore,
  createPostgresqlIdentityWriteThrough,
  identityRowsFromAppState,
  rowToUser,
  rowToUserGroup,
} = postgresql;

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(TESTS_DIR, "..");
const SERVER_SOURCE = readFileSync(path.join(BACKEND_DIR, "server.js"), "utf8");

const PIN_HASH = `scrypt$32768$8$1$${"ab".repeat(16)}$${"cd".repeat(32)}`;
const ROW_HASH = "a".repeat(64);

const OFF_ENV = Object.freeze({});
const SHADOW_ENV = Object.freeze({
  BACKEND_POSTGRES_ENABLED: "1",
  BACKEND_POSTGRES_SHADOW_DOMAINS: "identity",
});
const PRIMARY_ENV = Object.freeze({
  BACKEND_POSTGRES_ENABLED: "1",
  BACKEND_POSTGRES_PRIMARY_DOMAINS: "identity",
});
const EXCLUSIVE_ENV = Object.freeze({
  BACKEND_POSTGRES_ENABLED: "1",
  BACKEND_POSTGRES_PRIMARY_DOMAINS: "identity",
  BACKEND_POSTGRES_LEGACY_WRITE_GUARD_DOMAINS: "identity",
});

// ---------------------------------------------------------------------------
// Il banco: estrazione e compilazione delle funzioni vere di server.js
// ---------------------------------------------------------------------------

/** Il testo di una funzione di primo livello, dalla firma alla `}` in colonna 0. */
function extractTopLevelFunction(header) {
  const start = SERVER_SOURCE.indexOf(header);
  assert.ok(start >= 0, `firma non trovata in server.js: ${header}`);
  const end = SERVER_SOURCE.indexOf("\n}\n", start);
  assert.ok(end > start, `chiusura non trovata per ${header}`);
  return SERVER_SOURCE.slice(start, end + 2);
}

/**
 * La stessa funzione senza gli innesti identity: si cancellano le righe guardate da
 * `identityPostgresStore?.isPrimaryDomain?.` — nella forma a una riga e nella forma a
 * blocco — e i commenti che le precedono restano, perche' un commento non esegue niente.
 */
function withoutIdentityGraft(body) {
  const lines = body.split("\n");
  const kept = [];
  let skippingBlock = false;
  for (const line of lines) {
    if (skippingBlock) {
      if (line.trim() === "}") skippingBlock = false;
      continue;
    }
    if (line.includes("identityPostgresStore?.isPrimaryDomain?.")) {
      if (line.trimEnd().endsWith("{")) skippingBlock = true;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Compila il testo estratto dentro una fabbrica che prende le dipendenze come parametri e
 * ritorna la funzione vera. Le dipendenze diventano cosi' le variabili libere del corpo:
 * e' l'unico modo di eseguire codice di server.js senza avviare server.js.
 */
function compile(body, name, paramNames, deps) {
  const factory = new Function(...paramNames, `${body}\nreturn ${name};`);
  return factory(...paramNames.map((param) => deps[param]));
}

const FULLY_EXTERNALIZED_PARAMS = [
  "mysqlSessionsSplitRepository",
  "mysqlAuditEventsSplitRepository",
  "mysqlAppStateDomainsSplitRepository",
  "MYSQL_APP_STATE_DOMAINS",
  "auditEventsSplitRepository",
  "printSpoolJobsSplitRepository",
  "tableLocksSplitRepository",
  "paymentsFiscalSplitRepository",
  "identityPostgresStore",
];

const HYDRATE_PARAMS = [
  "mysqlSessionsSplitRepository",
  "mysqlAuditEventsSplitRepository",
  "mysqlAppStateDomainsSplitRepository",
  "mysqlTableLocksRepository",
  "auditEventsSplitRepository",
  "printSpoolJobsSplitRepository",
  "deviceStatusSplitRepository",
  "tableLocksSplitRepository",
  "tableStateSplitRepository",
  "ordersSplitRepository",
  "paymentsFiscalSplitRepository",
  "identityPostgresStore",
  "ORDERS_ANY_ASYNC_ACK",
];

const PREPARE_PARAMS = [
  "mysqlTableLocksRepository",
  "mysqlSessionsSplitRepository",
  "mysqlAuditEventsSplitRepository",
  "mysqlAppStateDomainsSplitRepository",
  "auditEventsSplitRepository",
  "printSpoolJobsSplitRepository",
  "deviceStatusSplitRepository",
  "tableLocksSplitRepository",
  "tableStateSplitRepository",
  "ordersSplitRepository",
  "paymentsFiscalSplitRepository",
  "identityPostgresStore",
];

const FULLY_EXTERNALIZED_BODY = extractTopLevelFunction(
  "function buildFullyExternalizedAppStateDomains() {",
);
const HYDRATE_BODY = extractTopLevelFunction(
  "async function hydrateAppStateSplitDomains(appState) {",
);
const PREPARE_BODY = extractTopLevelFunction(
  "async function prepareAppStateSplitPrimaryWrite(appState) {",
);
const DIRTY_TRACKING_BODY = extractTopLevelFunction(
  "function buildDefaultDirtyTrackingSplitDomains(fullyExternalizedDomains) {",
);

function buildFullyExternalized(deps, { graft = true } = {}) {
  const body = graft ? FULLY_EXTERNALIZED_BODY : withoutIdentityGraft(FULLY_EXTERNALIZED_BODY);
  return compile(body, "buildFullyExternalizedAppStateDomains", FULLY_EXTERNALIZED_PARAMS, deps)();
}

function hydrateSplitDomains(deps, appState, { graft = true } = {}) {
  const body = graft ? HYDRATE_BODY : withoutIdentityGraft(HYDRATE_BODY);
  return compile(body, "hydrateAppStateSplitDomains", HYDRATE_PARAMS, deps)(appState);
}

function prepareSplitPrimaryWrite(deps, appState, { graft = true } = {}) {
  const body = graft ? PREPARE_BODY : withoutIdentityGraft(PREPARE_BODY);
  return compile(body, "prepareAppStateSplitPrimaryWrite", PREPARE_PARAMS, deps)(appState);
}

function buildDefaultDirtyTracking(externalized, { fastPath = true } = {}) {
  const warnings = [];
  const fn = compile(
    DIRTY_TRACKING_BODY,
    "buildDefaultDirtyTrackingSplitDomains",
    ["APP_STATE_DIRTY_TRACKING_WRITE_FASTPATH", "buildInitialAppState", "console"],
    {
      APP_STATE_DIRTY_TRACKING_WRITE_FASTPATH: fastPath,
      buildInitialAppState,
      console: { warn: (line) => warnings.push(String(line)) },
    },
  );
  return { domains: fn(externalized), warnings };
}

// ---------------------------------------------------------------------------
// I doppi: repository di split spenti/accesi, e lo store identity vero
// ---------------------------------------------------------------------------

function offRepository() {
  return {
    enabled: false,
    externalized: false,
    async hydrateAppState(state) {
      return state;
    },
    async prepareAppStateForPrimaryWrite(state) {
      return state;
    },
  };
}

/** Undici repository spenti, uno per ogni passo delle catene di server.js. */
function splitRepositoryDeps(overrides = {}) {
  const names = [
    "mysqlSessionsSplitRepository",
    "mysqlAuditEventsSplitRepository",
    "mysqlAppStateDomainsSplitRepository",
    "mysqlTableLocksRepository",
    "auditEventsSplitRepository",
    "printSpoolJobsSplitRepository",
    "deviceStatusSplitRepository",
    "tableLocksSplitRepository",
    "tableStateSplitRepository",
    "ordersSplitRepository",
    "paymentsFiscalSplitRepository",
  ];
  const deps = { ORDERS_ANY_ASYNC_ACK: false, identityPostgresStore: null };
  for (const name of names) deps[name] = offRepository();
  return { ...deps, ...overrides };
}

function userRow(overrides = {}) {
  return {
    id: "u1",
    username: "Mario",
    username_normalized: "mario",
    full_name: "Mario Rossi",
    role: "admin",
    pin_hash: PIN_HASH,
    profile: { permissions: ["manage_users"], groupIds: ["g1"] },
    app_state_position: 0,
    row_hash: ROW_HASH,
    revision: "3",
    created_at: new Date("2026-01-01T10:00:00.000Z"),
    updated_at: new Date("2026-02-02T11:00:00.000Z"),
    ...overrides,
  };
}

function groupRow(overrides = {}) {
  return {
    id: "g1",
    name: "Sala",
    active: true,
    profile: { description: "Gruppo sala", permissions: ["view_orders"] },
    app_state_position: 0,
    row_hash: "c".repeat(64),
    revision: "1",
    created_at: new Date("2026-01-01T10:00:00.000Z"),
    updated_at: new Date("2026-01-01T10:00:00.000Z"),
    ...overrides,
  };
}

function fakeIdentityRepository(options = {}) {
  const users = (options.users ?? [userRow()]).map(rowToUser);
  const userGroups = (options.userGroups ?? [groupRow()]).map(rowToUserGroup);
  return {
    async listUsers() {
      return users;
    },
    async listUserGroups() {
      return userGroups;
    },
  };
}

const SILENT = { warn() {}, error() {}, info() {}, log() {} };

function identityStoreWith(env, options = {}) {
  return createPostgresqlIdentityStore({
    env,
    repository: fakeIdentityRepository(options),
    logger: SILENT,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  });
}

/** L'app-state che il blob porterebbe: utenti stantii, e un pinHash dentro. */
function staleAppState() {
  return {
    users: [{ id: "vecchio", username: "vecchio", pinHash: `${PIN_HASH}-stantio` }],
    userGroups: [{ id: "gruppo-vecchio", name: "Vecchio" }],
    posSettings: { rooms: [] },
    meta: {
      appStateSplitDomains: {
        users: { mode: "externalized", storage: "mysql", table: "app_state_domain_records" },
        userGroups: { mode: "externalized", storage: "mysql", table: "app_state_domain_records" },
        sessions: { mode: "externalized", storage: "mysql", table: "app_state_domain_records" },
      },
    },
  };
}

// I domini di MYSQL_APP_STATE_DOMAIN_DEFAULTS, letti dal sorgente vero: se
// domani ne aggiungono uno, il conto di questo test lo segue invece di mentire.
const MYSQL_APP_STATE_DOMAIN_DEFAULTS = (() => {
  const start = SERVER_SOURCE.indexOf("const MYSQL_APP_STATE_DOMAIN_DEFAULTS = Object.freeze([");
  assert.ok(start >= 0, "MYSQL_APP_STATE_DOMAIN_DEFAULTS non trovata in server.js");
  const end = SERVER_SOURCE.indexOf("]);", start);
  return SERVER_SOURCE.slice(start, end)
    .split("\n")
    .slice(1)
    .map((line) => line.trim().replace(/^"/, "").replace(/",?$/, ""))
    .filter(Boolean);
})();

// L3: la lista scritta a mano nel passo 5 di §3.3, cioe' il difetto MENO le due voci.
const CUTOVER_DOMAINS = MYSQL_APP_STATE_DOMAIN_DEFAULTS.filter(
  (domain) => domain !== "users" && domain !== "userGroups",
);

// ---------------------------------------------------------------------------
// §1.4 / D31 punto 6 — la bomba a orologeria
// ---------------------------------------------------------------------------

test("il difetto e' misurato e non supposto: 32 voci, `users` e `userGroups` fra loro", () => {
  assert.equal(MYSQL_APP_STATE_DOMAIN_DEFAULTS.length, 32);
  assert.ok(MYSQL_APP_STATE_DOMAIN_DEFAULTS.includes("users"));
  assert.ok(MYSQL_APP_STATE_DOMAIN_DEFAULTS.includes("userGroups"));
  assert.equal(CUTOVER_DOMAINS.length, 30, "il passo 5 di §3.3 scrive 30 voci su 32");
});

test("D31 punto 6: dopo L3 e senza store, `users` e `userGroups` escono dall'insieme", () => {
  const domains = buildFullyExternalized({
    ...splitRepositoryDeps(),
    mysqlAppStateDomainsSplitRepository: { ...offRepository(), enabled: true },
    MYSQL_APP_STATE_DOMAINS: CUTOVER_DOMAINS,
    identityPostgresStore: null,
  });
  assert.equal(domains.includes("users"), false);
  assert.equal(domains.includes("userGroups"), false);
});

test("D31 punto 6: con identity a primary le due voci rientrano nell'insieme", () => {
  const domains = buildFullyExternalized({
    ...splitRepositoryDeps(),
    mysqlAppStateDomainsSplitRepository: { ...offRepository(), enabled: true },
    MYSQL_APP_STATE_DOMAINS: CUTOVER_DOMAINS,
    identityPostgresStore: identityStoreWith(PRIMARY_ENV),
  });
  assert.ok(domains.includes("users"), "users e' esternalizzato su PostgreSQL, non sparito");
  assert.ok(domains.includes("userGroups"));
});

test("D31 punto 6: exclusive (L4) si comporta come primary, shadow (L2) no", () => {
  const base = {
    ...splitRepositoryDeps(),
    mysqlAppStateDomainsSplitRepository: { ...offRepository(), enabled: true },
    MYSQL_APP_STATE_DOMAINS: CUTOVER_DOMAINS,
  };
  const exclusive = buildFullyExternalized({
    ...base,
    identityPostgresStore: identityStoreWith(EXCLUSIVE_ENV),
  });
  assert.ok(exclusive.includes("users") && exclusive.includes("userGroups"));
  const shadow = buildFullyExternalized({
    ...base,
    identityPostgresStore: identityStoreWith(SHADOW_ENV),
  });
  assert.equal(shadow.includes("users"), false, "in shadow l'autorita' e' ancora MySQL");
  assert.equal(shadow.includes("userGroups"), false);
});

test("D31 punto 6: nessun doppione quando le due voci sono ANCORA nella lista MySQL", () => {
  const domains = buildFullyExternalized({
    ...splitRepositoryDeps(),
    mysqlAppStateDomainsSplitRepository: { ...offRepository(), enabled: true },
    MYSQL_APP_STATE_DOMAINS: MYSQL_APP_STATE_DOMAIN_DEFAULTS,
    identityPostgresStore: identityStoreWith(PRIMARY_ENV),
  });
  assert.equal(domains.filter((domain) => domain === "users").length, 1);
  assert.equal(domains.filter((domain) => domain === "userGroups").length, 1);
});

test("D31 punto 6, l'effetto vero: senza l'innesto `enforce` spegnerebbe il fast path per TUTTI", () => {
  const deps = {
    ...splitRepositoryDeps(),
    mysqlSessionsSplitRepository: { ...offRepository(), enabled: true },
    mysqlAuditEventsSplitRepository: { ...offRepository(), enabled: true },
    mysqlAppStateDomainsSplitRepository: { ...offRepository(), enabled: true },
    MYSQL_APP_STATE_DOMAINS: CUTOVER_DOMAINS,
  };

  // Senza store (o prima dell'innesto): l'insieme mente, e la regola di
  // buildDefaultDirtyTrackingSplitDomains — che e' corretta — spegne tutto e lo dice.
  const senza = buildDefaultDirtyTracking(
    buildFullyExternalized({ ...deps, identityPostgresStore: null }),
  );
  assert.deepEqual(senza.domains, [], "un dominio iniziale mancante azzera l'elenco per tutti");
  assert.equal(senza.warnings.length, 1);
  assert.match(senza.warnings[0], /Dirty tracking default disabilitato/);
  assert.match(senza.warnings[0], /users/);
  assert.match(senza.warnings[0], /userGroups/);

  // Con l'innesto e identity a primary: nessun warning, elenco popolato.
  const con = buildDefaultDirtyTracking(
    buildFullyExternalized({ ...deps, identityPostgresStore: identityStoreWith(PRIMARY_ENV) }),
  );
  assert.deepEqual(con.warnings, [], "il boot del passo 5 di §3.3 non deve stampare quella riga");
  assert.ok(con.domains.includes("users"));
  assert.ok(con.domains.length > 0);
  assert.equal(con.domains.includes("meta"), false);
});

// ---------------------------------------------------------------------------
// §2.1 — l'idratazione identity: ultima, sovrascrivente, solo da primary in su
// ---------------------------------------------------------------------------

test("§2.1: a primary `db.users` arriva da PostgreSQL e NON dal blob", async () => {
  const store = identityStoreWith(PRIMARY_ENV);
  const hydrated = await hydrateSplitDomains(
    { ...splitRepositoryDeps(), identityPostgresStore: store },
    staleAppState(),
  );
  assert.deepEqual(
    hydrated.users.map((user) => user.id),
    ["u1"],
    "l'array stantio del blob e' stato sovrascritto",
  );
  assert.deepEqual(
    hydrated.userGroups.map((group) => group.id),
    ["g1"],
  );
});

test("§2.1: l'idratazione identity e' l'ULTIMA e vince su ogni idratazione MySQL", async () => {
  // Un repository MySQL che rimette dentro l'array del blob DOPO gli altri: se l'innesto
  // non fosse in coda, `users` tornerebbe a essere quello di MariaDB.
  const rimetteIlBlob = {
    ...offRepository(),
    async hydrateAppState(state) {
      return { ...state, users: [{ id: "dal-blob", username: "dal-blob" }] };
    },
  };
  const hydrated = await hydrateSplitDomains(
    {
      ...splitRepositoryDeps({ paymentsFiscalSplitRepository: rimetteIlBlob }),
      identityPostgresStore: identityStoreWith(PRIMARY_ENV),
    },
    staleAppState(),
  );
  assert.deepEqual(hydrated.users.map((user) => user.id), ["u1"]);
});

test("§2.1: in shadow NON si sovrascrive — il confronto non deve guardarsi allo specchio (R-ISO-3)", async () => {
  const hydrated = await hydrateSplitDomains(
    { ...splitRepositoryDeps(), identityPostgresStore: identityStoreWith(SHADOW_ENV) },
    staleAppState(),
  );
  assert.deepEqual(hydrated.users.map((user) => user.id), ["vecchio"]);
});

test("§2.1: cio' che esce e' mutabile e mutarlo non tocca lo snapshot (R-ISO-1)", async () => {
  const store = identityStoreWith(PRIMARY_ENV);
  const deps = { ...splitRepositoryDeps(), identityPostgresStore: store };
  const primo = await hydrateSplitDomains(deps, staleAppState());
  primo.users[0].fullName = "mutato in posto";
  const secondo = await hydrateSplitDomains(deps, staleAppState());
  assert.equal(secondo.users[0].fullName, "Mario Rossi", "lo snapshot non e' stato inquinato");
});

test("§2.1: l'innesto sta dopo l'ultima idratazione MySQL e prima del `return`", () => {
  const identityAt = HYDRATE_BODY.indexOf("identityPostgresStore.hydrateAppState(hydrated)");
  const lastMysqlAt = HYDRATE_BODY.lastIndexOf("paymentsFiscalSplitRepository.hydrateAppState");
  assert.ok(identityAt > 0, "l'idratazione identity e' dentro hydrateAppStateSplitDomains");
  assert.ok(identityAt > lastMysqlAt, "identity idrata per ultimo e sovrascrive");
  assert.ok(identityAt < HYDRATE_BODY.lastIndexOf("return hydrated;"));
});

test("§2.1: `hydrateAppState` dello store ha finalmente un chiamante di produzione", () => {
  const produzione = readFileSync(path.join(BACKEND_DIR, "server.js"), "utf8");
  assert.ok(
    produzione.includes("identityPostgresStore.hydrateAppState("),
    "il limite dell'anello 3 («esiste, ha i suoi test, nessuno la chiama») e' chiuso",
  );
});

// ---------------------------------------------------------------------------
// §2.2 / S-CMP-3 — la vista secondaria
// ---------------------------------------------------------------------------

/** Il testo dell'espressione che costruisce il write-through in server.js. */
const WRITE_THROUGH_CONSTRUCTION = (() => {
  const start = SERVER_SOURCE.indexOf("const identityPostgresWriteThrough = identityPostgresRepository");
  assert.ok(start >= 0);
  return SERVER_SOURCE.slice(start, SERVER_SOURCE.indexOf("\nidentityPostgresStore?.start();", start));
})();

test("S-CMP-3: la costruzione del write-through passa `userView: sanitizeUser(record, null)`", () => {
  const code = WRITE_THROUGH_CONSTRUCTION.split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert.match(code, /userView:\s*\(record\)\s*=>\s*sanitizeUser\(record,\s*null\)/);
});

test("S-CMP-3: `userGroupView` resta assente, e la scelta e' dichiarata nel codice", () => {
  const code = WRITE_THROUGH_CONSTRUCTION.split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert.equal(/userGroupView\s*:/.test(code), false, "nessuna vista di gruppo viene passata");
  assert.match(WRITE_THROUGH_CONSTRUCTION, /userGroupView` resta ASSENTE/);
});

test("S-CMP-3: `sanitizeUser` e' una function declaration, quindi sollevata sopra la costruzione", () => {
  const declaredAt = SERVER_SOURCE.indexOf("function sanitizeUser(user, settings = null) {");
  const usedAt = SERVER_SOURCE.indexOf("userView: (record) => sanitizeUser(record, null)");
  assert.ok(declaredAt > 0 && usedAt > 0);
  assert.ok(declaredAt < usedAt, "e comunque dichiarata prima: nessuna zona morta temporale");
});

test("S-CMP-3: con la vista il rapporto dichiara `secondary.available` sugli utenti e non sui gruppi", async () => {
  const repository = fakeIdentityRepository();
  const writeThrough = createPostgresqlIdentityWriteThrough({
    env: SHADOW_ENV,
    repository,
    runtime: { async withTransaction(label, fn) { return fn({}); } },
    logger: SILENT,
    userView: (record) => ({ id: record?.id, role: record?.role ?? "operator" }),
  });
  const report = await writeThrough.compareWithAppState({
    users: (await repository.listUsers()).map((entry) => ({ ...entry.record })),
    userGroups: (await repository.listUserGroups()).map((entry) => ({ ...entry.record })),
  });
  assert.equal(report.users.secondary.available, true);
  assert.equal(report.users.secondary.checked, 1);
  assert.equal(report.userGroups.secondary.available, false, "S-CMP-3 lo dichiara invece di fingere");
  assert.equal(report.userGroups.secondary.checked, 0);
});

test("S-CMP-3: la vista secondaria non e' il criterio di uscita — somma, non sostituisce", async () => {
  const repository = fakeIdentityRepository();
  const writeThrough = createPostgresqlIdentityWriteThrough({
    env: SHADOW_ENV,
    repository,
    runtime: { async withTransaction(label, fn) { return fn({}); } },
    logger: SILENT,
    // Una vista che assorbe TUTTO: se fosse il criterio, direbbe verde.
    userView: () => ({ costante: true }),
  });
  const [entry] = await repository.listUsers();
  const divergente = { ...entry.record, fullName: "Nome diverso" };
  const report = await writeThrough.compareWithAppState({ users: [divergente], userGroups: [] });
  assert.equal(report.ok, false, "un secondario verde con il primario rosso resta ROSSO");
  assert.ok(report.mismatches.some((entry) => entry.kind === "fields_differ"));
  assert.equal(
    report.mismatches.some((entry) => entry.kind === "secondary_view_differs"),
    false,
    "la vista che assorbe la divergenza NON aggiunge una seconda segnalazione",
  );
});

// ---------------------------------------------------------------------------
// §1.5 — stripIdentityForPrimaryWrite: il pinHash fuori dal blob, e il marcatore che dice il vero
// ---------------------------------------------------------------------------

test("§1.5: fuori da primary la funzione ritorna lo stato IDENTICO, per riferimento", () => {
  const state = staleAppState();
  for (const env of [OFF_ENV, SHADOW_ENV]) {
    const store = identityStoreWith(env);
    assert.equal(store.stripIdentityForPrimaryWrite(state), state, `inerte con env ${JSON.stringify(env)}`);
  }
});

test("§1.5: a primary il blob perde gli utenti, e con loro il pinHash", () => {
  const store = identityStoreWith(PRIMARY_ENV);
  const originale = staleAppState();
  const persisted = store.stripIdentityForPrimaryWrite(originale);
  assert.deepEqual(persisted.users, []);
  assert.deepEqual(persisted.userGroups, []);
  const serializzato = JSON.stringify(persisted);
  assert.equal(serializzato.includes("pinHash"), false, "nessun pinHash nel blob MariaDB");
  assert.equal(serializzato.includes(PIN_HASH), false);
  assert.equal(serializzato.includes("vecchio"), false);
});

test("§1.5: il marcatore smette di mentire — da `mysql` a `postgresql`/`identity`", () => {
  const store = identityStoreWith(PRIMARY_ENV);
  const persisted = store.stripIdentityForPrimaryWrite(staleAppState());
  const marcatori = persisted.meta.appStateSplitDomains;
  for (const collection of ["users", "userGroups"]) {
    assert.deepEqual(marcatori[collection], {
      mode: "externalized",
      storage: "postgresql",
      schema: "identity",
    });
  }
  assert.deepEqual(
    marcatori.sessions,
    { mode: "externalized", storage: "mysql", table: "app_state_domain_records" },
    "i marcatori degli altri domini non si toccano",
  );
});

test("§1.5: non muta l'oggetto ricevuto, ne' il suo `meta`", () => {
  const store = identityStoreWith(PRIMARY_ENV);
  const originale = staleAppState();
  const primaMeta = originale.meta.appStateSplitDomains;
  store.stripIdentityForPrimaryWrite(originale);
  assert.equal(originale.users.length, 1, "l'ingresso resta intatto");
  assert.equal(primaMeta.users.storage, "mysql", "il meta dell'ingresso non e' stato riscritto");
});

test("§1.5: chiave assente non diventa valore vuoto, ma il marcatore si scrive lo stesso (§4.6)", () => {
  const store = identityStoreWith(PRIMARY_ENV);
  const persisted = store.stripIdentityForPrimaryWrite({
    userGroups: [{ id: "g" }],
    meta: { appStateSplitDomains: { users: { mode: "externalized", storage: "mysql" } } },
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(persisted, "users"),
    false,
    "chiave assente resta assente: non c'era niente da togliere",
  );
  assert.deepEqual(persisted.userGroups, []);
  assert.equal(persisted.meta.appStateSplitDomains.users.storage, "postgresql");
});

// Difetto MEDIO 6 della revisione avversaria: lo strip e il write-through decidevano «c'e' o
// non c'e'» con DUE predicati diversi — `hasOwnProperty` qui, `Array.isArray` in
// `identityRowsFromAppState` — e su una collezione in forma di oggetto divergevano: svuotata
// dal blob, mai propagata su PostgreSQL. Ora il predicato e' uno solo, importato; questo test
// e' la prova che le due risposte coincidono, ingresso per ingresso.
test("§1.5: lo strip e il write-through usano LO STESSO predicato di presenza", () => {
  const store = identityStoreWith(PRIMARY_ENV);
  const ingresso = { users: { u1: { pinHash: PIN_HASH } }, userGroups: null, meta: {} };
  const persisted = store.stripIdentityForPrimaryWrite(ingresso);

  // Non-array: il write-through non ne ricava righe (`null` = «non toccare la collezione»),
  // quindi lo strip non lo toglie dal blob. Toglierlo lo farebbe sparire da entrambe le fonti.
  const righe = identityRowsFromAppState(ingresso);
  assert.equal(righe.users, null);
  assert.equal(righe.userGroups, null);
  assert.deepEqual(persisted.users, { u1: { pinHash: PIN_HASH } }, "non si cancella cio' che non e' stato propagato");
  assert.equal(persisted.userGroups, null);

  // Array: entrambi dicono «c'e'», e la forma del vuoto e' `[]` — `Array.isArray(db.users)`
  // resta vero dopo lo strip, come con `defaultEmptyValue`.
  const conArray = {
    users: [{ id: "u1", username: "u1", pinHash: PIN_HASH }],
    userGroups: [],
    meta: {},
  };
  const righeArray = identityRowsFromAppState(conArray);
  assert.equal(righeArray.users.length, 1);
  assert.deepEqual(righeArray.userGroups, []);
  const svuotato = store.stripIdentityForPrimaryWrite(conArray);
  assert.deepEqual(svuotato.users, []);
  assert.deepEqual(svuotato.userGroups, []);
  assert.equal(JSON.stringify(svuotato).includes(PIN_HASH), false);
});

test("§1.5: senza `meta` non si inventa un `meta`, e senza stato non si lancia", () => {
  const store = identityStoreWith(PRIMARY_ENV);
  const persisted = store.stripIdentityForPrimaryWrite({ users: [{ id: "u" }] });
  assert.deepEqual(persisted.users, []);
  assert.equal("meta" in persisted, false);
  assert.equal(store.stripIdentityForPrimaryWrite(null), null);
  assert.equal(store.stripIdentityForPrimaryWrite("non un oggetto"), "non un oggetto");
});

test("§1.5: e' SINCRONA — non ritorna una Promise (la superficie sincrona e' il vincolo, R2)", () => {
  const store = identityStoreWith(PRIMARY_ENV);
  const esito = store.stripIdentityForPrimaryWrite(staleAppState());
  assert.equal(esito instanceof Promise, false);
  assert.equal(typeof esito.then, "undefined");
});

test("§1.5: la catena di scrittura la applica per ultima, dopo ogni prepare MySQL", async () => {
  // Il difetto vero da riprodurre: dopo L3 `stripDomainsFromAppState` non ha piu' `users`
  // nella sua lista, quindi il blob se li riporta dietro.
  const stripPostCutover = {
    ...offRepository(),
    async prepareAppStateForPrimaryWrite(state) {
      const persisted = { ...state, posSettings: {} };
      persisted.meta = {
        ...state.meta,
        appStateSplitDomains: {
          ...state.meta.appStateSplitDomains,
          posSettings: { mode: "externalized", storage: "mysql", table: "app_state_domain_records" },
        },
      };
      return persisted;
    },
  };
  const deps = splitRepositoryDeps({ mysqlAppStateDomainsSplitRepository: stripPostCutover });

  const senza = await prepareSplitPrimaryWrite({ ...deps, identityPostgresStore: null }, staleAppState());
  assert.equal(senza.users.length, 1, "e' esattamente la regressione che §1.5 descrive");
  assert.ok(JSON.stringify(senza).includes("pinHash"));

  const con = await prepareSplitPrimaryWrite(
    { ...deps, identityPostgresStore: identityStoreWith(PRIMARY_ENV) },
    staleAppState(),
  );
  assert.deepEqual(con.users, []);
  assert.equal(JSON.stringify(con).includes("pinHash"), false);
  assert.equal(con.meta.appStateSplitDomains.users.storage, "postgresql");
  assert.equal(con.meta.appStateSplitDomains.posSettings.storage, "mysql");
});

test("§1.5: l'innesto e' l'ultimo passo di prepareAppStateSplitPrimaryWrite", () => {
  const identityAt = PREPARE_BODY.indexOf("identityPostgresStore.stripIdentityForPrimaryWrite(prepared)");
  const lastMysqlAt = PREPARE_BODY.lastIndexOf(
    "paymentsFiscalSplitRepository.prepareAppStateForPrimaryWrite",
  );
  assert.ok(identityAt > 0 && identityAt > lastMysqlAt);
  assert.ok(identityAt < PREPARE_BODY.lastIndexOf("return prepared;"));

  // Difetto MEDIO 4 della revisione avversaria: il commento diceva «Sono le due conseguenze
  // che chiudono §7.6 punto 1» e ne chiudeva META'. Le righe `users`/`userGroups` di
  // `app_state_domain_records` restano ferme, con i pinHash dentro, e restano ferme APPOSTA:
  // sono il piano di rientro di §5.2 e la loro cancellazione appartiene a MIG-150. Chi legge
  // l'innesto deve trovarlo scritto qui, non doverlo dedurre.
  assert.match(PREPARE_BODY, /chiude META' di §7\.6 punto 1/, "il commento deve dire quanta parte chiude");
  assert.match(PREPARE_BODY, /app_state_domain_records/, "e deve nominare cio' che NON chiude");
  assert.match(PREPARE_BODY, /MIG-150/, "e a chi appartiene la cancellazione delle righe");
});

test("§1.5: lo store resta senza SQL e senza scritture, anche con la funzione nuova", () => {
  const source = readFileSync(path.join(BACKEND_DIR, "db/postgresql/identity-store.js"), "utf8");
  const withoutComments = source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  for (const pattern of [/\bINSERT\s+INTO\b/i, /\bDELETE\s+FROM\b/i, /\bclient\.query\b/, /\bwithTransaction\b/]) {
    assert.equal(pattern.test(withoutComments), false, `identity-store.js non deve contenere ${pattern}`);
  }
  const store = identityStoreWith(PRIMARY_ENV);
  assert.equal("syncFromAppState" in store, false, "resta il confine del terzo anello");
  assert.equal(typeof store.stripIdentityForPrimaryWrite, "function");
});

// ---------------------------------------------------------------------------
// La prova di inerzia: con le liste di D31 vuote, il comportamento non cambia
// ---------------------------------------------------------------------------

test("inerzia: con lo store `null` l'insieme esternalizzato e' quello di prima, riga per riga", () => {
  const configurazioni = [
    { enabled: false, domini: MYSQL_APP_STATE_DOMAIN_DEFAULTS },
    { enabled: true, domini: MYSQL_APP_STATE_DOMAIN_DEFAULTS },
    { enabled: true, domini: CUTOVER_DOMAINS },
    { enabled: true, domini: [] },
  ];
  for (const { enabled, domini } of configurazioni) {
    const deps = {
      ...splitRepositoryDeps(),
      mysqlSessionsSplitRepository: { ...offRepository(), enabled: true },
      mysqlAuditEventsSplitRepository: { ...offRepository(), enabled: true },
      mysqlAppStateDomainsSplitRepository: { ...offRepository(), enabled },
      paymentsFiscalSplitRepository: { ...offRepository(), externalized: true },
      MYSQL_APP_STATE_DOMAINS: domini,
      identityPostgresStore: null,
    };
    assert.deepEqual(
      buildFullyExternalized(deps, { graft: true }),
      buildFullyExternalized(deps, { graft: false }),
      `insieme diverso con enabled=${enabled} e ${domini.length} domini`,
    );
  }
});

test("inerzia: la prova sa distinguere le due varianti — con primary DEVONO divergere", () => {
  const deps = {
    ...splitRepositoryDeps(),
    mysqlAppStateDomainsSplitRepository: { ...offRepository(), enabled: true },
    MYSQL_APP_STATE_DOMAINS: CUTOVER_DOMAINS,
    identityPostgresStore: identityStoreWith(PRIMARY_ENV),
  };
  assert.notDeepEqual(
    buildFullyExternalized(deps, { graft: true }),
    buildFullyExternalized(deps, { graft: false }),
    "se qui fossero uguali, la variante senza innesto non sarebbe stata costruita davvero",
  );
});

test("inerzia: con lo store `null` l'idratazione e la preparazione sono identiche a prima", async () => {
  const deps = splitRepositoryDeps();
  const conInnesto = await hydrateSplitDomains(deps, staleAppState(), { graft: true });
  const senzaInnesto = await hydrateSplitDomains(deps, staleAppState(), { graft: false });
  assert.deepEqual(conInnesto, senzaInnesto);
  assert.deepEqual(conInnesto.users.map((user) => user.id), ["vecchio"], "il blob resta il blob");

  const preparatoCon = await prepareSplitPrimaryWrite(deps, staleAppState(), { graft: true });
  const preparatoSenza = await prepareSplitPrimaryWrite(deps, staleAppState(), { graft: false });
  assert.deepEqual(preparatoCon, preparatoSenza);
  assert.equal(preparatoCon.users.length, 1);
});

// Le guardie erano quattro; la quinta e' stata aggiunta dopo una revisione avversaria che
// ha trovato un difetto grave: `appStateSplitRequiresStrictRead` — cioe' `beforeWriteRequired`
// — elencava undici repository e NON nominava identity, perche' e' stata scritta prima che
// identity potesse essere un'autorita'. Senza quel termine, in primary e con gli altri undici
// spenti, l'errore fatale del write-through veniva inghiottito e lo strip svuotava comunque il
// blob: dati ne' in MariaDB ne' in PostgreSQL, e la writeDb rispondeva OK.
// Questo test ha colto l'aggiunta, ed e' esattamente il suo mestiere: se un giorno qualcuno
// scrive una guardia con un predicato EQUIVALENTE invece che UGUALE, deve diventare rosso.
// AGGIORNATO il 07/09: il conteggio sale di uno perche' `/api/health` ha ricevuto il
// predicato `isPostgresqlAuthoritative`, che usa lo STESSO `isPrimaryDomain` per decidere
// se un guasto di PostgreSQL debba abbattere la salute. Prima bastava che PostgreSQL fosse
// ACCESO, e in shadow un suo guasto faceva rispondere 503 -> il guardiano usciva dopo 15
// secondi -> la cassa si riavviava in ciclo. Questo test ha colto l'aggiunta, ed e'
// esattamente il suo mestiere: se qualcuno scrivesse un predicato EQUIVALENTE invece che
// UGUALE, dovrebbe diventare rosso.
test("inerzia: le sette guardie sono lo stesso predicato, `isPrimaryDomain`", () => {
  const guardie = SERVER_SOURCE.split("\n").filter(
    (line) => line.includes("identityPostgresStore?.isPrimaryDomain?.") && !line.trimStart().startsWith("//"),
  );
  assert.equal(
    guardie.length,
    7,
    "due in buildFullyExternalized, una in hydrate, una in prepare, una in appStateSplitRequiresStrictRead, "
      + "una in createOperationalPunctualWriters",
  );
  for (const guardia of guardie) {
    assert.match(guardia, /identityPostgresStore\?\.isPrimaryDomain\?\.\("(users|userGroups)"\)/);
  }
});

test("inerzia: nessun innesto tocca BACKEND_MYSQL_APP_STATE_DOMAINS o i suoi difetti", () => {
  assert.match(
    SERVER_SOURCE,
    /const MYSQL_APP_STATE_DOMAINS = \(\(\) => \{\n\s+const configured = String\(process\.env\.BACKEND_MYSQL_APP_STATE_DOMAINS \?\? ""\)/,
    "la lettura della variabile d'ambiente resta quella di prima: nessuna commutazione nel codice",
  );
  assert.ok(MYSQL_APP_STATE_DOMAIN_DEFAULTS.includes("users"));
  assert.ok(MYSQL_APP_STATE_DOMAIN_DEFAULTS.includes("userGroups"));
});

// ---------------------------------------------------------------------------
// MIG-040 — il collegamento, non solo il meccanismo.
//
// `app-state-repository.test.mjs` prova la CONSEGUENZA: con `beforeWriteRequired` vero la
// writeDb aborta, con falso perde gli utenti e risponde OK. Ma quel test passa le opzioni a
// mano, quindi resterebbe verde anche se `server.js` smettesse di collegarle.
//
// Questo test chiude l'anello, e nasce da un errore mio: avevo dichiarato che il test che
// conta le guardie «aveva colto l'aggiunta». Vero, ma quel test conta righe di sorgente, e
// una revisione avversaria ha mostrato che iniettando il difetto VERO — `beforeWriteRequired:
// false` — tutti i 181 test restavano verdi. Il conteggio delle guardie non cambia, perche'
// la guardia sta nella definizione della costante, non nel punto in cui viene collegata.
// ---------------------------------------------------------------------------

test("collegamento: beforeWriteRequired riceve appStateSplitRequiresStrictRead, non un letterale", () => {
  const righe = SERVER_SOURCE.split("\n").filter(
    (line) => line.includes("beforeWriteRequired:") && !line.trimStart().startsWith("//"),
  );

  assert.equal(righe.length, 1, "esiste un solo punto in cui beforeWriteRequired viene collegato");
  assert.match(
    righe[0],
    /beforeWriteRequired:\s*appStateSplitRequiresStrictRead\b/,
    "deve ricevere la costante, che dal 07/09 contiene anche il termine identity. Un letterale "
      + "`false` qui riaprirebbe la perdita: errore del write-through inghiottito, blob svuotato "
      + "lo stesso, e la writeDb che risponde OK.",
  );
});

test("collegamento: la costante contiene il termine identity, non solo gli undici repository", () => {
  const definizione = SERVER_SOURCE.slice(
    SERVER_SOURCE.indexOf("const appStateSplitRequiresStrictRead"),
  ).split(";")[0];

  assert.match(
    definizione,
    /identityPostgresStore\?\.isPrimaryDomain\?\.\("users"\)/,
    "il dodicesimo termine: la lista era stata scritta prima che identity potesse essere "
      + "un'autorita', e senza di esso in primary il fallimento del write-through non aborta nulla",
  );
});
