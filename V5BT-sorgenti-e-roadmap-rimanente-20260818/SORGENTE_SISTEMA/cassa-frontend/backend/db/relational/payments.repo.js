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

function indexById(values, selector) {
  const indexed = new Map();
  for (const value of values) {
    const id = optionalString(selector(value));
    if (id && !indexed.has(id)) indexed.set(id, value);
  }
  return indexed;
}

function pushMulti(map, key, value) {
  const normalized = optionalString(key);
  if (!normalized) return;
  const values = map.get(normalized) ?? [];
  values.push(value);
  map.set(normalized, values);
}

function firstFromMulti(map, key) {
  const values = map.get(optionalString(key) ?? "");
  return values?.[0] ?? null;
}

function normalizeStatus(value, fallback = "unknown") {
  const normalized = asTrimmedString(value).toLowerCase();
  return normalized || fallback;
}

function normalizeFiscalStatus(value) {
  const normalized = asTrimmedString(value).toUpperCase();
  return normalized || null;
}

function normalizeAttemptScope(value, fallback = "issue") {
  const normalized = asTrimmedString(value).toLowerCase();
  return normalized || fallback;
}

function centsFromCentsValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.trunc(numeric));
}

function positiveInteger(value, fallback = 1) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
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

function centsFromMoneyValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.round(numeric * 100));
}

