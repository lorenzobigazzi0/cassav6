export const V5BT_MAX_IN_FLIGHT_PER_DEVICE = 2;
export const V5BT_MAX_IN_FLIGHT_GLOBAL = 60;
export const V5BT_ACTION_P95_MAX_MS = 3_000;
export const V5BT_COMMAND_P95_MAX_MS = 8_000;
export const V5BT_ACTION_MAX_MS = 30_000;
export const V5BT_GUI_HOT_READ_BASE_BUDGET = 10;
export const V5BT_GUI_HOT_READS_PER_ACTION_BUDGET = 2;
export const V5BT_BATTERY_NOTIFICATION_INTERVAL_MS = 120_000;

const HOT_READ_ROUTES = Object.freeze([
  "GET /api/integration/layout",
  "GET /api/integration/orders",
]);

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function summarizeV5btGuiRequestTraffic(
  guiDiagnostics,
  actionsPerDevice,
  {
    baseBudget = V5BT_GUI_HOT_READ_BASE_BUDGET,
    readsPerActionBudget = V5BT_GUI_HOT_READS_PER_ACTION_BUDGET,
  } = {},
) {
  const diagnostics = Array.isArray(guiDiagnostics) ? guiDiagnostics : [];
  const perRoutePerGuiBudget = Math.max(
    0,
    Math.trunc(finiteNumber(baseBudget)) +
      Math.max(0, Math.trunc(finiteNumber(actionsPerDevice))) *
        Math.max(0, finiteNumber(readsPerActionBudget)),
  );
  const devices = diagnostics.map((entry, index) => {
    const requestsByRoute = entry?.requestsByRoute && typeof entry.requestsByRoute === "object"
      ? entry.requestsByRoute
      : {};
    const hotReads = Object.fromEntries(HOT_READ_ROUTES.map((route) => [
      route,
      Math.max(0, Math.trunc(finiteNumber(requestsByRoute[route]))),
    ]));
    const exceededRoutes = HOT_READ_ROUTES.filter(
      (route) => hotReads[route] > perRoutePerGuiBudget,
    );
    return {
      kind: String(entry?.kind || "gui"),
      index: Number.isInteger(entry?.index) ? entry.index : index,
      requests: Math.max(0, Math.trunc(finiteNumber(entry?.requests))),
      requestFailures: Math.max(0, Math.trunc(finiteNumber(entry?.requestFailures))),
      responses5xx: Math.max(0, Math.trunc(finiteNumber(entry?.responses5xx))),
      consoleErrors: Math.max(0, Math.trunc(finiteNumber(entry?.consoleErrors))),
      hotReads,
      exceededRoutes,
      ok:
        exceededRoutes.length === 0 &&
        finiteNumber(entry?.requestFailures) === 0 &&
        finiteNumber(entry?.responses5xx) === 0 &&
        finiteNumber(entry?.consoleErrors) === 0,
    };
  });
  return {
    hotReadRoutes: HOT_READ_ROUTES,
    perRoutePerGuiBudget,
    devices,
    totalHotReads: Object.fromEntries(HOT_READ_ROUTES.map((route) => [
      route,
      devices.reduce((sum, device) => sum + device.hotReads[route], 0),
    ])),
    ok: devices.length > 0 && devices.every((device) => device.ok),
  };
}

export function evaluateV5btOperationsRuntimeGate({
  profile,
  commandLatencyMs,
  guiDiagnostics,
  actionsPerDevice,
  maxInFlightPerDevice = V5BT_MAX_IN_FLIGHT_PER_DEVICE,
  maxInFlightGlobal = V5BT_MAX_IN_FLIGHT_GLOBAL,
  actionP95MaxMs = V5BT_ACTION_P95_MAX_MS,
  commandP95MaxMs = V5BT_COMMAND_P95_MAX_MS,
  actionMaxMs = V5BT_ACTION_MAX_MS,
  guiBaseBudget = V5BT_GUI_HOT_READ_BASE_BUDGET,
  guiReadsPerActionBudget = V5BT_GUI_HOT_READS_PER_ACTION_BUDGET,
} = {}) {
  const devices = Array.isArray(profile?.devices) ? profile.devices : [];
  const perDeviceViolations = devices
    .filter((device) => finiteNumber(device?.maximumInFlight) > maxInFlightPerDevice)
    .map((device) => ({
      deviceId: String(device?.id || "unknown"),
      maximumInFlight: finiteNumber(device?.maximumInFlight),
    }));
  const guiRequestTraffic = summarizeV5btGuiRequestTraffic(
    guiDiagnostics,
    actionsPerDevice,
    {
      baseBudget: guiBaseBudget,
      readsPerActionBudget: guiReadsPerActionBudget,
    },
  );
  const checks = {
    noEarlyActionBursts: finiteNumber(profile?.cadence?.earlyActionGaps, -1) === 0,
    noEarlyDispatchActionBursts:
      finiteNumber(profile?.cadence?.earlyDispatchActionGaps, -1) === 0,
    globalInFlightWithinLimit:
      finiteNumber(profile?.maximumInFlight, Number.POSITIVE_INFINITY) <= maxInFlightGlobal,
    perDeviceInFlightWithinLimit: perDeviceViolations.length === 0,
    actionP95WithinLimit:
      finiteNumber(profile?.actionLatencyMs?.p95ms, Number.POSITIVE_INFINITY) <= actionP95MaxMs,
    commandP95WithinLimit:
      finiteNumber(commandLatencyMs?.p95ms, Number.POSITIVE_INFINITY) <= commandP95MaxMs,
    actionMaximumWithinLimit:
      finiteNumber(profile?.actionLatencyMs?.maxMs, Number.POSITIVE_INFINITY) <= actionMaxMs,
    guiRequestBudgetWithinLimit: guiRequestTraffic.ok,
  };
  return {
    limits: {
      maxInFlightPerDevice,
      maxInFlightGlobal,
      actionP95MaxMs,
      commandP95MaxMs,
      actionMaxMs,
      guiHotReadBaseBudget: guiBaseBudget,
      guiHotReadsPerActionBudget: guiReadsPerActionBudget,
    },
    checks,
    perDeviceViolations,
    commandLatencyMs: commandLatencyMs || null,
    guiRequestTraffic,
    ok: Object.values(checks).every(Boolean),
  };
}

export function evaluateV5btPersistedOrderTarget({
  handheldDeviceIds,
  persistedOrdersByDevice,
  targetPerHandheld,
} = {}) {
  const ids = Array.isArray(handheldDeviceIds)
    ? [...new Set(handheldDeviceIds.map((value) => String(value || "").trim()).filter(Boolean))]
    : [];
  const counts = persistedOrdersByDevice && typeof persistedOrdersByDevice === "object"
    ? persistedOrdersByDevice
    : {};
  const target = Math.max(0, Math.trunc(finiteNumber(targetPerHandheld)));
  const devices = ids.map((deviceId) => {
    const observed = Math.max(0, Math.trunc(finiteNumber(counts[deviceId])));
    return { deviceId, observed, target, ok: observed === target };
  });
  return {
    targetPerHandheld: target,
    devices,
    devicesMeetingTarget: devices.filter((device) => device.ok).length,
    missingOrders: devices.reduce((sum, device) => sum + Math.max(0, target - device.observed), 0),
    duplicateOrders: devices.reduce((sum, device) => sum + Math.max(0, device.observed - target), 0),
    ok: devices.length > 0 && devices.every((device) => device.ok),
  };
}
