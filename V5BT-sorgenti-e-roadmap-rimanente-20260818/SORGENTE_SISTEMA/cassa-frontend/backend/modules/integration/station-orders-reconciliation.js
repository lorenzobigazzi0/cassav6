function cursorText(value) {
  return String(value ?? "").trim();
}

function cursorTimestamp(value) {
  const raw = value ?? "";
  if (typeof raw === "number" && Number.isFinite(raw)) return String(Math.trunc(raw));
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? String(parsed) : cursorText(raw);
}

function buildOrderRouteCursor(order) {
  const routes = Array.isArray(order?.lineRoutes) ? order.lineRoutes : [];
  if (routes.length === 0) return "";
  return routes
    .map((route, index) =>
      [
        cursorText(route?.lineId) || String(index),
        cursorText(route?.stationId),
        cursorText(route?.status),
        cursorTimestamp(route?.updatedAt ?? route?.assignedAt ?? route?.readyAt),
      ].join(":"),
    )
    .sort()
    .join(",");
}

function buildOrderItemsCursor(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  if (items.length === 0) return "";
  return items
    .map((item, index) =>
      [
        cursorText(item?.lineId ?? item?.id) || String(index),
        cursorText(item?.productId ?? item?.sku ?? item?.name),
        cursorText(item?.quantity ?? item?.qty),
        cursorText(item?.voidedAt),
        cursorText(item?.correctionStatus),
      ].join(":"),
    )
    .sort()
    .join(",");
}

export function buildStationOrdersPollReconciliationCursor(orders) {
  const safeOrders = Array.isArray(orders) ? orders : [];
  if (safeOrders.length === 0) return "orders:empty";
  return safeOrders
    .map((order, index) => {
      if (!order || typeof order !== "object") return `invalid:${index}`;
      return [
        cursorText(order.id ?? order.orderId) || String(index),
        cursorTimestamp(order.updatedAtMs ?? order.updatedAt ?? order.receivedAtMs),
        cursorText(order.workflowStatus),
        cursorText(order.paymentStatus),
        cursorText(order.assignmentStatus),
        cursorText(order.assignedStationId ?? order.station),
        cursorText(order.ownerStation),
        cursorText(order.lockedByStationId),
        cursorText(order.lockStatus),
        buildOrderRouteCursor(order),
        buildOrderItemsCursor(order),
      ].join("|");
    })
    .sort()
    .join("\n");
}

export function applyStationOrdersPollReconciliation(db, options = {}) {
  const {
    assignQueuedUnassignedIntegrationOrders,
    backfillStationOperatorAssignments,
    reconcileIntegrationPreparationQueue,
    station,
    source = "orders_poll_reconciliation",
  } = options;
  if (!station) {
    return { changed: false, changedOrderIds: [], assignedPendingOrders: [], assignedOperatorOrders: [], queuePromotions: [], pruned: false };
  }
  const assignedPendingOrders =
    assignQueuedUnassignedIntegrationOrders?.(db, { station, source }) ?? [];
  const assignedOperatorOrders = backfillStationOperatorAssignments?.(db, { station }) ?? [];
  const queuePromotions = reconcileIntegrationPreparationQueue?.(db, { station, source }) ?? [];
  const changedOrderIds = [
    ...assignedPendingOrders,
    ...assignedOperatorOrders,
    ...queuePromotions,
  ].reduce((ids, entry) => {
    const orderId = String(entry?.orderId ?? entry?.id ?? "").trim();
    if (orderId && !ids.includes(orderId)) ids.push(orderId);
    return ids;
  }, []);
  return {
    changed:
      assignedPendingOrders.length > 0 ||
      assignedOperatorOrders.length > 0 ||
      queuePromotions.length > 0,
    changedOrderIds,
    assignedPendingOrders,
    assignedOperatorOrders,
    queuePromotions,
    pruned: false,
  };
}

