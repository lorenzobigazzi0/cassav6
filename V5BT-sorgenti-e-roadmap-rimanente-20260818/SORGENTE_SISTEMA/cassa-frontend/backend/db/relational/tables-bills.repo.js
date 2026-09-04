import { runRelationalTransaction } from "./connection.js";

function safeJsonParse(value, fallback = null) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJson(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function optionalString(value) {
  const normalized = asTrimmedString(value);
  return normalized || null;
}

function firstString(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstString(...value);
      if (nested) return nested;
      continue;
    }
    const normalized = optionalString(value);
    if (normalized) return normalized;
  }
  return null;
}

function arrayFrom(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object") : [];
}

function centsFromMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.round(numeric * 100));
}

function centsFromCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.trunc(numeric));
}

function firstCents({ cents = [], money = [] } = {}) {
  for (const value of cents) {
    const parsed = centsFromCents(value);
    if (parsed !== null) return parsed;
  }
  for (const value of money) {
    const parsed = centsFromMoney(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function normalizeIntegerOrNull(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.trunc(numeric);
}

function positiveInteger(value, fallback = 1) {
  const parsed = normalizeIntegerOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : fallback;
}

function positiveIntegerOrNull(value) {
  const parsed = normalizeIntegerOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function isoFromMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return new Date().toISOString();
  return new Date(Math.trunc(numeric)).toISOString();
}

function msFromIso(value) {
  const parsed = Date.parse(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function sameLockOwner(lock, input) {
  if (!lock || !input) return false;
  const userId = optionalString(input.userId);
  const sessionId = optionalString(input.sessionId);
  const deviceUuid = optionalString(input.deviceUuid);
  if (lock.userId !== userId) return false;
  if (lock.sessionId && sessionId && lock.sessionId === sessionId) return true;
  if (lock.deviceUuid && deviceUuid && lock.deviceUuid === deviceUuid) return true;
  return !lock.sessionId && !lock.deviceUuid;
}

function slugifyId(value, fallback = "sala") {
  const normalized = asTrimmedString(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function roomIdFromTable(table) {
  return (
    optionalString(table?.roomId ?? table?.room_id ?? table?.areaId ?? table?.area_id) ??
    (optionalString(table?.type) ? `room_${slugifyId(table.type)}` : null)
  );
}

function normalizeStatus(value, fallback = "free") {
  const normalized = asTrimmedString(value).toLowerCase();
  return normalized || fallback;
}

function billLinesTotalCents(bill) {
  return arrayFrom(bill?.lines).reduce((sum, line) => {
    const lineTotal =
      firstCents({
        cents: [line.lineTotalCents, line.totalCents],
        money: [line.lineTotal, line.total],
      }) ??
      (firstCents({
        cents: [line.unitPriceCents],
        money: [line.unitPrice, line.price],
      }) ?? 0) * Math.max(0, Math.trunc(Number(line.qty ?? line.quantity) || 0));
    return sum + lineTotal;
  }, 0);
}

function totalCentsFromBill(bill) {
  return (
    firstCents({
      cents: [bill?.totalCents, bill?.subtotalCents, bill?.amountCents],
      money: [bill?.total, bill?.subtotal, bill?.amount],
    }) ??
    billLinesTotalCents(bill)
  );
}

function paidCentsFromBill(bill) {
  return (
    firstCents({
      cents: [bill?.paidCents, bill?.paid_amount_cents, bill?.totalPaidCents],
      money: [bill?.paidAmount, bill?.paid, bill?.totalPaid],
    }) ?? 0
  );
}

function dueCentsFromBill(bill, totalCents, paidCents) {
  return (
    firstCents({
      cents: [bill?.dueCents, bill?.due_amount_cents, bill?.remainingCents],
      money: [bill?.dueAmount, bill?.due, bill?.remainingAmount],
    }) ?? Math.max(0, totalCents - paidCents)
  );
}

function billStatus(bill, dueCents, paidCents) {
  const explicit = normalizeStatus(bill?.status ?? bill?.paymentStatus, "");
  if (explicit) return explicit;
  if (dueCents <= 0 && paidCents > 0) return "paid";
  if (paidCents > 0) return "partial";
  return "open";
}

function totalPaidCentsFromTable(table) {
  const explicit = firstCents({
    cents: [table?.totalPaidCents, table?.paidCents],
    money: [table?.totalPaid, table?.paidAmount, table?.amountPaid],
  });
  if (explicit !== null) return explicit;
  return arrayFrom(table?.pendingBills).reduce((sum, bill) => sum + paidCentsFromBill(bill), 0);
}

export function mapTableStateToRelationalRow(table, index = 0) {
  if (!table || typeof table !== "object") return null;
  const tableId = optionalString(table.id ?? table.tableId) ?? `table_${index + 1}`;
  if (!tableId) return null;
  return {
    tableId,
    roomId: roomIdFromTable(table),
    status: normalizeStatus(table.status, Number(table.totalDue) > 0 ? "payment_due" : "free"),
    covers: normalizeIntegerOrNull(table.covers),
    customerName: firstString(table.customerName, table.guestName, table.tableName),
    notes: firstString(table.notes, table.note, table.manualIntolerance),
    totalDueCents:
      firstCents({
        cents: [table.totalDueCents, table.dueCents],
        money: [table.totalDue, table.amountDue, table.dueAmount],
      }) ?? 0,
    totalPaidCents: totalPaidCentsFromTable(table),
    updatedAt: firstString(table.updatedAt, table.lastUpdatedAt, table.seatedAt),
    revision: positiveInteger(table.revision ?? table.currentRevision, 1),
    lastEventId: positiveIntegerOrNull(table.lastEventId ?? table.last_event_id ?? table.aggregateLastEventId),
    rawJson: stringifyJson(table, {}),
  };
}

export function mapTableBillToRelationalRow(table, bill, index = 0) {
  if (!table || !bill || typeof bill !== "object") return null;
  const tableId = optionalString(table.id ?? table.tableId);
  if (!tableId) return null;
  const totalCents = totalCentsFromBill(bill);
  if (totalCents <= 0) return null;
  const paidCents = paidCentsFromBill(bill);
  const dueCents = dueCentsFromBill(bill, totalCents, paidCents);
  return {
    id: optionalString(bill.id ?? bill.billId) ?? `${tableId}_bill_${index + 1}`,
    tableId,
    status: billStatus(bill, dueCents, paidCents),
    totalCents,
    paidCents,
    dueCents,
    createdAt: firstString(bill.createdAt, bill.openedAt),
    updatedAt: firstString(bill.updatedAt, bill.closedAt, bill.paidAt),
    rawJson: stringifyJson(bill, {}),
  };
}

export function mapTableLockToRelationalRow(table) {
  if (!table || typeof table !== "object") return null;
  const lock = table.workLock && typeof table.workLock === "object" ? table.workLock : null;
  if (!lock) return null;
  const tableId = optionalString(lock.tableId ?? table.id ?? table.tableId);
  if (!tableId) return null;
  return {
    tableId,
    userId: optionalString(lock.userId),
    deviceUuid: optionalString(lock.deviceUuid),
    acquiredAt: firstString(lock.acquiredAt, lock.createdAt),
    heartbeatAt: firstString(lock.heartbeatAt, lock.updatedAt, lock.acquiredAt),
    expiresAt: firstString(lock.expiresAt),
    revision: positiveInteger(lock.revision, 1),
    rawJson: stringifyJson({ ...lock, tableId }, {}),
  };
}

export function buildTablesBillsRelationalRows(appState) {
  const tables = arrayFrom(appState?.posSettings?.tables);
  const tableStates = [];
  const bills = [];
  const locks = [];

  tables.forEach((table, index) => {
    const stateRow = mapTableStateToRelationalRow(table, index);
    if (!stateRow) return;
    tableStates.push(stateRow);
    arrayFrom(table.pendingBills)
      .map((bill, billIndex) => mapTableBillToRelationalRow(table, bill, billIndex))
      .filter((row) => row !== null)
      .forEach((row) => bills.push(row));
    const lockRow = mapTableLockToRelationalRow(table);
    if (lockRow) locks.push(lockRow);
  });

  return { tableStates, bills, locks };
}

export class TablesBillsRelationalRepository {
  constructor(db) {
    this.db = db;
  }

  listTableStates(filters = {}) {
    const clauses = [];
    const params = [];
    this.#appendFilter(clauses, params, "room_id", filters.roomId);
    this.#appendFilter(clauses, params, "status", filters.status);
    if (filters.withDueOnly === true) clauses.push("total_due_cents > 0");
    if (filters.withLocksOnly === true) clauses.push("table_id IN (SELECT table_id FROM table_locks)");
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM table_states${where} ORDER BY room_id ASC, table_id ASC`)
      .all(...params)
      .map((row) => this.#hydrateTableState(row));
  }

  getTableState(tableId) {
    const row = this.db.prepare("SELECT * FROM table_states WHERE table_id = ?").get(asTrimmedString(tableId));
    return row ? this.#hydrateTableState(row) : null;
  }

  listBillsByTable(tableId) {
    return this.db
      .prepare("SELECT * FROM table_bills WHERE table_id = ? ORDER BY created_at ASC, id ASC")
      .all(asTrimmedString(tableId))
      .map((row) => this.#hydrateBill(row));
  }

  getBillById(billId) {
    const row = this.db.prepare("SELECT * FROM table_bills WHERE id = ?").get(asTrimmedString(billId));
    return row ? this.#hydrateBill(row) : null;
  }

  verifyDueInvariant(tableIds = []) {
    const ids = [
      ...new Set(
        (Array.isArray(tableIds) ? tableIds : [tableIds])
          .map((entry) => asTrimmedString(entry))
          .filter(Boolean),
      ),
    ];
    const summaries = [];
    for (const tableId of ids) {
      const table = this.db
        .prepare("SELECT table_id, total_due_cents FROM table_states WHERE table_id = ?")
        .get(tableId);
      if (!table) {
        return { ok: false, reason: "missing_table", tableId, summaries };
      }
      const row = this.db
        .prepare("SELECT COALESCE(SUM(due_cents), 0) AS due_cents FROM table_bills WHERE table_id = ?")
        .get(tableId);
      const tableDueCents = Math.max(0, Math.trunc(Number(table.total_due_cents) || 0));
      const billsDueCents = Math.max(0, Math.trunc(Number(row?.due_cents) || 0));
      const summary = { tableId, tableDueCents, billsDueCents };
      summaries.push(summary);
      if (tableDueCents !== billsDueCents) {
        return { ok: false, reason: "due_mismatch", tableId, summary, summaries };
      }
    }
    return { ok: true, summaries };
  }

  getTableLock(tableId) {
    const row = this.db.prepare("SELECT * FROM table_locks WHERE table_id = ?").get(asTrimmedString(tableId));
    return row ? this.#hydrateLock(row) : null;
  }

  acquireTableLock(input = {}) {
    const tableId = optionalString(input.tableId);
    const userId = optionalString(input.userId);
    const deviceUuid = optionalString(input.deviceUuid);
    const sessionId = optionalString(input.sessionId);
    const purpose = optionalString(input.purpose) ?? "table_mutation";
    const username = optionalString(input.username) ?? userId;
    const nowMs = Number.isFinite(Number(input.nowMs)) ? Math.trunc(Number(input.nowMs)) : Date.now();
    const expiresAtMs = Number.isFinite(Number(input.expiresAtMs)) ? Math.trunc(Number(input.expiresAtMs)) : nowMs;
    const heartbeatMinIntervalMs = Math.max(0, Math.trunc(Number(input.heartbeatMinIntervalMs) || 0));
    const forceHeartbeat = input.forceHeartbeat === true;
    if (!tableId || !userId || expiresAtMs <= nowMs) {
      return { ok: false, reason: "invalid" };
    }
    return runRelationalTransaction(this.db, () => {
      const table = this.db.prepare("SELECT table_id FROM table_states WHERE table_id = ?").get(tableId);
      if (!table) return { ok: false, reason: "missing" };
      const currentRow = this.db.prepare("SELECT * FROM table_locks WHERE table_id = ?").get(tableId);
      const current = currentRow ? this.#hydrateLock(currentRow) : null;
      const active = current && msFromIso(current.expiresAt) > nowMs;
      if (active && !sameLockOwner(current, { userId, sessionId, deviceUuid })) {
        return { ok: false, reason: "conflict", lock: current };
      }
      if (
        active &&
        !forceHeartbeat &&
        String(current.purpose ?? "").trim() === purpose &&
        nowMs - msFromIso(current.heartbeatAt || current.acquiredAt) < heartbeatMinIntervalMs
      ) {
        return { ok: true, changed: false, lock: current };
      }
      const acquiredAt = active ? current.acquiredAt : isoFromMs(nowMs);
      const heartbeatAt = isoFromMs(nowMs);
      const expiresAt = isoFromMs(expiresAtMs);
      const revision = positiveInteger(current?.revision, 0) + 1;
      const lock = {
        tableId,
        userId,
        username,
        deviceUuid: deviceUuid ?? "",
        sessionId: sessionId ?? "",
        purpose,
        acquiredAt,
        heartbeatAt,
        expiresAt,
        revision,
      };
      const rawJson = stringifyJson(lock, {});
      this.db
        .prepare(
          `
            INSERT INTO table_locks (
              table_id, user_id, device_uuid, acquired_at, heartbeat_at,
              expires_at, raw_json, revision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(table_id) DO UPDATE SET
              user_id = excluded.user_id,
              device_uuid = excluded.device_uuid,
              acquired_at = excluded.acquired_at,
              heartbeat_at = excluded.heartbeat_at,
              expires_at = excluded.expires_at,
              raw_json = excluded.raw_json,
              revision = table_locks.revision + 1
          `
        )
        .run(tableId, userId, deviceUuid ?? "", acquiredAt, heartbeatAt, expiresAt, rawJson, revision);
      return { ok: true, changed: true, lock: this.getTableLock(tableId), previousLock: active ? current : null };
    });
  }

  releaseTableLock(input = {}) {
    const tableId = optionalString(input.tableId);
    const userId = optionalString(input.userId);
    const deviceUuid = optionalString(input.deviceUuid);
    const sessionId = optionalString(input.sessionId);
    const force = input.force === true;
    if (!tableId || (!force && !userId)) return { ok: false, reason: "invalid" };
    return runRelationalTransaction(this.db, () => {
      const currentRow = this.db.prepare("SELECT * FROM table_locks WHERE table_id = ?").get(tableId);
      const current = currentRow ? this.#hydrateLock(currentRow) : null;
      if (!current) return { ok: true, released: false, previousLock: null };
      if (!force && !sameLockOwner(current, { userId, sessionId, deviceUuid })) {
        return { ok: false, reason: "forbidden", lock: current };
      }
      this.db.prepare("DELETE FROM table_locks WHERE table_id = ?").run(tableId);
      return { ok: true, released: true, previousLock: current };
    });
  }

  replaceAllFromAppState(appState, options = {}) {
    const rows = buildTablesBillsRelationalRows(appState);
    const operation = () => {
      this.#preserveTableLastEventIds(rows.tableStates);
      this.#deleteAll();
      for (const row of rows.tableStates) this.#insertTableState(row);
      for (const row of rows.bills) this.#insertBill(row);
      for (const row of rows.locks) this.#insertLock(row);
      return rows;
    };
    if (options.transaction === false) {
      return operation();
    }
    return runRelationalTransaction(this.db, operation);
  }

  replaceTablesFromAppState(appState, tableIds = [], options = {}) {
    const ids = new Set((Array.isArray(tableIds) ? tableIds : [tableIds]).map((entry) => optionalString(entry)).filter(Boolean));
    if (ids.size === 0) return { ok: false, reason: "invalid", rows: { tableStates: [], bills: [], locks: [] } };
    const allRows = buildTablesBillsRelationalRows(appState);
    const rows = {
      tableStates: allRows.tableStates.filter((row) => ids.has(row.tableId)),
      bills: allRows.bills.filter((row) => ids.has(row.tableId)),
      locks: allRows.locks.filter((row) => ids.has(row.tableId)),
    };
    const enforceRevision = options.enforceRevision === true;
    const operation = () => {
      this.#preserveTableLastEventIds(rows.tableStates);
      if (enforceRevision) {
        const conflicts = rows.tableStates.filter((row) => {
          const current = this.db.prepare("SELECT revision FROM table_states WHERE table_id = ?").get(row.tableId);
          return current && positiveInteger(current.revision, 1) !== Math.max(positiveInteger(row.revision, 1) - 1, 1);
        });
        if (conflicts.length > 0) return { ok: false, reason: "revision_conflict", conflicts };
      }
      for (const tableId of ids) {
        this.db.prepare("DELETE FROM table_bills WHERE table_id = ?").run(tableId);
        this.db.prepare("DELETE FROM table_locks WHERE table_id = ?").run(tableId);
        this.db.prepare("DELETE FROM table_states WHERE table_id = ?").run(tableId);
      }
      for (const row of rows.tableStates) this.#insertTableState(row);
      for (const row of rows.bills) this.#insertBill(row);
      for (const row of rows.locks) this.#insertLock(row);
      return { ok: true, rows };
    };
    if (options.transaction === false) return operation();
    return runRelationalTransaction(this.db, operation);
  }

  #appendFilter(clauses, params, columnName, value) {
    const normalized = optionalString(value);
    if (!normalized) return;
    clauses.push(`${columnName} = ?`);
    params.push(normalized);
  }

  #deleteAll() {
    this.db.prepare("DELETE FROM table_bills").run();
    this.db.prepare("DELETE FROM table_locks").run();
    this.db.prepare("DELETE FROM table_states").run();
  }

  #preserveTableLastEventIds(rows = []) {
    const existing = new Map(
      this.db
        .prepare("SELECT table_id, last_event_id FROM table_states WHERE last_event_id IS NOT NULL")
        .all()
        .map((row) => [row.table_id, positiveIntegerOrNull(row.last_event_id)])
    );
    for (const row of rows) {
      if (!row || row.lastEventId !== null && row.lastEventId !== undefined) continue;
      row.lastEventId = existing.get(row.tableId) ?? null;
    }
  }

  #insertTableState(row) {
    this.db
      .prepare(
        `
          INSERT INTO table_states (
            table_id,
            room_id,
            status,
            covers,
            customer_name,
            notes,
            total_due_cents,
            total_paid_cents,
            updated_at,
            revision,
            last_event_id,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        row.tableId,
        row.roomId,
        row.status,
        row.covers,
        row.customerName,
        row.notes,
        row.totalDueCents,
        row.totalPaidCents,
        row.updatedAt,
        row.revision,
        row.lastEventId,
        row.rawJson
      );
  }

  #insertBill(row) {
    this.db
      .prepare(
        `
          INSERT INTO table_bills (
            id,
            table_id,
            status,
            total_cents,
            paid_cents,
            due_cents,
            created_at,
            updated_at,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        row.id,
        row.tableId,
        row.status,
        row.totalCents,
        row.paidCents,
        row.dueCents,
        row.createdAt,
        row.updatedAt,
        row.rawJson
      );
  }

  #insertLock(row) {
    this.db
      .prepare(
        `
          INSERT INTO table_locks (
            table_id,
            user_id,
            device_uuid,
            acquired_at,
            heartbeat_at,
            expires_at,
            raw_json,
            revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(row.tableId, row.userId, row.deviceUuid, row.acquiredAt, row.heartbeatAt, row.expiresAt, row.rawJson, row.revision);
  }

  #hydrateTableState(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      tableId: row.table_id,
      id: row.table_id,
      roomId: row.room_id,
      status: row.status,
      covers: row.covers,
      customerName: row.customer_name,
      notes: row.notes,
      totalDueCents: row.total_due_cents,
      totalPaidCents: row.total_paid_cents,
      updatedAt: row.updated_at,
      revision: row.revision,
      currentRevision: positiveInteger(raw?.currentRevision ?? raw?.revision ?? row.revision, positiveInteger(row.revision, 1)),
      aggregateVersion: positiveInteger(row.revision, 1),
      lastEventId: positiveIntegerOrNull(row.last_event_id ?? raw?.lastEventId ?? raw?.last_event_id ?? raw?.aggregateLastEventId),
    };
  }

  #hydrateBill(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      tableId: row.table_id,
      status: row.status,
      totalCents: row.total_cents,
      paidCents: row.paid_cents,
      dueCents: row.due_cents,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #hydrateLock(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      tableId: row.table_id,
      userId: row.user_id,
      deviceUuid: row.device_uuid,
      acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
      revision: row.revision,
    };
  }
}
