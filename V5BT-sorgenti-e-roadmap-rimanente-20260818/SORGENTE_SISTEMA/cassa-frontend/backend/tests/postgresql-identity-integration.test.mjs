// MIG-040 — QUINTO ANELLO: la COMPOSIZIONE.
//
// I quattro anelli precedenti hanno ciascuno i propri test unitari, e ciascuno dichiara lo
// stesso limite: il pezzo e' provato da solo, la catena presa insieme no. Questo file prova
// la catena e nient'altro. Non ripete un'asserzione che un anello gia' fa su se stesso: se
// un test qui fallisse e nessuno degli altri 118, il difetto sarebbe nella COMPOSIZIONE —
// nel modo in cui write-through, store, comparatore e auth.repository si passano il dato.
//
// La catena, per intero e nell'ordine in cui gira in produzione:
//
//   app-state (MySQL e' l'autorita' in shadow)
//     -> identityRowsFromAppState        (identity-canonical.js, secondo anello)
//     -> repository.syncFromAppState     (identity.repository.js, primo anello)
//     -> store.refresh()                 (identity-store.js, terzo anello)
//     -> auth.repository.listUsers()     (auth.repository.js, terzo anello)
//     -> compareIdentitySnapshot()       (identity-shadow.js, quarto anello)
//
// I DOPPI NON SONO RISCRITTI. Vengono da ./helpers/postgresql-identity-doubles.mjs, che li
// copia verbatim dal quarto anello; l'ultimo test di questo file verifica che la copia sia
// ancora tale. Il repository, il canonicalizzatore, lo store, il comparatore, il
// write-through e auth.repository sono quelli di PRODUZIONE: qui non c'e' una seconda copia
// di nessuna logica.
//
// Il `pinHash` compare in questo file solo dove il test ne verifica l'ASSENZA da un log o da
// un rapporto, e una volta per verificarne la PRESENZA nel valore letto. Sono i due lati
// della stessa regola (§4.7).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as postgresql from "../db/postgresql/index.js";
import { createAuthRepository } from "../modules/auth/auth.repository.js";
import {
  adminRecord,
  countingMetrics,
  createFakeIdentityDb,
  groupRecord,
  operatorRecord,
  OTHER_PIN_HASH,
  PIN_HASH,
  PRIMARY_ENV,
  SHADOW_ENV,
  silentLogger,
} from "./helpers/postgresql-identity-doubles.mjs";

const {
  createPostgresqlIdentityRepository,
  createPostgresqlIdentityStore,
  createPostgresqlIdentityWriteThrough,
  IDENTITY_STORE_UNAVAILABLE,
  canonicalJson,
  maskIdentityRecord,
} = postgresql;

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

// §4.9 (c): la `users.save` dichiara la sostituzione integrale di ENTRAMBI i domini a ogni
// salvataggio. E' la forma che arriva davvero dalla writeDb, quindi e' quella che si prova.
const REPLACE_BOTH = Object.freeze({ identityReplace: ["users", "userGroups"] });

// ---------------------------------------------------------------------------
// La catena: un solo doppio, un solo orologio, un solo logger per tutti e cinque i pezzi.
// E' esattamente questo il punto dell'anello — negli anelli precedenti ogni pezzo aveva il
// proprio doppio, e la giuntura fra due pezzi non era osservata da nessuno.
// ---------------------------------------------------------------------------

function chain(options = {}) {
  const fake = createFakeIdentityDb(options.initial);
  const { lines, logger } = silentLogger();
  const { counters, operations, metrics } = countingMetrics();
  const clock = { value: options.startedAt ?? 5_000_000 };
  const now = () => clock.value;
  const env = options.env ?? PRIMARY_ENV;

  const repository = createPostgresqlIdentityRepository({ runtime: fake.runtime });
  const store = createPostgresqlIdentityStore({ env, repository, logger, now });
  const writeThrough = createPostgresqlIdentityWriteThrough({
    env,
    repository,
    runtime: fake.runtime,
    store,
    logger,
    runtimeMetrics: metrics,
    now,
  });
  // D39: `identityStore` e' la sola voce nuova nella firma. Nessun runtime relazionale, cosi'
  // il ramo legacy dell'app-state resta quello vero e non un terzo doppio.
  const authRepository = createAuthRepository({ identityStore: store });

  return { fake, repository, store, writeThrough, authRepository, lines, counters, operations, clock };
}

