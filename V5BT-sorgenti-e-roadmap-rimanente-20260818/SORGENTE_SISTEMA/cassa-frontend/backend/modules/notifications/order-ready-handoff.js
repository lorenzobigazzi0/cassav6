function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeIdentity(value) {
  return normalizeText(value).toLowerCase();
}

function uniqueStrings(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [values])
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map(normalizeText)
        .filter(Boolean),
    ),
  ];
}

function stringSet(values, normalizer = normalizeText) {
  return new Set(uniqueStrings(values).map(normalizer).filter(Boolean));
}

function notificationMeta(notification) {
  return notification?.meta && typeof notification.meta === "object"
    ? notification.meta
    : {};
}

function isOrderReadyNotification(notification) {
  return normalizeIdentity(notificationMeta(notification).eventType) === "order_ready";
}

function isAcknowledged(notification) {
  const meta = notificationMeta(notification);
  const acknowledgedAtMs = Number(meta.acknowledgedAtMs);
  return (
    (Number.isFinite(acknowledgedAtMs) && acknowledgedAtMs > 0) ||
    Boolean(normalizeText(meta.acknowledgedAt)) ||
    (Array.isArray(notification?.ackedBy) && notification.ackedBy.length > 0)
  );
}

function waiterIsOnline(waiter) {
  return (
    waiter &&
    typeof waiter === "object" &&
    normalizeText(waiter.userId) &&
    waiter.online !== false &&
    waiter.activeNow !== false
  );
}

function waiterIsAvailable(waiter) {
  const pause =
    waiter?.pauseStatus && typeof waiter.pauseStatus === "object"
      ? waiter.pauseStatus
      : {};
  return (
    waiterIsOnline(waiter) &&
    waiter.onPause !== true &&
    pause.active !== true &&
    pause.graceActive !== true
  );
}

function waiterSupportsNotification(waiter, notification) {
  const priority = normalizeIdentity(notificationMeta(notification).notificationPriority);
  const priorities = stringSet(waiter?.notificationPriorities, normalizeIdentity);
  return !priority || priorities.size === 0 || priorities.has(priority);
}

function targetIdentity(meta = {}) {
  return {
    userIds: stringSet([meta.targetUserId, meta.targetUserIds]),
    usernames: stringSet(
      [meta.targetUsername, meta.targetUsernames],
      normalizeIdentity,
    ),
    fullNames: stringSet(
      [meta.targetFullName, meta.targetFullNames],
      normalizeIdentity,
    ),
    deviceUuids: stringSet([
      meta.targetDeviceUuid,
      meta.targetDeviceIdAliases,
    ]),
  };
}

function excludedIdentity(meta = {}, options = {}) {
  return {
    userIds: stringSet([
      meta.excludeUserId,
      meta.excludeUserIds,
      options.excludeUserId,
      options.excludeUserIds,
    ]),
    usernames: stringSet(
      [
        meta.excludeUsername,
        meta.excludeUsernames,
        options.excludeUsername,
        options.excludeUsernames,
      ],
      normalizeIdentity,
    ),
    fullNames: stringSet(
      [
        meta.excludeFullName,
        meta.excludeFullNames,
        options.excludeFullName,
        options.excludeFullNames,
      ],
      normalizeIdentity,
    ),
    deviceUuids: stringSet([
      meta.excludeDeviceUuid,
      meta.excludeDeviceUuids,
      options.excludeDeviceUuid,
      options.excludeDeviceUuids,
    ]),
  };
}

function hasDirectTarget(identity) {
  return Object.values(identity).some((entries) => entries.size > 0);
}

function waiterMatchesIdentity(waiter, identity) {
  const userId = normalizeText(waiter?.userId);
  const username = normalizeIdentity(waiter?.username);
  const fullName = normalizeIdentity(waiter?.fullName);
  const deviceUuid = normalizeText(waiter?.deviceUuid);
  const hasUserIdentity =
    identity.userIds.size > 0 ||
    identity.usernames.size > 0 ||
    identity.fullNames.size > 0;
  if (hasUserIdentity) {
    return Boolean(
      (userId && identity.userIds.has(userId)) ||
        (username && identity.usernames.has(username)) ||
        (fullName && identity.fullNames.has(fullName)),
    );
  }
  return Boolean(deviceUuid && identity.deviceUuids.has(deviceUuid));
}

