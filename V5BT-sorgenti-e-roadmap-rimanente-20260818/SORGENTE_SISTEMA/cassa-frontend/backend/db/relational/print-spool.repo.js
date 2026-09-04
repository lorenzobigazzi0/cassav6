import { runRelationalTransaction } from "./connection.js";
import { normalizePrintState } from "../../modules/print-spool/print-state-machine.js";

// Step 6 — coda di stampa durabile su relazionale (SQL-primary). Claim atomico
// con lease + reclaim per la resilienza ai crash del worker. Gli stati seguono
// la macchina a stati di print-state-machine.js.

const TERMINAL_STATES = new Set(["confirmed", "failed_final"]);
// Stati da cui un job può essere (ri)preso dal worker.
const CLAIMABLE_STATES = new Set(["queued", "failed_retryable"]);

function nowIsoDefault() {
  return new Date().toISOString();
}

function optionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function optionalInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function stringifyJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function safeJsonParse(value, fallback = {}) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function addMsIso(baseIso, ms) {
  const baseMs = Date.parse(String(baseIso ?? ""));
  const safeBase = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(safeBase + Math.max(0, Math.trunc(Number(ms) || 0))).toISOString();
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    kind: row.kind ?? null,
    orderId: row.order_id ?? null,
    printerId: row.printer_id ?? null,
    printerHost: row.printer_host ?? null,
    printerPort: row.printer_port === null || row.printer_port === undefined
      ? null
      : Math.trunc(Number(row.printer_port)),
    payload: safeJsonParse(row.payload_json, {}),
    attemptCount: Math.max(0, Math.trunc(Number(row.attempt_count) || 0)),
    claimedBy: row.claimed_by ?? null,
    claimedAt: row.claimed_at ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    nextRetryAt: row.next_retry_at ?? null,
    lastError: row.last_error ?? null,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at ?? null,
  };
}

const PRINT_SPOOL_INSERT_SQL = `
  INSERT INTO print_spool (
    id, status, kind, order_id, printer_id, printer_host, printer_port,
    payload_json, attempt_count, claimed_by, claimed_at, lease_expires_at,
    next_retry_at, last_error, requested_at, updated_at, terminal_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`;

function normalizeEnqueueJob(job, now) {
  const id = String(job?.id ?? "").trim();
  if (!id) throw new Error("print_spool.enqueue richiede un id.");
  const status = normalizePrintState(job?.status ?? "queued", "queued");
  return {
    id,
    status,
    kind: optionalText(job?.kind),
    orderId: optionalText(job?.orderId),
    printerId: optionalText(job?.printerId),
    printerHost: optionalText(job?.printerHost),
    printerPort: optionalInteger(job?.printerPort),
    payloadJson: stringifyJson(job?.payload ?? job),
    errorMessage: optionalText(job?.errorMessage),
    requestedAt: String(job?.requestedAt ?? now),
    updatedAt: now,
    terminalAt: TERMINAL_STATES.has(status) ? now : null,
  };
}

function insertNormalizedJob(statement, job) {
  statement.run(
    job.id,
    job.status,
    job.kind,
    job.orderId,
    job.printerId,
    job.printerHost,
    job.printerPort,
    job.payloadJson,
    job.errorMessage,
    job.requestedAt,
    job.updatedAt,
    job.terminalAt,
  );
}

export class PrintSpoolRepository {
  constructor(db, options = {}) {
    if (!db || typeof db.prepare !== "function") {
      throw new Error("Connessione SQLite relazionale non valida per print_spool.");
    }
    this.db = db;
    this.nowIso = typeof options.nowIso === "function" ? options.nowIso : nowIsoDefault;
  }

  getById(id) {
    const safeId = String(id ?? "").trim();
    if (!safeId) return null;
    return rowToJob(this.db.prepare("SELECT * FROM print_spool WHERE id = ?").get(safeId));
  }

  enqueue(job = {}) {
    const now = this.nowIso();
    const normalized = normalizeEnqueueJob(job, now);
    insertNormalizedJob(this.db.prepare(PRINT_SPOOL_INSERT_SQL), normalized);
    return this.getById(normalized.id);
  }

