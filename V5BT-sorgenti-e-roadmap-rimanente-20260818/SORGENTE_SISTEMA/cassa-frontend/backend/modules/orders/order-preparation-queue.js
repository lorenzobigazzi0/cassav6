import { buildIntegrationOrderLookupCandidates } from "../integration/order-lookup.domain.js";

export function hasIntegrationOrderPreparationProgress(order) {
  return (Array.isArray(order?.items) ? order.items : []).some((item) => {
    const doneQty = Math.max(Math.trunc(Number(item?.doneQty) || 0), 0);
    return item?.done === true || doneQty > 0;
  });
}

function toSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

function resolveOrderSnapshotOrders(source) {
  if (Array.isArray(source)) return source;
  if (Array.isArray(source?.orders)) return source.orders;
  if (Array.isArray(source?.integration?.orders)) return source.integration.orders;
  return [];
}

export function buildIntegrationOrderWorkflowSnapshotSource(source, options = {}) {
  const orders = resolveOrderSnapshotOrders(source);
  const sourceKind =
    String(options.sourceKind ?? "").trim() ||
    String(source?.sourceKind ?? source?.__orderWorkflowSnapshotSource ?? "").trim() ||
    (source?.__scopedReadOnly === "integration.orders"
      ? "read-model"
      : Array.isArray(source)
        ? "array"
        : Array.isArray(source?.integration?.orders)
          ? "dbcache"
          : Array.isArray(source?.orders)
            ? "snapshot"
            : "empty");
  return {
    __orderWorkflowSnapshotSource: sourceKind,
    sourceKind,
    orders,
    orderCount: orders.length,
    externalized: options.externalized === true || source?.externalized === true,
    generatedAt: String(options.generatedAt ?? source?.generatedAt ?? "").trim(),
    scoped: options.scoped === true || source?.scoped === true,
  };
}

function findIntegrationOrderSnapshotIndex(orders, orderId, dependencies = {}) {
  const safeOrderId = String(orderId ?? "").trim();
  if (!safeOrderId || !Array.isArray(orders)) return -1;
  if (typeof dependencies.findIntegrationOrderIndexByLookup === "function") {
    return dependencies.findIntegrationOrderIndexByLookup(orders, safeOrderId, {
      lookupIndex: dependencies.lookupIndex,
    });
  }
  return orders.findIndex((entry) => String(entry?.id ?? "").trim() === safeOrderId);
}

function orderMatchesLookupValue(order, value) {
  const id = String(order?.id ?? "").trim();
  if (!id) return false;
  const candidates = new Set(buildIntegrationOrderLookupCandidates(value));
  return candidates.has(id) || candidates.has(`order_${id}`) || candidates.has(`#${id}`);
}

function collectScopedMergeCandidateIndexes(orderId, dependencies = {}, orderCount = 0) {
  const indexes = new Set();
  const addIndex = (value) => {
    const index = Math.trunc(Number(value));
    if (Number.isInteger(index) && index >= 0) indexes.add(index);
  };
  addIndex(dependencies.scopedMergeIndex);
  const hints = dependencies.scopedMergeIndexHints;
  if (hints instanceof Map) addIndex(hints.get(orderId));
  else if (hints && typeof hints === "object" && !Array.isArray(hints)) addIndex(hints[orderId]);
  for (const candidate of buildIntegrationOrderLookupCandidates(orderId)) {
    const digits = String(candidate ?? "").match(/\d{1,8}/)?.[0] ?? "";
    if (digits) addIndex(Number.parseInt(digits, 10) - 1);
  }
  const tailSize = Math.max(0, Math.min(256, Math.trunc(Number(dependencies.scopedMergeTailSize) || 0)));
  for (let offset = 1; offset <= tailSize; offset += 1) addIndex(orderCount - offset);
  return [...indexes];
}

export function resolveIntegrationOrderWorkflowTarget(orderSource, orderId, dependencies = {}) {
  const snapshotSource = buildIntegrationOrderWorkflowSnapshotSource(orderSource);
  const safeOrderId = String(orderId ?? "").trim();
  const index = findIntegrationOrderSnapshotIndex(snapshotSource.orders, safeOrderId, dependencies);
  if (index < 0) {
    return {
      found: false,
      index: -1,
      order: null,
      orderId: safeOrderId,
      snapshotSource,
      sourceKind: snapshotSource.sourceKind,
    };
  }

  const rawOrder = snapshotSource.orders[index];
  const fallbackId = String(rawOrder?.id ?? safeOrderId).trim() || safeOrderId;
  const order =
    typeof dependencies.sanitizeIntegrationOrder === "function"
      ? dependencies.sanitizeIntegrationOrder(rawOrder, fallbackId)
      : rawOrder;
  return {
    found: true,
    index,
    order,
    orderId: String(order?.id ?? fallbackId).trim(),
    snapshotSource,
    sourceKind: snapshotSource.sourceKind,
  };
}

