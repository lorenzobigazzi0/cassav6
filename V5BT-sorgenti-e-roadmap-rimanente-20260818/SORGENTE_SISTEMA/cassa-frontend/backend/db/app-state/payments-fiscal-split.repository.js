import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

let DatabaseSyncClass = null;

const VALID_MODES = new Set(["off", "shadow", "externalized"]);

const PAYMENT_FISCAL_COLLECTIONS = [
  {
    key: "paymentContainers",
    domain: "paymentContainers",
    idFields: ["id", "paymentId", "clientPaymentId", "idempotencyKey"],
    amountFields: ["amount"],
    statusFields: ["status"],
    createdAtFields: ["createdAt"],
    updatedAtFields: ["updatedAt", "fiscalIssuedAt", "tableCancelledAt"],
  },
  {
    key: "paymentParts",
    domain: "paymentParts",
    idFields: ["id", "partId"],
    amountFields: ["amountDue", "amount"],
    statusFields: ["status"],
    paymentIdFields: ["paymentId", "paymentContainerId"],
  },
  {
    key: "paymentTransactions",
    domain: "paymentTransactions",
    idFields: ["id", "transactionId", "txId"],
    amountFields: ["amountPaid", "amount"],
    methodFields: ["method"],
    paymentPartIdFields: ["partId", "paymentPartId"],
    createdAtFields: ["createdAt"],
    updatedAtFields: ["updatedAt", "refundedAt"],
  },
  {
    key: "paymentProviderTransactions",
    domain: "paymentProviderTransactions",
    idFields: ["transactionId", "id", "clientPaymentId", "idempotencyKey"],
    amountFields: ["amount"],
    statusFields: ["status", "phase"],
    methodFields: ["paymentMethodId", "providerType"],
    createdAtFields: ["createdAt"],
    updatedAtFields: ["updatedAt", "completedAt"],
  },
  {
    key: "payments",
    domain: "payments.legacy",
    idFields: ["id", "paymentId", "clientPaymentId", "idempotencyKey"],
    amountFields: ["amount"],
    methodFields: ["methodId", "methodLabel"],
    paymentIdFields: ["paymentContainerId", "paymentId"],
    paymentPartIdFields: ["paymentPartId"],
    paymentTransactionIdFields: ["paymentTxId"],
    createdAtFields: ["createdAt"],
    updatedAtFields: ["updatedAt", "tableCancelledAt"],
  },
  {
    key: "fiscalReceipts",
    domain: "fiscalReceipts",
    idFields: ["id", "receiptId", "fiscalDocNo", "fiscalRequestId", "idempotencyKey"],
    amountFields: ["amount"],
    statusFields: ["status", "fiscalStatus"],
    paymentTransactionIdFields: ["paymentId", "paymentTxId", "txId"],
    createdAtFields: ["createdAt"],
    updatedAtFields: ["updatedAt", "lastAttemptAt", "nextRetryAt"],
  },
  {
    key: "fiscalEvents",
    domain: "fiscalEvents",
    idFields: ["id", "eventId", "fiscalEventId"],
    statusFields: ["result", "status"],
    createdAtFields: ["createdAt", "occurredAt"],
  },
  {
    key: "cashTxDenoms",
    domain: "cashTxDenoms",
    idFields: ["id", "transactionId", "paymentTxId", "paymentId"],
    amountFields: ["amount", "value"],
    paymentTransactionIdFields: ["txId", "transactionId", "paymentTxId", "paymentId"],
    createdAtFields: ["createdAt"],
    updatedAtFields: ["updatedAt"],
  },
  {
    key: "smartNonFiscal",
    domain: "smartNonFiscal",
    idFields: ["id", "entryId", "paymentId", "clientPaymentId"],
    amountFields: ["amount"],
    methodFields: ["methodId", "methodLabel"],
    createdAtFields: ["createdAt"],
    updatedAtFields: ["updatedAt"],
  },
];

const PAYMENT_FISCAL_COLLECTION_BY_KEY = new Map(
  PAYMENT_FISCAL_COLLECTIONS.map((collection) => [collection.key, collection])
);

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
      `BACKEND_APP_STATE_SPLIT_PAYMENTS_FISCAL non valido: '${mode}'. Valori ammessi: off, shadow, externalized.`
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

function normalizeNumber(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
}

function firstString(record, fields = []) {
  for (const field of fields) {
    const value = normalizeNullableString(record?.[field]);
    if (value) return value;
  }
  return null;
}

