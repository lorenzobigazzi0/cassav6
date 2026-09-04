export const DEFAULT_POS_FISCAL_VERIFY_ENDPOINT =
  "/api/fiscal/receipt/verify";

const ISSUE_STATES = new Set([
  "ISSUED",
  "PROCESSING",
  "NOT_FOUND",
  "FAILED",
]);
const VOID_STATES = new Set([
  "VOIDED",
  "PROCESSING",
  "NOT_FOUND",
  "FAILED",
]);

function objectFrom(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function firstText(...values) {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized && normalized !== "[object Object]") return normalized;
  }
  return "";
}

function normalizeOperation(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase() === "void"
    ? "void"
    : "issue";
}

function normalizeState(value, operation) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (["ISSUED", "EMITTED"].includes(normalized)) return "ISSUED";
  if (["VOIDED", "CANCELLED", "CANCELED", "ANNULLED"].includes(normalized)) {
    return "VOIDED";
  }
  if (["PROCESSING", "PENDING", "QUEUED", "IN_PROGRESS"].includes(normalized)) {
    return "PROCESSING";
  }
  if (["NOT_FOUND", "MISSING", "ABSENT"].includes(normalized)) {
    return "NOT_FOUND";
  }
  if (["FAILED", "ERROR", "REJECTED"].includes(normalized)) return "FAILED";
  if (["COMPLETED", "SUCCESS", "SUCCEEDED"].includes(normalized)) {
    return operation === "void" ? "VOIDED" : "ISSUED";
  }
  return normalized;
}

function normalizeDocument(value) {
  const source = objectFrom(value) ?? {};
  const movement = objectFrom(source.movement) ?? {};
  const rawDocumentInfo = objectFrom(movement.rawDocumentInfo) ?? {};
  return {
    providerRef:
      firstText(
        source.providerRef,
        source.fiscalProviderRef,
        source.receiptId,
        source.documentId,
        source.reference,
        rawDocumentInfo.reference,
      ) || null,
    movementId:
      firstText(
        source.movementId,
        source.movement_id,
        source.fiscalMovementId,
        movement.id,
        movement.movementId,
      ) || null,
    receiptDate:
      firstText(
        source.receiptDate,
        source.documentDate,
        source.date,
        source.fiscalReceiptDate,
        movement.documentDate,
      ) || null,
    documentNumber:
      firstText(
        source.documentNumber,
        source.documentNo,
        source.receiptNumber,
        source.fiscalDocumentNumber,
        movement.documentNumber,
      ) || null,
  };
}

function compactDocument(value) {
  const normalized = normalizeDocument(value);
  return Object.fromEntries(
    Object.entries(normalized).filter(([, entry]) => Boolean(entry)),
  );
}

export function buildPosFiscalVerificationRequest({
  operation,
  paymentId,
  receiptId,
  idempotencyKey,
  fiscalRequestId,
  payloadHash,
  originalDocument,
} = {}) {
  const normalizedOperation = normalizeOperation(operation);
  const normalizedIdempotencyKey = firstText(idempotencyKey, fiscalRequestId);
  if (!normalizedIdempotencyKey) {
    throw new Error(
      "Idempotency key fiscale mancante: verifica autorevole impossibile.",
    );
  }
  const normalizedOriginalDocument = compactDocument(originalDocument);
  return {
    schemaVersion: 1,
    operation: normalizedOperation,
    idempotencyKey: normalizedIdempotencyKey,
    fiscalRequestId:
      firstText(fiscalRequestId, normalizedIdempotencyKey) ||
      normalizedIdempotencyKey,
    paymentId: firstText(paymentId) || null,
    receiptId: firstText(receiptId) || null,
    payloadHash: firstText(payloadHash) || null,
    ...(Object.keys(normalizedOriginalDocument).length > 0
      ? { originalDocument: normalizedOriginalDocument }
      : {}),
  };
}

export function normalizePosFiscalVerificationResponse(
  value,
  { operation, idempotencyKey } = {},
) {
  const source = objectFrom(value);
  if (!source || source.ok !== true || source.authoritative !== true) {
    throw new Error(
      "Il gateway fiscale non ha restituito una verifica autorevole.",
    );
  }
  const normalizedOperation = normalizeOperation(operation ?? source.operation);
  const responseOperation = source.operation
    ? normalizeOperation(source.operation)
    : normalizedOperation;
  if (responseOperation !== normalizedOperation) {
    throw new Error("Il gateway fiscale ha risposto per un'operazione diversa.");
  }
  const expectedKey = firstText(idempotencyKey);
  const responseKey = firstText(source.idempotencyKey, source.fiscalRequestId);
  if (expectedKey && responseKey && expectedKey !== responseKey) {
    throw new Error(
      "La risposta del gateway fiscale non corrisponde alla richiesta idempotente.",
    );
  }

  const state = normalizeState(
    source.state ?? source.operationStatus ?? source.status,
    normalizedOperation,
  );
  const allowedStates =
    normalizedOperation === "void" ? VOID_STATES : ISSUE_STATES;
  if (!allowedStates.has(state)) {
    throw new Error(
      `Stato fiscale autorevole non supportato: ${state || "vuoto"}.`,
    );
  }

  const found =
    state === "NOT_FOUND"
      ? false
      : source.found === false
        ? false
        : true;
  if (state !== "NOT_FOUND" && !found) {
    throw new Error(
      "Risposta fiscale incoerente: stato presente ma record dichiarato assente.",
    );
  }
  const documentSource =
    objectFrom(source.document) ??
    objectFrom(source.receipt) ??
    objectFrom(source.result) ??
    source;
  const retryable = source.retryable === true;
  const sideEffectApplied = source.sideEffectApplied === true;

  return {
    authoritative: true,
    operation: normalizedOperation,
    idempotencyKey: responseKey || expectedKey,
    state,
    found,
    retryable,
    sideEffectApplied,
    canWrite:
      state === "NOT_FOUND" ||
      (state === "FAILED" && retryable && !sideEffectApplied),
    message: firstText(source.message, source.error),
    completedAt:
      firstText(source.completedAt, source.updatedAt, source.createdAt) || null,
    document: normalizeDocument(documentSource),
    raw: source,
  };
}

