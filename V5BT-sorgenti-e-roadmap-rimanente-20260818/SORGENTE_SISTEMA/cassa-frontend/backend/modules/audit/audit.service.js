import { randomUUID } from "node:crypto";
import { sanitizeAuditEvent } from "./audit.mapper.js";

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

export function createAuditService(options = {}) {
  const maxEvents = Number.isFinite(Number(options.maxEvents)) ? Math.max(Math.trunc(Number(options.maxEvents)), 1) : 50_000;
  const nowIso = options.nowIso ?? defaultNowIso;

  function pruneAuditEvents(db) {
    if (!Array.isArray(db.auditEvents)) return;
    if (db.auditEvents.length <= maxEvents) return;
    db.auditEvents = db.auditEvents.slice(-maxEvents);
  }

  function appendAuditEvent(db, input) {
    if (!db || typeof db !== "object") return null;
    if (!Array.isArray(db.auditEvents)) db.auditEvents = [];
    const event = sanitizeAuditEvent(
      {
        id: `evt_${randomUUID().replace(/-/g, "")}`,
        occurredAt: nowIso(),
        actorUserId: String(input?.actorUserId ?? "system"),
        actorRole: String(input?.actorRole ?? "system"),
        roomId: input?.roomId ? String(input.roomId) : null,
        deviceId: input?.deviceId ? String(input.deviceId) : null,
        action: String(input?.action ?? "").trim(),
        entityType: String(input?.entityType ?? "").trim(),
        entityId: String(input?.entityId ?? "").trim(),
        correlationId: input?.correlationId ? String(input.correlationId) : null,
        payload: cloneJson(input?.payload, {}),
        before: input?.before === undefined ? null : cloneJson(input.before, null),
        after: input?.after === undefined ? null : cloneJson(input.after, null),
        deletedAt: null,
        deletedBy: null,
        deleteReason: null,
      },
      `evt_${Date.now()}`,
      { nowIso }
    );
    if (!event) return null;
    db.auditEvents.push(event);
    pruneAuditEvents(db);
    return event;
  }

  return {
    appendAuditEvent,
    pruneAuditEvents,
  };
}
