import { NOTIFICATION_PRIORITY_LEVELS } from "./notification-priority.js";

const DEFAULT_PRIORITIES = Object.freeze(Object.keys(NOTIFICATION_PRIORITY_LEVELS));

function normalizePriorityEntry(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return NOTIFICATION_PRIORITY_LEVELS[normalized] ? normalized : "";
}

export function normalizeWaiterNotificationPriorities(user = {}) {
  const source =
    user.notificationPriorities ??
    user.waiterNotificationPriorities ??
    user.notificationPriorityLevels;
  if (Array.isArray(source)) {
    const list = [...new Set(source.map(normalizePriorityEntry).filter(Boolean))];
    return list.length > 0 ? list : [...DEFAULT_PRIORITIES];
  }
  if (source && typeof source === "object") {
    const list = Object.entries(source)
      .filter(([, enabled]) => enabled !== false)
      .map(([key]) => normalizePriorityEntry(key))
      .filter(Boolean);
    return [...new Set(list)].length > 0 ? [...new Set(list)] : [...DEFAULT_PRIORITIES];
  }
  return [...DEFAULT_PRIORITIES];
}

export function buildWaiterRoutingMetadata(db = {}, user = {}, session = {}) {
  const userId = String(user.id ?? session.userId ?? "").trim();
  const currentRoomId = String(session.roomId ?? "").trim();
  const areas = Array.isArray(db?.posSettings?.areas) ? db.posSettings.areas : [];
  const assignedRoomIds = areas
    .filter((area) =>
      (Array.isArray(area?.waiterUserIds) ? area.waiterUserIds : [])
        .map((entry) => String(entry ?? "").trim())
        .includes(userId)
    )
    .map((area) => String(area?.id ?? "").trim())
    .filter(Boolean);
  const userRoomIds = [
    ...(Array.isArray(user.enabledRoomIds) ? user.enabledRoomIds : []),
    ...(Array.isArray(user.authorizedRoomIds) ? user.authorizedRoomIds : []),
  ]
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  const uniqueRoomIds = [...new Set([...assignedRoomIds, ...userRoomIds])];
  const liveRoomIds = currentRoomId ? [currentRoomId] : uniqueRoomIds;
  return {
    assignedRoomIds: liveRoomIds,
    assignedToCurrentRoom: Boolean(currentRoomId && liveRoomIds.includes(currentRoomId)),
    notificationPriorities: normalizeWaiterNotificationPriorities(user),
  };
}
