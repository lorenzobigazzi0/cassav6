// MIG-040 — repository identity, test cluster-free.
//
// Nessun PostgreSQL vero: si usa il finto pool/client dei test PostgreSQL esistenti
// (postgresql-runtime.test.mjs per il poolFactory, postgresql-audit-events.test.mjs per
// il finto runtime). Ciò che si misura è il SQL prodotto, l'ordine dei parametri, la
// classificazione del conflitto, il mapping riga->record e la regola di prune.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertRepositoryImplementation,
  defineRepositoryContract,
} from "../core/repository-contract.js";
import * as postgresql from "../db/postgresql/index.js";

const {
  createPostgresqlIdentityRepository,
  createPostgresqlRuntime,
  hasIdentityPruneIntent,
  identityPinFingerprint,
  isAdministratorProfile,
  normalizeIdentityUsername,
  POSTGRESQL_IDENTITY_REPOSITORY_CONTRACT,
} = postgresql;

const ROW_HASH_A = "a".repeat(64);
const ROW_HASH_B = "b".repeat(64);
const ROW_HASH_C = "c".repeat(64);
const PIN_HASH = `scrypt$32768$8$1$${"ab".repeat(16)}$${"cd".repeat(32)}`;

// ---------------------------------------------------------------------------
// Finto client/runtime
// ---------------------------------------------------------------------------

function harness(rules = []) {
  const queries = [];
  const connectionLabels = [];
  const client = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      for (const [pattern, value] of rules) {
        if (!pattern.test(sql)) continue;
        const reply = typeof value === "function" ? value(sql, parameters) : value;
        if (reply instanceof Error) throw reply;
        return { rowCount: reply.rows?.length ?? 0, ...reply };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  const runtime = {
    async withConnection(label, callback) {
      connectionLabels.push(label);
      return callback(client);
    },
    async withTransaction(_label, callback) {
      return callback(client, { attempt: 1, maxAttempts: 3 });
    },
  };
  return { client, connectionLabels, queries, runtime };
}

function repositoryWith(rules) {
  const context = harness(rules);
  return { ...context, repository: createPostgresqlIdentityRepository({ runtime: context.runtime }) };
}

function userRow(overrides = {}) {
  return {
    id: "u1",
    username: "Mario",
    username_normalized: "mario",
    full_name: "Mario Rossi",
    role: "admin",
    pin_hash: PIN_HASH,
    profile: { permissions: ["manage_users"], groupIds: [], roleLabel: "Amministratore" },
    app_state_position: 0,
    row_hash: ROW_HASH_A,
    revision: "3",
    created_at: new Date("2026-01-01T10:00:00.000Z"),
    updated_at: new Date("2026-02-02T11:00:00.000Z"),
    ...overrides,
  };
}

function userInput(overrides = {}) {
  return {
    id: "u1",
    username: "Mario",
    fullName: "Mario Rossi",
    role: "admin",
    pinHash: PIN_HASH,
    profile: { permissions: ["manage_users"] },
    appStatePosition: 0,
    rowHash: ROW_HASH_A,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-02-02T11:00:00.000Z",
    ...overrides,
  };
}

function groupInput(overrides = {}) {
  return {
    id: "g1",
    name: "Sala",
    active: true,
    profile: { description: "Gruppo sala", permissions: ["view_orders"] },
    appStatePosition: 0,
    rowHash: ROW_HASH_C,
    ...overrides,
  };
}

function setClauseOf(sql) {
  const start = sql.indexOf("SET");
  const end = sql.indexOf("WHERE");
  assert.ok(start >= 0 && end > start, "la query deve avere SET e WHERE");
  return sql.slice(start, end);
}

function whereClauseOf(sql) {
  const start = sql.indexOf("WHERE");
  assert.ok(start >= 0, "la query deve avere WHERE");
  return sql.slice(start);
}

// ---------------------------------------------------------------------------
// Contratto
// ---------------------------------------------------------------------------

test("MIG-040 dichiara un solo contratto identity e l'implementazione lo soddisfa", () => {
  assert.equal(typeof createPostgresqlIdentityRepository, "function");
  // §6.2 C5: "identity.user_groups" sarebbe rifiutato dal regex di repository-contract.js:44.
  assert.equal(POSTGRESQL_IDENTITY_REPOSITORY_CONTRACT.domain, "identity");
  assert.deepEqual(POSTGRESQL_IDENTITY_REPOSITORY_CONTRACT.methods, [
    { name: "listUsers", kind: "read", transaction: "none" },
    { name: "listUserGroups", kind: "read", transaction: "none" },
    { name: "getUserById", kind: "read", transaction: "none" },
    { name: "countAdministrators", kind: "read", transaction: "none" },
    { name: "insertUser", kind: "write", transaction: "required" },
    { name: "updateUser", kind: "write", transaction: "required" },
    { name: "deleteUsers", kind: "write", transaction: "required" },
    { name: "insertUserGroup", kind: "write", transaction: "required" },
    { name: "updateUserGroup", kind: "write", transaction: "required" },
    { name: "deleteUserGroups", kind: "write", transaction: "required" },
    { name: "syncFromAppState", kind: "write", transaction: "required" },
  ]);

  const { repository } = repositoryWith([]);
  assert.doesNotThrow(() => {
    assertRepositoryImplementation(POSTGRESQL_IDENTITY_REPOSITORY_CONTRACT, repository);
  });
});

test("il domain con underscore sarebbe rifiutato: la ragione per cui il contratto e' uno solo", () => {
  // §6.2 C5: un contratto "identity.user_groups" lancerebbe al primo import del modulo,
  // cioe' al boot. È l'errore che questo slice non deve commettere.
  assert.throws(
    () => defineRepositoryContract({
      domain: "identity.user_groups",
      methods: [{ name: "listUserGroups", kind: "read", transaction: "none" }],
    }),
    (error) => error instanceof TypeError && error.code === "REPOSITORY_CONTRACT_INVALID",
  );
  assert.doesNotThrow(() => defineRepositoryContract({
    domain: "identity",
    methods: [{ name: "listUserGroups", kind: "read", transaction: "none" }],
  }));
});

test("il repository rifiuta un runtime PostgreSQL non valido", () => {
  assert.throws(
    () => createPostgresqlIdentityRepository({ runtime: null }),
    (error) => error instanceof TypeError && error.code === "POSTGRES_IDENTITY_INVALID_INPUT",
  );
});

// ---------------------------------------------------------------------------
// Letture e mapping riga -> oggetto
// ---------------------------------------------------------------------------

test("listUsers ordina per posizione app-state e mappa snake_case -> camelCase", async () => {
  const { repository, queries, connectionLabels } = repositoryWith([
    [/ORDER BY app_state_position, id/, { rows: [userRow()] }],
  ]);

  const users = await repository.listUsers();

  assert.deepEqual(connectionLabels, ["identity:list-users"]);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /FROM identity\.users/);
  assert.match(queries[0].sql, /ORDER BY app_state_position, id/);
  assert.equal(users.length, 1);
  assert.equal(users[0].id, "u1");
  assert.equal(users[0].username, "Mario");
  assert.equal(users[0].usernameNormalized, "mario");
  assert.equal(users[0].fullName, "Mario Rossi");
  assert.equal(users[0].appStatePosition, 0);
  assert.equal(users[0].rowHash, ROW_HASH_A);
  assert.equal(users[0].revision, 3);
  assert.equal(users[0].createdAt, "2026-01-01T10:00:00.000Z");
  assert.equal(users[0].updatedAt, "2026-02-02T11:00:00.000Z");
  assert.equal(users[0].pinHash, PIN_HASH);
  assert.equal(users[0].pinFingerprint, identityPinFingerprint(PIN_HASH));
});

