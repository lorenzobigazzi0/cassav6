function asTrimmedString(value) {
  return String(value ?? "").trim();
}

export function createTableLockWorkerRequestFastPath(options = {}) {
  const enabled = typeof options.enabled === "function" ? options.enabled : () => options.enabled === true;
  const readDb = options.readDb;
  const sessionsRepository = options.sessionsRepository;
  const redisVolatileStore = options.redisVolatileStore;
  const redisSessionCacheEnabled = typeof options.redisSessionCacheEnabled === "function"
    ? options.redisSessionCacheEnabled
    : () => options.redisSessionCacheEnabled === true;
  const hashSessionToken = options.hashSessionToken;
  const validateResolvedSessionContext = options.validateResolvedSessionContext;
  const sanitizePosSettings = options.sanitizePosSettings;
  const buildIntegrationLayoutFromSettings = options.buildIntegrationLayoutFromSettings;
  const runtimeMetrics = options.runtimeMetrics;
  const logger = options.logger ?? console;
  let sourceSettings = null;
  let sourceVersion = "";
  let tableContextById = new Map();
  let lastLookupWarningAt = 0;

  function isEnabled() {
    return enabled() === true;
  }

  function metric(name) {
    runtimeMetrics?.incrementCounter?.(name);
  }

  function operation(label, startedAt) {
    runtimeMetrics?.recordOperation?.("tableLockWorkerFastPath", label, Date.now() - startedAt);
  }

  async function authenticate(payload) {
    if (!isEnabled()) return null;
    const tokenHash = hashSessionToken(asTrimmedString(payload?.token));
    const deviceUuid = asTrimmedString(payload?.deviceUuid);
    const db = await readDb();
    if (redisSessionCacheEnabled() === true && redisVolatileStore?.sessionsEnabled && typeof redisVolatileStore.getAuthSession === "function") {
      const cacheStartedAt = Date.now();
      try {
        const cached = await redisVolatileStore.getAuthSession({ deviceUuid, tokenHash });
        operation(cached?.hit ? "authCacheHit" : "authCacheMiss", cacheStartedAt);
        metric(cached?.hit ? "tableLockFastAuthCacheHits" : "tableLockFastAuthCacheMisses");
        if (cached?.hit) {
          return {
            db,
            context: validateResolvedSessionContext(db, payload, cached.value),
          };
        }
      } catch (error) {
        operation("authCacheError", cacheStartedAt);
        metric("tableLockFastAuthCacheErrors");
        const now = Date.now();
        if (now - lastLookupWarningAt >= 30_000) {
          lastLookupWarningAt = now;
          logger.warn?.(
            `[backend] Cache auth Redis worker lock in fallback: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    const startedAt = Date.now();
    let session;
    try {
      session = await sessionsRepository.findSessionByTokenHash({
        tokenHash,
        deviceUuid,
      });
      operation("authLookup", startedAt);
    } catch (error) {
      operation("authLookupError", startedAt);
      metric("tableLockFastAuthFallbacks");
      const now = Date.now();
      if (now - lastLookupWarningAt >= 30_000) {
        lastLookupWarningAt = now;
        logger.warn?.(
          `[backend] Fast auth worker lock in fallback: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
    metric(session ? "tableLockFastAuthHits" : "tableLockFastAuthMisses");
    return {
      db,
      context: validateResolvedSessionContext(db, payload, session),
    };
  }

  function resolveTableContext(db, tableIdRaw) {
    if (!isEnabled()) return undefined;
    const tableId = asTrimmedString(tableIdRaw);
    if (!tableId) return null;
    const settingsInput = db?.posSettings;
    const version = `${asTrimmedString(db?.meta?.settingsVersion)}:${asTrimmedString(db?.meta?.lastWriteAt)}`;
    const rebuild = settingsInput !== sourceSettings || version !== sourceVersion;
    if (rebuild) {
      const startedAt = Date.now();
      const settings = sanitizePosSettings(settingsInput, {
        menuItems: db?.menuItems,
        users: db?.users,
      });
      const layout = buildIntegrationLayoutFromSettings(settings);
      const layoutById = new Map(layout.tables.map((table) => [asTrimmedString(table?.id), table]));
      tableContextById = new Map(
        settings.tables.map((table, tableIndex) => {
          const id = asTrimmedString(table?.id);
          const layoutTable = layoutById.get(id) ?? null;
          return [
            id,
            {
              table,
              tableIndex,
              layoutTable,
              roomId: asTrimmedString(layoutTable?.roomId),
              roomName: asTrimmedString(layoutTable?.roomName),
              settings,
            },
          ];
        }),
      );
      sourceSettings = settingsInput;
      sourceVersion = version;
      metric("tableLockContextCacheMisses");
      operation("contextCacheBuild", startedAt);
    } else {
      metric("tableLockContextCacheHits");
    }
    return tableContextById.get(tableId) ?? null;
  }

  return {
    authenticate,
    isEnabled,
    resolveTableContext,
  };
}
