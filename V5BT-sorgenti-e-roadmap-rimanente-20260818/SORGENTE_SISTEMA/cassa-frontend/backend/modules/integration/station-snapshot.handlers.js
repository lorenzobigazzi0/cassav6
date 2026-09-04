export function createIntegrationStationSnapshotHandlers(options = {}) {
  const {
    activeCacheKey = "active",
    buildIntegrationStationStates,
    buildIntegrationStationStatesWithSessionRecovery,
    createDefaultIntegrationState,
    getActiveStations,
    hotCacheMs = 0,
    integrationStationsFastResponseCache,
    logger = console,
    maybeQueueNoActiveStationsNotification,
    nowIso,
    publishIntegrationNotificationStreamRefresh,
    readDb,
    readFastJsonCache,
    resolveConfiguredIntegrationStations,
    resolveIntegrationStationStatesVersionMs,
    scopedReadsEnabled = false,
    sendJsonString,
    showDemoStations = false,
    statesCacheKey = "states",
    writeDb,
    writeFastJsonCache,
    domainsRepository = null,
  } = options;

  async function readScopedIntegrationStationSnapshot() {
    if (!scopedReadsEnabled || !domainsRepository?.enabled) return null;
    try {
      const [rawStationStates, posSettings] = await Promise.all([
        domainsRepository.readObjectArrayField("integration", "stationStates", []),
        domainsRepository.readDomainValue("posSettings", {}),
      ]);
      const configuredStations = resolveConfiguredIntegrationStations({ posSettings });
      const stationStates = buildIntegrationStationStates(
        { stationStates: rawStationStates },
        configuredStations,
      );
      return { configuredStations, stationStates };
    } catch (error) {
      logger.warn?.(
        `[scoped-reads] stationStates fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async function handleIntegrationStationsSnapshot(res, { cacheKey, activeOnly, trigger, scopedRead }) {
    const cached = readFastJsonCache(
      integrationStationsFastResponseCache,
      cacheKey,
      hotCacheMs,
    );
    if (cached) {
      sendJsonString(res, 200, cached.json);
      return;
    }

    const scopedSnapshot = scopedRead ? await readScopedIntegrationStationSnapshot() : null;
    if (scopedSnapshot) {
      const { configuredStations, stationStates } = scopedSnapshot;
      const scopedActiveStations = getActiveStations(
        { integration: { stationStates } },
        { allowDemoStations: showDemoStations },
      );
      const scopedPayload = {
        ok: true,
        version: resolveIntegrationStationStatesVersionMs(
          { integration: { stationStates } },
          stationStates,
        ),
        showDemoStations,
        configuredStations,
        stations: activeOnly ? scopedActiveStations : stationStates,
      };
      const cacheEntry = writeFastJsonCache(
        integrationStationsFastResponseCache,
        cacheKey,
        scopedPayload,
        4,
      );
      sendJsonString(res, 200, cacheEntry.json);
      return;
    }

    const db = await readDb();
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    const configuredStations = resolveConfiguredIntegrationStations(db);
    const stationStates = buildIntegrationStationStatesWithSessionRecovery(db);
    const activeStations = getActiveStations(
      { integration: { ...db.integration, stationStates } },
      { allowDemoStations: showDemoStations },
    );
    const alertChanged = maybeQueueNoActiveStationsNotification(
      db,
      activeStations,
      { trigger },
    );
    if (alertChanged) {
      db.integration.lastWriteAt = nowIso();
      db.meta.lastWriteAt = nowIso();
      await writeDb(db);
      publishIntegrationNotificationStreamRefresh("station_availability_alert", {
        activeStations: activeStations.length,
      });
    }
    const version = resolveIntegrationStationStatesVersionMs(db, stationStates);
    const responsePayload = {
      ok: true,
      version: Number.isFinite(version) ? version : Date.now(),
      showDemoStations,
      configuredStations,
      stations: activeOnly ? activeStations : stationStates,
    };
    const cacheEntry = writeFastJsonCache(
      integrationStationsFastResponseCache,
      cacheKey,
      responsePayload,
      4,
    );
    sendJsonString(res, 200, cacheEntry.json);
  }

  async function handleIntegrationStationStates(_req, res) {
    return handleIntegrationStationsSnapshot(res, {
      activeOnly: false,
      cacheKey: statesCacheKey,
      scopedRead: true,
      trigger: "stations_state",
    });
  }

  async function handleIntegrationActiveStations(_req, res) {
    return handleIntegrationStationsSnapshot(res, {
      activeOnly: true,
      cacheKey: activeCacheKey,
      scopedRead: true,
      trigger: "stations_active",
    });
  }

  return {
    handleIntegrationActiveStations,
    handleIntegrationStationStates,
  };
}