test("rowToUser ri-omette fullName quando la colonna e' NULL e riemette \"\" quando c'era", async () => {
  const { repository } = repositoryWith([
    [/ORDER BY app_state_position, id/, {
      rows: [
        userRow({ id: "u1", full_name: null }),
        userRow({ id: "u2", full_name: "", username: "anna", username_normalized: "anna", app_state_position: 1 }),
      ],
    }],
  ]);

  const [senzaNome, conStringaVuota] = await repository.listUsers();

  // §4.6: chiave assente ≠ valore vuoto. Tre stati, non due.
  assert.equal(Object.prototype.hasOwnProperty.call(senzaNome.record, "fullName"), false);
  assert.equal(senzaNome.fullName, null);
  assert.equal(conStringaVuota.record.fullName, "");
});

test("il record ricostruito conserva i campi non promossi e non inventa chiavi assenti", async () => {
  const { repository } = repositoryWith([
    [/ORDER BY app_state_position, id/, {
      rows: [userRow({
        profile: {
          roleLabel: "Amministratore",
          permissions: ["manage_users"],
          fiscalExcluded: true,
          pauseSettings: { enabled: true, pauseDurationMinutes: 5 },
          campoSconosciuto: { a: 1 },
        },
      })],
    }],
  ]);

  const [user] = await repository.listUsers();

  assert.deepEqual(Object.keys(user.record), [
    "id",
    "username",
    "fullName",
    "role",
    "roleLabel",
    "permissions",
    "pinHash",
    "createdAt",
    "updatedAt",
    "fiscalExcluded",
    "pauseSettings",
    "campoSconosciuto",
  ]);
  // Catch-all lossless: nessun campo sconosciuto viene scartato (§5.1 campo 33).
  assert.deepEqual(user.record.campoSconosciuto, { a: 1 });
  assert.deepEqual(user.record.pauseSettings, { enabled: true, pauseDurationMinutes: 5 });
  // groupIds non era nel profile: non torna fuori.
  assert.equal(Object.prototype.hasOwnProperty.call(user.record, "groupIds"), false);
  // profile e record sono copie indipendenti.
  user.record.permissions.push("x");
  assert.deepEqual(user.profile.permissions, ["manage_users"]);
});

test("listUserGroups mappa active e tiene i timestamp fuori dal record app-state", async () => {
  const { repository, connectionLabels } = repositoryWith([
    [/FROM identity\.user_groups/, {
      rows: [{
        id: "g1",
        name: "Sala",
        active: false,
        profile: { description: "Gruppo sala", permissions: ["view_orders"], extra: 1 },
        app_state_position: 2,
        row_hash: ROW_HASH_C,
        revision: "0",
        created_at: new Date("2026-03-03T09:00:00.000Z"),
        updated_at: new Date("2026-03-03T09:00:00.000Z"),
      }],
    }],
  ]);

  const [group] = await repository.listUserGroups();

  assert.deepEqual(connectionLabels, ["identity:list-user-groups"]);
  assert.equal(group.active, false);
  assert.equal(group.appStatePosition, 2);
  assert.equal(group.createdAt, "2026-03-03T09:00:00.000Z");
  // §4.3/§6.4: i timestamp dei gruppi sono valori NUOVI e non rientrano nel round-trip.
  assert.deepEqual(Object.keys(group.record), ["id", "name", "description", "permissions", "active", "extra"]);
  assert.equal(Object.prototype.hasOwnProperty.call(group.record, "createdAt"), false);
});

test("countAdministrators usa la stessa espressione dello schema, non profile -> permissions", async () => {
  const { repository, queries } = repositoryWith([
    [/count\(\*\)/, { rows: [{ administrators: "2" }] }],
  ]);

  assert.equal(await repository.countAdministrators(), 2);
  assert.match(queries[0].sql, /WHERE role = 'admin' OR profile @> '\{"permissions": \["manage_users"\]\}'::jsonb/);
  assert.doesNotMatch(queries[0].sql, /profile -> 'permissions'/);
});

