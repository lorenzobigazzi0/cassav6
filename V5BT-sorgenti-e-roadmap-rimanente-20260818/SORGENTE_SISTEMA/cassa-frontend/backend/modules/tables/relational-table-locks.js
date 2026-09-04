import { TablesBillsRelationalRepository } from "../../db/relational/index.js";

export function createRelationalTableLockCoordinator(options = {}) {
  const {
    HttpError,
    appendAudit,
    canOverride = () => false,
    getDb,
    heartbeatWriteMinIntervalMs = 0,
    nowIso = () => new Date().toISOString(),
    resolveContext,
    sanitizeLock,
    tableLockTtlMs = 120_000,
  } = options;

  function repository() {
    const db = typeof getDb === "function" ? getDb() : null;
    if (!db) throw new HttpError(503, "DB relazionale tavoli non disponibile.");
    return new TablesBillsRelationalRepository(db);
  }

  function mirrorLock(db, tableInfo, lock) {
    const table = { ...tableInfo.table, workLock: lock };
    db.posSettings = {
      ...tableInfo.settings,
      tables: tableInfo.settings.tables.map((entry) =>
        entry.id === table.id ? table : entry,
      ),
    };
    return { ...tableInfo, table };
  }

  function clearLock(db, tableInfo) {
    const table = { ...tableInfo.table, workLock: null };
    db.posSettings = {
      ...tableInfo.settings,
      tables: tableInfo.settings.tables.map((entry) =>
        entry.id === table.id ? table : entry,
      ),
    };
    return { ...tableInfo, table };
  }

  async function acquire(db, tableId, context = {}) {
    const { user, session, payload = {}, purpose = "table_mutation", forceHeartbeat = false } = context;
    const { actor, tableInfo } = resolveContext(db, tableId, { user, payload });
    const nowMs = Date.now();
    const result = repository().acquireTableLock({
      tableId: tableInfo.table.id,
      userId: user.id,
      username: user.username || user.fullName || user.id,
      deviceUuid: session.deviceUuid ?? payload.deviceUuid,
      sessionId: session.id ?? payload.sessionId,
      purpose,
      nowMs,
      expiresAtMs: nowMs + tableLockTtlMs,
      heartbeatMinIntervalMs: heartbeatWriteMinIntervalMs,
      forceHeartbeat,
    });
    if (result?.reason === "conflict") {
      appendAudit(db, "table.lock_denied", { actor, tableInfo, previousLock: result.lock, nextLock: result.lock });
      throw new HttpError(409, `Il tavolo è già in modifica da ${result.lock?.username ?? result.lock?.userId ?? "un altro operatore"}.`, { code: "TABLE_LOCKED", details: { lockedByUsername: result.lock?.username, purpose: result.lock?.purpose, expiresAt: result.lock?.expiresAt } });
    }
    if (result?.reason === "missing") throw new HttpError(404, "Tavolo non trovato.");
    if (!result?.ok) throw new HttpError(400, "Lock tavolo non valido.");
    const lock = sanitizeLock(result.lock);
    const mirrored = mirrorLock(db, tableInfo, lock);
    if (result.changed !== false) {
      appendAudit(db, result.previousLock ? "table.lock_heartbeat" : "table.lock_acquired", {
        actor,
        tableInfo: mirrored,
        previousLock: result.previousLock ?? null,
        nextLock: lock,
      });
    }
    return { changed: result.changed !== false, lock, tableInfo: mirrored };
  }

  async function release(db, tableId, context = {}) {
    const { user, session, payload = {}, force = false } = context;
    const { actor, tableInfo } = resolveContext(db, tableId, { user, payload });
    if (force && !canOverride(user)) throw new HttpError(403, "Permesso insufficiente per forzare il rilascio del tavolo.");
    const result = repository().releaseTableLock({
      tableId: tableInfo.table.id,
      userId: user.id,
      deviceUuid: session.deviceUuid ?? payload.deviceUuid,
      sessionId: session.id ?? payload.sessionId,
      force,
    });
    if (result?.reason === "forbidden") throw new HttpError(403, "Solo l'operatore che ha il lock puo rilasciarlo.");
    if (!result?.ok) throw new HttpError(400, "Lock tavolo non valido.");
    const mirrored = clearLock(db, tableInfo);
    if (result.released) {
      appendAudit(db, force ? "table.lock_force_released" : "table.lock_released", {
        actor,
        tableInfo: mirrored,
        previousLock: result.previousLock ?? null,
        nextLock: null,
      });
    }
    return { released: Boolean(result.released), previousLock: result.previousLock ?? null, tableInfo: mirrored };
  }

  return { acquire, release };
}
