/**
 * Write model identity della route `auth.changePin` (P2b.4).
 *
 * Possiede l'unico accesso all'app-state per questa route: legge, valuta il PIN
 * attuale e applica uno dei due intenti di scrittura, restituendo solo l'esito.
 * Il handler non vede piu `db`.
 *
 * La transazione read-mutate-write legacy resta una sola perche i due intenti
 * insistono sullo stesso oggetto app-state: `validateSessionContext` non e una
 * lettura pura (su sessione scaduta rimuove la sessione, registra l'audit e
 * aggiorna `meta.lastWriteAt` in memoria, poi solleva 401), quindi una seconda
 * `readDb` perderebbe quella mutazione.
 */
export function createChangePinWriteModel({
  appendAuditEvent,
  buildAuditActor,
  hashPin,
  normalizeClientApp,
  nowIso,
  readDb,
  validateSessionContext,
  verifyPin,
  writeDb,
}) {
  /** Intento 1: PIN attuale errato, si registra solo l'audit del tentativo. */
  async function recordFailedPinChange(db, { user, session, payload }) {
    appendAuditEvent(db, {
      ...buildAuditActor(user, payload),
      action: "auth.pin_change_failed",
      entityType: "user",
      entityId: user.id,
      payload: {
        sessionId: String(session.id ?? ""),
        clientApp: normalizeClientApp(session.clientApp),
        reason: "invalid_current_pin",
      },
    });
    db.meta.lastWriteAt = nowIso();
    await writeDb(db, {
      metricLabel: "auth.pinChange.failed.appStateWrite",
      splitDomains: ["auditEvents"],
    });
    return { outcome: "invalid_current_pin" };
  }

  /** Intento 2: sostituzione dell'hash PIN e audit del cambio riuscito. */
  async function applyPinChange(db, { user, session, payload, newPin }) {
    const nextPinHash = hashPin(newPin);
    const updatedAt = nowIso();
    const userIndex = Array.isArray(db.users)
      ? db.users.findIndex(
          (entry) =>
            String(entry?.id ?? "").trim() === String(user.id ?? "").trim(),
        )
      : -1;
    if (userIndex < 0) {
      return { outcome: "user_not_found" };
    }

    db.users[userIndex] = {
      ...db.users[userIndex],
      pinHash: nextPinHash,
      updatedAt,
    };

    appendAuditEvent(db, {
      ...buildAuditActor(user, payload),
      action: "auth.pin_changed",
      entityType: "user",
      entityId: user.id,
      payload: {
        sessionId: String(session.id ?? ""),
        clientApp: normalizeClientApp(session.clientApp),
      },
    });

    db.meta.lastWriteAt = updatedAt;
    await writeDb(db, {
      metricLabel: "auth.pinChange.appStateWrite",
      splitDomains: ["users", "auditEvents"],
    });
    return { outcome: "changed" };
  }

  async function changeUserPin({ payload, currentPin, newPin }) {
    const db = await readDb({ refreshExternalizedSessions: true });
    const { user, session } = validateSessionContext(db, payload);
    if (!verifyPin(currentPin, user.pinHash)) {
      return recordFailedPinChange(db, { user, session, payload });
    }
    return applyPinChange(db, { user, session, payload, newPin });
  }

  return { changeUserPin };
}
