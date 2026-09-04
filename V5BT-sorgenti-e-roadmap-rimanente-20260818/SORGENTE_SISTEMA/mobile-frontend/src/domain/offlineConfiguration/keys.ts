import type { OfflineConfigurationScope } from "./types";

const normalizeScopePart = (value: string) => value.trim();

export function normalizeOfflineConfigurationScope(
  scope: OfflineConfigurationScope
): OfflineConfigurationScope | null {
  const userId = normalizeScopePart(scope.userId);
  const activityId = normalizeScopePart(scope.activityId);
  if (!userId || !activityId) return null;
  return { userId, activityId };
}

export function offlineConfigurationSnapshotKey(scope: OfflineConfigurationScope) {
  const normalized = normalizeOfflineConfigurationScope(scope);
  if (!normalized) return null;
  return `configuration:${encodeURIComponent(normalized.userId)}:${encodeURIComponent(
    normalized.activityId
  )}`;
}

export function offlineMenuRoomKey(roomId: string) {
  return encodeURIComponent(roomId.trim());
}

export function offlineReservationsKey(roomId: string, serviceDate: string) {
  return `${encodeURIComponent(roomId.trim())}:${encodeURIComponent(serviceDate.trim())}`;
}

export function parseOfflineReservationsKey(key: string) {
  const separatorIndex = key.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= key.length - 1) return null;
  try {
    const roomId = decodeURIComponent(key.slice(0, separatorIndex)).trim();
    const serviceDate = decodeURIComponent(key.slice(separatorIndex + 1)).trim();
    return roomId && serviceDate ? { roomId, serviceDate } : null;
  } catch {
    return null;
  }
}
