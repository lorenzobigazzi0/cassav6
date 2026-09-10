// MIG-040 — il write-through identity verso PostgreSQL (§4.9, §4.3, §6.3, D31, D32).
//
// QUARTO ANELLO, terza parte. Nessun SQL qui: le istruzioni vivono tutte in
// identity.repository.js, che resta l'UNICO scrittore di `identity.*` (§9.3). Questo file
// apre la transazione, trasforma l'app-state in righe con identity-canonical.js, chiama il
// repository e decide che cosa fare quando PostgreSQL rompe.
//
// PERCHE' NON E' UN METODO DELLO STORE, pur essendo `syncFromAppState` nella superficie
// asincrona di §9.4. Il terzo anello ha committato un test che ASSERISCE l'assenza di
// `syncFromAppState`, `withTransaction` e di ogni forma di SQL dentro identity-store.js
// («appartiene al quarto anello»,
// backend/tests/postgresql-identity-store.test.mjs:517-541). Riscriverlo per spostare il
// confine avrebbe fatto perdere la sola prova che lo store e' di sola lettura. Il
// write-through vive quindi in un modulo sorello che RICEVE lo store e ne usa una cosa
// sola: `refresh()` dopo una scrittura riuscita (§9.4 R4). Lo store resta byte-identico.
//
// LA REGOLA CHE GOVERNA TUTTO IL FILE (§4.9 (g), vincolo 1 dello slice):
//   in shadow PostgreSQL NON e' mai l'autorita'. `beforeWriteRequired` e' `true` sulla
//   linea (app-state.repository.js:132, :528; valorizzata da `beforeWriteRequired`,
//   backend/server.js:16595),
//   quindi un errore PostgreSQL NON catturato farebbe abortire la `writeDb`: lo strumento
//   di verifica romperebbe il servizio che deve verificare. Qui si registra e si prosegue,
//   con il contatore `identityShadowWriteFailures`.
//   In primary (L3) e in exclusive (L4) l'errore e' un errore e si rilancia.
//
// `identityShadowWriteFailures` non va confuso con `identityShadowMismatches`, che conta le
// divergenze del CONFRONTO e non i fallimenti della SCRITTURA (§4.9 (g)).

import { identityRowsFromAppState } from "./identity-canonical.js";
import { compareIdentitySnapshot, formatIdentityShadowMismatches } from "./identity-shadow.js";
import { IDENTITY_COLLECTIONS, normalizeIdentityMode } from "./identity-mode.js";
import {
  createIdentityPruneSkippedCounters,
  IDENTITY_PRUNE_SKIPPED_REASONS,
} from "./identity.repository.js";

const WRITE_THROUGH_LABEL = "identity:write-through";
const METRIC_KIND = "identityWriteThrough";

// Solo il codice, mai il messaggio: un messaggio del driver puo' contenere frammenti di
// query o di parametri, e fra i parametri c'e' `pin_hash` (§4.7).
function safeErrorCode(error) {
  const code = String(error?.code ?? "").trim();
  if (code && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)) return code;
  return error instanceof Error ? error.constructor.name : "Error";
}

