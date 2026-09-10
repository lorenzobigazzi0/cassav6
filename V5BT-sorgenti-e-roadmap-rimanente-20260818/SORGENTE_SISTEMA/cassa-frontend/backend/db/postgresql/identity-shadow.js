// MIG-040 — il comparatore shadow (§6.3, Questione 3).
//
// QUARTO ANELLO, seconda parte. Nessun SQL e nessuna connessione: riceve i record
// app-state e le righe GIA' rilette da PostgreSQL e dice dove divergono.
//
// S-CMP-1 — superficie PRIMARIA: `canonicalJson(record grezzo)` con `pinHash` sostituito
//   dal fingerprint, confrontato per `id`, piu' il confronto di `app_state_position`.
//   NON si confronta su `sanitizeUser`: quella funzione e' normalizzante per costruzione
//   (backend/server.js:4535-4581) e un criterio di uscita basato su di lei potrebbe
//   risultare VERDE con il mapping rotto — nasconderebbe fra l'altro esattamente il difetto
//   `permissions: undefined -> []`, che a login-write-model.js:107-110 toglie a un operatore
//   i permessi di ruolo.
// S-CMP-2 — in caso di divergenza si registrano l'`id` e i NOMI dei campi divergenti, mai
//   i valori. Vale in particolare per `pinHash`: il fingerprint serve a sapere SE due
//   valori differiscono, e quello e' tutto cio' che serve sapere (§6.2 C4).
// S-CMP-3 — `sanitizeUser` resta un confronto SECONDARIO, etichettato «vista utente»,
//   iniettabile dal chiamante. Un secondario verde con il primario rosso e' ROSSO.
// S-CMP-4 — il comparatore rilegge da PostgreSQL: mai lo snapshot contro se' stesso
//   (R-ISO-3). La rilettura la fa il chiamante; qui si vieta soltanto di riceverla dallo
//   store, e la regola sta scritta nel punto di chiamata.

import { canonicalJson, maskIdentityRecord } from "./identity-canonical.js";

export const IDENTITY_SHADOW_MISMATCH_KINDS = Object.freeze([
  "missing_in_postgres",
  "missing_in_app_state",
  "duplicate_id",
  "fields_differ",
  "position_differs",
  "secondary_view_differs",
]);

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

// Il record «grezzo» dell'app-state e quello ricostruito da PostgreSQL: `rowToUser`
// restituisce l'oggetto completo e mette la ricostruzione in `.record`.
function recordOf(entry) {
  if (!entry || typeof entry !== "object") return null;
  return entry.record && typeof entry.record === "object" ? entry.record : entry;
}

/**
 * I NOMI dei campi che divergono, in ordine, mai i valori. Una chiave presente da un lato
 * solo e' una divergenza: `chiave assente` ≠ `valore vuoto` (§4.6), ed e' proprio la
 * distinzione che un confronto sciatto perderebbe.
 */
export function identityRecordFieldDifferences(left, right) {
  const maskedLeft = maskIdentityRecord(left) ?? {};
  const maskedRight = maskIdentityRecord(right) ?? {};
  const keys = new Set([...Object.keys(maskedLeft), ...Object.keys(maskedRight)]);
  const fields = [];
  for (const key of [...keys].sort()) {
    const inLeft = hasOwn(maskedLeft, key);
    const inRight = hasOwn(maskedRight, key);
    if (inLeft !== inRight) {
      fields.push(key);
      continue;
    }
    if (canonicalJson(maskedLeft[key]) !== canonicalJson(maskedRight[key])) fields.push(key);
  }
  return fields;
}

function indexByPosition(records) {
  const byId = new Map();
  const duplicates = new Set();
  const list = Array.isArray(records) ? records : [];
  list.forEach((entry, index) => {
    const record = recordOf(entry);
    const id = asTrimmedString(record?.id);
    if (!id) return;
    if (byId.has(id)) {
      duplicates.add(id);
      return;
    }
    byId.set(id, { record, position: index });
  });
  return { byId, duplicates };
}

function indexPostgres(entries) {
  const byId = new Map();
  const duplicates = new Set();
  for (const entry of entries ?? []) {
    const record = recordOf(entry);
    const id = asTrimmedString(entry?.id ?? record?.id);
    if (!id) continue;
    if (byId.has(id)) {
      duplicates.add(id);
      continue;
    }
    const position = Number(entry?.appStatePosition);
    byId.set(id, { record, position: Number.isFinite(position) ? Math.trunc(position) : null });
  }
  return { byId, duplicates };
}

