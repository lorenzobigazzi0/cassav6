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

function dateKeyFromIso(value) {
  const iso = asTrimmedString(value);
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "";
}

function normalizeIntegerOrNull(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.trunc(numeric);
}

function resolveBusinessDate(session) {
  const direct = asTrimmedString(session?.businessDate);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  return dateKeyFromIso(session?.startedAt ?? session?.openedAt ?? session?.createdAt);
}

function resolveOpenedAt(session) {
  return asTrimmedString(session?.startedAt ?? session?.openedAt ?? session?.createdAt);
}

function resolveClosedAt(session) {
  return optionalString(session?.endedAt ?? session?.closedAt);
}

function resolveStatus(session, closedAt) {
  const status = asTrimmedString(session?.status).toLowerCase();
  if (status) return status;
  return closedAt ? "closed" : "open";
}

function resolveOpeningFloatCents(session) {
  return normalizeIntegerOrNull(
    session?.openingFloatCents ?? session?.opening_float_cents ?? session?.openingFloat ?? session?.openingCashCents
  );
}

function resolveClosingTotalCents(session) {
  return normalizeIntegerOrNull(
    session?.closingTotalCents ?? session?.closing_total_cents ?? session?.closingTotal ?? session?.totalCents
  );
}

function resolveNotes(source) {
  return optionalString(source?.notes ?? source?.note);
}

export function mapSaleSessionToRelationalRow(session) {
  if (!session || typeof session !== "object") return null;
  const id = asTrimmedString(session.id);
  const businessDate = resolveBusinessDate(session);
  const openedAt = resolveOpenedAt(session);
  if (!id || !businessDate || !openedAt) return null;
  const closedAt = resolveClosedAt(session);

  return {
    id,
    businessDate,
    openedAt,
    openedByUserId: optionalString(session.startedByUserId ?? session.openedByUserId),
    closedAt,
    closedByUserId: optionalString(session.endedByUserId ?? session.closedByUserId),
    status: resolveStatus(session, closedAt),
    openingFloatCents: resolveOpeningFloatCents(session),
    closingTotalCents: resolveClosingTotalCents(session),
    notes: resolveNotes(session),
    rawJson: stringifyJson(session, {}),
  };
}

function resolveSolarClosureBusinessDate(closure) {
  const direct = asTrimmedString(closure?.businessDate ?? closure?.key);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  return dateKeyFromIso(closure?.closedAt ?? closure?.transmittedAt);
}

function buildSolarClosureTotals(closure) {
  if (closure?.totals && typeof closure.totals === "object") return closure.totals;
  return {
    totalSaleSessions: Number.isFinite(Number(closure?.totalSaleSessions))
      ? Math.max(0, Math.trunc(Number(closure.totalSaleSessions)))
      : 0,
    saleSessionIds: Array.isArray(closure?.saleSessionIds)
      ? closure.saleSessionIds.map((id) => String(id))
      : [],
    printerStatus: optionalString(closure?.printerStatus),
    printerResponseCode: optionalString(closure?.printerResponseCode),
  };
}

export function mapSolarClosureToRelationalRow(closure, fallbackIndex = 0) {
  if (!closure || typeof closure !== "object") return null;
  const businessDate = resolveSolarClosureBusinessDate(closure);
  const closedAt = asTrimmedString(closure.closedAt ?? closure.transmittedAt);
  if (!businessDate || !closedAt) return null;
  const id = asTrimmedString(closure.id) || `solar_${businessDate.replace(/-/g, "")}_${fallbackIndex + 1}`;

  return {
    id,
    businessDate,
    closedAt,
    closedByUserId: optionalString(closure.closedByUserId),
    totalsJson: stringifyJson(buildSolarClosureTotals(closure), {}),
    rawJson: stringifyJson(closure, {}),
  };
}

export class SaleSessionsRelationalRepository {
  constructor(db) {
    this.db = db;
  }

