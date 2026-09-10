// MIG-040 — quarto anello: il percorso di SCRITTURA (write-through in shadow).
//
// Nessun PostgreSQL vero e nessun cluster. Il doppio in memoria di questo file emula le
// tre cose che contano della 008 e che il repository dà per esistenti:
//   * il DEFAULT 0 di `revision` sull'INSERT;
//   * il trigger `identity_users_bump_revision`, cioè `revision + 1` se e solo se cambia
//     qualcosa che non sia `revision`;
//   * la `WHERE … AND revision = $n AND row_hash IS DISTINCT FROM $m` come filtro vero.
// Il repository, il canonicalizzatore e il write-through sono quelli di produzione: ciò che
// si misura è il codice, non una seconda copia della sua logica.
//
// Il `pinHash` non compare in nessuna asserzione di log o di rapporto: se comparisse, il
// test stesso violerebbe §4.7. Anzi, c'è un test che verifica proprio che non compaia.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as postgresql from "../db/postgresql/index.js";

const {
  canonicalJson,
  compareIdentityCollection,
  compareIdentitySnapshot,
  createPostgresqlIdentityRepository,
  createPostgresqlIdentityWriteThrough,
  buildIdentitySyncOptions,
  identityPinFingerprint,
  identityRecordFieldDifferences,
  identityRowHash,
  identityRowsFromAppState,
  identityUserGroupToRow,
  identityUserToRow,
  isAdministratorProfile,
  maskIdentityRecord,
  rowToUser,
  rowToUserGroup,
} = postgresql;

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");

const PIN_HASH = `scrypt$32768$8$1$${"ab".repeat(16)}$${"cd".repeat(32)}`;
const OTHER_PIN_HASH = `scrypt$32768$8$1$${"ef".repeat(16)}$${"09".repeat(32)}`;

const SHADOW_ENV = Object.freeze({
  BACKEND_POSTGRES_ENABLED: "1",
  BACKEND_POSTGRES_SHADOW_DOMAINS: "identity",
});
const PRIMARY_ENV = Object.freeze({
  BACKEND_POSTGRES_ENABLED: "1",
  BACKEND_POSTGRES_PRIMARY_DOMAINS: "identity",
});
const OFF_ENV = Object.freeze({});

// ---------------------------------------------------------------------------
// Doppio in memoria di identity.users / identity.user_groups
// ---------------------------------------------------------------------------

function toDate(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function createFakeIdentityDb(initial = {}) {
  const users = new Map();
  const groups = new Map();
  const queries = [];
  const state = { failure: null, failOn: null };

  for (const row of initial.users ?? []) users.set(row.id, { ...row });
  for (const row of initial.userGroups ?? []) groups.set(row.id, { ...row });

  function rows(result) {
    return { rowCount: result.length, rows: result };
  }

  // Il trigger della 008: +1 se e solo se cambia qualcosa che non sia `revision`.
  function bumpRevision(previous, next) {
    const strip = (row) => {
      const { revision, ...rest } = row;
      return canonicalJson({
        ...rest,
        created_at: rest.created_at ? toDate(rest.created_at).toISOString() : null,
        updated_at: rest.updated_at ? toDate(rest.updated_at).toISOString() : null,
      });
    };
    return strip(previous) === strip(next) ? previous.revision : previous.revision + 1;
  }

  const client = {
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (state.failure && (!state.failOn || state.failOn.test(sql))) throw state.failure;

      if (/is_administrator/.test(sql)) {
        return rows(
          [...users.values()].map((row) => ({
            id: row.id,
            revision: row.revision,
            row_hash: row.row_hash,
            is_administrator: isAdministratorProfile(row.role, JSON.parse(row.profile)),
          })),
        );
      }
      if (/SELECT\s+id,\s+revision,\s+row_hash\s+FROM identity\.user_groups/.test(sql)) {
        return rows(
          [...groups.values()].map((row) => ({
            id: row.id,
            revision: row.revision,
            row_hash: row.row_hash,
          })),
        );
      }
      if (/INSERT INTO identity\.users/.test(sql)) {
        const row = {
          id: parameters[0],
          username: parameters[1],
          username_normalized: parameters[2],
          full_name: parameters[3],
          role: parameters[4],
          pin_hash: parameters[5],
          profile: parameters[6],
          app_state_position: parameters[7],
          row_hash: parameters[8],
          created_at: toDate(parameters[9]),
          updated_at: toDate(parameters[10]),
          revision: 0,
        };
        users.set(row.id, row);
        return rows([{ revision: 0 }]);
      }
      if (/UPDATE identity\.users/.test(sql)) {
        const current = users.get(parameters[0]);
        if (!current) return rows([]);
        if (current.revision !== parameters[11]) return rows([]);
        if (current.row_hash === parameters[8]) return rows([]);
        const next = {
          ...current,
          username: parameters[1],
          username_normalized: parameters[2],
          full_name: parameters[3],
          role: parameters[4],
          pin_hash: parameters[5],
          profile: parameters[6],
          app_state_position: parameters[7],
          row_hash: parameters[8],
          created_at: toDate(parameters[9]),
          updated_at: toDate(parameters[10]),
        };
        next.revision = bumpRevision(current, next);
        users.set(next.id, next);
        return rows([{ revision: next.revision }]);
      }
      if (/SELECT revision, row_hash\s+FROM identity\.users/.test(sql)) {
        const current = users.get(parameters[0]);
        return current ? rows([{ revision: current.revision, row_hash: current.row_hash }]) : rows([]);
      }
      // Il prune manda DUE array: gli id e la revision attesa per ciascuno
      // (PRUNE_USERS_SQL, lock ottimistico per riga). Il doppio la rispetta, altrimenti
      // cancellerebbe cio' che il database vero si rifiuta di cancellare e il test sarebbe
      // verde su un comportamento che in produzione non esiste. `deleteUsers(client, ids)`,
      // che e' l'altra chiamata, manda un array solo: allora si cancella per id.
      if (/DELETE FROM identity\.users/.test(sql)) {
        const pruneIds = parameters[0] ?? [];
        const pruneRevisions = Array.isArray(parameters[1]) ? parameters[1] : null;
        const removed = [];
        pruneIds.forEach((id, index) => {
          const current = users.get(id);
          if (!current) return;
          if (pruneRevisions && Number(current.revision) !== Number(pruneRevisions[index])) return;
          users.delete(id);
          removed.push({ id });
        });
        return rows(removed);
      }
      if (/INSERT INTO identity\.user_groups/.test(sql)) {
        const row = {
          id: parameters[0],
          name: parameters[1],
          active: parameters[2],
          profile: parameters[3],
          app_state_position: parameters[4],
          row_hash: parameters[5],
          created_at: toDate(parameters[6]) ?? new Date("2026-03-03T00:00:00.000Z"),
          updated_at: toDate(parameters[7]) ?? new Date("2026-03-03T00:00:00.000Z"),
          revision: 0,
        };
        groups.set(row.id, row);
        return rows([{ revision: 0 }]);
      }
      if (/UPDATE identity\.user_groups/.test(sql)) {
        const current = groups.get(parameters[0]);
        if (!current) return rows([]);
        if (current.revision !== parameters[8]) return rows([]);
        if (current.row_hash === parameters[5]) return rows([]);
        const next = {
          ...current,
          name: parameters[1],
          active: parameters[2],
          profile: parameters[3],
          app_state_position: parameters[4],
          row_hash: parameters[5],
          created_at: toDate(parameters[6]) ?? current.created_at,
          updated_at: toDate(parameters[7]) ?? current.updated_at,
        };
        next.revision = bumpRevision(current, next);
        groups.set(next.id, next);
        return rows([{ revision: next.revision }]);
      }
      if (/SELECT revision, row_hash\s+FROM identity\.user_groups/.test(sql)) {
        const current = groups.get(parameters[0]);
        return current ? rows([{ revision: current.revision, row_hash: current.row_hash }]) : rows([]);
      }
      // Gemella di quella sugli utenti: PRUNE_USER_GROUPS_SQL porta id e revision attesa.
      if (/DELETE FROM identity\.user_groups/.test(sql)) {
        const pruneIds = parameters[0] ?? [];
        const pruneRevisions = Array.isArray(parameters[1]) ? parameters[1] : null;
        const removed = [];
        pruneIds.forEach((id, index) => {
          const current = groups.get(id);
          if (!current) return;
          if (pruneRevisions && Number(current.revision) !== Number(pruneRevisions[index])) return;
          groups.delete(id);
          removed.push({ id });
        });
        return rows(removed);
      }
      if (/FROM identity\.users/.test(sql)) {
        return rows(
          [...users.values()].sort(
            (left, right) => left.app_state_position - right.app_state_position || left.id.localeCompare(right.id),
          ),
        );
      }
      if (/FROM identity\.user_groups/.test(sql)) {
        return rows(
          [...groups.values()].sort(
            (left, right) => left.app_state_position - right.app_state_position || left.id.localeCompare(right.id),
          ),
        );
      }
      return rows([]);
    },
  };

  const runtime = {
    async withConnection(_label, callback) {
      return callback(client);
    },
    async withTransaction(_label, callback) {
      return callback(client, { attempt: 1, maxAttempts: 3 });
    },
  };

  return { client, runtime, users, groups, queries, state };
}

