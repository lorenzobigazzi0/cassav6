import { resolveNotificationPriority } from "./notification-priority.js";
import { normalizeIntegrationNotificationType } from "./notification-records.js";

function normalizeUsername(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeStationKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeClientApp(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["pos-frontend", "pos_frontend", "posfrontend", "mobile_frontend", "mobilefrontend"].includes(normalized)) {
    return "mobile-frontend";
  }
  if (["cash-frontend", "cash_frontend", "cashfrontend", "cassa_frontend", "cassafrontend"].includes(normalized)) {
    return "cassa-frontend";
  }
  if (normalized === "settings_frontend" || normalized === "settingsfrontend") return "settings-frontend";
  if (normalized === "monitor_frontend" || normalized === "monitorfrontend") return "monitor-frontend";
  return ["postazione", "mobile-frontend", "cassa-frontend", "settings-frontend", "monitor-frontend"].includes(normalized)
    ? normalized
    : "";
}

function normalizeIp(value) {
  const firstValue = String(value ?? "").split(",")[0]?.trim() ?? "";
  return firstValue.replace(/^::ffff:/i, "").replace(/^\[|\]$/g, "").trim().toLowerCase();
}

function parseTimestampMs(value, fallback = 0) {
  const parsed = new Date(String(value ?? "")).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringSet(value) {
  return new Set((Array.isArray(value) ? value : []).map((entry) => String(entry ?? "").trim()).filter(Boolean));
}

function normalizedStringSet(value, normalizer) {
  return new Set([...stringSet(value)].map(normalizer).filter(Boolean));
}

export function notificationMatchesTarget(notification, requester = {}) {
  const meta = notification?.meta && typeof notification.meta === "object" ? notification.meta : {};
  const targetUserId = typeof meta.targetUserId === "string" ? meta.targetUserId.trim() : "";
  const targetUserIds = stringSet(meta.targetUserIds);
  const targetUsername = normalizeUsername(meta.targetUsername);
  const targetUsernames = normalizedStringSet(meta.targetUsernames, normalizeUsername);
  const targetFullName = normalizeUsername(meta.targetFullName);
  const targetFullNames = normalizedStringSet(meta.targetFullNames, normalizeUsername);
  const targetDeviceUuid = typeof meta.targetDeviceUuid === "string" ? meta.targetDeviceUuid.trim() : "";
  const targetDeviceIdAliases = stringSet(meta.targetDeviceIdAliases);
  const targetClientIp = normalizeIp(meta.targetClientIp);
  const targetRoomId = typeof meta.targetRoomId === "string" ? meta.targetRoomId.trim() : "";
  const targetStation = normalizeStationKey(meta.targetStation);
  const targetConsumer = typeof meta.targetConsumer === "string" ? meta.targetConsumer.trim() : "";
  const targetClientApp = normalizeClientApp(meta.targetClientApp);
  const excludeUserId = typeof meta.excludeUserId === "string" ? meta.excludeUserId.trim() : "";
  const excludeUserIds = stringSet(meta.excludeUserIds);
  const excludeUsername = normalizeUsername(meta.excludeUsername);
  const excludeUsernames = normalizedStringSet(meta.excludeUsernames, normalizeUsername);
  const excludeFullName = normalizeUsername(meta.excludeFullName);
  const excludeFullNames = normalizedStringSet(meta.excludeFullNames, normalizeUsername);
  const excludeDeviceUuid = typeof meta.excludeDeviceUuid === "string" ? meta.excludeDeviceUuid.trim() : "";
  const excludeDeviceUuids = stringSet(meta.excludeDeviceUuids);

  const requesterUserId = typeof requester.userId === "string" ? requester.userId.trim() : "";
  const requesterUsername = normalizeUsername(requester.username);
  const requesterFullName = normalizeUsername(requester.fullName);
  const requesterDeviceUuid = typeof requester.deviceUuid === "string" ? requester.deviceUuid.trim() : "";
  const requesterClientIp = normalizeIp(requester.clientIp);
  const requesterRoomId = typeof requester.roomId === "string" ? requester.roomId.trim() : "";
  const requesterStation = normalizeStationKey(requester.station);
  const requesterConsumer = typeof requester.consumer === "string" ? requester.consumer.trim() : "";
  const requesterAckConsumer = typeof requester.ackConsumer === "string" ? requester.ackConsumer.trim() : "";
  const requesterClientApp = normalizeClientApp(requester.clientApp);
  const assignedRoomIds = stringSet(requester.assignedRoomIds);
  const notificationPriorities = stringSet(requester.notificationPriorities);
  const priority = resolveNotificationPriority(meta, notification?.type)?.key ?? "";

  if (priority && notificationPriorities.size > 0 && !notificationPriorities.has(priority)) return false;

  const hasTarget = Boolean(
    targetUserId ||
      targetUserIds.size > 0 ||
      targetUsername ||
      targetUsernames.size > 0 ||
      targetFullName ||
      targetFullNames.size > 0 ||
      targetDeviceUuid ||
      targetDeviceIdAliases.size > 0 ||
      targetClientIp ||
      targetRoomId ||
      targetStation ||
      targetConsumer ||
      targetClientApp
  );
  if (!hasTarget) return true;

  const hasUserTarget = Boolean(
    targetUserId ||
      targetUserIds.size > 0 ||
      targetUsername ||
      targetUsernames.size > 0 ||
      targetFullName ||
      targetFullNames.size > 0
  );
  if (hasUserTarget) {
    const targetUserMatches = Boolean(
      (targetUserId && targetUserId === requesterUserId) ||
        (requesterUserId && targetUserIds.has(requesterUserId)) ||
        (targetUsername && targetUsername === requesterUsername) ||
        (requesterUsername && targetUsernames.has(requesterUsername)) ||
        (targetFullName && targetFullName === requesterFullName) ||
        (requesterFullName && targetFullNames.has(requesterFullName))
    );
    if (!targetUserMatches) return false;
  }
  const hasDeviceTarget = Boolean(targetDeviceUuid || targetDeviceIdAliases.size > 0);
  const targetDeviceMatches = Boolean(
    (targetDeviceUuid && targetDeviceUuid === requesterDeviceUuid) ||
      (requesterDeviceUuid && targetDeviceIdAliases.has(requesterDeviceUuid))
  );
  const targetIpMatches = Boolean(targetClientIp && requesterClientIp && targetClientIp === requesterClientIp);
  if (targetDeviceUuid && !targetDeviceMatches && !targetIpMatches) return false;
  if (
    targetDeviceIdAliases.size > 0 &&
    !targetDeviceMatches &&
    !targetIpMatches &&
    targetDeviceUuid !== requesterDeviceUuid
  ) {
    return false;
  }
  if (targetClientIp && !targetIpMatches && (!hasDeviceTarget || !targetDeviceMatches)) return false;
  if (targetRoomId && targetRoomId !== requesterRoomId && !assignedRoomIds.has(targetRoomId)) return false;
  if (targetStation && targetStation !== requesterStation) return false;
  if (targetConsumer && targetConsumer !== requesterConsumer && targetConsumer !== requesterAckConsumer) return false;
  if (targetClientApp && targetClientApp !== requesterClientApp) return false;
  if (excludeUserId && excludeUserId === requesterUserId) return false;
  if (requesterUserId && excludeUserIds.has(requesterUserId)) return false;
  if (excludeUsername && excludeUsername === requesterUsername) return false;
  if (requesterUsername && excludeUsernames.has(requesterUsername)) return false;
  if (excludeFullName && excludeFullName === requesterFullName) return false;
  if (requesterFullName && excludeFullNames.has(requesterFullName)) return false;
  if (excludeDeviceUuid && excludeDeviceUuid === requesterDeviceUuid) return false;
  if (requesterDeviceUuid && excludeDeviceUuids.has(requesterDeviceUuid)) return false;
  return true;
}

export function isMobilePickupNotificationForOrder(notification, options = {}) {
  if (!notification || typeof notification !== "object") return false;
  const meta = notification.meta && typeof notification.meta === "object" ? notification.meta : {};
  const orderId = String(options.orderId ?? "").trim();
  const sourceNotificationId = String(options.sourceNotificationId ?? "").trim();
  const notificationOrderId = String(meta.orderId ?? "").trim();
  const notificationSourceId = String(meta.sourceNotificationId ?? "").trim();
  const eventType = String(meta.eventType ?? "").trim().toLowerCase();
  const targetClientApp = normalizeClientApp(String(meta.targetClientApp ?? "").trim());
  const isSameOrder = Boolean(orderId && notificationOrderId === orderId);
  const isSameSource = Boolean(sourceNotificationId && notificationSourceId === sourceNotificationId);
  if (!isSameOrder && !isSameSource) return false;
  if (notification.type === "bell") return true;
  if (targetClientApp && targetClientApp !== "mobile-frontend") return false;
  return eventType === "bell_claimed_by_other" || eventType === "order_ready";
}

export function removeMobilePickupNotificationsForOrder(notifications, options = {}) {
  if (!Array.isArray(notifications)) return 0;
  let removed = 0;
  for (let index = notifications.length - 1; index >= 0; index -= 1) {
    if (!isMobilePickupNotificationForOrder(notifications[index], options)) continue;
    notifications.splice(index, 1);
    removed += 1;
  }
  return removed;
}

export function findPendingBellNotificationByOrderId(integration, orderIdRaw, dependencies = {}) {
  const { hasBellClaim, sanitizeIntegrationNotification } = dependencies;
  const orderId = String(orderIdRaw ?? "").trim();
  if (
    !orderId ||
    !integration ||
    !Array.isArray(integration.notifications) ||
    typeof sanitizeIntegrationNotification !== "function"
  ) {
    return null;
  }

  for (let index = integration.notifications.length - 1; index >= 0; index -= 1) {
    const notification = sanitizeIntegrationNotification(
      integration.notifications[index],
      `ntf_existing_${index + 1}`
    );
    if (notification.type !== "bell") continue;
    const meta = notification.meta && typeof notification.meta === "object" ? notification.meta : {};
    if (String(meta.orderId ?? "").trim() !== orderId) continue;
    if (typeof hasBellClaim === "function" && hasBellClaim(integration, notification.id)) continue;
    return notification;
  }
  return null;
}

export function waiterIsPausedForNotifications(waiter) {
  const pause = waiter?.pauseStatus && typeof waiter.pauseStatus === "object" ? waiter.pauseStatus : null;
  return Boolean(pause?.active || pause?.graceActive);
}

export function notificationTargetsPausedWaiter(notification) {
  const type = normalizeIntegrationNotificationType(notification?.type);
  if (type !== "waiter" && type !== "bell") return false;
  const meta = notification?.meta && typeof notification.meta === "object" ? notification.meta : {};
  if (meta.forcePausedDelivery === true || meta.urgent === true) return false;
  return true;
}

export function resolveNotificationRoomId(notification, requester = {}) {
  const meta = notification?.meta && typeof notification.meta === "object" ? notification.meta : {};
  return (
    String(meta.targetRoomId ?? "").trim() ||
    String(meta.roomId ?? "").trim() ||
    String(requester.roomId ?? "").trim()
  );
}

export function hasOtherAvailableWaiterForNotification(db, notification, requester = {}, dependencies = {}) {
  const { collectActiveWaitersInRoom, collectLoggedInWaiters, activeWaiterWindowMs = 0 } = dependencies;
  const roomId = resolveNotificationRoomId(notification, requester);
  if (roomId && typeof collectActiveWaitersInRoom === "function") {
    return (
      collectActiveWaitersInRoom(db, roomId, {
        excludeUserId: requester.userId,
        excludeDeviceUuid: requester.deviceUuid,
        availableForNotifications: true,
      }).length > 0
    );
  }
  if (typeof collectLoggedInWaiters !== "function") return false;
  return collectLoggedInWaiters(db, {
    clientApp: "mobile-frontend",
    activeWithinMs: activeWaiterWindowMs,
  }).some((waiter) => {
    if (String(waiter?.userId ?? "").trim() === String(requester.userId ?? "").trim()) return false;
    if (String(waiter?.deviceUuid ?? "").trim() === String(requester.deviceUuid ?? "").trim()) return false;
    return !waiterIsPausedForNotifications(waiter);
  });
}

export function shouldSuppressNotificationForWaiterPause(
  db,
  notification,
  requester = {},
  requesterUser = null,
  dependencies = {}
) {
  const { resolveWaiterPauseState } = dependencies;
  if (!requesterUser || !notificationTargetsPausedWaiter(notification)) return false;
  if (typeof resolveWaiterPauseState !== "function") return false;
  const pauseStatus = resolveWaiterPauseState(db?.integration ?? {}, requesterUser, requester);
  if (!pauseStatus.active && !pauseStatus.graceActive) return false;
  return hasOtherAvailableWaiterForNotification(db, notification, requester, dependencies);
}

export function waiterHintMatchesUser(waiterHint, user) {
  const hint = normalizeUsername(waiterHint);
  if (!hint) return false;
  const username = normalizeUsername(user?.username);
  const fullName = normalizeUsername(user?.fullName);
  if (hint === username || hint === fullName) return true;
  if (fullName) {
    const firstName = fullName.split(/\s+/).filter(Boolean)[0] || "";
    if (hint === firstName) return true;
  }
  return false;
}

export function resolveBellTargetFromActiveSessions(db, waiterHint, options = {}) {
  const hint = normalizeUsername(waiterHint);
  if (!hint) return null;
  const users = Array.isArray(db?.users) ? db.users : [];
  const sessions = Array.isArray(db?.sessions) ? db.sessions : [];
  if (!users.length || !sessions.length) return null;

  const nowMsRaw = Number(options.nowMs ?? Date.now());
  const nowMs = Number.isFinite(nowMsRaw) ? nowMsRaw : Date.now();
  const activeWindowMsRaw = Number(options.activeWindowMs);
  const activeWindowMs =
    Number.isFinite(activeWindowMsRaw) && activeWindowMsRaw > 0 ? Math.trunc(activeWindowMsRaw) : 0;
  const usersById = new Map(users.map((user) => [String(user.id ?? "").trim(), user]));
  let best = null;

  for (const session of sessions) {
    if (!session || typeof session !== "object") continue;
    if (normalizeClientApp(session.clientApp) !== "mobile-frontend") continue;

    const userId = String(session.userId ?? "").trim();
    if (!userId) continue;
    const user = usersById.get(userId);
    if (!user || !waiterHintMatchesUser(hint, user)) continue;

    const seenAtMs = parseTimestampMs(session.lastSeenAt ?? session.createdAt, 0);
    if (!Number.isFinite(seenAtMs) || seenAtMs <= 0) continue;
    if (activeWindowMs > 0 && nowMs - seenAtMs > activeWindowMs) continue;

    const candidate = {
      seenAtMs,
      userId,
      username: String(user.username ?? "").trim(),
      fullName: String(user.fullName ?? user.username ?? "Cameriere").trim() || "Cameriere",
      deviceUuid: String(session.deviceUuid ?? "").trim(),
    };
    if (!best || candidate.seenAtMs > best.seenAtMs) {
      best = candidate;
    }
  }

  if (!best) return null;
  return {
    targetUserId: best.userId,
    targetUsername: best.username,
    targetFullName: best.fullName,
    targetDeviceUuid: best.deviceUuid,
  };
}

export function maybeEscalateBellNotification(notification, options = {}) {
  const nowMsRaw = Number(options.nowMs ?? Date.now());
  const nowMs = Number.isFinite(nowMsRaw) ? nowMsRaw : Date.now();
  const defaultTargetTimeoutMsRaw = Number(options.defaultTargetTimeoutMs);
  const defaultTargetTimeoutMs =
    Number.isFinite(defaultTargetTimeoutMsRaw) && defaultTargetTimeoutMsRaw > 0
      ? Math.trunc(defaultTargetTimeoutMsRaw)
      : 0;
  if (!notification || notification.type !== "bell") return false;
  const meta = notification.meta && typeof notification.meta === "object" ? notification.meta : {};
  if (String(meta.eventType ?? "").trim().toLowerCase() === "order_ready") {
    return false;
  }
  if (meta.targetFallbackActive === true || meta.notificationHandoffActive === true) {
    return false;
  }
  if (Array.isArray(notification.ackedBy) && notification.ackedBy.length > 0) {
    return false;
  }

  const hasPersonalTarget = Boolean(
    String(meta.targetUserId ?? "").trim() ||
      (Array.isArray(meta.targetUserIds) && meta.targetUserIds.length > 0) ||
      String(meta.targetUsername ?? "").trim() ||
      String(meta.targetFullName ?? "").trim() ||
      String(meta.targetDeviceUuid ?? "").trim() ||
      String(meta.targetRoomId ?? "").trim() ||
      String(meta.targetStation ?? "").trim()
  );
  if (!hasPersonalTarget) return false;

  const rawEscalateAt = Number(meta.bellEscalateAtMs);
  const fallbackCreatedAtMs = Math.trunc(Number(notification.createdAt) || nowMs);
  const escalateAtMs =
    Number.isFinite(rawEscalateAt) && rawEscalateAt > 0
      ? Math.trunc(rawEscalateAt)
      : fallbackCreatedAtMs + defaultTargetTimeoutMs;
  if (nowMs < escalateAtMs) return false;

  delete meta.targetUserId;
  delete meta.targetUserIds;
  delete meta.targetUsername;
  delete meta.targetFullName;
  delete meta.targetDeviceUuid;
  delete meta.targetRoomId;
  delete meta.targetRoomName;
  delete meta.targetStation;
  if (String(meta.waiter ?? "").trim()) {
    meta.originalWaiter = String(meta.waiter ?? "").trim();
  }
  delete meta.waiter;
  meta.targetClientApp = "mobile-frontend";
  meta.escalatedToAllAtMs = nowMs;
  notification.meta = meta;
  return true;
}
