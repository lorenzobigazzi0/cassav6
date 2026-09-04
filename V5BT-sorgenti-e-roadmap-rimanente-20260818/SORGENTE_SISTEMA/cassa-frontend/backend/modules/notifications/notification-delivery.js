import {
  isNotificationTimestampFresh,
  parseNotificationTimestampMs,
} from "./notification-session-policy.js";

function text(value) {
  return String(value ?? "").trim();
}

export function getNotificationRequestIp(req) {
  return text(
    req?.headers?.["x-forwarded-for"] ??
      req?.headers?.["x-real-ip"] ??
      req?.socket?.remoteAddress,
  )
    .split(",")[0]
    .trim()
    .replace(/^::ffff:/i, "")
    .replace(/^\[|\]$/g, "");
}

export function findLatestSessionForNotificationRequester(
  db,
  requester = {},
  user = null,
  options = {},
) {
  const sessions = Array.isArray(db?.sessions) ? db.sessions : [];
  if (sessions.length === 0) return null;
  const users = Array.isArray(db?.users) ? db.users : [];
  const requestedUserId = text(requester.userId);
  const requestedUsername = options.normalizeUsername(requester.username);
  const suppliedUserId = text(user?.id);
  const suppliedUsername = options.normalizeUsername(user?.username);
  if (requestedUserId && suppliedUserId && requestedUserId !== suppliedUserId) {
    return null;
  }
  if (
    requestedUsername &&
    suppliedUsername &&
    requestedUsername !== suppliedUsername
  ) {
    return null;
  }
  const resolvedUser =
    (suppliedUserId
      ? users.find((entry) => text(entry?.id) === suppliedUserId)
      : null) ??
    (requestedUserId
      ? users.find((entry) => text(entry?.id) === requestedUserId)
      : null) ??
    (requestedUsername
      ? users.find(
          (entry) =>
            options.normalizeUsername(entry?.username) === requestedUsername,
        )
      : null);
  const userId = text(resolvedUser?.id);
  const username = options.normalizeUsername(resolvedUser?.username);
  if (
    !userId ||
    (requestedUserId && requestedUserId !== userId) ||
    (requestedUsername && requestedUsername !== username)
  ) {
    return null;
  }
  const deviceUuid = text(requester.deviceUuid);
  const clientApp = options.normalizeClientApp(requester.clientApp);
  if (!deviceUuid || !clientApp) return null;
  const nowMs = Number(options.nowMs) || Date.now();
  return sessions
    .filter((session) => {
      if (!session || typeof session !== "object") return false;
      const sessionUserId = text(session.userId);
      if (sessionUserId !== userId) return false;
      if (text(session.deviceUuid) !== deviceUuid) return false;
      if (options.normalizeClientApp(session.clientApp) !== clientApp) return false;
      return isNotificationSessionActive(session, { ...options, nowMs });
    })
    .sort((left, right) => {
      const createdDelta =
        parseNotificationTimestampMs(right.createdAt) -
        parseNotificationTimestampMs(left.createdAt);
      if (createdDelta !== 0) return createdDelta;
      const seenDelta =
        parseNotificationTimestampMs(right.lastSeenAt) -
        parseNotificationTimestampMs(left.lastSeenAt);
      if (seenDelta !== 0) return seenDelta;
      return text(right.id).localeCompare(text(left.id));
    })[0] ?? null;
}

export function isNotificationSessionActive(session, options = {}) {
  if (!session || typeof session !== "object") return false;
  if (
    !text(session.id ?? session.sessionId) ||
    !text(session.userId) ||
    !text(session.deviceUuid) ||
    !options.normalizeClientApp(session.clientApp)
  ) {
    return false;
  }
  const nowMs = Number(options.nowMs) || Date.now();
  const createdAtMs = parseNotificationTimestampMs(session.createdAt);
  const lastSeenAtMs = parseNotificationTimestampMs(session.lastSeenAt);
  const expiresAtMs = parseNotificationTimestampMs(session.expiresAt);
  const idleTimeoutMs = Math.max(
    0,
    Math.trunc(Number(options.sessionIdleTimeoutMs) || 0),
  );
  if (!createdAtMs || !lastSeenAtMs || !expiresAtMs) return false;
  if (createdAtMs > nowMs || lastSeenAtMs < createdAtMs || lastSeenAtMs > nowMs) {
    return false;
  }
  if (expiresAtMs <= nowMs) return false;
  if (idleTimeoutMs > 0 && lastSeenAtMs + idleTimeoutMs <= nowMs) return false;
  return true;
}

