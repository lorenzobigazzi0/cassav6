// MIG-040 — anello 5. I DOPPI CONDIVISI del dominio identity.
//
// Questo file non contiene test: esiste soltanto perche' i doppi in memoria del quarto
// anello (backend/tests/postgresql-identity-write-through.test.mjs) sono dichiarati dentro
// un file di test e non sono esportabili, e i quattro anelli committati non si toccano.
//
// I tre blocchi qui sotto sono COPIE VERBATIM di quel file, delimitate da marcatori. Non
// sono una seconda implementazione: postgresql-identity-integration.test.mjs contiene un
// test che rilegge l'originale e verifica che ogni blocco ne sia ancora un sottotesto
// esatto. Se il quarto anello cambiera' il suo doppio, quel test diventa rosso e questo
// file va riallineato — non riscritto a mano in modo diverso.
//
// Il `pinHash` compare qui come COSTANTE DI TEST (PIN_HASH): e' il valore che i test
// verificano non finire nei log. Non e' un segreto reale.

import { canonicalJson, isAdministratorProfile } from "../../db/postgresql/index.js";

// >>> COPIA VERBATIM (costanti) — INIZIO
const PIN_HASH = `scrypt$32768$8$1$${"ab".repeat(16)}$${"cd".repeat(32)}`;
const OTHER_PIN_HASH = `scrypt$32768$8$1$${"ef".repeat(16)}$${"09".repeat(32)}`;

const SHADOW_ENV = Object.freeze({
  BACKEND_POSTGRES_ENABLED: "1",
  BACKEND_POSTGRES_SHADOW_DOMAINS: "identity",
});
const PRIMARY_ENV = Object.freeze({
  BACKEND_POSTGRES_ENABLED: "1",
  BACKEND_POSTGRES_PRIMARY_DOMAINS: "identity",
});
const OFF_ENV = Object.freeze({});
// <<< COPIA VERBATIM (costanti) — FINE

