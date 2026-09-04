/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createIntegrationOrderCompHandlers({
  appendPaymentStornoPrintJobToDb,
  ORDERS_COMP_ASYNC_ACK,
  applyOrderCompPaymentAdjustmentsForRefundPlan,
  buildPaymentReferencesFromRefundPlan,
  buildOrderCompRefundPlan,
  RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY,
  resolveOrderCompPaymentReferences,
  RELATIONAL_ORDERS_COMP_WRITE_PRIMARY,
  BAR_CHARGE_REPLACEMENT_FISCAL_TREATMENT,
  BAR_CHARGE_REPLACEMENT_LINE_TYPE,
  HttpError,
  allocateIntegrationOrderId,
  alreadyCompedQuantityForOrderLine,
  appendAuditEvent,
  appendPrintSpoolJobToDb,
  appendReplacementOrderPrintJobToDb,
  appendReplacementPrecontoPrintJobToDb,
  applyIntegrationAutoAssignment,
  applyOrderFinancialTableRevisionTokens,
  areIntegrationTablesLinkedByGroup,
  assertActiveTableWorkLock,
  assertUserCanApplyOrderComp,
  assertUserCanOperateInTableRoom,
  buildAuditActor,
  buildOrderFinancialSyncState,
  buildReplacementPrintText,
  captureRelationalOrderFinancialTableGuard,
  clampInt,
  collectAuditEventIdsSince,
  collectOrderArticleUnitIdsForComp,
  ensureIntegrationOrderComps,
  findExistingIntegrationIdempotencyRecord,
  findIntegrationOrderIndexByLookup,
  findOrderLineForComp,
  findPosTableWithLayout,
  findRelationalOrderById,
  isIntegrationOrderPayable,
  listRelationalOrderWorkflowSnapshot,
  makeIntegrationOrderItemFromProduct,
  markIntegrationOrderDeliveredForWorkflow,
  normalizeIdempotencyKey,
  normalizeIntegrationOrderWriteIds,
  normalizeIntegrationStationName,
  nowIso,
  persistRelationalOrderFinancialTables,
  queuePrintSpoolWorker,
  randomUUID,
  readDb,
  readJsonBody,
  relationalRuntime,
  resolveIntegrationLogicalTableLabel,
  resolveOrderFinancialSnapshotTableIds,
  roundMoney,
  runtimeMetrics,
  sanitizeIntegrationLineRoute,
  sanitizeIntegrationOrder,
  sanitizeIntegrationTableLabel,
  sanitizeIntegrationTicketEntry,
  sanitizePosSettings,
  sendJson,
  shouldAutoDeliverReadyIntegrationOrder,
  slugifyId,
  syncPosTableFinancialsFromIntegrationOrders,
  syncRelationalOrderPrimary,
  validateOrderCompReason,
  validateSessionContext,
  writeIntegrationOrderSyncDb,
  writeOrderStornoFiscalPaymentIntentDb,
}) {
  async function handleIntegrationOrderComp(req, res, requestUrl = null) {
    const payload = await readJsonBody(req);
    const requestPath = String(requestUrl?.pathname ?? "").trim();
    const orderId = String(payload.orderId ?? payload.id ?? "").trim();
    const originalLineId = String(
      payload.originalLineId ?? payload.lineId ?? "",
    ).trim();
    const productId = String(payload.productId ?? "").trim();
    const quantity = clampInt(payload.quantity ?? payload.qty, 1, 99, 1);
    const reason = validateOrderCompReason(payload.reason);
    const sendReplacement =
      payload.sendReplacement === true || payload.reorderZero === true;
    const requestedOperationType = String(
      payload.operationType ?? payload.operation ?? payload.refundMode ?? "",
    ).trim();
    const explicitStornoRequest =
      requestPath === "/api/integration/orders/storno" ||
      ["storno", "financial_storno", "refund_storno", "reso"].includes(
        requestedOperationType,
      );
    const orderCompWritePrimary = explicitStornoRequest ? RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY : RELATIONAL_ORDERS_COMP_WRITE_PRIMARY;
    const orderCompMetricPrefix = explicitStornoRequest ? "orders.storno" : "orders.comp";
    let requestedOrderCompRevision = clampInt(payload.expectedRevision ?? payload.currentRevision ?? payload.revision, 0, 1_000_000, 0);
    if (!orderId || (!originalLineId && !productId)) {
      throw new HttpError(400, "Comanda e articolo sono obbligatori.");
    }
  
    const db = await readDb({
      refreshExternalizedSessions: true,
      refreshExternalizedTableLocks: true,
    });
    ensureIntegrationOrderComps(db);
    const authContext =
      req.__authContext && typeof req.__authContext === "object"
        ? req.__authContext
        : validateSessionContext(db, payload);
    const { user, session } = authContext;
    assertUserCanApplyOrderComp(user);
    const auditStartIndex = Array.isArray(db.auditEvents) ? db.auditEvents.length : 0;
    const idempotencyKey = normalizeIdempotencyKey(payload);
    const existing = findExistingIntegrationIdempotencyRecord(
      db.integration.orderComps,
      idempotencyKey,
      user,
      session.deviceUuid,
    );
    if (existing) {
      sendJson(res, 200, { ok: true, idempotent: true, comp: existing });
      return;
    }
  
    db.integration.orders = Array.isArray(db.integration.orders) ? db.integration.orders : [];
    let orderIndex = findIntegrationOrderIndexByLookup(db.integration.orders, orderId);
    let currentOrder = orderIndex >= 0 ? sanitizeIntegrationOrder(db.integration.orders[orderIndex], String(db.integration.orders[orderIndex]?.id ?? orderId).trim() || orderId) : null;
    if (requestedOrderCompRevision <= 0 && currentOrder) {
      requestedOrderCompRevision = clampInt(
        currentOrder.revision ?? currentOrder.currentRevision,
        0,
        1_000_000,
        0,
      );
    }
    const relationalOrderCompCurrentOrder = await findRelationalOrderById({ enabled: orderCompWritePrimary, orderId: currentOrder?.id ?? orderId, relationalRuntime, runtimeMetrics });
    if (relationalOrderCompCurrentOrder) {
      currentOrder = sanitizeIntegrationOrder(relationalOrderCompCurrentOrder, String(relationalOrderCompCurrentOrder.id ?? orderId).trim() || orderId);
      if (orderIndex < 0) { db.integration.orders.push(currentOrder); orderIndex = db.integration.orders.length - 1; } else db.integration.orders[orderIndex] = currentOrder;
    }
    if (!currentOrder || orderIndex < 0) throw new HttpError(404, "Comanda non trovata.");
    const canonicalOrderId = currentOrder.id;
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    if (shouldAutoDeliverReadyIntegrationOrder(currentOrder, settings)) {
      currentOrder = markIntegrationOrderDeliveredForWorkflow(
        currentOrder,
        canonicalOrderId,
      );
    }
    if (!isIntegrationOrderPayable(currentOrder, settings)) {
      throw new HttpError(409, "La comanda non e ancora pagabile.");
    }
    const dueAmount = roundMoney(
      Math.max(Number(currentOrder.dueAmount) || 0, 0),
    );
    const orderAlreadyPaid =
      String(currentOrder.paymentStatus ?? "")
        .trim()
        .toLowerCase() === "paid";
    if (!orderAlreadyPaid && dueAmount <= 0.009) {
      throw new HttpError(409, "Nessun importo pagabile disponibile.");
    }
  
    const tableId = String(payload.tableId ?? currentOrder.tableId ?? "").trim();
    if (
      tableId &&
      currentOrder.tableId &&
      tableId !== currentOrder.tableId &&
      !areIntegrationTablesLinkedByGroup(
        db.integration,
        currentOrder.tableId,
        tableId,
      )
    ) {
      throw new HttpError(400, "La comanda non appartiene al tavolo indicato.");
    }
    const lockTableId = tableId || currentOrder.tableId;
    const tableInfo = lockTableId
      ? findPosTableWithLayout(settings, lockTableId)
      : null;
    if (lockTableId && !tableInfo) {
      throw new HttpError(404, "Tavolo non trovato.");
    }
    const roomId = String(
      payload.roomId ?? currentOrder.roomId ?? tableInfo?.roomId ?? "",
    ).trim();
    if (tableInfo && lockTableId) {
      assertUserCanOperateInTableRoom(user, settings, { ...tableInfo, roomId });
      assertActiveTableWorkLock(db, lockTableId, {
        user,
        session,
        payload: { ...payload, roomId },
        purpose: "order.comp",
      });
    }
  
    const line = findOrderLineForComp(currentOrder, originalLineId, productId);
    if (!line) {
      throw new HttpError(400, "Articolo da rendere non trovato.");
    }
    const alreadyCompedQuantity = alreadyCompedQuantityForOrderLine(
      db,
      canonicalOrderId,
      line.lineId || originalLineId,
      line.productId || productId,
    );
    const availableQuantity = Math.max(
      Math.trunc(Number(line.quantity) || 0) - alreadyCompedQuantity,
      0,
    );
    if (availableQuantity <= 0) {
      throw new HttpError(409, "Nessun importo pagabile disponibile.");
    }
    if (quantity > availableQuantity) {
      throw new HttpError(
        400,
        `Quantita reso superiore ai pezzi disponibili (${availableQuantity}).`,
        {
          code: "ORDER_COMP_QUANTITY_EXCEEDS_AVAILABLE",
          details: { availableQuantity },
        },
      );
    }
    const compQuantity = Math.min(quantity, line.quantity, availableQuantity);
    const requestedAmount = roundMoney(
      Math.max(line.unitPrice, 0) * compQuantity,
    );
    const compArticleUnitIds = collectOrderArticleUnitIdsForComp(
      db,
      currentOrder,
      line,
      compQuantity,
      alreadyCompedQuantity,
    );
    const isZeroCostReplacement = sendReplacement === true;
    const operationType = isZeroCostReplacement
      ? "zero_cost_replacement"
      : "storno";
    const previousTotal = roundMoney(
      Math.max(Number(currentOrder.total) || 0, 0),
    );
    const previousPaidAmount = roundMoney(
      Math.max(Number(currentOrder.paidAmount) || 0, 0),
    );
    const previousDueAmount = roundMoney(
      Math.max(Number(currentOrder.dueAmount) || 0, 0),
    );
    const previousCompedAmount = roundMoney(
      Math.max(Number(currentOrder.compedAmount) || 0, 0),
    );
    const paymentReferencesForCoverage = isZeroCostReplacement
      ? []
      : resolveOrderCompPaymentReferences(db, {
          order: currentOrder,
          articleUnitIds: compArticleUnitIds,
          amount: requestedAmount,
          requireArticleUnitMatch: !orderAlreadyPaid,
        });
    const referencedPaidAmount = roundMoney(
      paymentReferencesForCoverage.reduce(
        (sum, reference) => sum + Math.max(Number(reference?.amount) || 0, 0),
        0,
      ),
    );
    const paidCompAmount = isZeroCostReplacement
      ? 0
      : orderAlreadyPaid
        ? roundMoney(Math.min(requestedAmount, previousPaidAmount))
        : roundMoney(
            Math.min(requestedAmount, referencedPaidAmount, previousPaidAmount),
          );
    const unpaidCompAmount = isZeroCostReplacement
      ? 0
      : orderAlreadyPaid
        ? 0
        : roundMoney(
            Math.min(Math.max(requestedAmount - paidCompAmount, 0), dueAmount),
          );
    const compAmount = roundMoney(paidCompAmount + unpaidCompAmount);
    if (!isZeroCostReplacement && compAmount <= 0.009) {
      throw new HttpError(409, "Nessun importo stornabile disponibile.");
    }
    let paymentReferences = [];
    const nextTotal = isZeroCostReplacement
      ? previousTotal
      : roundMoney(Math.max(previousTotal - compAmount, 0));
    const nextPaidAmount = isZeroCostReplacement
      ? previousPaidAmount
      : roundMoney(
          Math.max(Math.min(previousPaidAmount - paidCompAmount, nextTotal), 0),
        );
    const nextDueAmount = isZeroCostReplacement
      ? previousDueAmount
      : roundMoney(Math.max(nextTotal - nextPaidAmount, 0));
    const nextCompedAmount = isZeroCostReplacement
      ? previousCompedAmount
      : roundMoney(previousCompedAmount + compAmount);
    const grossTotalBeforeComps =
      Number(currentOrder.grossTotalBeforeComps) > 0
        ? roundMoney(Number(currentOrder.grossTotalBeforeComps))
        : previousTotal;
  
    const currentRevision = clampInt(
      currentOrder.revision ?? currentOrder.currentRevision,
      1,
      1_000_000,
      1,
    );
    if (orderCompWritePrimary && requestedOrderCompRevision > 0 && currentRevision !== requestedOrderCompRevision) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision, expectedRevision: requestedOrderCompRevision } });
    const nextRevision = currentRevision + 1;
    const createdAt = nowIso();
    const compId = `comp_${randomUUID().replace(/-/g, "")}`;
    const refundPlan = isZeroCostReplacement
      ? {
          id: `refund_${compId}`,
          status: "not_required",
          mode: "zero_cost_replacement",
          amount: 0,
          fiscalReturnAmount: 0,
          posPartialSupported: false,
          articleUnitIds: compArticleUnitIds,
          allocations: [],
          instructions:
            "Sostituzione a costo 0: nessuna modifica a totale, tavolo o pagamenti.",
        }
      : buildOrderCompRefundPlan(db, {
          order: currentOrder,
          articleUnitIds: compArticleUnitIds,
          amount: paidCompAmount,
          compId,
        });
    paymentReferences = isZeroCostReplacement
      ? []
      : buildPaymentReferencesFromRefundPlan(refundPlan);
    const tableLabel =
      sanitizeIntegrationTableLabel(
        payload.tableLabel ?? payload.logicalTableLabel,
      ) ||
      resolveIntegrationLogicalTableLabel(
        settings,
        db.integration,
        currentOrder.tableId,
        currentOrder.tableNumber,
      ) ||
      currentOrder.tableLabel;
    const compRecord = {
      id: compId,
      orderId: canonicalOrderId,
      lineId: line.lineId || originalLineId,
      productId: line.productId || productId,
      productName: line.productName,
      quantity: compQuantity,
      unitPrice: line.unitPrice,
      requestedAmount,
      amount: compAmount,
      paidAmount: paidCompAmount,
      unpaidAmount: unpaidCompAmount,
      articleUnitIds: compArticleUnitIds,
      paymentReferences,
      refundPlan,
      reason,
      sendReplacement,
      operationType,
      requestedOperationType: explicitStornoRequest
        ? "storno"
        : requestedOperationType || operationType,
      nonFinancialReplacement: isZeroCostReplacement,
      replacementSettlement: isZeroCostReplacement ? "non_chargeable_zero" : null,
      financialImpact: isZeroCostReplacement ? "none" : "storno",
      fiscalTreatment: isZeroCostReplacement
        ? BAR_CHARGE_REPLACEMENT_FISCAL_TREATMENT
        : "payment_storno",
      tableId: currentOrder.tableId,
      tableNumber: currentOrder.tableNumber,
      tableLabel,
      roomId,
      createdByUserId: user.id,
      createdByUsername: user.username,
      createdByDeviceUuid: session.deviceUuid,
      createdAt,
      idempotencyKey: idempotencyKey || null,
    };
    const paymentAdjustment = isZeroCostReplacement
      ? {
          voidAmount: 0,
          rechargeAmount: 0,
          stornoAmount: 0,
          rechargePaymentIds: [],
          rechargeTransactionIds: [],
          rechargePrintJobIds: [],
          rechargePrintPayloads: [],
        }
      : await applyOrderCompPaymentAdjustmentsForRefundPlan(db, {
          refundPlan,
          settings,
          user,
          session,
          order: currentOrder,
          compId,
          roomId,
          tableLabel,
          createdAt,
        });
    compRecord.paymentVoidAmount = paymentAdjustment.voidAmount;
    compRecord.paymentRechargeAmount = paymentAdjustment.rechargeAmount;
    compRecord.paymentStornoAmount = paymentAdjustment.stornoAmount;
    compRecord.rechargePaymentIds = paymentAdjustment.rechargePaymentIds;
    compRecord.rechargeTransactionIds = paymentAdjustment.rechargeTransactionIds;
    compRecord.rechargePrintJobIds = paymentAdjustment.rechargePrintJobIds;
  
    let nextOrder = sanitizeIntegrationOrder(
      {
        ...currentOrder,
        total: nextTotal,
        paidAmount: nextPaidAmount,
        dueAmount: nextDueAmount,
        compedAmount: nextCompedAmount,
        ...(isZeroCostReplacement
          ? {}
          : {
              grossTotalBeforeComps,
              totalAdjustedByComps: true,
            }),
        revision: nextRevision,
        currentRevision: nextRevision,
        lastCompId: compId,
        updatedAt: createdAt,
      },
      canonicalOrderId,
    );
  
    let replacementRecord = null;
    let replacementOrder = null;
    let printJob = null;
    let replacementOrderPrintJob = null;
    let precontoPrintJob = null;
    let stornoPrintJob = null;
    const rechargePrintJobs = [];
    if (sendReplacement) {
      const replacementOrderId = await allocateIntegrationOrderId(db);
      const replacementLineId = `repl_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const product = {
        id: line.productId || productId || slugifyId(line.productName, "product"),
        name: line.productName,
        price: 0,
      };
      replacementRecord = {
        id: `bar_repl_${randomUUID().replace(/-/g, "")}`,
        lineType: BAR_CHARGE_REPLACEMENT_LINE_TYPE,
        chargePolicy: "BAR_INTERNAL",
        payable: false,
        customerPrice: 0,
        unitPrice: 0,
        tableId: currentOrder.tableId,
        tableNumber: tableInfo?.table?.number ?? currentOrder.tableNumber,
        tableLabel,
        roomId,
        orderId: replacementOrderId,
        originalOrderId: canonicalOrderId,
        orderIds: [canonicalOrderId, replacementOrderId],
        originalLineId: line.lineId || originalLineId,
        replacementLineId,
        productId: product.id,
        productName: product.name,
        quantity: compQuantity,
        reason,
        createdByUserId: user.id,
        createdByUsername: user.username,
        createdByDeviceUuid: session.deviceUuid,
        createdAt,
        idempotencyKey: idempotencyKey ? `${idempotencyKey}:replacement` : null,
        fiscalTreatment: BAR_CHARGE_REPLACEMENT_FISCAL_TREATMENT,
        sourceCompId: compId,
      };
      compRecord.replacementOrderId = replacementOrderId;
      compRecord.replacementLineId = replacementLineId;
      const routeStations = line.routeStations.length
        ? line.routeStations
        : [currentOrder.station];
      const replacementItems = [];
      for (let index = 0; index < compQuantity; index += 1) {
        replacementItems.push(
          makeIntegrationOrderItemFromProduct({
            id: `oi_${replacementItems.length + 1}`,
            lineId: replacementLineId,
            product,
            productId: product.id,
            productName: product.name,
            quantity: 1,
            unitPrice: 0,
            routeStations,
            replacementMeta: {
              lineType: BAR_CHARGE_REPLACEMENT_LINE_TYPE,
              chargePolicy: "BAR_INTERNAL",
              payable: false,
              customerPrice: 0,
              tableId: currentOrder.tableId,
              tableNumber: tableInfo?.table?.number ?? currentOrder.tableNumber,
              tableLabel,
              roomId,
              orderId: replacementOrderId,
              orderIds: [canonicalOrderId, replacementOrderId],
              originalOrderId: canonicalOrderId,
              originalLineId: replacementRecord.originalLineId,
              replacementLineId,
              reason,
              createdByUserId: user.id,
              createdByUsername: user.username,
              createdByDeviceUuid: session.deviceUuid,
              createdAt,
              idempotencyKey: replacementRecord.idempotencyKey || "",
              fiscalTreatment: BAR_CHARGE_REPLACEMENT_FISCAL_TREATMENT,
            },
          }),
        );
      }
      const station = normalizeIntegrationStationName(
        routeStations[0] ?? currentOrder.station,
      );
      const replacementTicket = sanitizeIntegrationTicketEntry(
        {
          id: `tkt_${replacementOrderId}_${replacementLineId}`,
          orderId: replacementOrderId,
          roomId,
          stationId: station,
          createdAt,
          createdByUserId: user.id,
          createdByUsername: user.username,
          ticketStatus: "SENT",
        },
        `tkt_${replacementOrderId}_${replacementLineId}`,
        replacementOrderId,
        roomId,
      );
      const replacementRoute = sanitizeIntegrationLineRoute(
        {
          id: `route_${replacementOrderId}_${replacementLineId}`,
          orderId: replacementOrderId,
          ticketId: replacementTicket?.id ?? null,
          lineId: replacementLineId,
          stationId: station,
          sentAt: createdAt,
          sentByUserId: user.id,
          sentByUsername: user.username,
        },
        `route_${replacementOrderId}_${replacementLineId}`,
        replacementOrderId,
      );
      replacementOrder = sanitizeIntegrationOrder(
        {
          id: replacementOrderId,
          table: currentOrder.tableNumber,
          waiter: currentOrder.waiter,
          covers: currentOrder.covers,
          apericena: 0,
          note: `Sostituzione #${canonicalOrderId}`,
          communications: reason,
          receivedAtMs: Date.now(),
          completedAtMs: null,
          station,
          ownerStation: null,
          ownerOperator: null,
          ownerRole: null,
          ownerAtMs: null,
          workflowStatus: "waiting",
          items: replacementItems,
          tickets: [replacementTicket].filter(Boolean),
          lineRoutes: [replacementRoute].filter(Boolean),
          parentOrderId: canonicalOrderId,
          isPartial: false,
          source: "mobile-frontend",
          broadcastToAllStations: false,
          roomId,
          tableId: currentOrder.tableId,
          tableNumber: currentOrder.tableNumber,
          tableLabel,
          logicalTableLabel: tableLabel,
          title: `Sostituzione ${line.productName}`,
          total: 0,
          paidAmount: 0,
          dueAmount: 0,
          paymentStatus: "paid",
          nonChargeableReplacement: true,
          replacementSettlement: "non_chargeable_zero",
          payable: false,
          orderNote: `Sostituzione #${canonicalOrderId}`,
          orderComment: reason,
          createdByUserId: user.id,
          createdByUsername: user.username,
          createdAt,
          updatedAt: createdAt,
        },
        replacementOrderId,
      );
      replacementOrder = applyIntegrationAutoAssignment(db, replacementOrder, {
        source: "mobile-frontend",
      }).order;
      db.integration.orders.push(replacementOrder);
      printJob = await appendPrintSpoolJobToDb(db, {
        kind: "bar_replacement",
        orderId: replacementOrderId,
        roomId,
        station,
        userId: user.id,
        deviceUuid: session.deviceUuid,
        clientApp: session.clientApp,
        text: buildReplacementPrintText(replacementRecord, settings),
      });
      replacementRecord.preparationPrintJobId = printJob?.id ?? null;
      replacementOrderPrintJob = await appendReplacementOrderPrintJobToDb(db, {
        replacementRecord,
        order: replacementOrder,
        settings,
        station,
        user,
        session,
        roomId,
      });
      replacementRecord.orderPrintJobId = replacementOrderPrintJob?.id ?? null;
      precontoPrintJob = await appendReplacementPrecontoPrintJobToDb(db, {
        replacementRecord,
        order: replacementOrder,
        settings,
        station,
        user,
        session,
        roomId,
      });
      replacementRecord.precontoPrintJobId = precontoPrintJob?.id ?? null;
      db.integration.barChargeReplacements.push(replacementRecord);
    }
    if (paidCompAmount > 0.009) {
      const stornoQuantity =
        line.unitPrice > 0
          ? Math.max(
              1,
              Math.min(compQuantity, Math.round(paidCompAmount / line.unitPrice)),
            )
          : compQuantity;
      stornoPrintJob = await appendPaymentStornoPrintJobToDb(db, {
        compRecord: {
          ...compRecord,
          amount:
            paymentAdjustment.stornoAmount > 0
              ? paymentAdjustment.stornoAmount
              : paidCompAmount,
          quantity: stornoQuantity,
        },
        order: nextOrder,
        line,
        settings,
        user,
        session,
        roomId,
        paymentReferences,
      });
      compRecord.stornoPrintJobId = stornoPrintJob?.id ?? null;
    }
    for (const rechargePrintPayload of Array.isArray(
      paymentAdjustment.rechargePrintPayloads,
    )
      ? paymentAdjustment.rechargePrintPayloads
      : []) {
      const rechargePrintJob = await appendPrintSpoolJobToDb(
        db,
        rechargePrintPayload,
      );
      if (rechargePrintJob) {
        rechargePrintJobs.push(rechargePrintJob);
        compRecord.rechargePrintJobIds.push(rechargePrintJob.id);
      }
    }
  
    db.integration.orders[orderIndex] = nextOrder;
    db.integration.orderComps.push(compRecord);
    const actor = buildAuditActor(user, { ...payload, roomId });
    appendAuditEvent(db, {
      ...actor,
      action: isZeroCostReplacement
        ? "order.zero_cost_replacement_applied"
        : "order.storno_applied",
      entityType: "integration_order",
      entityId: canonicalOrderId,
      roomId,
      payload: compRecord,
      before: {
        total: currentOrder.total,
        paidAmount: currentOrder.paidAmount,
        dueAmount: currentOrder.dueAmount,
        compedAmount: currentOrder.compedAmount ?? 0,
        revision: currentRevision,
      },
      after: {
        total: nextOrder.total,
        paidAmount: nextOrder.paidAmount,
        dueAmount: nextOrder.dueAmount,
        compedAmount: nextOrder.compedAmount ?? 0,
        revision: nextRevision,
      },
    });
    if (replacementRecord) {
      appendAuditEvent(db, {
        ...actor,
        action: "order.comp_replacement_sent_to_preparation",
        entityType: "print_job",
        entityId: printJob?.id ?? replacementRecord.id,
        roomId,
        payload: {
          ...replacementRecord,
          printJobId: printJob?.id ?? null,
          orderPrintJobId: replacementOrderPrintJob?.id ?? null,
          precontoPrintJobId: precontoPrintJob?.id ?? null,
        },
      });
    }
    if (stornoPrintJob) {
      appendAuditEvent(db, {
        ...actor,
        action: "payment.storno_printed_for_paid_comp",
        entityType: "print_job",
        entityId: stornoPrintJob.id,
        roomId,
        payload: {
          compId,
          orderId: canonicalOrderId,
          printJobId: stornoPrintJob.id,
          refundPlan,
          amount: compAmount,
        },
      });
    }
  
    db.integration.lastWriteAt = nowIso();
    db.meta.lastWriteAt = nowIso();
    const relationalCompResult = await syncRelationalOrderPrimary({ enabled: orderCompWritePrimary, order: nextOrder, previousRevision: requestedOrderCompRevision > 0 ? requestedOrderCompRevision : currentRevision, relationalRuntime });
    if (orderCompWritePrimary && !relationalCompResult) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision: nextRevision } });
    const orderCompFinancialTargetTableIds = nextOrder.tableId ? [nextOrder.tableId] : [];
    const orderCompFinancialSyncSnapshot = await listRelationalOrderWorkflowSnapshot({ enabled: orderCompWritePrimary, logger: console, metricLabel: `${orderCompMetricPrefix}.relationalFinancialSnapshotRead`, relationalRuntime, runtimeMetrics, tableIds: resolveOrderFinancialSnapshotTableIds(db, orderCompFinancialTargetTableIds) }), orderCompFinancialSyncSource = buildOrderFinancialSyncState({ baseState: db, orderSnapshot: orderCompFinancialSyncSnapshot });
    const orderCompFinancialTableGuard = await captureRelationalOrderFinancialTableGuard({ enabled: orderCompWritePrimary, tableIds: orderCompFinancialTargetTableIds });
    const financialSync = syncPosTableFinancialsFromIntegrationOrders(orderCompFinancialSyncSource.state, orderCompFinancialTargetTableIds.length ? orderCompFinancialTargetTableIds : null);
    if (financialSync.changed === true && orderCompFinancialTableGuard?.tokens?.length > 0) { const tableRevisionPlan = applyOrderFinancialTableRevisionTokens({ settings: financialSync.settings, tableIds: financialSync.tableIds ?? (nextOrder.tableId ? [nextOrder.tableId] : []), tokens: orderCompFinancialTableGuard.tokens }); if (tableRevisionPlan.changed === true) { financialSync.settings = tableRevisionPlan.settings; db.posSettings = financialSync.settings; } }
    if (orderCompFinancialSyncSource.state !== db && financialSync.changed === true) db.posSettings = financialSync.settings;
    await persistRelationalOrderFinancialTables({ appState: db, enabled: orderCompWritePrimary && financialSync.changed === true, tableIds: financialSync.tableIds ?? (financialSync.changed ? [nextOrder.tableId] : []) });
    const orderStornoFiscalPaymentIntentNeeded = explicitStornoRequest && !isZeroCostReplacement && (paidCompAmount > 0.009 || paymentAdjustment.voidAmount > 0 || paymentAdjustment.rechargeAmount > 0 || Boolean(stornoPrintJob) || rechargePrintJobs.length > 0);
    if (orderStornoFiscalPaymentIntentNeeded) await writeOrderStornoFiscalPaymentIntentDb(db, { metricLabel: "orders.storno.fiscalPaymentIntentWrite" });
    await writeIntegrationOrderSyncDb(db, { orderIds: normalizeIntegrationOrderWriteIds(nextOrder.id, replacementOrder?.id), syncPosSettings: financialSync.changed === true, syncSequence: Boolean(replacementOrder), posSettingsTableIds: financialSync.tableIds ?? (financialSync.changed ? [nextOrder.tableId] : []), auditEventIds: collectAuditEventIdsSince(db, auditStartIndex), integrationObjectFields: ["orderComps", replacementRecord ? "barChargeReplacements" : ""], metricLabel: `${orderCompMetricPrefix}.appStateWrite`, defer: ORDERS_COMP_ASYNC_ACK });
    if (
      printJob ||
      replacementOrderPrintJob ||
      precontoPrintJob ||
      stornoPrintJob ||
      rechargePrintJobs.length > 0
    ) {
      queuePrintSpoolWorker();
    }
  
    sendJson(res, 200, {
      ok: true,
      comp: compRecord,
      replacement: replacementRecord,
      replacementOrder,
      order: nextOrder,
      printJob: printJob
        ? { id: printJob.id, printerName: printJob.printerName }
        : null,
      orderPrintJob: replacementOrderPrintJob
        ? {
            id: replacementOrderPrintJob.id,
            printerName: replacementOrderPrintJob.printerName,
          }
        : null,
      precontoPrintJob: precontoPrintJob
        ? { id: precontoPrintJob.id, printerName: precontoPrintJob.printerName }
        : null,
      stornoPrintJob: stornoPrintJob
        ? { id: stornoPrintJob.id, printerName: stornoPrintJob.printerName }
        : null,
    });
  }
  

  return {
    handleIntegrationOrderComp,
  };
}
