import { apiJson } from "./baseUrl";

export async function fetchActiveStationCount(): Promise<number | null> {
  const countActiveStations = (stations: unknown[]) =>
    stations.filter((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const station = entry as {
        active?: unknown;
        stale?: unknown;
        realStation?: unknown;
        isDemoFallback?: unknown;
        configuredStation?: unknown;
      };
      return (
        station.active !== false &&
        station.stale !== true &&
        station.configuredStation !== true &&
        (station.realStation === true || station.isDemoFallback === true)
      );
    }).length;

  try {
    const payload = await apiJson<{ ok?: unknown; stations?: unknown } | null>(
      `/api/integration/stations/active?_=${Date.now()}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }
    );
    if (!payload || payload.ok !== true || !Array.isArray(payload.stations)) return null;
    if (payload.stations.length > 0) return payload.stations.length;

    const statePayload = await apiJson<{ ok?: unknown; stations?: unknown } | null>(
      `/api/integration/stations/state?_=${Date.now()}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }
    );
    if (!statePayload || statePayload.ok !== true || !Array.isArray(statePayload.stations)) {
      return payload.stations.length;
    }
    return countActiveStations(statePayload.stations);
  } catch {
    return null;
  }
}
