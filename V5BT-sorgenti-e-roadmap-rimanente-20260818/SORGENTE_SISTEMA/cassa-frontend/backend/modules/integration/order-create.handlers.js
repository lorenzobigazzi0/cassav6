/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createIntegrationOrderCreateHandlers({
  buildIntegrationOrderLineSnapshots,
  isTableWorkLockExpired,
  sanitizeTableWorkLock,
  ORDERS_CREATE_FINANCIAL_DELTA_BEFORE_SNAPSHOT,
  ORDERS_CREATE_QUEUE_RECONCILE_FAST_SKIP,
  ORDERS_TRANSFER_FORCE_ASYNC_ACK,
  ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH,
  ORDER_CREATE_TARGETED_LOCK_REFRESH,
  RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY,
  RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY,
  RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY,
  AUTO_PRINT_ENQUEUE_DELAY_MS,
  HttpError,
  INTEGRATION_DEFAULT_BROADCAST_TO_ALL_STATIONS,
  ORDERS_CREATE_ASYNC_ACK,
  ORDER_AUDIT_DETAILED_LINE_MAX,
  ORDER_AUDIT_DETAILED_TICKET_MAX,
  ORDER_AUDIT_SUMMARY_LINE_SAMPLE_MAX,
  PRIMARY_INTEGRATION_STATION,
  PRINTING_ENABLED,
  PRINT_SPOOL_SQL_PRIMARY,
  REALTIME_BACKBONE_CONFIG,
  RELATIONAL_ORDER_EVENTS_WRITE_PRIMARY,
  allocateIntegrationOrderId,
  appendAuditEvent,
  appendRelationalOrderEvents,
  applyIntegrationAutoAssignment,
  applyIntegrationOrderCompsToPrintableOrder,
  applyNoFiscalAutoPaidPolicyToIntegrationOrder,
  applyOrderFinancialTableRevisionTokens,
  assertActiveRemovedOperationalTableWorkLock,
  assertActiveTableWorkLock,
  assertIntegrationLineVariantSelection,
  assertUserCanOperateInRemovedTableRoom,
  buildActiveIntegrationOrderQueueLaneKeys,
  buildAuditActor,
  buildAutoPrintPayloadsForOrder,
  buildCreatedOrderPreparationQueueFastPlan,
  buildIntegrationMenuItemsByName,
  buildIntegrationStationStatesWithSessionRecovery,
  buildOrderCreateFinancialDeltaBeforeSnapshotFastPath,
  buildOrderCreateFinancialDeltaFastPath,
  buildOrderCreationRelationalEvents,
  buildOrderFinancialSyncState,
  buildOrderOperationalSnapshot,
  buildOrderTransferForceRelationalEvents,
  buildOrderTransferResolutionRelationalEvents,
  buildPreparationQueuePromotionRecord,
  captureRelationalOrderFinancialTableGuard,
  clampInt,
  clearEmbeddedTableWorkLock,
  collectAuditEventIdsSince,
  createDefaultIntegrationState,
  createRelationalOrderPrimary,
  enqueuePrintSpoolJobsOnDb,
  findExistingIntegrationIdempotencyRecord,
  findIntegrationLayoutTableSnapshot,
  findIntegrationMenuItemForLine,
  findIntegrationOrderIndexByLookup,
  findPosTableWithLayout,
  findRelationalOrderById,
  findRelationalOrderCreateIdempotencyRecord,
  getRemovedOperationalTableWorkLock,
  integrationOrderQueueLaneKey,
  integrationOrderQueueOperatorKey,
  integrationOrderQueueStation,
  isIntegrationOrderCancelled,
  isIntegrationOrderOpenForPreparationQueue,
  isIntegrationOrderQueueLaneActive,
  isTableWorkLockFastPathEnabled,
  listRelationalOrderWorkflowSnapshot,
  mergeOrderEvents,
  mirrorRelationalOrderCreateRecordToAppState,
  normalizeClientApp,
  normalizeIntegrationStationName,
  normalizeIntegrationVariantData,
  normalizeIntegrationWorkflowStatus,
  normalizeStringList,
  normalizeTableCovers,
  nowIso,
  orderLaneMetricLabeler,
  parseTableNumberFromValue,
  persistRelationalOrderFinancialTables,
  pickIntegrationStationForLine,
  promoteIntegrationOrderToPreparation,
  pruneIntegrationState,
  publishIntegrationNotificationStreamRefresh,
  queueIntegrationNotification,
  readDb,
  readIntegrationMoneyValue,
  readJsonBody,
  reconcileIntegrationPreparationQueue,
  relationalRuntime,
  releaseRemovedOperationalTableWorkLock,
  releaseTableWorkLock,
  rerouteManualTransferredOrder,
  resolveClientAppFromRequest,
  resolveIntegrationItemAvailabilityInfo,
  resolveIntegrationLineListPrice,
  resolveIntegrationLineMinimumTotalValue,
  resolveIntegrationLineTotalValue,
  resolveIntegrationLineUnitPrice,
  resolveIntegrationLineVariantDelta,
  resolveIntegrationLinkedTableIds,
  resolveIntegrationLogicalTableLabel,
  resolveOrderFinancialSnapshotTableIds,
  resolvePrimaryIntegrationStation,
  resolveRemovedOperationalTableContext,
  roundMoney,
  runtimeMetrics,
  sanitizeIntegrationItemAvailabilityMap,
  sanitizeIntegrationLineRoute,
  sanitizeIntegrationOrder,
  sanitizeIntegrationTableLabel,
  sanitizeIntegrationTicketEntry,
  sanitizePosSettings,
  scheduleOrderCreateAutoPrint,
  sendJson,
  shouldApplyNoFiscalAutoPaidPolicy,
  shouldUseCatalogPriceForIntegrationLine,
  slugifyId,
  syncPosTableFinancialsFromIntegrationOrders,
  syncRelationalOrderPrimary,
  validateSessionContext,
  withPrintLaneMutation,
  writeIntegrationOrderDb,
  writeIntegrationOrderSyncDb,
}) {
  async function handleIntegrationOrderTransferResolve(req, res) {
    const payload = await readJsonBody(req);
    const orderId = String(payload.orderId ?? payload.id ?? "").trim();
    const requestedTransferResolveRevision = clampInt(payload.expectedRevision ?? payload.currentRevision ?? payload.revision, 0, 1_000_000, 0);
    const approve = payload.approve === true;
    const approverStation = normalizeIntegrationStationName(String(payload.approverStation ?? payload.station ?? "").trim());
    const approverOperator = String(payload.approverOperator ?? payload.operatorName ?? "").trim() || "Operatore";
  
    if (!orderId) throw new HttpError(400, "ID comanda non valido.");
  
    const db = await readDb();
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    db.integration.orders = Array.isArray(db.integration.orders) ? db.integration.orders : [];
    let orderIndex = findIntegrationOrderIndexByLookup(db.integration.orders, orderId);
    let currentOrder = orderIndex >= 0 ? sanitizeIntegrationOrder(db.integration.orders[orderIndex], String(db.integration.orders[orderIndex]?.id ?? orderId).trim() || orderId) : null;
    const relationalTransferResolveCurrentOrder = await findRelationalOrderById({ enabled: RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY, orderId: currentOrder?.id ?? orderId, relationalRuntime, runtimeMetrics });
    if (relationalTransferResolveCurrentOrder) {
      currentOrder = sanitizeIntegrationOrder(relationalTransferResolveCurrentOrder, String(relationalTransferResolveCurrentOrder.id ?? orderId).trim() || orderId);
      if (orderIndex < 0) { db.integration.orders.push(currentOrder); orderIndex = db.integration.orders.length - 1; } else db.integration.orders[orderIndex] = currentOrder;
    }
    if (!currentOrder || orderIndex < 0) throw new HttpError(404, "Comanda non trovata.");
  
    const pending = currentOrder.pendingAuthRequest;
    if (!pending || typeof pending !== "object") throw new HttpError(409, "Nessuna richiesta di trasferimento pendente.");
    const fromStation = normalizeIntegrationStationName(pending.fromStation || currentOrder.station);
    if (approverStation && approverStation !== fromStation) {
      throw new HttpError(
        403,
        "Solo la postazione proprietaria puo risolvere la richiesta.",
      );
    }
  
    let nextOrder = {
      ...currentOrder,
      pendingAuthRequest: null,
      updatedAt: nowIso(),
    };
    if (approve) {
      const toStation = normalizeIntegrationStationName(
        pending.toStation || currentOrder.station,
      );
      const transferredAt = nowIso();
      nextOrder.ownerStation = toStation;
      nextOrder.ownerOperator = String(
        pending.toOperator || approverOperator || "Operatore",
      )
        .trim()
        .slice(0, 64);
      nextOrder.ownerRole = String(pending.toOperatorRole || "Operatore")
        .trim()
        .slice(0, 64);
      nextOrder.ownerAtMs = Date.now();
      nextOrder.assignedStationId = toStation;
      nextOrder.assignedStationOperatorUserId = "";
      nextOrder.assignedStationOperatorUsername = "";
      nextOrder.assignedStationOperatorName = "";
      nextOrder.assignedStationDeviceUuid = "";
      nextOrder.assignedStationClientApp = "";
      nextOrder.originalAssignedStationId =
        currentOrder.originalAssignedStationId ||
        currentOrder.assignedStationId ||
        currentOrder.station ||
        fromStation;
      nextOrder.assignmentReason = "manual_transfer";
      nextOrder.assignmentStatus = "assigned";
      nextOrder.manuallyTransferredAt = transferredAt;
  
      if (pending.mode === "transfer") {
        const prevStation = normalizeIntegrationStationName(currentOrder.station);
        nextOrder = rerouteManualTransferredOrder(nextOrder, toStation);
        nextOrder.transferredFromStation = prevStation;
        nextOrder.transferredToStation = toStation;
        nextOrder.transferredAtMs = Date.now();
      }
    }
  
    const currentRevision = clampInt(currentOrder.revision ?? currentOrder.currentRevision, 1, 1_000_000, 1);
    if (RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY && requestedTransferResolveRevision > 0 && currentRevision !== requestedTransferResolveRevision) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision, expectedRevision: requestedTransferResolveRevision } });
    const nextRevision = currentRevision + 1;
    nextOrder = sanitizeIntegrationOrder({ ...nextOrder, revision: nextRevision, currentRevision: nextRevision, events: mergeOrderEvents(nextOrder.events, buildOrderTransferResolutionRelationalEvents({ actorUserId: req.__authContext?.user?.id, approve, approverOperator, approverStation, fromStation, occurredAt: nextOrder.updatedAt, order: nextOrder, pending, revision: nextRevision })) }, currentOrder.id);
    const relationalTransferResolveResult = await syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY, order: nextOrder, previousRevision: requestedTransferResolveRevision > 0 ? requestedTransferResolveRevision : currentRevision, relationalRuntime, runtimeMetrics });
    if (RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY && !relationalTransferResolveResult) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision: nextRevision } });
    db.integration.orders[orderIndex] = nextOrder;
  
    const notification = queueIntegrationNotification(db, {
      type: "general",
      title: approve
        ? nextOrder.assignedStationId ||
          normalizeIntegrationStationName(pending.toStation || currentOrder.station)
        : fromStation,
      description: approve
        ? `Trasferimento #${nextOrder.id} approvato`
        : `Trasferimento #${nextOrder.id} negato`,
      meta: {
        eventType: approve ? "transfer_approved" : "transfer_denied",
        orderId: nextOrder.id,
        fromStation,
        toStation: normalizeIntegrationStationName(
          pending.toStation || currentOrder.station,
        ),
        targetStation: normalizeIntegrationStationName(
          pending.toStation || currentOrder.station,
        ),
        targetClientApp: "postazione",
      },
    });
  
    db.integration.lastWriteAt = nowIso();
    db.meta.lastWriteAt = nowIso();
    pruneIntegrationState(db.integration);
    await writeIntegrationOrderSyncDb(db, { orderIds: [nextOrder.id], syncNotifications: true, notificationIds: [notification?.id], metricLabel: "orders.transfer.resolve.appStateWrite" });
    publishIntegrationNotificationStreamRefresh(approve ? "transfer_approved" : "transfer_denied", { orderId: nextOrder.id, notificationId: notification?.id ?? "", notification, fromStation, toStation: normalizeIntegrationStationName(pending.toStation || currentOrder.station), targetStation: normalizeIntegrationStationName(pending.toStation || currentOrder.station), approved: approve }, { requireOutbox: RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY && REALTIME_BACKBONE_CONFIG.eventOutboxEnabled });
  
    sendJson(res, 200, {
      ok: true,
      approved: approve,
      order: nextOrder,
    });
  }
  
  async function handleIntegrationOrderTransferForce(req, res) {
    const payload = await readJsonBody(req);
    const orderId = String(payload.orderId ?? payload.id ?? "").trim(), requestedTransferForceRevision = clampInt(payload.expectedRevision ?? payload.currentRevision ?? payload.revision, 0, 1_000_000, 0);
    const toStation = normalizeIntegrationStationName(
      String(payload.toStation ?? payload.station ?? "").trim(),
    );
    const operatorName =
      String(payload.operatorName ?? payload.toOperator ?? "Operatore").trim() ||
      "Operatore";
    const operatorRole =
      String(
        payload.operatorRole ?? payload.toOperatorRole ?? "Operatore",
      ).trim() || "Operatore";
  
    if (!orderId) {
      throw new HttpError(400, "ID comanda non valido.");
    }
  
    const db = await readDb();
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    db.integration.orders = Array.isArray(db.integration.orders) ? db.integration.orders : [];
    let orderIndex = findIntegrationOrderIndexByLookup(db.integration.orders, orderId);
    let currentOrder = orderIndex >= 0 ? sanitizeIntegrationOrder(db.integration.orders[orderIndex], String(db.integration.orders[orderIndex]?.id ?? orderId).trim() || orderId) : null;
    const relationalTransferForceCurrentOrder = await findRelationalOrderById({ enabled: RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY, orderId: currentOrder?.id ?? orderId, relationalRuntime, runtimeMetrics });
    if (relationalTransferForceCurrentOrder) {
      currentOrder = sanitizeIntegrationOrder(relationalTransferForceCurrentOrder, String(relationalTransferForceCurrentOrder.id ?? orderId).trim() || orderId);
      if (orderIndex < 0) { db.integration.orders.push(currentOrder); orderIndex = db.integration.orders.length - 1; } else db.integration.orders[orderIndex] = currentOrder;
    }
    if (!currentOrder || orderIndex < 0) throw new HttpError(404, "Comanda non trovata.");
    if (isIntegrationOrderCancelled(currentOrder)) {
      throw new HttpError(409, "Comanda annullata: non e trasferibile.", {
        code: "ORDER_CANCELLED",
      });
    }
    const fromStation = normalizeIntegrationStationName(
      String(
        payload.fromStation ??
          currentOrder.station ??
          PRIMARY_INTEGRATION_STATION,
      ),
    );
    const transferredAt = nowIso();
    const currentRevision = clampInt(currentOrder.revision ?? currentOrder.currentRevision, 1, 1_000_000, 1);
    if (RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY && requestedTransferForceRevision > 0 && currentRevision !== requestedTransferForceRevision) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision, expectedRevision: requestedTransferForceRevision } });
    const nextRevision = currentRevision + 1;
    const nextOrder = sanitizeIntegrationOrder(
      rerouteManualTransferredOrder(
        {
        ...currentOrder,
        station: toStation,
        assignedStationId: toStation,
        assignedStationOperatorUserId: "",
        assignedStationOperatorUsername: "",
        assignedStationOperatorName: "",
        assignedStationDeviceUuid: "",
        assignedStationClientApp: "",
        originalAssignedStationId:
          currentOrder.originalAssignedStationId ||
          currentOrder.assignedStationId ||
          currentOrder.station ||
          fromStation,
        assignmentReason: "manual_transfer",
        assignmentStatus: "assigned",
        manuallyTransferredAt: transferredAt,
        ownerStation: toStation,
        ownerOperator: operatorName,
        ownerRole: operatorRole,
        ownerAtMs: Date.now(),
        workflowStatus:
          normalizeIntegrationWorkflowStatus(
            currentOrder.workflowStatus,
            currentOrder.items,
            currentOrder.completedAtMs,
          ) === "delivered"
            ? "delivered"
            : "waiting",
        completedAtMs: null,
        transferredFromStation: fromStation,
        transferredToStation: toStation,
        transferredAtMs: Date.now(),
        pendingAuthRequest: null,
        revision: nextRevision,
        currentRevision: nextRevision,
        updatedAt: nowIso(),
        events: mergeOrderEvents(currentOrder.events, buildOrderTransferForceRelationalEvents({ actorUserId: req.__authContext?.user?.id, fromStation, occurredAt: transferredAt, operatorName, operatorRole, order: currentOrder, revision: nextRevision, toStation })),
        },
        toStation,
      ),
      currentOrder.id,
    );
    const relationalTransferForceResult = await syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY, order: nextOrder, previousRevision: requestedTransferForceRevision > 0 ? requestedTransferForceRevision : currentRevision, relationalRuntime, runtimeMetrics });
    if (RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY && !relationalTransferForceResult) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision: nextRevision } });
    db.integration.orders[orderIndex] = nextOrder;
    db.integration.lastWriteAt = nowIso();
    db.meta.lastWriteAt = nowIso();
    pruneIntegrationState(db.integration);
    await writeIntegrationOrderSyncDb(db, { orderIds: [nextOrder.id], metricLabel: "orders.transfer.force.appStateWrite", defer: ORDERS_TRANSFER_FORCE_ASYNC_ACK });
    publishIntegrationNotificationStreamRefresh("transfer_forced", { orderId: nextOrder.id, fromStation, toStation, station: toStation, order: nextOrder }, { requireOutbox: RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY && REALTIME_BACKBONE_CONFIG.eventOutboxEnabled });
  
    sendJson(res, 200, {
      ok: true,
      order: nextOrder,
    });
  }
  
  async function handleIntegrationOrderCreate(req, res) {
    let orderCreateStageAt = Date.now(); const recordOrderCreateStage = (label) => { const stageNow = Date.now(); runtimeMetrics.recordOperation("orderCreateInternal", label, stageNow - orderCreateStageAt); orderCreateStageAt = stageNow; };
    const sendOrderCreateResponse = (status, body) => { const startedAt = Date.now(); try { sendJson(res, status, body); } finally { runtimeMetrics.recordOperation("orderCreateInternal", "response", Date.now() - startedAt); } };
    const payload = await readJsonBody(req); recordOrderCreateStage("readBody"); const orderCreateTableId = typeof payload.tableId === "string" ? payload.tableId.trim() : "";
    const db = await readDb({ operationMetricKind: "orderCreateRead", parallelExternalizedTableLocksAndStationStates: ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH, refreshExternalizedSessions: !req.__authContext, refreshExternalizedIntegrationStationStates: true, refreshExternalizedTableLocks: !ORDER_CREATE_TARGETED_LOCK_REFRESH || Boolean(orderCreateTableId), refreshExternalizedTableLockId: ORDER_CREATE_TARGETED_LOCK_REFRESH ? orderCreateTableId : "" }); recordOrderCreateStage("readDb");
    const authContext = req.__authContext && typeof req.__authContext === "object" ? req.__authContext : validateSessionContext(db, payload);
    const { user, session } = authContext; recordOrderCreateStage("auth");
  
    if (!db.integration || typeof db.integration !== "object") db.integration = createDefaultIntegrationState();
    const orderIdempotencyKey = String(
      payload.idempotencyKey ?? payload.clientOrderId ?? payload.localOrderId ?? "",
    ).trim();
    const idempotentOrder = findExistingIntegrationIdempotencyRecord(
      db.integration.orders,
      orderIdempotencyKey,
      user,
      session.deviceUuid,
    );
    if (idempotentOrder) {
      sendOrderCreateResponse(200, { ok: true, idempotent: true, order: idempotentOrder });
      return;
    }
    const relationalIdempotentOrder =
      await findRelationalOrderCreateIdempotencyRecord({
        deviceUuid: session.deviceUuid,
        enabled: RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY,
        idempotencyKey: orderIdempotencyKey,
        relationalRuntime,
        user,
    });
    if (relationalIdempotentOrder) {
      const mirroredOrder = await mirrorRelationalOrderCreateRecordToAppState({
        db,
        order: relationalIdempotentOrder,
        createDefaultIntegrationState,
        findIntegrationOrderIndexByLookup,
        nowIso,
        pruneIntegrationState,
        sanitizeIntegrationOrder,
        writeIntegrationOrderDb,
      });
      sendOrderCreateResponse(200, {
        ok: true,
        idempotent: true,
        order: mirroredOrder ?? relationalIdempotentOrder,
      });
      return;
    } recordOrderCreateStage("idempotency");
  
    const menuItemsByName = buildIntegrationMenuItemsByName(db);
    const itemAvailability = sanitizeIntegrationItemAvailabilityMap(
      db.integration.itemAvailability,
    );
  
    const sourceLines = Array.isArray(payload.lines) ? payload.lines : [];
    const expandedItems = [];
    const lineDescriptors = [];
    for (const line of sourceLines) {
      const lineName = String(line?.name ?? "").trim();
      if (!lineName) continue;
      const qty = Math.max(1, Math.trunc(Number(line.qty) || 1));
      const menuItem = findIntegrationMenuItemForLine(line, menuItemsByName);
      const lineStation = pickIntegrationStationForLine(line, menuItemsByName);
      const availabilityInfo = resolveIntegrationItemAvailabilityInfo(
        menuItem || {
          id: line?.productId ?? line?.id ?? lineName,
          name: lineName,
          category: line?.category,
          station: lineStation,
          stations: [lineStation],
        },
        itemAvailability,
        lineStation,
      );
      if (!availabilityInfo.available) {
        throw new HttpError(
          409,
          `${lineName} non ordinabile: articolo esaurito.`,
          {
            code: "ITEM_UNAVAILABLE",
            itemName: lineName,
            station: lineStation,
            scope: availabilityInfo.scope,
          },
        );
      }
      const selectedVariant = assertIntegrationLineVariantSelection(
        line,
        menuItem,
      );
      const variant = selectedVariant
        ? selectedVariant.name
        : String(line.variant ?? line.variantName ?? "").trim();
      const note = String(line.note ?? "").trim();
      const unitPriceApplied = resolveIntegrationLineUnitPrice(
        line,
        qty,
        menuItemsByName,
      );
      const listPriceAtTime = resolveIntegrationLineListPrice(
        line,
        unitPriceApplied,
        menuItemsByName,
      );
      const menuPrice = readIntegrationMoneyValue(menuItem?.price);
      const usesCatalogPrice =
        shouldUseCatalogPriceForIntegrationLine(line, menuItem) &&
        menuPrice !== null &&
        menuPrice > 0;
      const rawLineTotal = usesCatalogPrice
        ? roundMoney(unitPriceApplied * qty)
        : resolveIntegrationLineTotalValue(line, qty, unitPriceApplied);
      const minimumLineTotal = resolveIntegrationLineMinimumTotalValue(
        line,
        qty,
        unitPriceApplied,
        menuItemsByName,
      );
      const lineTotal =
        minimumLineTotal > rawLineTotal ? minimumLineTotal : rawLineTotal;
      const lineTotalCents = Math.max(Math.round(lineTotal * 100), 0);
      const baseUnitTotalCents = Math.floor(lineTotalCents / qty);
      let extraUnitTotalCents = lineTotalCents - baseUnitTotalCents * qty;
      const lineId = `line_${String(lineDescriptors.length + 1).padStart(4, "0")}`;
      const routeStations = [normalizeIntegrationStationName(lineStation)];
      lineDescriptors.push({
        lineId,
        stationId: normalizeIntegrationStationName(lineStation),
        routeStations,
      });
      for (let unitIndex = 0; unitIndex < qty; unitIndex += 1) {
        const unitTotalCents =
          baseUnitTotalCents + (extraUnitTotalCents > 0 ? 1 : 0);
        if (extraUnitTotalCents > 0) extraUnitTotalCents -= 1;
        expandedItems.push({
          id: `oi_${expandedItems.length + 1}`,
          lineId,
          productId: String(
            menuItem?.id ??
              line.productId ??
              line.id ??
              slugifyId(lineName, "product"),
          ).trim(),
          productNameSnapshot: lineName,
          name: lineName,
          qty: 1,
          unitPriceApplied,
          listPriceAtTime,
          lineTotal: roundMoney(unitTotalCents / 100),
          variants: selectedVariant
            ? {
                id: selectedVariant.id,
                label: selectedVariant.name,
                name: selectedVariant.name,
                priceDelta: selectedVariant.priceDelta,
              }
            : normalizeIntegrationVariantData(line?.variants, variant),
          variant,
          selectedVariantId: selectedVariant?.id ?? null,
          selectedVariantName: selectedVariant?.name ?? null,
          selectedVariantPriceDelta: selectedVariant
            ? roundMoney(Number(selectedVariant.priceDelta) || 0)
            : 0,
          variantPriceDelta: selectedVariant
            ? roundMoney(Number(selectedVariant.priceDelta) || 0)
            : resolveIntegrationLineVariantDelta(line, menuItem),
          finalLinePrice: roundMoney(unitTotalCents / 100),
          notes: note,
          note,
          allergens: normalizeStringList(line?.allergens, 20, 80),
          routeStations,
          done: false,
        });
      }
    }
  
    if (expandedItems.length === 0) {
      throw new HttpError(400, "Comanda vuota: nessun articolo valido.");
    }
    const expandedItemsTotal = roundMoney(
      expandedItems.reduce(
        (sum, item) => sum + Math.max(Number(item.lineTotal) || 0, 0),
        0,
      ),
    ); recordOrderCreateStage("lineExpansion");
  
    const orderId = await allocateIntegrationOrderId(db);
    const hasExplicitStation = false;
    const station = resolvePrimaryIntegrationStation(db);
    const lineStations = lineDescriptors
      .map((descriptor) => normalizeIntegrationStationName(descriptor.stationId))
      .filter(Boolean);
    const uniqueLineStations = [...new Set(lineStations)];
    const stationStates = buildIntegrationStationStatesWithSessionRecovery(db);
    db.integration.stationStates = stationStates; recordOrderCreateStage("allocationAndStationState");
    let pausedStationWarning = null;
    const tableId = orderCreateTableId;
    const tableNumber = parseTableNumberFromValue(
      payload.tableNumber ?? payload.table,
      tableId,
    );
    const tableLabel =
      sanitizeIntegrationTableLabel(
        payload.tableLabel ?? payload.logicalTableLabel,
      ) ||
      resolveIntegrationLogicalTableLabel(
        db.posSettings,
        db.integration,
        tableId,
        tableNumber,
      );
    let shouldReleaseTransientOrderCreateLock = false;
    let removedOperationalOrderContext = null;
    if (tableId) {
      const settingsBeforeOrderCreateLock = sanitizePosSettings(db.posSettings, {
        menuItems: db.menuItems,
        users: db.users,
      });
      const tableInfoBeforeOrderCreateLock = findPosTableWithLayout(
        settingsBeforeOrderCreateLock,
        tableId,
      );
      if (tableInfoBeforeOrderCreateLock) {
        const lockBeforeOrderCreate = sanitizeTableWorkLock(
          tableInfoBeforeOrderCreateLock.table.workLock,
        );
        shouldReleaseTransientOrderCreateLock =
          !lockBeforeOrderCreate || isTableWorkLockExpired(lockBeforeOrderCreate);
        assertActiveTableWorkLock(db, tableId, {
          user,
          session,
          payload,
          purpose: "order.create",
        });
        if (isTableWorkLockFastPathEnabled()) {
          clearEmbeddedTableWorkLock(db, tableId);
        }
      } else {
        removedOperationalOrderContext = resolveRemovedOperationalTableContext(
          db,
          settingsBeforeOrderCreateLock,
          tableId,
          payload,
        );
        assertUserCanOperateInRemovedTableRoom(
          user,
          settingsBeforeOrderCreateLock,
          removedOperationalOrderContext.tableInfo,
          { session },
        );
        if (removedOperationalOrderContext.table.number !== tableNumber) {
          throw new HttpError(409, "Numero del tavolo rimosso non coerente.", {
            code: "REMOVED_SOURCE_NUMBER_MISMATCH",
          });
        }
        const lockBeforeOrderCreate = getRemovedOperationalTableWorkLock(
          db,
          tableId,
        );
        shouldReleaseTransientOrderCreateLock =
          !lockBeforeOrderCreate || isTableWorkLockExpired(lockBeforeOrderCreate);
        assertActiveRemovedOperationalTableWorkLock(
          db,
          removedOperationalOrderContext,
          {
            user,
            session,
            payload,
            purpose: "order.create",
          },
        );
      }
    } recordOrderCreateStage("tableLockAndOperationalContext");
    const orderOperationalResolution = buildOrderOperationalSnapshot({
      db,
      payload,
      user,
      tableId,
    });
    const explicitSourceApp =
      typeof payload.source === "string" && payload.source.trim().length > 0
        ? normalizeClientApp(payload.source)
        : "";
    const requestClientApp = resolveClientAppFromRequest(
      req,
      typeof payload.clientApp === "string" ? payload.clientApp.trim() : "",
    );
    const sourceApp = explicitSourceApp || requestClientApp || "mobile-frontend";
    // Le comande operative devono comparire su una sola postazione assegnata.
    // Il vecchio flag del mobile viene ignorato per evitare broadcast accidentali.
    const broadcastToAllStations =
      INTEGRATION_DEFAULT_BROADCAST_TO_ALL_STATIONS === true;
    const now = Date.now();
    const createdAtIso = nowIso();
    const ticketByStation = new Map();
    uniqueLineStations.forEach((stationId) => {
      const ticketId = `tkt_${orderId}_${ticketByStation.size + 1}`;
      const ticket = sanitizeIntegrationTicketEntry(
        {
          id: ticketId,
          orderId,
          roomId: typeof payload.roomId === "string" ? payload.roomId.trim() : "",
          stationId,
          createdAt: createdAtIso,
          createdByUserId: user.id,
          createdByUsername: user.username,
          ticketStatus: "SENT",
        },
        ticketId,
        orderId,
        typeof payload.roomId === "string" ? payload.roomId.trim() : "",
      );
      ticketByStation.set(stationId, ticket);
    });
    if (ticketByStation.size === 0) {
      const ticketId = `tkt_${orderId}_1`;
      ticketByStation.set(
        station,
        sanitizeIntegrationTicketEntry(
          {
            id: ticketId,
            orderId,
            roomId:
              typeof payload.roomId === "string" ? payload.roomId.trim() : "",
            stationId: station,
            createdAt: createdAtIso,
            createdByUserId: user.id,
            createdByUsername: user.username,
            ticketStatus: "SENT",
          },
          ticketId,
          orderId,
          typeof payload.roomId === "string" ? payload.roomId.trim() : "",
        ),
      );
    }
    const tickets = [...ticketByStation.values()].filter(
      (ticket) => ticket !== null,
    );
    const lineRoutes = lineDescriptors
      .map((descriptor, index) =>
        sanitizeIntegrationLineRoute(
          {
            id: `route_${orderId}_${index + 1}`,
            orderId,
            ticketId: ticketByStation.get(descriptor.stationId)?.id ?? null,
            lineId: descriptor.lineId,
            stationId: descriptor.stationId,
            sentAt: createdAtIso,
            sentByUserId: user.id,
            sentByUsername: user.username,
          },
          `route_${orderId}_${index + 1}`,
          orderId,
        ),
      )
      .filter((route) => route !== null);
    let nextOrder = sanitizeIntegrationOrder(
      {
        id: orderId,
        table: tableNumber,
        waiter:
          typeof payload.waiter === "string" && payload.waiter.trim().length > 0
            ? payload.waiter.trim()
            : String(user.fullName ?? user.username ?? "Cameriere").trim() ||
              "Cameriere",
        covers: normalizeTableCovers(payload.covers),
        apericena: Math.max(0, Math.trunc(Number(payload.apericena) || 0)),
        note: String(payload.orderNote ?? payload.note ?? "").trim(),
        communications: String(
          payload.orderComment ?? payload.communications ?? "",
        ).trim(),
        receivedAtMs: now,
        completedAtMs: null,
        station,
        ownerStation: null,
        ownerOperator: null,
        ownerRole: null,
        ownerAtMs: null,
        workflowStatus: "waiting",
        items: expandedItems,
        tickets,
        lineRoutes,
        parentOrderId: null,
        isPartial: false,
        transferredFromStation: null,
        transferredToStation: null,
        transferredAtMs: null,
        pendingAuthRequest: null,
        source: sourceApp,
        broadcastToAllStations,
        roomId: typeof payload.roomId === "string" ? payload.roomId.trim() : "",
        tableId,
        tableNumber,
        tableLabel,
        logicalTableLabel: tableLabel,
        operationalSnapshot: orderOperationalResolution.snapshot,
        title: String(payload.title ?? "").trim(),
        total: expandedItemsTotal,
        orderNote: String(payload.orderNote ?? "").trim(),
        orderComment: String(payload.orderComment ?? "").trim(),
  	      createdByUserId: user.id,
  	      createdByUsername: user.username,
  	      createdByDeviceUuid: session.deviceUuid,
  	      idempotencyKey: orderIdempotencyKey || null,
  	      createdAt: createdAtIso,
  	      updatedAt: createdAtIso,
  	    },
      orderId,
    );
    const assignment = applyIntegrationAutoAssignment(db, nextOrder, {
      source: sourceApp,
    });
    nextOrder = assignment.order; recordOrderCreateStage("buildOrderAndAssignment");
    const assignmentReasonDetail = String(
      nextOrder.assignmentReasonDetail ?? assignment.choice?.reason ?? "",
    ).trim();
    if (
      nextOrder.assignmentStatus === "queued_unassigned" &&
      ["no_active_station", "no_eligible_active_station"].includes(
        assignmentReasonDetail,
      )
    ) {
      pausedStationWarning = {
        code: "station_paused_only_target",
        station: normalizeIntegrationStationName(nextOrder.station || station),
        active: false,
        onlyStationForOrder: true,
        assignmentStatus: nextOrder.assignmentStatus,
        assignmentReasonDetail,
        message:
          "Nessuna postazione attiva, gli ordini andranno in coda ma non verranno preparati fino alla riattivazione di almeno una postazione.",
      };
    }
    if (shouldApplyNoFiscalAutoPaidPolicy(user, payload)) {
      nextOrder = applyNoFiscalAutoPaidPolicyToIntegrationOrder(nextOrder, {
        user,
        payload
      });
    }
  
    let orderCreateAuditPreludeAt = Date.now(); const recordOrderCreateAuditPrelude = (label) => { const stageNow = Date.now(); runtimeMetrics.recordOperation("orderCreateAuditPrelude", label, stageNow - orderCreateAuditPreludeAt); orderCreateAuditPreludeAt = stageNow; };
    orderLaneMetricLabeler.rememberOrder(nextOrder); db.integration.orders.push(nextOrder);
    let queuePromotions = [];
    const orderCreateQueueContext = { source: "order_create", userId: user.id, username: user.username };
    const orderCreateQueueReconcileFastPath = ORDERS_CREATE_QUEUE_RECONCILE_FAST_SKIP && Boolean(assignment.choice?.stationId) ? buildCreatedOrderPreparationQueueFastPlan(db, nextOrder, buildActiveIntegrationOrderQueueLaneKeys(db), { integrationOrderQueueLaneKey, isIntegrationOrderOpenForPreparationQueue: (order) => isIntegrationOrderOpenForPreparationQueue(order, { normalizeIntegrationWorkflowStatus, roundMoney }), isIntegrationOrderQueueLaneActive: (order, queue) => isIntegrationOrderQueueLaneActive(order, queue, { integrationOrderQueueLaneKey, integrationOrderQueueOperatorKey, integrationOrderQueueStation }), normalizeIntegrationWorkflowStatus, promoteOrder: (order) => promoteIntegrationOrderToPreparation(order, orderCreateQueueContext), buildPromotionRecord: (order) => buildPreparationQueuePromotionRecord(order, { integrationOrderQueueStation }) }) : { applied: false, promoted: [] };
    if (orderCreateQueueReconcileFastPath.applied) {
      runtimeMetrics.incrementCounter("orderCreateQueueReconcileFastSkips");
      queuePromotions = orderCreateQueueReconcileFastPath.promoted;
      if (orderCreateQueueReconcileFastPath.changed === true) { db.integration.orders = orderCreateQueueReconcileFastPath.orders; db.integration.lastWriteAt = nowIso(); db.meta.lastWriteAt = nowIso(); }
      if (queuePromotions.length > 0 || orderCreateQueueReconcileFastPath.changed === true) nextOrder = db.integration.orders.find((entry) => String(entry?.id ?? "").trim() === orderId) ?? nextOrder;
    } else {
      runtimeMetrics.incrementCounter("orderCreateQueueReconcileFastFallbacks");
      queuePromotions = reconcileIntegrationPreparationQueue(db, {
        ...orderCreateQueueContext,
      });
      if (queuePromotions.length > 0) {
        nextOrder =
          db.integration.orders.find(
            (entry) => String(entry?.id ?? "").trim() === orderId,
          ) ?? nextOrder;
      }
    } recordOrderCreateAuditPrelude("queueReconcile");
    const auditActor = buildAuditActor(user, {
      ...payload,
      deviceUuid: session.deviceUuid,
      sessionId: session.id,
    });
    const auditStartIndex = Array.isArray(db.auditEvents) ? db.auditEvents.length : 0;
    appendAuditEvent(db, {
      ...auditActor,
      action: "order.created",
      entityType: "integration_order",
      entityId: nextOrder.id,
      roomId: nextOrder.roomId || auditActor.roomId,
      payload: {
        orderId: nextOrder.id,
        tableId: nextOrder.tableId,
        tableNumber: nextOrder.tableNumber,
        source: sourceApp,
        activityId: nextOrder.operationalSnapshot?.activityId ?? null,
        operationalSchemaVersion:
          nextOrder.operationalSnapshot?.schemaVersion ?? null,
      },
      after: {
        id: nextOrder.id,
        workflowStatus: nextOrder.workflowStatus,
        operationalSnapshot: nextOrder.operationalSnapshot,
      },
    });
    if (orderOperationalResolution.legacyWarning) {
      appendAuditEvent(db, {
        ...auditActor,
        action: "order.operational_context_legacy",
        entityType: "integration_order",
        entityId: nextOrder.id,
        roomId: nextOrder.roomId || auditActor.roomId,
        payload: {
          orderId: nextOrder.id,
          roomId: nextOrder.roomId,
          warning: orderOperationalResolution.legacyWarning,
        },
      });
    }
    if (nextOrder.autoPaidNoFiscal === true) {
      appendAuditEvent(db, {
        ...auditActor,
        action: "order.auto_paid_no_fiscal",
        entityType: "integration_order",
        entityId: nextOrder.id,
        roomId: nextOrder.roomId || auditActor.roomId,
        payload: {
          orderId: nextOrder.id,
          tableId: nextOrder.tableId,
          tableNumber: nextOrder.tableNumber,
          total: nextOrder.total,
          paidAmount: nextOrder.paidAmount,
          dueAmount: nextOrder.dueAmount,
          fiscalPolicy: nextOrder.fiscalPolicy,
        },
        after: {
          paymentStatus: nextOrder.paymentStatus,
          workflowStatus: nextOrder.workflowStatus,
          fiscalExcluded: nextOrder.fiscalExcluded,
        },
      });
    } recordOrderCreateAuditPrelude("baseAuditEvents");
    const orderLineSnapshots = [
      ...buildIntegrationOrderLineSnapshots(nextOrder).values(),
    ]; recordOrderCreateAuditPrelude("lineSnapshots");
    const shouldBuildOrderRelationalEvents =
      RELATIONAL_ORDER_EVENTS_WRITE_PRIMARY ||
      RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY;
    const orderRelationalEvents = shouldBuildOrderRelationalEvents
      ? buildOrderCreationRelationalEvents({
          actor: auditActor,
          lineSnapshots: orderLineSnapshots,
          occurredAt: createdAtIso,
          order: nextOrder,
          source: sourceApp,
        })
  	    : [];
    recordOrderCreateAuditPrelude("relationalEventsBuild");
    if (orderRelationalEvents.length > 0) {
      const mergedCreateEvents = mergeOrderEvents(nextOrder.events, orderRelationalEvents);
      nextOrder = process.env.BACKEND_ORDERS_CREATE_AUDIT_PRELUDE_FAST_EVENTS !== "0" && RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY ? { ...nextOrder, events: mergedCreateEvents.slice(-500) } : sanitizeIntegrationOrder({ ...nextOrder, events: mergedCreateEvents }, nextOrder.id);
      const persistedOrderIndex = findIntegrationOrderIndexByLookup(
        db.integration.orders,
        nextOrder.id,
      );
      if (persistedOrderIndex >= 0) db.integration.orders[persistedOrderIndex] = nextOrder;
    } recordOrderCreateAuditPrelude("eventsMerge"); recordOrderCreateStage("auditPrelude");
    if (orderLineSnapshots.length <= ORDER_AUDIT_DETAILED_LINE_MAX) {
      orderLineSnapshots.forEach((line) => {
        appendAuditEvent(db, {
          ...auditActor,
          action: "order.line_added",
          entityType: "order_line",
          entityId: `${nextOrder.id}:${line.lineId}`,
          roomId: nextOrder.roomId || auditActor.roomId,
          payload: {
            orderId: nextOrder.id,
            lineId: line.lineId,
            qty: line.qty,
            productNameSnapshot: line.productNameSnapshot,
            unitPriceApplied: line.unitPriceApplied,
            listPriceAtTime: line.listPriceAtTime,
            routeStations: line.routeStations,
          },
        });
      });
    } else {
      const routeStations = Array.from(
        new Set(
          orderLineSnapshots.flatMap((line) =>
            Array.isArray(line.routeStations) ? line.routeStations : [],
          ),
        ),
      )
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
        .slice(0, 20);
      const sampleLines = orderLineSnapshots
        .slice(0, ORDER_AUDIT_SUMMARY_LINE_SAMPLE_MAX)
        .map((line) => ({
          lineId: line.lineId,
          qty: line.qty,
          productNameSnapshot: line.productNameSnapshot,
          unitPriceApplied: line.unitPriceApplied,
          listPriceAtTime: line.listPriceAtTime,
          routeStations: line.routeStations,
        }));
      appendAuditEvent(db, {
        ...auditActor,
        action: "order.lines_added",
        entityType: "order_lines",
        entityId: nextOrder.id,
        roomId: nextOrder.roomId || auditActor.roomId,
        payload: {
          orderId: nextOrder.id,
          lineCount: orderLineSnapshots.length,
          totalQty: roundMoney(
            orderLineSnapshots.reduce(
              (sum, line) => sum + Math.max(Number(line.qty) || 0, 0),
              0,
            ),
          ),
          routeStations,
          sampleLines,
          truncatedLineCount: Math.max(
            orderLineSnapshots.length - sampleLines.length,
            0,
          ),
        },
      });
    }
    const orderTickets = Array.isArray(nextOrder.tickets)
      ? nextOrder.tickets
      : [];
    if (orderTickets.length <= ORDER_AUDIT_DETAILED_TICKET_MAX) {
      orderTickets.forEach((ticket) => {
        appendAuditEvent(db, {
          ...auditActor,
          action: "order.ticket_created",
          entityType: "order_ticket",
          entityId: ticket.id,
          roomId: nextOrder.roomId || auditActor.roomId,
          payload: {
            orderId: nextOrder.id,
            ticketId: ticket.id,
            stationId: ticket.stationId,
          },
        });
        appendAuditEvent(db, {
          ...auditActor,
          action: "order.ticket_sent",
          entityType: "order_ticket",
          entityId: ticket.id,
          roomId: nextOrder.roomId || auditActor.roomId,
          payload: {
            orderId: nextOrder.id,
            ticketId: ticket.id,
            stationId: ticket.stationId,
            sentAt: ticket.createdAt,
          },
        });
      });
    } else {
      const ticketSummaries = orderTickets.map((ticket) => ({
        ticketId: ticket.id,
        stationId: ticket.stationId,
        sentAt: ticket.createdAt,
      }));
      appendAuditEvent(db, {
        ...auditActor,
        action: "order.tickets_created",
        entityType: "order_tickets",
        entityId: nextOrder.id,
        roomId: nextOrder.roomId || auditActor.roomId,
        payload: {
          orderId: nextOrder.id,
          ticketCount: orderTickets.length,
          tickets: ticketSummaries,
        },
      });
      appendAuditEvent(db, {
        ...auditActor,
        action: "order.tickets_sent",
        entityType: "order_tickets",
        entityId: nextOrder.id,
        roomId: nextOrder.roomId || auditActor.roomId,
        payload: {
          orderId: nextOrder.id,
          ticketCount: orderTickets.length,
          tickets: ticketSummaries,
        },
      });
    }
    recordOrderCreateStage("auditDetails"); await createRelationalOrderPrimary({
      enabled: RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY,
      order: nextOrder,
      relationalRuntime, runtimeMetrics,
    }); recordOrderCreateStage("relationalPrimary");
    const orderCreateFinancialTargetTableIds = nextOrder.tableId ? [nextOrder.tableId] : [];
    const orderCreateFinancialTableGuard = await captureRelationalOrderFinancialTableGuard({
      enabled: RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY,
      tableIds: orderCreateFinancialTargetTableIds,
    });
    const orderCreateFinancialDeltaEnabled = process.env.BACKEND_ORDERS_CREATE_FINANCIAL_DELTA_FASTPATH !== "0" && RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY;
    let orderCreateFinancialSyncSource = buildOrderFinancialSyncState({ baseState: db, orderSnapshot: null });
    let orderCreateFinancialDeltaFastPath = buildOrderCreateFinancialDeltaBeforeSnapshotFastPath({ appState: db, enabled: ORDERS_CREATE_FINANCIAL_DELTA_BEFORE_SNAPSHOT && orderCreateFinancialDeltaEnabled, guardTokens: orderCreateFinancialTableGuard?.tokens, linkedTableIds: nextOrder.tableId ? resolveIntegrationLinkedTableIds(db?.integration, nextOrder.tableId) : [], order: nextOrder, targetTableIds: orderCreateFinancialTargetTableIds });
    runtimeMetrics.recordOperation("orderWorkflow", `orders.create.financialDeltaBeforeSnapshot.${orderCreateFinancialDeltaFastPath.reason || "unknown"}`, 0);
    runtimeMetrics.incrementCounter(orderCreateFinancialDeltaFastPath.applied ? "orderCreateFinancialDeltaBeforeSnapshotHits" : "orderCreateFinancialDeltaBeforeSnapshotFallbacks");
    if (!orderCreateFinancialDeltaFastPath.applied) {
      const orderCreateFinancialSnapshotTableIds = resolveOrderFinancialSnapshotTableIds(db, orderCreateFinancialTargetTableIds);
      const orderCreateFinancialSyncSnapshot = await listRelationalOrderWorkflowSnapshot({ enabled: RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY, logger: console, metricLabel: "orders.create.relationalFinancialSnapshotRead", relationalRuntime, runtimeMetrics, tableIds: orderCreateFinancialSnapshotTableIds });
      orderCreateFinancialSyncSource = buildOrderFinancialSyncState({ baseState: db, orderSnapshot: orderCreateFinancialSyncSnapshot });
      orderCreateFinancialDeltaFastPath = buildOrderCreateFinancialDeltaFastPath({ appState: orderCreateFinancialSyncSource.state, enabled: orderCreateFinancialDeltaEnabled, linkedTableIds: nextOrder.tableId ? resolveIntegrationLinkedTableIds(db?.integration, nextOrder.tableId) : [], order: nextOrder, targetTableIds: orderCreateFinancialTargetTableIds });
    } recordOrderCreateStage("financialSnapshotRead");
    runtimeMetrics.recordOperation("orderWorkflow", `orders.create.financialDelta.${orderCreateFinancialDeltaFastPath.reason || "unknown"}`, 0);
    runtimeMetrics.incrementCounter(orderCreateFinancialDeltaFastPath.applied ? "orderCreateFinancialDeltaFastPathHits" : "orderCreateFinancialDeltaFastPathFallbacks");
    const financialSync = orderCreateFinancialDeltaFastPath.applied ? orderCreateFinancialDeltaFastPath.financialSync : syncPosTableFinancialsFromIntegrationOrders(
      orderCreateFinancialSyncSource.state,
      orderCreateFinancialTargetTableIds.length ? orderCreateFinancialTargetTableIds : null,
    ); recordOrderCreateStage("financialSync");
    if (financialSync.changed === true && orderCreateFinancialTableGuard?.tokens?.length > 0) {
      const tableRevisionPlan = applyOrderFinancialTableRevisionTokens({
        settings: financialSync.settings,
        tableIds: financialSync.tableIds ?? (nextOrder.tableId ? [nextOrder.tableId] : []),
        tokens: orderCreateFinancialTableGuard.tokens,
      });
      if (tableRevisionPlan.changed === true) {
        financialSync.settings = tableRevisionPlan.settings;
        db.posSettings = financialSync.settings;
      }
    }
    if (orderCreateFinancialSyncSource.state !== db && financialSync.changed === true) {
      db.posSettings = financialSync.settings;
    }
    if (shouldReleaseTransientOrderCreateLock && tableId) {
      if (removedOperationalOrderContext) {
        releaseRemovedOperationalTableWorkLock(
          db,
          removedOperationalOrderContext,
          { user, session, payload },
        );
      } else {
        releaseTableWorkLock(db, tableId, { user, session, payload });
      }
    }
    await persistRelationalOrderFinancialTables({
      appState: db,
      enabled: RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY && financialSync.changed === true,
      tableIds: financialSync.tableIds ?? (financialSync.changed ? [nextOrder.tableId] : []),
    }); recordOrderCreateStage("financialTableWrite");
    db.integration.lastWriteAt = nowIso();
    pruneIntegrationState(db.integration);
    db.meta.lastWriteAt = nowIso();
    const auditEventIds = collectAuditEventIdsSince(db, auditStartIndex);
    await writeIntegrationOrderSyncDb(db, { orderIds: [nextOrder.id], syncPosSettings: financialSync.changed === true, syncSequence: true, posSettingsTableIds: financialSync.tableIds ?? (financialSync.changed ? [nextOrder.tableId] : []), auditEventIds, extraSplitDomains: removedOperationalOrderContext ? ["tableLocks"] : [], metricLabel: "orders.create.appStateWrite", defer: ORDERS_CREATE_ASYNC_ACK }); recordOrderCreateStage("appStateWrite");
    await appendRelationalOrderEvents({
      enabled:
        RELATIONAL_ORDER_EVENTS_WRITE_PRIMARY &&
        !RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY,
      events: orderRelationalEvents,
      logger: console,
      order: nextOrder,
      relationalRuntime, runtimeMetrics,
    });
    const orderCreatedRealtimeLean = process.env.BACKEND_ORDERS_CREATE_REALTIME_LEAN_PAYLOAD !== "0" && RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY && REALTIME_BACKBONE_CONFIG.eventOutboxEnabled;
    const orderCreateOutboxStartedAt = Date.now();
    publishIntegrationNotificationStreamRefresh("order_created", orderCreatedRealtimeLean ? { orderId: nextOrder.id, tableId: nextOrder.tableId, tableNumber: nextOrder.tableNumber, roomId: nextOrder.roomId, station: nextOrder.station, ownerStation: nextOrder.ownerStation, revision: nextOrder.currentRevision ?? nextOrder.revision ?? null, total: nextOrder.total ?? null, itemCount: Array.isArray(nextOrder.items) ? nextOrder.items.length : 0, payloadMode: "lean" } : { orderId: nextOrder.id, tableId: nextOrder.tableId, tableNumber: nextOrder.tableNumber, roomId: nextOrder.roomId, station: nextOrder.station, ownerStation: nextOrder.ownerStation, order: nextOrder, table: findIntegrationLayoutTableSnapshot(db, nextOrder.tableId) }, { requireOutbox: RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY && REALTIME_BACKBONE_CONFIG.eventOutboxEnabled, enqueueOnly: process.env.BACKEND_ORDERS_CREATE_REALTIME_ENQUEUE_ONLY !== "0" && RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY && REALTIME_BACKBONE_CONFIG.eventOutboxEnabled });
    runtimeMetrics.recordOperation("orderCreateInternal", "outboxPublish", Date.now() - orderCreateOutboxStartedAt); recordOrderCreateStage("realtimePublish");
    const autoPrintCreateSettings = PRINT_SPOOL_SQL_PRIMARY
      ? sanitizePosSettings(db.posSettings, { menuItems: db.menuItems, users: db.users })
      : null;
    const autoPrintCreatePayloads = autoPrintCreateSettings
      ? buildAutoPrintPayloadsForOrder(
          db,
          applyIntegrationOrderCompsToPrintableOrder(nextOrder, db),
          stationStates,
          { settings: autoPrintCreateSettings },
        )
      : null;
    const autoPrintCreateOrderId = nextOrder.id;
    Promise.resolve()
      .then(async () => {
        if (AUTO_PRINT_ENQUEUE_DELAY_MS > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, AUTO_PRINT_ENQUEUE_DELAY_MS),
          );
        }
        if (autoPrintCreatePayloads) {
          await scheduleOrderCreateAutoPrint({
            orderId: autoPrintCreateOrderId,
            payloads: autoPrintCreatePayloads,
            db,
            settings: autoPrintCreateSettings,
          });
          return;
        }
        await withPrintLaneMutation(
          `async auto-print ${nextOrder.id}`,
          [`order:${nextOrder.id}`], async () => {
            const latestDb = await readDb();
            const latestOrder =
              (Array.isArray(latestDb.integration?.orders)
                ? latestDb.integration.orders
                : []
              ).find(
                (entry) => String(entry?.id ?? "").trim() === nextOrder.id,
              ) ?? nextOrder;
            const printableOrder = applyIntegrationOrderCompsToPrintableOrder(
              latestOrder,
              latestDb,
            );
            const printPayloads = buildAutoPrintPayloadsForOrder(
              latestDb,
              printableOrder,
              stationStates,
            );
            await enqueuePrintSpoolJobsOnDb(latestDb, printPayloads);
          },
          { metricLabel: "async auto-print", shouldPreserveHotCaches: () => true },
        );
      })
      .catch((error) => {
        console.error("[integration:auto-print:async]", nextOrder.id, error);
      });
  
    sendOrderCreateResponse(200, {
      ok: true,
      order: nextOrder,
      autoPrintQueued: PRINTING_ENABLED,
      ...(pausedStationWarning ? { pausedStationWarning } : {}),
    });
  }
  

  return {
    handleIntegrationOrderTransferResolve,
    handleIntegrationOrderTransferForce,
    handleIntegrationOrderCreate,
  };
}
