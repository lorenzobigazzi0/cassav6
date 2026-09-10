// MIG-040 — L'interruttore (D31) e lo store di lettura identity (§9.4, §3.3, §3.4).
//
// Nessun PostgreSQL vero e nessun cluster: il repository e' finto e conta le chiamate, cosi'
// «zero query durante mille getUserById» (R4) e' una misura e non un'affermazione. Le righe
// passano per il vero rowToUser/rowToUserGroup di identity.repository.js: cio' che si misura
// e' lo store, non una seconda copia del mapping.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as postgresql from "../db/postgresql/index.js";

const {
  createPostgresqlIdentityStore,
  DEFAULT_MAX_STALENESS_MS,
  DEFAULT_SHADOW_INTERVAL_MS,
  DEFAULT_SNAPSHOT_TTL_MS,
  IDENTITY_SNAPSHOT_REASONS,
  IDENTITY_STORE_UNAVAILABLE,
  indexUsers,
  isIdentityStoreRequired,
  normalizeIdentityMode,
  rowToUser,
  rowToUserGroup,
} = postgresql;

const PIN_HASH = `scrypt$32768$8$1$${"ab".repeat(16)}$${"cd".repeat(32)}`;
const OTHER_PIN_HASH = `scrypt$32768$8$1$${"ef".repeat(16)}$${"09".repeat(32)}`;
const ROW_HASH = "a".repeat(64);

const PRIMARY_ENV = Object.freeze({
  BACKEND_POSTGRES_ENABLED: "1",
  BACKEND_POSTGRES_PRIMARY_DOMAINS: "identity",
});

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

// Repository finto: conta le chiamate e sa fallire su richiesta.
function fakeRepository(options = {}) {
  const state = {
    users: (options.users ?? [userRow()]).map(rowToUser),
    userGroups: (options.userGroups ?? [groupRow()]).map(rowToUserGroup),
    calls: { listUsers: 0, listUserGroups: 0 },
    failure: options.failure ?? null,
  };
  return {
    state,
    repository: {
      async listUsers() {
        state.calls.listUsers += 1;
        if (state.failure) throw state.failure;
        return state.users;
      },
      async listUserGroups() {
        state.calls.listUserGroups += 1;
        if (state.failure) throw state.failure;
        return state.userGroups;
      },
    },
  };
}

function silentLogger() {
  const lines = [];
  const sink = (...args) => lines.push(args.map((entry) => String(entry)).join(" "));
  return { lines, logger: { warn: sink, error: sink, info: sink, log: sink } };
}

