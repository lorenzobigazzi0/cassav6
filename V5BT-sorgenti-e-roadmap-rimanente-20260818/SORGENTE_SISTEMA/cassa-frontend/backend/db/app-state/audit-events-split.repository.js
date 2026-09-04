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
      `BACKEND_APP_STATE_SPLIT_AUDIT_EVENTS non valido: '${mode}'. Valori ammessi: off, shadow, externalized.`
    );
  }
  return mode;
}

function normalizeAuditEvent(event, position) {
  if (!event || typeof event !== "object") return null;
  const id = String(event.id ?? `audit_event_${position}`).trim();
  if (!id) return null;
  const rawJson = safeJsonStringify(event, {});
  return {
    id,
    occurredAt: String(event.occurredAt ?? new Date().toISOString()),
    action: String(event.action ?? "").trim(),
    entityType: String(event.entityType ?? "").trim(),
    entityId: String(event.entityId ?? "").trim(),
    actorUserId: String(event.actorUserId ?? "system"),
    actorRole: String(event.actorRole ?? "system"),
    roomId: event.roomId ? String(event.roomId) : null,
    deviceId: event.deviceId ? String(event.deviceId) : null,
    deletedAt: event.deletedAt ? String(event.deletedAt) : null,
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

function buildChecksum(rows) {
  return sha256(JSON.stringify(rows.map((row) => [row.id, row.rowHash, row.appStatePosition])));
}

export async function loadAuditEventsSplitDatabaseSync() {
  if (!DatabaseSyncClass) {
    const sqliteModule = await import("node:sqlite");
    DatabaseSyncClass = sqliteModule.DatabaseSync;
  }
  return DatabaseSyncClass;
}

export function normalizeAuditEventsSplitMode(value) {
  return normalizeMode(value);
}

export function createAuditEventsSplitRepository(options = {}) {
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
    const DatabaseSync = await loadAuditEventsSplitDatabaseSync();
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

      CREATE TABLE IF NOT EXISTS app_state_audit_events (
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        action TEXT,
        entity_type TEXT,
        entity_id TEXT,
        actor_user_id TEXT,
        actor_role TEXT,
        room_id TEXT,
        device_id TEXT,
        deleted_at TEXT,
        app_state_position INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        row_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_state_audit_events_position
        ON app_state_audit_events(app_state_position);

      CREATE INDEX IF NOT EXISTS idx_app_state_audit_events_occurred_at
        ON app_state_audit_events(occurred_at);

      CREATE INDEX IF NOT EXISTS idx_app_state_audit_events_action
        ON app_state_audit_events(action);

      CREATE INDEX IF NOT EXISTS idx_app_state_audit_events_entity
        ON app_state_audit_events(entity_type, entity_id);
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

  async function syncFromAppState(appState) {
    if (!enabled) return null;
    await ensure();
    const events = Array.isArray(appState?.auditEvents) ? appState.auditEvents : [];
    const rows = events.map((event, index) => normalizeAuditEvent(event, index)).filter(Boolean);
    const checksum = buildChecksum(rows);
    const syncedAt = nowIso();
    const sourceLastWriteAt =
      typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim()
        ? appState.meta.lastWriteAt
        : null;

    return runTransaction(() => {
      const existingRows = db.prepare("SELECT id, row_hash FROM app_state_audit_events").all();
      const existingHashes = new Map(existingRows.map((row) => [String(row.id), String(row.row_hash ?? "")]));
      const nextIds = new Set(rows.map((row) => row.id));
      const insertOrReplace = db.prepare(`
        INSERT INTO app_state_audit_events (
          id,
          occurred_at,
          action,
          entity_type,
          entity_id,
          actor_user_id,
          actor_role,
          room_id,
          device_id,
          deleted_at,
          app_state_position,
          raw_json,
          row_hash,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          occurred_at = excluded.occurred_at,
          action = excluded.action,
          entity_type = excluded.entity_type,
          entity_id = excluded.entity_id,
          actor_user_id = excluded.actor_user_id,
          actor_role = excluded.actor_role,
          room_id = excluded.room_id,
          device_id = excluded.device_id,
          deleted_at = excluded.deleted_at,
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
              UPDATE app_state_audit_events
              SET app_state_position = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND app_state_position <> ?
            `
          ).run(row.appStatePosition, row.id, row.appStatePosition);
          continue;
        }
        insertOrReplace.run(
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
          row.rawJson,
          row.rowHash
        );
        upserted += 1;
      }

      const deleteRow = db.prepare("DELETE FROM app_state_audit_events WHERE id = ?");
      let deleted = 0;
      for (const row of existingRows) {
        const id = String(row.id);
        if (!nextIds.has(id)) {
          deleteRow.run(id);
          deleted += 1;
        }
      }

      const stateStatement = db.prepare(
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
      const metadataUpdated = upsertSplitStateIfChanged(
        stateStatement,
        "auditEvents",
        rows.length,
        checksum,
        sourceLastWriteAt,
        syncedAt
      );

      return {
        domain: "auditEvents",
        mode,
        rowCount: rows.length,
        upserted,
        deleted,
        metadataUpdated,
        checksum,
        syncedAt,
      };
    });
  }

  async function syncRecentFromAppState(appState, limit = 64) {
    if (!enabled) return null;
    await ensure();
    const events = Array.isArray(appState?.auditEvents) ? appState.auditEvents : [];
    const safeLimit = Math.max(1, Math.min(Math.trunc(Number(limit) || 64), 500));
    const offset = Math.max(events.length - safeLimit, 0);
    const rows = events.slice(offset).map((event, index) => normalizeAuditEvent(event, offset + index)).filter(Boolean);
    if (rows.length === 0) return null;
    return runTransaction(() => {
      const insertOrReplace = db.prepare(`
        INSERT INTO app_state_audit_events (
          id, occurred_at, action, entity_type, entity_id, actor_user_id,
          actor_role, room_id, device_id, deleted_at, app_state_position,
          raw_json, row_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          occurred_at = excluded.occurred_at,
          action = excluded.action,
          entity_type = excluded.entity_type,
          entity_id = excluded.entity_id,
          actor_user_id = excluded.actor_user_id,
          actor_role = excluded.actor_role,
          room_id = excluded.room_id,
          device_id = excluded.device_id,
          deleted_at = excluded.deleted_at,
          app_state_position = excluded.app_state_position,
          raw_json = excluded.raw_json,
          row_hash = excluded.row_hash,
          updated_at = CURRENT_TIMESTAMP
      `);
      let upserted = 0;
      for (const row of rows) {
        insertOrReplace.run(row.id, row.occurredAt, row.action, row.entityType, row.entityId, row.actorUserId, row.actorRole, row.roomId, row.deviceId, row.deletedAt, row.appStatePosition, row.rawJson, row.rowHash);
        upserted += 1;
      }
      const countRow = db.prepare("SELECT COUNT(*) AS count FROM app_state_audit_events").get();
      return { domain: "auditEvents", mode, rowCount: Number(countRow?.count ?? 0), upserted, syncedAt: nowIso() };
    });
  }

  async function syncEntriesFromAppState(appState, eventIds = []) {
    if (!enabled) return null;
    await ensure();
    const wantedIds = new Set((Array.isArray(eventIds) ? eventIds : []).map((entry) => String(entry ?? "").trim()).filter(Boolean));
    if (wantedIds.size === 0) return null;
    const events = Array.isArray(appState?.auditEvents) ? appState.auditEvents : [];
    const rows = [];
    for (let index = events.length - 1; index >= 0 && wantedIds.size > 0; index -= 1) {
      const event = events[index];
      const eventId = String(event?.id ?? `audit_event_${index}`).trim();
      if (!wantedIds.has(eventId)) continue;
      wantedIds.delete(eventId);
      const row = normalizeAuditEvent(event, index);
      if (row) rows.push(row);
    }
    if (rows.length === 0) return null;
    rows.reverse();
    return runTransaction(() => {
      const insertOrReplace = db.prepare(`
        INSERT INTO app_state_audit_events (
          id, occurred_at, action, entity_type, entity_id, actor_user_id,
          actor_role, room_id, device_id, deleted_at, app_state_position,
          raw_json, row_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          occurred_at = excluded.occurred_at,
          action = excluded.action,
          entity_type = excluded.entity_type,
          entity_id = excluded.entity_id,
          actor_user_id = excluded.actor_user_id,
          actor_role = excluded.actor_role,
          room_id = excluded.room_id,
          device_id = excluded.device_id,
          deleted_at = excluded.deleted_at,
          app_state_position = excluded.app_state_position,
          raw_json = excluded.raw_json,
          row_hash = excluded.row_hash,
          updated_at = CURRENT_TIMESTAMP
      `);
      let upserted = 0;
      for (const row of rows) {
        insertOrReplace.run(row.id, row.occurredAt, row.action, row.entityType, row.entityId, row.actorUserId, row.actorRole, row.roomId, row.deviceId, row.deletedAt, row.appStatePosition, row.rawJson, row.rowHash);
        upserted += 1;
      }
      const countRow = db.prepare("SELECT COUNT(*) AS count FROM app_state_audit_events").get();
      return { domain: "auditEvents", mode, rowCount: Number(countRow?.count ?? 0), upserted, syncedAt: nowIso() };
    });
  }

  async function listAuditEvents() {
    if (!enabled) return [];
    await ensure();
    const rows = db
      .prepare(
        `
          SELECT raw_json
          FROM app_state_audit_events
          ORDER BY app_state_position ASC, occurred_at ASC, id ASC
        `
      )
      .all();
    return rows.map(rowToAuditEvent).filter((event) => event && typeof event === "object");
  }

  async function hydrateAppState(appState) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    await ensure();
    const countRow = db.prepare("SELECT COUNT(*) AS count FROM app_state_audit_events").get();
    const rowCount = Number(countRow?.count ?? 0);
    if (rowCount <= 0) {
      if (Array.isArray(appState.auditEvents) && appState.auditEvents.length > 0) {
        await syncFromAppState(appState);
      }
      return appState;
    }
    const hydrated = clone(appState, appState);
    hydrated.auditEvents = await listAuditEvents();
    return hydrated;
  }

  function stripAuditEventsFromAppState(appState, options = {}) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    const persisted = clone(appState, appState);
    persisted.auditEvents = [];
    if (persisted.meta && typeof persisted.meta === "object") {
      persisted.meta.appStateSplitDomains = {
        ...(persisted.meta.appStateSplitDomains && typeof persisted.meta.appStateSplitDomains === "object"
          ? persisted.meta.appStateSplitDomains
          : {}),
        auditEvents: {
          mode: "externalized",
          storage: "sqlite",
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
    listAuditEvents,
    mode,
    prepareAppStateForPersistenceComparison,
    prepareAppStateForPrimaryWrite,
    syncEntriesFromAppState,
    syncFromAppState,
    syncRecentFromAppState,
  };
}
