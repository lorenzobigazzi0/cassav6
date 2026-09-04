const DEFAULT_DEDUP_MS = 2 * 60 * 1000;
const MAX_STATE_ENTRIES = 200;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : fallback;
}

function normalizeActiveStationNames(activeStations) {
  return Array.isArray(activeStations)
    ? activeStations
        .map((entry) => normalizeText(entry?.station ?? entry))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right, "it", { sensitivity: "base" }))
    : [];
}

export function createStationAvailabilityNotificationKey(options = {}) {
  const eventType = normalizeText(options.eventType) || "station_availability";
  if (eventType === "no_active_stations") return `${eventType}:global`;
  if (eventType === "active_stations_restored") {
    const activeStations = normalizeActiveStationNames(options.activeStations);
    return `${eventType}:${activeStations.join("|") || "any"}`;
  }
  return `${eventType}:${normalizeText(options.station) || "global"}`;
}

function pruneState(state, nowMs, ttlMs) {
  const entries = Object.entries(state)
    .filter(([, value]) => value && typeof value === "object")
    .sort((left, right) => normalizeNumber(right[1].lastNotifiedAtMs, 0) - normalizeNumber(left[1].lastNotifiedAtMs, 0));
  const maxAgeMs = Math.max(ttlMs * 4, DEFAULT_DEDUP_MS);
  return Object.fromEntries(
    entries
      .filter(([, value]) => nowMs - normalizeNumber(value.lastNotifiedAtMs, 0) <= maxAgeMs)
      .slice(0, MAX_STATE_ENTRIES),
  );
}

export function reserveStationAvailabilityNotification(integration, options = {}) {
  const nowMs = normalizeNumber(options.nowMs, Date.now());
  const ttlMs = normalizeNumber(options.ttlMs, DEFAULT_DEDUP_MS);
  const key = createStationAvailabilityNotificationKey(options);
  if (!integration || typeof integration !== "object") return { key, nowMs, suppressed: false };
  const state =
    integration.stationAvailabilityNotificationState &&
    typeof integration.stationAvailabilityNotificationState === "object"
      ? integration.stationAvailabilityNotificationState
      : {};
  const previous = state[key] && typeof state[key] === "object" ? state[key] : null;
  const lastNotifiedAtMs = normalizeNumber(previous?.lastNotifiedAtMs, 0);
  integration.stationAvailabilityNotificationState = state;
  if (previous && ttlMs > 0 && nowMs - lastNotifiedAtMs < ttlMs) {
    return { key, nowMs, previous, suppressed: true };
  }
  state[key] = {
    eventType: normalizeText(options.eventType) || "station_availability",
    station: normalizeText(options.station),
    lastNotifiedAtMs: nowMs,
    notificationId: "",
  };
  integration.stationAvailabilityNotificationState = pruneState(state, nowMs, ttlMs);
  return { key, nowMs, suppressed: false };
}

export function commitStationAvailabilityNotification(integration, reservation, notification) {
  if (!integration || typeof integration !== "object" || !reservation?.key) return;
  const state =
    integration.stationAvailabilityNotificationState &&
    typeof integration.stationAvailabilityNotificationState === "object"
      ? integration.stationAvailabilityNotificationState
      : {};
  const entry = state[reservation.key] && typeof state[reservation.key] === "object" ? state[reservation.key] : {};
  state[reservation.key] = {
    ...entry,
    lastNotifiedAtMs: reservation.nowMs,
    notificationId: normalizeText(notification?.id),
  };
  integration.stationAvailabilityNotificationState = state;
}
