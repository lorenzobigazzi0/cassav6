/**
 * Write model identity della route `auth.selectWorkstation` (P2b).
 *
 * Possiede l'unico accesso all'app-state per questa route: legge, applica i
 * controlli POS/workstation e scrive la sessione, restituendo solo l'esito e la
 * postazione selezionata. Il handler non vede piu `db` ne l'oggetto sessione.
 *
 * Come per `change-pin-write-model.js`, la transazione read-mutate-write legacy
 * resta una sola: `validateSessionContext` non e una lettura pura, quindi una
 * seconda `readDb` perderebbe la mutazione di sessione scaduta.
 *
 * Il doppio percorso di scrittura e conservato: `writeAuthSessionFastDb` quando
 * disponibile, altrimenti il fallback `writeDb` con gli stessi `splitDomains`.
 * `rememberVolatileSession` resta un side effect successivo alla scrittura.
 */
export function createSelectWorkstationWriteModel({
  appendAuditEvent,
  assertUserLoginWorkstationAllowed,
  assertWorkstationLoginAvailable,
  buildAuditActor,
  normalizeClientApp,
  nowIso,
  readDb,
  rememberVolatileSession,
  resolveLoginWorkstationContext,
  validateSessionContext,
  writeAuthSessionFastDb = null,
  writeDb,
}) {
  async function persistSelection(db, { user, session, payload, workstation, clientApp }) {
    session.workstationId = workstation.workstationId;
    session.stationName = workstation.stationName;
    session.lastSeenAt = nowIso();
    const auditEvent = appendAuditEvent(db, {
      ...buildAuditActor(user, payload),
      action: "auth.workstation_selected",
      entityType: "session",
      entityId: String(session.id ?? ""),
      payload: {
        sessionId: String(session.id ?? ""),
        workstationId: workstation.workstationId,
        stationName: workstation.stationName,
        clientApp,
      },
    });
    db.meta.lastWriteAt = nowIso();
    const wroteFast =
      typeof writeAuthSessionFastDb === "function" &&
      (await writeAuthSessionFastDb(db, {
        metricLabel: "auth.workstationSelect.sessionFastWrite",
        sessionIds: [session.id],
        auditEventIds: auditEvent?.id ? [auditEvent.id] : [],
      }));
    if (!wroteFast) {
      await writeDb(db, {
        metricLabel: "auth.workstationSelect.appStateWrite",
        splitDomains: ["sessions", "auditEvents"],
        sessionsSync: { deleteMissing: false },
      });
    }
    await rememberVolatileSession(user, session, clientApp);
  }

  async function selectWorkstation({ payload, clientApp }) {
    const db = await readDb({ refreshExternalizedSessions: true });
    const { user, session } = validateSessionContext(db, payload);
    if (clientApp !== "postazione" || normalizeClientApp(session.clientApp) !== "postazione") {
      return { outcome: "client_not_postazione" };
    }

    const requestedContext = resolveLoginWorkstationContext(db, payload, clientApp);
    const workstation = assertUserLoginWorkstationAllowed(db, user, requestedContext);
    const currentWorkstationId = String(session.workstationId ?? "").trim();
    if (currentWorkstationId && currentWorkstationId !== workstation.workstationId) {
      return { outcome: "change_requires_logout" };
    }
    assertWorkstationLoginAvailable(db, user, workstation, {
      deviceUuid: String(session.deviceUuid ?? payload.deviceUuid ?? "").trim(),
      clientApp,
    });

    await persistSelection(db, { user, session, payload, workstation, clientApp });
    return {
      outcome: "selected",
      selectedWorkstation: {
        id: workstation.workstationId,
        name: workstation.name,
        stationName: workstation.stationName,
      },
    };
  }

  return { selectWorkstation };
}