  enqueueMany(jobs = []) {
    const safeJobs = Array.isArray(jobs) ? jobs : [];
    if (safeJobs.length === 0) return [];
    const now = this.nowIso();
    const normalizedJobs = safeJobs.map((job) => normalizeEnqueueJob(job, now));
    return runRelationalTransaction(this.db, () => {
      const insert = this.db.prepare(PRINT_SPOOL_INSERT_SQL);
      const select = this.db.prepare("SELECT * FROM print_spool WHERE id = ?");
      for (const job of normalizedJobs) insertNormalizedJob(insert, job);
      return normalizedJobs.map((job) => rowToJob(select.get(job.id)));
    });
  }

  // Riporta a coda i job con lease scaduto (worker morto senza completare).
  reclaimExpiredLeasesTx(now) {
    return this.db
      .prepare(
        `
          UPDATE print_spool
          SET status = 'queued',
              claimed_by = NULL,
              claimed_at = NULL,
              lease_expires_at = NULL,
              updated_at = ?
          WHERE status = 'claimed'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at < ?
        `,
      )
      .run(now, now).changes;
  }

  reclaimExpiredLeases(now = this.nowIso()) {
    return runRelationalTransaction(this.db, () => this.reclaimExpiredLeasesTx(now));
  }

  // Recovery all'avvio: qualunque job 'claimed' è orfano (il processo che lo
  // teneva non c'è più) → torna in coda.
  reclaimAllClaimed(now = this.nowIso()) {
    return runRelationalTransaction(this.db, () =>
      this.db
        .prepare(
          `
            UPDATE print_spool
            SET status = 'queued',
                claimed_by = NULL,
                claimed_at = NULL,
                lease_expires_at = NULL,
                updated_at = ?
            WHERE status = 'claimed'
          `,
        )
        .run(now).changes,
    );
  }

  // Claim atomico: reclaim dei lease scaduti, poi prende il job pronto più
  // vecchio e lo marca 'claimed' con lease. La transazione serializza i claim.
  claimNext({ workerId = "worker", leaseMs = 30_000, now = this.nowIso() } = {}) {
    return runRelationalTransaction(this.db, () => {
      this.reclaimExpiredLeasesTx(now);
      const row = this.db
        .prepare(
          `
            SELECT * FROM print_spool
            WHERE status IN ('queued', 'failed_retryable')
              AND (next_retry_at IS NULL OR next_retry_at <= ?)
            ORDER BY requested_at ASC, id ASC
            LIMIT 1
          `,
        )
        .get(now);
      if (!row) return null;
      const leaseExpiresAt = addMsIso(now, leaseMs);
      this.db
        .prepare(
          `
            UPDATE print_spool
            SET status = 'claimed',
                claimed_by = ?,
                claimed_at = ?,
                lease_expires_at = ?,
                next_retry_at = NULL,
                updated_at = ?
            WHERE id = ?
          `,
        )
        .run(String(workerId), now, leaseExpiresAt, now, row.id);
      return this.getById(row.id);
    });
  }

