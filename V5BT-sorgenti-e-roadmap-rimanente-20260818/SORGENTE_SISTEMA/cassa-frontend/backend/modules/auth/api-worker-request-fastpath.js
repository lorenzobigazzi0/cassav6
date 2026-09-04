function asTrimmedString(value) {
  return String(value ?? "").trim();
}

export function createApiWorkerRequestFastPath(options = {}) {
  const enabled = typeof options.enabled === "function" ? options.enabled : () => options.enabled === true;
  const readDb = options.readDb;
  const sessionsRepository = options.sessionsRepository;
  const redisVolatileStore = options.redisVolatileStore;
  const redisSessionCacheEnabled = typeof options.redisSessionCacheEnabled === "function"
    ? options.redisSessionCacheEnabled
    : () => options.redisSessionCacheEnabled === true;
  const hashSessionToken = options.hashSessionToken;
  const validateResolvedSessionContext = options.validateResolvedSessionContext;
  const runtimeMetrics = options.runtimeMetrics;
  const logger = options.logger ?? console;
  let lastLookupWarningAt = 0;

  function isEnabled() {
    return enabled() === true;
  }

  function metric(name) {
    runtimeMetrics?.incrementCounter?.(name);
  }

  function operation(label, startedAt) {
    runtimeMetrics?.recordOperation?.("apiWorkerFastPath", label, Date.now() - startedAt);
  }

  function warnFallback(message, error) {
    const now = Date.now();
    if (now - lastLookupWarningAt < 30_000) return;
    lastLookupWarningAt = now;
    logger.warn?.(
      `[backend] ${message}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  async function authenticate(payload) {
    if (!isEnabled()) return null;
    const tokenHash = hashSessionToken(asTrimmedString(payload?.token));
    const deviceUuid = asTrimmedString(payload?.deviceUuid);
    if (!tokenHash || !deviceUuid) return null;

    const db = await readDb();
    const useRedis = redisSessionCacheEnabled() === true
      && redisVolatileStore?.sessionsEnabled
      && typeof redisVolatileStore.getAuthSession === "function";
    let session = null;

    if (useRedis) {
      const cacheStartedAt = Date.now();
      try {
        const cached = await redisVolatileStore.getAuthSession({ deviceUuid, tokenHash });
        operation(cached?.hit ? "authCacheHit" : "authCacheMiss", cacheStartedAt);
        metric(cached?.hit ? "apiWorkerFastAuthCacheHits" : "apiWorkerFastAuthCacheMisses");
        if (cached?.hit) session = cached.value;
      } catch (error) {
        operation("authCacheError", cacheStartedAt);
        metric("apiWorkerFastAuthCacheErrors");
        warnFallback("Cache auth Redis API worker in fallback", error);
      }
    }

    if (!session) {
      const lookupStartedAt = Date.now();
      try {
        session = await sessionsRepository.findSessionByTokenHash({ tokenHash, deviceUuid });
        operation("authLookup", lookupStartedAt);
      } catch (error) {
        operation("authLookupError", lookupStartedAt);
        metric("apiWorkerFastAuthFallbacks");
        warnFallback("Fast auth API worker in fallback", error);
        return null;
      }
      metric(session ? "apiWorkerFastAuthHits" : "apiWorkerFastAuthMisses");
      if (session && useRedis && typeof redisVolatileStore.storeAuthSession === "function") {
        const storeStartedAt = Date.now();
        try {
          const stored = await redisVolatileStore.storeAuthSession(session);
          operation(stored ? "authCacheStore" : "authCacheStoreSkipped", storeStartedAt);
          metric(stored ? "apiWorkerFastAuthCacheWrites" : "apiWorkerFastAuthCacheWriteMisses");
        } catch (error) {
          operation("authCacheStoreError", storeStartedAt);
          metric("apiWorkerFastAuthCacheErrors");
          warnFallback("Scrittura cache auth Redis API worker in fallback", error);
        }
      }
    }

    return {
      db,
      context: validateResolvedSessionContext(db, payload, session),
    };
  }

  return {
    authenticate,
    isEnabled,
  };
}