test("getUserById passa l'id come parametro e non lo interpola", async () => {
  const { repository, queries } = repositoryWith([
    [/WHERE id = \$1/, { rows: [userRow()] }],
  ]);

  const user = await repository.getUserById("u1");
  assert.equal(user.id, "u1");
  assert.deepEqual(queries[0].parameters, ["u1"]);

  const { repository: empty } = repositoryWith([[/WHERE id = \$1/, { rows: [] }]]);
  assert.equal(await empty.getUserById("u404"), null);
});

test("listUsers funziona con il runtime reale e un poolFactory finto", async () => {
  let released = false;
  const fakePool = {
    totalCount: 1,
    idleCount: 0,
    waitingCount: 0,
    on() {},
    async connect() {
      return {
        async query(sql) {
          assert.match(sql, /FROM identity\.users/);
          return { rowCount: 1, rows: [userRow()] };
        },
        release() {
          released = true;
        },
      };
    },
    async end() {},
  };
  const runtime = createPostgresqlRuntime({
    env: { BACKEND_POSTGRES_ENABLED: "1", POSTGRES_PASSWORD: "test-only-password" },
    poolFactory: () => fakePool,
  });
  const repository = createPostgresqlIdentityRepository({ runtime });

  const users = await repository.listUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].id, "u1");
  assert.equal(released, true);
  await runtime.close();
});

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

test("insertUser non scrive revision: la riga nuova prende il DEFAULT 0 della 010", async () => {
  const { repository, client, queries } = repositoryWith([
    [/INSERT INTO identity\.users/, { rows: [{ revision: "0" }] }],
  ]);

  const outcome = await repository.insertUser(client, userInput());

  assert.deepEqual(outcome, { outcome: "inserted", id: "u1", revision: 0 });
  assert.equal(queries.length, 1);
  const columnList = queries[0].sql.slice(0, queries[0].sql.indexOf("VALUES"));
  assert.doesNotMatch(columnList, /\brevision\b/i);
  assert.doesNotMatch(queries[0].sql, /now\(\)/i);
  assert.deepEqual(queries[0].parameters, [
    "u1",
    "Mario",
    "mario",
    "Mario Rossi",
    "admin",
    PIN_HASH,
    JSON.stringify({ permissions: ["manage_users"] }),
    0,
    ROW_HASH_A,
    "2026-01-01T10:00:00.000Z",
    "2026-02-02T11:00:00.000Z",
  ]);
});

test("insertUser richiede il client transazionale", async () => {
  const { repository } = repositoryWith([]);
  await assert.rejects(
    repository.insertUser(null, userInput()),
    (error) => error instanceof TypeError && error.code === "POSTGRES_IDENTITY_INVALID_INPUT",
  );
});

test("insertUserGroup usa COALESCE(now()) solo all'inserimento dei timestamp nuovi", async () => {
  const { repository, client, queries } = repositoryWith([
    [/INSERT INTO identity\.user_groups/, { rows: [{ revision: "0" }] }],
  ]);

  const outcome = await repository.insertUserGroup(client, groupInput());

  assert.deepEqual(outcome, { outcome: "inserted", id: "g1", revision: 0 });
  const columnList = queries[0].sql.slice(0, queries[0].sql.indexOf("VALUES"));
  assert.doesNotMatch(columnList, /\brevision\b/i);
  assert.match(queries[0].sql, /COALESCE\(\$7::timestamptz, now\(\)\)/);
  assert.deepEqual(queries[0].parameters, [
    "g1",
    "Sala",
    true,
    JSON.stringify({ description: "Gruppo sala", permissions: ["view_orders"] }),
    0,
    ROW_HASH_C,
    null,
    null,
  ]);
});

// ---------------------------------------------------------------------------
// UPDATE, lock ottimistico e conflitto
// ---------------------------------------------------------------------------

test("updateUser: revision assente dalla SET, presente nella WHERE, updated_at dal record", async () => {
  const { repository, client, queries } = repositoryWith([
    [/UPDATE identity\.users/, { rows: [{ revision: "8" }] }],
  ]);

  const outcome = await repository.updateUser(client, userInput({ rowHash: ROW_HASH_B }), 7);

  assert.deepEqual(outcome, { outcome: "updated", id: "u1", revision: 8 });
  assert.equal(queries.length, 1);
  const sql = queries[0].sql;
  // D38.1: revision la scrive il trigger; il repository la usa solo come lock.
  assert.doesNotMatch(setClauseOf(sql), /\brevision\b/i);
  assert.match(whereClauseOf(sql), /AND revision = \$12/);
  assert.match(whereClauseOf(sql), /AND row_hash IS DISTINCT FROM \$9/);
  // §3.1 punto 1: con now() ogni UPDATE sembrerebbe un cambio di contenuto.
  assert.doesNotMatch(sql, /now\(\)/i);
  assert.match(sql, /updated_at\s+= \$11/);
  assert.match(sql, /created_at\s+= \$10/);
  assert.match(sql, /RETURNING revision/);
  assert.deepEqual(queries[0].parameters, [
    "u1",
    "Mario",
    "mario",
    "Mario Rossi",
    "admin",
    PIN_HASH,
    JSON.stringify({ permissions: ["manage_users"] }),
    0,
    ROW_HASH_B,
    "2026-01-01T10:00:00.000Z",
    "2026-02-02T11:00:00.000Z",
    7,
  ]);
});

test("0 righe con row_hash uguale e' unchanged: nessuna revisione consumata, nessun errore", async () => {
  const { repository, client, queries } = repositoryWith([
    [/UPDATE identity\.users/, { rowCount: 0, rows: [] }],
    [/SELECT revision, row_hash/, { rows: [{ revision: "7", row_hash: ROW_HASH_A }] }],
  ]);

  const outcome = await repository.updateUser(client, userInput({ rowHash: ROW_HASH_A }), 7);

  assert.deepEqual(outcome, { outcome: "unchanged", id: "u1", revision: 7 });
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[1].parameters, ["u1"]);
});

