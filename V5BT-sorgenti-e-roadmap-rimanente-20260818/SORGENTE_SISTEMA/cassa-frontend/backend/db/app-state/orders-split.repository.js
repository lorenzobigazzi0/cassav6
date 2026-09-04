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
      `BACKEND_APP_STATE_SPLIT_ORDERS non valido: '${mode}'. Valori ammessi: off, shadow, externalized.`
    );
  }
  return mode;
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
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

function normalizeOrder(order, position) {
  if (!order || typeof order !== "object") return null;
  const id = normalizeNullableString(order.id ?? order.orderId);
  if (!id) return null;
  const rawJson = safeJsonStringify(order, {});
  const items = Array.isArray(order.items) ? order.items : [];
  const tickets = Array.isArray(order.tickets) ? order.tickets : [];
  const lineRoutes = Array.isArray(order.lineRoutes) ? order.lineRoutes : [];
  return {
    id,
    tableId: normalizeNullableString(order.tableId),
    roomId: normalizeNullableString(order.roomId),
    tableNumber: normalizeNullableString(order.tableNumber ?? order.table),
    tableLabel: normalizeNullableString(order.tableLabel ?? order.logicalTableLabel ?? order.title),
    logicalTableLabel: normalizeNullableString(order.logicalTableLabel),
    workflowStatus: normalizeNullableString(order.workflowStatus ?? order.status),
    paymentStatus: normalizeNullableString(order.paymentStatus),
    station: normalizeNullableString(order.station ?? order.assignedStationId),
    waiter: normalizeNullableString(order.waiter ?? order.createdByUsername),
    total: normalizeNumber(order.total, 0),
    paidAmount: normalizeNumber(order.paidAmount, 0),
    dueAmount: normalizeNumber(order.dueAmount, 0),
    revision: order.revision === null || order.revision === undefined ? null : normalizeInteger(order.revision, 0),
    currentRevision:
      order.currentRevision === null || order.currentRevision === undefined
        ? null
        : normalizeInteger(order.currentRevision, 0),
    receivedAtMs:
      order.receivedAtMs === null || order.receivedAtMs === undefined ? null : normalizeInteger(order.receivedAtMs, 0),
    createdAt: normalizeNullableString(order.createdAt),
    updatedAt: normalizeNullableString(order.updatedAt),
    readyAtMs: order.readyAtMs === null || order.readyAtMs === undefined ? null : normalizeInteger(order.readyAtMs, 0),
    completedAtMs:
      order.completedAtMs === null || order.completedAtMs === undefined
        ? null
        : normalizeInteger(order.completedAtMs, 0),
    itemCount: items.length,
    ticketCount: tickets.length,
    lineRouteCount: lineRoutes.length,
    appStatePosition: position,
    rawJson,
    rowHash: sha256(rawJson),
  };
}

function rowToIntegrationOrder(row) {
  const parsed = safeJsonParse(row?.raw_json, null);
  if (parsed && typeof parsed === "object") return parsed;
  return {
    id: String(row?.id ?? ""),
    tableId: row?.table_id ? String(row.table_id) : undefined,
    roomId: row?.room_id ? String(row.room_id) : undefined,
    tableNumber: row?.table_number ? String(row.table_number) : undefined,
    tableLabel: row?.table_label ? String(row.table_label) : undefined,
    logicalTableLabel: row?.logical_table_label ? String(row.logical_table_label) : undefined,
    workflowStatus: row?.workflow_status ? String(row.workflow_status) : undefined,
    paymentStatus: row?.payment_status ? String(row.payment_status) : undefined,
    station: row?.station ? String(row.station) : undefined,
    waiter: row?.waiter ? String(row.waiter) : undefined,
    total: normalizeNumber(row?.total, 0),
    paidAmount: normalizeNumber(row?.paid_amount, 0),
    dueAmount: normalizeNumber(row?.due_amount, 0),
    revision: row?.revision === null || row?.revision === undefined ? undefined : normalizeInteger(row.revision, 0),
    currentRevision:
      row?.current_revision === null || row?.current_revision === undefined
        ? undefined
        : normalizeInteger(row.current_revision, 0),
    receivedAtMs:
      row?.received_at_ms === null || row?.received_at_ms === undefined
        ? undefined
        : normalizeInteger(row.received_at_ms, 0),
    createdAt: row?.created_at_value ? String(row.created_at_value) : undefined,
    updatedAt: row?.updated_at_value ? String(row.updated_at_value) : undefined,
    items: [],
    tickets: [],
    lineRoutes: [],
  };
}

