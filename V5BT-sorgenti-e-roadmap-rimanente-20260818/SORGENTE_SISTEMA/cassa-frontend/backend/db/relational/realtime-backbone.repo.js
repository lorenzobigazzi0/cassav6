import { createHash } from "node:crypto";
import { runRelationalTransaction } from "./connection.js";

const IDEMPOTENCY_STATUSES = new Set(["processing", "completed", "failed"]);

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function optionalText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function requiredText(value, fieldName) {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new Error(`${fieldName} richiesto.`);
  }
  return normalized;
}

function normalizeLimit(value, fallback = 100) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 1_000);
}

function stringifyJson(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function safeJsonParse(value, fallback = null) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map((entry) => stableJsonValue(entry));
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = stableJsonValue(value[key]);
      return acc;
    }, {});
}

export function stableStringify(value) {
  return JSON.stringify(stableJsonValue(value));
}

export function hashIdempotencyRequest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function ensureRelationalConnection(connection) {
  if (!connection || typeof connection.exec !== "function" || typeof connection.prepare !== "function") {
    throw new Error("Connessione SQLite relazionale non valida.");
  }
}

function isExpired(expiresAt, nowIso) {
  const expiresMs = Date.parse(String(expiresAt ?? ""));
  const nowMs = Date.parse(String(nowIso ?? ""));
  if (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) return false;
  return expiresMs <= nowMs;
}

function rowToIdempotencyRecord(row) {
  if (!row) return null;
  return {
    key: row.idempotency_key,
    scope: row.scope,
    requestHash: row.request_hash,
    response: safeJsonParse(row.response_json, null),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function rowToOutboxEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    scope: row.scope,
    scopeSequence: row.scope_sequence,
    payload: safeJsonParse(row.payload_json, {}),
    occurredAt: row.occurred_at,
    publishedAt: row.published_at,
    publishAttempts: row.publish_attempts,
    lastError: row.last_error,
  };
}