function joinedLines(lines) {
  return lines.join("\n");
}

// Confronto fra due record app-state che ignora l'ordine delle chiavi e maschera il pinHash:
// e' il criterio di §6.2 C1 + C4, non un `deepEqual` che fallirebbe sull'ordine.
function sameRecord(left, right, message) {
  assert.equal(canonicalJson(maskIdentityRecord(left)), canonicalJson(maskIdentityRecord(right)), message);
}

// 18 utenti: la cardinalita' vera del `.164` (D40). Il primo e' l'amministratore, e non e'
// un dettaglio decorativo — senza di lui la guardia P3 del repository rifiuterebbe il
// secondo giro di sincronizzazione, quello con `updatesPlanned > 0`.
function eighteenUsers() {
  return Array.from({ length: 18 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    const record = {
      id: `u${suffix}`,
      username: `Utente${suffix}`,
      fullName: `Utente Numero ${suffix}`,
      role: index === 0 ? "admin" : "operator",
      pinHash: index % 3 === 0 ? PIN_HASH : "",
      createdAt: "2026-01-01T08:00:00.000Z",
      updatedAt: "2026-01-01T08:00:00.000Z",
    };
    if (index === 0) record.permissions = ["manage_users", "view_orders"];
    return record;
  });
}

function driverFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

// ---------------------------------------------------------------------------
// 1 — IL CICLO COMPLETO
// ---------------------------------------------------------------------------

test("ciclo completo: app-state → write-through → refresh → auth.listUsers legge dal ramo identity", async () => {
  const { writeThrough, store, authRepository, fake } = chain({ env: PRIMARY_ENV });
  const state = {
    users: [adminRecord(), operatorRecord()],
    userGroups: [groupRecord({ active: true })],
  };

  const outcome = await writeThrough.syncFromAppState(state, REPLACE_BOTH);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.summary.users.inserted, 2);
  assert.equal(outcome.summary.userGroups.inserted, 1);

  // Il refresh NON e' chiamato dal test: lo chiama il write-through in coda alla scrittura
  // (§9.4 R4). Se quella chiamata sparisse, lo snapshot resterebbe a `never_loaded` e la
  // riga qui sotto lancerebbe invece di leggere.
  assert.equal(store.snapshotStatus().ok, true, "il write-through ha idratato lo store da solo");
  assert.deepEqual(store.snapshotCounts(), { users: 2, userGroups: 1, loadedAt: 5_000_000 });

  // App-state con un intruso: se `listUsers` cadesse sul ramo legacy invece che su identity,
  // l'intruso comparirebbe e il conteggio sarebbe 3.
  const appStateConIntruso = { users: [{ id: "intruso", username: "intruso", pinHash: "" }] };
  const letti = authRepository.listUsers(appStateConIntruso);
  assert.equal(letti.length, 2, "la lettura viene da PostgreSQL, non dall'app-state");
  assert.deepEqual(letti.map((entry) => entry.id).sort(), ["u1", "u2"]);
  sameRecord(letti[0], adminRecord(), "l'utente e' tornato uguale a come era partito");
  sameRecord(letti[1], operatorRecord());

  // …e il giro e' passato davvero per PostgreSQL: le righe stanno nel doppio.
  assert.equal(fake.users.size, 2);
  assert.equal(fake.groups.size, 1);
});

test("prima del primo giro il ramo identity RIFIUTA, non ripiega in silenzio sull'app-state", () => {
  const { authRepository } = chain({ env: PRIMARY_ENV });
  const appState = { users: [{ id: "legacy", username: "legacy", pinHash: "" }] };
  assert.throws(
    () => authRepository.listUsers(appState),
    (error) => {
      assert.equal(error.code, IDENTITY_STORE_UNAVAILABLE);
      assert.equal(error.status, 503);
      assert.equal(error.details.reason, "never_loaded");
      return true;
    },
  );
});