// >>> COPIA VERBATIM (doppio in memoria, logger, metriche) — INIZIO
function toDate(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function createFakeIdentityDb(initial = {}) {
  const users = new Map();
  const groups = new Map();
  const queries = [];
  const state = { failure: null, failOn: null };

  for (const row of initial.users ?? []) users.set(row.id, { ...row });
  for (const row of initial.userGroups ?? []) groups.set(row.id, { ...row });

  function rows(result) {
    return { rowCount: result.length, rows: result };
  }

  // Il trigger della 008: +1 se e solo se cambia qualcosa che non sia `revision`.
  function bumpRevision(previous, next) {
    const strip = (row) => {
      const { revision, ...rest } = row;
      return canonicalJson({
        ...rest,
        created_at: rest.created_at ? toDate(rest.created_at).toISOString() : null,
        updated_at: rest.updated_at ? toDate(rest.updated_at).toISOString() : null,
      });
    };
    return strip(previous) === strip(next) ? previous.revision : previous.revision + 1;
  }

  const client = {
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (state.failure && (!state.failOn || state.failOn.test(sql))) throw state.failure;

      if (/is_administrator/.test(sql)) {
        return rows(
          [...users.values()].map((row) => ({
            id: row.id,
            revision: row.revision,
            row_hash: row.row_hash,
            is_administrator: isAdministratorProfile(row.role, JSON.parse(row.profile)),
          })),
        );
      }
      if (/SELECT\s+id,\s+revision,\s+row_hash\s+FROM identity\.user_groups/.test(sql)) {
        return rows(
          [...groups.values()].map((row) => ({
            id: row.id,
            revision: row.revision,
            row_hash: row.row_hash,
          })),
        );
      }
      if (/INSERT INTO identity\.users/.test(sql)) {
        const row = {
          id: parameters[0],
          username: parameters[1],
          username_normalized: parameters[2],
          full_name: parameters[3],
          role: parameters[4],
          pin_hash: parameters[5],
          profile: parameters[6],
          app_state_position: parameters[7],
          row_hash: parameters[8],
          created_at: toDate(parameters[9]),
          updated_at: toDate(parameters[10]),
          revision: 0,
        };
        users.set(row.id, row);
        return rows([{ revision: 0 }]);
      }
      if (/UPDATE identity\.users/.test(sql)) {
        const current = users.get(parameters[0]);
        if (!current) return rows([]);
        if (current.revision !== parameters[11]) return rows([]);
        if (current.row_hash === parameters[8]) return rows([]);
        const next = {
          ...current,
          username: parameters[1],
          username_normalized: parameters[2],
          full_name: parameters[3],
          role: parameters[4],
          pin_hash: parameters[5],
          profile: parameters[6],
          app_state_position: parameters[7],
          row_hash: parameters[8],
          created_at: toDate(parameters[9]),
          updated_at: toDate(parameters[10]),
        };
        next.revision = bumpRevision(current, next);
        users.set(next.id, next);
        return rows([{ revision: next.revision }]);
      }
      if (/SELECT revision, row_hash\s+FROM identity\.users/.test(sql)) {
        const current = users.get(parameters[0]);
        return current ? rows([{ revision: current.revision, row_hash: current.row_hash }]) : rows([]);
      }
      // Il prune manda DUE array: gli id e la revision attesa per ciascuno
      // (PRUNE_USERS_SQL, lock ottimistico per riga). Il doppio la rispetta, altrimenti
      // cancellerebbe cio' che il database vero si rifiuta di cancellare e il test sarebbe
      // verde su un comportamento che in produzione non esiste. `deleteUsers(client, ids)`,
      // che e' l'altra chiamata, manda un array solo: allora si cancella per id.
      if (/DELETE FROM identity\.users/.test(sql)) {
        const pruneIds = parameters[0] ?? [];
        const pruneRevisions = Array.isArray(parameters[1]) ? parameters[1] : null;
        const removed = [];
        pruneIds.forEach((id, index) => {
          const current = users.get(id);
          if (!current) return;
          if (pruneRevisions && Number(current.revision) !== Number(pruneRevisions[index])) return;
          users.delete(id);
          removed.push({ id });
        });
        return rows(removed);
      }
      if (/INSERT INTO identity\.user_groups/.test(sql)) {
        const row = {
          id: parameters[0],
          name: parameters[1],
          active: parameters[2],
          profile: parameters[3],
          app_state_position: parameters[4],
          row_hash: parameters[5],
          created_at: toDate(parameters[6]) ?? new Date("2026-03-03T00:00:00.000Z"),
          updated_at: toDate(parameters[7]) ?? new Date("2026-03-03T00:00:00.000Z"),
          revision: 0,
        };
        groups.set(row.id, row);
        return rows([{ revision: 0 }]);
      }
      if (/UPDATE identity\.user_groups/.test(sql)) {
        const current = groups.get(parameters[0]);
        if (!current) return rows([]);
        if (current.revision !== parameters[8]) return rows([]);
        if (current.row_hash === parameters[5]) return rows([]);
        const next = {
          ...current,
          name: parameters[1],
          active: parameters[2],
          profile: parameters[3],
          app_state_position: parameters[4],
          row_hash: parameters[5],
          created_at: toDate(parameters[6]) ?? current.created_at,
          updated_at: toDate(parameters[7]) ?? current.updated_at,
        };
        next.revision = bumpRevision(current, next);
        groups.set(next.id, next);
        return rows([{ revision: next.revision }]);
      }
      if (/SELECT revision, row_hash\s+FROM identity\.user_groups/.test(sql)) {
        const current = groups.get(parameters[0]);
        return current ? rows([{ revision: current.revision, row_hash: current.row_hash }]) : rows([]);
      }
      // Gemella di quella sugli utenti: PRUNE_USER_GROUPS_SQL porta id e revision attesa.
      if (/DELETE FROM identity\.user_groups/.test(sql)) {
        const pruneIds = parameters[0] ?? [];
        const pruneRevisions = Array.isArray(parameters[1]) ? parameters[1] : null;
        const removed = [];
        pruneIds.forEach((id, index) => {
          const current = groups.get(id);
          if (!current) return;
          if (pruneRevisions && Number(current.revision) !== Number(pruneRevisions[index])) return;
          groups.delete(id);
          removed.push({ id });
        });
        return rows(removed);
      }
      if (/FROM identity\.users/.test(sql)) {
        return rows(
          [...users.values()].sort(
            (left, right) => left.app_state_position - right.app_state_position || left.id.localeCompare(right.id),
          ),
        );
      }
      if (/FROM identity\.user_groups/.test(sql)) {
        return rows(
          [...groups.values()].sort(
            (left, right) => left.app_state_position - right.app_state_position || left.id.localeCompare(right.id),
          ),
        );
      }
      return rows([]);
    },
  };

  const runtime = {
    async withConnection(_label, callback) {
      return callback(client);
    },
    async withTransaction(_label, callback) {
      return callback(client, { attempt: 1, maxAttempts: 3 });
    },
  };

  return { client, runtime, users, groups, queries, state };
}

