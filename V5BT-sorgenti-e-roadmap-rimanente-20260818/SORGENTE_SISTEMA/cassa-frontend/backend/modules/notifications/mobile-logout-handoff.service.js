import {
  buildOrderReadyHandoffRealtimeEvents,
  handoffOfflineOrderReadyNotifications,
} from "./order-ready-handoff.js";

function text(value) {
  return String(value ?? "").trim();
}

export function createMobileLogoutNotificationHandoffService(options = {}) {
  const activeWindowMs = Math.max(0, Math.trunc(Number(options.activeWindowMs) || 0));

  function onlineWaiters(db) {
    return options.collectLoggedInWaiters(db, {
      clientApp: "mobile-frontend",
      activeWithinMs: activeWindowMs,
    });
  }

  function applyOrderReady(db, input = {}) {
    const online = onlineWaiters(db);
    const result = handoffOfflineOrderReadyNotifications({
      notifications: Array.isArray(input.notifications)
        ? input.notifications
        : Array.isArray(db?.integration?.notifications)
          ? db.integration.notifications
          : [],
      onlineWaiters: online,
      activeWaiters: online.filter(
        (waiter) => !options.waiterIsPausedForNotifications(waiter),
      ),
      onlyTargetIdentity: input.onlyTargetIdentity,
      excludeUserId: input.excludeUserId,
      excludeUsername: input.excludeUsername,
      excludeDeviceUuid: input.excludeDeviceUuid,
      reason: input.reason,
      mobileLogout: input.mobileLogout === true,
      nowMs: input.nowMs,
    });
    if (result.changed && db?.integration) {
      db.integration.lastWriteAt = options.nowIso();
    }
    return result;
  }

  function countRemainingMobileSessions(db, userId, nowMs) {
    return (Array.isArray(db?.sessions) ? db.sessions : []).filter((entry) => {
      if (
        text(entry?.userId) !== userId ||
        options.normalizeClientApp(entry?.clientApp) !== "mobile-frontend"
      ) {
        return false;
      }
      const expiresAtMs = new Date(text(entry?.expiresAt)).getTime();
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) return false;
      const seenAtMs = new Date(text(entry?.lastSeenAt ?? entry?.createdAt)).getTime();
      return Number.isFinite(seenAtMs) && nowMs - seenAtMs <= activeWindowMs;
    }).length;
  }

  function applyLogout(db, context = {}) {
    const session = context.session && typeof context.session === "object"
      ? context.session
      : {};
    const user = context.user && typeof context.user === "object"
      ? context.user
      : {};
    if (options.normalizeClientApp(session.clientApp) !== "mobile-frontend") {
      return null;
    }
    options.clearCaches?.();
    const userId = text(user.id ?? session.userId);
    const nowMs = Date.now();
    const result = applyOrderReady(db, {
      onlyTargetIdentity: {
        userId,
        username: user.username,
        fullName: user.fullName,
        deviceUuid: session.deviceUuid,
      },
      excludeUserId: userId,
      excludeUsername: user.username,
      excludeDeviceUuid: session.deviceUuid,
      reason: "target_logout",
      mobileLogout: true,
      nowMs,
    });
    return {
      ...result,
      mobileLogout: true,
      userId,
      username: text(user.username),
      fullName: text(user.fullName ?? user.username),
      deviceUuid: text(session.deviceUuid),
      remainingMobileSessions: countRemainingMobileSessions(db, userId, nowMs),
    };
  }

  function publishLogout(result = {}) {
    if (result.mobileLogout !== true) return;
    options.disconnectStream?.({
      clientApp: "mobile-frontend",
      userId: result.userId,
      deviceUuid: result.deviceUuid,
    });
    options.publish("waiter_presence_changed", {
      userId: result.userId,
      username: result.username,
      fullName: result.fullName,
      deviceUuid: result.deviceUuid,
      online: result.remainingMobileSessions > 0,
      remainingMobileSessions: result.remainingMobileSessions,
      trigger: "auth_logout",
      audience: { clientApps: ["postazione", "cassa-frontend"] },
    });
    for (const event of buildOrderReadyHandoffRealtimeEvents(result)) {
      options.publish(event.reason, event.detail);
    }
  }

  return { applyLogout, applyOrderReady, publishLogout };
}

export function createMobileLogoutHandoffWriter(options = {}) {
  return async function writeMobileLogoutFastDb(db, input = {}) {
    const result = input.mobileLogoutResult && typeof input.mobileLogoutResult === "object"
      ? input.mobileLogoutResult
      : {};
    const notificationIds = options.normalizeIds(result.notificationIds);
    if (result.changed !== true || notificationIds.length === 0) return false;
    try {
      await options.writeNotificationDb(db, {
        notificationIds,
        integrationObjectFields: ["lastWriteAt"],
        metricLabel: "auth.logout.mobileHandoff.notificationWrite",
      });
      return await options.writeSessionAuditDb(db, {
        deletedSessionIds: input.deletedSessionIds,
        auditEventIds: input.auditEventIds,
      });
    } catch (error) {
      options.logger?.warn(
        `[auth:logout] handoff mobile fast non disponibile, uso fallback completo: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  };
}
