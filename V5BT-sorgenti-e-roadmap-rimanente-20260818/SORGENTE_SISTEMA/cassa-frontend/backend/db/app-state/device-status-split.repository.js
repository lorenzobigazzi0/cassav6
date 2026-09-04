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
      `BACKEND_APP_STATE_SPLIT_DEVICE_STATUS non valido: '${mode}'. Valori ammessi: off, shadow, externalized.`
    );
  }
  return mode;
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === false) return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0 ? 1 : 0;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "y", "on", "active", "online"].includes(normalized)) return 1;
  if (["0", "false", "no", "n", "off", "inactive", "offline"].includes(normalized)) return 0;
  return fallback ? 1 : 0;
}

function normalizeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.trunc(numeric);
}

function normalizeSession(session, position) {
  if (!session || typeof session !== "object") return null;
  const id = String(session.id ?? session.sessionId ?? `session_${position}`).trim();
  if (!id) return null;
  const rawJson = safeJsonStringify(session, {});
  return {
    id,
    userId: normalizeNullableString(session.userId),
    username: normalizeNullableString(session.username),
    tokenHash: normalizeNullableString(session.tokenHash),
    deviceUuid: normalizeNullableString(session.deviceUuid),
    clientApp: normalizeNullableString(session.clientApp),
    roomId: normalizeNullableString(session.roomId),
    roomName: normalizeNullableString(session.roomName),
    stationName: normalizeNullableString(session.stationName ?? session.station),
    createdAt: normalizeNullableString(session.createdAt),
    lastSeenAt: normalizeNullableString(session.lastSeenAt ?? session.createdAt),
    expiresAt: normalizeNullableString(session.expiresAt),
    appStatePosition: position,
    rawJson,
    rowHash: sha256(rawJson),
  };
}

function rowToSession(row) {
  const parsed = safeJsonParse(row?.raw_json, null);
  if (parsed && typeof parsed === "object") return parsed;
  return {
    id: String(row?.id ?? ""),
    userId: row?.user_id ? String(row.user_id) : "",
    username: row?.username ? String(row.username) : "",
    tokenHash: row?.token_hash ? String(row.token_hash) : "",
    deviceUuid: row?.device_uuid ? String(row.device_uuid) : "",
    clientApp: row?.client_app ? String(row.client_app) : "",
    roomId: row?.room_id ? String(row.room_id) : "",
    roomName: row?.room_name ? String(row.room_name) : "",
    stationName: row?.station_name ? String(row.station_name) : "",
    createdAt: row?.created_at_value ? String(row.created_at_value) : "",
    lastSeenAt: row?.last_seen_at ? String(row.last_seen_at) : "",
    expiresAt: row?.expires_at ? String(row.expires_at) : "",
  };
}

function normalizeStationState(entry, position) {
  if (!entry || typeof entry !== "object") return null;
  const station = normalizeNullableString(entry.station ?? entry.stationName);
  const deviceUuid = normalizeNullableString(entry.deviceUuid ?? entry.deviceId);
  const operatorUserId = normalizeNullableString(entry.operatorUserId ?? entry.userId);
  const operatorUsername = normalizeNullableString(entry.operatorUsername ?? entry.username);
  const keyParts = [station, operatorUserId, operatorUsername, deviceUuid].filter(Boolean);
  const fallbackKey = `station_state_${position}`;
  const id = normalizeNullableString(entry.id) ?? (keyParts.length ? keyParts.join("|") : fallbackKey);
  if (!id) return null;
  const rawJson = safeJsonStringify(entry, {});
  return {
    id,
    station,
    active: normalizeBoolean(entry.active, true),
    stale: normalizeBoolean(entry.stale, false),
    realStation: normalizeBoolean(entry.realStation, false),
    configuredStation: normalizeBoolean(entry.configuredStation, false),
    isDemoFallback: normalizeBoolean(entry.isDemoFallback, false),
    clientApp: normalizeNullableString(entry.clientApp),
    deviceUuid,
    operatorUserId,
    operatorUsername,
    operatorName: normalizeNullableString(entry.operatorName ?? entry.operator),
    operatorRole: normalizeNullableString(entry.operatorRole ?? entry.role),
    autoPrintOrders: normalizeBoolean(entry.autoPrintOrders, false),
    autoPrintPreconto: normalizeBoolean(entry.autoPrintPreconto, false),
    updatedAt: normalizeNullableString(entry.updatedAt),
    updatedAtMs: entry.updatedAtMs === null || entry.updatedAtMs === undefined ? null : normalizeInteger(entry.updatedAtMs, 0),
    appStatePosition: position,
    rawJson,
    rowHash: sha256(rawJson),
  };
}