export function buildIntegrationOrderWorkflowApplyPlan(
  orderSource,
  target,
  nextOrder,
  dependencies = {}
) {
  const snapshotSource = buildIntegrationOrderWorkflowSnapshotSource(orderSource);
  const targetOrderId = String(
    target?.order?.id ?? target?.orderId ?? nextOrder?.id ?? ""
  ).trim();
  let index = -1;
  if (
    Number.isInteger(target?.index) &&
    target.index >= 0 &&
    target.index < snapshotSource.orders.length &&
    (!targetOrderId ||
      String(snapshotSource.orders[target.index]?.id ?? "").trim() === targetOrderId)
  ) {
    index = target.index;
  } else {
    index = findIntegrationOrderSnapshotIndex(snapshotSource.orders, targetOrderId, dependencies);
  }
  if (index < 0) {
    return {
      found: false,
      index: -1,
      order: null,
      orders: snapshotSource.orders,
      sourceKind: snapshotSource.sourceKind,
    };
  }

  const fallbackId =
    String(nextOrder?.id ?? snapshotSource.orders[index]?.id ?? targetOrderId).trim() ||
    targetOrderId;
  const order =
    typeof dependencies.sanitizeIntegrationOrder === "function"
      ? dependencies.sanitizeIntegrationOrder(nextOrder, fallbackId)
      : nextOrder;
  const orders = snapshotSource.orders.slice();
  orders[index] = order;
  return {
    found: true,
    index,
    order,
    orders,
    sourceKind: snapshotSource.sourceKind,
  };
}

export function mergeIntegrationOrderWorkflowScopedOrders(baseSource, scopedSource, dependencies = {}) {
  const baseOrders = resolveOrderSnapshotOrders(baseSource).slice();
  const scopedOrders = resolveOrderSnapshotOrders(scopedSource);
  if (dependencies.fastScopedMerge === true) {
    const remainingById = new Map();
    for (const entry of scopedOrders) {
      const orderId = String(entry?.id ?? "").trim();
      if (!orderId) continue;
      let appliedByHint = false;
      for (const index of collectScopedMergeCandidateIndexes(orderId, dependencies, baseOrders.length)) {
        if (index >= baseOrders.length || !orderMatchesLookupValue(baseOrders[index], orderId)) continue;
        baseOrders[index] = entry;
        appliedByHint = true;
        break;
      }
      if (!appliedByHint) remainingById.set(orderId, entry);
    }
    for (let index = 0; index < baseOrders.length && remainingById.size > 0; index += 1) { const orderId = String(baseOrders[index]?.id ?? "").trim(); if (remainingById.has(orderId)) { baseOrders[index] = remainingById.get(orderId); remainingById.delete(orderId); } }
    if (remainingById.size > 0 && typeof dependencies.findIntegrationOrderIndexByLookup === "function") for (const [orderId, entry] of [...remainingById]) { const index = dependencies.findIntegrationOrderIndexByLookup(baseOrders, orderId); if (index >= 0) { baseOrders[index] = entry; remainingById.delete(orderId); } }
    for (const entry of remainingById.values()) baseOrders.push(entry);
    return baseOrders;
  }
  const lookupIndex =
    typeof dependencies.buildIntegrationOrderLookupIndex === "function"
      ? dependencies.buildIntegrationOrderLookupIndex(baseOrders)
      : dependencies.lookupIndex;
  const indexedDependencies = { ...dependencies, lookupIndex };
  for (const entry of scopedOrders) {
    const orderId = String(entry?.id ?? "").trim();
    if (!orderId) continue;
    const index = findIntegrationOrderSnapshotIndex(baseOrders, orderId, indexedDependencies);
    if (index >= 0) baseOrders[index] = entry;
    else baseOrders.push(entry);
  }
  return baseOrders;
}

