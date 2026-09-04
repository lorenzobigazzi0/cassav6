function safeJsonParseObject(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function centsToMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric) / 100;
}

function firstString(...values) {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasPaymentsSyncState(db) {
  if (!tableExists(db, "relational_sync_state")) return false;
  return Boolean(db.prepare("SELECT domain FROM relational_sync_state WHERE domain = 'payments'").get());
}

function hasAppStatePaymentRows(appState = {}) {
  return [
    appState.payments,
    appState.paymentContainers,
    appState.paymentParts,
    appState.paymentTransactions,
    appState.paymentProviderTransactions,
    appState.fiscalReceipts,
  ].some((value) => Array.isArray(value) && value.length > 0);
}

function listRows(db, sql) {
  return db.prepare(sql).all();
}

function fallbackContainer(row) {
  return {
    id: row.id,
    tableId: row.table_id ?? null,
    billId: row.bill_id ?? null,
    orderId: row.order_id ?? null,
    status: row.status,
    amount: centsToMoney(row.paid_cents || row.total_cents),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function fallbackPart(row) {
  return {
    id: row.id,
    paymentId: row.container_id,
    methodId: row.method_id ?? null,
    methodType: row.method_type ?? null,
    amountDue: centsToMoney(row.amount_cents),
    fiscalStatus: row.fiscal_status ?? null,
    createdAt: row.created_at ?? null,
    status: "PAID",
  };
}

function fallbackTransaction(row, partByContainerId) {
  const part = partByContainerId.get(String(row.container_id ?? "").trim()) ?? null;
  return {
    id: row.id,
    partId: part?.id ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    tableId: row.table_id ?? null,
    billId: row.bill_id ?? null,
    orderId: row.order_id ?? null,
    amountPaid: centsToMoney(row.amount_cents),
    method: part?.methodType ?? null,
    status: row.status,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function fallbackFiscalReceipt(row) {
  return {
    id: row.id,
    paymentId: row.payment_transaction_id ?? null,
    status: row.fiscal_status ?? "UNKNOWN",
    fiscalStatus: row.fiscal_status ?? "UNKNOWN",
    fiscalProvider: row.fiscal_provider ?? null,
    fiscalProviderRef: row.fiscal_document_number ?? null,
    fiscalDocumentNumber: row.fiscal_document_number ?? null,
    createdAt: row.issued_at ?? null,
    payload: safeJsonParseObject(row.payload_json) ?? {},
  };
}

function isProviderTransactionRaw(raw) {
  if (!raw || typeof raw !== "object") return false;
  return Boolean(raw.transactionId && !raw.partId && !raw.amountPaid);
}

function normalizeTransactionRaw(raw, fallbackId) {
  if (!raw || typeof raw !== "object") return null;
  if (isProviderTransactionRaw(raw)) return null;
  return {
    ...raw,
    id: firstString(raw.id, fallbackId),
  };
}

function normalizeProviderTransactionRaw(raw, fallbackId) {
  if (!isProviderTransactionRaw(raw)) return null;
  return {
    ...raw,
    transactionId: firstString(raw.transactionId, raw.id, fallbackId),
  };
}

export function buildPaymentsReportReadModelFromRelational(db) {
  const containerRows = listRows(
    db,
    "SELECT * FROM payment_containers ORDER BY created_at ASC, id ASC"
  );
  const partRows = listRows(db, "SELECT * FROM payment_parts ORDER BY created_at ASC, id ASC");
  const transactionRows = listRows(
    db,
    "SELECT * FROM payment_transactions ORDER BY created_at ASC, id ASC"
  );
  const fiscalReceiptRows = listRows(db, "SELECT * FROM fiscal_receipts ORDER BY issued_at ASC, id ASC");

  const paymentContainers = containerRows.map((row) => safeJsonParseObject(row.raw_json) ?? fallbackContainer(row));
  const paymentParts = partRows.map((row) => safeJsonParseObject(row.raw_json) ?? fallbackPart(row));
  const partByContainerId = new Map();
  paymentParts.forEach((part) => {
    const containerId = String(part?.paymentId ?? part?.containerId ?? "").trim();
    if (containerId && !partByContainerId.has(containerId)) partByContainerId.set(containerId, part);
  });
  const paymentTransactions = [];
  const paymentProviderTransactions = [];
  transactionRows.forEach((row) => {
    const raw = safeJsonParseObject(row.raw_json);
    const provider = normalizeProviderTransactionRaw(raw, row.id);
    if (provider) {
      paymentProviderTransactions.push(provider);
      return;
    }
    paymentTransactions.push(normalizeTransactionRaw(raw, row.id) ?? fallbackTransaction(row, partByContainerId));
  });
  const fiscalReceipts = fiscalReceiptRows.map((row) => safeJsonParseObject(row.raw_json) ?? fallbackFiscalReceipt(row));

  return {
    paymentContainers,
    paymentParts,
    paymentTransactions,
    paymentProviderTransactions,
    fiscalReceipts,
    rowCount:
      paymentContainers.length +
      paymentParts.length +
      paymentTransactions.length +
      paymentProviderTransactions.length +
      fiscalReceipts.length,
  };
}

export function buildPaymentsReportReadDb(appState, relationalDb) {
  if (!relationalDb) return null;
  if (!hasPaymentsSyncState(relationalDb) && hasAppStatePaymentRows(appState)) return null;
  const readModel = buildPaymentsReportReadModelFromRelational(relationalDb);
  if (readModel.rowCount === 0 && hasAppStatePaymentRows(appState)) return null;
  return {
    ...appState,
    paymentContainers: readModel.paymentContainers,
    paymentParts: readModel.paymentParts,
    paymentTransactions: readModel.paymentTransactions,
    paymentProviderTransactions: readModel.paymentProviderTransactions,
    fiscalReceipts: readModel.fiscalReceipts,
  };
}
