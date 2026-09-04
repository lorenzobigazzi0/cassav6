import { logoutSession, type LogoutSessionRequest } from "../../api/auth";
import { releaseActiveTableLocks } from "../../api/tableLocks";
import { useAuthStore } from "../../store/authStore";

type EndSessionOptions = {
  notifyBackend?: boolean;
  releaseLocks?: boolean;
};

export function captureCurrentLogoutSession(): LogoutSessionRequest {
  const { token, userId, deviceUuid, roomId } = useAuthStore.getState();
  return {
    token,
    userId,
    deviceUuid,
    roomId,
    clientApp: "mobile-frontend",
  };
}

/**
 * Revokes the browser session first, then performs remote cleanup with captured
 * credentials. Neither a slow backend nor an offline device can keep the UI active.
 */
export function endCurrentSession(options: EndSessionOptions = {}) {
  const snapshot = captureCurrentLogoutSession();
  useAuthStore.getState().logout();

  if (options.releaseLocks !== false) {
    void releaseActiveTableLocks().catch(() => undefined);
  }
  if (options.notifyBackend !== false) {
    void logoutSession(snapshot).catch(() => undefined);
  }
  return snapshot;
}