test("0 righe con row_hash diverso e' conflitto 409, non un errore generico", async () => {
  const { repository, client } = repositoryWith([
    [/UPDATE identity\.users/, { rowCount: 0, rows: [] }],
    [/SELECT revision, row_hash/, { rows: [{ revision: "9", row_hash: ROW_HASH_C }] }],
  ]);

  await assert.rejects(
    repository.updateUser(client, userInput({ rowHash: ROW_HASH_B }), 7),
    (error) => {
      assert.equal(error.code, "IDENTITY_REVISION_CONFLICT");
      assert.equal(error.status, 409);
      assert.deepEqual(error.details, { id: "u1", expectedRevision: 7, actualRevision: 9 });
      // Il pinHash non entra mai in un messaggio d'errore (§4.7).
      assert.equal(error.message.includes(PIN_HASH), false);
      assert.equal(JSON.stringify(error.details).includes(PIN_HASH), false);
      return true;
    },
  );
});

test("0 righe e riga assente producono outcome missing, non un insert implicito", async () => {
  const { repository, client } = repositoryWith([
    [/UPDATE identity\.users/, { rowCount: 0, rows: [] }],
    [/SELECT revision, row_hash/, { rowCount: 0, rows: [] }],
  ]);

  assert.deepEqual(
    await repository.updateUser(client, userInput({ rowHash: ROW_HASH_B }), 7),
    { outcome: "missing", id: "u1", revision: null },
  );
});

test("updateUserGroup tiene revision fuori dalla SET e non usa now()", async () => {
  const { repository, client, queries } = repositoryWith([
    [/UPDATE identity\.user_groups/, { rows: [{ revision: "1" }] }],
  ]);

  await repository.updateUserGroup(client, groupInput({ rowHash: ROW_HASH_B }), 0);

  const sql = queries[0].sql;
  assert.doesNotMatch(setClauseOf(sql), /\brevision\b/i);
  assert.match(whereClauseOf(sql), /AND revision = \$9/);
  assert.match(whereClauseOf(sql), /AND row_hash IS DISTINCT FROM \$6/);
  assert.doesNotMatch(sql, /now\(\)/i);
  assert.match(setClauseOf(sql), /created_at\s+= COALESCE\(\$7::timestamptz, created_at\)/);
  assert.deepEqual(queries[0].parameters.at(-1), 0);
});

