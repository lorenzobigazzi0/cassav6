import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

let DatabaseSyncClass = null;

const VALID_MODES = new Set(["off", "shadow", "externalized"]);

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
      `BACKEND_APP_STATE_SPLIT_TABLE_LOCKS non valido: '${mode}'. Valori ammessi: off, shadow, externalized.`
    );
  }
  return mode;
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeTableWorkLock(table, position) {
  if (!table || typeof table !== "object") return null;
  const tableId = normalizeNullableString(table.id ?? table.tableId);
  const lock = table.workLock && typeof table.workLock === "object" ? table.workLock : null;
  if (!tableId || !lock) return null;
  const rawJson = safeJsonStringify(lock, {});
  return {
    tableId,
    userId: normalizeNullableString(lock.userId),
    username: normalizeNullableString(lock.username),
    deviceUuid: normalizeNullableString(lock.deviceUuid),
    sessionId: normalizeNullableString(lock.sessionId),
    purpose: normalizeNullableString(lock.purpose) ?? "table_mutation",
    acquiredAt: normalizeNullableString(lock.acquiredAt),
    heartbeatAt: normalizeNullableString(lock.heartbeatAt ?? lock.acquiredAt),
    expiresAt: normalizeNullableString(lock.expiresAt),
    tablePosition: position,
    rawJson,
    rowHash: sha256(rawJson),
  };
}

function rowToTableWorkLock(row) {
  const parsed = safeJsonParse(row?.raw_json, null);
  if (parsed && typeof parsed === "object") return parsed;
  return {
    tableId: String(row?.table_id ?? ""),
    userId: row?.user_id ? String(row.user_id) : "",
    username: row?.username ? String(row.username) : "",
    deviceUuid: row?.device_uuid ? String(row.device_uuid) : "",
    sessionId: row?.session_id ? String(row.session_id) : "",
    purpose: row?.purpose ? String(row.purpose) : "table_mutation",
    acquiredAt: row?.acquired_at ? String(row.acquired_at) : "",
    heartbeatAt: row?.heartbeat_at ? String(row.heartbeat_at) : "",
    expiresAt: row?.expires_at ? String(row.expires_at) : "",
  };
}

function normalizeLegacyTableLock(lock, position) {
  if (!lock || typeof lock !== "object") return null;
  const id = normalizeNullableString(lock.id ?? lock.lockId ?? lock.tableLockId) ?? `legacy_table_lock_${position}`;
  const tableId = normalizeNullableString(lock.tableId ?? lock.table_id);
  if (!id && !tableId) return null;
  const rawJson = safeJsonStringify(lock, {});
  return {
    id: id || `legacy_table_lock_${position}`,
    tableId,
    userId: normalizeNullableString(lock.userId ?? lock.ownerUserId ?? lock.actorUserId),
    deviceUuid: normalizeNullableString(lock.deviceUuid ?? lock.deviceId),
    sessionId: normalizeNullableString(lock.sessionId),
    purpose: normalizeNullableString(lock.purpose ?? lock.type) ?? "table_lock",
    acquiredAt: normalizeNullableString(lock.acquiredAt ?? lock.createdAt),
    heartbeatAt: normalizeNullableString(lock.heartbeatAt ?? lock.updatedAt ?? lock.acquiredAt),
    expiresAt: normalizeNullableString(lock.expiresAt),
    appStatePosition: position,
    rawJson,
    rowHash: sha256(rawJson),
  };
}

function rowToLegacyTableLock(row) {
  const parsed = safeJsonParse(row?.raw_json, null);
  if (parsed && typeof parsed === "object") return parsed;
  return {
    id: String(row?.id ?? ""),
    tableId: row?.table_id ? String(row.table_id) : "",
    userId: row?.user_id ? String(row.user_id) : "",
    deviceUuid: row?.device_uuid ? String(row.device_uuid) : "",
    sessionId: row?.session_id ? String(row.session_id) : "",
    purpose: row?.purpose ? String(row.purpose) : "table_lock",
    acquiredAt: row?.acquired_at ? String(row.acquired_at) : "",
    heartbeatAt: row?.heartbeat_at ? String(row.heartbeat_at) : "",
    expiresAt: row?.expires_at ? String(row.expires_at) : "",
  };
}

