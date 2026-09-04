/**
 * Modello del dominio `messaging` (P2b, MIG-033).
 *
 * Possiede l'unico accesso all'app-state delle tre route di notifica:
 * publish, pull e ack. I corpi arrivano invariati dai handler; l'unica
 * differenza e che dove il handler inviava la risposta il modello la
 * restituisce, e il handler resta il solo a parlare con `res`.
 *
 * `publishNotification` e `pullNotifications` rispondono sempre 200 e
 * restituiscono il corpo. `acknowledgeNotification` no: ha un ramo che
 * risponde **401** con `code: "NOTIFICATION_SESSION_REVOKED"`, che fa parte
 * del contratto con il client e un `HttpError` generico perderebbe. Lo stato
 * li dipende dai dati ed e deciso in fondo al flusso, quindi non puo restare
 * nel handler senza duplicare il controllo: quella funzione restituisce
 * `{ stato, corpo }`.
 *
 * Le tre route stanno insieme e non divise fra read model e write model **di
 * proposito**: `pull` e dichiarata non mutativa ma scrive davvero -- tocca
 * l'heartbeat delle sessioni e fa il flush delle chiamate differite -- quindi
 * separarle direbbe una cosa falsa.
 */
import { compareIntegrationNotifications } from "./notification-priority.js";