test("deleteUsers usa un parametro array e non concatena gli id", async () => {
  const { repository, client, queries } = repositoryWith([
    [/DELETE FROM identity\.users/, { rows: [{ id: "u2" }, { id: "u3" }] }],
  ]);

  const outcome = await repository.deleteUsers(client, ["u2", "u3", "u2"]);

  assert.deepEqual(outcome, { deleted: 2, ids: ["u2", "u3"] });
  assert.match(queries[0].sql, /WHERE id = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(queries[0].parameters, [["u2", "u3"]]);

  const { repository: idle, client: idleClient, queries: idleQueries } = repositoryWith([]);
  assert.deepEqual(await idle.deleteUsers(idleClient, []), { deleted: 0, ids: [] });
  assert.equal(idleQueries.length, 0);
});

// ---------------------------------------------------------------------------
// Validazione dell'input
// ---------------------------------------------------------------------------

test("il pinHash fuori contratto viene rifiutato senza mai comparire nell'errore", async () => {
  const { repository, client } = repositoryWith([]);

  await assert.rejects(
    repository.insertUser(client, userInput({ pinHash: "1234" })),
    (error) => {
      assert.equal(error.code, "IDENTITY_PIN_HASH_OUT_OF_CONTRACT");
      assert.equal(error.message.includes("1234"), false);
      assert.deepEqual(error.details, { id: "u1" });
      return true;
    },
  );
  // Il pinHash vuoto e' lecito (§4.7 punto 2).
  const { repository: ok, client: okClient, queries } = repositoryWith([
    [/INSERT INTO identity\.users/, { rows: [{ revision: "0" }] }],
  ]);
  await ok.insertUser(okClient, userInput({ pinHash: "" }));
  assert.equal(queries[0].parameters[5], "");
});

test("un profile con una chiave segreta non arriva mai al database", async () => {
  const { repository, client, queries } = repositoryWith([]);

  await assert.rejects(
    repository.insertUser(client, userInput({ profile: { pinHash: PIN_HASH } })),
    (error) => {
      assert.equal(error.code, "IDENTITY_PROFILE_CONTAINS_SECRET");
      assert.equal(error.message.includes(PIN_HASH), false);
      assert.deepEqual(error.details, { id: "u1", key: "pinHash" });
      return true;
    },
  );
  assert.equal(queries.length, 0);
});

test("row_hash, role e drift di normalizzazione sono errori rumorosi", async () => {
  const { repository, client } = repositoryWith([]);

  await assert.rejects(
    repository.insertUser(client, userInput({ rowHash: "non-un-hash" })),
    (error) => error.code === "POSTGRES_IDENTITY_INVALID_INPUT",
  );
  await assert.rejects(
    repository.insertUser(client, userInput({ role: "superadmin" })),
    (error) => error.code === "IDENTITY_ROLE_NOT_ALLOWED",
  );
  await assert.rejects(
    repository.insertUser(client, userInput({ usernameNormalized: "MARIO" })),
    (error) => error.code === "IDENTITY_USERNAME_NORMALIZATION_DRIFT" && error.details.id === "u1",
  );
  await assert.rejects(
    repository.insertUser(client, userInput({ updatedAt: "non-una-data" })),
    (error) => error.code === "POSTGRES_IDENTITY_INVALID_INPUT",
  );
});

test("normalizeUsername e' trim + lowercase, la stessa di server.js:3347-3351", () => {
  assert.equal(normalizeIdentityUsername("  Mario\t"), "mario");
  assert.equal(normalizeIdentityUsername(null), "");
  assert.equal(isAdministratorProfile("admin", {}), true);
  assert.equal(isAdministratorProfile("operator", { permissions: ["manage_users"] }), true);
  assert.equal(isAdministratorProfile("operator", { permissions: "manage_users" }), false);
  assert.equal(isAdministratorProfile("responsabile", { permissions: ["view_orders"] }), false);
  assert.equal(identityPinFingerprint(""), "");
  assert.match(identityPinFingerprint(PIN_HASH), /^sha256:[0-9a-f]{16}$/);
  assert.equal(identityPinFingerprint(PIN_HASH).includes(PIN_HASH), false);
});

// ---------------------------------------------------------------------------
// Prune (§4.9 P1-P5, D32)
// ---------------------------------------------------------------------------

function syncRules(existingUsers, overrides = []) {
  return [
    ...overrides,
    [/is_administrator/, { rows: existingUsers }],
    [/DELETE FROM identity\.users/, (_sql, parameters) => ({
      rows: (parameters[0] ?? []).map((id) => ({ id })),
    })],
    [/INSERT INTO identity\.users/, { rows: [{ revision: "0" }] }],
    [/UPDATE identity\.users/, { rows: [{ revision: "1" }] }],
  ];
}

const ADMIN_STATE = { id: "u1", revision: "0", row_hash: ROW_HASH_A, is_administrator: true };
const OPERATOR_STATE = { id: "u2", revision: "0", row_hash: ROW_HASH_B, is_administrator: false };

test("P1: senza dichiarazione la sync e' merge, non cancella e conta identityPruneSkipped.noIntent", async () => {
  const { repository, client, queries } = repositoryWith(syncRules([ADMIN_STATE, OPERATOR_STATE]));

  // È la writeDb di resetAppState: users: [] senza hint e senza identityReplace.
  const summary = await repository.syncFromAppState(client, { users: [], options: {} });

  assert.equal(summary.identityPruneSkipped.noIntent, 1);
  assert.equal(summary.users.pruned, false);
  assert.equal(summary.users.deleted, 0);
  assert.equal(summary.users.prunableIds, 2);
  assert.equal(queries.some((entry) => /DELETE FROM identity\.users/.test(entry.sql)), false);
  assert.equal(queries.length, 1);
});

test("P1: la dichiarazione identityReplace cancella davvero le righe omesse", async () => {
  const { repository, client, queries } = repositoryWith(syncRules([ADMIN_STATE, OPERATOR_STATE]));

  const summary = await repository.syncFromAppState(client, {
    users: [userInput({ id: "u1", rowHash: ROW_HASH_C })],
    options: { sessionsSync: { deleteMissing: true }, identityReplace: ["users", "userGroups"] },
  });

  assert.equal(summary.identityPruneSkipped.noIntent, 0);
  assert.equal(summary.users.pruned, true);
  assert.deepEqual(summary.users.deletedIds, ["u2"]);
  assert.equal(summary.users.updated, 1);
  const deleteQuery = queries.find((entry) => /DELETE FROM identity\.users/.test(entry.sql));
  assert.ok(deleteQuery, "la cancellazione dichiarata deve arrivare al database");
  // Due parametri e non uno: il prune porta la `revision` letta nella stessa transazione
  // come lock ottimistico per riga. `0` e' la revision di ADMIN_STATE/OPERATOR_STATE.
  assert.deepEqual(deleteQuery.parameters, [["u2"], [0]]);
  assert.match(whereClauseOf(deleteQuery.sql), /target\.revision = atteso\.revision/);
  // L'UPDATE della riga superstite usa la revision letta nella stessa transazione.
  const updateQuery = queries.find((entry) => /UPDATE identity\.users/.test(entry.sql));
  assert.equal(updateQuery.parameters.at(-1), 0);
  assert.doesNotMatch(setClauseOf(updateQuery.sql), /\brevision\b/i);
});

// D41 — questo test diceva l'opposto, e cosi' facendo CODIFICAVA un difetto: asseriva
// che `splitDomains: ["users"]` cancella gli utenti mancanti. Ma `splitDomains` e' un
// suggerimento su dove persistere, non una dichiarazione di possesso, e chi lo passa con
// "users" dentro e' `auth.login` (login-write-model.js:210) e `auth.changePin`
// (change-pin-write-model.js:80). Con il comportamento vecchio, una riga presente in
// identity.users ma non nell'app-state — per esempio aggiunta a mano da psql, che §4.8
// indica come procedura di riparazione — spariva al primo login successivo, in silenzio e
// senza conflitto, perche' il prune non ha lock ottimistico.
test("D41: gli hint splitDomains NON armano il prune, e un login non cancella utenti", async () => {
  const { repository, client, queries } = repositoryWith(syncRules([ADMIN_STATE, OPERATOR_STATE]));

  // La forma esatta di un login: lista parziale, splitDomains con "users" dentro.
  const summary = await repository.syncFromAppState(client, {
    users: [userInput({ id: "u1", rowHash: ROW_HASH_C })],
    options: { splitDomains: ["sessions", "users", "auditEvents"] },
  });

  assert.equal(summary.users.pruned, false, "un login non deve MAI armare una sostituzione integrale");
  assert.deepEqual(summary.users.deletedIds ?? [], []);
  assert.equal(
    queries.some((entry) => /DELETE FROM identity\.users/.test(entry.sql)),
    false,
    "u2 non compare nella lista parziale, ma non deve essere cancellato",
  );

  assert.equal(hasIdentityPruneIntent("users", { splitDomains: ["users"] }), false);
  assert.equal(hasIdentityPruneIntent("users", { identityReplace: ["users"] }), true);
  assert.equal(hasIdentityPruneIntent("users", {}), false);
  assert.equal(hasIdentityPruneIntent("sessions", { identityReplace: ["sessions"] }), false);
});

// D41 — svuotare `users` non lancia piu' per la FORMA del payload, ma resta impossibile
// per la ragione giusta: lascerebbe zero amministratori, e la protezione e' P3, non P2.
// La differenza non e' accademica. P2 guardava se l'array fosse vuoto; P3 guarda
// l'invariante. Con P2 armata, cancellare l'ultimo GRUPPO — operazione legittima e
// innocua — falliva, e siccome i gruppi si sincronizzano prima degli utenti faceva
// fallire in permanenza anche il write-through degli utenti.
test("D41/P3: svuotare users resta impossibile, ma per l'invariante e non per la forma", async () => {
  const { repository, client, queries } = repositoryWith(syncRules([ADMIN_STATE]));

  await assert.rejects(
    repository.syncFromAppState(client, { users: [], options: { identityReplace: ["users"] } }),
    (error) => {
      assert.equal(error.code, "IDENTITY_NO_SURVIVING_ADMINISTRATOR");
      return true;
    },
  );
  assert.equal(
    queries.some((entry) => /DELETE FROM/.test(entry.sql)),
    false,
    "P3 lancia PRIMA di scrivere: nessuna DELETE deve essere partita",
  );
});

// Il gemello: una collezione senza amministratori da difendere si puo' svuotare davvero.
// E' il caso dell'operatore che cancella l'ultimo gruppo dalla schermata.
test("D41: svuotare userGroups e' consentito e non blocca la sync degli utenti", async () => {
  // Un gruppo esiste davvero sul database, ed e' il caso che D40 aveva lasciato aperto.
  const { repository, client, queries } = repositoryWith(
    syncRules([ADMIN_STATE], [
      [/FROM identity\.user_groups/, { rows: [{ id: "g1", revision: "0", row_hash: ROW_HASH_B }] }],
      [/DELETE FROM identity\.user_groups/, (_sql, parameters) => ({
        rows: (parameters[0] ?? []).map((id) => ({ id })),
      })],
    ]),
  );

  const summary = await repository.syncFromAppState(client, {
    users: [userInput({ id: "u1", rowHash: ROW_HASH_C })],
    userGroups: [],
    options: { identityReplace: ["users", "userGroups"] },
  });

  assert.equal(summary.userGroups.pruned, true, "il gruppo va cancellato: l'ha chiesto chi possiede la collezione");
  assert.equal(
    queries.some((entry) => /DELETE FROM identity\.user_groups/.test(entry.sql)),
    true,
  );
  assert.ok(summary.users, "e soprattutto: la sync degli UTENTI deve essere avvenuta lo stesso");
  assert.equal(summary.identityPruneSkipped.emptyDeclared, 1);
  // D6 REV4 — il totale dice QUANTE, la scomposizione dice QUALE. Qui la collezione
  // svuotata e' `userGroups`, e `users` non e' stata toccata: due fatti diversi che il
  // solo `emptyDeclared: 1` confondeva.
  assert.deepEqual(summary.identityPruneSkipped.userGroups, { noIntent: 0, emptyDeclared: 1 });
  assert.deepEqual(summary.identityPruneSkipped.users, { noIntent: 0, emptyDeclared: 0 });
});

test("P3: una sync che lascerebbe zero amministratori lancia prima di scrivere", async () => {
  const { repository, client, queries } = repositoryWith(syncRules([ADMIN_STATE, OPERATOR_STATE]));

  await assert.rejects(
    repository.syncFromAppState(client, {
      users: [userInput({ id: "u2", username: "anna", role: "operator", profile: {}, rowHash: ROW_HASH_C })],
      options: { identityReplace: ["users"] },
    }),
    (error) => {
      assert.equal(error.code, "IDENTITY_NO_SURVIVING_ADMINISTRATOR");
      assert.equal(error.details.deletesPlanned, 1);
      return true;
    },
  );
  // Nessuna scrittura: la lettura di stato e basta.
  assert.equal(queries.length, 1);
  assert.equal(queries.some((entry) => /DELETE|INSERT|UPDATE/.test(entry.sql)), false);
});

test("P3: degradare l'ultimo amministratore in merge lancia comunque", async () => {
  const { repository, client } = repositoryWith(syncRules([ADMIN_STATE]));

  await assert.rejects(
    repository.syncFromAppState(client, {
      users: [userInput({ id: "u1", role: "operator", profile: {}, rowHash: ROW_HASH_C })],
      options: {},
    }),
    (error) => error.code === "IDENTITY_NO_SURVIVING_ADMINISTRATOR",
  );
});

test("un utente non-admin rimosso da users.save viene cancellato, l'admin resta", async () => {
  const { repository, client } = repositoryWith(syncRules([ADMIN_STATE, OPERATOR_STATE]));

  const summary = await repository.syncFromAppState(client, {
    users: [userInput({ id: "u1", rowHash: ROW_HASH_A })],
    options: { identityReplace: ["users", "userGroups"] },
  });

  assert.deepEqual(summary.users.deletedIds, ["u2"]);
  assert.equal(summary.users.pruned, true);
});

test("P4: solo allowIdentityPurge azzera davvero la collezione", async () => {
  const { repository, client, queries } = repositoryWith(syncRules([ADMIN_STATE, OPERATOR_STATE]));

  const summary = await repository.syncFromAppState(client, {
    users: [],
    options: { identityReplace: ["users"], allowIdentityPurge: true },
  });

  assert.equal(summary.users.pruned, true);
  assert.deepEqual(summary.users.deletedIds, ["u1", "u2"]);
  assert.equal(queries.filter((entry) => /DELETE FROM identity\.users/.test(entry.sql)).length, 1);
});

test("solo inserimenti su una tabella vuota non armano la regola dell'amministratore", async () => {
  const { repository, client } = repositoryWith(syncRules([]));

  const summary = await repository.syncFromAppState(client, {
    users: [userInput({ id: "u9", username: "anna", role: "operator", profile: {}, rowHash: ROW_HASH_C })],
    options: {},
  });

  // Mirror del CONSTRAINT TRIGGER, armato su AFTER UPDATE OR DELETE e non su INSERT.
  assert.equal(summary.users.inserted, 1);
  assert.equal(summary.users.pruned, false);
});

test("un dominio assente dall'input non viene toccato e non conta come merge saltato", async () => {
  const { repository, client, queries } = repositoryWith(syncRules([ADMIN_STATE]));

  const summary = await repository.syncFromAppState(client, { options: {} });

  assert.equal(summary.users, null);
  assert.equal(summary.userGroups, null);
  assert.equal(summary.identityPruneSkipped.noIntent, 0);
  assert.equal(queries.length, 0);
});

test("i gruppi seguono la stessa regola di prune degli utenti", async () => {
  const rules = [
    [/SELECT\s+id,\s+revision,\s+row_hash\s+FROM identity\.user_groups/, {
      rows: [{ id: "g1", revision: "0", row_hash: ROW_HASH_A }, { id: "g2", revision: "0", row_hash: ROW_HASH_B }],
    }],
    [/DELETE FROM identity\.user_groups/, (_sql, parameters) => ({
      rows: (parameters[0] ?? []).map((id) => ({ id })),
    })],
    [/UPDATE identity\.user_groups/, { rows: [{ revision: "1" }] }],
  ];

  const merge = repositoryWith(rules);
  const mergeSummary = await merge.repository.syncFromAppState(merge.client, {
    userGroups: [groupInput({ id: "g1", rowHash: ROW_HASH_C })],
    options: {},
  });
  assert.equal(mergeSummary.identityPruneSkipped.noIntent, 1);
  assert.equal(mergeSummary.userGroups.deleted, 0);
  assert.equal(merge.queries.some((entry) => /DELETE FROM/.test(entry.sql)), false);

  const replace = repositoryWith(rules);
  const replaceSummary = await replace.repository.syncFromAppState(replace.client, {
    userGroups: [groupInput({ id: "g1", rowHash: ROW_HASH_C })],
    options: { identityReplace: ["userGroups"] },
  });
  assert.deepEqual(replaceSummary.userGroups.deletedIds, ["g2"]);
  assert.equal(replaceSummary.userGroups.updated, 1);
});

test("la sync rifiuta id duplicati e chiavi di login duplicate senza stampare gli username", async () => {
  const { repository, client } = repositoryWith(syncRules([]));

  await assert.rejects(
    repository.syncFromAppState(client, {
      users: [userInput({ id: "u1" }), userInput({ id: "u1", username: "altro" })],
      options: {},
    }),
    (error) => error.code === "IDENTITY_DUPLICATE_ID",
  );
  await assert.rejects(
    repository.syncFromAppState(client, {
      users: [userInput({ id: "u1", username: "Mario" }), userInput({ id: "u2", username: " mario " })],
      options: {},
    }),
    (error) => {
      assert.equal(error.code, "IDENTITY_DUPLICATE_NORMALIZED_USERNAME");
      assert.equal(error.message.includes("mario"), false);
      assert.deepEqual(error.details, { ids: ["u1", "u2"] });
      return true;
    },
  );
});

test("nessun valore diagnostico della sync contiene il pinHash", async () => {
  const { repository, client, queries } = repositoryWith(syncRules([ADMIN_STATE, OPERATOR_STATE]));

  const summary = await repository.syncFromAppState(client, {
    users: [userInput({ id: "u1", rowHash: ROW_HASH_C })],
    options: { identityReplace: ["users"] },
  });

  assert.equal(JSON.stringify(summary).includes(PIN_HASH), false);
  assert.equal(JSON.stringify(summary).includes("scrypt$"), false);
  // Il valore reale viaggia solo come parametro della query, mai nel riepilogo.
  const insertOrUpdate = queries.filter((entry) => /UPDATE identity\.users/.test(entry.sql));
  assert.equal(insertOrUpdate[0].parameters[5], PIN_HASH);
});

test("il conflitto dentro la sync resta un 409 con soli id e revisioni", async () => {
  const { repository, client } = repositoryWith([
    [/is_administrator/, { rows: [ADMIN_STATE] }],
    [/UPDATE identity\.users/, { rowCount: 0, rows: [] }],
    [/SELECT revision, row_hash/, { rows: [{ revision: "5", row_hash: ROW_HASH_B }] }],
  ]);

  await assert.rejects(
    repository.syncFromAppState(client, {
      users: [userInput({ id: "u1", rowHash: ROW_HASH_C })],
      options: {},
    }),
    (error) => {
      assert.equal(error.code, "IDENTITY_REVISION_CONFLICT");
      assert.equal(error.status, 409);
      assert.deepEqual(error.details, { id: "u1", expectedRevision: 0, actualRevision: 5 });
      assert.equal(JSON.stringify(error.details).includes(PIN_HASH), false);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// §9.3 — test statico obbligatorio: «un solo scrittore»
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
// L'espressione cercava `UPDATE identity.` su QUALUNQUE tabella, ed era giusta finche' in
// quello schema vivevano solo utenti e gruppi. Con MIG-041 ci vive anche `identity.sessions`,
// scritta - correttamente - da un repository diverso: un repository per dominio e' proprio
// l'architettura che questo test difende. Restringere a `users`/`user_groups` non indebolisce
// l'asserzione, la riporta a cio' che intende dire. Se un giorno qualcuno scrivesse un secondo
// scrittore di UTENTI, il test tornerebbe rosso come deve.
// Gruppo NON catturante, e la ragione e' sottile: questa espressione viene usata anche con
// String.split, che con un gruppo di cattura inserisce nel risultato ANCHE i gruppi
// catturati. Con `(users|user_groups)` due UPDATE producevano quattro elementi e il test
// falliva senza che il codice avesse nulla che non andasse.
const IDENTITY_UPDATE_PATTERN = /UPDATE\s+identity\.(?:users|user_groups)\b/gi;

async function listSourceFiles(directory, relativeDirectory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    const relative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(absolute, relative));
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push({ absolute, relative });
    }
  }
  return files;
}

test("un solo scrittore: gli UPDATE su identity.users e identity.user_groups vivono solo nel loro repository", async () => {
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const files = [
    ...await listSourceFiles(path.join(appDir, "backend"), "backend"),
    ...await listSourceFiles(path.join(appDir, "scripts"), "scripts"),
  ];

  const occurrences = [];
  for (const file of files) {
    const source = await fs.readFile(file.absolute, "utf8");
    const matches = source.match(IDENTITY_UPDATE_PATTERN) ?? [];
    if (matches.length > 0) occurrences.push({ file: file.relative, count: matches.length });
  }

  assert.deepEqual(
    occurrences,
    [{ file: "backend/db/postgresql/identity.repository.js", count: 2 }],
    "Gli UPDATE su identity.users e identity.user_groups devono essere esattamente due e stare tutti nel loro repository.",
  );

  const repositorySource = await fs.readFile(
    path.join(appDir, "backend/db/postgresql/identity.repository.js"),
    "utf8",
  );
  const statements = repositorySource
    .split(IDENTITY_UPDATE_PATTERN)
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("RETURNING")));
  assert.equal(statements.length, 2);
  for (const statement of statements) {
    // Lock ottimistico presente...
    assert.match(statement, /AND revision = \$\d+/);
    // ...e revision assente dalla SET: la scrive il trigger della 010.
    const setClause = statement.slice(statement.indexOf("SET"), statement.indexOf("WHERE"));
    assert.doesNotMatch(setClause, /\brevision\b/i);
    assert.doesNotMatch(setClause, /now\(\)/i);
  }
});

