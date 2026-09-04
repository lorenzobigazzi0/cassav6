/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createPayTicketHandlers({
  ensurePaymentTrackingArrays,
  FISCAL_OUTBOX_WORKER_ENABLED,
  HttpError,
  mapPaymentMethodToTransactionType,
  PAYMENT_PROVIDER_WRITE_SPLIT_DOMAINS,
  RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY,
  appendAuditEvent,
  appendPaymentProviderAuditEvent,
  assertUserPaymentMethodAllowed,
  authorizeCardPayment,
  buildAuditActor,
  buildIntegrationNotificationStreamPayload,
  buildPaymentRealtimeBoundary,
  ensureRelationalFiscalReceiptsWritePrimary,
  ensureRelationalPaymentsTicketWritePrimary,
  ensureServerIdempotencyKey,
  executeFiscalProvider,
  findExistingPaymentByIdempotency,
  findPaymentMethod,
  isFiscalReceiptIssued,
  isMobileDeviceFiscalAllowed,
  isPosDemoModeEnabled,
  maybeIssuePosFiscalReceipt,
  normalizeSmartCardCode,
  nowIso,
  paymentIdempotencyCoordinator,
  paymentTransactionRepository,
  persistPaymentProviderFailure,
  persistPaymentProviderTransaction,
  publishIntegrationNotificationStreamRefresh,
  randomUUID,
  readDb,
  readJsonBody,
  realtimeEventOutboxCoordinator,
  recordRelationalTicketPayment,
  RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY,
  roundMoney,
  sanitizeFiscalReceipt,
  sanitizePaymentContainerRecord,
  sanitizePaymentItem,
  sanitizePaymentPartRecord,
  sanitizePaymentRecord,
  sanitizePaymentTransactionRecord,
  sanitizePosSettings,
  sanitizeSmartNonFiscalEntry,
  schedulePosFiscalReceiptBackgroundJob,
  sendJson,
  shouldIssuePosFiscalReceiptForTransaction,
  validatePaymentLinesAndAmount,
  validateSessionContext,
  writePaymentDb,
  writePaymentTicketDb,
}) {
  async function handlePayTicket(req, res) {
    const payload = await readJsonBody(req);
    const paymentMethodId =
      typeof payload.paymentMethodId === "string"
        ? payload.paymentMethodId.trim()
        : "";
    if (!paymentMethodId) {
      throw new HttpError(400, "Metodo di pagamento non valido.");
    }
  
    const lines = (Array.isArray(payload.lines) ? payload.lines : [])
      .map((line) => sanitizePaymentItem(line))
      .filter((line) => line !== null);
    if (lines.length === 0) {
      throw new HttpError(400, "Nessun articolo da incassare.");
    }
  
    const amountFromLines = roundMoney(
      lines.reduce((sum, line) => sum + Math.max(line.lineTotal, 0), 0),
    );
    const amountRaw = Number(payload.amount);
    const amount = Number.isFinite(amountRaw)
      ? roundMoney(Math.max(amountRaw, 0))
      : amountFromLines;
    if (amount <= 0) {
      throw new HttpError(400, "Nessun importo da pagare.");
    }
    validatePaymentLinesAndAmount(lines, amount);
  
    const db = await readDb();
    const { user, session } = validateSessionContext(db, payload);
    ensurePaymentTrackingArrays(db);
    const idempotencyKey = ensureServerIdempotencyKey(payload, "ticket");
    if (RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY) {
      await ensureRelationalPaymentsTicketWritePrimary();
    }
    const paymentIdempotencyClaim = paymentIdempotencyCoordinator.begin({
      key: idempotencyKey,
      scope: "payment.ticket",
      endpoint: "/api/payments/ticket",
      payload: {
        ...payload,
        idempotencyKey,
      },
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
    const existingProviderTransaction =
      paymentTransactionRepository.findByIdempotencyInDb(db, idempotencyKey);
    if (
      existingProviderTransaction &&
      existingProviderTransaction.status !== "created"
    ) {
      const responseBody = {
        ok: true,
        idempotent: true,
        transaction: existingProviderTransaction,
        message: "Transazione pagamento gia presente; nessun duplicato creato.",
      };
      paymentIdempotencyCoordinator.complete(paymentIdempotencyClaim, responseBody);
      sendJson(res, 200, responseBody);
      return;
    }
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
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
    const { transaction: providerTransaction } =
      paymentTransactionRepository.createOrGetInDb(db, {
        transactionId: `ptx_${randomUUID().replace(/-/g, "")}`,
        clientPaymentId: payload.clientPaymentId
          ? String(payload.clientPaymentId).trim()
          : null,
        idempotencyKey,
        amount,
        currency: "EUR",
        linesSnapshot: lines,
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
      await writePaymentDb(db, { metricLabel: "payments.ticket.cashRejected.appStateWrite", splitDomains: ["paymentProviderTransactions"] });
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
              source: "pay_ticket",
            },
          },
          { metricLabel: "payments.ticket.provider.appStateWrite", splitDomains: PAYMENT_PROVIDER_WRITE_SPLIT_DOMAINS },
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
              source: "pay_ticket",
              provider: cardAuthorization?.provider ?? null,
              posTxRef: cardAuthorization?.posTxRef ?? null,
            },
          },
          { metricLabel: "payments.ticket.provider.appStateWrite", splitDomains: PAYMENT_PROVIDER_WRITE_SPLIT_DOMAINS },
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
            writeOptions: { metricLabel: "payments.ticket.providerFailed.appStateWrite", splitDomains: PAYMENT_PROVIDER_WRITE_SPLIT_DOMAINS },
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
    if (
      RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY &&
      (shouldIssuePosFiscalReceipt || shouldRunLegacyFiscalProvider)
    ) {
      await ensureRelationalFiscalReceiptsWritePrimary({
        paymentWritePrimary: RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY,
      });
    }
  
    if (shouldRunLegacyFiscalProvider) {
      const fiscalResult = executeFiscalProvider("print_receipt", {
        tableId: null,
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
        const nonFiscalRecord = sanitizeSmartNonFiscalEntry(
          {
            id: `smart_nf_${randomUUID().replace(/-/g, "")}`,
            kind: "smart_payment",
            description: "Pagamento smart banco",
            amount,
            createdAt: nowIso(),
            methodId: method.id,
            methodLabel: method.label,
            customerId: null,
            customerLabel: "Banco",
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
            responseMessage: "Pagamento registrato.",
          };
    }
  
    const paymentContainer = sanitizePaymentContainerRecord(
      {
        id: paymentId,
        orderId: null,
        roomId: typeof payload.roomId === "string" ? payload.roomId.trim() : null,
        createdByUserId: user.id,
        createdByUsername: user.username,
        createdAt: nowIso(),
        status: "COMPLETED",
        splitType: "SINGLE",
        amount,
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
  
    const paymentRecord = sanitizePaymentRecord(
      {
        id: paymentId,
        tableId: null,
        amount,
        methodId: method.id,
        methodLabel: method.label,
        fiscal: shouldRunLegacyFiscalProvider,
        source: "ticket_payment",
        customerId: null,
        createdAt: nowIso(),
        createdByUserId: user.id,
        createdByUsername: user.username,
        receiptId: receipt?.id ?? null,
        paymentContainerId: paymentContainer?.id ?? null,
        paymentPartId: paymentPart?.id ?? null,
        paymentTxId: paymentTx?.id ?? null,
        changeGiven,
        idempotencyKey: idempotencyKey || null,
        clientPaymentId: payload.clientPaymentId
          ? String(payload.clientPaymentId).trim()
          : null,
        items: lines,
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
        source: "pay_ticket",
      },
    });
  
    const auditActor = buildAuditActor(user, payload);
    let posFiscalResult = null;
    const posFiscalJobsToSchedule = [];
    if (shouldIssuePosFiscalReceipt && paymentTx) {
      posFiscalResult = await maybeIssuePosFiscalReceipt(db, {
        paymentId,
        transactionId: paymentTx.id,
        amount,
        paymentItems: lines,
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
        splitType: "SINGLE",
        amount,
        source: "ticket_payment",
      },
    });
    appendAuditEvent(db, {
      ...auditActor,
      action: "payment.completed",
      entityType: "payment",
      entityId: paymentId,
      payload: {
        paymentId,
        amount,
        methodId: method.id,
        source: "ticket_payment",
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
  
    const realtimeBoundary = buildPaymentRealtimeBoundary({
      completed: true,
      fiscalResults: [posFiscalResult],
    });
    const realtimeDetail = {
      paymentId,
      amount,
      methodId: method.id,
      roomId: payload.roomId,
      paymentStatus: realtimeBoundary.paymentStatus,
      fiscalPending: realtimeBoundary.fiscalPending,
      fiscalRecoveryRequired: realtimeBoundary.fiscalRecoveryRequired,
      source: "ticket_payment",
    };
    const realtimePayload = buildIntegrationNotificationStreamPayload(
      realtimeBoundary.reason,
      realtimeDetail,
    );
    const relationalTicketResult = RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY
      ? await recordRelationalTicketPayment({
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
    await writePaymentTicketDb(db, "payments.ticket.complete.appStateWrite");
    if (
      RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY &&
      realtimeEventOutboxCoordinator.enabled
    ) {
      realtimeEventOutboxCoordinator.publishPending();
    } else {
      publishIntegrationNotificationStreamRefresh(
        realtimeBoundary.reason,
        realtimeDetail,
      );
    }
    if (FISCAL_OUTBOX_WORKER_ENABLED && posFiscalJobsToSchedule.length > 0) console.info(`[fiscal-outbox] ${posFiscalJobsToSchedule.length} job POS non schedulati dal path legacy: gestiti da fiscal_outbox.`);
    else posFiscalJobsToSchedule.forEach((job) => schedulePosFiscalReceiptBackgroundJob(job));
  
    const responseBody = {
      ok: true,
      payment: paymentRecord,
      receipt,
      middleware: middlewareResponse,
      posFiscalReceipt: posFiscalResult?.receipt ?? null,
      fiscalPending: realtimeBoundary.fiscalPending,
      fiscalWarning: posFiscalResult?.warning ?? null,
      fiscalRecoveryRequired: posFiscalResult?.requiresRetry === true,
      relational: relationalTicketResult
        ? {
            writePrimary: true,
            replayed: relationalTicketResult.domainResult?.replayed === true,
            paymentTransactionId:
              relationalTicketResult.domainResult?.transaction?.id ?? null,
          }
        : undefined,
    };
    paymentIdempotencyCoordinator.complete(paymentIdempotencyClaim, responseBody);
    sendJson(res, 200, responseBody);
    } catch (error) {
      paymentIdempotencyCoordinator.fail(paymentIdempotencyClaim, error);
      throw error;
    }
  }
  
  

  return {
    handlePayTicket,
  };
}