function silentLogger() {
  const lines = [];
  const sink = (...args) => lines.push(args.map((entry) => String(entry)).join(" "));
  return { lines, logger: { warn: sink, error: sink, info: sink, log: sink } };
}

function countingMetrics() {
  // D6 REV4: `identityPruneEmptyDeclared` e' un contatore vero di runtime-metrics.js
  // (:656-664), non un nome inventato qui. Il doppio riproduce l'allowlist reale: un nome
  // non registrato viene lasciato cadere in silenzio, come nel modulo vero.
  const counters = {
    identityShadowWriteFailures: 0,
    identityShadowMismatches: 0,
    identityPruneEmptyDeclared: 0,
  };
  const operations = [];
  return {
    counters,
    operations,
    metrics: {
      incrementCounter(name, amount = 1) {
        if (!Object.prototype.hasOwnProperty.call(counters, name)) return;
        counters[name] += amount;
      },
      recordOperation(kind, label) {
        operations.push(`${kind}:${label}`);
      },
    },
  };
}

function writeThroughWith(options = {}) {
  const fake = createFakeIdentityDb(options.initial);
  const { lines, logger } = silentLogger();
  const { counters, operations, metrics } = countingMetrics();
  const repository = createPostgresqlIdentityRepository({ runtime: fake.runtime });
  const refreshes = [];
  const store = options.store ?? {
    async refresh() {
      refreshes.push(Date.now());
      if (options.refreshFails) throw options.refreshFails;
      return { ok: true };
    },
  };
  const clock = { value: options.startedAt ?? 5_000_000 };
  const writeThrough = createPostgresqlIdentityWriteThrough({
    env: options.env ?? SHADOW_ENV,
    repository,
    runtime: fake.runtime,
    store,
    logger,
    runtimeMetrics: metrics,
    now: () => clock.value,
  });
  return { fake, writeThrough, repository, lines, counters, operations, refreshes, clock };
}

// Record app-state realistici. `permissions` ASSENTE su u2 non è una distrazione: è il caso
// di §4.6 che vale una configurazione di sicurezza.
function adminRecord(overrides = {}) {
  return {
    id: "u1",
    username: "Mario",
    fullName: "Mario Rossi",
    role: "admin",
    permissions: ["manage_users", "view_orders"],
    groupIds: ["g1"],
    pinHash: PIN_HASH,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-02-02T11:00:00.000Z",
    ...overrides,
  };
}

function operatorRecord(overrides = {}) {
  return {
    id: "u2",
    username: "Luigi",
    fullName: "Luigi Verdi",
    role: "operator",
    allowedPaymentMethodIds: [],
    pinHash: "",
    createdAt: "2026-01-03T10:00:00.000Z",
    updatedAt: "2026-01-03T10:00:00.000Z",
    ...overrides,
  };
}

function groupRecord(overrides = {}) {
  return { id: "g1", name: "Sala", description: "Gruppo sala", permissions: ["view_orders"], ...overrides };
}

// Simula la riga come tornerebbe dal driver: `profile` stringa, timestamp `Date`.
function rowFromUser(row) {
  return {
    id: row.id,
    username: row.username,
    username_normalized: row.usernameNormalized,
    full_name: row.fullName,
    role: row.role,
    pin_hash: row.pinHash,
    profile: JSON.stringify(row.profile),
    app_state_position: row.appStatePosition,
    row_hash: row.rowHash,
    revision: 0,
    created_at: row.createdAt ? new Date(row.createdAt) : null,
    updated_at: row.updatedAt ? new Date(row.updatedAt) : null,
  };
}

function rowFromGroup(row) {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    profile: JSON.stringify(row.profile),
    app_state_position: row.appStatePosition,
    row_hash: row.rowHash,
    revision: 0,
    created_at: new Date("2026-03-03T00:00:00.000Z"),
    updated_at: new Date("2026-03-03T00:00:00.000Z"),
  };
}

// ---------------------------------------------------------------------------
// §6.2 — canonicalJson, mask, row_hash
// ---------------------------------------------------------------------------

test("C1: canonicalJson ordina le chiavi ricorsivamente e conserva l'ordine degli array", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [3, 1, 2], c: true } }),
    '{"a":{"c":true,"d":[3,1,2]},"b":1}',
  );
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
});

test("C1: due record con lo stesso contenuto e ordine di chiavi diverso sono la stessa stringa", () => {
  // L'ordine di ensurePizzaInRivaConfiguration (backend/server.js:4785-4804) contro quello
  // di buildNextUser: senza C1 il confronto fallirebbe sul primo utente reale.
  const pizzaOrder = { id: "u1", username: "Mario", role: "admin", pinHash: "", active: true, permissions: ["a"] };
  const buildNextOrder = { permissions: ["a"], role: "admin", username: "Mario", active: true, id: "u1", pinHash: "" };
  assert.equal(canonicalJson(pizzaOrder), canonicalJson(buildNextOrder));
});

