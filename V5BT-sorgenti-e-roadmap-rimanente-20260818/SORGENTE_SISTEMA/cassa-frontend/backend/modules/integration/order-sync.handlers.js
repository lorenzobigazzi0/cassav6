/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createIntegrationOrderSyncHandlers({
  buildIntegrationOrderLineSnapshots,
  ORDERS_SYNC_ASYNC_ACK,
  buildIntegrationOrderLocationLabel,
  ORDERS_SYNC_QUEUE_RECONCILE_FAST_SKIP,
  assertIntegrationWorkflowTransitionAllowed,
  isIntegrationWorkflowRegression,
  RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY,
  RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY,
  RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY,
  HttpError,
  INTEGRATION_MAX_ORDER_FULFILLMENT_HISTORY,
  INTEGRATION_MAX_PREPARING_ORDERS_PER_LANE,
  INTEGRATION_PREPARATION_DEMOTION_REASONS,
  INTEGRATION_PREPARATION_SELECTION_REASONS,
  ORDERS_SYNC_WORKFLOW_LIGHT_SNAPSHOT,
  ORDER_READY_TARGET_TIMEOUT_MS,
  addOrderSyncFinancialNoopTableSnapshot,
  appendAuditEvent,
  appendIntegrationOrderFulfillmentHistoryEvent,
  appendIntegrationRouteAuditEvents,
  applyIntegrationOrderBackendLock,
  applyIntegrationWorkflowRouteTransitions,
  applyOrderFinancialTableRevisionTokens,
  assertActiveTableWorkLock,
  assertIntegrationDeliveryAllowed,
  buildAuditActor,
  buildIntegrationItemProgressAuditSnapshot,
  buildIntegrationOrderLookupIndex,
  buildIntegrationOrderSyncPreparationPlan,
  buildIntegrationOrderWorkflowApplyPlan,
  buildIntegrationOrderWorkflowSnapshotSource,
  buildOrderFinancialSyncState,
  buildOrderLinePriceOverrideRelationalEvents,
  buildOrderSyncFinancialNoopFastPath,
  captureRelationalOrderFinancialTableGuard,
  clampInt,
  collectAuditEventIdsSince,
  createDefaultIntegrationState,
  findIntegrationLayoutTableFromSettings,
  findIntegrationLayoutTableSnapshot,
  findIntegrationOrderIndexByLookup,
  findPosRoomById,
  findRelationalOrderById,
  hasIntegrationItemProgressAuditChange,
  integrationOrderQueueLaneKey,
  integrationOrderQueueStation,
  isIntegrationOrderCancelled,
  isTerminalDuplicateOrderSyncNoop,
  listRelationalOrderWorkflowSnapshot,
  markIntegrationOrderDeliveredForWorkflow,
  markIntegrationOrderItemsReady,
  mergeIntegrationOrderWorkflowScopedOrders,
  mergeIntegrationSyncItems,
  mergeOrderEvents,
  nextIntegrationOrderLineId,
  normalizeClientApp,
  normalizeIntegrationOrderWriteIds,
  normalizeIntegrationStationName,
  normalizeIntegrationWorkflowStatus,
  normalizeStringList,
  normalizeUsername,
  nowIso,
  orderLaneMetricLabeler,
  persistRelationalOrderFinancialTables,
  publishIntegrationNotificationStreamRefresh,
  queueBellNotification,
  readDb,
  readJsonBody,
  reconcileIntegrationPreparationQueue,
  relationalRuntime,
  resolveIntegrationLogicalTableLabel,
  resolveIntegrationOrderWorkflowTarget,
  resolveIntegrationReadyAtMs,
  resolveOrderFinancialSnapshotTableIds,
  roundMoney,
  runtimeMetrics,
  sanitizeIntegrationLineRoute,
  sanitizeIntegrationOrder,
  sanitizeIntegrationTableLabel,
  sanitizePosSettings,
  sendJson,
  shouldAutoDeliverReadyIntegrationOrder,
  syncPosTableFinancialsFromIntegrationOrders,
  syncRelationalOrderPrimary,
  validateSessionContext,
  writeIntegrationOrderSyncDb,
}) {
  async function handleIntegrationOrderSync(req, res) {
    const payload = await readJsonBody(req);
    const id = typeof payload.id === "string" ? payload.id.trim() : "";
    const rawOrder =
      payload.order && typeof payload.order === "object" ? payload.order : null;
    if (!id) {
      throw new HttpError(400, "ID comanda non valido.");
    }
    if (!rawOrder) {
      throw new HttpError(400, "Payload ordine non valido.");
    }
    let orderSyncStageAt = Date.now(); const recordOrderSyncStage = (label) => { const now = Date.now(); runtimeMetrics.recordOperation("orderSyncInternal", label, now - orderSyncStageAt); orderSyncStageAt = now; };
    const db = await readDb({
      ...(req.__orderWorkflowFastLane === true ? { preferCache: true } : {}),
      refreshExternalizedSessions: !req.__authContext,
    }); recordOrderSyncStage("readDbBootstrap");
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    const authContext =
      req.__authContext && typeof req.__authContext === "object"
        ? req.__authContext
        : validateSessionContext(db, payload);
    const { user, session } = authContext;
    const workflowSyncReason = String(
      payload.workflowReason ??
        payload.reason ??
        req.headers["x-workflow-pin-reason"] ??
        "",
    ).trim();
    const allowPreparationDemotion =
      INTEGRATION_PREPARATION_DEMOTION_REASONS.has(workflowSyncReason);
  
    const dbCacheOrderWorkflowSnapshot = buildIntegrationOrderWorkflowSnapshotSource(db, {
      sourceKind: "dbcache",
    });
    const relationalOrderWorkflowStationIds = normalizeStringList([rawOrder.assignedStationId, rawOrder.ownerStation, rawOrder.stationId, rawOrder.station, normalizeIntegrationStationName(rawOrder.assignedStationId), normalizeIntegrationStationName(rawOrder.ownerStation), normalizeIntegrationStationName(rawOrder.stationId), normalizeIntegrationStationName(rawOrder.station)], 12, 80);
    recordOrderSyncStage("authWorkflowSetup");
    const relationalOrderWorkflowSnapshot = buildIntegrationOrderWorkflowSnapshotSource(await listRelationalOrderWorkflowSnapshot({ enabled: RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY, relationalRuntime, runtimeMetrics, workflowLight: ORDERS_SYNC_WORKFLOW_LIGHT_SNAPSHOT && !INTEGRATION_PREPARATION_SELECTION_REASONS.has(workflowSyncReason), ...(relationalOrderWorkflowStationIds.length > 0 ? { orderId: id, stationIds: relationalOrderWorkflowStationIds, workflowStatuses: process.env.BACKEND_ORDERS_SYNC_WORKFLOW_STATION_STATUS_FILTER === "0" ? [] : ["waiting", "prep"] } : {}) })); recordOrderSyncStage("relationalSnapshotRead");
    const relationalOrderWorkflowTarget = resolveIntegrationOrderWorkflowTarget(
      relationalOrderWorkflowSnapshot,
      id,
      {
        findIntegrationOrderIndexByLookup,
        sanitizeIntegrationOrder,
      },
    );
    const orderWorkflowSnapshot = relationalOrderWorkflowTarget.found
      ? relationalOrderWorkflowSnapshot
      : dbCacheOrderWorkflowSnapshot;
    const orderWorkflowTarget = relationalOrderWorkflowTarget.found
      ? relationalOrderWorkflowTarget
      : resolveIntegrationOrderWorkflowTarget(dbCacheOrderWorkflowSnapshot, id, {
          findIntegrationOrderIndexByLookup,
          sanitizeIntegrationOrder,
        });
    if (!orderWorkflowTarget.found) {
      throw new HttpError(404, "Comanda non trovata.");
    }
  
    const currentOrder = orderWorkflowTarget.order;
    if (isIntegrationOrderCancelled(currentOrder)) {
      throw new HttpError(
        409,
        "Comanda annullata: non puo essere inoltrata o segnata pronta.",
        {
          code: "ORDER_CANCELLED",
        },
      );
    }
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const rawTableLabel = sanitizeIntegrationTableLabel(
      rawOrder.tableLabel ?? rawOrder.logicalTableLabel,
    );
    const currentLogicalTableLabel =
      resolveIntegrationLogicalTableLabel(
        db.posSettings,
        db.integration,
        currentOrder.tableId,
        currentOrder.tableNumber,
      ) || "";
    const nextTableLabel =
      rawTableLabel || currentLogicalTableLabel || currentOrder.tableLabel;
    const requestedWorkflowStatus = normalizeIntegrationWorkflowStatus(
      rawOrder.workflowStatus,
      [],
      null,
      {
        lineRoutes: [],
        ownerStation: rawOrder.ownerStation,
      },
    );
    const isTerminalDuplicateSync = isTerminalDuplicateOrderSyncNoop(currentOrder, requestedWorkflowStatus, rawOrder);
    if (!RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY && isTerminalDuplicateSync) { runtimeMetrics.incrementCounter("orderTerminalDuplicateSyncNoops"); orderLaneMetricLabeler.rememberOrder(currentOrder); sendJson(res, 200, { ok: true, idempotent: true, noop: true, order: currentOrder, selectionHandoffDemotions: [] }); return; }
    const isRequestedPreparationSelectionHandoffDemotion =
      allowPreparationDemotion &&
      currentOrder.workflowStatus === "prep" &&
      requestedWorkflowStatus === "waiting";
    const handoffLineRoutes =
      isRequestedPreparationSelectionHandoffDemotion &&
      Array.isArray(currentOrder.lineRoutes)
        ? currentOrder.lineRoutes.map((route) => {
            if (!route || typeof route !== "object") return route;
            const nextRoute = { ...route };
            delete nextRoute.receivedAt;
            delete nextRoute.receivedByUserId;
            delete nextRoute.receivedByUsername;
            return nextRoute;
          })
        : null;
    const rawOrderForMerge = {
      ...rawOrder,
      items: mergeIntegrationSyncItems(currentOrder.items, rawOrder.items),
      lockedByStationId: currentOrder.lockedByStationId,
      lockedByUserId: currentOrder.lockedByUserId,
      lockedAt: currentOrder.lockedAt,
      preparationStartedAt: isRequestedPreparationSelectionHandoffDemotion
        ? null
        : currentOrder.preparationStartedAt,
      lockStatus: currentOrder.lockStatus,
      ...(handoffLineRoutes ? { lineRoutes: handoffLineRoutes } : {}),
    };
    let mergedOrder = sanitizeIntegrationOrder(
      {
        ...currentOrder,
        ...rawOrderForMerge,
        id: currentOrder.id,
        createdAt: currentOrder.createdAt,
        source: currentOrder.source,
        roomId: currentOrder.roomId,
        tableId: currentOrder.tableId,
        tableNumber: currentOrder.tableNumber,
        tableLabel: nextTableLabel,
        logicalTableLabel: nextTableLabel,
        createdByUserId: currentOrder.createdByUserId,
        createdByUsername: currentOrder.createdByUsername,
        title: currentOrder.title,
        total: currentOrder.total,
        paymentStatus: currentOrder.paymentStatus,
        paidAmount: currentOrder.paidAmount,
        dueAmount: currentOrder.dueAmount,
        paidArticleUnits: currentOrder.paidArticleUnits,
        orderNote: currentOrder.orderNote,
        orderComment: currentOrder.orderComment,
        updatedAt: nowIso(),
      },
      currentOrder.id,
    );
  
    if (currentOrder.workflowStatus === "delivered") {
      mergedOrder = sanitizeIntegrationOrder(
        {
          ...currentOrder,
          paymentStatus: currentOrder.paymentStatus,
          paidAmount: currentOrder.paidAmount,
          dueAmount: currentOrder.dueAmount,
          paidArticleUnits: currentOrder.paidArticleUnits,
          workflowStatus: "delivered",
          readyAtMs: resolveIntegrationReadyAtMs(currentOrder),
          completedAtMs: currentOrder.completedAtMs ?? Date.now(),
          items: markIntegrationOrderItemsReady(currentOrder.items),
          lineRoutes: currentOrder.lineRoutes,
          updatedAt: nowIso(),
        },
        currentOrder.id,
      );
    } else if (
      isIntegrationWorkflowRegression(
        currentOrder.workflowStatus,
        mergedOrder.workflowStatus,
      ) &&
      !(
        allowPreparationDemotion &&
        currentOrder.workflowStatus === "prep" &&
        mergedOrder.workflowStatus === "waiting"
      )
    ) {
      mergedOrder = sanitizeIntegrationOrder(
        {
          ...currentOrder,
          workflowStatus: currentOrder.workflowStatus,
          readyAtMs:
            currentOrder.workflowStatus === "ready"
              ? resolveIntegrationReadyAtMs(currentOrder)
              : currentOrder.readyAtMs,
          completedAtMs: currentOrder.completedAtMs ?? null,
          items:
            currentOrder.workflowStatus === "ready"
              ? markIntegrationOrderItemsReady(currentOrder.items)
              : currentOrder.items,
          lineRoutes: currentOrder.lineRoutes,
          updatedAt: nowIso(),
        },
        currentOrder.id,
      );
    }
    if (
      currentOrder.workflowStatus === "ready" &&
      mergedOrder.workflowStatus !== "ready" &&
      mergedOrder.workflowStatus !== "delivered"
    ) {
      mergedOrder = sanitizeIntegrationOrder(
        {
          ...currentOrder,
          workflowStatus: "ready",
          readyAtMs: resolveIntegrationReadyAtMs(currentOrder),
          completedAtMs: null,
          items: markIntegrationOrderItemsReady(currentOrder.items),
          updatedAt: nowIso(),
        },
        currentOrder.id,
      );
    }
    if (mergedOrder.workflowStatus === "ready") {
      mergedOrder = sanitizeIntegrationOrder(
        {
          ...mergedOrder,
          workflowStatus: "ready",
          readyAtMs: resolveIntegrationReadyAtMs(mergedOrder),
          completedAtMs: null,
          items: markIntegrationOrderItemsReady(mergedOrder.items),
        },
        currentOrder.id,
      );
    }
    if (shouldAutoDeliverReadyIntegrationOrder(mergedOrder, settings)) {
      mergedOrder = markIntegrationOrderDeliveredForWorkflow(
        mergedOrder,
        currentOrder.id,
      );
    }
    if (
      mergedOrder.workflowStatus === "delivered" &&
      currentOrder.workflowStatus !== "delivered"
    ) {
      assertIntegrationDeliveryAllowed(currentOrder, settings);
    }
    assertIntegrationWorkflowTransitionAllowed(
      currentOrder.workflowStatus,
      mergedOrder.workflowStatus,
      {
        allowPreparationDemotion,
      },
    );
    const routeTransition = applyIntegrationWorkflowRouteTransitions(
      mergedOrder,
      currentOrder.workflowStatus,
      {
        userId: user.id,
        username: user.username,
      },
    );
    mergedOrder = sanitizeIntegrationOrder(
      {
        ...mergedOrder,
        lineRoutes: routeTransition.lineRoutes,
        updatedAt: nowIso(),
      },
      currentOrder.id,
    );
    const authenticatedSyncPayload = {
      ...payload,
      userId: user.id,
      username: user.username,
      deviceUuid: session.deviceUuid,
      sessionId: session.id,
    };
    mergedOrder = applyIntegrationOrderBackendLock(
      currentOrder,
      mergedOrder,
      authenticatedSyncPayload,
      rawOrder,
    ); recordOrderSyncStage("mergeSanitizeLock");
    const syncPreparationPlan = buildIntegrationOrderSyncPreparationPlan(
      orderWorkflowSnapshot,
      currentOrder,
      mergedOrder,
      {
        workflowSyncReason,
        selectionReasons: INTEGRATION_PREPARATION_SELECTION_REASONS,
        maxPreparingOrdersPerLane: INTEGRATION_MAX_PREPARING_ORDERS_PER_LANE,
        excludeOrderId: currentOrder.id,
      },
      {
        integrationOrderQueueLaneKey,
        normalizeIntegrationWorkflowStatus,
        nowIso,
        sanitizeIntegrationOrder,
      },
    );
    const selectionHandoffDemotions = syncPreparationPlan.selectionHandoffDemotions; recordOrderSyncStage("preparationPlan");
    if (syncPreparationPlan.preparationQueueFull) {
      throw new HttpError(
        409,
        "Massimo 3 comande in preparazione su questa postazione.",
        {
          code: "PREPARATION_QUEUE_FULL",
          maxPreparingOrders: INTEGRATION_MAX_PREPARING_ORDERS_PER_LANE,
          station: integrationOrderQueueStation(mergedOrder),
        },
      );
    }
    const isPreparationSelectionHandoffDemotion =
      allowPreparationDemotion &&
      currentOrder.workflowStatus === "prep" &&
      mergedOrder.workflowStatus === "waiting";
    const itemProgressChanged = hasIntegrationItemProgressAuditChange(currentOrder, mergedOrder);
    const previousItemProgress = itemProgressChanged ? buildIntegrationItemProgressAuditSnapshot(currentOrder) : [];
    const nextItemProgress = itemProgressChanged ? buildIntegrationItemProgressAuditSnapshot(mergedOrder) : [];
    const becameReady =
      (mergedOrder.workflowStatus === "ready" ||
        mergedOrder.workflowStatus === "delivered") &&
      currentOrder.workflowStatus !== "ready" &&
      currentOrder.workflowStatus !== "delivered";
    const requestedSyncRevision = clampInt(rawOrder.revision ?? rawOrder.currentRevision, 0, 1_000_000, 0);
    const syncPreviousRevision = RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY && requestedSyncRevision > 0 ? requestedSyncRevision : clampInt(currentOrder.revision ?? currentOrder.currentRevision, 1, 1_000_000, 1);
    mergedOrder = sanitizeIntegrationOrder({ ...mergedOrder, revision: syncPreviousRevision + 1, currentRevision: syncPreviousRevision + 1 }, currentOrder.id); recordOrderSyncStage("revisionApply");
  
    const orderWorkflowApplyPlan = buildIntegrationOrderWorkflowApplyPlan(
      {
        ...orderWorkflowSnapshot,
        orders: syncPreparationPlan.orders,
      },
      orderWorkflowTarget,
      mergedOrder,
      {
        findIntegrationOrderIndexByLookup,
        sanitizeIntegrationOrder,
      },
    ); recordOrderSyncStage("workflowApplyPlan");
    if (!orderWorkflowApplyPlan.found) throw new HttpError(404, "Comanda non trovata.");
    mergedOrder = orderWorkflowApplyPlan.order;
    const orderWorkflowScopedMergeIds = new Set([mergedOrder.id, ...selectionHandoffDemotions.map((entry) => entry?.orderId)].map((entry) => String(entry ?? "").trim()).filter(Boolean)), orderWorkflowScopedMergeFilteredOrders = orderWorkflowSnapshot.scoped === true ? orderWorkflowApplyPlan.orders.filter((entry) => orderWorkflowScopedMergeIds.has(String(entry?.id ?? "").trim())) : orderWorkflowApplyPlan.orders, orderWorkflowScopedMergeOrders = orderWorkflowSnapshot.scoped === true && orderWorkflowScopedMergeFilteredOrders.length === 0 ? [mergedOrder] : orderWorkflowScopedMergeFilteredOrders;
    db.integration.orders = orderWorkflowSnapshot.scoped === true ? mergeIntegrationOrderWorkflowScopedOrders(db.integration.orders, orderWorkflowScopedMergeOrders, { buildIntegrationOrderLookupIndex, findIntegrationOrderIndexByLookup, fastScopedMerge: true, scopedMergeTailSize: 128 }) : orderWorkflowApplyPlan.orders; recordOrderSyncStage("workflowScopedMerge");
    orderLaneMetricLabeler.rememberOrder(mergedOrder); recordOrderSyncStage("orderLabeler");
    let queuePromotions = [];
    const orderSyncQueueReconcileFastSkip = ORDERS_SYNC_QUEUE_RECONCILE_FAST_SKIP && selectionHandoffDemotions.length === 0 && ((syncPreparationPlan.fastNoop === true && syncPreparationPlan.currentWorkflow !== "waiting") || syncPreparationPlan.entersPreparation === true);
    if (orderSyncQueueReconcileFastSkip) runtimeMetrics.incrementCounter("orderSyncQueueReconcileFastSkips"); else if (
      !isPreparationSelectionHandoffDemotion ||
      workflowSyncReason === "selected_order_deselect_empty"
    ) {
      queuePromotions = reconcileIntegrationPreparationQueue(db, {
        source: "order_sync",
        userId: user.id,
        username: user.username,
      });
    } recordOrderSyncStage("queueReconcile"); recordOrderSyncStage("applyPlanQueue");
    const auditActor = buildAuditActor(user, {
      ...authenticatedSyncPayload,
      roomId: mergedOrder.roomId,
    });
    const auditStartIndex = Array.isArray(db.auditEvents) ? db.auditEvents.length : 0;
    if (mergedOrder.workflowStatus !== currentOrder.workflowStatus) {
      appendAuditEvent(db, {
        ...auditActor,
        action: "order.status_changed",
        entityType: "integration_order",
        entityId: mergedOrder.id,
        roomId: mergedOrder.roomId || auditActor.roomId,
        payload: {
          orderId: mergedOrder.id,
          previousStatus: currentOrder.workflowStatus,
          nextStatus: mergedOrder.workflowStatus,
        },
        before: {
          workflowStatus: currentOrder.workflowStatus,
        },
        after: {
          workflowStatus: mergedOrder.workflowStatus,
        },
      });
    }
    if (itemProgressChanged) {
      appendAuditEvent(db, {
        ...auditActor,
        action: "order.item_progress_changed",
        entityType: "integration_order",
        entityId: mergedOrder.id,
        roomId: mergedOrder.roomId || auditActor.roomId,
        payload: {
          orderId: mergedOrder.id,
          reason: workflowSyncReason || "sync",
        },
        before: {
          items: previousItemProgress,
        },
        after: {
          items: nextItemProgress,
        },
      });
    }
    selectionHandoffDemotions.forEach((demotion) => {
      appendAuditEvent(db, {
        ...auditActor,
        action: "order.selection_handoff_demoted",
        entityType: "integration_order",
        entityId: demotion.orderId,
        roomId: demotion.next?.roomId || auditActor.roomId,
        payload: {
          selectedOrderId: mergedOrder.id,
          demotedOrderId: demotion.orderId,
          previousStatus: demotion.previous?.workflowStatus,
          nextStatus: demotion.next?.workflowStatus,
          lane: demotion.lane,
          reason: workflowSyncReason,
        },
        before: {
          workflowStatus: demotion.previous?.workflowStatus,
          lockStatus: demotion.previous?.lockStatus,
        },
        after: {
          workflowStatus: demotion.next?.workflowStatus,
          lockStatus: demotion.next?.lockStatus,
        },
      });
    });
    appendIntegrationRouteAuditEvents(
      db,
      auditActor,
      mergedOrder,
      routeTransition.routeEvents,
    );
  
    let queuedReadyBell = null;
    if (becameReady) {
      const room =
        mergedOrder.roomId && db.posSettings
          ? findPosRoomById(db.posSettings, mergedOrder.roomId)
          : null;
      const tableLabel =
        buildIntegrationOrderLocationLabel(
          mergedOrder,
          db.posSettings,
          room?.name ?? "",
        ) || (mergedOrder.tableId ? `Tavolo ${mergedOrder.tableId}` : "Banco");
      const createdByUserId = String(mergedOrder.createdByUserId ?? "").trim();
      const createdByUsername = String(
        mergedOrder.createdByUsername ?? "",
      ).trim();
      const createdByUser = Array.isArray(db.users)
        ? (db.users.find((entry) => {
            if (!entry || typeof entry !== "object") return false;
            const entryId = String(entry.id ?? "").trim();
            if (createdByUserId && entryId === createdByUserId) return true;
            if (!createdByUsername) return false;
            return (
              normalizeUsername(entry.username) ===
              normalizeUsername(createdByUsername)
            );
          }) ?? null)
        : null;
      const createdByFullName = String(createdByUser?.fullName ?? "").trim();
      queuedReadyBell = queueBellNotification(db, {
        title: "Comanda pronta",
        description: `#${mergedOrder.id} pronta - ${tableLabel} - ${mergedOrder.station}`,
        meta: {
          eventType: "order_ready",
          orderId: mergedOrder.id,
          station: normalizeIntegrationStationName(mergedOrder.station),
          targetUserId: createdByUserId,
          targetUsername: createdByUsername,
          targetFullName: createdByFullName,
          roomId: String(mergedOrder.roomId ?? "").trim(),
          roomName: room?.name ?? "",
          waiter: String(
            mergedOrder.waiter ??
              mergedOrder.ownerOperator ??
              mergedOrder.createdByUsername ??
              "Cameriere",
          ).trim(),
          orderSource:
            normalizeClientApp(String(mergedOrder.source ?? "").trim()) ||
            "postazione",
          targetClientApp: "mobile-frontend",
          bellEscalateAtMs: Date.now() + ORDER_READY_TARGET_TIMEOUT_MS,
        },
      });
    }
  
    const becameFulfilledForHistory =
      (mergedOrder.workflowStatus === "ready" ||
        mergedOrder.workflowStatus === "delivered") &&
      currentOrder.workflowStatus !== "ready" &&
      currentOrder.workflowStatus !== "delivered";
    const fulfillmentHistoryLengthBefore = Array.isArray(db.integration?.orderFulfillmentHistory)
      ? db.integration.orderFulfillmentHistory.length
      : 0;
    const fulfillmentHistoryEvent = becameFulfilledForHistory
      ? appendIntegrationOrderFulfillmentHistoryEvent(
          db,
          currentOrder,
          mergedOrder,
          authenticatedSyncPayload,
        )
      : null;
    if (fulfillmentHistoryEvent) {
      appendAuditEvent(db, {
        ...auditActor,
        action: "order.fulfillment_recorded",
        entityType: "integration_order",
        entityId: mergedOrder.id,
        roomId: mergedOrder.roomId || auditActor.roomId,
        payload: {
          orderId: mergedOrder.id,
          stationId: fulfillmentHistoryEvent.stationId,
          operatorUserId: fulfillmentHistoryEvent.operatorUserId,
          secondsPerItem: fulfillmentHistoryEvent.secondsPerItem,
          isTimingAnomaly: fulfillmentHistoryEvent.isTimingAnomaly,
          includedInOperationalAverage:
            fulfillmentHistoryEvent.includedInOperationalAverage,
        },
      });
    }
    recordOrderSyncStage("workflowApplyAudit");
  
    db.integration.lastWriteAt = nowIso();
    db.meta.lastWriteAt = nowIso();
    const relationalSyncResult = await syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY, metricScope: "sync", order: mergedOrder, previousRevision: syncPreviousRevision, relationalRuntime, runtimeMetrics });
    if (RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY && !relationalSyncResult) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision: syncPreviousRevision + 1 } });
    recordOrderSyncStage("relationalWrite");
    const orderSyncFinancialTargetTableIds = mergedOrder.tableId ? [mergedOrder.tableId] : [];
    const orderSyncFinancialNoop = buildOrderSyncFinancialNoopFastPath({ enabled: process.env.BACKEND_ORDERS_SYNC_FINANCIAL_NOOP_FASTPATH !== "0", currentOrder, mergedOrder, settings, queuePromotions, selectionHandoffDemotions });
    let financialSync = orderSyncFinancialNoop.financialSync;
    if (orderSyncFinancialNoop.skipped) runtimeMetrics.recordOperation("orderWorkflow", "orders.sync.financialNoopFastPath", 0);
    else { const orderSyncFinancialSyncSnapshot = await listRelationalOrderWorkflowSnapshot({ enabled: RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY, logger: console, metricLabel: "orders.sync.relationalFinancialSnapshotRead", relationalRuntime, runtimeMetrics, tableIds: resolveOrderFinancialSnapshotTableIds(db, orderSyncFinancialTargetTableIds) }); const orderSyncFinancialSyncSource = buildOrderFinancialSyncState({ baseState: db, orderSnapshot: orderSyncFinancialSyncSnapshot }); const orderSyncFinancialTableGuard = await captureRelationalOrderFinancialTableGuard({ enabled: RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY, tableIds: orderSyncFinancialTargetTableIds }); financialSync = syncPosTableFinancialsFromIntegrationOrders(orderSyncFinancialSyncSource.state, orderSyncFinancialTargetTableIds.length ? orderSyncFinancialTargetTableIds : null); if (financialSync.changed === true && orderSyncFinancialTableGuard?.tokens?.length > 0) { const tableRevisionPlan = applyOrderFinancialTableRevisionTokens({ settings: financialSync.settings, tableIds: financialSync.tableIds ?? orderSyncFinancialTargetTableIds, tokens: orderSyncFinancialTableGuard.tokens }); if (tableRevisionPlan.changed === true) { financialSync.settings = tableRevisionPlan.settings; db.posSettings = financialSync.settings; } } if (orderSyncFinancialSyncSource.state !== db && financialSync.changed === true) db.posSettings = financialSync.settings; await persistRelationalOrderFinancialTables({ appState: db, enabled: RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY && financialSync.changed === true, tableIds: financialSync.tableIds ?? (financialSync.changed ? orderSyncFinancialTargetTableIds : []) }); }
    if (orderSyncFinancialNoop.skipped && process.env.BACKEND_ORDERS_SYNC_NOOP_TABLE_SNAPSHOT !== "0") addOrderSyncFinancialNoopTableSnapshot(financialSync, mergedOrder.tableId, findIntegrationLayoutTableFromSettings(settings, mergedOrder.tableId));
    runtimeMetrics.incrementCounter(financialSync.changed ? "orderSyncTableStateChanged" : "orderSyncTableStateNoops");
    recordOrderSyncStage("financialSync");
    const realtimeTableSnapshot = financialSync.tableSnapshotsById?.get(String(mergedOrder.tableId ?? "").trim()) ?? findIntegrationLayoutTableSnapshot(db, mergedOrder.tableId); recordOrderSyncStage("realtimeTableSnapshot");
    if (queuedReadyBell) {
      publishIntegrationNotificationStreamRefresh("order_ready", {
        orderId: mergedOrder.id,
        station: normalizeIntegrationStationName(mergedOrder.station),
        roomId: String(mergedOrder.roomId ?? "").trim(),
        notificationId: queuedReadyBell.notification?.id ?? "",
        notification: queuedReadyBell.notification ?? null,
        deduped: queuedReadyBell.deduped === true,
        order: mergedOrder,
        table: realtimeTableSnapshot,
      });
    } recordOrderSyncStage("readyNotificationPublish");
    const orderSyncAuditEventIds = collectAuditEventIdsSince(db, auditStartIndex); recordOrderSyncStage("auditEventIdsCollect"); await writeIntegrationOrderSyncDb(db, {
      orderIds: normalizeIntegrationOrderWriteIds(
        mergedOrder.id,
        queuePromotions,
        selectionHandoffDemotions,
      ),
      syncNotifications: Boolean(queuedReadyBell && queuedReadyBell.deduped !== true),
      notificationIds: queuedReadyBell && queuedReadyBell.deduped !== true ? [queuedReadyBell.notification?.id] : [],
      syncFulfillmentHistory: Boolean(fulfillmentHistoryEvent),
      fulfillmentHistoryIds: fulfillmentHistoryEvent ? [fulfillmentHistoryEvent.id] : [],
      fulfillmentHistoryFullSync: Boolean(fulfillmentHistoryEvent && fulfillmentHistoryLengthBefore >= INTEGRATION_MAX_ORDER_FULFILLMENT_HISTORY),
      extraSplitDomains: financialSync.changed ? ["posSettings"] : [],
      posSettingsTableIds: financialSync.tableIds ?? (financialSync.changed ? [mergedOrder.tableId] : []),
      auditEventIds: orderSyncAuditEventIds,
      defer: ORDERS_SYNC_ASYNC_ACK,
    });
    recordOrderSyncStage("appStateWrite");
    publishIntegrationNotificationStreamRefresh("order_state_changed", {
      orderId: mergedOrder.id,
      previousStatus: currentOrder.workflowStatus,
      nextStatus: mergedOrder.workflowStatus,
      station: normalizeIntegrationStationName(mergedOrder.station),
      roomId: String(mergedOrder.roomId ?? "").trim(),
      order: mergedOrder,
      table: realtimeTableSnapshot,
      queuePromotions,
      selectionHandoffDemotions: selectionHandoffDemotions.map((entry) => ({
        orderId: entry.orderId,
        previousStatus: entry.previous?.workflowStatus,
        nextStatus: entry.next?.workflowStatus,
      })),
    });
    recordOrderSyncStage("realtimeResponse");
  
    sendJson(res, 200, {
      ok: true,
      order: mergedOrder,
      selectionHandoffDemotions: selectionHandoffDemotions.map((entry) => ({
        orderId: entry.orderId,
        previousStatus: entry.previous?.workflowStatus,
        nextStatus: entry.next?.workflowStatus,
      })),
    });
  }
  
  async function handleIntegrationOrderLineSplit(req, res) {
    const payload = await readJsonBody(req);
    const orderId = String(payload.orderId ?? payload.id ?? "").trim();
    const lineId = String(payload.lineId ?? "").trim();
    const splitQty = clampInt(payload.qty, 1, 10_000, 1);
    const markDelivered = payload.markDelivered === true;
    const requestedLineSplitRevision = clampInt(payload.expectedRevision ?? payload.currentRevision ?? payload.revision, 0, 1_000_000, 0);
    if (!orderId || !lineId) {
      throw new HttpError(400, "orderId e lineId sono obbligatori.");
    }
  
    const relationalLineSplitCurrentOrder = await findRelationalOrderById({ enabled: RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY, orderId, relationalRuntime, runtimeMetrics });
    const db = await readDb({
      refreshExternalizedSessions: true,
      refreshExternalizedTableLocks: true,
    });
    const authContext =
      req.__authContext && typeof req.__authContext === "object"
        ? req.__authContext
        : validateSessionContext(db, payload);
    const { user } = authContext;
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    const orderIndex = findIntegrationOrderIndexByLookup(
      db.integration.orders,
      orderId,
    );
    if (orderIndex < 0 && !relationalLineSplitCurrentOrder) {
      throw new HttpError(404, "Comanda non trovata.");
    }
  
    const currentOrderSource = relationalLineSplitCurrentOrder ?? db.integration.orders[orderIndex];
    const currentOrder = sanitizeIntegrationOrder(
      currentOrderSource,
      String(currentOrderSource?.id ?? orderId).trim() || orderId,
    );
    if (isIntegrationOrderCancelled(currentOrder)) {
      throw new HttpError(409, "Comanda annullata: operazione non consentita.", {
        code: "ORDER_CANCELLED",
      });
    }
    if (currentOrder.tableId) {
      assertActiveTableWorkLock(db, currentOrder.tableId, {
        user,
        session: null,
        payload: { ...payload, roomId: currentOrder.roomId },
        purpose: "order.line_split",
      });
    }
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    if (markDelivered) {
      assertIntegrationDeliveryAllowed(currentOrder, settings);
    }
    const candidateIndices = [];
    currentOrder.items.forEach((item, index) => {
      if (item.voidedAt) return;
      if (item.lineId !== lineId) return;
      candidateIndices.push(index);
    });
    if (candidateIndices.length < splitQty) {
      throw new HttpError(400, "Quantita split superiore al disponibile.");
    }
  
    const newLineId = nextIntegrationOrderLineId(currentOrder);
    const nextItems = currentOrder.items.map((item) => ({ ...item }));
    const selectedIndices = candidateIndices.slice(0, splitQty);
    selectedIndices.forEach((index) => {
      const item = nextItems[index];
      const nextItem = {
        ...item,
        lineId: newLineId,
      };
      if (markDelivered) {
        nextItem.done = true;
      }
      nextItems[index] = nextItem;
    });
  
    const actor = buildAuditActor(user, payload);
    const auditStartIndex = Array.isArray(db.auditEvents) ? db.auditEvents.length : 0;
    const now = nowIso();
    const existingRoutes = Array.isArray(currentOrder.lineRoutes)
      ? currentOrder.lineRoutes.map((entry) => ({ ...entry }))
      : [];
    const sourceRoutes = existingRoutes.filter(
      (route) => route.lineId === lineId,
    );
    const clonedRoutes = sourceRoutes
      .map((route, index) =>
        sanitizeIntegrationLineRoute(
          {
            ...route,
            id: `route_${currentOrder.id}_${existingRoutes.length + index + 1}`,
            lineId: newLineId,
            pickedUpAt: markDelivered ? now : route.pickedUpAt,
            pickedUpByUserId: markDelivered
              ? actor.actorUserId
              : route.pickedUpByUserId,
            pickedUpByUsername: markDelivered
              ? actor.username
              : route.pickedUpByUsername,
            deliveredAt: markDelivered ? now : route.deliveredAt,
            deliveredByUserId: markDelivered
              ? actor.actorUserId
              : route.deliveredByUserId,
            deliveredByUsername: markDelivered
              ? actor.username
              : route.deliveredByUsername,
          },
          `route_${currentOrder.id}_${existingRoutes.length + index + 1}`,
          currentOrder.id,
        ),
      )
      .filter((route) => route !== null);
    const nextLineRoutes = [...existingRoutes, ...clonedRoutes];
  
    const currentRevision = clampInt(currentOrder.revision ?? currentOrder.currentRevision, 1, 1_000_000, 1);
    if (RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY && requestedLineSplitRevision > 0 && currentRevision !== requestedLineSplitRevision) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision, expectedRevision: requestedLineSplitRevision } });
    const nextRevision = currentRevision + 1;
    const nextOrder = sanitizeIntegrationOrder(
      {
        ...currentOrder,
        items: nextItems,
        lineRoutes: nextLineRoutes,
        isPartial: true,
        revision: nextRevision,
        currentRevision: nextRevision,
        updatedAt: now,
      },
      currentOrder.id,
    );
  
    if (orderIndex >= 0) {
      db.integration.orders[orderIndex] = nextOrder;
    } else {
      db.integration.orders.push(nextOrder);
    }
    const beforeLines = buildIntegrationOrderLineSnapshots(currentOrder);
    const afterLines = buildIntegrationOrderLineSnapshots(nextOrder);
    appendAuditEvent(db, {
      ...actor,
      action: "order.line_split",
      entityType: "order_line",
      entityId: `${orderId}:${lineId}`,
      roomId: nextOrder.roomId || actor.roomId,
      payload: {
        orderId,
        lineId,
        newLineId,
        splitQty,
        markDelivered,
      },
      before: beforeLines.get(lineId) ?? null,
      after: {
        originalLine: afterLines.get(lineId) ?? null,
        newLine: afterLines.get(newLineId) ?? null,
      },
    });
    if (markDelivered) {
      clonedRoutes.forEach((route) => {
        appendAuditEvent(db, {
          ...actor,
          action: "order.route_picked_up",
          entityType: "line_route",
          entityId: route.id,
          roomId: nextOrder.roomId || actor.roomId,
          payload: {
            orderId,
            routeId: route.id,
            lineId: route.lineId,
            stationId: route.stationId,
            pickedUpAt: route.pickedUpAt,
          },
        });
        appendAuditEvent(db, {
          ...actor,
          action: "order.route_delivered",
          entityType: "line_route",
          entityId: route.id,
          roomId: nextOrder.roomId || actor.roomId,
          payload: {
            orderId,
            routeId: route.id,
            lineId: route.lineId,
            stationId: route.stationId,
            deliveredAt: route.deliveredAt,
          },
        });
      });
    }
    db.integration.lastWriteAt = nowIso();
    db.meta.lastWriteAt = nowIso();
    const relationalLineSplitResult = await syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY, order: nextOrder, previousRevision: requestedLineSplitRevision > 0 ? requestedLineSplitRevision : currentRevision, relationalRuntime, runtimeMetrics });
    if (RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY && !relationalLineSplitResult) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision: nextRevision } });
    await writeIntegrationOrderSyncDb(db, { orderIds: [nextOrder.id], auditEventIds: collectAuditEventIdsSince(db, auditStartIndex), metricLabel: "orders.lineSplit.appStateWrite" });
  
    sendJson(res, 200, {
      ok: true,
      order: nextOrder,
      lineId,
      newLineId,
    });
  }
  
  async function handleIntegrationOrderLinePriceOverride(req, res) {
    const payload = await readJsonBody(req);
    const orderId = String(payload.orderId ?? payload.id ?? "").trim();
    const lineId = String(payload.lineId ?? "").trim();
    const requestedPriceOverrideRevision = clampInt(payload.expectedRevision ?? payload.currentRevision ?? payload.revision, 0, 1_000_000, 0);
    const nextUnitPriceRaw = Number(
      payload.unitPriceApplied ?? payload.unit_price_applied,
    );
    const reason = String(payload.reason ?? "")
      .trim()
      .slice(0, 240);
  
    if (
      !orderId ||
      !lineId ||
      !Number.isFinite(nextUnitPriceRaw) ||
      nextUnitPriceRaw < 0
    ) {
      throw new HttpError(400, "Dati override prezzo non validi.");
    }
  
    const db = await readDb({
      refreshExternalizedSessions: true,
      refreshExternalizedTableLocks: true,
    });
    const authContext =
      req.__authContext && typeof req.__authContext === "object"
        ? req.__authContext
        : validateSessionContext(db, payload);
    const { user } = authContext;
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    db.integration.orders = Array.isArray(db.integration.orders) ? db.integration.orders : [];
    let orderIndex = findIntegrationOrderIndexByLookup(db.integration.orders, orderId);
    let currentOrder = orderIndex >= 0 ? sanitizeIntegrationOrder(db.integration.orders[orderIndex], String(db.integration.orders[orderIndex]?.id ?? orderId).trim() || orderId) : null;
    const relationalPriceOverrideCurrentOrder = await findRelationalOrderById({ enabled: RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY, orderId: currentOrder?.id ?? orderId, relationalRuntime, runtimeMetrics });
    if (relationalPriceOverrideCurrentOrder) {
      currentOrder = sanitizeIntegrationOrder(relationalPriceOverrideCurrentOrder, String(relationalPriceOverrideCurrentOrder.id ?? orderId).trim() || orderId);
      if (orderIndex < 0) { db.integration.orders.push(currentOrder); orderIndex = db.integration.orders.length - 1; } else db.integration.orders[orderIndex] = currentOrder;
    }
    if (!currentOrder || orderIndex < 0) throw new HttpError(404, "Comanda non trovata.");
  
    if (currentOrder.tableId) {
      assertActiveTableWorkLock(db, currentOrder.tableId, {
        user,
        session: null,
        payload: { ...payload, roomId: currentOrder.roomId },
        purpose: "order.price_override",
      });
    }
    if (currentOrder.paymentStatus === "paid" || currentOrder.dueAmount <= 0) {
      throw new HttpError(
        409,
        "Override prezzo non consentito: ordine gia saldato.",
      );
    }
  
    const nextUnitPriceApplied = roundMoney(Math.max(nextUnitPriceRaw, 0));
    const nextListPriceRaw = Number(
      payload.listPriceAtTime ?? payload.list_price_at_time,
    );
    const hasListPrice =
      Number.isFinite(nextListPriceRaw) && nextListPriceRaw >= 0;
    const nextListPriceAtTime = hasListPrice
      ? roundMoney(Math.max(nextListPriceRaw, 0))
      : null;
  
    let affectedQty = 0;
    let beforeUnitPriceApplied = null;
    const nextItems = currentOrder.items.map((item) => {
      if (item.lineId !== lineId || item.voidedAt) return { ...item };
      affectedQty += 1;
      if (beforeUnitPriceApplied === null) {
        beforeUnitPriceApplied = roundMoney(Number(item.unitPriceApplied) || 0);
      }
      return {
        ...item,
        unitPriceApplied: nextUnitPriceApplied,
        listPriceAtTime: nextListPriceAtTime ?? item.listPriceAtTime,
      };
    });
    if (affectedQty <= 0) {
      throw new HttpError(404, "Riga non trovata.");
    }
  
    const deltaPerUnit = roundMoney(
      nextUnitPriceApplied - (beforeUnitPriceApplied ?? 0),
    );
    const nextTotal = roundMoney(
      Math.max(currentOrder.total + deltaPerUnit * affectedQty, 0),
    );
    const nextPaidAmount = roundMoney(
      Math.min(currentOrder.paidAmount, nextTotal),
    );
    const nextDueAmount = roundMoney(Math.max(nextTotal - nextPaidAmount, 0));
    const nextPaymentStatus =
      nextDueAmount <= 0 ? "paid" : nextPaidAmount > 0 ? "partial" : "unpaid";
    const currentRevision = clampInt(currentOrder.revision ?? currentOrder.currentRevision, 1, 1_000_000, 1);
    if (RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY && requestedPriceOverrideRevision > 0 && currentRevision !== requestedPriceOverrideRevision) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision, expectedRevision: requestedPriceOverrideRevision } });
    const nextRevision = currentRevision + 1;
    const nextOrder = sanitizeIntegrationOrder(
      { ...currentOrder, items: nextItems, total: nextTotal, paidAmount: nextPaidAmount, dueAmount: nextDueAmount, paymentStatus: nextPaymentStatus, revision: nextRevision, currentRevision: nextRevision, updatedAt: nowIso(),
        events: mergeOrderEvents(currentOrder.events, buildOrderLinePriceOverrideRelationalEvents({ actorUserId: user?.id, lineId, occurredAt: nowIso(), order: currentOrder, previousUnitPrice: beforeUnitPriceApplied, reason, revision: nextRevision, unitPriceApplied: nextUnitPriceApplied })),
      },
      currentOrder.id,
    );
    const relationalPriceOverrideResult = await syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY, order: nextOrder, previousRevision: requestedPriceOverrideRevision > 0 ? requestedPriceOverrideRevision : currentRevision, relationalRuntime, runtimeMetrics });
    if (RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY && !relationalPriceOverrideResult) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision: nextRevision } });
    db.integration.orders[orderIndex] = nextOrder;
    const priceOverrideFinancialTargetTableIds = nextOrder.tableId ? [nextOrder.tableId] : [];
    const priceOverrideFinancialSyncSnapshot = await listRelationalOrderWorkflowSnapshot({ enabled: RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY, logger: console, metricLabel: "orders.priceOverride.relationalFinancialSnapshotRead", relationalRuntime, runtimeMetrics, tableIds: resolveOrderFinancialSnapshotTableIds(db, priceOverrideFinancialTargetTableIds) });
    const priceOverrideFinancialSyncSource = buildOrderFinancialSyncState({ baseState: db, orderSnapshot: priceOverrideFinancialSyncSnapshot });
    const priceOverrideFinancialTableGuard = await captureRelationalOrderFinancialTableGuard({ enabled: RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY, tableIds: priceOverrideFinancialTargetTableIds });
    const financialSync = syncPosTableFinancialsFromIntegrationOrders(priceOverrideFinancialSyncSource.state, priceOverrideFinancialTargetTableIds.length ? priceOverrideFinancialTargetTableIds : null);
    if (financialSync.changed === true && priceOverrideFinancialTableGuard?.tokens?.length > 0) { const priceOverrideTableRevisionPlan = applyOrderFinancialTableRevisionTokens({ settings: financialSync.settings, tableIds: financialSync.tableIds ?? [nextOrder.tableId], tokens: priceOverrideFinancialTableGuard.tokens }); if (priceOverrideTableRevisionPlan.changed === true) { financialSync.settings = priceOverrideTableRevisionPlan.settings; db.posSettings = financialSync.settings; } }
    if (priceOverrideFinancialSyncSource.state !== db && financialSync.changed === true) db.posSettings = financialSync.settings;
    await persistRelationalOrderFinancialTables({ appState: db, enabled: RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY && financialSync.changed === true, tableIds: financialSync.tableIds ?? (financialSync.changed ? [nextOrder.tableId] : []) });
    const beforeLines = buildIntegrationOrderLineSnapshots(currentOrder);
    const afterLines = buildIntegrationOrderLineSnapshots(nextOrder);
    const actor = buildAuditActor(user, payload);
    const auditStartIndex = Array.isArray(db.auditEvents) ? db.auditEvents.length : 0;
    appendAuditEvent(db, {
      ...actor,
      action: "order.line_price_overridden",
      entityType: "order_line",
      entityId: `${orderId}:${lineId}`,
      roomId: nextOrder.roomId || actor.roomId,
      payload: {
        orderId,
        lineId,
        reason,
        qty: affectedQty,
        previousUnitPriceApplied: beforeUnitPriceApplied,
        nextUnitPriceApplied,
        nextListPriceAtTime: nextListPriceAtTime ?? undefined,
      },
      before: beforeLines.get(lineId) ?? null,
      after: afterLines.get(lineId) ?? null,
    });
  
    db.integration.lastWriteAt = nowIso();
    db.meta.lastWriteAt = nowIso();
    await writeIntegrationOrderSyncDb(db, { orderIds: [nextOrder.id], syncPosSettings: financialSync.changed === true, posSettingsTableIds: financialSync.tableIds ?? (financialSync.changed ? [nextOrder.tableId] : []), auditEventIds: collectAuditEventIdsSince(db, auditStartIndex), metricLabel: "orders.priceOverride.appStateWrite" });
  
    sendJson(res, 200, {
      ok: true,
      order: nextOrder,
      lineId,
    });
  }
  

  return {
    handleIntegrationOrderSync,
    handleIntegrationOrderLineSplit,
    handleIntegrationOrderLinePriceOverride,
  };
}
