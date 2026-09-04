export type NativeNotificationSessionContext = {
  token: string;
  userId: string;
  username: string;
  fullName: string;
  deviceUuid: string;
  sessionStartedAt: number;
  roomId: string;
  roomName: string;
  clientApp: "mobile-frontend";
};

type NativeNotificationBridge = {
  updateSessionContext?: (payloadJson: string) => boolean;
  clearSession?: () => boolean;
  // Transitional aliases for APKs produced while the definitive contract was landing.
  updateClientContext?: (payloadJson: string) => boolean;
  clearClientContext?: () => boolean;
};

declare global {
  interface Window {
    AmaliaNativeNotifications?: NativeNotificationBridge;
  }
}

const text = (value: unknown) => String(value ?? "").trim();

export function normalizeNativeNotificationSessionContext(
  context: Omit<NativeNotificationSessionContext, "clientApp" | "sessionStartedAt"> & {
    clientApp?: string;
    sessionStartedAt?: number | string | null;
  }
): NativeNotificationSessionContext {
  const sessionStartedAt = Number(context.sessionStartedAt);
  return {
    token: text(context.token),
    userId: text(context.userId),
    username: text(context.username),
    fullName: text(context.fullName),
    deviceUuid: text(context.deviceUuid),
    sessionStartedAt:
      Number.isFinite(sessionStartedAt) && sessionStartedAt > 0 ? sessionStartedAt : 0,
    roomId: text(context.roomId),
    roomName: text(context.roomName),
    clientApp: "mobile-frontend",
  };
}

export function clearNativeNotificationSession() {
  if (typeof window === "undefined") return false;
  const bridge = window.AmaliaNativeNotifications;
  const clear = bridge?.clearSession ?? bridge?.clearClientContext;
  if (typeof clear !== "function") return false;
  try {
    return clear.call(bridge) === true;
  } catch {
    return false;
  }
}

export function syncNativeNotificationSession(
  context: Omit<NativeNotificationSessionContext, "clientApp" | "sessionStartedAt"> & {
    clientApp?: string;
    sessionStartedAt?: number | string | null;
  }
) {
  const normalized = normalizeNativeNotificationSessionContext(context);
  if (
    !normalized.token ||
    !normalized.deviceUuid ||
    !normalized.sessionStartedAt ||
    (!normalized.userId && !normalized.username)
  ) {
    clearNativeNotificationSession();
    return false;
  }
  if (typeof window === "undefined") return false;
  const bridge = window.AmaliaNativeNotifications;
  const update = bridge?.updateSessionContext ?? bridge?.updateClientContext;
  if (typeof update !== "function") return false;
  try {
    return update.call(bridge, JSON.stringify(normalized)) === true;
  } catch {
    return false;
  }
}