test("getUserById e getUserByUsername attraversano lo stesso snapshot della catena", async () => {
  const { writeThrough, authRepository } = chain({ env: PRIMARY_ENV });
  const state = { users: [adminRecord(), operatorRecord()], userGroups: [] };
  await writeThrough.syncFromAppState(state, REPLACE_BOTH);

  const perId = authRepository.getUserById({ users: [] }, "u2");
  assert.equal(perId.id, "u2");
  sameRecord(perId, operatorRecord());

  // getUserByUsername resta invariata: filtra in JavaScript sul risultato di listUsers, e
  // proprio per questo eredita il ramo identity senza una riga nuova (§9.4).
  const perNome = authRepository.getUserByUsername({ users: [] }, "  MARIO  ");
  assert.equal(perNome.id, "u1", "la normalizzazione autorevole e' quella JavaScript (D38.2)");
  assert.equal(authRepository.getUserById({ users: [] }, "assente"), null);
});

test("R-ISO-2: ciò che esce dalla catena è una copia mutabile e mutarla non tocca lo snapshot", async () => {
  const { writeThrough, authRepository } = chain({ env: PRIMARY_ENV });
  await writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [] }, REPLACE_BOTH);

  const primo = authRepository.getUserById({}, "u1");
  primo.role = "operator";
  primo.permissions.push("saccheggio");
  primo.pinHash = "";

  const secondo = authRepository.getUserById({}, "u1");
  assert.equal(secondo.role, "admin", "lo snapshot non ha subito la mutazione del chiamante");
  assert.deepEqual(secondo.permissions, ["manage_users", "view_orders"]);
  assert.equal(secondo.pinHash, PIN_HASH);
});

test("il secondo giro della catena sugli stessi dati è `unchanged`: nessuna revisione che scappa", async () => {
  const { writeThrough, fake } = chain({ env: PRIMARY_ENV });
  const state = { users: [adminRecord(), operatorRecord()], userGroups: [groupRecord({ active: true })] };

  await writeThrough.syncFromAppState(state, REPLACE_BOTH);
  const secondo = await writeThrough.syncFromAppState(state, REPLACE_BOTH);

  assert.equal(secondo.summary.users.unchanged, 2);
  assert.equal(secondo.summary.users.updated, 0);
  assert.equal(secondo.summary.userGroups.unchanged, 1);
  // La prova che T e T⁻¹ combaciano lungo la catena: se il record ricostruito differisse da
  // quello canonicalizzato, `row_hash` cambierebbe a ogni giro e `revision` salirebbe.
  assert.equal(fake.users.get("u1").revision, 0, "revision ferma: il write-through non riscrive per sport");
  assert.equal(fake.groups.get("g1").revision, 0);
});

// ---------------------------------------------------------------------------
// 2 — IL COMPARATORE SU DATI IDENTICI
// ---------------------------------------------------------------------------

test("dati identici: il confronto in coda al write-through non segnala nessuna divergenza", async () => {
  const { writeThrough, counters, lines } = chain({ env: SHADOW_ENV });
  const state = {
    users: [adminRecord(), operatorRecord()],
    userGroups: [groupRecord({ active: true })],
  };

  const outcome = await writeThrough.syncFromAppState(state, REPLACE_BOTH);
  assert.equal(outcome.ok, true);
  // Il confronto parte da solo alla prima scrittura shadow: non e' il test a chiamarlo.
  assert.ok(outcome.comparison, "in shadow il confronto e' in coda al write-through");
  assert.equal(outcome.comparison.ok, true, JSON.stringify(outcome.comparison.mismatches));
  assert.equal(outcome.comparison.mismatchCount, 0);
  assert.equal(outcome.comparison.users.appStateCount, 2);
  assert.equal(outcome.comparison.users.postgresCount, 2);
  assert.equal(outcome.comparison.userGroups.postgresCount, 1);
  assert.equal(counters.identityShadowMismatches, 0);
  assert.equal(counters.identityShadowWriteFailures, 0);
  assert.equal(joinedLines(lines), "", "una catena verde non scrive niente nel log");
});