function storeWith(options = {}) {
  const { state, repository } = fakeRepository(options);
  const clock = { value: options.startedAt ?? 1_000_000 };
  const { lines, logger } = silentLogger();
  const timers = [];
  const store = createPostgresqlIdentityStore({
    env: options.env ?? PRIMARY_ENV,
    repository,
    logger,
    now: () => clock.value,
    setInterval: (fn, ms) => {
      const handle = { fn, ms, unrefCalled: false, unref() { handle.unrefCalled = true; } };
      timers.push(handle);
      return handle;
    },
    clearInterval: (handle) => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return { clock, lines, state, store, timers };
}

// ---------------------------------------------------------------------------
// D31 — l'interruttore, spento per difetto
// ---------------------------------------------------------------------------

test("D31: senza le tre liste il dominio identity e' off e i default sono quelli dichiarati", () => {
  const mode = normalizeIdentityMode({ env: {} });
  assert.equal(mode.enabled, false);
  assert.equal(mode.identityLevel, "off");
  assert.equal(mode.isIdentityPrimary, false);
  assert.equal(mode.isIdentityShadow, false);
  assert.equal(mode.snapshotTtlMs, DEFAULT_SNAPSHOT_TTL_MS);
  assert.equal(mode.snapshotTtlMs, 1000);
  assert.equal(mode.maxStalenessMs, DEFAULT_MAX_STALENESS_MS);
  assert.equal(mode.maxStalenessMs, 5000);
  assert.equal(mode.shadowIntervalMs, DEFAULT_SHADOW_INTERVAL_MS);
  assert.equal(isIdentityStoreRequired(mode), false);
});

test("D31: i quattro livelli si esprimono con le righe, non con un valore", () => {
  const enabled = { BACKEND_POSTGRES_ENABLED: "1" };
  assert.equal(normalizeIdentityMode({ env: enabled }).identityLevel, "off");
  assert.equal(
    normalizeIdentityMode({ env: { ...enabled, BACKEND_POSTGRES_SHADOW_DOMAINS: "identity" } }).identityLevel,
    "shadow",
  );
  assert.equal(normalizeIdentityMode({ env: { ...enabled, ...PRIMARY_ENV } }).identityLevel, "primary");
  const exclusive = normalizeIdentityMode({
    env: { ...PRIMARY_ENV, BACKEND_POSTGRES_LEGACY_WRITE_GUARD_DOMAINS: "identity" },
  });
  assert.equal(exclusive.identityLevel, "exclusive");
  assert.equal(exclusive.isIdentityPrimary, true);
  assert.equal(exclusive.isIdentityLegacyWriteGuard, true);
});

// MIG-041 ha cambiato UN dato di questo test e nessuna delle sue asserzioni: il valore fuori
// elenco era 'sessions', che da MIG-041 e' un dominio VERO (identity-mode.js:33). L'esempio e'
// ora una stringa che nessuna migrazione rendera' un dominio; cio' che si misura — «un valore
// fuori elenco lancia nominando la variabile e i valori ammessi» — e' rimasto identico, e in
// piu' si assicura che l'elenco stampato contenga ENTRAMBI i domini esistenti, che e' la
// ragione per cui il messaggio elenca invece di dire «non valido».
test("D31 controllo 1: un dominio fuori elenco lancia con l'elenco dei valori ammessi", () => {
  for (const envName of [
    "BACKEND_POSTGRES_SHADOW_DOMAINS",
    "BACKEND_POSTGRES_PRIMARY_DOMAINS",
    "BACKEND_POSTGRES_LEGACY_WRITE_GUARD_DOMAINS",
  ]) {
    assert.throws(
      () => normalizeIdentityMode({ env: { BACKEND_POSTGRES_ENABLED: "1", [envName]: "identita" } }),
      (error) =>
        error.message.includes(envName)
        && error.message.includes("identita")
        && error.message.includes("identity")
        && error.message.includes("sessions"),
      `${envName} deve lanciare nominando se stessa e l'elenco ammesso`,
    );
  }
  // E il contrario: i due domini che esistono davvero NON lanciano su nessuna delle tre liste.
  assert.doesNotThrow(() =>
    normalizeIdentityMode({
      env: { BACKEND_POSTGRES_ENABLED: "1", BACKEND_POSTGRES_SHADOW_DOMAINS: "identity,sessions" },
    }),
  );
});

test("D31 controllo 2: una lista non vuota senza BACKEND_POSTGRES_ENABLED e' fatale", () => {
  assert.throws(
    () => normalizeIdentityMode({ env: { BACKEND_POSTGRES_PRIMARY_DOMAINS: "identity" } }),
    /BACKEND_POSTGRES_ENABLED=1/,
  );
});

test("D31 controllo 3: lo stesso dominio in SHADOW e in PRIMARY e' vietato", () => {
  assert.throws(
    () =>
      normalizeIdentityMode({
        env: {
          BACKEND_POSTGRES_ENABLED: "1",
          BACKEND_POSTGRES_SHADOW_DOMAINS: "identity",
          BACKEND_POSTGRES_PRIMARY_DOMAINS: "identity",
        },
      }),
    /sia in BACKEND_POSTGRES_SHADOW_DOMAINS sia in BACKEND_POSTGRES_PRIMARY_DOMAINS/,
  );
});

test("D31 controlli 4, 7 e 8: la guardia senza primary, lo scrittore legacy ancora armato a L4, e il mezzo passo", () => {
  assert.throws(
    () =>
      normalizeIdentityMode({
        env: {
          BACKEND_POSTGRES_ENABLED: "1",
          BACKEND_POSTGRES_LEGACY_WRITE_GUARD_DOMAINS: "identity",
        },
      }),
    /assente da BACKEND_POSTGRES_PRIMARY_DOMAINS/,
  );

  // D5 REV4 — controllo 7. Il livello L4 non e' piu' un'etichetta: se lo split app-state
  // MariaDB e' acceso e scriverebbe ancora `users`/`userGroups`, il boot fallisce.
  const guarded = { ...PRIMARY_ENV, BACKEND_POSTGRES_LEGACY_WRITE_GUARD_DOMAINS: "identity" };
  const CUTOVER_DOMAINS = "menuItems,posSettings,payments,saleSessions";

  // (1) split acceso, lista assente => valgono i default di server.js, che contengono
  //     ENTRAMBE le collezioni. E' il caso che nessuno vedeva.
  assert.throws(
    () =>
      normalizeIdentityMode({
        env: { ...guarded, BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1" },
      }),
    (error) =>
      error.message.includes("BACKEND_POSTGRES_LEGACY_WRITE_GUARD_DOMAINS")
      && error.message.includes("BACKEND_MYSQL_APP_STATE_DOMAINS")
      && error.message.includes("users")
      && error.message.includes("userGroups")
      && error.message.includes("assente"),
    "lista assente = domini di default: la guardia deve scattare e dirlo",
  );

  // (2) split acceso e lista che nomina ancora una sola delle due: scatta lo stesso, e
  //     nomina quella e non l'altra.
  assert.throws(
    () =>
      normalizeIdentityMode({
        env: {
          ...guarded,
          BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
          BACKEND_MYSQL_APP_STATE_DOMAINS: `${CUTOVER_DOMAINS},userGroups`,
        },
      }),
    (error) => error.message.includes("userGroups") && !error.message.includes("users,"),
  );

  // (3) le due righe di D31 punto 5 messe insieme, come vuole il passo 5 del runbook:
  //     il boot passa e `isIdentityLegacyWriteGuard` significa qualcosa.
  const ok = normalizeIdentityMode({
    env: {
      ...guarded,
      BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
      BACKEND_MYSQL_APP_STATE_DOMAINS: CUTOVER_DOMAINS,
    },
  });
  assert.equal(ok.identityLevel, "exclusive");
  assert.equal(ok.isIdentityLegacyWriteGuard, true);

  // (4) split spento, o motore non MySQL: nessuno scrittore legacy, nessun falso positivo.
  assert.equal(
    normalizeIdentityMode({ env: { ...guarded, BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "0" } })
      .identityLevel,
    "exclusive",
  );
  assert.equal(
    normalizeIdentityMode({
      env: { ...guarded, BACKEND_DB_MODE: "sqlite", BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1" },
    }).identityLevel,
    "exclusive",
  );

  // (5) L3 non e' toccato: chi resta a primary non subisce il controllo 7.
  assert.equal(
    normalizeIdentityMode({ env: { ...PRIMARY_ENV, BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1" } })
      .identityLevel,
    "primary",
  );

  // ---- Controllo 8: il MEZZO PASSO. La coppia di righe di L3 si muove insieme, e la meta'
  // che si raggiunge per dimenticanza e' quella che lascia fuori tutti.
  const mezzoPasso = {
    BACKEND_POSTGRES_ENABLED: "1",
    BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "1",
    BACKEND_MYSQL_APP_STATE_DOMAINS: CUTOVER_DOMAINS,
  };

  // (6) andata dimenticata: la lista MySQL e' gia' senza identity, PRIMARY non c'e' ancora.
  //     Vale a livello `off` (L1) e a livello `shadow` (L2), che e' il gradino da cui si parte.
  for (const livello of [{}, { BACKEND_POSTGRES_SHADOW_DOMAINS: "identity" }]) {
    assert.throws(
      () => normalizeIdentityMode({ env: { ...mezzoPasso, ...livello } }),
      (error) =>
        error.message.includes("BACKEND_MYSQL_APP_STATE_DOMAINS")
        && error.message.includes("BACKEND_POSTGRES_PRIMARY_DOMAINS")
        && error.message.includes("users")
        && error.message.includes("userGroups")
        && error.message.includes("mezzo passo"),
      `il mezzo passo deve essere fatale anche con ${JSON.stringify(livello)}`,
    );
  }

  // (7) ritorno dimenticato: mezza lista rimessa. Nomina quella che manca e non l'altra.
  assert.throws(
    () =>
      normalizeIdentityMode({
        env: { ...mezzoPasso, BACKEND_MYSQL_APP_STATE_DOMAINS: `${CUTOVER_DOMAINS},users` },
      }),
    (error) => error.message.includes("userGroups") && !error.message.includes("users,"),
  );

  // (8) le due righe insieme: e' L3, e passa.
  assert.equal(
    normalizeIdentityMode({ env: { ...mezzoPasso, ...PRIMARY_ENV } }).identityLevel,
    "primary",
  );

  // (9) nessun falso positivo. Lista assente o vuota = i default, che portano entrambe le
  //     collezioni; split spento o motore non MySQL = nessuno scrittore legacy da spegnere;
  //     runtime PostgreSQL spento = macchina fuori dalla strada di MIG-040.
  for (const innocua of [
    { ...mezzoPasso, BACKEND_MYSQL_APP_STATE_DOMAINS: undefined },
    { ...mezzoPasso, BACKEND_MYSQL_APP_STATE_DOMAINS: "" },
    { ...mezzoPasso, BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS: "0" },
    { ...mezzoPasso, BACKEND_DB_MODE: "sqlite" },
    { ...mezzoPasso, BACKEND_POSTGRES_ENABLED: undefined },
  ]) {
    assert.equal(
      normalizeIdentityMode({ env: innocua }).identityLevel,
      "off",
      `configurazione innocua rifiutata: ${JSON.stringify(innocua)}`,
    );
  }
});

test("D31 punto 3: BACKEND_POSTGRES_DOMAIN_MODE presente nell'ambiente fa fallire il boot", () => {
  assert.throws(
    () => normalizeIdentityMode({ env: { BACKEND_POSTGRES_DOMAIN_MODE: "identity:shadow" } }),
    (error) =>
      error.message.includes("alias documentale")
      && error.message.includes("BACKEND_POSTGRES_SHADOW_DOMAINS")
      && error.message.includes("BACKEND_POSTGRES_PRIMARY_DOMAINS")
      && error.message.includes("BACKEND_POSTGRES_LEGACY_WRITE_GUARD_DOMAINS"),
  );
  // Anche vuota: e' la PRESENZA a essere un errore, non il valore.
  assert.throws(() => normalizeIdentityMode({ env: { BACKEND_POSTGRES_DOMAIN_MODE: "" } }), /alias documentale/);
});

test("D39 R1: identity primary insieme a users relazionale nomina entrambe le variabili", () => {
  assert.throws(
    () =>
      normalizeIdentityMode({
        env: { ...PRIMARY_ENV, BACKEND_RELATIONAL_PRIMARY_DOMAINS: "sessions,users" },
      }),
    (error) =>
      error.message.includes("BACKEND_POSTGRES_PRIMARY_DOMAINS")
      && error.message.includes("BACKEND_RELATIONAL_PRIMARY_DOMAINS"),
  );
  // A shadow non c'e' conflitto: il legacy resta l'autorita'.
  assert.doesNotThrow(() =>
    normalizeIdentityMode({
      env: {
        BACKEND_POSTGRES_ENABLED: "1",
        BACKEND_POSTGRES_SHADOW_DOMAINS: "identity",
        BACKEND_RELATIONAL_PRIMARY_DOMAINS: "users",
      },
    }),
  );
});

test("R-FRESH-4 / R6: MAX_STALENESS_MS fuori da [2 x TTL, 60000] non fa partire il boot, zero compreso", () => {
  const base = { ...PRIMARY_ENV };
  for (const value of ["0", "1", "1999", "60001"]) {
    assert.throws(
      () => normalizeIdentityMode({ env: { ...base, BACKEND_POSTGRES_IDENTITY_MAX_STALENESS_MS: value } }),
      /BACKEND_POSTGRES_IDENTITY_MAX_STALENESS_MS non valido/,
      `${value} deve essere rifiutato`,
    );
  }
  assert.equal(
    normalizeIdentityMode({ env: { ...base, BACKEND_POSTGRES_IDENTITY_MAX_STALENESS_MS: "2000" } }).maxStalenessMs,
    2000,
  );
  assert.equal(
    normalizeIdentityMode({ env: { ...base, BACKEND_POSTGRES_IDENTITY_MAX_STALENESS_MS: "60000" } }).maxStalenessMs,
    60000,
  );
  // Un TTL che rende vuoto l'intervallo ammesso si rifiuta a monte.
  assert.throws(
    () => normalizeIdentityMode({ env: { ...base, BACKEND_POSTGRES_IDENTITY_SNAPSHOT_TTL_MS: "40000" } }),
    /BACKEND_POSTGRES_IDENTITY_SNAPSHOT_TTL_MS non valido/,
  );
  assert.throws(
    () => normalizeIdentityMode({ env: { ...base, BACKEND_POSTGRES_IDENTITY_SNAPSHOT_TTL_MS: "1.5" } }),
    /Atteso un intero/,
  );
});

// ---------------------------------------------------------------------------
// Lo store: inerzia, superficie sincrona, isolamento
// ---------------------------------------------------------------------------

test("lo store e' inerte per difetto: nessun ramo primario senza le liste", async () => {
  const { store } = storeWith({ env: {} });
  assert.equal(store.enabled, false);
  assert.equal(store.identityLevel, "off");
  assert.equal(store.isPrimaryDomain("users"), false);
  assert.equal(store.isPrimaryDomain("userGroups"), false);
  assert.equal(store.start(), false);
});

test("isPrimaryDomain mappa le due collezioni app-state e nient'altro", () => {
  const { store } = storeWith();
  assert.equal(store.isPrimaryDomain("users"), true);
  assert.equal(store.isPrimaryDomain("userGroups"), true);
  assert.equal(store.isPrimaryDomain("sessions"), false);
  assert.equal(store.isPrimaryDomain(""), false);
  assert.equal(store.isPrimaryDomain(undefined), false);
  const shadow = storeWith({
    env: { BACKEND_POSTGRES_ENABLED: "1", BACKEND_POSTGRES_SHADOW_DOMAINS: "identity" },
  }).store;
  assert.equal(shadow.isPrimaryDomain("users"), false, "a shadow il legacy resta l'autorita'");
  assert.equal(shadow.isShadowDomain("users"), true);
});

test("R5: snapshotStatus giudica never_loaded, refresh_failed, stale, duplicate e ok", async () => {
  const { clock, store, state } = storeWith();
  assert.deepEqual(store.snapshotStatus(), {
    ok: false,
    reason: "never_loaded",
    ageMs: null,
    maxStalenessMs: 5000,
  });

  await store.refresh();
  assert.deepEqual(store.snapshotStatus(), { ok: true, reason: null, ageMs: 0, maxStalenessMs: 5000 });

  clock.value += 5000;
  assert.equal(store.snapshotStatus().ok, true, "ageMs == maxStalenessMs non e' ancora stale");
  clock.value += 1;
  const stale = store.snapshotStatus();
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale");
  assert.equal(stale.ageMs, 5001);

  // Latch: il primo refresh fallito rende il servizio 503 senza aspettare l'eta'.
  clock.value = 1_000_000;
  await store.refresh();
  assert.equal(store.snapshotStatus().ok, true);
  state.failure = Object.assign(new Error("connessione caduta"), { code: "ECONNREFUSED" });
  await assert.rejects(() => store.refresh());
  const failed = store.snapshotStatus();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "refresh_failed");
  assert.equal(failed.ageMs, 0, "il latch non aspetta che scada un'eta'");

  // Si azzera SOLO con un refresh riuscito.
  state.failure = null;
  await store.refresh();
  assert.equal(store.snapshotStatus().ok, true);

  for (const status of [stale, failed]) {
    assert.ok(IDENTITY_SNAPSHOT_REASONS.includes(status.reason));
  }
});

test("D38.2: due username che normalizzano uguale armano il latch, con gli id e mai gli username", async () => {
  const { lines, store } = storeWith({
    users: [userRow(), userRow({ id: "u2", username: " MARIO ", pin_hash: OTHER_PIN_HASH })],
  });
  await assert.rejects(
    () => store.refresh(),
    (error) => {
      assert.equal(error.code, IDENTITY_STORE_UNAVAILABLE);
      assert.equal(error.status, 503);
      assert.equal(error.details.reason, "duplicate_normalized_username");
      assert.deepEqual(error.details.ids, ["u1", "u2"]);
      const serialized = `${error.message} ${JSON.stringify(error.details)}`;
      assert.ok(!serialized.toLowerCase().includes("mario"), "nessun username nell'errore");
      assert.ok(!serialized.includes(PIN_HASH) && !serialized.includes("scrypt$"), "nessun pinHash");
      return true;
    },
  );
  const status = store.snapshotStatus();
  assert.equal(status.ok, false);
  assert.equal(status.reason, "duplicate_normalized_username");
  assert.equal(store.listUsers().length, 0, "lo snapshot ambiguo non viene installato");

  const logged = lines.join("\n");
  assert.ok(logged.includes("u1") && logged.includes("u2"));
  assert.ok(!logged.toLowerCase().includes("mario"), "nessun username nel log");
  assert.ok(!logged.includes("scrypt$"), "nessun pinHash nel log");
});

test("il latch dei duplicati precede never_loaded e si azzera solo con dati non ambigui", async () => {
  const { state, store } = storeWith({
    users: [userRow(), userRow({ id: "u2", username: "mario" })],
  });
  await assert.rejects(() => store.refresh());
  assert.equal(store.snapshotStatus().reason, "duplicate_normalized_username");
  state.users = [rowToUser(userRow())];
  await store.refresh();
  assert.equal(store.snapshotStatus().ok, true);
});
test("indexUsers ignora la colonna username_normalized e usa la normalizzazione JavaScript", () => {
  // Colonna e funzione divergono: la colonna dice due chiavi diverse, il codice una sola.
  const rows = [
    rowToUser(userRow({ id: "u1", username: "mario\t", username_normalized: "mario\t" })),
    rowToUser(userRow({ id: "u2", username: "mario", username_normalized: "mario" })),
  ];
  assert.throws(() => indexUsers(rows), (error) => error.details.reason === "duplicate_normalized_username");
});

test("R2: nessun metodo della superficie sincrona ritorna una Promise", async () => {
  const { store } = storeWith();
  await store.refresh();
  for (const call of [
    () => store.listUsers(),
    () => store.getUserById("u1"),
    () => store.listUserGroups(),
    () => store.snapshotStatus(),
    () => store.getUserByNormalizedUsername("mario"),
  ]) {
    const value = call();
    assert.equal(value instanceof Promise, false);
    assert.equal(typeof value?.then, "undefined");
  }
});

test("R4: mille getUserById non producono nessuna query", async () => {
  const { state, store } = storeWith();
  await store.refresh();
  const after = { ...state.calls };
  for (let index = 0; index < 1000; index += 1) {
    assert.equal(store.getUserById("u1").id, "u1");
    store.listUsers();
    store.snapshotStatus();
  }
  assert.deepEqual(state.calls, after, "la lettura non deve mai innescare un refresh");
  assert.equal(after.listUsers, 1);
  assert.equal(after.listUserGroups, 1);
});

test("R-ISO-2: le copie in uscita sono profonde e mutabili, mai i record interni", async () => {
  const { store } = storeWith();
  await store.refresh();

  const first = store.getUserById("u1");
  assert.equal(Object.isFrozen(first), false, "congelare trasformerebbe un no-op in un TypeError");
  first.role = "operator";
  first.permissions.push("intruso");
  first.groupIds.length = 0;
  const second = store.getUserById("u1");
  assert.equal(second.role, "admin");
  assert.deepEqual(second.permissions, ["manage_users"]);
  assert.deepEqual(second.groupIds, ["g1"]);
  assert.notEqual(first.permissions, second.permissions);

  const list = store.listUsers();
  list[0].username = "mutato";
  assert.equal(store.listUsers()[0].username, "Mario");

  const groups = store.listUserGroups();
  groups[0].name = "mutato";
  assert.equal(store.listUserGroups()[0].name, "Sala");
});

test("R-ISO-1 / R-ISO-4: due idratazioni consecutive non condividono niente", async () => {
  const { store } = storeWith();
  const stateA = { users: [], userGroups: [], meta: { keep: true } };
  await store.hydrateAppState(stateA);
  assert.equal(stateA.users.length, 1);
  assert.equal(stateA.userGroups.length, 1);
  assert.equal(stateA.meta.keep, true, "l'idratazione tocca solo le due collezioni");
  stateA.users[0].fullName = "mutato in posto";
  stateA.userGroups[0].active = false;

  const stateB = {};
  await store.hydrateAppState(stateB);
  assert.equal(stateB.users[0].fullName, "Mario Rossi");
  assert.equal(stateB.userGroups[0].active, true);
  assert.notEqual(stateA.users[0], stateB.users[0]);
  assert.equal(Object.isFrozen(stateB.users[0]), false, "i write model mutano in posto");
});

test("l'idratazione rinfresca, e con lo snapshot gia' in memoria sopravvive a un refresh fallito", async () => {
  const { state, store } = storeWith();
  await store.hydrateAppState({});
  assert.equal(state.calls.listUsers, 1, "l'idratazione e' uno dei quattro punti di refresh");

  state.failure = Object.assign(new Error("giu'"), { code: "ECONNREFUSED" });
  const stateC = {};
  await store.hydrateAppState(stateC);
  assert.equal(stateC.users.length, 1, "si idrata dallo snapshot noto: il 503 lo decide auth.repository");
  assert.equal(store.snapshotStatus().reason, "refresh_failed");
});

test("senza uno snapshot un'idratazione fallita propaga l'errore", async () => {
  const { state, store } = storeWith();
  state.failure = Object.assign(new Error("giu'"), { code: "ECONNREFUSED" });
  await assert.rejects(() => store.hydrateAppState({}));
});

test("il pinHash e' nel valore di ritorno — e' il dato — ma non nelle diagnostiche", async () => {
  const { lines, store } = storeWith();
  await store.refresh();
  assert.equal(store.getUserById("u1").pinHash, PIN_HASH);
  assert.equal(store.listUsers()[0].pinHash, PIN_HASH);
  const diagnostics = `${JSON.stringify(store.snapshotStatus())} ${JSON.stringify(store.snapshotCounts())} ${lines.join("\n")}`;
  assert.ok(!diagnostics.includes("scrypt$"));
  assert.deepEqual(store.snapshotCounts(), { users: 1, userGroups: 1, loadedAt: 1_000_000 });
});

test("R-FRESH-2: il timer e' unref()-ato, parte con un refresh immediato e si ferma con stop()", async () => {
  const { state, store, timers } = storeWith();
  assert.equal(store.start(), true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000, "la cadenza e' BACKEND_POSTGRES_IDENTITY_SNAPSHOT_TTL_MS");
  assert.equal(timers[0].unrefCalled, true, "il timer non deve tenere vivo il processo");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.calls.listUsers, 1, "refresh immediato al boot");
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.calls.listUsers, 2);
  assert.equal(store.start(), false, "start() e' idempotente");
  assert.equal(store.stop(), true);
  assert.equal(timers.length, 0);
  assert.equal(store.stop(), false);
});

test("i refresh concorrenti si accodano su una sola query", async () => {
  const { state, store } = storeWith();
  await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
  assert.equal(state.calls.listUsers, 1);
});

// ---------------------------------------------------------------------------
// Confini: lo store non contiene SQL e non scrive
// ---------------------------------------------------------------------------

test("lo store non contiene SQL e non espone nessuna scrittura", () => {
  const storePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../db/postgresql/identity-store.js",
  );
  const source = readFileSync(storePath, "utf8");
  const withoutComments = source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  for (const pattern of [
    /\bSELECT\s+/i,
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+\S+\s+SET\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bclient\.query\b/,
    /\bwithTransaction\b/,
  ]) {
    assert.equal(pattern.test(withoutComments), false, `lo store non deve contenere ${pattern}`);
  }
  const { store } = storeWith();
  for (const forbidden of ["syncFromAppState", "insertUser", "updateUser", "deleteUsers", "insertUserGroup"]) {
    assert.equal(forbidden in store, false, `${forbidden} appartiene al quarto anello`);
  }
});

// ---------------------------------------------------------------------------
// D43 — la rete che §3.1 punto 5 dichiarava e che non era mai stata scritta.
// `assertPostgresPrimaryPreconditions` non esisteva in tutto il repository e
// `countAdministrators` non aveva un solo chiamante. Il buco e' reale: P3 si arma solo su
// UPDATE/DELETE e il CONSTRAINT TRIGGER della 008 e' AFTER UPDATE OR DELETE, quindi una
// sync di soli INSERT su tabella vuota puo' installare una collezione senza nemmeno un
// amministratore senza che nessuna delle due protezioni se ne accorga.
// ---------------------------------------------------------------------------

const SOLO_OPERATORI = [
  userRow({ id: "u1", username: "Anna", username_normalized: "anna", role: "operator",
            profile: { permissions: ["view_orders"] } }),
  userRow({ id: "u2", username: "Bruno", username_normalized: "bruno", role: "operator",
            profile: { permissions: [] } }),
];

test("D43: a primary, zero amministratori arma il latch e le letture vengono rifiutate", async () => {
  const { store } = storeWith({ env: PRIMARY_ENV, users: SOLO_OPERATORI });

  await store.refresh();
  const status = store.snapshotStatus();
  assert.equal(status.ok, false);
  assert.equal(status.reason, "no_administrator");
  assert.ok(
    IDENTITY_SNAPSHOT_REASONS.includes(status.reason),
    "il motivo deve stare nell'enumerazione chiusa di R-FRESH-6",
  );
});

test("D43: basta un amministratore perche' il latch non si armi", async () => {
  const { store } = storeWith({
    env: PRIMARY_ENV,
    users: [SOLO_OPERATORI[0], userRow({ id: "u2", username: "Capo", username_normalized: "capo", role: "admin",
                                        profile: { permissions: [] } })],
  });

  await store.refresh();
  assert.equal(store.snapshotStatus().ok, true);
});

// In shadow PostgreSQL non e' l'autorita': chi risponde al login e' ancora MySQL, quindi
// una collezione senza amministratori non impedisce nulla. Armare il latch anche li'
// vorrebbe dire rifiutare letture che nessuno stava facendo da PostgreSQL.
test("D43: in shadow il latch NON si arma", async () => {
  const shadowEnv = Object.freeze({
    BACKEND_POSTGRES_ENABLED: "1",
    BACKEND_POSTGRES_SHADOW_DOMAINS: "identity",
  });
  const { store } = storeWith({ env: shadowEnv, users: SOLO_OPERATORI });

  await store.refresh();
  assert.equal(store.snapshotStatus().ok, true);
});
