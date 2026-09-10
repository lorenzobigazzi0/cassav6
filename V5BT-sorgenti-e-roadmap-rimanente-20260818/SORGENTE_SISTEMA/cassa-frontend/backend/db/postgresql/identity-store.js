// MIG-040 — Lo store di lettura del dominio identity (§9.4, §3.3, §3.4).
//
// TERZO ANELLO: solo lettura. Questo file non contiene SQL — lo vieta il gate
// audit:repository-boundary e lo impone §9.3, «tutto il SQL del dominio identity vive in
// identity.repository.js» — e non esegue nessuna INSERT/UPDATE/DELETE. Il write-through
// (`syncFromAppState`) è il quarto anello e qui non c'è.
//
// Due superfici, e la separazione è il vincolo, non un dettaglio (§9.4):
//
//   sincrona   isPrimaryDomain, snapshotStatus, listUsers, getUserById, listUserGroups,
//              stripIdentityForPrimaryWrite
//              nessun I/O, nessuna Promise, nessun refresh. Legge un array in memoria,
//              un timestamp e due flag. Ritorna COPIE PROFONDE e MUTABILI (R-ISO-2).
//
//   asincrona  refresh, hydrateAppState, start, stop
//              sono queste, e solo queste, ad aggiornare snapshot, loadedAt e i latch.
//
// Se un metodo della superficie sincrona diventasse `async`, `getUserById` ritornerebbe
// una Promise e `validateResolvedSessionContext` (backend/server.js:17776-17779) la
// troverebbe truthy: ogni sessione sarebbe valida per chiunque (§9.4 R2).
//
// Il `pinHash` è nel valore di ritorno — è il dato che serve a `verifyPin` — e non entra
// MAI in un log, in un messaggio d'errore o in una diagnostica (§4.7). Le diagnostiche di
// questo file portano id e conteggi, mai username e mai valori di record.

import { isAdministratorProfile, normalizeIdentityUsername } from "./identity.repository.js";
import { IDENTITY_COLLECTIONS, isIdentityCollection, normalizeIdentityMode } from "./identity-mode.js";
// Il predicato «la collezione c'e' o non c'e'» e' UNO SOLO e vive dove sta la
// trasformazione app-state -> righe, cioe' dove si decide che cosa arriva davvero su
// PostgreSQL. Importarlo invece di riscriverlo e' il punto: due predicati equivalenti che
// divergono su un ingresso raro sono esattamente il difetto che questo import chiude.
// Questo import non porta SQL: identity-canonical.js non ne contiene e non apre connessioni.
import { appStateCarriesIdentityCollection } from "./identity-canonical.js";

// MIG-040 anello 6 (§1.5) — il marcatore che il blob MariaDB deve portare da primary in su.
// Non e' `storage: "mysql"`: dopo la commutazione la verita' di `users`/`userGroups` sta su
// PostgreSQL, e un marcatore che dichiara MySQL e' un marcatore che mente (§7.6 punto 1).
// Nessun `updatedAt`: il marcatore dice DOVE vive il dominio, non quando e' stato scritto, e
// un timestamp nuovo a ogni scrittura renderebbe il blob sempre diverso da se' stesso.
const IDENTITY_BLOB_SPLIT_MARKER = Object.freeze({
  mode: "externalized",
  storage: "postgresql",
  schema: "identity",
});

// La forma del vuoto. `defaultEmptyValue`
// (backend/db/app-state/mysql-domains-split.repository.js:772-776) la fa seguire alla forma
// dell'originale perche' deve svuotare trentuno domini di forma qualunque; qui il predicato
// `appStateCarriesIdentityCollection` ha gia' escluso tutto cio' che non e' un array, quindi
// la forma dell'originale E' l'array e il vuoto e' `[]` — lo stesso valore che
// `defaultEmptyValue` produrrebbe, senza i due rami che non possono piu' essere raggiunti.
// Cosi' `Array.isArray(db.users)` resta vero dopo lo strip.