  // Mirror del claim quando il worker legacy (app-state) claima un job: allinea
  // lo stato relazionale a 'claimed' con lease. No-op se il job non è nel DB.
  markClaimed(id, { workerId = "worker", leaseMs = 30_000, now = this.nowIso() } = {}) {
    const safeId = String(id ?? "").trim();
    if (!safeId) return null;
    const result = this.db
      .prepare(
        `
          UPDATE print_spool
          SET status = 'claimed',
              claimed_by = ?,
              claimed_at = ?,
              lease_expires_at = ?,
              next_retry_at = NULL,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(String(workerId), now, addMsIso(now, leaseMs), now, safeId);
    if (result.changes === 0) return null;
    return this.getById(safeId);
  }

  markSent(id, { now = this.nowIso() } = {}) {
    return this.#setStatus(id, "sent", { now });
  }

  markConfirmed(id, { now = this.nowIso() } = {}) {
    return this.#setStatus(id, "confirmed", { now, terminal: true, clearClaim: true });
  }

  // Fallimento: retryable → torna in coda con backoff e attempt++, altrimenti
  // termina come failed_final.
  markFailed(id, { retryable = false, retryDelayMs = 0, errorMessage = "", now = this.nowIso() } = {}) {
    const current = this.getById(id);
    if (!current) return null;
    const attemptCount = current.attemptCount + 1;
    if (retryable) {
      this.db
        .prepare(
          `
            UPDATE print_spool
            SET status = 'failed_retryable',
                attempt_count = ?,
                next_retry_at = ?,
                last_error = ?,
                claimed_by = NULL,
                claimed_at = NULL,
                lease_expires_at = NULL,
                updated_at = ?
            WHERE id = ?
          `,
        )
        .run(attemptCount, addMsIso(now, retryDelayMs), optionalText(errorMessage), now, id);
    } else {
      this.db
        .prepare(
          `
            UPDATE print_spool
            SET status = 'failed_final',
                attempt_count = ?,
                next_retry_at = NULL,
                last_error = ?,
                claimed_by = NULL,
                claimed_at = NULL,
                lease_expires_at = NULL,
                updated_at = ?,
                terminal_at = ?
            WHERE id = ?
          `,
        )
        .run(attemptCount, optionalText(errorMessage), now, now, id);
    }
    return this.getById(id);
  }

  #setStatus(id, status, { now, terminal = false, clearClaim = false } = {}) {
    const safeId = String(id ?? "").trim();
    if (!safeId) return null;
    const result = this.db
      .prepare(
        `
          UPDATE print_spool
          SET status = ?,
              updated_at = ?,
              terminal_at = CASE WHEN ? = 1 THEN ? ELSE terminal_at END,
              claimed_by = CASE WHEN ? = 1 THEN NULL ELSE claimed_by END,
              claimed_at = CASE WHEN ? = 1 THEN NULL ELSE claimed_at END,
              lease_expires_at = CASE WHEN ? = 1 THEN NULL ELSE lease_expires_at END
          WHERE id = ?
        `,
      )
      .run(
        status,
        now,
        terminal ? 1 : 0,
        now,
        clearClaim ? 1 : 0,
        clearClaim ? 1 : 0,
        clearClaim ? 1 : 0,
        safeId,
      );
    if (result.changes === 0) return null;
    return this.getById(safeId);
  }

  listByStatus(status, { limit = 100 } = {}) {
    const safeLimit = Math.min(1000, Math.max(1, Math.trunc(Number(limit) || 100)));
    return this.db
      .prepare(
        "SELECT * FROM print_spool WHERE status = ? ORDER BY requested_at ASC, id ASC LIMIT ?",
      )
      .all(String(status), safeLimit)
      .map(rowToJob);
  }

  countSummary() {
    const row = this.db
      .prepare(
        `
          SELECT
            SUM(CASE WHEN status IN ('queued', 'failed_retryable') THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
            SUM(CASE WHEN status IN ('confirmed', 'failed_final') THEN 1 ELSE 0 END) AS terminal,
            MIN(CASE WHEN status IN ('queued', 'failed_retryable') THEN requested_at ELSE NULL END) AS oldest_pending_at
          FROM print_spool
        `,
      )
      .get();
    return {
      pending: Math.max(0, Math.trunc(Number(row?.pending) || 0)),
      claimed: Math.max(0, Math.trunc(Number(row?.claimed) || 0)),
      terminal: Math.max(0, Math.trunc(Number(row?.terminal) || 0)),
      oldestPendingAt: optionalText(row?.oldest_pending_at),
    };
  }

  nextRetryDelayMs(now = this.nowIso()) {
    const row = this.db
      .prepare(
        `
          SELECT MIN(next_retry_at) AS next_retry_at
          FROM print_spool
          WHERE status = 'failed_retryable'
            AND next_retry_at IS NOT NULL
        `,
      )
      .get();
    const nextMs = Date.parse(String(row?.next_retry_at ?? ""));
    if (!Number.isFinite(nextMs)) return null;
    const nowMs = Date.parse(String(now ?? ""));
    const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    return Math.max(0, nextMs - safeNowMs);
  }

  deleteTerminalBefore(beforeIso) {
    const cutoff = String(beforeIso ?? "").trim();
    if (!cutoff) return 0;
    return this.db
      .prepare(
        "DELETE FROM print_spool WHERE status IN ('confirmed', 'failed_final') AND terminal_at IS NOT NULL AND terminal_at < ?",
      )
      .run(cutoff).changes;
  }
}