test("canonicalJson: undefined omesso, non-finiti a null, Date in ISO, cicli e BigInt rifiutati", () => {
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson({ a: Number.NaN, b: Number.POSITIVE_INFINITY }), '{"a":null,"b":null}');
  assert.equal(canonicalJson(new Date("2026-01-01T00:00:00.000Z")), '"2026-01-01T00:00:00.000Z"');
  assert.equal(canonicalJson([undefined, 1]), "[null,1]");
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /Ciclo/);
  assert.throws(() => canonicalJson({ a: 1n }), /BigInt/);
});

test("C4: mask sostituisce il VALORE di pinHash e non inventa la chiave quando manca", () => {
  const masked = maskIdentityRecord({ id: "u1", pinHash: PIN_HASH });
  assert.equal(masked.pinHash, identityPinFingerprint(PIN_HASH));
  assert.match(masked.pinHash, /^sha256:[0-9a-f]{16}$/);
  assert.equal(maskIdentityRecord({ id: "u1" }).pinHash, undefined);
  assert.equal("pinHash" in maskIdentityRecord({ id: "u1" }), false);
  // pinHash vuoto ⇒ "" e non l'hash della stringa vuota: users_without_pin resta distinguibile.
  assert.equal(maskIdentityRecord({ id: "u1", pinHash: "" }).pinHash, "");
});

test("C4: il pinHash reale non entra mai nella stringa canonica né nel row_hash", () => {
  const record = adminRecord();
  const serialized = canonicalJson(maskIdentityRecord(record));
  assert.equal(serialized.includes(PIN_HASH), false);
  assert.equal(serialized.includes(PIN_HASH.slice(-32)), false);
  const hash = identityRowHash(record);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(
    hash,
    createHash("sha256").update(canonicalJson(maskIdentityRecord(record)), "utf8").digest("hex"),
  );
  // Due pinHash diversi producono due row_hash diversi: il fingerprint basta.
  assert.notEqual(hash, identityRowHash(adminRecord({ pinHash: OTHER_PIN_HASH })));
});

// ---------------------------------------------------------------------------
// §6.1 — round-trip T⁻¹(T(R))
// ---------------------------------------------------------------------------

test("§6.1: rowToUser(userToRow(R)).record ricostruisce il record canonico e la stessa impronta", () => {
  const record = adminRecord({ waiterPauseSettings: null, enabledAppIds: ["pos"], extra: { nested: [1, 2] } });
  const row = identityUserToRow(record, 3);
  const rebuilt = rowToUser(rowFromUser(row));
  assert.equal(canonicalJson(rebuilt.record), canonicalJson(row.record));
  assert.equal(identityRowHash(rebuilt.record), row.rowHash);
  assert.equal(rebuilt.appStatePosition, 3);
  // Il record originale e la ricostruzione coincidono a meno dell'ordine delle chiavi.
  assert.equal(canonicalJson(maskIdentityRecord(rebuilt.record)), canonicalJson(maskIdentityRecord(record)));
});

test("§4.6: la distinzione a tre valori sopravvive al giro completo", () => {
  const record = {
    id: "u9",
    username: "Anna",
    role: "operator",
    // `permissions` ASSENTE: a login-write-model.js:107-110 fa aggiungere i default di
    // ruolo. Diventasse `[]`, l'operatore perderebbe i permessi di ruolo in silenzio.
    allowedPaymentMethodIds: [],
    authorizedRoomIds: null,
    pinHash: "",
  };
  const rebuilt = rowToUser(rowFromUser(identityUserToRow(record, 0))).record;
  assert.equal("permissions" in rebuilt, false, "una chiave assente non deve comparire");
  assert.deepEqual(rebuilt.allowedPaymentMethodIds, [], "[] resta [] e non diventa i default");
  assert.equal(rebuilt.authorizedRoomIds, null, "null resta null e non diventa []");
});

test("§4.6: fullName assente resta assente, fullName vuoto resta vuoto", () => {
  const absent = rowToUser(rowFromUser(identityUserToRow({ id: "u1", username: "a", pinHash: "" }, 0))).record;
  assert.equal("fullName" in absent, false);
  const empty = rowToUser(
    rowFromUser(identityUserToRow({ id: "u1", username: "a", fullName: "", pinHash: "" }, 0)),
  ).record;
  assert.equal(empty.fullName, "");
});

test("§4.3: i timestamp vengono dal record, normalizzati in ISO UTC; l'assenza resta assenza", () => {
  const withOffset = identityUserToRow(
    { id: "u1", username: "a", pinHash: "", createdAt: "2026-01-01T10:00:00+01:00" },
    0,
  );
  assert.equal(withOffset.createdAt, "2026-01-01T09:00:00.000Z");
  assert.equal(withOffset.updatedAt, null);
  const rebuilt = rowToUser(rowFromUser(withOffset)).record;
  assert.equal(rebuilt.createdAt, "2026-01-01T09:00:00.000Z");
  assert.equal("updatedAt" in rebuilt, false);
  assert.throws(
    () => identityUserToRow({ id: "u1", username: "a", createdAt: "non una data" }, 0),
    /createdAt non valido/,
  );
});

test("§4.5: role assente diventa operator, active dei gruppi assente diventa true", () => {
  assert.equal(identityUserToRow({ id: "u1", username: "a", pinHash: "" }, 0).role, "operator");
  assert.equal(identityUserGroupToRow({ id: "g1", name: "Sala" }, 0).active, true);
  assert.equal(identityUserGroupToRow({ id: "g1", name: "Sala", active: false }, 0).active, false);
  const rebuilt = rowToUserGroup(rowFromGroup(identityUserGroupToRow(groupRecord(), 0))).record;
  assert.equal(rebuilt.active, true);
  assert.equal("createdAt" in rebuilt, false, "i timestamp dei gruppi non rientrano nel round-trip");
});

// LIMITE DICHIARATO. `row_hash` è l'impronta del RECORD (008:21 e il COMMENT sulla
// colonna), non della riga: `app_state_position` non vi entra. L'UPDATE del repository è
// filtrato da `row_hash IS DISTINCT FROM $9`, quindi un riordino PURO — stesse persone,
// stesso contenuto, ordine diverso nell'array — non aggiorna la posizione in PostgreSQL e
// il comparatore continua a segnalare `position_differs` finché qualcosa non cambia
// davvero. Includere la posizione nell'impronta avrebbe contraddetto lo schema e il
// `--verify` dell'importer, quindi si dichiara invece di aggirare.
test("LIMITE: un riordino puro non aggiorna app_state_position", async () => {
  const { writeThrough, fake } = writeThroughWith();
  const options = { identityReplace: ["users"] };
  await writeThrough.syncFromAppState({ users: [adminRecord(), operatorRecord()] }, options);
  assert.equal(fake.users.get("u2").app_state_position, 1);
  const outcome = await writeThrough.syncFromAppState({ users: [operatorRecord(), adminRecord()] }, options);
  assert.equal(outcome.summary.users.unchanged, 2, "row_hash identico: il repository classifica unchanged");
  assert.equal(fake.users.get("u2").app_state_position, 1, "la posizione resta quella vecchia");
  const report = await writeThrough.compareWithAppState({ users: [operatorRecord(), adminRecord()], userGroups: [] });
  assert.deepEqual(
    report.mismatches.map((entry) => `${entry.id}:${entry.kind}`).sort(),
    ["u1:position_differs", "u2:position_differs"],
  );
});

