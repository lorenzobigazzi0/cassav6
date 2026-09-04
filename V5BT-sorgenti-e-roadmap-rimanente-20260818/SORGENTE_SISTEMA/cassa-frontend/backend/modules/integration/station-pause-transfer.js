function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeUsername(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeStation(value) {
  return normalizeText(value).toUpperCase();
}

export function normalizeStationPauseTransferMode(payload = {}) {
  const mode = normalizeUsername(
    payload.pauseTransferMode ?? payload.transferMode ?? payload.queueTransferMode ?? payload.pausedQueueMode
  );
  if (["transfer", "redistribute", "move", "sposta", "trasferisci"].includes(mode)) {
    return "transfer";
  }
  if (
    payload.transferOrders === true ||
    payload.redistributeOrders === true ||
    payload.transferQueue === true ||
    payload.redistributeQueue === true
  ) {
    return "transfer";
  }
  return "suspend";
}

export function stationPauseOperatorKey(source = {}) {
  const userId = normalizeText(source.operatorUserId ?? source.userId ?? source.assignedStationOperatorUserId);
  if (userId) return `user:${userId}`;
  const username = normalizeUsername(
    source.operatorUsername ?? source.username ?? source.assignedStationOperatorUsername
  );
  if (username) return `username:${username}`;
  const deviceUuid = normalizeText(source.deviceUuid ?? source.assignedStationDeviceUuid);
  if (deviceUuid) return `device:${deviceUuid}`;
  const name = normalizeUsername(source.operatorName ?? source.operator ?? source.assignedStationOperatorName);
  return name ? `name:${name}` : "";
}

export function stationPauseEntryKey(source = {}) {
  const station = normalizeStation(source.station ?? source.assignedStationId);
  const operatorKey = stationPauseOperatorKey(source);
  return station && operatorKey ? `${station}::${operatorKey}` : "";
}

function hasTransferableStationOperator(source = {}) {
  const userId = normalizeText(source.operatorUserId ?? source.userId ?? source.assignedStationOperatorUserId);
  if (userId) return true;
  const username = normalizeUsername(
    source.operatorUsername ?? source.username ?? source.assignedStationOperatorUsername
  );
  if (username && !["guest", "ospite", "non autenticato", "non_autenticato"].includes(username)) return true;
  return false;
}

export function isStationPauseTransferDestination(entry = {}) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.active === false || entry.stale === true) return false;
  if (entry.realStation !== true) return false;
  if (entry.isDemoFallback === true || entry.configuredStation === true) return false;
  if (entry.paused === true || entry.onPause === true || entry.isPaused === true) return false;
  const pauseStatus = entry.pauseStatus && typeof entry.pauseStatus === "object" ? entry.pauseStatus : null;
  if (pauseStatus && (pauseStatus.active === true || pauseStatus.status === "paused")) return false;
  const status = normalizeUsername(entry.status ?? entry.stationStatus ?? entry.availability);
  if (["paused", "pausa", "offline", "stale", "inactive", "inattiva"].includes(status)) return false;
  return hasTransferableStationOperator(entry);
}

export function filterStationPauseTransferDestinations(activeStations = [], pausedStation = {}) {
  const pausedKey = stationPauseEntryKey(pausedStation);
  return (Array.isArray(activeStations) ? activeStations : []).filter((entry) => {
    if (!isStationPauseTransferDestination(entry)) return false;
    if (stationPauseEntryKey(entry) && stationPauseEntryKey(entry) === pausedKey) return false;
    return true;
  });
}

export function orderBelongsToPausedStationOperator(order = {}, pausedStation = {}, options = {}) {
  const orderStation = normalizeStation(
    order.assignedStationId ?? order.ownerStation ?? order.lockedByStationId ?? order.station
  );
  const pausedStationName = normalizeStation(pausedStation.station);
  if (!orderStation || !pausedStationName || orderStation !== pausedStationName) return false;

  const orderOperatorKey = stationPauseOperatorKey({
    assignedStationOperatorUserId: order.assignedStationOperatorUserId,
    assignedStationOperatorUsername: order.assignedStationOperatorUsername,
    assignedStationOperatorName: order.assignedStationOperatorName,
    assignedStationDeviceUuid: order.assignedStationDeviceUuid,
  });
  const pausedOperatorKey = stationPauseOperatorKey(pausedStation);
  if (orderOperatorKey && pausedOperatorKey) return orderOperatorKey === pausedOperatorKey;
  if (!orderOperatorKey && options.includeUnassignedStationOrders === true) return true;
  return false;
}

