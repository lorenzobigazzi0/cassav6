import { create } from "zustand";
import type { AuthUser } from "../types/auth";
import { setUnauthorizedHandler } from "../shared/api/apiClient";
import { dispatchMobileSessionEnding } from "../app/session/sessionLifecycle";
import {
  clearNativeNotificationSession,
  syncNativeNotificationSession,
} from "../shared/native/nativeNotificationSession";
import { cancelHapticPulse } from "../utils/haptics";
import {
  persistMobilePaymentRuntime,
  restoreMobilePaymentRuntime,
} from "../utils/paymentSessionRuntime";
import { rememberRoomPreference, restoreStoredRoomForCurrentUser } from "../utils/roomPreferences";
import {
  AUTH_STORAGE_KEYS,
  readAuthStorage,
  readAuthTimestamp,
  removeAuthStorage,
  writeAuthStorage,
} from "../shared/storage/authStorage";

const parsePermissions = (raw: string | null): AuthUser["permissions"] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AuthUser["permissions"]) : [];
  } catch {
    return [];
  }
};

const parseStringList = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
  } catch {
    return [];
  }
};

type AuthState = {
  token: string | null;
  userId: string | null;
  username: string | null;
  fullName: string | null;
  sessionStartedAt: number | null;
  role: AuthUser["role"] | null;
  roleLabel: string | null;
  permissions: AuthUser["permissions"];
  allowedPaymentMethodIds: string[];
  deviceUuid: string | null;
  roomId: string | null;
  roomName: string | null;
  activityId: string | null;
  activityName: string | null;
  setAuth: (payload: {
    token: string;
    user: AuthUser;
    deviceUuid: string;
    sessionStartedAt: number;
  }) => void;
  setRoom: (room: {
    roomId: string;
    roomName: string;
    activityId?: string;
    activityName?: string;
  }) => void;
  logout: () => void;
};

function syncNativeSessionFromState(state: AuthState) {
  syncNativeNotificationSession({
    token: state.token ?? "",
    userId: state.userId ?? "",
    username: state.username ?? "",
    fullName: state.fullName ?? "",
    deviceUuid: state.deviceUuid ?? "",
    sessionStartedAt: state.sessionStartedAt,
    roomId: state.roomId ?? "",
    roomName: state.roomName ?? "",
  });
}

const initialToken = readAuthStorage(AUTH_STORAGE_KEYS.token);
const initialSessionStartedAt = (() => {
  const stored = readAuthTimestamp(AUTH_STORAGE_KEYS.sessionStartedAt);
  if (stored !== null) return stored;
  if (!initialToken) return null;
  const now = Date.now();
  writeAuthStorage(AUTH_STORAGE_KEYS.sessionStartedAt, String(now));
  return now;
})();

