// MIG-040 — L'interruttore del dominio identity su PostgreSQL (D31).
//
// Tre liste di domini, non una flag a livelli. Ogni gradino si sale aggiungendo una riga
// e si scende cancellandola; un errore di battitura produce un errore al boot invece di
// una configurazione sbagliata plausibile (D31, «Perché»).
//
//   BACKEND_POSTGRES_ENABLED=1                      L1  pool aperto, nessuno legge PG
//   BACKEND_POSTGRES_SHADOW_DOMAINS=identity        L2  lettura legacy, confronto
//   BACKEND_POSTGRES_PRIMARY_DOMAINS=identity       L3  lettura e scrittura PG
//   BACKEND_POSTGRES_LEGACY_WRITE_GUARD_DOMAINS=…   L4  come L3, e rifiuta di partire se lo
//                                                       scrittore legacy di users/userGroups
//                                                       e' ancora armato (controllo 7)
//
// MIG-041 aggiunge il dominio `sessions` alle STESSE tre liste. I gradini sono gli stessi e
// si esprimono allo stesso modo (`…SHADOW_DOMAINS=identity,sessions`), ma i due domini si
// muovono in modo indipendente: si puo' avere identity a primary e sessions a off, e
// viceversa. Cambiano solo i controlli di coerenza, perche' cambia chi altro scrive quei dati
// — controllo S1 (il relazionale) e controllo S2 (il percorso veloce di login e logout).
//
// Default del pacchetto: tutte le liste vuote, comportamento identico a oggi (D31 punto 7).
// Il modulo è nuovo e separato da backend/db/persistence-mode.js, che governa un altro
// motore (D31 punto 1); la forma — insieme di domini, elenco dei valori ammessi nel
// messaggio, throw invece di ignorare — è quella di persistence-mode.js:41-59 e :104-109.
//
// Questo file non contiene SQL e non apre connessioni: legge solo l'ambiente.

// I domini PostgreSQL commutabili. `sessions` e' la voce di MIG-041 e `configuration` quella
// di MIG-042a, aggiunte qui e non in un secondo modulo perche' D31 dice che la commutazione
// per dominio si esprime con TRE LISTE di domini: un `BACKEND_POSTGRES_SESSIONS_MODE` o un
// `BACKEND_POSTGRES_CONFIGURATION_MODE` a parte sarebbero la forma che D31 ha gia' scartato.
// Quali controlli valgono su `configuration` e quali no: in fondo al file, sezione MIG-042a.
//
// CONSEGUENZA DICHIARATA, e va detta perche' rende rossa una riga di test scritta prima:
// `BACKEND_POSTGRES_SHADOW_DOMAINS=sessions` non e' piu' un errore di configurazione, e da
// MIG-042a non lo e' piu' nemmeno `...=configuration`. Il controllo 1 aveva due prove che
// usavano quei nomi come esempi di dominio inesistente: backend/tests/postgresql-identity-store.test.mjs:166-188
// per la prima e la prova del limite dichiarato dell'anello 3 per la seconda. Gli esempi sono
// cambiati; l'asserzione — «un dominio fuori elenco lancia nominando l'elenco» — non e' cambiata.
export const POSTGRESQL_DOMAINS = Object.freeze(["identity", "sessions", "configuration"]);

// Le collezioni app-state che il dominio `identity` copre. La mappatura collezione ->
// dominio è interna a questo modulo e allo store (§9.4): il chiamante sincrono di
// createAuthRepository conosce solo "users" / "userGroups".
export const IDENTITY_COLLECTIONS = Object.freeze(["users", "userGroups"]);

// Il dominio `sessions` copre una collezione sola, e ha lo stesso nome del dominio. La
// mappatura resta comunque esplicita: il chiamante sincrono di createAuthRepository conosce
// il nome della COLLEZIONE ("sessions"), non quello della lista di D31, ed e' cosi' che
// MIG-042 potra' aggiungere un dominio con piu' collezioni senza toccare i chiamanti.
export const SESSIONS_COLLECTIONS = Object.freeze(["sessions"]);

// Traduzione dell'alias documentale BACKEND_POSTGRES_DOMAIN_MODE (D31 punto 3), che il
// codice NON legge: off -> nessuna riga, shadow -> L2, primary -> L3, exclusive -> L4.
export const IDENTITY_LEVELS = Object.freeze(["off", "shadow", "primary", "exclusive"]);

const DOMAIN_MODE_ALIAS_ENV = "BACKEND_POSTGRES_DOMAIN_MODE";
const SHADOW_ENV = "BACKEND_POSTGRES_SHADOW_DOMAINS";
const PRIMARY_ENV = "BACKEND_POSTGRES_PRIMARY_DOMAINS";
const LEGACY_WRITE_GUARD_ENV = "BACKEND_POSTGRES_LEGACY_WRITE_GUARD_DOMAINS";
const ENABLED_ENV = "BACKEND_POSTGRES_ENABLED";
const RELATIONAL_PRIMARY_ENV = "BACKEND_RELATIONAL_PRIMARY_DOMAINS";

// Le tre variabili che, INSIEME, decidono se lo scrittore legacy di `users`/`userGroups`
// esiste ancora. Non sono di questo modulo, e per questo si leggono qui: il controllo 7
// deve giudicare la configurazione dell'ALTRO motore, esattamente come il controllo 5
// giudica BACKEND_RELATIONAL_PRIMARY_DOMAINS.
const DB_MODE_ENV = "BACKEND_DB_MODE";
const MYSQL_SPLIT_APP_STATE_DOMAINS_ENV = "BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS";
const MYSQL_APP_STATE_DOMAINS_ENV = "BACKEND_MYSQL_APP_STATE_DOMAINS";

// MIG-041 — le due variabili che, INSIEME a BACKEND_DB_MODE, armano il percorso veloce di
// login e logout. Si leggono qui per la stessa ragione delle tre qui sopra: il controllo S2
// deve giudicare la configurazione di un ALTRO motore.
const MYSQL_SPLIT_SESSIONS_ENV = "BACKEND_MYSQL_SPLIT_SESSIONS";
const MYSQL_SPLIT_AUDIT_EVENTS_ENV = "BACKEND_MYSQL_SPLIT_AUDIT_EVENTS";