function enqueueOutboxEventInTransaction(db, nowIso, outboxEvent) {
  const safeEventType = requiredText(outboxEvent?.eventType, "event_type");
  const safeAggregateType = requiredText(outboxEvent?.aggregateType, "aggregate_type");
  const safeAggregateId = requiredText(outboxEvent?.aggregateId, "aggregate_id");
  const safeScope = optionalText(outboxEvent?.scope);
  const safeOccurredAt = normalizeText(outboxEvent?.occurredAt, nowIso());
  const payloadJson = stringifyJson(outboxEvent?.payload, {});
  const row = safeScope
    ? db
        .prepare("SELECT COALESCE(MAX(scope_sequence), 0) + 1 AS next_sequence FROM event_outbox WHERE scope = ?")
        .get(safeScope)
    : db
        .prepare("SELECT COALESCE(MAX(scope_sequence), 0) + 1 AS next_sequence FROM event_outbox WHERE scope IS NULL")
        .get();
  const scopeSequence = Math.max(1, Math.trunc(Number(row?.next_sequence) || 1));
  const result = db
    .prepare(
      `
        INSERT INTO event_outbox (
          event_type,
          aggregate_type,
          aggregate_id,
          scope,
          scope_sequence,
          payload_json,
          occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      safeEventType,
      safeAggregateType,
      safeAggregateId,
      safeScope,
      scopeSequence,
      payloadJson,
      safeOccurredAt
    );
  return rowToOutboxEvent(db.prepare("SELECT * FROM event_outbox WHERE id = ?").get(result.lastInsertRowid));
}

export function withTransactionalOutboxEvent(connection, { paymentWrite, outboxEvent, nowIso } = {}) {
  ensureRelationalConnection(connection);
  if (typeof paymentWrite !== "function") {
    throw new Error("withTransactionalOutboxEvent richiede paymentWrite come callback sincrona.");
  }
  const getNowIso = typeof nowIso === "function" ? nowIso : () => new Date().toISOString();

  return runRelationalTransaction(connection, () => {
    const domainResult = paymentWrite(connection);
    if (domainResult && typeof domainResult.then === "function") {
      throw new Error("withTransactionalOutboxEvent supporta solo callback sincrone.");
    }
    const resolvedOutboxEvent = typeof outboxEvent === "function" ? outboxEvent(domainResult) : outboxEvent;
    if (resolvedOutboxEvent && typeof resolvedOutboxEvent.then === "function") {
      throw new Error("withTransactionalOutboxEvent supporta solo eventi outbox sincroni.");
    }
    const queuedOutboxEvent = enqueueOutboxEventInTransaction(connection, getNowIso, resolvedOutboxEvent);
    return {
      domainResult,
      outboxEvent: queuedOutboxEvent,
    };
  });
}

export class IdempotencyKeysRepository {
  constructor(db, options = {}) {
    this.db = db;
    this.nowIso = typeof options.nowIso === "function" ? options.nowIso : () => new Date().toISOString();
  }

  get(key) {
    const safeKey = requiredText(key, "idempotency_key");
    return rowToIdempotencyRecord(
      this.db
        .prepare("SELECT * FROM idempotency_keys WHERE idempotency_key = ?")
        .get(safeKey)
    );
  }

  begin({ key, scope, requestHash, request, expiresAt } = {}) {
    const safeKey = requiredText(key, "idempotency_key");
    const safeScope = requiredText(scope, "scope");
    const safeHash = normalizeText(requestHash) || hashIdempotencyRequest(request ?? {});
    if (!/^[a-f0-9]{64}$/i.test(safeHash)) {
      throw new Error("request_hash deve essere uno SHA-256 esadecimale da 64 caratteri.");
    }
    const now = this.nowIso();
    const safeExpiresAt = requiredText(expiresAt, "expires_at");

    return runRelationalTransaction(this.db, () => {
      let existing = this.get(safeKey);
      if (existing && isExpired(existing.expiresAt, now)) {
        this.db
          .prepare("DELETE FROM idempotency_keys WHERE idempotency_key = ?")
          .run(safeKey);
        existing = null;
      }

      if (!existing) {
        this.db
          .prepare(
            `
              INSERT INTO idempotency_keys (
                idempotency_key,
                scope,
                request_hash,
                response_json,
                status,
                created_at,
                updated_at,
                expires_at
              ) VALUES (?, ?, ?, NULL, 'processing', ?, ?, ?)
            `
          )
          .run(safeKey, safeScope, safeHash, now, now, safeExpiresAt);
        return {
          state: "created",
          record: this.get(safeKey),
        };
      }

      if (existing.scope !== safeScope || existing.requestHash !== safeHash) {
        return {
          state: "conflict",
          record: existing,
        };
      }

      return {
        state: existing.status,
        record: existing,
        response: existing.response,
      };
    });
  }

  complete(key, response) {
    return this.setStatus(key, "completed", response);
  }

  fail(key, response = null) {
    return this.setStatus(key, "failed", response);
  }

  setStatus(key, status, response = null) {
    const safeKey = requiredText(key, "idempotency_key");
    const safeStatus = normalizeText(status).toLowerCase();
    if (!IDEMPOTENCY_STATUSES.has(safeStatus)) {
      throw new Error(`Stato idempotenza non valido: ${status}`);
    }
    const now = this.nowIso();
    const result = this.db
      .prepare(
        `
          UPDATE idempotency_keys
          SET status = ?,
              response_json = ?,
              updated_at = ?
          WHERE idempotency_key = ?
        `
      )
      .run(safeStatus, stringifyJson(response, null), now, safeKey);
    if (result.changes === 0) {
      throw new Error(`Idempotency key non trovata: ${safeKey}`);
    }
    return this.get(safeKey);
  }

  deleteExpired(nowIso = this.nowIso()) {
    return this.db
      .prepare("DELETE FROM idempotency_keys WHERE expires_at <= ?")
      .run(nowIso).changes;
  }
}

export class EventOutboxRepository {
  constructor(db, options = {}) {
    this.db = db;
    this.nowIso = typeof options.nowIso === "function" ? options.nowIso : () => new Date().toISOString();
  }

  nextScopeSequence(scope = null) {
    const safeScope = optionalText(scope);
    const row = safeScope
      ? this.db
          .prepare("SELECT COALESCE(MAX(scope_sequence), 0) + 1 AS next_sequence FROM event_outbox WHERE scope = ?")
          .get(safeScope)
      : this.db
          .prepare("SELECT COALESCE(MAX(scope_sequence), 0) + 1 AS next_sequence FROM event_outbox WHERE scope IS NULL")
          .get();
    return Math.max(1, Math.trunc(Number(row?.next_sequence) || 1));
  }

  enqueue({ eventType, aggregateType, aggregateId, scope = null, payload, occurredAt, afterEnqueue } = {}) {
    return runRelationalTransaction(this.db, () => {
      const queued = enqueueOutboxEventInTransaction(this.db, this.nowIso, {
        eventType,
        aggregateType,
        aggregateId,
        scope,
        payload,
        occurredAt,
      });
      if (typeof afterEnqueue === "function") afterEnqueue(queued, this.db);
      return queued;
    });
  }

  getById(id) {
    const safeId = Math.trunc(Number(id));
    if (!Number.isFinite(safeId) || safeId <= 0) return null;
    return rowToOutboxEvent(
      this.db
        .prepare("SELECT * FROM event_outbox WHERE id = ?")
        .get(safeId)
    );
  }

  listUnpublished({ limit = 100 } = {}) {
    return this.db
      .prepare(
        `
          SELECT *
          FROM event_outbox
          WHERE published_at IS NULL
          ORDER BY id ASC
          LIMIT ?
        `
      )
      .all(normalizeLimit(limit))
      .map(rowToOutboxEvent);
  }

  // Replay durabile per Last-Event-ID: eventi con id > afterId in ordine
  // crescente (l'id AUTOINCREMENT e' la sequenza globale monotona).
  listAfter(afterId, { limit = 200 } = {}) {
    const safeAfterId = Math.max(0, Math.trunc(Number(afterId) || 0));
    return this.db
      .prepare(
        `
          SELECT *
          FROM event_outbox
          WHERE id > ?
          ORDER BY id ASC
          LIMIT ?
        `
      )
      .all(safeAfterId, normalizeLimit(limit))
      .map(rowToOutboxEvent);
  }

  // Estremi correnti della finestra durabile: servono a rilevare i gap di
  // replay (se il client chiede eventi gia' potati dalla retention).
  getReplayBounds() {
    const row = this.db
      .prepare("SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM event_outbox")
      .get();
    const toBound = (value) => {
      if (value === null || value === undefined) return null;
      const parsed = Math.trunc(Number(value));
      return Number.isFinite(parsed) ? parsed : null;
    };
    return { minId: toBound(row?.min_id), maxId: toBound(row?.max_id) };
  }

  markPublished(id, publishedAt = this.nowIso()) {
    const safeId = Math.trunc(Number(id));
    if (!Number.isFinite(safeId) || safeId <= 0) {
      throw new Error("event_outbox.id non valido.");
    }
    const result = this.db
      .prepare(
        `
          UPDATE event_outbox
          SET published_at = ?,
              last_error = NULL
          WHERE id = ?
        `
      )
      .run(publishedAt, safeId);
    if (result.changes === 0) {
      throw new Error(`Evento outbox non trovato: ${safeId}`);
    }
    return this.getById(safeId);
  }

  markPublishFailed(id, error) {
    const safeId = Math.trunc(Number(id));
    if (!Number.isFinite(safeId) || safeId <= 0) {
      throw new Error("event_outbox.id non valido.");
    }
    const message = String(error?.message ?? error ?? "").trim().slice(0, 2_000) || "publish failed";
    const result = this.db
      .prepare(
        `
          UPDATE event_outbox
          SET publish_attempts = publish_attempts + 1,
              last_error = ?
          WHERE id = ?
        `
      )
      .run(message, safeId);
    if (result.changes === 0) {
      throw new Error(`Evento outbox non trovato: ${safeId}`);
    }
    return this.getById(safeId);
  }

  countUnpublished() {
    return this.db
      .prepare("SELECT COUNT(*) AS count FROM event_outbox WHERE published_at IS NULL")
      .get().count;
  }

  countSummary() {
    const row = this.db
      .prepare(
        `
          SELECT
            SUM(CASE WHEN published_at IS NULL THEN 1 ELSE 0 END) AS unpublished,
            SUM(CASE WHEN published_at IS NOT NULL THEN 1 ELSE 0 END) AS published,
            SUM(CASE WHEN published_at IS NULL AND publish_attempts > 0 THEN 1 ELSE 0 END) AS failed_unpublished,
            MIN(CASE WHEN published_at IS NULL THEN occurred_at ELSE NULL END) AS oldest_unpublished_at
          FROM event_outbox
        `
      )
      .get();
    return {
      unpublished: Math.max(0, Math.trunc(Number(row?.unpublished) || 0)),
      published: Math.max(0, Math.trunc(Number(row?.published) || 0)),
      failedUnpublished: Math.max(0, Math.trunc(Number(row?.failed_unpublished) || 0)),
      oldestUnpublishedAt: optionalText(row?.oldest_unpublished_at),
    };
  }

  deletePublishedBefore(publishedBeforeIso) {
    const cutoff = requiredText(publishedBeforeIso, "published_before");
    return this.db
      .prepare("DELETE FROM event_outbox WHERE published_at IS NOT NULL AND published_at < ?")
      .run(cutoff).changes;
  }
}
