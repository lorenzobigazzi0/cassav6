import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { normalizeTableCovers } from "../../modules/tables/table-capacity.domain.js";

let DatabaseSyncClass = null;

const VALID_MODES = new Set(["off", "shadow", "externalized"]);
const TABLE_OPERATIONAL_KEYS = [
  "status",
  "guestName",
  "covers",
  "totalDue",
  "amountDue",
  "dueAmount",
  "reservation",
  "pendingBills",
  "customerPhone",
  "note",
  "allergens",
  "manualIntolerance",
  "seatedAt",
];
const TABLE_OPERATIONAL_KEY_SET = new Set(TABLE_OPERATIONAL_KEYS);

function defaultNowIso() {
  return new Date().toISOString();
}

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function safeJsonStringify(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function normalizeMode(value) {
  const mode = String(value ?? "off").trim().toLowerCase() || "off";
  if (!VALID_MODES.has(mode)) {
    throw new Error(
      `BACKEND_APP_STATE_SPLIT_TABLE_STATES non valido: '${mode}'. Valori ammessi: off, shadow, externalized.`
    );
  }
  return mode;
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function normalizeNumber(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeOperationalJson(table) {
  const state = {
    status: normalizeString(table.status, "free").trim() || "free",
    guestName: normalizeString(table.guestName, ""),
    covers: normalizeTableCovers(table.covers),
    totalDue: Math.max(0, normalizeNumber(table.totalDue, 0)),
    reservation: table.reservation === undefined ? null : cloneJson(table.reservation, null),
    pendingBills: Array.isArray(table.pendingBills) ? cloneJson(table.pendingBills, []) : [],
    customerPhone: normalizeString(table.customerPhone, ""),
    note: normalizeString(table.note, ""),
    allergens: Array.isArray(table.allergens) ? cloneJson(table.allergens, []) : [],
    manualIntolerance: normalizeString(table.manualIntolerance, ""),
    seatedAt: table.seatedAt === undefined ? null : cloneJson(table.seatedAt, null),
  };

  if (hasOwn(table, "amountDue")) {
    state.amountDue = Math.max(0, normalizeNumber(table.amountDue, 0));
  }
  if (hasOwn(table, "dueAmount")) {
    state.dueAmount = Math.max(0, normalizeNumber(table.dueAmount, 0));
  }

  return state;
}

function normalizeTableState(table, position) {
  if (!table || typeof table !== "object") return null;
  const tableId = normalizeNullableString(table.id ?? table.tableId);
  if (!tableId) return null;
  const operational = normalizeOperationalJson(table);
  const operationalJson = safeJsonStringify(operational, {});
  const pendingBillCount = Array.isArray(operational.pendingBills) ? operational.pendingBills.length : 0;
  return {
    tableId,
    roomId: normalizeNullableString(table.roomId),
    status: normalizeString(operational.status, "free").trim() || "free",
    guestName: normalizeString(operational.guestName, ""),
    covers: normalizeTableCovers(operational.covers),
    totalDue: Math.max(0, normalizeNumber(operational.totalDue, 0)),
    amountDue: hasOwn(operational, "amountDue") ? Math.max(0, normalizeNumber(operational.amountDue, 0)) : null,
    dueAmount: hasOwn(operational, "dueAmount") ? Math.max(0, normalizeNumber(operational.dueAmount, 0)) : null,
    seatedAt: operational.seatedAt === null || operational.seatedAt === undefined ? null : safeJsonStringify(operational.seatedAt, null),
    hasReservation: operational.reservation && typeof operational.reservation === "object" ? 1 : 0,
    pendingBillCount,
    tablePosition: position,
    operationalJson,
    rowHash: sha256(operationalJson),
  };
}

function rowToTableOperationalState(row) {
  const parsed = safeJsonParse(row?.operational_json, null);
  if (parsed && typeof parsed === "object") return parsed;
  return {
    status: String(row?.status ?? "free"),
    guestName: row?.guest_name === null || row?.guest_name === undefined ? "" : String(row.guest_name),
    covers: normalizeTableCovers(row?.covers),
    totalDue: Math.max(0, normalizeNumber(row?.total_due, 0)),
    pendingBills: [],
    reservation: null,
    customerPhone: "",
    note: "",
    allergens: [],
    manualIntolerance: "",
    seatedAt: row?.seated_at ? safeJsonParse(row.seated_at, row.seated_at) : null,
    ...(row?.amount_due === null || row?.amount_due === undefined ? {} : { amountDue: normalizeNumber(row.amount_due, 0) }),
    ...(row?.due_amount === null || row?.due_amount === undefined ? {} : { dueAmount: normalizeNumber(row.due_amount, 0) }),
  };
}

function buildChecksum(rows) {
  return sha256(JSON.stringify(rows.map((row) => [row.tableId, row.rowHash, row.tablePosition])));
}

function tableHasOperationalState(table) {
  if (!table || typeof table !== "object") return false;
  return TABLE_OPERATIONAL_KEYS.some((key) => hasOwn(table, key));
}

function mergeTableOperationalState(table, operationalState) {
  if (!table || typeof table !== "object" || !operationalState || typeof operationalState !== "object") {
    return table;
  }
  return {
    ...table,
    ...cloneJson(operationalState, operationalState),
  };
}

function stripTableOperationalState(table) {
  if (!table || typeof table !== "object") return table;
  const stripped = { ...table };
  for (const key of TABLE_OPERATIONAL_KEY_SET) {
    delete stripped[key];
  }
  return stripped;
}

export async function loadTableStateSplitDatabaseSync() {
  if (!DatabaseSyncClass) {
    const sqliteModule = await import("node:sqlite");
    DatabaseSyncClass = sqliteModule.DatabaseSync;
  }
  return DatabaseSyncClass;
}

export function normalizeTableStateSplitMode(value) {
  return normalizeMode(value);
}

export function createTableStateSplitRepository(options = {}) {
  const mode = normalizeMode(options.mode);
  const enabled = mode !== "off";
  const externalized = mode === "externalized";
  const dbPath = path.resolve(String(options.dbPath ?? "app-state-split.sqlite"));
  const logger = options.logger ?? console;
  const nowIso = options.nowIso ?? defaultNowIso;
  const clone = options.cloneJson ?? cloneJson;
  let db = null;

  async function ensure() {
    if (!enabled) return null;
    if (db) return db;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const DatabaseSync = await loadTableStateSplitDatabaseSync();
    db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS app_state_split_state (
        domain TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        checksum TEXT,
        source_last_write_at TEXT,
        synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_state_table_states (
        table_id TEXT PRIMARY KEY,
        room_id TEXT,
        status TEXT NOT NULL,
        guest_name TEXT,
        covers INTEGER NOT NULL DEFAULT 0,
        total_due REAL NOT NULL DEFAULT 0,
        amount_due REAL,
        due_amount REAL,
        seated_at TEXT,
        has_reservation INTEGER NOT NULL DEFAULT 0,
        pending_bill_count INTEGER NOT NULL DEFAULT 0,
        table_position INTEGER NOT NULL,
        operational_json TEXT NOT NULL,
        row_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_state_table_states_room_status
        ON app_state_table_states(room_id, status);

      CREATE INDEX IF NOT EXISTS idx_app_state_table_states_position
        ON app_state_table_states(table_position);

      CREATE INDEX IF NOT EXISTS idx_app_state_table_states_due
        ON app_state_table_states(total_due, pending_bill_count);
    `);
    return db;
  }

  function runTransaction(callback) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // noop
      }
      throw error;
    }
  }

  function upsertSplitStateIfChanged(statement, domain, rowCount, checksum, sourceLastWriteAt, syncedAt) {
    const existing = db
      .prepare("SELECT mode, row_count, checksum FROM app_state_split_state WHERE domain = ?")
      .get(domain);
    if (
      existing &&
      String(existing.mode ?? "") === mode &&
      Number(existing.row_count ?? 0) === rowCount &&
      String(existing.checksum ?? "") === String(checksum ?? "")
    ) {
      return false;
    }
    statement.run(domain, mode, rowCount, checksum, sourceLastWriteAt, syncedAt);
    return true;
  }

  function prepareTableStateUpsert() {
    return db.prepare(`
      INSERT INTO app_state_table_states (
        table_id,
        room_id,
        status,
        guest_name,
        covers,
        total_due,
        amount_due,
        due_amount,
        seated_at,
        has_reservation,
        pending_bill_count,
        table_position,
        operational_json,
        row_hash,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(table_id) DO UPDATE SET
        room_id = excluded.room_id,
        status = excluded.status,
        guest_name = excluded.guest_name,
        covers = excluded.covers,
        total_due = excluded.total_due,
        amount_due = excluded.amount_due,
        due_amount = excluded.due_amount,
        seated_at = excluded.seated_at,
        has_reservation = excluded.has_reservation,
        pending_bill_count = excluded.pending_bill_count,
        table_position = excluded.table_position,
        operational_json = excluded.operational_json,
        row_hash = excluded.row_hash,
        updated_at = CURRENT_TIMESTAMP
    `);
  }

  function upsertTableStateRows(rows, existingRows) {
    const existingHashes = new Map(existingRows.map((row) => [String(row.table_id), String(row.row_hash ?? "")]));
    const insertOrReplace = prepareTableStateUpsert();
    let upserted = 0;
    for (const row of rows) {
      if (existingHashes.get(row.tableId) === row.rowHash) {
        db.prepare(
          `
            UPDATE app_state_table_states
            SET room_id = ?, table_position = ?, updated_at = CURRENT_TIMESTAMP
            WHERE table_id = ? AND (room_id IS NOT ? OR table_position <> ?)
          `
        ).run(row.roomId, row.tablePosition, row.tableId, row.roomId, row.tablePosition);
        continue;
      }
      insertOrReplace.run(
        row.tableId,
        row.roomId,
        row.status,
        row.guestName,
        row.covers,
        row.totalDue,
        row.amountDue,
        row.dueAmount,
        row.seatedAt,
        row.hasReservation,
        row.pendingBillCount,
        row.tablePosition,
        row.operationalJson,
        row.rowHash
      );
      upserted += 1;
    }
    return { upserted };
  }

  function upsertTableStates(rows) {
    const existingRows = db.prepare("SELECT table_id, row_hash FROM app_state_table_states").all();
    const nextIds = new Set(rows.map((row) => row.tableId));
    const result = upsertTableStateRows(rows, existingRows);

    const deleteRow = db.prepare("DELETE FROM app_state_table_states WHERE table_id = ?");
    let deleted = 0;
    for (const row of existingRows) {
      const tableId = String(row.table_id);
      if (!nextIds.has(tableId)) {
        deleteRow.run(tableId);
        deleted += 1;
      }
    }
    return { ...result, deleted };
  }

  function prepareSplitStateUpsert() {
    return db.prepare(
      `
        INSERT INTO app_state_split_state (
          domain,
          mode,
          row_count,
          checksum,
          source_last_write_at,
          synced_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET
          mode = excluded.mode,
          row_count = excluded.row_count,
          checksum = excluded.checksum,
          source_last_write_at = excluded.source_last_write_at,
          synced_at = excluded.synced_at
      `
    );
  }

  function readStoredTableStateSummary() {
    const rows = db
      .prepare(
        `
          SELECT table_id, row_hash, table_position
          FROM app_state_table_states
          ORDER BY table_position ASC, table_id ASC
        `
      )
      .all()
      .map((row) => ({
        tableId: String(row.table_id),
        rowHash: String(row.row_hash ?? ""),
        tablePosition: Number(row.table_position),
      }));
    return { checksum: buildChecksum(rows), rowCount: rows.length };
  }

  async function syncFromAppState(appState) {
    if (!enabled) return null;
    await ensure();
    const tables = Array.isArray(appState?.posSettings?.tables) ? appState.posSettings.tables : [];
    const rows = tables.map((table, index) => normalizeTableState(table, index)).filter(Boolean);
    const checksum = buildChecksum(rows);
    const syncedAt = nowIso();
    const sourceLastWriteAt =
      typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim()
        ? appState.meta.lastWriteAt
        : null;

    return runTransaction(() => {
      const result = upsertTableStates(rows);
      const stateStatement = prepareSplitStateUpsert();
      const metadataUpdated = upsertSplitStateIfChanged(
        stateStatement,
        "tableStates",
        rows.length,
        checksum,
        sourceLastWriteAt,
        syncedAt
      );

      return {
        domain: "tableStates",
        mode,
        rowCount: rows.length,
        metadataUpdated,
        checksum,
        syncedAt,
        ...result,
      };
    });
  }

  async function syncEntriesFromAppState(appState, tableIds = []) {
    if (!enabled) return null;
    const selectedIds = [
      ...new Set(
        (Array.isArray(tableIds) ? tableIds : [tableIds])
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean)
      ),
    ];
    if (selectedIds.length === 0) return null;
    await ensure();
    const selectedIdSet = new Set(selectedIds);
    const tables = Array.isArray(appState?.posSettings?.tables) ? appState.posSettings.tables : [];
    const rows = tables
      .map((table, index) => normalizeTableState(table, index))
      .filter((row) => row && selectedIdSet.has(row.tableId));
    const foundIds = new Set(rows.map((row) => row.tableId));
    const missingIds = selectedIds.filter((tableId) => !foundIds.has(tableId));
    const syncedAt = nowIso();
    const sourceLastWriteAt =
      typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim()
        ? appState.meta.lastWriteAt
        : null;

    return runTransaction(() => {
      const selectExisting = db.prepare(
        "SELECT table_id, row_hash FROM app_state_table_states WHERE table_id = ?"
      );
      const existingRows = rows
        .map((row) => selectExisting.get(row.tableId))
        .filter(Boolean);
      const result = upsertTableStateRows(rows, existingRows);
      const summary = readStoredTableStateSummary();
      const metadataUpdated = upsertSplitStateIfChanged(
        prepareSplitStateUpsert(),
        "tableStates",
        summary.rowCount,
        summary.checksum,
        sourceLastWriteAt,
        syncedAt
      );
      return {
        domain: "tableStates",
        mode,
        rowCount: summary.rowCount,
        selectedCount: rows.length,
        missingIds,
        metadataUpdated,
        checksum: summary.checksum,
        syncedAt,
        ...result,
        deleted: 0,
      };
    });
  }

  async function listTableStates() {
    if (!enabled) return [];
    await ensure();
    const rows = db
      .prepare(
        `
          SELECT table_id, operational_json
          FROM app_state_table_states
          ORDER BY table_position ASC, table_id ASC
        `
      )
      .all();
    return rows
      .map((row) => ({
        tableId: String(row?.table_id ?? ""),
        state: rowToTableOperationalState(row),
      }))
      .filter((entry) => entry.tableId && entry.state && typeof entry.state === "object");
  }

  async function hydrateAppState(appState) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    await ensure();
    const countRow = db.prepare("SELECT COUNT(*) AS count FROM app_state_table_states").get();
    const rowCount = Number(countRow?.count ?? 0);
    if (rowCount <= 0) {
      const hasJsonState = Array.isArray(appState.posSettings?.tables)
        ? appState.posSettings.tables.some(tableHasOperationalState)
        : false;
      if (hasJsonState) {
        await syncFromAppState(appState);
      }
      return appState;
    }

    const hydrated = clone(appState, appState);
    if (!hydrated.posSettings || typeof hydrated.posSettings !== "object") {
      hydrated.posSettings = {};
    }
    const tables = Array.isArray(hydrated.posSettings.tables) ? hydrated.posSettings.tables : [];
    const stateRows = await listTableStates();
    const statesByTableId = new Map(stateRows.map((entry) => [entry.tableId, entry.state]));
    hydrated.posSettings.tables = tables.map((table) => {
      if (!table || typeof table !== "object") return table;
      const tableId = String(table.id ?? table.tableId ?? "").trim();
      return tableId && statesByTableId.has(tableId)
        ? mergeTableOperationalState(table, statesByTableId.get(tableId))
        : table;
    });
    return hydrated;
  }

  function stripTableStatesFromAppState(appState, options = {}) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    const persisted = clone(appState, appState);
    if (persisted.posSettings && typeof persisted.posSettings === "object") {
      persisted.posSettings.tables = Array.isArray(persisted.posSettings.tables)
        ? persisted.posSettings.tables.map(stripTableOperationalState)
        : [];
    }
    if (persisted.meta && typeof persisted.meta === "object") {
      persisted.meta.appStateSplitDomains = {
        ...(persisted.meta.appStateSplitDomains && typeof persisted.meta.appStateSplitDomains === "object"
          ? persisted.meta.appStateSplitDomains
          : {}),
        tableStates: {
          mode: "externalized",
          storage: "sqlite",
          domains: ["posSettings.tables.operationalState", "posSettings.tables.pendingBills"],
          operationalKeys: TABLE_OPERATIONAL_KEYS,
          ...(options.includeUpdatedAt ? { updatedAt: nowIso() } : {}),
        },
      };
    }
    return persisted;
  }

  async function prepareAppStateForPrimaryWrite(appState) {
    return stripTableStatesFromAppState(appState, { includeUpdatedAt: true });
  }

  async function prepareAppStateForPersistenceComparison(appState) {
    return stripTableStatesFromAppState(appState, { includeUpdatedAt: false });
  }

  function close() {
    try {
      db?.close();
    } catch {
      // noop
    }
    db = null;
  }

  return {
    close,
    dbPath,
    enabled,
    externalized,
    hydrateAppState,
    listTableStates,
    mode,
    prepareAppStateForPersistenceComparison,
    prepareAppStateForPrimaryWrite,
    syncEntriesFromAppState,
    syncFromAppState,
  };
}
