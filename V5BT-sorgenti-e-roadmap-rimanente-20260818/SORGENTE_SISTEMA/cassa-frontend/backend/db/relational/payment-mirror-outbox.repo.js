import { runRelationalTransaction } from "./connection.js";

export const PAYMENT_MIRROR_OUTBOX_STATUSES = Object.freeze([
  "pending",
  "processing",
  "retrying",
  "completed",
  "failed",
]);

const VALID_STATUSES = new Set(PAYMENT_MIRROR_OUTBOX_STATUSES);

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function required(value, fieldName) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${fieldName} richiesto.`);
  return normalized;
}

function optional(value) {
  return text(value) || null;
}

function nonNegativeInt(value, fallback = 0) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInt(value, fallback = 1) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedBatchSize(value, fallback = 250) {
  return Math.min(500, positiveInt(value, fallback));
}

function addMsIso(baseIso, delayMs) {
  const baseMs = Date.parse(String(baseIso ?? ""));
  const safeBase = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(safeBase + Math.max(0, nonNegativeInt(delayMs))).toISOString();
}

function stringifyJson(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isConstraintError(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  return code.includes("SQLITE_CONSTRAINT") || message.includes("UNIQUE constraint failed");
}

function rowToEntry(row) {
  if (!row) return null;
  return {
    mirrorId: row.mirror_id,
    mirrorKind: row.mirror_kind,
    aggregateId: row.aggregate_id,
    idempotencyKey: row.idempotency_key,
    payloadVersion: positiveInt(row.payload_version, 1),
    payload: parseJson(row.payload_json),
    status: row.status,
    attemptCount: nonNegativeInt(row.attempt_count),
    nextAttemptAt: row.next_attempt_at,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    lockExpiresAt: row.lock_expires_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export class PaymentMirrorOutboxRepository {
  constructor(db, options = {}) {
    this.db = db;
    this.nowIso = typeof options.nowIso === "function" ? options.nowIso : () => new Date().toISOString();
  }

  getById(mirrorId) {
    const id = required(mirrorId, "mirror_id");
    return rowToEntry(this.db.prepare("SELECT * FROM payment_mirror_outbox WHERE mirror_id = ?").get(id));
  }

  getByAggregate(mirrorKind, aggregateId) {
    return rowToEntry(
      this.db
        .prepare("SELECT * FROM payment_mirror_outbox WHERE mirror_kind = ? AND aggregate_id = ?")
        .get(required(mirrorKind, "mirror_kind"), required(aggregateId, "aggregate_id")),
    );
  }

  getByIdempotencyKey(mirrorKind, idempotencyKey) {
    const key = optional(idempotencyKey);
    if (!key) return null;
    return rowToEntry(
      this.db
        .prepare("SELECT * FROM payment_mirror_outbox WHERE mirror_kind = ? AND idempotency_key = ?")
        .get(required(mirrorKind, "mirror_kind"), key),
    );
  }

  enqueue(row = {}) {
    const now = this.nowIso();
    const safe = {
      mirrorId: required(row.mirrorId ?? row.mirror_id, "mirror_id"),
      mirrorKind: required(row.mirrorKind ?? row.mirror_kind, "mirror_kind"),
      aggregateId: required(row.aggregateId ?? row.aggregate_id, "aggregate_id"),
      idempotencyKey: optional(row.idempotencyKey ?? row.idempotency_key),
      payloadVersion: positiveInt(row.payloadVersion ?? row.payload_version, 1),
      payloadJson: typeof row.payloadJson === "string" ? row.payloadJson : stringifyJson(row.payloadJson ?? row.payload),
      status: VALID_STATUSES.has(text(row.status).toLowerCase()) ? text(row.status).toLowerCase() : "pending",
      createdAt: optional(row.createdAt ?? row.created_at) ?? now,
      updatedAt: optional(row.updatedAt ?? row.updated_at) ?? now,
    };
    try {
      this.db.prepare(`
        INSERT INTO payment_mirror_outbox (
          mirror_id, mirror_kind, aggregate_id, idempotency_key,
          payload_version, payload_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        safe.mirrorId,
        safe.mirrorKind,
        safe.aggregateId,
        safe.idempotencyKey,
        safe.payloadVersion,
        safe.payloadJson,
        safe.status,
        safe.createdAt,
        safe.updatedAt,
      );
    } catch (error) {
      if (isConstraintError(error)) {
        const existing =
          this.getById(safe.mirrorId) ??
          this.getByAggregate(safe.mirrorKind, safe.aggregateId) ??
          this.getByIdempotencyKey(safe.mirrorKind, safe.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }
    return this.getById(safe.mirrorId);
  }

  reclaimExpiredLeases(nowIso = this.nowIso()) {
    const now = typeof nowIso === "function" ? nowIso() : nowIso;
    return runRelationalTransaction(this.db, () => this.reclaimExpiredLeasesTx(now));
  }

  reclaimExpiredLeasesTx(nowIso = this.nowIso()) {
    const now = typeof nowIso === "function" ? nowIso() : nowIso;
    return this.db.prepare(`
      UPDATE payment_mirror_outbox
      SET status = 'retrying', locked_by = NULL, locked_at = NULL,
          lock_expires_at = NULL, next_attempt_at = ?, updated_at = ?
      WHERE status = 'processing' AND lock_expires_at IS NOT NULL AND lock_expires_at <= ?
    `).run(now, now, now).changes;
  }

  reclaimAllProcessing(nowIso = this.nowIso()) {
    const now = typeof nowIso === "function" ? nowIso() : nowIso;
    return runRelationalTransaction(this.db, () =>
      this.db.prepare(`
        UPDATE payment_mirror_outbox
        SET status = 'retrying', locked_by = NULL, locked_at = NULL,
            lock_expires_at = NULL, next_attempt_at = ?, updated_at = ?
        WHERE status = 'processing'
      `).run(now, now).changes,
    );
  }

  claimNext({ workerId = "payment-mirror-worker", leaseMs = 30_000, nowIso = this.nowIso() } = {}) {
    const now = typeof nowIso === "function" ? nowIso() : nowIso;
    return runRelationalTransaction(this.db, () => {
      this.reclaimExpiredLeasesTx(now);
      const row = this.db.prepare(`
        SELECT * FROM payment_mirror_outbox
        WHERE status IN ('pending', 'retrying')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at ASC, mirror_id ASC
        LIMIT 1
      `).get(now);
      if (!row) return null;
      const result = this.db.prepare(`
        UPDATE payment_mirror_outbox
        SET status = 'processing', locked_by = ?, locked_at = ?,
            lock_expires_at = ?, next_attempt_at = NULL, updated_at = ?
        WHERE mirror_id = ? AND status IN ('pending', 'retrying')
      `).run(text(workerId, "payment-mirror-worker"), now, addMsIso(now, leaseMs), now, row.mirror_id);
      return result.changes === 1 ? this.getById(row.mirror_id) : null;
    });
  }

  markCompleted(mirrorId, completedAt = this.nowIso()) {
    const at = typeof completedAt === "function" ? completedAt() : completedAt;
    this.db.prepare(`
      UPDATE payment_mirror_outbox
      SET status = 'completed', next_attempt_at = NULL, locked_by = NULL,
          locked_at = NULL, lock_expires_at = NULL, last_error_code = NULL,
          last_error_message = NULL, updated_at = ?, completed_at = ?
      WHERE mirror_id = ?
    `).run(at, at, required(mirrorId, "mirror_id"));
    return this.getById(mirrorId);
  }

  markFailed(mirrorId, options = {}) {
    const now = this.nowIso();
    const terminal = options.terminal === true;
    this.db.prepare(`
      UPDATE payment_mirror_outbox
      SET status = ?, attempt_count = attempt_count + 1,
          next_attempt_at = ?, locked_by = NULL, locked_at = NULL,
          lock_expires_at = NULL, last_error_code = ?, last_error_message = ?,
          updated_at = ?, completed_at = NULL
      WHERE mirror_id = ?
    `).run(
      terminal ? "failed" : "retrying",
      terminal ? null : optional(options.nextAttemptAt) ?? now,
      optional(options.errorCode),
      text(options.errorMessage).slice(0, 1_000) || null,
      now,
      required(mirrorId, "mirror_id"),
    );
    return this.getById(mirrorId);
  }

  deleteTerminalBefore(options = {}) {
    const completedBefore = required(options.completedBefore, "completed_before");
    const failedBefore = required(options.failedBefore, "failed_before");
    const limit = boundedBatchSize(options.limit);
    return runRelationalTransaction(this.db, () => {
      const rows = this.db.prepare(`
        SELECT mirror_id, status
        FROM payment_mirror_outbox
        WHERE (status = 'completed' AND completed_at IS NOT NULL AND completed_at <= ?)
           OR (status = 'failed' AND updated_at <= ?)
        ORDER BY COALESCE(completed_at, updated_at) ASC, mirror_id ASC
        LIMIT ?
      `).all(completedBefore, failedBefore, limit);
      if (rows.length === 0) return { deleted: 0, completed: 0, failed: 0 };
      const placeholders = rows.map(() => "?").join(", ");
      const deleted = this.db.prepare(`
        DELETE FROM payment_mirror_outbox
        WHERE mirror_id IN (${placeholders})
          AND status IN ('completed', 'failed')
      `).run(...rows.map((row) => row.mirror_id)).changes;
      return {
        deleted,
        completed: rows.filter((row) => row.status === "completed").length,
        failed: rows.filter((row) => row.status === "failed").length,
      };
    });
  }

  countSummary() {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('pending', 'retrying') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        MIN(CASE WHEN status IN ('pending', 'retrying') THEN created_at ELSE NULL END) AS oldest_pending_at
      FROM payment_mirror_outbox
    `).get();
    return {
      pending: nonNegativeInt(row?.pending),
      processing: nonNegativeInt(row?.processing),
      completed: nonNegativeInt(row?.completed),
      failed: nonNegativeInt(row?.failed),
      oldestPendingAt: optional(row?.oldest_pending_at),
    };
  }
}
