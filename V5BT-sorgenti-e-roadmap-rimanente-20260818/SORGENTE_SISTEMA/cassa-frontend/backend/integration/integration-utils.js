import {
  INTEGRATION_STATIONS,
  PRIMARY_INTEGRATION_STATION,
} from "../app-state/initial-state.js";

export function slugifyId(value, fallback = "item") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

export function normalizeIntegrationItemKey(value) {
  return slugifyId(value, "");
}

export function normalizeIntegrationLookupKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function collectIntegrationLookupTokens(...values) {
  const tokens = new Set();
  for (const value of values) {
    const normalized = normalizeIntegrationLookupKey(value);
    if (!normalized) continue;
    normalized
      .split(" ")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 3)
      .forEach((entry) => tokens.add(entry));
  }
  return [...tokens];
}

export function collectIntegrationLookupKeys(...values) {
  const keys = new Set();
  for (const value of values) {
    const normalized = normalizeIntegrationLookupKey(value);
    if (normalized) {
      keys.add(normalized);
      keys.add(normalized.replace(/\s+/g, ""));
    }
    const itemKey = normalizeIntegrationItemKey(value);
    if (itemKey) {
      keys.add(itemKey);
      keys.add(itemKey.replace(/_/g, ""));
    }
  }
  return [...keys].filter(Boolean);
}

export function measureIntegrationSharedPrefix(left, right) {
  const safeLeft = String(left ?? "").trim();
  const safeRight = String(right ?? "").trim();
  const limit = Math.min(safeLeft.length, safeRight.length);
  let shared = 0;
  while (shared < limit && safeLeft.charAt(shared) === safeRight.charAt(shared)) {
    shared += 1;
  }
  return shared;
}

export function normalizeIntegrationStationToken(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeIntegrationStationComparable(value) {
  return normalizeIntegrationStationToken(value).replace(/[^a-z0-9]+/g, "");
}

export function resolveCanonicalIntegrationStation(value) {
  const token = normalizeIntegrationStationToken(value);
  if (!token) return "";
  const compactToken = normalizeIntegrationStationComparable(token);
  if (token === "bar" || token === "barprincipale" || token === "bar principale") {
    return PRIMARY_INTEGRATION_STATION;
  }
  return (
    INTEGRATION_STATIONS.find((entry) => {
      const normalizedEntry = normalizeIntegrationStationToken(entry);
      return (
        normalizedEntry === token ||
        normalizedEntry.replace(/\s+/g, "") === token.replace(/\s+/g, "") ||
        normalizeIntegrationStationComparable(entry) === compactToken
      );
    }) || ""
  );
}

export function normalizeIntegrationStationScope(value) {
  const station = String(value ?? "").trim();
  if (!station) return "";
  const placeholder = station.toLowerCase();
  if (
    placeholder === "undefined" ||
    placeholder === "null" ||
    placeholder === "nan" ||
    placeholder === "postazione"
  ) {
    return "";
  }
  const canonicalStation = resolveCanonicalIntegrationStation(station);
  if (canonicalStation) return canonicalStation;
  return station.slice(0, 64);
}