function buildChecksum(rows) {
  return sha256(JSON.stringify(rows.map((row) => [row.tableId ?? row.id, row.rowHash, row.tablePosition ?? row.appStatePosition ?? 0])));
}

export async function loadTableLocksSplitDatabaseSync() {
  if (!DatabaseSyncClass) {
    const sqliteModule = await import("node:sqlite");
    DatabaseSyncClass = sqliteModule.DatabaseSync;
  }
  return DatabaseSyncClass;
}

export function normalizeTableLocksSplitMode(value) {
  return normalizeMode(value);
}

export function createTableLocksSplitRepository(options = {}) {
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
    const DatabaseSync = await loadTableLocksSplitDatabaseSync();
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

      CREATE TABLE IF NOT EXISTS app_state_table_work_locks (
        table_id TEXT PRIMARY KEY,
        user_id TEXT,
        username TEXT,
        device_uuid TEXT,
        session_id TEXT,
        purpose TEXT,
        acquired_at TEXT,
        heartbeat_at TEXT,
        expires_at TEXT,
        table_position INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        row_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_state_table_work_locks_user
        ON app_state_table_work_locks(user_id, session_id, device_uuid);

      CREATE INDEX IF NOT EXISTS idx_app_state_table_work_locks_expires_at
        ON app_state_table_work_locks(expires_at);

      CREATE INDEX IF NOT EXISTS idx_app_state_table_work_locks_position
        ON app_state_table_work_locks(table_position);

      CREATE TABLE IF NOT EXISTS app_state_legacy_table_locks (
        id TEXT PRIMARY KEY,
        table_id TEXT,
        user_id TEXT,
        device_uuid TEXT,
        session_id TEXT,
        purpose TEXT,
        acquired_at TEXT,
        heartbeat_at TEXT,
        expires_at TEXT,
        app_state_position INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        row_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_state_legacy_table_locks_table
        ON app_state_legacy_table_locks(table_id);

      CREATE INDEX IF NOT EXISTS idx_app_state_legacy_table_locks_position
        ON app_state_legacy_table_locks(app_state_position);
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

  function upsertWorkLocks(rows) {
    const existingRows = db.prepare("SELECT table_id, row_hash FROM app_state_table_work_locks").all();
    const existingHashes = new Map(existingRows.map((row) => [String(row.table_id), String(row.row_hash ?? "")]));
    const nextIds = new Set(rows.map((row) => row.tableId));
    const insertOrReplace = db.prepare(`
      INSERT INTO app_state_table_work_locks (
        table_id,
        user_id,
        username,
        device_uuid,
        session_id,
        purpose,
        acquired_at,
        heartbeat_at,
        expires_at,
        table_position,
        raw_json,
        row_hash,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(table_id) DO UPDATE SET
        user_id = excluded.user_id,
        username = excluded.username,
        device_uuid = excluded.device_uuid,
        session_id = excluded.session_id,
        purpose = excluded.purpose,
        acquired_at = excluded.acquired_at,
        heartbeat_at = excluded.heartbeat_at,
        expires_at = excluded.expires_at,
        table_position = excluded.table_position,
        raw_json = excluded.raw_json,
        row_hash = excluded.row_hash,
        updated_at = CURRENT_TIMESTAMP
    `);
    let upserted = 0;
    for (const row of rows) {
      if (existingHashes.get(row.tableId) === row.rowHash) {
        db.prepare(
          `
            UPDATE app_state_table_work_locks
            SET table_position = ?, updated_at = CURRENT_TIMESTAMP
            WHERE table_id = ? AND table_position <> ?
          `
        ).run(row.tablePosition, row.tableId, row.tablePosition);
        continue;
      }
      insertOrReplace.run(
        row.tableId,
        row.userId,
        row.username,
        row.deviceUuid,
        row.sessionId,
        row.purpose,
        row.acquiredAt,
        row.heartbeatAt,
        row.expiresAt,
        row.tablePosition,
        row.rawJson,
        row.rowHash
      );
      upserted += 1;
    }

    const deleteRow = db.prepare("DELETE FROM app_state_table_work_locks WHERE table_id = ?");
    let deleted = 0;
    for (const row of existingRows) {
      const tableId = String(row.table_id);
      if (!nextIds.has(tableId)) {
        deleteRow.run(tableId);
        deleted += 1;
      }
    }
    return { upserted, deleted };
  }

  function upsertLegacyTableLocks(rows) {
    const existingRows = db.prepare("SELECT id, row_hash FROM app_state_legacy_table_locks").all();
    const existingHashes = new Map(existingRows.map((row) => [String(row.id), String(row.row_hash ?? "")]));
    const nextIds = new Set(rows.map((row) => row.id));
    const insertOrReplace = db.prepare(`
      INSERT INTO app_state_legacy_table_locks (
        id,
        table_id,
        user_id,
        device_uuid,
        session_id,
        purpose,
        acquired_at,
        heartbeat_at,
        expires_at,
        app_state_position,
        raw_json,
        row_hash,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        table_id = excluded.table_id,
        user_id = excluded.user_id,
        device_uuid = excluded.device_uuid,
        session_id = excluded.session_id,
        purpose = excluded.purpose,
        acquired_at = excluded.acquired_at,
        heartbeat_at = excluded.heartbeat_at,
        expires_at = excluded.expires_at,
        app_state_position = excluded.app_state_position,
        raw_json = excluded.raw_json,
        row_hash = excluded.row_hash,
        updated_at = CURRENT_TIMESTAMP
    `);
    let upserted = 0;
    for (const row of rows) {
      if (existingHashes.get(row.id) === row.rowHash) {
        db.prepare(
          `
            UPDATE app_state_legacy_table_locks
            SET app_state_position = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND app_state_position <> ?
          `
        ).run(row.appStatePosition, row.id, row.appStatePosition);
        continue;
      }
      insertOrReplace.run(
        row.id,
        row.tableId,
        row.userId,
        row.deviceUuid,
        row.sessionId,
        row.purpose,
        row.acquiredAt,
        row.heartbeatAt,
        row.expiresAt,
        row.appStatePosition,
        row.rawJson,
        row.rowHash
      );
      upserted += 1;
    }

    const deleteRow = db.prepare("DELETE FROM app_state_legacy_table_locks WHERE id = ?");
    let deleted = 0;
    for (const row of existingRows) {
      const id = String(row.id);
      if (!nextIds.has(id)) {
        deleteRow.run(id);
        deleted += 1;
      }
    }
    return { upserted, deleted };
  }

  async function syncFromAppState(appState) {
    if (!enabled) return null;
    await ensure();
    const tables = Array.isArray(appState?.posSettings?.tables) ? appState.posSettings.tables : [];
    const legacyLocks = Array.isArray(appState?.tableLocks) ? appState.tableLocks : [];
    const workLockRows = tables.map((table, index) => normalizeTableWorkLock(table, index)).filter(Boolean);
    const legacyRows = legacyLocks.map((lock, index) => normalizeLegacyTableLock(lock, index)).filter(Boolean);
    const workLockChecksum = buildChecksum(workLockRows);
    const legacyChecksum = buildChecksum(legacyRows);
    const checksum = sha256(JSON.stringify({ workLocks: workLockChecksum, legacyLocks: legacyChecksum }));
    const syncedAt = nowIso();
    const sourceLastWriteAt =
      typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim()
        ? appState.meta.lastWriteAt
        : null;

    return runTransaction(() => {
      const workLockResult = upsertWorkLocks(workLockRows);
      const legacyResult = upsertLegacyTableLocks(legacyRows);

      const upsertState = db.prepare(
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
      const metadataUpdated = {
        workLocks: upsertSplitStateIfChanged(
          upsertState,
          "posSettings.tables.workLock",
          workLockRows.length,
          workLockChecksum,
          sourceLastWriteAt,
          syncedAt
        ),
        legacyLocks: upsertSplitStateIfChanged(
          upsertState,
          "tableLocks",
          legacyRows.length,
          legacyChecksum,
          sourceLastWriteAt,
          syncedAt
        ),
        tableLockState: upsertSplitStateIfChanged(
          upsertState,
          "tableLockState",
          workLockRows.length + legacyRows.length,
          checksum,
          sourceLastWriteAt,
          syncedAt
        ),
      };

      return {
        domain: "tableLockState",
        mode,
        rowCount: workLockRows.length + legacyRows.length,
        metadataUpdated,
        workLocks: {
          rowCount: workLockRows.length,
          checksum: workLockChecksum,
          ...workLockResult,
        },
        legacyLocks: {
          rowCount: legacyRows.length,
          checksum: legacyChecksum,
          ...legacyResult,
        },
        checksum,
        syncedAt,
      };
    });
  }

  async function listTableWorkLocks() {
    if (!enabled) return [];
    await ensure();
    const rows = db
      .prepare(
        `
          SELECT table_id, raw_json
          FROM app_state_table_work_locks
          ORDER BY table_position ASC, table_id ASC
        `
      )
      .all();
    return rows
      .map((row) => ({ tableId: String(row?.table_id ?? ""), lock: rowToTableWorkLock(row) }))
      .filter((entry) => entry.tableId && entry.lock && typeof entry.lock === "object");
  }

  async function listLegacyTableLocks() {
    if (!enabled) return [];
    await ensure();
    const rows = db
      .prepare(
        `
          SELECT raw_json
          FROM app_state_legacy_table_locks
          ORDER BY app_state_position ASC, table_id ASC, id ASC
        `
      )
      .all();
    return rows.map(rowToLegacyTableLock).filter((entry) => entry && typeof entry === "object");
  }

  async function mutateTableLock(tableId, callback) {
    if (!externalized) {
      throw new Error("Table locks split non externalized.");
    }
    const safeTableId = normalizeNullableString(tableId);
    if (!safeTableId) throw new Error("tableId non valido.");
    await ensure();
    return runTransaction(() => {
      const currentRow = db
        .prepare("SELECT * FROM app_state_table_work_locks WHERE table_id = ?")
        .get(safeTableId);
      const previousLock = currentRow ? rowToTableWorkLock(currentRow) : null;
      const result = callback(previousLock) ?? {};
      if (result.delete === true) {
        db.prepare("DELETE FROM app_state_table_work_locks WHERE table_id = ?").run(safeTableId);
      } else if (result.nextLock) {
        const row = normalizeTableWorkLock(
          {
            id: safeTableId,
            workLock: result.nextLock,
          },
          Number(currentRow?.table_position ?? 0)
        );
        if (row) {
          db.prepare(
            `
              INSERT INTO app_state_table_work_locks (
                table_id,
                user_id,
                username,
                device_uuid,
                session_id,
                purpose,
                acquired_at,
                heartbeat_at,
                expires_at,
                table_position,
                raw_json,
                row_hash,
                updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(table_id) DO UPDATE SET
                user_id = excluded.user_id,
                username = excluded.username,
                device_uuid = excluded.device_uuid,
                session_id = excluded.session_id,
                purpose = excluded.purpose,
                acquired_at = excluded.acquired_at,
                heartbeat_at = excluded.heartbeat_at,
                expires_at = excluded.expires_at,
                raw_json = excluded.raw_json,
                row_hash = excluded.row_hash,
                updated_at = CURRENT_TIMESTAMP
            `
          ).run(
            row.tableId,
            row.userId,
            row.username,
            row.deviceUuid,
            row.sessionId,
            row.purpose,
            row.acquiredAt,
            row.heartbeatAt,
            row.expiresAt,
            row.tablePosition,
            row.rawJson,
            row.rowHash
          );
        }
      }
      return {
        previousLock,
        ...result,
      };
    });
  }

  async function hydrateAppState(appState) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    await ensure();
    const workLockCountRow = db.prepare("SELECT COUNT(*) AS count FROM app_state_table_work_locks").get();
    const legacyLockCountRow = db.prepare("SELECT COUNT(*) AS count FROM app_state_legacy_table_locks").get();
    const workLockCount = Number(workLockCountRow?.count ?? 0);
    const legacyLockCount = Number(legacyLockCountRow?.count ?? 0);
    if (workLockCount <= 0 && legacyLockCount <= 0) {
      const hasJsonWorkLocks = Array.isArray(appState.posSettings?.tables)
        ? appState.posSettings.tables.some((table) => table?.workLock && typeof table.workLock === "object")
        : false;
      const hasLegacyLocks = Array.isArray(appState.tableLocks) && appState.tableLocks.length > 0;
      if (hasJsonWorkLocks || hasLegacyLocks) {
        await syncFromAppState(appState);
      }
      return appState;
    }

    const hydrated = clone(appState, appState);
    const workLocks = await listTableWorkLocks();
    const workLocksByTableId = new Map(workLocks.map((entry) => [entry.tableId, entry.lock]));
    if (!hydrated.posSettings || typeof hydrated.posSettings !== "object") {
      hydrated.posSettings = {};
    }
    const tables = Array.isArray(hydrated.posSettings.tables) ? hydrated.posSettings.tables : [];
    hydrated.posSettings.tables = tables.map((table) => {
      if (!table || typeof table !== "object") return table;
      const tableId = String(table.id ?? table.tableId ?? "").trim();
      return {
        ...table,
        workLock: tableId && workLocksByTableId.has(tableId) ? workLocksByTableId.get(tableId) : null,
      };
    });
    hydrated.tableLocks = await listLegacyTableLocks();
    return hydrated;
  }

  function stripTableLocksFromAppState(appState, options = {}) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    const persisted = clone(appState, appState);
    if (persisted.posSettings && typeof persisted.posSettings === "object") {
      persisted.posSettings.tables = Array.isArray(persisted.posSettings.tables)
        ? persisted.posSettings.tables.map((table) =>
            table && typeof table === "object"
              ? {
                  ...table,
                  workLock: null,
                }
              : table
          )
        : [];
    }
    persisted.tableLocks = [];
    if (persisted.meta && typeof persisted.meta === "object") {
      persisted.meta.appStateSplitDomains = {
        ...(persisted.meta.appStateSplitDomains && typeof persisted.meta.appStateSplitDomains === "object"
          ? persisted.meta.appStateSplitDomains
          : {}),
        tableLocks: {
          mode: "externalized",
          storage: "sqlite",
          domains: ["posSettings.tables.workLock", "tableLocks"],
          ...(options.includeUpdatedAt ? { updatedAt: nowIso() } : {}),
        },
      };
    }
    return persisted;
  }

  async function prepareAppStateForPrimaryWrite(appState) {
    return stripTableLocksFromAppState(appState, { includeUpdatedAt: true });
  }

  async function prepareAppStateForPersistenceComparison(appState) {
    return stripTableLocksFromAppState(appState, { includeUpdatedAt: false });
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
    listLegacyTableLocks,
    listTableWorkLocks,
    mode,
    mutateTableLock,
    prepareAppStateForPersistenceComparison,
    prepareAppStateForPrimaryWrite,
    syncFromAppState,
  };
}
