// MIG-040 — identity: l'unico scrittore di identity.users e identity.user_groups.
//
// Regole non negoziabili implementate qui (MIG040_IDENTITY_SOURCE_OF_TRUTH_20260906.md):
//   * §3.1 punto 1 / §9.3 — `revision` NON compare mai nella SET: la scrive il trigger
//     identity_users_bump_revision della 010. Qui vive solo nella WHERE, come lock
//     ottimistico. 0 righe aggiornate = conflitto (409) oppure contenuto identico.
//   * §3.1 punto 1 / §4.3 — `created_at` e `updated_at` vengono DAL RECORD, mai da now():
//     con now() ogni UPDATE cambierebbe una colonna e il trigger incrementerebbe
//     `revision` anche a contenuto identico.
//   * §4.7 — `pinHash` si copia byte per byte, non si ricalcola e non compare mai in un
//     log, in un messaggio d'errore o in un valore di ritorno diagnostico. Dove serve un
//     confronto si usa `identityPinFingerprint` (§6.2 C4).
//   * §4.9 / D32 — la sync non cancella mai per omissione: il prune richiede una
//     dichiarazione esplicita (P1), un array non vuoto (P2), un amministratore superstite
//     (P3), e fallisce rumorosamente (P5). Il solo azzeramento è `allowIdentityPurge` (P4).
//   * §6.2 C5 — un solo contratto, `domain: "identity"`: il regex di
//     backend/core/repository-contract.js:44 non ammette l'underscore.
//
// Il record app-state NON viene ricostruito altrove: `rowToUser`/`rowToUserGroup` sono qui,
// e applicano la distinzione a tre valori di §4.6 (chiave assente ≠ valore vuoto).
// `canonicalJson` e il calcolo di `row_hash` restano fuori (§6.2 C3, una sola
// implementazione in identity-canonical.js): il repository li riceve già calcolati e ne
// verifica soltanto la FORMA, come fa lo schema.

import { createHash } from "node:crypto";

import {
  assertRepositoryImplementation,
  defineRepositoryContract,
} from "../../core/repository-contract.js";

const IDENTITY_DOMAINS = Object.freeze(["users", "userGroups"]);
const ALLOWED_ROLES = new Set(["operator", "responsabile", "admin"]);
const DEFAULT_ROLE = "operator";
const PIN_HASH_PREFIX = "scrypt$";
const ROW_HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 512;

// Stessa lista del CHECK identity_users_profile_without_secrets / identity_user_groups_...
// (010:124 e :186). Il confronto è sulle chiavi di primo livello, come `?|`.
const FORBIDDEN_PROFILE_KEYS = Object.freeze([
  "pin",
  "plainPin",
  "pinCode",
  "password",
  "passwordPlain",
  "pinHash",
]);

// Ordine di emissione di buildNextUser (users-save-write-model.js:200-235). È una
// convenzione di leggibilità e di diff, non un'invariante: canonicalJson ordina le chiavi
// e rende la differenza invisibile a ogni confronto (§6.4 punto 1).
const USER_PROFILE_KEYS_BEFORE_PIN = Object.freeze([
  "roleLabel",
  "permissions",
  "extraPermissionIds",
  "groupIds",
  "workstationIds",
  "enabledAppIds",
  "allowedPaymentMethodIds",
  "waiterPauseSettings",
  "enabledRoomIds",
  "authorizedRoomIds",
  "defaultRoomId",
  "lastSelectedRoomId",
  "lastSelectedRoomName",
  "lastSelectedRoomAt",
  "lastSelectedRoomDeviceUuid",
]);
const USER_PROFILE_KEYS_AFTER_TIMESTAMPS = Object.freeze([
  "fiscalExcluded",
  "fiscalPolicy",
  "autoPaidNoFiscal",
]);
// Ordine di normalizeSettingsUserGroupDraft (users.service.js:77-100).
const GROUP_PROFILE_KEYS = Object.freeze([
  "description",
  "permissions",
  "enabledRoomIds",
  "authorizedRoomIds",
  "workstationIds",
]);

export const POSTGRESQL_IDENTITY_REPOSITORY_CONTRACT = defineRepositoryContract({
  domain: "identity",
  methods: [
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
  ],
});

// ---------------------------------------------------------------------------
// SQL. Tutto il SQL del dominio identity vive in questo file: l'audit
// audit:repository-boundary (scripts/postgresql-migration/mig022-repository-boundary.mjs)
// ammette istruzioni SQL solo sotto backend/db/**.
// ---------------------------------------------------------------------------

const USER_COLUMNS = `
  id,
  username,
  username_normalized,
  full_name,
  role,
  pin_hash,
  profile,
  app_state_position,
  row_hash,
  revision,
  created_at,
  updated_at`;

const GROUP_COLUMNS = `
  id,
  name,
  active,
  profile,
  app_state_position,
  row_hash,
  revision,
  created_at,
  updated_at`;

// L'espressione «amministratore» è UNA SOLA in tutto il sistema (§3.1 punto 5): la stessa
// del CONSTRAINT TRIGGER identity_users_require_administrator e dell'indice parziale
// identity_users_administrators_idx. Contenimento sull'oggetto intero, non su
// `profile -> 'permissions'`, che tornerebbe NULL quando la chiave manca.
const ADMINISTRATOR_PREDICATE = `role = 'admin' OR profile @> '{"permissions": ["manage_users"]}'::jsonb`;

const LIST_USERS_SQL = `
  SELECT${USER_COLUMNS}
  FROM identity.users
  ORDER BY app_state_position, id`;

const GET_USER_BY_ID_SQL = `
  SELECT${USER_COLUMNS}
  FROM identity.users
  WHERE id = $1`;

const LIST_USER_GROUPS_SQL = `
  SELECT${GROUP_COLUMNS}
  FROM identity.user_groups
  ORDER BY app_state_position, id`;

const COUNT_ADMINISTRATORS_SQL = `
  SELECT count(*) AS administrators
  FROM identity.users
  WHERE ${ADMINISTRATOR_PREDICATE}`;

// Stato minimo per la sync: id, lock ottimistico, impronta del contenuto e il flag
// amministratore calcolato dal database con l'espressione autorevole. Il `profile` non
// viene letto: non serve, e non va spostato in memoria per niente.
const USERS_SYNC_STATE_SQL = `
  SELECT
    id,
    revision,
    row_hash,
    (${ADMINISTRATOR_PREDICATE}) AS is_administrator
  FROM identity.users`;

