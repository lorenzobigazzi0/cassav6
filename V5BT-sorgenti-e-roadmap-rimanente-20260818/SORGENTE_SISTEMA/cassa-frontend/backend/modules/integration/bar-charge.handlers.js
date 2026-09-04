/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createBarChargeHandlers({
  BAR_CHARGE_REPLACEMENT_FISCAL_TREATMENT,
  BAR_CHARGE_REPLACEMENT_LINE_TYPE,
  HttpError,
  appendAuditEvent,
  appendPrintSpoolJobToDb,
  appendReplacementOrderPrintJobToDb,
  appendReplacementPrecontoPrintJobToDb,
  applyOrderFinancialTableRevisionTokens,
  areIntegrationTablesLinkedByGroup,
  assertActiveTableWorkLock,
  assertUserCanOperateInTableRoom,
  buildAuditActor,
  buildOrderFinancialSyncState,
  buildReplacementPrintText,
  captureRelationalOrderFinancialTableGuard,
  clampInt,
  collectAuditEventIdsSince,
  createDefaultIntegrationState,
  findExistingIntegrationIdempotencyRecord,
  findIntegrationOrderIndexByLookup,
  findOrderLineSnapshot,
  findPosTableWithLayout,
  findRelationalOrderById,
  listRelationalOrderWorkflowSnapshot,
  makeIntegrationOrderItemFromProduct,
  normalizeIdempotencyKey,
  normalizeIntegrationStationName,
  nowIso,
  ORDERS_BAR_REPLACEMENT_ASYNC_ACK,
  persistRelationalOrderFinancialTables,
  queuePrintSpoolWorker,
  randomUUID,
  readDb,
  readJsonBody,
  RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY,
  relationalRuntime,
  resolveIntegrationLinkedTableIds,
  resolveIntegrationLogicalTableLabel,
  resolveMenuProductForPayload,
  resolveOrderFinancialSnapshotTableIds,
  runtimeMetrics,
  sanitizeIntegrationLineRoute,
  sanitizeIntegrationOrder,
  sanitizeIntegrationTableLabel,
  sanitizeIntegrationTicketEntry,
  sanitizePosSettings,
  sendJson,
  syncPosTableFinancialsFromIntegrationOrders,
  syncRelationalOrderPrimary,
  validateReplacementReason,
  validateSessionContext,
  writeIntegrationOrderSyncDb,
}) {
  async function handleBarChargeReplacement(req, res) {
    const payload = await readJsonBody(req);
    const tableId = String(payload.tableId ?? "").trim();
    const orderId = String(payload.orderId ?? "").trim();
    const productId = String(payload.productId ?? "").trim();
    const quantity = clampInt(payload.quantity, 1, 99, 1);
    const reason = validateReplacementReason(payload.reason);
    if (!tableId || !orderId || !productId) {
      throw new HttpError(400, "tableId, orderId e productId sono obbligatori.");
    }
  
    const db = await readDb();
    const { user, session } = validateSessionContext(db, payload);
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    if (!Array.isArray(db.integration.barChargeReplacements)) {
      db.integration.barChargeReplacements = [];
    }
    const idempotencyKey = normalizeIdempotencyKey(payload);
    const existing = findExistingIntegrationIdempotencyRecord(
      db.integration.barChargeReplacements,
      idempotencyKey,
      user,
      session.deviceUuid,
    );
    if (existing) {
      sendJson(res, 200, { ok: true, idempotent: true, replacement: existing });
      return;
    }
  
    db.integration.orders = Array.isArray(db.integration.orders)
      ? db.integration.orders
      : [];
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
    const relationalBarReplacementCurrentOrder = await findRelationalOrderById({
      enabled: RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY,
      orderId: currentOrder?.id ?? orderId,
      relationalRuntime,
      runtimeMetrics,
    });
    if (relationalBarReplacementCurrentOrder) {
      currentOrder = sanitizeIntegrationOrder(
        relationalBarReplacementCurrentOrder,
        String(relationalBarReplacementCurrentOrder.id ?? orderId).trim() ||
          orderId,
      );
      if (orderIndex < 0) {
        db.integration.orders.push(currentOrder);
        orderIndex = db.integration.orders.length - 1;
      } else {
        db.integration.orders[orderIndex] = currentOrder;
      }
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
    assertUserCanOperateInTableRoom(user, settings, { ...tableInfo, roomId });
    assertActiveTableWorkLock(db, tableId, {
      user,
      session,
      payload: { ...payload, roomId },
      purpose: "bar_charge_replacement",
    });
  
    const originalLineId = String(payload.originalLineId ?? "").trim();
    const originalLine = findOrderLineSnapshot(
      currentOrder,
      originalLineId,
      productId,
    );
    const product = originalLine
      ? {
          id: originalLine.productId || productId,
          name: originalLine.productNameSnapshot,
          price:
            originalLine.unitPriceApplied || originalLine.listPriceAtTime || 0,
        }
      : resolveMenuProductForPayload(db, payload);
    if (!originalLine && !product) {
      throw new HttpError(400, "Prodotto non valido per la sostituzione.");
    }
  
    const replacementLineId = `repl_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const createdAt = nowIso();
    const tableLabel =
      sanitizeIntegrationTableLabel(
        payload.tableLabel ?? payload.logicalTableLabel,
      ) ||
      resolveIntegrationLogicalTableLabel(
        settings,
        db.integration,
        tableId,
        tableInfo.table.number,
      );
    const productName =
      String(
        product?.name ?? originalLine?.productNameSnapshot ?? productId,
      ).trim() || productId;
    const replacementRecord = {
      id: `bar_repl_${randomUUID().replace(/-/g, "")}`,
      lineType: BAR_CHARGE_REPLACEMENT_LINE_TYPE,
      chargePolicy: "BAR_INTERNAL",
      payable: false,
      customerPrice: 0,
      unitPrice: 0,
      tableId,
      tableNumber: tableInfo.table.number,
      tableLabel,
      roomId,
      orderId,
      orderIds: [orderId],
      originalLineId: originalLine?.lineId ?? originalLineId,
      replacementLineId,
      productId: String(product?.id ?? productId).trim() || productId,
      productName,
      quantity,
      reason,
      createdByUserId: user.id,
      createdByUsername: user.username,
      createdByDeviceUuid: session.deviceUuid,
      createdAt,
      idempotencyKey: idempotencyKey || null,
      fiscalTreatment: BAR_CHARGE_REPLACEMENT_FISCAL_TREATMENT,
    };
  
    const nextItems = [...currentOrder.items];
    for (let index = 0; index < quantity; index += 1) {
      nextItems.push(
        makeIntegrationOrderItemFromProduct({
          id: `oi_${nextItems.length + 1}`,
          lineId: replacementLineId,
          product,
          productId: replacementRecord.productId,
          productName,
          quantity: 1,
          unitPrice: 0,
          routeStations: originalLine?.routeStations,
          replacementMeta: {
            lineType: BAR_CHARGE_REPLACEMENT_LINE_TYPE,
            chargePolicy: "BAR_INTERNAL",
            payable: false,
            customerPrice: 0,
            tableId,
            tableNumber: tableInfo.table.number,
            tableLabel,
            roomId,
            orderId,
            orderIds: [orderId],
            originalLineId: replacementRecord.originalLineId,
            replacementLineId,
            reason,
            createdByUserId: user.id,
            createdByUsername: user.username,
            createdByDeviceUuid: session.deviceUuid,
            createdAt,
            idempotencyKey: idempotencyKey || "",
            fiscalTreatment: BAR_CHARGE_REPLACEMENT_FISCAL_TREATMENT,
          },
        }),
      );
    }
  
    const station = normalizeIntegrationStationName(originalLine?.routeStations?.[0] ?? currentOrder.station);
    const currentRevision = clampInt(currentOrder.revision ?? currentOrder.currentRevision, 1, 1_000_000, 1);
    const nextRevision = currentRevision + 1;
    const replacementTicket = sanitizeIntegrationTicketEntry(
      {
        id: `tkt_${orderId}_${replacementLineId}`,
        orderId,
        roomId,
        stationId: station,
        createdAt,
        createdByUserId: user.id,
        createdByUsername: user.username,
        ticketStatus: "SENT",
      },
      `tkt_${orderId}_${replacementLineId}`,
      orderId,
      roomId,
    );
    const replacementRoute = sanitizeIntegrationLineRoute(
      {
        id: `route_${orderId}_${replacementLineId}`,
        orderId,
        ticketId: replacementTicket?.id ?? null,
        lineId: replacementLineId,
        stationId: station,
        sentAt: createdAt,
        sentByUserId: user.id,
        sentByUsername: user.username,
      },
      `route_${orderId}_${replacementLineId}`,
      orderId,
    );
    const nextOrder = sanitizeIntegrationOrder(
      {
        ...currentOrder,
        items: nextItems,
        tickets: [...currentOrder.tickets, replacementTicket].filter(Boolean),
        lineRoutes: [...currentOrder.lineRoutes, replacementRoute].filter(
          Boolean,
        ),
        total: currentOrder.total,
        paidAmount: currentOrder.paidAmount,
        dueAmount: currentOrder.dueAmount,
        revision: nextRevision,
        currentRevision: nextRevision,
        updatedAt: createdAt,
      },
      orderId,
    );
    db.integration.orders[orderIndex] = nextOrder;
    db.integration.barChargeReplacements.push(replacementRecord);
    const printJob = await appendPrintSpoolJobToDb(db, {
      kind: "bar_replacement",
      orderId,
      roomId,
      station,
      userId: user.id,
      deviceUuid: session.deviceUuid,
      clientApp: session.clientApp,
      text: buildReplacementPrintText(replacementRecord, settings),
    });
    replacementRecord.preparationPrintJobId = printJob?.id ?? null;
    const replacementOrderPrintJob = await appendReplacementOrderPrintJobToDb(db, { replacementRecord, sourceOrder: nextOrder, settings, station, user, session, roomId });
    replacementRecord.orderPrintJobId = replacementOrderPrintJob?.id ?? null;
    const precontoPrintJob = await appendReplacementPrecontoPrintJobToDb(db, { replacementRecord, order: nextOrder, settings, station, user, session, roomId });
    replacementRecord.precontoPrintJobId = precontoPrintJob?.id ?? null;
  
    const actor = buildAuditActor(user, { ...payload, roomId });
    const auditStartIndex = Array.isArray(db.auditEvents) ? db.auditEvents.length : 0;
    appendAuditEvent(db, {
      ...actor,
      action: "bar_replacement.created",
      entityType: "integration_order",
      entityId: orderId,
      roomId,
      payload: replacementRecord,
    });
    appendAuditEvent(db, {
      ...actor,
      action: "bar_replacement.sent_to_preparation",
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
  
    const affectedTableIds = [...new Set([tableId, ...resolveIntegrationLinkedTableIds(db.integration, tableId)].filter(Boolean))];
    db.integration.lastWriteAt = nowIso();
    db.meta.lastWriteAt = nowIso();
    const relationalBarReplacementResult = await syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY, order: nextOrder, previousRevision: currentRevision, relationalRuntime, runtimeMetrics });
    if (RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY && !relationalBarReplacementResult) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision: nextRevision } });
    const barReplacementFinancialSyncSnapshot = await listRelationalOrderWorkflowSnapshot({ enabled: RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY, logger: console, metricLabel: "orders.barReplacement.relationalFinancialSnapshotRead", relationalRuntime, runtimeMetrics, tableIds: resolveOrderFinancialSnapshotTableIds(db, affectedTableIds) });
    const barReplacementFinancialSyncSource = buildOrderFinancialSyncState({ baseState: db, orderSnapshot: barReplacementFinancialSyncSnapshot });
    const barReplacementFinancialTableGuard = await captureRelationalOrderFinancialTableGuard({ enabled: RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY, tableIds: affectedTableIds });
    const financialSync = syncPosTableFinancialsFromIntegrationOrders(barReplacementFinancialSyncSource.state, affectedTableIds);
    if (financialSync.changed === true && barReplacementFinancialTableGuard?.tokens?.length > 0) { const tableRevisionPlan = applyOrderFinancialTableRevisionTokens({ settings: financialSync.settings, tableIds: financialSync.tableIds ?? affectedTableIds, tokens: barReplacementFinancialTableGuard.tokens }); if (tableRevisionPlan.changed === true) { financialSync.settings = tableRevisionPlan.settings; db.posSettings = financialSync.settings; } }
    if (barReplacementFinancialSyncSource.state !== db && financialSync.changed === true) db.posSettings = financialSync.settings;
    await persistRelationalOrderFinancialTables({ appState: db, enabled: RELATIONAL_ORDERS_BAR_REPLACEMENT_WRITE_PRIMARY && financialSync.changed === true, tableIds: financialSync.tableIds ?? (financialSync.changed ? affectedTableIds : []) });
    await writeIntegrationOrderSyncDb(db, { orderIds: [nextOrder.id], syncPosSettings: financialSync.changed === true, posSettingsTableIds: financialSync.tableIds ?? (financialSync.changed ? affectedTableIds : []), auditEventIds: collectAuditEventIdsSince(db, auditStartIndex), integrationObjectFields: ["barChargeReplacements"], metricLabel: "orders.barReplacement.appStateWrite", defer: ORDERS_BAR_REPLACEMENT_ASYNC_ACK });
    queuePrintSpoolWorker();
  
    sendJson(res, 200, {
      ok: true,
      replacement: replacementRecord,
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
    });
  }
  

  return {
    handleBarChargeReplacement,
  };
}