const SNAPSHOT_TTL_ENV = "BACKEND_POSTGRES_IDENTITY_SNAPSHOT_TTL_MS";
const SHADOW_INTERVAL_ENV = "BACKEND_POSTGRES_IDENTITY_SHADOW_INTERVAL_MS";
const MAX_STALENESS_ENV = "BACKEND_POSTGRES_IDENTITY_MAX_STALENESS_MS";

export const DEFAULT_SNAPSHOT_TTL_MS = 1000;
export const DEFAULT_SHADOW_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_STALENESS_MS = 5000;

// R-FRESH-4 / §9.4 R6: il limite superiore della finestra di staleness ammessa.
export const MAX_STALENESS_CEILING_MS = 60_000;
// Derivato, non inventato: con TTL oltre questa soglia l'intervallo ammesso
// [2 × TTL, 60000] sarebbe vuoto e nessun valore di MAX_STALENESS_MS farebbe partire il
// boot. Si rifiuta il TTL, non i cinquantanove valori che ne discendono.
export const MAX_SNAPSHOT_TTL_MS = MAX_STALENESS_CEILING_MS / 2;

const DOMAIN_LABEL = POSTGRESQL_DOMAINS.join(", ");
const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function parseEnabled(value) {
  return ENABLED_VALUES.has(String(value ?? "").trim().toLowerCase());
}

function envValue(env, name) {
  return env && Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}

export function isIdentityCollection(collection) {
  return IDENTITY_COLLECTIONS.includes(String(collection ?? "").trim());
}

export function isSessionsCollection(collection) {
  return SESSIONS_COLLECTIONS.includes(String(collection ?? "").trim());
}

// Forma di persistence-mode.js:41-59: si lancia con l'elenco dei valori ammessi, non si
// ignora la voce sconosciuta.
export function parsePostgresqlDomainList(value, options = {}) {
  const envName = options.envName ?? PRIMARY_ENV;
  const allowed = options.allowedDomains ?? POSTGRESQL_DOMAINS;
  const allowedLabel = options.allowedLabel ?? DOMAIN_LABEL;
  const domains = new Set();

  String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const domain = entry.toLowerCase();
      if (!allowed.includes(domain)) {
        throw new Error(`${envName} non valido: '${entry}'. Valori ammessi: ${allowedLabel}.`);
      }
      domains.add(domain);
    });

  return domains;
}