function buildChecksum(rows) {
  return sha256(JSON.stringify(rows.map((row) => [row.id, row.rowHash, row.appStatePosition])));
}

export async function loadOrdersSplitDatabaseSync() {
  if (!DatabaseSyncClass) {
    const sqliteModule = await import("node:sqlite");
    DatabaseSyncClass = sqliteModule.DatabaseSync;
  }
  return DatabaseSyncClass;
}

export function normalizeOrdersSplitMode(value) {
  return normalizeMode(value);
}

export function createOrdersSplitRepository(options = {}) {
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
    const DatabaseSync = await loadOrdersSplitDatabaseSync();
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

      CREATE TABLE IF NOT EXISTS app_state_integration_orders (
        id TEXT PRIMARY KEY,
        table_id TEXT,
        room_id TEXT,
        table_number TEXT,
        table_label TEXT,
        logical_table_label TEXT,
        workflow_status TEXT,
        payment_status TEXT,
        station TEXT,
        waiter TEXT,
        total REAL NOT NULL DEFAULT 0,
        paid_amount REAL NOT NULL DEFAULT 0,
        due_amount REAL NOT NULL DEFAULT 0,
        revision INTEGER,
        current_revision INTEGER,
        received_at_ms INTEGER,
        created_at_value TEXT,
        updated_at_value TEXT,
        ready_at_ms INTEGER,
        completed_at_ms INTEGER,
        item_count INTEGER NOT NULL DEFAULT 0,
        ticket_count INTEGER NOT NULL DEFAULT 0,
        line_route_count INTEGER NOT NULL DEFAULT 0,
        app_state_position INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        row_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_state_integration_orders_table
        ON app_state_integration_orders(table_id, room_id, workflow_status);

      CREATE INDEX IF NOT EXISTS idx_app_state_integration_orders_status
        ON app_state_integration_orders(workflow_status, payment_status);

      CREATE INDEX IF NOT EXISTS idx_app_state_integration_orders_position
        ON app_state_integration_orders(app_state_position);

      CREATE INDEX IF NOT EXISTS idx_app_state_integration_orders_updated
        ON app_state_integration_orders(updated_at_value, received_at_ms);
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

  function upsertOrders(rows) {
    const existingRows = db
      .prepare("SELECT id, row_hash, app_state_position FROM app_state_integration_orders")
      .all();
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
      INSERT INTO app_state_integration_orders (
        id,
        table_id,
        room_id,
        table_number,
        table_label,
        logical_table_label,
        workflow_status,
        payment_status,
        station,
        waiter,
        total,
        paid_amount,
        due_amount,
        revision,
        current_revision,
        received_at_ms,
        created_at_value,
        updated_at_value,
        ready_at_ms,
        completed_at_ms,
        item_count,
        ticket_count,
        line_route_count,
        app_state_position,
        raw_json,
        row_hash,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        table_id = excluded.table_id,
        room_id = excluded.room_id,
        table_number = excluded.table_number,
        table_label = excluded.table_label,
        logical_table_label = excluded.logical_table_label,
        workflow_status = excluded.workflow_status,
        payment_status = excluded.payment_status,
        station = excluded.station,
        waiter = excluded.waiter,
        total = excluded.total,
        paid_amount = excluded.paid_amount,
        due_amount = excluded.due_amount,
        revision = excluded.revision,
        current_revision = excluded.current_revision,
        received_at_ms = excluded.received_at_ms,
        created_at_value = excluded.created_at_value,
        updated_at_value = excluded.updated_at_value,
        ready_at_ms = excluded.ready_at_ms,
        completed_at_ms = excluded.completed_at_ms,
        item_count = excluded.item_count,
        ticket_count = excluded.ticket_count,
        line_route_count = excluded.line_route_count,
        app_state_position = excluded.app_state_position,
        raw_json = excluded.raw_json,
        row_hash = excluded.row_hash,
        updated_at = CURRENT_TIMESTAMP
    `);
    const updatePosition = db.prepare(`
      UPDATE app_state_integration_orders
      SET app_state_position = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND app_state_position <> ?
    `);
    let upserted = 0;
    for (const row of rows) {
      const existing = existingById.get(row.id);
      if (existing && existing.rowHash === row.rowHash) {
        updatePosition.run(row.appStatePosition, row.id, row.appStatePosition);
        continue;
      }
      insertOrReplace.run(
        row.id,
        row.tableId,
        row.roomId,
        row.tableNumber,
        row.tableLabel,
        row.logicalTableLabel,
        row.workflowStatus,
        row.paymentStatus,
        row.station,
        row.waiter,
        row.total,
        row.paidAmount,
        row.dueAmount,
        row.revision,
        row.currentRevision,
        row.receivedAtMs,
        row.createdAt,
        row.updatedAt,
        row.readyAtMs,
        row.completedAtMs,
        row.itemCount,
        row.ticketCount,
        row.lineRouteCount,
        row.appStatePosition,
        row.rawJson,
        row.rowHash
      );
      upserted += 1;
    }

    const deleteRow = db.prepare("DELETE FROM app_state_integration_orders WHERE id = ?");
    let deleted = 0;
    for (const row of existingRows) {
      const id = String(row.id);
      if (!nextIds.has(id)) {
        deleteRow.run(id);
        deleted += 1;
      }
    }
    return { upserted, deleted };
  }

  function upsertOrderRows(rows) {
    const existingRows = db
      .prepare("SELECT id, row_hash, app_state_position FROM app_state_integration_orders")
      .all();
    const existingById = new Map(
      existingRows.map((row) => [
        String(row.id),
        {
          rowHash: String(row.row_hash ?? ""),
          appStatePosition: normalizeInteger(row.app_state_position, -1),
        },
      ])
    );
    const insertOrReplace = db.prepare(`
      INSERT INTO app_state_integration_orders (
        id,
        table_id,
        room_id,
        table_number,
        table_label,
        logical_table_label,
        workflow_status,
        payment_status,
        station,
        waiter,
        total,
        paid_amount,
        due_amount,
        revision,
        current_revision,
        received_at_ms,
        created_at_value,
        updated_at_value,
        ready_at_ms,
        completed_at_ms,
        item_count,
        ticket_count,
        line_route_count,
        app_state_position,
        raw_json,
        row_hash,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        table_id = excluded.table_id,
        room_id = excluded.room_id,
        table_number = excluded.table_number,
        table_label = excluded.table_label,
        logical_table_label = excluded.logical_table_label,
        workflow_status = excluded.workflow_status,
        payment_status = excluded.payment_status,
        station = excluded.station,
        waiter = excluded.waiter,
        total = excluded.total,
        paid_amount = excluded.paid_amount,
        due_amount = excluded.due_amount,
        revision = excluded.revision,
        current_revision = excluded.current_revision,
        received_at_ms = excluded.received_at_ms,
        created_at_value = excluded.created_at_value,
        updated_at_value = excluded.updated_at_value,
        ready_at_ms = excluded.ready_at_ms,
        completed_at_ms = excluded.completed_at_ms,
        item_count = excluded.item_count,
        ticket_count = excluded.ticket_count,
        line_route_count = excluded.line_route_count,
        app_state_position = excluded.app_state_position,
        raw_json = excluded.raw_json,
        row_hash = excluded.row_hash,
        updated_at = CURRENT_TIMESTAMP
    `);
    const updatePosition = db.prepare(`
      UPDATE app_state_integration_orders
      SET app_state_position = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND app_state_position <> ?
    `);
    let upserted = 0;
    for (const row of rows) {
      const existing = existingById.get(row.id);
      if (existing && existing.rowHash === row.rowHash) {
        updatePosition.run(row.appStatePosition, row.id, row.appStatePosition);
        continue;
      }
      insertOrReplace.run(
        row.id,
        row.tableId,
        row.roomId,
        row.tableNumber,
        row.tableLabel,
        row.logicalTableLabel,
        row.workflowStatus,
        row.paymentStatus,
        row.station,
        row.waiter,
        row.total,
        row.paidAmount,
        row.dueAmount,
        row.revision,
        row.currentRevision,
        row.receivedAtMs,
        row.createdAt,
        row.updatedAt,
        row.readyAtMs,
        row.completedAtMs,
        row.itemCount,
        row.ticketCount,
        row.lineRouteCount,
        row.appStatePosition,
        row.rawJson,
        row.rowHash
      );
      upserted += 1;
    }
    return { upserted };
  }

  async function syncFromAppState(appState) {
    if (!enabled) return null;
    await ensure();
    const orders = Array.isArray(appState?.integration?.orders) ? appState.integration.orders : [];
    const rows = orders.map((order, index) => normalizeOrder(order, index)).filter(Boolean);
    const checksum = buildChecksum(rows);
    const syncedAt = nowIso();
    const sourceLastWriteAt =
      typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim()
        ? appState.meta.lastWriteAt
        : typeof appState?.integration?.lastWriteAt === "string" && appState.integration.lastWriteAt.trim()
          ? appState.integration.lastWriteAt
          : null;

    return runTransaction(() => {
      const result = upsertOrders(rows);
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
        "integration.orders",
        rows.length,
        checksum,
        sourceLastWriteAt,
        syncedAt
      );

      return {
        domain: "integration.orders",
        mode,
        rowCount: rows.length,
        metadataUpdated,
        checksum,
        syncedAt,
        ...result,
      };
    });
  }

  async function upsertIntegrationOrdersFromAppState(appState, orderIds = []) {
    if (!enabled) return null;
    await ensure();
    const requestedIds = new Set(
      (Array.isArray(orderIds) ? orderIds : [orderIds])
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
    );
    const orders = Array.isArray(appState?.integration?.orders) ? appState.integration.orders : [];
    const rows = orders
      .map((order, index) => normalizeOrder(order, index))
      .filter((row) => row && (requestedIds.size === 0 || requestedIds.has(row.id)));
    if (rows.length === 0) return null;

    const syncedAt = nowIso();
    const sourceLastWriteAt =
      typeof appState?.meta?.lastWriteAt === "string" && appState.meta.lastWriteAt.trim()
        ? appState.meta.lastWriteAt
        : typeof appState?.integration?.lastWriteAt === "string" && appState.integration.lastWriteAt.trim()
          ? appState.integration.lastWriteAt
          : null;

    return runTransaction(() => {
      const result = upsertOrderRows(rows);
      const countRow = db.prepare("SELECT COUNT(*) AS count FROM app_state_integration_orders").get();
      const rowCount = Number(countRow?.count ?? 0);
      db.prepare(
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
      ).run("integration.orders", mode, rowCount, null, sourceLastWriteAt, syncedAt);

      return {
        domain: "integration.orders",
        mode,
        rowCount,
        orderCount: rows.length,
        syncedAt,
        ...result,
      };
    });
  }

  async function listIntegrationOrders() {
    if (!enabled) return [];
    await ensure();
    const rows = db
      .prepare(
        `
          SELECT id, raw_json
          FROM app_state_integration_orders
          ORDER BY app_state_position ASC, id ASC
        `
      )
      .all();
    return rows.map(rowToIntegrationOrder).filter((order) => order && typeof order === "object" && order.id);
  }

  async function hydrateAppState(appState) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    await ensure();
    const countRow = db.prepare("SELECT COUNT(*) AS count FROM app_state_integration_orders").get();
    const rowCount = Number(countRow?.count ?? 0);
    if (rowCount <= 0) {
      const hasJsonOrders = Array.isArray(appState.integration?.orders) && appState.integration.orders.length > 0;
      if (hasJsonOrders) {
        await syncFromAppState(appState);
      }
      return appState;
    }

    const hydrated = clone(appState, appState);
    if (!hydrated.integration || typeof hydrated.integration !== "object") {
      hydrated.integration = {};
    }
    hydrated.integration.orders = await listIntegrationOrders();
    return hydrated;
  }

  function stripIntegrationOrdersFromAppState(appState, options = {}) {
    if (!externalized || !appState || typeof appState !== "object") return appState;
    const persisted = clone(appState, appState);
    if (!persisted.integration || typeof persisted.integration !== "object") {
      persisted.integration = {};
    }
    persisted.integration.orders = [];
    if (persisted.meta && typeof persisted.meta === "object") {
      persisted.meta.appStateSplitDomains = {
        ...(persisted.meta.appStateSplitDomains && typeof persisted.meta.appStateSplitDomains === "object"
          ? persisted.meta.appStateSplitDomains
          : {}),
        orders: {
          mode: "externalized",
          storage: "sqlite",
          domains: ["integration.orders"],
          granularity: "order",
          ...(options.includeUpdatedAt ? { updatedAt: nowIso() } : {}),
        },
      };
    }
    return persisted;
  }

  async function prepareAppStateForPrimaryWrite(appState) {
    return stripIntegrationOrdersFromAppState(appState, { includeUpdatedAt: true });
  }

  async function prepareAppStateForPersistenceComparison(appState) {
    return stripIntegrationOrdersFromAppState(appState, { includeUpdatedAt: false });
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
    listIntegrationOrders,
    mode,
    prepareAppStateForPersistenceComparison,
    prepareAppStateForPrimaryWrite,
    syncFromAppState,
    upsertIntegrationOrdersFromAppState,
  };
}