function notificationTargetsIdentity(notification, identity = {}) {
  const target = targetIdentity(notificationMeta(notification));
  const requested = {
    userIds: stringSet(identity.userId),
    usernames: stringSet(identity.username, normalizeIdentity),
    fullNames: stringSet(identity.fullName, normalizeIdentity),
    deviceUuids: stringSet(identity.deviceUuid),
  };
  const hasTargetUserIdentity =
    target.userIds.size > 0 ||
    target.usernames.size > 0 ||
    target.fullNames.size > 0;
  if (hasTargetUserIdentity) {
    return Boolean(
      [...requested.userIds].some((value) => target.userIds.has(value)) ||
        [...requested.usernames].some((value) => target.usernames.has(value)) ||
        [...requested.fullNames].some((value) => target.fullNames.has(value)),
    );
  }
  return [...requested.deviceUuids].some((value) =>
    target.deviceUuids.has(value),
  );
}

function resolveNotificationRoomId(notification) {
  const meta = notificationMeta(notification);
  return normalizeText(
    meta.roomId ?? meta.targetRoomId ?? meta.sourceRoomId ?? meta.orderRoomId,
  );
}

function waiterMatchesRoom(waiter, roomId) {
  if (!roomId) return false;
  if (normalizeText(waiter?.roomId) === roomId) return true;
  return stringSet(waiter?.assignedRoomIds).has(roomId);
}

function preserveOriginalTarget(meta, key) {
  const value = meta[key];
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && !normalizeText(value)) ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return;
  }
  const originalKey = `original${key[0].toUpperCase()}${key.slice(1)}`;
  if (meta[originalKey] !== undefined && meta[originalKey] !== null) return;
  meta[originalKey] = Array.isArray(value) ? [...value] : value;
}

function collectAvailableWaiters(activeWaiters, notification) {
  const byUserId = new Map();
  for (const waiter of Array.isArray(activeWaiters) ? activeWaiters : []) {
    if (!waiterIsAvailable(waiter)) continue;
    if (!waiterSupportsNotification(waiter, notification)) continue;
    const userId = normalizeText(waiter.userId);
    const previous = byUserId.get(userId);
    const seenAtMs = new Date(
      normalizeText(waiter.lastSessionAt ?? waiter.lastSeenAt),
    ).getTime();
    const previousSeenAtMs = new Date(
      normalizeText(previous?.lastSessionAt ?? previous?.lastSeenAt),
    ).getTime();
    if (
      !previous ||
      (Number.isFinite(seenAtMs) &&
        (!Number.isFinite(previousSeenAtMs) || seenAtMs > previousSeenAtMs))
    ) {
      byUserId.set(userId, waiter);
    }
  }
  return [...byUserId.values()];
}

function collectOnlineWaiters(activeWaiters) {
  const byUserId = new Map();
  for (const waiter of Array.isArray(activeWaiters) ? activeWaiters : []) {
    if (!waiterIsOnline(waiter)) continue;
    const userId = normalizeText(waiter.userId);
    if (!byUserId.has(userId)) byUserId.set(userId, waiter);
  }
  return [...byUserId.values()];
}