function firstCents({ cents = [], money = [] } = {}) {
  for (const value of cents) {
    const parsed = centsFromCentsValue(value);
    if (parsed !== null) return parsed;
  }
  for (const value of money) {
    const parsed = centsFromMoneyValue(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function buildContext(appState) {
  const containers = arrayFrom(appState?.paymentContainers);
  const payments = arrayFrom(appState?.payments);
  const parts = arrayFrom(appState?.paymentParts);
  const transactions = arrayFrom(appState?.paymentTransactions);
  const providerTransactions = arrayFrom(appState?.paymentProviderTransactions);
  const receipts = arrayFrom(appState?.fiscalReceipts);

  const paymentsByContainerId = new Map();
  const paymentsByPartId = new Map();
  const paymentsByTxId = new Map();
  const paymentsByReceiptId = new Map();
  const paymentsByClientPaymentId = new Map();
  for (const payment of payments) {
    pushMulti(paymentsByContainerId, payment.paymentContainerId ?? payment.id, payment);
    pushMulti(paymentsByPartId, payment.paymentPartId, payment);
    pushMulti(paymentsByTxId, payment.paymentTxId, payment);
    pushMulti(paymentsByReceiptId, payment.receiptId, payment);
    pushMulti(paymentsByClientPaymentId, payment.clientPaymentId, payment);
  }

  const partsByContainerId = new Map();
  for (const part of parts) {
    pushMulti(partsByContainerId, part.paymentId ?? part.containerId, part);
  }

  const transactionsByPartId = new Map();
  for (const transaction of transactions) {
    pushMulti(transactionsByPartId, transaction.partId, transaction);
  }

  const providerByReceiptId = new Map();
  for (const transaction of providerTransactions) {
    const receiptId = transaction?.settlementResponse?.receiptId;
    if (receiptId && !providerByReceiptId.has(String(receiptId))) {
      providerByReceiptId.set(String(receiptId), transaction);
    }
  }

  return {
    containers,
    payments,
    parts,
    transactions,
    providerTransactions,
    receipts,
    containerById: indexById(containers, (entry) => entry.id),
    paymentById: indexById(payments, (entry) => entry.id),
    partById: indexById(parts, (entry) => entry.id),
    transactionById: indexById(transactions, (entry) => entry.id),
    paymentsByContainerId,
    paymentsByPartId,
    paymentsByTxId,
    paymentsByReceiptId,
    paymentsByClientPaymentId,
    partsByContainerId,
    transactionsByPartId,
    providerByReceiptId,
  };
}

function sumPartsCents(containerId, context) {
  const parts = context.partsByContainerId.get(optionalString(containerId) ?? "") ?? [];
  return parts.reduce((sum, part) => {
    const cents = firstCents({
      cents: [part.amountCents, part.amount_due_cents],
      money: [part.amountDue, part.amount],
    });
    return sum + (cents ?? 0);
  }, 0);
}

function resolveContainerTotals(container, payment, context) {
  const id = optionalString(container?.id ?? payment?.paymentContainerId ?? payment?.id);
  const total =
    firstCents({
      cents: [container?.totalCents, container?.amountCents, payment?.totalCents, payment?.amountCents],
      money: [container?.total, container?.amount, payment?.total, payment?.amount],
    }) ??
    (id ? sumPartsCents(id, context) : 0);
  const explicitPaid = firstCents({
    cents: [container?.paidCents, payment?.paidCents],
    money: [container?.paidAmount, container?.paid, payment?.paidAmount, payment?.paid],
  });
  const explicitDue = firstCents({
    cents: [container?.dueCents, payment?.dueCents],
    money: [container?.dueAmount, container?.due, payment?.dueAmount, payment?.due],
  });
  const status = normalizeStatus(container?.status ?? payment?.status ?? "");
  const paid = explicitPaid ?? (["completed", "paid", "settled"].includes(status) ? total : 0);
  const due = explicitDue ?? Math.max(0, total - paid);
  return {
    total,
    paid,
    due,
  };
}

export function mapPaymentContainerToRelationalRow(container, context = buildContext({})) {
  if (!container || typeof container !== "object") return null;
  const id = optionalString(container.id);
  if (!id) return null;
  const payment = firstFromMulti(context.paymentsByContainerId, id) ?? context.paymentById.get(id) ?? null;
  const totals = resolveContainerTotals(container, payment, context);

  return {
    id,
    tableId: firstString(container.tableId, payment?.tableId),
    billId: firstString(container.billId, container.billIds, payment?.billId, payment?.billIds),
    orderId: firstString(container.orderId, container.orderIds, payment?.orderId, payment?.orderIds),
    status: normalizeStatus(container.status ?? payment?.status, totals.due > 0 ? "open" : "completed"),
    totalCents: totals.total,
    paidCents: totals.paid,
    dueCents: totals.due,
    createdAt: firstString(container.createdAt, payment?.createdAt),
    updatedAt: firstString(container.updatedAt, container.fiscalIssuedAt, payment?.updatedAt, payment?.createdAt),
    revision: positiveInteger(container.revision ?? container.currentRevision ?? payment?.revision ?? payment?.currentRevision, 1),
    rawJson: stringifyJson(container, {}),
  };
}

function mapLegacyPaymentContainerToRelationalRow(payment, context) {
  if (!payment || typeof payment !== "object") return null;
  const id = optionalString(payment.paymentContainerId ?? payment.id);
  if (!id) return null;
  return mapPaymentContainerToRelationalRow(
    {
      id,
      tableId: payment.tableId,
      billId: payment.billId,
      billIds: payment.billIds,
      orderId: payment.orderId,
      orderIds: payment.orderIds,
      status: "COMPLETED",
      amount: payment.amount,
      createdAt: payment.createdAt,
      idempotencyKey: payment.idempotencyKey,
      clientPaymentId: payment.clientPaymentId,
      legacyPaymentId: payment.id,
      source: payment.source,
    },
    context
  );
}

export function mapPaymentPartToRelationalRow(part, context = buildContext({}), containerIds = new Set()) {
  if (!part || typeof part !== "object") return null;
  const id = optionalString(part.id);
  const payment = firstFromMulti(context.paymentsByPartId, id);
  const containerId = firstString(part.paymentId, part.containerId, payment?.paymentContainerId, payment?.id);
  if (!id || !containerId || !containerIds.has(containerId)) return null;
  const transaction = firstFromMulti(context.transactionsByPartId, id);
  const receipt = payment?.receiptId ? context.receipts.find((entry) => String(entry.id) === String(payment.receiptId)) : null;

  return {
    id,
    containerId,
    methodId: firstString(part.methodId, payment?.methodId, context.containerById.get(containerId)?.paymentMethod),
    methodType: firstString(part.methodType, transaction?.method, payment?.methodLabel),
    amountCents:
      firstCents({
        cents: [part.amountCents, part.amount_due_cents],
        money: [part.amountDue, part.amount, transaction?.amountPaid, payment?.amount],
      }) ?? 0,
    fiscalStatus: normalizeFiscalStatus(part.fiscalStatus ?? receipt?.fiscalStatus ?? receipt?.status),
    createdAt: firstString(part.createdAt, transaction?.createdAt, payment?.createdAt, context.containerById.get(containerId)?.createdAt),
    rawJson: stringifyJson(part, {}),
  };
}

function resolveContainerIdForTransaction(transaction, context) {
  const part = context.partById.get(optionalString(transaction?.partId) ?? "");
  const payment = firstFromMulti(context.paymentsByTxId, transaction?.id) ?? firstFromMulti(context.paymentsByPartId, part?.id);
  return firstString(transaction?.paymentContainerId, transaction?.containerId, payment?.paymentContainerId, part?.paymentId);
}

function transactionRefs(containerId, payment) {
  return {
    tableId: firstString(payment?.tableId),
    billId: firstString(payment?.billId, payment?.billIds),
    orderId: firstString(payment?.orderId, payment?.orderIds),
    containerId: optionalString(containerId),
  };
}

export function mapPaymentTransactionToRelationalRow(transaction, context = buildContext({}), containerIds = new Set()) {
  if (!transaction || typeof transaction !== "object") return null;
  const id = optionalString(transaction.id);
  if (!id) return null;
  const containerId = resolveContainerIdForTransaction(transaction, context);
  const part = context.partById.get(optionalString(transaction.partId) ?? "");
  const payment =
    firstFromMulti(context.paymentsByTxId, id) ??
    firstFromMulti(context.paymentsByPartId, part?.id) ??
    firstFromMulti(context.paymentsByContainerId, containerId);
  const container = context.containerById.get(optionalString(containerId) ?? "");
  const refs = transactionRefs(containerId, payment);
  return {
    id,
    containerId: containerIds.has(refs.containerId) ? refs.containerId : null,
    idempotencyKey: firstString(transaction.idempotencyKey, payment?.idempotencyKey, container?.idempotencyKey),
    tableId: firstString(transaction.tableId, refs.tableId, container?.tableId),
    billId: firstString(transaction.billId, refs.billId, container?.billId, container?.billIds),
    orderId: firstString(transaction.orderId, refs.orderId, container?.orderId, container?.orderIds),
    amountCents:
      firstCents({
        cents: [transaction.amountCents, transaction.amount_paid_cents],
        money: [transaction.amountPaid, transaction.amount, payment?.amount, part?.amountDue],
      }) ?? 0,
    status: normalizeStatus(transaction.status ?? payment?.status ?? (transaction.refundedAt ? "refunded" : "settled"), "settled"),
    createdAt: firstString(transaction.createdAt, payment?.createdAt, container?.createdAt),
    updatedAt: firstString(transaction.updatedAt, transaction.refundedAt, payment?.updatedAt, payment?.createdAt),
    revision: positiveInteger(transaction.revision ?? transaction.currentRevision ?? payment?.revision ?? payment?.currentRevision, 1),
    rawJson: stringifyJson(transaction, {}),
  };
}

function resolveContainerIdForProviderTransaction(transaction, context) {
  const direct = firstString(
    transaction?.containerId,
    transaction?.paymentContainerId,
    transaction?.paymentId,
    transaction?.settlementResponse?.paymentId,
    transaction?.settlementResponse?.containerId
  );
  if (direct) return direct;
  const payment = firstFromMulti(context.paymentsByClientPaymentId, transaction?.clientPaymentId);
  return firstString(payment?.paymentContainerId, payment?.id);
}

export function mapPaymentProviderTransactionToRelationalRow(transaction, context = buildContext({}), containerIds = new Set()) {
  if (!transaction || typeof transaction !== "object") return null;
  const id = optionalString(transaction.transactionId ?? transaction.id);
  if (!id) return null;
  const containerId = resolveContainerIdForProviderTransaction(transaction, context);
  const container = context.containerById.get(optionalString(containerId) ?? "");
  const payment =
    firstFromMulti(context.paymentsByContainerId, containerId) ??
    firstFromMulti(context.paymentsByClientPaymentId, transaction.clientPaymentId);

  return {
    id,
    containerId: containerIds.has(optionalString(containerId) ?? "") ? optionalString(containerId) : null,
    idempotencyKey: firstString(transaction.idempotencyKey, transaction.clientPaymentId),
    tableId: firstString(transaction.tableId, payment?.tableId, container?.tableId),
    billId: firstString(transaction.billId, payment?.billId, payment?.billIds, container?.billId, container?.billIds),
    orderId: firstString(transaction.orderId, payment?.orderId, payment?.orderIds, container?.orderId, container?.orderIds),
    amountCents:
      firstCents({
        cents: [transaction.amountCents],
        money: [transaction.amount],
      }) ?? 0,
    status: normalizeStatus(transaction.status, "created"),
    createdAt: firstString(transaction.createdAt),
    updatedAt: firstString(transaction.updatedAt, transaction.completedAt, transaction.createdAt),
    revision: positiveInteger(transaction.revision ?? transaction.currentRevision, 1),
    rawJson: stringifyJson(transaction, {}),
  };
}

function withUniqueIdempotencyKeys(rows) {
  const seen = new Set();
  return rows.map((row) => {
    const key = optionalString(row.idempotencyKey);
    if (!key) return row;
    if (seen.has(key)) {
      return { ...row, idempotencyKey: null };
    }
    seen.add(key);
    return row;
  });
}

function resolveReceiptTransactionId(receipt, context, transactionIds) {
  const id = optionalString(receipt?.id);
  const payment =
    firstFromMulti(context.paymentsByReceiptId, id) ??
    firstFromMulti(context.paymentsByContainerId, receipt?.paymentId);
  const provider = context.providerByReceiptId.get(id ?? "");
  const candidates = [
    receipt?.paymentTransactionId,
    receipt?.paymentTxId,
    receipt?.paymentId,
    payment?.paymentTxId,
    provider?.transactionId,
    provider?.id,
  ]
    .map((value) => optionalString(value))
    .filter(Boolean);
  return candidates.find((candidate) => transactionIds.has(candidate)) ?? null;
}

export function mapFiscalReceiptToRelationalRow(receipt, context = buildContext({}), transactionIds = new Set()) {
  if (!receipt || typeof receipt !== "object") return null;
  const id = optionalString(receipt.id);
  if (!id) return null;
  const payload =
    receipt.payload && typeof receipt.payload === "object"
      ? receipt.payload
      : {
          command: receipt.command,
          responseCode: receipt.responseCode,
          responseMessage: receipt.responseMessage,
          fiscalError: receipt.fiscalError,
          requiresFiscalRetry: receipt.requiresFiscalRetry === true,
        };

  return {
    id,
    paymentTransactionId: resolveReceiptTransactionId(receipt, context, transactionIds),
    attemptScope: normalizeAttemptScope(
      firstString(
        receipt.attemptScope,
        receipt.attempt_scope,
        receipt.payload?.attemptScope,
        receipt.rawJson?.attemptScope,
      ),
    ),
    fiscalProvider: firstString(receipt.fiscalProvider),
    fiscalStatus: normalizeFiscalStatus(receipt.fiscalStatus ?? receipt.status),
    fiscalDocumentNumber: firstString(receipt.fiscalDocumentNumber, receipt.fiscalDocNo, receipt.fiscalProviderRef),
    issuedAt: firstString(receipt.issuedAt, receipt.createdAt),
    payloadJson: stringifyJson(payload, {}),
    rawJson: stringifyJson(receipt, {}),
  };
}

export function buildPaymentsRelationalRows(appState) {
  const context = buildContext(appState);
  const containerRows = [];
  const containerIds = new Set();

  for (const container of context.containers) {
    const row = mapPaymentContainerToRelationalRow(container, context);
    if (!row) continue;
    containerRows.push(row);
    containerIds.add(row.id);
  }
  for (const payment of context.payments) {
    const row = mapLegacyPaymentContainerToRelationalRow(payment, context);
    if (!row || containerIds.has(row.id)) continue;
    containerRows.push(row);
    containerIds.add(row.id);
  }

  const partRows = context.parts
    .map((part) => mapPaymentPartToRelationalRow(part, context, containerIds))
    .filter((row) => row !== null);
  const transactionRows = withUniqueIdempotencyKeys([
    ...context.transactions
      .map((transaction) => mapPaymentTransactionToRelationalRow(transaction, context, containerIds))
      .filter((row) => row !== null),
    ...context.providerTransactions
      .map((transaction) => mapPaymentProviderTransactionToRelationalRow(transaction, context, containerIds))
      .filter((row) => row !== null),
  ]);
  const transactionIds = new Set(transactionRows.map((row) => row.id));
  const fiscalReceiptRows = context.receipts
    .map((receipt) => mapFiscalReceiptToRelationalRow(receipt, context, transactionIds))
    .filter((row) => row !== null);

  return {
    containers: containerRows,
    parts: partRows,
    transactions: transactionRows,
    fiscalReceipts: fiscalReceiptRows,
  };
}

export class PaymentsRelationalRepository {
  constructor(db) {
    this.db = db;
  }

  listTransactions(filters = {}) {
    const clauses = [];
    const params = [];
    this.#appendFilter(clauses, params, "container_id", filters.containerId);
    this.#appendFilter(clauses, params, "idempotency_key", filters.idempotencyKey);
    this.#appendFilter(clauses, params, "table_id", filters.tableId);
    this.#appendFilter(clauses, params, "bill_id", filters.billId);
    this.#appendFilter(clauses, params, "order_id", filters.orderId);
    this.#appendFilter(clauses, params, "status", filters.status);
    this.#appendDateRange(clauses, params, "created_at", filters.from ?? filters.fromCreatedAt, filters.to ?? filters.toCreatedAt);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM payment_transactions${where} ORDER BY created_at ASC, id ASC`)
      .all(...params)
      .map((row) => this.#hydrateTransaction(row));
  }

  getTransactionById(id) {
    const row = this.db.prepare("SELECT * FROM payment_transactions WHERE id = ?").get(asTrimmedString(id));
    return row ? this.#hydrateTransaction(row) : null;
  }

  getFiscalReceiptById(id) {
    const row = this.db.prepare("SELECT * FROM fiscal_receipts WHERE id = ?").get(asTrimmedString(id));
    return row ? this.#hydrateFiscalReceipt(row) : null;
  }

  getFiscalReceiptByPaymentAttempt(paymentTransactionId, attemptScope = "issue") {
    const normalizedPaymentTransactionId = optionalString(paymentTransactionId);
    if (!normalizedPaymentTransactionId) return null;
    const row = this.db
      .prepare(
        "SELECT * FROM fiscal_receipts WHERE payment_transaction_id = ? AND attempt_scope = ? ORDER BY issued_at ASC, id ASC LIMIT 1",
      )
      .get(
        normalizedPaymentTransactionId,
        normalizeAttemptScope(attemptScope),
      );
    return row ? this.#hydrateFiscalReceipt(row) : null;
  }

  createFiscalReceipt(row) {
    const normalizedId = optionalString(row?.id);
    if (!normalizedId) return null;
    const safeRow = {
      id: normalizedId,
      paymentTransactionId: optionalString(row?.paymentTransactionId),
      attemptScope: normalizeAttemptScope(row?.attemptScope),
      fiscalProvider: optionalString(row?.fiscalProvider),
      fiscalStatus: normalizeFiscalStatus(row?.fiscalStatus),
      fiscalDocumentNumber: optionalString(row?.fiscalDocumentNumber),
      issuedAt: optionalString(row?.issuedAt),
      payloadJson:
        typeof row?.payloadJson === "string"
          ? row.payloadJson
          : stringifyJson(row?.payloadJson, {}),
      rawJson:
        typeof row?.rawJson === "string"
          ? row.rawJson
          : stringifyJson(row?.rawJson, {}),
    };
    try {
      this.#insertFiscalReceipt(safeRow);
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        const existingByAttempt = this.getFiscalReceiptByPaymentAttempt(
          safeRow.paymentTransactionId,
          safeRow.attemptScope,
        );
        if (existingByAttempt) return existingByAttempt;
        const existingById = this.getFiscalReceiptById(normalizedId);
        if (existingById) return existingById;
      }
      throw error;
    }
    return this.getFiscalReceiptById(normalizedId);
  }

  updateFiscalReceipt(id, patch = {}) {
    const normalizedId = optionalString(id);
    if (!normalizedId) return null;
    const assignments = [];
    const params = [];
    this.#appendPatch(assignments, params, "payment_transaction_id", patch.paymentTransactionId);
    this.#appendPatch(assignments, params, "attempt_scope", patch.attemptScope);
    this.#appendPatch(assignments, params, "fiscal_provider", patch.fiscalProvider);
    if (patch.fiscalStatus !== undefined) {
      assignments.push("fiscal_status = ?");
      params.push(normalizeFiscalStatus(patch.fiscalStatus));
    }
    this.#appendPatch(assignments, params, "fiscal_document_number", patch.fiscalDocumentNumber);
    this.#appendPatch(assignments, params, "issued_at", patch.issuedAt);
    if (patch.payloadJson !== undefined) {
      assignments.push("payload_json = ?");
      params.push(typeof patch.payloadJson === "string" ? patch.payloadJson : stringifyJson(patch.payloadJson, {}));
    }
    if (patch.rawJson !== undefined) {
      assignments.push("raw_json = ?");
      params.push(typeof patch.rawJson === "string" ? patch.rawJson : stringifyJson(patch.rawJson, {}));
    }
    if (assignments.length === 0) return this.getFiscalReceiptById(normalizedId);
    const result = this.db
      .prepare(`UPDATE fiscal_receipts SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...params, normalizedId);
    return result.changes > 0 ? this.getFiscalReceiptById(normalizedId) : null;
  }

  createPaymentTransaction(row) {
    const normalizedId = optionalString(row?.id);
    if (!normalizedId) return { ok: false, reason: "invalid_transaction" };
    const safeRow = {
      id: normalizedId,
      containerId: optionalString(row?.containerId),
      idempotencyKey: optionalString(row?.idempotencyKey),
      tableId: optionalString(row?.tableId),
      billId: optionalString(row?.billId),
      orderId: optionalString(row?.orderId),
      amountCents: centsFromCentsValue(row?.amountCents) ?? 0,
      status: normalizeStatus(row?.status, "settled"),
      createdAt: optionalString(row?.createdAt),
      updatedAt: optionalString(row?.updatedAt),
      revision: positiveInteger(row?.revision, 1),
      rawJson:
        typeof row?.rawJson === "string"
          ? row.rawJson
          : stringifyJson(row?.rawJson, {}),
    };
    try {
      this.#insertTransaction(safeRow);
      return {
        ok: true,
        created: true,
        transaction: this.getTransactionById(safeRow.id),
      };
    } catch (error) {
      if (isSqliteConstraintError(error) && safeRow.idempotencyKey) {
        const existing = this.getTransactionByIdempotencyKey(safeRow.idempotencyKey);
        if (existing) {
          return {
            ok: true,
            created: false,
            replayed: true,
            reason: "duplicate_idempotency",
            transaction: existing,
          };
        }
      }
      throw error;
    }
  }

  createTicketPaymentFromAppState({
    paymentContainer,
    paymentPart,
    paymentTransaction,
    paymentRecord,
    fiscalReceipts = [],
  } = {}) {
    return this.createFreeSplitPaymentFromAppState({
      paymentContainer,
      paymentParts: paymentPart ? [paymentPart] : [],
      paymentTransactions: paymentTransaction ? [paymentTransaction] : [],
      paymentRecords: paymentRecord ? [paymentRecord] : [],
      fiscalReceipts,
    });
  }

  createFreeSplitPaymentFromAppState({
    paymentContainer,
    paymentParts = [],
    paymentTransactions = [],
    paymentRecords = [],
    fiscalReceipts = [],
  } = {}) {
    const rows = buildPaymentsRelationalRows({
      paymentContainers: paymentContainer ? [paymentContainer] : [],
      paymentParts: Array.isArray(paymentParts)
        ? paymentParts.filter(Boolean)
        : [],
      paymentTransactions: Array.isArray(paymentTransactions)
        ? paymentTransactions.filter(Boolean)
        : [],
      paymentProviderTransactions: [],
      payments: Array.isArray(paymentRecords)
        ? paymentRecords.filter(Boolean)
        : [],
      fiscalReceipts: Array.isArray(fiscalReceipts)
        ? fiscalReceipts.filter(Boolean)
        : [],
    });
    const requestedIdempotencyKey = optionalString(paymentContainer?.idempotencyKey);
    const transactionRow =
      rows.transactions.find(
        (row) => optionalString(row.idempotencyKey) === requestedIdempotencyKey,
      ) ??
      rows.transactions[0] ??
      null;
    if (!transactionRow?.id) {
      const zeroValueContainer = rows.containers[0] ?? null;
      if (
        zeroValueContainer &&
        zeroValueContainer.totalCents === 0 &&
        zeroValueContainer.paidCents === 0
      ) {
        if (!this.getContainerById(zeroValueContainer.id)) {
          this.#insertContainer(zeroValueContainer);
        }
        return {
          ok: true,
          created: true,
          replayed: false,
          container: this.getContainerById(zeroValueContainer.id),
          transaction: null,
          transactions: [],
          receipts: [],
          rows,
        };
      }
      return { ok: false, reason: "missing_transaction" };
    }
    const transactionResults = [];
    for (const row of rows.transactions) {
      const transactionResult = this.createPaymentTransaction(row);
      transactionResults.push(transactionResult);
      if (!transactionResult?.ok || transactionResult.replayed) {
        return {
          ok: transactionResult?.ok === true,
          created: false,
          replayed: transactionResult?.replayed === true,
          reason: transactionResult?.reason ?? "transaction_not_created",
          transaction: transactionResult?.transaction ?? null,
          transactions: transactionResults
            .map((entry) => entry?.transaction ?? null)
            .filter(Boolean),
          rows,
        };
      }
    }
    for (const row of rows.containers) {
      if (!this.getContainerById(row.id)) this.#insertContainer(row);
    }
    for (const row of rows.parts) {
      this.#insertPart(row);
    }
    const receipts = [];
    for (const row of rows.fiscalReceipts) {
      const existingReceipt = this.getFiscalReceiptById(row.id);
      receipts.push(existingReceipt ?? this.createFiscalReceipt(row));
    }
    return {
      ok: true,
      created: true,
      replayed: false,
      container: rows.containers[0]?.id ? this.getContainerById(rows.containers[0].id) : null,
      transaction: this.getTransactionById(transactionRow.id),
      transactions: rows.transactions
        .map((row) => this.getTransactionById(row.id))
        .filter(Boolean),
      receipts,
      rows,
    };
  }

  createTablePaymentFromAppState(input = {}) {
    return this.createTicketPaymentFromAppState(input);
  }

  getTransactionByIdempotencyKey(key) {
    const row = this.db
      .prepare("SELECT * FROM payment_transactions WHERE idempotency_key = ?")
      .get(asTrimmedString(key));
    return row ? this.#hydrateTransaction(row) : null;
  }

  listContainers(filters = {}) {
    const clauses = [];
    const params = [];
    this.#appendFilter(clauses, params, "table_id", filters.tableId);
    this.#appendFilter(clauses, params, "bill_id", filters.billId);
    this.#appendFilter(clauses, params, "order_id", filters.orderId);
    this.#appendFilter(clauses, params, "status", filters.status);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM payment_containers${where} ORDER BY created_at ASC, id ASC`)
      .all(...params)
      .map((row) => this.#hydrateContainer(row));
  }

  getContainerById(id) {
    const row = this.db.prepare("SELECT * FROM payment_containers WHERE id = ?").get(asTrimmedString(id));
    return row ? this.#hydrateContainer(row) : null;
  }

  updateContainerWithRevision(id, expectedRevision, patch = {}) {
    const normalizedId = optionalString(id);
    const safeExpectedRevision = positiveInteger(expectedRevision, 0);
    if (!normalizedId || safeExpectedRevision <= 0) return null;
    const assignments = ["revision = revision + 1"];
    const params = [];
    this.#appendPatch(assignments, params, "table_id", patch.tableId);
    this.#appendPatch(assignments, params, "bill_id", patch.billId);
    this.#appendPatch(assignments, params, "order_id", patch.orderId);
    this.#appendPatch(assignments, params, "status", patch.status);
    this.#appendPatchCents(assignments, params, "total_cents", patch.totalCents);
    this.#appendPatchCents(assignments, params, "paid_cents", patch.paidCents);
    this.#appendPatchCents(assignments, params, "due_cents", patch.dueCents);
    this.#appendPatch(assignments, params, "updated_at", patch.updatedAt);
    if (patch.rawJson !== undefined) {
      assignments.push("raw_json = ?");
      params.push(typeof patch.rawJson === "string" ? patch.rawJson : stringifyJson(patch.rawJson, {}));
    }
    const result = this.db
      .prepare(`UPDATE payment_containers SET ${assignments.join(", ")} WHERE id = ? AND revision = ?`)
      .run(...params, normalizedId, safeExpectedRevision);
    return result.changes > 0 ? this.getContainerById(normalizedId) : null;
  }

  updateTransactionWithRevision(id, expectedRevision, patch = {}) {
    const normalizedId = optionalString(id);
    const safeExpectedRevision = positiveInteger(expectedRevision, 0);
    if (!normalizedId || safeExpectedRevision <= 0) return null;
    const assignments = ["revision = revision + 1"];
    const params = [];
    this.#appendPatch(assignments, params, "container_id", patch.containerId);
    this.#appendPatch(assignments, params, "idempotency_key", patch.idempotencyKey);
    this.#appendPatch(assignments, params, "table_id", patch.tableId);
    this.#appendPatch(assignments, params, "bill_id", patch.billId);
    this.#appendPatch(assignments, params, "order_id", patch.orderId);
    this.#appendPatchCents(assignments, params, "amount_cents", patch.amountCents);
    this.#appendPatch(assignments, params, "status", patch.status);
    this.#appendPatch(assignments, params, "updated_at", patch.updatedAt);
    if (patch.rawJson !== undefined) {
      assignments.push("raw_json = ?");
      params.push(typeof patch.rawJson === "string" ? patch.rawJson : stringifyJson(patch.rawJson, {}));
    }
    const result = this.db
      .prepare(`UPDATE payment_transactions SET ${assignments.join(", ")} WHERE id = ? AND revision = ?`)
      .run(...params, normalizedId, safeExpectedRevision);
    return result.changes > 0 ? this.getTransactionById(normalizedId) : null;
  }

  replaceAllFromAppState(appState, options = {}) {
    const rows = buildPaymentsRelationalRows(appState);
    const operation = () => {
      this.#deleteAll();
      for (const row of rows.containers) this.#insertContainer(row);
      for (const row of rows.parts) this.#insertPart(row);
      for (const row of rows.transactions) this.#insertTransaction(row);
      for (const row of rows.fiscalReceipts) this.#insertFiscalReceipt(row);
      return rows;
    };

    if (options.transaction === false) {
      return operation();
    }
    return runRelationalTransaction(this.db, operation);
  }

  #appendFilter(clauses, params, columnName, value) {
    const normalized = optionalString(value);
    if (!normalized) return;
    clauses.push(`${columnName} = ?`);
    params.push(normalized);
  }

  #appendDateRange(clauses, params, columnName, from, to) {
    const fromValue = optionalString(from);
    const toValue = optionalString(to);
    if (fromValue) {
      clauses.push(`${columnName} >= ?`);
      params.push(fromValue);
    }
    if (toValue) {
      clauses.push(`${columnName} <= ?`);
      params.push(toValue);
    }
  }

  #appendPatch(assignments, params, columnName, value) {
    if (value === undefined) return;
    assignments.push(`${columnName} = ?`);
    params.push(value === null ? null : optionalString(value));
  }

  #appendPatchCents(assignments, params, columnName, value) {
    if (value === undefined) return;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    assignments.push(`${columnName} = ?`);
    params.push(Math.max(0, Math.trunc(numeric)));
  }

  #deleteAll() {
    this.db.prepare("DELETE FROM fiscal_receipts").run();
    this.db.prepare("DELETE FROM payment_transactions").run();
    this.db.prepare("DELETE FROM payment_parts").run();
    this.db.prepare("DELETE FROM payment_containers").run();
  }

  #insertContainer(row) {
    this.db
      .prepare(
        `
          INSERT INTO payment_containers (
            id,
            table_id,
            bill_id,
            order_id,
            status,
            total_cents,
            paid_cents,
            due_cents,
            created_at,
            updated_at,
            revision,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        row.id,
        row.tableId,
        row.billId,
        row.orderId,
        row.status,
        row.totalCents,
        row.paidCents,
        row.dueCents,
        row.createdAt,
        row.updatedAt,
        row.revision,
        row.rawJson
      );
  }

  #insertPart(row) {
    this.db
      .prepare(
        `
          INSERT INTO payment_parts (
            id,
            container_id,
            method_id,
            method_type,
            amount_cents,
            fiscal_status,
            created_at,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        row.id,
        row.containerId,
        row.methodId,
        row.methodType,
        row.amountCents,
        row.fiscalStatus,
        row.createdAt,
        row.rawJson
      );
  }

  #insertTransaction(row) {
    this.db
      .prepare(
        `
          INSERT INTO payment_transactions (
            id,
            container_id,
            idempotency_key,
            table_id,
            bill_id,
            order_id,
            amount_cents,
            status,
            created_at,
            updated_at,
            revision,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        row.id,
        row.containerId,
        row.idempotencyKey,
        row.tableId,
        row.billId,
        row.orderId,
        row.amountCents,
        row.status,
        row.createdAt,
        row.updatedAt,
        row.revision,
        row.rawJson
      );
  }

  #insertFiscalReceipt(row) {
    this.db
      .prepare(
        `
          INSERT INTO fiscal_receipts (
            id,
            payment_transaction_id,
            attempt_scope,
            fiscal_provider,
            fiscal_status,
            fiscal_document_number,
            issued_at,
            payload_json,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        row.id,
        row.paymentTransactionId,
        row.attemptScope,
        row.fiscalProvider,
        row.fiscalStatus,
        row.fiscalDocumentNumber,
        row.issuedAt,
        row.payloadJson,
        row.rawJson
      );
  }

  #hydrateContainer(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      tableId: row.table_id,
      billId: row.bill_id,
      orderId: row.order_id,
      status: row.status,
      totalCents: row.total_cents,
      paidCents: row.paid_cents,
      dueCents: row.due_cents,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: positiveInteger(row.revision, 1),
      currentRevision: positiveInteger(raw?.currentRevision ?? raw?.revision ?? row.revision, positiveInteger(row.revision, 1)),
    };
  }

  #hydrateTransaction(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      containerId: row.container_id,
      idempotencyKey: row.idempotency_key,
      tableId: row.table_id,
      billId: row.bill_id,
      orderId: row.order_id,
      amountCents: row.amount_cents,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: positiveInteger(row.revision, 1),
      currentRevision: positiveInteger(raw?.currentRevision ?? raw?.revision ?? row.revision, positiveInteger(row.revision, 1)),
    };
  }

  #hydrateFiscalReceipt(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      paymentTransactionId: row.payment_transaction_id,
      paymentId: row.payment_transaction_id,
      attemptScope: row.attempt_scope ?? "issue",
      fiscalProvider: row.fiscal_provider,
      fiscalStatus: row.fiscal_status,
      fiscalDocumentNumber: row.fiscal_document_number,
      fiscalProviderRef: row.fiscal_document_number,
      issuedAt: row.issued_at,
      payload: safeJsonParse(row.payload_json, {}),
      rawJson: raw,
    };
  }
}
