/**
 * Write model identity della route `auth.logout` (P2b).
 *
 * Possiede l'unico accesso all'app-state per questa route: legge, invalida la
 * cache volatile, rimuove la sessione, applica handoff postazione e mobile e
 * persiste. Il handler non vede piu `db`.
 *
 * Il corpo della risposta e costante, quindi fuori escono solo due esiti.
 *
 * Due asimmetrie della sequenza legacy vanno conservate:
 * - la cache Redis viene invalidata PRIMA di togliere la sessione dall'app-state,
 *   al contrario di `login-write-model.js`; se la revoca non e confermata non si
 *   scrive nulla e la sessione resta valida;
 * - la scrittura sceglie fra tre rami mutuamente esclusivi in base a `changed`,
 *   mentre la pubblicazione mobile guarda `mobileLogout`, non `changed`.
 */
export function createLogoutWriteModel({
  appendAuditEvent,
  applyMobileLogoutNotificationHandoff = null,
  applyPostazioneLogoutStationState = null,
  buildAuditActor,
  forgetVolatileSessions,
  normalizeClientApp,
  nowIso,
  publishMobileLogoutNotificationHandoff = null,
  publishPostazioneLogoutStationState = null,
  readDb,
  validateSessionContext,
  writeAuthSessionFastDb = null,
  writeMobileLogoutFastDb = null,
  writePostazioneLogoutFastDb = null,
  writeDb,
}) {
  async function persistLogout(db, {
    session,
    stationLogoutResult,
    mobileLogoutResult,
    logoutAuditEvent,
  }) {
    const auditEventIds = logoutAuditEvent?.id ? [logoutAuditEvent.id] : [];
    db.meta.lastWriteAt = nowIso();
    if (stationLogoutResult?.changed === true) {
      const wrotePostazioneLogoutFast =
        typeof writePostazioneLogoutFastDb === "function" &&
        (await writePostazioneLogoutFastDb(db, {
          stationLogoutResult,
          deletedSessionIds: [session.id],
          auditEventIds,
        }));
      if (!wrotePostazioneLogoutFast) {
        await writeDb(db, {
          metricLabel: "auth.logout.stationState.appStateWrite",
          splitDomains: ["sessions", "integration", "auditEvents"],
          sessionsSync: { deleteMissing: true },
        });
      }
      return;
    }
    if (mobileLogoutResult?.changed === true) {
      const wroteMobileLogoutFast =
        typeof writeMobileLogoutFastDb === "function" &&
        (await writeMobileLogoutFastDb(db, {
          mobileLogoutResult,
          deletedSessionIds: [session.id],
          auditEventIds,
        }));
      if (!wroteMobileLogoutFast) {
        await writeDb(db, {
          metricLabel: "auth.logout.mobileHandoff.appStateWrite",
          splitDomains: ["sessions", "integration", "auditEvents"],
          sessionsSync: { deleteMissing: true },
        });
      }
      return;
    }
    const wroteAuthSessionFast =
      typeof writeAuthSessionFastDb === "function" &&
      (await writeAuthSessionFastDb(db, {
        metricLabel: "auth.logout.sessionFastWrite",
        deletedSessionIds: [session.id],
        auditEventIds,
      }));
    if (!wroteAuthSessionFast) {
      await writeDb(db, {
        metricLabel: "auth.logout.appStateWrite",
        splitDomains: ["sessions", "auditEvents"],
        sessionsSync: { deleteMissing: true },
      });
    }
  }

  function publishLogoutSideEffects({ stationLogoutResult, mobileLogoutResult }) {
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
  }

  async function logout({ payload }) {
    const db = await readDb({
      refreshExternalizedSessions: true,
      refreshExternalizedIntegrationStationStates: true,
    });
    const { user, session } = validateSessionContext(db, payload);

    if (!(await forgetVolatileSessions([session]))) {
      return { outcome: "session_cache_unavailable" };
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
    const logoutAuditEvent = appendAuditEvent(db, {
      ...buildAuditActor(user, payload),
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

    await persistLogout(db, {
      session,
      stationLogoutResult,
      mobileLogoutResult,
      logoutAuditEvent,
    });
    publishLogoutSideEffects({ stationLogoutResult, mobileLogoutResult });
    return { outcome: "logged_out" };
  }

  return { logout };
}
