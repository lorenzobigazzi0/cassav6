export function createAuthHandlers({
  appendAuditEvent,
  authRepository,
  assertLoginAttemptAllowed,
  assertUserClientAppAllowed,
  buildAuditActor,
  buildMissingAdminMessage,
  buildMobileRoomSettings,
  buildPosRoomListFromSettings,
  changeUserPin,
  createSession,
  enforceLoginSessionPolicy,
  hasAdministrativeUser,
  normalizeClientApp,
  normalizeUserRole,
  normalizeUsername,
  nowIso,
  getLoginRequestIp,
  readDb,
  recordLoginAttempt,
  readJsonBody,
  redisVolatileStore = null,
  rememberVolatileSession,
  requireAuthSessionCacheInvalidation = () => false,
  resolveClientAppFromRequest,
  resolveDefaultAuthorizedRoomIdsForUser,
  resolveLoginWorkstationContext,
  resolveUserLoginWorkstations,
  resolveMobileInitialRoom,
  roleLabelFromRole,
  refreshSessionStatus,
  retrySessionStatusPersistently,
  sanitizeAuthorizedRoomIds,
  sanitizeEnabledRoomIds,
  sanitizePermissionList,
  sanitizeUser,
  selectWorkstation,
  sendJson,
  assertWorkstationLoginAvailable,
  assertUserLoginWorkstationAllowed,
  applyMobileLogoutNotificationHandoff = null,
  disconnectMobileNotificationStreams = null,
  applyPostazioneLogoutStationState = null,
  publishMobileLogoutNotificationHandoff = null,
  publishPostazioneLogoutStationState = null,
  validateSessionContext,
  verifyPin,
  writeAuthSessionFastDb = null,
  writeMobileLogoutFastDb = null,
  writePostazioneLogoutFastDb = null,
  writeDb,
}) {
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

  async function handleLogin(req, res) {
    const payload = await readJsonBody(req);
    const username =
      typeof payload.username === "string" ? payload.username.trim() : "";
    const pin = typeof payload.pin === "string" ? payload.pin.trim() : "";
    const deviceUuid =
      typeof payload.deviceUuid === "string" ? payload.deviceUuid.trim() : "";
    const payloadClientApp =
      typeof payload.clientApp === "string" ? payload.clientApp.trim() : "";
    const clientApp = resolveClientAppFromRequest(req, payloadClientApp);
    const ipAddress =
      typeof getLoginRequestIp === "function" ? getLoginRequestIp(req) : "";

    if (!username) {
      sendJson(res, 400, { ok: false, error: "Inserisci il nome utente." });
      return;
    }

    if (!/^\d{4,6}$/.test(pin)) {
      sendJson(res, 400, { ok: false, error: "PIN non valido (4-6 cifre)." });
      return;
    }

    if (!deviceUuid) {
      sendJson(res, 400, { ok: false, error: "Dispositivo non riconosciuto." });
      return;
    }

    const db = await readDb({ refreshExternalizedSessions: true });
    if (!hasAdministrativeUser(db)) {
      sendJson(res, 503, { ok: false, error: buildMissingAdminMessage() });
      return;
    }

    if (typeof assertLoginAttemptAllowed === "function") {
      try {
        assertLoginAttemptAllowed({ username, deviceUuid, ipAddress });
      } catch (error) {
        const status = Number(error?.status) || 429;
        sendJson(res, status, {
          ok: false,
          error: error?.message ?? "Troppi tentativi di login.",
          ...(error?.code ? { code: error.code } : {}),
          ...(error?.details ? { details: error.details } : {}),
        });
        return;
      }
    }

    const normalizedUsername = normalizeUsername(username);
    const user = authRepository?.getUserByUsername
      ? authRepository.getUserByUsername(db, normalizedUsername)
      : db.users.find(
          (item) => normalizeUsername(item.username) === normalizedUsername,
        );

    if (!user) {
      if (typeof recordLoginAttempt === "function") {
        recordLoginAttempt({ username, deviceUuid, ipAddress, ok: false });
      }
      appendAuditEvent(db, {
        ...buildAuditActor(null, { ...payload, username, deviceUuid }),
        action: "auth.login_failed",
        entityType: "session",
        entityId: "login",
        payload: {
          username,
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
      sendJson(res, 401, { ok: false, error: "Credenziali non valide." });
      return;
    }

    if (!verifyPin(pin, user.pinHash)) {
      if (typeof recordLoginAttempt === "function") {
        recordLoginAttempt({ username, deviceUuid, ipAddress, ok: false });
      }
      appendAuditEvent(db, {
        ...buildAuditActor(user, { ...payload, clientApp, deviceUuid }),
        action: "auth.login_failed",
        entityType: "session",
        entityId: "login",
        payload: {
          username: user.username,
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
      sendJson(res, 401, { ok: false, error: "Credenziali non valide." });
      return;
    }

    if (typeof assertUserClientAppAllowed === "function") {
      try {
        assertUserClientAppAllowed(user, clientApp);
      } catch (error) {
        const status = Number(error?.status) || 403;
        sendJson(res, status, {
          ok: false,
          error:
            error?.message ??
            "Utente non abilitato per questa applicazione.",
          ...(error?.code ? { code: error.code } : {}),
          ...(error?.details ? { details: error.details } : {}),
        });
        return;
      }
    }

    if (typeof recordLoginAttempt === "function") {
      recordLoginAttempt({ username, deviceUuid, ipAddress, ok: true });
    }

    const userAuthorizationSnapshotBefore = JSON.stringify({
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
    user.enabledRoomIds = sanitizeEnabledRoomIds(
      user.enabledRoomIds,
      db.posSettings,
    );
    const enabledRoomSet = new Set(user.enabledRoomIds);
    user.authorizedRoomIds = user.authorizedRoomIds.filter((roomId) =>
      enabledRoomSet.has(roomId),
    );
    const userAuthorizationSnapshotAfter = JSON.stringify({
      role: user.role,
      roleLabel: user.roleLabel,
      permissions: user.permissions,
      authorizedRoomIds: user.authorizedRoomIds,
      enabledRoomIds: user.enabledRoomIds,
    });
    const userAuthorizationChanged =
      userAuthorizationSnapshotAfter !== userAuthorizationSnapshotBefore;
    if (userAuthorizationChanged) {
      user.updatedAt = nowIso();
    }

    let workstationContext = null;
    if (typeof resolveLoginWorkstationContext === "function") {
      try {
        workstationContext = resolveLoginWorkstationContext(
          db,
          payload,
          clientApp,
        );
      } catch (error) {
        const status = Number(error?.status) || 400;
        sendJson(res, status, {
          ok: false,
          error: error?.message ?? "Postazione non valida.",
          ...(error?.code ? { code: error.code } : {}),
          ...(error?.details ? { details: error.details } : {}),
        });
        return;
      }
    }

    if (typeof assertWorkstationLoginAvailable === "function") {
      try {
        if (workstationContext && typeof assertUserLoginWorkstationAllowed === "function") {
          workstationContext = assertUserLoginWorkstationAllowed(
            db,
            user,
            workstationContext,
          );
        }
        assertWorkstationLoginAvailable(db, user, workstationContext, {
          deviceUuid,
          clientApp,
        });
      } catch (error) {
        const status = Number(error?.status) || 409;
        sendJson(res, status, {
          ok: false,
          error: error?.message ?? "Postazione gia occupata.",
          ...(error?.code ? { code: error.code } : {}),
          ...(error?.details ? { details: error.details } : {}),
        });
        return;
      }
    }

    const sessionsBeforeLoginPolicy = Array.isArray(db.sessions) ? [...db.sessions] : [];
    const sessionIdsBeforeLoginPolicy = new Set(sessionsBeforeLoginPolicy.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean));
    const revokedSessions = enforceLoginSessionPolicy(db, user, {
      deviceUuid,
      clientApp,
    });

    const { token, session } = createSession(
      user.id,
      deviceUuid,
      clientApp,
      workstationContext ?? {},
    );
    let initialRoom = null;
    if (
      normalizeClientApp(clientApp) === "mobile-frontend" &&
      typeof buildMobileRoomSettings === "function" &&
      typeof buildPosRoomListFromSettings === "function" &&
      typeof resolveMobileInitialRoom === "function"
    ) {
      const roomSettings = buildMobileRoomSettings(
        user,
        buildPosRoomListFromSettings(db.posSettings),
        db.posSettings,
      );
      initialRoom = resolveMobileInitialRoom(user, roomSettings);
      const roomId = String(
        initialRoom?.roomId ?? initialRoom?.id ?? "",
      ).trim();
      const roomName = String(
        initialRoom?.roomName ?? initialRoom?.name ?? "",
      ).trim();
      const canEnterInitialRoom =
        initialRoom?.authorized === true &&
        initialRoom?.requiresAdminAuth !== true;
      if (roomId && canEnterInitialRoom) {
        session.roomId = roomId;
        if (roomName) {
          session.roomName = roomName;
        }
      }
    }
    db.sessions.push(session);
    if (db.sessions.length > 2000) {
      db.sessions.splice(0, db.sessions.length - 2000);
    }
    const retainedSessionIds = new Set(db.sessions.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean));
    const revokedSessionEntries = sessionsBeforeLoginPolicy.filter((entry) => !retainedSessionIds.has(String(entry?.id ?? "").trim()));
    const revokedSessionIds = [...sessionIdsBeforeLoginPolicy].filter((id) => !retainedSessionIds.has(id));
    if (!(await forgetVolatileSessions(revokedSessionEntries))) {
      db.sessions = sessionsBeforeLoginPolicy;
      sendJson(res, 503, {
        ok: false,
        error: "Impossibile aggiornare in sicurezza le sessioni. Riprova tra poco.",
        code: "SESSION_CACHE_INVALIDATION_UNAVAILABLE",
      });
      return;
    }

    const auditActor = buildAuditActor(user, {
      ...payload,
      clientApp,
      deviceUuid,
    });
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
    const wroteAuthSessionFast = typeof writeAuthSessionFastDb === "function" && await writeAuthSessionFastDb(db, { metricLabel: "auth.login.sessionFastWrite", sessionIds: [session.id], deletedSessionIds: revokedSessionIds, auditEventIds: loginAuditEvent?.id ? [loginAuditEvent.id] : [], usersChanged: userAuthorizationChanged });
    if (!wroteAuthSessionFast) await writeDb(db, {
      metricLabel: "auth.login.appStateWrite",
      splitDomains: ["sessions", "users", "auditEvents"],
      sessionsSync: { deleteMissing: false, deleteSessionIds: revokedSessionIds },
    });
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

    const availableWorkstations =
      normalizeClientApp(clientApp) === "postazione" &&
      typeof resolveUserLoginWorkstations === "function"
        ? resolveUserLoginWorkstations(user, db.posSettings)
        : [];
    sendJson(res, 200, {
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
    });
  }

  async function handleSelectWorkstation(req, res) {
    const payload = await readJsonBody(req);
    const clientApp = normalizeClientApp(
      resolveClientAppFromRequest(req, payload.clientApp),
    );

    const { outcome, selectedWorkstation } = await selectWorkstation({
      payload,
      clientApp,
    });
    if (outcome === "client_not_postazione") {
      sendJson(res, 403, {
        ok: false,
        error: "Selezione disponibile solo per Postazione Advanced.",
        code: "WORKSTATION_CLIENT_REQUIRED",
      });
      return;
    }
    if (outcome === "change_requires_logout") {
      sendJson(res, 409, {
        ok: false,
        error: "Per cambiare postazione esegui prima il logout.",
        code: "WORKSTATION_CHANGE_REQUIRES_LOGOUT",
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      workstationSelectionRequired: false,
      selectedWorkstation,
    });
  }

  async function handleAuthSessionStatus(req, res) {
    const payload = await readJsonBody(req);
    const payloadClientApp =
      typeof payload.clientApp === "string" ? payload.clientApp.trim() : "";
    const clientApp = resolveClientAppFromRequest(req, payloadClientApp);

    const result = await refreshSessionStatus({
      authenticatedDb: req.__authDb,
      clientApp,
      fastPath: req.__authSessionStatusFastPath === true,
      payload,
    });
    if (result.outcome === "retry_persistently") {
      await retrySessionStatusPersistently(req, res);
      return;
    }
    if (result.preserveIntegrationHotCaches) {
      req.__preserveIntegrationHotCaches = true;
    }
    sendJson(res, 200, result.response);
  }

  async function handleChangePin(req, res) {
    const payload = await readJsonBody(req);
    const currentPin =
      typeof payload.currentPin === "string" ? payload.currentPin.trim() : "";
    const newPin =
      typeof payload.newPin === "string" ? payload.newPin.trim() : "";
    const confirmPin =
      typeof payload.confirmPin === "string" ? payload.confirmPin.trim() : "";

    if (!/^\d{4}$/.test(currentPin)) {
      sendJson(res, 400, { ok: false, error: "PIN attuale non valido." });
      return;
    }
    if (!/^\d{4}$/.test(newPin)) {
      sendJson(res, 400, {
        ok: false,
        error: "Il nuovo PIN deve essere di 4 cifre.",
      });
      return;
    }
    if (newPin !== confirmPin) {
      sendJson(res, 400, {
        ok: false,
        error: "Il nuovo PIN e la conferma non coincidono.",
      });
      return;
    }

    const { outcome } = await changeUserPin({ payload, currentPin, newPin });
    if (outcome === "invalid_current_pin") {
      sendJson(res, 401, { ok: false, error: "PIN attuale non corretto." });
      return;
    }
    if (outcome === "user_not_found") {
      sendJson(res, 404, { ok: false, error: "Utente non trovato." });
      return;
    }

    sendJson(res, 200, { ok: true, changed: true });
  }

  async function handleLogout(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb({
      refreshExternalizedSessions: true,
      refreshExternalizedIntegrationStationStates: true,
    });
    const { user, session } = validateSessionContext(db, payload);

    if (!(await forgetVolatileSessions([session]))) {
      sendJson(res, 503, {
        ok: false,
        error: "Impossibile invalidare la sessione. Riprova tra poco.",
        code: "SESSION_CACHE_INVALIDATION_UNAVAILABLE",
      });
      return;
    }

    db.sessions = db.sessions.filter(
      (entry) => String(entry.id ?? "") !== String(session.id ?? ""),
    );
    const stationLogoutResult =
      typeof applyPostazioneLogoutStationState === "function"
        ? applyPostazioneLogoutStationState(db, { payload, session, user })
        : null;
    const mobileLogoutResult =
      typeof applyMobileLogoutNotificationHandoff === "function"
        ? applyMobileLogoutNotificationHandoff(db, { payload, session, user })
        : null;
    const auditActor = buildAuditActor(user, payload);
    const logoutAuditEvent = appendAuditEvent(db, {
      ...auditActor,
      action: "auth.logout",
      entityType: "session",
      entityId: String(session.id ?? ""),
      payload: {
        sessionId: String(session.id ?? ""),
        userId: user.id,
        username: user.username,
        clientApp: normalizeClientApp(session.clientApp),
        deactivatedStations: Array.isArray(stationLogoutResult?.deactivatedStations)
          ? stationLogoutResult.deactivatedStations
          : [],
        handedOffNotificationIds: Array.isArray(mobileLogoutResult?.notificationIds)
          ? mobileLogoutResult.notificationIds
          : [],
      },
    });

    db.meta.lastWriteAt = nowIso();
    if (stationLogoutResult?.changed === true) {
      const wrotePostazioneLogoutFast =
        typeof writePostazioneLogoutFastDb === "function" &&
        await writePostazioneLogoutFastDb(db, {
          stationLogoutResult,
          deletedSessionIds: [session.id],
          auditEventIds: logoutAuditEvent?.id ? [logoutAuditEvent.id] : [],
        });
      if (!wrotePostazioneLogoutFast) {
        await writeDb(db, {
          metricLabel: "auth.logout.stationState.appStateWrite",
          splitDomains: ["sessions", "integration", "auditEvents"],
          sessionsSync: { deleteMissing: true },
        });
      }
    } else if (mobileLogoutResult?.changed === true) {
      const wroteMobileLogoutFast =
        typeof writeMobileLogoutFastDb === "function" &&
        await writeMobileLogoutFastDb(db, {
          mobileLogoutResult,
          deletedSessionIds: [session.id],
          auditEventIds: logoutAuditEvent?.id ? [logoutAuditEvent.id] : [],
        });
      if (!wroteMobileLogoutFast) {
        await writeDb(db, {
          metricLabel: "auth.logout.mobileHandoff.appStateWrite",
          splitDomains: ["sessions", "integration", "auditEvents"],
          sessionsSync: { deleteMissing: true },
        });
      }
    } else {
      const wroteAuthSessionFast = typeof writeAuthSessionFastDb === "function" && await writeAuthSessionFastDb(db, { metricLabel: "auth.logout.sessionFastWrite", deletedSessionIds: [session.id], auditEventIds: logoutAuditEvent?.id ? [logoutAuditEvent.id] : [] });
      if (!wroteAuthSessionFast) await writeDb(db, {
        metricLabel: "auth.logout.appStateWrite",
        splitDomains: ["sessions", "auditEvents"],
        sessionsSync: { deleteMissing: true },
      });
    }
    if (
      stationLogoutResult?.changed === true &&
      typeof publishPostazioneLogoutStationState === "function"
    ) {
      publishPostazioneLogoutStationState(stationLogoutResult);
    }
    if (
      mobileLogoutResult?.mobileLogout === true &&
      typeof publishMobileLogoutNotificationHandoff === "function"
    ) {
      publishMobileLogoutNotificationHandoff(mobileLogoutResult);
    }
    sendJson(res, 200, { ok: true, loggedOut: true });
  }

  return {
    handleAuthSessionStatus,
    handleChangePin,
    handleLogin,
    handleLogout,
    handleSelectWorkstation,
  };
}