// ---------------------------------------------------------------------------
// Il lock ottimistico del PRUNE, provato per davvero.
//
// Una revisione avversaria ha mostrato che i test che dicevano di provarlo NON lo provavano:
// togliendo `AND target.revision = atteso.revision` da entrambe le PRUNE, l'unico rosso era un
// test sulla FORMA della query, non sulla sua semantica. La causa e' che il doppio dei test
// restituiva come cancellati tutti gli id richiesti, ignorando la revisione — quindi il lock
// non era osservabile da nessuna asserzione.
//
// E' lo stesso schema gia' visto oggi due volte: una prova dichiarata che non morde. Qui il
// doppio emula il lock come fa il database, e il test misura la conseguenza che conta: una
// riga cambiata dopo lo snapshot NON viene cancellata.
// ---------------------------------------------------------------------------

test("il prune ha un lock ottimistico: una riga cambiata dopo lo snapshot sopravvive", async () => {
  // `u2` risulta a revisione 0 nello snapshot, ma sul database e' gia' passata a 7:
  // qualcun altro l'ha modificata fra la lettura e la scrittura.
  const revisioniVere = new Map([["u1", 0], ["u2", 7]]);

  const { repository, client, queries } = repositoryWith([
    [/is_administrator/, { rows: [ADMIN_STATE, OPERATOR_STATE] }],
    // Il doppio emula il DATABASE, non il desiderio del chiamante: cancella solo le righe la
    // cui revisione corrisponde a quella attesa, che e' precisamente cio' che fa la WHERE.
    [/DELETE FROM identity\.users/, (_sql, parameters) => {
      const ids = parameters[0] ?? [];
      const attese = parameters[1] ?? [];
      const cancellate = ids.filter((id, i) => revisioniVere.get(id) === Number(attese[i]));
      return { rows: cancellate.map((id) => ({ id })) };
    }],
    [/INSERT INTO identity\.users/, { rows: [{ revision: "0" }] }],
    [/UPDATE identity\.users/, { rows: [{ revision: "1" }] }],
  ]);

  // Il comportamento vero e' piu' forte di un semplice "non la cancella": il repository
  // se ne ACCORGE e lancia. E' la differenza fra una riga che sopravvive per caso e un
  // chiamante che sa di aver lavorato su una fotografia vecchia.
  await assert.rejects(
    repository.syncFromAppState(client, {
      users: [userInput({ id: "u1", rowHash: ROW_HASH_C })],
      options: { identityReplace: ["users"] },
    }),
    (error) => {
      assert.match(
        String(error.message),
        /cambiata durante la transazione/i,
        "u2 e' cambiata dopo lo snapshot: il lock deve impedirne la cancellazione E dirlo. "
          + "Senza, una modifica concorrente verrebbe distrutta da una sostituzione integrale "
          + "che non l'ha mai vista.",
      );
      return true;
    },
  );

  // E la DELETE deve essere stata TENTATA con la revisione attesa: se il repository smettesse
  // di passarla, il lock sparirebbe senza che nessuna asserzione se ne accorga.
  const prune = queries.find((entry) => /DELETE FROM identity\.users/.test(entry.sql));
  assert.ok(prune, "il prune deve essere stato tentato");
  assert.match(
    prune.sql,
    /AND\s+target\.revision\s*=\s*atteso\.revision/,
    "la WHERE deve contenere il lock",
  );
  assert.ok(
    Array.isArray(prune.parameters?.[1]) && prune.parameters[1].length === prune.parameters[0].length,
    "le revisioni attese devono essere passate, una per id",
  );
});