export function canTransferPausedStationQueueOrder(order = {}, options = {}) {
  if (!order || typeof order !== "object") return false;
  if (typeof options.isOrderOpenForOperatorAssignment === "function") {
    if (!options.isOrderOpenForOperatorAssignment(order)) return false;
  }
  const workflow = normalizeUsername(
    typeof options.resolveWorkflowStatus === "function"
      ? options.resolveWorkflowStatus(order)
      : order.workflowStatus
  );
  if (["ready", "delivered", "done", "completed", "cancelled"].includes(workflow)) {
    return false;
  }
  if (workflow === "prep" && options.releaseInProgressOrders !== true) {
    return false;
  }
  if (
    (order.lockStatus === "locked" || order.preparationStartedAt || order.lockedAt) &&
    options.releaseInProgressOrders !== true
  ) {
    return false;
  }
  if (order.manuallyTransferredAt || order.assignmentReason === "manual_transfer") {
    return false;
  }
  return true;
}

function releasePausedStationQueueOrder(order = {}, options = {}) {
  const workflow = normalizeUsername(
    typeof options.resolveWorkflowStatus === "function"
      ? options.resolveWorkflowStatus(order)
      : order.workflowStatus
  );
  return {
    ...order,
    workflowStatus:
      workflow === "prep" && options.releaseInProgressOrders === true
        ? "waiting"
        : order.workflowStatus,
    ownerStation: null,
    ownerOperator: null,
    ownerRole: null,
    ownerAtMs: null,
    preparationStartedAt: null,
    lockedByStationId: null,
    lockedByUserId: "",
    lockedAt: null,
    lockStatus: "unlocked",
  };
}

export function parkPausedStationOperatorQueueOrders(state, options = {}) {
  const integration = state?.integration && typeof state.integration === "object" ? state.integration : state;
  if (!integration || typeof integration !== "object") return [];
  if (!Array.isArray(integration.orders) || integration.orders.length === 0) return [];

  const sanitizeOrder =
    typeof options.sanitizeOrder === "function" ? options.sanitizeOrder : (order) => order;
  const normalizeStationName =
    typeof options.normalizeStationName === "function" ? options.normalizeStationName : normalizeStation;
  const nowIso = typeof options.nowIso === "function" ? options.nowIso : () => new Date().toISOString();
  const station = normalizeStationName(options.station ?? options.pausedStation?.station ?? "");
  const pausedStation =
    options.pausedStation && typeof options.pausedStation === "object" ? options.pausedStation : { station };
  const parked = [];

  integration.orders = integration.orders.map((entry, index) => {
    const current = sanitizeOrder(entry, String(index + 1).padStart(5, "0"));
    if (!canTransferPausedStationQueueOrder(current, options)) return entry;
    if (
      !orderBelongsToPausedStationOperator(current, pausedStation, {
        includeUnassignedStationOrders: options.includeUnassignedStationOrders === true,
      })
    ) {
      return entry;
    }

    const previousStation = normalizeStationName(
      typeof options.getOrderAssignmentStation === "function"
        ? options.getOrderAssignmentStation(current)
        : current.assignedStationId ?? current.station ?? station
    );
    const releasedOrder = releasePausedStationQueueOrder(current, options);
    const queuedOrder = sanitizeOrder(
      {
        ...releasedOrder,
        assignedStationId: null,
        originalAssignedStationId:
          current.originalAssignedStationId || previousStation || station || null,
        assignedStationOperatorUserId: "",
        assignedStationOperatorUsername: "",
        assignedStationOperatorName: "",
        assignedStationDeviceUuid: "",
        assignedStationClientApp: "",
        assignmentReason: "pause_virtual_queue",
        assignmentStatus: "queued_unassigned",
        assignmentReasonDetail: "station_pause_virtual_queue",
        pendingAuthRequest: null,
        updatedAt: nowIso(),
      },
      current.id
    );
    parked.push({
      orderId: queuedOrder.id,
      fromStation: previousStation,
      queue: "virtual",
      reason: "no_active_station",
    });
    return queuedOrder;
  });

  return parked;
}

