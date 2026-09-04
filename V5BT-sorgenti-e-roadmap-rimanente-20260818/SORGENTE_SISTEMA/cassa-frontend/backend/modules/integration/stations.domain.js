import { normalizeIntegrationStationScope } from "../../integration/integration-utils.js";

export function normalizeIntegrationStationName(value, fallbackStation = "") {
  return normalizeIntegrationStationScope(value) || String(fallbackStation ?? "").trim() || "";
}

export function normalizeOptionalIntegrationStationName(value, fallbackStation = "") {
  const raw = String(value ?? "").trim();
  return raw ? normalizeIntegrationStationName(raw, fallbackStation) : null;
}

export function isInvalidIntegrationStationName(value) {
  const comparable = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return !comparable || ["undefined", "null", "nan", "postazione", "station"].includes(comparable);
}

export function normalizeConfiguredIntegrationStationName(value) {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  if (isInvalidIntegrationStationName(raw)) return "";
  const scoped = normalizeIntegrationStationScope(raw);
  const station = scoped || raw;
  return station.replace(/\s+/g, " ").trim().toUpperCase().slice(0, 64);
}

export function dedupeConfiguredIntegrationStations(values) {
  const seen = new Set();
  const result = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const station = normalizeConfiguredIntegrationStationName(value);
    if (!station || seen.has(station)) return;
    seen.add(station);
    result.push(station);
  });
  return result;
}

export function resolveConfiguredIntegrationStationsFromSettings(settings) {
  const workstations = [];
  if (Array.isArray(settings?.workstations)) {
    workstations.push(...settings.workstations);
  }
  for (const area of Array.isArray(settings?.areas) ? settings.areas : []) {
    if (Array.isArray(area?.workstations)) {
      workstations.push(...area.workstations);
    }
  }
  for (const room of Array.isArray(settings?.rooms) ? settings.rooms : []) {
    if (Array.isArray(room?.workstations)) {
      workstations.push(...room.workstations);
    }
  }
  return dedupeConfiguredIntegrationStations(
    workstations
      .filter((workstation) => workstation && typeof workstation === "object")
      .filter((workstation) => workstation.enabled !== false && workstation.status !== "disabled")
      .map((workstation) => workstation.stationName ?? workstation.station ?? workstation.name ?? workstation.id)
  );
}

export function resolveConfiguredIntegrationStations(dbOrSettings) {
  const settings = dbOrSettings?.posSettings ?? dbOrSettings;
  return resolveConfiguredIntegrationStationsFromSettings(settings);
}

export function resolvePrimaryIntegrationStation(dbOrSettings, fallbackStation = "") {
  return resolveConfiguredIntegrationStations(dbOrSettings)[0] || String(fallbackStation ?? "").trim() || "";
}
