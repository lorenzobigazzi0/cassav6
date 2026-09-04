import {
  buildPaymentRealtimeBoundary,
  isFiscalReceiptIssued,
} from "./payments.domain.js";
import {
  beginPaymentFreeSplitMirrorCapture,
  buildPaymentFreeSplitMirrorPayload,
} from "./payment-free-split-mirror-payload.js";
import {
  buildFiscalReceiptPatchFromVerification,
  requestPosFiscalVerification,
} from "../fiscal-pos/fiscal-verification.js";
import {
  assertFiscalProviderRealMode,
  FISCAL_PROVIDER_DRY_RUN_CODE,
} from "../fiscal-pos/fiscal.domain.js";

const PAYMENT_PROVIDER_WRITE_SPLIT_DOMAINS = [
  "paymentProviderTransactions",
  "auditEvents",
];
const PAYMENT_CORE_WRITE_SPLIT_DOMAINS = [
  "payments",
  "paymentContainers",
  "paymentParts",
  "paymentTransactions",
  "paymentProviderTransactions",
  "cashTxDenoms",
  "fiscalReceipts",
  "fiscalEvents",
  "integration",
  "posSettings",
  "auditEvents",
  "commercialBenefitApplications",
  "commercialBenefitRedemptions",
];
const PAYMENT_FISCAL_REPLAY_WRITE_SPLIT_DOMAINS = [
  "paymentContainers",
  "auditEvents",
];
const PAYMENT_MOVEMENT_PRINT_WRITE_SPLIT_DOMAINS = [
  "printSpoolJobs",
  "auditEvents",
];
const PAYMENT_MOVEMENT_REPRINT_WRITE_SPLIT_DOMAINS = [
  "printSpoolJobs",
  "fiscalEvents",
  "auditEvents",
];

function collectPaymentAuditEventIdsSince(db, startIndex = 0) {
  const events = Array.isArray(db?.auditEvents) ? db.auditEvents : [];
  return events
    .slice(Math.max(0, Math.trunc(Number(startIndex) || 0)))
    .map((event) => String(event?.id ?? "").trim())
    .filter(Boolean);
}

function collectPaymentFreeSplitCollectionEntryIds(payload) {
  const collections =
    payload?.collections && typeof payload.collections === "object"
      ? payload.collections
      : {};
  return Object.fromEntries(
    Object.entries(collections)
      .map(([collection, entries]) => [
        collection,
        [
          ...new Set(
            (Array.isArray(entries) ? entries : [])
              .map((entry) => String(entry?.id ?? "").trim())
              .filter(Boolean),
          ),
        ],
      ])
      .filter(([, entryIds]) => entryIds.length > 0),
  );
}