export function createStationOrdersPollReconciliationScheduler(options = {}) {
  const pending = new Set();
  const lastScheduledAtByStation = new Map();
  const lastCompletedVersionByStation = new Map();
  const latestRequestedVersionByStation = new Map();
  const deferredTimerByStation = new Map();
  const logger = options.logger ?? console;
  const minIntervalMs = Math.max(0, Math.trunc(Number(options.minIntervalMs ?? 1_000)));
  const backpressureDelayMs = Math.max(
    0,
    Math.trunc(Number(options.backpressureDelayMs ?? 1_500)),
  );
  const deferInitialSchedule = options.deferInitialSchedule === true;

  function normalizeVersion(value) {
    return String(value ?? "").trim();
  }

  function shouldSkipAlreadyReconciled(station, version, force) {
    return (
      !force &&
      version &&
      normalizeVersion(lastCompletedVersionByStation.get(station)) === version
    );
  }

  let scheduleStationOrdersPollReconciliation = null;

  function deferForBackpressure(station) {
    if (deferredTimerByStation.has(station)) return false;
    const timer = setTimeout(() => {
      deferredTimerByStation.delete(station);
      const latestRequestedVersion = normalizeVersion(
        latestRequestedVersionByStation.get(station),
      );
      scheduleStationOrdersPollReconciliation?.(station, {
        stateVersion: latestRequestedVersion,
        deferred: true,
      });
    }, backpressureDelayMs);
    deferredTimerByStation.set(station, timer);
    return false;
  }

  scheduleStationOrdersPollReconciliation = function scheduleStationOrdersPollReconciliationFn(stationRaw, context = {}) {
    const station = String(options.normalizeStation?.(stationRaw) ?? stationRaw ?? "").trim();
    if (!station) return false;
    const stateVersion = normalizeVersion(
      context.stateVersion ?? context.version ?? context.lastWriteAt,
    );
    const force = context.force === true;
    if (shouldSkipAlreadyReconciled(station, stateVersion, force)) return false;
    latestRequestedVersionByStation.set(station, stateVersion);
    if (!force && !context.deferred && deferInitialSchedule) {
      return deferForBackpressure(station);
    }
    if (
      !force &&
      options.isBackpressureActive?.(station, context) === true
    ) {
      return deferForBackpressure(station);
    }
    const deferredTimer = deferredTimerByStation.get(station);
    if (deferredTimer) {
      clearTimeout(deferredTimer);
      deferredTimerByStation.delete(station);
    }
    if (pending.has(station)) return false;
    const nowMs = Date.now();
    const lastScheduledAt = Number(lastScheduledAtByStation.get(station)) || 0;
    if (!force && minIntervalMs > 0 && nowMs - lastScheduledAt < minIntervalMs) return false;
    lastScheduledAtByStation.set(station, nowMs);
    pending.add(station);
    const scheduledVersion = stateVersion;
    let shouldPreserveHotCaches = true;
    const run = async () => {
      const db = await options.readDb?.({ preferCache: true });
      const result = applyStationOrdersPollReconciliation(db, { ...options, station });
      if (result.changed) {
        if (result.changedOrderIds.length === 0) {
          throw new Error("Riconciliazione ordini senza ID persistibili.");
        }
        shouldPreserveHotCaches = false;
        const now = options.nowIso?.() ?? new Date().toISOString();
        if (!db.meta || typeof db.meta !== "object") db.meta = {};
        if (!db.integration || typeof db.integration !== "object") db.integration = {};
        db.integration.lastWriteAt = now;
        db.meta.lastWriteAt = now;
        await options.writeIntegrationOrderEntriesDb?.(db, {
          orderIds: result.changedOrderIds,
          integrationObjectFields: ["lastWriteAt"],
          skipAudit: true,
          skipPrintSpool: true,
          metricLabel: "orders.stationReconciliation.appStateWrite",
        });
      }
      if (scheduledVersion) {
        lastCompletedVersionByStation.set(station, scheduledVersion);
      }
      return result;
    };
    Promise.resolve(
      options.enqueueMutation?.("GET /api/integration/orders station reconciliation", `station:${station}`, run, {
        shouldPreserveHotCaches: () => shouldPreserveHotCaches,
      }) ?? run(),
    )
      .catch((error) => logger.warn?.(`[station-orders] riconciliazione saltata: ${error?.message || error}`))
      .finally(() => {
        pending.delete(station);
        const latestRequestedVersion = normalizeVersion(latestRequestedVersionByStation.get(station));
        if (
          latestRequestedVersion &&
          latestRequestedVersion !== scheduledVersion &&
          !shouldSkipAlreadyReconciled(station, latestRequestedVersion, false)
        ) {
          scheduleStationOrdersPollReconciliation(station, {
            stateVersion: latestRequestedVersion,
            force: true,
          });
        }
      });
    return true;
  };
  return scheduleStationOrdersPollReconciliation;
}
