import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyMenuCatalogPatches,
  fetchMenuCatalog,
  fetchMenuCatalogForSession,
  fetchMenuCatalogUpdatesForSession,
  menuCatalogQueryKey,
  type MenuCatalogSnapshot,
} from "../../../../api/menu";
import { useRealtimeTransportStatus } from "../../../../app/runtime/realtimeTransportStatus";
import { useAuthStore } from "../../../../store/authStore";
import { useTimedPricingRefresh } from "./useTimedPricingRefresh";

const MENU_UPDATES_POLL_MS = 15_000;
const MENU_UPDATES_CONNECTED_FALLBACK_MS = 90_000;

export function useMenuSessionSync(enabled = true) {
  const queryClient = useQueryClient();
  const { token, userId, deviceUuid, roomId } = useAuthStore();
  const realtimeTransport = useRealtimeTransportStatus();
  const effectiveRoomId = roomId || "";
  const canSync = enabled && Boolean(token && userId && deviceUuid && effectiveRoomId);
  const key = menuCatalogQueryKey(effectiveRoomId);
  const versionRef = useRef(0);

  const bootstrapQuery = useQuery({
    queryKey: key,
    enabled: canSync,
    staleTime: 1000 * 60,
    queryFn: async () => {
      try {
        return await fetchMenuCatalogForSession({
          token: token || "",
          userId: userId || "",
          deviceUuid: deviceUuid || "",
          roomId: effectiveRoomId,
        });
      } catch {
        const catalog = await fetchMenuCatalog();
        return { version: 0, catalog };
      }
    },
  });

  useEffect(() => {
    if (!bootstrapQuery.data) return;
    versionRef.current = bootstrapQuery.data.version;
  }, [bootstrapQuery.data]);

  useTimedPricingRefresh({
    enabled: canSync && Boolean(bootstrapQuery.data?.catalog.products.length),
    products: bootstrapQuery.data?.catalog.products ?? [],
    onRefresh: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  useEffect(() => {
    if (!canSync) return;

    versionRef.current = bootstrapQuery.data?.version ?? 0;
    let active = true;

    const poll = async () => {
      if (!token || !userId || !deviceUuid) return;
      try {
        const updates = await fetchMenuCatalogUpdatesForSession({
          token,
          userId,
          deviceUuid,
          roomId: effectiveRoomId,
          sinceVersion: versionRef.current,
        });
        if (!active) return;

        if (updates.updates.length > 0) {
          queryClient.setQueryData<MenuCatalogSnapshot | undefined>(key, (current) => {
            if (!current) return current;
            return {
              version: updates.version,
              catalog: applyMenuCatalogPatches(current.catalog, updates.updates),
            };
          });
        } else {
          queryClient.setQueryData<MenuCatalogSnapshot | undefined>(key, (current) => {
            if (!current || current.version === updates.version) return current;
            return { ...current, version: updates.version };
          });
        }

        versionRef.current = updates.version;
      } catch {
        // noop in mock mode
      }
    };

    const handleServerEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: unknown; type?: unknown }>).detail;
      const reason = String(detail?.reason ?? "").trim().toLowerCase();
      const type = String(detail?.type ?? "").trim().toLowerCase();
      if (type !== "settings.updated" && !reason.includes("settings")) return;
      void poll();
    };
    window.addEventListener("pos:server-payload", handleServerEvent);
    window.addEventListener("pos:server-refresh", handleServerEvent);
    const id = window.setInterval(
      () => void poll(),
      realtimeTransport.connected ? MENU_UPDATES_CONNECTED_FALLBACK_MS : MENU_UPDATES_POLL_MS,
    );
    void poll();

    return () => {
      active = false;
      window.removeEventListener("pos:server-payload", handleServerEvent);
      window.removeEventListener("pos:server-refresh", handleServerEvent);
      window.clearInterval(id);
    };
  }, [
    bootstrapQuery.data?.version,
    canSync,
    deviceUuid,
    effectiveRoomId,
    key,
    queryClient,
    realtimeTransport.connected,
    token,
    userId,
  ]);

  return bootstrapQuery;
}
