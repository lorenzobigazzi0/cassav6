export function createIntegrationStationStateHelpers(options = {}) {
  const {
    normalizeUsername = (value) => String(value ?? "").trim().toLowerCase(),
    normalizeClientApp = (value) => String(value ?? "").trim(),
    normalizeIntegrationStationName = (value, fallback = "") => String(value ?? fallback ?? "").trim(),
    dedupeConfiguredIntegrationStations = (values) => [...new Set(Array.isArray(values) ? values : [])],
    integrationStations = [],
    primaryIntegrationStation = "",
    stationStaleMs = 0,
    heartbeatWriteMinIntervalMs = 0,
    showDemoStations = false,
    nowMs = () => Date.now(),
  } = options;

  function isIntegrationDemoStationEntry(source, station, operatorName, operatorRole, deviceUuid) {
    if (source?.isDemoFallback === true) return true;
    if (source?.realStation === true) return false;
    if (deviceUuid) return false;
    const operatorKey = normalizeUsername(operatorName);
    const roleKey = normalizeUsername(operatorRole);
    return (
      integrationStations.includes(station) &&
      (!operatorKey || operatorKey === "guest") &&
      (!roleKey || roleKey === "non_autenticato" || roleKey === "non autenticato")
    );
  }

  function isIntegrationStationStale(updatedAtMs, currentNowMs = nowMs()) {
    if (!stationStaleMs || stationStaleMs <= 0) return false;
    if (!Number.isFinite(Number(updatedAtMs)) || Number(updatedAtMs) <= 0) return false;
    return currentNowMs - Number(updatedAtMs) > stationStaleMs;
  }

  function sanitizeIntegrationStationStateEntry(entry, fallbackStation = primaryIntegrationStation) {
    const source = entry && typeof entry === "object" ? entry : {};
    const station = normalizeIntegrationStationName(source.station ?? fallbackStation);
    const operatorName = String(source.operatorName ?? source.operator ?? "Guest").trim() || "Guest";
    const operatorUserId = String(source.operatorUserId ?? source.userId ?? "").trim();
    const operatorUsername = String(source.operatorUsername ?? source.username ?? "").trim();
    const operatorRole =
      String(source.operatorRole ?? source.role ?? "Non autenticato").trim() ||
      "Non autenticato";
    const deviceUuid = String(source.deviceUuid ?? "").trim();
    const clientApp = normalizeClientApp(source.clientApp ?? "postazione") || "postazione";
    const updatedAtMs = Number.isFinite(Number(source.updatedAtMs))
      ? Math.max(0, Math.trunc(Number(source.updatedAtMs)))
      : nowMs();
    const isDemoFallback = isIntegrationDemoStationEntry(
      source,
      station,
      operatorName,
      operatorRole,
      deviceUuid
    );
    const realStation = source.realStation === true || (!isDemoFallback && deviceUuid.length > 0);
    const stale = realStation ? isIntegrationStationStale(updatedAtMs) : false;
    return {
      station,
      active: isDemoFallback && !showDemoStations ? false : source.active !== false && stale !== true,
      autoPrintOrders: source.autoPrintOrders === true,
      autoPrintPreconto: source.autoPrintPreconto === true,
      operatorUserId: operatorUserId.slice(0, 120),
      operatorUsername: operatorUsername.slice(0, 120),
      operatorName: operatorName.slice(0, 64),
      operatorRole: operatorRole.slice(0, 64),
      deviceUuid: deviceUuid.slice(0, 120),
      clientApp,
      updatedAtMs,
      realStation,
      isDemoFallback,
      configuredStation: source.configuredStation === true,
      stale,
    };
  }

  function integrationStationStateKey(entry) {
    const source = entry && typeof entry === "object" ? entry : {};
    const station = normalizeIntegrationStationName(source.station ?? primaryIntegrationStation);
    const identity =
      String(source.operatorUserId ?? source.userId ?? "").trim() ||
      String(source.operatorUsername ?? source.username ?? "").trim() ||
      String(source.deviceUuid ?? "").trim() ||
      (source.configuredStation === true ? "__configured__" : source.isDemoFallback === true ? "__demo__" : "__station__");
    return `${station}::${identity || "__station__"}`;
  }

  function integrationStationStateStableFingerprint(entry) {
    const normalized = sanitizeIntegrationStationStateEntry(entry);
    return JSON.stringify({
      station: normalized.station,
      active: normalized.active !== false,
      autoPrintOrders: normalized.autoPrintOrders === true,
      autoPrintPreconto: normalized.autoPrintPreconto === true,
      operatorUserId: normalized.operatorUserId,
      operatorUsername: normalized.operatorUsername,
      deviceUuid: normalized.deviceUuid,
      clientApp: normalized.clientApp,
      realStation: normalized.realStation === true,
      isDemoFallback: normalized.isDemoFallback === true,
    });
  }

  function shouldPersistIntegrationStationHeartbeat(currentEntry, nextEntry, currentNowMs = nowMs()) {
    if (!currentEntry) return true;
    const current = sanitizeIntegrationStationStateEntry(currentEntry);
    const next = sanitizeIntegrationStationStateEntry(nextEntry);
    if (integrationStationStateStableFingerprint(current) !== integrationStationStateStableFingerprint(next)) {
      return true;
    }
    if (next.active === false) return true;
    const previousUpdatedAtMs = Number(current.updatedAtMs);
    if (!Number.isFinite(previousUpdatedAtMs) || previousUpdatedAtMs <= 0) return true;
    return currentNowMs - previousUpdatedAtMs >= heartbeatWriteMinIntervalMs;
  }

  function deactivateIntegrationStationStatesForSession(stationStates, context = {}) {
    const session = context.session && typeof context.session === "object" ? context.session : {};
    const user = context.user && typeof context.user === "object" ? context.user : {};
    const payload = context.payload && typeof context.payload === "object" ? context.payload : {};
    const clientApp = normalizeClientApp(session.clientApp ?? payload.clientApp);
    const deviceUuid = String(session.deviceUuid ?? payload.deviceUuid ?? "").trim();
    const userId = String(user.id ?? session.userId ?? payload.userId ?? "").trim();
    const sessionStation = normalizeIntegrationStationName(session.stationName ?? "");
    const requestedStation = normalizeIntegrationStationName(
      payload.stationName ?? payload.station ?? session.stationName ?? ""
    );
    const updatedAtMs = Number.isFinite(Number(context.updatedAtMs))
      ? Math.max(0, Math.trunc(Number(context.updatedAtMs)))
      : nowMs();
    const sourceStates = Array.isArray(stationStates) ? stationStates : [];

    if (clientApp !== "postazione" || !deviceUuid || !userId) {
      return { changed: false, deactivated: [], stationStates: sourceStates };
    }

    const deactivated = [];
    let matchingStateExists = false;
    const nextStates = sourceStates.map((entry) => {
      const safe = sanitizeIntegrationStationStateEntry(entry);
      if (String(safe.deviceUuid ?? "").trim() !== deviceUuid) return entry;
      if (String(safe.operatorUserId ?? "").trim() !== userId) return entry;
      if (requestedStation && safe.station !== requestedStation) return entry;
      matchingStateExists = true;
      if (safe.active === false) return entry;

      const nextEntry = sanitizeIntegrationStationStateEntry({
        ...safe,
        active: false,
        stale: false,
        updatedAtMs,
      });
      deactivated.push(nextEntry);
      return nextEntry;
    });

    if (!matchingStateExists && sessionStation) {
      const nextEntry = sanitizeIntegrationStationStateEntry({
        station: sessionStation,
        active: false,
        stale: false,
        operatorUserId: userId,
        operatorUsername: String(user.username ?? payload.username ?? "").trim(),
        operatorName:
          String(user.fullName ?? user.username ?? payload.operatorName ?? "Operatore").trim() ||
          "Operatore",
        operatorRole:
          String(user.roleLabel ?? user.role ?? payload.operatorRole ?? "Operatore").trim() ||
          "Operatore",
        clientApp: "postazione",
        deviceUuid,
        updatedAtMs,
      });
      nextStates.push(nextEntry);
      deactivated.push(nextEntry);
    }

    return {
      changed: deactivated.length > 0,
      deactivated,
      stationStates: nextStates,
    };
  }

  function buildIntegrationStationStates(integrationState, configuredStations = []) {
    const sourceList = Array.isArray(integrationState?.stationStates)
      ? integrationState.stationStates
      : [];
    const orderedConfiguredStations = dedupeConfiguredIntegrationStations(configuredStations);
    const configuredStationSet = new Set(orderedConfiguredStations);
    const map = new Map();

    sourceList
      .filter((entry) => entry && typeof entry === "object")
      .forEach((entry) => {
        const normalized = sanitizeIntegrationStationStateEntry(entry);
        if (configuredStationSet.size > 0 && !configuredStationSet.has(normalized.station)) {
          if (normalized.realStation !== true || normalized.active === false || normalized.stale === true) {
            return;
          }
        }
        map.set(integrationStationStateKey(normalized), normalized);
      });

    orderedConfiguredStations.forEach((station) => {
      if ([...map.values()].some((entry) => entry.station === station)) return;
      map.set(
        `${station}::__configured__`,
        sanitizeIntegrationStationStateEntry({
          station,
          active: false,
          autoPrintPreconto: false,
          operatorUserId: "",
          operatorUsername: "",
          operatorName: "Guest",
          operatorRole: "Non autenticato",
          isDemoFallback: false,
          configuredStation: true,
          realStation: false,
          clientApp: "postazione",
          updatedAtMs: nowMs(),
        })
      );
    });

    return [...map.values()]
      .filter(Boolean)
      .sort((left, right) => {
        const leftIndex = orderedConfiguredStations.indexOf(left.station);
        const rightIndex = orderedConfiguredStations.indexOf(right.station);
        const leftOrder = leftIndex >= 0 ? leftIndex : orderedConfiguredStations.length;
        const rightOrder = rightIndex >= 0 ? rightIndex : orderedConfiguredStations.length;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        if (left.configuredStation !== right.configuredStation) return left.configuredStation ? 1 : -1;
        if (left.isDemoFallback !== right.isDemoFallback) return left.isDemoFallback ? 1 : -1;
        if (left.updatedAtMs !== right.updatedAtMs) return right.updatedAtMs - left.updatedAtMs;
        return integrationStationStateKey(left).localeCompare(integrationStationStateKey(right), "it", {
          sensitivity: "base",
        });
      });
  }

  return {
    buildIntegrationStationStates,
    deactivateIntegrationStationStatesForSession,
    integrationStationStateKey,
    integrationStationStateStableFingerprint,
    isIntegrationDemoStationEntry,
    isIntegrationStationStale,
    sanitizeIntegrationStationStateEntry,
    shouldPersistIntegrationStationHeartbeat,
  };
}