const USER_GROUPS_SYNC_STATE_SQL = `
  SELECT
    id,
    revision,
    row_hash
  FROM identity.user_groups`;

// `revision` NON compare fra le colonne: la riga nuova prende il DEFAULT 0 della 010
// (§4.3, «l'import assegna 0»). Nessun trigger è armato sull'INSERT.
const INSERT_USER_SQL = `
  INSERT INTO identity.users (
    id,
    username,
    username_normalized,
    full_name,
    role,
    pin_hash,
    profile,
    app_state_position,
    row_hash,
    created_at,
    updated_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
  RETURNING revision`;

// L'UNICO UPDATE su identity.users di tutto il sistema.
// revision NON e' nella SET: la scrive il trigger identity_users_bump_revision
// (010). Qui vive solo il lock ottimistico, con la forma di
// 05_DATA_MODEL_AND_TRANSACTIONS.md:28-38 meno il "+1".
// updated_at viene DAL RECORD, mai da now(): con now() ogni UPDATE cambierebbe
// una colonna e il trigger incrementerebbe revision anche a contenuto identico.
const UPDATE_USER_SQL = `
  UPDATE identity.users
     SET username            = $2,
         username_normalized = $3,
         full_name           = $4,
         role                = $5,
         pin_hash            = $6,
         profile             = $7::jsonb,
         app_state_position  = $8,
         row_hash            = $9,
         created_at          = $10,
         updated_at          = $11
   WHERE id = $1
     AND revision = $12
     AND row_hash IS DISTINCT FROM $9
  RETURNING revision`;

const SELECT_USER_LOCK_STATE_SQL = `
  SELECT revision, row_hash
  FROM identity.users
  WHERE id = $1`;

const DELETE_USERS_SQL = `
  DELETE FROM identity.users
  WHERE id = ANY($1::text[])
  RETURNING id`;

// Il prune del write-through NON usa DELETE_USERS_SQL: usa questa, che porta la `revision`
// nella WHERE come fa gia' l'UPDATE. La ragione e' un difetto trovato da una revisione
// avversaria: senza `revision`, una riga cambiata da un altro scrittore fra la SELECT di
// stato e il DELETE spariva senza produrre nemmeno un conflitto — mentre lo stesso
// scrittore, se avesse aggiornato quella riga invece di cancellarla, avrebbe preso un 409.
// Cancellare era piu' facile che modificare, e la cancellazione e' l'operazione che non si
// annulla. Con l'isolamento della linea (READ COMMITTED, transactions.js:29) il DELETE
// rivaluta la WHERE sull'ultima versione committata: se `revision` non e' piu' quella
// letta, la riga NON viene cancellata e il chiamante se ne accorge dal conteggio.
// `revision` resta fuori dalla SET, qui non c'e' SET.
const PRUNE_USERS_SQL = `
  DELETE FROM identity.users AS target
  USING unnest($1::text[], $2::bigint[]) AS atteso(id, revision)
  WHERE target.id = atteso.id
    AND target.revision = atteso.revision
  RETURNING target.id`;

// I gruppi non hanno timestamp nell'app-state (§4.3): created_at/updated_at sono valori
// NUOVI e la colonna è NOT NULL DEFAULT now(). Quando il chiamante non li porta si usa
// now() *solo* qui, all'inserimento, esattamente come farebbe il DEFAULT della 010.
const INSERT_USER_GROUP_SQL = `
  INSERT INTO identity.user_groups (
    id,
    name,
    active,
    profile,
    app_state_position,
    row_hash,
    created_at,
    updated_at
  ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, COALESCE($7::timestamptz, now()), COALESCE($8::timestamptz, now()))
  RETURNING revision`;

// Come per gli utenti: revision solo nella WHERE. Nella SET i due timestamp usano
// COALESCE(…, colonna) e MAI now(): un now() qui farebbe scattare il trigger di revisione
// a ogni write-through, anche a contenuto identico.
const UPDATE_USER_GROUP_SQL = `
  UPDATE identity.user_groups
     SET name               = $2,
         active             = $3,
         profile            = $4::jsonb,
         app_state_position = $5,
         row_hash           = $6,
         created_at         = COALESCE($7::timestamptz, created_at),
         updated_at         = COALESCE($8::timestamptz, updated_at)
   WHERE id = $1
     AND revision = $9
     AND row_hash IS DISTINCT FROM $6
  RETURNING revision`;

const SELECT_USER_GROUP_LOCK_STATE_SQL = `
  SELECT revision, row_hash
  FROM identity.user_groups
  WHERE id = $1`;

const DELETE_USER_GROUPS_SQL = `
  DELETE FROM identity.user_groups
  WHERE id = ANY($1::text[])
  RETURNING id`;

// Gemella di PRUNE_USERS_SQL, e su questa tabella conta di piu': `identity.user_groups` non
// ha il CONSTRAINT TRIGGER della 010 (che e' solo su `identity.users`, 010:279-283) e non
// ha una guardia P3 (che parla di amministratori, cioe' di utenti). Il lock ottimistico per
// riga e' l'unica protezione che si puo' aggiungere qui senza rendere impossibile il caso
// legittimo, che e' l'operatore che cancella l'ultimo gruppo.
const PRUNE_USER_GROUPS_SQL = `
  DELETE FROM identity.user_groups AS target
  USING unnest($1::text[], $2::bigint[]) AS atteso(id, revision)
  WHERE target.id = atteso.id
    AND target.revision = atteso.revision
  RETURNING target.id`;

// ---------------------------------------------------------------------------
// Errori
// ---------------------------------------------------------------------------

function validationError(message, details = null) {
  const error = new TypeError(message);
  error.code = "POSTGRES_IDENTITY_INVALID_INPUT";
  if (details) error.details = details;
  return error;
}

