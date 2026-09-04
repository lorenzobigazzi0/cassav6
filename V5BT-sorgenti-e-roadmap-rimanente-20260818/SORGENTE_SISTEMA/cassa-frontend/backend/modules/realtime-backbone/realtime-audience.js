function normalize(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

function values(...candidates) {
  const output = [];
  for (const candidate of candidates) {
    const entries = Array.isArray(candidate) ? candidate : [candidate];
    for (const entry of entries) {
      const normalized = normalize(entry);
      if (normalized && !output.includes(normalized)) output.push(normalized);
    }
  }
  return output;
}

function intersects(left = [], right = []) {
  if (left.length === 0 || right.length === 0) return false;
  const lookup = new Set(left);
  return right.some((entry) => lookup.has(entry));
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function buildRealtimeSubscription(input = {}) {
  const subscription = {
    clientApps: values(input.clientApp, input.clientApps),
    storeIds: values(input.storeId, input.storeIds),
    roomIds: values(input.roomId, input.roomName, input.roomIds),
    stationIds: values(input.station, input.stationId, input.stationName, input.stationIds),
    deviceIds: values(input.deviceUuid, input.deviceId, input.deviceIds),
    userIds: values(input.userId, input.username, input.fullName, input.userIds),
    roles: values(input.role, input.roles),
    departments: values(input.department, input.departments),
  };
  subscription.scoped = Object.entries(subscription)
    .filter(([name]) => name !== "clientApps")
    .some(([, entries]) => Array.isArray(entries) && entries.length > 0);
  return subscription;
}

export function resolveRealtimeAudience(event = {}) {
  const root = object(event);
  const eventPayload = object(root.payload);
  const payload = Object.keys(eventPayload).length > 0 ? eventPayload : root;
  const detail = object(payload.detail);
  const explicit = object(detail.audience ?? payload.audience ?? root.audience);
  const notification = object(detail.notification);
  const notificationMeta = object(notification.meta ?? detail.meta);
  const order = object(detail.order);
  const table = object(detail.table);
  const eventType = normalize(root.type ?? root.eventType ?? payload.type);

  const audience = {
    global: explicit.global === true || ["settings.updated", "system.refresh"].includes(eventType),
    clientApps: values(explicit.clientApp, explicit.clientApps, notificationMeta.targetClientApp),
    storeIds: values(explicit.storeId, explicit.storeIds, detail.storeId, order.storeId, table.storeId),
    roomIds: values(
      explicit.roomId,
      explicit.roomIds,
      detail.roomId,
      detail.roomName,
      detail.targetRoomId,
      detail.sourceRoomId,
      order.roomId,
      order.roomName,
      table.roomId,
      table.roomName,
      notificationMeta.roomId,
      notificationMeta.roomName,
    ),
    stationIds: values(
      explicit.stationId,
      explicit.stationIds,
      detail.station,
      detail.stationName,
      detail.targetStation,
      detail.ownerStation,
      detail.toStation,
      detail.fromStation,
      order.station,
      order.ownerStation,
      notificationMeta.targetStation,
      notificationMeta.station,
      notificationMeta.stationName,
    ),
    deviceIds: values(
      explicit.deviceId,
      explicit.deviceIds,
      explicit.deviceUuid,
      detail.targetDeviceUuid,
      notificationMeta.targetDeviceUuid,
      notificationMeta.targetDeviceIdAliases,
    ),
    userIds: values(
      explicit.userId,
      explicit.userIds,
      detail.targetUserId,
      detail.targetUsername,
      detail.targetFullName,
      notificationMeta.targetUserId,
      notificationMeta.targetUserIds,
      notificationMeta.targetUsername,
      notificationMeta.targetFullName,
    ),
    roles: values(explicit.role, explicit.roles),
    departments: values(explicit.department, explicit.departments),
  };
  audience.targeted = audience.deviceIds.length > 0 || audience.userIds.length > 0;
  audience.scoped = Object.entries(audience)
    .filter(([name]) => !["global", "targeted", "clientApps"].includes(name))
    .some(([, entries]) => Array.isArray(entries) && entries.length > 0);
  return audience;
}

export function isRealtimeSubscriptionEligible(subscription = {}, audience = {}, options = {}) {
  if (options.enabled !== true || audience.global === true || subscription.scoped !== true) return true;

  if (audience.clientApps?.length > 0 && !intersects(subscription.clientApps, audience.clientApps)) {
    return false;
  }
  if (audience.targeted === true) {
    return (
      intersects(subscription.deviceIds, audience.deviceIds) ||
      intersects(subscription.userIds, audience.userIds)
    );
  }
  if (audience.roles?.length > 0 && !intersects(subscription.roles, audience.roles)) return false;
  if (audience.departments?.length > 0 && !intersects(subscription.departments, audience.departments)) return false;
  if (audience.storeIds?.length > 0 && subscription.storeIds?.length > 0) {
    if (!intersects(subscription.storeIds, audience.storeIds)) return false;
  }

  const contextualMatches = [];
  if (audience.roomIds?.length > 0 && subscription.roomIds?.length > 0) {
    contextualMatches.push(intersects(subscription.roomIds, audience.roomIds));
  }
  if (audience.stationIds?.length > 0 && subscription.stationIds?.length > 0) {
    contextualMatches.push(intersects(subscription.stationIds, audience.stationIds));
  }
  return contextualMatches.length === 0 || contextualMatches.some(Boolean);
}