export function resolveIntegrationOrderQueueStation(order, dependencies = {}) {
  const {
    normalizeIntegrationStationName,
    normalizeOptionalIntegrationStationName,
    primaryStation = "",
  } = dependencies;
  const normalizeOptional =
    typeof normalizeOptionalIntegrationStationName === "function"
      ? normalizeOptionalIntegrationStationName
      : (value) => {
          const normalized = String(value ?? "").trim();
          return normalized || null;
        };
  const normalizeRequired =
    typeof normalizeIntegrationStationName === "function"
      ? normalizeIntegrationStationName
      : (value) => normalizeOptional(value) ?? "";

  return (
    normalizeOptional(order?.assignedStationId) ??
    normalizeOptional(order?.ownerStation) ??
    normalizeOptional(order?.lockedByStationId) ??
    normalizeOptional(order?.station) ??
    normalizeRequired(primaryStation)
  );
}

export function buildIntegrationOrderQueueOperatorKey(order, dependencies = {}) {
  const { getStationOperatorAssignmentKey } = dependencies;
  if (typeof getStationOperatorAssignmentKey !== "function") return "";
  return getStationOperatorAssignmentKey({
    assignedStationOperatorUserId: order?.assignedStationOperatorUserId,
    assignedStationOperatorUsername: order?.assignedStationOperatorUsername,
    assignedStationOperatorName: order?.assignedStationOperatorName,
    assignedStationDeviceUuid: order?.assignedStationDeviceUuid,
  });
}

export function buildIntegrationStationStateQueueOperatorKey(stationState, dependencies = {}) {
  const { getStationOperatorAssignmentKey } = dependencies;
  if (typeof getStationOperatorAssignmentKey !== "function") return "";
  return getStationOperatorAssignmentKey({
    operatorUserId: stationState?.operatorUserId ?? stationState?.userId,
    operatorUsername: stationState?.operatorUsername ?? stationState?.username,
    operatorName: stationState?.operatorName ?? stationState?.operator,
    deviceUuid: stationState?.deviceUuid,
  });
}

export function buildIntegrationOrderQueueLaneKey(order, dependencies = {}) {
  const {
    integrationOrderQueueOperatorKey,
    integrationOrderQueueStation,
  } = dependencies;
  const station =
    typeof integrationOrderQueueStation === "function"
      ? integrationOrderQueueStation(order)
      : resolveIntegrationOrderQueueStation(order, dependencies);
  if (!station) return "";
  const operatorKey =
    typeof integrationOrderQueueOperatorKey === "function"
      ? integrationOrderQueueOperatorKey(order)
      : buildIntegrationOrderQueueOperatorKey(order, dependencies);
  return `${station}::${operatorKey}`;
}

export function isIntegrationOrderOpenForPreparationQueue(order, dependencies = {}) {
  const { normalizeIntegrationWorkflowStatus, roundMoney } = dependencies;
  if (!order || typeof order !== "object") return false;
  if (typeof normalizeIntegrationWorkflowStatus !== "function") return false;
  if (String(order.paymentStatus ?? "").trim().toLowerCase() === "paid") return false;
  const normalizedDue =
    typeof roundMoney === "function"
      ? roundMoney(Math.max(Number(order.dueAmount) || 0, 0))
      : Math.round(Math.max(Number(order.dueAmount) || 0, 0) * 100) / 100;
  if (normalizedDue <= 0.009) return false;
  const workflow = normalizeIntegrationWorkflowStatus(
    order.workflowStatus,
    order.items,
    order.completedAtMs,
    {
      lineRoutes: order.lineRoutes,
      ownerStation: order.ownerStation,
    }
  );
  return workflow === "waiting" || workflow === "prep";
}

export function isIntegrationOrderQueueLaneActive(order, activeQueue, dependencies = {}) {
  const {
    integrationOrderQueueLaneKey,
    integrationOrderQueueOperatorKey,
    integrationOrderQueueStation,
  } = dependencies;
  if (
    typeof integrationOrderQueueLaneKey !== "function" ||
    typeof integrationOrderQueueOperatorKey !== "function" ||
    typeof integrationOrderQueueStation !== "function"
  ) {
    return false;
  }
  const stations = toSet(activeQueue?.stations);
  const lanes = toSet(activeQueue?.lanes);
  const station = integrationOrderQueueStation(order);
  if (!station || !stations.has(station)) return false;
  const laneKey = integrationOrderQueueLaneKey(order);
  if (!laneKey) return false;
  const operatorKey = integrationOrderQueueOperatorKey(order);
  return operatorKey ? lanes.has(laneKey) : true;
}

