function scalar(value) {
  if (value === null || value === undefined) return "";
  if (!["string", "number", "bigint"].includes(typeof value)) return "";
  const text = String(value).trim();
  return text === "[object Object]" ? "" : text;
}

function normalizeReceiptDate(value) {
  const raw = scalar(value);
  if (!raw) return "";
  const isoDate = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDate) return isoDate[1];
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : "";
}

function normalizeDocumentNumber(value) {
  const raw = scalar(value);
  if (!raw || /^MF\d+/i.test(raw)) return "";
  return raw.match(/(\d+)\s*$/)?.[1] ?? "";
}

export function isFiscalReceiptVoided(receipt) {
  return (
    String(receipt?.fiscalStatus ?? "").trim().toUpperCase() === "VOIDED" ||
    String(receipt?.voidStatus ?? "").trim().toUpperCase() === "VOIDED"
  );
}

export function resolveFiscalReprintTarget(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  const documentKind = isFiscalReceiptVoided(receipt) ? "void" : "receipt";
  const providerRef = scalar(
    documentKind === "void"
      ? receipt.voidProviderRef
      : receipt.fiscalProviderRef,
  );
  const movementId = scalar(
    documentKind === "void"
      ? receipt.voidMovementId
      : receipt.fiscalMovementId,
  );
  const movementCandidate =
    movementId || (/^MF\d+/i.test(providerRef) ? providerRef : "");
  const receiptDate = normalizeReceiptDate(
    documentKind === "void"
      ? receipt.voidReceiptDate ?? receipt.voidedAt
      : receipt.fiscalReceiptDate ?? receipt.createdAt,
  );
  const documentNumber =
    normalizeDocumentNumber(
      documentKind === "void"
        ? receipt.voidDocumentNumber
        : receipt.fiscalDocumentNumber,
    ) || normalizeDocumentNumber(providerRef);

  const request = movementCandidate
    ? { movementId: movementCandidate }
    : receiptDate && documentNumber
      ? { receiptDate, documentNumber }
      : null;
  if (!request) return null;

  return {
    documentKind,
    request,
    providerRef: providerRef || null,
    movementId: movementId || null,
    receiptDate: receiptDate || null,
    documentNumber: documentNumber || null,
  };
}

export function findReprintableFiscalReceipts(
  db,
  paymentIds,
  { provider, sanitizeFiscalReceipt },
) {
  const normalizedIds = new Set(
    (Array.isArray(paymentIds) ? paymentIds : [paymentIds])
      .map((entry) => scalar(entry))
      .filter(Boolean),
  );
  if (normalizedIds.size === 0) return [];
  const seen = new Set();
  return (Array.isArray(db?.fiscalReceipts) ? db.fiscalReceipts : [])
    .map((receipt, index) =>
      sanitizeFiscalReceipt(receipt, `fiscal_${index + 1}`),
    )
    .filter(
      (receipt) =>
        receipt &&
        normalizedIds.has(scalar(receipt.paymentId)) &&
        receipt.fiscalProvider === provider &&
        (receipt.fiscalStatus === "ISSUED" ||
          isFiscalReceiptVoided(receipt)) &&
        receipt.requiresFiscalRetry !== true,
    )
    .filter((receipt) => {
      const key = `${receipt.paymentId ?? ""}|${receipt.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function findFiscalReferencePatchFromEvents(
  db,
  paymentId,
  receiptId,
  {
    documentKind = "receipt",
    extractReferences,
    provider,
  },
) {
  const normalizedPaymentId = scalar(paymentId);
  const normalizedReceiptId = scalar(receiptId);
  if (!normalizedPaymentId && !normalizedReceiptId) return null;
  const wantsVoid = documentKind === "void";
  const events = Array.isArray(db?.fiscalEvents) ? db.fiscalEvents : [];

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.provider !== provider) continue;
    const command = scalar(event.command).toLowerCase();
    const result = scalar(event.result).toLowerCase();
    if (wantsVoid) {
      if (command !== "pos_receipt_void" || result !== "voided") continue;
    } else if (
      command === "pos_receipt_void" ||
      command === "pos_receipt_reprint"
    ) {
      continue;
    }
    const paymentMatches =
      normalizedPaymentId && scalar(event.paymentId) === normalizedPaymentId;
    const receiptMatches =
      normalizedReceiptId &&
      scalar(event.payload?.receiptId) === normalizedReceiptId;
    if (!paymentMatches && !receiptMatches) continue;
    const references = extractReferences(event.payload?.response);
    if (
      !references?.fiscalMovementId &&
      !(references?.fiscalReceiptDate && references?.fiscalDocumentNumber)
    ) {
      continue;
    }
    return wantsVoid
      ? {
          voidProviderRef: references.fiscalProviderRef,
          voidMovementId: references.fiscalMovementId,
          voidReceiptDate: references.fiscalReceiptDate,
          voidDocumentNumber: references.fiscalDocumentNumber,
        }
      : references;
  }
  return null;
}

export function buildFiscalReprintJobKey(job = {}) {
  const paymentId = scalar(job.paymentId);
  const receiptId = scalar(job.receiptId);
  const documentKind =
    scalar(job.documentKind).toLowerCase() === "void" ? "void" : "receipt";
  return paymentId && receiptId
    ? `${paymentId}:${receiptId}:${documentKind}`
    : "";
}
