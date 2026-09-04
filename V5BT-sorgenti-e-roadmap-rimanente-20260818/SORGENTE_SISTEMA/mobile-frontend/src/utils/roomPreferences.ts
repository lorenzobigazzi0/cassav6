import {
  readRoomPreferenceMap,
  readRoomStorage,
  removeRoomStorage,
  ROOM_ID_KEY,
  ROOM_ACTIVITY_ID_KEY,
  ROOM_ACTIVITY_NAME_KEY,
  ROOM_NAME_KEY,
  ROOM_USER_ID_KEY,
  writeRoomPreferenceMap,
  writeRoomStorage,
} from "../shared/storage/roomPreferenceStorage";

type RoomLike = {
  id?: unknown;
  name?: unknown;
  roomId?: unknown;
  roomName?: unknown;
  activityId?: unknown;
  activityName?: unknown;
  activityIds?: unknown;
  enabled?: unknown;
  authorized?: unknown;
  requiresAdminAuth?: unknown;
};

const normalize = (value: unknown) => String(value ?? "").trim();

export function normalizeRoomLike(room: unknown) {
  if (!room || typeof room !== "object") return null;
  const source = room as RoomLike;
  const roomId = normalize(source.roomId ?? source.id);
  const roomName = normalize(source.roomName ?? source.name);
  const activityIds = Array.isArray(source.activityIds)
    ? source.activityIds.map((entry) => normalize(entry)).filter(Boolean)
    : [];
  const activityId = normalize(source.activityId) || activityIds[0] || "";
  const activityName = normalize(source.activityName);
  if (!roomId) return null;
  return { roomId, roomName, activityId, activityName, activityIds };
}

export function rememberRoomPreference(userId: unknown, room: unknown) {
  const safeUserId = normalize(userId || readRoomStorage(ROOM_USER_ID_KEY));
  const normalized = normalizeRoomLike(room);
  if (!safeUserId || !normalized) return;

  const map = readRoomPreferenceMap();
  map[safeUserId] = {
    roomId: normalized.roomId,
    roomName: normalized.roomName,
    activityId: normalized.activityId,
    activityName: normalized.activityName,
    updatedAt: new Date().toISOString(),
  };
  writeRoomPreferenceMap(map);
  writeRoomStorage(ROOM_ID_KEY, normalized.roomId);
  if (normalized.roomName) writeRoomStorage(ROOM_NAME_KEY, normalized.roomName);
  if (normalized.activityId) writeRoomStorage(ROOM_ACTIVITY_ID_KEY, normalized.activityId);
  if (normalized.activityName) writeRoomStorage(ROOM_ACTIVITY_NAME_KEY, normalized.activityName);

  window.dispatchEvent(
    new CustomEvent("mobile:room-preference-updated", {
      detail: {
        userId: safeUserId,
        roomId: normalized.roomId,
        roomName: normalized.roomName,
        activityId: normalized.activityId,
        activityName: normalized.activityName,
      },
    })
  );
}

export function clearStoredRoomPreference() {
  removeRoomStorage(ROOM_ID_KEY);
  removeRoomStorage(ROOM_NAME_KEY);
  removeRoomStorage(ROOM_ACTIVITY_ID_KEY);
  removeRoomStorage(ROOM_ACTIVITY_NAME_KEY);
}

export function restoreStoredRoomForCurrentUser() {
  const userId = normalize(readRoomStorage(ROOM_USER_ID_KEY));
  if (!userId) return;
  const preferred = readRoomPreferenceMap()[userId];
  if (!preferred?.roomId) return;
  writeRoomStorage(ROOM_ID_KEY, normalize(preferred.roomId));
  if (preferred.roomName) writeRoomStorage(ROOM_NAME_KEY, normalize(preferred.roomName));
  if (preferred.activityId) writeRoomStorage(ROOM_ACTIVITY_ID_KEY, normalize(preferred.activityId));
  if (preferred.activityName) writeRoomStorage(ROOM_ACTIVITY_NAME_KEY, normalize(preferred.activityName));
}

export function getPreferredRoomId(userId?: unknown) {
  const safeUserId = normalize(userId || readRoomStorage(ROOM_USER_ID_KEY));
  if (!safeUserId) return "";
  return normalize(readRoomPreferenceMap()[safeUserId]?.roomId);
}

export function isDirectRoom(room: unknown) {
  if (!room || typeof room !== "object") return false;
  const source = room as RoomLike;
  return (
    source.enabled !== false && source.authorized === true && source.requiresAdminAuth !== true
  );
}

export function findRoomById<T>(rooms: T[], roomId: string) {
  const safeRoomId = normalize(roomId);
  if (!safeRoomId) return null;
  return rooms.find((room) => normalizeRoomLike(room)?.roomId === safeRoomId) ?? null;
}

export function reorderRoomsByPreference<T>(rooms: T[], preferredRoomId: string) {
  const directRooms = rooms.filter(isDirectRoom);
  const otherRooms = rooms.filter((room) => !directRooms.includes(room));
  const ordered = directRooms.concat(otherRooms);
  if (!preferredRoomId) return ordered;

  const index = ordered.findIndex((room) => normalizeRoomLike(room)?.roomId === preferredRoomId);
  if (index < 0) return ordered;
  const [preferred] = ordered.splice(index, 1);
  if (!isDirectRoom(preferred)) return ordered.concat([preferred]);
  return [preferred].concat(ordered);
}
