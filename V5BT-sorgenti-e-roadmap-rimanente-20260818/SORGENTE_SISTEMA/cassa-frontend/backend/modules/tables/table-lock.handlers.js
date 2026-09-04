/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createTableLockHandlers({
  RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY,
  HttpError,
  acquireOrRefreshRemovedOperationalTableWorkLock,
  acquireOrRefreshTableWorkLock,
  acquireOrRefreshTableWorkLockFast,
  assertActiveTableWorkLock,
  assertUserCanOperateInRemovedTableRoom,
  buildRemovedOperationalLockReleaseContext,
  clearEmbeddedTableWorkLock,
  findPosTableWithLayout,
  isTableWorkLockFastPathEnabled,
  nowIso,
  readJsonBody,
  readTableWorkLockRequestDb,
  relationalTableLockCoordinator,
  releaseRemovedOperationalTableWorkLock,
  releaseTableWorkLock,
  releaseTableWorkLockFast,
  resolveRemovedOperationalTableContext,
  sanitizePosSettings,
  sendJson,
  tableLockWorkerRequestFastPath,
  validateSessionContext,
  writeDb,
}) {
  async function handleTableLockAcquire(req, res) {
    const payload = await readJsonBody(req);
    const tableId = String(payload.tableId ?? "").trim();
    if (!tableId) {
      throw new HttpError(400, "Tavolo non valido.");
    }
    const db = await readTableWorkLockRequestDb(req);
    const authContext =
      req.__authContext && typeof req.__authContext === "object"
        ? req.__authContext
        : validateSessionContext(db, payload);
    const { user, session } = authContext;
    const lockSettings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    if (!findPosTableWithLayout(lockSettings, tableId)) {
      const removedContext = resolveRemovedOperationalTableContext(
        db,
        lockSettings,
        tableId,
        payload,
      );
      assertUserCanOperateInRemovedTableRoom(
        user,
        lockSettings,
        removedContext.tableInfo,
        { session },
      );
      const lockResult = acquireOrRefreshRemovedOperationalTableWorkLock(
        db,
        removedContext,
        {
          user,
          session,
          payload,
          purpose:
            String(payload.purpose ?? "manual_edit").trim() || "manual_edit",
        },
      );
      db.meta.lastWriteAt = nowIso();
      await writeDb(db, { splitDomains: ["tableLocks", "auditEvents"] });
      sendJson(res, 200, {
        ok: true,
        lock: lockResult.lock,
        table: lockResult.tableInfo?.table ?? null,
        removedFromConfiguration: true,
      });
      return;
    }
    const lockResult = RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY
      ? await relationalTableLockCoordinator.acquire(db, tableId, { user, session, payload, purpose: String(payload.purpose ?? "manual_edit").trim() || "manual_edit" })
      : isTableWorkLockFastPathEnabled()
      ? await acquireOrRefreshTableWorkLockFast(db, tableId, {
          user,
          session,
          payload,
          purpose:
            String(payload.purpose ?? "manual_edit").trim() || "manual_edit",
        })
      : acquireOrRefreshTableWorkLock(db, tableId, {
          user,
          session,
          payload,
          purpose:
            String(payload.purpose ?? "manual_edit").trim() || "manual_edit",
        });
    if (RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY || !isTableWorkLockFastPathEnabled()) {
      db.meta.lastWriteAt = nowIso();
      await writeDb(db);
    }
    sendJson(res, 200, {
      ok: true,
      lock: lockResult.lock,
      table: lockResult.tableInfo?.table ?? null,
    });
  }
  
  async function handleTableLockHeartbeat(req, res) {
    const payload = await readJsonBody(req);
    const tableId = String(payload.tableId ?? "").trim();
    if (!tableId) {
      throw new HttpError(400, "Tavolo non valido.");
    }
    const db = await readTableWorkLockRequestDb(req);
    const authContext =
      req.__authContext && typeof req.__authContext === "object"
        ? req.__authContext
        : validateSessionContext(db, payload);
    const { user, session } = authContext;
    const purpose = String(payload.purpose ?? "heartbeat").trim() || "heartbeat";
    const lockSettings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    if (!findPosTableWithLayout(lockSettings, tableId)) {
      const removedContext = resolveRemovedOperationalTableContext(
        db,
        lockSettings,
        tableId,
        payload,
      );
      assertUserCanOperateInRemovedTableRoom(
        user,
        lockSettings,
        removedContext.tableInfo,
        { session },
      );
      const lockResult = acquireOrRefreshRemovedOperationalTableWorkLock(
        db,
        removedContext,
        {
          user,
          session,
          payload,
          purpose,
          forceHeartbeat: true,
        },
      );
      db.meta.lastWriteAt = nowIso();
      await writeDb(db, { splitDomains: ["tableLocks", "auditEvents"] });
      sendJson(res, 200, {
        ok: true,
        lock: lockResult.lock,
        table: lockResult.tableInfo?.table ?? null,
        removedFromConfiguration: true,
      });
      return;
    }
    const lockResult = RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY
      ? await relationalTableLockCoordinator.acquire(db, tableId, { user, session, payload, purpose, forceHeartbeat: true })
      : isTableWorkLockFastPathEnabled()
      ? await acquireOrRefreshTableWorkLockFast(db, tableId, {
          user,
          session,
          payload,
          purpose,
          forceHeartbeat: true,
        })
      : (() => {
          assertActiveTableWorkLock(db, tableId, {
            user,
            session,
            payload,
            purpose,
          });
          return acquireOrRefreshTableWorkLock(db, tableId, {
            user,
            session,
            payload,
            purpose,
            forceHeartbeat: true,
          });
        })();
    if (RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY || !isTableWorkLockFastPathEnabled()) {
      db.meta.lastWriteAt = nowIso();
      await writeDb(db);
    }
    sendJson(res, 200, {
      ok: true,
      lock: lockResult.lock,
      table: lockResult.tableInfo?.table ?? null,
    });
  }
  
  async function handleTableLockRelease(req, res) {
    const payload = await readJsonBody(req);
    const tableId = String(payload.tableId ?? "").trim();
    if (!tableId) {
      throw new HttpError(400, "Tavolo non valido.");
    }
    const db = await readTableWorkLockRequestDb(req);
    const authContext =
      req.__authContext && typeof req.__authContext === "object"
        ? req.__authContext
        : validateSessionContext(db, payload);
    const { user, session } = authContext;
    const lockSettings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    if (!findPosTableWithLayout(lockSettings, tableId)) {
      const removedContext =
        buildRemovedOperationalLockReleaseContext(db, lockSettings, tableId) ??
        resolveRemovedOperationalTableContext(db, lockSettings, tableId, payload);
      assertUserCanOperateInRemovedTableRoom(
        user,
        lockSettings,
        removedContext.tableInfo,
        { session },
      );
      const result = releaseRemovedOperationalTableWorkLock(db, removedContext, {
        user,
        session,
        payload,
      });
      db.meta.lastWriteAt = nowIso();
      await writeDb(db, { splitDomains: ["tableLocks", "auditEvents"] });
      sendJson(res, 200, {
        ok: true,
        released: result.released,
        previousLock: result.previousLock,
        removedFromConfiguration: true,
      });
      return;
    }
    const result = RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY
      ? await relationalTableLockCoordinator.release(db, tableId, { user, session, payload })
      : isTableWorkLockFastPathEnabled()
      ? await releaseTableWorkLockFast(db, tableId, { user, session, payload })
      : releaseTableWorkLock(db, tableId, { user, session, payload });
    const embeddedLockCleared = tableLockWorkerRequestFastPath.isEnabled() ? false : clearEmbeddedTableWorkLock(db, tableId);
    if (RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY || !isTableWorkLockFastPathEnabled() || embeddedLockCleared) {
      db.meta.lastWriteAt = nowIso();
      await writeDb(db);
    }
    sendJson(res, 200, {
      ok: true,
      released: result.released,
      previousLock: result.previousLock,
    });
  }
  
  async function handleTableLockForceRelease(req, res) {
    const payload = await readJsonBody(req);
    const tableId = String(payload.tableId ?? "").trim();
    if (!tableId) {
      throw new HttpError(400, "Tavolo non valido.");
    }
    const db = await readTableWorkLockRequestDb(req);
    const authContext =
      req.__authContext && typeof req.__authContext === "object"
        ? req.__authContext
        : validateSessionContext(db, payload);
    const { user, session } = authContext;
    const lockSettings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    if (!findPosTableWithLayout(lockSettings, tableId)) {
      const removedContext =
        buildRemovedOperationalLockReleaseContext(db, lockSettings, tableId) ??
        resolveRemovedOperationalTableContext(db, lockSettings, tableId, payload);
      assertUserCanOperateInRemovedTableRoom(
        user,
        lockSettings,
        removedContext.tableInfo,
        { session },
      );
      const result = releaseRemovedOperationalTableWorkLock(db, removedContext, {
        user,
        session,
        payload,
        force: true,
      });
      db.meta.lastWriteAt = nowIso();
      await writeDb(db, { splitDomains: ["tableLocks", "auditEvents"] });
      sendJson(res, 200, {
        ok: true,
        released: result.released,
        previousLock: result.previousLock,
        removedFromConfiguration: true,
      });
      return;
    }
    const result = RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY
      ? await relationalTableLockCoordinator.release(db, tableId, { user, session, payload, force: true })
      : isTableWorkLockFastPathEnabled()
      ? await releaseTableWorkLockFast(db, tableId, {
          user,
          session,
          payload,
          force: true,
        })
      : releaseTableWorkLock(db, tableId, {
          user,
          session,
          payload,
          force: true,
        });
    const embeddedLockCleared = tableLockWorkerRequestFastPath.isEnabled() ? false : clearEmbeddedTableWorkLock(db, tableId);
    if (RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY || !isTableWorkLockFastPathEnabled() || embeddedLockCleared) {
      db.meta.lastWriteAt = nowIso();
      await writeDb(db);
    }
    sendJson(res, 200, {
      ok: true,
      released: result.released,
      previousLock: result.previousLock,
    });
  }
  
  

  return {
    handleTableLockAcquire,
    handleTableLockHeartbeat,
    handleTableLockRelease,
    handleTableLockForceRelease,
  };
}
