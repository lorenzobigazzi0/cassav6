/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createWaiterPauseHandlers({
  buildAuditActor,
  sanitizePosTable,
  collectIntegrationTableGroupLeafIds,
  HttpError,
  INTEGRATION_HOT_GET_FAST_CACHE_MS,
  appendAuditEvent,
  appendTableGroupMergePrintJobsToDb,
  buildWaiterPauseCorrelationId,
  buildWaiterPauseResponse,
  createDefaultIntegrationState,
  findUserByWaiterIdentity,
  findWaiterPauseRecord,
  flushDueWaiterDeferredCalls,
  flushTableRoomMoveDeferredCallsForUser,
  integrationTableGroupsFastResponseCache,
  normalizeWaiterPauseCollections,
  nowIso,
  publishIntegrationNotificationStreamRefresh,
  queuePrintSpoolWorker,
  readDb,
  readFastJsonCache,
  readJsonBody,
  reconcileWaiterPauseSideEffects,
  resolveIntegrationStationStatesVersionMs,
  resolveWaiterPauseState,
  sanitizeIntegrationTableGroups,
  sanitizePosSettings,
  sanitizeWaiterDeferredCall,
  sendJson,
  sendJsonString,
  startWaiterPause,
  stopWaiterPause,
  syncPosTableFinancialsFromIntegrationOrders,
  touchSessionHeartbeat,
  validateSessionContext,
  waiterPauseTelemetry,
  writeDb,
  writeFastJsonCache,
  writeTableGroupsFastDb,
  writeWaiterPauseDb,
}) {
  async function handleMobileWaiterPauseStart(req, res) {
    const telemetry = waiterPauseTelemetry.start("start");
    try {
      const payload = await readJsonBody(req);
      const db = await telemetry.measure("readDb.handler", () => readDb({
        refreshExternalizedSessions: true,
        refreshExternalizedTableLocks: true,
      }));
      const authContext = telemetry.measureSync("auth.resolve", () =>
        req.__authContext && typeof req.__authContext === "object"
          ? req.__authContext
          : validateSessionContext(db, payload));
      const { user, session } = authContext;
      if (!db.integration || typeof db.integration !== "object") {
        db.integration = createDefaultIntegrationState();
      }
      const effectiveSession = {
        ...session,
        roomId: String(session.roomId ?? "").trim() || payload.roomId,
        roomName: String(session.roomName ?? "").trim() || payload.roomName,
        deviceUuid: payload.deviceUuid ?? session.deviceUuid,
      };
      const result = telemetry.measureSync("state.transition", () =>
        startWaiterPause(db.integration, user, effectiveSession));
      if (!result.ok) {
        telemetry.finish(result.reason);
        throw new HttpError(409, "Pausa non disponibile per questo utente.", {
          code: result.reason,
          pause: result.state,
        });
      }
      if (result.reason === "already_paused") {
        const recovered = await telemetry.measure("state.reconcile", () =>
          reconcileWaiterPauseSideEffects({ kind: "start", db, user, effectiveSession, payload, telemetry }));
        if (recovered) telemetry.measureSync("realtime.publish", () =>
          publishIntegrationNotificationStreamRefresh("waiter_pause_started", {
            userId: user.id,
            roomId: String(payload.roomId ?? "").trim(),
          }));
        const response = telemetry.measureSync("response.build", () => buildWaiterPauseResponse(db, user, effectiveSession, result.state));
        telemetry.finish(recovered ? "recovered" : result.reason);
        sendJson(res, 200, response);
        return;
      }
      const sessionHeartbeatChanged = telemetry.measureSync("state.sessionHeartbeat", () => touchSessionHeartbeat(db, {
        ...payload,
        userId: user.id,
        clientApp: "mobile-frontend",
      }));
      const pauseRecord = findWaiterPauseRecord(db.integration, { userId: user.id });
      const auditEvent = telemetry.measureSync("audit.append", () => appendAuditEvent(db, {
        ...buildAuditActor(user, payload),
        action: "waiter.pause_started",
        entityType: "user",
        entityId: user.id,
        correlationId: buildWaiterPauseCorrelationId("start", user.id, pauseRecord?.startedAtMs),
        payload: {
          userId: user.id,
          startedAtMs: pauseRecord?.startedAtMs ?? result.state.startedAtMs,
          endsAtMs: result.state.endsAtMs,
          durationMinutes: result.state.durationMinutes,
        },
      }));
      db.integration.lastWriteAt = nowIso();
      db.meta.lastWriteAt = nowIso();
      await telemetry.measure("state.appStateWrite", () =>
        writeWaiterPauseDb(db, { metricLabel: "waiter.pause.start.appStateWrite", sessionIds: sessionHeartbeatChanged ? [effectiveSession.id] : [], auditEventIds: [auditEvent?.id], measure: (label, action) => telemetry.measure(label, action) }));
      telemetry.measureSync("realtime.publish", () =>
        publishIntegrationNotificationStreamRefresh("waiter_pause_started", {
          userId: user.id,
          roomId: String(payload.roomId ?? "").trim(),
        }));
      const response = telemetry.measureSync("response.build", () =>
        buildWaiterPauseResponse(db, user, effectiveSession, result.state));
      telemetry.finish(result.reason);
      sendJson(res, 200, response);
    } catch (error) {
      telemetry.finish("error");
      throw error;
    }
  }
  
  async function handleMobileWaiterPauseStop(req, res) {
    const telemetry = waiterPauseTelemetry.start("stop");
    try {
      const payload = await readJsonBody(req);
      const db = await telemetry.measure("readDb.handler", () => readDb());
      const { user, session } = telemetry.measureSync("auth.resolve", () =>
        validateSessionContext(db, payload));
      if (!db.integration || typeof db.integration !== "object") {
        db.integration = createDefaultIntegrationState();
      }
      const effectiveSession = {
        ...session,
        roomId: String(session.roomId ?? "").trim() || payload.roomId,
        roomName: String(session.roomName ?? "").trim() || payload.roomName,
        deviceUuid: payload.deviceUuid ?? session.deviceUuid,
      };
      const result = telemetry.measureSync("state.transition", () =>
        stopWaiterPause(db.integration, user, effectiveSession));
      if (result.reason === "already_active") {
        const recovered = await telemetry.measure("state.reconcile", () =>
          reconcileWaiterPauseSideEffects({ kind: "stop", db, user, effectiveSession, payload, telemetry }));
        if (recovered) telemetry.measureSync("realtime.publish", () =>
          publishIntegrationNotificationStreamRefresh("waiter_pause_stopped", {
            userId: user.id,
            roomId: String(payload.roomId ?? "").trim(),
          }));
        const response = telemetry.measureSync("response.build", () => buildWaiterPauseResponse(db, user, effectiveSession, result.state));
        telemetry.finish(recovered ? "recovered" : result.reason);
        sendJson(res, 200, response);
        return;
      }
      const sessionHeartbeatChanged = telemetry.measureSync("state.sessionHeartbeat", () => touchSessionHeartbeat(db, {
        ...payload,
        userId: user.id,
        clientApp: "mobile-frontend",
      }));
      const tableRoomMoveDeferredChanged = telemetry.measureSync(
        "deferred.tableRoomMoveFlush",
        () => flushTableRoomMoveDeferredCallsForUser(db, user),
      );
      const waiterDeferredChanged = telemetry.measureSync(
        "deferred.waiterFlush",
        () => flushDueWaiterDeferredCalls(db),
      );
      const deferredChanged = waiterDeferredChanged || tableRoomMoveDeferredChanged;
      const pauseRecord = findWaiterPauseRecord(db.integration, { userId: user.id });
      const auditEvent = telemetry.measureSync("audit.append", () => appendAuditEvent(db, {
        ...buildAuditActor(user, payload),
        action: "waiter.pause_stopped",
        entityType: "user",
        entityId: user.id,
        correlationId: buildWaiterPauseCorrelationId("stop", user.id, pauseRecord?.stoppedAtMs),
        payload: {
          userId: user.id,
          stoppedAtMs: pauseRecord?.stoppedAtMs ?? 0,
          reason: result.reason,
          reenableAtMs: result.state.reenableAtMs,
          flushedDeferredCalls: deferredChanged === true,
        },
      }));
      db.integration.lastWriteAt = nowIso();
      db.meta.lastWriteAt = nowIso();
      await telemetry.measure("state.appStateWrite", () =>
        writeWaiterPauseDb(db, { metricLabel: "waiter.pause.stop.appStateWrite", sessionIds: sessionHeartbeatChanged ? [effectiveSession.id] : [], auditEventIds: [auditEvent?.id], measure: (label, action) => telemetry.measure(label, action) }));
      telemetry.measureSync("realtime.publish", () =>
        publishIntegrationNotificationStreamRefresh("waiter_pause_stopped", {
          userId: user.id,
          roomId: String(payload.roomId ?? "").trim(),
        }));
      const response = telemetry.measureSync("response.build", () =>
        buildWaiterPauseResponse(db, user, effectiveSession, result.state));
      telemetry.finish(result.reason);
      sendJson(res, 200, response);
    } catch (error) {
      telemetry.finish("error");
      throw error;
    }
  }
  
  async function handleIntegrationWaiterPauseDeferredCall(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    normalizeWaiterPauseCollections(db.integration);
    const target = {
      userId: String(payload.targetUserId ?? payload.userId ?? "").trim(),
      username: String(payload.targetUsername ?? payload.username ?? "").trim(),
      fullName: String(
        payload.targetFullName ?? payload.fullName ?? payload.waiter ?? "",
      ).trim(),
    };
    const user = findUserByWaiterIdentity(db, target);
    if (!user) {
      throw new HttpError(404, "Cameriere non trovato per chiamata differita.");
    }
    const pauseStatus = resolveWaiterPauseState(db.integration, user, target);
    const station = String(payload.station ?? "").trim();
    const requestedBy = String(payload.requestedBy ?? "").trim();
    const waiterName = String(
      user.fullName ?? user.username ?? target.fullName ?? "Cameriere",
    ).trim();
    const description =
      String(payload.description ?? "").trim() ||
      `Richiesta da ${requestedBy || "postazione"} - Cameriere: ${waiterName}`;
    const record = sanitizeWaiterDeferredCall({
      id: `waiter_deferred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      targetUserId: String(user.id ?? "").trim(),
      targetUsername: String(user.username ?? "").trim(),
      targetFullName: waiterName,
      createdAtMs: Date.now(),
      deliverAfterMs: pauseStatus.active ? pauseStatus.endsAtMs : Date.now(),
      payload: {
        type: "waiter",
        title: station || "Chiamata cameriere",
        description,
        meta: {
          eventType: "waiter_call_after_pause",
          station,
          requestedBy,
          requesterDeviceUuid: String(payload.requesterDeviceUuid ?? "").trim(),
          requesterFeedbackConsumer: String(
            payload.requesterFeedbackConsumer ?? "",
          ).trim(),
          waiter: waiterName,
          targetUserId: String(user.id ?? "").trim(),
          targetUsername: String(user.username ?? "").trim(),
          targetFullName: waiterName,
          targetClientApp: "mobile-frontend",
        },
      },
    });
    db.integration.waiterDeferredCalls.push(record);
    const flushedImmediately = flushDueWaiterDeferredCalls(db);
    appendAuditEvent(db, {
      ...buildAuditActor(null, {
        deviceUuid: String(payload.requesterDeviceUuid ?? "").trim(),
      }),
      action: "waiter.call_deferred",
      entityType: "user",
      entityId: String(user.id ?? "").trim(),
      payload: {
        deferredCallId: record.id,
        targetUserId: user.id,
        deliverAfterMs: record.deliverAfterMs,
        station,
        flushedImmediately,
      },
    });
    db.integration.lastWriteAt = nowIso();
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);
    publishIntegrationNotificationStreamRefresh("waiter_call_deferred", {
      userId: user.id,
      station,
    });
    sendJson(res, 200, {
      ok: true,
      deferredCall: record,
      flushedImmediately,
    });
  }
  
  async function handleIntegrationTableGroups(_req, res) {
    const cachedGroups = readFastJsonCache(
      integrationTableGroupsFastResponseCache,
      "groups",
      INTEGRATION_HOT_GET_FAST_CACHE_MS,
    );
    if (cachedGroups) {
      sendJsonString(res, 200, cachedGroups.json);
      return;
    }
    const db = await readDb();
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    let settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
    });
    const validIds = new Set(
      settings.tables
        .map((table) => String(table.id ?? "").trim())
        .filter(Boolean),
    );
    const groups = sanitizeIntegrationTableGroups(db.integration.tableGroups, {
      validIds,
    });
    if (JSON.stringify(db.integration.tableGroups) !== JSON.stringify(groups)) {
      db.integration.tableGroups = groups;
      db.integration.lastWriteAt = nowIso();
      db.meta.lastWriteAt = nowIso();
      await writeDb(db, {
        metricLabel: "integration.tableGroups.normalize.appStateWrite",
        splitDomains: ["integration"],
      });
    }
    const version = resolveIntegrationStationStatesVersionMs(db);
    const responsePayload = {
      ok: true,
      version: Number.isFinite(version) ? version : Date.now(),
      groups,
    };
    const cacheEntry = writeFastJsonCache(
      integrationTableGroupsFastResponseCache,
      "groups",
      responsePayload,
      4,
    );
    sendJsonString(res, 200, cacheEntry.json);
  }
  
  async function handleIntegrationTableGroupsSave(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
    });
    const validIds = new Set(settings.tables.map((table) => String(table.id ?? "").trim()).filter(Boolean));
    const previousGroups = sanitizeIntegrationTableGroups(db.integration.tableGroups, { validIds });
    const groups = sanitizeIntegrationTableGroups(payload.groups, { validIds });
    const tableGroupTableIds = [...new Set([...previousGroups, ...groups].flatMap((group) => [String(group?.id ?? "").trim(), ...collectIntegrationTableGroupLeafIds(group)]))].filter((tableId) => tableId && validIds.has(tableId));
    db.posSettings = settings;
    db.integration.tableGroups = groups;
    db.integration.lastWriteAt = nowIso(); db.meta.lastWriteAt = nowIso();
    const financialSync = syncPosTableFinancialsFromIntegrationOrders(db, tableGroupTableIds);
    const printJobs = ["merge", "split"].includes(
      String(payload.operation ?? "")
        .trim()
        .toLowerCase(),
    )
      ? await appendTableGroupMergePrintJobsToDb(db, {
          previousGroups,
          groups,
          settings,
          userId: String(payload.userId ?? "").trim(),
          deviceUuid: String(payload.deviceUuid ?? "").trim(),
          clientApp: "mobile-frontend",
          operation: String(payload.operation ?? "")
            .trim()
            .toLowerCase(),
        })
      : [];
    integrationTableGroupsFastResponseCache.clear();
    const fastWritten = await writeTableGroupsFastDb(db, {
      printJobsChanged: printJobs.length > 0,
      printJobIds: printJobs.map((job) => job?.id),
      tableIds: financialSync.tableIds ?? [],
    });
    if (!fastWritten) await writeDb(db, {
      metricLabel: "integration.tableGroups.save.appStateWrite",
      splitDomains: ["integration", "posSettings", ...(printJobs.length > 0 ? ["printSpoolJobs"] : [])],
    });
    if (printJobs.length > 0) {
      queuePrintSpoolWorker();
    }
    publishIntegrationNotificationStreamRefresh("table_groups_updated", {
      groupsCount: groups.length,
      printJobsCount: printJobs.length,
    });
    const version = new Date(db.integration.lastWriteAt).getTime();
    sendJson(res, 200, {
      ok: true,
      version: Number.isFinite(version) ? version : Date.now(),
      groups,
      printJobs,
    });
  }
  

  return {
    handleMobileWaiterPauseStart,
    handleMobileWaiterPauseStop,
    handleIntegrationWaiterPauseDeferredCall,
    handleIntegrationTableGroups,
    handleIntegrationTableGroupsSave,
  };
}