function rowToStationState(row) {
  const parsed = safeJsonParse(row?.raw_json, null);
  if (parsed && typeof parsed === "object") return parsed;
  return {
    id: String(row?.id ?? ""),
    station: row?.station ? String(row.station) : "",
    active: Number(row?.active ?? 0) !== 0,
    stale: Number(row?.stale ?? 0) !== 0,
    realStation: Number(row?.real_station ?? 0) !== 0,
    configuredStation: Number(row?.configured_station ?? 0) !== 0,
    isDemoFallback: Number(row?.is_demo_fallback ?? 0) !== 0,
    clientApp: row?.client_app ? String(row.client_app) : "",
    deviceUuid: row?.device_uuid ? String(row.device_uuid) : "",
    operatorUserId: row?.operator_user_id ? String(row.operator_user_id) : "",
    operatorUsername: row?.operator_username ? String(row.operator_username) : "",
    operatorName: row?.operator_name ? String(row.operator_name) : "",
    operatorRole: row?.operator_role ? String(row.operator_role) : "",
    autoPrintOrders: Number(row?.auto_print_orders ?? 0) !== 0,
    autoPrintPreconto: Number(row?.auto_print_preconto ?? 0) !== 0,
    updatedAt: row?.updated_at_value ? String(row.updated_at_value) : "",
    updatedAtMs: row?.updated_at_ms === null || row?.updated_at_ms === undefined ? 0 : Number(row.updated_at_ms),
  };
}

function buildChecksum(rows) {
  return sha256(JSON.stringify(rows.map((row) => [row.id, row.rowHash, row.appStatePosition])));
}

export async function loadDeviceStatusSplitDatabaseSync() {
  if (!DatabaseSyncClass) {
    const sqliteModule = await import("node:sqlite");
    DatabaseSyncClass = sqliteModule.DatabaseSync;
  }
  return DatabaseSyncClass;
}

export function normalizeDeviceStatusSplitMode(value) {
  return normalizeMode(value);
}

