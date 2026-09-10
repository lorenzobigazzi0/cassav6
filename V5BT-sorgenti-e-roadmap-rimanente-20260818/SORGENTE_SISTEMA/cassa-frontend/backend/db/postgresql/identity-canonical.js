// MIG-040 — canonicalJson, mask, row_hash e la trasformazione record -> riga.
//
// QUARTO ANELLO, prima parte. Questo file non contiene SQL e non apre connessioni:
// trasforma record app-state in righe e calcola l'impronta con cui il repository decide
// se un UPDATE ha davvero qualcosa da scrivere.
//
// §6.2 C3 — «canonicalJson vive in UN SOLO file ed e' importata da repository, store,
// comparatore shadow e importer». Questo e' quel file. Se ce ne fossero due, shadow e
// import potrebbero dichiarare «uguale» e «diverso» sugli stessi dati, cioe' il confronto
// misurerebbe le due implementazioni invece dei dati.
//
// §6.2 C1 — canonicalJson ORDINA le chiavi, ricorsivamente; gli array conservano il loro
// ordine, perche' l'ordine dentro un array E' contenuto (§6.1). Senza l'ordinamento il
// confronto per record fallirebbe sul PRIMO utente reale: `ensurePizzaInRivaConfiguration`
// costruisce il suo utente come literal (backend/server.js:4785-4804) con un ordine di
// chiavi diverso da quello di `buildNextUser` (users-save-write-model.js:200-235), a dato
// identico.
//
// §6.2 C4 — in ogni confronto e IN OGNI HASH il valore di `pinHash` e' sostituito dal
// fingerprint. Il valore reale non entra mai in un hash condiviso, in un report o in un
// log. `mask` sostituisce il VALORE e conserva il NOME della chiave: e' la lettura del
// COMMENT ON COLUMN identity.users.row_hash della 010 («pinHash sostituito dal
// fingerprint»), e conserva la distinzione a tre valori di §4.6 sulla chiave stessa.
//
// La riga prodotta qui e' l'INGRESSO del repository: `identity.repository.js` la
// ri-valida per intero (id, username, ruolo, forma del pinHash, forma del row_hash,
// timestamp) e nessuna delle sue regole viene aggirata passando da qui.

import { createHash } from "node:crypto";

import { identityPinFingerprint, normalizeIdentityUsername } from "./identity.repository.js";

// Le sole chiavi del record utente che diventano colonne. Tutto il resto vive in
// `profile`, lossless (§5.1 campo 33: nessun campo sconosciuto viene scartato).
export const IDENTITY_USER_PROMOTED_KEYS = Object.freeze([
  "id",
  "username",
  "fullName",
  "role",
  "pinHash",
  "createdAt",
  "updatedAt",
]);

// Per i gruppi le colonne promosse sono tre. `createdAt`/`updatedAt` NON sono promosse:
// i gruppi non hanno timestamp nell'app-state (§4.3) e quelli delle colonne sono valori
// NUOVI, fuori dal round-trip (§6.4 punto 2). Se un record di gruppo ne portasse comunque
// uno, resta in `profile` e torna fuori identico invece di sparire.
export const IDENTITY_GROUP_PROMOTED_KEYS = Object.freeze(["id", "name", "active"]);

const USER_PROMOTED = new Set(IDENTITY_USER_PROMOTED_KEYS);
const GROUP_PROMOTED = new Set(IDENTITY_GROUP_PROMOTED_KEYS);

const DEFAULT_ROLE = "operator";

function canonicalError(message, details = null) {
  const error = new TypeError(message);
  error.code = "IDENTITY_CANONICAL_INVALID_INPUT";
  if (details) error.details = details;
  return error;
}

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

// `undefined` come valore di una chiave si comporta come in JSON.stringify: la chiave
// sparisce. E' la sola coercizione ammessa, ed e' quella che il `jsonb` applicherebbe
// comunque al passaggio; ogni altro caso fuori da JSON e' un errore rumoroso.
const OMITTED = Symbol("omitted");