test("dati identici su 18 utenti: anche le posizioni combaciano dopo il giro completo", async () => {
  const { writeThrough } = chain({ env: SHADOW_ENV });
  const state = { users: eighteenUsers(), userGroups: [groupRecord({ active: true })] };

  const outcome = await writeThrough.syncFromAppState(state, REPLACE_BOTH);
  assert.equal(outcome.comparison.ok, true, JSON.stringify(outcome.comparison.mismatches));
  assert.equal(outcome.comparison.users.postgresCount, 18);
  // `position_differs` e' il difetto che una catena sciatta produce per prima: basta un
  // ORDER BY che non rispetti `app_state_position` e i 18 utenti tornano rimescolati.
  assert.equal(outcome.comparison.mismatches.length, 0);
});

// ---------------------------------------------------------------------------
// 3 — IL COMPARATORE SU UNA DIVERGENZA VERA
// ---------------------------------------------------------------------------

test("divergenza vera: il comparatore la segnala e dice QUALE campo", async () => {
  const { writeThrough, fake, counters, lines } = chain({ env: SHADOW_ENV });
  const state = { users: [adminRecord(), operatorRecord()], userGroups: [] };
  await writeThrough.syncFromAppState(state, REPLACE_BOTH);

  // La riga PostgreSQL cambia sotto il naso della catena — una scrittura fuori dal
  // write-through, che e' proprio cio' che il confronto shadow esiste per scoprire.
  const riga = fake.users.get("u2");
  riga.full_name = "Qualcun Altro";
  riga.profile = JSON.stringify({ ...JSON.parse(riga.profile), allowedPaymentMethodIds: ["contanti"] });

  const report = await writeThrough.compareWithAppState(state);
  assert.equal(report.ok, false);
  assert.equal(report.mismatchCount, 1);
  const [divergenza] = report.mismatches;
  assert.equal(divergenza.collection, "users");
  assert.equal(divergenza.id, "u2");
  assert.equal(divergenza.kind, "fields_differ");
  assert.deepEqual(divergenza.fields, ["allowedPaymentMethodIds", "fullName"], "i NOMI dei campi divergenti");

  assert.equal(counters.identityShadowMismatches, 1);
  assert.equal(counters.identityShadowWriteFailures, 0, "una divergenza non e' un fallimento di scrittura");

  const log = joinedLines(lines);
  assert.ok(log.includes("users/u2:fields_differ"), "il log nomina la collezione, l'id e il tipo");
  assert.ok(log.includes("fullName"), "e i nomi dei campi");
  assert.equal(log.includes("Qualcun Altro"), false, "S-CMP-2: mai i valori");
  assert.equal(log.includes("Luigi Verdi"), false);
});

test("divergenza vera: mancante da un lato e mancante dall'altro sono due segnalazioni distinte", async () => {
  const { writeThrough, fake } = chain({ env: SHADOW_ENV });
  const state = { users: [adminRecord(), operatorRecord()], userGroups: [] };
  await writeThrough.syncFromAppState(state, REPLACE_BOTH);

  // Un utente sparisce da PostgreSQL, un altro compare solo li'.
  fake.users.delete("u2");
  fake.users.set("orfano", { ...fake.users.get("u1"), id: "orfano", username: "Orfano", username_normalized: "orfano", app_state_position: 9 });

  const report = await writeThrough.compareWithAppState(state);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.mismatches.map((entry) => `${entry.id}:${entry.kind}`).sort(),
    ["orfano:missing_in_app_state", "u2:missing_in_postgres"],
  );
});

// ---------------------------------------------------------------------------
// 4 — FRESCHEZZA
// ---------------------------------------------------------------------------

