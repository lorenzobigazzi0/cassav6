import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { menuCatalogQueryKey } from "../../api/menu";
import { reservationsQueryKey } from "../../api/reservations";
import { isRuntimeFeatureEnabled } from "../../config/runtimeConfig";
import { parseOfflineReservationsKey } from "../../domain/offlineConfiguration/keys";
import { readOfflineConfigurationSnapshot } from "../../domain/offlineConfiguration/repository";
import type { OfflineConfigurationRefreshResult } from "../../domain/offlineConfiguration/types";
import { useAuthStore } from "../../store/authStore";
import { OFFLINE_REPLAY_APPLIED_EVENT } from "../../shared/offline/offlineRuntime";
import { REALTIME_TRANSPORT_STATUS_EVENT } from "./realtimeTransportStatus";
import {
  buildOfflineReservationDateWindow,
  OFFLINE_RESERVATION_SYNC_WINDOW_DAYS,
  refreshOfflineConfiguration,
  type OfflineConfigurationSyncSession,
} from "./offlineConfigurationRefresh";

const BACKGROUND_REFRESH_MS = 60_000;

const invalidateOfflineConfigurationQueries = async (
  queryClient: QueryClient,
  session: OfflineConfigurationSyncSession,
  result: OfflineConfigurationRefreshResult
) => {
  const snapshot = result.snapshot;
  if (
    !snapshot ||
    snapshot.userId !== session.userId.trim() ||
    snapshot.activityId !== session.activityId.trim()
  ) {
    return;
  }

  const invalidations: Promise<unknown>[] = [];
  if (result.refreshed.rooms) {
    invalidations.push(
      queryClient.invalidateQueries({ queryKey: ["available-rooms"] }),
      queryClient.invalidateQueries({ queryKey: ["reservations-available-rooms"] })
    );
  }
  if (result.refreshed.layout || result.refreshed.reservationKeys.length > 0) {
    invalidations.push(queryClient.invalidateQueries({ queryKey: ["tables-room"] }));
  }

  const roomsById = new Map((snapshot.rooms?.value ?? []).map((room) => [room.id, room]));
  result.refreshed.menuRoomIds.forEach((roomId) => {
    const roomActivityId = roomsById.get(roomId)?.activityId?.trim() || session.activityId;
    invalidations.push(
      queryClient.invalidateQueries({ queryKey: menuCatalogQueryKey(roomId) }),
      queryClient.invalidateQueries({
        queryKey: ["tables-order-menu", roomActivityId, roomId],
      })
    );
  });
  result.refreshed.reservationKeys.forEach((key) => {
    const parsed = parseOfflineReservationsKey(key);
    if (!parsed) return;
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: reservationsQueryKey(parsed.roomId, parsed.serviceDate),
      })
    );
  });

  await Promise.all(invalidations);
};

export function useOfflineConfigurationSync(queryClient: QueryClient) {
  const token = useAuthStore((state) => state.token);
  const userId = useAuthStore((state) => state.userId);
  const deviceUuid = useAuthStore((state) => state.deviceUuid);
  const role = useAuthStore((state) => state.role);
  const roomId = useAuthStore((state) => state.roomId);
  const activityId = useAuthStore((state) => state.activityId);

  useEffect(() => {
    if (
      !isRuntimeFeatureEnabled("offlineMode") ||
      !token ||
      !userId ||
      !deviceUuid ||
      !role ||
      !activityId
    ) {
      return;
    }

    let disposed = false;
    const session: OfflineConfigurationSyncSession = {
      token,
      userId,
      deviceUuid,
      role,
      currentRoomId: roomId || undefined,
      activityId,
    };
    const isSessionCurrent = () => {
      if (disposed) return false;
      const current = useAuthStore.getState();
      return (
        current.token === token && current.userId === userId && current.activityId === activityId
      );
    };
    const activateStoredSnapshot = async () => {
      const snapshot = await readOfflineConfigurationSnapshot({ userId, activityId });
      if (!snapshot || !isSessionCurrent()) return;
      await invalidateOfflineConfigurationQueries(queryClient, session, {
        snapshot,
        refreshed: {
          rooms: Boolean(snapshot.rooms),
          layout: Boolean(snapshot.layout),
          menuRoomIds: Object.keys(snapshot.menusByRoom)
            .map((key) => {
              try {
                return decodeURIComponent(key);
              } catch {
                return "";
              }
            })
            .filter(Boolean),
          reservationKeys: Object.keys(snapshot.reservationsByRoomDate),
        },
      });
    };
    const refresh = async () => {
      if (!isSessionCurrent() || navigator.onLine === false) return;
      const result = await refreshOfflineConfiguration(session, {
        serviceDates: buildOfflineReservationDateWindow(
          Date.now(),
          OFFLINE_RESERVATION_SYNC_WINDOW_DAYS
        ),
        isSessionCurrent,
      });
      if (!isSessionCurrent()) return;
      await invalidateOfflineConfigurationQueries(queryClient, session, result);
    };
    const refreshReservationWindow = () => {
      void refresh().catch(() => undefined);
    };
    const handleRealtimeStatus = (event: Event) => {
      const connected = (event as CustomEvent<{ connected?: boolean }>).detail?.connected;
      if (connected === true) refreshReservationWindow();
    };
    const handleVisibility = () => {
      if (!document.hidden) refreshReservationWindow();
    };
    const handleSettingsUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: unknown; type?: unknown }>).detail;
      const reason = String(detail?.reason ?? "").toLowerCase();
      const type = String(detail?.type ?? "").toLowerCase();
      if (type === "settings.updated" || reason.includes("settings")) refreshReservationWindow();
    };

    window.addEventListener("online", refreshReservationWindow);
    window.addEventListener("focus", refreshReservationWindow);
    window.addEventListener(OFFLINE_REPLAY_APPLIED_EVENT, refreshReservationWindow);
    window.addEventListener(REALTIME_TRANSPORT_STATUS_EVENT, handleRealtimeStatus);
    window.addEventListener("pos:server-payload", handleSettingsUpdate);
    window.addEventListener("pos:server-refresh", handleSettingsUpdate);
    document.addEventListener("visibilitychange", handleVisibility);
    void activateStoredSnapshot().catch(() => undefined);
    void refresh().catch(() => undefined);
    const interval = window.setInterval(refreshReservationWindow, BACKGROUND_REFRESH_MS);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("online", refreshReservationWindow);
      window.removeEventListener("focus", refreshReservationWindow);
      window.removeEventListener(OFFLINE_REPLAY_APPLIED_EVENT, refreshReservationWindow);
      window.removeEventListener(REALTIME_TRANSPORT_STATUS_EVENT, handleRealtimeStatus);
      window.removeEventListener("pos:server-payload", handleSettingsUpdate);
      window.removeEventListener("pos:server-refresh", handleSettingsUpdate);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [activityId, deviceUuid, queryClient, role, roomId, token, userId]);
}