// §4.9 P1 punto 1: l'intenzione puo' arrivare dagli hint della `writeDb`.
// `normalizeSplitDomainHints` (backend/server.js:16074-16086) legge `splitDomains` e, in
// alternativa, `domains`: qui si riproduce quella lettura e basta. La lista NON viene mai
// costruita da sola — un array assente o vuoto resta assente o vuoto.
function declaredSplitDomains(options) {
  const raw = options?.splitDomains ?? options?.domains;
  if (!Array.isArray(raw)) return undefined;
  const list = raw.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function declaredIdentityReplace(options) {
  const raw = options?.identityReplace;
  if (!Array.isArray(raw)) return undefined;
  const list = raw.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/**
 * Le opzioni che arrivano al repository sono SOLO le tre che la regola di prune conosce.
 * Tutto il resto delle opzioni di `writeDb` (sessionsSync, dirty tracking, …) non entra:
 * un canale di intenzione deve essere stretto, altrimenti un giorno qualcosa vi passera'
 * per sbaglio e cancellera' un dominio.
 */
export function buildIdentitySyncOptions(options = {}) {
  const syncOptions = {};
  const splitDomains = declaredSplitDomains(options);
  if (splitDomains) syncOptions.splitDomains = splitDomains;
  const identityReplace = declaredIdentityReplace(options);
  if (identityReplace) syncOptions.identityReplace = identityReplace;
  // P4 — il purge esplicito. Nessuna route HTTP lo passa, e un test statico lo verifica:
  // il solo chiamante legittimo e' l'importer con `--purge-identity`.
  if (options?.allowIdentityPurge === true) syncOptions.allowIdentityPurge = true;
  return syncOptions;
}

export function createPostgresqlIdentityWriteThrough(options = {}) {
  const mode = options.mode ?? normalizeIdentityMode({ env: options.env });
  const repository = options.repository ?? null;
  const runtime = options.runtime ?? null;
  const store = options.store ?? null;
  const logger = options.logger ?? console;
  const runtimeMetrics = options.runtimeMetrics ?? null;
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  // Spento per difetto: con le liste di D31 vuote `identityLevel` e' "off", `enabled` e'
  // `false` e ogni metodo ritorna `null` senza toccare niente (D31 punto 7).
  const enabled =
    Boolean(mode?.enabled) &&
    mode?.identityLevel !== "off" &&
    Boolean(repository) &&
    typeof runtime?.withTransaction === "function";
  // In shadow l'errore si registra; da primary in su l'errore e' un errore.
  const failuresAreFatal = mode?.isIdentityPrimary === true;
  const shadowIntervalMs = Number(mode?.shadowIntervalMs) || 0;

  const counters = {
    runs: 0,
    skipped: 0,
    writeFailures: 0,
    compares: 0,
    compareFailures: 0,
    mismatches: 0,
    // D6 REV4 — la stessa forma del summary del repository, costruita dalla stessa
    // funzione. Prima erano due elenchi scritti a mano, e non coincidevano: il repository
    // contava `emptyDeclared` e qui il campo non esisteva nemmeno, quindi il conteggio
    // veniva sommato a niente e l'operazione piu' distruttiva del sistema non lasciava
    // traccia. Un solo costruttore, e la divergenza non e' piu' esprimibile.
    identityPruneSkipped: createIdentityPruneSkippedCounters(),
  };
  let lastComparedAt = null;

  function incrementCounter(name, amount = 1) {
    try {
      runtimeMetrics?.incrementCounter?.(name, amount);
    } catch {
      // L'osservabilita' non cambia mai l'esito di una scrittura.
    }
  }

  function recordOperation(label, durationMs) {
    try {
      runtimeMetrics?.recordOperation?.(METRIC_KIND, label, durationMs);
    } catch {
      // Come sopra.
    }
  }

  // D32 punto (f): UN nome con suffissi, non un nome per motivo. La forma e' quella gia' in
  // uso in casa — `recordWriteOperation("appStateWriteHook", "beforeWrite.failure." + cause)`
  // (app-state.repository.js:516-520). I nomi `identityPruneSkippedNoHint` e
  // `identityPruneSkippedNoIntent` non si usano.
  //
  // D6 REV4 — si assorbono ENTRAMBI i motivi e ENTRAMBI i domini, ciclando sulle liste che
  // il repository esporta invece di nominare i campi a mano: era proprio la lista scritta a
  // mano a perdere `emptyDeclared`, e a rendere invisibile lo svuotamento su richiesta di
  // una collezione. L'etichetta e' `pruneSkipped.<motivo>.<dominio>` — suffissi, come vuole
  // D32 (f), cosi' la somma per motivo resta leggibile e la scomposizione per dominio pure.
  function absorbSummary(summary) {
    const skipped = summary?.identityPruneSkipped;
    if (!skipped || typeof skipped !== "object") return;
    for (const reason of IDENTITY_PRUNE_SKIPPED_REASONS) {
      let total = 0;
      for (const domain of IDENTITY_COLLECTIONS) {
        const amount = Math.max(0, Math.trunc(Number(skipped?.[domain]?.[reason]) || 0));
        if (amount === 0) continue;
        total += amount;
        counters.identityPruneSkipped[reason] += amount;
        counters.identityPruneSkipped[domain][reason] += amount;
        for (let index = 0; index < amount; index += 1) {
          recordOperation(`pruneSkipped.${reason}.${domain}`, 0);
        }
      }
      // Lo svuotamento dichiarato di una collezione e' l'operazione piu' distruttiva che il
      // sistema esegua senza lanciare: oltre all'istogramma prende un contatore proprio di
      // runtime-metrics, che e' cio' che si guarda quando si cerca «e' successo, o me lo
      // sono immaginato?». Il totale si RICALCOLA dalla scomposizione e non si legge dal
      // campo aggregato del summary: due sorgenti per lo stesso numero sono due numeri.
      if (reason === "emptyDeclared" && total > 0) {
        incrementCounter("identityPruneEmptyDeclared", total);
      }
    }
  }

  // §9.4 R4: il refresh e' chiamato dal boot, dal timer, dall'idratazione e dalla fine di
  // ogni write-through riuscito. Non deve poter rompere la scrittura appena conclusa.
  async function refreshStore() {
    if (typeof store?.refresh !== "function") return false;
    try {
      await store.refresh();
      return true;
    } catch (error) {
      logger?.warn?.(
        `[identity-write-through] refresh dello store dopo la scrittura fallito (${safeErrorCode(error)}).`,
      );
      return false;
    }
  }

  /**
   * S-CMP-4 / R-ISO-3: si RILEGGE da PostgreSQL con una query propria (`repository.listUsers`),
   * mai lo snapshot in memoria dello store contro se' stesso — che, essendo idratato dallo
   * stesso oggetto, sarebbe verde per costruzione.
   */
  async function compareWithAppState(state, compareOptions = {}) {
    if (!enabled) return null;
    counters.compares += 1;
    const [postgresUsers, postgresUserGroups] = await Promise.all([
      repository.listUsers(),
      repository.listUserGroups(),
    ]);
    const report = compareIdentitySnapshot({
      users: Array.isArray(state?.users) ? state.users : [],
      userGroups: Array.isArray(state?.userGroups) ? state.userGroups : [],
      postgresUsers,
      postgresUserGroups,
      userView: compareOptions.userView ?? options.userView ?? null,
      userGroupView: compareOptions.userGroupView ?? options.userGroupView ?? null,
    });
    lastComparedAt = now();
    if (!report.ok) {
      counters.mismatches += report.mismatchCount;
      incrementCounter("identityShadowMismatches", report.mismatchCount);
      // S-CMP-2: id e nomi dei campi, mai i valori.
      logger?.warn?.(
        `[identity-write-through] confronto shadow: ${report.mismatchCount} divergenze — ` +
          `${formatIdentityShadowMismatches(report.mismatches)}.`,
      );
    }
    return report;
  }

  // Il confronto costa due letture: si esegue al piu' una volta ogni
  // BACKEND_POSTGRES_IDENTITY_SHADOW_INTERVAL_MS (default 30_000, identity-mode.js:44), e
  // solo in shadow — in primary non esiste un legacy aggiornato con cui confrontarsi, che e'
  // esattamente la ragione per cui identity-mode.js vieta i due livelli insieme.
  function comparisonIsDue() {
    if (mode?.isIdentityShadow !== true) return false;
    if (shadowIntervalMs <= 0) return true;
    if (lastComparedAt === null) return true;
    return now() - lastComparedAt >= shadowIntervalMs;
  }

  async function compareIfDue(state) {
    if (!comparisonIsDue()) return null;
    try {
      return await compareWithAppState(state);
    } catch (error) {
      counters.compareFailures += 1;
      // Il confronto e' una diagnostica: non puo' far fallire nulla, nemmeno in primary,
      // perche' in primary non gira affatto.
      logger?.warn?.(`[identity-write-through] confronto shadow fallito (${safeErrorCode(error)}).`);
      lastComparedAt = now();
      return null;
    }
  }

  /**
   * Il write-through vero. Chiamato dall'hook `beforeWrite` dell'app-state, DOPO le sync
   * MySQL: in shadow un errore PostgreSQL non deve poter impedire una scrittura MySQL, e
   * l'unico modo per garantirlo e' che PostgreSQL venga per ultimo e non lanci.
   *
   * `options` sono le opzioni della `writeDb`. Da esse si estrae solo l'intenzione di
   * sostituzione integrale (§4.9 P1); tutto il resto e' ignorato.
   */
  async function syncFromAppState(state, writeOptions = {}) {
    if (!enabled) return null;
    const startedAt = now();
    let rows;
    try {
      rows = identityRowsFromAppState(state);
    } catch (error) {
      // Un record app-state fuori contratto (id vuoto, username vuoto, timestamp non
      // parsabile) e' un difetto del dato, non di PostgreSQL: si tratta come un fallimento
      // di scrittura shadow, con la stessa regola di fatalita'.
      return handleFailure(error, startedAt, "map");
    }
    // D32: dominio assente = non toccato. Se l'app-state non porta NESSUNA delle due
    // collezioni non c'e' niente da propagare, e non si apre nemmeno una transazione.
    if (rows.users === null && rows.userGroups === null) {
      counters.skipped += 1;
      return null;
    }
    const syncOptions = buildIdentitySyncOptions(writeOptions);
    try {
      const summary = await runtime.withTransaction(WRITE_THROUGH_LABEL, (client) =>
        repository.syncFromAppState(client, {
          users: rows.users,
          userGroups: rows.userGroups,
          options: syncOptions,
        }),
      );
      counters.runs += 1;
      absorbSummary(summary);
      recordOperation("sync", now() - startedAt);
      await refreshStore();
      const comparison = await compareIfDue(state);
      return { ok: true, summary, comparison };
    } catch (error) {
      return handleFailure(error, startedAt, "write");
    }
  }

  function handleFailure(error, startedAt, stage) {
    counters.writeFailures += 1;
    incrementCounter("identityShadowWriteFailures");
    recordOperation(`failure.${stage}.${safeErrorCode(error)}`, now() - startedAt);
    logger?.warn?.(
      `[identity-write-through] scrittura identity su PostgreSQL fallita in ${stage} ` +
        `(${safeErrorCode(error)}); livello ${mode?.identityLevel ?? "off"}.`,
    );
    // Vincolo 1 dello slice, e §4.9 (g): in shadow si registra e si prosegue, perche'
    // `beforeWriteRequired` e' true e rilanciare farebbe abortire la `writeDb` MySQL.
    if (failuresAreFatal) throw error;
    return { ok: false, errorCode: safeErrorCode(error), stage };
  }

  return Object.freeze({
    syncFromAppState,
    compareWithAppState,
    counters() {
      // La copia dei contatori di prune e' a DUE livelli: `{ ...counters }` sola
      // condividerebbe gli oggetti per dominio, e chi legge le metriche si troverebbe in
      // mano una struttura viva che cambia sotto di lui a ogni scrittura.
      const identityPruneSkipped = { ...counters.identityPruneSkipped };
      for (const domain of IDENTITY_COLLECTIONS) {
        identityPruneSkipped[domain] = { ...counters.identityPruneSkipped[domain] };
      }
      return { ...counters, identityPruneSkipped, lastComparedAt };
    },
    get enabled() {
      return enabled;
    },
    get failuresAreFatal() {
      return failuresAreFatal;
    },
    get identityLevel() {
      return mode?.identityLevel ?? "off";
    },
    mode,
  });
}