test("snapshot scaduto: la catena rifiuta con 503 `stale` invece di servire dati vecchi in silenzio", async () => {
  const { writeThrough, store, authRepository, clock } = chain({ env: PRIMARY_ENV });
  await writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [] }, REPLACE_BOTH);
  assert.equal(authRepository.listUsers({}).length, 1, "appena scritto si legge");

  // maxStalenessMs di default: max(5000, 2 × snapshotTtlMs) = 5000 (identity-mode.js:209-214).
  clock.value += 5_001;
  const status = store.snapshotStatus();
  assert.equal(status.ok, false);
  assert.equal(status.reason, "stale");
  assert.equal(status.ageMs, 5_001);

  // Lo snapshot in memoria E' ancora li' — `store.listUsers()` lo restituirebbe. Il punto
  // dell'anello e' che il ramo di auth.repository NON lo serve: il giudizio di freschezza sta
  // fra lo store e il chiamante, ed e' proprio quella giuntura che nessun test unitario vede.
  assert.equal(store.listUsers().length, 1, "lo store non cancella niente: si limita a dichiararsi vecchio");
  assert.throws(
    () => authRepository.listUsers({ users: [{ id: "legacy", username: "legacy", pinHash: "" }] }),
    (error) => {
      assert.equal(error.code, IDENTITY_STORE_UNAVAILABLE);
      assert.equal(error.status, 503);
      assert.equal(error.details.reason, "stale");
      assert.equal(error.details.ageMs, 5_001);
      assert.equal(error.details.maxStalenessMs, 5_000);
      return true;
    },
  );
  assert.throws(() => authRepository.getUserById({}, "u1"), { code: IDENTITY_STORE_UNAVAILABLE });

  // Un refresh riuscito alla nuova ora riapre la lettura: `stale` e' uno stato, non un latch.
  await store.refresh();
  assert.equal(store.snapshotStatus().ok, true);
  assert.equal(authRepository.listUsers({}).length, 1);
});

test("refresh fallito: la catena rifiuta con `refresh_failed` e non serve lo snapshot precedente", async () => {
  const { writeThrough, store, authRepository, fake, lines } = chain({ env: PRIMARY_ENV });
  await writeThrough.syncFromAppState({ users: [adminRecord()], userGroups: [] }, REPLACE_BOTH);

  fake.state.failure = driverFailure("57P01", "terminating connection due to administrator command");
  await assert.rejects(() => store.refresh(), { code: "57P01" });

  assert.equal(store.snapshotStatus().reason, "refresh_failed");
  assert.throws(() => authRepository.listUsers({}), (error) => {
    assert.equal(error.details.reason, "refresh_failed");
    return true;
  });
  assert.ok(joinedLines(lines).includes("57P01"), "nel log il codice del driver");
  assert.equal(joinedLines(lines).includes("administrator command"), false, "mai il messaggio del driver");

  fake.state.failure = null;
  await store.refresh();
  assert.equal(store.snapshotStatus().ok, true, "il latch si azzera con un refresh riuscito");
  assert.equal(authRepository.listUsers({}).length, 1);
});

// ---------------------------------------------------------------------------
// 5 — GUASTO DI POSTGRESQL A META'
// ---------------------------------------------------------------------------

// Il guasto e' mirato: la prima UPDATE passa, la INSERT del terzo utente no. Cosi' il
// database resta a meta' strada — che e' il caso vero, non un fallimento pulito all'inizio.
async function guastoAMeta(env) {
  const catena = chain({ env });
  const primoStato = { users: [adminRecord(), operatorRecord()], userGroups: [groupRecord({ active: true })] };
  await catena.writeThrough.syncFromAppState(primoStato, REPLACE_BOTH);

  const nuovoUtente = {
    id: "u3",
    username: "Anna",
    fullName: "Anna Bianchi",
    role: "operator",
    pinHash: "",
    createdAt: "2026-04-04T09:00:00.000Z",
    updatedAt: "2026-04-04T09:00:00.000Z",
  };
  const secondoStato = {
    users: [adminRecord({ fullName: "Mario Rossi Junior" }), operatorRecord(), nuovoUtente],
    userGroups: [groupRecord({ active: true })],
  };

  catena.fake.state.failure = driverFailure("53300", `remaining connection slots reserved; pin_hash='${PIN_HASH}'`);
  catena.fake.state.failOn = /INSERT INTO identity\.users/;
  return { catena, secondoStato };
}

