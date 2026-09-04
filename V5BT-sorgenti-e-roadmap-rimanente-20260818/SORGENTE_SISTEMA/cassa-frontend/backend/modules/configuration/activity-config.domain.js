function clonePlainObject(value) {
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return cloned && typeof cloned === "object" && !Array.isArray(cloned) ? cloned : {};
  } catch {
    return {};
  }
}

export function createPosActivityConfigHelpers(options = {}) {
  const {
    normalizeConfigId = (value, fallback = "config") => String(value ?? "").trim() || fallback,
    normalizeReferenceIdList = (value) =>
      (Array.isArray(value) ? value : []).map((entry) => normalizeConfigId(entry, "")).filter(Boolean),
    normalizeMenuScheduleRules = () => [],
  } = options;

  function sanitizePosActivityFiscalPolicy(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return clonePlainObject(value);
    }
    const normalized = String(value ?? "").trim().slice(0, 80);
    return normalized || "standard";
  }

  function sanitizePosActivity(entry, fallbackId = "activity") {
    if (!entry || typeof entry !== "object") return null;
    const id = normalizeConfigId(entry.id ?? entry.activityId ?? entry.code, fallbackId);
    const name = String(entry.name ?? entry.label ?? id).trim().slice(0, 80);
    if (!id || !name) return null;
    return {
      id,
      name,
      type: String(entry.type ?? "operational").trim().slice(0, 48) || "operational",
      status: entry.status === "disabled" || entry.enabled === false ? "disabled" : "active",
      fiscalPolicy: sanitizePosActivityFiscalPolicy(entry.fiscalPolicy ?? entry.fiscalPolicyId ?? entry.fiscal),
      fiscalDeviceIds: normalizeReferenceIdList(
        entry.fiscalDeviceIds ?? entry.rtIds ?? entry.fiscalPrinterIds ?? (entry.fiscalPrinterId ? [entry.fiscalPrinterId] : []),
        null,
        16
      ),
      menuIds: normalizeReferenceIdList(entry.menuIds ?? (entry.menuId ? [entry.menuId] : []), null, 32),
      priceListIds: normalizeReferenceIdList(
        entry.priceListIds ?? entry.listinoIds ?? entry.listiniIds ?? (entry.priceListId ? [entry.priceListId] : []),
        null,
        32
      ),
      printerIds: normalizeReferenceIdList(entry.printerIds ?? (entry.printerId ? [entry.printerId] : []), null, 24),
      precontoPrinterIds: normalizeReferenceIdList(
        entry.precontoPrinterIds ??
          entry.receiptPrinterIds ??
          entry.billPrinterIds ??
          (entry.precontoPrinterId ? [entry.precontoPrinterId] : []),
        null,
        24
      ),
      workstationIds: normalizeReferenceIdList(
        entry.workstationIds ?? entry.stationIds ?? (entry.workstationId ? [entry.workstationId] : []),
        null,
        24
      ),
      menuSchedules: normalizeMenuScheduleRules(
        entry.menuSchedules ?? entry.menuSchedule ?? entry.menuScheduleRules,
        "menuIds",
        `${id}_menu_schedule`
      ),
      priceListSchedules: normalizeMenuScheduleRules(
        entry.priceListSchedules ?? entry.priceListSchedule ?? entry.listinoSchedules,
        "priceListIds",
        `${id}_price_list_schedule`
      ),
    };
  }

  function sanitizePosActivityRoomBinding(entry, fallbackId = "activity_room", options = {}) {
    if (!entry || typeof entry !== "object") return null;
    const activityId = normalizeConfigId(entry.activityId ?? entry.activity ?? entry.attivitaId, "");
    const roomId = normalizeConfigId(entry.roomId ?? entry.room ?? entry.salaId, "");
    if (!activityId || !roomId) return null;
    if (options.activityIds && !options.activityIds.has(activityId)) return null;
    if (options.roomIds && !options.roomIds.has(roomId)) return null;
    return {
      id: normalizeConfigId(entry.id, fallbackId),
      activityId,
      roomId,
      status: entry.status === "disabled" || entry.enabled === false ? "disabled" : "active",
    };
  }

  function buildDefaultPosActivityRoomBindings(activities, areas) {
    const defaultActivity =
      (Array.isArray(activities) ? activities : []).find((activity) => activity.status !== "disabled") ??
      (Array.isArray(activities) ? activities[0] : null);
    if (!defaultActivity) return [];
    return (Array.isArray(areas) ? areas : [])
      .map((area, index) => {
        const roomId = normalizeConfigId(area?.id, "");
        if (!roomId) return null;
        return {
          id: `activity_room_${index + 1}`,
          activityId: defaultActivity.id,
          roomId,
          status: "active",
        };
      })
      .filter((entry) => entry !== null);
  }

  return {
    buildDefaultPosActivityRoomBindings,
    sanitizePosActivity,
    sanitizePosActivityFiscalPolicy,
    sanitizePosActivityRoomBinding,
  };
}
