/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createIntegrationOrderCorrectionHandlers({
  ORDERS_CANCEL_ASYNC_ACK,
  ORDERS_CANCEL_FINANCIAL_DELTA_BEFORE_SNAPSHOT,
  RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY,
  ORDERS_CORRECT_ASYNC_ACK,
  RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY,
  HttpError,
  ORDER_CORRECTION_ALLOWED_WORKFLOWS,
  PRIMARY_INTEGRATION_STATION,
  REALTIME_BACKBONE_CONFIG,
  appendAuditEvent,
  appendPrintSpoolJobToDb,
  applyOrderCorrectionToDb,
  applyOrderFinancialTableRevisionTokens,
  areIntegrationTablesLinkedByGroup,
  assertActiveTableWorkLock,
  assertOrderCorrectableOrThrow,
  assertUserCanOperateInTableRoom,
  buildAuditActor,
  buildCancellationOrderPrintText,
  buildOrderCancelFinancialDeltaBeforeSnapshotFastPath,
  buildOrderFinancialSyncState,
  captureRelationalOrderFinancialTableGuard,
  clampInt,
  clearEmbeddedTableWorkLock,
  collectAuditEventIdsSince,
  createDefaultIntegrationState,
  createOrderCorrectionApprovalRequest,
  findExistingIntegrationIdempotencyRecord,
  findIntegrationOrderIndexByLookup,
  findPosTableWithLayout,
  findRelationalOrderById,
  isTableWorkLockFastPathEnabled,
  listRelationalOrderWorkflowSnapshot,
  normalizeCorrectionReason,
  normalizeIdempotencyKey,
  normalizeIntegrationStationName,
  nowIso,
  orderCorrectionRequiresCashApproval,
  persistRelationalOrderFinancialTables,
  pruneIntegrationState,
  publishIntegrationNotificationStreamRefresh,
  queueIntegrationNotification,
  queuePrintSpoolWorker,
  readDb,
  readJsonBody,
  relationalRuntime,
  resolveOrderFinancialSnapshotTableIds,
  runtimeMetrics,
  sanitizeIntegrationOrder,
  sanitizePosSettings,
  sendJson,
  syncPosTableFinancialsFromIntegrationOrders,
  syncRelationalOrderPrimary,
  validateSessionContext,
  withOrderPrintOperationalRoutingPayload,
  writeIntegrationOrderDb,
  writeIntegrationOrderSyncDb,
}) {
  async function handleIntegrationOrderCorrection(req, res) {
    const payload = await readJsonBody(req);
    const orderId = String(payload.orderId ?? "").trim();
    const tableId = String(payload.tableId ?? "").trim();
    const expectedRevision = clampInt(payload.expectedRevision, 1, 1_000_000, 0);
    if (!orderId || !tableId || expectedRevision <= 0) {
      throw new HttpError(
        400,
        "orderId, tableId ed expectedRevision sono obbligatori.",
      );
    }
  
    const db = await readDb({
      refreshExternalizedSessions: true,
      refreshExternalizedTableLocks: true,
    });
    const authContext =
      req.__authContext && typeof req.__authContext === "object"
        ? req.__authContext
        : validateSessionContext(db, payload);
    const { user, session } = authContext;
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    if (!Array.isArray(db.integration.orderCorrections)) {
      db.integration.orderCorrections = [];
    }
    if (!Array.isArray(db.integration.orderCorrectionRequests)) {
      db.integration.orderCorrectionRequests = [];
    }
    if (!Array.isArray(db.integration.orders)) {
      db.integration.orders = [];
    }
    let orderIndex = findIntegrationOrderIndexByLookup(
      db.integration.orders,
      orderId,
    );
    let currentOrder =
      orderIndex >= 0
        ? sanitizeIntegrationOrder(
            db.integration.orders[orderIndex],
            String(db.integration.orders[orderIndex]?.id ?? orderId).trim() ||
              orderId,
          )
        : null;
    const correctionMirrorOrderIndex = orderIndex;
    const correctionMirrorOrder = currentOrder;
    const relationalCorrectionCurrentOrder = await findRelationalOrderById({
      enabled: RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY,
      orderId: currentOrder?.id ?? orderId,
      relationalRuntime,
      runtimeMetrics,
    });
    if (relationalCorrectionCurrentOrder) {
      currentOrder = sanitizeIntegrationOrder(
        relationalCorrectionCurrentOrder,
        String(relationalCorrectionCurrentOrder.id ?? orderId).trim() || orderId,
      );
      if (orderIndex < 0) {
        db.integration.orders.push(currentOrder);
        orderIndex = db.integration.orders.length - 1;
      } else {
        db.integration.orders[orderIndex] = currentOrder;
      }
    }
    const auditStartIndex = Array.isArray(db.auditEvents) ? db.auditEvents.length : 0;
    const idempotencyKey = normalizeIdempotencyKey(payload);
    const existing = findExistingIntegrationIdempotencyRecord(
      db.integration.orderCorrections,
      idempotencyKey,
      user,
      session.deviceUuid,
    );
    if (existing) {
      sendJson(res, 200, {
        ok: true,
        idempotent: true,
        correction: existing,
        order: currentOrder,
      });
      return;
    }
    const existingRequest = findExistingIntegrationIdempotencyRecord(
      db.integration.orderCorrectionRequests,
      idempotencyKey,
      user,
      session.deviceUuid,
    );
    if (existingRequest) {
      throw new HttpError(
        409,
        "La richiesta modifica alla cassa non e piu attiva. Riapri la modifica e inviala di nuovo.",
        {
          code: "ORDER_CORRECTION_APPROVAL_DISABLED",
        },
      );
    }
  
    if (!currentOrder || orderIndex < 0) {
      throw new HttpError(404, "Comanda non trovata.");
    }
    if (
      currentOrder.tableId !== tableId &&
      !areIntegrationTablesLinkedByGroup(
        db.integration,
        currentOrder.tableId,
        tableId,
      )
    ) {
      throw new HttpError(400, "La comanda non appartiene al tavolo indicato.");
    }
  
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const tableInfo = findPosTableWithLayout(settings, tableId);
    if (!tableInfo) {
      throw new HttpError(404, "Tavolo non trovato.");
    }
    const roomId = String(
      payload.roomId ?? currentOrder.roomId ?? tableInfo.roomId ?? "",
    ).trim();
    const actor = buildAuditActor(user, { ...payload, roomId });
    assertUserCanOperateInTableRoom(user, settings, { ...tableInfo, roomId });
    assertActiveTableWorkLock(db, tableId, {
      user,
      session,
      payload: { ...payload, roomId },
      purpose: "order.correction",
    });
    try {
      assertOrderCorrectableOrThrow(db, currentOrder, actor);
    } catch (error) {
      await writeIntegrationOrderDb(db, { metricLabel: "orders.correct.rejected.appStateWrite" });
      throw error;
    }
  
    const currentRevision = clampInt(
      currentOrder.revision ?? currentOrder.currentRevision,
      1,
      1_000_000,
      1,
    );
    if (currentRevision !== expectedRevision) {
      appendAuditEvent(db, {
        ...actor,
        action: "order.correction_rejected_revision_conflict",
        entityType: "integration_order",
        entityId: orderId,
        roomId,
        payload: {
          orderId,
          expectedRevision,
          currentRevision,
        },
      });
      db.meta.lastWriteAt = nowIso();
      if (correctionMirrorOrderIndex >= 0) {
        db.integration.orders[correctionMirrorOrderIndex] = correctionMirrorOrder;
      } else if (orderIndex >= 0) {
        db.integration.orders.splice(orderIndex, 1);
      }
      await writeIntegrationOrderDb(db, { metricLabel: "orders.correct.revisionConflict.appStateWrite" });
      throw new HttpError(
        409,
        "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.",
        {
          code: "REVISION_CONFLICT",
          details: { currentRevision },
        },
      );
    }
  
    if (orderCorrectionRequiresCashApproval(currentOrder, payload)) {
      const requestRecord = createOrderCorrectionApprovalRequest(db, {
        payload: {
          ...payload,
          tableId,
          roomId,
          expectedRevision,
        },
        user,
        session,
        currentOrder,
        settings,
        tableInfo,
        roomId,
        actor,
        idempotencyKey,
      });
      await writeIntegrationOrderDb(db, { metricLabel: "orders.correct.approvalRequest.appStateWrite" });
      publishIntegrationNotificationStreamRefresh(
        "order_correction_approval_request",
        {
          requestId: requestRecord.requestId,
          orderId,
          tableId,
          roomId,
        },
      );
      sendJson(res, 202, {
        ok: true,
        status: "pending_cash_approval",
        code: "ORDER_CORRECTION_REQUIRES_CASH_APPROVAL",
        requestId: requestRecord.requestId,
        request: requestRecord,
        order: currentOrder,
      });
      return;
    }
  
    const appliedCorrection = await applyOrderCorrectionToDb(db, {
      payload: {
        ...payload,
        tableId,
        roomId,
        expectedRevision,
      },
      user,
      session,
      currentOrder,
      orderIndex,
      settings,
      tableInfo,
      roomId, actor, idempotencyKey, skipFinancialSync: RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY,
    });
    const relationalCorrectionResult = await syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY, order: appliedCorrection.nextOrder, previousRevision: appliedCorrection.correctionRecord?.previousRevision ?? expectedRevision, relationalRuntime });
    if (RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY && !relationalCorrectionResult) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision: appliedCorrection.correctionRecord?.nextRevision ?? expectedRevision + 1 } });
    let correctionFinancialSync = appliedCorrection.financialSync;
    if (RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY) { const orderCorrectFinancialTargetTableIds = [tableId]; const orderCorrectFinancialSyncSnapshot = await listRelationalOrderWorkflowSnapshot({ enabled: RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY, logger: console, metricLabel: "orders.correct.relationalFinancialSnapshotRead", relationalRuntime, runtimeMetrics, tableIds: resolveOrderFinancialSnapshotTableIds(db, orderCorrectFinancialTargetTableIds) }); const orderCorrectFinancialSyncSource = buildOrderFinancialSyncState({ baseState: db, orderSnapshot: orderCorrectFinancialSyncSnapshot }); const orderCorrectFinancialTableGuard = await captureRelationalOrderFinancialTableGuard({ enabled: RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY, tableIds: orderCorrectFinancialTargetTableIds }); correctionFinancialSync = syncPosTableFinancialsFromIntegrationOrders(orderCorrectFinancialSyncSource.state, orderCorrectFinancialTargetTableIds); if (correctionFinancialSync.changed === true && orderCorrectFinancialTableGuard?.tokens?.length > 0) { const tableRevisionPlan = applyOrderFinancialTableRevisionTokens({ settings: correctionFinancialSync.settings, tableIds: correctionFinancialSync.tableIds ?? orderCorrectFinancialTargetTableIds, tokens: orderCorrectFinancialTableGuard.tokens }); if (tableRevisionPlan.changed === true) { correctionFinancialSync.settings = tableRevisionPlan.settings; db.posSettings = correctionFinancialSync.settings; } } if (orderCorrectFinancialSyncSource.state !== db && correctionFinancialSync.changed === true) db.posSettings = correctionFinancialSync.settings; await persistRelationalOrderFinancialTables({ appState: db, enabled: correctionFinancialSync.changed === true, tableIds: correctionFinancialSync.tableIds ?? (correctionFinancialSync.changed ? orderCorrectFinancialTargetTableIds : []) }); }
    await writeIntegrationOrderSyncDb(db, { orderIds: [appliedCorrection.nextOrder?.id ?? orderId], syncPosSettings: correctionFinancialSync?.changed === true, posSettingsTableIds: correctionFinancialSync?.tableIds ?? (correctionFinancialSync?.changed ? [tableId] : []), auditEventIds: collectAuditEventIdsSince(db, auditStartIndex), integrationObjectFields: ["orderCorrections"], metricLabel: "orders.correct.appStateWrite", defer: ORDERS_CORRECT_ASYNC_ACK });
    publishIntegrationNotificationStreamRefresh("order_correction_applied", {
      orderId: appliedCorrection.nextOrder?.id ?? orderId,
      tableId,
      roomId,
      correctionId: appliedCorrection.correctionRecord?.correctionId ?? null,
      revision:
        appliedCorrection.nextOrder?.revision ??
        appliedCorrection.nextOrder?.currentRevision ??
        null,
    }, { requireOutbox: RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY && REALTIME_BACKBONE_CONFIG.eventOutboxEnabled });
    queuePrintSpoolWorker();
    sendJson(res, 200, {
      ok: true,
      correction: appliedCorrection.correctionRecord,
      order: appliedCorrection.nextOrder,
      printJob: appliedCorrection.printJob
        ? {
            id: appliedCorrection.printJob.id,
            printerName: appliedCorrection.printJob.printerName,
          }
        : null,
      precontoPrintJob: appliedCorrection.precontoPrintJob
        ? {
            id: appliedCorrection.precontoPrintJob.id,
            printerName: appliedCorrection.precontoPrintJob.printerName,
          }
        : null,
    });
  }
  
  async function handleIntegrationOrderCancel(req, res) {
    let orderCancelStageAt = Date.now(); const recordOrderCancelStage = (label) => { const now = Date.now(); runtimeMetrics.recordOperation("orderCancelInternal", label, now - orderCancelStageAt); orderCancelStageAt = now; };
    const payload = await readJsonBody(req); recordOrderCancelStage("readBody");
    const orderId = String(payload.orderId ?? "").trim();
    const tableId = String(payload.tableId ?? "").trim();
    const expectedRevision = clampInt(payload.expectedRevision, 1, 1_000_000, 0);
    const reasonRaw = String(payload.reason ?? "").trim();
    const reason = reasonRaw ? reasonRaw.slice(0, 300) : "Annullata da operatore mobile";
    if (!orderId || !tableId) throw new HttpError(400, "orderId e tableId sono obbligatori.");
    if (reasonRaw.length > 300) {
      throw new HttpError(400, "Il motivo dell'annullamento e troppo lungo.", {
        code: "ORDER_CANCEL_REASON_TOO_LONG",
      });
    }
  
    const db = await readDb({ refreshExternalizedSessions: true, refreshExternalizedTableLocks: true }); recordOrderCancelStage("readDb");
    const authContext = req.__authContext && typeof req.__authContext === "object" ? req.__authContext : validateSessionContext(db, payload);
    const { user, session } = authContext;
    if (!db.integration || typeof db.integration !== "object") db.integration = createDefaultIntegrationState();
    const auditStartIndex = Array.isArray(db.auditEvents) ? db.auditEvents.length : 0;
  
    db.integration.orders = Array.isArray(db.integration.orders) ? db.integration.orders : [];
    let orderIndex = findIntegrationOrderIndexByLookup(db.integration.orders, orderId);
    let currentOrder = orderIndex >= 0 ? sanitizeIntegrationOrder(db.integration.orders[orderIndex], String(db.integration.orders[orderIndex]?.id ?? orderId).trim() || orderId) : null;
    const relationalCancelCurrentOrder = await findRelationalOrderById({ enabled: RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY, orderId: currentOrder?.id ?? orderId, relationalRuntime, runtimeMetrics });
    recordOrderCancelStage("relationalCurrentOrderRead");
    let appliedRelationalCancelCurrentOrder = false;
    if (relationalCancelCurrentOrder && (!currentOrder || clampInt(relationalCancelCurrentOrder.revision ?? relationalCancelCurrentOrder.currentRevision, 1, 1_000_000, 1) > clampInt(currentOrder.revision ?? currentOrder.currentRevision, 1, 1_000_000, 1))) { currentOrder = sanitizeIntegrationOrder(relationalCancelCurrentOrder, String(relationalCancelCurrentOrder.id ?? orderId).trim() || orderId); if (orderIndex < 0) { db.integration.orders.push(currentOrder); orderIndex = db.integration.orders.length - 1; } else db.integration.orders[orderIndex] = currentOrder; appliedRelationalCancelCurrentOrder = true; }
    if (!currentOrder || orderIndex < 0) throw new HttpError(404, "Comanda non trovata.");
    if (
      currentOrder.tableId !== tableId &&
      !areIntegrationTablesLinkedByGroup(
        db.integration,
        currentOrder.tableId,
        tableId,
      )
    ) {
      throw new HttpError(400, "La comanda non appartiene al tavolo indicato.");
    }
  
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const tableInfo = findPosTableWithLayout(settings, tableId);
    if (!tableInfo) {
      throw new HttpError(404, "Tavolo non trovato.");
    }
    const roomId = String(
      payload.roomId ?? currentOrder.roomId ?? tableInfo.roomId ?? "",
    ).trim();
    const actor = buildAuditActor(user, { ...payload, roomId });
    assertUserCanOperateInTableRoom(user, settings, { ...tableInfo, roomId });
    assertActiveTableWorkLock(db, tableId, {
      user,
      session,
      payload: { ...payload, roomId },
      purpose: "order.cancel",
    });
    if (isTableWorkLockFastPathEnabled()) {
      clearEmbeddedTableWorkLock(db, tableId);
    }
    recordOrderCancelStage("authAndLock");
  
    const workflow = String(currentOrder.workflowStatus ?? "")
      .trim()
      .toLowerCase();
    const alreadyCancelled = ["cancelled", "annullata", "voided"].includes(
      workflow,
    );
    if (alreadyCancelled) {
      if (appliedRelationalCancelCurrentOrder) { db.integration.lastWriteAt = nowIso(); if (!db.meta || typeof db.meta !== "object") db.meta = {}; db.meta.lastWriteAt = nowIso(); await writeIntegrationOrderSyncDb(db, { orderIds: [currentOrder.id], metricLabel: "orders.cancel.idempotentMirror.appStateWrite" }); }
      sendJson(res, 200, { ok: true, idempotent: true, order: currentOrder });
      return;
    }
    if (currentOrder.paymentStatus === "paid") {
      throw new HttpError(
        409,
        "La comanda e gia pagata e non puo essere annullata.",
        {
          code: "ORDER_ALREADY_PAID",
        },
      );
    }
    if (!ORDER_CORRECTION_ALLOWED_WORKFLOWS.has(workflow)) {
      throw new HttpError(
        409,
        "La comanda non e annullabile nello stato corrente.",
        {
          code: "ORDER_CANCEL_NOT_ALLOWED",
        },
      );
    }
  
    const currentRevision = clampInt(
      currentOrder.revision ?? currentOrder.currentRevision,
      1,
      1_000_000,
      1,
    );
    if (expectedRevision > 0 && currentRevision !== expectedRevision) {
      appendAuditEvent(db, {
        ...actor,
        action: "order.cancel_rejected_revision_conflict",
        entityType: "integration_order",
        entityId: orderId,
        roomId,
        payload: {
          orderId,
          expectedRevision,
          currentRevision,
        },
      });
      db.meta.lastWriteAt = nowIso();
      await writeIntegrationOrderDb(db, { metricLabel: "orders.cancel.revisionConflict.appStateWrite" });
      throw new HttpError(
        409,
        "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.",
        {
          code: "REVISION_CONFLICT",
          details: { currentRevision },
        },
      );
    }
  
    const cancelledAt = nowIso();
    const voidedBy =
      String(user.username ?? user.fullName ?? user.id ?? "").trim() ||
      "operatore";
    const nextRevision = currentRevision + 1;
    const nextOrder = sanitizeIntegrationOrder(
      {
        ...currentOrder,
        workflowStatus: "cancelled",
        completedAtMs: Date.parse(cancelledAt),
        total: 0,
        paidAmount: 0,
        dueAmount: 0,
        paymentStatus: "paid",
        items: currentOrder.items.map((item) => ({
          ...item,
          voidedAt: item.voidedAt || cancelledAt,
          voidedBy,
        })),
        lockedByStationId: null,
        lockedByUserId: null,
        lockedAt: null,
        lockStatus: "unlocked",
        ownerStation: null,
        ownerOperator: null,
        ownerRole: null,
        ownerAtMs: null,
        assignmentStatus: "cancelled",
        communications: currentOrder.communications
          ? `${currentOrder.communications}\nAnnullata: ${reason}`.slice(0, 240)
          : `Annullata: ${reason}`.slice(0, 240),
        orderComment: currentOrder.orderComment
          ? `${currentOrder.orderComment}\nAnnullata: ${reason}`.slice(0, 240)
          : `Annullata: ${reason}`.slice(0, 240),
        revision: nextRevision,
        currentRevision: nextRevision,
        updatedAt: cancelledAt,
      },
      currentOrder.id,
    );
    recordOrderCancelStage("buildCancelledOrder");
    const cancelPrintJob = await appendPrintSpoolJobToDb(
      db,
      withOrderPrintOperationalRoutingPayload(settings, currentOrder, {
        kind: "order_cancellation",
        orderId,
        roomId,
        station: normalizeIntegrationStationName(currentOrder.station),
        fallbackStation: PRIMARY_INTEGRATION_STATION,
        userId: user.id,
        deviceUuid: session.deviceUuid,
        clientApp: session.clientApp,
        text: buildCancellationOrderPrintText(currentOrder, reason, settings),
        printPreferences: settings.printPreferences,
      }),
    );
    recordOrderCancelStage("printSpool");
  
    db.integration.orders[orderIndex] = nextOrder;
    appendAuditEvent(db, {
      ...actor,
      action: "order.cancelled",
      entityType: "integration_order",
      entityId: orderId,
      roomId,
      payload: {
        orderId,
        tableId,
        reason,
        previousRevision: currentRevision,
        nextRevision,
        printJobId: cancelPrintJob?.id ?? null,
      },
      before: {
        workflowStatus: currentOrder.workflowStatus,
        paymentStatus: currentOrder.paymentStatus,
        dueAmount: currentOrder.dueAmount,
      },
      after: {
        workflowStatus: nextOrder.workflowStatus,
        paymentStatus: nextOrder.paymentStatus,
        dueAmount: nextOrder.dueAmount,
      },
    });
    const relationalCancelResult = await syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY, metricScope: "cancel", order: nextOrder, previousRevision: currentRevision, relationalRuntime, runtimeMetrics });
    recordOrderCancelStage("relationalPrimary");
    if (RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY && !relationalCancelResult) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision: currentRevision + 1 } });
    const orderCancelFinancialTargetTableIds = [tableId], orderCancelFinancialSnapshotTableIds = resolveOrderFinancialSnapshotTableIds(db, orderCancelFinancialTargetTableIds);
    const orderCancelFinancialTableGuard = await captureRelationalOrderFinancialTableGuard({ enabled: RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY, metricLabel: "orders.cancel.relationalFinancialTableGuardRead", tableIds: orderCancelFinancialTargetTableIds });
    recordOrderCancelStage("financialGuardRead");
    let orderCancelFinancialSyncSource = buildOrderFinancialSyncState({ baseState: db, orderSnapshot: null });
    const orderCancelFinancialDeltaFastPath = buildOrderCancelFinancialDeltaBeforeSnapshotFastPath({ appState: db, currentOrder, enabled: RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY && ORDERS_CANCEL_FINANCIAL_DELTA_BEFORE_SNAPSHOT, guardTokens: orderCancelFinancialTableGuard?.tokens ?? [], linkedTableIds: orderCancelFinancialSnapshotTableIds, nextOrder, targetTableIds: orderCancelFinancialTargetTableIds });
    runtimeMetrics.recordOperation("orderWorkflow", `orders.cancel.financialDeltaBeforeSnapshot.${orderCancelFinancialDeltaFastPath.reason}`, 0);
    if (orderCancelFinancialDeltaFastPath.applied) runtimeMetrics.incrementCounter("orderCancelFinancialDeltaBeforeSnapshotHits");
    else runtimeMetrics.incrementCounter("orderCancelFinancialDeltaBeforeSnapshotFallbacks");
    let financialSync = orderCancelFinancialDeltaFastPath.financialSync;
    if (!orderCancelFinancialDeltaFastPath.applied) {
      const orderCancelFinancialSyncSnapshot = await listRelationalOrderWorkflowSnapshot({ enabled: RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY, logger: console, metricLabel: "orders.cancel.relationalFinancialSnapshotRead", relationalRuntime, runtimeMetrics, tableIds: orderCancelFinancialSnapshotTableIds });
      orderCancelFinancialSyncSource = buildOrderFinancialSyncState({ baseState: db, orderSnapshot: orderCancelFinancialSyncSnapshot });
      financialSync = syncPosTableFinancialsFromIntegrationOrders(orderCancelFinancialSyncSource.state, tableId);
    }
    recordOrderCancelStage("financialSnapshotRead"); recordOrderCancelStage("financialSync");
    if (financialSync.changed === true && orderCancelFinancialTableGuard?.tokens?.length > 0) { const tableRevisionPlan = applyOrderFinancialTableRevisionTokens({ settings: financialSync.settings, tableIds: financialSync.tableIds ?? orderCancelFinancialTargetTableIds, tokens: orderCancelFinancialTableGuard.tokens }); if (tableRevisionPlan.changed === true) { financialSync.settings = tableRevisionPlan.settings; db.posSettings = financialSync.settings; } }
    if (orderCancelFinancialSyncSource.state !== db && financialSync.changed === true) db.posSettings = financialSync.settings;
    await persistRelationalOrderFinancialTables({ appState: db, enabled: RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY && financialSync.changed === true, metricLabel: "orders.cancel.relationalFinancialTableWrite", tableIds: financialSync.tableIds ?? (financialSync.changed ? [tableId] : []) });
    recordOrderCancelStage("financialTableWrite");
    db.integration.lastWriteAt = nowIso();
    db.meta.lastWriteAt = nowIso();
    await writeIntegrationOrderSyncDb(db, { orderIds: [nextOrder.id], syncPosSettings: financialSync.changed === true, posSettingsTableIds: financialSync.tableIds ?? (financialSync.changed ? [tableId] : []), auditEventIds: collectAuditEventIdsSince(db, auditStartIndex), metricLabel: "orders.cancel.appStateWrite", defer: ORDERS_CANCEL_ASYNC_ACK });
    recordOrderCancelStage("appStateWrite");
    queuePrintSpoolWorker();
    publishIntegrationNotificationStreamRefresh("order_cancelled", { orderId, tableId, roomId }, { requireOutbox: RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY && REALTIME_BACKBONE_CONFIG.eventOutboxEnabled });
    recordOrderCancelStage("realtimePublish");
    sendJson(res, 200, { ok: true, order: nextOrder, printJob: cancelPrintJob ? { id: cancelPrintJob.id, printerName: cancelPrintJob.printerName } : null });
  }
  
  async function handleIntegrationOrderCorrectionPending(req, res) {
    sendJson(res, 200, {
      ok: true,
      disabled: true,
      requests: [],
    });
  }
  
  async function handleIntegrationOrderCorrectionResolve(req, res) {
    throw new HttpError(
      410,
      "La richiesta modifica alla cassa non e piu attiva.",
      {
        code: "ORDER_CORRECTION_APPROVAL_DISABLED",
      },
    );
    const payload = await readJsonBody(req);
    const requestId = String(payload.requestId ?? "").trim();
    const decision = String(payload.decision ?? payload.action ?? "")
      .trim()
      .toLowerCase();
    if (
      !requestId ||
      !["approve", "approved", "reject", "rejected"].includes(decision)
    ) {
      throw new HttpError(400, "Richiesta o decisione non valida.");
    }
    const approve = decision === "approve" || decision === "approved";
    const db = await readDb();
    const { user, session } = validateSessionContext(db, payload);
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    if (!Array.isArray(db.integration.orderCorrectionRequests)) {
      db.integration.orderCorrectionRequests = [];
    }
    if (!Array.isArray(db.integration.orderCorrections)) {
      db.integration.orderCorrections = [];
    }
    const requestIndex = db.integration.orderCorrectionRequests.findIndex(
      (entry) => String(entry?.requestId ?? "").trim() === requestId,
    );
    if (requestIndex < 0) {
      throw new HttpError(404, "Richiesta modifica non trovata.");
    }
    const requestRecord = db.integration.orderCorrectionRequests[requestIndex];
    if (requestRecord.status !== "pending") {
      sendJson(res, 200, { ok: true, idempotent: true, request: requestRecord });
      return;
    }
    const orderId = String(requestRecord.orderId ?? "").trim();
    const orderIndex = findIntegrationOrderIndexByLookup(
      db.integration.orders,
      orderId,
    );
    if (orderIndex < 0) {
      throw new HttpError(404, "Comanda non trovata.");
    }
    const currentOrder = sanitizeIntegrationOrder(
      db.integration.orders[orderIndex],
      String(db.integration.orders[orderIndex]?.id ?? orderId).trim() || orderId,
    );
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const tableInfo = findPosTableWithLayout(settings, currentOrder.tableId);
    if (!tableInfo) {
      throw new HttpError(404, "Tavolo non trovato.");
    }
    const roomId = String(
      requestRecord.roomId ?? currentOrder.roomId ?? tableInfo.roomId ?? "",
    ).trim();
    const actor = buildAuditActor(user, { ...payload, roomId });
    const resolvedAt = nowIso();
  
    if (!approve) {
      const nextRequest = {
        ...requestRecord,
        status: "rejected",
        resolvedAt,
        resolvedByUserId: user.id,
        resolvedByUsername: user.username,
        resolutionReason: normalizeCorrectionReason(payload.reason),
      };
      db.integration.orderCorrectionRequests[requestIndex] = nextRequest;
      queueIntegrationNotification(db, {
        type: "general",
        title: "Modifica comanda rifiutata",
        description: `La cassa ha rifiutato la modifica della comanda ${orderId}.`,
        meta: {
          eventType: "order_correction_rejected",
          requestId,
          orderId,
          targetClientApp: "mobile-frontend",
          targetUserId: String(requestRecord.createdByUserId ?? "").trim(),
          targetDeviceUuid: String(
            requestRecord.createdByDeviceUuid ?? "",
          ).trim(),
        },
      });
      appendAuditEvent(db, {
        ...actor,
        action: "order.correction_approval_rejected",
        entityType: "integration_order",
        entityId: orderId,
        roomId,
        payload: nextRequest,
      });
      db.integration.lastWriteAt = nowIso();
      db.meta.lastWriteAt = nowIso();
      pruneIntegrationState(db.integration);
      await writeIntegrationOrderDb(db, { metricLabel: "orders.correct.approvalRejected.appStateWrite" });
      publishIntegrationNotificationStreamRefresh("order_correction_rejected", {
        requestId,
        orderId,
      });
      sendJson(res, 200, { ok: true, request: nextRequest });
      return;
    }
  
    const correctionPayload = {
      ...(requestRecord.requestedPayload &&
      typeof requestRecord.requestedPayload === "object"
        ? requestRecord.requestedPayload
        : {}),
      orderId,
      tableId: currentOrder.tableId,
      roomId,
      expectedRevision: clampInt(requestRecord.expectedRevision, 1, 1_000_000, 0),
      reason:
        normalizeCorrectionReason(payload.reason) ||
        normalizeCorrectionReason(requestRecord.requestedPayload?.reason),
    };
    const { correctionRecord, nextOrder, printJob, precontoPrintJob } =
      await applyOrderCorrectionToDb(db, {
        payload: correctionPayload,
        user,
        session,
        currentOrder,
        orderIndex,
        settings,
        tableInfo,
        roomId,
        actor,
        idempotencyKey: String(requestRecord.idempotencyKey ?? "").trim(),
        approvalRequestId: requestId,
      });
    const nextRequest = {
      ...requestRecord,
      status: "approved",
      resolvedAt,
      resolvedByUserId: user.id,
      resolvedByUsername: user.username,
      correctionId: correctionRecord.correctionId,
    };
    db.integration.orderCorrectionRequests[requestIndex] = nextRequest;
    queueIntegrationNotification(db, {
      type: "general",
      title: "Modifica comanda approvata",
      description: `La cassa ha approvato la modifica della comanda ${orderId}.`,
      meta: {
        eventType: "order_correction_approved",
        requestId,
        orderId,
        targetClientApp: "mobile-frontend",
        targetUserId: String(requestRecord.createdByUserId ?? "").trim(),
        targetDeviceUuid: String(requestRecord.createdByDeviceUuid ?? "").trim(),
      },
    });
    pruneIntegrationState(db.integration);
    await writeIntegrationOrderDb(db, { metricLabel: "orders.correct.approvalResolved.appStateWrite" });
    queuePrintSpoolWorker();
    publishIntegrationNotificationStreamRefresh("order_correction_approved", {
      requestId,
      orderId,
    });
    sendJson(res, 200, {
      ok: true,
      request: nextRequest,
      correction: correctionRecord,
      order: nextOrder,
      printJob: printJob
        ? { id: printJob.id, printerName: printJob.printerName }
        : null,
      precontoPrintJob: precontoPrintJob
        ? { id: precontoPrintJob.id, printerName: precontoPrintJob.printerName }
        : null,
    });
  }
  

  return {
    handleIntegrationOrderCorrection,
    handleIntegrationOrderCancel,
    handleIntegrationOrderCorrectionPending,
    handleIntegrationOrderCorrectionResolve,
  };
}