test("shadow: PostgreSQL cade a metà scrittura, la lettura legacy continua e il contatore sale", async () => {
  const { catena, secondoStato } = await guastoAMeta(SHADOW_ENV);
  const { writeThrough, authRepository, fake, counters, lines } = catena;

  const outcome = await writeThrough.syncFromAppState(secondoStato, REPLACE_BOTH);
  assert.equal(outcome.ok, false, "in shadow si registra e si prosegue: la writeDb MySQL non deve abortire");
  assert.equal(outcome.stage, "write");
  assert.equal(outcome.errorCode, "53300");
  assert.equal(counters.identityShadowWriteFailures, 1, "il contatore sale");
  assert.equal(counters.identityShadowMismatches, 0, "e non e' il contatore delle divergenze");
  assert.equal(writeThrough.counters().writeFailures, 1);

  // LA LETTURA CONTINUA A FUNZIONARE. In shadow l'autorita' e' MySQL, quindi auth.repository
  // legge l'app-state: il guasto PostgreSQL non si vede dal lato del servizio.
  assert.equal(authRepository.isIdentityPrimary("users"), false);
  const letti = authRepository.listUsers(secondoStato);
  assert.equal(letti.length, 3);
  assert.deepEqual(letti.map((entry) => entry.id), ["u1", "u2", "u3"]);

  // Il database e' rimasto a meta': u1 aggiornato, u3 mai inserito.
  assert.equal(fake.users.get("u1").full_name, "Mario Rossi Junior");
  assert.equal(fake.users.has("u3"), false);

  // E la meta' rimasta e' esattamente cio' che il confronto deve far vedere all'operatore.
  fake.state.failure = null;
  fake.state.failOn = null;
  const report = await writeThrough.compareWithAppState(secondoStato);
  assert.equal(report.ok, false);
  assert.deepEqual(report.mismatches.map((entry) => `${entry.id}:${entry.kind}`), ["u3:missing_in_postgres"]);

  const log = joinedLines(lines);
  assert.ok(log.includes("53300"));
  assert.equal(log.includes(PIN_HASH), false, "il messaggio del driver conteneva il pinHash: non deve passare");
  assert.equal(log.includes("scrypt$"), false);
});

test("primary: lo stesso guasto a metà è un errore che si propaga al chiamante", async () => {
  const { catena, secondoStato } = await guastoAMeta(PRIMARY_ENV);
  const { writeThrough, counters, store } = catena;

  assert.equal(writeThrough.failuresAreFatal, true);
  await assert.rejects(() => writeThrough.syncFromAppState(secondoStato, REPLACE_BOTH), { code: "53300" });
  assert.equal(counters.identityShadowWriteFailures, 1, "il fallimento si conta anche quando e' fatale");

  // Lo store non e' stato idratato dal giro fallito: continua a servire cio' che aveva.
  assert.equal(store.snapshotCounts().users, 2);
});

// ---------------------------------------------------------------------------
// 6 — D40: 18 UTENTI E ZERO GRUPPI
// ---------------------------------------------------------------------------

test("D40: 18 utenti e ZERO gruppi attraversano tutta la catena senza lanciare", async () => {
  const { writeThrough, store, fake, lines, counters, operations } = chain({ env: SHADOW_ENV });
  // La forma dei dati veri del `.164`: `userGroups` e' presente e vuoto, non assente. Con la
  // sostituzione integrale dichiarata su entrambi i domini e' il caso che senza la guardia
  // `emptyDeclared` farebbe fallire OGNI `users.save`.
  const state = { users: eighteenUsers(), userGroups: [] };

  const outcome = await writeThrough.syncFromAppState(state, REPLACE_BOTH);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.summary.users.inserted, 18);
  assert.equal(outcome.summary.userGroups.inserted, 0);
  assert.equal(outcome.summary.identityPruneSkipped.emptyDeclared, 1, "il dominio vuoto su entrambi i lati");
  assert.equal(outcome.summary.identityPruneSkipped.noIntent, 0, "l'intenzione era dichiarata");

  // D6 REV4 — lo svuotamento dichiarato ARRIVA. Prima si fermava nel summary: `absorbSummary`
  // leggeva solo `noIntent` e nell'oggetto dei contatori il campo non esisteva nemmeno, quindi
  // l'operazione piu' distruttiva che il sistema esegua senza lanciare non produceva ne'
  // metrica ne' traccia. Le tre destinazioni ora sono tutte e tre popolate, e la
  // scomposizione dice CHE COSA e' stato svuotato: `userGroups`, non `users`.
  assert.equal(counters.identityPruneEmptyDeclared, 1, "il contatore di runtime-metrics");
  const skipped = writeThrough.counters().identityPruneSkipped;
  assert.equal(skipped.emptyDeclared, 1, "il contatore del write-through");
  assert.deepEqual(skipped.userGroups, { noIntent: 0, emptyDeclared: 1 });
  assert.deepEqual(skipped.users, { noIntent: 0, emptyDeclared: 0 });
  assert.deepEqual(
    operations.filter((entry) => entry.includes("pruneSkipped")),
    ["identityWriteThrough:pruneSkipped.emptyDeclared.userGroups"],
    "la traccia nomina il dominio: `emptyDeclared: 1` da solo non direbbe quale",
  );

  assert.deepEqual(store.snapshotCounts(), { users: 18, userGroups: 0, loadedAt: 5_000_000 });
  assert.equal(fake.groups.size, 0);
  assert.equal(outcome.comparison.ok, true, JSON.stringify(outcome.comparison.mismatches));
  assert.equal(outcome.comparison.userGroups.appStateCount, 0);

  // Secondo giro: e' qui che si arma la guardia dell'amministratore superstite (P3), perche'
  // `updatesPlanned` diventa 18. Se la catena perdesse il ruolo dell'utente 01 lungo il
  // percorso, questa riga lancerebbe IDENTITY_NO_SURVIVING_ADMINISTRATOR.
  const secondo = await writeThrough.syncFromAppState(state, REPLACE_BOTH);
  assert.equal(secondo.ok, true);
  assert.equal(secondo.summary.users.unchanged, 18);
  assert.equal(joinedLines(lines), "", "nessun warning in tutto il percorso D40");
});

