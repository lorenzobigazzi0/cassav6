import { createHash } from "node:crypto";
import { runRelationalTransaction } from "./connection.js";
import { stableStringify } from "./realtime-backbone.repo.js";

const COMMAND_STATUSES = new Set(["processing", "committed", "rejected", "failed"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,191}$/;

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
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

function requiredPattern(value, fieldName, pattern) {
  const normalized = requiredText(value, fieldName);
  if (!pattern.test(normalized)) {
    throw new Error(`${fieldName} non valido.`);
  }
  return normalized;
}

function optionalInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!COMMAND_STATUSES.has(normalized)) {
    throw new Error(`Stato command inbox non valido: ${value}`);
  }
  return normalized;
}

function stringifyJson(value, fallback = null) {
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

export function hashCommandPayload(value) {
  return createHash("sha256").update(stableStringify(value ?? {})).digest("hex");
}

function normalizePayloadHash(payloadHash, payload) {
  const explicit = normalizeText(payloadHash);
  if (explicit) {
    if (!/^[a-f0-9]{64}$/i.test(explicit)) {
      throw new Error("payload_hash deve essere uno SHA-256 esadecimale da 64 caratteri.");
    }
    return explicit.toLowerCase();
  }
  return hashCommandPayload(payload ?? {});
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

function rowToCommandRecord(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    deviceId: row.device_id,
    userId: row.user_id ?? null,
    stationId: row.station_id ?? null,
    commandType: row.command_type,
    aggregateType: row.aggregate_type ?? null,
    aggregateId: row.aggregate_id ?? null,
    expectedVersion: row.expected_version === null || row.expected_version === undefined
      ? null
      : Math.trunc(Number(row.expected_version)),
    payloadHash: row.payload_hash,
    payload: safeJsonParse(row.payload_json, {}),
    status: row.status,
    result: safeJsonParse(row.result_json, null),
    errorCode: row.error_code ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    committedAt: row.committed_at ?? null,
    expiresAt: row.expires_at ?? null,
  };
}

function normalizeCommandInput(input = {}, nowIso) {
  const requestId = requiredPattern(input.requestId ?? input.request_id, "request_id", REQUEST_ID_PATTERN);
  const idempotencyKey = requiredPattern(
    input.idempotencyKey ?? input.idempotency_key,
    "idempotency_key",
    IDEMPOTENCY_KEY_PATTERN,
  );
  const deviceId = requiredText(input.deviceId ?? input.device_id, "device_id").slice(0, 128);
  const commandType = requiredText(input.commandType ?? input.command_type, "command_type").slice(0, 128);
  const payload = input.payload === undefined ? {} : input.payload;
  const createdAt = normalizeText(input.createdAt ?? input.created_at, nowIso());
  return {
    requestId,
    idempotencyKey,
    deviceId,
    userId: optionalText(input.userId ?? input.user_id),
    stationId: optionalText(input.stationId ?? input.station_id),
    commandType,
    aggregateType: optionalText(input.aggregateType ?? input.aggregate_type),
    aggregateId: optionalText(input.aggregateId ?? input.aggregate_id),
    expectedVersion: optionalInteger(input.expectedVersion ?? input.expected_version),
    payload,
    payloadHash: normalizePayloadHash(input.payloadHash ?? input.payload_hash, payload),
    createdAt,
    expiresAt: optionalText(input.expiresAt ?? input.expires_at),
  };
}

function recordsAreCompatible(existing, command) {
  if (!existing) return true;
  return (
    existing.requestId === command.requestId &&
    existing.idempotencyKey === command.idempotencyKey &&
    existing.payloadHash === command.payloadHash &&
    existing.commandType === command.commandType &&
    String(existing.aggregateType ?? "") === String(command.aggregateType ?? "") &&
    String(existing.aggregateId ?? "") === String(command.aggregateId ?? "")
  );
}

export class CommandInboxRepository {
  constructor(db, options = {}) {
    ensureRelationalConnection(db);
    this.db = db;
    this.nowIso = typeof options.nowIso === "function" ? options.nowIso : () => new Date().toISOString();
    this.runtimeMetrics = options.runtimeMetrics && typeof options.runtimeMetrics === "object" ? options.runtimeMetrics : null;
  }

  getByRequestId(requestId) {
    const safeRequestId = requiredPattern(requestId, "request_id", REQUEST_ID_PATTERN);
    return rowToCommandRecord(
      this.db.prepare("SELECT * FROM command_inbox WHERE request_id = ?").get(safeRequestId),
    );
  }

  getByIdempotencyKey(idempotencyKey) {
    const safeKey = requiredPattern(idempotencyKey, "idempotency_key", IDEMPOTENCY_KEY_PATTERN);
    return rowToCommandRecord(
      this.db.prepare("SELECT * FROM command_inbox WHERE idempotency_key = ?").get(safeKey),
    );
  }

  begin(input = {}) {
    const command = normalizeCommandInput(input, this.nowIso);
    const now = this.nowIso();
    this.runtimeMetrics?.incrementCounter?.("commandInboxClaims");
    return runRelationalTransaction(this.db, () => {
      let existing = this.getByRequestId(command.requestId) ?? this.getByIdempotencyKey(command.idempotencyKey);
      if (existing && existing.status !== "processing" && isExpired(existing.expiresAt, now)) {
        this.db.prepare("DELETE FROM command_inbox WHERE request_id = ?").run(existing.requestId);
        existing = null;
      }

      if (!existing) {
        this.db
          .prepare(
            `
              INSERT INTO command_inbox (
                request_id,
                idempotency_key,
                device_id,
                user_id,
                station_id,
                command_type,
                aggregate_type,
                aggregate_id,
                expected_version,
                payload_hash,
                payload_json,
                status,
                result_json,
                error_code,
                created_at,
                updated_at,
                committed_at,
                expires_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', NULL, NULL, ?, ?, NULL, ?)
            `,
          )
          .run(
            command.requestId,
            command.idempotencyKey,
            command.deviceId,
            command.userId,
            command.stationId,
            command.commandType,
            command.aggregateType,
            command.aggregateId,
            command.expectedVersion,
            command.payloadHash,
            stringifyJson(command.payload, {}),
            command.createdAt,
            now,
            command.expiresAt,
          );
        this.runtimeMetrics?.incrementCounter?.("commandInboxCreated");
        return { state: "created", record: this.getByRequestId(command.requestId) };
      }

      if (!recordsAreCompatible(existing, command)) {
        this.runtimeMetrics?.incrementCounter?.("commandInboxConflicts");
        return { state: "conflict", record: existing };
      }

      if (existing.status === "processing") this.runtimeMetrics?.incrementCounter?.("commandInboxInProgress");
      else this.runtimeMetrics?.incrementCounter?.("commandInboxReplays");
      return {
        state: existing.status,
        record: existing,
        result: existing.result,
        errorCode: existing.errorCode,
      };
    });
  }

  setStatus(requestId, status, result = null, options = {}) {
    const safeRequestId = requiredPattern(requestId, "request_id", REQUEST_ID_PATTERN);
    const safeStatus = normalizeStatus(status);
    const now = this.nowIso();
    const committedAt = safeStatus === "processing" ? null : normalizeText(options.committedAt ?? now, now);
    const errorCode = optionalText(options.errorCode);
    const updateResult = this.db
      .prepare(
        `
          UPDATE command_inbox
          SET status = ?,
              result_json = ?,
              error_code = ?,
              updated_at = ?,
              committed_at = ?
          WHERE request_id = ?
        `,
      )
      .run(safeStatus, stringifyJson(result, null), errorCode, now, committedAt, safeRequestId);
    if (updateResult.changes === 0) {
      throw new Error(`Comando non trovato: ${safeRequestId}`);
    }
    const record = this.getByRequestId(safeRequestId);
    if (safeStatus === "committed") this.runtimeMetrics?.incrementCounter?.("commandInboxCommitted");
    if (safeStatus === "rejected") this.runtimeMetrics?.incrementCounter?.("commandInboxRejected");
    if (safeStatus === "failed") this.runtimeMetrics?.incrementCounter?.("commandInboxFailed");
    return record;
  }

  commit(requestId, result = null) {
    return this.setStatus(requestId, "committed", result);
  }

  reject(requestId, errorCode, result = null) {
    return this.setStatus(requestId, "rejected", result, { errorCode });
  }

  fail(requestId, errorCode, result = null) {
    return this.setStatus(requestId, "failed", result, { errorCode });
  }

  listOpen({ limit = 100 } = {}) {
    const safeLimit = Math.min(1000, Math.max(1, Math.trunc(Number(limit) || 100)));
    return this.db
      .prepare(
        `
          SELECT *
          FROM command_inbox
          WHERE status = 'processing'
          ORDER BY created_at ASC
          LIMIT ?
        `,
      )
      .all(safeLimit)
      .map(rowToCommandRecord);
  }

  countSummary() {
    const row = this.db
      .prepare(
        `
          SELECT
            SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
            SUM(CASE WHEN status = 'committed' THEN 1 ELSE 0 END) AS committed,
            SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            MIN(CASE WHEN status = 'processing' THEN created_at ELSE NULL END) AS oldest_processing_at
          FROM command_inbox
        `,
      )
      .get();
    return {
      processing: Math.max(0, Math.trunc(Number(row?.processing) || 0)),
      committed: Math.max(0, Math.trunc(Number(row?.committed) || 0)),
      rejected: Math.max(0, Math.trunc(Number(row?.rejected) || 0)),
      failed: Math.max(0, Math.trunc(Number(row?.failed) || 0)),
      oldestProcessingAt: optionalText(row?.oldest_processing_at),
    };
  }

  deleteExpired(nowIso = this.nowIso()) {
    return this.db
      .prepare("DELETE FROM command_inbox WHERE expires_at IS NOT NULL AND expires_at <= ? AND status <> 'processing'")
      .run(requiredText(nowIso, "nowIso")).changes;
  }
}

export function createCommandEnvelope(input = {}) {
  const nowIso = typeof input.nowIso === "function" ? input.nowIso : () => new Date().toISOString();
  return normalizeCommandInput(input, nowIso);
}
