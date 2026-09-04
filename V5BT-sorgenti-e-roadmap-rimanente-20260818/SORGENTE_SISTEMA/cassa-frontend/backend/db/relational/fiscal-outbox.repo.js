import { runRelationalTransaction } from "./connection.js";

const FISCAL_OUTBOX_STATUSES = new Set([
  "requested",
  "processing",
  "issued",
  "failed",
  "retrying",
  "manual_required",
]);

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
  if (!normalized) throw new Error(`${fieldName} richiesto.`);
  return normalized;
}

function normalizeStatus(value, fallback = "requested") {
  const normalized = normalizeText(value, fallback).toLowerCase();
  return FISCAL_OUTBOX_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeAttemptCount(value) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function addMsIso(baseIso, ms) {
  const baseMs = Date.parse(String(baseIso ?? ""));
  const parsedMs = Math.max(0, Math.trunc(Number(ms) || 0));
  const start = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(start + parsedMs).toISOString();
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

function isSqliteConstraintError(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  return (
    code.includes("SQLITE_CONSTRAINT") ||
    message.includes("UNIQUE constraint failed") ||
    message.includes("constraint failed")
  );
}

function rowToFiscalOutbox(row) {
  if (!row) return null;
  return {
    fiscalId: row.fiscal_id,
    storeId: row.store_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    paymentId: row.payment_id,
    payload: safeJsonParse(row.payload_json, {}),
    status: row.status,
    attemptCount: normalizeAttemptCount(row.attempt_count),
    nextAttemptAt: row.next_attempt_at,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    lockExpiresAt: row.lock_expires_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    issuedAt: row.issued_at,
  };
}

export class FiscalOutboxRepository {
  constructor(db, options = {}) {
    this.db = db;
    this.nowIso = typeof options.nowIso === "function" ? options.nowIso : () => new Date().toISOString();
  }

  getById(fiscalId) {
    const safeId = requiredText(fiscalId, "fiscal_id");
    return rowToFiscalOutbox(
      this.db.prepare("SELECT * FROM fiscal_outbox WHERE fiscal_id = ?").get(safeId),
    );
  }

  getByAggregate(aggregateType, aggregateId) {
    const safeAggregateType = requiredText(aggregateType, "aggregate_type");
    const safeAggregateId = requiredText(aggregateId, "aggregate_id");
    return rowToFiscalOutbox(
      this.db
        .prepare(
          "SELECT * FROM fiscal_outbox WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY created_at ASC LIMIT 1",
        )
        .get(safeAggregateType, safeAggregateId),
    );
  }

  enqueue(row = {}) {
    const now = this.nowIso();
    const safeRow = {
      fiscalId: requiredText(row.fiscalId ?? row.fiscal_id, "fiscal_id"),
      storeId: optionalText(row.storeId ?? row.store_id),
      aggregateType: requiredText(row.aggregateType ?? row.aggregate_type, "aggregate_type"),
      aggregateId: requiredText(row.aggregateId ?? row.aggregate_id, "aggregate_id"),
      paymentId: optionalText(row.paymentId ?? row.payment_id),
      payloadJson:
        typeof row.payloadJson === "string"
          ? row.payloadJson
          : stringifyJson(row.payloadJson ?? row.payload, {}),
      status: normalizeStatus(row.status),
      attemptCount: normalizeAttemptCount(row.attemptCount ?? row.attempt_count),
      nextAttemptAt: optionalText(row.nextAttemptAt ?? row.next_attempt_at),
      lockedBy: optionalText(row.lockedBy ?? row.locked_by),
      lockedAt: optionalText(row.lockedAt ?? row.locked_at),
      lockExpiresAt: optionalText(row.lockExpiresAt ?? row.lock_expires_at),
      lastErrorCode: optionalText(row.lastErrorCode ?? row.last_error_code),
      lastErrorMessage: optionalText(row.lastErrorMessage ?? row.last_error_message),
      createdAt: optionalText(row.createdAt ?? row.created_at) ?? now,
      updatedAt: optionalText(row.updatedAt ?? row.updated_at) ?? now,
      issuedAt: optionalText(row.issuedAt ?? row.issued_at),
    };

    try {
      this.db
        .prepare(
          `
            INSERT INTO fiscal_outbox (
              fiscal_id,
              store_id,
              aggregate_type,
              aggregate_id,
              payment_id,
              payload_json,
              status,
              attempt_count,
              next_attempt_at,
              locked_by,
              locked_at,
              lock_expires_at,
              last_error_code,
              last_error_message,
              created_at,
              updated_at,
              issued_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          safeRow.fiscalId,
          safeRow.storeId,
          safeRow.aggregateType,
          safeRow.aggregateId,
          safeRow.paymentId,
          safeRow.payloadJson,
          safeRow.status,
          safeRow.attemptCount,
          safeRow.nextAttemptAt,
          safeRow.lockedBy,
          safeRow.lockedAt,
          safeRow.lockExpiresAt,
          safeRow.lastErrorCode,
          safeRow.lastErrorMessage,
          safeRow.createdAt,
          safeRow.updatedAt,
          safeRow.issuedAt,
        );
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        const existing =
          this.getById(safeRow.fiscalId) ??
          this.getByAggregate(safeRow.aggregateType, safeRow.aggregateId);
        if (existing) return existing;
      }
      throw error;
    }
    return this.getById(safeRow.fiscalId);
  }

  listReady({ nowIso = this.nowIso(), limit = 100 } = {}) {
    const referenceNow = typeof nowIso === "function" ? nowIso() : nowIso;
    const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 100, 1), 1_000);
    return this.db
      .prepare(
        `
          SELECT *
          FROM fiscal_outbox
          WHERE status IN ('requested', 'retrying')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY created_at ASC, fiscal_id ASC
          LIMIT ?
        `,
      )
      .all(referenceNow, safeLimit)
      .map(rowToFiscalOutbox);
  }

  reclaimExpiredLeases(nowIso = this.nowIso()) {
    const now = typeof nowIso === "function" ? nowIso() : nowIso;
    return runRelationalTransaction(this.db, () => this.reclaimExpiredLeasesTx(now));
  }

  reclaimExpiredLeasesTx(nowIso = this.nowIso()) {
    const now = typeof nowIso === "function" ? nowIso() : nowIso;
    return this.db
      .prepare(
        `
          UPDATE fiscal_outbox
          SET status = 'retrying',
              locked_by = NULL,
              locked_at = NULL,
              lock_expires_at = NULL,
              updated_at = ?
          WHERE status = 'processing'
            AND lock_expires_at IS NOT NULL
            AND lock_expires_at <= ?
        `,
      )
      .run(now, now).changes;
  }

  reclaimAllProcessing(nowIso = this.nowIso()) {
    const now = typeof nowIso === "function" ? nowIso() : nowIso;
    return runRelationalTransaction(this.db, () =>
      this.db
        .prepare(
          `
            UPDATE fiscal_outbox
            SET status = 'retrying',
                locked_by = NULL,
                locked_at = NULL,
                lock_expires_at = NULL,
                updated_at = ?
            WHERE status = 'processing'
          `,
        )
        .run(now).changes,
    );
  }

  claimNext({ workerId = "fiscal-worker", leaseMs = 30_000, nowIso = this.nowIso() } = {}) {
    const now = typeof nowIso === "function" ? nowIso() : nowIso;
    return runRelationalTransaction(this.db, () => {
      this.reclaimExpiredLeasesTx(now);
      const row = this.db
        .prepare(
          `
            SELECT *
            FROM fiscal_outbox
            WHERE status IN ('requested', 'retrying')
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY created_at ASC, fiscal_id ASC
            LIMIT 1
          `,
        )
        .get(now);
      if (!row) return null;
      const lockExpiresAt = addMsIso(now, leaseMs);
      this.db
        .prepare(
          `
            UPDATE fiscal_outbox
            SET status = 'processing',
                locked_by = ?,
                locked_at = ?,
                lock_expires_at = ?,
                next_attempt_at = NULL,
                updated_at = ?
            WHERE fiscal_id = ?
          `,
        )
        .run(String(workerId), now, lockExpiresAt, now, row.fiscal_id);
      return this.getById(row.fiscal_id);
    });
  }

  markProcessing(fiscalId, { lockedBy = null, lockedAt = this.nowIso(), leaseMs = 30_000 } = {}) {
    const lockStartedAt = typeof lockedAt === "function" ? lockedAt() : lockedAt;
    return this.#updateStatus(fiscalId, "processing", {
      lockedBy,
      lockedAt: lockStartedAt,
      lockExpiresAt: addMsIso(lockStartedAt, leaseMs),
      updatedAt: lockStartedAt,
    });
  }

  markIssued(fiscalId, { issuedAt = this.nowIso(), payload = undefined } = {}) {
    return this.#updateStatus(fiscalId, "issued", {
      issuedAt,
      updatedAt: issuedAt,
      payload,
      clearLock: true,
      clearError: true,
    });
  }

  markFailed(fiscalId, { errorCode = null, errorMessage = null, nextAttemptAt = null, manualRequired = false, payload = undefined } = {}) {
    const now = this.nowIso();
    return this.#updateStatus(fiscalId, manualRequired ? "manual_required" : nextAttemptAt ? "retrying" : "failed", {
      lastErrorCode: errorCode,
      lastErrorMessage: errorMessage,
      nextAttemptAt,
      updatedAt: now,
      incrementAttempts: true,
      clearLock: true,
      payload,
    });
  }

  countSummary() {
    const row = this.db
      .prepare(
        `
          SELECT
            SUM(CASE WHEN status IN ('requested', 'retrying') THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
            SUM(CASE WHEN status IN ('issued', 'failed', 'manual_required') THEN 1 ELSE 0 END) AS terminal,
            SUM(CASE WHEN status = 'manual_required' THEN 1 ELSE 0 END) AS manual_required,
            MIN(CASE WHEN status IN ('requested', 'retrying') THEN created_at ELSE NULL END) AS oldest_pending_at
          FROM fiscal_outbox
        `,
      )
      .get();
    return {
      pending: normalizeAttemptCount(row?.pending),
      processing: normalizeAttemptCount(row?.processing),
      terminal: normalizeAttemptCount(row?.terminal),
      manualRequired: normalizeAttemptCount(row?.manual_required),
      oldestPendingAt: optionalText(row?.oldest_pending_at),
    };
  }

  #updateStatus(fiscalId, status, patch = {}) {
    const safeId = requiredText(fiscalId, "fiscal_id");
    const safeStatus = normalizeStatus(status);
    const assignments = ["status = ?", "updated_at = ?"];
    const params = [safeStatus, optionalText(patch.updatedAt) ?? this.nowIso()];

    if (patch.incrementAttempts) assignments.push("attempt_count = attempt_count + 1");
    if (patch.nextAttemptAt !== undefined) {
      assignments.push("next_attempt_at = ?");
      params.push(optionalText(patch.nextAttemptAt));
    }
    if (patch.lockedBy !== undefined) {
      assignments.push("locked_by = ?");
      params.push(optionalText(patch.lockedBy));
    }
    if (patch.lockedAt !== undefined) {
      assignments.push("locked_at = ?");
      params.push(optionalText(patch.lockedAt));
    }
    if (patch.lockExpiresAt !== undefined) {
      assignments.push("lock_expires_at = ?");
      params.push(optionalText(patch.lockExpiresAt));
    }
    if (patch.clearLock) assignments.push("locked_by = NULL", "locked_at = NULL", "lock_expires_at = NULL");
    if (patch.clearError) assignments.push("last_error_code = NULL", "last_error_message = NULL");
    if (patch.lastErrorCode !== undefined) {
      assignments.push("last_error_code = ?");
      params.push(optionalText(patch.lastErrorCode));
    }
    if (patch.lastErrorMessage !== undefined) {
      assignments.push("last_error_message = ?");
      params.push(optionalText(patch.lastErrorMessage));
    }
    if (patch.issuedAt !== undefined) {
      assignments.push("issued_at = ?");
      params.push(optionalText(patch.issuedAt));
    }
    if (patch.payload !== undefined) {
      assignments.push("payload_json = ?");
      params.push(stringifyJson(patch.payload, {}));
    }

    const result = this.db
      .prepare(`UPDATE fiscal_outbox SET ${assignments.join(", ")} WHERE fiscal_id = ?`)
      .run(...params, safeId);
    if (result.changes === 0) throw new Error(`Fiscal outbox non trovata: ${safeId}`);
    return this.getById(safeId);
  }
}

export { FISCAL_OUTBOX_STATUSES };
