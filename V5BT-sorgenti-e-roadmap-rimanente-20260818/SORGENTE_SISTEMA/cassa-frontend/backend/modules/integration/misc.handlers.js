/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createIntegrationMiscHandlers({
  DEFAULT_NETWORK_PRINTER_PORT,
  HttpError,
  INTEGRATION_HOT_GET_FAST_CACHE_MS,
  INTEGRATION_WAITER_ACTIVE_WINDOW_MS,
  REALTIME_BACKBONE_CONFIG,
  buildSearchParamsCacheKey,
  collectLoggedInWaiters,
  createDefaultIntegrationState,
  flushDueWaiterDeferredCalls,
  integrationWaitersFastResponseCache,
  normalizeClientApp,
  nowIso,
  publishIntegrationNotificationStreamRefresh,
  readDb,
  readFastJsonCache,
  readHeaderValue,
  readJsonBody,
  realtimeEventOutboxCoordinator,
  resolvePrinterFromSettings,
  runtimeMetrics,
  sanitizePosSettings,
  sendJson,
  sendJsonString,
  sendNetworkDrawerKick,
  toRealtimeEventEnvelope,
  writeDb,
  writeFastJsonCache,
}) {
  async function handleRealtimeReplay(req, res, requestUrl) {
    if (!REALTIME_BACKBONE_CONFIG.replayEnabled) {
      throw new HttpError(404, "Replay realtime non abilitato.", {
        code: "REALTIME_REPLAY_DISABLED",
      });
    }
    const headerValue = String(readHeaderValue(req, "last-event-id") ?? "").trim();
    const queryValue = String(
      requestUrl?.searchParams?.get("afterEventId") ??
        requestUrl?.searchParams?.get("lastEventId") ??
        "",
    ).trim();
    const afterEventId = Math.max(
      0,
      Math.trunc(Number(headerValue || queryValue) || 0),
    );
    const limitRaw = Math.trunc(
      Number(requestUrl?.searchParams?.get("limit")) || 0,
    );
    const limit = limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;
  
    runtimeMetrics.incrementCounter("realtimeReplayRuns");
    const result = realtimeEventOutboxCoordinator.replay({ afterEventId, limit });
  
    if (result.recoveryRequired) {
      runtimeMetrics.incrementCounter("realtimeReplayRecoveries");
      sendJson(res, 200, {
        ok: true,
        recoveryRequired: true,
        minEventId: result.bounds.minId,
        maxEventId: result.bounds.maxId,
        events: [],
      });
      return;
    }
  
    const events = result.events.map(toRealtimeEventEnvelope);
    runtimeMetrics.incrementCounter("realtimeReplayEvents", events.length);
    const lastEventId =
      events.length > 0 ? events[events.length - 1].eventId : afterEventId;
    sendJson(res, 200, {
      ok: true,
      recoveryRequired: false,
      events,
      lastEventId,
      maxEventId: result.bounds.maxId,
    });
  }
  
  async function handleIntegrationDrawerOpen(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const resolvedTarget = resolvePrinterFromSettings(settings, {
      ...payload,
      kind: "drawer",
      printerPurpose: "generic",
    });
    if (!resolvedTarget?.printer?.host) {
      throw new HttpError(
        400,
        "Nessuna stampante 80mm configurata per questa cassa.",
      );
    }
  
    await sendNetworkDrawerKick(resolvedTarget.printer, payload);
  
    sendJson(res, 200, {
      ok: true,
      opened: true,
      printer: resolvedTarget.printer.name || resolvedTarget.printer.host,
      printerId: resolvedTarget.printer.id || "",
      printerHost: resolvedTarget.printer.host,
      printerPort: resolvedTarget.printer.port || DEFAULT_NETWORK_PRINTER_PORT,
      source: resolvedTarget.source || "",
    });
  }
  
  async function handleIntegrationWaiters(_req, res, requestUrl) {
    const fastCacheKey = buildSearchParamsCacheKey(requestUrl, [
      "_",
      "token",
      "fullName",
    ]);
    const cachedWaiters = readFastJsonCache(
      integrationWaitersFastResponseCache,
      fastCacheKey,
      INTEGRATION_HOT_GET_FAST_CACHE_MS,
    );
    if (cachedWaiters) {
      sendJsonString(res, 200, cachedWaiters.json);
      return;
    }
    const db = await readDb();
    if (!db.integration || typeof db.integration !== "object") db.integration = createDefaultIntegrationState();
    const deferredChanged = flushDueWaiterDeferredCalls(db);
    if (deferredChanged) {
      db.integration.lastWriteAt = nowIso();
      db.meta.lastWriteAt = nowIso();
      await writeDb(db);
      publishIntegrationNotificationStreamRefresh(
        "waiter_deferred_calls_flushed",
        {},
      );
    }
    const sourceRaw = String(requestUrl.searchParams.get("source") ?? "").trim();
    const source =
      sourceRaw.toLowerCase() === "all"
        ? ""
        : normalizeClientApp(sourceRaw || "mobile-frontend");
    const includeInactive = ["1", "true", "yes", "si", "sì"].includes(
      String(requestUrl.searchParams.get("includeInactive") ?? "")
        .trim()
        .toLowerCase(),
    );
    const activeMsRaw = Number.parseInt(
      String(requestUrl.searchParams.get("activeMs") ?? ""),
      10,
    );
    const activeWithinMs =
      Number.isFinite(activeMsRaw) && activeMsRaw > 0
        ? Math.max(5_000, activeMsRaw)
        : INTEGRATION_WAITER_ACTIVE_WINDOW_MS;
    const waiters = collectLoggedInWaiters(db, {
      operatorOnly: false,
      clientApp:
        sourceRaw.toLowerCase() === "all" ? "" : source || "mobile-frontend",
      activeWithinMs,
      includeInactive,
    });
    const version = new Date(db.meta?.lastWriteAt ?? nowIso()).getTime();
    const responsePayload = {
      ok: true,
      version: Number.isFinite(version) ? version : Date.now(),
      waiters: waiters.map((waiter) => ({
        userId: waiter.userId,
        username: waiter.username,
        fullName: waiter.fullName,
        clientApp: waiter.clientApp || "",
        roomId: waiter.roomId || "",
        roomName: waiter.roomName || "",
        lastSessionAt: waiter.lastSessionAt,
        online: waiter.online === true,
        activeNow: waiter.activeNow === true,
        assignedRoomIds: waiter.assignedRoomIds ?? [],
        assignedToCurrentRoom: waiter.assignedToCurrentRoom === true,
        notificationPriorities: waiter.notificationPriorities ?? [],
        pauseStatus: waiter.pauseStatus ?? null,
        onPause: waiter.onPause === true,
      })),
    };
    const cacheEntry = writeFastJsonCache(
      integrationWaitersFastResponseCache,
      fastCacheKey,
      responsePayload,
      12,
    );
    sendJsonString(res, 200, cacheEntry.json);
  }
  

  return {
    handleRealtimeReplay,
    handleIntegrationDrawerOpen,
    handleIntegrationWaiters,
  };
}