// R-FRESH-6: un solo codice d'errore, con `reason` per l'operatore.
export const IDENTITY_STORE_UNAVAILABLE = "IDENTITY_STORE_UNAVAILABLE";

// Gli stati di snapshotStatus(). Il nome IDENTITY_SNAPSHOT_STALE non si usa.
// L'enumerazione e' CHIUSA: R-FRESH-6 vuole un solo codice d'errore e un `reason` che
// l'operatore possa leggere, quindi ogni motivo nuovo va aggiunto qui e non inventato al
// volo nel punto in cui serve.
export const IDENTITY_SNAPSHOT_REASONS = Object.freeze([
  "never_loaded",
  "refresh_failed",
  "stale",
  "duplicate_normalized_username",
  // D43 — identity e' primary e la collezione non contiene alcun amministratore.
  "no_administrator",
]);

function storeUnavailableError(reason, details = null) {
  const error = new Error("Store identity PostgreSQL non disponibile.");
  error.code = IDENTITY_STORE_UNAVAILABLE;
  error.status = 503;
  error.details = { reason, ...(details ?? {}) };
  return error;
}

// Copia profonda e MUTABILE. Non congelata, e la ragione va scritta perché è
// controintuitiva: i moduli sono ESM, quindi strict mode, e un'assegnazione su un oggetto
// congelato lancia TypeError invece di essere ignorata; `getUserById` è consumata da 92
// punti di chiamata che nessuno ha verificato uno per uno (§3.3 R-ISO-2).
function deepCopy(value) {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

// Solo il codice, mai il messaggio: un messaggio del driver può contenere frammenti di
// query o di parametri (§4.7).
function safeErrorCode(error) {
  const code = asTrimmedString(error?.code);
  if (code) return code;
  return error instanceof Error ? error.constructor.name : "Error";
}

// `record` è la forma app-state (§4.6: chiave assente ≠ valore vuoto), già costruita da
// rowToUser/rowToUserGroup. Lo store non la ricostruisce e non la normalizza.
function recordOf(entry) {
  if (!entry || typeof entry !== "object") return null;
  return entry.record && typeof entry.record === "object" ? entry.record : entry;
}

/**
 * §3.1 punto 2 / D38.2. L'indice di lookup si costruisce in JavaScript con
 * `normalizeIdentityUsername`, NON leggendo la colonna `username_normalized`: se colonna e
 * funzione divergessero, un login non deve mai finire sull'utente sbagliato. Due record che
 * producono la stessa chiave normalizzata armano il latch `duplicate_normalized_username`,
 * con `details.ids` e mai gli username.
 */
export function indexUsers(entries) {
  const users = [];
  const byId = new Map();
  const byNormalizedUsername = new Map();
  const duplicateIds = new Set();

  for (const entry of entries ?? []) {
    const record = recordOf(entry);
    if (!record) continue;
    const id = asTrimmedString(entry?.id ?? record.id);
    if (!id) continue;
    users.push(record);
    byId.set(id, record);
    const normalized = normalizeIdentityUsername(record.username);
    if (!normalized) continue;
    const existing = byNormalizedUsername.get(normalized);
    if (existing !== undefined) {
      duplicateIds.add(existing);
      duplicateIds.add(id);
      continue;
    }
    byNormalizedUsername.set(normalized, id);
  }

  if (duplicateIds.size > 0) {
    throw storeUnavailableError("duplicate_normalized_username", {
      ids: Array.from(duplicateIds).sort(),
    });
  }

  return { users, byId, byNormalizedUsername };
}

function indexUserGroups(entries) {
  const groups = [];
  for (const entry of entries ?? []) {
    const record = recordOf(entry);
    if (!record) continue;
    groups.push(record);
  }
  return groups;
}

/**
 * Lo store è inerte per difetto: senza le liste di D31 `isPrimaryDomain` ritorna sempre
 * `false` e nessun ramo nuovo si accende. Non commuta niente da solo.
 */
export function createPostgresqlIdentityStore(options = {}) {
  const mode = options.mode ?? normalizeIdentityMode({ env: options.env });
  const repository = options.repository ?? null;
  const logger = options.logger ?? console;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const startTimer = options.setInterval ?? setInterval;
  const stopTimer = options.clearInterval ?? clearInterval;
  const maxStalenessMs = mode.maxStalenessMs;
  const snapshotTtlMs = mode.snapshotTtlMs;

  let snapshot = null;
  let lastRefreshError = null;
  let duplicateIds = null;
  // D43 — latch: identity e' primary e non c'e' nemmeno un amministratore.
  let noAdministrator = false;
  let timer = null;
  let inFlight = null;

  function requireRepository() {
    if (!repository) {
      throw storeUnavailableError("never_loaded", { detail: "repository identity non configurato" });
    }
    return repository;
  }

  // ---------------------------------------------------------------------------
  // Superficie SINCRONA. Nessun await qui sotto, per nessun motivo (R2).
  // ---------------------------------------------------------------------------

  // Prende il nome della COLLEZIONE app-state; la mappatura verso il dominio `identity`
  // delle tre liste di D31 è interna allo store (§9.4).
  function isPrimaryDomain(collection) {
    return mode.isIdentityPrimary === true && isIdentityCollection(collection);
  }

  function isShadowDomain(collection) {
    return mode.isIdentityShadow === true && isIdentityCollection(collection);
  }

  /**
   * R5: guarda TRE cose, non una — più il latch dei duplicati, che è a sé.
   * È solo un giudizio su ciò che è già in memoria: due numeri e due flag. Non innesca
   * mai un refresh (R4) e non lancia mai.
   *
   * Scelta dichiarata sull'ordine dei rami: `duplicate_normalized_username` viene PRIMA di
   * `never_loaded`. Lo pseudocodice di §9.4 R5 non lo contiene (R5 lo introduce nella prosa
   * come «un latch a sé»), e metterlo dopo lo renderebbe invisibile proprio nel caso per cui
   * esiste — due omonimi trovati al PRIMO caricamento, quando `snapshot` è ancora `null`:
   * l'operatore leggerebbe «never_loaded» e cercherebbe un guasto di rete inesistente.
   */
  function snapshotStatus() {
    const ageMs = snapshot ? now() - snapshot.loadedAt : null;
    if (duplicateIds) {
      return { ok: false, reason: "duplicate_normalized_username", ageMs, maxStalenessMs };
    }
    if (!snapshot) {
      return { ok: false, reason: "never_loaded", ageMs: null, maxStalenessMs };
    }
    // D43 — prima di `refresh_failed` e di `stale`: uno snapshot fresco e senza
    // amministratori e' peggio di uno vecchio, e il motivo deve dirlo. Un operatore che
    // legge «stale» va a cercare un problema di rete che non c'e'.
    if (noAdministrator) {
      return { ok: false, reason: "no_administrator", ageMs, maxStalenessMs };
    }
    if (lastRefreshError) {
      return { ok: false, reason: "refresh_failed", ageMs, maxStalenessMs };
    }
    if (ageMs > maxStalenessMs) {
      return { ok: false, reason: "stale", ageMs, maxStalenessMs };
    }
    return { ok: true, reason: null, ageMs, maxStalenessMs };
  }

  // R-ISO-2: copie profonde in uscita, mai i record interni. Il giudizio di freschezza NON
  // si dà qui: lo dà il chiamante con snapshotStatus() prima di leggere (R-FRESH-1), perché
  // è lì che si sa se la risposta è un 503 o una lista vuota legittima.
  function listUsers() {
    if (!snapshot) return [];
    return snapshot.users.map(deepCopy);
  }

  function getUserById(id) {
    const safeId = asTrimmedString(id);
    if (!safeId || !snapshot) return null;
    const record = snapshot.byId.get(safeId);
    return record ? deepCopy(record) : null;
  }

  function listUserGroups() {
    if (!snapshot) return [];
    return snapshot.userGroups.map(deepCopy);
  }

  // Non è nella superficie minima di §9.4: l'indice esiste comunque per la guardia degli
  // omonimi, e questo lo rende leggibile senza aggiungere una seconda normalizzazione.
  // `getUserByUsername` di auth.repository.js resta INVARIATA e non lo usa (§9.4).
  function getUserByNormalizedUsername(username) {
    const normalized = normalizeIdentityUsername(username);
    if (!normalized || !snapshot) return null;
    const id = snapshot.byNormalizedUsername.get(normalized);
    return id === undefined ? null : getUserById(id);
  }

  function snapshotCounts() {
    if (!snapshot) return { users: 0, userGroups: 0, loadedAt: null };
    return { users: snapshot.users.length, userGroups: snapshot.userGroups.length, loadedAt: snapshot.loadedAt };
  }

  /**
   * MIG-040 anello 6, §1.5 — la modifica che nessun documento aveva previsto.
   *
   * `BACKEND_MYSQL_APP_STATE_DOMAINS` e' letta da TRE cicli, non da uno:
   * `syncFromAppState` (mysql-domains-split.repository.js:2720), `hydrateAppState` (:1354) e
   * `stripDomainsFromAppState` (:2739). Togliendo `users,userGroups` dalla lista il terzo
   * ciclo smette di svuotarli, e il blob dell'app-state scritto su MariaDB **ricomincia a
   * portare l'array utenti per intero, con i `pinHash` dentro** — l'esatto contrario di cio'
   * che la commutazione vuole. In piu' il marcatore `meta.appStateSplitDomains.users`
   * sopravvive alla rimozione (`stripDomainsFromAppState` parte dalla copia di cio' che c'e'
   * e solo aggiunge, :2729-2737) e continuerebbe a dichiarare `storage: "mysql"`.
   *
   * Questa funzione chiude entrambe le conseguenze. Non contiene SQL, non e'
   * `syncFromAppState` e non scrive niente da nessuna parte: prepara un oggetto.
   *
   * QUELLO CHE NON CHIUDE, e che nessuno deve credere chiuso. §7.6 punto 1 del documento
   * madre chiede che l'app-state su MariaDB non porti piu' identity «ne' nel blob ne' in
   * `app_state_domain_records`». Qui si chiude il blob e si corregge il marcatore; le RIGHE
   * di `app_state_domain_records` restano dove sono, ferme dal momento della commutazione,
   * con ogni `pinHash` dentro. Non e' una dimenticanza: e' il piano di rientro
   * (MIG040_ANELLO6_COMMUTAZIONE.md §5.2 — «il legacy non e' mai stato svuotato… il rientro
   * le rimette in servizio cosi' com'erano»), cancellarle appartiene a MIG-150, e la
   * domanda 9 di §6 la lascia esplicitamente al proprietario. La parentesi di §7.6 punto 1
   * contraddice il punto 2 della stessa sezione, che vuole la prova dinamica «dopo un
   * `users.save` quelle righe non cambiano e `max(updated_at)` non avanza» — una prova che
   * presuppone che le righe ESISTANO. Vale il punto 2; la correzione e' scritta nei due
   * documenti (§7.6 del documento madre e §7.5 del documento dell'anello 6).
   *
   * Inerte per difetto e per costruzione: fuori da primary ritorna lo stato **identico**,
   * per identita' di riferimento. La stessa guardia sta anche nel chiamante
   * (`prepareAppStateSplitPrimaryWrite`, backend/server.js): due volte, perche' la funzione
   * deve essere sicura anche se un giorno qualcuno la chiama da un altro punto.
   *
   * Non muta l'oggetto ricevuto: copia il livello superiore e `meta`. La copia e'
   * SUPERFICIALE, non profonda come `cloneJson` di `stripDomainsFromAppState`, ed e' una
   * scelta: si sostituiscono due chiavi con valori nuovi e si riscrive `meta`, quindi
   * nessun oggetto annidato dell'ingresso viene toccato, e una seconda copia profonda
   * dell'intero app-state a ogni scrittura sarebbe un costo senza contropartita.
   */
  function stripIdentityForPrimaryWrite(state) {
    if (!state || typeof state !== "object") return state;
    // `isPrimaryDomain` guarda `mode.isIdentityPrimary`: con le liste di D31 vuote e'
    // sempre `false` e questa funzione e' una `return state;`.
    if (!isPrimaryDomain("users")) return state;

    const persisted = { ...state };
    for (const collection of IDENTITY_COLLECTIONS) {
      // §4.6 / D32: chiave assente non e' valore vuoto. Se il blob non porta la collezione
      // non la si introduce — non c'e' niente da togliere. Il predicato e' lo STESSO che
      // decide, in `identityRowsFromAppState`, se la collezione arriva su PostgreSQL: si
      // toglie dal blob solo cio' che il write-through ha davvero portato altrove. Con
      // `hasOwnProperty` erano due predicati diversi e su una collezione in forma di oggetto
      // divergevano — svuotata di qua, mai scritta di la'.
      if (!appStateCarriesIdentityCollection(state[collection])) continue;
      persisted[collection] = [];
    }

    if (persisted.meta && typeof persisted.meta === "object") {
      const previous =
        persisted.meta.appStateSplitDomains && typeof persisted.meta.appStateSplitDomains === "object"
          ? persisted.meta.appStateSplitDomains
          : {};
      const splitDomains = { ...previous };
      // Il marcatore si riscrive per ENTRAMBE le collezioni anche quando la chiave era
      // assente dal blob: dice dove vive il dominio, non che cosa c'era nell'oggetto. E' il
      // solo modo di sostituire un `storage: "mysql"` rimasto li' dalla commutazione.
      for (const collection of IDENTITY_COLLECTIONS) {
        splitDomains[collection] = { ...IDENTITY_BLOB_SPLIT_MARKER };
      }
      persisted.meta = { ...persisted.meta, appStateSplitDomains: splitDomains };
    }

    return persisted;
  }

  // ---------------------------------------------------------------------------
  // Superficie ASINCRONA. È la sola che tocca lo snapshot, `loadedAt` e i latch (R4).
  // ---------------------------------------------------------------------------

  async function loadSnapshot() {
    const source = requireRepository();
    const [users, userGroups] = await Promise.all([source.listUsers(), source.listUserGroups()]);
    const indexed = indexUsers(users);
    return {
      loadedAt: now(),
      users: indexed.users,
      byId: indexed.byId,
      byNormalizedUsername: indexed.byNormalizedUsername,
      userGroups: indexUserGroups(userGroups),
    };
  }

  /**
   * R4: il refresh non avviene mai in lettura. È chiamato dal boot, dal timer di
   * SNAPSHOT_TTL_MS, dall'idratazione e — nel quarto anello — dalla fine di ogni
   * write-through riuscito. Le chiamate concorrenti si accodano sulla stessa promessa:
   * il timer non deve poter accumulare refresh sovrapposti su un PostgreSQL lento.
   */
  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await loadSnapshot();
        snapshot = next;
        lastRefreshError = null;
        duplicateIds = null;
        // D43 — la rete che §3.1 punto 5 dichiarava («assertPostgresPrimaryPreconditions
        // verifica admin_count >= 1 al boot… se quel controllo non viene scritto, il
        // guardiano ha una porta di servizio e nessuno la sorveglia») e che NON era mai
        // stata scritta: `assertPostgresPrimaryPreconditions` non esisteva in tutto il
        // repository, e `countAdministrators` non aveva un solo chiamante.
        // Il buco che copre e' reale: P3 si arma solo se la transazione pianifica UPDATE o
        // DELETE, e il CONSTRAINT TRIGGER della 008 e' AFTER UPDATE OR DELETE. Una sync di
        // soli INSERT su una tabella vuota puo' quindi installare una collezione senza
        // nemmeno un amministratore, senza che nessuna delle due protezioni si accorga di
        // nulla. Da primary in su quello stato non e' recuperabile dall'applicazione: il
        // login risponde 503 e `create-admin.mjs` non conosce la modalita' mysql.
        // Qui non si lancia e non si abbatte il processo: si arma un latch, come per gli
        // omonimi. L'effetto e' che le letture rifiutano con un motivo che si legge, invece
        // di servire una collezione in cui nessuno puo' entrare.
        noAdministrator =
          mode.isIdentityPrimary === true &&
          !next.users.some((entry) => {
            const record = recordOf(entry) ?? entry;
            return isAdministratorProfile(record?.role, record);
          });
        if (noAdministrator) {
          logger?.error?.(
            "[identity-store] identity e' primary ma non contiene alcun amministratore: " +
              "le letture vengono rifiutate. Ripristinare almeno un amministratore prima di proseguire.",
          );
        }
        return snapshotStatus();
      } catch (error) {
        if (error?.code === IDENTITY_STORE_UNAVAILABLE && Array.isArray(error?.details?.ids)) {
          // Latch a sé: lo snapshot ambiguo NON viene installato. Si azzera solo con un
          // refresh che trova dati non ambigui. Nel log gli id, mai gli username.
          duplicateIds = error.details.ids;
          logger?.error?.(
            `[identity-store] username normalizzati duplicati: ${duplicateIds.length} record coinvolti ` +
              `(id: ${duplicateIds.join(", ")}).`,
          );
        } else {
          lastRefreshError = safeErrorCode(error);
          logger?.warn?.(`[identity-store] refresh dello snapshot fallito (${lastRefreshError}).`);
        }
        throw error;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /**
   * R-ISO-1: consegna copie profonde e MUTABILI a ogni idratazione. I write model mutano in
   * posto (login-write-model.js:105-118) e quella mutazione deve finire nell'oggetto che
   * arriva a writeDb, non nello snapshot dello store.
   *
   * Se il refresh fallisce ma uno snapshot esiste, si idrata comunque: la freschezza si
   * impone nel ramo di createAuthRepository (R-FRESH-1), non qui, e un throw in idratazione
   * verrebbe comunque inghiottito da readStructuredDb (§3.4, :651-659).
   */
  async function hydrateAppState(state, hydrateOptions = {}) {
    if (!state || typeof state !== "object") return state;
    if (hydrateOptions.refresh !== false) {
      try {
        await refresh();
      } catch (error) {
        if (!snapshot) throw error;
      }
    }
    state.users = listUsers();
    state.userGroups = listUserGroups();
    return state;
  }

  /**
   * R-FRESH-2: lo store possiede la propria cadenza. Il timer è `unref()`-ato — non tiene
   * vivo il processo — e il primo refresh parte subito, così `never_loaded` dura quanto una
   * query e non quanto un TTL.
   */
  function start() {
    if (timer || !mode.enabled || mode.identityLevel === "off" || !repository) return false;
    timer = startTimer(() => {
      void refresh().catch(() => {});
    }, snapshotTtlMs);
    timer?.unref?.();
    void refresh().catch(() => {});
    return true;
  }

  function stop() {
    if (!timer) return false;
    stopTimer(timer);
    timer = null;
    return true;
  }

  const store = {
    // sincrona
    isPrimaryDomain,
    isShadowDomain,
    snapshotStatus,
    listUsers,
    getUserById,
    listUserGroups,
    getUserByNormalizedUsername,
    snapshotCounts,
    stripIdentityForPrimaryWrite,
    // asincrona
    refresh,
    hydrateAppState,
    start,
    stop,
    // configurazione
    mode,
    get enabled() {
      return mode.enabled && mode.identityLevel !== "off";
    },
    get identityLevel() {
      return mode.identityLevel;
    },
  };

  return Object.freeze(store);
}
