import { useEffect, useRef } from "react";
import { fetchActiveStationCount } from "../../../../api/stations";

export const NO_ACTIVE_STATIONS_MESSAGE = "NESSUNA POSTAZIONE ATTIVA";

const STATION_AVAILABILITY_REASONS = new Set([
  "station_availability_alert",
  "station_state_changed",
]);

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const isNoActiveStationOrderWarning = (code: unknown, message: unknown) => {
  const normalizedCode = String(code ?? "").trim().toLowerCase();
  if (normalizedCode === "station_paused_only_target") return true;
  return String(message ?? "").trim().toLowerCase().includes("nessuna postazione attiva");
};

export const readRealtimeActiveStationCount = (value: unknown): number | null => {
  const detail = toRecord(value);
  if (!detail) return null;
  const reason = String(detail.reason ?? detail.type ?? "").trim().toLowerCase();
  if (!STATION_AVAILABILITY_REASONS.has(reason)) return null;

  if (Array.isArray(detail.activeStations)) return detail.activeStations.length;
  const count = Number(detail.activeStations);
  if (Number.isFinite(count) && count >= 0) return Math.trunc(count);
  if (reason === "station_state_changed" && detail.active === true) return 1;
  return null;
};

export function useStationAvailabilityRecovery({
  enabled,
  onRestored,
}: {
  enabled: boolean;
  onRestored: () => void;
}) {
  const onRestoredRef = useRef(onRestored);

  useEffect(() => {
    onRestoredRef.current = onRestored;
  }, [onRestored]);

  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    let checking = false;
    let restored = false;

    const markRestored = () => {
      if (!active || restored) return;
      restored = true;
      onRestoredRef.current();
    };
    const refresh = async () => {
      if (!active || checking || restored) return;
      checking = true;
      try {
        const count = await fetchActiveStationCount();
        if (count !== null && count > 0) markRestored();
      } finally {
        checking = false;
      }
    };
    const handleRealtime = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const count = readRealtimeActiveStationCount(detail);
      if (count !== null) {
        if (count > 0) markRestored();
        return;
      }
      const record = toRecord(detail);
      const reason = String(record?.reason ?? record?.type ?? "").trim().toLowerCase();
      if (STATION_AVAILABILITY_REASONS.has(reason)) void refresh();
    };

    window.addEventListener("pos:server-payload", handleRealtime);
    window.addEventListener("pos:server-refresh", handleRealtime);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("pos:server-payload", handleRealtime);
      window.removeEventListener("pos:server-refresh", handleRealtime);
    };
  }, [enabled]);
}