function codedError(code, message, details = null) {
  const error = new TypeError(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

// 0 righe aggiornate con contenuto diverso = qualcun altro ha scritto: 409, non un errore
// generico (§3.1 punto 1, COMMENT ON COLUMN identity.users.revision).
function revisionConflictError(table, id, expectedRevision, actualRevision) {
  const error = new Error(`Conflitto di revisione su ${table}.`);
  error.code = "IDENTITY_REVISION_CONFLICT";
  error.status = 409;
  error.details = { id, expectedRevision, actualRevision };
  return error;
}

function pruneError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

// ---------------------------------------------------------------------------
// Normalizzazione dell'input
// ---------------------------------------------------------------------------

// backend/server.js:3347-3351, identica a auth.repository.js:14-17. È la sola
// normalizzazione autorevole: lo schema NON la ricalcola (D38.2).
export function normalizeIdentityUsername(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

// §6.2 C4. Stringa vuota ⇒ "", non l'hash della stringa vuota, così `users_without_pin`
// resta distinguibile. È il solo valore derivato dal pinHash che può comparire in un
// confronto, in un report o in un log.
export function identityPinFingerprint(pinHash) {
  const value = typeof pinHash === "string" ? pinHash : "";
  if (value === "") return "";
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;
}

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

// Testo conservato VERBATIM: non si trimma né si normalizza, perché il record legacy è la
// verità e `row_hash` è stato calcolato su quel valore. Si verifica solo ciò che verifica
// lo schema: btrim(valore) <> ''.
function verbatimText(value, fieldName, maxLength = MAX_TEXT_LENGTH) {
  if (value === null || value === undefined) {
    throw validationError(`${fieldName} obbligatorio.`);
  }
  const text = typeof value === "string" ? value : String(value);
  if (text.trim() === "") throw validationError(`${fieldName} non valido.`);
  if (text.length > maxLength) throw validationError(`${fieldName} supera ${maxLength} caratteri.`);
  return text;
}

function optionalVerbatimText(value, fieldName, maxLength = MAX_TEXT_LENGTH) {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : String(value);
  if (text.length > maxLength) throw validationError(`${fieldName} supera ${maxLength} caratteri.`);
  return text;
}

function nonNegativeInteger(value, fieldName, fallback) {
  if (value === null || value === undefined) {
    if (fallback === undefined) throw validationError(`${fieldName} obbligatorio.`);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw validationError(`${fieldName} deve essere un intero non negativo.`);
  }
  return parsed;
}

// §4.3: i timestamp si copiano verbatim dal record. Un valore presente ma non parsabile
// NON diventa un now() silenzioso e non diventa NULL qui: è l'importer che lo classifica
// e lo conta (`unparsable_timestamps`). Sul percorso di scrittura è un errore rumoroso.
function recordTimestamp(value, fieldName) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw validationError(`${fieldName} non valido.`);
    return value.toISOString();
  }
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw validationError(`${fieldName} non valido.`);
  return new Date(parsed).toISOString();
}

function isoValue(value) {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? null : String(value);
}

function integerValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function parseJsonObject(value, fieldName) {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw validationError(`${fieldName} non è JSON valido.`);
    }
  }
  if (candidate === null || candidate === undefined) return {};
  if (typeof candidate !== "object" || Array.isArray(candidate)) {
    throw validationError(`${fieldName} deve essere un oggetto JSON.`);
  }
  return candidate;
}

function assertProfileWithoutSecrets(profile, id) {
  for (const key of FORBIDDEN_PROFILE_KEYS) {
    if (hasOwn(profile, key)) {
      // Il nome della chiave sì, il valore mai (§4.7 punto 3).
      throw codedError(
        "IDENTITY_PROFILE_CONTAINS_SECRET",
        `profile contiene la chiave vietata "${key}".`,
        { id, key },
      );
    }
  }
}

// Accetta sia `profileJson` (stringa già serializzata dal chiamante, forma di §9.3) sia
// `profile` (oggetto). Ritorna la stringa da passare a $n::jsonb.
function normalizeProfile(input, id) {
  const source = typeof input.profileJson === "string" ? input.profileJson : input.profile;
  const profile = parseJsonObject(source, "profile");
  assertProfileWithoutSecrets(profile, id);
  let serialized;
  try {
    serialized = JSON.stringify(profile);
  } catch {
    throw validationError("profile non serializzabile in JSON.");
  }
  if (typeof serialized !== "string") throw validationError("profile non serializzabile in JSON.");
  return { profile, profileJson: serialized };
}

function normalizeRowHash(value) {
  const text = String(value ?? "").trim();
  if (!ROW_HASH_PATTERN.test(text)) {
    // row_hash è il perno del write-through incrementale: un segnaposto farebbe saltare
    // ogni UPDATE e congelerebbe `revision` per sempre, senza alcun errore (010:126-129).
    throw validationError("rowHash deve essere uno sha256 esadecimale minuscolo di 64 caratteri.");
  }
  return text;
}

function normalizeRole(value, id) {
  if (value === null || value === undefined) return DEFAULT_ROLE;
  if (typeof value !== "string" || value.trim() === "") return DEFAULT_ROLE;
  if (!ALLOWED_ROLES.has(value)) {
    // §4.5: un role presente e non ammesso è errore duro. Non si applica
    // normalizeUserRole, che lo coercerebbe a "operator" cambiando le autorizzazioni.
    throw codedError("IDENTITY_ROLE_NOT_ALLOWED", `role non ammesso: ${value}.`, { id, role: value });
  }
  return value;
}

// §4.7 punto 1: il valore non compare mai nell'errore, solo l'id. Non si trasforma un PIN
// trovato in chiaro in un hash: significherebbe cambiare una credenziale senza dirlo.
function normalizePinHash(value, id) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw codedError("IDENTITY_PIN_HASH_OUT_OF_CONTRACT", "pinHash fuori contratto.", { id });
  }
  if (value === "") return "";
  if (!value.startsWith(PIN_HASH_PREFIX)) {
    throw codedError(
      "IDENTITY_PIN_HASH_OUT_OF_CONTRACT",
      `pinHash fuori contratto per l'utente ${id}: atteso vuoto oppure "${PIN_HASH_PREFIX}…".`,
      { id },
    );
  }
  return value;
}

function normalizeUsernameNormalized(input, username, id) {
  const computed = normalizeIdentityUsername(username);
  if (computed === "") throw validationError("usernameNormalized non può essere vuoto.");
  const provided = input.usernameNormalized;
  if (provided !== null && provided !== undefined && String(provided) !== "" && String(provided) !== computed) {
    // Il repository calcola la chiave di login (§5.1 campo 3): se il chiamante ne porta
    // una diversa è drift di normalizzazione, e persisterlo produce un utente che passa i
    // CHECK e non entra mai in cassa. Rumoroso, non silenzioso.
    throw codedError(
      "IDENTITY_USERNAME_NORMALIZATION_DRIFT",
      `usernameNormalized non coincide con normalizeUsername(username) per l'utente ${id}.`,
      { id },
    );
  }
  return computed;
}