export function buildActivePreparationQueueLaneKeys(stationStates, dependencies = {}) {
  const {
    allowDemoStations = false,
    getActiveStations,
    integrationStationStateQueueOperatorKey,
    normalizeOptionalIntegrationStationName,
  } = dependencies;
  const empty = { lanes: new Set(), stations: new Set() };
  if (
    !Array.isArray(stationStates) ||
    typeof getActiveStations !== "function" ||
    typeof integrationStationStateQueueOperatorKey !== "function" ||
    typeof normalizeOptionalIntegrationStationName !== "function"
  ) {
    return empty;
  }

  const activeStations = getActiveStations(
    { integration: { stationStates } },
    { allowDemoStations }
  );
  const lanes = new Set();
  const stations = new Set();

  activeStations.forEach((stationState) => {
    const station = normalizeOptionalIntegrationStationName(stationState?.station);
    if (!station) return;
    stations.add(station);
    lanes.add(`${station}::${integrationStationStateQueueOperatorKey(stationState)}`);
  });

  return { lanes, stations };
}

export function countPreparingIntegrationOrdersInLane(
  orderSource,
  targetOrder,
  options = {},
  dependencies = {}
) {
  const {
    integrationOrderQueueLaneKey,
    normalizeIntegrationWorkflowStatus,
    sanitizeIntegrationOrder,
  } = dependencies;
  const orders = buildIntegrationOrderWorkflowSnapshotSource(orderSource).orders;
  if (
    orders.length === 0 ||
    !targetOrder ||
    typeof integrationOrderQueueLaneKey !== "function" ||
    typeof normalizeIntegrationWorkflowStatus !== "function" ||
    typeof sanitizeIntegrationOrder !== "function"
  ) {
    return 0;
  }

  const targetLane = integrationOrderQueueLaneKey(targetOrder);
  if (!targetLane) return 0;
  const excludeOrderId = String(options.excludeOrderId ?? "").trim();

  return orders
    .map((entry, index) => sanitizeIntegrationOrder(entry, String(index + 1).padStart(5, "0")))
    .filter((order) => {
      if (!order || String(order.id ?? "").trim() === excludeOrderId) return false;
      if (integrationOrderQueueLaneKey(order) !== targetLane) return false;
      const workflow = normalizeIntegrationWorkflowStatus(
        order.workflowStatus,
        order.items,
        order.completedAtMs,
        {
          lineRoutes: order.lineRoutes,
          ownerStation: order.ownerStation,
        }
      );
      return workflow === "prep";
    }).length;
}

export function selectPreparationQueuePromotionIds(
  orders,
  activeQueue,
  dependencies = {}
) {
  const {
    integrationOrderQueueLaneKey,
    isIntegrationOrderOpenForPreparationQueue,
    isIntegrationOrderQueueLaneActive,
    normalizeIntegrationWorkflowStatus,
  } = dependencies;
  if (
    !Array.isArray(orders) ||
    typeof integrationOrderQueueLaneKey !== "function" ||
    typeof isIntegrationOrderOpenForPreparationQueue !== "function" ||
    typeof isIntegrationOrderQueueLaneActive !== "function" ||
    typeof normalizeIntegrationWorkflowStatus !== "function"
  ) {
    return [];
  }

  const normalizedActiveQueue = {
    lanes: toSet(activeQueue?.lanes),
    stations: toSet(activeQueue?.stations),
  };
  if (normalizedActiveQueue.stations.size === 0) return [];

  const lanesWithPreparation = new Set();
  const waitingByLane = new Map();

  orders.forEach((order) => {
    if (!isIntegrationOrderOpenForPreparationQueue(order)) return;
    if (!isIntegrationOrderQueueLaneActive(order, normalizedActiveQueue)) return;
    const laneKey = integrationOrderQueueLaneKey(order);
    if (!laneKey) return;
    const workflow = normalizeIntegrationWorkflowStatus(
      order.workflowStatus,
      order.items,
      order.completedAtMs,
      {
        lineRoutes: order.lineRoutes,
        ownerStation: order.ownerStation,
      }
    );
    if (workflow === "prep") {
      lanesWithPreparation.add(laneKey);
      return;
    }
    if (workflow === "waiting") {
      if (!waitingByLane.has(laneKey)) waitingByLane.set(laneKey, []);
      waitingByLane.get(laneKey).push(order);
    }
  });

  const promoteIds = new Set();
  waitingByLane.forEach((laneOrders, laneKey) => {
    if (lanesWithPreparation.has(laneKey)) return;
    const next = [...laneOrders].sort((left, right) => {
      const leftReceived = Number(left?.receivedAtMs) || 0;
      const rightReceived = Number(right?.receivedAtMs) || 0;
      if (leftReceived !== rightReceived) return leftReceived - rightReceived;
      return String(left?.id ?? "").localeCompare(String(right?.id ?? ""), "it", {
        sensitivity: "base",
      });
    })[0];
    if (next?.id) {
      promoteIds.add(String(next.id));
      lanesWithPreparation.add(laneKey);
    }
  });

  return [...promoteIds];
}