test("D40: gli stessi 18 utenti tornano interi dal ramo identity di auth.repository", async () => {
  const { writeThrough, authRepository } = chain({ env: PRIMARY_ENV });
  const attesi = eighteenUsers();
  await writeThrough.syncFromAppState({ users: attesi, userGroups: [] }, REPLACE_BOTH);

  const letti = authRepository.listUsers({ users: [] });
  assert.equal(letti.length, 18);
  assert.deepEqual(letti.map((entry) => entry.id), attesi.map((entry) => entry.id), "ordine di app_state_position");
  for (const atteso of attesi) {
    sameRecord(authRepository.getUserById({}, atteso.id), atteso, `utente ${atteso.id}`);
  }
  // Nessun gruppo: la lista vuota e' una lista vuota, non un errore e non un null.
  assert.deepEqual(authRepository.listUsers({}).length, 18);
});

// ---------------------------------------------------------------------------
// 7 — IL pinHash: PRESENTE NEL VALORE, ASSENTE DA OGNI LOG E DA OGNI RAPPORTO
// ---------------------------------------------------------------------------

test("il pinHash arriva intatto in fondo alla catena di lettura e non compare in nessun log", async () => {
  const { writeThrough, store, authRepository, fake, lines } = chain({ env: PRIMARY_ENV });
  const state = { users: [adminRecord(), operatorRecord({ pinHash: OTHER_PIN_HASH })], userGroups: [] };
  await writeThrough.syncFromAppState(state, REPLACE_BOTH);

  // C'E' nel valore letto: e' il dato che serve a verifyPin, e senza di lui il login non
  // funziona piu'. Il fine di §4.7 non e' nascondere il pinHash al codice, e' tenerlo fuori
  // dalle diagnostiche.
  assert.equal(authRepository.getUserById({}, "u1").pinHash, PIN_HASH);
  assert.equal(authRepository.getUserById({}, "u2").pinHash, OTHER_PIN_HASH);
  assert.equal(store.listUsers()[0].pinHash, PIN_HASH);

  // Ora si rompe tutto, con un messaggio del driver che PORTA il pinHash — e' il caso vero:
  // un vincolo violato su `pin_hash` mette il parametro nel messaggio.
  fake.state.failure = driverFailure("23514", `new row violates check constraint; pin_hash='${PIN_HASH}'`);
  await assert.rejects(() => store.refresh());
  await writeThrough.syncFromAppState(state, REPLACE_BOTH).catch(() => {});
  let errore = null;
  try {
    authRepository.listUsers({});
  } catch (caught) {
    errore = caught;
  }
  assert.ok(errore, "dopo il refresh fallito la lettura deve rifiutare");
  assert.equal(errore.code, IDENTITY_STORE_UNAVAILABLE);

  const superficie = [joinedLines(lines), JSON.stringify(errore.details ?? {}), String(errore.message)].join("\n");
  assert.equal(superficie.includes(PIN_HASH), false, "il pinHash non entra in nessuna diagnostica");
  assert.equal(superficie.includes(OTHER_PIN_HASH), false);
  assert.equal(superficie.includes("scrypt$"), false, "nemmeno un frammento riconoscibile");
  assert.ok(joinedLines(lines).includes("23514"), "il codice del driver invece si', ed e' cio' che serve");
});