function normalizeUserRow(input, fallbackPosition = 0) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw validationError("record utente non valido.");
  }
  const id = verbatimText(input.id, "id", MAX_ID_LENGTH);
  const username = verbatimText(input.username, "username");
  const usernameNormalized = normalizeUsernameNormalized(input, username, id);
  const { profile, profileJson } = normalizeProfile(input, id);
  return {
    id,
    username,
    usernameNormalized,
    fullName: optionalVerbatimText(input.fullName, "fullName"),
    role: normalizeRole(input.role, id),
    pinHash: normalizePinHash(input.pinHash, id),
    profile,
    profileJson,
    appStatePosition: nonNegativeInteger(input.appStatePosition, "appStatePosition", fallbackPosition),
    rowHash: normalizeRowHash(input.rowHash),
    createdAt: recordTimestamp(input.createdAt, "createdAt"),
    updatedAt: recordTimestamp(input.updatedAt, "updatedAt"),
    revision: input.revision === null || input.revision === undefined
      ? null
      : nonNegativeInteger(input.revision, "revision"),
  };
}

function normalizeUserGroupRow(input, fallbackPosition = 0) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw validationError("record gruppo non valido.");
  }
  const id = verbatimText(input.id, "id", MAX_ID_LENGTH);
  const name = verbatimText(input.name, "name");
  const { profile, profileJson } = normalizeProfile(input, id);
  if (hasOwn(profile, "description")) {
    // Gemello in codice del CHECK identity_user_groups_description_bounded (§3.1 punto 3):
    // il rifiuto è una riga di report prima di essere un SQLSTATE a sorpresa.
    const description = profile.description;
    if (typeof description !== "string" || [...description].length > 240) {
      throw codedError(
        "IDENTITY_GROUP_DESCRIPTION_OUT_OF_CONTRACT",
        `profile.description fuori contratto per il gruppo ${id}: attesa una stringa di al più 240 caratteri.`,
        { id },
      );
    }
  }
  return {
    id,
    name,
    active: input.active !== false,
    profile,
    profileJson,
    appStatePosition: nonNegativeInteger(input.appStatePosition, "appStatePosition", fallbackPosition),
    rowHash: normalizeRowHash(input.rowHash),
    createdAt: recordTimestamp(input.createdAt, "createdAt"),
    updatedAt: recordTimestamp(input.updatedAt, "updatedAt"),
    revision: input.revision === null || input.revision === undefined
      ? null
      : nonNegativeInteger(input.revision, "revision"),
  };
}

function normalizeIdList(value, fieldName) {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const ids = [];
  const seen = new Set();
  for (const entry of list) {
    const id = verbatimText(entry, fieldName, MAX_ID_LENGTH);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Mapping riga -> oggetto (§4.6, §5.1, §5.2)
// ---------------------------------------------------------------------------

function deepCopyJson(value) {
  return value === null || value === undefined ? {} : JSON.parse(JSON.stringify(value));
}

// §4.6: chiave assente ≠ valore vuoto. Ciò che nel legacy non c'era non torna fuori.
function buildUserRecord(row, profile) {
  const record = {};
  record.id = row.id;
  record.username = row.username;
  if (row.full_name !== null && row.full_name !== undefined) record.fullName = row.full_name;
  record.role = row.role;
  for (const key of USER_PROFILE_KEYS_BEFORE_PIN) {
    if (hasOwn(profile, key)) record[key] = profile[key];
  }
  record.pinHash = row.pin_hash ?? "";
  if (row.created_at !== null && row.created_at !== undefined) record.createdAt = isoValue(row.created_at);
  if (row.updated_at !== null && row.updated_at !== undefined) record.updatedAt = isoValue(row.updated_at);
  for (const key of USER_PROFILE_KEYS_AFTER_TIMESTAMPS) {
    if (hasOwn(profile, key)) record[key] = profile[key];
  }
  // Catch-all lossless (§5.1 campo 33): nessun campo sconosciuto viene scartato.
  for (const [key, value] of Object.entries(profile)) {
    if (!hasOwn(record, key)) record[key] = value;
  }
  return record;
}

export function rowToUser(row) {
  if (!row) return null;
  const profile = parseJsonObject(row.profile, "profile");
  return {
    id: row.id,
    username: row.username,
    usernameNormalized: row.username_normalized,
    fullName: row.full_name ?? null,
    role: row.role,
    // Valore reale, necessario a verifyPin: è il dato, non una diagnostica.
    pinHash: row.pin_hash ?? "",
    // Il solo derivato che può comparire in un confronto o in un report (§6.2 C4).
    pinFingerprint: identityPinFingerprint(row.pin_hash ?? ""),
    profile: deepCopyJson(profile),
    appStatePosition: integerValue(row.app_state_position),
    rowHash: row.row_hash,
    revision: integerValue(row.revision),
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at),
    record: buildUserRecord(row, deepCopyJson(profile)),
  };
}

function buildUserGroupRecord(row, profile) {
  const record = {};
  record.id = row.id;
  record.name = row.name;
  for (const key of GROUP_PROFILE_KEYS) {
    if (hasOwn(profile, key)) record[key] = profile[key];
  }
  record.active = row.active === true;
  for (const [key, value] of Object.entries(profile)) {
    if (!hasOwn(record, key)) record[key] = value;
  }
  // created_at/updated_at dei gruppi sono valori NUOVI e NON rientrano nel round-trip
  // (§4.3, §6.4 punto 2): non entrano nel record app-state.
  return record;
}

export function rowToUserGroup(row) {
  if (!row) return null;
  const profile = parseJsonObject(row.profile, "profile");
  return {
    id: row.id,
    name: row.name,
    active: row.active === true,
    profile: deepCopyJson(profile),
    appStatePosition: integerValue(row.app_state_position),
    rowHash: row.row_hash,
    revision: integerValue(row.revision),
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at),
    record: buildUserGroupRecord(row, deepCopyJson(profile)),
  };
}

// ---------------------------------------------------------------------------
// Regola di amministratore (§3.1 punto 5, §4.9 P3)
// ---------------------------------------------------------------------------

// Stessa definizione, in JavaScript, del predicato SQL: role 'admin' OPPURE 'manage_users'
// letteralmente presente nell'ARRAY profile.permissions. Un `permissions` non-array è
// ignorato da entrambi i lati (§3.1 punto 5, residuo dichiarato).
export function isAdministratorProfile(role, profile) {
  if (role === "admin") return true;
  const permissions = profile && typeof profile === "object" ? profile.permissions : null;
  return Array.isArray(permissions) && permissions.includes("manage_users");
}

