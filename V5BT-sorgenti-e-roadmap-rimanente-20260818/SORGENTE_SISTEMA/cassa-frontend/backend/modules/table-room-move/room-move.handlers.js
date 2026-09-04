/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createRoomMoveHandlers({
  buildPosTableRoomMoveResponse,
  DB_MODE,
  HttpError,
  INTEGRATION_WAITER_ACTIVE_WINDOW_MS,
  POS_TABLE_ROOM_MOVE_APPROVAL_TIMEOUT_MS,
  RELATIONAL_TABLE_ROOM_MOVE_REQUEST_WRITE_PRIMARY,
  ReservationsRelationalRepository,
  collectActiveWaitersInRoom,
  collectLoggedInWaiters,
  collectPausedWaitersInRoom,
  ensurePosDataCollections,
  findPosAllowedRoomForUser,
  mysqlAppStateDomainsSplitRepository,
  normalizeStringList,
  nowIso,
  pruneExpiredPosTableRoomMoveRequests,
  publishIntegrationNotificationStreamRefresh,
  queuePosTableRoomMoveNotification,
  queuePosTableRoomMovePausedWaiterNotifications,
  randomUUID,
  readDb,
  readJsonBody,
  relationalRuntime,
  resolvePendingPosTableRoomMoveRequest,
  sanitizePosTableRoomMoveRequestRecord,
  sendJson,
  syncOrderNotificationsFastPath,
  validateSessionContext,
  writeTableRoomMoveRequestAppStateFastDb,
  writeRoomDb,
}) {
  async function handleIntegrationLayoutTableRoomMoveRequest(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user, session } = validateSessionContext(db, payload);
    ensurePosDataCollections(db);
    const tableRoomMoveRequestsPruned = pruneExpiredPosTableRoomMoveRequests(db);
  
    const targetRoomId = String(payload.targetRoomId ?? "").trim();
    const targetRoom = findPosAllowedRoomForUser(
      db.posSettings,
      user,
      targetRoomId,
    );
    if (!targetRoom) {
      throw new HttpError(
        403,
        "Sala destinazione non autorizzata per questo utente.",
      );
    }
    const fromTableId = String(
      payload.fromTableId ?? payload.tableId ?? "",
    ).trim();
    const targetTableIds = normalizeStringList(
      payload.targetTableIds ?? payload.toTableIds,
      24,
      80,
    );
    if (!fromTableId || targetTableIds.length === 0) {
      throw new HttpError(400, "Tavoli non validi.");
    }
  
    const deviceUuid = String(
      payload.deviceUuid ?? session.deviceUuid ?? "",
    ).trim();
    const activeWaiters = collectLoggedInWaiters(db, {
      clientApp: "mobile-frontend",
      activeWithinMs: INTEGRATION_WAITER_ACTIVE_WINDOW_MS,
    });
    const otherWaitersInTargetRoom = collectActiveWaitersInRoom(
      db,
      targetRoom.id,
      {
        excludeUserId: user.id,
        excludeDeviceUuid: deviceUuid,
        availableForNotifications: true,
      },
    );
    const pausedWaitersInTargetRoom = collectPausedWaitersInRoom(
      db,
      targetRoom.id,
      {
        excludeUserId: user.id,
        excludeDeviceUuid: deviceUuid,
      },
    );
    if (activeWaiters.length <= 1 || otherWaitersInTargetRoom.length === 0) {
      const directRequest = sanitizePosTableRoomMoveRequestRecord({
        requestId: `table_room_direct_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
        requesterUserId: user.id,
        requesterUsername: user.username,
        requesterFullName: user.fullName,
        requesterDeviceUuid: deviceUuid,
        fromRoomId: String(payload.fromRoomId ?? payload.roomId ?? "").trim(),
        fromRoomName: String(payload.fromRoomName ?? "").trim(),
        targetRoomId: targetRoom.id,
        targetRoomName: targetRoom.name,
        fromTableId,
        fromTableLabel: String(payload.fromTableLabel ?? "").trim(),
        targetTableIds,
        targetTableLabels: normalizeStringList(payload.targetTableLabels, 24, 80),
        sourceLeafCount: payload.sourceLeafCount,
        targetTableCount: payload.targetTableCount ?? targetTableIds.length,
        adjustCoversDelta: payload.adjustCoversDelta,
        status: "approved",
        createdAt: Date.now(),
        expiresAt: Date.now(),
      });
      const deferredCount = queuePosTableRoomMovePausedWaiterNotifications(
        db,
        directRequest,
        pausedWaitersInTargetRoom,
      );
      if (deferredCount > 0) {
        db.integration.lastWriteAt = nowIso();
        db.meta.lastWriteAt = nowIso();
        await writeRoomDb(db, { metricLabel: "rooms.tableRoomMove.deferred.appStateWrite", splitDomains: ["integration"] });
        publishIntegrationNotificationStreamRefresh(
          "table_room_move_paused_waiters_queued",
          {
            targetRoomId: targetRoom.id,
            deferredCount,
          },
        );
      }
      sendJson(res, 200, {
        ok: true,
        status: "approved",
        room: targetRoom,
        direct: true,
      });
      return;
    }
  
    const existing = db.posTableRoomMoveRequests.find((entry) => {
      const safe = sanitizePosTableRoomMoveRequestRecord(entry);
      return (
        safe &&
        safe.status === "pending" &&
        safe.requesterUserId === user.id &&
        safe.requesterDeviceUuid === deviceUuid &&
        safe.fromTableId === fromTableId &&
        safe.targetRoomId === targetRoom.id &&
        JSON.stringify(safe.targetTableIds) === JSON.stringify(targetTableIds)
      );
    });
    if (existing) {
      sendJson(res, 200, {
        ok: true,
        status: "pending",
        request: buildPosTableRoomMoveResponse(existing),
      });
      return;
    }
  
    const request = sanitizePosTableRoomMoveRequestRecord({
      requestId: `table_room_req_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      requesterUserId: user.id,
      requesterUsername: user.username,
      requesterFullName: user.fullName,
      requesterDeviceUuid: deviceUuid,
      fromRoomId: String(payload.fromRoomId ?? payload.roomId ?? "").trim(),
      fromRoomName: String(payload.fromRoomName ?? "").trim(),
      targetRoomId: targetRoom.id,
      targetRoomName: targetRoom.name,
      fromTableId,
      fromTableLabel: String(payload.fromTableLabel ?? "").trim(),
      targetTableIds,
      targetTableLabels: normalizeStringList(payload.targetTableLabels, 24, 80),
      sourceLeafCount: payload.sourceLeafCount,
      targetTableCount: payload.targetTableCount ?? targetTableIds.length,
      adjustCoversDelta: payload.adjustCoversDelta,
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + POS_TABLE_ROOM_MOVE_APPROVAL_TIMEOUT_MS,
    });
    if (!request) throw new HttpError(400, "Richiesta cambio sala non valida.");
  
    if (RELATIONAL_TABLE_ROOM_MOVE_REQUEST_WRITE_PRIMARY) { await relationalRuntime.initialize(); if (!relationalRuntime?.db) throw new HttpError(503, "DB relazionale prenotazioni non disponibile."); const persistedRequest = new ReservationsRelationalRepository(relationalRuntime.db).createTableRoomMoveRequest(request); if (!persistedRequest?.ok) throw new HttpError(persistedRequest?.reason === "exists" ? 409 : 400, "Richiesta spostamento tavolo relazionale non valida."); }
    db.posTableRoomMoveRequests.push(request);
    const notification = queuePosTableRoomMoveNotification(db, request, "request");
    const deferredCount = queuePosTableRoomMovePausedWaiterNotifications(
      db,
      request,
      pausedWaitersInTargetRoom,
    );
    db.meta.lastWriteAt = nowIso();
    const fastAppStateWritten = await writeTableRoomMoveRequestAppStateFastDb(db, { requestId: request.requestId, notificationIds: notification?.id ? [notification.id] : [], deferredCallsChanged: deferredCount > 0, requiresFullFallback: tableRoomMoveRequestsPruned }); if (!fastAppStateWritten) { if (DB_MODE === "mysql" && mysqlAppStateDomainsSplitRepository?.enabled === true && typeof mysqlAppStateDomainsSplitRepository.syncObjectEntryFromAppState === "function") { await syncOrderNotificationsFastPath(db, notification?.id ? [notification.id] : []); if (deferredCount > 0) await mysqlAppStateDomainsSplitRepository.syncObjectEntryFromAppState(db, "integration", "waiterDeferredCalls"); await mysqlAppStateDomainsSplitRepository.syncObjectEntryFromAppState(db, "integration", "lastWriteAt"); await writeRoomDb(db, { metricLabel: "rooms.tableRoomMove.request.appStateWrite", splitDomains: ["posTableRoomMoveRequests"] }); } else await writeRoomDb(db, { metricLabel: "rooms.tableRoomMove.request.appStateWrite", splitDomains: ["posTableRoomMoveRequests", "integration"] }); }
    publishIntegrationNotificationStreamRefresh("table_room_move_request", {
      requestId: request.requestId,
      targetRoomId: request.targetRoomId,
      deferredCount,
    });
  
    sendJson(res, 200, {
      ok: true,
      status: "pending",
      request: buildPosTableRoomMoveResponse(request),
    });
  }
  
  async function handleIntegrationLayoutTableRoomMoveStatus(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    ensurePosDataCollections(db);
    pruneExpiredPosTableRoomMoveRequests(db);
    const requestId = String(payload.requestId ?? "").trim();
    let requestIndex = db.posTableRoomMoveRequests.findIndex(
      (entry) => entry?.requestId === requestId,
    );
    if (RELATIONAL_TABLE_ROOM_MOVE_REQUEST_WRITE_PRIMARY) {
      await relationalRuntime.initialize();
      if (!relationalRuntime?.db) throw new HttpError(503, "DB relazionale prenotazioni non disponibile.");
      const relationalRequest = sanitizePosTableRoomMoveRequestRecord(new ReservationsRelationalRepository(relationalRuntime.db).getTableRoomMoveRequest(requestId));
      if (relationalRequest) {
        if (requestIndex < 0) {
          db.posTableRoomMoveRequests.push(relationalRequest);
          requestIndex = db.posTableRoomMoveRequests.length - 1;
        } else {
          db.posTableRoomMoveRequests[requestIndex] = relationalRequest;
        }
      }
    }
    if (requestIndex < 0) return sendJson(res, 200, { ok: false, error: "Richiesta non trovata o scaduta." });
    let request = sanitizePosTableRoomMoveRequestRecord(
      db.posTableRoomMoveRequests[requestIndex],
    );
    if (!request || request.requesterUserId !== user.id) {
      throw new HttpError(403, "Richiesta non disponibile per questo utente.");
    }
    let changed = false;
    if (request.status === "pending" && Date.now() >= request.expiresAt) {
      const resolved = resolvePendingPosTableRoomMoveRequest(
        db,
        request,
        "timeout_approved",
      );
      request = resolved.request;
      changed = resolved.changed;
      queuePosTableRoomMoveNotification(db, request, "timeout");
    }
    if (changed) {
      db.meta.lastWriteAt = nowIso();
      await writeRoomDb(db, { metricLabel: "rooms.tableRoomMove.status.appStateWrite", splitDomains: ["posTableRoomMoveRequests", "integration"] });
      publishIntegrationNotificationStreamRefresh("table_room_move_timeout", { requestId });
    }
    sendJson(res, 200, { ok: true, status: request.status, request: buildPosTableRoomMoveResponse(request) });
  }
  
  async function handleIntegrationLayoutTableRoomMovePending(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    ensurePosDataCollections(db);
    const changed = pruneExpiredPosTableRoomMoveRequests(db);
    const roomId = String(payload.roomId ?? "").trim();
    let sourceRequests = db.posTableRoomMoveRequests;
    if (RELATIONAL_TABLE_ROOM_MOVE_REQUEST_WRITE_PRIMARY) {
      await relationalRuntime.initialize();
      if (!relationalRuntime?.db) throw new HttpError(503, "DB relazionale prenotazioni non disponibile.");
      sourceRequests = new ReservationsRelationalRepository(relationalRuntime.db).listTableRoomMoveRequests({ targetRoomId: roomId, status: "pending" });
    }
    const items = sourceRequests
      .map((entry) => sanitizePosTableRoomMoveRequestRecord(entry))
      .filter((entry) => entry && entry.status === "pending" && (!roomId || entry.targetRoomId === roomId) && entry.requesterUserId !== user.id)
      .map(buildPosTableRoomMoveResponse)
      .filter(Boolean);
    if (changed) {
      db.meta.lastWriteAt = nowIso();
      await writeRoomDb(db, { metricLabel: "rooms.tableRoomMove.pending.appStateWrite", splitDomains: ["posTableRoomMoveRequests"] });
    }
    sendJson(res, 200, { ok: true, requests: items });
  }
  
  async function handleIntegrationLayoutTableRoomMoveResolve(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user, session } = validateSessionContext(db, payload);
    ensurePosDataCollections(db);
    pruneExpiredPosTableRoomMoveRequests(db);
    const requestId = String(payload.requestId ?? "").trim();
    const approve = payload.approve !== false;
    let tableRoomMoveRepo = null;
    let requestIndex = db.posTableRoomMoveRequests.findIndex(
      (entry) => entry?.requestId === requestId,
    );
    if (RELATIONAL_TABLE_ROOM_MOVE_REQUEST_WRITE_PRIMARY) {
      await relationalRuntime.initialize();
      if (!relationalRuntime?.db) throw new HttpError(503, "DB relazionale prenotazioni non disponibile.");
      tableRoomMoveRepo = new ReservationsRelationalRepository(relationalRuntime.db);
      const relationalRequest = sanitizePosTableRoomMoveRequestRecord(tableRoomMoveRepo.getTableRoomMoveRequest(requestId));
      if (relationalRequest) {
        if (requestIndex < 0) {
          db.posTableRoomMoveRequests.push(relationalRequest);
          requestIndex = db.posTableRoomMoveRequests.length - 1;
        } else {
          db.posTableRoomMoveRequests[requestIndex] = relationalRequest;
        }
      }
    }
    if (requestIndex < 0) return sendJson(res, 200, { ok: false, error: "Richiesta non trovata o scaduta." });
    const request = sanitizePosTableRoomMoveRequestRecord(
      db.posTableRoomMoveRequests[requestIndex],
    );
    if (!request || request.status !== "pending") return sendJson(res, 200, { ok: true, status: request?.status ?? "missing", request: buildPosTableRoomMoveResponse(request) });
    const sessionRoomId = String(session.roomId ?? payload.roomId ?? "").trim();
    if (sessionRoomId && sessionRoomId !== request.targetRoomId) {
      throw new HttpError(
        403,
        "Solo il cameriere loggato nella sala destinazione puo rispondere.",
      );
    }
    let resolved = null;
    if (tableRoomMoveRepo) {
      const persisted = tableRoomMoveRepo.resolveTableRoomMoveRequest({ requestId, status: approve ? "approved" : "rejected", resolvedByUserId: user.id, resolvedByUsername: user.username, resolvedAt: Date.now() });
      if (!persisted?.ok) throw new HttpError(persisted?.reason === "missing" ? 404 : 409, "Richiesta spostamento tavolo relazionale non risolvibile.");
      const relationalResolved = sanitizePosTableRoomMoveRequestRecord(persisted.request);
      if (relationalResolved) db.posTableRoomMoveRequests[requestIndex] = relationalResolved;
      resolved = { request: relationalResolved, changed: persisted.changed !== false };
    } else {
      resolved = resolvePendingPosTableRoomMoveRequest(db, request, approve ? "approved" : "rejected", user);
    }
    queuePosTableRoomMoveNotification(db, resolved.request, "resolved");
    db.meta.lastWriteAt = nowIso();
    await writeRoomDb(db, { metricLabel: "rooms.tableRoomMove.resolve.appStateWrite", splitDomains: ["posTableRoomMoveRequests", "integration"] });
    publishIntegrationNotificationStreamRefresh("table_room_move_resolved", { requestId, status: resolved.request?.status ?? "" });
    sendJson(res, 200, { ok: true, status: resolved.request?.status ?? "", request: buildPosTableRoomMoveResponse(resolved.request) });
  }
  

  return {
    handleIntegrationLayoutTableRoomMoveRequest,
    handleIntegrationLayoutTableRoomMoveStatus,
    handleIntegrationLayoutTableRoomMovePending,
    handleIntegrationLayoutTableRoomMoveResolve,
  };
}