test("D32: dominio assente = non toccato, array vuoto = collezione vuota dichiarata", () => {
  assert.deepEqual(identityRowsFromAppState({}), { users: null, userGroups: null });
  const declared = identityRowsFromAppState({ users: [], userGroups: [] });
  assert.deepEqual(declared.users, []);
  assert.deepEqual(declared.userGroups, []);
  assert.notEqual(declared.users, null, "un array vuoto non è la stessa cosa di un dominio assente");
});

// ---------------------------------------------------------------------------
// Spento per difetto (D31 punto 7) — vincolo 2 dello slice
// ---------------------------------------------------------------------------

test("con le liste di D31 vuote il write-through non esiste: nessuna query, nessun effetto", async () => {
  const { writeThrough, fake, refreshes } = writeThroughWith({ env: OFF_ENV });
  assert.equal(writeThrough.enabled, false);
  assert.equal(writeThrough.identityLevel, "off");
  const outcome = await writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [groupRecord()] }, {
    identityReplace: ["users", "userGroups"],
  });
  assert.equal(outcome, null, "spento per difetto: nessun esito, nemmeno negativo");
  assert.equal(fake.queries.length, 0, "nessuna query PostgreSQL con le liste vuote");
  assert.equal(fake.users.size, 0);
  assert.equal(refreshes.length, 0);
  assert.equal(await writeThrough.compareWithAppState({ users: [] }), null);
});

test("con un app-state privo di entrambe le collezioni non si apre nemmeno una transazione", async () => {
  const { writeThrough, fake } = writeThroughWith();
  assert.equal(writeThrough.enabled, true);
  assert.equal(await writeThrough.syncFromAppState({ menuItems: [] }, {}), null);
  assert.equal(fake.queries.length, 0);
  assert.equal(writeThrough.counters().skipped, 1);
});

// ---------------------------------------------------------------------------
// Il percorso felice
// ---------------------------------------------------------------------------

test("write-through: inserisce, poi non riscrive nulla a contenuto identico", async () => {
  const { writeThrough, fake, refreshes } = writeThroughWith();
  const state = { users: [adminRecord(), operatorRecord()], userGroups: [groupRecord()] };

  const first = await writeThrough.syncFromAppState(state, { identityReplace: ["users", "userGroups"] });
  assert.equal(first.ok, true);
  assert.equal(first.summary.users.inserted, 2);
  assert.equal(first.summary.userGroups.inserted, 1);
  assert.equal(fake.users.size, 2);
  assert.equal(fake.users.get("u1").revision, 0, "l'INSERT prende il DEFAULT 0 di revision");
  assert.equal(refreshes.length, 1, "R4: refresh dello store a scrittura riuscita");

  const second = await writeThrough.syncFromAppState(state, { identityReplace: ["users", "userGroups"] });
  assert.equal(second.summary.users.unchanged, 2, "row_hash uguale ⇒ unchanged, zero revisioni consumate");
  assert.equal(second.summary.users.updated, 0);
  assert.equal(fake.users.get("u1").revision, 0, "un UPDATE senza cambio di contenuto non incrementa revision");
});

test("write-through: un cambio di contenuto incrementa revision una volta sola", async () => {
  const { writeThrough, fake } = writeThroughWith();
  const state = { users: [adminRecord()], userGroups: [] };
  await writeThrough.syncFromAppState(state, { identityReplace: ["users"] });
  const changed = { users: [adminRecord({ fullName: "Mario Bianchi" })], userGroups: [] };
  const outcome = await writeThrough.syncFromAppState(changed, { identityReplace: ["users"] });
  assert.equal(outcome.summary.users.updated, 1);
  assert.equal(fake.users.get("u1").revision, 1);
  await writeThrough.syncFromAppState(changed, { identityReplace: ["users"] });
  assert.equal(fake.users.get("u1").revision, 1, "riscrivere lo stesso contenuto non consuma revisioni");
});

test("§9.3: revision non compare mai nella SET e updated_at viene dal record, mai da now()", async () => {
  const { writeThrough, fake } = writeThroughWith();
  await writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [] }, { identityReplace: ["users"] });
  await writeThrough.syncFromAppState(
    { users: [adminRecord({ updatedAt: "2026-05-05T05:05:05.000Z", fullName: "Nuovo" })], userGroups: [] },
    { identityReplace: ["users"] },
  );
  const updates = fake.queries.filter((entry) => /UPDATE identity\.users/.test(entry.sql));
  assert.ok(updates.length >= 1);
  for (const entry of updates) {
    const set = entry.sql.slice(entry.sql.indexOf("SET"), entry.sql.indexOf("WHERE"));
    assert.equal(/revision\s*=/.test(set), false, "revision non è nella SET: la scrive il trigger");
    assert.equal(/now\s*\(\s*\)/i.test(set), false, "nessun now() nella SET");
    assert.match(entry.sql, /AND revision = \$12/);
    assert.match(entry.sql, /AND row_hash IS DISTINCT FROM \$9/);
  }
  assert.equal(fake.users.get("u1").updated_at.toISOString(), "2026-05-05T05:05:05.000Z");
});

// ---------------------------------------------------------------------------
// §4.9 — la regola di prune, dal lato del write-through
// ---------------------------------------------------------------------------

test("P1: una writeDb con users: [] non cancella nulla e conta identityPruneSkipped.noIntent", async () => {
  const { writeThrough, fake, operations } = writeThroughWith();
  await writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [groupRecord()] }, {
    identityReplace: ["users", "userGroups"],
  });
  assert.equal(fake.users.size, 1);

  // È esattamente resetAppState: buildInitialAppState ha users: [] e userGroups: [], e la
  // writeDb non passa opzioni.
  const outcome = await writeThrough.syncFromAppState({ users: [], userGroups: [] }, {});
  assert.equal(outcome.ok, true);
  assert.equal(fake.users.size, 1, "le righe PostgreSQL sopravvivono al reset");
  assert.equal(fake.groups.size, 1);
  assert.equal(outcome.summary.identityPruneSkipped.noIntent, 2);
  assert.equal(writeThrough.counters().identityPruneSkipped.noIntent, 2);
  // D6 REV4 — `noIntent: 2` non dice CHI: la scomposizione per dominio lo dice, e i due
  // numeri devono sommare al totale, altrimenti sono due sorgenti per lo stesso fatto.
  const skipped = writeThrough.counters().identityPruneSkipped;
  assert.deepEqual(skipped.users, { noIntent: 1, emptyDeclared: 0 });
  assert.deepEqual(skipped.userGroups, { noIntent: 1, emptyDeclared: 0 });
  assert.deepEqual(outcome.summary.identityPruneSkipped.users, { noIntent: 1, emptyDeclared: 0 });
  assert.deepEqual(outcome.summary.identityPruneSkipped.userGroups, { noIntent: 1, emptyDeclared: 0 });
  assert.deepEqual(
    operations.filter((entry) => entry.includes("pruneSkipped")).sort(),
    [
      "identityWriteThrough:pruneSkipped.noIntent.userGroups",
      "identityWriteThrough:pruneSkipped.noIntent.users",
    ],
  );
  assert.equal(
    operations.some((entry) => entry === "identityWriteThrough:pruneSkippedNoIntent"),
    false,
    "D32 (f): un nome con suffissi, non un nome per motivo",
  );
  // La copia in uscita non e' la struttura viva: un secondo giro non deve poterla muovere.
  await writeThrough.syncFromAppState({ users: [], userGroups: [] }, {});
  assert.deepEqual(skipped.users, { noIntent: 1, emptyDeclared: 0 }, "counters() ritorna una copia");
});