// ---------------------------------------------------------------------------
// Prune (§4.9 P1-P5, D32)
// ---------------------------------------------------------------------------

function declaredDomains(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter((entry) => entry !== "");
}

// P1 — l'intenzione arriva da due sorgenti e mai da una terza: gli hint della writeDb
// (normalizeSplitDomainHints ritorna null se l'array è assente o vuoto) oppure
// options.identityReplace. Ogni altro caso è merge senza cancellazione.
// D41 — `splitDomains` NON arma piu' il prune, e la ragione e' che non lo ha mai
// significato. `splitDomains` e' un suggerimento su DOVE persistere un dominio (quali
// tabelle sincronizzare in MariaDB); `identityReplace` e' la dichiarazione di CHI possiede
// la collezione e la sta sostituendo per intero. Sono due cose diverse, e confonderle
// significava che `auth.login` (login-write-model.js:210) e `auth.changePin`
// (change-pin-write-model.js:80) armavano una sostituzione integrale di `users` a ogni
// accesso, senza saperlo e senza volerlo: una riga presente in identity.users ma non
// nell'app-state — per esempio aggiunta a mano da psql, che §4.8 indica come la procedura
// di riparazione — sarebbe stata cancellata dal primo login successivo, in silenzio.
// Il prune, all'epoca, non aveva nemmeno un lock ottimistico (DELETE_USERS_SQL non ha
// `revision` nella WHERE), quindi quella cancellazione non produceva nemmeno un conflitto.
// Adesso il prune usa PRUNE_USERS_SQL / PRUNE_USER_GROUPS_SQL, che la `revision` nella
// WHERE ce l'hanno: e' un lock per RIGA e copre la finestra fra la SELECT di stato e il
// DELETE, non la finestra fra la lettura del CLIENT e la sua scrittura. Quella seconda
// finestra e' il difetto A del 07/09 e si chiude solo dove il client puo' dichiarare su
// quale versione ha lavorato: `expectedVersion` di `users.save`
// (users-save-write-model.js). Le due protezioni non si sostituiscono a vicenda.
export function hasIdentityPruneIntent(domain, options = {}) {
  if (!IDENTITY_DOMAINS.includes(domain)) return false;
  return declaredDomains(options.identityReplace).includes(domain);
}

// D32 punto (f) — i motivi per cui una sincronizzazione NON ha cancellato, o ha cancellato
// tutto. Sono due e l'enumerazione e' chiusa: chi ne aggiunge uno lo aggiunge qui, e il
// write-through lo assorbe senza modifiche (identity-write-through.js absorbSummary cicla
// su queste due liste, non su nomi scritti a mano).
export const IDENTITY_PRUNE_SKIPPED_REASONS = Object.freeze(["noIntent", "emptyDeclared"]);

/**
 * Il contenitore dei contatori di prune. Due livelli, e nessuno dei due e' ridondante:
 *
 *   - i TOTALI (`noIntent`, `emptyDeclared`) sono la somma sui due domini, che e' la forma
 *     in cui il contatore si legge a colpo d'occhio;
 *   - la SCOMPOSIZIONE per dominio esiste perche' il totale, da solo, mente per omissione:
 *     `noIntent: 2` non dice se sono due domini saltati una volta o un dominio saltato due
 *     volte, e la sync tocca sempre entrambi nella stessa transazione. Con `users` e
 *     `userGroups` separati la domanda «chi» ha una risposta.
 */
export function createIdentityPruneSkippedCounters() {
  const counters = {};
  for (const reason of IDENTITY_PRUNE_SKIPPED_REASONS) counters[reason] = 0;
  for (const domain of IDENTITY_DOMAINS) {
    counters[domain] = {};
    for (const reason of IDENTITY_PRUNE_SKIPPED_REASONS) counters[domain][reason] = 0;
  }
  return counters;
}

