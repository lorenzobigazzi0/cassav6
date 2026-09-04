/**
 * Cache volatile delle sessioni auth (Redis), estratta da `createAuthHandlers`
 * per essere condivisa con i write model identity di P2b.
 *
 * `rememberVolatileSession` e `forgetVolatileSessions` sono side effect fuori
 * app-state: vanno invocate nello stesso ordine dell'implementazione legacy,
 * rispettivamente dopo la scrittura della sessione e prima di persistere una
 * revoca.
 */
export function createVolatileSessionCache({
  normalizeClientApp,
  redisVolatileStore = null,
  requireAuthSessionCacheInvalidation = () => false,
}) {
  function buildVolatileSessionPayload(user, session, clientApp) {
    return {
      ...session,
      clientApp: normalizeClientApp(clientApp || session?.clientApp),
      deviceUuid: session?.deviceUuid,
      sessionId: session?.id,
      userId: user?.id ?? session?.userId,
      username: user?.username ?? session?.username,
    };
  }

  async function rememberVolatileSession(user, session, clientApp) {
    const payload = {
      ...buildVolatileSessionPayload(user, session, clientApp),
    };
    if (requireAuthSessionCacheInvalidation() === true) {
      await redisVolatileStore?.storeAuthSession?.(payload);
    }
    void redisVolatileStore?.storeSession?.(payload);
    void redisVolatileStore?.touchPresence?.(payload);
  }

  async function forgetVolatileSessions(sessions) {
    const entries = (Array.isArray(sessions) ? sessions : [sessions]).filter(Boolean);
    if (requireAuthSessionCacheInvalidation() === true) {
      if (typeof redisVolatileStore?.deleteAuthSessions !== "function") return false;
      const invalidated = await redisVolatileStore.deleteAuthSessions(entries);
      if (!invalidated) return false;
    }
    entries.forEach((session) => {
      void redisVolatileStore?.deleteSession?.({
        deviceUuid: session?.deviceUuid,
        sessionId: session?.id,
      });
    });
    return true;
  }

  return { buildVolatileSessionPayload, forgetVolatileSessions, rememberVolatileSession };
}