function parseMilliseconds(value, envName, fallback, bounds) {
  const raw = String(value ?? "").trim();
  if (raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${envName} non valido: '${raw}'. Atteso un intero di millisecondi.`);
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    throw new Error(
      `${envName} non valido: ${parsed}. Valori ammessi: da ${bounds.min} a ${bounds.max} millisecondi.`,
    );
  }
  return parsed;
}

/**
 * Il cuore del livello L4: quali collezioni identity lo scrittore legacy dell'app-state
 * split scriverebbe ANCORA su MariaDB, con questa configurazione.
 *
 * Non e' una supposizione, e' la riproduzione di tre righe di `backend/server.js`, nello
 * stesso ordine in cui lui le valuta:
 *
 *   1. `DB_MODE` (`:728-738`): `BACKEND_DB_MODE ?? "mysql"`, trim + lowercase. Fuori da
 *      "mysql" il repository split non esiste affatto.
 *   2. `MYSQL_SPLIT_APP_STATE_DOMAINS` (`:786-788`): `DB_MODE === "mysql"` E
 *      `BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS === "1"` — confronto esatto con la stringa
 *      "1", non un parseEnabled. Se e' spento il repository c'e' ma e' inerte
 *      (`:15950-15953` lo costruisce con `enabled:` quel valore).
 *   3. `MYSQL_APP_STATE_DOMAINS` (`:827-832`): la lista si legge dall'ambiente, si divide
 *      sulla virgola, si fa trim; **se il risultato e' vuoto valgono i default di
 *      `:794-826`, che contengono `users` a `:795` e `userGroups` a `:796`**. Variabile
 *      assente NON significa quindi «nessun dominio»: significa tutti e trentuno, le due
 *      identity comprese. E' il caso che rende necessario questo controllo.
 *
 * Il confronto sui nomi e' ESATTO, come in `shouldSyncSplitDomain` / `syncDomainFromAppState`:
 * `usergroups` scritto in minuscolo non corrisponde ad alcun dominio dello split, quindi non
 * produce nessuna scrittura legacy e non va segnalato. Riconoscerlo qui vorrebbe dire
 * inventare una regola che l'altro motore non ha.
 */
export function legacyIdentitySplitWriterState(env) {
  const dbMode = String(envValue(env, DB_MODE_ENV) ?? "mysql").trim().toLowerCase();
  const off = { splitActive: false, listConfigured: false, armed: [], disarmed: [] };
  if (dbMode !== "mysql") return off;
  if (String(envValue(env, MYSQL_SPLIT_APP_STATE_DOMAINS_ENV) ?? "") !== "1") return off;

  const configured = String(envValue(env, MYSQL_APP_STATE_DOMAINS_ENV) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  // Lista vuota o assente = i default di server.js, che portano ENTRAMBE le collezioni.
  if (configured.length === 0) {
    return { splitActive: true, listConfigured: false, armed: Array.from(IDENTITY_COLLECTIONS), disarmed: [] };
  }
  return {
    splitActive: true,
    listConfigured: true,
    armed: IDENTITY_COLLECTIONS.filter((collection) => configured.includes(collection)),
    disarmed: IDENTITY_COLLECTIONS.filter((collection) => !configured.includes(collection)),
  };
}

/**
 * Il controllo 7 legge questa: quali collezioni identity lo scrittore legacy scriverebbe
 * ANCORA. Il controllo 8 legge `disarmed` dello stesso stato, cioe' la stessa lettura
 * dell'ambiente vista dall'altro lato — non una seconda lettura che potrebbe divergere.
 */
export function legacyIdentityWritersStillArmed(env) {
  return legacyIdentitySplitWriterState(env).armed;
}

/**
 * MIG-041 controllo S2 — lo stato del PERCORSO VELOCE di login e logout, che e' il fatto che
 * decide se `sessions` puo' essere primary.
 *
 * Non e' una supposizione. `login` e `logout` NON chiamano `writeDb` per prima cosa: provano
 * `writeAuthSessionFastDb` (backend/server.js:16894-16929) e ricadono sulla `writeDb` solo
 * se quella ritorna falso: backend/auth/login-write-model.js:198-213 e
 * backend/auth/logout-write-model.js:76-89. Il percorso veloce scrive DIRETTAMENTE sulle
 * tabelle MariaDB e non passa da `runBeforeWriteHook`, quindi non passa dal write-through:
 * con `sessions` primary, la sessione appena creata non arriverebbe MAI su PostgreSQL e
 * l'utente non riuscirebbe ad autenticarsi al giro successivo, mentre il login risponde OK.
 *
 * Quando e' armato lo dicono tre variabili, riprodotte qui nello stesso ordine in cui
 * `server.js` le valuta:
 *   1. `DB_MODE` (backend/server.js:728-738): fuori da "mysql" i due repository split non
 *      esistono affatto;
 *   2. `MYSQL_SPLIT_SESSIONS` (backend/server.js:774-775): confronto esatto con la stringa
 *      "1", non un parseEnabled;
 *   3. `MYSQL_SPLIT_AUDIT_EVENTS` (backend/server.js:779-780): stessa forma. Servono
 *      ENTRAMBE, perche' `canSync` le richiede tutte e due: backend/server.js:16775-16779.
 *
 * `blobCarriesSessions` e' l'altra faccia della stessa lettura, e serve al limite dichiarato
 * dell'anello: `stripSessionsFromAppState`
 * (backend/db/app-state/mysql-sessions-split.repository.js:446-467) toglie l'array `sessions`
 * dal blob MariaDB solo quando lo split sessioni e' acceso. Spegnendolo per disarmare il
 * percorso veloce, il blob torna a portare le sessioni — `token_hash` compresi.
 */
export function authSessionFastPathState(env) {
  const dbMode = String(envValue(env, DB_MODE_ENV) ?? "mysql").trim().toLowerCase();
  const mysql = dbMode === "mysql";
  const splitSessions = mysql && String(envValue(env, MYSQL_SPLIT_SESSIONS_ENV) ?? "") === "1";
  const splitAuditEvents = mysql && String(envValue(env, MYSQL_SPLIT_AUDIT_EVENTS_ENV) ?? "") === "1";
  return {
    splitSessions,
    splitAuditEvents,
    armed: splitSessions && splitAuditEvents,
    blobCarriesSessions: !splitSessions,
  };
}

function levelOf(domain, shadowDomains, primaryDomains, legacyWriteGuardDomains) {
  if (legacyWriteGuardDomains.has(domain)) return "exclusive";
  if (primaryDomains.has(domain)) return "primary";
  if (shadowDomains.has(domain)) return "shadow";
  return "off";
}

/**
 * Legge e valida le tre liste. Ogni incoerenza è un errore al boot, mai un warning.
 * Il risultato è congelato: è una configurazione, non uno stato.
 */
export function normalizeIdentityMode(options = {}) {
  const env = options.env ?? process.env;

  // Controllo 0 (D31 punto 3). L'alias documentale non è letto: se qualcuno lo mette
  // nell'ambiente credendo che funzioni, il boot fallisce nominando le tre liste vere.
  // Precedente esatto: persistence-mode.js:104-109.
  if (envValue(env, DOMAIN_MODE_ALIAS_ENV) !== undefined) {
    throw new Error(
      `${DOMAIN_MODE_ALIAS_ENV} non e' letto dal codice: e' un alias documentale. ` +
        `Usa ${SHADOW_ENV}, ${PRIMARY_ENV} o ${LEGACY_WRITE_GUARD_ENV}.`,
    );
  }

  const enabled = parseEnabled(env[ENABLED_ENV] ?? env.POSTGRES_ENABLED);

  // Controllo 1: dominio fuori dall'elenco ammesso -> errore con l'elenco.
  const shadowDomains = parsePostgresqlDomainList(env[SHADOW_ENV], { envName: SHADOW_ENV });
  const primaryDomains = parsePostgresqlDomainList(env[PRIMARY_ENV], { envName: PRIMARY_ENV });
  const legacyWriteGuardDomains = parsePostgresqlDomainList(env[LEGACY_WRITE_GUARD_ENV], {
    envName: LEGACY_WRITE_GUARD_ENV,
  });

  // Controllo 2: una qualunque lista non vuota senza BACKEND_POSTGRES_ENABLED è fatale.
  if (!enabled) {
    const populated = [
      shadowDomains.size > 0 ? SHADOW_ENV : null,
      primaryDomains.size > 0 ? PRIMARY_ENV : null,
      legacyWriteGuardDomains.size > 0 ? LEGACY_WRITE_GUARD_ENV : null,
    ].filter(Boolean);
    if (populated.length > 0) {
      throw new Error(
        `${populated.join(", ")} richiede ${ENABLED_ENV}=1: nessun dominio PostgreSQL puo' essere ` +
          "commutato con il runtime disabilitato.",
      );
    }
  }

  // Controllo 3: stesso dominio in SHADOW e in PRIMARY. In primary non esiste un legacy
  // aggiornato con cui confrontarsi, quindi non è uno stato da gestire ma da vietare.
  for (const domain of primaryDomains) {
    if (shadowDomains.has(domain)) {
      throw new Error(
        `Dominio '${domain}' presente sia in ${SHADOW_ENV} sia in ${PRIMARY_ENV}: ` +
          "in primary non esiste un legacy aggiornato con cui confrontarsi.",
      );
    }
  }

  // Controllo 4: LEGACY_WRITE_GUARD su un dominio non primary.
  for (const domain of legacyWriteGuardDomains) {
    if (!primaryDomains.has(domain)) {
      throw new Error(
        `Dominio '${domain}' in ${LEGACY_WRITE_GUARD_ENV} ma assente da ${PRIMARY_ENV}: ` +
          "la guardia sul legacy vale solo su un dominio gia' primary.",
      );
    }
  }

  const identityLevel = levelOf("identity", shadowDomains, primaryDomains, legacyWriteGuardDomains);
  const isIdentityPrimary = identityLevel === "primary" || identityLevel === "exclusive";
  const sessionsLevel = levelOf("sessions", shadowDomains, primaryDomains, legacyWriteGuardDomains);
  const isSessionsPrimary = sessionsLevel === "primary" || sessionsLevel === "exclusive";

  // Una sola lettura di BACKEND_RELATIONAL_PRIMARY_DOMAINS per i controlli 5 e S1: sono la
  // stessa invariante su due domini, e non devono poter vedere due configurazioni diverse.
  const relationalPrimary = String(env[RELATIONAL_PRIMARY_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/[-_\s]+/g, ""))
    .filter(Boolean);

  // Controllo 5 (D39 R1): due source of truth per lo stesso dominio non sono uno stato da
  // gestire, sono uno stato da vietare. Si guarda il CONTENUTO della variabile relazionale,
  // non il suo effetto: una riga dimenticata con il motore relazionale spento è comunque
  // una configurazione che dice due cose opposte su chi è la verità per `users`.
  if (isIdentityPrimary && relationalPrimary.includes("users")) {
    throw new Error(
      `Conflitto di source of truth su 'users': ${PRIMARY_ENV} contiene 'identity' e ` +
        `${RELATIONAL_PRIMARY_ENV} contiene 'users'. Rimuovi 'users' da ${RELATIONAL_PRIMARY_ENV}.`,
    );
  }

  // Controllo S1 (MIG-041) — lo stesso di sopra, sul dominio `sessions`, e non e' una copia
  // per simmetria: qui il conflitto ha gia' un ramo VIVO nel codice. `sessions` e' uno dei
  // domini di RELATIONAL_READ_PRIMARY_DOMAINS (backend/db/persistence-mode.js:15-20) e
  // `findSessionByTokenHash` legge davvero dal relazionale quando `isPrimaryDomain("sessions")`
  // e' vero: backend/modules/auth/auth.repository.js:186-231. Con entrambe le righe scritte,
  // l'unica cosa che deciderebbe quale database autentica sarebbe l'ordine degli `if`.
  if (isSessionsPrimary && relationalPrimary.includes("sessions")) {
    throw new Error(
      `Conflitto di source of truth su 'sessions': ${PRIMARY_ENV} contiene 'sessions' e ` +
        `${RELATIONAL_PRIMARY_ENV} contiene 'sessions'. Rimuovi 'sessions' da ${RELATIONAL_PRIMARY_ENV}.`,
    );
  }

  // Controllo 6 (R6 / R-FRESH-4): i parametri e i loro limiti.
  const snapshotTtlMs = parseMilliseconds(env[SNAPSHOT_TTL_ENV], SNAPSHOT_TTL_ENV, DEFAULT_SNAPSHOT_TTL_MS, {
    min: 1,
    max: MAX_SNAPSHOT_TTL_MS,
  });
  const shadowIntervalMs = parseMilliseconds(
    env[SHADOW_INTERVAL_ENV],
    SHADOW_INTERVAL_ENV,
    DEFAULT_SHADOW_INTERVAL_MS,
    { min: 1, max: 3_600_000 },
  );
  // `0` è escluso per costruzione dal limite inferiore: `now - loadedAt > 0` è vero un
  // millisecondo dopo il refresh e produrrebbe un 503 permanente (§3.4 R-FRESH-4).
  const maxStalenessMs = parseMilliseconds(
    env[MAX_STALENESS_ENV],
    MAX_STALENESS_ENV,
    Math.max(DEFAULT_MAX_STALENESS_MS, snapshotTtlMs * 2),
    { min: snapshotTtlMs * 2, max: MAX_STALENESS_CEILING_MS },
  );

  // Controllo 7 (D5 della revisione REV4) — il livello L4 smette di essere un'etichetta.
  //
  // Fino a qui `exclusive` era `primary` piu' un booleano che nessun file di produzione
  // leggeva: chi metteva la riga otteneva primary e la convinzione, falsa, che qualcosa
  // sorvegliasse il legacy. Un gradino che non fa niente e' peggio di un gradino che non
  // c'e', perche' il primo lo si crede.
  //
  // Che cosa sorveglia. D31 punto 5 dice che a L3 «le due righe sono inseparabili»:
  // `BACKEND_POSTGRES_PRIMARY_DOMAINS=identity` non ferma il dual-write, perche'
  // la chiamata a `mysqlAppStateDomainsSplitRepository.syncFromAppState` dentro
  // `syncAppStateSplitDomains` (backend/server.js:16120-16126) e' INCONDIZIONATA, fuori da
  // ogni `shouldSyncSplitDomain`. L'unico modo di fermarlo senza codice e' togliere
  // `users,userGroups` da
  // `BACKEND_MYSQL_APP_STATE_DOMAINS`. Quell'invariante era affidata alla memoria
  // dell'operatore e a nient'altro. Ora L4 la verifica: se lo scrittore legacy e' ancora
  // armato, il boot fallisce nominando la variabile da correggere.
  //
  // Perche' al boot e non sul percorso di scrittura. Il punto in cui la scrittura legacy
  // avviene sta in `syncAppStateSplitDomains`, cioe' in server.js, e non e' raggiungibile
  // da qui senza spostare il confine dei moduli identity (§9.3). Ma la scrittura legacy non
  // e' un evento: e' una CONFIGURAZIONE. Se e' armata lo e' per tutta la vita del processo,
  // quindi rifiutarsi di partire copre lo stesso insieme di casi del throw a runtime, e lo
  // copre prima che la prima riga sia scritta invece che dopo.
  //
  // Forma e precedente: identici al controllo 5 (D39 R1), che allo stesso modo giudica il
  // CONTENUTO delle variabili di un altro motore e lancia con l'istruzione di rientro.
  //
  // LIMITE DICHIARATO. Il controllo copre lo scrittore legacy dello split app-state, che e'
  // quello che D31 punto 5 nomina e il solo che scriva `users`/`userGroups` su MariaDB.
  // Non copre una scrittura fatta da uno script fuori dal servizio (`psql`, un import
  // manuale): niente al boot puo' vederla.
  // Una sola lettura dell'ambiente per i controlli 7 e 8: sono le due facce della stessa
  // invariante e non devono poter vedere due configurazioni diverse.
  const legacySplit = legacyIdentitySplitWriterState(env);

  if (identityLevel === "exclusive") {
    const stillArmed = legacySplit.armed;
    if (stillArmed.length > 0) {
      throw new Error(
        `${LEGACY_WRITE_GUARD_ENV} contiene 'identity' ma lo scrittore legacy dell'app-state ` +
          `split scriverebbe ancora ${stillArmed.join(", ")} su MariaDB ` +
          `(${MYSQL_SPLIT_APP_STATE_DOMAINS_ENV}=1 e ${MYSQL_APP_STATE_DOMAINS_ENV} ` +
          `${envValue(env, MYSQL_APP_STATE_DOMAINS_ENV) === undefined ? "assente, quindi con i domini di default" : "con quelle voci"}). ` +
          `Togli ${stillArmed.join(", ")} da ${MYSQL_APP_STATE_DOMAINS_ENV}, oppure togli ` +
          `'identity' da ${LEGACY_WRITE_GUARD_ENV} e resta a L3.`,
      );
    }
  }

  // Controllo 8 (difetto MEDIO 5 della revisione avversaria dell'anello 6) — il MEZZO PASSO.
  //
  // Il controllo 7 vieta la meta' innocua della coppia (PostgreSQL autorita' esclusiva
  // mentre il legacy scrive ancora: due scrittori, nessun dato perso). Questo vieta la meta'
  // che PERDE il servizio, ed e' l'unica delle due che si raggiunge per dimenticanza:
  //
  //   andata   si toglie `users,userGroups` da BACKEND_MYSQL_APP_STATE_DOMAINS e ci si
  //            dimentica BACKEND_POSTGRES_PRIMARY_DOMAINS=identity;
  //   ritorno  si cancella BACKEND_POSTGRES_PRIMARY_DOMAINS per rientrare (§5.2 passo 2) e
  //            ci si dimentica di rimettere l'elenco completo.
  //
  // In entrambi i casi il boot oggi PASSA, e il risultato e' lo stesso: le righe
  // `app_state_domain_records` di `users`/`userGroups` si congelano perche' il ciclo di
  // `syncFromAppState` non le vede piu', `hydrateAppState` non le legge piu' e prende la
  // collezione dal blob — che dopo l'esternalizzazione e' vuoto — e senza `identity` in
  // primary non c'e' nessuna idratazione da PostgreSQL a rimetterla. `db.users` diventa
  // vuoto, `hasAdministrativeUser` non trova amministratori e nessuno entra piu'. E'
  // recuperabile in un riavvio, ma e' esattamente la classe di errore che le tre liste di
  // D31 sono state disegnate per rendere impossibile: «un errore di battitura produce un
  // errore al boot invece di una configurazione sbagliata plausibile».
  //
  // Che cosa serve per giudicare, e perche' qui. Servono due fatti: il contenuto di
  // BACKEND_MYSQL_APP_STATE_DOMAINS (che `legacyIdentitySplitWriterState` gia' legge per il
  // controllo 7) e il livello di identity (che questa funzione calcola). Sono qui tutti e
  // due. `buildFullyExternalizedAppStateDomains` (backend/server.js) li ha anch'essa, ma
  // costruisce un insieme e non ha un modo di rifiutare: ritornerebbe un elenco monco e il
  // servizio partirebbe lo stesso. La forma e il precedente sono quelli dei controlli 5 e 7:
  // si giudica il CONTENUTO delle variabili di un altro motore, si lancia al boot, e il
  // messaggio nomina ENTRAMBE le vie d'uscita, quella avanti e quella indietro.
  //
  // Perche' solo con ENABLED. Con il runtime PostgreSQL spento questa macchina non e' sulla
  // strada di MIG-040, e un elenco split che non nomina `users` e' semplicemente
  // un'installazione che non ha mai esternalizzato l'identity: li' la rimozione e' innocua e
  // rifiutare il boot sarebbe un falso positivo. Con ENABLED=1 la coppia di righe di L3 e'
  // in gioco, e l'elenco scritto a mano senza le due voci ha una sola causa nota nel
  // repository — la commutazione — perche' nessun file di configurazione del pacchetto
  // valorizza quella variabile.
  //
  // LIMITE DICHIARATO. Il controllo giudica la configurazione, non lo stato del database:
  // non sa se le righe legacy sono davvero state scritte. Su una macchina con ENABLED=1 che
  // non ha mai esternalizzato l'identity il rifiuto e' un falso positivo, e il rientro e'
  // rimettere le due voci nell'elenco — cioe' la configurazione di default. Non copre
  // nemmeno il rientro completo in cui si cancella l'intero file d'ambiente PostgreSQL,
  // ENABLED compreso, lasciando pero' l'elenco split monco: li' non resta nessun segnale
  // da leggere.
  if (enabled && !isIdentityPrimary && legacySplit.listConfigured && legacySplit.disarmed.length > 0) {
    const mancanti = legacySplit.disarmed.join(", ");
    throw new Error(
      `${MYSQL_APP_STATE_DOMAINS_ENV} non contiene piu' ${mancanti}, ma 'identity' non e' in ` +
        `${PRIMARY_ENV} (livello attuale: ${identityLevel}). E' un mezzo passo: lo scrittore legacy di ` +
        `${mancanti} e' spento e PostgreSQL non e' l'autorita', quindi nessuno scrive piu' quelle ` +
        "collezioni e l'app-state le rilegge dal blob, che dopo l'esternalizzazione e' vuoto — " +
        `nessun amministratore, nessun accesso. Le due righe di L3 si muovono INSIEME: aggiungi ` +
        `${PRIMARY_ENV}=identity per commutare, oppure rimetti ${mancanti} in ` +
        `${MYSQL_APP_STATE_DOMAINS_ENV} per restare (o rientrare) sul legacy.`,
    );
  }

  // Controllo S2 (MIG-041) — il gemello del controllo 7, e vale gia' a PRIMARY invece che a
  // EXCLUSIVE. La differenza non e' un inasprimento gratuito: il controllo 7 vieta DUE
  // SCRITTORI (PostgreSQL autorita' mentre il legacy scrive ancora: nessun dato si perde),
  // mentre qui il percorso veloce non e' un secondo scrittore, e' una DEVIAZIONE che salta il
  // write-through. Con `sessions` primary e il percorso veloce armato, la sessione appena
  // creata resterebbe su MariaDB e non arriverebbe mai su PostgreSQL, che e' l'unico posto da
  // cui il login successivo la cerchera': l'utente non entra piu', e il login che l'ha creata
  // ha risposto OK.
  //
  // Perche' solo da primary in su. In shadow l'effetto e' che il write-through non gira per
  // login e logout e il confronto risulta divergente: e' rumore in una diagnostica, non un
  // servizio perso, e rifiutare il boot impedirebbe proprio la misura che shadow esiste per
  // fare. Il write-through lo conta a parte, cosi' la divergenza si spiega invece di essere
  // scoperta.
  //
  // LIMITE DICHIARATO, ed e' quello che rende `sessions` primary non ancora consigliabile:
  // disarmare il percorso veloce vuol dire spegnere `BACKEND_MYSQL_SPLIT_SESSIONS`, e con
  // quello spento `stripSessionsFromAppState`
  // (backend/db/app-state/mysql-sessions-split.repository.js:446-467) smette di svuotare
  // `state.sessions`: il blob dell'app-state su MariaDB torna a portare le sessioni, con i
  // `token_hash` dentro. La via d'uscita esiste ed e' asimmetrica —
  // `BACKEND_MYSQL_SPLIT_SESSIONS=1` con `BACKEND_MYSQL_SPLIT_AUDIT_EVENTS=0` disarma il
  // percorso veloce E continua a svuotare il blob — ma spegne lo split degli audit. Chiudere
  // davvero questo punto e' lavoro dell'anello di commutazione (lo strip del blob lato
  // PostgreSQL, gemello di `stripIdentityForPrimaryWrite`), che non e' in questo anello: qui
  // si rifiuta di partire invece di far credere che sia chiuso.
  const authSessionFastPath = authSessionFastPathState(env);
  if (isSessionsPrimary && authSessionFastPath.armed) {
    throw new Error(
      `${PRIMARY_ENV} contiene 'sessions' ma il percorso veloce di login e logout e' ancora ` +
        `armato (${MYSQL_SPLIT_SESSIONS_ENV}=1 e ${MYSQL_SPLIT_AUDIT_EVENTS_ENV}=1): ` +
        "writeAuthSessionFastDb scrive direttamente su MariaDB e non passa dall'hook " +
        "beforeWrite, quindi la sessione creata dal login non arriverebbe mai su PostgreSQL " +
        "e nessuno riuscirebbe piu' ad autenticarsi. Spegni uno dei due split per disarmarlo, " +
        `oppure togli 'sessions' da ${PRIMARY_ENV} e resta sul legacy.`,
    );
  }

  // Controllo C1 (MIG-042a anello 5) — per `configuration` il livello L4 non esiste, e
  // dichiararlo e' un ERRORE AL BOOT invece che un'etichetta.
  //
  // La ragione e' la stessa di D5 (REV4) che ha prodotto il controllo 7, applicata a un
  // dominio dove la verifica NON e' scrivibile. L4 promette una cosa sola e verificabile: che
  // lo scrittore legacy sia disarmato. Il controllo 7 puo' promettere quello per `identity`
  // perche' lo scrittore legacy di `users`/`userGroups` e' lo split app-state, cioe' tre
  // variabili d'ambiente che questa funzione sa leggere. Per la configurazione il secondo
  // scrittore di `posSettings.printers` e' `ensurePizzaInRivaConfiguration`
  // (backend/modules/app-state/security-migration.js:314), che reinserisce una stampante
  // cablata nel codice a ogni lettura migrante e che NESSUNA variabile d'ambiente governa: non
  // c'e' niente che il boot possa leggere per dire «e' disarmato». Un L4 che non guarda quello
  // sarebbe il gradino che non fa niente, e D5 lo ha gia' giudicato peggio di un gradino che
  // non c'e', perche' lo si crede.
  //
  // PERCHE' QUI E NON SOLO IN `configurationLevelOf`. L'anello 4 aveva gia' stabilito questo
  // rifiuto, ma poteva viverlo solo nel proprio modulo, che nessun percorso di runtime
  // costruisce: finche' `configuration` era fuori da POSTGRESQL_DOMAINS il controllo 1 lo
  // copriva per caso, perche' la riga non era nemmeno scrivibile. Con la riga qui sopra la voce
  // diventa scrivibile, e senza questo controllo `PRIMARY=configuration` piu'
  // `LEGACY_WRITE_GUARD=configuration` supererebbe il controllo 4 e il boot passerebbe. Il
  // messaggio e' UNO SOLO — `configurationLegacyWriteGuardError`, in fondo a questo file — e
  // l'anello 4 chiama quella stessa funzione: due traduzioni dello stesso rifiuto sono due
  // messaggi che divergeranno.
  //
  // Ordine: chi scrive la sola riga di L4 senza quella di L3 incontra prima il controllo 4, che
  // e' corretto e non contraddice questo. E' la stessa sequenza che `identity` ha con il
  // controllo 7, non un'asimmetria introdotta qui.
  if (legacyWriteGuardDomains.has(CONFIGURATION_DOMAIN)) {
    throw configurationLegacyWriteGuardError();
  }

  return Object.freeze({
    enabled,
    shadowDomains: Object.freeze(Array.from(shadowDomains)),
    primaryDomains: Object.freeze(Array.from(primaryDomains)),
    legacyWriteGuardDomains: Object.freeze(Array.from(legacyWriteGuardDomains)),
    identityLevel,
    isIdentityShadow: identityLevel === "shadow",
    isIdentityPrimary,
    // Vero solo quando il controllo 7 e' stato eseguito ED e' passato: da qui in giu' lo
    // scrittore legacy di `users`/`userGroups` e' spento, non «si spera spento».
    isIdentityLegacyWriteGuard: identityLevel === "exclusive",
    // MIG-041 — lo stesso insieme di campi per il dominio `sessions`, cosi' che store e
    // write-through leggano `mode` allo stesso modo dei loro gemelli identity.
    sessionsLevel,
    isSessionsShadow: sessionsLevel === "shadow",
    isSessionsPrimary,
    isSessionsLegacyWriteGuard: sessionsLevel === "exclusive",
    // Lo stato che ha superato il controllo S2: da primary in su il percorso veloce e'
    // disarmato, e in shadow questo campo dice al write-through perche' il confronto puo'
    // risultare divergente su login e logout.
    authSessionFastPath: Object.freeze({ ...authSessionFastPath }),
    snapshotTtlMs,
    shadowIntervalMs,
    maxStalenessMs,
  });
}

