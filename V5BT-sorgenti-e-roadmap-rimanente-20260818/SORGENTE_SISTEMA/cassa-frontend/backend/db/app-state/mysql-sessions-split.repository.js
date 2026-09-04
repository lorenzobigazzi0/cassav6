import { createHash } from "node:crypto";

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeIdentifier(value, fallback) {
  const identifier = String(value ?? fallback ?? "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(
      `Identificatore MySQL non valido: ${identifier || "(vuoto)"}`,
    );
  }
  return identifier;
}

function quoteIdentifier(identifier) {
  return `\`${identifier}\``;
}

function safeJsonStringify(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function safeJsonParse(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex");
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeSessionIdList(values = []) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeSession(session, position) {
  if (!session || typeof session !== "object") return null;
  const id = String(
    session.id ?? session.sessionId ?? `session_${position}`,
  ).trim();
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
    stationName: normalizeNullableString(
      session.stationName ?? session.station,
    ),
    createdAt: normalizeNullableString(session.createdAt),
    lastSeenAt: normalizeNullableString(
      session.lastSeenAt ?? session.createdAt,
    ),
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

export function createMysqlSessionsSplitRepository(options = {}) {
  const enabled = normalizeBoolean(options.enabled, false);
  const tableName = normalizeIdentifier(
    options.tableName,
    "app_state_sessions",
  );
  const tableSql = quoteIdentifier(tableName);
  const logger = options.logger ?? console;
  const mysqlRepository = options.mysqlRepository;
  let ensured = false;

  async function query(sql, params = []) {
    if (!mysqlRepository || typeof mysqlRepository.query !== "function") {
      throw new Error("Repository MySQL non disponibile per split sessioni.");
    }
    return mysqlRepository.query(sql, params);
  }

  async function withConnection(callback) {
    const pool = await mysqlRepository.getPool();
    const connection = await pool.getConnection();
    try {
      return await callback(connection);
    } finally {
      connection.release();
    }
  }

  async function ensure() {
    if (!enabled || ensured) return;
    await query(`
      CREATE TABLE IF NOT EXISTS ${tableSql} (
        id VARCHAR(96) NOT NULL PRIMARY KEY,
        user_id VARCHAR(96) NULL,
        username VARCHAR(128) NULL,
        token_hash VARCHAR(160) NULL,
        device_uuid VARCHAR(160) NULL,
        client_app VARCHAR(80) NULL,
        room_id VARCHAR(128) NULL,
        room_name VARCHAR(160) NULL,
        station_name VARCHAR(160) NULL,
        created_at_value VARCHAR(64) NULL,
        last_seen_at VARCHAR(64) NULL,
        expires_at VARCHAR(64) NULL,
        app_state_position INT NOT NULL DEFAULT 0,
        row_hash CHAR(64) NOT NULL,
        raw_json JSON NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_app_state_sessions_token_hash (token_hash),
        INDEX idx_app_state_sessions_device (device_uuid, client_app),
        INDEX idx_app_state_sessions_user (user_id, client_app),
        INDEX idx_app_state_sessions_last_seen (last_seen_at),
        INDEX idx_app_state_sessions_position (app_state_position)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    ensured = true;
  }

  async function listSessions() {
    if (!enabled) return [];
    await ensure();
    const rows = await query(
      `SELECT * FROM ${tableSql} ORDER BY app_state_position ASC, created_at_value ASC, id ASC`,
    );
    return (Array.isArray(rows) ? rows : [])
      .map(rowToSession)
      .filter((entry) => entry?.id);
  }

  async function findSessionByTokenHash(options = {}) {
    if (!enabled) return null;
    const tokenHash = String(options.tokenHash ?? "").trim();
    const deviceUuid = String(options.deviceUuid ?? "").trim();
    if (!tokenHash || !deviceUuid) return null;
    await ensure();
    const rows = await query(
      `SELECT * FROM ${tableSql} WHERE token_hash = ? AND device_uuid = ? ORDER BY last_seen_at DESC, id ASC LIMIT 1`,
      [tokenHash, deviceUuid],
    );
    const session = rowToSession(Array.isArray(rows) ? rows[0] : null);
    return session?.id ? session : null;
  }

  async function upsertSessionRows(connection, rows, existing = new Map()) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || existing.get(row.id) === row.rowHash) continue;
      await connection.query(
        `
          INSERT INTO ${tableSql} (
            id, user_id, username, token_hash, device_uuid, client_app,
            room_id, room_name, station_name, created_at_value, last_seen_at,
            expires_at, app_state_position, row_hash, raw_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            user_id = VALUES(user_id),
            username = VALUES(username),
            token_hash = VALUES(token_hash),
            device_uuid = VALUES(device_uuid),
            client_app = VALUES(client_app),
            room_id = VALUES(room_id),
            room_name = VALUES(room_name),
            station_name = VALUES(station_name),
            created_at_value = VALUES(created_at_value),
            last_seen_at = VALUES(last_seen_at),
            expires_at = VALUES(expires_at),
            app_state_position = VALUES(app_state_position),
            row_hash = VALUES(row_hash),
            raw_json = VALUES(raw_json)
        `,
        [
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
          row.rowHash,
          row.rawJson,
        ],
      );
    }
  }

  async function updateSessionRows(connection, rows) {
    let matchedRows = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row) continue;
      const [result] = await connection.query(
        `
          UPDATE ${tableSql}
          SET user_id = ?, username = ?, token_hash = ?, device_uuid = ?,
              client_app = ?, room_id = ?, room_name = ?, station_name = ?,
              created_at_value = ?, last_seen_at = ?, expires_at = ?,
              app_state_position = ?, row_hash = ?, raw_json = ?
          WHERE id = ?
        `,
        [
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
          row.rowHash,
          row.rawJson,
          row.id,
        ],
      );
      matchedRows += Math.max(
        0,
        Number(result?.affectedRows ?? result?.changedRows) || 0,
      );
    }
    return matchedRows;
  }

  async function syncFromAppState(appState, options = {}) {
    if (!enabled || !appState || typeof appState !== "object") return;
    await ensure();
    const deleteMissing = options.deleteMissing !== false;
    const sessions = Array.isArray(appState.sessions) ? appState.sessions : [];
    const rows = sessions
      .map((session, index) => normalizeSession(session, index))
      .filter(Boolean);
    const deleteSessionIds = normalizeSessionIdList(options.deleteSessionIds ?? options.deletedSessionIds);
    await withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [existingRows] = await connection.query(
          `SELECT id, row_hash FROM ${tableSql}`,
        );
        const existing = new Map(
          (Array.isArray(existingRows) ? existingRows : []).map((row) => [
            String(row.id ?? ""),
            String(row.row_hash ?? ""),
          ]),
        );
        const nextIds = new Set(rows.map((row) => row.id));
        for (const id of deleteSessionIds) {
          if (!nextIds.has(id)) {
            await connection.query(`DELETE FROM ${tableSql} WHERE id = ?`, [
              id,
            ]);
            existing.delete(id);
          }
        }
        if (deleteMissing) {
          for (const id of existing.keys()) {
            if (!nextIds.has(id)) {
              await connection.query(`DELETE FROM ${tableSql} WHERE id = ?`, [
                id,
              ]);
            }
          }
        }
        await upsertSessionRows(connection, rows, existing);
        await connection.commit();
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // noop
        }
        throw error;
      }
    });
  }

  async function syncEntriesFromAppState(appState, sessionIds = []) {
    if (!enabled || !appState || typeof appState !== "object") return;
    const wantedIds = new Set(normalizeSessionIdList(sessionIds));
    if (wantedIds.size === 0) return;
    await ensure();
    const rows = (Array.isArray(appState.sessions) ? appState.sessions : [])
      .map((session, index) => normalizeSession(session, index))
      .filter((row) => row && wantedIds.has(row.id));
    if (rows.length === 0) return;
    await withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [existingRows] = await connection.query(
          `SELECT id, row_hash FROM ${tableSql}`,
        );
        const existing = new Map(
          (Array.isArray(existingRows) ? existingRows : []).map((row) => [
            String(row.id ?? ""),
            String(row.row_hash ?? ""),
          ]),
        );
        await upsertSessionRows(connection, rows, existing);
        await connection.commit();
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // noop
        }
        throw error;
      }
    });
  }

  async function updateEntriesFromAppState(appState, sessionIds = []) {
    if (!enabled || !appState || typeof appState !== "object") return 0;
    const wantedIds = new Set(normalizeSessionIdList(sessionIds));
    if (wantedIds.size === 0) return 0;
    await ensure();
    const rows = (Array.isArray(appState.sessions) ? appState.sessions : [])
      .map((session, index) => normalizeSession(session, index))
      .filter((row) => row && wantedIds.has(row.id));
    if (rows.length === 0) return 0;
    return withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const matchedRows = await updateSessionRows(connection, rows);
        await connection.commit();
        return matchedRows;
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // noop
        }
        throw error;
      }
    });
  }

  async function deleteSessions(sessionIds = []) {
    if (!enabled) return;
    const ids = normalizeSessionIdList(sessionIds);
    if (ids.length === 0) return;
    await ensure();
    await withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        for (const id of ids) {
          await connection.query(`DELETE FROM ${tableSql} WHERE id = ?`, [id]);
        }
        await connection.commit();
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // noop
        }
        throw error;
      }
    });
  }

  async function hydrateAppState(appState) {
    if (!enabled || !appState || typeof appState !== "object") return appState;
    await ensure();
    const rows = await listSessions();
    if (rows.length === 0) {
      const hasJsonSessions =
        Array.isArray(appState.sessions) && appState.sessions.length > 0;
      if (hasJsonSessions) {
        await syncFromAppState(appState);
      }
      return appState;
    }
    return {
      ...appState,
      sessions: rows,
    };
  }

  function stripSessionsFromAppState(appState, options = {}) {
    if (!enabled || !appState || typeof appState !== "object") return appState;
    const persisted = cloneJson(appState, appState);
    persisted.sessions = [];
    if (persisted.meta && typeof persisted.meta === "object") {
      persisted.meta.appStateSplitDomains = {
        ...(persisted.meta.appStateSplitDomains &&
        typeof persisted.meta.appStateSplitDomains === "object"
          ? persisted.meta.appStateSplitDomains
          : {}),
        sessions: {
          mode: "externalized",
          storage: "mysql",
          table: tableName,
          ...(options.includeUpdatedAt
            ? { updatedAt: new Date().toISOString() }
            : {}),
        },
      };
    }
    return persisted;
  }

  async function prepareAppStateForPrimaryWrite(appState) {
    return stripSessionsFromAppState(appState, { includeUpdatedAt: true });
  }

  async function prepareAppStateForPersistenceComparison(appState) {
    return stripSessionsFromAppState(appState, { includeUpdatedAt: false });
  }

  function logStatus() {
    if (enabled) {
      logger.info?.(
        `[backend] MySQL split sessioni attivo: tabella ${tableName}`,
      );
    }
  }

  return {
    enabled,
    findSessionByTokenHash,
    hydrateAppState,
    logStatus,
    prepareAppStateForPersistenceComparison,
    prepareAppStateForPrimaryWrite,
    deleteSessions,
    syncEntriesFromAppState,
    syncFromAppState,
    updateEntriesFromAppState,
  };
}
