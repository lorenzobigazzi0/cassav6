function stringifyJson(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

export function mapAuditEventToRow(event, position) {
  if (!event || typeof event !== "object") return null;
  const action = String(event.action ?? "").trim();
  const entityType = String(event.entityType ?? "").trim();
  const entityId = String(event.entityId ?? "").trim();
  const id = String(event.id ?? "").trim();
  if (!id || !action || !entityType || !entityId) return null;

  return {
    id,
    occurredAt: String(event.occurredAt ?? new Date().toISOString()),
    actorUserId: String(event.actorUserId ?? "system"),
    actorRole: String(event.actorRole ?? "system"),
    roomId: event.roomId ? String(event.roomId) : null,
    deviceId: event.deviceId ? String(event.deviceId) : null,
    action,
    entityType,
    entityId,
    correlationId: event.correlationId ? String(event.correlationId) : null,
    payloadJson: stringifyJson(event.payload, {}),
    beforeJson: event.before === undefined ? null : stringifyJson(event.before, null),
    afterJson: event.after === undefined ? null : stringifyJson(event.after, null),
    deletedAt: event.deletedAt ? String(event.deletedAt) : null,
    deletedBy: event.deletedBy ? String(event.deletedBy) : null,
    deleteReason: event.deleteReason ? String(event.deleteReason).slice(0, 240) : null,
    appStatePosition: position,
  };
}

export class AuditEventsRelationalRepository {
  constructor(db) {
    this.db = db;
  }

  deleteAll() {
    this.db.prepare("DELETE FROM audit_events").run();
  }

  insert(row) {
    this.db
      .prepare(
        `
          INSERT INTO audit_events (
            id,
            occurred_at,
            actor_user_id,
            actor_role,
            room_id,
            device_id,
            action,
            entity_type,
            entity_id,
            correlation_id,
            payload_json,
            before_json,
            after_json,
            deleted_at,
            deleted_by,
            delete_reason,
            app_state_position,
            updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
          )
        `
      )
      .run(
        row.id,
        row.occurredAt,
        row.actorUserId,
        row.actorRole,
        row.roomId,
        row.deviceId,
        row.action,
        row.entityType,
        row.entityId,
        row.correlationId,
        row.payloadJson,
        row.beforeJson,
        row.afterJson,
        row.deletedAt,
        row.deletedBy,
        row.deleteReason,
        row.appStatePosition
      );
  }

  listAll() {
    return this.db
      .prepare("SELECT * FROM audit_events ORDER BY app_state_position ASC, occurred_at ASC")
      .all();
  }
}
