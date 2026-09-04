export const LOAD_BALANCER_DEFAULTS = Object.freeze({
  defaultSecondsPerItem: 90,
  baseOrderOverheadSeconds: 30,
  minSamplesForStationUser: 5,
  minSamplesForStation: 10,
  minSamplesForUser: 10,
  maxHistorySamplesGlobal: 200,
  maxHistorySamplesStation: 50,
  maxHistorySamplesUser: 30,
  maxHistorySamplesStationUser: 20,
  minSecondsPerItemBeforeAnomaly: 10,
  maxSecondsPerItemBeforeAnomaly: 20 * 60,
  anomalyReliableSampleCount: 10,
  anomalyDistanceMultiplier: 3,
  recurringAnomalyLast10Count: 3,
  recurringAnomalyLast20Ratio: 0.3,
});

const COMPLETED_WORKFLOWS = new Set(["ready", "delivered", "done", "completed", "cancelled"]);
const STARTED_WORKFLOWS = new Set(["prep", "in_preparation", "in preparazione"]);

function configWithDefaults(config = {}) {
  return { ...LOAD_BALANCER_DEFAULTS, ...(config && typeof config === "object" ? config : {}) };
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeKey(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeWorkflow(value) {
  const raw = normalizeText(value).toLowerCase();
  if (raw === "in_preparazione" || raw === "in preparazione") return "prep";
  if (raw === "pronto" || raw === "pronta") return "ready";
  if (raw === "consegnato") return "delivered";
  return raw || "waiting";
}

function integrationOf(state) {
  return state?.integration && typeof state.integration === "object" ? state.integration : state;
}

function stationStateList(state) {
  const integration = integrationOf(state);
  return Array.isArray(integration?.stationStates) ? integration.stationStates : [];
}

function orderList(state) {
  const integration = integrationOf(state);
  return Array.isArray(integration?.orders) ? integration.orders : [];
}

function historyList(state) {
  const integration = integrationOf(state);
  return Array.isArray(integration?.orderFulfillmentHistory)
    ? integration.orderFulfillmentHistory
    : [];
}

function stationUserKey(stationId, userId) {
  return `${normalizeKey(stationId)}::${normalizeKey(userId)}`;
}

function stationOperatorIdentity(station) {
  return (
    normalizeText(station?.operatorUserId ?? station?.userId) ||
    normalizeText(station?.operatorUsername ?? station?.username) ||
    normalizeText(station?.deviceUuid) ||
    normalizeText(station?.operatorName ?? station?.operator)
  );
}

function resolveOrderSpreadSeed(order) {
  const raw = normalizeText(order?.id ?? order?.orderId ?? order?.code);
  const numeric = Number.parseInt(raw.replace(/\D+/g, ""), 10);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  let hash = 2166136261;
  const source = raw || JSON.stringify(order ?? {});
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function orderAssignedOperatorIdentity(order) {
  return (
    normalizeText(order?.assignedStationOperatorUserId) ||
    normalizeText(order?.assignedStationOperatorUsername) ||
    normalizeText(order?.assignedStationDeviceUuid) ||
    normalizeText(order?.assignedStationOperatorName)
  );
}

function orderAssignmentMatchesStationOperator(order, station) {
  const assignedUserId = normalizeText(order?.assignedStationOperatorUserId);
  const stationUserId = normalizeText(station?.operatorUserId ?? station?.userId);
  if (assignedUserId && stationUserId && normalizeKey(assignedUserId) !== normalizeKey(stationUserId)) {
    return false;
  }

  const assignedUsername = normalizeText(order?.assignedStationOperatorUsername);
  const stationUsername = normalizeText(station?.operatorUsername ?? station?.username);
  if (
    !assignedUserId &&
    assignedUsername &&
    stationUsername &&
    normalizeKey(assignedUsername) !== normalizeKey(stationUsername)
  ) {
    return false;
  }

  const assignedDeviceUuid = normalizeText(order?.assignedStationDeviceUuid);
  const stationDeviceUuid = normalizeText(station?.deviceUuid);
  if (
    !assignedUserId &&
    !assignedUsername &&
    assignedDeviceUuid &&
    stationDeviceUuid &&
    assignedDeviceUuid !== stationDeviceUuid
  ) {
    return false;
  }

  const orderIdentity = orderAssignedOperatorIdentity(order);
  const stationIdentity = stationOperatorIdentity(station);
  if (orderIdentity && stationIdentity) {
    return normalizeKey(orderIdentity) === normalizeKey(stationIdentity);
  }

  return !orderIdentity;
}

function isDemoStationAllowed(station, options) {
  return options.allowDemoStations === true && station?.isDemoFallback === true;
}

function hasLoggedOperator(station, options) {
  if (options.requireLoggedOperator === false) return true;
  if (isDemoStationAllowed(station, options)) return true;
  const userId = normalizeText(station?.operatorUserId ?? station?.userId);
  const username = normalizeText(station?.operatorUsername ?? station?.username).toLowerCase();
  const operatorName = normalizeText(station?.operatorName ?? station?.operator).toLowerCase();
  const operatorRole = normalizeText(station?.operatorRole ?? station?.role).toLowerCase();
  const guestNames = new Set(["", "guest", "ospite"]);
  const unauthRoles = new Set(["", "non autenticato", "non_autenticato", "guest"]);
  return Boolean(
    userId ||
      (username && !guestNames.has(username)) ||
      (operatorName && !guestNames.has(operatorName) && !unauthRoles.has(operatorRole))
  );
}

export function getActiveStations(state, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const staleMs = Number.isFinite(Number(options.staleMs)) ? Number(options.staleMs) : 5 * 60 * 1000;
  const excludeStations = new Set(
    (Array.isArray(options.excludeStationIds) ? options.excludeStationIds : []).map((entry) =>
      normalizeKey(entry)
    )
  );
  return stationStateList(state)
    .filter((station) => station && typeof station === "object")
    .map((station) => {
      const updatedAtMs = Number(station.updatedAtMs);
      const stale =
        station.stale === true ||
        (staleMs > 0 && Number.isFinite(updatedAtMs) && updatedAtMs > 0 && nowMs - updatedAtMs > staleMs);
      return {
        ...station,
        station: normalizeText(station.station),
        stale,
      };
    })
    .filter((station) => station.station)
    .filter((station) => !excludeStations.has(normalizeKey(station.station)))
    .filter((station) => station.active !== false)
    .filter((station) => station.stale !== true)
    .filter((station) => station.realStation === true || isDemoStationAllowed(station, options))
    .filter((station) => hasLoggedOperator(station, options))
    .filter((station, _index, activeStations) => {
      const deviceUuid = normalizeText(station.deviceUuid);
      if (!deviceUuid || isDemoStationAllowed(station, options)) return true;
      const newestForSameDevice = activeStations
        .filter((entry) => normalizeText(entry.deviceUuid) === deviceUuid)
        .sort((left, right) => (Number(right.updatedAtMs) || 0) - (Number(left.updatedAtMs) || 0))[0];
      return newestForSameDevice === station;
    });
}

export function getStationOperator(state, stationId) {
  const stationKey = normalizeKey(stationId);
  const station =
    stationStateList(state).find((entry) => normalizeKey(entry?.station) === stationKey) ?? null;
  if (!station) {
    return { userId: "", username: "", displayName: "" };
  }
  const displayName = normalizeText(station.operatorName);
  const username = normalizeText(station.operatorUsername ?? station.username ?? displayName);
  const userId = normalizeText(station.operatorUserId ?? station.userId ?? username);
  return { userId, username, displayName };
}

export function countOrderItems(order, options = {}) {
  const items = Array.isArray(order?.items) ? order.items : [];
  return items.reduce((sum, item) => {
    if (!item || typeof item !== "object") return sum;
    if (item.voidedAt) return sum;
    const qty = Math.max(Math.trunc(Number(item.qty) || 0), 1);
    if (options.remainingOnly === true) {
      const doneQty = Math.max(Math.trunc(Number(item.doneQty ?? (item.done === true ? qty : 0)) || 0), 0);
      return sum + Math.max(qty - doneQty, 0);
    }
    return sum + qty;
  }, 0);
}

function eventSecondsPerItem(event) {
  const direct = Number(event?.secondsPerItem);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const durationSeconds = Number(event?.durationSeconds);
  const itemsCount = Math.max(Math.trunc(Number(event?.itemsCount) || 0), 1);
  return Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds / itemsCount : null;
}

function eventStationId(event) {
  return normalizeText(event?.stationId ?? event?.assignedStationId ?? event?.station);
}

function eventUserId(event) {
  return normalizeText(event?.operatorUserId ?? event?.userId ?? event?.username ?? event?.operatorName);
}

function sortHistoryAsc(history) {
  return [...history].sort((a, b) => {
    const left = Date.parse(String(a?.completedAt ?? a?.createdAt ?? ""));
    const right = Date.parse(String(b?.completedAt ?? b?.createdAt ?? ""));
    return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
  });
}

function lastSamples(history, maxSamples) {
  const safeMax = Math.max(Math.trunc(Number(maxSamples) || 0), 1);
  return sortHistoryAsc(history).slice(-safeMax);
}

function averageSeconds(events, maxSamples) {
  const values = lastSamples(events, maxSamples)
    .map(eventSecondsPerItem)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return { avgSecondsPerItem: null, samples: 0 };
  const total = values.reduce((sum, value) => sum + value, 0);
  return { avgSecondsPerItem: total / values.length, samples: values.length };
}

function dimensionMatches(event, dimensionKey) {
  const type = String(dimensionKey?.type ?? "").trim();
  if (type === "global") return true;
  if (type === "station") return normalizeKey(eventStationId(event)) === normalizeKey(dimensionKey.stationId);
  if (type === "user") return normalizeKey(eventUserId(event)) === normalizeKey(dimensionKey.userId);
  if (type === "stationUser") {
    return (
      normalizeKey(eventStationId(event)) === normalizeKey(dimensionKey.stationId) &&
      normalizeKey(eventUserId(event)) === normalizeKey(dimensionKey.userId)
    );
  }
  return false;
}

export function classifyTimingEvent(event, context = {}) {
  const config = configWithDefaults(context.config);
  const secondsPerItem = eventSecondsPerItem(event);
  if (!Number.isFinite(secondsPerItem) || secondsPerItem <= 0) {
    return { isTimingAnomaly: true, anomalyReason: "invalid_duration" };
  }
  if (secondsPerItem < config.minSecondsPerItemBeforeAnomaly) {
    return { isTimingAnomaly: true, anomalyReason: "too_fast" };
  }
  if (secondsPerItem > config.maxSecondsPerItemBeforeAnomaly) {
    return { isTimingAnomaly: true, anomalyReason: "too_slow" };
  }

  const average = Number(context.averageSecondsPerItem);
  const samples = Math.trunc(Number(context.sampleCount) || 0);
  if (
    Number.isFinite(average) &&
    average > 0 &&
    samples >= config.anomalyReliableSampleCount &&
    secondsPerItem > average * config.anomalyDistanceMultiplier
  ) {
    return { isTimingAnomaly: true, anomalyReason: "far_from_average" };
  }

  return { isTimingAnomaly: false, anomalyReason: "" };
}

export function isRecurringTimingAnomaly(history, dimensionKey, configInput = {}) {
  const config = configWithDefaults(configInput);
  const relevant = lastSamples(
    history.filter((event) => dimensionMatches(event, dimensionKey)),
    20
  );
  if (relevant.length === 0) return false;
  const last10 = relevant.slice(-10);
  const last20 = relevant.slice(-20);
  const anomalies10 = last10.filter((event) => event?.isTimingAnomaly === true).length;
  const anomalies20 = last20.filter((event) => event?.isTimingAnomaly === true).length;
  return (
    anomalies10 >= config.recurringAnomalyLast10Count ||
    (last20.length >= 10 && anomalies20 / last20.length >= config.recurringAnomalyLast20Ratio)
  );
}

export function shouldIncludeTimingInOperationalAverage(event, context = {}) {
  if (!event || typeof event !== "object") return false;
  if (event.includedInOperationalAverage === true) return true;
  if (event.includedInOperationalAverage === false && event.isTimingAnomaly !== true) return false;
  if (event.isTimingAnomaly !== true) return true;

  const history = Array.isArray(context.history) ? context.history : [];
  const config = configWithDefaults(context.config);
  const dimensions = [
    { type: "station", stationId: eventStationId(event) },
    { type: "user", userId: eventUserId(event) },
    { type: "stationUser", stationId: eventStationId(event), userId: eventUserId(event) },
  ];
  return dimensions.some((dimension) => isRecurringTimingAnomaly(history, dimension, config));
}

export function getHistoricalAverages(state, options = {}) {
  const config = configWithDefaults(options.config);
  const history = historyList(state).filter((event) =>
    shouldIncludeTimingInOperationalAverage(event, { history: historyList(state), config })
  );
  const global = averageSeconds(history, config.maxHistorySamplesGlobal);
  const byStation = new Map();
  const byUser = new Map();
  const byStationUser = new Map();

  for (const event of history) {
    const stationId = eventStationId(event);
    const userId = eventUserId(event);
    if (stationId) {
      const key = normalizeKey(stationId);
      byStation.set(key, [...(byStation.get(key) ?? []), event]);
    }
    if (userId) {
      const key = normalizeKey(userId);
      byUser.set(key, [...(byUser.get(key) ?? []), event]);
    }
    if (stationId && userId) {
      const key = stationUserKey(stationId, userId);
      byStationUser.set(key, [...(byStationUser.get(key) ?? []), event]);
    }
  }

  return {
    global,
    byStation: new Map(
      [...byStation.entries()].map(([key, events]) => [
        key,
        averageSeconds(events, config.maxHistorySamplesStation),
      ])
    ),
    byUser: new Map(
      [...byUser.entries()].map(([key, events]) => [
        key,
        averageSeconds(events, config.maxHistorySamplesUser),
      ])
    ),
    byStationUser: new Map(
      [...byStationUser.entries()].map(([key, events]) => [
        key,
        averageSeconds(events, config.maxHistorySamplesStationUser),
      ])
    ),
  };
}

function resolveAverage(averages, kind, key) {
  if (kind === "global") return averages?.global ?? { avgSecondsPerItem: null, samples: 0 };
  return averages?.[kind]?.get(normalizeKey(key)) ?? { avgSecondsPerItem: null, samples: 0 };
}

function hasSamples(average, minSamples) {
  return (
    average &&
    Number.isFinite(Number(average.avgSecondsPerItem)) &&
    Number(average.avgSecondsPerItem) > 0 &&
    Math.trunc(Number(average.samples) || 0) >= minSamples
  );
}

export function estimateSecondsPerItem(context = {}) {
  const config = configWithDefaults(context.config);
  const averages = context.averages ?? getHistoricalAverages(context.state ?? {}, { config });
  const stationId = normalizeText(context.stationId);
  const userId = normalizeText(context.userId);
  const global = resolveAverage(averages, "global");
  const station = resolveAverage(averages, "byStation", stationId);
  const user = resolveAverage(averages, "byUser", userId);
  const stationUser = averages?.byStationUser?.get(stationUserKey(stationId, userId)) ?? {
    avgSecondsPerItem: null,
    samples: 0,
  };

  const globalValue = Number(global.avgSecondsPerItem) || config.defaultSecondsPerItem;
  const stationOk = hasSamples(station, config.minSamplesForStation);
  const userOk = hasSamples(user, config.minSamplesForUser);
  const stationUserOk = hasSamples(stationUser, config.minSamplesForStationUser);

  if (stationUserOk && stationOk && userOk) {
    return (
      Number(stationUser.avgSecondsPerItem) * 0.5 +
      Number(station.avgSecondsPerItem) * 0.25 +
      Number(user.avgSecondsPerItem) * 0.2 +
      globalValue * 0.05
    );
  }
  if (stationOk && userOk) {
    return Number(station.avgSecondsPerItem) * 0.45 + Number(user.avgSecondsPerItem) * 0.4 + globalValue * 0.15;
  }
  if (stationOk) {
    return Number(station.avgSecondsPerItem) * 0.7 + globalValue * 0.3;
  }
  if (userOk) {
    return Number(user.avgSecondsPerItem) * 0.7 + globalValue * 0.3;
  }
  return config.defaultSecondsPerItem;
}

export function estimateOrderSeconds(order, context = {}) {
  const config = configWithDefaults(context.config);
  const itemsCount = Math.max(countOrderItems(order, context), 1);
  const weightedSecondsPerItem = estimateSecondsPerItem(context);
  return config.baseOrderOverheadSeconds + itemsCount * weightedSecondsPerItem;
}

function orderAssignedStation(order) {
  return (
    normalizeText(order?.assignedStationId) ||
    normalizeText(order?.ownerStation) ||
    normalizeText(order?.station)
  );
}

function isOrderStarted(order) {
  return (
    STARTED_WORKFLOWS.has(normalizeWorkflow(order?.workflowStatus)) ||
    normalizeText(order?.preparationStartedAt).length > 0 ||
    normalizeText(order?.lockedByStationId).length > 0
  );
}

function isOpenWorkloadOrder(order) {
  if (COMPLETED_WORKFLOWS.has(normalizeWorkflow(order?.workflowStatus))) return false;
  if (normalizeText(order?.paymentStatus).toLowerCase() === "paid") return false;
  const dueAmount = Number(order?.dueAmount);
  return !(Number.isFinite(dueAmount) && dueAmount <= 0.009);
}

export function estimateStationWorkload(state, stationId, options = {}) {
  const stationKey = normalizeKey(stationId);
  const stationCandidate = options.stationCandidate && typeof options.stationCandidate === "object"
    ? options.stationCandidate
    : null;
  const operator = stationCandidate
    ? {
        userId: normalizeText(stationCandidate.operatorUserId ?? stationCandidate.userId),
        username: normalizeText(stationCandidate.operatorUsername ?? stationCandidate.username),
        displayName: normalizeText(stationCandidate.operatorName ?? stationCandidate.operator),
      }
    : getStationOperator(state, stationId);
  const averages = options.averages ?? getHistoricalAverages(state, options);
  let stationWorkloadSeconds = 0;
  let ordersCount = 0;
  let itemsCount = 0;

  for (const order of orderList(state)) {
    if (!order || typeof order !== "object") continue;
    if (!isOpenWorkloadOrder(order)) continue;
    if (normalizeKey(orderAssignedStation(order)) !== stationKey) continue;
    const remainingItems = Math.max(countOrderItems(order, { remainingOnly: true }), 1);
    itemsCount += remainingItems;
    ordersCount += 1;
    stationWorkloadSeconds += estimateOrderSeconds(order, {
      ...options,
      averages,
      stationId,
      userId: operator.userId || operator.username || operator.displayName,
      remainingOnly: true,
    });
  }

  return { stationId: normalizeText(stationId), stationWorkloadSeconds, ordersCount, itemsCount };
}

export function chooseBestStationForOrder(state, order, options = {}) {
  const isStationEligible =
    typeof options.isStationEligible === "function" ? options.isStationEligible : null;
  const candidates = getActiveStations(state, options).filter((station) =>
    isStationEligible ? isStationEligible(station, order) : true
  );
  if (candidates.length === 0) {
    return {
      station: null,
      stationId: null,
      reason: isStationEligible ? "no_eligible_active_station" : "no_active_station",
      candidates: [],
    };
  }

  const averages = options.averages ?? getHistoricalAverages(state, options);
  const scored = candidates.map((station) => {
    const stationId = normalizeText(station.station);
    const workload = estimateStationWorkload(state, stationId, {
      ...options,
      averages,
      stationCandidate: station,
    });
    const operator = {
      userId: normalizeText(station.operatorUserId ?? station.userId),
      username: normalizeText(station.operatorUsername ?? station.username),
      displayName: normalizeText(station.operatorName ?? station.operator),
    };
    const orderSeconds = estimateOrderSeconds(order, {
      ...options,
      averages,
      stationId,
      userId: operator.userId || operator.username || operator.displayName,
    });
    const stationWorkloadSeconds = workload.stationWorkloadSeconds;
    return {
      station,
      stationId,
      orderSeconds,
      stationWorkloadSeconds,
      scoreSeconds: stationWorkloadSeconds + orderSeconds,
      ordersCount: workload.ordersCount,
      itemsCount: workload.itemsCount,
      updatedAtMs: Number(station.updatedAtMs) || 0,
      operatorUserId: normalizeText(station.operatorUserId ?? station.userId),
      operatorUsername: normalizeText(station.operatorUsername ?? station.username),
      operatorName: normalizeText(station.operatorName ?? station.operator),
      deviceUuid: normalizeText(station.deviceUuid),
      clientApp: normalizeText(station.clientApp),
    };
  });

  const spreadStationIds = [...new Set(scored.map((entry) => entry.stationId).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "it", { sensitivity: "base" }));
  const spreadOffset = spreadStationIds.length > 0
    ? resolveOrderSpreadSeed(order) % spreadStationIds.length
    : 0;
  const spreadRank = (entry) => {
    if (spreadStationIds.length <= 1) return 0;
    const index = spreadStationIds.indexOf(entry.stationId);
    if (index < 0) return spreadStationIds.length;
    return (index - spreadOffset + spreadStationIds.length) % spreadStationIds.length;
  };

  scored.sort((left, right) => {
    if (left.ordersCount !== right.ordersCount) return left.ordersCount - right.ordersCount;
    if (left.itemsCount !== right.itemsCount) return left.itemsCount - right.itemsCount;
    const leftSpreadRank = spreadRank(left);
    const rightSpreadRank = spreadRank(right);
    if (leftSpreadRank !== rightSpreadRank) return leftSpreadRank - rightSpreadRank;
    if (left.updatedAtMs !== right.updatedAtMs) return left.updatedAtMs - right.updatedAtMs;
    const leftIdentity = stationOperatorIdentity(left.station);
    const rightIdentity = stationOperatorIdentity(right.station);
    if (leftIdentity !== rightIdentity) {
      return leftIdentity.localeCompare(rightIdentity, "it", { sensitivity: "base" });
    }
    return left.stationId.localeCompare(right.stationId, "it", { sensitivity: "base" });
  });

  return {
    station: scored[0].station,
    stationId: scored[0].stationId,
    reason: "least_estimated_workload",
    candidates: scored,
  };
}

function canAutoMoveOrder(order, stationId) {
  if (!order || typeof order !== "object") return false;
  if (normalizeKey(orderAssignedStation(order)) !== normalizeKey(stationId)) return false;
  if (isOrderStarted(order)) return false;
  if (COMPLETED_WORKFLOWS.has(normalizeWorkflow(order.workflowStatus))) return false;
  if (normalizeText(order.manuallyTransferredAt)) return false;
  if (order.assignmentReason === "manual_transfer") return false;
  return true;
}

export function rerouteOrderOperationalStation(order, stationId) {
  const targetStation = normalizeText(stationId);
  if (!order || typeof order !== "object" || !targetStation || isOrderStarted(order)) {
    return order;
  }

  order.station = targetStation;
  order.assignedStationId = targetStation;
  if (Array.isArray(order.items)) {
    order.items = order.items.map((item) =>
      item && typeof item === "object"
        ? {
            ...item,
            routeStations: [targetStation],
          }
        : item
    );
  }
  if (Array.isArray(order.tickets)) {
    order.tickets = order.tickets.map((ticket) =>
      ticket && typeof ticket === "object"
        ? {
            ...ticket,
            stationId: targetStation,
          }
        : ticket
    );
  }
  if (Array.isArray(order.lineRoutes)) {
    order.lineRoutes = order.lineRoutes.map((route) =>
      route && typeof route === "object"
        ? {
            ...route,
            stationId: targetStation,
          }
        : route
    );
  }
  return order;
}

function assignOrderToStation(order, stationId, reason, options = {}) {
  const now = normalizeText(options.nowIso) || new Date().toISOString();
  const previousStation = orderAssignedStation(order);
  order.assignedStationId = stationId || null;
  order.station = stationId || order.station;
  order.ownerStation = isOrderStarted(order) ? order.ownerStation : null;
  order.assignmentReason = reason;
  order.updatedAt = now;
  if (reason === "auto") {
    order.originalAssignedStationId = stationId || null;
  } else if (reason === "pause_redistribution") {
    order.originalAssignedStationId = order.originalAssignedStationId || previousStation || stationId || null;
  } else if (!order.originalAssignedStationId) {
    order.originalAssignedStationId = previousStation || stationId || null;
  }
  if (reason !== "manual_transfer") {
    order.manuallyTransferredAt = null;
  }
  if (reason !== "manual_transfer") {
    rerouteOrderOperationalStation(order, stationId);
  }
  return order;
}

export function rebalanceOrdersForPausedStation(state, stationId, options = {}) {
  const movedOrders = [];
  const normalizedStationId = normalizeText(stationId);
  for (const order of orderList(state)) {
    if (!canAutoMoveOrder(order, normalizedStationId)) continue;
    const previousStation = orderAssignedStation(order);
    const choice = chooseBestStationForOrder(state, order, {
      ...options,
      excludeStationIds: [...(options.excludeStationIds ?? []), normalizedStationId],
    });
    const targetStation = choice.stationId;
    if (!targetStation || normalizeKey(targetStation) === normalizeKey(previousStation)) continue;
    assignOrderToStation(order, targetStation, "pause_redistribution", options);
    order.originalAssignedStationId = order.originalAssignedStationId || previousStation;
    order.preparationStartedAt = null;
    movedOrders.push({ orderId: order.id, fromStation: previousStation, toStation: targetStation });
  }
  return movedOrders;
}

export function restoreOrdersForReturnedStation(state, stationId, options = {}) {
  const restoredOrders = [];
  const normalizedStationId = normalizeText(stationId);
  for (const order of orderList(state)) {
    if (!order || typeof order !== "object") continue;
    if (normalizeKey(order.originalAssignedStationId) !== normalizeKey(normalizedStationId)) continue;
    if (order.assignmentReason !== "pause_redistribution") continue;
    if (isOrderStarted(order)) continue;
    if (normalizeText(order.manuallyTransferredAt)) continue;
    assignOrderToStation(order, normalizedStationId, "restore_after_pause", options);
    restoredOrders.push({ orderId: order.id, toStation: normalizedStationId });
  }
  return restoredOrders;
}
