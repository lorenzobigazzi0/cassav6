import {
  findConfiguredMenuRoutingWorkstationForStation,
  workstationAllowsMenuRoutingLine,
} from "../menu/index.js";

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function callOrFallback(fn, value, fallback = "") {
  return typeof fn === "function" ? fn(value) : normalizeText(value) || fallback;
}

export function buildOrderCreateStationEligibilityChecker({
  settings,
  menuItemsByName,
  findMenuItemForLine,
} = {}) {
  return (station, order) => {
    const workstation = findConfiguredMenuRoutingWorkstationForStation(
      settings,
      station?.station ?? station,
    );
    if (!workstation) return true;
    const items = Array.isArray(order?.items) ? order.items : [];
    if (items.length === 0) return true;
    return items
      .filter((item) => item && typeof item === "object" && !item.voidedAt)
      .every((item) => {
        const menuItem =
          typeof findMenuItemForLine === "function"
            ? findMenuItemForLine(item, menuItemsByName) ?? {}
            : {};
        return workstationAllowsMenuRoutingLine(workstation, item, menuItem);
      });
  };
}

export function buildOrderCreateAutoAssignmentPlan({
  allowDemoStations = false,
  chooseBestStationForOrder,
  findMenuItemForLine,
  menuItemsByName,
  normalizeClientApp,
  normalizeStation,
  nowIso,
  order,
  settings,
  state,
} = {}) {
  if (typeof chooseBestStationForOrder !== "function") {
    throw new TypeError("chooseBestStationForOrder is required");
  }
  const choice = chooseBestStationForOrder(state, order, {
    allowDemoStations,
    isStationEligible: buildOrderCreateStationEligibilityChecker({
      settings,
      menuItemsByName,
      findMenuItemForLine,
    }),
  });
  const updatedAt = typeof nowIso === "function" ? nowIso() : new Date().toISOString();
  if (!choice?.stationId) {
    return {
      choice,
      changed: true,
      shouldReroute: false,
      targetStationId: null,
      orderPatch: {
        assignedStationId: null,
        originalAssignedStationId: null,
        assignedStationOperatorUserId: "",
        assignedStationOperatorUsername: "",
        assignedStationOperatorName: "",
        assignedStationDeviceUuid: "",
        assignedStationClientApp: "",
        assignmentReason: "auto",
        assignmentStatus: "queued_unassigned",
        assignmentReasonDetail: normalizeText(choice?.reason),
        updatedAt,
      },
    };
  }

  const stationId = callOrFallback(normalizeStation, choice.stationId);
  const stationChoice =
    choice.station && typeof choice.station === "object" ? choice.station : {};
  return {
    choice,
    changed:
      normalizeText(order?.assignedStationId) !== stationId ||
      normalizeText(order?.station) !== stationId,
    shouldReroute: true,
    targetStationId: stationId,
    orderPatch: {
      station: stationId,
      assignedStationId: stationId,
      originalAssignedStationId: stationId,
      assignedStationOperatorUserId: normalizeText(
        stationChoice.operatorUserId ?? choice.operatorUserId,
      ),
      assignedStationOperatorUsername: normalizeText(
        stationChoice.operatorUsername ?? choice.operatorUsername,
      ),
      assignedStationOperatorName: normalizeText(
        stationChoice.operatorName ?? choice.operatorName,
      ),
      assignedStationDeviceUuid: normalizeText(
        stationChoice.deviceUuid ?? choice.deviceUuid,
      ),
      assignedStationClientApp: callOrFallback(
        normalizeClientApp,
        stationChoice.clientApp ?? choice.clientApp ?? "postazione",
      ),
      assignmentReason: "auto",
      assignmentStatus: "assigned",
      assignmentReasonDetail: normalizeText(choice.reason),
      ownerStation: null,
      ownerOperator: null,
      ownerRole: null,
      ownerAtMs: null,
      updatedAt,
    },
  };
}
