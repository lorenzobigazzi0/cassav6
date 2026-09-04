import { createHash, randomUUID } from "node:crypto";

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

function normalizeAuditEvent(event, position) {
  if (!event || typeof event !== "object") return null;
  const id = String(event.id ?? `audit_event_${position}`).trim();
  if (!id) return null;
  const rawJson = safeJsonStringify(event, {});
  return {
    id,
    occurredAt: normalizeNullableString(event.occurredAt),
    action: normalizeNullableString(event.action),
    entityType: normalizeNullableString(event.entityType),
    entityId: normalizeNullableString(event.entityId),
    actorUserId: normalizeNullableString(event.actorUserId),
    actorRole: normalizeNullableString(event.actorRole),
    roomId: normalizeNullableString(event.roomId),
    deviceId: normalizeNullableString(event.deviceId),
    deletedAt: normalizeNullableString(event.deletedAt),
    appStatePosition: position,
    rawJson,
    rowHash: sha256(rawJson),
  };
}

function rowToAuditEvent(row) {
  const parsed = safeJsonParse(row?.raw_json, null);
  if (parsed && typeof parsed === "object") return parsed;
  return {
    id: String(row?.id ?? ""),
    occurredAt: String(row?.occurred_at ?? ""),
    actorUserId: String(row?.actor_user_id ?? "system"),
    actorRole: String(row?.actor_role ?? "system"),
    roomId: row?.room_id ? String(row.room_id) : null,
    deviceId: row?.device_id ? String(row.device_id) : null,
    action: String(row?.action ?? ""),
    entityType: String(row?.entity_type ?? ""),
    entityId: String(row?.entity_id ?? ""),
    deletedAt: row?.deleted_at ? String(row.deleted_at) : null,
  };
}