/** Vero quando il dominio identity è almeno a shadow: è la soglia da cui lo store esiste. */
export function isIdentityStoreRequired(mode) {
  return Boolean(mode?.enabled) && mode?.identityLevel !== "off";
}

/** Gemello del precedente per `sessions`: la soglia da cui lo store delle sessioni esiste. */
export function isSessionsStoreRequired(mode) {
  return Boolean(mode?.enabled) && mode?.sessionsLevel !== "off";
}

// ---------------------------------------------------------------------------
// MIG-042a — il dominio `configuration`
//
// PERCHE' QUESTA SEZIONE STA IN FONDO E NON ACCANTO A POSTGRESQL_DOMAINS. Sette file citano
// righe precise di questo modulo con la forma `percorso:riga`, e il gate D7
// (scripts/postgresql-migration/mig040-code-references.mjs) esiste perche' quelle citazioni
// invecchiano in silenzio quando un file cresce dall'alto. Due delle sette stanno in file di
// MIG-041 che questo anello non deve toccare. Aggiungere qui sotto invece che in mezzo tiene
// tutte e sette esatte senza modificare un solo file altrui: e' la stessa ragione per cui il
// controllo C1 sta in coda a `normalizeIdentityMode` invece che accanto al controllo 4.
//
// QUALI CONTROLLI VALGONO SU `configuration`, uno per uno, e perche'.
//
//   0  alias `BACKEND_POSTGRES_DOMAIN_MODE`     VALE, senza una riga nuova. Non guarda il
//      dominio: guarda se la variabile e' presente. Non c'e' niente di specifico da aggiungere.
//
//   1  dominio fuori dall'elenco ammesso        VALE, ed e' il controllo che questa modifica
//      cambia: `configuration` entra in POSTGRESQL_DOMAINS, quindi smette di essere un errore e
//      l'elenco stampato dai messaggi diventa «identity, sessions, configuration».
//
//   2  lista non vuota senza ENABLED            VALE, senza una riga nuova: guarda la
//      DIMENSIONE delle tre liste, non il loro contenuto. `BACKEND_POSTGRES_SHADOW_DOMAINS=
//      configuration` senza `BACKEND_POSTGRES_ENABLED=1` non accende lo store: rifiuta l'avvio,
//      esattamente come per gli altri due domini. E' l'invariante «non si commuta un dominio con
//      il runtime PostgreSQL spento», e vale a maggior ragione qui, perche' lo store di questa
//      fetta rifiuta di dirsi `ok` con stampanti, dispositivi fiscali o postazioni a zero: senza
//      pool aperto non potrebbe nemmeno misurarlo.
//
//   3  stesso dominio in SHADOW e in PRIMARY    VALE, senza una riga nuova: il ciclo scorre
//      `primaryDomains` e chiede a `shadowDomains`, senza nominare nessun dominio. La ragione
//      per cui deve valere anche qui e' la stessa di D31 e non e' simmetria: in primary
//      l'app-state non e' piu' aggiornato, quindi non esiste un legacy con cui confrontarsi, e
//      il write-through di questa fetta userebbe la regola di fatalita' sbagliata — in shadow
//      registra e prosegue, da primary in su rilancia. Le due cose insieme non sono uno stato
//      da gestire.
//
//   4  LEGACY_WRITE_GUARD su un dominio non primary   VALE, senza una riga nuova, ed e' il
//      primo dei due muri davanti a L4 per questo dominio. Il secondo e' C1.
//
//   5  conflitto di source of truth con BACKEND_RELATIONAL_PRIMARY_DOMAINS (D39 R1)
//      NON VALE, e l'assenza e' misurata, non dimenticata. Il conflitto non e' esprimibile:
//      `parsePersistenceDomainList` (backend/db/persistence-mode.js:40-59) rifiuta qualunque
//      valore fuori da RELATIONAL_DOMAINS, e ne' `configuration` ne' `posSettings` ci sono
//      dentro. Il dominio relazionale piu' vicino e' `menuSettings`, che `posSettings` alimenta
//      davvero, ma le righe che possiede sono menu_categories, menu_items, menu_item_variants,
//      payment_methods, pos_rooms e pos_tables (backend/db/relational/equivalence.js:758-765):
//      nessuna delle CINQUE chiavi della fetta A. Non c'e' una riga su cui i due motori possano
//      dirsi entrambi la verita', e un controllo per uno stato irraggiungibile sarebbe la flag
//      che non fa niente. LIMITE DICHIARATO: la fetta B/C porta `rooms`, `tables` e
//      `paymentMethods` dentro questo dominio, e quelle SONO righe di `menuSettings`. Il giorno
//      in cui una di loro entra, il gemello del controllo 5 va scritto, su `menuSettings` e su
//      `tablesBills`.
//
//   6  parametri numerici e i loro limiti       VALE, senza una riga nuova, ma con un limite da
//      dire: `snapshotTtlMs` e `maxStalenessMs` governano ANCHE lo store della configurazione, e
//      le variabili che li portano si chiamano `BACKEND_POSTGRES_IDENTITY_SNAPSHOT_TTL_MS` e
//      `BACKEND_POSTGRES_IDENTITY_MAX_STALENESS_MS`. Il nome dice `IDENTITY` e il valore vale per
//      tre domini. Rinominarle e' una decisione dell'anello di cablaggio, non di questo: farlo
//      qui cambierebbe il significato di un file d'ambiente gia' scritto senza che nessuno se ne
//      accorga, che e' il difetto che D31 e' stata scritta per impedire.
//
//   7  lo scrittore legacy di identity ancora armato a L4    NON VALE, e non e' pigrizia: per
//      questo dominio L4 non esiste affatto. Vedi C1 e `configurationLegacyWriteGuardError`.
//
//   8  il MEZZO PASSO su BACKEND_MYSQL_APP_STATE_DOMAINS     NON VALE OGGI, e va detto perche'
//      il materiale c'e': `posSettings` E' fra i domini di default dello split app-state
//      (backend/server.js:794-826), quindi togliere quella voce produrrebbe lo stesso
//      congelamento che il controllo 8 vieta per `users`. Cio' che manca e' la COPPIA: per
//      `identity` il controllo 8 esiste perche' D31 punto 5 obbliga a togliere `users,userGroups`
//      dallo split QUANDO si passa a L3, e le due righe si muovono insieme. Per `configuration`
//      quella coppia non e' stata decisa da nessuno — l'anello 3 dichiara di NON avere un gemello
//      di `stripIdentityForPrimaryWrite` e di lasciare `posSettings` nel blob apposta, perche' un
//      rientro deve ritrovare le stampanti. Scrivere il controllo 8 adesso vorrebbe dire
//      rifiutare l'avvio indicando una via d'uscita che non esiste ancora. Va scritto insieme
//      allo strip, nell'anello di commutazione, e non prima.
//
//   S1 conflitto di source of truth su `sessions`   NON VALE: e' il controllo 5 su un altro
//      dominio, e vale per `configuration` la stessa misura fatta al punto 5.
//
//   S2 il percorso veloce di login e logout    NON VALE per la fetta A, e anche questo e'
//      misurato. I percorsi che scrivono `posSettings` su MariaDB saltando `writeDb` — quindi
//      saltando l'hook `beforeWrite` e il write-through — passano tutti da
//      `syncPosSettingsTablesFastPath` (backend/server.js:16943), che sincronizza `tables` e
//      nient'altro. `tables` non e' una delle cinque chiavi di questa fetta. LIMITE DICHIARATO,
//      identico a quello del punto 5: il giorno in cui `tables` entra nel dominio, il gemello di
//      S2 diventa obbligatorio prima di qualunque `configuration` in primary.
//
//   C1 il livello exclusive                    NUOVO, ed e' l'unica riga di controllo che
//      questo anello aggiunge. Sta in coda a `normalizeIdentityMode`.
// ---------------------------------------------------------------------------