function encode(value, seen, path) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") {
    // Come JSON.stringify: NaN e Infinity diventano null. Non si inventa un valore.
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (type === "undefined" || type === "function" || type === "symbol") return OMITTED;
  if (type === "bigint") {
    throw canonicalError(`Valore BigInt non rappresentabile in JSON (${path}).`);
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw canonicalError(`Date non valida (${path}).`);
    return JSON.stringify(value.toISOString());
  }
  if (seen.has(value)) throw canonicalError(`Ciclo nel record (${path}).`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // L'ordine degli elementi E' contenuto e si conserva (§6.1).
      const parts = value.map((entry, index) => {
        const encoded = encode(entry, seen, `${path}[${index}]`);
        return encoded === OMITTED ? "null" : encoded;
      });
      return `[${parts.join(",")}]`;
    }
    if (typeof value.toJSON === "function") {
      return encode(value.toJSON(path), seen, path);
    }
    // C1: chiavi in ordine lessicografico. `Array.prototype.sort` senza comparatore ordina
    // per unita' di codice UTF-16: e' una scelta, ed e' dichiarata qui perche' senza
    // dichiararla il confronto sarebbe indefinito.
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      const encoded = encode(value[key], seen, `${path}.${key}`);
      if (encoded === OMITTED) continue;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** §6.2 C1. Unica implementazione in casa: non se ne scrive una seconda. */
export function canonicalJson(value) {
  const encoded = encode(value, new Set(), "$");
  if (encoded === OMITTED) {
    throw canonicalError("Valore non rappresentabile in JSON.");
  }
  return encoded;
}

/**
 * §6.1 / §6.2 C4. Sostituisce il VALORE di `pinHash` con il fingerprint e lascia il nome
 * della chiave dov'era. Se la chiave non c'e', non la si aggiunge: `chiave assente` e
 * `valore vuoto` restano due stati distinti (§4.6).
 */
export function maskIdentityRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  if (!hasOwn(record, "pinHash")) return record;
  const masked = { ...record };
  masked.pinHash = identityPinFingerprint(typeof record.pinHash === "string" ? record.pinHash : "");
  return masked;
}

/**
 * `row_hash = sha256(canonicalJson(mask(record)))` — 010:21 e
 * COMMENT ON COLUMN identity.users.row_hash. Esadecimale minuscolo di 64 caratteri, la
 * forma che il CHECK identity_users_row_hash_is_sha256 impone.
 *
 * ATTENZIONE, ed e' un limite dichiarato: `app_state_position` NON entra nell'impronta,
 * perche' il COMMENT della 010 dice «del RECORD app-state canonicalizzato» e il `--verify`
 * dell'importer ricalcolera' l'hash da li'. Conseguenza: un riordino puro delle collezioni,
 * senza alcun cambio di contenuto, non aggiorna `app_state_position` — l'UPDATE del
 * repository e' filtrato da `row_hash IS DISTINCT FROM $9` e classifica `unchanged`.
 */
export function identityRowHash(record) {
  return createHash("sha256").update(canonicalJson(maskIdentityRecord(record)), "utf8").digest("hex");
}

function requiredText(value, fieldName) {
  if (value === null || value === undefined) throw canonicalError(`${fieldName} obbligatorio.`);
  const text = typeof value === "string" ? value : String(value);
  if (text.trim() === "") throw canonicalError(`${fieldName} non valido.`);
  return text;
}

// §4.5: `role` assente, vuoto o non stringa ⇒ 'operator', ed e' esattamente cio' che il
// runtime fa gia' a ogni lettura (permissions.js:110-118). Un `role` PRESENTE e fuori
// dall'insieme ammesso non si tocca: lo rifiuta il repository, rumorosamente.
function roleOf(record) {
  const role = record.role;
  if (typeof role !== "string" || role.trim() === "") return DEFAULT_ROLE;
  return role;
}

