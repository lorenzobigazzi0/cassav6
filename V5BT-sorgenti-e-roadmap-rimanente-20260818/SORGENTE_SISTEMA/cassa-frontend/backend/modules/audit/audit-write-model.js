/**
 * Write model della sola route mutativa del dominio `audit` (P2b, MIG-033).
 *
 * La cancellazione di un evento di audit e una cancellazione logica: l'evento
 * resta, si marcano `deletedAt`, `deletedBy` e `deleteReason`, e la
 * cancellazione stessa produce un nuovo evento `security.admin_delete` con il
 * prima e il dopo. Il ramo `if (!currentEvent.deletedAt)` rende l'operazione
 * idempotente e va conservato: una seconda cancellazione non deve riscrivere
 * l'autore ne la data della prima.
 */
export function createAuditWriteModel({
  HttpError,
  appendAuditEvent,
  buildAuditActor,
  isAdminUser,
  nowIso,
  readDb,
  sanitizeAuditEvent,
  validateSessionContext,
  writeDb,
}) {
  async function deleteAuditEvent(payload, authContext) {
    const eventId = String(payload.eventId ?? "").trim();
    const reason = String(payload.reason ?? "").trim().slice(0, 240);
    if (!eventId) {
      throw new HttpError(400, "eventId obbligatorio.");
    }
    if (!reason) {
      throw new HttpError(400, "Motivo cancellazione obbligatorio.");
    }

    const db = await readDb();
    const { user } =
      authContext?.user && authContext?.session
        ? authContext
        : validateSessionContext(db, payload);
    if (!isAdminUser(user)) {
      throw new HttpError(403, "Solo admin puo cancellare eventi audit.");
    }

    const eventIndex = db.auditEvents.findIndex((event) => String(event?.id ?? "") === eventId);
    if (eventIndex < 0) {
      throw new HttpError(404, "Evento audit non trovato.");
    }
    const currentEvent = sanitizeAuditEvent(db.auditEvents[eventIndex], eventId);
    if (!currentEvent) {
      throw new HttpError(404, "Evento audit non valido.");
    }
    if (!currentEvent.deletedAt) {
      currentEvent.deletedAt = nowIso();
      currentEvent.deletedBy = user.id;
      currentEvent.deleteReason = reason;
      db.auditEvents[eventIndex] = currentEvent;
    }

    const actor = buildAuditActor(user, payload);
    appendAuditEvent(db, {
      ...actor,
      action: "security.admin_delete",
      entityType: "audit_event",
      entityId: eventId,
      payload: {
        eventId,
        reason,
        deletedAt: currentEvent.deletedAt,
      },
      before: {
        action: currentEvent.action,
        entityType: currentEvent.entityType,
        entityId: currentEvent.entityId,
      },
      after: {
        deletedAt: currentEvent.deletedAt,
        deletedBy: currentEvent.deletedBy,
        deleteReason: currentEvent.deleteReason,
      },
    });

    db.meta.lastWriteAt = nowIso();
    await writeDb(db);

    return {
      ok: true,
      event: currentEvent,
    };
  }

  return {
    deleteAuditEvent,
  };
}