export function createMessagingModel({
  BELL_TARGET_TIMEOUT_MS,
  HttpError,
  INTEGRATION_WAITER_ACTIVE_WINDOW_MS,
  NATIVE_NOTIFICATION_SESSION_HEADERS,
  applyBellClaimAssignmentToOrder,
  applyOrderReadyNotificationHandoff,
  buildNotificationOnlineFallbackView,
  buildOrderReadyHandoffRealtimeEvents,
  buildWaiterRoutingMetadata,
  collectActiveWaitersInRoom,
  collectLoggedInWaiters,
  createDefaultIntegrationState,
  enqueueRealtimePilotEvent,
  findIntegrationBellClaim,
  findIntegrationOrderIndexByLookup,
  findLatestSessionForNotificationRequester,
  flushDueWaiterDeferredCalls,
  flushTableRoomMoveDeferredCallsForUser,
  getNotificationRequestIp,
  isNotificationFreshForSession,
  isNotificationGloballyAcknowledged,
  markNotificationGloballyAcknowledged,
  maybeEscalateBellNotification,
  normalizeClientApp,
  normalizeIntegrationNotificationType,
  normalizeWaiterPauseCollections,
  notificationMatchesTarget,
  nowIso,
  pruneIntegrationState,
  publishIntegrationNotificationStreamRefresh,
  queueBellNotification,
  queueIntegrationNotification,
  readDb,
  refreshExpiredWaiterPause,
  rejectNativeNotificationSession,
  removeMobilePickupNotificationsForOrder,
  requestHeaderCount,
  resolveNotificationRequesterUser,
  resolveNotificationSessionStartedAtMs,
  resolveWaiterPauseState,
  sanitizeIntegrationNotification,
  shouldDeliverNotificationByOnlineFallback,
  shouldGloballyAcknowledgeNotification,
  shouldSuppressNotificationForWaiterPause,
  touchSessionHeartbeat,
  upsertIntegrationBellClaim,
  validateNativeNotificationSessionRequest,
  validateNotificationSessionRequest,
  writeNotificationPunctualDb,
}) {
  async function publishNotification(payload) {
    const type = normalizeIntegrationNotificationType(payload.type);
    const titleRaw =
      typeof payload.title === "string" ? payload.title.trim() : "";
    const descriptionRaw =
      typeof payload.description === "string" ? payload.description.trim() : "";
    const title =
      titleRaw ||
      (type === "waiter"
        ? "Chiamata cameriere"
        : type === "bell"
          ? "Comanda pronta"
          : "Notifica");
    const description = descriptionRaw || "Dettaglio non disponibile.";

    const rawMeta =
      payload.meta && typeof payload.meta === "object" ? payload.meta : {};
    const meta = { ...rawMeta };
    const db = await readDb();

    if (type === "waiter") {
      const hasExplicitTarget = Boolean(
        String(meta.targetUserId ?? "").trim() ||
        String(meta.targetUsername ?? "").trim() ||
        String(meta.targetFullName ?? "").trim() ||
        String(meta.targetDeviceUuid ?? "").trim(),
      );
      if (!hasExplicitTarget) {
        const legacyWaiter = String(meta.waiter ?? "").trim();
        if (legacyWaiter) {
          meta.targetFullName = legacyWaiter;
        }
      }
    }
    if (type === "bell") {
      const queued = queueBellNotification(db, {
        title,
        description,
        meta,
      });
      publishIntegrationNotificationStreamRefresh(
        queued.deduped ? "notification_publish_deduped" : "notification_publish",
        {
          type,
          id: queued.notification?.id ?? "",
          notification: queued.notification ?? null,
          deduped: queued.deduped === true,
          orderId: String(meta.orderId ?? meta.sourceOrderId ?? "").trim(),
          targetClientApp: String(meta.targetClientApp ?? "").trim(),
        },
      );
      if (!queued.deduped) {
        db.meta.lastWriteAt = nowIso();
        await writeNotificationPunctualDb(db, {
          notificationIds: [queued.notification?.id],
          integrationObjectFields: ["sequence", "lastWriteAt"],
          metricLabel: "notifications.publish.appStateWrite",
        });
      }

      return {
        ok: true,
        notification: queued.notification,
      };
    }

    const notification = queueIntegrationNotification(db, {
      type,
      title,
      description,
      meta,
    });
    db.meta.lastWriteAt = nowIso();
    publishIntegrationNotificationStreamRefresh("notification_publish", {
      type,
      id: notification?.id ?? "",
      notification,
    });
    await writeNotificationPunctualDb(db, {
      notificationIds: [notification?.id],
      integrationObjectFields: ["sequence", "lastWriteAt"],
      metricLabel: "notifications.publish.appStateWrite",
    });

    return {
      ok: true,
      notification,
    };
  }

  async function pullNotifications(requestUrl, req) {
    const consumerRaw = String(
      requestUrl.searchParams.get("consumer") ?? "",
    ).trim();
    const consumer = consumerRaw || "mobile-frontend";
    const ackConsumerRaw = String(
      requestUrl.searchParams.get("ackConsumer") ?? "",
    ).trim();
    const ackConsumer = ackConsumerRaw || consumer;
    const requester = {
      consumer,
      ackConsumer,
      userId: String(requestUrl.searchParams.get("userId") ?? "").trim(),
      username: String(requestUrl.searchParams.get("username") ?? "").trim(),
      fullName: String(requestUrl.searchParams.get("fullName") ?? "").trim(),
      deviceUuid: String(requestUrl.searchParams.get("deviceUuid") ?? "").trim(),
      roomId: String(requestUrl.searchParams.get("roomId") ?? "").trim(),
      roomName: String(requestUrl.searchParams.get("roomName") ?? "").trim(),
      station: String(requestUrl.searchParams.get("station") ?? "").trim(),
      clientIp: getNotificationRequestIp(req),
      clientApp: normalizeClientApp(
        String(requestUrl.searchParams.get("clientApp") ?? "").trim(),
      ),
    };
    const requesterClientApp = normalizeClientApp(
      requester.clientApp || consumer || "mobile-frontend",
    );
    requester.clientApp = requesterClientApp;
    const db = await readDb({ refreshExternalizedSessions: true });
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    normalizeWaiterPauseCollections(db.integration);
    const nativeContext = validateNotificationSessionRequest(
      db,
      req,
      requestUrl,
    );
    const requesterUser =
      nativeContext?.user ?? resolveNotificationRequesterUser(db, requester);
    const requesterSession =
      nativeContext?.session ??
      findLatestSessionForNotificationRequester(db, requester, requesterUser);
    if (requesterSession) {
      requester.userId = String(requesterUser?.id ?? requester.userId).trim();
      requester.username = String(
        requesterUser?.username ?? requester.username,
      ).trim();
      requester.fullName = String(
        requesterUser?.fullName ?? requester.fullName,
      ).trim();
      requester.deviceUuid = String(requesterSession.deviceUuid ?? "").trim();
      const sessionRoomId = String(requesterSession.roomId ?? "").trim();
      const sessionRoomName = String(requesterSession.roomName ?? "").trim();
      if (sessionRoomId) requester.roomId = sessionRoomId;
      if (sessionRoomName) requester.roomName = sessionRoomName;
    }
    if (
      requesterClientApp === "mobile-frontend" &&
      (!requester.userId ||
        !requester.deviceUuid ||
        !requesterUser ||
        !requesterSession)
    ) {
      return { ok: true, items: [] };
    }
    if (requesterUser) {
      Object.assign(
        requester,
        buildWaiterRoutingMetadata(db, requesterUser, requester),
      );
    }

    const heartbeatSessionIds = [];
    const heartbeatChanged = touchSessionHeartbeat(db, {
      ...requester,
      clientApp: requester.clientApp || "mobile-frontend",
      sessionId: String(requesterSession?.id ?? "").trim(),
      strictIdentity: true,
      touchedSessionIds: heartbeatSessionIds,
    });
    const notificationIdsBeforeDeferredFlush = new Set(
      (Array.isArray(db.integration.notifications)
        ? db.integration.notifications
        : [])
        .map((notification) => String(notification?.id ?? "").trim())
        .filter(Boolean),
    );
    let pauseChanged = false;
    let tableRoomMoveDeferredChanged = false;
    if (requesterUser) {
      pauseChanged = refreshExpiredWaiterPause(
        db.integration,
        requesterUser,
        requester,
      );
      if (pauseChanged) {
        tableRoomMoveDeferredChanged = flushTableRoomMoveDeferredCallsForUser(
          db,
          requesterUser,
        );
      }
    }
    const deferredChanged = flushDueWaiterDeferredCalls(db);
    let deliveryChanged = false;
    let escalationChanged = false;
    const notifications = Array.isArray(db.integration.notifications)
      ? db.integration.notifications
      : [];
    const notificationWriteIds = new Set(
      notifications
        .map((notification) => String(notification?.id ?? "").trim())
        .filter(
          (notificationId) =>
            notificationId &&
            !notificationIdsBeforeDeferredFlush.has(notificationId),
        ),
    );
    const notificationsRemovedDuringDeferredFlush = [
      ...notificationIdsBeforeDeferredFlush,
    ].some(
      (notificationId) =>
        !notifications.some(
          (notification) =>
            String(notification?.id ?? "").trim() === notificationId,
        ),
    );
    const normalizedNotifications = notifications.map((notification, index) =>
      sanitizeIntegrationNotification(
        notification,
        `ntf_${String(index + 1).padStart(7, "0")}`,
      ),
    );
    const nowMs = Date.now();
    const handoffResult = applyOrderReadyNotificationHandoff(db, {
      notifications: normalizedNotifications,
      reason: "no_online_target",
      nowMs,
    });
    const handoffChanged = handoffResult.changed === true;
    handoffResult.notificationIds.forEach((id) => notificationWriteIds.add(id));
    normalizedNotifications.forEach((notification) => {
      if (
        maybeEscalateBellNotification(notification, {
          nowMs,
          defaultTargetTimeoutMs: BELL_TARGET_TIMEOUT_MS,
        })
      ) {
        escalationChanged = true;
        notificationWriteIds.add(notification.id);
      }
    });
    const pending = normalizedNotifications
      .map((notification) => {
        if (isNotificationGloballyAcknowledged(notification)) return null;
        if (
          requesterClientApp === "mobile-frontend" &&
          requesterSession &&
          !isNotificationFreshForSession(notification, requesterSession)
        ) {
          return null;
        }
        const matchesTarget = notificationMatchesTarget(notification, requester);
        const deliverByOnlineFallback =
          !matchesTarget &&
          shouldDeliverNotificationByOnlineFallback(db, notification, requester);
        if (!matchesTarget && !deliverByOnlineFallback) return null;
        if (
          shouldSuppressNotificationForWaiterPause(
            db,
            notification,
            requester,
            requesterUser,
            {
              activeWaiterWindowMs: INTEGRATION_WAITER_ACTIVE_WINDOW_MS,
              collectActiveWaitersInRoom,
              collectLoggedInWaiters,
              resolveWaiterPauseState,
            },
          )
        ) {
          return null;
        }
        if (notification.ackedBy.includes(ackConsumer)) return null;
        if (!notification.deliveredTo.includes(consumer)) {
          notification.deliveredTo.push(consumer);
          deliveryChanged = true;
          notificationWriteIds.add(notification.id);
        }
        return deliverByOnlineFallback
          ? buildNotificationOnlineFallbackView(notification)
          : notification;
      })
      .filter(Boolean)
      .sort(compareIntegrationNotifications);

    if (
      deliveryChanged ||
      heartbeatChanged ||
      handoffChanged ||
      escalationChanged ||
      pauseChanged ||
      tableRoomMoveDeferredChanged ||
      deferredChanged
    ) {
      let prunedIntegrationState = false;
      if (
        deliveryChanged ||
        handoffChanged ||
        escalationChanged ||
        pauseChanged ||
        tableRoomMoveDeferredChanged ||
        deferredChanged
      ) {
        db.integration.notifications = normalizedNotifications;
        db.integration.lastWriteAt = nowIso();
        prunedIntegrationState = pruneIntegrationState(db.integration);
      }
      db.meta.lastWriteAt = nowIso();
      const integrationObjectFields = [];
      if (pauseChanged) integrationObjectFields.push("waiterPauses");
      if (tableRoomMoveDeferredChanged || deferredChanged) {
        integrationObjectFields.push("waiterDeferredCalls", "sequence");
      }
      if (
        deliveryChanged ||
        handoffChanged ||
        escalationChanged ||
        pauseChanged ||
        tableRoomMoveDeferredChanged ||
        deferredChanged
      ) {
        integrationObjectFields.push("lastWriteAt");
      }
      await writeNotificationPunctualDb(db, {
        notificationIds: [...notificationWriteIds],
        replaceNotifications: notificationsRemovedDuringDeferredFlush,
        integrationObjectFields,
        sessionIds: heartbeatSessionIds,
        syncSessions: heartbeatChanged,
        requiresFullIntegrationFallback: prunedIntegrationState,
        metricLabel: "notifications.pull.appStateWrite",
      });
      if (escalationChanged) {
        publishIntegrationNotificationStreamRefresh("notification_escalated", {
          consumer,
        });
      }
      if (handoffChanged) {
        for (const event of buildOrderReadyHandoffRealtimeEvents(handoffResult)) {
          publishIntegrationNotificationStreamRefresh(event.reason, event.detail);
        }
      }
      if (deferredChanged) {
        publishIntegrationNotificationStreamRefresh(
          "waiter_deferred_calls_flushed",
          {
            consumer,
          },
        );
      }
    }

    const responsePayload = {
      ok: true,
      items: pending.map((notification) => ({
        id: notification.id,
        type: notification.type,
        title: notification.title,
        description: notification.description,
        createdAt: notification.createdAt,
        meta: notification.meta,
      })),
    };
    return responsePayload;
  }

  async function acknowledgeNotification(payload, req) {
    const id = typeof payload.id === "string" ? payload.id.trim() : "";
    const consumerRaw =
      typeof payload.consumer === "string" ? payload.consumer.trim() : "";
    const consumer = consumerRaw || "mobile-frontend";
    const action = payload.action === "delete" ? "delete" : "ack";
    const requester = {
      userId: String(payload.userId ?? "").trim(),
      username: String(payload.username ?? "").trim(),
      fullName: String(payload.fullName ?? "").trim(),
      deviceUuid: String(payload.deviceUuid ?? "").trim(),
      roomId: String(payload.roomId ?? "").trim(),
      roomName: String(payload.roomName ?? "").trim(),
      station: String(payload.station ?? "").trim(),
      clientApp: normalizeClientApp(
        String(payload.clientApp ?? "").trim() || "mobile-frontend",
      ),
    };

    if (!id) {
      throw new HttpError(400, "ID notifica non valido.");
    }

    const db = await readDb({ refreshExternalizedSessions: true });
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    const requesterUser = resolveNotificationRequesterUser(db, requester);
    const requesterSession = findLatestSessionForNotificationRequester(
      db,
      requester,
      requesterUser,
    );
    if (
      requester.clientApp === "mobile-frontend" &&
      (!requester.userId ||
        !requester.deviceUuid ||
        !requesterUser ||
        !requesterSession)
    ) {
      return { stato: 401, corpo: {
        ok: false,
        error: "Sessione notifiche non attiva.",
        code: "NOTIFICATION_SESSION_REVOKED",
      } };
    }
    if (requesterSession) {
      requester.userId = String(requesterUser.id ?? "").trim();
      requester.username = String(requesterUser.username ?? "").trim();
      requester.fullName = String(requesterUser.fullName ?? "").trim();
      requester.deviceUuid = String(requesterSession.deviceUuid ?? "").trim();
    }
    const heartbeatSessionIds = [];
    const heartbeatChanged = requesterSession
      ? touchSessionHeartbeat(db, {
          ...requester,
          clientApp: requester.clientApp || "mobile-frontend",
          sessionId: String(requesterSession.id ?? "").trim(),
          strictIdentity: true,
          touchedSessionIds: heartbeatSessionIds,
        })
      : false;
    const notifications = Array.isArray(db.integration.notifications)
      ? db.integration.notifications
      : [];
    const existingClaim =
      action !== "delete" ? findIntegrationBellClaim(db.integration, id) : null;
    const notificationIndex = notifications.findIndex(
      (notification) => notification.id === id,
    );
    if (notificationIndex < 0) {
      if (existingClaim) {
        if (heartbeatChanged) {
          db.meta.lastWriteAt = nowIso();
          await writeNotificationPunctualDb(db, {
            sessionIds: heartbeatSessionIds,
            syncSessions: true,
            metricLabel: "notifications.ack.heartbeatWrite",
          });
        }
        const sameClaimant =
          existingClaim.claimedByConsumer === consumer ||
          (existingClaim.claimedByUserId &&
            existingClaim.claimedByUserId === requester.userId &&
            (!existingClaim.claimedByDeviceUuid ||
              existingClaim.claimedByDeviceUuid === requester.deviceUuid));
        return { stato: 200, corpo: {
          ok: true,
          deleted: false,
          acknowledged: sameClaimant,
          conflict: !sameClaimant,
          claim: existingClaim,
        } };
      }
      return { stato: 200, corpo: { ok: true, deleted: false, acknowledged: false } };
    }

    let changed = false;
    const notification = sanitizeIntegrationNotification(
      notifications[notificationIndex],
      id,
    );
    const sourceMeta =
      notification.meta && typeof notification.meta === "object"
        ? notification.meta
        : {};
    if (notification.type === "bell" && action !== "delete" && existingClaim) {
      if (heartbeatChanged) {
        db.meta.lastWriteAt = nowIso();
        await writeNotificationPunctualDb(db, {
          sessionIds: heartbeatSessionIds,
          syncSessions: true,
          metricLabel: "notifications.ack.heartbeatWrite",
        });
      }
      const sameClaimant =
        existingClaim.claimedByConsumer === consumer ||
        (existingClaim.claimedByUserId &&
          existingClaim.claimedByUserId === requester.userId &&
          (!existingClaim.claimedByDeviceUuid ||
            existingClaim.claimedByDeviceUuid === requester.deviceUuid));
      return { stato: 200, corpo: {
        ok: true,
        deleted: false,
        acknowledged: sameClaimant,
        conflict: !sameClaimant,
        claim: existingClaim,
      } };
    }
    if (!notification.ackedBy.includes(consumer)) {
      notification.ackedBy.push(consumer);
      changed = true;
    }
    if (
      action !== "delete" &&
      notification.type !== "bell" &&
      shouldGloballyAcknowledgeNotification(notification)
    ) {
      changed =
        markNotificationGloballyAcknowledged(notification, {
          consumer,
          requester,
          nowMs: Date.now(),
        }) || changed;
    }

    let bellClaim = null;
    let removedPickupNotifications = 0;
    if (action === "delete") {
      notifications.splice(notificationIndex, 1);
      changed = true;
    } else {
      notifications[notificationIndex] = notification;
      if (notification.type === "waiter" && changed) {
        const targetStation = String(
          sourceMeta.station ?? sourceMeta.targetStation ?? "",
        ).trim();
        if (targetStation) {
          const waiterName =
            String(requester.fullName || "").trim() ||
            String(
              sourceMeta.targetFullName ??
                sourceMeta.waiter ??
                requester.username ??
                "",
            ).trim() ||
            "Il cameriere";
          queueIntegrationNotification(db, {
            type: "general",
            title: targetStation,
            description: `${waiterName} sta arrivando...`,
            meta: {
              eventType: "waiter_ack",
              station: targetStation,
              targetStation,
              targetConsumer: String(
                sourceMeta.requesterFeedbackConsumer ?? "",
              ).trim(),
              targetClientApp: "postazione",
              waiter: waiterName,
              sourceNotificationId: notification.id,
            },
          });
          changed = true;
        }
      }
    }

    if (notification.type === "bell" && action !== "delete" && changed) {
      const orderId = String(sourceMeta.orderId ?? "").trim();
      const targetStation = String(
        sourceMeta.station ?? sourceMeta.targetStation ?? "",
      ).trim();
      const waiterName =
        String(requester.fullName || "").trim() ||
        String(
          sourceMeta.targetFullName ??
            sourceMeta.waiter ??
            requester.username ??
            "",
        ).trim() ||
        "Cameriere";
      bellClaim = upsertIntegrationBellClaim(db.integration, {
        notificationId: notification.id,
        orderId,
        station: targetStation,
        roomId: String(sourceMeta.roomId ?? "").trim(),
        roomName: String(sourceMeta.roomName ?? "").trim(),
        claimedAtMs: Date.now(),
        claimedByConsumer: consumer,
        claimedByUserId: requester.userId,
        claimedByUsername: requester.username,
        claimedByFullName: waiterName,
        claimedByDeviceUuid: requester.deviceUuid,
      });
      if (orderId && Array.isArray(db.integration.orders)) {
        const orderIndex = findIntegrationOrderIndexByLookup(
          db.integration.orders,
          orderId,
        );
        if (orderIndex >= 0) {
          const nextOrder = applyBellClaimAssignmentToOrder(
            db.integration.orders[orderIndex],
            requester,
            waiterName,
          );
          if (nextOrder) {
            db.integration.orders[orderIndex] = nextOrder;
            changed = true;
          }
        }
      }
      if (targetStation && orderId) {
        queueIntegrationNotification(db, {
          type: "general",
          title: targetStation,
          description: `${waiterName} ritira ${orderId}`,
          meta: {
            eventType: "bell_ack_pickup",
            station: targetStation,
            targetStation,
            targetClientApp: "postazione",
            waiter: waiterName,
            orderId,
            sourceNotificationId: notification.id,
          },
        });
        changed = true;
      }

      // La conferma "bell" e' one-shot: chiude tutte le notifiche mobile di ritiro
      // collegate alla stessa comanda, cosi' sugli altri palmari non resta nulla da confermare.
      removedPickupNotifications = removeMobilePickupNotificationsForOrder(
        notifications,
        {
          orderId,
          sourceNotificationId: notification.id,
        },
      );
      if (removedPickupNotifications > 0) {
        changed = true;
      }
    }

    if (changed || heartbeatChanged) {
      db.integration.notifications = notifications;
      if (changed) {
        db.integration.lastWriteAt = nowIso();
      }
      db.meta.lastWriteAt = nowIso();
      const prunedIntegrationState = pruneIntegrationState(db.integration);
      const sourceOrderId = String(sourceMeta.orderId ?? "").trim();
      await writeNotificationPunctualDb(db, {
        replaceNotifications: changed,
        orderIds: bellClaim && sourceOrderId ? [sourceOrderId] : [],
        integrationObjectFields: changed
          ? ["sequence", "recentBellClaims", "lastWriteAt"]
          : [],
        sessionIds: heartbeatSessionIds,
        syncSessions: heartbeatChanged,
        requiresFullIntegrationFallback: prunedIntegrationState,
        metricLabel: "notifications.ack.appStateWrite",
      });
      if (changed) {
        publishIntegrationNotificationStreamRefresh(
          action === "delete" ? "notification_deleted" : "notification_ack",
          {
            id,
            type: notification.type,
            consumer,
            eventType: String(sourceMeta.eventType ?? "").trim(),
            orderId: String(sourceMeta.orderId ?? "").trim(),
            sourceNotificationId: String(sourceMeta.sourceNotificationId ?? notification.id ?? "").trim(),
            targetClientApp: String(sourceMeta.targetClientApp ?? "").trim(),
            removedPickupNotifications,
            ...(bellClaim ? { claim: bellClaim } : {}),
          },
        );
        // Step 5 — evento pilota durabile: la conferma di una notifica reale.
        if (action === "ack") {
          enqueueRealtimePilotEvent({
            eventType: "notification.acked",
            aggregateType: "notification",
            aggregateId: id,
            scope: String(sourceMeta.orderId ?? "").trim() || null,
            payload: {
              id,
              action,
              consumer,
              type: notification.type,
              orderId: String(sourceMeta.orderId ?? "").trim() || null,
            },
          });
        }
      }
    }

    return { stato: 200, corpo: {
      ok: true,
      deleted: action === "delete",
      acknowledged: true,
      conflict: false,
      claim: bellClaim,
    } };
  }

  /**
   * Autenticazione della route SSE `notifications/stream`. Il trasporto
   * resta nel composition root: qui si decide soltanto se la connessione
   * puo aprirsi e con quale contesto di sessione.
   *
   * Restituisce `{ errore: { stato, corpo } }` sui due rami 401, che
   * portano un `code` su cui il client fa affidamento.
   */
  async function resolveNotificationStreamSession(identita, req, requestUrl) {
    const { clientApp, userId, username, fullName, deviceUuid } = identita;
    let sessionStartedAtMs = 0;
    let sessionContext = {};

  if (
    clientApp === "mobile-frontend" ||
    NATIVE_NOTIFICATION_SESSION_HEADERS.some(
      (name) => requestHeaderCount(req, name) > 0,
    )
  ) {
    const db = await readDb({ refreshExternalizedSessions: true });
    const nativeContext = validateNativeNotificationSessionRequest(
      db,
      req,
      requestUrl,
    );
    if (clientApp !== "mobile-frontend") {
      rejectNativeNotificationSession();
    }
    if (!nativeContext && (!userId || !deviceUuid)) {
      return {
        errore: {
          stato: 401,
          corpo: {
            ok: false,
            error: "Identita notifiche incompleta.",
            code: "NOTIFICATION_IDENTITY_REQUIRED",
          },
        },
      };
    }
    const requester = { clientApp, userId, username, fullName, deviceUuid };
    const requesterUser =
      nativeContext?.user ?? resolveNotificationRequesterUser(db, requester);
    const requesterSession =
      nativeContext?.session ??
      findLatestSessionForNotificationRequester(db, requester, requesterUser);
    if (!requesterSession) {
      return {
        errore: {
          stato: 401,
          corpo: {
            ok: false,
            error: "Sessione notifiche non attiva.",
            code: "NOTIFICATION_SESSION_REVOKED",
          },
        },
      };
    }
    sessionStartedAtMs =
      nativeContext?.sessionStartedAtMs ??
      resolveNotificationSessionStartedAtMs(requesterSession);
    sessionContext = {
      sessionId: String(requesterSession.id ?? "").trim(),
      userId: String(requesterUser.id ?? "").trim(),
      username: String(requesterUser.username ?? "").trim(),
      fullName: String(requesterUser.fullName ?? "").trim(),
      deviceUuid: String(requesterSession.deviceUuid ?? "").trim(),
      roomId: String(requesterSession.roomId ?? "").trim(),
      roomName: String(requesterSession.roomName ?? "").trim(),
    };
  }

    return { sessionStartedAtMs, sessionContext };
  }

  return {
    publishNotification,
    pullNotifications,
    acknowledgeNotification,
    resolveNotificationStreamSession,
  };
}