function silentLogger() {
  const lines = [];
  const sink = (...args) => lines.push(args.map((entry) => String(entry)).join(" "));
  return { lines, logger: { warn: sink, error: sink, info: sink, log: sink } };
}

function countingMetrics() {
  // D6 REV4: `identityPruneEmptyDeclared` e' un contatore vero di runtime-metrics.js
  // (:656-664), non un nome inventato qui. Il doppio riproduce l'allowlist reale: un nome
  // non registrato viene lasciato cadere in silenzio, come nel modulo vero.
  const counters = {
    identityShadowWriteFailures: 0,
    identityShadowMismatches: 0,
    identityPruneEmptyDeclared: 0,
  };
  const operations = [];
  return {
    counters,
    operations,
    metrics: {
      incrementCounter(name, amount = 1) {
        if (!Object.prototype.hasOwnProperty.call(counters, name)) return;
        counters[name] += amount;
      },
      recordOperation(kind, label) {
        operations.push(`${kind}:${label}`);
      },
    },
  };
}
// <<< COPIA VERBATIM (doppio in memoria, logger, metriche) — FINE

// >>> COPIA VERBATIM (record app-state e righe driver) — INIZIO
// Record app-state realistici. `permissions` ASSENTE su u2 non è una distrazione: è il caso
// di §4.6 che vale una configurazione di sicurezza.
function adminRecord(overrides = {}) {
  return {
    id: "u1",
    username: "Mario",
    fullName: "Mario Rossi",
    role: "admin",
    permissions: ["manage_users", "view_orders"],
    groupIds: ["g1"],
    pinHash: PIN_HASH,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-02-02T11:00:00.000Z",
    ...overrides,
  };
}

function operatorRecord(overrides = {}) {
  return {
    id: "u2",
    username: "Luigi",
    fullName: "Luigi Verdi",
    role: "operator",
    allowedPaymentMethodIds: [],
    pinHash: "",
    createdAt: "2026-01-03T10:00:00.000Z",
    updatedAt: "2026-01-03T10:00:00.000Z",
    ...overrides,
  };
}

function groupRecord(overrides = {}) {
  return { id: "g1", name: "Sala", description: "Gruppo sala", permissions: ["view_orders"], ...overrides };
}

// Simula la riga come tornerebbe dal driver: `profile` stringa, timestamp `Date`.
function rowFromUser(row) {
  return {
    id: row.id,
    username: row.username,
    username_normalized: row.usernameNormalized,
    full_name: row.fullName,
    role: row.role,
    pin_hash: row.pinHash,
    profile: JSON.stringify(row.profile),
    app_state_position: row.appStatePosition,
    row_hash: row.rowHash,
    revision: 0,
    created_at: row.createdAt ? new Date(row.createdAt) : null,
    updated_at: row.updatedAt ? new Date(row.updatedAt) : null,
  };
}

function rowFromGroup(row) {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    profile: JSON.stringify(row.profile),
    app_state_position: row.appStatePosition,
    row_hash: row.rowHash,
    revision: 0,
    created_at: new Date("2026-03-03T00:00:00.000Z"),
    updated_at: new Date("2026-03-03T00:00:00.000Z"),
  };
}
// <<< COPIA VERBATIM (record app-state e righe driver) — FINE

export {
  adminRecord,
  countingMetrics,
  createFakeIdentityDb,
  groupRecord,
  operatorRecord,
  OFF_ENV,
  OTHER_PIN_HASH,
  PIN_HASH,
  PRIMARY_ENV,
  rowFromGroup,
  rowFromUser,
  SHADOW_ENV,
  silentLogger,
  toDate,
};