function firstNumber(record, fields = []) {
  for (const field of fields) {
    const value = record?.[field];
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function resolveRecordId(collection, record, position, rawJson) {
  const direct = firstString(record, collection.idFields);
  if (direct) return direct;
  return `${collection.key}_${position + 1}_${sha256(rawJson).slice(0, 16)}`;
}

function normalizeOrderIds(record) {
  const orderIds = Array.isArray(record?.orderIds)
    ? record.orderIds.map((entry) => normalizeNullableString(entry)).filter(Boolean)
    : [];
  const orderId = normalizeNullableString(record?.orderId);
  if (orderId && !orderIds.includes(orderId)) orderIds.unshift(orderId);
  return orderIds;
}

function normalizePaymentFiscalRecord(collection, record, position) {
  if (!record || typeof record !== "object") return null;
  const rawJson = safeJsonStringify(record, {});
  const id = resolveRecordId(collection, record, position, rawJson);
  if (!id) return null;
  const orderIds = normalizeOrderIds(record);
  return {
    collectionKey: collection.key,
    id,
    paymentId: firstString(record, collection.paymentIdFields ?? ["paymentId", "paymentContainerId", "containerId"]),
    paymentPartId: firstString(record, collection.paymentPartIdFields ?? ["partId", "paymentPartId"]),
    paymentTransactionId: firstString(
      record,
      collection.paymentTransactionIdFields ?? ["paymentTxId", "txId", "transactionId"]
    ),
    receiptId: firstString(record, ["receiptId", "fiscalReceiptId", "fiscalDocNo", "fiscalRequestId"]),
    tableId: firstString(record, ["tableId", "sourceTableId", "targetTableId"]),
    roomId: firstString(record, ["roomId"]),
    orderId: orderIds[0] ?? null,
    orderIdsJson: safeJsonStringify(orderIds, []),
    status: firstString(record, collection.statusFields),
    method: firstString(record, collection.methodFields),
    amount: firstNumber(record, collection.amountFields),
    createdAt: firstString(record, collection.createdAtFields),
    updatedAt: firstString(record, collection.updatedAtFields),
    appStatePosition: position,
    rawJson,
    rowHash: sha256(rawJson),
  };
}

function rowToRecord(row) {
  const parsed = safeJsonParse(row?.raw_json, null);
  if (parsed && typeof parsed === "object") return parsed;
  return {
    id: String(row?.id ?? ""),
    paymentId: row?.payment_id ? String(row.payment_id) : undefined,
    partId: row?.payment_part_id ? String(row.payment_part_id) : undefined,
    transactionId: row?.payment_transaction_id ? String(row.payment_transaction_id) : undefined,
    receiptId: row?.receipt_id ? String(row.receipt_id) : undefined,
    tableId: row?.table_id ? String(row.table_id) : undefined,
    roomId: row?.room_id ? String(row.room_id) : undefined,
    orderId: row?.order_id ? String(row.order_id) : undefined,
    status: row?.status ? String(row.status) : undefined,
    method: row?.method ? String(row.method) : undefined,
    amount: normalizeNumber(row?.amount, 0),
  };
}

function buildChecksum(rows) {
  return sha256(JSON.stringify(rows.map((row) => [row.collectionKey, row.id, row.rowHash, row.appStatePosition])));
}

export async function loadPaymentsFiscalSplitDatabaseSync() {
  if (!DatabaseSyncClass) {
    const sqliteModule = await import("node:sqlite");
    DatabaseSyncClass = sqliteModule.DatabaseSync;
  }
  return DatabaseSyncClass;
}

export function normalizePaymentsFiscalSplitMode(value) {
  return normalizeMode(value);
}

export function createPaymentsFiscalSplitRepository(options = {}) {
  const mode = normalizeMode(options.mode);
  const enabled = mode !== "off";
  const externalized = mode === "externalized";
  const dbPath = path.resolve(String(options.dbPath ?? "app-state-split.sqlite"));
  const nowIso = options.nowIso ?? defaultNowIso;
  const clone = options.cloneJson ?? cloneJson;
  let db = null;

  async function ensure() {
    if (!enabled) return null;
    if (db) return db;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const DatabaseSync = await loadPaymentsFiscalSplitDatabaseSync();
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

      CREATE TABLE IF NOT EXISTS app_state_payment_fiscal_records (
        collection_key TEXT NOT NULL,
        id TEXT NOT NULL,
        payment_id TEXT,
        payment_part_id TEXT,
        payment_transaction_id TEXT,
        receipt_id TEXT,
        table_id TEXT,
        room_id TEXT,
        order_id TEXT,
        order_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT,
        method TEXT,
        amount REAL NOT NULL DEFAULT 0,
        created_at_value TEXT,
        updated_at_value TEXT,
        app_state_position INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        row_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (collection_key, id)
      );

      CREATE INDEX IF NOT EXISTS idx_app_state_payment_fiscal_collection_position
        ON app_state_payment_fiscal_records(collection_key, app_state_position);

      CREATE INDEX IF NOT EXISTS idx_app_state_payment_fiscal_payment
        ON app_state_payment_fiscal_records(payment_id, payment_part_id, payment_transaction_id);

      CREATE INDEX IF NOT EXISTS idx_app_state_payment_fiscal_table
        ON app_state_payment_fiscal_records(table_id, room_id, order_id);

      CREATE INDEX IF NOT EXISTS idx_app_state_payment_fiscal_status
        ON app_state_payment_fiscal_records(collection_key, status, method);

      CREATE INDEX IF NOT EXISTS idx_app_state_payment_fiscal_created
        ON app_state_payment_fiscal_records(collection_key, created_at_value);
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

  function upsertRows(collection, rows) {
    const existingRows = db
      .prepare(
        "SELECT id, row_hash, app_state_position FROM app_state_payment_fiscal_records WHERE collection_key = ?"
      )
      .all(collection.key);
    const existingById = new Map(
      existingRows.map((row) => [
        String(row.id),
        {
          rowHash: String(row.row_hash ?? ""),
          appStatePosition: normalizeInteger(row.app_state_position, -1),
        },
      ])
    );
    const nextIds = new Set(rows.map((row) => row.id));
    const insertOrReplace = db.prepare(`
      INSERT INTO app_state_payment_fiscal_records (
        collection_key,
        id,
        payment_id,
        payment_part_id,
        payment_transaction_id,
        receipt_id,
        table_id,
        room_id,
        order_id,
        order_ids_json,
        status,
        method,
        amount,
        created_at_value,
        updated_at_value,
        app_state_position,
        raw_json,
        row_hash,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(collection_key, id) DO UPDATE SET
        payment_id = excluded.payment_id,
        payment_part_id = excluded.payment_part_id,
        payment_transaction_id = excluded.payment_transaction_id,
        receipt_id = excluded.receipt_id,
        table_id = excluded.table_id,
        room_id = excluded.room_id,
        order_id = excluded.order_id,
        order_ids_json = excluded.order_ids_json,
        status = excluded.status,
        method = excluded.method,
        amount = excluded.amount,
        created_at_value = excluded.created_at_value,
        updated_at_value = excluded.updated_at_value,
        app_state_position = excluded.app_state_position,
        raw_json = excluded.raw_json,
        row_hash = excluded.row_hash,
        updated_at = CURRENT_TIMESTAMP
    `);
    const updatePosition = db.prepare(`
      UPDATE app_state_payment_fiscal_records
      SET app_state_position = ?, updated_at = CURRENT_TIMESTAMP
      WHERE collection_key = ? AND id = ? AND app_state_position <> ?
    `);
    let upserted = 0;
    for (const row of rows) {
      const existing = existingById.get(row.id);
      if (existing && existing.rowHash === row.rowHash) {
        updatePosition.run(row.appStatePosition, row.collectionKey, row.id, row.appStatePosition);
        continue;
      }
      insertOrReplace.run(
        row.collectionKey,
        row.id,
        row.paymentId,
        row.paymentPartId,
        row.paymentTransactionId,
        row.receiptId,
        row.tableId,
        row.roomId,
        row.orderId,
        row.orderIdsJson,
        row.status,
        row.method,
        row.amount,
        row.createdAt,
        row.updatedAt,
        row.appStatePosition,
        row.rawJson,
        row.rowHash
      );
      upserted += 1;
    }

    const deleteRow = db.prepare("DELETE FROM app_state_payment_fiscal_records WHERE collection_key = ? AND id = ?");
    let deleted = 0;
    for (const row of existingRows) {
      const id = String(row.id);
      if (!nextIds.has(id)) {
        deleteRow.run(collection.key, id);
        deleted += 1;
      }
    }
    return { upserted, deleted };
  }

  async function syncFromAppState(appState) {
    if (!enabled) return null;
    await ensure();
    const syncedAt = nowIso();
    const sourceLastWriteAt =
      typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim()
        ? appState.meta.lastWriteAt
        : typeof appState?.integration?.lastWriteAt === "string" && appState.integration.lastWriteAt.trim()
          ? appState.integration.lastWriteAt
          : null;

    return runTransaction(() => {
      const summary = {
        domain: "paymentsFiscal",
        mode,
        rowCount: 0,
        syncedAt,
        collections: {},
        metadataUpdated: {},
      };
      const allRows = [];
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

      for (const collection of PAYMENT_FISCAL_COLLECTIONS) {
        const source = Array.isArray(appState?.[collection.key]) ? appState[collection.key] : [];
        const rows = source
          .map((record, index) => normalizePaymentFiscalRecord(collection, record, index))
          .filter(Boolean);
        const checksum = buildChecksum(rows);
        const result = upsertRows(collection, rows);
        allRows.push(...rows);
        summary.rowCount += rows.length;
        summary.collections[collection.key] = {
          rowCount: rows.length,
          checksum,
          ...result,
        };
        summary.metadataUpdated[collection.domain] = upsertSplitStateIfChanged(
          stateStatement,
          collection.domain,
          rows.length,
          checksum,
          sourceLastWriteAt,
          syncedAt
        );
      }

      const aggregateChecksum = buildChecksum(allRows);
      summary.checksum = aggregateChecksum;
      summary.metadataUpdated.paymentsFiscal = upsertSplitStateIfChanged(
        stateStatement,
        "paymentsFiscal",
        summary.rowCount,
        aggregateChecksum,
        sourceLastWriteAt,
        syncedAt
      );
      return summary;
    });
  }

  async function listPaymentFiscalRecords(collectionKey) {
    if (!enabled) return [];
    await ensure();
    const collection = PAYMENT_FISCAL_COLLECTION_BY_KEY.get(collectionKey);
    if (!collection) return [];
    const rows = db
      .prepare(
        `
          SELECT raw_json, id
          FROM app_state_payment_fiscal_records
          WHERE collection_key = ?
          ORDER BY app_state_position ASC, id ASC
        `
      )
      .all(collection.key);
    return rows.map(rowToRecord).filter((record) => record && typeof record === "object");
  }

  async function listPaymentsFiscalCollections() {
    const result = {};
    for (const collection of PAYMENT_FISCAL_COLLECTIONS) {
      result[collection.key] = await listPaymentFiscalRecords(collection.key);
    }
    return result;
  }

  async function hydrateAppState(appState) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    await ensure();
    const countRow = db.prepare("SELECT COUNT(*) AS count FROM app_state_payment_fiscal_records").get();
    const rowCount = Number(countRow?.count ?? 0);
    if (rowCount <= 0) {
      const hasJsonPayments = PAYMENT_FISCAL_COLLECTIONS.some(
        (collection) => Array.isArray(appState?.[collection.key]) && appState[collection.key].length > 0
      );
      if (hasJsonPayments) {
        await syncFromAppState(appState);
      }
      return appState;
    }

    const hydrated = clone(appState, appState);
    for (const collection of PAYMENT_FISCAL_COLLECTIONS) {
      hydrated[collection.key] = await listPaymentFiscalRecords(collection.key);
    }
    return hydrated;
  }

  function stripPaymentsFiscalFromAppState(appState, options = {}) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    const persisted = clone(appState, appState);
    for (const collection of PAYMENT_FISCAL_COLLECTIONS) {
      persisted[collection.key] = [];
    }
    if (persisted.meta && typeof persisted.meta === "object") {
      persisted.meta.appStateSplitDomains = {
        ...(persisted.meta.appStateSplitDomains && typeof persisted.meta.appStateSplitDomains === "object"
          ? persisted.meta.appStateSplitDomains
          : {}),
        paymentsFiscal: {
          mode: "externalized",
          storage: "sqlite",
          domains: PAYMENT_FISCAL_COLLECTIONS.map((collection) => collection.domain),
          granularity: "payment-fiscal-record",
          ...(options.includeUpdatedAt ? { updatedAt: nowIso() } : {}),
        },
      };
    }
    return persisted;
  }

  async function prepareAppStateForPrimaryWrite(appState) {
    return stripPaymentsFiscalFromAppState(appState, { includeUpdatedAt: true });
  }

  async function prepareAppStateForPersistenceComparison(appState) {
    return stripPaymentsFiscalFromAppState(appState, { includeUpdatedAt: false });
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
    hydrateAppState,
    listPaymentFiscalRecords,
    listPaymentsFiscalCollections,
    mode,
    prepareAppStateForPersistenceComparison,
    prepareAppStateForPrimaryWrite,
    syncFromAppState,
  };
}
