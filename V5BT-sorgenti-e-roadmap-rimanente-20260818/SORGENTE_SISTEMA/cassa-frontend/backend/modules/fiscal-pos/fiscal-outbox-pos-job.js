const POS_FISCAL_API_PROVIDER = "pos-fiscal-api";

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeLower(value, fallback = "") {
  return normalizeText(value, fallback).toLowerCase();
}

function firstText(...values) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return "";
}

function objectFrom(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function cloneJsonObject(value) {
  const source = objectFrom(value);
  if (!source) return null;
  try {
    return JSON.parse(JSON.stringify(source));
  } catch {
    return null;
  }
}

function firstObject(...values) {
  for (const value of values) {
    const object = objectFrom(value);
    if (object) return object;
  }
  return null;
}

function normalizePosFiscalApiPath(pathname, fallback) {
  const normalized = normalizeText(pathname);
  return normalized.startsWith("/") ? normalized : fallback;
}

function buildDeviceFromReceipt(receipt = {}, rawReceipt = {}) {
  const id = firstText(
    receipt.fiscalDeviceId,
    rawReceipt.fiscalDeviceId,
    receipt.fiscalDevice?.id,
    rawReceipt.fiscalDevice?.id,
  );
  const apiBaseUrl = firstText(
    receipt.fiscalApiBaseUrl,
    rawReceipt.fiscalApiBaseUrl,
    receipt.fiscalDevice?.apiBaseUrl,
    rawReceipt.fiscalDevice?.apiBaseUrl,
  ).replace(/\/+$/, "");
  if (!id || !apiBaseUrl) return null;
  return {
    id,
    apiBaseUrl,
    statusEndpoint: normalizePosFiscalApiPath(
      firstText(receipt.fiscalStatusEndpoint, rawReceipt.fiscalStatusEndpoint),
      "/api/fiscal/status",
    ),
    verifyEndpoint: normalizePosFiscalApiPath(
      firstText(receipt.fiscalVerifyEndpoint, rawReceipt.fiscalVerifyEndpoint),
      "/api/fiscal/receipt/verify",
    ),
    receiptEndpoint: normalizePosFiscalApiPath(
      firstText(receipt.fiscalReceiptEndpoint, rawReceipt.fiscalReceiptEndpoint),
      "/api/fiscal/receipt",
    ),
    reprintEndpoint: normalizePosFiscalApiPath(
      firstText(receipt.fiscalReprintEndpoint, rawReceipt.fiscalReprintEndpoint),
      "/api/fiscal/reprint",
    ),
  };
}

function buildUnsupportedResult(reason, message) {
  return {
    ok: false,
    reason,
    errorCode: `FISCAL_OUTBOX_${String(reason).toUpperCase()}`,
    errorMessage: message,
  };
}

export function buildPosFiscalJobFromFiscalOutboxEntry(entry = {}) {
  const payload = objectFrom(entry.payload) ?? {};
  const receipt = firstObject(payload.receipt, payload.rawReceipt) ?? {};
  const rawReceipt = firstObject(receipt.rawJson, receipt.raw, receipt) ?? {};
  const receiptPayload = firstObject(receipt.payload, payload.receiptPayload) ?? {};
  const payloadSnapshot =
    firstObject(
      rawReceipt.payloadSnapshot,
      receipt.payloadSnapshot,
      receiptPayload.payloadSnapshot,
      payload.payloadSnapshot,
    ) ?? null;
  const fiscalProvider = normalizeLower(
    firstText(receipt.fiscalProvider, rawReceipt.fiscalProvider, payload.fiscalProvider),
  );
  if (fiscalProvider && fiscalProvider !== POS_FISCAL_API_PROVIDER) {
    return buildUnsupportedResult(
      "unsupported_provider",
      `Provider fiscale non gestito dalla fiscal_outbox POS: ${fiscalProvider}.`,
    );
  }

  const command = normalizeLower(firstText(receipt.command, rawReceipt.command, payload.command));
  if (command && command !== "pos_receipt") {
    return buildUnsupportedResult(
      "unsupported_command",
      `Comando fiscale non gestito dalla fiscal_outbox POS: ${command}.`,
    );
  }

  const paymentId = firstText(
    entry.paymentId,
    payload.paymentTransactionId,
    receipt.paymentTransactionId,
    receipt.paymentId,
    rawReceipt.paymentId,
  );
  if (!paymentId) {
    return buildUnsupportedResult(
      "missing_payment_id",
      "Payment transaction id mancante nella riga fiscal_outbox.",
    );
  }

  const jobPayload = cloneJsonObject(payloadSnapshot);
  if (!jobPayload || !Array.isArray(jobPayload.items) || jobPayload.items.length === 0) {
    return buildUnsupportedResult(
      "missing_payload_snapshot",
      "Payload fiscale POS mancante o privo di articoli.",
    );
  }

  const fiscalDevice = buildDeviceFromReceipt(receipt, rawReceipt);
  if (!fiscalDevice) {
    return buildUnsupportedResult(
      "missing_fiscal_device",
      "Configurazione RT mancante nella ricevuta fiscale relazionale.",
    );
  }

  return {
    ok: true,
    receiptId: firstText(payload.receiptId, receipt.id, rawReceipt.id, entry.aggregateId),
    job: {
      paymentId,
      paymentContainerId: firstText(
        payload.paymentContainerId,
        receipt.paymentContainerId,
        rawReceipt.paymentContainerId,
      ),
      orderId: firstText(jobPayload.orderId, payload.orderId, receipt.orderId, rawReceipt.orderId),
      issuedBy: firstText(payload.issuedBy, receipt.issuedBy, rawReceipt.issuedBy),
      payload: jobPayload,
      fiscalDevice,
      idempotencyKey: firstText(
        receipt.idempotencyKey,
        rawReceipt.idempotencyKey,
        receipt.fiscalRequestId,
        rawReceipt.fiscalRequestId,
        payload.idempotencyKey,
      ),
      receiptSnapshot: cloneJsonObject(receipt),
    },
  };
}

export function recoverPendingPosFiscalReceiptFromJob(
  db,
  job,
  { findReceipt, sanitizeReceipt } = {},
) {
  if (!db || typeof db !== "object") return null;
  const paymentId = firstText(job?.paymentId);
  if (!paymentId) return null;
  const existing = typeof findReceipt === "function" ? findReceipt(db, paymentId) : null;
  if (existing) return existing;
  if (typeof sanitizeReceipt !== "function") return null;
  const snapshot = cloneJsonObject(job?.receiptSnapshot);
  if (!snapshot) return null;
  const recovered = sanitizeReceipt(snapshot, firstText(snapshot.id, `fiscal_${paymentId}`));
  if (!recovered || firstText(recovered.paymentId) !== paymentId) return null;
  if (!Array.isArray(db.fiscalReceipts)) db.fiscalReceipts = [];
  db.fiscalReceipts.push(recovered);
  return recovered;
}

export function mapPosFiscalReceiptToOutboxWorkerResult({
  entry = {},
  job = {},
  issueResult = null,
  receipt = null,
} = {}) {
  if (issueResult?.retry === true) {
    return {
      status: "retrying",
      errorCode: "POS_FISCAL_RETRY",
      errorMessage: "Emissione fiscale POS in retry.",
      retryDelayMs: issueResult.delayMs,
      payload: {
        ...entry.payload,
        worker: {
          provider: POS_FISCAL_API_PROVIDER,
          paymentId: job.paymentId,
          retry: true,
          updatedAt: new Date().toISOString(),
        },
      },
    };
  }

  const fiscalStatus = normalizeText(
    receipt?.fiscalStatus ?? receipt?.status ?? issueResult?.receipt?.fiscalStatus,
  ).toUpperCase();
  const requiresRetry = receipt?.requiresFiscalRetry === true || issueResult?.requiresRetry === true;
  const providerRef = firstText(
    receipt?.fiscalProviderRef,
    receipt?.fiscalMovementId,
    receipt?.fiscalDocumentNumber,
  );
  const payload = {
    ...entry.payload,
    fiscalStatus: fiscalStatus || null,
    fiscalDocumentNumber: receipt?.fiscalDocumentNumber ?? providerRef ?? null,
    receipt: receipt ?? entry.payload?.receipt ?? null,
    worker: {
      provider: POS_FISCAL_API_PROVIDER,
      paymentId: job.paymentId,
      updatedAt: new Date().toISOString(),
    },
  };

  if (fiscalStatus === "ISSUED" || issueResult?.issued === true) {
    return {
      status: "issued",
      issuedAt: firstText(receipt?.issuedAt, receipt?.createdAt) || undefined,
      payload,
    };
  }

  if (["PENDING", "PROCESSING"].includes(fiscalStatus) || requiresRetry) {
    return {
      status: "retrying",
      errorCode: "POS_FISCAL_PENDING",
      errorMessage: "Emissione fiscale POS ancora pendente o recuperabile.",
      retryDelayMs: issueResult?.delayMs,
      payload,
    };
  }

  if (["FAILED_CONFIGURATION", "EXPIRED"].includes(fiscalStatus)) {
    return {
      status: "manual_required",
      errorCode: fiscalStatus,
      errorMessage: receipt?.fiscalError ?? receipt?.responseMessage ?? "Emissione fiscale POS non recuperabile automaticamente.",
      payload,
    };
  }

  if (fiscalStatus.includes("FAIL") || fiscalStatus.includes("ERROR")) {
    return {
      status: "failed",
      errorCode: fiscalStatus || "POS_FISCAL_FAILED",
      errorMessage: receipt?.fiscalError ?? receipt?.responseMessage ?? "Emissione fiscale POS fallita.",
      payload,
    };
  }

  return {
    status: "retrying",
    errorCode: "POS_FISCAL_STATUS_UNKNOWN",
    errorMessage: "Stato fiscale POS non ancora determinato.",
    retryDelayMs: issueResult?.delayMs,
    payload,
  };
}