// Un solo punto di incremento: il totale e la voce di dominio non possono divergere se
// nessuno li tocca separatamente.
function countPruneSkipped(summary, domain, reason) {
  const counters = summary?.identityPruneSkipped;
  if (!counters || !counters[domain]) return;
  counters[reason] += 1;
  counters[domain][reason] += 1;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

function requireRuntime(runtime) {
  if (typeof runtime?.withConnection !== "function") {
    throw validationError("runtime PostgreSQL non valido per identity.");
  }
  return runtime;
}

function requireClient(client, methodName) {
  if (typeof client?.query !== "function") {
    throw validationError(`client transazionale richiesto per ${methodName}.`);
  }
  return client;
}

function rowCountOf(result) {
  if (Number.isFinite(Number(result?.rowCount))) return Number(result.rowCount);
  return Array.isArray(result?.rows) ? result.rows.length : 0;
}

export function createPostgresqlIdentityRepository(options = {}) {
  const runtime = requireRuntime(options.runtime);

  async function applyUpdate(client, spec) {
    const result = await client.query(spec.sql, spec.parameters);
    if (rowCountOf(result) === 1) {
      return { outcome: "updated", id: spec.id, revision: integerValue(result.rows?.[0]?.revision) };
    }
    // 0 righe: o il contenuto e' identico (row_hash uguale), o qualcun altro ha scritto.
    const current = await client.query(spec.lockStateSql, [spec.id]);
    if (rowCountOf(current) === 0) return { outcome: "missing", id: spec.id, revision: null };
    const row = current.rows[0];
    if (row.row_hash === spec.rowHash) {
      return { outcome: "unchanged", id: spec.id, revision: integerValue(row.revision) };
    }
    throw revisionConflictError(spec.table, spec.id, spec.expectedRevision, integerValue(row.revision));
  }

  async function insertUserRow(client, row) {
    const result = await client.query(INSERT_USER_SQL, [
      row.id,
      row.username,
      row.usernameNormalized,
      row.fullName,
      row.role,
      row.pinHash,
      row.profileJson,
      row.appStatePosition,
      row.rowHash,
      row.createdAt,
      row.updatedAt,
    ]);
    return { outcome: "inserted", id: row.id, revision: integerValue(result.rows?.[0]?.revision) };
  }

  async function updateUserRow(client, row, expectedRevision) {
    return applyUpdate(client, {
      table: "identity.users",
      sql: UPDATE_USER_SQL,
      lockStateSql: SELECT_USER_LOCK_STATE_SQL,
      id: row.id,
      rowHash: row.rowHash,
      expectedRevision,
      parameters: [
        row.id,
        row.username,
        row.usernameNormalized,
        row.fullName,
        row.role,
        row.pinHash,
        row.profileJson,
        row.appStatePosition,
        row.rowHash,
        row.createdAt,
        row.updatedAt,
        expectedRevision,
      ],
    });
  }

  async function insertUserGroupRow(client, row) {
    const result = await client.query(INSERT_USER_GROUP_SQL, [
      row.id,
      row.name,
      row.active,
      row.profileJson,
      row.appStatePosition,
      row.rowHash,
      row.createdAt,
      row.updatedAt,
    ]);
    return { outcome: "inserted", id: row.id, revision: integerValue(result.rows?.[0]?.revision) };
  }

  async function updateUserGroupRow(client, row, expectedRevision) {
    return applyUpdate(client, {
      table: "identity.user_groups",
      sql: UPDATE_USER_GROUP_SQL,
      lockStateSql: SELECT_USER_GROUP_LOCK_STATE_SQL,
      id: row.id,
      rowHash: row.rowHash,
      expectedRevision,
      parameters: [
        row.id,
        row.name,
        row.active,
        row.profileJson,
        row.appStatePosition,
        row.rowHash,
        row.createdAt,
        row.updatedAt,
        expectedRevision,
      ],
    });
  }

  async function deleteRows(client, sql, ids) {
    if (ids.length === 0) return { deleted: 0, ids: [] };
    const result = await client.query(sql, [ids]);
    const deletedIds = (result.rows ?? []).map((row) => row.id);
    return { deleted: deletedIds.length || rowCountOf(result), ids: deletedIds };
  }

  // Il prune con il lock ottimistico: si cancellano SOLO le righe che sono ancora alla
  // revisione letta all'inizio della transazione. Chi non c'e' piu' nel risultato e' una
  // riga che qualcun altro ha toccato nel frattempo, e non si cancella per conto suo: si
  // lancia (P5, «fallisce rumorosamente»), perche' una cancellazione parziale silenziosa e'
  // il difetto, non il rimedio.
  async function prunePinnedRows(client, sql, table, domain, pinned) {
    if (pinned.length === 0) return { deleted: 0, ids: [] };
    const result = await client.query(sql, [
      pinned.map((entry) => entry.id),
      pinned.map((entry) => entry.revision),
    ]);
    const deletedIds = (result.rows ?? []).map((row) => row.id);
    if (deletedIds.length !== pinned.length) {
      throw pruneError(
        "IDENTITY_PRUNE_REVISION_CONFLICT",
        `${table}: una riga da cancellare e' cambiata durante la transazione.`,
        {
          domain,
          planned: pinned.length,
          deleted: deletedIds.length,
          // Solo gli id, mai il contenuto: §4.4 e §4.7.
          conflictingIds: pinned
            .map((entry) => entry.id)
            .filter((id) => !deletedIds.includes(id)),
        },
      );
    }
    return { deleted: deletedIds.length, ids: deletedIds };
  }

  function normalizeIncoming(list, normalizer, label) {
    if (list === null || list === undefined) return null;
    if (!Array.isArray(list)) throw validationError(`${label} deve essere un array.`);
    const rows = list.map((entry, index) => normalizer(entry, index));
    const ids = new Set();
    const usernames = new Set();
    for (const row of rows) {
      if (ids.has(row.id)) {
        // §4.4: nessun caso di dedup produce una scelta automatica.
        throw codedError("IDENTITY_DUPLICATE_ID", `id duplicato in ${label}: ${row.id}.`, { id: row.id });
      }
      ids.add(row.id);
      if (row.usernameNormalized !== undefined) {
        if (usernames.has(row.usernameNormalized)) {
          // Solo gli id nel dettaglio, mai gli username completi (§4.4).
          throw codedError(
            "IDENTITY_DUPLICATE_NORMALIZED_USERNAME",
            `chiave di login duplicata in ${label}.`,
            { ids: rows.filter((entry) => entry.usernameNormalized === row.usernameNormalized).map((entry) => entry.id) },
          );
        }
        usernames.add(row.usernameNormalized);
      }
    }
    return rows;
  }

  async function syncUsersDomain(client, incoming, syncOptions, summary) {
    const state = await client.query(USERS_SYNC_STATE_SQL);
    const existing = new Map();
    for (const row of state.rows ?? []) {
      existing.set(row.id, {
        revision: integerValue(row.revision),
        rowHash: row.row_hash,
        administrator: row.is_administrator === true,
      });
    }
    const incomingIds = new Set(incoming.map((row) => row.id));
    const prunableIds = [...existing.keys()].filter((id) => !incomingIds.has(id));
    const purge = syncOptions.allowIdentityPurge === true;
    const intent = hasIdentityPruneIntent("users", syncOptions);

    let prune = false;
    if (!intent) {
      // P1 — nessuna dichiarazione: merge senza cancellazione. È il caso di
      // resetAppState, che non deve più svuotare identity.
      countPruneSkipped(summary, "users", "noIntent");
    } else {
      // D41 — P2 non lancia più sulla collezione vuota, e D40 era una correzione a metà.
      // D40 aveva tolto il caso «vuota su entrambi i lati» dicendo che appena una riga
      // fosse esistita la guardia si sarebbe riarmata «come deve». Era sbagliato: per
      // questo chiamante la collezione vuota NON è «il payload non è arrivato», è
      // l'operatore che ha cancellato l'ultima riga dalla schermata. Con P2 armata,
      // cancellare l'ultimo gruppo avrebbe fatto fallire OGNI `users.save` successivo —
      // i gruppi si sincronizzano prima degli utenti, quindi il lancio arrivava prima di
      // toccarli — e avrebbe spento anche il comparatore shadow, che gira solo dopo una
      // transazione riuscita: la divergenza avrebbe disattivato il solo strumento fatto
      // per vederla.
      // Ora che `splitDomains` non arma più il prune, l'unico che può dichiararlo è
      // `users.save`, che possiede entrambe le collezioni: la sua dichiarazione È
      // l'autorità. Il caso catastrofico su `users` resta fermato da P3 qui sotto e dal
      // CONSTRAINT TRIGGER della 010, che sono protezioni sull'invariante vera («mai zero
      // amministratori») invece che sulla forma del payload.
      //
      // ATTENZIONE, e la precisazione e' dovuta perche' l'ho scritta sbagliata altrove: la
      // frase qui sopra vale per `identity.users` E BASTA. Il CONSTRAINT TRIGGER
      // `identity_users_require_administrator` e' dichiarato `AFTER UPDATE OR DELETE ON
      // identity.users` (010:279-283) e su `identity.user_groups` non esiste alcun trigger
      // oltre a `identity_user_groups_bump_revision`, che e' BEFORE UPDATE e conta le
      // revisioni. P3, dal canto suo, e' scritta in `syncUsersDomain` e parla di
      // amministratori: e' un'invariante del dominio utenti, non delle collezioni in
      // generale. Cosa protegge davvero i gruppi e' scritto in `syncUserGroupsDomain`.
      // Vale anche notare che nemmeno su `users` queste due proteggono dalla cancellazione
      // SBAGLIATA: proteggono dalla cancellazione che lascia zero amministratori. Un
      // operatore cancellato per errore, con l'amministratore ancora in piedi, non le
      // sveglia ne' l'una ne' l'altra.
      if (incoming.length === 0) countPruneSkipped(summary, "users", "emptyDeclared");
      prune = true;
    }

    // P3 — amministratore superstite, con la stessa definizione dello schema. Il controllo
    // si arma quando la transazione aggiorna o cancella, esattamente come il CONSTRAINT
    // TRIGGER (AFTER UPDATE OR DELETE, mai INSERT).
    const survivors = new Map();
    for (const [id, entry] of existing) {
      if (incomingIds.has(id)) continue;
      if (prune) continue;
      survivors.set(id, entry.administrator);
    }
    for (const row of incoming) {
      survivors.set(row.id, isAdministratorProfile(row.role, row.profile));
    }
    const administrators = [...survivors.values()].filter(Boolean).length;
    const updatesPlanned = incoming.filter((row) => existing.has(row.id)).length;
    const deletesPlanned = prune ? prunableIds.length : 0;
    if (administrators === 0 && (updatesPlanned > 0 || deletesPlanned > 0) && !purge) {
      throw pruneError(
        "IDENTITY_NO_SURVIVING_ADMINISTRATOR",
        "identity.users: la sincronizzazione lascerebbe zero amministratori.",
        { domain: "users", deletesPlanned, updatesPlanned },
      );
    }

    const result = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      deletedIds: [],
      pruned: prune,
      prunableIds: prunableIds.length,
    };

    if (deletesPlanned > 0) {
      const deleted = await prunePinnedRows(
        client,
        PRUNE_USERS_SQL,
        "identity.users",
        "users",
        prunableIds.map((id) => ({ id, revision: existing.get(id).revision })),
      );
      result.deleted = deleted.deleted;
      result.deletedIds = deleted.ids;
    }

    for (const row of incoming) {
      const current = existing.get(row.id);
      if (!current) {
        await insertUserRow(client, row);
        result.inserted += 1;
        continue;
      }
      const expectedRevision = row.revision === null ? current.revision : row.revision;
      const outcome = await updateUserRow(client, row, expectedRevision);
      if (outcome.outcome === "updated") result.updated += 1;
      else if (outcome.outcome === "unchanged") result.unchanged += 1;
      else {
        // La riga esisteva alla lettura di stato e non c'è più: qualcun altro l'ha
        // cancellata dentro la stessa finestra. È un conflitto, non un insert.
        throw revisionConflictError("identity.users", row.id, expectedRevision, null);
      }
    }
    return result;
  }

  async function syncUserGroupsDomain(client, incoming, syncOptions, summary) {
    const state = await client.query(USER_GROUPS_SYNC_STATE_SQL);
    const existing = new Map();
    for (const row of state.rows ?? []) {
      existing.set(row.id, { revision: integerValue(row.revision), rowHash: row.row_hash });
    }
    const incomingIds = new Set(incoming.map((row) => row.id));
    const prunableIds = [...existing.keys()].filter((id) => !incomingIds.has(id));
    const purge = syncOptions.allowIdentityPurge === true;
    const intent = hasIdentityPruneIntent("userGroups", syncOptions);

    let prune = false;
    if (!intent) {
      countPruneSkipped(summary, "userGroups", "noIntent");
    } else {
      // D41, gemello di quello sugli utenti. Qui il caso e' ancora piu' netto: cancellare
      // l'ultimo gruppo dalla schermata e' un'operazione legittima e ordinaria, e con P2
      // armata sarebbe stata impossibile — anzi, avrebbe congelato in permanenza anche il
      // write-through degli utenti, perche' i gruppi si sincronizzano per primi.
      //
      // MA «gemello» finisce qui, e la differenza va scritta perche' l'avevo dichiarata al
      // contrario. Su `users` il caso catastrofico ha DUE reti sotto — P3 nel codice e il
      // CONSTRAINT TRIGGER della 010 — ed entrambe difendono l'invariante «mai zero
      // amministratori». Qui NON C'E' NESSUNA DELLE DUE, e non e' una dimenticanza:
      //   * la 010 crea `identity_users_require_administrator` su `identity.users` soltanto
      //     (010:279-283); su `identity.user_groups` l'unico trigger e'
      //     `identity_user_groups_bump_revision`, BEFORE UPDATE, che conta le revisioni e
      //     non guarda la cardinalita';
      //   * P3 parla di amministratori, e un gruppo non e' un amministratore: non esiste
      //     una versione della guardia che si possa applicare qui.
      // Una cardinalita' minima sui gruppi NON si aggiunge, ed e' una scelta: zero gruppi e'
      // uno stato legittimo del prodotto — il `.164` ne ha zero da sempre (D40) — e
      // vietarlo renderebbe impossibile il caso voluto per fermare quello sbagliato.
      //
      // Quello che protegge davvero i gruppi, e che va saputo prima di fidarsi:
      //   1. l'intenzione: solo `identityReplace` arma il prune (D41), e lo dichiara solo
      //      `users.save`; nessun'altra `writeDb` puo' cancellare un gruppo per omissione;
      //   2. la forma del payload: quando `payload.groups` manca, `normalizeGroups`
      //      (users-save-write-model.js) ricade su `db.userGroups`, quindi un client che
      //      non parla di gruppi non puo' svuotarli. Per svuotarli bisogna mandare
      //      `groups: []`, cioe' dirlo;
      //   3. il lock ottimistico di collezione di `users.save` (`expectedVersion`): una
      //      sostituzione integrale che parte da una versione vecchia viene rifiutata prima
      //      di arrivare fin qui — ma solo se il client dichiara la versione;
      //   4. il lock ottimistico per riga di `PRUNE_USER_GROUPS_SQL` qui sotto: un gruppo
      //      cambiato da un altro scrittore nella finestra della transazione non viene piu'
      //      cancellato in silenzio;
      //   5. i contatori `emptyDeclared` e `identityPruneEmptyDeclared`, che restano il
      //      SOLO segnale quando lo svuotamento e' dichiarato da un client aggiornato: un
      //      contatore, non una guardia. E' il limite dichiarato di questo dominio.
      if (incoming.length === 0) countPruneSkipped(summary, "userGroups", "emptyDeclared");
      prune = true;
    }

    const result = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      deletedIds: [],
      pruned: prune,
      prunableIds: prunableIds.length,
    };

    if (prune && prunableIds.length > 0) {
      const deleted = await prunePinnedRows(
        client,
        PRUNE_USER_GROUPS_SQL,
        "identity.user_groups",
        "userGroups",
        prunableIds.map((id) => ({ id, revision: existing.get(id).revision })),
      );
      result.deleted = deleted.deleted;
      result.deletedIds = deleted.ids;
    }

    for (const row of incoming) {
      const current = existing.get(row.id);
      if (!current) {
        await insertUserGroupRow(client, row);
        result.inserted += 1;
        continue;
      }
      const expectedRevision = row.revision === null ? current.revision : row.revision;
      const outcome = await updateUserGroupRow(client, row, expectedRevision);
      if (outcome.outcome === "updated") result.updated += 1;
      else if (outcome.outcome === "unchanged") result.unchanged += 1;
      else throw revisionConflictError("identity.user_groups", row.id, expectedRevision, null);
    }
    return result;
  }

  const implementation = {
    async listUsers() {
      return runtime.withConnection("identity:list-users", async (client) => {
        const result = await client.query(LIST_USERS_SQL);
        return (result.rows ?? []).map(rowToUser);
      });
    },

    async listUserGroups() {
      return runtime.withConnection("identity:list-user-groups", async (client) => {
        const result = await client.query(LIST_USER_GROUPS_SQL);
        return (result.rows ?? []).map(rowToUserGroup);
      });
    },

    async getUserById(idValue) {
      const id = verbatimText(idValue, "id", MAX_ID_LENGTH);
      return runtime.withConnection("identity:get-user-by-id", async (client) => {
        const result = await client.query(GET_USER_BY_ID_SQL, [id]);
        return rowToUser(result.rows?.[0]) ?? null;
      });
    },

    async countAdministrators() {
      return runtime.withConnection("identity:count-administrators", async (client) => {
        const result = await client.query(COUNT_ADMINISTRATORS_SQL);
        return integerValue(result.rows?.[0]?.administrators);
      });
    },

    async insertUser(client, user = {}) {
      requireClient(client, "insertUser");
      return insertUserRow(client, normalizeUserRow(user));
    },

    async updateUser(client, user = {}, expectedRevision) {
      requireClient(client, "updateUser");
      const row = normalizeUserRow(user);
      const expected = expectedRevision === undefined || expectedRevision === null
        ? row.revision
        : nonNegativeInteger(expectedRevision, "expectedRevision");
      if (expected === null) throw validationError("expectedRevision obbligatoria per updateUser.");
      return updateUserRow(client, row, expected);
    },

    async deleteUsers(client, ids) {
      requireClient(client, "deleteUsers");
      return deleteRows(client, DELETE_USERS_SQL, normalizeIdList(ids, "id"));
    },

    async insertUserGroup(client, group = {}) {
      requireClient(client, "insertUserGroup");
      return insertUserGroupRow(client, normalizeUserGroupRow(group));
    },

    async updateUserGroup(client, group = {}, expectedRevision) {
      requireClient(client, "updateUserGroup");
      const row = normalizeUserGroupRow(group);
      const expected = expectedRevision === undefined || expectedRevision === null
        ? row.revision
        : nonNegativeInteger(expectedRevision, "expectedRevision");
      if (expected === null) throw validationError("expectedRevision obbligatoria per updateUserGroup.");
      return updateUserGroupRow(client, row, expected);
    },

    async deleteUserGroups(client, ids) {
      requireClient(client, "deleteUserGroups");
      return deleteRows(client, DELETE_USER_GROUPS_SQL, normalizeIdList(ids, "id"));
    },

    // Write-through dell'app-state, dentro la transazione del chiamante. Merge per
    // definizione: cancella solo con la dichiarazione esplicita di §4.9 P1.
    // Un dominio ASSENTE da `input` non viene toccato affatto; un array vuoto è una
    // collezione vuota dichiarata, che è un caso diverso.
    async syncFromAppState(client, input = {}) {
      requireClient(client, "syncFromAppState");
      const syncOptions = input.options && typeof input.options === "object" ? input.options : {};
      const users = normalizeIncoming(input.users, normalizeUserRow, "users");
      const userGroups = normalizeIncoming(input.userGroups, normalizeUserGroupRow, "userGroups");
      const summary = {
        users: null,
        userGroups: null,
        // D32 punto (f): un nome solo, con suffissi. `identityPruneSkippedNoIntent` non si usa.
        // `emptyDeclared`: il proprietario della collezione ha dichiarato la sostituzione
        // con una collezione vuota, cioe' ha chiesto di svuotarla. Si conta a parte perche'
        // e' l'operazione piu' distruttiva che il sistema esegua senza lanciare, e perche'
        // non va confusa con `noIntent`, che segnala l'opposto: un chiamante che non ha
        // dichiarato nulla e per cui non si cancella niente. D41.
        // D6 REV4 — i due domini si contano SEPARATI oltre che sommati: la sync li tocca
        // entrambi nella stessa transazione, quindi un totale a 2 non dice chi.
        identityPruneSkipped: createIdentityPruneSkippedCounters(),
      };
      if (userGroups !== null) {
        summary.userGroups = await syncUserGroupsDomain(client, userGroups, syncOptions, summary);
      }
      if (users !== null) {
        summary.users = await syncUsersDomain(client, users, syncOptions, summary);
      }
      return summary;
    },
  };

  return assertRepositoryImplementation(
    POSTGRESQL_IDENTITY_REPOSITORY_CONTRACT,
    Object.freeze(implementation),
  );
}