test("P1: un users.save che rimuove un utente non-admin cancella la sua riga", async () => {
  const { writeThrough, fake } = writeThroughWith();
  // Le opzioni sono esattamente quelle della writeDb di users-save-write-model.js.
  const options = { sessionsSync: { deleteMissing: true }, identityReplace: ["users", "userGroups"] };
  const groups = [groupRecord()];
  await writeThrough.syncFromAppState({ users: [adminRecord(), operatorRecord()], userGroups: groups }, options);
  assert.equal(fake.users.size, 2);
  const outcome = await writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: groups }, options);
  assert.equal(outcome.summary.users.deleted, 1);
  assert.deepEqual(outcome.summary.users.deletedIds, ["u2"]);
  assert.equal(fake.users.has("u2"), false);
});

// D40 — la contraddizione fra §4.9 (c) e P2, risolta. §4.9 (c) prescrive
// `identityReplace: ["users", "userGroups"]` su OGNI users.save; P2 vietava l'intenzione
// dichiarata su una collezione vuota. Sui dati veri del `.164` — users 18, userGroups 0 con
// la chiave presente — le due regole si colpivano: i gruppi si sincronizzano PRIMA, quindi
// il lancio arrivava prima ancora di toccare i 18 utenti, e `users.save` non avrebbe mai
// funzionato in primary. P2 ora si arma solo quando c'è qualcosa da perdere.
test("D40: con zero gruppi su entrambi i lati il write-through degli utenti gira", async () => {
  const { writeThrough, fake, counters } = writeThroughWith();
  const options = { sessionsSync: { deleteMissing: true }, identityReplace: ["users", "userGroups"] };
  const outcome = await writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [] }, options);
  assert.equal(outcome.ok, true, "il dominio vuoto su entrambi i lati non deve far fallire nulla");
  assert.equal(fake.users.size, 1, "gli utenti arrivano a destinazione");
  assert.equal(counters.identityShadowWriteFailures, 0);
});

// Il gemello che dimostra che la protezione NON è stata smontata: appena un gruppo esiste
// davvero, una sostituzione dichiarata con la collezione vuota torna a lanciare. È il caso
// che P2 doveva fermare fin dall'inizio, ed è ancora fermato.
// D41 — questo test asseriva il contrario, e l'avevo scritto io per D40 credendo che la
// guardia riarmata fosse la protezione giusta. Non lo era: cancellare l'ultimo gruppo è
// un'operazione ordinaria, e farla fallire non proteggeva nulla. Peggio: siccome i gruppi
// si sincronizzano PRIMA degli utenti, da quel momento ogni `users.save` sarebbe morto
// nello stesso punto e `identity.users` non avrebbe più ricevuto un solo aggiornamento —
// con il comparatore shadow spento insieme a lui, perché gira solo dopo una transazione
// riuscita. La divergenza avrebbe disattivato il solo strumento fatto per vederla.
test("D41: cancellare l'ultimo gruppo riesce, e NON congela il write-through degli utenti", async () => {
  const { writeThrough, fake, counters } = writeThroughWith();
  await writeThrough.syncFromAppState(
    { users: [adminRecord()], userGroups: [groupRecord()] },
    { identityReplace: ["users", "userGroups"] },
  );
  assert.equal(fake.groups.size, 1, "premessa: un gruppo esiste");

  const outcome = await writeThrough.syncFromAppState(
    { users: [adminRecord({ fullName: "Capo Nuovo" })], userGroups: [] },
    { identityReplace: ["users", "userGroups"] },
  );
  assert.equal(outcome.ok, true, "l'operatore ha cancellato l'ultimo gruppo: è una sua facoltà");
  assert.equal(fake.groups.size, 0, "il gruppo viene cancellato davvero");
  assert.equal(counters.identityShadowWriteFailures, 0);
  assert.equal(
    fake.users.get("u1").full_name,
    "Capo Nuovo",
    "e soprattutto: l'aggiornamento dell'UTENTE, che viene dopo i gruppi, è arrivato",
  );
});

// D41 — azzerare gli utenti resta impossibile, ma per l'invariante («mai zero
// amministratori») e non per la forma del payload. È la differenza fra una guardia che
// protegge un dato e una che protegge una convenzione.
test("D41/P3: azzerare gli utenti lancia per l'invariante, e in shadow il lancio è assorbito", async () => {
  const { writeThrough, fake, counters, lines } = writeThroughWith();
  await writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [] }, { identityReplace: ["users"] });
  const outcome = await writeThrough.syncFromAppState({ users: [], userGroups: [] }, {
    identityReplace: ["users"],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "IDENTITY_NO_SURVIVING_ADMINISTRATOR");
  assert.equal(fake.users.size, 1, "la collezione non viene azzerata: è P3 a impedirlo");
  assert.equal(counters.identityShadowWriteFailures, 1);
  assert.ok(lines.some((line) => line.includes("IDENTITY_NO_SURVIVING_ADMINISTRATOR")));
});

test("P3/D32 (d): una sync che azzererebbe gli amministratori lancia", async () => {
  const { writeThrough, fake } = writeThroughWith();
  const options = { identityReplace: ["users"] };
  await writeThrough.syncFromAppState({ users: [adminRecord(), operatorRecord()], userGroups: [] }, options);
  const outcome = await writeThrough.syncFromAppState({ users: [operatorRecord()], userGroups: [] }, options);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "IDENTITY_NO_SURVIVING_ADMINISTRATOR");
  assert.equal(fake.users.size, 2, "nessuna cancellazione parziale è arrivata a destinazione");
});

test("P1: l'intenzione passa solo dai due canali previsti, e nessun'altra opzione di writeDb entra", () => {
  assert.deepEqual(buildIdentitySyncOptions({}), {});
  assert.deepEqual(buildIdentitySyncOptions({ splitDomains: [] }), {});
  assert.deepEqual(buildIdentitySyncOptions({ splitDomains: ["users"] }), { splitDomains: ["users"] });
  assert.deepEqual(buildIdentitySyncOptions({ domains: ["userGroups"] }), { splitDomains: ["userGroups"] });
  assert.deepEqual(buildIdentitySyncOptions({ identityReplace: ["users"] }), { identityReplace: ["users"] });
  assert.deepEqual(
    buildIdentitySyncOptions({ sessionsSync: { deleteMissing: true }, dirtyDomains: ["users"] }),
    {},
    "le altre opzioni di writeDb non sono un canale di intenzione",
  );
  assert.deepEqual(buildIdentitySyncOptions({ allowIdentityPurge: false }), {});
  assert.deepEqual(buildIdentitySyncOptions({ allowIdentityPurge: true }), { allowIdentityPurge: true });
});