// §4.7: si copia cosi' com'e'. La guardia di forma («vuoto oppure scrypt$…») e' del
// repository, e non si duplica qui: due guardie che divergono sono peggio di una.
function pinHashOf(record) {
  const value = record.pinHash;
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

// §4.6 / COMMENT ON COLUMN identity.users.full_name: `NULL` significa «chiave assente nel
// record legacy». Un `fullName: null` esplicito e' quindi indistinguibile dall'assenza:
// e' un limite del modello a colonne, non una scelta di questo file.
function fullNameOf(record) {
  const value = record.fullName;
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

// §4.3: il timestamp si copia dal record. Qui si NORMALIZZA solo la rappresentazione in
// ISO UTC, perche' e' la forma con cui tornera' da PostgreSQL (`timestamptz` -> `Date` ->
// `isoValue`): calcolare `row_hash` sulla stringa originale farebbe divergere ogni riga con
// un offset non-Z a ogni singola scrittura, per sempre. La differenza di rappresentazione
// resta visibile al comparatore shadow, che e' il posto dove §6.4 punto 3 la vuole.
function timestampOf(value, fieldName) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw canonicalError(`${fieldName} non valido.`);
    return value.toISOString();
  }
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw canonicalError(`${fieldName} non valido.`);
  return new Date(parsed).toISOString();
}

function profileOf(record, promoted) {
  const profile = {};
  for (const [key, value] of Object.entries(record)) {
    if (promoted.has(key)) continue;
    if (value === undefined) continue;
    profile[key] = value;
  }
  return profile;
}

/**
 * Il record canonico e' quello che `rowToUser(...).record` ricostruira' dalla riga: stesso
 * INSIEME di chiavi e stessi valori. L'ordine di emissione non conta (canonicalJson ordina),
 * ma l'insieme si', perche' su quell'insieme si calcola `row_hash`. Se il record canonico
 * non coincidesse con la ricostruzione, ogni write-through vedrebbe un'impronta diversa da
 * quella memorizzata e riscriverebbe la stessa riga all'infinito, incrementando `revision`
 * a ogni giro.
 */
function canonicalUserRecord(row) {
  const record = { id: row.id, username: row.username };
  if (row.fullName !== null) record.fullName = row.fullName;
  record.role = row.role;
  for (const [key, value] of Object.entries(row.profile)) record[key] = value;
  record.pinHash = row.pinHash;
  if (row.createdAt !== null) record.createdAt = row.createdAt;
  if (row.updatedAt !== null) record.updatedAt = row.updatedAt;
  return record;
}

function canonicalUserGroupRecord(row) {
  const record = { id: row.id, name: row.name };
  for (const [key, value] of Object.entries(row.profile)) record[key] = value;
  record.active = row.active;
  return record;
}

/** §6.1: `T`. L'inverso `T⁻¹` e' `rowToUser` di identity.repository.js. */
export function identityUserToRow(record, appStatePosition = 0) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw canonicalError("record utente non valido.");
  }
  const row = {
    id: requiredText(record.id, "id"),
    username: requiredText(record.username, "username"),
    fullName: fullNameOf(record),
    role: roleOf(record),
    pinHash: pinHashOf(record),
    profile: profileOf(record, USER_PROMOTED),
    appStatePosition,
    createdAt: timestampOf(record.createdAt, "createdAt"),
    updatedAt: timestampOf(record.updatedAt, "updatedAt"),
  };
  row.usernameNormalized = normalizeIdentityUsername(row.username);
  if (row.usernameNormalized === "") throw canonicalError("username non valido.");
  row.record = canonicalUserRecord(row);
  row.rowHash = identityRowHash(row.record);
  // `revision` resta `null`: il write-through non conosce la revisione di PostgreSQL e non
  // deve indovinarla. Il repository usa allora quella letta nella stessa transazione, cioe'
  // il lock ottimistico degenera in «l'app-state e' la verita'» — che in shadow e' esatto,
  // perche' l'autorita' e' MySQL. `revision` non entra MAI nella SET (§9.3).
  row.revision = null;
  return row;
}

