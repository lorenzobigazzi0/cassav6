import { randomUUID } from "node:crypto";
import {
  PAYMENT_PROVIDER_TRANSACTION_STATES,
  PAYMENT_PROVIDER_TERMINAL_STATES,
  assertPaymentProviderTransitionAllowed,
  normalizePaymentProviderTransactionStatus,
} from "./payment-provider-state-machine.js";

export const PAYMENT_TRANSACTION_STATUSES = PAYMENT_PROVIDER_TRANSACTION_STATES;

const RECONCILIATION_PAYMENT_STATUSES = new Set([
  "cash_collected",
  "settlement_pending",
  "settlement_failed",
  "manual_reconciliation_required",
]);

function nowIso() {
  return new Date().toISOString();
}

function cloneJson(value, fallback = null) {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function safeId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function normalizeMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(Math.max(parsed, 0) * 100) / 100 : 0;
}

function normalizePaymentProviderType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["cash", "card", "manual"].includes(normalized)) return normalized;
  return "manual";
}

export function ensurePaymentProviderPersistence(db) {
  if (!db || typeof db !== "object") return;
  if (!Array.isArray(db.paymentProviderTransactions)) db.paymentProviderTransactions = [];
}

export function normalizePaymentProviderTransaction(record, fallbackId = safeId("ptx")) {
  if (!record || typeof record !== "object") return null;
  const fallbackTransactionId = String(fallbackId ?? "").trim() || safeId("ptx");
  const transactionId = String(record.transactionId ?? record.id ?? "").trim() || fallbackTransactionId;
  const status = normalizePaymentProviderTransactionStatus(record.status);
  const createdAt = String(record.createdAt ?? nowIso());
  return {
    transactionId,
    clientPaymentId: String(record.clientPaymentId ?? "").trim() || null,
    idempotencyKey: String(record.idempotencyKey ?? "").trim() || transactionId,
    status,
    amount: normalizeMoney(record.amount),
    currency: String(record.currency ?? "EUR").trim().toUpperCase() || "EUR",
    linesSnapshot: Array.isArray(record.linesSnapshot)
      ? cloneJson(record.linesSnapshot, [])
      : Array.isArray(record.lines)
        ? cloneJson(record.lines, [])
        : [],
    paymentMethodId: String(record.paymentMethodId ?? "").trim() || null,
    providerType: normalizePaymentProviderType(record.providerType),
    providerPayload:
      record.providerPayload && typeof record.providerPayload === "object" ? cloneJson(record.providerPayload, {}) : {},
    settlementResponse:
      record.settlementResponse && typeof record.settlementResponse === "object"
        ? cloneJson(record.settlementResponse, {})
        : null,
    settlementError:
      record.settlementError && typeof record.settlementError === "object"
        ? cloneJson(record.settlementError, {})
        : record.settlementError
          ? { message: String(record.settlementError) }
          : null,
    phase: String(record.phase ?? "").trim() || null,
    createdAt,
    updatedAt: String(record.updatedAt ?? createdAt),
    completedAt: record.completedAt ? String(record.completedAt) : null,
  };
}

export class PaymentTransactionRepository {
  constructor({ readDb, writeDb, now = nowIso } = {}) {
    this.readDb = readDb;
    this.writeDb = writeDb;
    this.now = now;
  }

  ensure(db) {
    ensurePaymentProviderPersistence(db);
    db.paymentProviderTransactions = db.paymentProviderTransactions
      .map((entry, index) => normalizePaymentProviderTransaction(entry, `ptx_${index + 1}`))
      .filter(Boolean);
    return db.paymentProviderTransactions;
  }

  findByIdempotencyInDb(db, idempotencyKey) {
    const key = String(idempotencyKey ?? "").trim();
    if (!key) return null;
    return this.ensure(db).find((entry) => entry.idempotencyKey === key) ?? null;
  }

  findByIdInDb(db, transactionId) {
    const id = String(transactionId ?? "").trim();
    if (!id) return null;
    return this.ensure(db).find((entry) => entry.transactionId === id) ?? null;
  }

  createOrGetInDb(db, payload = {}) {
    const key = String(payload.idempotencyKey ?? payload.clientPaymentId ?? "").trim();
    const existing = key ? this.findByIdempotencyInDb(db, key) : null;
    if (existing) return { transaction: existing, created: false };
    const requestedTransactionId = String(payload.transactionId ?? payload.id ?? "").trim();
    const existingByTransactionId = requestedTransactionId ? this.findByIdInDb(db, requestedTransactionId) : null;
    if (existingByTransactionId) return { transaction: existingByTransactionId, created: false };

    const at = this.now();
    const transaction = normalizePaymentProviderTransaction(
      {
        transactionId: requestedTransactionId || safeId("ptx"),
        clientPaymentId: payload.clientPaymentId,
        idempotencyKey: key || requestedTransactionId || safeId("idem"),
        amount: payload.amount,
        currency: payload.currency || "EUR",
        linesSnapshot: payload.linesSnapshot || payload.lines || [],
        paymentMethodId: payload.paymentMethodId,
        providerType: payload.providerType,
        providerPayload: payload.providerPayload || {},
        status: payload.status || "created",
        phase: payload.phase || "created",
        createdAt: at,
        updatedAt: at,
      },
      safeId("ptx")
    );
    this.ensure(db).push(transaction);
    return { transaction, created: true };
  }

  updateInDb(db, transactionId, patch = {}) {
    const records = this.ensure(db);
    const index = records.findIndex((entry) => entry.transactionId === String(transactionId ?? "").trim());
    if (index < 0) return null;
    const current = records[index];
    if (patch.status !== undefined) {
      assertPaymentProviderTransitionAllowed(current.status, patch.status, {
        allowOverride: patch.allowStatusOverride === true,
        overrideReason: patch.overrideReason,
      });
    }
    const at = this.now();
    const nextStatus =
      patch.status !== undefined
        ? normalizePaymentProviderTransactionStatus(patch.status, current.status)
        : current.status;
    const next = normalizePaymentProviderTransaction(
      {
        ...current,
        ...patch,
        providerPayload: { ...(current.providerPayload || {}), ...(patch.providerPayload || {}) },
        updatedAt: at,
        completedAt:
          patch.completedAt !== undefined
            ? patch.completedAt
            : PAYMENT_PROVIDER_TERMINAL_STATES.has(nextStatus)
              ? current.completedAt || at
              : current.completedAt,
      },
      current.transactionId
    );
    records[index] = next;
    return next;
  }

  async createOrGet(payload = {}) {
    const db = await this.readDb();
    const result = this.createOrGetInDb(db, payload);
    if (result.created) {
      db.meta.lastWriteAt = this.now();
      await this.writeDb(db);
    }
    return result;
  }

  async update(transactionId, patch = {}) {
    const db = await this.readDb();
    const updated = this.updateInDb(db, transactionId, patch);
    if (updated) {
      db.meta.lastWriteAt = this.now();
      await this.writeDb(db);
    }
    return updated;
  }

  async listForReconciliation(limit = 100) {
    const db = await this.readDb({ allowMigrations: false });
    return this.ensure(db)
      .filter((entry) => RECONCILIATION_PAYMENT_STATUSES.has(entry.status))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
  }
}