export function buildPreparationQueuePromotionRecord(order, dependencies = {}) {
  const { integrationOrderQueueStation } = dependencies;
  if (!order || typeof order !== "object" || typeof integrationOrderQueueStation !== "function") {
    return null;
  }
  const orderId = String(order?.id ?? "").trim();
  if (!orderId) return null;
  return {
    orderId,
    station: integrationOrderQueueStation(order),
    operatorUserId: String(order?.assignedStationOperatorUserId ?? "").trim(),
    operatorUsername: String(order?.assignedStationOperatorUsername ?? "").trim(),
    operatorName: String(order?.assignedStationOperatorName ?? "").trim(),
  };
}

export function normalizePreparationQueueOrders(orders, dependencies = {}) {
  const { sanitizeIntegrationOrder } = dependencies;
  if (!Array.isArray(orders) || typeof sanitizeIntegrationOrder !== "function") {
    return [];
  }
  return orders.map((entry, index) =>
    sanitizeIntegrationOrder(entry, String(index + 1).padStart(5, "0"))
  );
}

export function buildPreparationQueueReconciliationPlan(
  orderSource,
  activeQueue,
  dependencies = {}
) {
  const orders = buildIntegrationOrderWorkflowSnapshotSource(orderSource).orders;
  const normalizedOrders = normalizePreparationQueueOrders(orders, {
    sanitizeIntegrationOrder: dependencies.sanitizeIntegrationOrder,
  });
  if (normalizedOrders.length === 0) {
    return {
      orders: [],
      promoteIds: [],
    };
  }
  return {
    orders: normalizedOrders,
    promoteIds: selectPreparationQueuePromotionIds(normalizedOrders, activeQueue, dependencies),
  };
}

export function applyPreparationQueuePromotionPlan(
  orders,
  promoteIds,
  dependencies = {}
) {
  const { buildPromotionRecord, promoteOrder } = dependencies;
  if (!Array.isArray(orders)) {
    return {
      orders: [],
      promoted: [],
    };
  }
  const promoteSet = toSet(promoteIds);
  if (promoteSet.size === 0 || typeof promoteOrder !== "function") {
    return {
      orders: [...orders],
      promoted: [],
    };
  }

  const promoted = [];
  const nextOrders = orders.map((order) => {
    const orderId = String(order?.id ?? "").trim();
    if (!orderId || !promoteSet.has(orderId)) return order;
    const nextOrder = promoteOrder(order);
    const promotedOrder = nextOrder && typeof nextOrder === "object" ? nextOrder : order;
    if (promotedOrder === order || typeof buildPromotionRecord !== "function") {
      return promotedOrder;
    }
    const promotionRecord = buildPromotionRecord(promotedOrder);
    if (promotionRecord) promoted.push(promotionRecord);
    return promotedOrder;
  });

  return {
    orders: nextOrders,
    promoted,
  };
}

