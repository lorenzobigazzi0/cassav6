/**
 * Modello delle tre route fiscali sui movimenti di pagamento
 * (P2b, dominio `fiscal`): emissione, annullamento e verifica.
 *
 * Possiede l'unico accesso all'app-state delle tre route. Con loro sono
 * arrivate le sei funzioni del loro grappolo e la costante dei domini di
 * scrittura, che serviva solo a `persistMovementFiscalState`.
 *
 * `resolvePaymentsReportReadDb` e arrivata qui pur non essendo del dominio:
 * era locale alla factory e la usano anche altre route, che ora la ricevono
 * indietro da questo modello. Il composition root non avrebbe potuto
 * passarla, perche non esiste al suo livello.
 *
 * Tutte e otto le risposte erano 200: i modelli restituiscono il corpo e i
 * handler lo inviano, senza busta.
 *
 * Da conoscere: lo stato fiscale viene aggiornato **solo dopo la risposta
 * reale del gateway** -- e il contratto che
 * `backend/tests/payment-movement-fiscal-actions.test.mjs` verifica leggendo
 * questo file.
 */
import {
  buildFiscalReceiptPatchFromVerification,
  requestPosFiscalVerification,
} from "../fiscal-pos/fiscal-verification.js";
import {
  assertFiscalProviderRealMode,
  FISCAL_PROVIDER_DRY_RUN_CODE,
} from "../fiscal-pos/fiscal.domain.js";