export function identityUserGroupToRow(record, appStatePosition = 0) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw canonicalError("record gruppo non valido.");
  }
  const row = {
    id: requiredText(record.id, "id"),
    name: requiredText(record.name, "name"),
    // §4.5: `active` assente ⇒ true, la stessa regola di users.service.js:98.
    active: record.active !== false,
    profile: profileOf(record, GROUP_PROMOTED),
    appStatePosition,
    createdAt: timestampOf(record.createdAt, "createdAt"),
    updatedAt: timestampOf(record.updatedAt, "updatedAt"),
  };
  row.record = canonicalUserGroupRecord(row);
  row.rowHash = identityRowHash(row.record);
  row.revision = null;
  return row;
}

/**
 * MIG-040 anello 6 — UN SOLO predicato per «l'app-state porta questa collezione identity?».
 *
 * Prima ce n'erano due, e rispondevano diversamente sullo stesso ingresso: qui
 * `Array.isArray`, e in `stripIdentityForPrimaryWrite` (identity-store.js) `hasOwnProperty`
 * piu' una forma del vuoto che seguiva la forma dell'originale. Con `users` in forma di
 * OGGETTO — non un array — il primo diceva «non c'e'» e ritornava `null`, cioe' «non
 * toccare la collezione su PostgreSQL», mentre il secondo diceva «c'e'» e lo svuotava dal
 * blob MariaDB. Esito: dati ne' di qua ne' di la'. E' lo stesso guasto per cui la quinta
 * guardia di `appStateSplitRequiresStrictRead` e' stata aggiunta, e la regola che ne e'
 * uscita e' «stesso predicato, non uno equivalente»: questa funzione E' quel predicato, ed
 * e' importata dai due punti invece di essere riscritta due volte.
 *
 * Perche' `Array.isArray` e non `hasOwnProperty`. Il predicato governa una CANCELLAZIONE
 * (lo strip toglie l'identity dal blob) e la cancellazione e' lecita solo per cio' che il
 * write-through ha davvero portato altrove. Da qui non esce nessuna riga per un valore che
 * non e' un array — `identityUserToRow` vuole record, e ricavarli da un oggetto sarebbe una
 * conversione inventata — quindi quel valore su PostgreSQL non arriva, e toglierlo dal blob
 * lo farebbe sparire e basta. Conseguenza dichiarata e voluta: a primary una collezione
 * identity non-array resta nel blob COM'E', `pinHash` compresi se ce ne sono. E' una forma
 * che nessun percorso di questo sistema produce (`db.users` e' sempre un array, e a primary
 * l'idratazione lo rimpiazza con quello di PostgreSQL); fra un valore anomalo che resta dov'e'
 * e un dato che sparisce da entrambe le fonti, il secondo e' il difetto piu' grave.
 */
export function appStateCarriesIdentityCollection(value) {
  return Array.isArray(value);
}

/**
 * D32, la regola che il prune non cancella per omissione, espressa gia' in ingresso:
 *
 *   dominio ASSENTE (nessun array) -> `null` -> il repository non tocca la collezione;
 *   array VUOTO                    -> `[]`   -> collezione vuota DICHIARATA, che e' un
 *                                               caso diverso e che senza intenzione
 *                                               esplicita resta comunque un merge.
 *
 * Non si converte mai l'uno nell'altro.
 */
export function identityRowsFromAppState(state) {
  const source = state && typeof state === "object" ? state : {};
  return {
    users: appStateCarriesIdentityCollection(source.users)
      ? source.users.map((entry, index) => identityUserToRow(entry, index))
      : null,
    userGroups: appStateCarriesIdentityCollection(source.userGroups)
      ? source.userGroups.map((entry, index) => identityUserGroupToRow(entry, index))
      : null,
  };
}