/**
 * Confronta UNA collezione. `records` sono i record app-state nell'ordine dell'array;
 * `entries` sono le righe rilette da PostgreSQL e mappate da `rowToUser`/`rowToUserGroup`.
 *
 * `secondaryView` e' opzionale (S-CMP-3): quando c'e', il suo esito si somma al primario e
 * non lo sostituisce mai. Quando manca, `secondary.available` e' `false` e il rapporto lo
 * dichiara invece di far finta che il confronto sia stato fatto.
 */
export function compareIdentityCollection(options = {}) {
  const collection = asTrimmedString(options.collection) || "users";
  const appState = indexByPosition(options.records);
  const postgres = indexPostgres(options.entries);
  const secondaryView = typeof options.secondaryView === "function" ? options.secondaryView : null;
  const mismatches = [];
  let secondaryChecked = 0;

  for (const id of [...appState.duplicates].sort()) {
    mismatches.push({ collection, id, kind: "duplicate_id", side: "appState", fields: [] });
  }
  for (const id of [...postgres.duplicates].sort()) {
    mismatches.push({ collection, id, kind: "duplicate_id", side: "postgres", fields: [] });
  }

  for (const [id, left] of appState.byId) {
    const right = postgres.byId.get(id);
    if (!right) {
      mismatches.push({ collection, id, kind: "missing_in_postgres", fields: [] });
      continue;
    }
    const fields = identityRecordFieldDifferences(left.record, right.record);
    if (fields.length > 0) {
      mismatches.push({ collection, id, kind: "fields_differ", fields });
    }
    if (right.position !== null && right.position !== left.position) {
      mismatches.push({ collection, id, kind: "position_differs", fields: ["appStatePosition"] });
    }
    if (secondaryView) {
      secondaryChecked += 1;
      let leftView = null;
      let rightView = null;
      try {
        leftView = canonicalJson(maskIdentityRecord(secondaryView(left.record)));
        rightView = canonicalJson(maskIdentityRecord(secondaryView(right.record)));
      } catch {
        // La vista secondaria non puo' rompere il confronto primario: e' un aiuto alla
        // lettura, non il criterio di uscita.
        leftView = null;
        rightView = null;
      }
      if (leftView !== null && leftView !== rightView) {
        mismatches.push({ collection, id, kind: "secondary_view_differs", fields: [] });
      }
    }
  }

  for (const id of postgres.byId.keys()) {
    if (appState.byId.has(id)) continue;
    mismatches.push({ collection, id, kind: "missing_in_app_state", fields: [] });
  }

  return {
    collection,
    appStateCount: appState.byId.size,
    postgresCount: postgres.byId.size,
    mismatches,
    // Un secondario verde con il primario rosso e' rosso: `ok` e' la congiunzione, e il
    // secondario e' gia' dentro `mismatches`.
    ok: mismatches.length === 0,
    secondary: { available: Boolean(secondaryView), checked: secondaryChecked },
  };
}

/**
 * Il rapporto completo delle due collezioni. Non contiene nessun valore di record: solo
 * conteggi, `id` e nomi di campo (S-CMP-2).
 */
export function compareIdentitySnapshot(options = {}) {
  const users = compareIdentityCollection({
    collection: "users",
    records: options.users,
    entries: options.postgresUsers,
    secondaryView: options.userView,
  });
  const userGroups = compareIdentityCollection({
    collection: "userGroups",
    records: options.userGroups,
    entries: options.postgresUserGroups,
    secondaryView: options.userGroupView,
  });
  const mismatches = [...users.mismatches, ...userGroups.mismatches];
  return {
    ok: mismatches.length === 0,
    mismatchCount: mismatches.length,
    users,
    userGroups,
    mismatches,
  };
}

/**
 * La riga di log di una divergenza: `id` e nomi dei campi, mai i valori (S-CMP-2). Il
 * numero di voci e' limitato perche' un log non e' un report: il report lo produce
 * l'importer con `--verify`.
 */
export function formatIdentityShadowMismatches(mismatches, limit = 10) {
  const list = Array.isArray(mismatches) ? mismatches : [];
  const shown = list.slice(0, Math.max(1, Math.trunc(Number(limit) || 10)));
  const parts = shown.map((entry) => {
    const fields = Array.isArray(entry?.fields) && entry.fields.length > 0
      ? ` [${entry.fields.join(", ")}]`
      : "";
    return `${entry?.collection ?? "?"}/${entry?.id ?? "?"}:${entry?.kind ?? "?"}${fields}`;
  });
  if (list.length > shown.length) parts.push(`… altre ${list.length - shown.length}`);
  return parts.join("; ");
}