export function createDeviceStatusSplitRepository(options = {}) {
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
    const DatabaseSync = await loadDeviceStatusSplitDatabaseSync();
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

      CREATE TABLE IF NOT EXISTS app_state_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        username TEXT,
        token_hash TEXT,
        device_uuid TEXT,
        client_app TEXT,
        room_id TEXT,
        room_name TEXT,
        station_name TEXT,
        created_at_value TEXT,
        last_seen_at TEXT,
        expires_at TEXT,
        app_state_position INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        row_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_state_sessions_position
        ON app_state_sessions(app_state_position);

      CREATE INDEX IF NOT EXISTS idx_app_state_sessions_token_hash
        ON app_state_sessions(token_hash);

      CREATE INDEX IF NOT EXISTS idx_app_state_sessions_device
        ON app_state_sessions(device_uuid, client_app);

      CREATE INDEX IF NOT EXISTS idx_app_state_sessions_user
        ON app_state_sessions(user_id, client_app);

      CREATE INDEX IF NOT EXISTS idx_app_state_sessions_last_seen
        ON app_state_sessions(last_seen_at);

      CREATE TABLE IF NOT EXISTS app_state_integration_station_states (
        id TEXT PRIMARY KEY,
        station TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        stale INTEGER NOT NULL DEFAULT 0,
        real_station INTEGER NOT NULL DEFAULT 0,
        configured_station INTEGER NOT NULL DEFAULT 0,
        is_demo_fallback INTEGER NOT NULL DEFAULT 0,
        client_app TEXT,
        device_uuid TEXT,
        operator_user_id TEXT,
        operator_username TEXT,
        operator_name TEXT,
        operator_role TEXT,
        auto_print_orders INTEGER NOT NULL DEFAULT 0,
        auto_print_preconto INTEGER NOT NULL DEFAULT 0,
        updated_at_value TEXT,
        updated_at_ms INTEGER,
        app_state_position INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        row_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_state_station_states_position
        ON app_state_integration_station_states(app_state_position);

      CREATE INDEX IF NOT EXISTS idx_app_state_station_states_station
        ON app_state_integration_station_states(station, active, stale);

      CREATE INDEX IF NOT EXISTS idx_app_state_station_states_device
        ON app_state_integration_station_states(device_uuid, client_app);

      CREATE INDEX IF NOT EXISTS idx_app_state_station_states_updated
        ON app_state_integration_station_states(updated_at_ms);
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

  function upsertSessions(rows, options = {}) {
    const existingRows = db.prepare("SELECT id, row_hash FROM app_state_sessions").all();
    const existingHashes = new Map(existingRows.map((row) => [String(row.id), String(row.row_hash ?? "")]));
    const nextIds = new Set(rows.map((row) => row.id));
    const deleteMissing = options.deleteMissing !== false;
    const insertOrReplace = db.prepare(`
      INSERT INTO app_state_sessions (
        id,
        user_id,
        username,
        token_hash,
        device_uuid,
        client_app,
        room_id,
        room_name,
        station_name,
        created_at_value,
        last_seen_at,
        expires_at,
        app_state_position,
        raw_json,
        row_hash,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        username = excluded.username,
        token_hash = excluded.token_hash,
        device_uuid = excluded.device_uuid,
        client_app = excluded.client_app,
        room_id = excluded.room_id,
        room_name = excluded.room_name,
        station_name = excluded.station_name,
        created_at_value = excluded.created_at_value,
        last_seen_at = excluded.last_seen_at,
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
            UPDATE app_state_sessions
            SET app_state_position = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND app_state_position <> ?
          `
        ).run(row.appStatePosition, row.id, row.appStatePosition);
        continue;
      }
      insertOrReplace.run(
        row.id,
        row.userId,
        row.username,
        row.tokenHash,
        row.deviceUuid,
        row.clientApp,
        row.roomId,
        row.roomName,
        row.stationName,
        row.createdAt,
        row.lastSeenAt,
        row.expiresAt,
        row.appStatePosition,
        row.rawJson,
        row.rowHash
      );
      upserted += 1;
    }

    let deleted = 0;
    if (deleteMissing) {
      const deleteRow = db.prepare("DELETE FROM app_state_sessions WHERE id = ?");
      for (const row of existingRows) {
        const id = String(row.id);
        if (!nextIds.has(id)) {
          deleteRow.run(id);
          deleted += 1;
        }
      }
    }
    return { upserted, deleted };
  }

  function upsertStationStates(rows) {
    const existingRows = db.prepare("SELECT id, row_hash FROM app_state_integration_station_states").all();
    const existingHashes = new Map(existingRows.map((row) => [String(row.id), String(row.row_hash ?? "")]));
    const nextIds = new Set(rows.map((row) => row.id));
    const insertOrReplace = db.prepare(`
      INSERT INTO app_state_integration_station_states (
        id,
        station,
        active,
        stale,
        real_station,
        configured_station,
        is_demo_fallback,
        client_app,
        device_uuid,
        operator_user_id,
        operator_username,
        operator_name,
        operator_role,
        auto_print_orders,
        auto_print_preconto,
        updated_at_value,
        updated_at_ms,
        app_state_position,
        raw_json,
        row_hash,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        station = excluded.station,
        active = excluded.active,
        stale = excluded.stale,
        real_station = excluded.real_station,
        configured_station = excluded.configured_station,
        is_demo_fallback = excluded.is_demo_fallback,
        client_app = excluded.client_app,
        device_uuid = excluded.device_uuid,
        operator_user_id = excluded.operator_user_id,
        operator_username = excluded.operator_username,
        operator_name = excluded.operator_name,
        operator_role = excluded.operator_role,
        auto_print_orders = excluded.auto_print_orders,
        auto_print_preconto = excluded.auto_print_preconto,
        updated_at_value = excluded.updated_at_value,
        updated_at_ms = excluded.updated_at_ms,
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
            UPDATE app_state_integration_station_states
            SET app_state_position = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND app_state_position <> ?
          `
        ).run(row.appStatePosition, row.id, row.appStatePosition);
        continue;
      }
      insertOrReplace.run(
        row.id,
        row.station,
        row.active,
        row.stale,
        row.realStation,
        row.configuredStation,
        row.isDemoFallback,
        row.clientApp,
        row.deviceUuid,
        row.operatorUserId,
        row.operatorUsername,
        row.operatorName,
        row.operatorRole,
        row.autoPrintOrders,
        row.autoPrintPreconto,
        row.updatedAt,
        row.updatedAtMs,
        row.appStatePosition,
        row.rawJson,
        row.rowHash
      );
      upserted += 1;
    }

    const deleteRow = db.prepare("DELETE FROM app_state_integration_station_states WHERE id = ?");
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

  async function syncFromAppState(appState, options = {}) {
    if (!enabled) return null;
    await ensure();
    const sessionSyncOptions = options.sessionsSync ?? options.sessionSync ?? {};
    const shouldSyncSessions =
      sessionSyncOptions.skip !== true && sessionSyncOptions.enabled !== false;
    const sessions =
      shouldSyncSessions && Array.isArray(appState?.sessions)
        ? appState.sessions
        : [];
    const stationStates = Array.isArray(appState?.integration?.stationStates) ? appState.integration.stationStates : [];
    const sessionRows = sessions.map((session, index) => normalizeSession(session, index)).filter(Boolean);
    const stationRows = stationStates.map((entry, index) => normalizeStationState(entry, index)).filter(Boolean);
    const sessionChecksum = shouldSyncSessions ? buildChecksum(sessionRows) : "";
    const stationChecksum = buildChecksum(stationRows);
    const checksum = sha256(
      JSON.stringify({
        ...(shouldSyncSessions ? { sessions: sessionChecksum } : {}),
        stationStates: stationChecksum,
      })
    );
    const syncedAt = nowIso();
    const sourceLastWriteAt =
      typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim()
        ? appState.meta.lastWriteAt
        : null;

    return runTransaction(() => {
      const sessionResult = shouldSyncSessions
        ? upsertSessions(sessionRows, sessionSyncOptions)
        : { skipped: true };
      const stationResult = upsertStationStates(stationRows);

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
        sessions: shouldSyncSessions
          ? upsertSplitStateIfChanged(
              upsertState,
              "sessions",
              sessionRows.length,
              sessionChecksum,
              sourceLastWriteAt,
              syncedAt
            )
          : false,
        stationStates: upsertSplitStateIfChanged(
          upsertState,
          "integration.stationStates",
          stationRows.length,
          stationChecksum,
          sourceLastWriteAt,
          syncedAt
        ),
        deviceStatus: upsertSplitStateIfChanged(
          upsertState,
          "deviceStatus",
          (shouldSyncSessions ? sessionRows.length : 0) + stationRows.length,
          checksum,
          sourceLastWriteAt,
          syncedAt
        ),
      };

      return {
        domain: "deviceStatus",
        mode,
        rowCount: (shouldSyncSessions ? sessionRows.length : 0) + stationRows.length,
        metadataUpdated,
        sessions: {
          rowCount: shouldSyncSessions ? sessionRows.length : null,
          checksum: sessionChecksum,
          ...sessionResult,
        },
        stationStates: {
          rowCount: stationRows.length,
          checksum: stationChecksum,
          ...stationResult,
        },
        checksum,
        syncedAt,
      };
    });
  }

  async function listSessions() {
    if (!enabled) return [];
    await ensure();
    const rows = db
      .prepare(
        `
          SELECT raw_json
          FROM app_state_sessions
          ORDER BY app_state_position ASC, last_seen_at DESC, id ASC
        `
      )
      .all();
    return rows.map(rowToSession).filter((entry) => entry && typeof entry === "object");
  }

  async function listStationStates() {
    if (!enabled) return [];
    await ensure();
    const rows = db
      .prepare(
        `
          SELECT raw_json
          FROM app_state_integration_station_states
          ORDER BY app_state_position ASC, updated_at_ms DESC, station ASC, id ASC
        `
      )
      .all();
    return rows.map(rowToStationState).filter((entry) => entry && typeof entry === "object");
  }

  async function upsertStationState(entry) {
    if (!enabled) return null;
    await ensure();
    const normalizedForId = normalizeStationState(entry, 0);
    if (!normalizedForId) return null;
    const existing = db
      .prepare("SELECT app_state_position FROM app_state_integration_station_states WHERE id = ?")
      .get(normalizedForId.id);
    const maxRow = db
      .prepare("SELECT COALESCE(MAX(app_state_position), -1) AS max_position FROM app_state_integration_station_states")
      .get();
    const position =
      Number.isFinite(Number(existing?.app_state_position))
        ? normalizeInteger(existing.app_state_position, 0)
        : normalizeInteger(maxRow?.max_position, -1) + 1;
    const row = normalizeStationState(entry, position);
    if (!row) return null;
    const syncedAt = nowIso();

    return runTransaction(() => {
      db.prepare(
        `
          INSERT INTO app_state_integration_station_states (
            id,
            station,
            active,
            stale,
            real_station,
            configured_station,
            is_demo_fallback,
            client_app,
            device_uuid,
            operator_user_id,
            operator_username,
            operator_name,
            operator_role,
            auto_print_orders,
            auto_print_preconto,
            updated_at_value,
            updated_at_ms,
            app_state_position,
            raw_json,
            row_hash,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            station = excluded.station,
            active = excluded.active,
            stale = excluded.stale,
            real_station = excluded.real_station,
            configured_station = excluded.configured_station,
            is_demo_fallback = excluded.is_demo_fallback,
            client_app = excluded.client_app,
            device_uuid = excluded.device_uuid,
            operator_user_id = excluded.operator_user_id,
            operator_username = excluded.operator_username,
            operator_name = excluded.operator_name,
            operator_role = excluded.operator_role,
            auto_print_orders = excluded.auto_print_orders,
            auto_print_preconto = excluded.auto_print_preconto,
            updated_at_value = excluded.updated_at_value,
            updated_at_ms = excluded.updated_at_ms,
            app_state_position = excluded.app_state_position,
            raw_json = excluded.raw_json,
            row_hash = excluded.row_hash,
            updated_at = CURRENT_TIMESTAMP
        `
      ).run(
        row.id,
        row.station,
        row.active,
        row.stale,
        row.realStation,
        row.configuredStation,
        row.isDemoFallback,
        row.clientApp,
        row.deviceUuid,
        row.operatorUserId,
        row.operatorUsername,
        row.operatorName,
        row.operatorRole,
        row.autoPrintOrders,
        row.autoPrintPreconto,
        row.updatedAt,
        row.updatedAtMs,
        row.appStatePosition,
        row.rawJson,
        row.rowHash
      );

      const stationCount = db
        .prepare("SELECT COUNT(*) AS count FROM app_state_integration_station_states")
        .get();
      const sessionCount = db.prepare("SELECT COUNT(*) AS count FROM app_state_sessions").get();
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
      upsertState.run("integration.stationStates", mode, Number(stationCount?.count ?? 0), null, row.updatedAt, syncedAt);
      upsertState.run(
        "deviceStatus",
        mode,
        Number(stationCount?.count ?? 0) + Number(sessionCount?.count ?? 0),
        null,
        row.updatedAt,
        syncedAt
      );

      return {
        id: row.id,
        rowCount: Number(stationCount?.count ?? 0),
        syncedAt,
      };
    });
  }

  async function hydrateAppState(appState) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    await ensure();
    const sessionsCountRow = db.prepare("SELECT COUNT(*) AS count FROM app_state_sessions").get();
    const stationStatesCountRow = db.prepare("SELECT COUNT(*) AS count FROM app_state_integration_station_states").get();
    const sessionsCount = Number(sessionsCountRow?.count ?? 0);
    const stationStatesCount = Number(stationStatesCountRow?.count ?? 0);
    if (sessionsCount <= 0 && stationStatesCount <= 0) {
      const hasJsonSessions = Array.isArray(appState.sessions) && appState.sessions.length > 0;
      const hasJsonStationStates =
        Array.isArray(appState.integration?.stationStates) && appState.integration.stationStates.length > 0;
      if (hasJsonSessions || hasJsonStationStates) {
        await syncFromAppState(appState);
      }
      return appState;
    }

    const hydrated = clone(appState, appState);
    if (sessionsCount > 0) {
      hydrated.sessions = await listSessions();
    }
    if (!hydrated.integration || typeof hydrated.integration !== "object") {
      hydrated.integration = {};
    }
    if (stationStatesCount > 0) {
      hydrated.integration.stationStates = await listStationStates();
    }
    return hydrated;
  }

  function stripDeviceStatusFromAppState(appState, options = {}) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    const persisted = clone(appState, appState);
    persisted.sessions = [];
    if (persisted.integration && typeof persisted.integration === "object") {
      persisted.integration.stationStates = [];
    }
    if (persisted.meta && typeof persisted.meta === "object") {
      persisted.meta.appStateSplitDomains = {
        ...(persisted.meta.appStateSplitDomains && typeof persisted.meta.appStateSplitDomains === "object"
          ? persisted.meta.appStateSplitDomains
          : {}),
        deviceStatus: {
          mode: "externalized",
          storage: "sqlite",
          domains: ["sessions", "integration.stationStates"],
          ...(options.includeUpdatedAt ? { updatedAt: nowIso() } : {}),
        },
      };
    }
    return persisted;
  }

  async function prepareAppStateForPrimaryWrite(appState) {
    return stripDeviceStatusFromAppState(appState, { includeUpdatedAt: true });
  }

  async function prepareAppStateForPersistenceComparison(appState) {
    return stripDeviceStatusFromAppState(appState, { includeUpdatedAt: false });
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
    listSessions,
    listStationStates,
    mode,
    prepareAppStateForPersistenceComparison,
    prepareAppStateForPrimaryWrite,
    syncFromAppState,
    upsertStationState,
  };
}