export function transferPausedStationOperatorQueueOrders(state, options = {}) {
  const integration = state?.integration && typeof state.integration === "object" ? state.integration : state;
  if (!integration || typeof integration !== "object") return [];
  if (!Array.isArray(integration.orders) || integration.orders.length === 0) return [];

  const sanitizeOrder =
    typeof options.sanitizeOrder === "function" ? options.sanitizeOrder : (order) => order;
  const chooseBestStationForOrder =
    typeof options.chooseBestStationForOrder === "function" ? options.chooseBestStationForOrder : null;
  const rerouteOrderOperationalStation =
    typeof options.rerouteOrderOperationalStation === "function"
      ? options.rerouteOrderOperationalStation
      : (order) => order;
  const normalizeStationName =
    typeof options.normalizeStationName === "function" ? options.normalizeStationName : normalizeStation;
  const normalizeClientApp =
    typeof options.normalizeClientApp === "function" ? options.normalizeClientApp : normalizeUsername;
  const nowIso = typeof options.nowIso === "function" ? options.nowIso : () => new Date().toISOString();
  const station = normalizeStationName(options.station ?? options.pausedStation?.station ?? "");
  const pausedStation =
    options.pausedStation && typeof options.pausedStation === "object" ? options.pausedStation : { station };
  const moved = [];

  if (!chooseBestStationForOrder) return moved;
  integration.orders = integration.orders.map((entry, index) => {
    const current = sanitizeOrder(entry, String(index + 1).padStart(5, "0"));
    if (!canTransferPausedStationQueueOrder(current, options)) return entry;
    if (
      !orderBelongsToPausedStationOperator(current, pausedStation, {
        includeUnassignedStationOrders: options.includeUnassignedStationOrders === true,
      })
    ) {
      return entry;
    }

    const previousStation = normalizeStationName(
      typeof options.getOrderAssignmentStation === "function"
        ? options.getOrderAssignmentStation(current)
        : current.assignedStationId ?? current.station ?? station
    );
    const choice = chooseBestStationForOrder(state, current, {
      allowDemoStations: options.allowDemoStations === true,
    });
    if (!choice?.stationId || !choice.station || typeof choice.station !== "object") return entry;

    const targetStation = normalizeStationName(choice.stationId);
    if (!targetStation) return entry;
    const stationChoice = choice.station;
    const releasedOrder = releasePausedStationQueueOrder(current, options);
    const routedOrder = rerouteOrderOperationalStation(
      {
        ...releasedOrder,
        station: targetStation,
        assignedStationId: targetStation,
        originalAssignedStationId: current.originalAssignedStationId || previousStation || station,
        assignedStationOperatorUserId: normalizeText(stationChoice.operatorUserId ?? stationChoice.userId),
        assignedStationOperatorUsername: normalizeText(stationChoice.operatorUsername ?? stationChoice.username),
        assignedStationOperatorName: normalizeText(stationChoice.operatorName ?? stationChoice.operator),
        assignedStationDeviceUuid: normalizeText(stationChoice.deviceUuid),
        assignedStationClientApp: normalizeClientApp(stationChoice.clientApp ?? "postazione"),
        assignmentReason: "pause_redistribution",
        assignmentStatus: "assigned",
        assignmentReasonDetail: "station_pause_transfer",
        updatedAt: nowIso(),
      },
      targetStation
    );
    const nextOrder = sanitizeOrder(routedOrder, current.id);
    moved.push({
      orderId: nextOrder.id,
      fromStation: previousStation,
      toStation: targetStation,
      operatorUserId: nextOrder.assignedStationOperatorUserId,
      operatorUsername: nextOrder.assignedStationOperatorUsername,
      operatorName: nextOrder.assignedStationOperatorName,
      deviceUuid: nextOrder.assignedStationDeviceUuid,
      reason: choice.reason,
    });
    return nextOrder;
  });
  return moved;
}
