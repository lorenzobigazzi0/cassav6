// MIG-040 §9.4 D39 — l'innesto dello store identity in createAuthRepository.
//
// Si misura il comportamento dei rami, non il SQL: lo store e' finto e sincrono per
// costruzione, e uno dei test usa di proposito uno store che ritorna Promise per provare che
// R2 ha i denti e non e' un commento.

import assert from "node:assert/strict";
import test from "node:test";

import { createAuthRepository } from "../modules/auth/auth.repository.js";
import { createPostgresqlIdentityStore, rowToUser } from "../db/postgresql/index.js";

const PIN_HASH = `scrypt$32768$8$1$${"ab".repeat(16)}$${"cd".repeat(32)}`;
const PRIMARY_ENV = Object.freeze({
  BACKEND_POSTGRES_ENABLED: "1",
  BACKEND_POSTGRES_PRIMARY_DOMAINS: "identity",
});

function pgUser(overrides = {}) {
  return rowToUser({
    id: "u_pg",
    username: "Mario",
    username_normalized: "mario",
    full_name: "Mario Rossi",
    role: "admin",
    pin_hash: PIN_HASH,
    profile: { permissions: ["manage_users"] },
    app_state_position: 0,
    row_hash: "a".repeat(64),
    revision: "1",
    created_at: new Date("2026-01-01T10:00:00.000Z"),
    updated_at: new Date("2026-01-01T10:00:00.000Z"),
    ...overrides,
  });
}

// Store vero, repository finto: cosi' l'innesto vede la superficie reale.
async function loadedStore(options = {}) {
  const users = options.users ?? [pgUser()];
  const store = createPostgresqlIdentityStore({
    env: options.env ?? PRIMARY_ENV,
    logger: { warn() {}, error() {} },
    repository: {
      async listUsers() {
        return users;
      },
      async listUserGroups() {
        return [];
      },
    },
  });
  if (options.load !== false) await store.refresh();
  return store;
}

// Store finto minimo, per gli stati che il repository non sa produrre a comando.
function fakeStore(overrides = {}) {
  return {
    isPrimaryDomain: (collection) => ["users", "userGroups"].includes(collection),
    snapshotStatus: () => ({ ok: true, reason: null, ageMs: 0, maxStalenessMs: 5000 }),
    listUsers: () => [],
    getUserById: () => null,
    listUserGroups: () => [],
    ...overrides,
  };
}

const APP_STATE = Object.freeze({
  users: [{ id: "u_legacy", username: "legacy", role: "operator", pinHash: "" }],
});

// ---------------------------------------------------------------------------
// Default: senza store, niente cambia
// ---------------------------------------------------------------------------

test("senza identityStore il comportamento e' identico a prima: app-state", () => {
  const repository = createAuthRepository({});
  assert.equal(repository.isIdentityPrimary("users"), false);
  assert.deepEqual(repository.listUsers(APP_STATE), APP_STATE.users);
  assert.equal(repository.getUserById(APP_STATE, "u_legacy").username, "legacy");
  assert.equal(repository.getUserByUsername(APP_STATE, "LEGACY").id, "u_legacy");
  assert.equal(repository.getUserById(APP_STATE, "assente"), null);
});

test("uno store a livello off non accende nessun ramo", async () => {
  const store = await loadedStore({ env: {}, load: false });
  const repository = createAuthRepository({ identityStore: store });
  assert.equal(repository.isIdentityPrimary("users"), false);
  assert.deepEqual(repository.listUsers(APP_STATE), APP_STATE.users);
});

// ---------------------------------------------------------------------------
// R1 — precedenza e mutua esclusione
// ---------------------------------------------------------------------------

test("R1: il ramo identity viene prima di isPrimaryDomain('users')", async () => {
  const store = await loadedStore();
  // Il relazionale diventa primary DOPO la costruzione: cosi' si osserva l'ordine dei rami
  // senza costruire la combinazione che R1 vieta al boot.
  const relational = { primary: false, isPrimaryDomain: () => relational.primary, db: null };
  const repository = createAuthRepository({ identityStore: store, relationalRuntime: relational });
  relational.primary = true;
  assert.equal(repository.listUsers(APP_STATE)[0].id, "u_pg");
  assert.equal(repository.getUserById(APP_STATE, "u_pg").id, "u_pg");
});

test("R1: identity primary insieme a users relazionale fa fallire la costruzione", async () => {
  const store = await loadedStore();
  assert.throws(
    () =>
      createAuthRepository({
        identityStore: store,
        relationalRuntime: { isPrimaryDomain: (domain) => domain === "users", db: null },
      }),
    (error) =>
      error.message.includes("BACKEND_POSTGRES_PRIMARY_DOMAINS")
      && error.message.includes("BACKEND_RELATIONAL_PRIMARY_DOMAINS"),
  );
  // Il conflitto e' su `users`: un relazionale primary su altri domini non e' un conflitto.
  assert.doesNotThrow(() =>
    createAuthRepository({
      identityStore: store,
      relationalRuntime: { isPrimaryDomain: (domain) => domain === "sessions", db: null },
    }),
  );
});

// ---------------------------------------------------------------------------
// Il ramo identity, e i quattro 503
// ---------------------------------------------------------------------------

test("a primary le letture vengono da PostgreSQL, app-state ignorato", async () => {
  const repository = createAuthRepository({ identityStore: await loadedStore() });
  assert.equal(repository.isIdentityPrimary("users"), true);
  const users = repository.listUsers(APP_STATE);
  assert.equal(users.length, 1);
  assert.equal(users[0].id, "u_pg");
  assert.equal(repository.getUserById(APP_STATE, "u_legacy"), null, "l'app-state non e' piu' la verita'");
  assert.equal(repository.getUserById(APP_STATE, "u_pg").pinHash, PIN_HASH, "il pinHash e' il dato");
});

