/**
 * Write model identity della route `auth.login` (P2b).
 *
 * Possiede l'unico accesso all'app-state per questa route: legge, applica le
 * policy di login, crea la sessione e la persiste, restituendo l'esito e il
 * corpo della risposta gia composto. Il handler non vede piu `db`, `user` ne
 * l'oggetto sessione.
 *
 * L'ordine delle operazioni e osservabile (audit, rate limit, revoche, cache
 * Redis) e resta identico all'implementazione legacy. Le sette uscite d'errore
 * condividono la stessa forma e vengono collassate nell'esito `rejected`, che
 * porta con se status, messaggio e gli opzionali `code`/`details` gia risolti.
 */
export function createLoginWriteModel({
  appendAuditEvent,
  assertLoginAttemptAllowed,
  assertUserClientAppAllowed,
  assertUserLoginWorkstationAllowed,
  assertWorkstationLoginAvailable,
  authRepository,
  buildAuditActor,
  buildMissingAdminMessage,
  buildMobileRoomSettings,
  buildPosRoomListFromSettings,
  createSession,
  disconnectMobileNotificationStreams = null,
  enforceLoginSessionPolicy,
  forgetVolatileSessions,
  hasAdministrativeUser,
  normalizeClientApp,
  normalizeUserRole,
  normalizeUsername,
  nowIso,
  readDb,
  recordLoginAttempt,
  rememberVolatileSession,
  resolveDefaultAuthorizedRoomIdsForUser,
  resolveLoginWorkstationContext,
  resolveMobileInitialRoom,
  resolveUserLoginWorkstations,
  roleLabelFromRole,
  sanitizeAuthorizedRoomIds,
  sanitizeEnabledRoomIds,
  sanitizePermissionList,
  sanitizeUser,
  verifyPin,
  writeAuthSessionFastDb = null,
  writeDb,
}) {
  function rejectFrom(error, { status, message }) {
    return {
      outcome: "rejected",
      status: Number(error?.status) || status,
      error: error?.message ?? message,
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.details ? { details: error.details } : {}),
    };
  }

  function findUser(db, normalizedUsername) {
    if (authRepository?.getUserByUsername) {
      return authRepository.getUserByUsername(db, normalizedUsername);
    }
    return db.users.find(
      (item) => normalizeUsername(item.username) === normalizedUsername,
    );
  }

  /** Intento di fallimento: audit del tentativo, nessuna mutazione di utenti o sessioni. */
  async function recordFailedLogin(db, { user, payload, username, deviceUuid, clientApp, ipAddress }) {
    if (typeof recordLoginAttempt === "function") {
      recordLoginAttempt({ username, deviceUuid, ipAddress, ok: false });
    }
    appendAuditEvent(db, {
      ...(user
        ? buildAuditActor(user, { ...payload, clientApp, deviceUuid })
        : buildAuditActor(null, { ...payload, username, deviceUuid })),
      action: "auth.login_failed",
      entityType: "session",
      entityId: "login",
      payload: {
        username: user ? user.username : username,
        deviceUuid,
        clientApp: normalizeClientApp(clientApp),
        reason: "invalid_credentials",
      },
    });
    db.meta.lastWriteAt = nowIso();
    await writeDb(db, {
      metricLabel: "auth.login.failed.appStateWrite",
      splitDomains: ["auditEvents"],
    });
    return { outcome: "rejected", status: 401, error: "Credenziali non valide." };
  }

  function normalizeUserAuthorization(db, user) {
    const snapshotBefore = JSON.stringify({
      role: user.role,
      roleLabel: user.roleLabel,
      permissions: user.permissions,
      authorizedRoomIds: user.authorizedRoomIds,
      enabledRoomIds: user.enabledRoomIds,
    });

    user.role = normalizeUserRole(user.role);
    user.roleLabel = roleLabelFromRole(user.role);
    user.permissions = sanitizePermissionList(user.permissions, {
      role: user.role,
      includeRoleDefaults: !Array.isArray(user.permissions),
    });
    user.authorizedRoomIds = Array.isArray(user.authorizedRoomIds)
      ? sanitizeAuthorizedRoomIds(user.authorizedRoomIds, db.posSettings)
      : resolveDefaultAuthorizedRoomIdsForUser(user, db.posSettings);
    user.enabledRoomIds = sanitizeEnabledRoomIds(user.enabledRoomIds, db.posSettings);
    const enabledRoomSet = new Set(user.enabledRoomIds);
    user.authorizedRoomIds = user.authorizedRoomIds.filter((roomId) =>
      enabledRoomSet.has(roomId),
    );

    const snapshotAfter = JSON.stringify({
      role: user.role,
      roleLabel: user.roleLabel,
      permissions: user.permissions,
      authorizedRoomIds: user.authorizedRoomIds,
      enabledRoomIds: user.enabledRoomIds,
    });
    const changed = snapshotAfter !== snapshotBefore;
    if (changed) {
      user.updatedAt = nowIso();
    }
    return changed;
  }

  function resolveInitialRoom(db, user, session, clientApp) {
    if (
      normalizeClientApp(clientApp) !== "mobile-frontend" ||
      typeof buildMobileRoomSettings !== "function" ||
      typeof buildPosRoomListFromSettings !== "function" ||
      typeof resolveMobileInitialRoom !== "function"
    ) {
      return null;
    }
    const roomSettings = buildMobileRoomSettings(
      user,
      buildPosRoomListFromSettings(db.posSettings),
      db.posSettings,
    );
    const initialRoom = resolveMobileInitialRoom(user, roomSettings);
    const roomId = String(initialRoom?.roomId ?? initialRoom?.id ?? "").trim();
    const roomName = String(initialRoom?.roomName ?? initialRoom?.name ?? "").trim();
    const canEnterInitialRoom =
      initialRoom?.authorized === true && initialRoom?.requiresAdminAuth !== true;
    if (roomId && canEnterInitialRoom) {
      session.roomId = roomId;
      if (roomName) {
        session.roomName = roomName;
      }
    }
    return initialRoom;
  }

  /** Intento di login riuscito: audit, scrittura sessione e side effect di cache. */
  async function persistLogin(db, {
    user,
    session,
    payload,
    clientApp,
    deviceUuid,
    revokedSessions,
    revokedSessionIds,
    revokedSessionEntries,
    userAuthorizationChanged,
    workstationContext,
  }) {
    const auditActor = buildAuditActor(user, { ...payload, clientApp, deviceUuid });
    const loginAuditEvent = appendAuditEvent(db, {
      ...auditActor,
      action: "auth.login_success",
      entityType: "session",
      entityId: session.id,
      payload: {
        sessionId: session.id,
        clientApp: normalizeClientApp(clientApp),
        deviceUuid,
        username: user.username,
        revokedSessions,
        concurrencyPolicy: "per_app_user",
        ...(workstationContext?.workstationId
          ? {
              workstationId: workstationContext.workstationId,
              stationName: workstationContext.stationName ?? "",
            }
          : {}),
      },
    });

    db.meta.lastWriteAt = nowIso();
    const wroteAuthSessionFast =
      typeof writeAuthSessionFastDb === "function" &&
      (await writeAuthSessionFastDb(db, {
        metricLabel: "auth.login.sessionFastWrite",
        sessionIds: [session.id],
        deletedSessionIds: revokedSessionIds,
        auditEventIds: loginAuditEvent?.id ? [loginAuditEvent.id] : [],
        usersChanged: userAuthorizationChanged,
      }));
    if (!wroteAuthSessionFast) {
      await writeDb(db, {
        metricLabel: "auth.login.appStateWrite",
        splitDomains: ["sessions", "users", "auditEvents"],
        sessionsSync: { deleteMissing: false, deleteSessionIds: revokedSessionIds },
      });
    }
    await rememberVolatileSession(user, session, clientApp);
    if (typeof disconnectMobileNotificationStreams === "function") {
      for (const revokedSession of revokedSessionEntries) {
        if (normalizeClientApp(revokedSession?.clientApp) !== "mobile-frontend") {
          continue;
        }
        disconnectMobileNotificationStreams({
          clientApp: "mobile-frontend",
          sessionId: String(revokedSession?.id ?? "").trim(),
          userId: String(revokedSession?.userId ?? "").trim(),
          deviceUuid: String(revokedSession?.deviceUuid ?? "").trim(),
        });
      }
    }
  }

  function buildLoginResponse(db, {
    user,
    session,
    token,
    clientApp,
    revokedSessions,
    workstationContext,
    initialRoom,
  }) {
    const availableWorkstations =
      normalizeClientApp(clientApp) === "postazione" &&
      typeof resolveUserLoginWorkstations === "function"
        ? resolveUserLoginWorkstations(user, db.posSettings)
        : [];
    return {
      ok: true,
      token,
      sessionStartedAt: new Date(session.createdAt).getTime(),
      revokedSessions,
      user: sanitizeUser(user, db.posSettings),
      ...(normalizeClientApp(clientApp) === "postazione"
        ? {
            workstationSelectionRequired: !workstationContext?.workstationId,
            availableWorkstations,
            selectedWorkstation: workstationContext
              ? {
                  id: workstationContext.workstationId,
                  name: workstationContext.name ?? workstationContext.stationName,
                  stationName: workstationContext.stationName,
                }
              : null,
          }
        : {}),
      ...(initialRoom ? { initialRoom } : {}),
    };
  }

  async function login({ payload, clientApp, ipAddress, username, pin, deviceUuid }) {
    const db = await readDb({ refreshExternalizedSessions: true });
    if (!hasAdministrativeUser(db)) {
      return { outcome: "rejected", status: 503, error: buildMissingAdminMessage() };
    }

    if (typeof assertLoginAttemptAllowed === "function") {
      try {
        assertLoginAttemptAllowed({ username, deviceUuid, ipAddress });
      } catch (error) {
        return rejectFrom(error, { status: 429, message: "Troppi tentativi di login." });
      }
    }

    const user = findUser(db, normalizeUsername(username));
    if (!user) {
      return recordFailedLogin(db, {
        user: null,
        payload,
        username,
        deviceUuid,
        clientApp,
        ipAddress,
      });
    }
    if (!verifyPin(pin, user.pinHash)) {
      return recordFailedLogin(db, {
        user,
        payload,
        username,
        deviceUuid,
        clientApp,
        ipAddress,
      });
    }

    if (typeof assertUserClientAppAllowed === "function") {
      try {
        assertUserClientAppAllowed(user, clientApp);
      } catch (error) {
        return rejectFrom(error, {
          status: 403,
          message: "Utente non abilitato per questa applicazione.",
        });
      }
    }

    if (typeof recordLoginAttempt === "function") {
      recordLoginAttempt({ username, deviceUuid, ipAddress, ok: true });
    }

    const userAuthorizationChanged = normalizeUserAuthorization(db, user);

    let workstationContext = null;
    if (typeof resolveLoginWorkstationContext === "function") {
      try {
        workstationContext = resolveLoginWorkstationContext(db, payload, clientApp);
      } catch (error) {
        return rejectFrom(error, { status: 400, message: "Postazione non valida." });
      }
    }

    if (typeof assertWorkstationLoginAvailable === "function") {
      try {
        if (workstationContext && typeof assertUserLoginWorkstationAllowed === "function") {
          workstationContext = assertUserLoginWorkstationAllowed(db, user, workstationContext);
        }
        assertWorkstationLoginAvailable(db, user, workstationContext, { deviceUuid, clientApp });
      } catch (error) {
        return rejectFrom(error, { status: 409, message: "Postazione gia occupata." });
      }
    }

    const sessionsBeforeLoginPolicy = Array.isArray(db.sessions) ? [...db.sessions] : [];
    const sessionIdsBeforeLoginPolicy = new Set(
      sessionsBeforeLoginPolicy.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean),
    );
    const revokedSessions = enforceLoginSessionPolicy(db, user, { deviceUuid, clientApp });

    const { token, session } = createSession(
      user.id,
      deviceUuid,
      clientApp,
      workstationContext ?? {},
    );
    const initialRoom = resolveInitialRoom(db, user, session, clientApp);
    db.sessions.push(session);
    if (db.sessions.length > 2000) {
      db.sessions.splice(0, db.sessions.length - 2000);
    }
    const retainedSessionIds = new Set(
      db.sessions.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean),
    );
    const revokedSessionEntries = sessionsBeforeLoginPolicy.filter(
      (entry) => !retainedSessionIds.has(String(entry?.id ?? "").trim()),
    );
    const revokedSessionIds = [...sessionIdsBeforeLoginPolicy].filter(
      (id) => !retainedSessionIds.has(id),
    );
    if (!(await forgetVolatileSessions(revokedSessionEntries))) {
      db.sessions = sessionsBeforeLoginPolicy;
      return {
        outcome: "rejected",
        status: 503,
        error: "Impossibile aggiornare in sicurezza le sessioni. Riprova tra poco.",
        code: "SESSION_CACHE_INVALIDATION_UNAVAILABLE",
      };
    }

    await persistLogin(db, {
      user,
      session,
      payload,
      clientApp,
      deviceUuid,
      revokedSessions,
      revokedSessionIds,
      revokedSessionEntries,
      userAuthorizationChanged,
      workstationContext,
    });

    return {
      outcome: "logged_in",
      body: buildLoginResponse(db, {
        user,
        session,
        token,
        clientApp,
        revokedSessions,
        workstationContext,
        initialRoom,
      }),
    };
  }

  return { login };
}
