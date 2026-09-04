/**
 * Write model identity della route `auth.sessionStatus` (P2b).
 *
 * Possiede l'unico accesso all'app-state della route e conserva il percorso
 * heartbeat esistente: copia isolata nel primo passaggio veloce, retry nella
 * lane serializzata quando serve persistere, fast writer puntuali e fallback
 * al writer app-state. La cache Redis viene aggiornata soltanto dopo la
 * persistenza, prima dell'ACK HTTP composto dal handler.
 */
export function createSessionStatusWriteModel({
  normalizeClientApp,
  nowIso,
  readDb,
  refreshPostazioneStationStateFromSessionHeartbeat,
  rememberVolatileSession,
  touchSessionHeartbeat,
  validateSessionContext,
  writeAuthSessionFastDb = null,
  writeIntegrationStationPresenceDb = null,
  writeDb,
}) {
  function createWorkingDb(db, useIsolatedHeartbeatState) {
    if (!useIsolatedHeartbeatState || !db || typeof db !== "object") return db;
    return {
      ...db,
      sessions: Array.isArray(db.sessions)
        ? db.sessions.map((entry) => ({ ...entry }))
        : db.sessions,
      integration:
        db.integration && typeof db.integration === "object"
          ? {
              ...db.integration,
              stationStates: Array.isArray(db.integration.stationStates)
                ? db.integration.stationStates.map((entry) => ({ ...entry }))
                : db.integration.stationStates,
            }
          : db.integration,
    };
  }

  function buildValidResponse(user, session) {
    const sessionClientApp = normalizeClientApp(session.clientApp);
    return {
      ok: true,
      valid: true,
      userId: user.id,
      sessionId: String(session.id ?? ""),
      clientApp: sessionClientApp,
      workstationSelectionRequired:
        sessionClientApp === "postazione" &&
        !String(session.workstationId ?? "").trim(),
      workstationId: String(session.workstationId ?? "").trim() || null,
      stationName: String(session.stationName ?? "").trim() || null,
    };
  }

  async function refreshSessionStatus({
    authenticatedDb = null,
    clientApp,
    fastPath = false,
    payload,
  }) {
    const sourceDb =
      authenticatedDb && typeof authenticatedDb === "object"
        ? authenticatedDb
        : await readDb({ refreshExternalizedSessions: true });
    const db = createWorkingDb(sourceDb, fastPath);
    const { user, session } = validateSessionContext(db, payload);
    const effectiveClientApp = clientApp || normalizeClientApp(session.clientApp);

    const touched = touchSessionHeartbeat(db, {
      userId: user.id,
      deviceUuid: String(payload.deviceUuid ?? "").trim(),
      clientApp: effectiveClientApp,
      username: user.username,
      sessionId: String(session.id ?? "").trim(),
      strictIdentity: true,
    });
    const touchedStationStateIds = [];
    const stationHeartbeatTouched =
      typeof refreshPostazioneStationStateFromSessionHeartbeat === "function"
        ? refreshPostazioneStationStateFromSessionHeartbeat(db, {
            user,
            session,
            payload,
            clientApp: effectiveClientApp,
            touchedStationStateIds,
          })
        : false;
    const shouldPersist = touched || stationHeartbeatTouched;

    if (shouldPersist && fastPath) {
      return { outcome: "retry_persistently" };
    }

    if (shouldPersist) {
      db.meta.lastWriteAt = nowIso();
      const wroteAuthSessionFast =
        typeof writeAuthSessionFastDb === "function" &&
        (await writeAuthSessionFastDb(db, {
          metricLabel: "auth.sessionStatus.sessionFastWrite",
          sessionIds: [session.id],
        }));
      const wroteStationPresenceFast =
        !stationHeartbeatTouched ||
        (wroteAuthSessionFast &&
          touchedStationStateIds.length > 0 &&
          typeof writeIntegrationStationPresenceDb === "function" &&
          (await writeIntegrationStationPresenceDb(db, {
            stationStateIds: touchedStationStateIds,
          })));
      if (!(wroteAuthSessionFast && wroteStationPresenceFast)) {
        await writeDb(db, {
          metricLabel: "auth.sessionStatus.appStateWrite",
          splitDomains: stationHeartbeatTouched
            ? ["sessions", "integration", "auditEvents"]
            : ["sessions"],
          sessionsSync: { deleteMissing: false },
        });
      }
    }

    await rememberVolatileSession(user, session, effectiveClientApp);
    return {
      outcome: "valid",
      preserveIntegrationHotCaches: !shouldPersist,
      response: buildValidResponse(user, session),
    };
  }

  return { refreshSessionStatus };
}
