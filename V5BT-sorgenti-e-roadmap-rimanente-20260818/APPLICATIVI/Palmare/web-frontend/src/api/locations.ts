import { login } from "./auth";
import type { UserRole } from "../types/auth";
import {
  findRoomById,
  getPreferredRoomId,
  isDirectRoom,
  normalizeRoomLike,
  rememberRoomPreference,
  reorderRoomsByPreference,
  restoreStoredRoomForCurrentUser,
} from "../utils/roomPreferences";
import { apiFetch } from "./baseUrl";
import { readLocalStorageString, writeLocalStorageString } from "../shared/storage/storageAdapter";
import { resolveOfflineConfigurationScope } from "./offlineConfigurationScope";
import { readOfflineRooms, recordOfflineRooms } from "../domain/offlineConfiguration/repository";

export type Room = {
  id: string;
  name: string;
  activityId?: string;
  activityName?: string;
  activityIds?: string[];
};

type RoomChangeRequestRecord = {
  requestId: string;
  userId: string;
  targetRoom: Room;
  deviceUuid: string;
  createdAt: number;
};

export type RequestRoomChangeResponse =
  | { status: "approved"; room: Room }
  | { status: "pending"; requestId: string; room: Room };

export type ApproveRoomChangeResponse =
  | { ok: true; room: Room; approver: { username: string; role: UserRole } }
  | { ok: false; error: string };

const BACKEND_TIMEOUT_MS = 30000;
const ROOM_CACHE_KEY_PREFIX = "pos_available_rooms_cache_v2";
const ROOM_CACHE_MAX_AGE_MS = 2 * 60 * 1000;

const pendingRoomChanges = new Map<string, RoomChangeRequestRecord>();

const isAuthorizedRole = (role: UserRole) => role === "admin" || role === "responsabile";
const toUserRole = (value: unknown): UserRole =>
  value === "admin" || value === "responsabile" ? value : "operator";