export function buildCreatedOrderPreparationQueueFastPlan(
  orderSource,
  createdOrder,
  activeQueue,
  dependencies = {}
) {
  const {
    buildPromotionRecord,
    integrationOrderQueueLaneKey,
    isIntegrationOrderOpenForPreparationQueue,
    isIntegrationOrderQueueLaneActive,
    normalizeIntegrationWorkflowStatus,
    promoteOrder,
  } = dependencies;
  const orders = buildIntegrationOrderWorkflowSnapshotSource(orderSource).orders;
  if (
    !Array.isArray(orders) ||
    !createdOrder ||
    typeof integrationOrderQueueLaneKey !== "function" ||
    typeof isIntegrationOrderOpenForPreparationQueue !== "function" ||
    typeof isIntegrationOrderQueueLaneActive !== "function" ||
    typeof normalizeIntegrationWorkflowStatus !== "function"
  ) {
    return { applied: false, changed: false, orders, promoted: [] };
  }

  const normalizedActiveQueue = {
    lanes: toSet(activeQueue?.lanes),
    stations: toSet(activeQueue?.stations),
  };
  if (normalizedActiveQueue.stations.size === 0) {
    return { applied: true, changed: false, orders, promoted: [] };
  }
  if (!isIntegrationOrderQueueLaneActive(createdOrder, normalizedActiveQueue)) {
    return { applied: false, changed: false, orders, promoted: [] };
  }
  const laneKey = integrationOrderQueueLaneKey(createdOrder);
  if (!laneKey || !isIntegrationOrderOpenForPreparationQueue(createdOrder)) {
    return { applied: true, changed: false, orders, promoted: [] };
  }

  let waitingOrder = null;
  let waitingIndex = -1;
  for (let index = 0; index < orders.length; index += 1) {
    const candidate = orders[index];
    if (!candidate || typeof candidate !== "object") continue;
    if (integrationOrderQueueLaneKey(candidate) !== laneKey) continue;
    if (!isIntegrationOrderOpenForPreparationQueue(candidate)) continue;
    const workflow = normalizeIntegrationWorkflowStatus(candidate.workflowStatus, candidate.items, candidate.completedAtMs, { lineRoutes: candidate.lineRoutes, ownerStation: candidate.ownerStation });
    if (workflow === "prep") return { applied: true, changed: false, orders, promoted: [] };
    if (workflow !== "waiting") continue;
    const candidateReceived = Number(candidate?.receivedAtMs) || 0;
    const waitingReceived = Number(waitingOrder?.receivedAtMs) || 0;
    if (!waitingOrder || candidateReceived < waitingReceived || (candidateReceived === waitingReceived && String(candidate?.id ?? "").localeCompare(String(waitingOrder?.id ?? ""), "it", { sensitivity: "base" }) < 0)) {
      waitingOrder = candidate;
      waitingIndex = index;
    }
  }
  if (!waitingOrder || String(waitingOrder?.id ?? "").trim() !== String(createdOrder?.id ?? "").trim() || waitingIndex < 0 || typeof promoteOrder !== "function") {
    return { applied: false, changed: false, orders, promoted: [] };
  }
  const promotedOrder = promoteOrder(waitingOrder);
  const nextOrders = orders.slice();
  nextOrders[waitingIndex] = promotedOrder;
  const promotionRecord = typeof buildPromotionRecord === "function" ? buildPromotionRecord(promotedOrder) : null;
  return { applied: true, changed: promotedOrder !== waitingOrder, orders: nextOrders, promoted: promotionRecord ? [promotionRecord] : [] };
}

export function buildPreparationQueueReconciliationApplyPlan(
  orderSource,
  activeQueue,
  dependencies = {}
) {
  const reconciliationPlan = buildPreparationQueueReconciliationPlan(
    orderSource,
    activeQueue,
    dependencies
  );
  const promoteIds = [...new Set(reconciliationPlan.promoteIds)];
  if (promoteIds.length === 0 || reconciliationPlan.orders.length === 0) {
    return {
      orders: reconciliationPlan.orders,
      promoteIds,
      promoted: [],
      changed: false,
    };
  }

  const promotionResult = applyPreparationQueuePromotionPlan(
    reconciliationPlan.orders,
    promoteIds,
    {
      promoteOrder: dependencies.promoteOrder,
      buildPromotionRecord: dependencies.buildPromotionRecord,
    }
  );
  const changed = promotionResult.orders.some(
    (order, index) => order !== reconciliationPlan.orders[index]
  );

  return {
    orders: promotionResult.orders,
    promoteIds,
    promoted: promotionResult.promoted,
    changed,
  };
}