test("D32 (e): identityReplace non restringe gli hint MySQL di users.save", () => {
  const source = readFileSync(path.join(BACKEND_DIR, "users", "users-save-write-model.js"), "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  const call = source.slice(source.indexOf("await writeDb(db, {"));
  const body = call.slice(0, call.indexOf("});") + 3);
  assert.match(body, /identityReplace:\s*\["users",\s*"userGroups"\]/);
  assert.equal(
    /splitDomains/.test(body),
    false,
    "con splitDomains la sync di sessions e auditEvents verrebbe saltata (backend/server.js:16002-16011)",
  );
  // MIG-041 — `deleteMissing: true` NON resta: la revoca viaggia SOLO per nome. La forma
  // per omissione e' una sostituzione dichiarata, e ha due esiti sbagliati e nessuno giusto:
  // con lo snapshot stantio viene RIFIUTATA (la sessione sopravvive alla propria revoca),
  // con lo snapshot in salute viene ONORATA e cancella anche cio' che e' nato dopo il
  // `readDb` di questo write model. `deleteMissing: false` resta scritto ESPLICITO perche'
  // `device-status-split.repository.js:331` legge l'assenza della chiave come un si'.
  assert.match(body, /sessionsSync:\s*\{\s*deleteMissing:\s*false,\s*deleteSessionIds:\s*revokedSessionIds\s*\}/);
  assert.equal(
    /deleteMissing:\s*true/.test(body),
    false,
    "D32: la potatura delle sessioni non avviene mai per omissione",
  );
});

// ---------------------------------------------------------------------------
// Vincolo 1: in shadow PostgreSQL non è mai l'autorità
// ---------------------------------------------------------------------------

test("shadow: un errore PostgreSQL NON si propaga e non può far fallire la scrittura MySQL", async () => {
  const { writeThrough, fake, counters, lines } = writeThroughWith();
  const failure = new Error("connessione persa");
  failure.code = "57P01";
  fake.state.failure = failure;
  // Nessun assert.rejects: il punto del test è che NON si arriva mai a un throw.
  const outcome = await writeThrough.syncFromAppState(
    { users: [adminRecord()], userGroups: [] },
    { identityReplace: ["users"] },
  );
  assert.equal(outcome.ok, false, "si registra e si prosegue: nessun throw");
  assert.equal(outcome.errorCode, "57P01");
  assert.equal(writeThrough.failuresAreFatal, false);
  assert.equal(counters.identityShadowWriteFailures, 1);
  assert.ok(lines.some((line) => line.includes("57P01")));
  assert.equal(
    lines.some((line) => line.includes("connessione persa")),
    false,
    "solo il codice, mai il messaggio del driver",
  );
});

test("primary: lo stesso errore è un errore e si propaga", async () => {
  const { writeThrough, fake, counters } = writeThroughWith({ env: PRIMARY_ENV });
  const failure = new Error("connessione persa");
  failure.code = "57P01";
  fake.state.failure = failure;
  await assert.rejects(
    () => writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [] }, { identityReplace: ["users"] }),
    (error) => error.code === "57P01",
  );
  assert.equal(counters.identityShadowWriteFailures, 1, "il fallimento si conta anche quando è fatale");
  assert.equal(writeThrough.failuresAreFatal, true);
});

test("shadow: un record app-state fuori contratto non fa fallire la writeDb", async () => {
  const { writeThrough, fake, counters } = writeThroughWith();
  const outcome = await writeThrough.syncFromAppState(
    { users: [{ id: "", username: "Mario" }], userGroups: [] },
    { identityReplace: ["users"] },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stage, "map");
  assert.equal(fake.queries.length, 0, "non si apre una transazione per un dato che non si può mappare");
  assert.equal(counters.identityShadowWriteFailures, 1);
});

test("il pinHash non compare mai nei log del write-through, nemmeno nel percorso d'errore", async () => {
  const { writeThrough, fake, lines } = writeThroughWith();
  const failure = new Error(`INSERT … pin_hash = '${PIN_HASH}'`);
  failure.code = "23514";
  fake.state.failure = failure;
  await writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [] }, { identityReplace: ["users"] });
  const joined = lines.join("\n");
  assert.equal(joined.includes(PIN_HASH), false);
  assert.equal(joined.includes("scrypt$"), false);
  assert.ok(joined.includes("23514"));
});

test("R4: un refresh dello store fallito non rompe la scrittura appena riuscita", async () => {
  const refreshFailure = new Error("pool chiuso");
  refreshFailure.code = "ECONNRESET";
  const { writeThrough, fake, lines } = writeThroughWith({ refreshFails: refreshFailure });
  const outcome = await writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [] }, {
    identityReplace: ["users"],
  });
  assert.equal(outcome.ok, true);
  assert.equal(fake.users.size, 1);
  assert.ok(lines.some((line) => line.includes("ECONNRESET")));
});

// ---------------------------------------------------------------------------
// §6.3 — il comparatore shadow
// ---------------------------------------------------------------------------

test("S-CMP-1: il confronto è verde quando PostgreSQL rispecchia l'app-state", async () => {
  const { writeThrough } = writeThroughWith();
  const state = {
    users: [adminRecord(), operatorRecord()],
    userGroups: [groupRecord({ active: true })],
  };
  await writeThrough.syncFromAppState(state, { identityReplace: ["users", "userGroups"] });
  const report = await writeThrough.compareWithAppState(state);
  assert.equal(report.ok, true, JSON.stringify(report.mismatches));
  assert.equal(report.users.appStateCount, 2);
  assert.equal(report.userGroups.postgresCount, 1);
});

// LIMITE DICHIARATO. Tre campi hanno una colonna NOT NULL e una regola di default
// (§4.5): `role` assente ⇒ 'operator', `pinHash` assente ⇒ '', `active` di un gruppo
// assente ⇒ true. Il record che torna da PostgreSQL li porta SEMPRE, quello legacy no: il
// comparatore lo vede e lo dichiara divergente. È il comportamento voluto — un confronto
// che mascherasse i default nasconderebbe anche un default scritto per errore — ma va
// saputo prima di leggere il primo rapporto shadow su dati veri.
test("LIMITE: i default sintetizzati di §4.5 compaiono come divergenze del confronto", async () => {
  const { writeThrough } = writeThroughWith();
  const state = {
    users: [{ id: "u7", username: "Senza", fullName: "Senza Ruolo" }],
    userGroups: [groupRecord()],
  };
  await writeThrough.syncFromAppState(state, { identityReplace: ["users", "userGroups"] });
  const report = await writeThrough.compareWithAppState(state);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.users.mismatches.map((entry) => entry.fields).flat().sort(),
    ["pinHash", "role"],
  );
  assert.deepEqual(report.userGroups.mismatches[0].fields, ["active"]);
});