test("getUserByUsername resta invariata ed eredita il ramo identity", async () => {
  const repository = createAuthRepository({ identityStore: await loadedStore() });
  // La normalizzazione autorevole resta quella JavaScript (D38.2).
  assert.equal(repository.getUserByUsername(APP_STATE, "  MARIO  ").id, "u_pg");
  assert.equal(repository.getUserByUsername(APP_STATE, "legacy"), null);
  // Copia profonda: mutare il risultato non tocca lo store.
  const first = repository.getUserByUsername(APP_STATE, "mario");
  first.role = "operator";
  assert.equal(repository.getUserByUsername(APP_STATE, "mario").role, "admin");
});

test("R-FRESH-6: le quattro cause producono un solo codice, 503, con `reason` per l'operatore", async () => {
  const causes = [
    { reason: "never_loaded", ageMs: null },
    { reason: "refresh_failed", ageMs: 12 },
    { reason: "stale", ageMs: 9000 },
    { reason: "duplicate_normalized_username", ageMs: 3 },
  ];
  for (const cause of causes) {
    const repository = createAuthRepository({
      identityStore: fakeStore({
        snapshotStatus: () => ({ ok: false, reason: cause.reason, ageMs: cause.ageMs, maxStalenessMs: 5000 }),
        listUsers: () => {
          throw new Error("non si deve arrivare qui");
        },
        getUserById: () => {
          throw new Error("non si deve arrivare qui");
        },
      }),
    });
    for (const call of [() => repository.listUsers(APP_STATE), () => repository.getUserById(APP_STATE, "u_pg")]) {
      assert.throws(call, (error) => {
        assert.equal(error.code, "IDENTITY_STORE_UNAVAILABLE");
        assert.equal(error.status, 503);
        assert.equal(error.details.reason, cause.reason);
        assert.equal(error.details.ageMs, cause.ageMs);
        assert.equal(error.details.maxStalenessMs, 5000);
        assert.ok(!`${error.message}${JSON.stringify(error.details)}`.includes("scrypt$"));
        return true;
      }, `${cause.reason} deve produrre un 503`);
    }
  }
});

test("il nome IDENTITY_SNAPSHOT_STALE non esiste, e la fonte non fallback sull'app-state", () => {
  const repository = createAuthRepository({
    identityStore: fakeStore({
      snapshotStatus: () => ({ ok: false, reason: "stale", ageMs: 9000, maxStalenessMs: 5000 }),
    }),
  });
  assert.throws(
    () => repository.listUsers(APP_STATE),
    (error) => error.code === "IDENTITY_STORE_UNAVAILABLE" && error.code !== "IDENTITY_SNAPSHOT_STALE",
  );
});

test("uno snapshot vuoto ma fresco e' una risposta legittima, non un 503", () => {
  const repository = createAuthRepository({ identityStore: fakeStore() });
  assert.deepEqual(repository.listUsers(APP_STATE), []);
  assert.equal(repository.getUserById(APP_STATE, "u_pg"), null);
});

// ---------------------------------------------------------------------------
// R2 — la sincronia, con i denti
// ---------------------------------------------------------------------------

test("R2: getUserById e listUsers non ritornano mai una Promise", async () => {
  const repository = createAuthRepository({ identityStore: await loadedStore() });
  assert.equal(repository.getUserById(APP_STATE, "u_pg") instanceof Promise, false);
  assert.equal(repository.listUsers(APP_STATE) instanceof Promise, false);
  assert.equal(repository.getUserByUsername(APP_STATE, "mario") instanceof Promise, false);
  // Anche sul ramo app-state, che e' quello di oggi.
  const legacy = createAuthRepository({});
  assert.equal(legacy.getUserById(APP_STATE, "u_legacy") instanceof Promise, false);
});

test("R2: uno store che ritorna Promise viene rifiutato, non inoltrato", () => {
  // Senza questa guardia il valore truthy arriverebbe a `validateResolvedSessionContext`
  // (cercala in backend/server.js) e ogni sessione sarebbe valida per chiunque.
  // Senza numero di riga di proposito: questa citazione e' gia' scaduta due volte in un
  // giorno perche' server.js cresce sopra di lei, e il numero non aggiunge niente al nome.
  const asyncStore = fakeStore({
    listUsers: async () => [pgUser().record],
    getUserById: async () => pgUser().record,
  });
  const repository = createAuthRepository({ identityStore: asyncStore });
  for (const call of [() => repository.listUsers(APP_STATE), () => repository.getUserById(APP_STATE, "u_pg")]) {
    let returned;
    assert.throws(
      () => {
        returned = call();
      },
      (error) => error.code === "IDENTITY_STORE_CONTRACT_VIOLATION" && error.status === 500,
    );
    assert.equal(returned, undefined, "non si ritorna mai una Promise truthy");
  }
});

test("R4: le letture dell'innesto non innescano nessuna query", async () => {
  let calls = 0;
  const store = createPostgresqlIdentityStore({
    env: PRIMARY_ENV,
    logger: { warn() {}, error() {} },
    repository: {
      async listUsers() {
        calls += 1;
        return [pgUser()];
      },
      async listUserGroups() {
        calls += 1;
        return [];
      },
    },
  });
  await store.refresh();
  const baseline = calls;
  const repository = createAuthRepository({ identityStore: store });
  for (let index = 0; index < 1000; index += 1) {
    repository.getUserById(APP_STATE, "u_pg");
  }
  repository.listUsers(APP_STATE);
  repository.getUserByUsername(APP_STATE, "mario");
  assert.equal(calls, baseline);
});
