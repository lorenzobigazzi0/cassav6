export const ROUTE_HEALTH_SLA_MS = 5_000;
export const ROUTE_HEALTH_OPERATIONAL_BUDGET_MS = 4_750;
export const BACKEND_HEALTH_PROBE_TIMEOUT_MS = 900;
export const LE_ADVERTISEMENT_DBUS_OPERATION_TIMEOUT_MS = 350;
export const LE_ADVERTISEMENT_REPLACEMENT_OPERATIONS = 2;
export const ROUTE_HEALTH_SCHEDULING_MARGIN_MS = 150;
export const LE_ADVERTISEMENT_HEALTH_FRESHNESS_MS = 3_500;

export function routeHealthWorstCaseMs(input: Readonly<{
  transportTickIntervalMs: number;
  backendHealthIntervalMs: number;
}>): number {
  return (
    input.transportTickIntervalMs +
    input.backendHealthIntervalMs +
    BACKEND_HEALTH_PROBE_TIMEOUT_MS +
    LE_ADVERTISEMENT_DBUS_OPERATION_TIMEOUT_MS *
      LE_ADVERTISEMENT_REPLACEMENT_OPERATIONS +
    ROUTE_HEALTH_SCHEDULING_MARGIN_MS
  );
}