const makeRequestId = () => `room_req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

const parseRoom = (raw: unknown): Room | null => {
  const normalized = normalizeRoomLike(raw);
  if (!normalized || !normalized.roomName) return null;
  return {
    id: normalized.roomId,
    name: normalized.roomName,
    activityId: normalized.activityId || undefined,
    activityName: normalized.activityName || undefined,
    activityIds: normalized.activityIds,
  };
};

const sanitizeRoomList = (rooms: unknown): Room[] => {
  const seen = new Set<string>();
  return (Array.isArray(rooms) ? rooms : []).map(parseRoom).filter((room): room is Room => {
    if (!room || seen.has(room.id)) return false;
    seen.add(room.id);
    return true;
  });
};

const roomCacheKeyForUser = (userId: string, activityId?: string) => {
  const normalized = userId.trim() || "anonymous";
  const activity = String(activityId ?? "").trim() || "unscoped";
  return `${ROOM_CACHE_KEY_PREFIX}:${encodeURIComponent(normalized)}:${encodeURIComponent(activity)}`;
};

const readCachedRooms = (userId: string, activityId?: string): Room[] | null => {
  try {
    const parsed = JSON.parse(
      readLocalStorageString(roomCacheKeyForUser(userId, activityId)) || "null"
    ) as {
      savedAt?: unknown;
      rooms?: unknown;
    } | null;
    const savedAt = Number(parsed?.savedAt ?? 0);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > ROOM_CACHE_MAX_AGE_MS) {
      return null;
    }
    if (!Array.isArray(parsed?.rooms)) return null;
    return sanitizeRoomList(parsed.rooms);
  } catch {
    return null;
  }
};

const writeCachedRooms = (rooms: Room[], userId: string, activityId?: string) => {
  const safeRooms = sanitizeRoomList(rooms);
  try {
    writeLocalStorageString(
      roomCacheKeyForUser(userId, activityId),
      JSON.stringify({ savedAt: Date.now(), rooms: safeRooms })
    );
  } catch {
    // Cache best-effort: room availability must not fail because storage is blocked.
  }
};

const parseBackendError = (payload: unknown, fallback: string) => {
  if (payload && typeof payload === "object") {
    const source = payload as Record<string, unknown>;
    const error = String(source.error ?? "").trim();
    if (error) return error;
  }
  return fallback;
};

type BackendResult =
  | { kind: "ok"; payload: unknown }
  | { kind: "error"; error: string }
  | { kind: "unavailable" };

const postPosEndpoint = async (
  path: string,
  body: Record<string, unknown>,
  options: { useOfflineOnServerError?: boolean } = {}
): Promise<BackendResult> => {
  const ctrl = new AbortController();
  const timeoutId = window.setTimeout(() => ctrl.abort(), BACKEND_TIMEOUT_MS);
  try {
    const response = await apiFetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      if (options.useOfflineOnServerError && response.status >= 500) {
        return { kind: "unavailable" };
      }
      return {
        kind: "error",
        error: parseBackendError(payload, `Errore backend (${response.status}).`),
      };
    }
    return { kind: "ok", payload };
  } catch {
    return { kind: "unavailable" };
  } finally {
    window.clearTimeout(timeoutId);
  }
};

export async function fetchAvailableRooms(params: {
  token: string;
  userId: string;
  role: UserRole;
  deviceUuid: string;
  currentRoomId?: string;
  activityId?: string;
}) {
  if (!params.token || !params.userId || !params.deviceUuid) {
    throw new Error("Sessione non valida.");
  }
  restoreStoredRoomForCurrentUser();

  const backend = await postPosEndpoint(
    "/api/pos/rooms",
    {
      token: params.token,
      userId: params.userId,
      role: params.role,
      deviceUuid: params.deviceUuid,
      currentRoomId: params.currentRoomId,
      activityId: params.activityId,
    },
    { useOfflineOnServerError: true }
  );

  if (backend.kind === "ok") {
    const source = backend.payload as Record<string, unknown>;
    if (!Array.isArray(source.rooms)) {
      throw new Error("Risposta backend sale non valida.");
    }
    const roomsRaw = source.rooms;
    const currentRoomId =
      String(params.currentRoomId ?? "").trim() || getPreferredRoomId(params.userId);
    const currentRoom = findRoomById(roomsRaw, currentRoomId);
    const keepCurrentRoom = Boolean(currentRoom && isDirectRoom(currentRoom));
    const initialRoomId = String(normalizeRoomLike(source.initialRoom)?.roomId ?? "").trim();
    const initialRoom = parseRoom(findRoomById(roomsRaw, initialRoomId));
    if (!keepCurrentRoom && initialRoom) rememberRoomPreference(params.userId, initialRoom);
    const preferredRoomId = keepCurrentRoom
      ? currentRoomId
      : String(
          initialRoom?.id || source.lastSelectedRoomId || getPreferredRoomId(params.userId)
        ).trim();
    const rooms = reorderRoomsByPreference(roomsRaw, preferredRoomId)
      .map(parseRoom)
      .filter((room): room is Room => room !== null);
    if (roomsRaw.length > 0 && rooms.length === 0) {
      throw new Error("Risposta backend sale non valida.");
    }
    const activityId = String(params.activityId ?? "").trim();
    const scopedRooms = activityId
      ? rooms.filter(
          (room) =>
            !room.activityId ||
            room.activityId === activityId ||
            room.activityIds?.includes(activityId)
        )
      : rooms;
    const roomsToCache = activityId ? scopedRooms : rooms;
    writeCachedRooms(roomsToCache, params.userId, activityId);
    const offlineScope = resolveOfflineConfigurationScope(params);
    if (offlineScope) await recordOfflineRooms(offlineScope, roomsToCache);
    return roomsToCache;
  }
  if (backend.kind === "error") {
    throw new Error(backend.error);
  }

  const offlineScope = resolveOfflineConfigurationScope(params);
  const offlineRooms = offlineScope ? await readOfflineRooms(offlineScope) : null;
  if (offlineRooms !== null) {
    return reorderRoomsByPreference(offlineRooms, getPreferredRoomId(params.userId));
  }
  const cachedRooms = readCachedRooms(params.userId, params.activityId);
  if (cachedRooms !== null) {
    return reorderRoomsByPreference(cachedRooms, getPreferredRoomId(params.userId));
  }
  throw new Error(
    "Nessuna sala disponibile: verifica la configurazione backend o riconnettiti alla rete POS."
  );
}

export async function requestRoomChange(params: {
  token: string;
  userId: string;
  role: UserRole;
  deviceUuid: string;
  targetRoomId: string;
}): Promise<RequestRoomChangeResponse> {
  if (!params.token || !params.userId || !params.deviceUuid) {
    throw new Error("Sessione non valida.");
  }

  const backend = await postPosEndpoint("/api/pos/room-change/request", {
    token: params.token,
    userId: params.userId,
    role: params.role,
    deviceUuid: params.deviceUuid,
    targetRoomId: params.targetRoomId,
  });
  if (backend.kind === "ok") {
    const source = backend.payload as Record<string, unknown>;
    const status = String(source.status ?? "").trim();
    const room = parseRoom(source.room);
    if (!room) {
      throw new Error("Risposta backend non valida.");
    }
    if (status === "approved") {
      rememberRoomPreference(params.userId, room);
      return { status: "approved", room };
    }
    const requestId = String(source.requestId ?? "").trim();
    if (!requestId) {
      throw new Error("Risposta backend non valida.");
    }
    return { status: "pending", requestId, room };
  }
  if (backend.kind === "error") {
    throw new Error(backend.error);
  }

  const cachedRooms = readCachedRooms(params.userId);
  const allowedRooms = import.meta.env.DEV ? cachedRooms : null;
  if (!allowedRooms || allowedRooms.length === 0) {
    throw new Error(
      "Nessuna sala disponibile: verifica la configurazione backend o riconnettiti alla rete POS."
    );
  }
  const targetRoom = allowedRooms.find((room) => room.id === params.targetRoomId);
  if (!targetRoom) {
    throw new Error("Sala non disponibile per questo utente.");
  }

  if (isAuthorizedRole(params.role)) {
    rememberRoomPreference(params.userId, targetRoom);
    return { status: "approved", room: targetRoom };
  }

  const requestId = makeRequestId();
  pendingRoomChanges.set(requestId, {
    requestId,
    userId: params.userId,
    targetRoom,
    deviceUuid: params.deviceUuid,
    createdAt: Date.now(),
  });

  return { status: "pending", requestId, room: targetRoom };
}

export async function approveRoomChangeRequest(params: {
  requestId: string;
  approverUsername: string;
  approverPin: string;
  deviceUuid: string;
}): Promise<ApproveRoomChangeResponse> {
  const backend = await postPosEndpoint("/api/pos/room-change/approve", {
    requestId: params.requestId,
    approverUsername: params.approverUsername,
    approverPin: params.approverPin,
    deviceUuid: params.deviceUuid,
  });
  if (backend.kind === "ok") {
    const source = backend.payload as Record<string, unknown>;
    if (source.ok !== true) {
      return {
        ok: false,
        error: parseBackendError(backend.payload, "Errore durante l'approvazione."),
      };
    }
    const room = parseRoom(source.room);
    const approverSource =
      source.approver && typeof source.approver === "object"
        ? (source.approver as Record<string, unknown>)
        : null;
    const username = String(approverSource?.username ?? "").trim();
    const role = toUserRole(approverSource?.role);
    if (!room || !username) {
      return { ok: false, error: "Risposta backend non valida." };
    }
    rememberRoomPreference(undefined, room);
    return {
      ok: true,
      room,
      approver: {
        username,
        role,
      },
    };
  }
  if (backend.kind === "error") {
    return {
      ok: false,
      error: backend.error,
    };
  }

  const pending = pendingRoomChanges.get(params.requestId);
  if (!pending) {
    return { ok: false, error: "Richiesta non trovata o scaduta." };
  }

  const auth = await login({
    username: params.approverUsername,
    pin: params.approverPin,
    deviceUuid: params.deviceUuid,
  });
  if (!auth.ok) {
    return { ok: false, error: "Credenziali autorizzatore non valide." };
  }

  if (!isAuthorizedRole(auth.user.role)) {
    return { ok: false, error: "Utente non autorizzato ad approvare il cambio sala." };
  }

  pendingRoomChanges.delete(params.requestId);
  rememberRoomPreference(pending.userId, pending.targetRoom);
  return {
    ok: true,
    room: pending.targetRoom,
    approver: {
      username: auth.user.username,
      role: auth.user.role,
    },
  };
}

export async function cancelRoomChangeRequest(requestId: string) {
  if (!requestId.trim()) return;

  const backend = await postPosEndpoint("/api/pos/room-change/cancel", {
    requestId,
  });
  if (backend.kind === "error") {
    // keep local fallback only when backend is unavailable
    return;
  }
  pendingRoomChanges.delete(requestId);
}