/**
 * Il nome del dominio nelle tre liste di D31. Vive QUI, accanto a POSTGRESQL_DOMAINS, e non
 * nello store: e' la chiave con cui lo store cerca dentro `mode.shadowDomains` e
 * `mode.primaryDomains`, quindi due definizioni che divergessero non darebbero un errore ma un
 * SILENZIO — il livello risponderebbe sempre "off" e nessuno saprebbe perche'.
 *
 * Che questa costante e la voce dentro POSTGRESQL_DOMAINS restino la stessa stringa non e'
 * affidato alla lettura: lo misura una prova di comportamento in
 * backend/tests/postgresql-configuration-integration.test.mjs.
 */
export const CONFIGURATION_DOMAIN = "configuration";

/**
 * Il rifiuto di L4 per questo dominio, in UNA funzione e con UN messaggio.
 *
 * Lo chiamano due posti e non ne esiste un terzo: il controllo C1 di `normalizeIdentityMode`,
 * che lo fa scattare al boot su qualunque ambiente, e `configurationLevelOf`
 * (backend/db/postgresql/configuration-store.js), che lo fa scattare anche su un `mode`
 * costruito a mano — cioe' nella forma in cui i test e un eventuale chiamante futuro possono
 * ancora arrivarci senza passare dall'ambiente. Il messaggio e' uno solo perche' l'operatore
 * che lo incontra da un lato o dall'altro deve leggere la stessa cosa e fare la stessa cosa.
 *
 * Il fatto che il messaggio nomina: `ensurePizzaInRivaConfiguration`
 * (backend/modules/app-state/security-migration.js:314) reinserisce una stampante cablata nel
 * codice a ogni lettura migrante. Non e' governato da nessuna variabile d'ambiente, quindi non
 * esiste una configurazione che il boot possa leggere per dire che il legacy e' disarmato — che
 * e' l'unica cosa che L4 promette.
 */
export function configurationLegacyWriteGuardError() {
  return new Error(
    `${LEGACY_WRITE_GUARD_ENV} contiene '${CONFIGURATION_DOMAIN}', ma per questo dominio il `
    + "livello exclusive non e' implementato: il secondo scrittore di posSettings.printers e' "
    + "ensurePizzaInRivaConfiguration, che nessuna variabile d'ambiente governa, quindi non c'e' "
    + `niente che il boot possa verificare. Togli la riga e resta a primary con ${PRIMARY_ENV}.`,
  );
}