export function resolvePreparationPromotionActor(order, context = {}, dependencies = {}) {
  const { nowMs } = dependencies;
  const actorUserId =
    String(order?.assignedStationOperatorUserId ?? "").trim() ||
    String(context.userId ?? "").trim() ||
    String(order?.createdByUserId ?? "").trim();
  const actorUsername =
    String(order?.assignedStationOperatorUsername ?? "").trim() ||
    String(context.username ?? "").trim() ||
    String(order?.assignedStationOperatorName ?? "").trim() ||
    String(order?.createdByUsername ?? "").trim();
  const existingOwnerAtMs = Number(order?.ownerAtMs);
  const resolvedNowMs = typeof nowMs === "function" ? Number(nowMs()) : Date.now();

  return {
    actorUserId,
    actorUsername,
    lockedByUserId: String(order?.lockedByUserId ?? "").trim() || actorUserId,
    ownerOperator:
      String(order?.assignedStationOperatorName ?? "").trim() ||
      String(order?.ownerOperator ?? "").trim() ||
      actorUsername ||
      "Operatore",
    ownerRole: String(order?.ownerRole ?? context.ownerRole ?? "").trim() || "Operatore",
    ownerAtMs: Number.isFinite(existingOwnerAtMs) && existingOwnerAtMs > 0
      ? Math.trunc(existingOwnerAtMs)
      : Math.trunc(Number.isFinite(resolvedNowMs) && resolvedNowMs > 0 ? resolvedNowMs : Date.now()),
  };
}

function clearIntegrationOrderRoutePreparationProgress(order) {
  if (!Array.isArray(order?.lineRoutes)) return order?.lineRoutes;
  return order.lineRoutes.map((route) => {
    if (!route || typeof route !== "object") return route;
    const nextRoute = { ...route };
    delete nextRoute.receivedAt;
    delete nextRoute.receivedByUserId;
    delete nextRoute.receivedByUsername;
    return nextRoute;
  });
}

export function buildEmptyPreparationSelectionDemotionPlan(
  orderSource,
  selectedOrder,
  dependencies = {}
) {
  const {
    integrationOrderQueueLaneKey,
    normalizeIntegrationWorkflowStatus,
    nowIso,
    sanitizeIntegrationOrder,
  } = dependencies;
  const orders = buildIntegrationOrderWorkflowSnapshotSource(orderSource).orders;
  if (
    orders.length === 0 ||
    !selectedOrder ||
    typeof integrationOrderQueueLaneKey !== "function" ||
    typeof normalizeIntegrationWorkflowStatus !== "function" ||
    typeof nowIso !== "function" ||
    typeof sanitizeIntegrationOrder !== "function"
  ) {
    return { orders: [], demotions: [] };
  }

  const selectedId = String(selectedOrder?.id ?? "").trim();
  const targetLane = integrationOrderQueueLaneKey(selectedOrder);
  if (!selectedId || !targetLane) return { orders: [], demotions: [] };

  const demoted = [];
  const now = nowIso();
  const nextOrders = orders.map((entry, index) => {
    const fallbackId = String(entry?.id ?? index + 1).trim() || String(index + 1).padStart(5, "0");
    const order = sanitizeIntegrationOrder(entry, fallbackId);
    if (!order || String(order.id ?? "").trim() === selectedId) return order;
    if (integrationOrderQueueLaneKey(order) !== targetLane) return order;
    const workflow = normalizeIntegrationWorkflowStatus(
      order.workflowStatus,
      order.items,
      order.completedAtMs,
      {
        lineRoutes: order.lineRoutes,
        ownerStation: order.ownerStation,
      }
    );
    if (workflow !== "prep") return order;
    if (hasIntegrationOrderPreparationProgress(order)) return order;

    const nextOrder = sanitizeIntegrationOrder(
      {
        ...order,
        workflowStatus: "waiting",
        ownerStation: null,
        ownerOperator: null,
        ownerRole: null,
        ownerAtMs: null,
        lockedByStationId: null,
        lockedByUserId: null,
        lockedAt: null,
        lockStatus: "unlocked",
        preparationStartedAt: null,
        lineRoutes: clearIntegrationOrderRoutePreparationProgress(order),
        updatedAt: now,
      },
      order.id
    );
    demoted.push({
      orderId: nextOrder.id,
      previous: order,
      next: nextOrder,
      lane: targetLane,
    });
    return nextOrder;
  });

  return {
    orders: nextOrders,
    demotions: demoted,
  };
}

function normalizeOrderWorkflowForPreparationPlan(order, dependencies = {}) {
  const { normalizeIntegrationWorkflowStatus } = dependencies;
  if (typeof normalizeIntegrationWorkflowStatus !== "function") return "";
  return normalizeIntegrationWorkflowStatus(
    order?.workflowStatus,
    order?.items,
    order?.completedAtMs,
    {
      lineRoutes: order?.lineRoutes,
      ownerStation: order?.ownerStation,
    }
  );
}

