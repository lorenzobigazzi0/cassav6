import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

let DatabaseSyncClass = null;

const VALID_MODES = new Set(["off", "shadow", "externalized"]);

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

function safeJsonStringify(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function normalizeMode(value) {
  const mode = String(value ?? "off").trim().toLowerCase() || "off";
  if (!VALID_MODES.has(mode)) {
    throw new Error(
      `BACKEND_APP_STATE_SPLIT_PRINT_SPOOL_JOBS non valido: '${mode}'. Valori ammessi: off, shadow, externalized.`
    );
  }
  return mode;
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.trunc(numeric);
}

function normalizePrintSpoolJob(job, position) {
  if (!job || typeof job !== "object") return null;
  const id = String(job.id ?? `print_spool_job_${position}`).trim();
  if (!id) return null;
  const rawJson = safeJsonStringify(job, {});
  return {
    id,
    status: String(job.status ?? "pending").trim() || "pending",
    kind: normalizeNullableString(job.kind),
    orderId: normalizeNullableString(job.orderId),
    areaId: normalizeNullableString(job.areaId),
    deviceId: normalizeNullableString(job.deviceId),
    station: normalizeNullableString(job.station),
    printerId: normalizeNullableString(job.printerId),
    printerName: normalizeNullableString(job.printerName),
    printerHost: normalizeNullableString(job.printerHost),
    printerPort: job.printerPort === null || job.printerPort === undefined ? null : normalizeInteger(job.printerPort, 0),
    requestedAt: normalizeNullableString(job.requestedAt),
    processedAt: normalizeNullableString(job.processedAt),
    lastAttemptAt: normalizeNullableString(job.lastAttemptAt),
    nextRetryAt: normalizeNullableString(job.nextRetryAt),
    recoveredAt: normalizeNullableString(job.recoveredAt),
    fileName: normalizeNullableString(job.fileName),
    textPreview: job.textPreview === null || job.textPreview === undefined ? null : String(job.textPreview),
    bytes: job.bytes === null || job.bytes === undefined ? null : normalizeInteger(job.bytes, 0),
    attempts: normalizeInteger(job.attempts, 0),
    errorMessage: job.errorMessage === null || job.errorMessage === undefined ? null : String(job.errorMessage),
    requestedBy: normalizeNullableString(job.requestedBy),
    appStatePosition: position,
    rawJson,
    rowHash: sha256(rawJson),
  };
}

function rowToPrintSpoolJob(row) {
  const parsed = safeJsonParse(row?.raw_json, null);
  if (parsed && typeof parsed === "object") return parsed;
  return {
    id: String(row?.id ?? ""),
    status: String(row?.status ?? "pending"),
    kind: row?.kind ? String(row.kind) : null,
    orderId: row?.order_id ? String(row.order_id) : null,
    areaId: row?.area_id ? String(row.area_id) : null,
    deviceId: row?.device_id ? String(row.device_id) : null,
    station: row?.station ? String(row.station) : null,
    printerId: row?.printer_id ? String(row.printer_id) : null,
    printerName: row?.printer_name ? String(row.printer_name) : null,
    printerHost: row?.printer_host ? String(row.printer_host) : null,
    printerPort: row?.printer_port === null || row?.printer_port === undefined ? null : Number(row.printer_port),
    requestedAt: row?.requested_at ? String(row.requested_at) : null,
    processedAt: row?.processed_at ? String(row.processed_at) : null,
    lastAttemptAt: row?.last_attempt_at ? String(row.last_attempt_at) : null,
    nextRetryAt: row?.next_retry_at ? String(row.next_retry_at) : null,
    recoveredAt: row?.recovered_at ? String(row.recovered_at) : null,
    fileName: row?.file_name ? String(row.file_name) : null,
    textPreview: row?.text_preview === null || row?.text_preview === undefined ? null : String(row.text_preview),
    bytes: row?.bytes === null || row?.bytes === undefined ? null : Number(row.bytes),
    attempts: Number(row?.attempts ?? 0),
    errorMessage: row?.error_message === null || row?.error_message === undefined ? null : String(row.error_message),
    requestedBy: row?.requested_by ? String(row.requested_by) : null,
  };
}

function buildChecksum(rows) {
  return sha256(JSON.stringify(rows.map((row) => [row.id, row.rowHash, row.appStatePosition])));
}

export async function loadPrintSpoolJobsSplitDatabaseSync() {
  if (!DatabaseSyncClass) {
    const sqliteModule = await import("node:sqlite");
    DatabaseSyncClass = sqliteModule.DatabaseSync;
  }
  return DatabaseSyncClass;
}

export function normalizePrintSpoolJobsSplitMode(value) {
  return normalizeMode(value);
}

export function createPrintSpoolJobsSplitRepository(options = {}) {
  const mode = normalizeMode(options.mode);
  const enabled = mode !== "off";
  const externalized = mode === "externalized";
  const dbPath = path.resolve(String(options.dbPath ?? "app-state-split.sqlite"));
  const logger = options.logger ?? console;
  const nowIso = options.nowIso ?? defaultNowIso;
  const clone = options.cloneJson ?? cloneJson;
  let db = null;

  async function ensure() {
    if (!enabled) return null;
    if (db) return db;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const DatabaseSync = await loadPrintSpoolJobsSplitDatabaseSync();
    db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS app_state_split_state (
        domain TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        checksum TEXT,
        source_last_write_at TEXT,
        synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_state_print_spool_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        kind TEXT,
        order_id TEXT,
        area_id TEXT,
        device_id TEXT,
        station TEXT,
        printer_id TEXT,
        printer_name TEXT,
        printer_host TEXT,
        printer_port INTEGER,
        requested_at TEXT,
        processed_at TEXT,
        last_attempt_at TEXT,
        next_retry_at TEXT,
        recovered_at TEXT,
        file_name TEXT,
        text_preview TEXT,
        bytes INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        requested_by TEXT,
        app_state_position INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        row_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_state_print_spool_jobs_position
        ON app_state_print_spool_jobs(app_state_position);

      CREATE INDEX IF NOT EXISTS idx_app_state_print_spool_jobs_status
        ON app_state_print_spool_jobs(status);

      CREATE INDEX IF NOT EXISTS idx_app_state_print_spool_jobs_order
        ON app_state_print_spool_jobs(order_id, kind);

      CREATE INDEX IF NOT EXISTS idx_app_state_print_spool_jobs_printer
        ON app_state_print_spool_jobs(printer_id, status);

      CREATE INDEX IF NOT EXISTS idx_app_state_print_spool_jobs_retry
        ON app_state_print_spool_jobs(status, next_retry_at);
    `);
    return db;
  }

  function runTransaction(callback) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // noop
      }
      throw error;
    }
  }

  function upsertSplitStateIfChanged(statement, domain, rowCount, checksum, sourceLastWriteAt, syncedAt) {
    const existing = db
      .prepare("SELECT mode, row_count, checksum FROM app_state_split_state WHERE domain = ?")
      .get(domain);
    if (
      existing &&
      String(existing.mode ?? "") === mode &&
      Number(existing.row_count ?? 0) === rowCount &&
      String(existing.checksum ?? "") === String(checksum ?? "")
    ) {
      return false;
    }
    statement.run(domain, mode, rowCount, checksum, sourceLastWriteAt, syncedAt);
    return true;
  }

  async function syncFromAppState(appState) {
    if (!enabled) return null;
    await ensure();
    const jobs = Array.isArray(appState?.printSpoolJobs) ? appState.printSpoolJobs : [];
    const rows = jobs.map((job, index) => normalizePrintSpoolJob(job, index)).filter(Boolean);
    const checksum = buildChecksum(rows);
    const syncedAt = nowIso();
    const sourceLastWriteAt =
      typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim()
        ? appState.meta.lastWriteAt
        : null;

    return runTransaction(() => {
      const existingRows = db.prepare("SELECT id, row_hash FROM app_state_print_spool_jobs").all();
      const existingHashes = new Map(existingRows.map((row) => [String(row.id), String(row.row_hash ?? "")]));
      const nextIds = new Set(rows.map((row) => row.id));
      const insertOrReplace = db.prepare(`
        INSERT INTO app_state_print_spool_jobs (
          id,
          status,
          kind,
          order_id,
          area_id,
          device_id,
          station,
          printer_id,
          printer_name,
          printer_host,
          printer_port,
          requested_at,
          processed_at,
          last_attempt_at,
          next_retry_at,
          recovered_at,
          file_name,
          text_preview,
          bytes,
          attempts,
          error_message,
          requested_by,
          app_state_position,
          raw_json,
          row_hash,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          kind = excluded.kind,
          order_id = excluded.order_id,
          area_id = excluded.area_id,
          device_id = excluded.device_id,
          station = excluded.station,
          printer_id = excluded.printer_id,
          printer_name = excluded.printer_name,
          printer_host = excluded.printer_host,
          printer_port = excluded.printer_port,
          requested_at = excluded.requested_at,
          processed_at = excluded.processed_at,
          last_attempt_at = excluded.last_attempt_at,
          next_retry_at = excluded.next_retry_at,
          recovered_at = excluded.recovered_at,
          file_name = excluded.file_name,
          text_preview = excluded.text_preview,
          bytes = excluded.bytes,
          attempts = excluded.attempts,
          error_message = excluded.error_message,
          requested_by = excluded.requested_by,
          app_state_position = excluded.app_state_position,
          raw_json = excluded.raw_json,
          row_hash = excluded.row_hash,
          updated_at = CURRENT_TIMESTAMP
      `);
      let upserted = 0;
      for (const row of rows) {
        if (existingHashes.get(row.id) === row.rowHash) {
          db.prepare(
            `
              UPDATE app_state_print_spool_jobs
              SET app_state_position = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND app_state_position <> ?
            `
          ).run(row.appStatePosition, row.id, row.appStatePosition);
          continue;
        }
        insertOrReplace.run(
          row.id,
          row.status,
          row.kind,
          row.orderId,
          row.areaId,
          row.deviceId,
          row.station,
          row.printerId,
          row.printerName,
          row.printerHost,
          row.printerPort,
          row.requestedAt,
          row.processedAt,
          row.lastAttemptAt,
          row.nextRetryAt,
          row.recoveredAt,
          row.fileName,
          row.textPreview,
          row.bytes,
          row.attempts,
          row.errorMessage,
          row.requestedBy,
          row.appStatePosition,
          row.rawJson,
          row.rowHash
        );
        upserted += 1;
      }

      const deleteRow = db.prepare("DELETE FROM app_state_print_spool_jobs WHERE id = ?");
      let deleted = 0;
      for (const row of existingRows) {
        const id = String(row.id);
        if (!nextIds.has(id)) {
          deleteRow.run(id);
          deleted += 1;
        }
      }

      const stateStatement = db.prepare(
        `
          INSERT INTO app_state_split_state (
            domain,
            mode,
            row_count,
            checksum,
            source_last_write_at,
            synced_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(domain) DO UPDATE SET
            mode = excluded.mode,
            row_count = excluded.row_count,
            checksum = excluded.checksum,
            source_last_write_at = excluded.source_last_write_at,
            synced_at = excluded.synced_at
        `
      );
      const metadataUpdated = upsertSplitStateIfChanged(
        stateStatement,
        "printSpoolJobs",
        rows.length,
        checksum,
        sourceLastWriteAt,
        syncedAt
      );

      return {
        domain: "printSpoolJobs",
        mode,
        rowCount: rows.length,
        upserted,
        deleted,
        metadataUpdated,
        checksum,
        syncedAt,
      };
    });
  }

  async function listPrintSpoolJobs() {
    if (!enabled) return [];
    await ensure();
    const rows = db
      .prepare(
        `
          SELECT raw_json
          FROM app_state_print_spool_jobs
          ORDER BY app_state_position ASC, requested_at ASC, id ASC
        `
      )
      .all();
    return rows.map(rowToPrintSpoolJob).filter((job) => job && typeof job === "object");
  }

  async function getPrintSpoolJob(jobId) {
    if (!enabled) return null;
    const id = String(jobId ?? "").trim();
    if (!id) return null;
    await ensure();
    const row = db
      .prepare(
        `
          SELECT raw_json
          FROM app_state_print_spool_jobs
          WHERE id = ?
          LIMIT 1
        `
      )
      .get(id);
    const job = rowToPrintSpoolJob(row);
    return job && typeof job === "object" ? job : null;
  }

  async function hydrateAppState(appState) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    await ensure();
    const countRow = db.prepare("SELECT COUNT(*) AS count FROM app_state_print_spool_jobs").get();
    const rowCount = Number(countRow?.count ?? 0);
    if (rowCount <= 0) {
      if (Array.isArray(appState.printSpoolJobs) && appState.printSpoolJobs.length > 0) {
        await syncFromAppState(appState);
      }
      return appState;
    }
    const hydrated = clone(appState, appState);
    hydrated.printSpoolJobs = await listPrintSpoolJobs();
    return hydrated;
  }

  function stripPrintSpoolJobsFromAppState(appState, options = {}) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    const persisted = clone(appState, appState);
    persisted.printSpoolJobs = [];
    if (persisted.meta && typeof persisted.meta === "object") {
      persisted.meta.appStateSplitDomains = {
        ...(persisted.meta.appStateSplitDomains && typeof persisted.meta.appStateSplitDomains === "object"
          ? persisted.meta.appStateSplitDomains
          : {}),
        printSpoolJobs: {
          mode: "externalized",
          storage: "sqlite",
          ...(options.includeUpdatedAt ? { updatedAt: nowIso() } : {}),
        },
      };
    }
    return persisted;
  }

  async function prepareAppStateForPrimaryWrite(appState) {
    return stripPrintSpoolJobsFromAppState(appState, { includeUpdatedAt: true });
  }

  async function prepareAppStateForPersistenceComparison(appState) {
    return stripPrintSpoolJobsFromAppState(appState, { includeUpdatedAt: false });
  }

  function close() {
    try {
      db?.close();
    } catch {
      // noop
    }
    db = null;
  }

  return {
    close,
    dbPath,
    enabled,
    externalized,
    getPrintSpoolJob,
    hydrateAppState,
    listPrintSpoolJobs,
    mode,
    prepareAppStateForPersistenceComparison,
    prepareAppStateForPrimaryWrite,
    syncFromAppState,
  };
}
