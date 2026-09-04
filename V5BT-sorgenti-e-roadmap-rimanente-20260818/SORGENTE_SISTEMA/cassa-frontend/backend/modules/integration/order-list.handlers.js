/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createIntegrationOrderListHandlers({
  isTableWorkLockExpired,
  sanitizeTableWorkLock,
  INTEGRATION_HOT_GET_FAST_CACHE_MS,
  INTEGRATION_STATION_DONE_HISTORY_LIMIT,
  RELATIONAL_ORDERS_HISTORY_READS,
  RELATIONAL_ORDERS_WRITE_PRIMARY,
  SCOPED_READS,
  buildIntegrationCurrentTableSessions,
  buildIntegrationMenuItemsByName,
  buildIntegrationOrderCompAvailability,
  buildIntegrationOrderLookupCandidates,
  buildIntegrationOrdersFastCacheKey,
  buildOrderCorrectionState,
  buildStationOrdersPollReconciliationCursor,
  cloneJson,
  createDefaultIntegrationState,
  hydrateIntegrationOrderPrices,
  integrationOrderMatchesStationFilter,
  integrationOrderMatchesStationOperatorFilter,
  integrationOrdersFastResponseCache,
  isIntegrationOrderHistoricalForStationView,
  isIntegrationOrderReadyForDelivery,
  limitIntegrationStationDoneHistory,
  mysqlAppStateDomainsSplitRepository,
  normalizeIntegrationStationName,
  nowIso,
  pruneIntegrationState,
  readDb,
  readFastJsonCache,
  readScopedIntegrationOrdersDb,
  relationalRuntime,
  resolveIntegrationLogicalTableLabel,
  resolveIntegrationOrderDisplayTitle,
  roundMoney,
  runtimeMetrics,
  sanitizeIntegrationOrder,
  sanitizeIntegrationTableLabel,
  sanitizeOrderWorkflowSettings,
  sanitizePosSettings,
  scheduleStationOrdersPollReconciliation,
  sendJson,
  sendJsonString,
  shouldIncludeIntegrationOrderForCurrentTableSession,
  writeFastJsonCache,
}) {
  async function handleIntegrationOrders(req, res, requestUrl) {
    const stationRaw = String(
      requestUrl.searchParams.get("station") ?? "",
    ).trim();
    const bypassFastCache =
      requestUrl.searchParams.has("fresh");
    const fastCacheKey = buildIntegrationOrdersFastCacheKey(requestUrl, {
      defaultDoneHistoryLimit: INTEGRATION_STATION_DONE_HISTORY_LIMIT,
    });
    if (!bypassFastCache) {
      const cachedOrders = readFastJsonCache(
        integrationOrdersFastResponseCache,
        fastCacheKey,
        INTEGRATION_HOT_GET_FAST_CACHE_MS,
      );
      if (cachedOrders) {
        runtimeMetrics.incrementCounter("integrationOrdersFastCacheHits");
        sendJsonString(res, 200, cachedOrders.json);
        return;
      }
    }
    runtimeMetrics.incrementCounter("integrationOrdersFastCacheMisses");
    const scopedOrdersDb = await readScopedIntegrationOrdersDb({
      enabled: SCOPED_READS,
      requestUrl,
      domainsRepository: mysqlAppStateDomainsSplitRepository,
      createDefaultIntegrationState,
      logger: console,
      relationalOrdersHistoryReadEnabled: RELATIONAL_ORDERS_HISTORY_READS, relationalOrdersLookupReadEnabled: RELATIONAL_ORDERS_WRITE_PRIMARY,
      relationalRuntime,
    });
    let db = scopedOrdersDb ?? (await readDb());
    const scopedOrdersReadOnly = scopedOrdersDb !== null;
    const station = stationRaw ? normalizeIntegrationStationName(stationRaw) : "";
    const operatorFilter = {
      userId: String(
        requestUrl.searchParams.get("operatorUserId") ??
          requestUrl.searchParams.get("userId") ??
          "",
      ).trim(),
      username: String(
        requestUrl.searchParams.get("operatorUsername") ??
          requestUrl.searchParams.get("username") ??
          "",
      ).trim(),
      deviceUuid: String(requestUrl.searchParams.get("deviceUuid") ?? "").trim(),
    };
    const includeDone = requestUrl.searchParams.get("includeDone") === "1";
    const includeTransferred =
      requestUrl.searchParams.get("includeTransferred") === "1";
    const currentSessionOnly =
      requestUrl.searchParams.get("currentSessionOnly") === "1";
    const requestedRoomId = String(requestUrl.searchParams.get("roomId") ?? "")
      .trim();
    const orderLookupRaw = String(
      requestUrl.searchParams.get("orderId") ??
        requestUrl.searchParams.get("id") ??
        "",
    ).trim();
    const orderLookupCandidates = new Set(
      buildIntegrationOrderLookupCandidates(orderLookupRaw),
    );
    const prunedIntegrationState = station || scopedOrdersReadOnly
      ? false
      : pruneIntegrationState((db = {
          ...db,
          integration: cloneJson(db.integration, createDefaultIntegrationState()),
        }).integration);
    const integrationOrders = Array.isArray(db.integration?.orders)
      ? db.integration.orders
      : [];
    if (station) {
      scheduleStationOrdersPollReconciliation(station, {
        stateVersion: buildStationOrdersPollReconciliationCursor(integrationOrders),
      });
    } else if (prunedIntegrationState) {
      runtimeMetrics.incrementCounter("integrationOrdersReadOnlyPrunes");
    }
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const hideReadyOrdersFromStationQueue =
      sanitizeOrderWorkflowSettings(settings.orderWorkflow)
        .deliveryConfirmationEnabled === false;
    const normalizedOrders = integrationOrders.map((order, index) =>
      sanitizeIntegrationOrder(order, String(index + 1).padStart(5, "0")),
    );
  
    const menuItemsByName = buildIntegrationMenuItemsByName(db);
    const currentTableSessions = currentSessionOnly
      ? buildIntegrationCurrentTableSessions(db)
      : null;
    const filteredOrders = normalizedOrders
      .filter((order) => {
        if (orderLookupCandidates.size === 0) return true;
        const orderId = String(order?.id ?? "").trim();
        return (
          orderLookupCandidates.has(orderId) ||
          orderLookupCandidates.has(`#${orderId}`) ||
          orderLookupCandidates.has(`order_${orderId}`)
        );
      })
      .filter((order) =>
        integrationOrderMatchesStationFilter(order, station, includeTransferred),
      )
      .filter((order) => {
        const operatorMatches = integrationOrderMatchesStationOperatorFilter(
          order,
          operatorFilter,
          {
            requireRequesterForAssigned: Boolean(station),
          },
        );
        if (operatorMatches) return true;
        return includeDone && isIntegrationOrderHistoricalForStationView(order);
      })
      .filter((order) =>
        shouldIncludeIntegrationOrderForCurrentTableSession(
          order,
          currentTableSessions,
        ),
      )
      .filter((order) => {
        if (!requestedRoomId) return true;
        const orderRoomId = String(order.roomId ?? "").trim();
        return !orderRoomId || orderRoomId === requestedRoomId;
      })
      .filter((order) =>
        includeDone
          ? true
          : String(order.paymentStatus ?? "")
              .trim()
              .toLowerCase() !== "paid" &&
            roundMoney(Math.max(Number(order.dueAmount) || 0, 0)) > 0.009 &&
            order.workflowStatus !== "delivered" &&
            !(
              hideReadyOrdersFromStationQueue &&
              isIntegrationOrderReadyForDelivery(order)
            ),
      )
      .map((order) => hydrateIntegrationOrderPrices(order, menuItemsByName))
      .map((order) => {
        const displayTitle = resolveIntegrationOrderDisplayTitle(
          order,
          order.title,
        );
        const orderWithFreshTitle = displayTitle
          ? { ...order, title: displayTitle }
          : order;
        const tableLabel =
          resolveIntegrationLogicalTableLabel(
            db.posSettings,
            db.integration,
            orderWithFreshTitle.tableId,
            orderWithFreshTitle.tableNumber,
          ) ||
          sanitizeIntegrationTableLabel(
            orderWithFreshTitle.tableLabel ??
              orderWithFreshTitle.logicalTableLabel,
          );
        const correctionState = buildOrderCorrectionState(
          orderWithFreshTitle,
          db.integration,
          db,
        );
        const tableWorkLock = order.tableId
          ? sanitizeTableWorkLock(
              settings.tables.find((table) => table.id === order.tableId)
                ?.workLock,
            )
          : null;
        const orderWithCorrectionState = {
          ...orderWithFreshTitle,
          ...correctionState,
          compAvailability: buildIntegrationOrderCompAvailability(order, db),
          tableLockStatus:
            tableWorkLock && !isTableWorkLockExpired(tableWorkLock)
              ? tableWorkLock
              : null,
        };
        return tableLabel
          ? {
              ...orderWithCorrectionState,
              tableLabel,
              logicalTableLabel: tableLabel,
            }
          : orderWithCorrectionState;
      })
      .sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  
    const version = new Date(
      db.integration?.lastWriteAt ?? db.meta?.lastWriteAt ?? nowIso(),
    ).getTime();
    const responseOrders =
      station && includeDone && orderLookupCandidates.size === 0
        ? limitIntegrationStationDoneHistory(filteredOrders, {
            limit:
              requestUrl.searchParams.get("doneHistoryLimit") ??
              requestUrl.searchParams.get("historyLimit"),
          })
        : filteredOrders;
  
    const responsePayload = {
      ok: true,
      version: Number.isFinite(version) ? version : Date.now(),
      orders: responseOrders,
    };
    if (bypassFastCache) {
      sendJson(res, 200, responsePayload);
      return;
    }
    const cacheEntry = writeFastJsonCache(
      integrationOrdersFastResponseCache,
      fastCacheKey,
      responsePayload,
      32,
    );
    sendJsonString(res, 200, cacheEntry.json);
  }
  

  return {
    handleIntegrationOrders,
  };
}