export function resolveNotificationSessionStartedAtMs(session) {
  return parseNotificationTimestampMs(session?.createdAt);
}

export function isNotificationFreshForSession(notification, session) {
  const sessionStartedAtMs = resolveNotificationSessionStartedAtMs(session);
  return isNotificationTimestampFresh(
    notification?.createdAt,
    sessionStartedAtMs,
  );
}

function hasDirectOnlineTarget(notification) {
  const meta = notification?.meta && typeof notification.meta === "object"
    ? notification.meta
    : {};
  return Boolean(
    text(meta.targetUserId) ||
      (Array.isArray(meta.targetUserIds) && meta.targetUserIds.length > 0) ||
      text(meta.targetUsername) ||
      text(meta.targetFullName),
  );
}

function requesterFromWaiter(waiter) {
  return {
    clientApp: "mobile-frontend",
    userId: text(waiter?.userId),
    username: text(waiter?.username),
    fullName: text(waiter?.fullName),
    deviceUuid: text(waiter?.deviceUuid),
    roomId: text(waiter?.roomId),
    roomName: text(waiter?.roomName),
    assignedRoomIds: Array.isArray(waiter?.assignedRoomIds)
      ? waiter.assignedRoomIds
      : [],
    notificationPriorities: Array.isArray(waiter?.notificationPriorities)
      ? waiter.notificationPriorities
      : [],
  };
}

function fallbackMeta(notification, options = {}) {
  const meta = notification?.meta && typeof notification.meta === "object"
    ? { ...notification.meta }
    : {};
  const originalTargetUserId = text(meta.targetUserId);
  const originalTargetUsername = text(meta.targetUsername);
  const originalTargetFullName = text(meta.targetFullName);
  [
    "targetUserId",
    "targetUserIds",
    "targetUsername",
    "targetFullName",
    "targetDeviceUuid",
    "targetDeviceIdAliases",
    "targetClientIp",
    "targetConsumer",
    "targetRoomId",
    "targetRoomName",
    "targetStation",
  ].forEach((key) => delete meta[key]);
  meta.targetClientApp =
    options.normalizeClientApp(meta.targetClientApp) || "mobile-frontend";
  if (options.view === true) {
    if (originalTargetUserId && !text(meta.originalTargetUserId)) {
      meta.originalTargetUserId = originalTargetUserId;
    }
    if (originalTargetUsername && !text(meta.originalTargetUsername)) {
      meta.originalTargetUsername = originalTargetUsername;
    }
    if (originalTargetFullName && !text(meta.originalTargetFullName)) {
      meta.originalTargetFullName = originalTargetFullName;
    }
    meta.targetFallbackActive = true;
    meta.targetFallbackReason = "no_online_target";
    meta.targetFallbackScope = "online_mobile";
  }
  return meta;
}

export function buildNotificationOnlineFallbackView(notification, options = {}) {
  return {
    ...notification,
    meta: fallbackMeta(notification, { ...options, view: true }),
  };
}

export function shouldDeliverNotificationByOnlineFallback(options = {}) {
  const { db, notification, requester } = options;
  if (text(notification?.meta?.eventType).toLowerCase() === "order_ready") {
    return false;
  }
  if (!hasDirectOnlineTarget(notification)) return false;
  const onlineTargetExists = options.collectLoggedInWaiters(db, {
    clientApp: "mobile-frontend",
    activeWithinMs: options.activeWindowMs,
    operatorOnly: false,
  }).some((waiter) =>
    options.notificationMatchesTarget(notification, requesterFromWaiter(waiter)),
  );
  if (onlineTargetExists) return false;
  return options.notificationMatchesTarget(
    {
      ...notification,
      meta: fallbackMeta(notification, options),
    },
    requester,
  );
}

export function createNotificationDeliveryService(options = {}) {
  return {
    buildNotificationOnlineFallbackView: (notification) =>
      buildNotificationOnlineFallbackView(notification, options),
    findLatestSessionForNotificationRequester: (db, requester, user) =>
      findLatestSessionForNotificationRequester(db, requester, user, options),
    isNotificationSessionActive: (session, activeOptions = {}) =>
      isNotificationSessionActive(session, { ...options, ...activeOptions }),
    isNotificationFreshForSession,
    resolveNotificationSessionStartedAtMs,
    shouldDeliverNotificationByOnlineFallback: (db, notification, requester) =>
      shouldDeliverNotificationByOnlineFallback({
        ...options,
        db,
        notification,
        requester,
      }),
  };
}