export function createPaymentsFiscalModel({
  HttpError,
  appendAuditEvent,
  appendPosFiscalEvent,
  buildAuditActor,
  buildPosFiscalReprintJobsForPaymentContainer,
  buildRecoveredPosFiscalJob,
  buildRelationalPaymentsReportDb,
  collectPaymentPartsAndTransactionsForContainer,
  ensureFiscalTrackingArrays,
  ensurePaymentTrackingArrays,
  extractPosFiscalReferenceFromApiResponse,
  fetchPosFiscalApiJson,
  findPaymentMethod,
  findPaymentReprintContainer,
  findPosFiscalReceiptByPaymentId,
  fiscalRealIoDisabled,
  linkPosFiscalReceiptToPaymentRecords,
  mapPaymentMethodToTransactionType,
  maybeIssuePosFiscalReceipt,
  normalizePaymentMethodType,
  normalizePaymentMovementId,
  nowIso,
  readDb,
  relationalPaymentsReportsReadEnabled,
  sanitizeFiscalReceipt,
  sanitizePosSettings,
  updatePosFiscalReceiptByPaymentId,
  validateSessionContext,
  writePaymentDb,
}) {
  const PAYMENT_MOVEMENT_FISCAL_WRITE_SPLIT_DOMAINS = [
  "payments",
  "paymentContainers",
  "fiscalReceipts",
  "fiscalEvents",
  "auditEvents",
];

async function resolvePaymentsReportReadDb(db) {
  if (!relationalPaymentsReportsReadEnabled || typeof buildRelationalPaymentsReportDb !== "function") return db;
  try {
    return (await buildRelationalPaymentsReportDb(db)) ?? db;
  } catch {
    return db;
  }
}

function hydrateMovementFiscalReceiptForWrite(db, receipt) {
  if (!receipt) return null;
  const paymentId = String(receipt.paymentId ?? "").trim();
  const existing = paymentId
    ? findPosFiscalReceiptByPaymentId(db, paymentId)
    : null;
  if (existing) return existing;
  const hydrated = sanitizeFiscalReceipt(
    receipt,
    receipt.id || `fiscal_${paymentId}`,
  );
  if (!hydrated) return null;
  db.fiscalReceipts.push(hydrated);
  return hydrated;
}

function originalFiscalDocumentFromReceipt(receipt) {
  return {
    providerRef: receipt?.fiscalProviderRef,
    movementId: receipt?.fiscalMovementId,
    receiptDate: receipt?.fiscalReceiptDate,
    documentNumber: receipt?.fiscalDocumentNumber,
  };
}

async function persistMovementFiscalState(db, metricLabel) {
  db.meta.lastWriteAt = nowIso();
  await writePaymentDb(db, {
    metricLabel,
    splitDomains: PAYMENT_MOVEMENT_FISCAL_WRITE_SPLIT_DOMAINS,
  });
}

function reconcileMovementFiscalReceipt({
  db,
  verification,
  job,
  receipt,
  context,
  user,
}) {
  const patch = buildFiscalReceiptPatchFromVerification(verification, {
    nowIso,
  });
  if (!patch) return receipt;
  const updatedReceipt = updatePosFiscalReceiptByPaymentId(
    db,
    job.paymentId,
    patch,
  );
  if (verification.operation === "issue" && verification.state === "ISSUED") {
    linkPosFiscalReceiptToPaymentRecords(db, updatedReceipt, {
      paymentId: job.paymentId,
      paymentContainerId: context.container.id,
      issuedBy: user.id,
    });
  }
  if (verification.operation === "void" && verification.state === "VOIDED") {
    const containerRecord = (
      Array.isArray(db.paymentContainers) ? db.paymentContainers : []
    ).find(
      (entry) =>
        String(entry?.id ?? "").trim() === String(context.container.id).trim(),
    );
    if (containerRecord) {
      containerRecord.fiscalVoidStatus = "VOIDED";
      containerRecord.fiscalVoidedAt = updatedReceipt?.voidedAt ?? nowIso();
      containerRecord.fiscalVoidedByUserId = user.id;
    }
  }
  appendPosFiscalEvent(db, {
    paymentId: job.paymentId,
    orderId: job.orderId,
    command:
      verification.operation === "void"
        ? "pos_receipt_void"
        : "pos_receipt",
    result: `${verification.operation}_${String(
      verification.state,
    ).toLowerCase()}_reconciled`,
    message:
      verification.message ||
      "Stato fiscale riconciliato con il gateway autorevole.",
    requiresFiscalRetry: verification.state === "PROCESSING",
    payload: {
      receiptId: updatedReceipt?.id ?? null,
      verification: verification.raw ?? null,
    },
  });
  return updatedReceipt;
}

async function resolveMovementFiscalActionContext(db, movementId) {
  const paymentsReadDb = await resolvePaymentsReportReadDb(db);
  const container = findPaymentReprintContainer(paymentsReadDb, movementId);
  if (!container || container.status !== "COMPLETED") {
    throw new HttpError(404, "Pagamento completato non trovato.");
  }
  const settings = sanitizePosSettings(db.posSettings, {
    menuItems: db.menuItems,
    users: db.users,
  });
  const { transactions } = collectPaymentPartsAndTransactionsForContainer(
    paymentsReadDb,
    container.id,
  );
  const method = findPaymentMethod(settings, container.paymentMethod) ?? null;
  const sourceTransactions = transactions.length
    ? transactions
    : [
        {
          id: container.id,
          method: mapPaymentMethodToTransactionType(
            method?.id ?? container.paymentMethod,
            method?.label ?? container.paymentMethod,
          ),
          amountPaid: container.amount,
        },
      ];
  const fiscalTransactions = sourceTransactions.filter((transaction) =>
    ["CASH", "POS"].includes(normalizePaymentMethodType(transaction.method)),
  );
  if (fiscalTransactions.length === 0) {
    throw new HttpError(409, "Il pagamento non contiene transazioni fiscalizzabili.");
  }
  return { container, fiscalTransactions, method, paymentsReadDb, settings };
}

async function verifyMovementFiscalOperation({
  operation,
  job,
  receipt,
  idempotencyKey,
}) {
  if (!job?.fiscalDevice) {
    throw new HttpError(
      409,
      "Configurazione RT non disponibile per la verifica fiscale.",
    );
  }
  return requestPosFiscalVerification({
    fetchJson: fetchPosFiscalApiJson,
    fiscalDevice: job.fiscalDevice,
    operation,
    paymentId: job.paymentId,
    receiptId: receipt?.id ?? job.receiptId,
    idempotencyKey,
    fiscalRequestId: receipt?.fiscalRequestId,
    payloadHash: receipt?.payloadHash,
    originalDocument:
      operation === "void"
        ? originalFiscalDocumentFromReceipt(receipt)
        : undefined,
  });
}

async function issueMovementFiscal(payload) {
  const movementId = normalizePaymentMovementId(
    payload.paymentId ?? payload.movementId ?? payload.recordId ?? payload.id,
  );
  if (!movementId) throw new HttpError(400, "Movimento pagamento non valido.");
  if (fiscalRealIoDisabled) {
    throw new HttpError(503, "Emissione fiscale reale disabilitata in questo ambiente.");
  }
  const db = await readDb();
  ensurePaymentTrackingArrays(db);
  ensureFiscalTrackingArrays(db);
  const { user, session } = validateSessionContext(db, payload);
  const actor = buildAuditActor(user, payload);
  const context = await resolveMovementFiscalActionContext(db, movementId);
  const candidateIds = [
    ...context.fiscalTransactions.map((transaction) => String(transaction.id ?? "").trim()),
    String(context.container.clientPaymentId ?? "").trim(),
    context.container.id,
  ].filter(Boolean);
  let receipt = null;
  for (const paymentId of candidateIds) {
    receipt =
      findPosFiscalReceiptByPaymentId(db, paymentId) ??
      findPosFiscalReceiptByPaymentId(context.paymentsReadDb, paymentId);
    if (receipt && String(receipt.voidStatus ?? "").toUpperCase() !== "VOIDED") break;
  }
  if (receipt?.fiscalStatus === "ISSUED") {
    return { ok: true, idempotent: true, receipt };
  }
  receipt = hydrateMovementFiscalReceiptForWrite(db, receipt);
  const transaction =
    context.fiscalTransactions.find(
      (entry) => String(entry.id ?? "").trim() === String(receipt?.paymentId ?? "").trim(),
    ) ?? context.fiscalTransactions[0];
  let job = receipt ? buildRecoveredPosFiscalJob(db, receipt) : null;
  if (!job) {
    const issueResult = await maybeIssuePosFiscalReceipt(db, {
      paymentId: context.container.id,
      transactionId: transaction.id,
      orderId: context.container.orderId,
      orderIds: context.container.orderIds,
      articleUnitIds: context.container.articleUnitIds,
      amount: transaction.amountPaid ?? context.container.amount,
      methodType: transaction.method,
      paymentMethodId: context.method?.id ?? context.container.paymentMethod,
      paymentMethodLabel: context.method?.label ?? context.container.paymentMethod,
      issuedBy: user.id,
      deviceUuid: session.deviceUuid,
      deferSchedule: true,
    });
    receipt = issueResult?.receipt ?? receipt;
    job = issueResult?.backgroundJob ?? (receipt ? buildRecoveredPosFiscalJob(db, receipt) : null);
    if (issueResult?.issued === true && receipt) {
      await persistMovementFiscalState(db, "payments.movement.fiscalIssue.idempotentWrite");
      return { ok: true, idempotent: true, receipt };
    }
    if (!job) {
      await persistMovementFiscalState(db, "payments.movement.fiscalIssue.rejectedWrite");
      throw new HttpError(
        409,
        String(issueResult?.warning ?? receipt?.fiscalError ?? "Emissione fiscale non disponibile."),
      );
    }
  }
  if (!job.fiscalDevice || !job.payload) {
    throw new HttpError(409, "Configurazione o payload fiscale non disponibile.");
  }
  const priorAttemptCount = Math.max(
    0,
    Math.trunc(Number(receipt?.attemptCount) || 0),
  );
  updatePosFiscalReceiptByPaymentId(db, job.paymentId, {
    status: "PROCESSING",
    fiscalStatus: "PROCESSING",
    responseCode: "FISCAL_API_PROCESSING",
    responseMessage: "Emissione fiscale richiesta manualmente.",
    manualRetryStartedAt: nowIso(),
    attemptCount: priorAttemptCount + 1,
    lastAttemptAt: nowIso(),
    requiresFiscalRetry: false,
  });

  let verification = null;
  try {
    verification = await verifyMovementFiscalOperation({
      operation: "issue",
      job,
      receipt,
      idempotencyKey: job.idempotencyKey,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    receipt = updatePosFiscalReceiptByPaymentId(db, job.paymentId, {
      status: "FAILED",
      fiscalStatus: "FAILED",
      responseCode: "FISCAL_VERIFY_ERROR",
      responseMessage: "Verifica fiscale non disponibile.",
      fiscalError: message,
      requiresFiscalRetry: true,
    });
    appendPosFiscalEvent(db, {
      paymentId: job.paymentId,
      orderId: job.orderId,
      result: "manual_issue_verification_error",
      message,
      requiresFiscalRetry: true,
    });
    await persistMovementFiscalState(
      db,
      "payments.movement.fiscalIssue.verificationErrorWrite",
    );
    throw new HttpError(502, message, {
      code: "FISCAL_VERIFY_FAILED",
    });
  }

  if (verification.supported === false) {
    if (priorAttemptCount > 0) {
      const message =
        "Il gateway non espone la verifica fiscale: retry bloccato per evitare una doppia emissione.";
      receipt = updatePosFiscalReceiptByPaymentId(db, job.paymentId, {
        status: "FAILED",
        fiscalStatus: "FAILED",
        responseCode: "FISCAL_VERIFY_ENDPOINT_REQUIRED",
        responseMessage: message,
        fiscalError: message,
        requiresFiscalRetry: true,
      });
      await persistMovementFiscalState(
        db,
        "payments.movement.fiscalIssue.verifyEndpointRequiredWrite",
      );
      throw new HttpError(503, message, {
        code: "FISCAL_VERIFY_ENDPOINT_REQUIRED",
      });
    }
  } else if (verification.state === "ISSUED") {
    receipt = reconcileMovementFiscalReceipt({
      db,
      verification,
      job,
      receipt,
      context,
      user,
    });
    appendAuditEvent(db, {
      ...actor,
      action: "payment.fiscal_issue_reconciled",
      entityType: "payment",
      entityId: context.container.id,
      payload: {
        receiptId: receipt?.id ?? null,
        paymentId: job.paymentId,
      },
    });
    await persistMovementFiscalState(
      db,
      "payments.movement.fiscalIssue.reconciledWrite",
    );
    return {
      ok: true,
      idempotent: true,
      reconciled: true,
      receipt,
    };
  } else if (verification.state === "PROCESSING") {
    receipt = reconcileMovementFiscalReceipt({
      db,
      verification,
      job,
      receipt,
      context,
      user,
    });
    await persistMovementFiscalState(
      db,
      "payments.movement.fiscalIssue.processingReconciledWrite",
    );
    throw new HttpError(
      503,
      "Emissione ancora in elaborazione sul gateway fiscale.",
      { code: "FISCAL_VERIFY_PROCESSING" },
    );
  } else if (!verification.canWrite) {
    receipt = reconcileMovementFiscalReceipt({
      db,
      verification,
      job,
      receipt,
      context,
      user,
    });
    await persistMovementFiscalState(
      db,
      "payments.movement.fiscalIssue.failedReconciledWrite",
    );
    throw new HttpError(
      409,
      verification.message || "Il gateway fiscale ha rifiutato l'emissione.",
      { code: "FISCAL_VERIFY_REJECTED" },
    );
  }

  try {
    const status = await fetchPosFiscalApiJson(job.fiscalDevice.statusEndpoint, {
      baseUrl: job.fiscalDevice.apiBaseUrl,
      fiscalDeviceId: job.fiscalDevice.id,
    });
    assertFiscalProviderRealMode(status);
    if (status?.ok !== true || status?.fiscalApiEnabled !== true) {
      throw new Error(String(status?.message ?? status?.error ?? "Server fiscale non pronto."));
    }
    const response = await fetchPosFiscalApiJson(job.fiscalDevice.receiptEndpoint, {
      method: "POST",
      body: job.payload,
      baseUrl: job.fiscalDevice.apiBaseUrl,
      idempotencyKey: job.idempotencyKey,
      fiscalDeviceId: job.fiscalDevice.id,
    });
    if (response?.ok === false) {
      throw new Error(String(response?.message ?? response?.error ?? "Emissione fiscale rifiutata."));
    }
    const references = extractPosFiscalReferenceFromApiResponse(response);
    receipt = updatePosFiscalReceiptByPaymentId(db, job.paymentId, {
      status: "ISSUED",
      fiscalStatus: "ISSUED",
      responseCode: references.fiscalProviderRef || "FISCAL_API_OK",
      responseMessage: String(response?.message ?? "Scontrino fiscale emesso."),
      ...references,
      fiscalError: null,
      requiresFiscalRetry: false,
    });
    linkPosFiscalReceiptToPaymentRecords(db, receipt, {
      paymentId: job.paymentId,
      paymentContainerId: context.container.id,
      issuedBy: user.id,
    });
    appendPosFiscalEvent(db, {
      paymentId: job.paymentId,
      orderId: job.orderId,
      result: "issued_manual",
      message: "Scontrino fiscale emesso da dettaglio pagamento.",
      payload: { receiptId: receipt?.id ?? null, response },
    });
    appendAuditEvent(db, {
      ...actor,
      action: "payment.fiscal_issued_manual",
      entityType: "payment",
      entityId: context.container.id,
      payload: { receiptId: receipt?.id ?? null, paymentId: job.paymentId },
    });
    await persistMovementFiscalState(db, "payments.movement.fiscalIssue.appStateWrite");
    return { ok: true, receipt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dryRun = error?.code === FISCAL_PROVIDER_DRY_RUN_CODE;
    receipt = updatePosFiscalReceiptByPaymentId(db, job.paymentId, {
      status: "FAILED",
      fiscalStatus: "FAILED",
      responseCode: dryRun ? FISCAL_PROVIDER_DRY_RUN_CODE : "FISCAL_API_ERROR",
      responseMessage: "Scontrino fiscale non emesso.",
      fiscalError: message,
      requiresFiscalRetry: true,
    });
    appendPosFiscalEvent(db, {
      paymentId: job.paymentId,
      orderId: job.orderId,
      result: dryRun ? "manual_issue_dry_run" : "manual_issue_error",
      message,
      requiresFiscalRetry: true,
    });
    await persistMovementFiscalState(db, "payments.movement.fiscalIssue.errorWrite");
    throw new HttpError(dryRun ? 503 : 502, message, {
      code: dryRun ? FISCAL_PROVIDER_DRY_RUN_CODE : "FISCAL_ISSUE_FAILED",
    });
  }
}

async function voidMovementFiscal(payload) {
  const movementId = normalizePaymentMovementId(
    payload.paymentId ?? payload.movementId ?? payload.recordId ?? payload.id,
  );
  if (!movementId) throw new HttpError(400, "Movimento pagamento non valido.");
  if (fiscalRealIoDisabled) {
    throw new HttpError(503, "Annullamento fiscale reale disabilitato in questo ambiente.");
  }
  const db = await readDb();
  ensurePaymentTrackingArrays(db);
  ensureFiscalTrackingArrays(db);
  const { user } = validateSessionContext(db, payload);
  const actor = buildAuditActor(user, payload);
  const context = await resolveMovementFiscalActionContext(db, movementId);
  const jobs = buildPosFiscalReprintJobsForPaymentContainer(context.paymentsReadDb, {
    container: context.container,
    transactions: context.fiscalTransactions,
    movementId,
  });
  const requestedReceiptId = String(payload.receiptId ?? payload.fiscalReceiptId ?? "").trim();
  const job =
    jobs.find((entry) => requestedReceiptId && entry.receiptId === requestedReceiptId) ?? jobs[0];
  if (!job) throw new HttpError(409, "Documento fiscale non annullabile o riferimento mancante.");
  const currentReceipt = hydrateMovementFiscalReceiptForWrite(
    db,
    findPosFiscalReceiptByPaymentId(db, job.paymentId) ??
      findPosFiscalReceiptByPaymentId(context.paymentsReadDb, job.paymentId),
  );
  if (!currentReceipt) throw new HttpError(404, "Documento fiscale non trovato.");
  if (
    currentReceipt.fiscalStatus === "VOIDED" ||
    String(currentReceipt.voidStatus ?? "").toUpperCase() === "VOIDED"
  ) {
    return { ok: true, idempotent: true, receipt: currentReceipt };
  }
  if (!job.fiscalDevice || !job.request) {
    throw new HttpError(409, "Documento fiscale non annullabile o riferimento mancante.");
  }
  const voidRequestId = `fiscal_void_${job.receiptId || job.paymentId}`;
  const previousVoidStatus = String(currentReceipt.voidStatus ?? "")
    .trim()
    .toUpperCase();
  updatePosFiscalReceiptByPaymentId(db, job.paymentId, {
    voidStatus: "PROCESSING",
    voidRequestId,
    voidRequestedAt: nowIso(),
    voidReason: String(payload.reason ?? "Annullamento da dettaglio pagamento").slice(0, 240),
    voidError: null,
  });

  let verification = null;
  try {
    verification = await verifyMovementFiscalOperation({
      operation: "void",
      job,
      receipt: currentReceipt,
      idempotencyKey: voidRequestId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updatePosFiscalReceiptByPaymentId(db, job.paymentId, {
      status: "ISSUED",
      fiscalStatus: "ISSUED",
      voidStatus: "FAILED",
      voidError: message,
    });
    appendPosFiscalEvent(db, {
      paymentId: job.paymentId,
      orderId: job.orderId,
      command: "pos_receipt_void",
      result: "void_verification_error",
      message,
    });
    await persistMovementFiscalState(
      db,
      "payments.movement.fiscalVoid.verificationErrorWrite",
    );
    throw new HttpError(502, message, {
      code: "FISCAL_VERIFY_FAILED",
    });
  }

  if (verification.supported === false) {
    if (previousVoidStatus) {
      const message =
        "Il gateway non espone la verifica fiscale: retry annullamento bloccato per evitare un doppio documento.";
      updatePosFiscalReceiptByPaymentId(db, job.paymentId, {
        status: "ISSUED",
        fiscalStatus: "ISSUED",
        voidStatus: "FAILED",
        voidError: message,
      });
      await persistMovementFiscalState(
        db,
        "payments.movement.fiscalVoid.verifyEndpointRequiredWrite",
      );
      throw new HttpError(503, message, {
        code: "FISCAL_VERIFY_ENDPOINT_REQUIRED",
      });
    }
  } else if (verification.state === "VOIDED") {
    const receipt = reconcileMovementFiscalReceipt({
      db,
      verification,
      job,
      receipt: currentReceipt,
      context,
      user,
    });
    appendAuditEvent(db, {
      ...actor,
      action: "payment.fiscal_void_reconciled",
      entityType: "payment",
      entityId: context.container.id,
      payload: {
        receiptId: receipt?.id ?? null,
        paymentId: job.paymentId,
      },
    });
    await persistMovementFiscalState(
      db,
      "payments.movement.fiscalVoid.reconciledWrite",
    );
    return {
      ok: true,
      idempotent: true,
      reconciled: true,
      receipt,
    };
  } else if (verification.state === "PROCESSING") {
    reconcileMovementFiscalReceipt({
      db,
      verification,
      job,
      receipt: currentReceipt,
      context,
      user,
    });
    await persistMovementFiscalState(
      db,
      "payments.movement.fiscalVoid.processingReconciledWrite",
    );
    throw new HttpError(
      503,
      "Annullamento ancora in elaborazione sul gateway fiscale.",
      { code: "FISCAL_VERIFY_PROCESSING" },
    );
  } else if (!verification.canWrite) {
    reconcileMovementFiscalReceipt({
      db,
      verification,
      job,
      receipt: currentReceipt,
      context,
      user,
    });
    await persistMovementFiscalState(
      db,
      "payments.movement.fiscalVoid.failedReconciledWrite",
    );
    throw new HttpError(
      409,
      verification.message || "Il gateway fiscale ha rifiutato l'annullamento.",
      { code: "FISCAL_VERIFY_REJECTED" },
    );
  }

  try {
    const status = await fetchPosFiscalApiJson(job.fiscalDevice.statusEndpoint, {
      baseUrl: job.fiscalDevice.apiBaseUrl,
      fiscalDeviceId: job.fiscalDevice.id,
    });
    assertFiscalProviderRealMode(status);
    if (status?.ok !== true || status?.fiscalApiEnabled !== true) {
      throw new Error(String(status?.message ?? status?.error ?? "Server fiscale non pronto."));
    }
    const response = await fetchPosFiscalApiJson(job.fiscalDevice.voidEndpoint, {
      method: "POST",
      body: job.request,
      baseUrl: job.fiscalDevice.apiBaseUrl,
      idempotencyKey: voidRequestId,
      fiscalDeviceId: job.fiscalDevice.id,
    });
    if (response?.ok === false) {
      throw new Error(String(response?.message ?? response?.error ?? "Annullamento fiscale rifiutato."));
    }
    const references = extractPosFiscalReferenceFromApiResponse(response);
    const voidedAt = nowIso();
    const receipt = updatePosFiscalReceiptByPaymentId(db, job.paymentId, {
      status: "VOIDED",
      fiscalStatus: "VOIDED",
      responseCode: references.fiscalProviderRef || "FISCAL_VOID_OK",
      responseMessage: String(response?.message ?? "Documento fiscale annullato."),
      voidStatus: "VOIDED",
      voidedAt,
      voidedByUserId: user.id,
      voidedByUsername: user.username,
      voidProviderRef: references.fiscalProviderRef,
      voidMovementId: references.fiscalMovementId,
      voidReceiptDate: references.fiscalReceiptDate,
      voidDocumentNumber: references.fiscalDocumentNumber,
      voidError: null,
      requiresFiscalRetry: false,
    });
    const containerRecord = (Array.isArray(db.paymentContainers) ? db.paymentContainers : []).find(
      (entry) => String(entry?.id ?? "").trim() === context.container.id,
    );
    if (containerRecord) {
      containerRecord.fiscalVoidStatus = "VOIDED";
      containerRecord.fiscalVoidedAt = voidedAt;
      containerRecord.fiscalVoidedByUserId = user.id;
    }
    appendPosFiscalEvent(db, {
      paymentId: job.paymentId,
      orderId: job.orderId,
      command: "pos_receipt_void",
      result: "voided",
      message: "Documento fiscale annullato.",
      payload: {
        receiptId: receipt?.id ?? null,
        documentKind: "void",
        originalDocument: {
          providerRef: currentReceipt.fiscalProviderRef ?? null,
          movementId: currentReceipt.fiscalMovementId ?? null,
          receiptDate: currentReceipt.fiscalReceiptDate ?? null,
          documentNumber: currentReceipt.fiscalDocumentNumber ?? null,
        },
        voidDocument: {
          providerRef: references.fiscalProviderRef,
          movementId: references.fiscalMovementId,
          receiptDate: references.fiscalReceiptDate,
          documentNumber: references.fiscalDocumentNumber,
        },
        request: job.request,
        response,
      },
    });
    appendAuditEvent(db, {
      ...actor,
      action: "payment.fiscal_voided",
      entityType: "payment",
      entityId: context.container.id,
      payload: {
        receiptId: receipt?.id ?? null,
        paymentId: job.paymentId,
        originalFiscalDocumentNumber:
          currentReceipt.fiscalDocumentNumber ?? null,
        voidDocumentNumber: references.fiscalDocumentNumber,
      },
    });
    await persistMovementFiscalState(db, "payments.movement.fiscalVoid.appStateWrite");
    return { ok: true, receipt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dryRun = error?.code === FISCAL_PROVIDER_DRY_RUN_CODE;
    updatePosFiscalReceiptByPaymentId(db, job.paymentId, {
      status: "ISSUED",
      fiscalStatus: "ISSUED",
      voidStatus: "FAILED",
      voidError: message,
    });
    appendPosFiscalEvent(db, {
      paymentId: job.paymentId,
      orderId: job.orderId,
      command: "pos_receipt_void",
      result: dryRun ? "void_dry_run" : "void_error",
      message,
    });
    await persistMovementFiscalState(db, "payments.movement.fiscalVoid.errorWrite");
    throw new HttpError(dryRun ? 503 : 502, message, {
      code: dryRun ? FISCAL_PROVIDER_DRY_RUN_CODE : "FISCAL_VOID_FAILED",
    });
  }
}

async function verifyMovementFiscal(payload) {
  const movementId = normalizePaymentMovementId(
    payload.paymentId ?? payload.movementId ?? payload.recordId ?? payload.id,
  );
  if (!movementId) {
    throw new HttpError(400, "Movimento pagamento non valido.");
  }
  const operation = String(payload.operation ?? "issue")
    .trim()
    .toLowerCase();
  if (!["issue", "void"].includes(operation)) {
    throw new HttpError(400, "Operazione fiscale da verificare non valida.");
  }
  if (fiscalRealIoDisabled) {
    throw new HttpError(
      503,
      "Verifica fiscale reale disabilitata in questo ambiente.",
    );
  }

  const db = await readDb();
  ensurePaymentTrackingArrays(db);
  ensureFiscalTrackingArrays(db);
  const { user } = validateSessionContext(db, payload);
  const actor = buildAuditActor(user, payload);
  const context = await resolveMovementFiscalActionContext(db, movementId);
  const requestedReceiptId = String(
    payload.receiptId ?? payload.fiscalReceiptId ?? "",
  ).trim();
  const candidateIds = [
    ...context.fiscalTransactions.map((transaction) =>
      String(transaction.id ?? "").trim(),
    ),
    String(context.container.clientPaymentId ?? "").trim(),
    context.container.id,
  ].filter(Boolean);
  let receipt = null;
  for (const paymentId of candidateIds) {
    const candidate =
      findPosFiscalReceiptByPaymentId(db, paymentId) ??
      findPosFiscalReceiptByPaymentId(context.paymentsReadDb, paymentId);
    if (!candidate) continue;
    if (requestedReceiptId && String(candidate.id) !== requestedReceiptId) {
      continue;
    }
    receipt = candidate;
    break;
  }
  receipt = hydrateMovementFiscalReceiptForWrite(db, receipt);
  if (!receipt) {
    throw new HttpError(404, "Documento fiscale locale non trovato.");
  }

  let job = null;
  let idempotencyKey = "";
  if (operation === "void") {
    const jobs = buildPosFiscalReprintJobsForPaymentContainer(
      context.paymentsReadDb,
      {
        container: context.container,
        transactions: context.fiscalTransactions,
        movementId,
      },
    );
    job =
      jobs.find(
        (entry) =>
          String(entry.paymentId ?? "") === String(receipt.paymentId ?? ""),
      ) ?? jobs[0];
    idempotencyKey =
      String(receipt.voidRequestId ?? "").trim() ||
      `fiscal_void_${receipt.id || receipt.paymentId}`;
  } else {
    job = buildRecoveredPosFiscalJob(db, receipt);
    idempotencyKey =
      String(receipt.idempotencyKey ?? receipt.fiscalRequestId ?? "").trim();
  }
  if (!job?.fiscalDevice || !idempotencyKey) {
    throw new HttpError(
      409,
      "Configurazione o chiave fiscale non disponibile per la verifica.",
    );
  }

  const verification = await verifyMovementFiscalOperation({
    operation,
    job,
    receipt,
    idempotencyKey,
  });
  if (verification.supported === false) {
    throw new HttpError(
      503,
      "Il gateway fiscale non espone ancora l'endpoint di verifica autorevole.",
      { code: "FISCAL_VERIFY_ENDPOINT_REQUIRED" },
    );
  }

  let reconciled = false;
  if (verification.state === "NOT_FOUND") {
    receipt = updatePosFiscalReceiptByPaymentId(
      db,
      job.paymentId,
      operation === "void"
        ? {
            status: "ISSUED",
            fiscalStatus: "ISSUED",
            voidStatus: "FAILED",
            voidError:
              "Annullamento non trovato nel registro autorevole del gateway.",
          }
        : {
            status: "FAILED",
            fiscalStatus: "FAILED",
            responseCode: "FISCAL_VERIFY_NOT_FOUND",
            responseMessage:
              "Documento non trovato nel registro autorevole del gateway.",
            fiscalError:
              "Documento non trovato nel registro autorevole del gateway.",
            requiresFiscalRetry: true,
          },
    );
    reconciled = true;
  } else {
    receipt = reconcileMovementFiscalReceipt({
      db,
      verification,
      job,
      receipt,
      context,
      user,
    });
    reconciled = true;
  }
  appendAuditEvent(db, {
    ...actor,
    action: `payment.fiscal_${operation}_verified`,
    entityType: "payment",
    entityId: context.container.id,
    payload: {
      paymentId: job.paymentId,
      receiptId: receipt?.id ?? null,
      gatewayState: verification.state,
      found: verification.found,
    },
  });
  await persistMovementFiscalState(
    db,
    `payments.movement.fiscalVerify.${operation}.appStateWrite`,
  );
  return {
    ok: true,
    authoritative: true,
    operation,
    state: verification.state,
    found: verification.found,
    reconciled,
    receipt,
  };
}

  return {
    issueMovementFiscal,
    resolvePaymentsReportReadDb,
    verifyMovementFiscal,
    voidMovementFiscal,
  };
}