export function createPaymentHandlers({
  issueMovementFiscal,
  resolvePaymentsReportReadDb,
  verifyMovementFiscal,
  voidMovementFiscal,
  randomUUID,
  collectArticleUnitIdsFromPaymentItems,
  isAmountStylePaymentContinuationMode,
  normalizePaymentContinuationSplitMode,
  normalizePaymentSplitType,
  normalizePaymentLineSelections,
  resolvePaymentOrderRefs,
  resolveIntegrationLinkedTableIds,
  resolveIntegrationLogicalTableLabel,
  sanitizeIntegrationTableLabel,
  findIntegrationOrderIndexByLookup,
  HttpError,
  sendJson,
  commercialBenefitCentsToMoney,
  ensureCommercialBenefitCollections,
  redeemCommercialBenefitApplications,
  nowIso,
  normalizeSmartCardCode,
  publishIntegrationNotificationStreamRefresh,
  assertArticleSplitAllowedForTable,
  getIntegrationTableLiveStat,
  normalizePaymentResponseTableDue,
  buildIntegrationTableLiveStats,
  overlayIntegrationLayoutFinancials,
  getIntegrationLinkedTableLiveStat,
  syncPosTableFinancialsFromIntegrationOrders,
  summarizeIntegrationPaymentReadiness,
  applyBillPaymentsToIntegrationOrders,
  applyIntegrationPaymentToOrders,
  centsToMoney,
  moneyToCents,
  validateFreeSplitAuthoritativePayable,
  isCommercialBenefitOnlyPaymentRequest,
  summarizeFreeSplitPaymentRequest,
  normalizePaymentCommercialBenefitApplicationRefs,
  summarizePaymentCommercialBenefitApplications,
  normalizePaymentAdminAdjustment,
  findCompletedPaymentContainerForFiscalReplay,
  collectPaymentPartsAndTransactionsForContainer,
  applyPaymentAdminAdjustmentToOrders,
  buildIntegrationLayoutFromSettings,
  sanitizeIntegrationOrder,
  normalizePaymentPrintNote,
  enqueueMobileElectronicPaymentReceipts,
  sanitizeSmartNonFiscalEntry,
  appendAuditEvent,
  normalizePaymentMethodType,
  mapPaymentMethodToTransactionType,
  normalizePaymentCollectionMetadata,
  sanitizePaymentContainerRecord,
  sanitizePaymentPartRecord,
  sanitizePaymentTransactionRecord,
  sanitizeCashTxDenomRecord,
  ensurePaymentTrackingArrays,
  sanitizePaymentItem,
  sanitizePaymentRecord,
  sanitizeFiscalReceipt,
  normalizeStringList,
  normalizeSeatedAtMs,
  roundMoney,
  assertActiveTableWorkLock,
  sanitizePosTable,
  sanitizePosSettings,
  getPosBillSubtotal,
  buildLegacyPosPaymentBill,
  applyAmountPaymentToPosBills,
  applyLineSelectionsToPosBills,
  paymentIdempotencyCoordinator,
  readDb,
  writePaymentDb,
  writePaymentFreeSplitDb = writePaymentDb,
  paymentFreeSplitTelemetry = null,
  paymentFreeSplitSettingsReuseEnabled = false,
  buildAuditActor,
  validateSessionContext,
  findPaymentMethod,
  assertUserPaymentMethodAllowed,
  executeFiscalProvider,
  schedulePosFiscalReceiptBackgroundJob,
  maybeIssuePosFiscalReceipt,
  shouldIssuePosFiscalReceiptForPayload,
  appendPosFiscalEvent,
  isPosDemoModeEnabled,
  isMobileDeviceFiscalAllowed,
  shouldIssuePosFiscalReceiptForTransaction,
  normalizeIdempotencyKey,
  appendPaymentProviderAuditEvent,
  persistPaymentProviderTransaction,
  persistPaymentProviderFailure,
  authorizeCardPayment,
  findExistingPaymentByIdempotency,
  buildPosSettingsPayload,
  readJsonBody,
  paymentTransactionRepository,
  queuePrintSpoolWorker,
  schedulePosFiscalReprintBackgroundJobs,
  hasConfiguredPosFiscalApiDevice,
  ensureIntegrationOrderComps,
  normalizePaymentMovementId,
  normalizePaymentMovementAdvancedDetails,
  enqueuePaymentMovementAdvancedPrintJobToDb,
  findPaymentReprintContainer,
  enqueuePaymentMovementReprintJobsToDb,
  buildPosFiscalReprintJobsForPaymentContainer,
  appendQueuedPosFiscalReprintEvents,
  findPaymentStornoCompRecord,
  canReprintPaymentMovement,
  enqueueStornoMovementReprintJobToDb,
  relationalPaymentsTableWritePrimary = false,
  ensureRelationalPaymentsTableWritePrimary = null,
  recordRelationalTablePayment = null,
  relationalPaymentsFreeSplitWritePrimary = false,
  ensureRelationalPaymentsFreeSplitWritePrimary = null,
  recordRelationalFreeSplitPayment = null,
  paymentFreeSplitDurableMirrorEnabled = false,
  wakePaymentFreeSplitMirrorWorker = null,
  recordPaymentFreeSplitMirrorFallback = null,
  relationalFiscalReceiptsWritePrimary = false,
  ensureRelationalFiscalReceiptsWritePrimary = null,
  readRelationalPaymentOrderById = null,
  realtimeEventOutboxEnabled = false,
  buildIntegrationNotificationStreamPayload = null,
  publishRealtimeEventOutboxPending = null,
  paymentStateMachineEnabled = true,
}) {
async function hydratePaymentOrderFromRelational(db, orderId) {
  const safeOrderId = String(orderId ?? "").trim();
  if (!safeOrderId || typeof readRelationalPaymentOrderById !== "function") return false;
  if (!db.integration || typeof db.integration !== "object") db.integration = {};
  if (!Array.isArray(db.integration.orders)) db.integration.orders = [];
  if (findIntegrationOrderIndexByLookup(db.integration.orders, safeOrderId) >= 0) return false;
  const relationalOrder = await readRelationalPaymentOrderById(safeOrderId);
  if (!relationalOrder) return false;
  const order = sanitizeIntegrationOrder(relationalOrder, safeOrderId);
  if (!order) return false;
  const orderIndex = findIntegrationOrderIndexByLookup(db.integration.orders, safeOrderId);
  if (orderIndex >= 0) db.integration.orders[orderIndex] = order;
  else db.integration.orders.push(order);
  return true;
}


function assertFreeSplitRelationalTotals({
  paymentContainer,
  paymentParts,
  paymentTransactions,
  totalDue,
  totalPaid,
} = {}) {
  const expectedDueCents = moneyToCents(totalDue);
  const expectedPaidCents = moneyToCents(totalPaid);
  const containerPaidCents = moneyToCents(paymentContainer?.amount);
  const partsCents = (Array.isArray(paymentParts) ? paymentParts : []).reduce(
    (sum, part) => sum + moneyToCents(part?.amountDue),
    0,
  );
  const txCents = (
    Array.isArray(paymentTransactions) ? paymentTransactions : []
  ).reduce((sum, tx) => sum + moneyToCents(tx?.amountPaid), 0);
  if (partsCents !== expectedDueCents) {
    throw new HttpError(409, "Somma quote split non coerente.", {
      code: "PAYMENT_FREE_SPLIT_PARTS_TOTAL_MISMATCH",
      details: { expectedDueCents, partsCents },
    });
  }
  if (txCents !== expectedPaidCents || containerPaidCents !== expectedPaidCents) {
    throw new HttpError(409, "Somma transazioni split non coerente.", {
      code: "PAYMENT_FREE_SPLIT_TRANSACTIONS_TOTAL_MISMATCH",
      details: { expectedPaidCents, txCents, containerPaidCents },
    });
  }
}

async function ensureFiscalReceiptWritePrimaryReady({ paymentWritePrimary } = {}) {
  if (!relationalFiscalReceiptsWritePrimary) return;
  if (typeof ensureRelationalFiscalReceiptsWritePrimary !== "function") {
    throw new HttpError(503, "DB relazionale fiscale non disponibile.", {
      code: "RELATIONAL_FISCAL_DB_UNAVAILABLE",
    });
  }
  await ensureRelationalFiscalReceiptsWritePrimary({ paymentWritePrimary });
}

function startPaymentFreeSplitTrace() {
  const trace = paymentFreeSplitTelemetry?.start?.();
  if (trace) return trace;
  return {
    measure: (_label, action) => action(),
    measureSync: (_label, action) => action(),
    record: () => {},
    finish: () => {},
  };
}

function paymentFreeSplitErrorOutcome(error) {
  return `error_${String(
    error?.code ?? error?.statusCode ?? error?.status ?? "unknown",
  )}`;
}

async function handlePayTable(req, res) {
  const payload = await readJsonBody(req);
  const tableId =
    typeof payload.tableId === "string" ? payload.tableId.trim() : "";
  const paymentMethodId =
    typeof payload.paymentMethodId === "string"
      ? payload.paymentMethodId.trim()
      : "";
  if (!tableId) {
    throw new HttpError(400, "Tavolo non valido.");
  }
  if (!paymentMethodId) {
    throw new HttpError(400, "Metodo di pagamento non valido.");
  }

  const db = await readDb({
    refreshExternalizedSessions: !req.__authContext,
    refreshExternalizedTableLocks: true,
    refreshExternalizedTableLockId: tableId,
  });
  const { user, session } = req.__authContext && typeof req.__authContext === "object"
    ? req.__authContext
    : validateSessionContext(db, payload);
  ensurePaymentTrackingArrays(db);
  ensureCommercialBenefitCollections(db);
  const idempotencyKey = normalizeIdempotencyKey(payload);
  if (relationalPaymentsTableWritePrimary) {
    if (
      typeof ensureRelationalPaymentsTableWritePrimary !== "function" ||
      typeof recordRelationalTablePayment !== "function"
    ) {
      throw new HttpError(503, "DB relazionale pagamenti non disponibile.", {
        code: "RELATIONAL_PAYMENTS_DB_UNAVAILABLE",
      });
    }
    await ensureRelationalPaymentsTableWritePrimary();
  }
  const paymentIdempotencyClaim = paymentIdempotencyCoordinator.begin({
    key: idempotencyKey,
    scope: "payment.table",
    endpoint: "/api/payments/table",
    payload,
    user,
    session,
  });
  if (paymentIdempotencyClaim?.replayed) {
    sendJson(res, 200, paymentIdempotencyClaim.response);
    return;
  }
  try {
  const existingIdempotentPayment = findExistingPaymentByIdempotency(
    db,
    idempotencyKey,
    user,
    session,
  );
  if (existingIdempotentPayment) {
    const responseBody = {
      ok: true,
      idempotent: true,
      payment:
        existingIdempotentPayment.payments[0] ??
        existingIdempotentPayment.container,
      paymentContainer: existingIdempotentPayment.container,
    };
    paymentIdempotencyCoordinator.complete(paymentIdempotencyClaim, responseBody);
    sendJson(res, 200, responseBody);
    return;
  }

  const linkedTableIds = resolveIntegrationLinkedTableIds(
    db.integration,
    tableId,
  );
  const paymentScopeTableIds = linkedTableIds.length
    ? linkedTableIds
    : [tableId];
  assertActiveTableWorkLock(db, tableId, {
    user,
    session,
    payload,
    purpose: "payment.table",
    requireExisting: true,
  });
  let { settings, liveStats } = syncPosTableFinancialsFromIntegrationOrders(
    db,
    paymentScopeTableIds,
  );
  let tableIndex = settings.tables.findIndex((table) => table.id === tableId);
  if (tableIndex < 0) {
    throw new HttpError(404, "Tavolo non trovato.");
  }

  const table = settings.tables[tableIndex];
  const layoutTables = buildIntegrationLayoutFromSettings(settings).tables;
  const layoutTable =
    layoutTables.find((entry) => entry.id === table.id) ?? null;
  const liveTableStats =
    getIntegrationLinkedTableLiveStat(
      liveStats,
      layoutTables,
      paymentScopeTableIds,
      layoutTable ?? {
        id: table.id,
        roomId: typeof payload.roomId === "string" ? payload.roomId.trim() : "",
        number: table.number,
      },
    ) ?? null;
  const tableLabel =
    sanitizeIntegrationTableLabel(
      payload.tableLabel ?? payload.logicalTableLabel,
    ) ||
    resolveIntegrationLogicalTableLabel(
      settings,
      db.integration,
      tableId,
      table.number,
    );
  const paymentNote = normalizePaymentPrintNote(
    payload.note ?? payload.paymentNote,
  );
  const splitModeRaw =
    typeof payload.splitMode === "string"
      ? payload.splitMode.trim().toLowerCase()
      : "";
  const splitMode =
    splitModeRaw === "bill" ||
    splitModeRaw === "roman" ||
    splitModeRaw === "amount" ||
    splitModeRaw === "article"
      ? splitModeRaw
      : "single";
  const requestedBillIds = new Set(
    normalizeStringList(payload.billIds, 50, 120),
  );
  const hasRequestedBills = requestedBillIds.size > 0;
  const validLineSelections = normalizePaymentLineSelections(
    payload.lineSelections,
  );
  const amountRaw = Number(payload.amount);
  const requestedAmount = Number.isFinite(amountRaw)
    ? roundMoney(Math.max(amountRaw, 0))
    : 0;
  const tableBillsSource =
    Array.isArray(liveTableStats?.pendingBills) &&
    liveTableStats.pendingBills.length > 0
      ? liveTableStats.pendingBills
      : Array.isArray(table.pendingBills)
        ? table.pendingBills
        : [];
  const liveTotalDue = roundMoney(
    Math.max(Number(liveTableStats?.amountDue) || 0, 0),
  );
  const tableBills = tableBillsSource.length
    ? tableBillsSource
    : liveTotalDue > 0 || Number(table.totalDue) > 0
      ? [
          buildLegacyPosPaymentBill({
            ...table,
            totalDue: Math.max(liveTotalDue, Number(table.totalDue) || 0),
          }),
        ]
      : [];
  let receiptBillIds = [];
  const fullTableAmount = roundMoney(
    Math.max(
      liveTotalDue,
      Number(table.totalDue) || 0,
      tableBills.reduce((sum, bill) => sum + getPosBillSubtotal(bill), 0),
    ),
  );
  let remainingBills = [];
  let paidItems = [];
  let amount = 0;

  if (validLineSelections.length > 0) {
    const articleSplit = applyLineSelectionsToPosBills(
      tableBills,
      validLineSelections,
    );
    amount = articleSplit.amount;
    paidItems = articleSplit.paidItems;
    remainingBills = articleSplit.remainingBills;
    receiptBillIds = [
      ...new Set(
        validLineSelections
          .map((entry) => String(entry?.billId ?? "").trim())
          .filter(Boolean),
      ),
    ];
    if (amount <= 0) {
      throw new HttpError(400, "Seleziona almeno un articolo da saldare.");
    }
  } else if (hasRequestedBills) {
    const payableBills = tableBills.filter((bill) =>
      requestedBillIds.has(String(bill.id ?? "").trim()),
    );
    if (payableBills.length === 0) {
      throw new HttpError(400, "Comanda da saldare non valida.");
    }
    remainingBills = tableBills.filter(
      (bill) => !requestedBillIds.has(String(bill.id ?? "").trim()),
    );
    amount = roundMoney(
      payableBills.reduce((sum, bill) => sum + getPosBillSubtotal(bill), 0),
    );
    receiptBillIds = payableBills
      .map((bill) => String(bill.id ?? "").trim())
      .filter(Boolean);
    paidItems = payableBills.flatMap((bill) =>
      (Array.isArray(bill.lines) ? bill.lines : [])
        .map((line) => sanitizePaymentItem(line))
        .filter((line) => line !== null),
    );
  } else if (
    requestedAmount > 0 &&
    requestedAmount + 0.0001 < fullTableAmount
  ) {
    const partialSplit = applyAmountPaymentToPosBills(
      tableBills,
      requestedAmount,
      splitMode,
    );
    amount = partialSplit.amount;
    paidItems = partialSplit.paidItems;
    remainingBills = partialSplit.remainingBills;
    receiptBillIds =
      tableBills.length === 1
        ? [String(tableBills[0]?.id ?? "").trim()].filter(Boolean)
        : [];
  } else {
    remainingBills = [];
    amount = fullTableAmount;
    receiptBillIds = tableBills
      .map((bill) => String(bill.id ?? "").trim())
      .filter(Boolean);
    paidItems = tableBills.flatMap((bill) =>
      (Array.isArray(bill.lines) ? bill.lines : [])
        .map((line) => sanitizePaymentItem(line))
        .filter((line) => line !== null),
    );
  }
  const paymentContinuationSplitMode =
    validLineSelections.length > 0
      ? "article"
      : hasRequestedBills
        ? "bill"
        : requestedAmount > 0 && requestedAmount + 0.0001 < fullTableAmount
          ? (normalizePaymentContinuationSplitMode(splitMode) ?? "amount")
          : "single";
  const selectedArticleUnitIdsForPayment =
    paymentContinuationSplitMode === "article"
      ? collectArticleUnitIdsFromPaymentItems(paidItems)
      : [];
  if (paymentContinuationSplitMode === "article") {
    assertArticleSplitAllowedForTable(db, tableId);
  }

  if (amount <= 0) {
    throw new HttpError(
      400,
      "Nessun importo da pagare per il tavolo selezionato.",
    );
  }
  let paymentRefs = resolvePaymentOrderRefs({
    tableBills,
    selectedBillIds: receiptBillIds,
    lineSelections: validLineSelections,
    tableId: table.id,
  });

  const method = findPaymentMethod(settings, paymentMethodId);
  if (!method) {
    throw new HttpError(400, "Metodo di pagamento non disponibile.");
  }
  assertUserPaymentMethodAllowed(user, method.id, settings);
  if (method.id === "pay_chip") {
    const hasLinkedMyContoCard = db.smartCustomers.some(
      (customer) => normalizeSmartCardCode(customer.cardCode ?? "").length > 0,
    );
    if (!hasLinkedMyContoCard) {
      throw new HttpError(
        409,
        "Metodo MyConto non disponibile: nessuna card associata.",
      );
    }
  }

  const paymentId = `pay_${randomUUID().replace(/-/g, "")}`;
  const partId = `part_${randomUUID().replace(/-/g, "")}`;
  const txId = `tx_${randomUUID().replace(/-/g, "")}`;
  const methodType = mapPaymentMethodToTransactionType(method.id, method.label);
  const collectionMetadata = normalizePaymentCollectionMetadata(payload, methodType);
  const { transaction: providerTransaction } =
    paymentTransactionRepository.createOrGetInDb(db, {
      transactionId: `ptx_${randomUUID().replace(/-/g, "")}`,
      clientPaymentId: payload.clientPaymentId
        ? String(payload.clientPaymentId).trim()
        : null,
      idempotencyKey,
      amount,
      currency: "EUR",
      linesSnapshot: paidItems,
      paymentMethodId: method.id,
      providerType:
        methodType === "POS"
          ? "card"
          : methodType === "CASH"
            ? "cash"
            : "manual",
      status: "created",
    });
  const cashGivenRaw = Number(payload.cashGiven);
  if (
    methodType === "CASH" &&
    Number.isFinite(cashGivenRaw) &&
    cashGivenRaw + 0.0001 < amount
  ) {
    paymentTransactionRepository.updateInDb(
      db,
      providerTransaction.transactionId,
      {
        status: "failed",
        settlementError: {
          message: "Contante ricevuto inferiore all'importo da pagare.",
        },
      },
    );
    db.meta.lastWriteAt = nowIso();
    await writePaymentDb(db, {
      metricLabel: "payments.table.cashRejected.appStateWrite",
      splitDomains: ["paymentProviderTransactions"],
    });
    throw new HttpError(
      400,
      "Contante ricevuto inferiore all'importo da pagare.",
      { code: "CASH_GIVEN_TOO_LOW" },
    );
  }
  const cashGiven =
    methodType === "CASH"
      ? Number.isFinite(cashGivenRaw) && cashGivenRaw >= amount
        ? roundMoney(cashGivenRaw)
        : roundMoney(amount)
      : null;
  const changeGiven =
    methodType === "CASH" && cashGiven !== null
      ? roundMoney(Math.max(cashGiven - amount, 0))
      : null;
  let cardAuthorization = null;
  if (methodType === "POS") {
    try {
      await persistPaymentProviderTransaction(
        db,
        providerTransaction.transactionId,
        {
          status: "settlement_pending",
          phase: "settlement_pending",
        },
        {
          action: "payment.provider_settlement_pending",
          user,
          payload,
          details: {
            amount,
            paymentMethodId: method.id,
            source: "pay_table",
          },
        },
        {
          metricLabel: "payments.table.provider.appStateWrite",
          splitDomains: PAYMENT_PROVIDER_WRITE_SPLIT_DOMAINS,
        },
      );
      cardAuthorization = await authorizeCardPayment({
        amount,
        paymentMethodId: method.id,
        payload,
        transactionId: providerTransaction.transactionId,
      });
      await persistPaymentProviderTransaction(
        db,
        providerTransaction.transactionId,
        {
          status: "settlement_pending",
          phase: "settlement_pending",
          settlementResponse: { authorization: cardAuthorization },
        },
        {
          action: "payment.provider_authorized",
          user,
          payload,
          details: {
            amount,
            paymentMethodId: method.id,
            source: "pay_table",
            provider: cardAuthorization?.provider ?? null,
            posTxRef: cardAuthorization?.posTxRef ?? null,
          },
        },
        {
          metricLabel: "payments.table.provider.appStateWrite",
          splitDomains: PAYMENT_PROVIDER_WRITE_SPLIT_DOMAINS,
        },
      );
    } catch (error) {
      await persistPaymentProviderFailure(
        db,
        providerTransaction.transactionId,
        error,
        {
          cardAuthorization,
          user,
          payload,
          writeOptions: {
            metricLabel: "payments.table.providerFailed.appStateWrite",
            splitDomains: PAYMENT_PROVIDER_WRITE_SPLIT_DOMAINS,
          },
        },
      );
      throw error;
    }
  }
  let receipt = null;
  let middlewareResponse = null;

  const shouldIssuePosFiscalReceipt =
    method.isFiscal &&
    shouldIssuePosFiscalReceiptForTransaction({
      settings,
      payload: { ...payload, deviceUuid: session.deviceUuid },
      methodType,
      paymentMethodId: method.id,
    });
  const shouldRunLegacyFiscalProvider =
    !isPosDemoModeEnabled(settings) &&
    isMobileDeviceFiscalAllowed(settings, {
      deviceUuid: payload.deviceUuid,
      methodType,
      paymentMethodId: method.id,
    }) &&
    method.isFiscal &&
    methodType !== "POS" &&
    !shouldIssuePosFiscalReceipt;
  if (shouldIssuePosFiscalReceipt || shouldRunLegacyFiscalProvider) {
    await ensureFiscalReceiptWritePrimaryReady({
      paymentWritePrimary: relationalPaymentsTableWritePrimary,
    });
  }

  if (shouldRunLegacyFiscalProvider) {
    const fiscalResult = executeFiscalProvider("print_receipt", {
      tableId,
      amount,
      paymentMethodId: method.id,
    });
    middlewareResponse = fiscalResult.middleware;
    const receiptRecord = sanitizeFiscalReceipt(
      {
        id: `fiscal_${randomUUID().replace(/-/g, "")}`,
        paymentId,
        command: "print_receipt",
        status: fiscalResult.fiscalStatus,
        responseCode: middlewareResponse.responseCode,
        responseMessage: middlewareResponse.responseMessage,
        createdAt: middlewareResponse.processedAt,
        fiscalProvider: fiscalResult.fiscalProvider,
        requiresFiscalRetry: fiscalResult.requiresFiscalRetry,
      },
      `fiscal_${Date.now()}`,
    );
    if (receiptRecord) {
      db.fiscalReceipts.push(receiptRecord);
      receipt = receiptRecord;
    }
  } else {
    if (methodType !== "CASH") {
      const customerLabel = table.guestName
        ? table.guestName
        : `Tavolo ${tableLabel || table.number}`;
      const nonFiscalRecord = sanitizeSmartNonFiscalEntry(
        {
          id: `smart_nf_${randomUUID().replace(/-/g, "")}`,
          kind: "smart_payment",
          description: `Pagamento smart ${customerLabel}`,
          amount,
          createdAt: nowIso(),
          methodId: method.id,
          methodLabel: method.label,
          customerId: null,
          customerLabel,
        },
        `smart_nf_${Date.now()}`,
      );
      if (nonFiscalRecord) {
        db.smartNonFiscal.push(nonFiscalRecord);
      }
    }
    middlewareResponse = shouldIssuePosFiscalReceipt
      ? {
          ok: true,
          responseCode: "FISCAL_API_QUEUED",
          responseMessage: "Scontrino fiscale POS in accodamento.",
        }
      : {
          ok: true,
          responseCode: "SMART_OK",
          responseMessage: "Pagamento smart registrato.",
        };
  }

  const paymentContainer = sanitizePaymentContainerRecord(
    {
      id: paymentId,
      ...paymentRefs,
      tableNumber: table.number,
      tableLabel,
      roomId: typeof payload.roomId === "string" ? payload.roomId.trim() : null,
      createdByUserId: user.id,
      createdByUsername: user.username,
      collectedByUserId: user.id,
      collectedByUsername: user.username,
      collectedByDeviceUuid: session.deviceUuid,
      createdAt: nowIso(),
      status: "COMPLETED",
      splitType: remainingBills.length > 0 ? "FREE_SPLIT" : "SINGLE",
      splitMode: paymentContinuationSplitMode,
      articleUnitIds: selectedArticleUnitIdsForPayment,
      paymentMethod: method.id,
      ...collectionMetadata,
      amount,
      note: paymentNote,
      idempotencyKey: idempotencyKey || null,
      clientPaymentId: payload.clientPaymentId
        ? String(payload.clientPaymentId).trim()
        : null,
      fiscalDocType: shouldRunLegacyFiscalProvider ? "RECEIPT" : null,
      fiscalDocNo: receipt?.id ?? null,
      fiscalIssuedAt: receipt ? receipt.createdAt : null,
      fiscalIssuedBy: receipt ? user.id : null,
    },
    paymentId,
  );
  if (paymentContainer) {
    db.paymentContainers.push(paymentContainer);
  }

  const paymentPart = sanitizePaymentPartRecord(
    {
      id: partId,
      paymentId,
      partNo: 1,
      amountDue: amount,
      status: "PAID",
    },
    partId,
  );
  if (paymentPart) {
    db.paymentParts.push(paymentPart);
  }

  const paymentTx = sanitizePaymentTransactionRecord(
    {
      id: txId,
      partId,
      createdByUserId: user.id,
      createdByUsername: user.username,
      createdAt: nowIso(),
      method: methodType,
      ...collectionMetadata,
      amountPaid: amount,
      cashGiven,
      changeGiven,
      posProvider:
        methodType === "POS"
          ? cardAuthorization?.provider ||
            String(payload.posProvider ?? method.label ?? "POS").trim() ||
            "POS"
          : null,
      posTxRef:
        methodType === "POS"
          ? cardAuthorization?.posTxRef ||
            String(payload.posTxRef ?? payload.posTxRefId ?? "").trim() ||
            null
          : null,
    },
    txId,
  );
  if (paymentTx) {
    db.paymentTransactions.push(paymentTx);
  }

  const denomsIn = Array.isArray(payload.cashDenomsIn)
    ? payload.cashDenomsIn
    : [];
  const denomsOut = Array.isArray(payload.cashDenomsOut)
    ? payload.cashDenomsOut
    : [];
  if (methodType === "CASH" && paymentTx) {
    denomsIn.forEach((entry, index) => {
      const denom = sanitizeCashTxDenomRecord(
        {
          id: `denom_in_${paymentTx.id}_${index + 1}`,
          txId: paymentTx.id,
          direction: "IN",
          denomCents: entry?.denomCents,
          qty: entry?.qty,
        },
        `denom_in_${paymentTx.id}_${index + 1}`,
      );
      if (denom) db.cashTxDenoms.push(denom);
    });
    denomsOut.forEach((entry, index) => {
      const denom = sanitizeCashTxDenomRecord(
        {
          id: `denom_out_${paymentTx.id}_${index + 1}`,
          txId: paymentTx.id,
          direction: "OUT",
          denomCents: entry?.denomCents,
          qty: entry?.qty,
        },
        `denom_out_${paymentTx.id}_${index + 1}`,
      );
      if (denom) db.cashTxDenoms.push(denom);
    });
  }

  const paymentRecord = sanitizePaymentRecord(
    {
      id: paymentId,
      tableId: table.id,
      tableNumber: table.number,
      tableLabel,
      roomId: typeof payload.roomId === "string" ? payload.roomId.trim() : null,
      orderId: paymentRefs.orderId,
      orderIds: paymentRefs.orderIds,
      billId: paymentRefs.billId,
      billIds: paymentRefs.billIds,
      tableCovers: table.covers,
      amount,
      note: paymentNote,
      methodId: method.id,
      methodLabel: method.label,
      ...collectionMetadata,
      fiscal: shouldRunLegacyFiscalProvider,
      source:
        validLineSelections.length > 0
          ? "table_article_payment"
          : hasRequestedBills
            ? "table_split_payment"
            : requestedAmount > 0 && requestedAmount + 0.0001 < fullTableAmount
              ? splitMode === "roman"
                ? "table_roman_payment"
                : "table_amount_payment"
              : "table_payment",
      customerId: null,
      createdAt: nowIso(),
      createdByUserId: user.id,
      createdByUsername: user.username,
      collectedByUserId: user.id,
      collectedByUsername: user.username,
      collectedByDeviceUuid: session.deviceUuid,
      receiptId: receipt?.id ?? null,
      paymentContainerId: paymentContainer?.id ?? null,
      paymentPartId: paymentPart?.id ?? null,
      paymentTxId: paymentTx?.id ?? null,
      changeGiven,
      idempotencyKey: idempotencyKey || null,
      clientPaymentId: payload.clientPaymentId
        ? String(payload.clientPaymentId).trim()
        : null,
      items: paidItems,
    },
    paymentId,
  );
  if (paymentRecord) {
    db.payments.push(paymentRecord);
  }
  paymentTransactionRepository.updateInDb(
    db,
    providerTransaction.transactionId,
    {
      status: "settled",
      phase: "settled",
      settlementResponse: {
        paymentId,
        receiptId: receipt?.id ?? null,
        middleware: middlewareResponse,
        cardAuthorization,
      },
    },
  );
  appendPaymentProviderAuditEvent(db, {
    action: "payment.provider_settled",
    transactionId: providerTransaction.transactionId,
    user,
    payload,
    details: {
      paymentId,
      amount,
      paymentMethodId: method.id,
      source: "pay_table",
      paymentSource: collectionMetadata.paymentSource,
      automaticCashPaymentOperationId:
        collectionMetadata.automaticCashPaymentOperationId,
    },
  });

  const integrationOrderPaymentStateBeforeById = new Map(
    (Array.isArray(db.integration?.orders) ? db.integration.orders : []).map(
      (order, index) => {
        const safeOrder = sanitizeIntegrationOrder(
          order,
          String(index + 1).padStart(5, "0"),
        );
        return [
          safeOrder.id,
          {
            workflowStatus: safeOrder.workflowStatus,
            paymentStatus: safeOrder.paymentStatus,
            paidAmount: safeOrder.paidAmount,
            dueAmount: safeOrder.dueAmount,
          },
        ];
      },
    ),
  );
  const paidIntegrationOrderIds = applyBillPaymentsToIntegrationOrders(
    db,
    tableBills,
    remainingBills,
    {
      tableId,
      articleUnitIds: selectedArticleUnitIdsForPayment,
    },
  );
  ({ settings, liveStats } = syncPosTableFinancialsFromIntegrationOrders(
    db,
    paymentScopeTableIds,
  ));
  const syncedTable = sanitizePosTable(
    settings.tables[tableIndex],
    tableIndex + 1,
  );
  const syncedLayoutTables =
    buildIntegrationLayoutFromSettings(settings).tables;
  const syncedLayoutTable =
    syncedLayoutTables.find((entry) => entry.id === table.id) ?? null;
  const syncedLiveTable =
    getIntegrationLinkedTableLiveStat(
      liveStats,
      syncedLayoutTables,
      paymentScopeTableIds,
      syncedLayoutTable ?? {
        id: table.id,
        roomId: typeof payload.roomId === "string" ? payload.roomId.trim() : "",
        number: table.number,
      },
    ) ?? null;
  const nextTotalDue = roundMoney(
    Math.max(
      Number(syncedLiveTable?.amountDue) || 0,
      Number(syncedTable.totalDue) || 0,
    ),
  );
  const updatedTable = {
    ...syncedTable,
    status: nextTotalDue > 0 ? "payment_due" : "no_orders",
    seatedAt: normalizeSeatedAtMs(syncedTable.seatedAt) ?? Date.now(),
    totalDue: nextTotalDue,
    amountDue: nextTotalDue,
    pendingBills: Array.isArray(syncedLiveTable?.pendingBills)
      ? syncedLiveTable.pendingBills
      : Array.isArray(syncedTable.pendingBills)
        ? syncedTable.pendingBills
        : [],
  };
  const amountStyleContinuationMode =
    nextTotalDue > 0 &&
    isAmountStylePaymentContinuationMode(paymentContinuationSplitMode)
      ? paymentContinuationSplitMode
      : null;
  updatedTable.paymentFlowMode =
    syncedLiveTable?.paymentFlowMode ?? amountStyleContinuationMode;
  updatedTable.paymentArticleSplitLocked =
    syncedLiveTable?.paymentArticleSplitLocked === true ||
    amountStyleContinuationMode !== null;
  settings.tables[tableIndex] = updatedTable;
  db.posSettings = settings;
  const auditActor = buildAuditActor(user, payload);
  let posFiscalResult = null;
  const posFiscalJobsToSchedule = [];
  if (
    shouldIssuePosFiscalReceipt &&
    paymentTx &&
    paymentContainer?.status === "COMPLETED"
  ) {
    posFiscalResult = await maybeIssuePosFiscalReceipt(db, {
      paymentId,
      transactionId: paymentTx.id,
      orderId: paymentRefs.orderId,
      orderIds: paymentRefs.orderIds,
      articleUnitIds: selectedArticleUnitIdsForPayment,
      amount,
      paymentItems: paidItems,
      methodType,
      paymentMethodId: method.id,
      paymentMethodLabel: method.label,
      issuedBy: user.id,
      deviceUuid: session.deviceUuid,
      deferSchedule: true,
    });
    if (posFiscalResult?.backgroundJob) {
      posFiscalJobsToSchedule.push(posFiscalResult.backgroundJob);
    }
    if (posFiscalResult?.receipt) {
      receipt = receipt ?? posFiscalResult.receipt;
      paymentContainer.fiscalDocType = "RECEIPT";
      paymentContainer.fiscalDocNo =
        paymentContainer.fiscalDocNo || posFiscalResult.receipt.id;
      if (posFiscalResult?.issued) {
        paymentContainer.fiscalIssuedAt =
          paymentContainer.fiscalIssuedAt || posFiscalResult.receipt.createdAt;
        paymentContainer.fiscalIssuedBy =
          paymentContainer.fiscalIssuedBy || user.id;
      }
      if (posFiscalResult?.issued && paymentRecord) {
        paymentRecord.receiptId =
          paymentRecord.receiptId ?? posFiscalResult.receipt.id;
        paymentRecord.fiscal = true;
      }
    }
  }
  appendAuditEvent(db, {
    ...auditActor,
    action: "payment.created",
    entityType: "payment",
    entityId: paymentId,
    payload: {
      paymentId,
      tableId: paymentRefs.tableId,
      orderId: paymentRefs.orderId,
      orderIds: paymentRefs.orderIds,
      billId: paymentRefs.billId,
      billIds: paymentRefs.billIds,
      roomId: paymentContainer?.roomId ?? auditActor.roomId,
      splitType:
        paymentContainer?.splitType ??
        (remainingBills.length > 0 ? "FREE_SPLIT" : "SINGLE"),
      amount,
      method: method.id,
      paymentSource: collectionMetadata.paymentSource,
      automaticCashPaymentOperationId:
        collectionMetadata.automaticCashPaymentOperationId,
      collectedByUserId: user.id,
      collectedByUsername: user.username,
      deviceUuid: session.deviceUuid,
    },
  });
  paidIntegrationOrderIds.forEach((orderId) => {
    const nextOrderIndex = Array.isArray(db.integration?.orders)
      ? findIntegrationOrderIndexByLookup(db.integration.orders, orderId)
      : -1;
    if (nextOrderIndex < 0) return;
    const nextOrder = sanitizeIntegrationOrder(
      db.integration.orders[nextOrderIndex],
      String(orderId),
    );
    const beforeState =
      integrationOrderPaymentStateBeforeById.get(nextOrder.id) ?? null;
    const afterState = {
      workflowStatus: nextOrder.workflowStatus,
      paymentStatus: nextOrder.paymentStatus,
      paidAmount: nextOrder.paidAmount,
      dueAmount: nextOrder.dueAmount,
    };
    if (
      beforeState &&
      JSON.stringify(beforeState) === JSON.stringify(afterState)
    )
      return;
    appendAuditEvent(db, {
      ...auditActor,
      action: "order.payment_status_changed",
      entityType: "integration_order",
      entityId: nextOrder.id,
      roomId: nextOrder.roomId || auditActor.roomId,
      payload: {
        orderId: nextOrder.id,
        paymentId,
        methodId: method.id,
        amount,
      },
      before: beforeState,
      after: afterState,
    });
  });
  appendAuditEvent(db, {
    ...auditActor,
    action: "payment.split_created",
    entityType: "payment_part",
    entityId: paymentPart?.id ?? partId,
    payload: {
      paymentId,
      partsCount: 1,
      amountDue: amount,
    },
  });
  appendAuditEvent(db, {
    ...auditActor,
    action: "payment.part_paid",
    entityType: "payment_tx",
    entityId: paymentTx?.id ?? txId,
    payload: {
      paymentId,
      partId: paymentPart?.id ?? partId,
      txId: paymentTx?.id ?? txId,
      method: paymentTx?.method ?? methodType,
      amountPaid: paymentTx?.amountPaid ?? amount,
      cashGiven: paymentTx?.cashGiven ?? null,
      changeGiven: paymentTx?.changeGiven ?? null,
    },
  });
  if (isFiscalReceiptIssued(receipt)) {
    appendAuditEvent(db, {
      ...auditActor,
      action: "fiscal.issued",
      entityType: "fiscal_receipt",
      entityId: receipt.id,
      payload: {
        paymentId,
        fiscalDocType: "RECEIPT",
        fiscalDocNo: receipt.id,
        issuedAt: receipt.createdAt,
      },
    });
  }
  appendAuditEvent(db, {
    ...auditActor,
    action: "payment.completed",
    entityType: "payment",
    entityId: paymentId,
    payload: {
      paymentId,
      amount,
      methodId: method.id,
    },
  });
  if (nextTotalDue <= 0) {
    appendAuditEvent(db, {
      ...auditActor,
      action: "table.settled",
      entityType: "table",
      entityId: table.id,
      payload: {
        tableId: table.id,
        tableNumber: table.number,
        paymentId,
        amount,
        nextStatus: updatedTable.status,
        keptOccupied: true,
      },
    });
  }
  const realtimeBoundary = buildPaymentRealtimeBoundary({
    completed: true,
    fiscalResults: [posFiscalResult],
    paymentStateMachineEnabled,
  });
  const realtimeDetail = {
    paymentId,
    tableId: paymentRefs.tableId,
    orderId: paymentRefs.orderId,
    orderIds: paymentRefs.orderIds,
    billId: paymentRefs.billId,
    billIds: paymentRefs.billIds,
    roomId: paymentContainer?.roomId ?? auditActor.roomId ?? payload.roomId,
    amount,
    methodId: method.id,
    paymentStatus: realtimeBoundary.paymentStatus,
    paymentState: realtimeBoundary.paymentState,
    paymentStatePath: realtimeBoundary.paymentStatePath,
    fiscalPending: realtimeBoundary.fiscalPending,
    fiscalRecoveryRequired: realtimeBoundary.fiscalRecoveryRequired,
    source: "table_payment",
  };
  const realtimePayload =
    typeof buildIntegrationNotificationStreamPayload === "function"
      ? buildIntegrationNotificationStreamPayload(
          realtimeBoundary.reason,
          realtimeDetail,
        )
      : { reason: realtimeBoundary.reason, detail: realtimeDetail };
  const relationalTableResult = relationalPaymentsTableWritePrimary
      ? await recordRelationalTablePayment({
        appState: db,
        tableIds: paymentScopeTableIds,
        orderIds: paidIntegrationOrderIds,
        paymentContainer,
        paymentPart,
        paymentTx,
        paymentRecord,
        receipt,
        posFiscalResult,
        idempotencyKey,
        realtimePayload,
        occurredAt: nowIso(),
      })
    : null;

  db.meta.lastWriteAt = nowIso();
  await writePaymentDb(db, {
    metricLabel: "payments.table.complete.appStateWrite",
    splitDomains: PAYMENT_CORE_WRITE_SPLIT_DOMAINS,
  });
  if (
    relationalPaymentsTableWritePrimary &&
    realtimeEventOutboxEnabled &&
    typeof publishRealtimeEventOutboxPending === "function"
  ) {
    publishRealtimeEventOutboxPending();
  } else {
    publishIntegrationNotificationStreamRefresh(
      realtimeBoundary.reason,
      realtimeDetail,
    );
  }
  posFiscalJobsToSchedule.forEach((job) =>
    schedulePosFiscalReceiptBackgroundJob(job),
  );
  const paymentReceiptJobs = await enqueueMobileElectronicPaymentReceipts({
    settings,
    user,
    clientApp: session?.clientApp,
    deviceUuid: session?.deviceUuid,
    roomId: paymentContainer?.roomId ?? auditActor.roomId ?? payload.roomId,
    paymentId,
    table,
    tableLabel,
    tableBills,
    selectedBillIds: receiptBillIds,
    fallbackOrderId: String(payload.orderId ?? "").trim(),
    transactions: paymentTx
      ? [
          {
            id: paymentTx.id,
            createdAt: paymentTx.createdAt,
            amountPaid: paymentTx.amountPaid,
            methodType: paymentTx.method,
            methodId: method.id,
            methodLabel: method.label,
            note: paymentNote,
          },
        ]
      : [],
    note: paymentNote,
  });

  const responseBody = {
    ...buildPosSettingsPayload(settings),
    table: updatedTable,
    payment: paymentRecord,
    receipt,
    middleware: middlewareResponse,
    posFiscalReceipt: posFiscalResult?.receipt ?? null,
    fiscalPending: realtimeBoundary.fiscalPending,
    fiscalWarning: posFiscalResult?.warning ?? null,
    fiscalRecoveryRequired: posFiscalResult?.requiresRetry === true,
    relational: relationalTableResult
      ? {
          writePrimary: true,
          replayed: relationalTableResult.domainResult?.replayed === true,
          paymentTransactionId:
            relationalTableResult.domainResult?.transaction?.id ?? null,
          tableInvariant:
            relationalTableResult.domainResult?.tableInvariant?.summaries ?? [],
        }
      : undefined,
    ...(paymentReceiptJobs.length
      ? {
          paymentReceiptJobs: paymentReceiptJobs.map((job) => ({
            id: job.id,
            printerName: job.printerName,
          })),
        }
      : {}),
  };
  paymentIdempotencyCoordinator.complete(paymentIdempotencyClaim, responseBody);
  sendJson(res, 200, responseBody);
  } catch (error) {
    paymentIdempotencyCoordinator.fail(paymentIdempotencyClaim, error);
    throw error;
  }
}

  async function handleFreeSplitWithTelemetry(req, res) {
    const telemetry = startPaymentFreeSplitTrace();
    try {
      const result = await handlePaymentFreeSplit(req, res, telemetry);
      telemetry.finish("completed");
      return result;
    } catch (error) {
      telemetry.finish(paymentFreeSplitErrorOutcome(error));
      throw error;
    }
  }

  async function handlePaymentFreeSplit(req, res, telemetry) {
  const payload = await telemetry.measure("request.parse", () => readJsonBody(req));
  const partsInput = Array.isArray(payload.parts) ? payload.parts : [];
  const commercialBenefitApplicationRefs =
    normalizePaymentCommercialBenefitApplicationRefs(
      payload.commercialBenefitApplications ??
        payload.commercialBenefitApplicationIds ??
        payload.commercialBenefits,
    );
  const commercialBenefitOnlyPayment = isCommercialBenefitOnlyPaymentRequest(
    partsInput,
    commercialBenefitApplicationRefs,
  );
  if (partsInput.length === 0 && !commercialBenefitOnlyPayment) {
    throw new HttpError(400, "Specifica almeno una quota di pagamento.");
  }

  const tableId =
    typeof payload.tableId === "string" ? payload.tableId.trim() : "";
  const db = await telemetry.measure("readDb", () =>
    readDb({
      refreshExternalizedSessions: !req.__authContext,
      refreshExternalizedTableLocks: true,
      refreshExternalizedTableLockId: tableId,
    }),
  );
  const { user, session } = req.__authContext && typeof req.__authContext === "object"
    ? req.__authContext
    : validateSessionContext(db, payload);
  ensurePaymentTrackingArrays(db);
  ensureCommercialBenefitCollections(db);
  const paymentMirrorCapture = beginPaymentFreeSplitMirrorCapture(db);
  const idempotencyKey = normalizeIdempotencyKey(payload);
  if (relationalPaymentsFreeSplitWritePrimary) {
    if (
      typeof ensureRelationalPaymentsFreeSplitWritePrimary !== "function" ||
      typeof recordRelationalFreeSplitPayment !== "function"
    ) {
      throw new HttpError(503, "DB relazionale pagamenti non disponibile.", {
        code: "RELATIONAL_PAYMENTS_DB_UNAVAILABLE",
      });
    }
    await telemetry.measure("relational.preflight", () =>
      ensureRelationalPaymentsFreeSplitWritePrimary(),
    );
  }
  const paymentIdempotencyClaim = telemetry.measureSync("idempotency.begin", () =>
    paymentIdempotencyCoordinator.begin({
      key: idempotencyKey,
      scope: "payment.free_split",
      endpoint: "/api/payments/free-split",
      payload,
      user,
      session,
    }),
  );
  if (paymentIdempotencyClaim?.replayed) {
    sendJson(res, 200, paymentIdempotencyClaim.response);
    return;
  }
  try {
  const existingIdempotentPayment = telemetry.measureSync(
    "idempotency.lookup",
    () => findExistingPaymentByIdempotency(
      db,
      idempotencyKey,
      user,
      session,
    ),
  );
  if (existingIdempotentPayment) {
    const idempotentTableId =
      (typeof payload.tableId === "string" && payload.tableId.trim()) ||
      String(existingIdempotentPayment.container?.tableId ?? "").trim();
    const idempotentLayout = idempotentTableId
      ? buildIntegrationLayoutFromSettings(
          sanitizePosSettings(db.posSettings, { menuItems: db.menuItems }),
        )
      : null;
    const idempotentTable = normalizePaymentResponseTableDue(
      idempotentTableId
        ? ((Array.isArray(idempotentLayout?.tables)
            ? idempotentLayout.tables
            : []
          ).find((entry) => entry.id === idempotentTableId) ?? null)
        : null,
    );
    const responseBody = {
      ok: true,
      idempotent: true,
      payment: existingIdempotentPayment.container,
      table: idempotentTable,
      parts: (Array.isArray(db.paymentParts) ? db.paymentParts : [])
        .map((entry, index) =>
          sanitizePaymentPartRecord(entry, `part_${index + 1}`),
        )
        .filter(
          (entry) =>
            entry && entry.paymentId === existingIdempotentPayment.container.id,
        ),
      transactions: (Array.isArray(db.paymentTransactions)
        ? db.paymentTransactions
        : []
      )
        .map((entry, index) =>
          sanitizePaymentTransactionRecord(entry, `tx_${index + 1}`),
        )
        .filter((entry) => entry !== null),
    };
    paymentIdempotencyCoordinator.complete(paymentIdempotencyClaim, responseBody);
    sendJson(res, 200, responseBody);
    return;
  }
  const domainPrepareStartedAt = Date.now();
  let settings = telemetry.measureSync("domain.settingsSanitize", () =>
    sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
    }),
  );
  const paymentDomainOptions = () =>
    paymentFreeSplitSettingsReuseEnabled
      ? { sanitizedPosSettings: settings }
      : {};
  const targetOrderId =
    typeof payload.orderId === "string" ? payload.orderId.trim() : "";
  await telemetry.measure("relational.orderHydrate", () =>
    hydratePaymentOrderFromRelational(db, targetOrderId),
  );
  let table = null;
  if (tableId) {
    assertActiveTableWorkLock(db, tableId, {
      user,
      session,
      payload,
      purpose: "payment.free_split",
      requireExisting: true,
    });
    ({ settings } = telemetry.measureSync(
      "domain.tableFinancialSync.initial",
      () =>
        syncPosTableFinancialsFromIntegrationOrders(
          db,
          [tableId],
          paymentDomainOptions(),
        ),
    ));
    table = settings.tables.find((entry) => entry.id === tableId) ?? null;
  }
  const paymentId = `pay_${randomUUID().replace(/-/g, "")}`;
  const paymentCreatedAt = nowIso();
  const splitType = normalizePaymentSplitType(
    payload.splitType || "FREE_SPLIT",
  );
  const roomId =
    typeof payload.roomId === "string" ? payload.roomId.trim() : "";
  const paymentNote = normalizePaymentPrintNote(
    payload.note ?? payload.paymentNote,
  );
  const articleUnitIds = normalizeStringList(payload.articleUnitIds, 1000, 120);
  const paymentContinuationSplitMode = normalizePaymentContinuationSplitMode(
    payload.splitMode,
    {
      splitType,
      articleUnitIds,
      hasLineSelections:
        Array.isArray(payload.lineSelections) &&
        payload.lineSelections.length > 0,
    },
  );
  if (paymentContinuationSplitMode === "article") {
    assertArticleSplitAllowedForTable(db, table?.id ?? tableId);
  }
  let paymentRefs = resolvePaymentOrderRefs({
    tableBills: Array.isArray(table?.pendingBills) ? table.pendingBills : [],
    selectedBillIds: Array.isArray(payload.billIds) ? payload.billIds : [],
    lineSelections: Array.isArray(payload.lineSelections)
      ? payload.lineSelections
      : [],
    targetOrderId,
    tableId: table?.id ?? tableId,
  });
  const authoritativePayment = telemetry.measureSync(
    "domain.authoritativeValidate",
    () =>
      validateFreeSplitAuthoritativePayable(db, {
        table,
        tableId: table?.id ?? tableId,
        targetOrderId,
        selectedBillIds: Array.isArray(payload.billIds) ? payload.billIds : [],
        lineSelections: Array.isArray(payload.lineSelections)
          ? payload.lineSelections
          : [],
        articleUnitIds,
        ...paymentDomainOptions(),
      }),
  );
  if (
    authoritativePayment.paymentRefs &&
    Array.isArray(authoritativePayment.paymentRefs.orderIds) &&
    authoritativePayment.paymentRefs.orderIds.length > 0
  ) {
    paymentRefs = authoritativePayment.paymentRefs;
  }
  if (
    paymentRefs.orderIds.length === 0 &&
    Array.isArray(authoritativePayment.alreadySettledOrderIds) &&
    authoritativePayment.alreadySettledOrderIds.length > 0
  ) {
    const settledOrderIds = authoritativePayment.alreadySettledOrderIds;
    paymentRefs = {
      ...paymentRefs,
      orderId: settledOrderIds.length === 1 ? settledOrderIds[0] : null,
      orderIds: settledOrderIds,
    };
  }
  const fiscalDocTypeRaw =
    typeof payload.fiscalDocType === "string"
      ? payload.fiscalDocType.trim().toUpperCase()
      : "";
  const fiscalDocType =
    fiscalDocTypeRaw === "INVOICE"
      ? "INVOICE"
      : fiscalDocTypeRaw === "RECEIPT"
        ? "RECEIPT"
        : null;
  const fiscalDocNo =
    typeof payload.fiscalDocNo === "string" ? payload.fiscalDocNo.trim() : "";
  const issueFiscal =
    !isPosDemoModeEnabled(settings) &&
    (payload.issueFiscal === true || Boolean(fiscalDocType && fiscalDocNo));
  const requestedPaymentTotals = summarizeFreeSplitPaymentRequest(
    partsInput,
    user,
    settings,
    { allowCommercialBenefitOnly: commercialBenefitOnlyPayment },
  );
  const adminAdjustment = normalizePaymentAdminAdjustment(
    payload.adminAdjustment,
    {
      user,
      requestedPaymentTotals,
      authoritativePayment,
    },
  );
  const preflightAlreadySettledCents = Math.max(
    Math.trunc(Number(authoritativePayment.alreadySettledCents) || 0),
    0,
  );
  const isSettledFiscalReplay =
    issueFiscal &&
    authoritativePayment.payableCents <= 0 &&
    preflightAlreadySettledCents > 0 &&
    requestedPaymentTotals.totalDueCents <= preflightAlreadySettledCents + 1 &&
    requestedPaymentTotals.totalPaidCents <= preflightAlreadySettledCents + 1;
  if (isSettledFiscalReplay) {
    const replayOrderIds = [
      ...new Set(
        [
          ...(Array.isArray(authoritativePayment.alreadySettledOrderIds)
            ? authoritativePayment.alreadySettledOrderIds
            : []),
          ...(Array.isArray(paymentRefs.orderIds) ? paymentRefs.orderIds : []),
          targetOrderId,
        ]
          .map((value) => String(value ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const replayPayment = findCompletedPaymentContainerForFiscalReplay(db, {
      tableId: table?.id ?? tableId,
      orderIds: replayOrderIds,
    });
    if (!replayPayment) {
      throw new HttpError(409, "Nessun importo pagabile disponibile.", {
        code: "PAYMENT_NOT_PAYABLE",
      });
    }
    const fiscalExecution = executeFiscalProvider(
      fiscalDocType === "INVOICE" ? "issue_invoice" : "print_receipt",
      {
        tableId,
        orderId: targetOrderId,
        orderIds: replayOrderIds,
        amount: requestedPaymentTotals.totalPaid,
        fiscalDocType: fiscalDocType ?? "RECEIPT",
      },
    );
    const updatedPaymentContainer = sanitizePaymentContainerRecord(
      {
        ...replayPayment.record,
        fiscalDocType: fiscalDocType ?? "RECEIPT",
        fiscalDocNo:
          fiscalDocNo ||
          fiscalExecution?.middleware?.responseCode ||
          `doc_${replayPayment.record.id}`,
        fiscalIssuedAt: fiscalExecution?.middleware?.processedAt ?? nowIso(),
        fiscalIssuedBy: user.id,
      },
      replayPayment.record.id,
    );
    if (!updatedPaymentContainer) {
      throw new HttpError(500, "Impossibile aggiornare il pagamento fiscale.");
    }
    db.paymentContainers[replayPayment.index] = updatedPaymentContainer;
    const auditActor = buildAuditActor(user, payload);
    appendAuditEvent(db, {
      ...auditActor,
      action: "payment.fiscal_replayed",
      entityType: "payment",
      entityId: updatedPaymentContainer.id,
      roomId: updatedPaymentContainer.roomId || auditActor.roomId,
      payload: {
        paymentId: updatedPaymentContainer.id,
        tableId: updatedPaymentContainer.tableId,
        orderId: updatedPaymentContainer.orderId,
        orderIds: updatedPaymentContainer.orderIds,
        amount: requestedPaymentTotals.totalPaid,
      },
    });
    appendAuditEvent(db, {
      ...auditActor,
      action: "fiscal.issued",
      entityType: "payment",
      entityId: updatedPaymentContainer.id,
      roomId: updatedPaymentContainer.roomId || auditActor.roomId,
      payload: {
        paymentId: updatedPaymentContainer.id,
        fiscalDocType: updatedPaymentContainer.fiscalDocType,
        fiscalDocNo: updatedPaymentContainer.fiscalDocNo,
        fiscalIssuedAt: updatedPaymentContainer.fiscalIssuedAt,
      },
    });
    db.meta.lastWriteAt = nowIso();
    await writePaymentDb(db, {
      metricLabel: "payments.freeSplit.fiscalReplay.appStateWrite",
      splitDomains: PAYMENT_FISCAL_REPLAY_WRITE_SPLIT_DOMAINS,
    });
    const replayed = collectPaymentPartsAndTransactionsForContainer(
      db,
      updatedPaymentContainer.id,
    );
    const responseLayout = table
      ? buildIntegrationLayoutFromSettings(settings)
      : null;
    const responseTable = normalizePaymentResponseTableDue(
      table
        ? ((Array.isArray(responseLayout?.tables)
            ? responseLayout.tables
            : []
          ).find((entry) => entry.id === table.id) ?? null)
        : null,
    );
    const responseBody = {
      ok: true,
      fiscalReplay: true,
      payment: updatedPaymentContainer,
      parts: replayed.parts,
      transactions: replayed.transactions,
      table: responseTable,
      releasedTable: null,
    };
    paymentIdempotencyCoordinator.complete(paymentIdempotencyClaim, responseBody);
    sendJson(res, 200, responseBody);
    return;
  }

  const preflightReadiness = telemetry.measureSync(
    "domain.readiness.preflight",
    () =>
      summarizeIntegrationPaymentReadiness(db, {
        tableId,
        orderId: targetOrderId,
        ...paymentDomainOptions(),
      }),
  );
  if (
    preflightReadiness.unpayableDue > 0.009 &&
    requestedPaymentTotals.totalDue > preflightReadiness.payableDue + 0.009
  ) {
    throw new HttpError(
      409,
      "Consegna la comanda prima di incassarla: il pagamento include comande ancora pronte o in preparazione.",
    );
  }
  const preflightTotalDueCents = requestedPaymentTotals.totalDueCents;
  const preflightTotalPaidCents = requestedPaymentTotals.totalPaidCents;
  const preflightSelectedArticleCents = Math.max(
    Math.trunc(Number(authoritativePayment.selectedArticleCents) || 0),
    0,
  );
  const preflightExpectedArticleCents =
    adminAdjustment?.type === "line_price_override"
      ? moneyToCents(adminAdjustment.adjustedAmount)
      : preflightSelectedArticleCents;
  if (authoritativePayment.payableCents <= 0) {
    throw new HttpError(409, "Nessun importo pagabile disponibile.", {
      code: "PAYMENT_NOT_PAYABLE",
    });
  }
  if (
    articleUnitIds.length > 0 &&
    preflightExpectedArticleCents > 0 &&
    Math.abs(preflightTotalDueCents - preflightExpectedArticleCents) > 1
  ) {
    throw new HttpError(
      409,
      "Importo non coerente con gli articoli selezionati.",
      {
        code: "PAYMENT_ARTICLE_AMOUNT_MISMATCH",
        details: {
          selectedArticleDue: centsToMoney(preflightExpectedArticleCents),
          totalDue: requestedPaymentTotals.totalDue,
        },
      },
    );
  }
  if (
    preflightTotalDueCents > authoritativePayment.payableCents + 1 ||
    preflightTotalPaidCents > authoritativePayment.payableCents + 1
  ) {
    throw new HttpError(409, "Importo split superiore al totale pagabile.", {
      code: "PAYMENT_OVERPAYMENT",
      details: {
        payableDue: authoritativePayment.payableDue,
        alreadySettledDue: authoritativePayment.alreadySettledDue,
        totalDue: requestedPaymentTotals.totalDue,
        totalPaid: requestedPaymentTotals.totalPaid,
      },
    });
  }

  const partRecords = [];
  const txRecords = [];
  const legacyPaymentRecords = [];
  const denoms = [];
  const printTransactions = [];
  const providerTransactionLinks = [];
  let paymentCollectionMetadata = normalizePaymentCollectionMetadata(payload);
  let totalDue = 0;
  let totalPaid = 0;
  let partNo = 1;

  for (const partInput of partsInput) {
    const amountDueRaw = Number(partInput?.amountDue);
    const amountDue = Number.isFinite(amountDueRaw)
      ? roundMoney(Math.max(amountDueRaw, 0))
      : 0;
    const txInput = Array.isArray(partInput?.transactions)
      ? partInput.transactions
      : [];
    if (commercialBenefitOnlyPayment && amountDue <= 0 && txInput.length === 0) {
      partNo += 1;
      continue;
    }
    if (amountDue <= 0) {
      throw new HttpError(400, `Quota #${partNo} non valida.`);
    }
    totalDue = roundMoney(totalDue + amountDue);

    const partId = `part_${randomUUID().replace(/-/g, "")}`;
    if (txInput.length === 0) {
      throw new HttpError(400, `Quota #${partNo} senza transazioni.`);
    }

    let partPaid = 0;
    const partTxRecords = [];
    for (const txInputEntry of txInput) {
      const methodRaw = String(txInputEntry?.method ?? "").trim();
      const method = normalizePaymentMethodType(methodRaw);
      const txCollectionMetadata = normalizePaymentCollectionMetadata(
        {
          ...payload,
          ...txInputEntry,
        },
        method,
      );
      if (
        txCollectionMetadata.paymentSource &&
        !paymentCollectionMetadata.paymentSource
      ) {
        paymentCollectionMetadata = txCollectionMetadata;
      }
      const requestedMethodId =
        method === "CASH"
          ? "pay_cash"
          : method === "POS"
            ? "pay_card"
            : String(txInputEntry?.methodId ?? "pay_other").trim() ||
              "pay_other";
      assertUserPaymentMethodAllowed(user, requestedMethodId, settings);
      const amountPaidRaw = Number(txInputEntry?.amountPaid);
      const amountPaid = Number.isFinite(amountPaidRaw)
        ? roundMoney(Math.max(amountPaidRaw, 0))
        : 0;
      if (amountPaid <= 0) {
        throw new HttpError(
          400,
          `Transazione non valida nella quota #${partNo}.`,
        );
      }
      const cashGivenRaw = Number(txInputEntry?.cashGiven);
      if (
        method === "CASH" &&
        Number.isFinite(cashGivenRaw) &&
        cashGivenRaw + 0.0001 < amountPaid
      ) {
        throw new HttpError(
          400,
          "Contante ricevuto inferiore all'importo da pagare.",
          { code: "CASH_GIVEN_TOO_LOW" },
        );
      }
      const txOrdinal = partTxRecords.length + 1;
      const txId = `tx_${randomUUID().replace(/-/g, "")}`;
      let txCardAuthorization = null;
      if (method === "POS") {
        const providerIdempotencyKey = `${idempotencyKey || paymentId}:part-${partNo}:tx-${txOrdinal}:pos`;
        const { transaction: providerTransaction } =
          paymentTransactionRepository.createOrGetInDb(db, {
            transactionId: `ptx_${randomUUID().replace(/-/g, "")}`,
            clientPaymentId: payload.clientPaymentId
              ? `${String(payload.clientPaymentId).trim()}:part-${partNo}:tx-${txOrdinal}`
              : null,
            idempotencyKey: providerIdempotencyKey,
            amount: amountPaid,
            currency: "EUR",
            linesSnapshot: [
              {
                partNo,
                txOrdinal,
                amountPaid,
                method: "POS",
                methodId: txInputEntry?.methodId ?? "pay_card",
              },
            ],
            paymentMethodId: txInputEntry?.methodId ?? "pay_card",
            providerType: "card",
            status: "created",
          });
        if (
          providerTransaction.status === "failed" ||
          providerTransaction.status === "cancelled"
        ) {
          throw new HttpError(
            409,
            "Transazione POS precedente non riutilizzabile: richiede nuova operazione.",
            {
              code: "PAYMENT_PROVIDER_TRANSACTION_NOT_REUSABLE",
              details: {
                transactionId: providerTransaction.transactionId,
                status: providerTransaction.status,
              },
            },
          );
        }
        const existingAuthorization =
          providerTransaction.settlementResponse &&
          typeof providerTransaction.settlementResponse === "object" &&
          providerTransaction.settlementResponse.authorization &&
          typeof providerTransaction.settlementResponse.authorization ===
            "object"
            ? providerTransaction.settlementResponse.authorization
            : null;
        if (existingAuthorization) {
          txCardAuthorization = existingAuthorization;
        } else if (providerTransaction.status === "settled") {
          throw new HttpError(
            409,
            "Transazione POS gia saldata ma senza autorizzazione riconciliabile.",
            {
              code: "PAYMENT_PROVIDER_RECONCILIATION_REQUIRED",
              details: { transactionId: providerTransaction.transactionId },
            },
          );
        } else {
          try {
            await persistPaymentProviderTransaction(
              db,
              providerTransaction.transactionId,
              {
                status: "settlement_pending",
                phase: "settlement_pending",
              },
              {
                action: "payment.provider_settlement_pending",
                user,
                payload,
                details: {
                  amount: amountPaid,
                  paymentMethodId: txInputEntry?.methodId ?? "pay_card",
                  source: "payment_free_split",
                  partNo,
                  txOrdinal,
                },
              },
              {
                metricLabel: "payments.freeSplit.provider.appStateWrite",
                splitDomains: PAYMENT_PROVIDER_WRITE_SPLIT_DOMAINS,
              },
            );
            txCardAuthorization = await authorizeCardPayment({
              amount: amountPaid,
              paymentMethodId: txInputEntry?.methodId ?? "pay_card",
              payload: txInputEntry,
              transactionId: providerTransaction.transactionId,
            });
            await persistPaymentProviderTransaction(
              db,
              providerTransaction.transactionId,
              {
                status: "settlement_pending",
                phase: "settlement_pending",
                settlementResponse: { authorization: txCardAuthorization },
              },
              {
                action: "payment.provider_authorized",
                user,
                payload,
                details: {
                  amount: amountPaid,
                  paymentMethodId: txInputEntry?.methodId ?? "pay_card",
                  source: "payment_free_split",
                  partNo,
                  txOrdinal,
                  provider: txCardAuthorization?.provider ?? null,
                  posTxRef: txCardAuthorization?.posTxRef ?? null,
                },
              },
              {
                metricLabel: "payments.freeSplit.provider.appStateWrite",
                splitDomains: PAYMENT_PROVIDER_WRITE_SPLIT_DOMAINS,
              },
            );
          } catch (error) {
            await persistPaymentProviderFailure(
              db,
              providerTransaction.transactionId,
              error,
              {
                cardAuthorization: txCardAuthorization,
                user,
                payload,
                writeOptions: {
                  metricLabel: "payments.freeSplit.providerFailed.appStateWrite",
                  splitDomains: PAYMENT_PROVIDER_WRITE_SPLIT_DOMAINS,
                },
              },
            );
            throw error;
          }
        }
        providerTransactionLinks.push({
          transactionId: providerTransaction.transactionId,
          txId,
          authorization: txCardAuthorization,
        });
      }
      const cashGiven =
        method === "CASH"
          ? Number.isFinite(cashGivenRaw) && cashGivenRaw >= amountPaid
            ? roundMoney(cashGivenRaw)
            : roundMoney(amountPaid)
          : null;
      const changeGiven =
        method === "CASH" && cashGiven !== null
          ? roundMoney(Math.max(cashGiven - amountPaid, 0))
          : null;
      const txPaymentNote = normalizePaymentPrintNote(
        txInputEntry?.note ?? txInputEntry?.paymentNote ?? paymentNote,
      );
      const txRecord = sanitizePaymentTransactionRecord(
        {
          id: txId,
          partId,
          createdByUserId: user.id,
          createdByUsername: user.username,
          createdAt: String(txInputEntry?.createdAt ?? paymentCreatedAt),
          method,
          ...txCollectionMetadata,
          amountPaid,
          cashGiven,
          changeGiven,
          posProvider:
            method === "POS"
              ? txCardAuthorization?.provider ||
                String(txInputEntry?.posProvider ?? "POS").trim() ||
                "POS"
              : null,
          posTxRef:
            method === "POS"
              ? txCardAuthorization?.posTxRef ||
                String(txInputEntry?.posTxRef ?? "").trim() ||
                null
              : null,
          note: txPaymentNote,
        },
        txId,
      );
      if (!txRecord) {
        throw new HttpError(
          400,
          `Transazione non valida nella quota #${partNo}.`,
        );
      }
      txRecords.push(txRecord);
      partTxRecords.push(txRecord);
      printTransactions.push({
        id: txRecord.id,
        createdAt: txRecord.createdAt,
        amountPaid: txRecord.amountPaid,
        methodType: txRecord.method,
        methodId: String(txInputEntry?.methodId ?? "").trim(),
        methodLabel: String(txInputEntry?.methodLabel ?? "").trim(),
        cashGiven: txRecord.cashGiven,
        changeGiven: txRecord.changeGiven,
        note: txRecord.note || txPaymentNote,
      });
      partPaid = roundMoney(partPaid + txRecord.amountPaid);
      totalPaid = roundMoney(totalPaid + txRecord.amountPaid);

      if (method === "CASH") {
        const denomsIn = Array.isArray(txInputEntry?.cashDenomsIn)
          ? txInputEntry.cashDenomsIn
          : [];
        const denomsOut = Array.isArray(txInputEntry?.cashDenomsOut)
          ? txInputEntry.cashDenomsOut
          : [];
        denomsIn.forEach((entry, index) => {
          const denom = sanitizeCashTxDenomRecord(
            {
              id: `denom_in_${txId}_${index + 1}`,
              txId,
              direction: "IN",
              denomCents: entry?.denomCents,
              qty: entry?.qty,
            },
            `denom_in_${txId}_${index + 1}`,
          );
          if (denom) denoms.push(denom);
        });
        denomsOut.forEach((entry, index) => {
          const denom = sanitizeCashTxDenomRecord(
            {
              id: `denom_out_${txId}_${index + 1}`,
              txId,
              direction: "OUT",
              denomCents: entry?.denomCents,
              qty: entry?.qty,
            },
            `denom_out_${txId}_${index + 1}`,
          );
          if (denom) denoms.push(denom);
        });
      }

      const legacyMethodId = requestedMethodId;
      const legacyMethodLabel =
        method === "CASH"
          ? "Contanti"
          : method === "POS"
            ? "Carta"
            : String(txInputEntry?.methodLabel ?? "Altro").trim() || "Altro";
      const legacyPaymentRecord = sanitizePaymentRecord(
        {
          id: `pay_${randomUUID().replace(/-/g, "")}`,
          tableId: table?.id ?? null,
          tableNumber: table?.number ?? null,
          tableLabel: table
            ? resolveIntegrationLogicalTableLabel(
                settings,
                db.integration,
                table.id,
                table.number,
              )
            : null,
          roomId: roomId || null,
          orderId: paymentRefs.orderId,
          orderIds: paymentRefs.orderIds,
          billId: paymentRefs.billId,
          billIds: paymentRefs.billIds,
          tableCovers: table?.covers ?? null,
          amount: txRecord.amountPaid,
          note: txRecord.note || paymentNote,
          methodId: legacyMethodId,
          methodLabel: legacyMethodLabel,
          ...txCollectionMetadata,
          fiscal: !isPosDemoModeEnabled(settings) && issueFiscal,
          source:
            paymentContinuationSplitMode === "roman"
              ? "free_split_roman_payment"
              : paymentContinuationSplitMode === "amount"
                ? "free_split_amount_payment"
                : paymentContinuationSplitMode === "article"
                  ? "free_split_article_payment"
                  : "free_split_payment",
          adjustmentKind: adminAdjustment?.type ?? null,
          adminAdjustment,
          customerId: null,
          createdAt: txRecord.createdAt,
          createdByUserId: user.id,
          createdByUsername: user.username,
          collectedByUserId: user.id,
          collectedByUsername: user.username,
          collectedByDeviceUuid: session.deviceUuid,
          paymentContainerId: paymentId,
          paymentPartId: partId,
          paymentTxId: txRecord.id,
          changeGiven: txRecord.changeGiven,
          idempotencyKey: idempotencyKey || null,
          clientPaymentId: payload.clientPaymentId
            ? String(payload.clientPaymentId).trim()
            : null,
          items: [],
        },
        `pay_${Date.now()}`,
      );
      if (legacyPaymentRecord) {
        legacyPaymentRecords.push(legacyPaymentRecord);
      }
    }

    const partStatus = partPaid >= amountDue ? "PAID" : "PENDING";
    const partRecord = sanitizePaymentPartRecord(
      {
        id: partId,
        paymentId,
        partNo,
        amountDue,
        status: partStatus,
      },
      partId,
    );
    if (partRecord) {
      partRecords.push(partRecord);
    }
    partNo += 1;
  }

  const readiness = telemetry.measureSync("domain.readiness.final", () =>
    summarizeIntegrationPaymentReadiness(db, {
      tableId,
      orderId: targetOrderId,
      ...paymentDomainOptions(),
    }),
  );
  if (
    readiness.unpayableDue > 0.009 &&
    totalDue > readiness.payableDue + 0.009
  ) {
    throw new HttpError(
      409,
      "Consegna la comanda prima di incassarla: il pagamento include comande ancora pronte o in preparazione.",
    );
  }
  const totalDueCents = moneyToCents(totalDue);
  const totalPaidCents = moneyToCents(totalPaid);
  const commercialBenefitPaymentSummary =
    summarizePaymentCommercialBenefitApplications(
      db,
      commercialBenefitApplicationRefs,
      { user, session },
    );
  const commercialBenefitAmountCents =
    commercialBenefitPaymentSummary.totalBenefitCents;
  const commercialBenefitAmount =
    commercialBenefitCentsToMoney(commercialBenefitAmountCents);
  const selectedArticleCents = Math.max(
    Math.trunc(Number(authoritativePayment.selectedArticleCents) || 0),
    0,
  );
  const expectedArticleCents =
    adminAdjustment?.type === "line_price_override"
      ? moneyToCents(adminAdjustment.adjustedAmount)
      : selectedArticleCents;
  const alreadySettledCents = Math.max(
    Math.trunc(Number(authoritativePayment.alreadySettledCents) || 0),
    0,
  );
  const allowSettledFiscalReplay =
    !isPosDemoModeEnabled(settings) &&
    issueFiscal &&
    authoritativePayment.payableCents <= 0 &&
    alreadySettledCents > 0 &&
    totalDueCents <= alreadySettledCents + 1 &&
    totalPaidCents <= alreadySettledCents + 1;
  if (authoritativePayment.payableCents <= 0 && !allowSettledFiscalReplay) {
    throw new HttpError(409, "Nessun importo pagabile disponibile.", {
      code: "PAYMENT_NOT_PAYABLE",
    });
  }
  if (
    articleUnitIds.length > 0 &&
    expectedArticleCents > 0 &&
    Math.abs(totalDueCents - expectedArticleCents) > 1
  ) {
    throw new HttpError(
      409,
      "Importo non coerente con gli articoli selezionati.",
      {
        code: "PAYMENT_ARTICLE_AMOUNT_MISMATCH",
        details: {
          selectedArticleDue: centsToMoney(expectedArticleCents),
          totalDue,
        },
      },
    );
  }
  const effectivePayableCents = allowSettledFiscalReplay
    ? Math.max(totalDueCents, totalPaidCents)
    : authoritativePayment.payableCents;
  if (
    commercialBenefitOnlyPayment &&
    commercialBenefitAmountCents + 1 < effectivePayableCents
  ) {
    throw new HttpError(
      409,
      "Beneficio commerciale insufficiente per chiudere il pagamento senza incasso.",
      {
        code: "COMMERCIAL_BENEFIT_INSUFFICIENT_FOR_PAYMENT",
        details: {
          payableDue: authoritativePayment.payableDue,
          commercialBenefitAmount,
        },
      },
    );
  }
  if (
    totalDueCents + commercialBenefitAmountCents > effectivePayableCents + 1 ||
    totalPaidCents + commercialBenefitAmountCents > effectivePayableCents + 1
  ) {
    throw new HttpError(409, "Importo split superiore al totale pagabile.", {
      code: "PAYMENT_OVERPAYMENT",
      details: {
        payableDue: authoritativePayment.payableDue,
        alreadySettledDue: authoritativePayment.alreadySettledDue,
        totalDue,
        totalPaid,
        commercialBenefitAmount,
      },
    });
  }

  const shouldIssuePosFiscalReceipt =
    !isPosDemoModeEnabled(settings) &&
    shouldIssuePosFiscalReceiptForPayload(payload);
  const mobileFiscalBlockedTransactions =
    shouldIssuePosFiscalReceipt || issueFiscal
      ? txRecords
          .map((entry) => ({
            entry,
            printTransaction:
              printTransactions.find(
                (printEntry) => printEntry.id === entry.id,
              ) ?? null,
          }))
          .filter(
            ({ entry, printTransaction }) =>
              !isMobileDeviceFiscalAllowed(settings, {
                deviceUuid: session.deviceUuid,
                methodType: entry.method,
                paymentMethodId: printTransaction?.methodId,
              }),
          )
      : [];
  const posFiscalEligibleTransactions = shouldIssuePosFiscalReceipt
    ? txRecords.filter((entry) => {
        const printTransaction =
          printTransactions.find((printEntry) => printEntry.id === entry.id) ??
          null;
        if (
          !isMobileDeviceFiscalAllowed(settings, {
            deviceUuid: session.deviceUuid,
            methodType: entry.method,
            paymentMethodId: printTransaction?.methodId,
          })
        ) {
          return false;
        }
        if (entry.method === "POS") return true;
        if (entry.method !== "CASH") return false;
        return hasConfiguredPosFiscalApiDevice(
          settings,
          printTransaction?.methodId || "pay_cash",
        );
      })
    : [];
  const shouldRunLegacyFiscalProvider =
    !isPosDemoModeEnabled(settings) &&
    isMobileDeviceFiscalAllowed(settings, {
      deviceUuid: session.deviceUuid,
      methodType: posFiscalEligibleTransactions[0]?.method ?? "",
      paymentMethodId: printTransactions[0]?.methodId ?? "",
    }) &&
    issueFiscal &&
    posFiscalEligibleTransactions.length === 0;
  if (posFiscalEligibleTransactions.length > 0 || shouldRunLegacyFiscalProvider) {
    await ensureFiscalReceiptWritePrimaryReady({
      paymentWritePrimary: relationalPaymentsFreeSplitWritePrimary,
    });
  }
  const fiscalExecution = shouldRunLegacyFiscalProvider
    ? executeFiscalProvider(
        fiscalDocType === "INVOICE" ? "issue_invoice" : "print_receipt",
        {
          tableId,
          orderId: targetOrderId,
          orderIds: paymentRefs.orderIds,
          amount: totalPaid,
          fiscalDocType: fiscalDocType ?? "RECEIPT",
        },
      )
    : null;
  const paymentStatus = totalPaid >= totalDue ? "COMPLETED" : "OPEN";
  const paymentContainer = sanitizePaymentContainerRecord(
    {
      id: paymentId,
      ...paymentRefs,
      tableNumber: table?.number ?? null,
      tableLabel: table
        ? resolveIntegrationLogicalTableLabel(
            settings,
            db.integration,
            table.id,
            table.number,
          )
        : null,
      roomId: roomId || null,
      createdByUserId: user.id,
      createdByUsername: user.username,
      collectedByUserId: user.id,
      collectedByUsername: user.username,
      collectedByDeviceUuid: session.deviceUuid,
      ...paymentCollectionMetadata,
      createdAt: paymentCreatedAt,
      status: paymentStatus,
      splitType,
      splitMode: paymentContinuationSplitMode,
      amount: totalPaid,
      note: paymentNote,
      articleUnitIds,
      commercialBenefitApplicationIds: commercialBenefitApplicationRefs,
      commercialBenefitAmountCents,
      commercialBenefitAmount,
      adjustmentKind: adminAdjustment?.type ?? null,
      adminAdjustment,
      idempotencyKey: idempotencyKey || null,
      clientPaymentId: payload.clientPaymentId
        ? String(payload.clientPaymentId).trim()
        : null,
      fiscalDocType: shouldRunLegacyFiscalProvider
        ? (fiscalDocType ?? "RECEIPT")
        : null,
      fiscalDocNo: shouldRunLegacyFiscalProvider
        ? fiscalDocNo ||
          fiscalExecution?.middleware?.responseCode ||
          `doc_${paymentId}`
        : null,
      fiscalIssuedAt: shouldRunLegacyFiscalProvider
        ? (fiscalExecution?.middleware?.processedAt ?? paymentCreatedAt)
        : null,
      fiscalIssuedBy: shouldRunLegacyFiscalProvider ? user.id : null,
    },
    paymentId,
  );
  if (!paymentContainer) {
    throw new HttpError(500, "Impossibile creare il pagamento split.");
  }

  db.paymentContainers.push(paymentContainer);
  db.paymentParts.push(...partRecords);
  db.paymentTransactions.push(...txRecords);
  db.cashTxDenoms.push(...denoms);
  db.payments.push(...legacyPaymentRecords);
  let redeemedCommercialBenefits = [];
  if (commercialBenefitApplicationRefs.length > 0) {
    try {
      redeemedCommercialBenefits = redeemCommercialBenefitApplications(
        db,
        commercialBenefitApplicationRefs,
        {
          now: paymentCreatedAt,
          paymentId: paymentContainer.id,
          user,
          session,
        },
      );
    } catch (error) {
      throw new HttpError(
        409,
        error instanceof Error
          ? error.message
          : "Beneficio commerciale non riscattabile.",
        {
          code: error?.code || "COMMERCIAL_BENEFIT_REDEEM_FAILED",
          details: error?.details ?? {},
        },
      );
    }
  }
  for (const link of providerTransactionLinks) {
    paymentTransactionRepository.updateInDb(db, link.transactionId, {
      status: "settled",
      phase: "settled",
      settlementResponse: {
        paymentId,
        transactionId: link.txId,
        cardAuthorization: link.authorization,
      },
    });
    appendPaymentProviderAuditEvent(db, {
      action: "payment.provider_settled",
      transactionId: link.transactionId,
      user,
      payload,
      details: {
        paymentId,
        transactionId: link.txId,
        source: "payment_free_split",
      },
    });
  }

  const auditStartIndex = Array.isArray(db.auditEvents) ? db.auditEvents.length : 0;
  const auditActor = buildAuditActor(user, payload);
  for (const { entry, printTransaction } of mobileFiscalBlockedTransactions) {
    appendPosFiscalEvent(db, {
      paymentId: entry.id,
      orderId: paymentRefs.orderId || targetOrderId,
      command: "pos_receipt",
      result: "mobile_device_fiscal_disabled",
      message:
        "Emissione fiscale non eseguita: palmare non abilitato alla fiscalita per questo metodo.",
      requiresFiscalRetry: false,
      payload: {
        paymentContainerId: paymentContainer.id,
        deviceUuid: session.deviceUuid,
        methodType: entry.method,
        paymentMethodId: printTransaction?.methodId ?? null,
        paymentMethodLabel: printTransaction?.methodLabel ?? null,
      },
    });
  }
  const posFiscalResults = [];
  const posFiscalJobsToSchedule = [];
  for (const txRecord of posFiscalEligibleTransactions) {
    const printTransaction =
      printTransactions.find((entry) => entry.id === txRecord.id) ?? null;
    const posFiscalResult = await maybeIssuePosFiscalReceipt(db, {
      paymentId: paymentContainer.id,
      transactionId: txRecord.id,
      orderId: paymentRefs.orderId || targetOrderId,
      orderIds: paymentRefs.orderIds,
      articleUnitIds,
      amount: txRecord.amountPaid,
      methodType: txRecord.method,
      paymentMethodId: printTransaction?.methodId,
      paymentMethodLabel: printTransaction?.methodLabel,
      issuedBy: user.id,
      deviceUuid: session.deviceUuid,
      deferSchedule: true,
    });
    posFiscalResults.push(posFiscalResult);
    if (posFiscalResult?.backgroundJob) {
      posFiscalJobsToSchedule.push(posFiscalResult.backgroundJob);
    }
    if (posFiscalResult?.receipt) {
      paymentContainer.fiscalDocType = "RECEIPT";
      paymentContainer.fiscalDocNo =
        paymentContainer.fiscalDocNo || posFiscalResult.receipt.id;
      if (posFiscalResult?.issued) {
        paymentContainer.fiscalIssuedAt =
          paymentContainer.fiscalIssuedAt || posFiscalResult.receipt.createdAt;
        paymentContainer.fiscalIssuedBy =
          paymentContainer.fiscalIssuedBy || user.id;
      }
      const legacyPaymentRecord = legacyPaymentRecords.find(
        (record) => record.paymentTxId === txRecord.id,
      );
      if (posFiscalResult?.issued && legacyPaymentRecord) {
        legacyPaymentRecord.receiptId =
          legacyPaymentRecord.receiptId ?? posFiscalResult.receipt.id;
        legacyPaymentRecord.fiscal = true;
      }
    }
  }
  appendAuditEvent(db, {
    ...auditActor,
    action: "payment.created",
    entityType: "payment",
    entityId: paymentContainer.id,
    roomId: paymentContainer.roomId || auditActor.roomId,
    payload: {
      paymentId: paymentContainer.id,
      tableId: paymentRefs.tableId,
      orderId: paymentRefs.orderId,
      orderIds: paymentRefs.orderIds,
      billId: paymentRefs.billId,
      billIds: paymentRefs.billIds,
      splitType: paymentContainer.splitType,
      totalDue,
      totalPaid,
      commercialBenefitAmount,
      collectedByUserId: user.id,
      collectedByUsername: user.username,
      deviceUuid: session.deviceUuid,
      adjustmentKind: adminAdjustment?.type ?? null,
    },
  });
  appendAuditEvent(db, {
    ...auditActor,
    action: "payment.split_created",
    entityType: "payment",
    entityId: paymentContainer.id,
    roomId: paymentContainer.roomId || auditActor.roomId,
    payload: {
      paymentId: paymentContainer.id,
      tableId: paymentRefs.tableId,
      orderId: paymentRefs.orderId,
      orderIds: paymentRefs.orderIds,
      partsCount: partRecords.length,
      totalDue,
      commercialBenefitAmount,
      adjustmentKind: adminAdjustment?.type ?? null,
    },
  });
  redeemedCommercialBenefits.forEach((application) => {
    appendAuditEvent(db, {
      ...auditActor,
      action: "commercial_benefit.redeemed",
      entityType: "commercial_benefit_application",
      entityId: application.id,
      roomId: paymentContainer.roomId || auditActor.roomId,
      payload: {
        applicationId: application.id,
        campaignId: application.campaignId,
        couponId: application.couponId,
        paymentId: paymentContainer.id,
        benefitAmountCents: application.benefitAmountCents,
        balanceAfterCents: application.balanceAfterPreviewCents,
        forfeitedCents: application.forfeitedPreviewCents,
      },
    });
  });
  txRecords.forEach((txRecord) => {
    appendAuditEvent(db, {
      ...auditActor,
      action: "payment.part_paid",
      entityType: "payment_tx",
      entityId: txRecord.id,
      roomId: paymentContainer.roomId || auditActor.roomId,
      payload: {
        paymentId: paymentContainer.id,
        partId: txRecord.partId,
        txId: txRecord.id,
        method: txRecord.method,
        amountPaid: txRecord.amountPaid,
        tableId: paymentRefs.tableId,
        orderId: paymentRefs.orderId,
        orderIds: paymentRefs.orderIds,
        collectedByUserId: user.id,
        collectedByUsername: user.username,
        deviceUuid: session.deviceUuid,
        cashGiven: txRecord.cashGiven,
        changeGiven: txRecord.changeGiven,
      },
    });
  });
  if (shouldRunLegacyFiscalProvider) {
    appendAuditEvent(db, {
      ...auditActor,
      action: "fiscal.issued",
      entityType: "payment",
      entityId: paymentContainer.id,
      roomId: paymentContainer.roomId || auditActor.roomId,
      payload: {
        paymentId: paymentContainer.id,
        fiscalDocType: paymentContainer.fiscalDocType,
        fiscalDocNo: paymentContainer.fiscalDocNo,
        fiscalIssuedAt: paymentContainer.fiscalIssuedAt,
      },
    });
  }
  if (paymentStatus === "COMPLETED") {
    appendAuditEvent(db, {
      ...auditActor,
      action: "payment.completed",
      entityType: "payment",
      entityId: paymentContainer.id,
      roomId: paymentContainer.roomId || auditActor.roomId,
      payload: {
        paymentId: paymentContainer.id,
        totalPaid,
      },
    });
  }

  const adminAdjustmentUpdate = applyPaymentAdminAdjustmentToOrders(db, {
    adjustment: adminAdjustment,
    paymentRefs,
    tableId,
    orderId: targetOrderId,
    articleUnitIds,
    paymentId: paymentContainer.id,
    roomId: paymentContainer.roomId || auditActor.roomId,
    user,
    payload,
    auditActor,
  });
  const integrationPaymentUpdate = telemetry.measureSync(
    "domain.applyIntegrationPayment",
    () =>
      applyIntegrationPaymentToOrders(db, {
        tableId,
        orderId: targetOrderId,
        totalPaid: roundMoney(totalPaid + commercialBenefitAmount),
        articleUnitIds,
        ...paymentDomainOptions(),
      }),
  );
  const paymentSyncTargetIds = [
    ...new Set(
      [
        ...(Array.isArray(integrationPaymentUpdate.tableIds)
          ? integrationPaymentUpdate.tableIds
          : []),
        ...(Array.isArray(adminAdjustmentUpdate.tableIds)
          ? adminAdjustmentUpdate.tableIds
          : []),
        table?.id ?? null,
      ]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const paymentSyncOrderIds = [
    ...new Set(
      [
        ...(Array.isArray(integrationPaymentUpdate.orderIds)
          ? integrationPaymentUpdate.orderIds
          : []),
        ...(Array.isArray(adminAdjustmentUpdate.orderIds)
          ? adminAdjustmentUpdate.orderIds
          : []),
        ...(Array.isArray(paymentRefs.orderIds) ? paymentRefs.orderIds : []),
        paymentRefs.orderId,
        targetOrderId,
      ]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const syncedFinancials = telemetry.measureSync(
    "domain.tableFinancialSync.final",
    () =>
      paymentSyncTargetIds.length
        ? syncPosTableFinancialsFromIntegrationOrders(
            db,
            paymentSyncTargetIds,
            paymentDomainOptions(),
          )
        : {
            settings,
            liveStats: buildIntegrationTableLiveStats(
              {
                ...db,
                posSettings: settings,
              },
              paymentDomainOptions(),
            ),
          },
  );
  settings = syncedFinancials.settings;
  db.posSettings = settings;

  let releasedTable = null;
  const shouldReleaseTable =
    payload.releaseTable !== false &&
    !posFiscalResults.some((result) => result?.requiresRetry === true);
  if (table && shouldReleaseTable && paymentStatus === "COMPLETED") {
    const tableIndex = settings.tables.findIndex(
      (entry) => entry.id === table.id,
    );
    const currentLayout = buildIntegrationLayoutFromSettings(settings);
    const layoutTable =
      (Array.isArray(currentLayout?.tables) ? currentLayout.tables : []).find(
        (entry) => entry.id === table.id,
      ) ?? table;
    const liveTable = getIntegrationTableLiveStat(
      syncedFinancials.liveStats,
      layoutTable,
    );
    const canResetTable =
      !liveTable ||
      (roundMoney(Math.max(Number(liveTable.amountDue) || 0, 0)) <= 0.009 &&
        Math.max(Math.trunc(Number(liveTable.ordersInProgress) || 0), 0) <= 0);
    if (tableIndex >= 0 && canResetTable) {
      releasedTable = sanitizePosTable(
        {
          ...settings.tables[tableIndex],
          status: "no_orders",
          totalDue: 0,
          pendingBills: [],
        },
        tableIndex + 1,
      );
      settings.tables[tableIndex] = releasedTable;
      db.posSettings = settings;
      appendAuditEvent(db, {
        ...auditActor,
        action: "table.settled",
        entityType: "table",
        entityId: table.id,
        payload: {
          tableId: table.id,
          tableNumber: table.number,
          paymentId: paymentContainer.id,
          nextStatus: releasedTable.status,
          keptOccupied: true,
        },
      });
    }
  }

  const responseLayout = table
    ? overlayIntegrationLayoutFinancials(
        buildIntegrationLayoutFromSettings(settings),
        syncedFinancials.liveStats ??
          buildIntegrationTableLiveStats(
            { ...db, posSettings: settings },
            paymentDomainOptions(),
          ),
      )
    : null;
  const responseTable = normalizePaymentResponseTableDue(
    table
      ? ((Array.isArray(responseLayout?.tables)
          ? responseLayout.tables
          : []
        ).find((entry) => entry.id === table.id) ?? null)
      : null,
  );

  const realtimeBoundary = buildPaymentRealtimeBoundary({
    completed: paymentStatus === "COMPLETED",
    fiscalResults: posFiscalResults,
    paymentStateMachineEnabled,
  });
  const realtimeDetail = {
    paymentId: paymentContainer.id,
    tableId: paymentRefs.tableId,
    orderId: paymentRefs.orderId,
    orderIds: paymentRefs.orderIds,
    billId: paymentRefs.billId,
    billIds: paymentRefs.billIds,
    roomId: paymentContainer.roomId || auditActor.roomId || payload.roomId,
    totalPaid,
    paymentStatus: realtimeBoundary.paymentStatus,
    paymentState: realtimeBoundary.paymentState,
    paymentStatePath: realtimeBoundary.paymentStatePath,
    economicPaymentStatus: paymentStatus,
    fiscalPending: realtimeBoundary.fiscalPending,
    fiscalRecoveryRequired: realtimeBoundary.fiscalRecoveryRequired,
    methodIds: [
      ...new Set(
        txRecords
          .map((txRecord) =>
            String(txRecord?.paymentMethodId ?? txRecord?.method ?? "").trim(),
          )
          .filter(Boolean),
      ),
    ],
    source: "free_split",
  };
  const realtimePayload =
    typeof buildIntegrationNotificationStreamPayload === "function"
      ? buildIntegrationNotificationStreamPayload(
          realtimeBoundary.reason,
          realtimeDetail,
        )
      : { reason: realtimeBoundary.reason, detail: realtimeDetail };
  telemetry.record("domain.prepare", Date.now() - domainPrepareStartedAt);
  telemetry.measureSync("relational.assertTotals", () =>
    assertFreeSplitRelationalTotals({
      paymentContainer,
      paymentParts: partRecords,
      paymentTransactions: txRecords,
      totalDue,
      totalPaid,
    }),
  );
  const mirrorOccurredAt = nowIso();
  const paymentMirrorPayload = buildPaymentFreeSplitMirrorPayload(db, {
    capture: paymentMirrorCapture,
    aggregateId: paymentContainer.id,
    idempotencyKey,
    orderIds: paymentSyncOrderIds,
    tableIds: paymentSyncTargetIds,
    occurredAt: mirrorOccurredAt,
    explicitIds: {
      paymentProviderTransactions: providerTransactionLinks.map(
        (entry) => entry.transactionId,
      ),
      commercialBenefitApplications: [
        ...commercialBenefitApplicationRefs,
        ...redeemedCommercialBenefits.map((entry) => entry?.id),
      ],
    },
  });
  const paymentCollectionEntryIds =
    collectPaymentFreeSplitCollectionEntryIds(paymentMirrorPayload);
  const relationalFreeSplitResult = relationalPaymentsFreeSplitWritePrimary
      ? await telemetry.measure("relational.commit", () =>
        recordRelationalFreeSplitPayment({
          appState: db,
          tableIds: paymentSyncTargetIds,
          orderIds: paymentSyncOrderIds,
          paymentContainer,
          paymentParts: partRecords,
          paymentTransactions: txRecords,
          paymentRecords: legacyPaymentRecords,
          receipts: posFiscalResults
            .map((result) => result?.receipt ?? null)
            .filter(Boolean),
          idempotencyKey,
          realtimePayload,
          mirrorPayload: paymentFreeSplitDurableMirrorEnabled
            ? paymentMirrorPayload
            : null,
          occurredAt: mirrorOccurredAt,
        }),
      )
    : null;

  db.meta.lastWriteAt = mirrorOccurredAt;
  if (paymentFreeSplitDurableMirrorEnabled) {
    const mirrorJob = relationalFreeSplitResult?.domainResult?.paymentMirrorJob;
    if (mirrorJob?.mirrorId) {
      telemetry.record("appState.mirror.enqueued", 0);
      wakePaymentFreeSplitMirrorWorker?.("payment.free_split.committed");
    } else {
      recordPaymentFreeSplitMirrorFallback?.();
      await telemetry.measure("appState.mirror.fallback", async () =>
        await writePaymentFreeSplitDb(db, {
          metricLabel: "payments.freeSplit.durableMirrorFallback.appStateWrite",
          orderIds: paymentSyncOrderIds,
          tableIds: paymentSyncTargetIds,
          auditEventIds: collectPaymentAuditEventIdsSince(db, auditStartIndex),
          collectionEntryIds: paymentCollectionEntryIds,
          allowTransientDefer: false,
        }),
      );
    }
  } else {
    await telemetry.measure("appState.mirror", async () =>
      await writePaymentFreeSplitDb(db, {
        metricLabel: "payments.freeSplit.complete.appStateWrite",
        orderIds: paymentSyncOrderIds,
        tableIds: paymentSyncTargetIds,
        auditEventIds: collectPaymentAuditEventIdsSince(db, auditStartIndex),
        collectionEntryIds: paymentCollectionEntryIds,
      }),
    );
  }
  telemetry.measureSync("realtime.publish", () => {
    if (
      relationalPaymentsFreeSplitWritePrimary &&
      realtimeEventOutboxEnabled &&
      typeof publishRealtimeEventOutboxPending === "function"
    ) {
      publishRealtimeEventOutboxPending();
    } else {
      publishIntegrationNotificationStreamRefresh(
        realtimeBoundary.reason,
        realtimeDetail,
      );
    }
  });
  posFiscalJobsToSchedule.forEach((job) =>
    schedulePosFiscalReceiptBackgroundJob(job),
  );
  const paymentReceiptJobs = await telemetry.measure("receipt.enqueue", () =>
    enqueueMobileElectronicPaymentReceipts({
      settings,
      user,
      clientApp: session?.clientApp,
      deviceUuid: session?.deviceUuid,
      roomId: paymentContainer.roomId || auditActor.roomId || payload.roomId,
      paymentId: paymentContainer.id,
      table,
      tableBills: Array.isArray(table?.pendingBills) ? table.pendingBills : [],
      selectedBillIds: Array.isArray(table?.pendingBills)
        ? table.pendingBills
            .map((bill) => String(bill?.id ?? "").trim())
            .filter(Boolean)
        : [],
      fallbackOrderId: targetOrderId,
      transactions: printTransactions,
      note: paymentNote,
    }),
  );

  const responseBody = {
    ok: true,
    payment: paymentContainer,
    parts: partRecords,
    transactions: txRecords,
    cashDenoms: denoms,
    table: responseTable,
    releasedTable,
    posFiscalReceipts: posFiscalResults
      .map((result) => result?.receipt ?? null)
      .filter((receipt) => receipt !== null),
    fiscalPending: realtimeBoundary.fiscalPending,
    fiscalWarnings: posFiscalResults
      .map((result) => result?.warning ?? "")
      .filter(Boolean),
    fiscalRecoveryRequired: posFiscalResults.some(
      (result) => result?.requiresRetry === true,
    ),
    relational: relationalFreeSplitResult
      ? {
          writePrimary: true,
          replayed: relationalFreeSplitResult.domainResult?.replayed === true,
          paymentTransactionId:
            relationalFreeSplitResult.domainResult?.transaction?.id ?? null,
          paymentTransactionIds: (
            relationalFreeSplitResult.domainResult?.transactions ?? []
          )
            .map((entry) => entry?.id ?? null)
            .filter(Boolean),
          tableInvariant:
            relationalFreeSplitResult.domainResult?.tableInvariant
              ?.summaries ?? [],
        }
      : undefined,
    ...(paymentReceiptJobs.length
      ? {
          paymentReceiptJobs: paymentReceiptJobs.map((job) => ({
            id: job.id,
            printerName: job.printerName,
          })),
        }
      : {}),
  };
  paymentIdempotencyCoordinator.complete(paymentIdempotencyClaim, responseBody);
  sendJson(res, 200, responseBody);
  } catch (error) {
    paymentIdempotencyCoordinator.fail(paymentIdempotencyClaim, error);
    throw error;
  }
}







async function handlePaymentMovementFiscalIssue(req, res) {
  const payload = await readJsonBody(req);
  sendJson(res, 200, await issueMovementFiscal(payload));
}

async function handlePaymentMovementFiscalVoid(req, res) {
  const payload = await readJsonBody(req);
  sendJson(res, 200, await voidMovementFiscal(payload));
}

async function handlePaymentMovementFiscalVerify(req, res) {
  const payload = await readJsonBody(req);
  sendJson(res, 200, await verifyMovementFiscal(payload));
}



async function handlePaymentMovementReprint(req, res) {
    const payload = await readJsonBody(req);
    const movementType = String(payload.type ?? payload.movementType ?? "")
      .trim()
      .toLowerCase();
    const movementId = normalizePaymentMovementId(
      payload.paymentId ?? payload.movementId ?? payload.recordId ?? payload.id,
    );
    if (!movementId) {
      throw new HttpError(400, "Movimento pagamento non valido.");
    }

    const db = await readDb();
    ensurePaymentTrackingArrays(db);
    ensureIntegrationOrderComps(db);
    const { user, session } = validateSessionContext(db, payload);
    if (!canReprintPaymentMovement(user)) {
      throw new HttpError(
        403,
        "Utente non autorizzato alla ristampa del movimento.",
      );
    }
    const actor = buildAuditActor(user, payload);
    const advancedDetails = normalizePaymentMovementAdvancedDetails(
      payload.advancedDetails,
    );
    if (payload.advanced === true && advancedDetails.length > 0) {
      const printJob = await enqueuePaymentMovementAdvancedPrintJobToDb(db, {
        movementId,
        details: advancedDetails,
        user,
        session,
      });
      appendAuditEvent(db, {
        ...actor,
        action: "payment.movement_advanced_printed",
        entityType: "print_job",
        entityId: printJob.id,
        payload: {
          movementType: movementType || "advanced",
          movementId,
          printJobId: printJob.id,
          detailCount: advancedDetails.length,
        },
      });
      db.meta.lastWriteAt = nowIso();
      await writePaymentDb(db, {
        metricLabel: "payments.movement.advancedPrint.appStateWrite",
        splitDomains: PAYMENT_MOVEMENT_PRINT_WRITE_SPLIT_DOMAINS,
      });
      queuePrintSpoolWorker();
      sendJson(res, 200, {
        ok: true,
        movementType: movementType || "advanced",
        fiscalReissued: false,
        fiscalReprinted: false,
        fiscalReprintQueued: false,
        printJobs: [
          {
            id: printJob.id,
            printerName: printJob.printerName,
            status: printJob.status,
          },
        ],
        fiscalReprintJobs: [],
      });
      return;
    }
    let printJobs = [];
    let fiscalReprintJobs = [];
    let resolvedType = movementType;
    const paymentsReadDb = await resolvePaymentsReportReadDb(db);

    if (!resolvedType || resolvedType === "payment") {
      const container = findPaymentReprintContainer(paymentsReadDb, movementId);
      if (container) {
        resolvedType = "payment";
        const result = await enqueuePaymentMovementReprintJobsToDb(db, {
          container,
          user,
          session,
          paymentsReadDb,
        });
        printJobs = result.printJobs;
        if (printJobs.length === 0) {
          throw new HttpError(
            409,
            "Nessuna transazione stampabile per questo pagamento.",
          );
        }
        const fiscalReprintCandidates =
          buildPosFiscalReprintJobsForPaymentContainer(paymentsReadDb, {
          container,
          transactions: result.transactions,
          movementId,
        });
        if (
          fiscalReprintCandidates.some(
            (job) =>
              job.documentKind === "void" &&
              job.blockedReason === "void_reference_missing",
          )
        ) {
          throw new HttpError(
            409,
            "Riferimento del documento fiscale di annullamento non disponibile.",
            { code: "FISCAL_VOID_REPRINT_REFERENCE_MISSING" },
          );
        }
        fiscalReprintJobs = fiscalReprintCandidates.filter((job) =>
          hasConfiguredPosFiscalApiDevice(
            result.settings,
            job.paymentMethod === "cash" ? "pay_cash" : "pay_card",
            "reprint",
          ),
        );
        appendQueuedPosFiscalReprintEvents(db, fiscalReprintJobs);
        appendAuditEvent(db, {
          ...actor,
          action: "payment.movement_reprinted",
          entityType: "payment",
          entityId: container.id,
          roomId: container.roomId || actor.roomId,
          payload: {
            movementType: resolvedType,
            paymentId: container.id,
            printJobIds: printJobs.map((job) => job.id),
            fiscalReprintPaymentIds: fiscalReprintJobs.map(
              (job) => job.paymentId,
            ),
            fiscalReprintReceiptIds: fiscalReprintJobs.map(
              (job) => job.receiptId,
            ),
            fiscalReprintDocumentKinds: fiscalReprintJobs.map(
              (job) => job.documentKind,
            ),
          },
        });
      }
    }

    if (
      (!resolvedType || resolvedType === "storno") &&
      printJobs.length === 0
    ) {
      const compRecord = findPaymentStornoCompRecord(db, movementId);
      if (compRecord) {
        resolvedType = "storno";
        const result = await enqueueStornoMovementReprintJobToDb(db, {
          compRecord,
          user,
          session,
        });
        if (result.printJob) printJobs = [result.printJob];
        appendAuditEvent(db, {
          ...actor,
          action: "payment.storno_movement_reprinted",
          entityType: "print_job",
          entityId: result.printJob?.id ?? compRecord.id,
          roomId: compRecord.roomId || actor.roomId,
          payload: {
            movementType: resolvedType,
            compId: compRecord.id,
            orderId: compRecord.orderId,
            printJobId: result.printJob?.id ?? null,
          },
        });
      }
    }

    if (printJobs.length === 0) {
      throw new HttpError(
        404,
        "Movimento pagamento non trovato o non ristampabile.",
      );
    }

    db.meta.lastWriteAt = nowIso();
    await writePaymentDb(db, {
      metricLabel: "payments.movement.reprint.appStateWrite",
      splitDomains: PAYMENT_MOVEMENT_REPRINT_WRITE_SPLIT_DOMAINS,
    });
    queuePrintSpoolWorker();
    schedulePosFiscalReprintBackgroundJobs(fiscalReprintJobs);
    sendJson(res, 200, {
      ok: true,
      movementType: resolvedType,
      fiscalReissued: false,
      fiscalReprinted: false,
      fiscalReprintQueued: fiscalReprintJobs.length > 0,
      printJobs: printJobs.map((job) => ({
        id: job.id,
        printerName: job.printerName,
        status: job.status,
      })),
      fiscalReprintJobs: fiscalReprintJobs.map((job) => ({
        paymentId: job.paymentId,
        receiptId: job.receiptId,
        providerRef: job.providerRef,
        documentKind: job.documentKind,
        status: "queued",
      })),
    });
  }

  return {
    "payments.table": handlePayTable,
    "payments.freeSplit": handleFreeSplitWithTelemetry,
    "reports.paymentMovementReprint": handlePaymentMovementReprint,
    "reports.paymentMovementFiscalVerify": handlePaymentMovementFiscalVerify,
    "reports.paymentMovementFiscalIssue": handlePaymentMovementFiscalIssue,
    "reports.paymentMovementFiscalVoid": handlePaymentMovementFiscalVoid,
  };
}