test("S-CMP-2: una divergenza riporta id e NOMI dei campi, mai i valori", () => {
  const left = adminRecord();
  const right = adminRecord({ fullName: "Altro", permissions: ["view_orders"], pinHash: OTHER_PIN_HASH });
  assert.deepEqual(identityRecordFieldDifferences(left, right), ["fullName", "permissions", "pinHash"]);
  const report = compareIdentityCollection({
    collection: "users",
    records: [left],
    entries: [{ id: "u1", appStatePosition: 0, record: right }],
  });
  assert.equal(report.ok, false);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("Mario Rossi"), false, "nessun valore nel rapporto");
  assert.equal(serialized.includes(PIN_HASH), false);
  assert.deepEqual(report.mismatches[0].fields, ["fullName", "permissions", "pinHash"]);
});

test("il comparatore vede chiave assente ≠ valore vuoto", () => {
  const withKey = { id: "u1", permissions: [] };
  const withoutKey = { id: "u1" };
  assert.deepEqual(identityRecordFieldDifferences(withKey, withoutKey), ["permissions"]);
  assert.deepEqual(identityRecordFieldDifferences(withKey, { id: "u1", permissions: [] }), []);
});

test("il comparatore trova righe mancanti da un lato e posizioni sbagliate", () => {
  const report = compareIdentitySnapshot({
    users: [adminRecord(), operatorRecord()],
    userGroups: [],
    postgresUsers: [
      { id: "u1", appStatePosition: 1, record: adminRecord() },
      { id: "u3", appStatePosition: 2, record: { id: "u3", username: "orfano" } },
    ],
    postgresUserGroups: [],
  });
  const kinds = report.mismatches.map((entry) => `${entry.id}:${entry.kind}`).sort();
  assert.deepEqual(kinds, ["u1:position_differs", "u2:missing_in_postgres", "u3:missing_in_app_state"]);
  assert.equal(report.ok, false);
});

test("S-CMP-3: un secondario verde con il primario rosso resta rosso, e il secondario si dichiara", () => {
  // La «vista utente» normalizzante: collassa fullName, esattamente ciò che sanitizeUser fa
  // con mezzo record. Il primario vede la differenza, il secondario no.
  const view = (record) => ({ id: record.id, role: record.role });
  const report = compareIdentityCollection({
    collection: "users",
    records: [adminRecord()],
    entries: [{ id: "u1", appStatePosition: 0, record: adminRecord({ fullName: "Altro" }) }],
    secondaryView: view,
  });
  assert.equal(report.ok, false, "il primario è rosso, quindi l'esito è rosso");
  assert.equal(report.secondary.available, true);
  assert.equal(report.secondary.checked, 1);
  const senzaSecondario = compareIdentityCollection({
    collection: "users",
    records: [adminRecord()],
    entries: [{ id: "u1", appStatePosition: 0, record: adminRecord() }],
  });
  assert.equal(senzaSecondario.secondary.available, false, "senza vista non si finge di aver confrontato");
});

test("S-CMP-4: il comparatore rilegge da PostgreSQL, non lo snapshot dello store", async () => {
  const { writeThrough, fake } = writeThroughWith();
  const state = { users: [adminRecord()], userGroups: [] };
  await writeThrough.syncFromAppState(state, { identityReplace: ["users"] });
  const before = fake.queries.length;
  await writeThrough.compareWithAppState(state);
  const added = fake.queries.slice(before).map((entry) => entry.sql);
  assert.ok(added.some((sql) => /FROM identity\.users\s+ORDER BY/.test(sql)), "rilettura vera di identity.users");
  assert.ok(added.some((sql) => /FROM identity\.user_groups\s+ORDER BY/.test(sql)));
});

test("il confronto shadow è cadenzato, non a ogni scrittura, e non gira in primary", async () => {
  const { writeThrough, fake, clock } = writeThroughWith();
  const state = { users: [adminRecord()], userGroups: [] };
  await writeThrough.syncFromAppState(state, { identityReplace: ["users"] });
  assert.equal(writeThrough.counters().compares, 1, "il primo confronto parte subito");
  await writeThrough.syncFromAppState(state, { identityReplace: ["users"] });
  assert.equal(writeThrough.counters().compares, 1, "dentro l'intervallo non si riconfronta");
  clock.value += 30_000;
  await writeThrough.syncFromAppState(state, { identityReplace: ["users"] });
  assert.equal(writeThrough.counters().compares, 2, "scaduto l'intervallo si riconfronta");
  void fake;

  const primary = writeThroughWith({ env: PRIMARY_ENV });
  await primary.writeThrough.syncFromAppState(state, { identityReplace: ["users"] });
  assert.equal(primary.writeThrough.counters().compares, 0, "in primary non c'è un legacy con cui confrontarsi");
});

test("una divergenza incrementa identityShadowMismatches, che non è identityShadowWriteFailures", async () => {
  const { writeThrough, fake, counters } = writeThroughWith();
  const state = { users: [adminRecord()], userGroups: [] };
  await writeThrough.syncFromAppState(state, { identityReplace: ["users"] });
  // Divergenza fabbricata: la riga PostgreSQL cambia sotto il naso dell'app-state.
  fake.users.get("u1").full_name = "Qualcun altro";
  const report = await writeThrough.compareWithAppState(state);
  assert.equal(report.ok, false);
  assert.deepEqual(report.mismatches[0].fields, ["fullName"]);
  assert.equal(counters.identityShadowMismatches, 1);
  assert.equal(counters.identityShadowWriteFailures, 0, "una divergenza non è un fallimento di scrittura");
});

test("un confronto che esplode non fa fallire la scrittura già riuscita", async () => {
  const { writeThrough, fake } = writeThroughWith();
  const state = { users: [adminRecord()], userGroups: [] };
  fake.state.failure = Object.assign(new Error("select rotta"), { code: "42P01" });
  fake.state.failOn = /ORDER BY/;
  const outcome = await writeThrough.syncFromAppState(state, { identityReplace: ["users"] });
  assert.equal(outcome.ok, true, "la scrittura è andata a buon fine");
  assert.equal(writeThrough.counters().compareFailures, 1);
  assert.equal(writeThrough.counters().writeFailures, 0);
});

// ---------------------------------------------------------------------------
// Test statici
// ---------------------------------------------------------------------------

function walk(dir, files = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "tests") continue;
      walk(target, files);
    } else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) {
      files.push(target);
    }
  }
  return files;
}

test("D32 (b): nessuna route passa allowIdentityPurge", () => {
  const targets = [
    ...walk(path.join(BACKEND_DIR, "modules")),
    ...walk(path.join(BACKEND_DIR, "routes")),
    path.join(BACKEND_DIR, "server.js"),
  ];
  const offenders = targets.filter((file) => readFileSync(file, "utf8").includes("allowIdentityPurge"));
  assert.deepEqual(
    offenders.map((file) => path.relative(REPO_ROOT, file)),
    [],
    "l'azzeramento dell'identity non passa da HTTP: si fa con mig040-identity-import.mjs --purge-identity",
  );
});

