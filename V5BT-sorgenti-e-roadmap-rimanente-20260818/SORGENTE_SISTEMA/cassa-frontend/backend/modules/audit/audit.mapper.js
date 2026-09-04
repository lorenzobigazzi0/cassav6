function defaultNowIso() {
  return new Date().toISOString();
}

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

export function sanitizeAuditEvent(event, fallbackId = `evt_${Date.now()}`, options = {}) {
  if (!event || typeof event !== "object") return null;
  const action = String(event.action ?? "").trim();
  const entityType = String(event.entityType ?? "").trim();
  const entityId = String(event.entityId ?? "").trim();
  if (!action || !entityType || !entityId) return null;

  const nowIso = options.nowIso ?? defaultNowIso;
  return {
    id: String(event.id ?? fallbackId),
    occurredAt: String(event.occurredAt ?? nowIso()),
    actorUserId: String(event.actorUserId ?? "system"),
    actorRole: String(event.actorRole ?? "system"),
    roomId: event.roomId ? String(event.roomId) : null,
    deviceId: event.deviceId ? String(event.deviceId) : null,
    action,
    entityType,
    entityId,
    correlationId: event.correlationId ? String(event.correlationId) : null,
    payload: cloneJson(event.payload, {}),
    before: event.before === undefined ? null : cloneJson(event.before, null),
    after: event.after === undefined ? null : cloneJson(event.after, null),
    deletedAt:
      typeof event.deletedAt === "string" && event.deletedAt.trim().length > 0
        ? String(event.deletedAt)
        : null,
    deletedBy:
      typeof event.deletedBy === "string" && event.deletedBy.trim().length > 0
        ? String(event.deletedBy)
        : null,
    deleteReason:
      typeof event.deleteReason === "string" && event.deleteReason.trim().length > 0
        ? String(event.deleteReason).trim().slice(0, 240)
        : null,
  };
}

export function sanitizeAuditEvents(records, options = {}) {
  if (!Array.isArray(records)) return [];
  return records
    .map((event, index) => sanitizeAuditEvent(event, `evt_${String(index + 1).padStart(8, "0")}`, options))
    .filter((event) => event !== null)
    .sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
}