export const useAuthStore = create<AuthState>((set, get) => ({
  token: initialToken,
  userId: readAuthStorage(AUTH_STORAGE_KEYS.userId),
  username: readAuthStorage(AUTH_STORAGE_KEYS.username),
  fullName:
    readAuthStorage(AUTH_STORAGE_KEYS.fullName) ?? readAuthStorage(AUTH_STORAGE_KEYS.username),
  sessionStartedAt: initialSessionStartedAt,
  role: (readAuthStorage(AUTH_STORAGE_KEYS.role) as AuthUser["role"] | null) ?? null,
  roleLabel: readAuthStorage(AUTH_STORAGE_KEYS.roleLabel),
  permissions: parsePermissions(readAuthStorage(AUTH_STORAGE_KEYS.permissions)),
  allowedPaymentMethodIds: parseStringList(
    readAuthStorage(AUTH_STORAGE_KEYS.allowedPaymentMethodIds)
  ),
  deviceUuid: readAuthStorage(AUTH_STORAGE_KEYS.deviceUuid),
  roomId: readAuthStorage(AUTH_STORAGE_KEYS.roomId),
  roomName: readAuthStorage(AUTH_STORAGE_KEYS.roomName),
  activityId: readAuthStorage(AUTH_STORAGE_KEYS.activityId),
  activityName: readAuthStorage(AUTH_STORAGE_KEYS.activityName),
  setAuth: ({ token, user, deviceUuid, sessionStartedAt }) => {
    const allowedPaymentMethodIds = Array.isArray(user.allowedPaymentMethodIds)
      ? [
          ...new Set(
            user.allowedPaymentMethodIds.map((entry) => String(entry ?? "").trim()).filter(Boolean)
          ),
        ]
      : [];
    writeAuthStorage(AUTH_STORAGE_KEYS.token, token);
    writeAuthStorage(AUTH_STORAGE_KEYS.userId, user.id);
    writeAuthStorage(AUTH_STORAGE_KEYS.username, user.username);
    writeAuthStorage(AUTH_STORAGE_KEYS.fullName, user.fullName);
    writeAuthStorage(AUTH_STORAGE_KEYS.role, user.role);
    writeAuthStorage(AUTH_STORAGE_KEYS.roleLabel, user.roleLabel);
    writeAuthStorage(AUTH_STORAGE_KEYS.permissions, JSON.stringify(user.permissions || []));
    writeAuthStorage(
      AUTH_STORAGE_KEYS.allowedPaymentMethodIds,
      JSON.stringify(allowedPaymentMethodIds)
    );
    writeAuthStorage(AUTH_STORAGE_KEYS.sessionStartedAt, String(sessionStartedAt));
    writeAuthStorage(AUTH_STORAGE_KEYS.deviceUuid, deviceUuid);
    restoreStoredRoomForCurrentUser();
    restoreMobilePaymentRuntime("auth:setAuth");
    set({
      token,
      userId: user.id,
      username: user.username,
      fullName: user.fullName,
      sessionStartedAt,
      role: user.role,
      roleLabel: user.roleLabel,
      permissions: user.permissions || [],
      allowedPaymentMethodIds,
      deviceUuid,
      roomId: readAuthStorage(AUTH_STORAGE_KEYS.roomId),
      roomName: readAuthStorage(AUTH_STORAGE_KEYS.roomName),
      activityId: readAuthStorage(AUTH_STORAGE_KEYS.activityId),
      activityName: readAuthStorage(AUTH_STORAGE_KEYS.activityName),
    });
    syncNativeSessionFromState(get());
  },
  setRoom: ({ roomId, roomName, activityId = "", activityName = "" }) => {
    rememberRoomPreference(get().userId ?? readAuthStorage(AUTH_STORAGE_KEYS.userId), {
      roomId,
      roomName,
      activityId,
      activityName,
    });
    writeAuthStorage(AUTH_STORAGE_KEYS.roomId, roomId);
    writeAuthStorage(AUTH_STORAGE_KEYS.roomName, roomName);
    if (activityId) writeAuthStorage(AUTH_STORAGE_KEYS.activityId, activityId);
    else removeAuthStorage(AUTH_STORAGE_KEYS.activityId);
    if (activityName) writeAuthStorage(AUTH_STORAGE_KEYS.activityName, activityName);
    else removeAuthStorage(AUTH_STORAGE_KEYS.activityName);
    set({ roomId, roomName, activityId: activityId || null, activityName: activityName || null });
    syncNativeSessionFromState(get());
  },
  logout: () => {
    dispatchMobileSessionEnding();
    cancelHapticPulse();
    clearNativeNotificationSession();
    persistMobilePaymentRuntime("before-logout");
    removeAuthStorage(AUTH_STORAGE_KEYS.token);
    removeAuthStorage(AUTH_STORAGE_KEYS.userId);
    removeAuthStorage(AUTH_STORAGE_KEYS.username);
    removeAuthStorage(AUTH_STORAGE_KEYS.fullName);
    removeAuthStorage(AUTH_STORAGE_KEYS.role);
    removeAuthStorage(AUTH_STORAGE_KEYS.roleLabel);
    removeAuthStorage(AUTH_STORAGE_KEYS.permissions);
    removeAuthStorage(AUTH_STORAGE_KEYS.allowedPaymentMethodIds);
    removeAuthStorage(AUTH_STORAGE_KEYS.sessionStartedAt);
    removeAuthStorage(AUTH_STORAGE_KEYS.roomId);
    removeAuthStorage(AUTH_STORAGE_KEYS.roomName);
    removeAuthStorage(AUTH_STORAGE_KEYS.activityId);
    removeAuthStorage(AUTH_STORAGE_KEYS.activityName);
    set({
      token: null,
      userId: null,
      username: null,
      fullName: null,
      sessionStartedAt: null,
      role: null,
      roleLabel: null,
      permissions: [],
      allowedPaymentMethodIds: [],
      deviceUuid: readAuthStorage(AUTH_STORAGE_KEYS.deviceUuid),
      roomId: null,
      roomName: null,
      activityId: null,
      activityName: null,
    });
  },
}));

syncNativeSessionFromState(useAuthStore.getState());

// A protected API can return 401 for a single operation without meaning that
// the whole mobile login session must be destroyed. Session lifecycle is owned
// by App.tsx through /api/auth/session/status, where invalid states must be
// confirmed consecutively before logout. This prevents unrelated endpoint
// failures from kicking the operator back to login mid-service.
setUnauthorizedHandler(() => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("mobile:api-unauthorized"));
  }
});
