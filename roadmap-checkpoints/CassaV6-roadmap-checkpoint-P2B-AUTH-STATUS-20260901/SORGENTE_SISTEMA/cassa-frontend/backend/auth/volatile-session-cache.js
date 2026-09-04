/**
 * Cache volatile delle sessioni auth (Redis), estratta da `createAuthHandlers`
 * per essere condivisa con i write model identity di P2b.
 *
 * `rememberVolatileSession` e un side effect fuori app-state: va invocata dopo
 * la scrittura della sessione, nello stesso ordine dell'implementazione legacy.
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

  return { buildVolatileSessionPayload, rememberVolatileSession };
}