function normalizeCanonicalOrderWorkflowForPreparationPlan(order) {
  const raw = String(order?.workflowStatus ?? "").trim().toLowerCase();
  if (["cancelled", "annullata", "voided"].includes(raw)) return "cancelled";
  if (["done", "delivered", "consegnato", "paid", "pagata"].includes(raw)) return "delivered";
  if (["ready", "da_consegnare", "da consegnare", "pronto", "pronta"].includes(raw)) return "ready";
  if (["prep", "preparing", "in_preparation", "in_preparazione", "in preparazione"].includes(raw)) return "prep";
  if (["", "waiting", "queued", "sent", "received"].includes(raw) && String(order?.ownerStation ?? "").trim()) return "prep";
  return "";
}

function buildSameWorkflowPreparationFastNoop(snapshotSource, currentOrder, nextOrder, options = {}) {
  const currentWorkflow = normalizeCanonicalOrderWorkflowForPreparationPlan(currentOrder);
  const nextWorkflow = normalizeCanonicalOrderWorkflowForPreparationPlan(nextOrder);
  if (!currentWorkflow || currentWorkflow !== nextWorkflow) return null;
  return {
    currentWorkflow,
    nextWorkflow,
    entersPreparation: false,
    fastNoop: true,
    usedSelectionDemotionPlan: false,
    snapshotSourceKind: snapshotSource.sourceKind,
    orders: snapshotSource.orders,
    selectionHandoffDemotions: [],
    preparingInLane: 0,
    maxPreparingOrdersPerLane: Math.max(0, Math.trunc(Number(options.maxPreparingOrdersPerLane) || 0)),
    preparationQueueFull: false,
  };
}

export function buildIntegrationOrderSyncPreparationPlan(
  orderSource,
  currentOrder,
  nextOrder,
  options = {},
  dependencies = {}
) {
  const snapshotSource = buildIntegrationOrderWorkflowSnapshotSource(orderSource);
  const sourceOrders = snapshotSource.orders;
  const fastNoop = buildSameWorkflowPreparationFastNoop(snapshotSource, currentOrder, nextOrder, options);
  if (fastNoop) return fastNoop;
  const currentWorkflow = normalizeOrderWorkflowForPreparationPlan(currentOrder, dependencies);
  const nextWorkflow = normalizeOrderWorkflowForPreparationPlan(nextOrder, dependencies);
  const entersPreparation = nextWorkflow === "prep" && currentWorkflow !== "prep";
  const workflowSyncReason = String(options.workflowSyncReason ?? "").trim();
  const selectionReasons = toSet(options.selectionReasons);
  const shouldBuildDemotionPlan =
    entersPreparation && selectionReasons.has(workflowSyncReason);
  const demotionPlan = shouldBuildDemotionPlan
    ? buildEmptyPreparationSelectionDemotionPlan(sourceOrders, nextOrder, dependencies)
    : { orders: sourceOrders, demotions: [] };
  const ordersForCount = demotionPlan.orders.length > 0 ? demotionPlan.orders : sourceOrders;
  const preparingInLane = entersPreparation
    ? countPreparingIntegrationOrdersInLane(
        ordersForCount,
        nextOrder,
        { excludeOrderId: options.excludeOrderId ?? currentOrder?.id },
        dependencies
      )
    : 0;
  const maxPreparingOrdersPerLane = Math.max(
    0,
    Math.trunc(Number(options.maxPreparingOrdersPerLane) || 0)
  );

  return {
    currentWorkflow,
    nextWorkflow,
    entersPreparation,
    usedSelectionDemotionPlan: shouldBuildDemotionPlan,
    snapshotSourceKind: snapshotSource.sourceKind,
    orders: ordersForCount,
    selectionHandoffDemotions: demotionPlan.demotions,
    preparingInLane,
    maxPreparingOrdersPerLane,
    preparationQueueFull:
      entersPreparation &&
      maxPreparingOrdersPerLane > 0 &&
      preparingInLane >= maxPreparingOrdersPerLane,
  };
}

export function demoteEmptyPreparationOrdersForSelection(db, selectedOrder, dependencies = {}) {
  if (!db?.integration || !Array.isArray(db.integration.orders)) return [];
  const plan = buildEmptyPreparationSelectionDemotionPlan(
    db.integration.orders,
    selectedOrder,
    dependencies
  );
  if (plan.orders.length > 0) {
    db.integration.orders = plan.orders;
  }
  return plan.demotions;
}