test("una divergenza SUL pinHash nomina il campo e tiene i valori fuori dal rapporto", async () => {
  const { writeThrough, fake, lines } = chain({ env: SHADOW_ENV });
  const state = { users: [adminRecord()], userGroups: [] };
  await writeThrough.syncFromAppState(state, REPLACE_BOTH);

  // Il PIN e' cambiato solo su PostgreSQL: e' esattamente il caso in cui il confronto deve
  // dire «differiscono» senza mostrare nessuno dei due valori (§6.2 C4 — il fingerprint
  // basta a sapere SE differiscono, e quello e' tutto cio' che serve sapere).
  fake.users.get("u1").pin_hash = OTHER_PIN_HASH;

  const report = await writeThrough.compareWithAppState(state);
  assert.equal(report.ok, false);
  assert.deepEqual(report.mismatches[0].fields, ["pinHash"]);

  const serializzato = JSON.stringify(report);
  assert.equal(serializzato.includes(PIN_HASH), false);
  assert.equal(serializzato.includes(OTHER_PIN_HASH), false);
  assert.equal(serializzato.includes("scrypt$"), false);
  assert.equal(serializzato.includes("sha256:"), false, "nemmeno il fingerprint esce dal comparatore");
  assert.ok(serializzato.includes("pinHash"), "il NOME del campo si', altrimenti il rapporto e' inutile");

  const log = joinedLines(lines);
  assert.ok(log.includes("users/u1:fields_differ"));
  assert.ok(log.includes("pinHash"));
  assert.equal(log.includes(PIN_HASH), false);
  assert.equal(log.includes(OTHER_PIN_HASH), false);
});

// ---------------------------------------------------------------------------
// GUARDIA DI DERIVA — i doppi condivisi devono restare copie del quarto anello
// ---------------------------------------------------------------------------

// Senza questo test, `helpers/postgresql-identity-doubles.mjs` sarebbe una SECONDA
// implementazione del doppio, libera di divergere da quella del quarto anello: due emulatori
// diversi della stessa 008, e la composizione proverebbe una catena che non e' quella
// provata dagli anelli. Il vincolo «riusa gli helper, non riscriverli» diventa qui una
// misura, e i test del quarto anello non vengono toccati.
test("i doppi condivisi sono ancora copie VERBATIM del quarto anello", () => {
  const originale = readFileSync(path.join(TESTS_DIR, "postgresql-identity-write-through.test.mjs"), "utf8");
  const copia = readFileSync(path.join(TESTS_DIR, "helpers", "postgresql-identity-doubles.mjs"), "utf8");

  const blocchi = [...copia.matchAll(/^\/\/ >>> COPIA VERBATIM \((.+?)\) — INIZIO\n([\s\S]*?)^\/\/ <<< COPIA VERBATIM \(\1\) — FINE$/gm)];
  assert.equal(blocchi.length, 3, "i tre blocchi delimitati devono esserci tutti");
  for (const [, etichetta, testo] of blocchi) {
    assert.ok(testo.trim().length > 0, `blocco '${etichetta}' vuoto`);
    assert.ok(
      originale.includes(testo),
      `il blocco '${etichetta}' non e' piu' un sottotesto esatto di postgresql-identity-write-through.test.mjs: ` +
        "il quarto anello ha cambiato il proprio doppio e la copia va riallineata, non riscritta.",
    );
  }

  // E il file dei doppi non contiene test: se ne contenesse, il conteggio dei quattro anelli
  // committati smetterebbe di essere leggibile.
  assert.equal(/(^|\n)\s*test\(/.test(copia), false, "il file dei doppi non deve dichiarare test");
});
