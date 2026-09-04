import { useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../api/baseUrl";
import { readLocalPreference, writeLocalPreference } from "../../shared/storage/preferenceStorage";
import { useRealtimeTransportStatus } from "./realtimeTransportStatus";
import {
  SETTINGS_VERSION_EVENT,
  resolveSettingsVersion,
  type SettingsVersionEventDetail,
} from "../../shared/settings/settingsVersionEvents";

const FALLBACK_POLL_MS = 90_000;
const STORAGE_KEY = "pos:settings-version";
const BANNER_VISIBLE_MS = 1800;

function readStoredVersion() {
  try {
    const value = Number(readLocalPreference(STORAGE_KEY) || "");
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeStoredVersion(version: number) {
  try {
    writeLocalPreference(STORAGE_KEY, String(version));
  } catch {
    // ignore storage failures
  }
}

function queryKeyStartsWith(queryKey: readonly unknown[], prefix: string) {
  return String(queryKey[0] ?? "") === prefix;
}

function invalidateSettingsQueries(queryClient: QueryClient) {
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const queryKey = query.queryKey;
      return (
        queryKeyStartsWith(queryKey, "available-rooms") ||
        queryKeyStartsWith(queryKey, "home-dashboard") ||
        queryKeyStartsWith(queryKey, "menu-catalog") ||
        queryKeyStartsWith(queryKey, "order-workflow-settings") ||
        queryKeyStartsWith(queryKey, "payment-overview") ||
        queryKeyStartsWith(queryKey, "tables-order-menu") ||
        queryKeyStartsWith(queryKey, "tables-room")
      );
    },
  });
}

/**
 * Live-syncs server settings versions. Ported from the retired
 * src/mobile/installMobileSettingsLiveSync.ts into a hook. Query invalidation stays
 * on TanStack Query; the previously DOM-injected banner/style are replaced by React
 * state — the hook returns whether the "Configurazione aggiornata." banner is
 * visible, rendered by SettingsSyncBanner. With SSE connected it is driven by
 * settings.updated payloads; /api/health stays as initial baseline and slow fallback.
 */
export function useSettingsLiveSync(queryClient: QueryClient): boolean {
  const [bannerVisible, setBannerVisible] = useState(false);
  const realtimeTransport = useRealtimeTransportStatus();

  useEffect(() => {
    const state: {
      baseline: number | null;
      syncing: boolean;
      pending: { version: number; source: string } | null;
    } = {
      baseline: readStoredVersion() || null,
      syncing: false,
      pending: null,
    };
    let disposed = false;
    let bannerTimer: number | null = null;

    const triggerSync = (version: number, source: string, showBanner = true) => {
      if (disposed) return;
      if (state.syncing) {
        if (!state.pending || version >= state.pending.version) {
          state.pending = { version, source };
        }
        return;
      }
      state.syncing = true;
      invalidateSettingsQueries(queryClient);
      window.dispatchEvent(
        new CustomEvent("pos:settings-sync", {
          detail: { version, source },
        })
      );
      if (showBanner) setBannerVisible(true);
      if (bannerTimer !== null) window.clearTimeout(bannerTimer);
      bannerTimer = window.setTimeout(() => {
        if (disposed) return;
        bannerTimer = null;
        state.syncing = false;
        setBannerVisible(false);
        const pending = state.pending;
        state.pending = null;
        if (pending) {
          triggerSync(pending.version, pending.source, false);
          return;
        }
      }, BANNER_VISIBLE_MS);
    };

    const handleVersionEvent = (event: Event) => {
      const detail = (event as CustomEvent<SettingsVersionEventDetail>).detail;
      const version = Number(detail?.version);
      if (!Number.isFinite(version) || version <= 0) return;
      const previous = state.baseline;
      state.baseline = previous === null ? version : Math.max(previous, version);
      writeStoredVersion(version);
      if (previous !== null && version > previous) {
        triggerSync(version, detail?.source || SETTINGS_VERSION_EVENT);
      }
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      const version = Number(event.newValue || "");
      if (!Number.isFinite(version) || version <= 0) return;
      if (state.baseline === null || version > state.baseline) {
        state.baseline = version;
        triggerSync(version, "storage");
      }
    };

    const pollVersion = async () => {
      try {
        const response = await apiFetch(`/api/health?_=${Date.now()}`, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload || payload.ok !== true) return;

        const remoteVersion = resolveSettingsVersion(payload);
        if (!remoteVersion) return;

        const storedVersion = readStoredVersion();
        if (state.baseline === null) {
          state.baseline = Math.max(remoteVersion, storedVersion);
          writeStoredVersion(state.baseline);
          return;
        }

        const nextVersion = Math.max(remoteVersion, storedVersion);
        if (nextVersion > state.baseline) {
          state.baseline = nextVersion;
          writeStoredVersion(nextVersion);
          triggerSync(nextVersion, "health-poll");
        }
      } catch {
        // ignore polling failures
      }
    };

    const handleServerPayload = (event: Event) => {
      const payload = (event as CustomEvent<Record<string, unknown>>).detail;
      const type = String(payload?.type ?? "")
        .trim()
        .toLowerCase();
      const reason = String(payload?.reason ?? "")
        .trim()
        .toLowerCase();
      if (type !== "settings.updated" && !reason.includes("settings")) return;
      const detail =
        payload?.detail && typeof payload.detail === "object" ? payload.detail : payload;
      const version = Math.max(resolveSettingsVersion(detail), resolveSettingsVersion(payload));
      if (version <= 0) {
        void pollVersion();
        return;
      }
      const previous = state.baseline;
      state.baseline = previous === null ? version : Math.max(previous, version);
      writeStoredVersion(version);
      if (previous !== null && version > previous) {
        triggerSync(version, "sse-settings");
      }
    };

    const onFocus = () => {
      if (!realtimeTransport.connected && !state.syncing) void pollVersion();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(SETTINGS_VERSION_EVENT, handleVersionEvent);
    window.addEventListener("pos:server-payload", handleServerPayload);
    window.addEventListener("focus", onFocus);
    void pollVersion();
    const pollTimer = !realtimeTransport.connected
      ? window.setInterval(() => {
          if (!document.hidden && !state.syncing) void pollVersion();
        }, FALLBACK_POLL_MS)
      : null;

    return () => {
      disposed = true;
      if (bannerTimer !== null) window.clearTimeout(bannerTimer);
      setBannerVisible(false);
      if (pollTimer !== null) window.clearInterval(pollTimer);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(SETTINGS_VERSION_EVENT, handleVersionEvent);
      window.removeEventListener("pos:server-payload", handleServerPayload);
      window.removeEventListener("focus", onFocus);
    };
  }, [queryClient, realtimeTransport.connected]);

  return bannerVisible;
}