test("i tre file nuovi del quarto anello non contengono SQL: lo scrittore resta uno solo", () => {
  for (const relative of [
    "db/postgresql/identity-canonical.js",
    "db/postgresql/identity-shadow.js",
    "db/postgresql/identity-write-through.js",
  ]) {
    const source = readFileSync(path.join(BACKEND_DIR, relative), "utf8");
    const withoutComments = source
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    for (const pattern of [/\bSELECT\s+/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+identity\./i, /\bDELETE\s+FROM\b/i]) {
      assert.equal(pattern.test(withoutComments), false, `${relative} non deve contenere ${pattern}`);
    }
    assert.equal(/client\.query\(/.test(withoutComments), false, `${relative} non deve interrogare il client`);
  }
});

test("il write-through è l'ultimo passo dell'hook beforeWrite, dopo ogni sync MySQL", () => {
  const source = readFileSync(path.join(BACKEND_DIR, "server.js"), "utf8");
  const start = source.indexOf("async function syncAppStateSplitDomains(");
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf("async function prepareAppStateSplitPrimaryWrite("));
  const identityAt = body.indexOf("identityPostgresWriteThrough.syncFromAppState");
  assert.ok(identityAt > 0, "il write-through è dentro l'hook");
  const lastMysqlAt = body.lastIndexOf("paymentsFiscalSplitRepository.syncFromAppState");
  assert.ok(
    identityAt > lastMysqlAt,
    "PostgreSQL viene per ultimo: in shadow non deve poter impedire una scrittura MySQL",
  );
});

// ---------------------------------------------------------------------------
// Difetto B (revisione avversaria del 07/09) e il lock ottimistico del prune.
//
// Avevo scritto che il caso catastrofico «resta fermato da P3 e dal CONSTRAINT TRIGGER
// della 008». E' vero per `identity.users` ed e' FALSO per `identity.user_groups`: il
// CONSTRAINT TRIGGER `identity_users_require_administrator` e' dichiarato `AFTER UPDATE OR
// DELETE ON identity.users` (008:279-283) e P3 parla di amministratori, che sono utenti.
// Sui gruppi non c'e' ne' l'una ne' l'altro, e non ci deve essere una cardinalita' minima:
// zero gruppi e' uno stato legittimo.
//
// Quello che si poteva aggiungere senza rendere impossibile il caso voluto e' un lock
// ottimistico PER RIGA sul prune: `revision` nella WHERE del DELETE, come ce l'ha gia'
// l'UPDATE. Copre la finestra fra la SELECT di stato e il DELETE dentro la transazione, non
// la finestra fra la lettura del client e la sua scrittura — quella e' il difetto A e si
// chiude in `users.save`.
// ---------------------------------------------------------------------------

// Un altro scrittore committa un UPDATE su `id` subito dopo la SELECT di stato: e'
// esattamente cio' che il DELETE, sotto READ COMMITTED (transactions.js:29), rivaluterebbe
// sull'ultima versione committata.
function scrittoreConcorrente(fake, collezione, id) {
  const query = fake.client.query;
  fake.client.query = async (sql, parameters) => {
    const result = await query(sql, parameters);
    if (/FROM identity\.(users|user_groups)$/m.test(sql) && /revision/.test(sql)) {
      const row = collezione.get(id);
      if (row) collezione.set(id, { ...row, revision: row.revision + 1 });
    }
    return result;
  };
}

test("difetto B: una riga cambiata nella finestra della transazione non viene piu' cancellata in silenzio", async () => {
  const { writeThrough, fake } = writeThroughWith();
  const options = { identityReplace: ["users", "userGroups"] };
  await writeThrough.syncFromAppState({ users: [adminRecord(), operatorRecord()], userGroups: [] }, options);
  assert.equal(fake.users.size, 2, "premessa: due utenti su PostgreSQL");

  scrittoreConcorrente(fake, fake.users, "u2");
  const outcome = await writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [] }, options);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "IDENTITY_PRUNE_REVISION_CONFLICT");
  assert.equal(fake.users.has("u2"), true, "la riga toccata da un altro scrittore resta al suo posto");
  assert.equal(fake.users.size, 2);
});

test("difetto B: lo stesso lock vale sui gruppi, che non hanno ne' P3 ne' CONSTRAINT TRIGGER", async () => {
  const { writeThrough, fake } = writeThroughWith();
  const options = { identityReplace: ["users", "userGroups"] };
  await writeThrough.syncFromAppState(
    { users: [adminRecord()], userGroups: [groupRecord(), groupRecord({ id: "g2", name: "Cucina" })] },
    options,
  );
  assert.equal(fake.groups.size, 2, "premessa: due gruppi su PostgreSQL");

  scrittoreConcorrente(fake, fake.groups, "g2");
  const outcome = await writeThrough.syncFromAppState(
    { users: [adminRecord()], userGroups: [groupRecord()] },
    options,
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "IDENTITY_PRUNE_REVISION_CONFLICT");
  assert.equal(fake.groups.has("g2"), true, "sui gruppi il lock per riga e' l'unica rete che esiste");
});

test("difetto B: il conflitto del prune non nomina mai il contenuto della riga, solo l'id", async () => {
  const { writeThrough, fake, lines } = writeThroughWith({ env: PRIMARY_ENV });
  const options = { identityReplace: ["users"] };
  await writeThrough.syncFromAppState(
    { users: [adminRecord(), operatorRecord({ pinHash: OTHER_PIN_HASH })], userGroups: [] },
    options,
  );
  scrittoreConcorrente(fake, fake.users, "u2");

  await assert.rejects(
    () => writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [] }, options),
    (error) => {
      assert.equal(error.code, "IDENTITY_PRUNE_REVISION_CONFLICT");
      assert.deepEqual(error.details.conflictingIds, ["u2"]);
      assert.equal(error.details.planned, 1);
      assert.equal(error.details.deleted, 0);
      assert.equal(JSON.stringify(error.details).includes("scrypt$"), false);
      return true;
    },
  );
  const joined = lines.join("\n");
  assert.equal(joined.includes(OTHER_PIN_HASH), false);
  assert.equal(joined.includes("scrypt$"), false);
});

// Il gemello che dimostra che il lock non ha smontato la cancellazione ordinaria: senza
// scrittori concorrenti, il prune dichiarato cancella come prima.
test("difetto B: senza scrittori concorrenti il prune dichiarato cancella esattamente come prima", async () => {
  const { writeThrough, fake } = writeThroughWith();
  const options = { identityReplace: ["users", "userGroups"] };
  await writeThrough.syncFromAppState(
    { users: [adminRecord(), operatorRecord()], userGroups: [groupRecord()] },
    options,
  );

  const outcome = await writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [] }, options);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.summary.users.deleted, 1);
  assert.deepEqual(outcome.summary.users.deletedIds, ["u2"]);
  assert.equal(outcome.summary.userGroups.deleted, 1, "l'ultimo gruppo si cancella: e' facolta' dell'operatore");
  assert.equal(fake.users.size, 1);
  assert.equal(fake.groups.size, 0);
});