  list(filters = {}) {
    const clauses = [];
    const params = [];
    const businessDate = optionalString(filters.businessDate);
    const status = optionalString(filters.status);
    const fromOpenedAt = optionalString(filters.from ?? filters.fromOpenedAt);
    const toOpenedAt = optionalString(filters.to ?? filters.toOpenedAt);

    if (businessDate) {
      clauses.push("business_date = ?");
      params.push(businessDate);
    }
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    if (filters.openOnly === true) {
      clauses.push("closed_at IS NULL");
    }
    if (fromOpenedAt) {
      clauses.push("opened_at >= ?");
      params.push(fromOpenedAt);
    }
    if (toOpenedAt) {
      clauses.push("opened_at <= ?");
      params.push(toOpenedAt);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM sale_sessions${where} ORDER BY opened_at ASC, id ASC`)
      .all(...params);
    return rows.map((row) => this.#hydrateSaleSession(row));
  }

  getById(id) {
    const row = this.db.prepare("SELECT * FROM sale_sessions WHERE id = ?").get(asTrimmedString(id));
    return row ? this.#hydrateSaleSession(row) : null;
  }

  getOpenSession() {
    const row = this.db
      .prepare("SELECT * FROM sale_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC, id DESC LIMIT 1")
      .get();
    return row ? this.#hydrateSaleSession(row) : null;
  }

  getByBusinessDate(businessDate) {
    return this.list({ businessDate });
  }

  listSolarClosures() {
    return this.db
      .prepare("SELECT * FROM solar_closures ORDER BY closed_at ASC, id ASC")
      .all()
      .map((row) => this.#hydrateSolarClosure(row));
  }

  replaceAllFromAppState(saleSessions, options = {}) {
    const saleSessionRows = (Array.isArray(saleSessions) ? saleSessions : [])
      .map((session) => mapSaleSessionToRelationalRow(session))
      .filter((row) => row !== null);
    const solarClosureRows = (Array.isArray(options.solarClosures) ? options.solarClosures : [])
      .map((closure, index) => mapSolarClosureToRelationalRow(closure, index))
      .filter((row) => row !== null);
    const operation = () => {
      this.#deleteAll();
      for (const row of saleSessionRows) {
        this.#insertSaleSession(row);
      }
      for (const row of solarClosureRows) {
        this.#insertSolarClosure(row);
      }
      return {
        saleSessions: saleSessionRows,
        solarClosures: solarClosureRows,
      };
    };

    if (options.transaction === false) {
      return operation();
    }
    return runRelationalTransaction(this.db, operation);
  }

  #deleteAll() {
    this.db.prepare("DELETE FROM solar_closures").run();
    this.db.prepare("DELETE FROM sale_sessions").run();
  }

  #insertSaleSession(row) {
    this.db
      .prepare(
        `
          INSERT INTO sale_sessions (
            id,
            business_date,
            opened_at,
            opened_by_user_id,
            closed_at,
            closed_by_user_id,
            status,
            opening_float_cents,
            closing_total_cents,
            notes,
            raw_json,
            updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
          )
        `
      )
      .run(
        row.id,
        row.businessDate,
        row.openedAt,
        row.openedByUserId,
        row.closedAt,
        row.closedByUserId,
        row.status,
        row.openingFloatCents,
        row.closingTotalCents,
        row.notes,
        row.rawJson
      );
  }

  #insertSolarClosure(row) {
    this.db
      .prepare(
        `
          INSERT INTO solar_closures (
            id,
            business_date,
            closed_at,
            closed_by_user_id,
            totals_json,
            raw_json
          ) VALUES (
            ?, ?, ?, ?, ?, ?
          )
        `
      )
      .run(row.id, row.businessDate, row.closedAt, row.closedByUserId, row.totalsJson, row.rawJson);
  }

  #hydrateSaleSession(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      businessDate: row.business_date,
      openedAt: row.opened_at,
      openedByUserId: row.opened_by_user_id,
      closedAt: row.closed_at,
      closedByUserId: row.closed_by_user_id,
      status: row.status,
      openingFloatCents: row.opening_float_cents,
      closingTotalCents: row.closing_total_cents,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #hydrateSolarClosure(row) {
    const raw = safeJsonParse(row.raw_json, {});
    const totals = safeJsonParse(row.totals_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      key: raw?.key ?? row.business_date,
      businessDate: row.business_date,
      transmittedAt: raw?.transmittedAt ?? row.closed_at,
      closedAt: row.closed_at,
      closedByUserId: row.closed_by_user_id,
      printerStatus: raw?.printerStatus ?? totals?.printerStatus ?? null,
      printerResponseCode: raw?.printerResponseCode ?? totals?.printerResponseCode ?? null,
      printerResponseMessage: raw?.printerResponseMessage ?? totals?.printerResponseMessage ?? "",
      totalSaleSessions: Number.isFinite(Number(raw?.totalSaleSessions ?? totals?.totalSaleSessions))
        ? Number(raw?.totalSaleSessions ?? totals?.totalSaleSessions)
        : 0,
      saleSessionIds: Array.isArray(raw?.saleSessionIds)
        ? raw.saleSessionIds
        : Array.isArray(totals?.saleSessionIds)
          ? totals.saleSessionIds
          : [],
    };
  }
}