export function createMysqlAuditEventsSplitRepository(options = {}) {
  const enabled = normalizeBoolean(options.enabled, false);
  const tableName = normalizeIdentifier(
    options.tableName,
    "app_state_audit_events",
  );
  const tableSql = quoteIdentifier(tableName);
  const logger = options.logger ?? console;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const mysqlRepository = options.mysqlRepository;
  let ensured = false;

  async function query(sql, params = []) {
    if (!mysqlRepository || typeof mysqlRepository.query !== "function") {
      throw new Error("Repository MySQL non disponibile per split audit.");
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
        occurred_at VARCHAR(64) NULL,
        action VARCHAR(160) NULL,
        entity_type VARCHAR(120) NULL,
        entity_id VARCHAR(160) NULL,
        actor_user_id VARCHAR(96) NULL,
        actor_role VARCHAR(80) NULL,
        room_id VARCHAR(128) NULL,
        device_id VARCHAR(160) NULL,
        deleted_at VARCHAR(64) NULL,
        app_state_position INT NOT NULL DEFAULT 0,
        row_hash CHAR(64) NOT NULL,
        raw_json JSON NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_app_state_audit_events_position (app_state_position),
        INDEX idx_app_state_audit_events_occurred_at (occurred_at),
        INDEX idx_app_state_audit_events_action (action),
        INDEX idx_app_state_audit_events_entity (entity_type, entity_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    ensured = true;
  }

  function auditRowParams(row) {
    return [
      row.id,
      row.occurredAt,
      row.action,
      row.entityType,
      row.entityId,
      row.actorUserId,
      row.actorRole,
      row.roomId,
      row.deviceId,
      row.deletedAt,
      row.appStatePosition,
      row.rowHash,
      row.rawJson,
    ];
  }

  async function upsertAuditRows(connection, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const placeholders = rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    await connection.query(
      `
        INSERT INTO ${tableSql} (
          id, occurred_at, action, entity_type, entity_id, actor_user_id,
          actor_role, room_id, device_id, deleted_at, app_state_position,
          row_hash, raw_json
        )
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          occurred_at = VALUES(occurred_at),
          action = VALUES(action),
          entity_type = VALUES(entity_type),
          entity_id = VALUES(entity_id),
          actor_user_id = VALUES(actor_user_id),
          actor_role = VALUES(actor_role),
          room_id = VALUES(room_id),
          device_id = VALUES(device_id),
          deleted_at = VALUES(deleted_at),
          app_state_position = VALUES(app_state_position),
          row_hash = VALUES(row_hash),
          raw_json = VALUES(raw_json)
      `,
      rows.flatMap(auditRowParams),
    );
  }

  async function listAuditEvents() {
    if (!enabled) return [];
    await ensure();
    const rows = await query(
      `SELECT * FROM ${tableSql} ORDER BY app_state_position ASC, occurred_at ASC, id ASC`,
    );
    return (Array.isArray(rows) ? rows : [])
      .map(rowToAuditEvent)
      .filter((entry) => entry && typeof entry === "object");
  }

  async function syncFromAppState(appState) {
    if (!enabled || !appState || typeof appState !== "object") return;
    await ensure();
    const events = Array.isArray(appState.auditEvents)
      ? appState.auditEvents
      : [];
    const rows = events
      .map((event, index) => normalizeAuditEvent(event, index))
      .filter(Boolean);
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
        for (const id of existing.keys()) {
          if (!nextIds.has(id)) {
            await connection.query(`DELETE FROM ${tableSql} WHERE id = ?`, [
              id,
            ]);
          }
        }
        await upsertAuditRows(connection, rows.filter((row) => existing.get(row.id) !== row.rowHash));
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

  async function syncRecentFromAppState(appState, limit = 64) {
    if (!enabled || !appState || typeof appState !== "object") return;
    await ensure();
    const events = Array.isArray(appState.auditEvents) ? appState.auditEvents : [];
    const safeLimit = Math.max(1, Math.min(Math.trunc(Number(limit) || 64), 500));
    const offset = Math.max(events.length - safeLimit, 0);
    const rows = events.slice(offset).map((event, index) => normalizeAuditEvent(event, offset + index)).filter(Boolean);
    if (rows.length === 0) return;
    await withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        await upsertAuditRows(connection, rows);
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

  async function syncEntriesFromAppState(appState, eventIds = [], options = {}) {
    if (!enabled || !appState || typeof appState !== "object") return 0;
    await ensure();
    const wantedIds = new Set((Array.isArray(eventIds) ? eventIds : []).map((entry) => String(entry ?? "").trim()).filter(Boolean));
    if (wantedIds.size === 0) return 0;
    const events = Array.isArray(appState.auditEvents) ? appState.auditEvents : [];
    const rows = [];
    for (let index = events.length - 1; index >= 0 && wantedIds.size > 0; index -= 1) {
      const event = events[index];
      const eventId = String(event?.id ?? `audit_event_${index}`).trim();
      if (!wantedIds.has(eventId)) continue;
      wantedIds.delete(eventId);
      const row = normalizeAuditEvent(event, index);
      if (row) rows.push(row);
    }
    if (rows.length === 0) return 0;
    rows.reverse();
    if (options.connection) {
      await upsertAuditRows(options.connection, rows);
      return rows.length;
    }
    await withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        await upsertAuditRows(connection, rows);
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
    return rows.length;
  }

  async function appendEvent(event) {
    if (!enabled || !event || typeof event !== "object") return false;
    await ensure();
    const id =
      String(event.id ?? "").trim() ||
      `audit_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const occurredAt =
      normalizeNullableString(event.occurredAt) ?? nowIso();
    const normalized = normalizeAuditEvent(
      {
        ...event,
        id,
        occurredAt,
      },
      0,
    );
    if (!normalized) return false;
    await withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [positionRows] = await connection.query(
          `SELECT COALESCE(MAX(app_state_position), -1) + 1 AS next_position FROM ${tableSql}`,
        );
        const nextPosition = Number(positionRows?.[0]?.next_position ?? 0);
        await connection.query(
          `
            INSERT INTO ${tableSql} (
              id, occurred_at, action, entity_type, entity_id, actor_user_id,
              actor_role, room_id, device_id, deleted_at, app_state_position,
              row_hash, raw_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              occurred_at = VALUES(occurred_at),
              action = VALUES(action),
              entity_type = VALUES(entity_type),
              entity_id = VALUES(entity_id),
              actor_user_id = VALUES(actor_user_id),
              actor_role = VALUES(actor_role),
              room_id = VALUES(room_id),
              device_id = VALUES(device_id),
              deleted_at = VALUES(deleted_at),
              app_state_position = VALUES(app_state_position),
              row_hash = VALUES(row_hash),
              raw_json = VALUES(raw_json)
          `,
          [
            normalized.id,
            normalized.occurredAt,
            normalized.action,
            normalized.entityType,
            normalized.entityId,
            normalized.actorUserId,
            normalized.actorRole,
            normalized.roomId,
            normalized.deviceId,
            normalized.deletedAt,
            nextPosition,
            normalized.rowHash,
            normalized.rawJson,
          ],
        );
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
    return true;
  }

  async function hydrateAppState(appState) {
    if (!enabled || !appState || typeof appState !== "object") return appState;
    await ensure();
    const rows = await listAuditEvents();
    if (rows.length === 0) {
      if (
        Array.isArray(appState.auditEvents) &&
        appState.auditEvents.length > 0
      ) {
        await syncFromAppState(appState);
      }
      return appState;
    }
    return {
      ...appState,
      auditEvents: rows,
    };
  }

  function stripAuditEventsFromAppState(appState, options = {}) {
    if (!enabled || !appState || typeof appState !== "object") return appState;
    const persisted = cloneJson(appState, appState);
    persisted.auditEvents = [];
    if (persisted.meta && typeof persisted.meta === "object") {
      persisted.meta.appStateSplitDomains = {
        ...(persisted.meta.appStateSplitDomains &&
        typeof persisted.meta.appStateSplitDomains === "object"
          ? persisted.meta.appStateSplitDomains
          : {}),
        auditEvents: {
          mode: "externalized",
          storage: "mysql",
          table: tableName,
          ...(options.includeUpdatedAt ? { updatedAt: nowIso() } : {}),
        },
      };
    }
    return persisted;
  }

  async function prepareAppStateForPrimaryWrite(appState) {
    return stripAuditEventsFromAppState(appState, { includeUpdatedAt: true });
  }

  async function prepareAppStateForPersistenceComparison(appState) {
    return stripAuditEventsFromAppState(appState, { includeUpdatedAt: false });
  }

  function logStatus() {
    if (enabled) {
      logger.info?.(`[backend] MySQL split audit attivo: tabella ${tableName}`);
    }
  }

  return {
    appendEvent,
    enabled,
    hydrateAppState,
    listAuditEvents,
    logStatus,
    prepareAppStateForPersistenceComparison,
    prepareAppStateForPrimaryWrite,
    syncEntriesFromAppState,
    syncFromAppState,
    syncRecentFromAppState,
    ensureStorage: ensure,
  };
}