function rewriteNotificationTarget(notification, recipients, options = {}) {
  const meta = { ...notificationMeta(notification) };
  const identity = targetIdentity(meta);
  const roomId = resolveNotificationRoomId(notification);
  const sameRoomRecipients = roomId
    ? recipients.filter((waiter) => waiterMatchesRoom(waiter, roomId))
    : [];
  const selected = sameRoomRecipients.length > 0 ? sameRoomRecipients : recipients;
  if (selected.length === 0) return null;

  if (meta.notificationHandoffActive !== true) {
    [
      "targetUserId",
      "targetUserIds",
      "targetUsername",
      "targetUsernames",
      "targetFullName",
      "targetFullNames",
      "targetDeviceUuid",
      "targetDeviceIdAliases",
      "targetClientIp",
      "targetConsumer",
      "targetRoomId",
      "targetRoomName",
      "targetStation",
    ].forEach((key) => preserveOriginalTarget(meta, key));
  }

  const excludedUserIds = uniqueStrings([
    meta.excludeUserId,
    meta.excludeUserIds,
    [...identity.userIds],
    options.excludeUserId,
    options.excludeUserIds,
  ]);
  const excludedUsernames = uniqueStrings([
    meta.excludeUsername,
    meta.excludeUsernames,
    [...identity.usernames],
    options.excludeUsername,
    options.excludeUsernames,
  ]);
  const excludedDeviceUuids = uniqueStrings([
    meta.excludeDeviceUuid,
    meta.excludeDeviceUuids,
    [...identity.deviceUuids],
    options.excludeDeviceUuid,
    options.excludeDeviceUuids,
  ]);

  delete meta.targetUserId;
  delete meta.targetUserIds;
  delete meta.targetUsername;
  delete meta.targetUsernames;
  delete meta.targetFullName;
  delete meta.targetFullNames;
  delete meta.targetDeviceUuid;
  delete meta.targetDeviceIdAliases;
  delete meta.targetClientIp;
  delete meta.targetConsumer;
  delete meta.targetStation;
  delete meta.bellEscalateAtMs;

  const targetUserIds = uniqueStrings(selected.map((waiter) => waiter.userId));
  meta.targetUserIds = targetUserIds;
  meta.targetClientApp = "mobile-frontend";
  if (sameRoomRecipients.length > 0) {
    meta.targetRoomId = roomId;
  } else {
    delete meta.targetRoomId;
    delete meta.targetRoomName;
  }
  if (excludedUserIds.length > 0) meta.excludeUserIds = excludedUserIds;
  if (excludedUsernames.length > 0) meta.excludeUsernames = excludedUsernames;
  if (excludedDeviceUuids.length > 0) {
    meta.excludeDeviceUuids = excludedDeviceUuids;
  }
  meta.targetFallbackActive = true;
  meta.targetFallbackReason = normalizeText(options.reason) || "no_online_target";
  meta.targetFallbackScope =
    sameRoomRecipients.length > 0 ? "same_room" : "online_mobile";
  meta.notificationHandoffActive = true;
  meta.notificationHandoffAtMs = Math.trunc(Number(options.nowMs) || Date.now());
  meta.notificationHandoffTargetCount = targetUserIds.length;
  meta.notificationHandoffTargets = selected.map((waiter) => ({
    userId: normalizeText(waiter.userId),
    username: normalizeText(waiter.username),
    fullName: normalizeText(waiter.fullName),
  }));
  notification.meta = meta;

  return {
    notification,
    notificationId: normalizeText(notification.id),
    orderId: normalizeText(meta.orderId),
    roomId,
    scope: meta.targetFallbackScope,
    targetUserIds,
    excludedUserIds,
  };
}

export function handoffOfflineOrderReadyNotifications(options = {}) {
  const notifications = Array.isArray(options.notifications)
    ? options.notifications
    : [];
  const handoffs = [];

  for (const notification of notifications) {
    if (!isOrderReadyNotification(notification) || isAcknowledged(notification)) {
      continue;
    }
    if (
      options.onlyTargetIdentity &&
      !notificationTargetsIdentity(notification, options.onlyTargetIdentity)
    ) {
      continue;
    }

    const identity = targetIdentity(notificationMeta(notification));
    if (!hasDirectTarget(identity)) continue;
    const online = collectOnlineWaiters(
      options.onlineWaiters ?? options.activeWaiters,
    );
    if (online.some((waiter) => waiterMatchesIdentity(waiter, identity))) {
      continue;
    }
    const available = collectAvailableWaiters(
      options.activeWaiters,
      notification,
    );
    const exclusions = excludedIdentity(notificationMeta(notification), options);
    const recipients = available.filter(
      (waiter) =>
        !waiterMatchesIdentity(waiter, identity) &&
        !waiterMatchesIdentity(waiter, exclusions),
    );
    const handoff = rewriteNotificationTarget(notification, recipients, options);
    if (handoff) handoffs.push(handoff);
  }

  return {
    mobileLogout: options.mobileLogout === true,
    changed: handoffs.length > 0,
    handoffs,
    notificationIds: handoffs.map((entry) => entry.notificationId).filter(Boolean),
    notifications: handoffs.map((entry) => entry.notification),
  };
}

export function buildOrderReadyHandoffRealtimeEvents(result = {}) {
  return (Array.isArray(result.handoffs) ? result.handoffs : []).map(
    (handoff) => ({
      reason: "notification_handoff",
      detail: {
        notificationId: handoff.notificationId,
        orderId: handoff.orderId,
        roomId: handoff.roomId,
        handoffScope: handoff.scope,
        notification: handoff.notification,
        notifications: [handoff.notification],
        audience: {
          clientApps: ["mobile-frontend"],
          userIds: [...handoff.targetUserIds],
          ...(handoff.scope === "same_room" && handoff.roomId
            ? { roomIds: [handoff.roomId] }
            : {}),
        },
      },
    }),
  );
}
