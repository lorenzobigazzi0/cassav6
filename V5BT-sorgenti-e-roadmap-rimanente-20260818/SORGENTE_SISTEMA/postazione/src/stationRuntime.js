const INVALID_STATION_KEYS = new Set([
  "",
  "undefined",
  "null",
  "nan",
  "postazione",
  "station",
  "unsigned",
]);

const UNAVAILABLE_STATION_STATUSES = new Set([
  "paused",
  "pausa",
  "offline",
  "stale",
  "inactive",
  "inattiva",
]);

const HISTORICAL_WORKFLOWS = new Set([
  "delivered",
  "done",
  "completed",
  "paid",
  "consegnato",
  "consegnata",
  "completato",
  "completata",
  "pagato",
  "pagata",
]);

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const normalizeKey = (value) => normalizeText(value).toLowerCase();
const stationKey = (value) => normalizeKey(value).replace(/[^a-z0-9]+/g, "");

export function normalizeStationName(value) {
  const station = normalizeText(value)
    .replace(/^["']|["']$/g, "")
    .replace(/^postazione\s+attiva\s*/i, "")
    .trim();
  const key = stationKey(station);
  if (INVALID_STATION_KEYS.has(key)) return "";
  if (["bar", "barprincipale", "bar1", "caffetteria"].includes(key)) return "BAR-1";
  if (key === "bar2") return "BAR-2";
  return station.toUpperCase();
}

export function dedupeStationNames(values) {
  const seen = new Set();
  const stations = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const station = normalizeStationName(value);
    if (!station || seen.has(station)) return;
    seen.add(station);
    stations.push(station);
  });
  return stations;
}

function stationNameFromEntry(entry) {
  if (typeof entry === "string" || typeof entry === "number") return entry;
  if (!entry || typeof entry !== "object") return "";
  return entry.stationName ?? entry.station ?? entry.name ?? entry.id ?? "";
}

export function configuredStationsFromPayload(payload, additionalStations = []) {
  const source = payload && typeof payload === "object" ? payload : {};
  const configured = Array.isArray(source.configuredStations) ? source.configuredStations : [];
  const integration = Array.isArray(source.integrationStations) ? source.integrationStations : [];
  const workstations = Array.isArray(source.workstations) ? source.workstations : [];
  const states = Array.isArray(source.stations) ? source.stations : [];

  return dedupeStationNames([
    ...configured.map(stationNameFromEntry),
    ...integration.map(stationNameFromEntry),
    ...workstations.map(stationNameFromEntry),
    ...states.map(stationNameFromEntry),
    ...(Array.isArray(additionalStations) ? additionalStations : []),
  ]);
}

export function normalizeStationSession(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const station = normalizeStationName(entry.station ?? entry.stationName);
  if (!station) return null;

  const pauseStatus =
    entry.pauseStatus && typeof entry.pauseStatus === "object" && !Array.isArray(entry.pauseStatus)
      ? { ...entry.pauseStatus }
      : null;

  return {
    station,
    operatorUserId: normalizeText(entry.operatorUserId ?? entry.userId),
    operatorUsername: normalizeText(entry.operatorUsername ?? entry.username),
    operatorName: normalizeText(entry.operatorName ?? entry.operator),
    operatorRole: normalizeText(entry.operatorRole ?? entry.role),
    deviceUuid: normalizeText(entry.deviceUuid ?? entry.deviceId),
    clientApp: normalizeText(entry.clientApp ?? entry.source),
    updatedAtMs: Number.isFinite(Number(entry.updatedAtMs))
      ? Math.max(0, Math.trunc(Number(entry.updatedAtMs)))
      : 0,
    active: entry.active !== false,
    realStation: entry.realStation === true,
    isDemoFallback: entry.isDemoFallback === true,
    configuredStation: entry.configuredStation === true,
    stale: entry.stale === true,
    paused: entry.paused === true || entry.onPause === true || entry.isPaused === true,
    pauseStatus,
    status: normalizeKey(entry.status ?? entry.stationStatus ?? entry.availability),
  };
}

export function isRealActiveStation(session) {
  const entry = normalizeStationSession(session);
  if (!entry || entry.active === false || entry.stale === true) return false;
  if (entry.realStation !== true) return false;
  if (entry.isDemoFallback === true || entry.configuredStation === true) return false;
  if (entry.paused === true) return false;
  if (
    entry.pauseStatus &&
    (entry.pauseStatus.active === true || normalizeKey(entry.pauseStatus.status) === "paused")
  ) {
    return false;
  }
  return !UNAVAILABLE_STATION_STATUSES.has(entry.status);
}

