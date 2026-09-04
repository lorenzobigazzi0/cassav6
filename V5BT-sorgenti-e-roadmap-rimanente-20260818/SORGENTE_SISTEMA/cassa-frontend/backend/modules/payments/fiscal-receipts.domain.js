export function createFiscalReceiptHelpers(options = {}) {
  const {
    normalizeConfigId = (value, fallback = "config") => String(value ?? fallback).trim() || fallback,
    normalizePosFiscalApiPath = (pathname, fallback = "/api/fiscal/reprint") => {
      const value = String(pathname ?? "").trim();
      return value.startsWith("/") ? value : fallback;
    },
    nowIso = () => new Date().toISOString(),
  } = options;

  function normalizeFiscalApiScalar(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
      const text = String(value).trim();
      return text === "[object Object]" ? "" : text;
    }
    return "";
  }

  function firstFiscalApiScalar(...values) {
    for (const value of values) {
      const normalized = normalizeFiscalApiScalar(value);
      if (normalized) return normalized;
    }
    return "";
  }

  function cloneJsonObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }

  function sanitizeFiscalReceipt(receipt, fallbackId) {
    if (!receipt || typeof receipt !== "object") return null;
    const fiscalProviderRef = firstFiscalApiScalar(receipt.fiscalProviderRef);
    const fiscalMovementId = firstFiscalApiScalar(receipt.fiscalMovementId, receipt.movementId);
    const fiscalReceiptDate = firstFiscalApiScalar(receipt.fiscalReceiptDate, receipt.receiptDate);
    const fiscalDocumentNumber = firstFiscalApiScalar(receipt.fiscalDocumentNumber, receipt.documentNumber);
    const fiscalRequestId = firstFiscalApiScalar(receipt.fiscalRequestId, receipt.idempotencyKey);
    const idempotencyKey = firstFiscalApiScalar(receipt.idempotencyKey, fiscalRequestId);
    const attemptCount = Math.max(0, Math.trunc(Number(receipt.attemptCount) || 0));
    return {
      id: String(receipt.id ?? fallbackId),
      paymentId: receipt.paymentId ? String(receipt.paymentId) : null,
      command: String(receipt.command ?? "print_receipt"),
      status: String(receipt.status ?? receipt.fiscalStatus ?? "UNKNOWN"),
      responseCode: String(receipt.responseCode ?? "UNKNOWN"),
      responseMessage: String(receipt.responseMessage ?? "Stato fiscale non verificato."),
      fiscalStatus: String(receipt.fiscalStatus ?? receipt.status ?? "UNKNOWN").toUpperCase(),
      fiscalProvider: receipt.fiscalProvider ? String(receipt.fiscalProvider).trim() : null,
      fiscalDeviceId: receipt.fiscalDeviceId ? normalizeConfigId(receipt.fiscalDeviceId, "") : null,
      fiscalApiBaseUrl: receipt.fiscalApiBaseUrl
        ? String(receipt.fiscalApiBaseUrl).trim().replace(/\/+$/, "").slice(0, 180)
        : null,
      fiscalStatusEndpoint: receipt.fiscalStatusEndpoint
        ? normalizePosFiscalApiPath(receipt.fiscalStatusEndpoint, "/api/fiscal/status").slice(0, 120)
        : null,
      fiscalVerifyEndpoint: receipt.fiscalVerifyEndpoint
        ? normalizePosFiscalApiPath(receipt.fiscalVerifyEndpoint, "/api/fiscal/receipt/verify").slice(0, 120)
        : null,
      fiscalReceiptEndpoint: receipt.fiscalReceiptEndpoint
        ? normalizePosFiscalApiPath(receipt.fiscalReceiptEndpoint, "/api/fiscal/receipt").slice(0, 120)
        : null,
      fiscalReprintEndpoint: receipt.fiscalReprintEndpoint
        ? normalizePosFiscalApiPath(receipt.fiscalReprintEndpoint, "/api/fiscal/reprint").slice(0, 120)
        : null,
      fiscalVoidEndpoint: receipt.fiscalVoidEndpoint
        ? normalizePosFiscalApiPath(receipt.fiscalVoidEndpoint, "/api/fiscal/void").slice(0, 120)
        : null,
      fiscalProviderRef: fiscalProviderRef || null,
      fiscalMovementId: fiscalMovementId || null,
      fiscalReceiptDate: fiscalReceiptDate || null,
      fiscalDocumentNumber: fiscalDocumentNumber || null,
      fiscalError: receipt.fiscalError ? String(receipt.fiscalError).slice(0, 240) : null,
      requiresFiscalRetry: receipt.requiresFiscalRetry === true,
      fiscalRequestId: fiscalRequestId || null,
      idempotencyKey: idempotencyKey || null,
      payloadSnapshot: cloneJsonObject(receipt.payloadSnapshot),
      payloadHash: firstFiscalApiScalar(receipt.payloadHash) || null,
      attemptCount,
      lastAttemptAt: firstFiscalApiScalar(receipt.lastAttemptAt) || null,
      nextRetryAt: firstFiscalApiScalar(receipt.nextRetryAt) || null,
      retryCutoffAt: firstFiscalApiScalar(receipt.retryCutoffAt) || null,
      manualRetryStartedAt: firstFiscalApiScalar(receipt.manualRetryStartedAt) || null,
      voidStatus: firstFiscalApiScalar(receipt.voidStatus) || null,
      voidRequestId: firstFiscalApiScalar(receipt.voidRequestId) || null,
      voidRequestedAt: firstFiscalApiScalar(receipt.voidRequestedAt) || null,
      voidedAt: firstFiscalApiScalar(receipt.voidedAt) || null,
      voidedByUserId: firstFiscalApiScalar(receipt.voidedByUserId) || null,
      voidedByUsername: firstFiscalApiScalar(receipt.voidedByUsername) || null,
      voidReason: firstFiscalApiScalar(receipt.voidReason) || null,
      voidProviderRef: firstFiscalApiScalar(receipt.voidProviderRef) || null,
      voidMovementId: firstFiscalApiScalar(receipt.voidMovementId) || null,
      voidReceiptDate: firstFiscalApiScalar(receipt.voidReceiptDate) || null,
      voidDocumentNumber: firstFiscalApiScalar(receipt.voidDocumentNumber) || null,
      voidError: receipt.voidError ? String(receipt.voidError).slice(0, 240) : null,
      createdAt: String(receipt.createdAt ?? nowIso()),
    };
  }

  return {
    firstFiscalApiScalar,
    normalizeFiscalApiScalar,
    sanitizeFiscalReceipt,
  };
}