export async function requestPosFiscalVerification({
  fetchJson,
  fiscalDevice,
  operation,
  paymentId,
  receiptId,
  idempotencyKey,
  fiscalRequestId,
  payloadHash,
  originalDocument,
} = {}) {
  if (typeof fetchJson !== "function") {
    throw new Error("Client gateway fiscale non disponibile.");
  }
  const request = buildPosFiscalVerificationRequest({
    operation,
    paymentId,
    receiptId,
    idempotencyKey,
    fiscalRequestId,
    payloadHash,
    originalDocument,
  });
  try {
    const response = await fetchJson(
      firstText(fiscalDevice?.verifyEndpoint) ||
        DEFAULT_POS_FISCAL_VERIFY_ENDPOINT,
      {
        method: "POST",
        body: request,
        baseUrl: fiscalDevice?.apiBaseUrl,
        idempotencyKey: request.idempotencyKey,
        fiscalDeviceId: fiscalDevice?.id,
      },
    );
    return {
      supported: true,
      request,
      ...normalizePosFiscalVerificationResponse(response, {
        operation: request.operation,
        idempotencyKey: request.idempotencyKey,
      }),
    };
  } catch (error) {
    if (Number(error?.status) === 404) {
      return {
        supported: false,
        request,
        reason: "verify_endpoint_not_found",
        error,
      };
    }
    throw error;
  }
}

export function buildFiscalReceiptPatchFromVerification(
  verification,
  { nowIso = () => new Date().toISOString() } = {},
) {
  if (!verification?.authoritative) return null;
  const document = verification.document ?? {};
  if (
    verification.operation === "issue" &&
    verification.state === "ISSUED"
  ) {
    return {
      status: "ISSUED",
      fiscalStatus: "ISSUED",
      responseCode:
        document.providerRef ||
        document.documentNumber ||
        "FISCAL_VERIFY_ISSUED",
      responseMessage:
        verification.message ||
        "Documento fiscale riconciliato con il gateway.",
      fiscalProviderRef: document.providerRef,
      fiscalMovementId: document.movementId,
      fiscalReceiptDate: document.receiptDate,
      fiscalDocumentNumber: document.documentNumber,
      fiscalError: null,
      requiresFiscalRetry: false,
      nextRetryAt: null,
    };
  }
  if (
    verification.operation === "void" &&
    verification.state === "VOIDED"
  ) {
    return {
      status: "VOIDED",
      fiscalStatus: "VOIDED",
      responseCode:
        document.providerRef ||
        document.documentNumber ||
        "FISCAL_VERIFY_VOIDED",
      responseMessage:
        verification.message ||
        "Annullamento fiscale riconciliato con il gateway.",
      voidStatus: "VOIDED",
      voidedAt: verification.completedAt || nowIso(),
      voidProviderRef: document.providerRef,
      voidMovementId: document.movementId,
      voidReceiptDate: document.receiptDate,
      voidDocumentNumber: document.documentNumber,
      voidError: null,
      requiresFiscalRetry: false,
    };
  }
  if (verification.state === "PROCESSING") {
    return verification.operation === "void"
      ? {
          status: "ISSUED",
          fiscalStatus: "ISSUED",
          voidStatus: "PROCESSING",
          voidError: null,
        }
      : {
          status: "PROCESSING",
          fiscalStatus: "PROCESSING",
          responseCode: "FISCAL_VERIFY_PROCESSING",
          responseMessage:
            verification.message ||
            "Operazione fiscale ancora in elaborazione sul gateway.",
          requiresFiscalRetry: true,
        };
  }
  if (verification.state === "FAILED") {
    return verification.operation === "void"
      ? {
          status: "ISSUED",
          fiscalStatus: "ISSUED",
          voidStatus: "FAILED",
          voidError:
            verification.message ||
            "Annullamento fiscale rifiutato dal gateway.",
        }
      : {
          status: "FAILED",
          fiscalStatus: "FAILED",
          responseCode: "FISCAL_VERIFY_FAILED",
          responseMessage:
            verification.message || "Operazione fiscale fallita sul gateway.",
          fiscalError:
            verification.message || "Operazione fiscale fallita sul gateway.",
          requiresFiscalRetry: verification.retryable === true,
        };
  }
  return null;
}