export function normalizeActiveStationsPayload(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const sessions = (Array.isArray(source.stations) ? source.stations : [])
    .map(normalizeStationSession)
    .filter(Boolean);
  const activeSessions = sessions.filter(isRealActiveStation);

  return {
    ok: source.ok === true,
    showDemoStations: source.showDemoStations === true,
    configuredStations: configuredStationsFromPayload(source),
    sessions,
    activeSessions,
    activeStations: dedupeStationNames(activeSessions.map((entry) => entry.station)),
  };
}

export function stationSessionMatchesIdentity(session, identity) {
  const entry = normalizeStationSession(session);
  if (!entry || !identity || typeof identity !== "object") return false;

  const expectedUserId = normalizeText(identity.operatorUserId ?? identity.userId ?? identity.id);
  if (expectedUserId && entry.operatorUserId === expectedUserId) return true;

  const expectedUsername = normalizeKey(identity.operatorUsername ?? identity.username);
  if (expectedUsername && normalizeKey(entry.operatorUsername) === expectedUsername) return true;

  const expectedDevice = normalizeText(identity.deviceUuid ?? identity.deviceId);
  if (expectedDevice && entry.deviceUuid === expectedDevice) return true;

  const expectedName = normalizeKey(
    identity.operatorName ?? identity.fullName ?? identity.userName ?? identity.name
  );
  return Boolean(expectedName && normalizeKey(entry.operatorName) === expectedName);
}

export function findStationOccupant(sessions, station, currentIdentity = null) {
  const stationName = normalizeStationName(station);
  if (!stationName) return null;

  return (
    (Array.isArray(sessions) ? sessions : [])
      .map(normalizeStationSession)
      .filter(Boolean)
      .find(
        (entry) =>
          entry.station === stationName &&
          isRealActiveStation(entry) &&
          !stationSessionMatchesIdentity(entry, currentIdentity)
      ) || null
  );
}

export function isStationOccupiedByOther(sessions, station, currentIdentity = null) {
  return findStationOccupant(sessions, station, currentIdentity) !== null;
}

export function tableLabelForOrder(order, fallback = "-") {
  const explicitLabel = normalizeText(order?.tableLabel || order?.logicalTableLabel).replace(
    /^tavolo\s+/i,
    ""
  );
  if (explicitLabel) return explicitLabel;

  const number = Number(order?.tableNumber ?? order?.table);
  return Number.isFinite(number) && number > 0 ? String(Math.trunc(number)) : fallback;
}

export function formatDurationHHMMSS(durationMs) {
  const rawMilliseconds = Number(durationMs);
  const totalSeconds = Number.isFinite(rawMilliseconds)
    ? Math.max(0, Math.floor(rawMilliseconds / 1000))
    : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

export function isHistoricalOrder(order) {
  if (!order || typeof order !== "object") return false;
  const workflow = normalizeKey(order.workflowStatus ?? order.status).replace(/_/g, " ");
  if (HISTORICAL_WORKFLOWS.has(workflow)) return true;

  const paymentStatus = normalizeKey(order.paymentStatus);
  if (["paid", "pagato", "pagata"].includes(paymentStatus)) return true;

  const completedAtMs = Number(order.completedAtMs);
  if (Number.isFinite(completedAtMs) && completedAtMs > 0) return true;

  const dueAmount = Number(order.dueAmount);
  return (
    order.dueAmount !== null &&
    order.dueAmount !== undefined &&
    order.dueAmount !== "" &&
    Number.isFinite(dueAmount) &&
    dueAmount <= 0.009
  );
}

export function classifyOrderHistory(order) {
  return isHistoricalOrder(order) ? "history" : "operational";
}

export function orderTimestamp(order) {
  for (const value of [
    order?.receivedAtMs,
    order?.createdAtMs,
    order?.readyAtMs,
    order?.completedAtMs,
  ]) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  const parsedDate = Date.parse(String(order?.createdAt ?? order?.updatedAt ?? ""));
  return Number.isFinite(parsedDate) ? parsedDate : 0;
}

export function compareOrdersOperationalFirst(left, right) {
  const leftHistorical = isHistoricalOrder(left);
  const rightHistorical = isHistoricalOrder(right);
  if (leftHistorical !== rightHistorical) return leftHistorical ? 1 : -1;
  return orderTimestamp(right) - orderTimestamp(left);
}

export function sortOrdersOperationalFirst(orders) {
  return [...(Array.isArray(orders) ? orders : [])].sort(compareOrdersOperationalFirst);
}
