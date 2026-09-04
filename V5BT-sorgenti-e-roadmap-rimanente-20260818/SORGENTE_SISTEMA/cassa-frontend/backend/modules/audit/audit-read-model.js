/**
 * Reader della sola route di lettura del dominio `audit` (P2b, MIG-033).
 *
 * `validateSessionContext` resta qui dentro: su sessione scaduta rimuove la
 * sessione, registra l'audit e aggiorna `meta.lastWriteAt` in memoria prima di
 * sollevare 401, quindi non e una lettura pura e non puo tornare nel handler.
 *
 * Il contesto gia risolto dal middleware arriva come secondo argomento, con lo
 * stesso fallback di `resolveReportsAuthContext`.
 */
export function createAuditReadModel({
  HttpError,
  clampInt,
  hasPermission,
  isAdminUser,
  parseTimestampMs,
  readDb,
  sanitizeAuditEvents,
  validateSessionContext,
}) {
  async function readAuditEventsView(payload, authContext) {
    const db = await readDb();
    const { user } =
      authContext?.user && authContext?.session
        ? authContext
        : validateSessionContext(db, payload);
    if (!hasPermission(user, "view_analytics") && !hasPermission(user, "manage_users") && !isAdminUser(user)) {
      throw new HttpError(403, "Utente non autorizzato alla consultazione audit.");
    }

    const actionFilter = typeof payload.action === "string" ? payload.action.trim() : "";
    const entityTypeFilter = typeof payload.entityType === "string" ? payload.entityType.trim() : "";
    const entityIdFilter = typeof payload.entityId === "string" ? payload.entityId.trim() : "";
    const actorUserIdFilter = typeof payload.actorUserId === "string" ? payload.actorUserId.trim() : "";
    const includeDeleted = payload.includeDeleted === true;
    const fromTs = parseTimestampMs(payload.from, null);
    const toTs = parseTimestampMs(payload.to, null);
    const limit = clampInt(payload.limit, 1, 5_000, 500);

    const events = sanitizeAuditEvents(db.auditEvents)
      .filter((event) => (includeDeleted ? true : !event.deletedAt))
      .filter((event) => (actionFilter ? event.action === actionFilter : true))
      .filter((event) => (entityTypeFilter ? event.entityType === entityTypeFilter : true))
      .filter((event) => (entityIdFilter ? event.entityId === entityIdFilter : true))
      .filter((event) => (actorUserIdFilter ? event.actorUserId === actorUserIdFilter : true))
      .filter((event) => {
        const ts = new Date(event.occurredAt).getTime();
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs !== null && ts > toTs) return false;
        return true;
      })
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
      .slice(0, limit);

    return {
      ok: true,
      events,
      count: events.length,
    };
  }

  return {
    readAuditEventsView,
  };
}
