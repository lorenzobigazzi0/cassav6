import { resolveOperationalContext } from "./operational-context.js";
import { normalizeMenuConfiguration, normalizeMenuScheduleRules } from "../menu/menu-configuration.js";

const DEFAULT_LOCALE_ID = "locale_default";
const DEFAULT_ACTIVITY_ID = "activity_default";

function normalizeString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeConfigId(value, fallback) {
  return normalizeString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || fallback;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeFiscalPolicy(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value));
  }
  return normalizeString(value, "standard");
}

function normalizeLocale(rawLocale) {
  const source = rawLocale && typeof rawLocale === "object" ? rawLocale : {};
  const id = normalizeConfigId(source.id ?? source.localeId, DEFAULT_LOCALE_ID);
  return {
    id,
    name: normalizeString(source.name ?? source.label, "Locale"),
    status: source.status === "disabled" ? "disabled" : "active",
  };
}

function normalizeActivity(rawActivity, fallbackIndex = 1) {
  if (!rawActivity || typeof rawActivity !== "object") return null;
  const id = normalizeConfigId(
    rawActivity.id ?? rawActivity.activityId ?? rawActivity.code,
    `activity_${fallbackIndex}`
  );
  const name = normalizeString(rawActivity.name ?? rawActivity.label, id);
  if (!id || !name) return null;
  return {
    id,
    name,
    type: normalizeString(rawActivity.type, "operational"),
    status: rawActivity.status === "disabled" || rawActivity.enabled === false ? "disabled" : "active",
    fiscalPolicy: normalizeFiscalPolicy(rawActivity.fiscalPolicy ?? rawActivity.fiscalPolicyId ?? rawActivity.fiscal),
    fiscalDeviceIds: uniqueStrings(
      rawActivity.fiscalDeviceIds ??
        rawActivity.rtIds ??
        rawActivity.fiscalPrinterIds ??
        (rawActivity.fiscalPrinterId ? [rawActivity.fiscalPrinterId] : [])
    )
      .map((entry) => normalizeConfigId(entry, ""))
      .filter(Boolean),
    menuIds: uniqueStrings(rawActivity.menuIds ?? (rawActivity.menuId ? [rawActivity.menuId] : []))
      .map((entry) => normalizeConfigId(entry, ""))
      .filter(Boolean),
    priceListIds: uniqueStrings(
      rawActivity.priceListIds ??
        rawActivity.listinoIds ??
        rawActivity.listiniIds ??
        (rawActivity.priceListId ? [rawActivity.priceListId] : [])
    )
      .map((entry) => normalizeConfigId(entry, ""))
      .filter(Boolean),
    printerIds: uniqueStrings(rawActivity.printerIds ?? (rawActivity.printerId ? [rawActivity.printerId] : []))
      .map((entry) => normalizeConfigId(entry, ""))
      .filter(Boolean),
    precontoPrinterIds: uniqueStrings(
      rawActivity.precontoPrinterIds ??
        rawActivity.receiptPrinterIds ??
        rawActivity.billPrinterIds ??
        (rawActivity.precontoPrinterId ? [rawActivity.precontoPrinterId] : [])
    )
      .map((entry) => normalizeConfigId(entry, ""))
      .filter(Boolean),
    workstationIds: uniqueStrings(
      rawActivity.workstationIds ??
        rawActivity.stationIds ??
        (rawActivity.workstationId ? [rawActivity.workstationId] : [])
    )
      .map((entry) => normalizeConfigId(entry, ""))
      .filter(Boolean),
    menuSchedules: normalizeMenuScheduleRules(
      rawActivity.menuSchedules ?? rawActivity.menuSchedule ?? rawActivity.menuScheduleRules,
      "menuIds",
      `${id}_menu_schedule`
    ),
    priceListSchedules: normalizeMenuScheduleRules(
      rawActivity.priceListSchedules ?? rawActivity.priceListSchedule ?? rawActivity.listinoSchedules,
      "priceListIds",
      `${id}_price_list_schedule`
    ),
  };
}

function normalizeRoom(rawRoom, fallbackIndex = 1) {
  if (!rawRoom || typeof rawRoom !== "object") return null;
  const id = normalizeConfigId(rawRoom.id ?? rawRoom.roomId ?? rawRoom.code, `room_${fallbackIndex}`);
  const name = normalizeString(rawRoom.name ?? rawRoom.label ?? rawRoom.roomName, id);
  if (!id || !name) return null;
  return {
    id,
    name,
    status: rawRoom.status === "disabled" || rawRoom.enabled === false ? "disabled" : "active",
    source: normalizeString(rawRoom.source, "pos-settings"),
    menuIds: uniqueStrings(rawRoom.menuIds ?? (rawRoom.menuId ? [rawRoom.menuId] : []))
      .map((entry) => normalizeConfigId(entry, ""))
      .filter(Boolean),
    priceListIds: uniqueStrings(
      rawRoom.priceListIds ?? rawRoom.listinoIds ?? rawRoom.listiniIds ?? (rawRoom.priceListId ? [rawRoom.priceListId] : [])
    )
      .map((entry) => normalizeConfigId(entry, ""))
      .filter(Boolean),
    menuSchedules: normalizeMenuScheduleRules(
      rawRoom.menuSchedules ?? rawRoom.menuSchedule ?? rawRoom.menuScheduleRules,
      "menuIds",
      `${id}_menu_schedule`
    ),
    priceListSchedules: normalizeMenuScheduleRules(
      rawRoom.priceListSchedules ?? rawRoom.priceListSchedule ?? rawRoom.listinoSchedules,
      "priceListIds",
      `${id}_price_list_schedule`
    ),
  };
}

function collectRooms(settings) {
  const roomsById = new Map();
  const addRoom = (room, index, source) => {
    const normalized = normalizeRoom({ ...room, source }, index);
    if (!normalized) return;
    roomsById.set(normalized.id, {
      ...roomsById.get(normalized.id),
      ...normalized,
    });
  };

  (Array.isArray(settings?.areas) ? settings.areas : []).forEach((area, index) => {
    addRoom(area, index + 1, "area");
  });

  (Array.isArray(settings?.tables) ? settings.tables : []).forEach((table, index) => {
    const roomName = normalizeString(table?.roomName ?? table?.type ?? table?.roomId);
    const roomId = normalizeString(table?.roomId) || normalizeConfigId(roomName, `room_from_table_${index + 1}`);
    if (!roomId || !roomName) return;
    addRoom({ id: roomId, name: roomName }, index + 1, "table");
  });

  return [...roomsById.values()].sort((left, right) => left.name.localeCompare(right.name, "it-IT"));
}

function collectActivities(rawSettings) {
  const configured = (Array.isArray(rawSettings?.activities) ? rawSettings.activities : [])
    .map((entry, index) => normalizeActivity(entry, index + 1))
    .filter((entry) => entry !== null);
  if (configured.length > 0) {
    return configured.sort((left, right) => left.name.localeCompare(right.name, "it-IT"));
  }
  return [
    {
      id: DEFAULT_ACTIVITY_ID,
      name: "Operativa",
      type: "operational",
      status: "active",
      fiscalPolicy: "standard",
      fiscalDeviceIds: [],
      menuIds: [],
      priceListIds: [],
      printerIds: [],
      precontoPrinterIds: [],
      workstationIds: [],
    },
  ];
}

function normalizeActivityRoomBinding(rawBinding, fallbackIndex = 1, validActivityIds, validRoomIds) {
  if (!rawBinding || typeof rawBinding !== "object") return null;
  const activityId = normalizeConfigId(rawBinding.activityId ?? rawBinding.activity ?? rawBinding.attivitaId, "");
  const roomId = normalizeConfigId(rawBinding.roomId ?? rawBinding.room ?? rawBinding.salaId, "");
  if (!activityId || !roomId) return null;
  if (validActivityIds && !validActivityIds.has(activityId)) return null;
  if (validRoomIds && !validRoomIds.has(roomId)) return null;
  return {
    id: normalizeConfigId(rawBinding.id, `activity_room_${fallbackIndex}`),
    activityId,
    roomId,
    status: rawBinding.status === "disabled" || rawBinding.enabled === false ? "disabled" : "active",
  };
}

function collectActivityRoomBindings(rawSettings, activities, rooms) {
  const validActivityIds = new Set(activities.map((activity) => activity.id));
  const validRoomIds = new Set(rooms.map((room) => room.id));
  const configured = (Array.isArray(rawSettings?.activityRoomBindings) ? rawSettings.activityRoomBindings : [])
    .map((entry, index) => normalizeActivityRoomBinding(entry, index + 1, validActivityIds, validRoomIds))
    .filter((entry) => entry !== null);
  if (configured.length > 0) {
    return configured.sort((left, right) => {
      const activityCompare = left.activityId.localeCompare(right.activityId, "it-IT");
      if (activityCompare !== 0) return activityCompare;
      return left.roomId.localeCompare(right.roomId, "it-IT");
    });
  }

  const defaultActivity = activities[0] ?? { id: DEFAULT_ACTIVITY_ID };
  return rooms.map((room, index) => ({
    id: `activity_room_${index + 1}`,
    activityId: defaultActivity.id,
    roomId: room.id,
    status: "active",
  }));
}

function mergeWorkstation(target, patch) {
  const roomIds = new Set([...(target.roomIds ?? []), ...(patch.roomIds ?? [])].filter(Boolean));
  const printerIds = new Set([...(target.printerIds ?? []), ...(patch.printerIds ?? [])].filter(Boolean));
  const precontoPrinterIds = new Set([...(target.precontoPrinterIds ?? []), ...(patch.precontoPrinterIds ?? [])].filter(Boolean));
  const cashPointIds = new Set([...(target.cashPointIds ?? []), ...(patch.cashPointIds ?? [])].filter(Boolean));
  const menuIds = new Set([...(target.menuIds ?? []), ...(patch.menuIds ?? [])].filter(Boolean));
  const categoryIds = new Set([...(target.categoryIds ?? []), ...(patch.categoryIds ?? [])].filter(Boolean));
  const productIds = new Set([...(target.productIds ?? []), ...(patch.productIds ?? [])].filter(Boolean));
  const excludedCategoryIds = new Set([...(target.excludedCategoryIds ?? []), ...(patch.excludedCategoryIds ?? [])].filter(Boolean));
  const excludedProductIds = new Set([...(target.excludedProductIds ?? []), ...(patch.excludedProductIds ?? [])].filter(Boolean));
  return {
    ...target,
    ...patch,
    name: normalizeString(target.name, patch.name),
    stationName: normalizeString(target.stationName, patch.stationName),
    status: target.status === "disabled" || patch.status === "disabled" ? "disabled" : "configured",
    roomIds: [...roomIds].sort((left, right) => left.localeCompare(right, "it-IT")),
    printerIds: [...printerIds].sort((left, right) => left.localeCompare(right, "it-IT")),
    precontoPrinterIds: [...precontoPrinterIds].sort((left, right) => left.localeCompare(right, "it-IT")),
    cashPointIds: [...cashPointIds].sort((left, right) => left.localeCompare(right, "it-IT")),
    menuIds: [...menuIds].sort((left, right) => left.localeCompare(right, "it-IT")),
    categoryIds: [...categoryIds].sort((left, right) => left.localeCompare(right, "it-IT")),
    productIds: [...productIds].sort((left, right) => left.localeCompare(right, "it-IT")),
    excludedCategoryIds: [...excludedCategoryIds].sort((left, right) => left.localeCompare(right, "it-IT")),
    excludedProductIds: [...excludedProductIds].sort((left, right) => left.localeCompare(right, "it-IT")),
  };
}

function collectWorkstations(settings) {
  const workstationsById = new Map();
  const addWorkstation = (entry) => {
    if (!entry || !entry.id) return;
    const current = workstationsById.get(entry.id);
    workstationsById.set(entry.id, current ? mergeWorkstation(current, entry) : entry);
  };

  (Array.isArray(settings?.workstations) ? settings.workstations : []).forEach((workstation, index) => {
    const id = normalizeConfigId(
      workstation?.id ?? workstation?.stationId ?? workstation?.stationName ?? workstation?.name,
      `workstation_${index + 1}`
    );
    if (!id) return;
    addWorkstation({
      id,
      name: normalizeString(workstation?.name ?? workstation?.label ?? workstation?.stationName, id),
      stationName: normalizeString(workstation?.stationName ?? workstation?.station ?? workstation?.name, id),
      type: normalizeString(workstation?.type, "workstation"),
      source: normalizeString(workstation?.source, "workstation"),
      status: workstation?.active === false || workstation?.status === "disabled" ? "disabled" : "configured",
      roomIds: uniqueStrings(workstation?.roomIds).map((roomId) => normalizeConfigId(roomId, "")).filter(Boolean),
      printerIds: uniqueStrings(workstation?.printerIds).map((printerId) => normalizeConfigId(printerId, "")).filter(Boolean),
      precontoPrinterIds: uniqueStrings(
        workstation?.precontoPrinterIds ??
          workstation?.receiptPrinterIds ??
          workstation?.billPrinterIds ??
          (workstation?.precontoPrinterId ? [workstation.precontoPrinterId] : [])
      ).map((printerId) => normalizeConfigId(printerId, "")).filter(Boolean),
      useOwnPrinters: workstation?.useOwnPrinters === true,
      printOrderEnabled: workstation?.printOrderEnabled !== false,
      printPrecontoEnabled: workstation?.printPrecontoEnabled !== false,
      printTableChangesEnabled: workstation?.printTableChangesEnabled !== false,
      cashPointIds: [],
      menuIds: uniqueStrings(workstation?.menuIds).map((menuId) => normalizeConfigId(menuId, "")).filter(Boolean),
      categoryIds: uniqueStrings(workstation?.categoryIds),
      productIds: uniqueStrings(workstation?.productIds).map((productId) => normalizeConfigId(productId, "")).filter(Boolean),
      excludedCategoryIds: uniqueStrings(workstation?.excludedCategoryIds),
      excludedProductIds: uniqueStrings(workstation?.excludedProductIds).map((productId) => normalizeConfigId(productId, "")).filter(Boolean),
    });
  });

  (Array.isArray(settings?.areas) ? settings.areas : []).forEach((area) => {
    const roomId = normalizeConfigId(area?.id ?? area?.roomId, "");
    if (!roomId) return;

    (Array.isArray(area?.workstations) ? area.workstations : []).forEach((workstation, index) => {
      const id = normalizeConfigId(
        workstation?.id ?? workstation?.stationId ?? workstation?.stationName ?? workstation?.name,
        `${roomId}_station_${index + 1}`
      );
      if (!id) return;
      addWorkstation({
        id,
        name: normalizeString(workstation?.name ?? workstation?.label ?? workstation?.stationName, id),
        stationName: normalizeString(workstation?.stationName ?? workstation?.station ?? workstation?.name, id),
        type: "workstation",
        source: "area.workstations",
        status: workstation?.active === false || workstation?.status === "disabled" ? "disabled" : "configured",
        roomIds: [roomId],
        printerIds: uniqueStrings(workstation?.printerIds).map((printerId) => normalizeConfigId(printerId, "")).filter(Boolean),
        precontoPrinterIds: uniqueStrings(
          workstation?.precontoPrinterIds ??
            workstation?.receiptPrinterIds ??
            workstation?.billPrinterIds ??
            (workstation?.precontoPrinterId ? [workstation.precontoPrinterId] : [])
        ).map((printerId) => normalizeConfigId(printerId, "")).filter(Boolean),
        useOwnPrinters: workstation?.useOwnPrinters === true,
        printOrderEnabled: workstation?.printOrderEnabled !== false,
        printPrecontoEnabled: workstation?.printPrecontoEnabled !== false,
        printTableChangesEnabled: workstation?.printTableChangesEnabled !== false,
        cashPointIds: [],
        menuIds: uniqueStrings(workstation?.menuIds).map((menuId) => normalizeConfigId(menuId, "")).filter(Boolean),
        categoryIds: uniqueStrings(workstation?.categoryIds),
        productIds: uniqueStrings(workstation?.productIds).map((productId) => normalizeConfigId(productId, "")).filter(Boolean),
        excludedCategoryIds: uniqueStrings(workstation?.excludedCategoryIds),
        excludedProductIds: uniqueStrings(workstation?.excludedProductIds).map((productId) => normalizeConfigId(productId, "")).filter(Boolean),
      });
    });

    (Array.isArray(area?.cashPoints) ? area.cashPoints : []).forEach((cashPoint, index) => {
      const id = normalizeConfigId(cashPoint?.id ?? cashPoint?.code ?? cashPoint?.name, `${roomId}_cash_${index + 1}`);
      if (!id) return;
      addWorkstation({
        id,
        name: normalizeString(cashPoint?.name ?? cashPoint?.label ?? cashPoint?.code, id),
        stationName: normalizeString(cashPoint?.code ?? cashPoint?.name, id),
        type: "cash_point",
        source: "area.cashPoints",
        status: cashPoint?.active === false || cashPoint?.status === "disabled" ? "disabled" : "configured",
        roomIds: [roomId],
        printerIds: uniqueStrings(cashPoint?.printerIds).map((printerId) => normalizeConfigId(printerId, "")).filter(Boolean),
        cashPointIds: [id],
      });
    });
  });

  return [...workstationsById.values()].sort((left, right) => left.name.localeCompare(right.name, "it-IT"));
}

function collectPrinters(settings) {
  return (Array.isArray(settings?.printers) ? settings.printers : [])
    .map((printer, index) => {
      const id = normalizeConfigId(printer?.id, `printer_${index + 1}`);
      return {
        id,
        name: normalizeString(printer?.name ?? printer?.label, id),
        host: normalizeString(printer?.host),
        port: Number.isFinite(Number(printer?.port)) ? Number(printer.port) : null,
        purpose: normalizeString(printer?.purpose, "generic"),
        status: printer?.active === false ? "disabled" : "active",
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "it-IT"));
}

function collectPrinterAssignments(settings, printers) {
  const printersById = new Map(printers.map((printer) => [printer.id, printer]));
  const assignments = [];
  const addAssignment = ({ area, printerId, source, targetType, targetId, targetName, forceFiscal = false }) => {
    const roomId = normalizeConfigId(area?.id ?? area?.roomId, "");
    const printer = printersById.get(normalizeConfigId(printerId, ""));
    if (!roomId || !printer) return;
    const safeTargetType = normalizeString(targetType, "room");
    const safeTargetId = normalizeConfigId(targetId, roomId);
    const safeSource = normalizeString(source, "area.printerIds");
    assignments.push({
      id: normalizeConfigId(`${roomId}_${safeTargetType}_${safeTargetId}_${printer.id}_${safeSource}`, "printer_assignment"),
      roomId,
      roomName: normalizeString(area?.name ?? area?.label, roomId),
      printerId: printer.id,
      printerName: printer.name,
      printerHost: printer.host,
      printerPort: printer.port,
      purpose: printer.purpose,
      fiscal: forceFiscal || printer.purpose === "fiscal",
      targetType: safeTargetType,
      targetId: safeTargetId,
      targetName: normalizeString(targetName, safeTargetId),
      source: safeSource,
      status: printer.status === "disabled" ? "disabled" : "active",
    });
  };

  (Array.isArray(settings?.areas) ? settings.areas : []).forEach((area) => {
    (Array.isArray(area?.printerIds) ? area.printerIds : []).forEach((printerId) => {
      addAssignment({
        area,
        printerId,
        source: "area.printerIds",
        targetType: "room",
        targetId: area?.id,
        targetName: area?.name,
      });
    });
    (Array.isArray(area?.precontoPrinterIds) ? area.precontoPrinterIds : []).forEach((printerId) => {
      addAssignment({
        area,
        printerId,
        source: "area.precontoPrinterIds",
        targetType: "room_preconto",
        targetId: area?.id,
        targetName: `${normalizeString(area?.name ?? area?.label, area?.id)} preconto`,
      });
    });

    (Array.isArray(area?.cashPoints) ? area.cashPoints : []).forEach((cashPoint) => {
      const cashPointId = normalizeConfigId(cashPoint?.id ?? cashPoint?.code ?? cashPoint?.name, "");
      const cashPointName = normalizeString(cashPoint?.name ?? cashPoint?.label ?? cashPoint?.code, cashPointId);
      (Array.isArray(cashPoint?.printerIds) ? cashPoint.printerIds : []).forEach((printerId) => {
        addAssignment({
          area,
          printerId,
          source: "cashPoint.printerIds",
          targetType: "cash_point",
          targetId: cashPointId,
          targetName: cashPointName,
        });
      });
      if (cashPoint?.fiscalPrinterId) {
        addAssignment({
          area,
          printerId: cashPoint.fiscalPrinterId,
          source: "cashPoint.fiscalPrinterId",
          targetType: "cash_point",
          targetId: cashPointId,
          targetName: cashPointName,
          forceFiscal: true,
        });
      }
    });

    (Array.isArray(area?.workstations) ? area.workstations : []).forEach((workstation) => {
      const workstationId = normalizeConfigId(
        workstation?.id ?? workstation?.stationId ?? workstation?.stationName ?? workstation?.name,
        ""
      );
      const workstationName = normalizeString(
        workstation?.name ?? workstation?.label ?? workstation?.stationName,
        workstationId
      );
      (Array.isArray(workstation?.printerIds) ? workstation.printerIds : []).forEach((printerId) => {
        addAssignment({
          area,
          printerId,
          source: "workstation.printerIds",
          targetType: "workstation",
          targetId: workstationId,
          targetName: workstationName,
        });
      });
      (Array.isArray(workstation?.precontoPrinterIds) ? workstation.precontoPrinterIds : []).forEach((printerId) => {
        addAssignment({
          area,
          printerId,
          source: "workstation.precontoPrinterIds",
          targetType: "workstation_preconto",
          targetId: workstationId,
          targetName: `${workstationName} preconto`,
        });
      });
    });
  });

  return assignments.sort((left, right) => {
    const roomCompare = left.roomName.localeCompare(right.roomName, "it-IT");
    if (roomCompare !== 0) return roomCompare;
    const targetCompare = left.targetName.localeCompare(right.targetName, "it-IT");
    if (targetCompare !== 0) return targetCompare;
    return left.printerName.localeCompare(right.printerName, "it-IT");
  });
}

function enrichRoomsWithConfiguration(rooms, settings, printerAssignments) {
  const areasById = new Map(
    (Array.isArray(settings?.areas) ? settings.areas : [])
      .map((area) => [normalizeConfigId(area?.id ?? area?.roomId, ""), area])
      .filter(([id]) => Boolean(id))
  );
  return rooms.map((room) => {
    const area = areasById.get(room.id);
    const assignments = printerAssignments.filter((assignment) => assignment.roomId === room.id);
    const legacyFiscalPrinterIds = [
      ...new Set(assignments.filter((assignment) => assignment.fiscal).map((assignment) => assignment.printerId)),
    ].sort((a, b) => a.localeCompare(b, "it-IT"));
    const legacyCashPointIds = uniqueStrings(
      (Array.isArray(area?.cashPoints) ? area.cashPoints : []).map((entry) => entry?.id ?? entry?.code)
    )
      .map((id) => normalizeConfigId(id, ""))
      .filter(Boolean);
    return {
      ...room,
      menuIds: uniqueStrings(area?.menuIds).map((id) => normalizeConfigId(id, "")).filter(Boolean),
      priceListIds: uniqueStrings(
        area?.priceListIds ?? area?.listinoIds ?? area?.listiniIds ?? room.priceListIds
      )
        .map((id) => normalizeConfigId(id, ""))
        .filter(Boolean),
      waiterUserIds: uniqueStrings(area?.waiterUserIds),
      printerIds: [
        ...new Set(assignments.filter((assignment) => !assignment.fiscal).map((assignment) => assignment.printerId)),
      ].sort((a, b) => a.localeCompare(b, "it-IT")),
      precontoPrinterIds: uniqueStrings(area?.precontoPrinterIds)
        .map((id) => normalizeConfigId(id, ""))
        .filter(Boolean),
      workstationIds: uniqueStrings((Array.isArray(area?.workstations) ? area.workstations : []).map((entry) => entry?.id))
        .map((id) => normalizeConfigId(id, ""))
        .filter(Boolean),
      legacyFiscalPrinterIds,
      legacyCashPointIds,
    };
  });
}

function collectLegacyRoomFiscalAssignments(settings, printers) {
  const printersById = new Map(printers.map((printer) => [printer.id, printer]));
  const assignments = [];
  const addAssignment = ({ area, printerId, source, targetType, targetId }) => {
    const roomId = normalizeConfigId(area?.id ?? area?.roomId, "");
    const safePrinterId = normalizeConfigId(printerId, "");
    const printer = printersById.get(safePrinterId);
    if (!roomId || !safePrinterId) return;
    assignments.push({
      id: normalizeConfigId(`${roomId}_${targetType}_${targetId}_${safePrinterId}_${source}`, "legacy_room_fiscal"),
      roomId,
      roomName: normalizeString(area?.name ?? area?.label, roomId),
      printerId: safePrinterId,
      fiscalDeviceId: `rt_${safePrinterId}`,
      printerName: printer?.name ?? safePrinterId,
      targetType,
      targetId: normalizeConfigId(targetId, roomId),
      source,
      status: printer?.status === "disabled" ? "disabled" : "legacy",
      legacy: true,
    });
  };

  (Array.isArray(settings?.areas) ? settings.areas : []).forEach((area) => {
    const directFiscalIds = uniqueStrings(
      area?.fiscalPrinterIds ?? area?.fiscalDeviceIds ?? (area?.fiscalPrinterId ? [area.fiscalPrinterId] : [])
    );
    directFiscalIds.forEach((printerId) => {
      addAssignment({
        area,
        printerId,
        source: "area.fiscalPrinterId",
        targetType: "room",
        targetId: area?.id ?? area?.roomId,
      });
    });
    (Array.isArray(area?.cashPoints) ? area.cashPoints : []).forEach((cashPoint) => {
      uniqueStrings(cashPoint?.printerIds).forEach((printerId) => {
        const printer = printersById.get(normalizeConfigId(printerId, ""));
        if (printer?.purpose !== "fiscal") return;
        addAssignment({
          area,
          printerId,
          source: "cashPoint.printerIds",
          targetType: "cash_point",
          targetId: cashPoint?.id ?? cashPoint?.code ?? cashPoint?.name,
        });
      });
      if (!cashPoint?.fiscalPrinterId) return;
      addAssignment({
        area,
        printerId: cashPoint.fiscalPrinterId,
        source: "cashPoint.fiscalPrinterId",
        targetType: "cash_point",
        targetId: cashPoint?.id ?? cashPoint?.code ?? cashPoint?.name,
      });
    });
  });

  return assignments.sort((left, right) => {
    const roomCompare = left.roomName.localeCompare(right.roomName, "it-IT");
    if (roomCompare !== 0) return roomCompare;
    return left.printerName.localeCompare(right.printerName, "it-IT");
  });
}

function normalizeFiscalDevice(rawDevice, fallbackIndex = 1) {
  if (!rawDevice || typeof rawDevice !== "object") return null;
  const id = normalizeConfigId(
    rawDevice.id ?? rawDevice.fiscalDeviceId ?? rawDevice.rtId ?? rawDevice.code,
    `fiscal_device_${fallbackIndex}`
  );
  const name = normalizeString(rawDevice.name ?? rawDevice.label, id);
  if (!id || !name) return null;
  const status = rawDevice.active === false || rawDevice.status === "disabled" ? "disabled" : "active";
  return {
    id,
    name,
    type: normalizeString(rawDevice.type ?? rawDevice.kind, "api"),
    fiscalProvider: normalizeString(rawDevice.fiscalProvider ?? rawDevice.provider, "pos-fiscal-api"),
    apiBaseUrl: normalizeString(rawDevice.apiBaseUrl ?? rawDevice.fiscalApiBaseUrl),
    statusEndpoint: normalizeString(rawDevice.statusEndpoint ?? rawDevice.fiscalStatusEndpoint, "/api/fiscal/status"),
    verifyEndpoint: normalizeString(rawDevice.verifyEndpoint ?? rawDevice.fiscalVerifyEndpoint, "/api/fiscal/receipt/verify"),
    receiptEndpoint: normalizeString(rawDevice.receiptEndpoint ?? rawDevice.fiscalReceiptEndpoint, "/api/fiscal/receipt"),
    reprintEndpoint: normalizeString(rawDevice.reprintEndpoint ?? rawDevice.fiscalReprintEndpoint, "/api/fiscal/reprint"),
    voidEndpoint: normalizeString(rawDevice.voidEndpoint ?? rawDevice.fiscalVoidEndpoint, "/api/fiscal/void"),
    paymentMethodIds: uniqueStrings(rawDevice.paymentMethodIds ?? rawDevice.supportedPaymentMethodIds),
    supportsCash: rawDevice.supportsCash === true,
    supportsElectronic: rawDevice.supportsElectronic === true,
    supportsReprint: rawDevice.supportsReprint === true,
    status,
    source: normalizeString(rawDevice.source, "settings.fiscalDevices"),
  };
}

function collectFiscalDevices(settings, printers, activityFiscalAssignments = [], legacyRoomFiscalAssignments = []) {
  const configuredDevices = (Array.isArray(settings?.fiscalDevices) ? settings.fiscalDevices : [])
    .map((device, index) => normalizeFiscalDevice(device, index + 1))
    .filter((device) => device !== null);
  const configuredDeviceIds = new Set(configuredDevices.map((device) => device.id));
  const activityIdsByPrinterId = new Map();
  activityFiscalAssignments.forEach((assignment) => {
    const printerId = normalizeConfigId(assignment.printerId, "");
    const activityId = normalizeConfigId(assignment.activityId, "");
    if (!printerId || !activityId) return;
    const current = activityIdsByPrinterId.get(printerId) ?? new Set();
    current.add(activityId);
    activityIdsByPrinterId.set(printerId, current);
  });
  const legacyRoomIdsByPrinterId = new Map();
  const legacyCashPointIdsByPrinterId = new Map();
  legacyRoomFiscalAssignments.forEach((assignment) => {
    const printerId = normalizeConfigId(assignment.printerId, "");
    if (!printerId) return;
    const roomSet = legacyRoomIdsByPrinterId.get(printerId) ?? new Set();
    if (assignment.roomId) roomSet.add(assignment.roomId);
    legacyRoomIdsByPrinterId.set(printerId, roomSet);
    if (assignment.targetType === "cash_point") {
      const cashSet = legacyCashPointIdsByPrinterId.get(printerId) ?? new Set();
      if (assignment.targetId) cashSet.add(assignment.targetId);
      legacyCashPointIdsByPrinterId.set(printerId, cashSet);
    }
  });
  const configuredDeviceAssignments = configuredDevices.map((device) => ({
    ...device,
    activityIds: [...(activityIdsByPrinterId.get(device.id) ?? new Set())].sort((left, right) =>
      left.localeCompare(right, "it-IT")
    ),
    legacyRoomIds: [],
    legacyCashPointIds: [],
  }));
  const legacyPrinterDevices = printers
    .filter((printer) => printer.purpose === "fiscal")
    .map((printer) => {
      const id = `rt_${printer.id}`;
      if (configuredDeviceIds.has(id) || configuredDeviceIds.has(printer.id)) return null;
      return {
      id,
      name: printer.name,
      printerId: printer.id,
      host: printer.host,
      port: printer.port,
      status: printer.status,
      type: "legacy_printer",
      fiscalProvider: "legacy_printer",
      source: "legacy.printers.purpose_fiscal",
      activityIds: [...(activityIdsByPrinterId.get(printer.id) ?? new Set())].sort((left, right) =>
        left.localeCompare(right, "it-IT")
      ),
      legacyRoomIds: [...(legacyRoomIdsByPrinterId.get(printer.id) ?? new Set())].sort((left, right) =>
        left.localeCompare(right, "it-IT")
      ),
      legacyCashPointIds: [...(legacyCashPointIdsByPrinterId.get(printer.id) ?? new Set())].sort((left, right) =>
        left.localeCompare(right, "it-IT")
      ),
      };
    })
    .filter((device) => device !== null);
  return [...configuredDeviceAssignments, ...legacyPrinterDevices].sort((left, right) =>
    left.name.localeCompare(right.name, "it-IT")
  );
}

function collectStaffAssignments(users) {
  const normalizeNotificationPrioritiesForSnapshot = (value) => {
    const keys = ["ordine", "consegna", "ritiro"];
    if (Array.isArray(value)) {
      const selected = new Set(value.map((entry) => normalizeString(entry)).filter(Boolean));
      return Object.fromEntries(keys.map((key) => [key, selected.has(key) ? "enabled" : "disabled"]));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(keys.map((key) => {
        const entry = value[key];
        if (entry === false) return [key, "disabled"];
        if (entry === true) return [key, "enabled"];
        return [key, normalizeString(entry, "normal")];
      }));
    }
    return Object.fromEntries(keys.map((key) => [key, "normal"]));
  };

  return (Array.isArray(users) ? users : [])
    .map((user) => {
      const id = normalizeString(user?.id);
      if (!id) return null;
      return {
        userId: id,
        username: normalizeString(user?.username),
        fullName: normalizeString(user?.fullName ?? user?.name ?? user?.username, id),
        role: normalizeString(user?.role, "operator"),
        enabledRoomIds: uniqueStrings(user?.enabledRoomIds),
        authorizedRoomIds: uniqueStrings(user?.authorizedRoomIds),
        notificationPriorities: normalizeNotificationPrioritiesForSnapshot(user?.notificationPriorities),
      };
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => left.fullName.localeCompare(right.fullName, "it-IT"));
}

function collectMenuScopes(settings) {
  const configuration = normalizeMenuConfiguration(settings, []);
  return configuration.menus
    .map((menu, index) => ({
      id: normalizeConfigId(menu?.id, `menu_scope_${index + 1}`),
      name: normalizeString(menu?.name ?? menu?.label, `Menu ${index + 1}`),
      categories: (Array.isArray(menu?.categories) ? menu.categories : []).map((category, categoryIndex) => ({
        id: normalizeConfigId(category?.id, `category_${categoryIndex + 1}`),
        name: normalizeString(category?.name ?? category?.label, `Categoria ${categoryIndex + 1}`),
        productIds: uniqueStrings(category?.productIds).map((id) => normalizeConfigId(id, "")).filter(Boolean),
      })),
      categoryNames: (Array.isArray(menu?.categories) ? menu.categories : []).map((category) =>
        normalizeString(category?.name ?? category?.label)
      ).filter(Boolean),
      status: menu?.status === "disabled" || menu?.enabled === false ? "disabled" : "active",
      schedule: normalizeMenuScheduleRules(menu?.schedule ?? menu?.menuSchedule, "menuIds", `${menu?.id || "menu"}_schedule`),
      source: Array.isArray(settings?.menus) && settings.menus.length ? "settings.menus" : "settings.areaMenus",
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "it-IT"));
}

function collectPriceLists(settings) {
  const configuration = normalizeMenuConfiguration(settings, []);
  return configuration.priceLists.map((priceList) => ({
    id: priceList.id,
    name: priceList.name,
    currency: priceList.currency,
    status: priceList.status,
    pricesCount: Array.isArray(priceList.prices) ? priceList.prices.length : 0,
  }));
}

function collectRoomStaffAssignments(settings, users) {
  const usersById = new Map(
    collectStaffAssignments(users).map((user) => [user.userId, user])
  );
  const assignmentsByKey = new Map();
  const addAssignment = ({ roomId, userId, source, assignmentType }) => {
    const safeRoomId = normalizeConfigId(roomId, "");
    const safeUserId = normalizeString(userId);
    if (!safeRoomId || !safeUserId) return;
    const user = usersById.get(safeUserId);
    if (!user) return;
    const key = `${safeRoomId}:${safeUserId}`;
    const current = assignmentsByKey.get(key);
    const sources = new Set([...(current?.sources ?? []), normalizeString(source, "unknown")]);
    const assignmentTypes = new Set([...(current?.assignmentTypes ?? []), normalizeString(assignmentType, "enabled")]);
    assignmentsByKey.set(key, {
      id: normalizeConfigId(`room_staff_${safeRoomId}_${safeUserId}`, "room_staff_assignment"),
      roomId: safeRoomId,
      userId: safeUserId,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      notificationPriorities: user.notificationPriorities,
      assignmentTypes: [...assignmentTypes].sort((left, right) => left.localeCompare(right, "it-IT")),
      sources: [...sources].sort((left, right) => left.localeCompare(right, "it-IT")),
      status: "active",
    });
  };

  (Array.isArray(settings?.areas) ? settings.areas : []).forEach((area) => {
    const roomId = normalizeConfigId(area?.id ?? area?.roomId, "");
    if (!roomId) return;
    uniqueStrings(area?.waiterUserIds).forEach((userId) => {
      addAssignment({ roomId, userId, source: "area.waiterUserIds", assignmentType: "waiter" });
    });
  });

  for (const user of usersById.values()) {
    uniqueStrings(user.enabledRoomIds).forEach((roomId) => {
      addAssignment({ roomId, userId: user.userId, source: "user.enabledRoomIds", assignmentType: "enabled" });
    });
    uniqueStrings(user.authorizedRoomIds).forEach((roomId) => {
      addAssignment({ roomId, userId: user.userId, source: "user.authorizedRoomIds", assignmentType: "authorized" });
    });
  }

  return [...assignmentsByKey.values()].sort((left, right) => {
    const roomCompare = left.roomId.localeCompare(right.roomId, "it-IT");
    if (roomCompare !== 0) return roomCompare;
    return left.fullName.localeCompare(right.fullName, "it-IT");
  });
}

function collectRoomMenuAssignments(settings, menuScopes) {
  const menuScopesById = new Map(menuScopes.map((menu) => [menu.id, menu]));
  const assignments = [];
  (Array.isArray(settings?.areas) ? settings.areas : []).forEach((area) => {
    const roomId = normalizeConfigId(area?.id ?? area?.roomId, "");
    if (!roomId) return;
    uniqueStrings(area?.menuIds).forEach((menuId) => {
      const safeMenuId = normalizeConfigId(menuId, "");
      const menu = menuScopesById.get(safeMenuId);
      if (!menu) return;
      assignments.push({
        id: normalizeConfigId(`room_menu_${roomId}_${safeMenuId}`, "room_menu_assignment"),
        roomId,
        roomName: normalizeString(area?.name ?? area?.label, roomId),
        menuId: safeMenuId,
        menuName: menu.name,
        categories: uniqueStrings(menu.categoryNames ?? menu.categories),
        status: menu.status === "disabled" ? "disabled" : "active",
        source: "area.menuIds",
      });
    });
  });
  return assignments.sort((left, right) => {
    const roomCompare = left.roomName.localeCompare(right.roomName, "it-IT");
    if (roomCompare !== 0) return roomCompare;
    return left.menuName.localeCompare(right.menuName, "it-IT");
  });
}

function resolveFiscalDeviceReference(referenceId, fiscalDevices) {
  const safeReferenceId = normalizeConfigId(referenceId, "");
  if (!safeReferenceId) return null;
  return (
    fiscalDevices.find((device) => device.id === safeReferenceId) ??
    fiscalDevices.find((device) => device.printerId === safeReferenceId) ??
    fiscalDevices.find((device) => device.id === `rt_${safeReferenceId}`) ??
    null
  );
}

function collectActivityFiscalAssignments(activities, fiscalDevices) {
  return activities
    .flatMap((activity) =>
      uniqueStrings(activity.fiscalDeviceIds).map((fiscalDeviceId) => {
        const safeFiscalDeviceId = normalizeConfigId(fiscalDeviceId, "");
        const fiscalDevice = resolveFiscalDeviceReference(safeFiscalDeviceId, fiscalDevices);
        return {
          id: normalizeConfigId(`activity_fiscal_${activity.id}_${safeFiscalDeviceId}`, "activity_fiscal_assignment"),
          activityId: activity.id,
          activityName: activity.name,
          fiscalDeviceId: fiscalDevice?.id ?? safeFiscalDeviceId,
          fiscalDeviceName: fiscalDevice?.name ?? safeFiscalDeviceId,
          printerId: fiscalDevice?.printerId ?? safeFiscalDeviceId,
          fiscalPolicy: activity.fiscalPolicy,
          source: "activity.fiscalDeviceIds",
          status: fiscalDevice ? fiscalDevice.status : "unresolved",
        };
      })
    )
    .sort((left, right) => {
      const activityCompare = left.activityName.localeCompare(right.activityName, "it-IT");
      if (activityCompare !== 0) return activityCompare;
      return left.fiscalDeviceName.localeCompare(right.fiscalDeviceName, "it-IT");
    });
}

function collectActivityPrinterAssignments(activities, printers) {
  const printersById = new Map(printers.map((printer) => [printer.id, printer]));
  return activities
    .flatMap((activity) => {
      const fiscalDeviceIds = new Set(activity.fiscalDeviceIds);
      return uniqueStrings(activity.printerIds).map((printerId) => {
        const safePrinterId = normalizeConfigId(printerId, "");
        const printer = printersById.get(safePrinterId);
        const fiscal = printer?.purpose === "fiscal" || fiscalDeviceIds.has(safePrinterId) || fiscalDeviceIds.has(`rt_${safePrinterId}`);
        return {
          id: normalizeConfigId(`activity_printer_${activity.id}_${safePrinterId}`, "activity_printer_assignment"),
          activityId: activity.id,
          activityName: activity.name,
          printerId: safePrinterId,
          printerName: printer?.name ?? safePrinterId,
          purpose: printer?.purpose ?? "generic",
          fiscal,
          source: "activity.printerIds",
          status: fiscal ? "legacy_fiscal_reference" : printer?.status ?? "unresolved",
        };
      });
    })
    .sort((left, right) => {
      const activityCompare = left.activityName.localeCompare(right.activityName, "it-IT");
      if (activityCompare !== 0) return activityCompare;
      return left.printerName.localeCompare(right.printerName, "it-IT");
    });
}

function collectActivityMenuAssignments(activities, menuScopes) {
  const menuScopesById = new Map(menuScopes.map((menu) => [menu.id, menu]));
  return activities
    .flatMap((activity) =>
      uniqueStrings(activity.menuIds).map((menuId) => {
        const safeMenuId = normalizeConfigId(menuId, "");
        const menu = menuScopesById.get(safeMenuId);
        return {
          id: normalizeConfigId(`activity_menu_${activity.id}_${safeMenuId}`, "activity_menu_assignment"),
          activityId: activity.id,
          activityName: activity.name,
          menuId: safeMenuId,
          menuName: menu?.name ?? safeMenuId,
          categories: uniqueStrings(menu?.categoryNames ?? menu?.categories),
          source: "activity.menuIds",
          status: menu?.status ?? "unresolved",
        };
      })
    )
    .sort((left, right) => {
      const activityCompare = left.activityName.localeCompare(right.activityName, "it-IT");
      if (activityCompare !== 0) return activityCompare;
      return left.menuName.localeCompare(right.menuName, "it-IT");
    });
}

function collectResolvedContexts({ settings, locale, activities, activityRoomBindings, generatedAt }) {
  const resolverSettings = {
    ...settings,
    locale,
    activities,
    activityRoomBindings,
  };
  return activityRoomBindings
    .filter((binding) => binding.status !== "disabled")
    .map((binding) =>
      resolveOperationalContext({
        settings: resolverSettings,
        activityId: binding.activityId,
        roomId: binding.roomId,
        now: generatedAt,
      })
    )
    .sort((left, right) => {
      const activityCompare = left.activityId.localeCompare(right.activityId, "it-IT");
      if (activityCompare !== 0) return activityCompare;
      return left.roomId.localeCompare(right.roomId, "it-IT");
    });
}

export function buildConfigurationSnapshot({
  settings,
  rawSettings = settings,
  users = [],
  meta = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const locale = normalizeLocale(rawSettings?.locale);
  const rooms = collectRooms(settings);
  const activities = collectActivities(rawSettings);
  const activityRoomBindings = collectActivityRoomBindings(rawSettings, activities, rooms);
  const printers = collectPrinters(settings);
  const printerAssignments = collectPrinterAssignments(settings, printers);
  const legacyRoomFiscalAssignments = collectLegacyRoomFiscalAssignments(settings, printers);
  const enrichedRooms = enrichRoomsWithConfiguration(rooms, settings, printerAssignments);
  const staffAssignments = collectStaffAssignments(users);
  const menuScopes = collectMenuScopes(settings);
  const menuConfiguration = normalizeMenuConfiguration(settings, []);
  const rawFiscalDevices = collectFiscalDevices(settings, printers);
  const activityFiscalAssignments = collectActivityFiscalAssignments(activities, rawFiscalDevices);
  const activityPrinterAssignments = collectActivityPrinterAssignments(activities, printers);
  const activityMenuAssignments = collectActivityMenuAssignments(activities, menuScopes);
  const fiscalDevices = collectFiscalDevices(settings, printers, activityFiscalAssignments, legacyRoomFiscalAssignments);
  const resolvedContexts = collectResolvedContexts({
    settings,
    locale,
    activities,
    activityRoomBindings,
    generatedAt,
  });

  return {
    ok: true,
    schemaVersion: 2,
    status: "published",
    demoMode: rawSettings?.demoMode === true || settings?.demoMode === true,
    generatedAt,
    settingsVersion: Number(meta?.settingsVersion ?? meta?.version ?? 1) || 1,
    settingsLastWriteAt: normalizeString(meta?.settingsLastWriteAt ?? meta?.lastWriteAt),
    locale,
    activities,
    rooms: enrichedRooms,
    activityRoomBindings,
    resolvedContexts,
    workstations: collectWorkstations(settings),
    mobileDevices: Array.isArray(settings?.mobileDevices) ? settings.mobileDevices : [],
    printers,
    fiscalDevices,
    printerAssignments,
    activityFiscalAssignments,
    activityPrinterAssignments,
    activityMenuAssignments,
    legacyRoomFiscalAssignments,
    staffAssignments,
    roomStaffAssignments: collectRoomStaffAssignments(settings, users),
    menus: menuConfiguration.menus,
    menuScopes,
    priceLists: collectPriceLists(settings),
    priceListSchedules: menuConfiguration.priceListSchedules,
    menuSchedules: menuConfiguration.menuSchedules,
    roomMenuAssignments: collectRoomMenuAssignments(settings, menuScopes),
    invariants: {
      runtimeUsesPublishedSnapshot: true,
      backendOwnsPriceResolution: true,
      backendOwnsPrinterRouting: true,
      ordersKeepCreationSnapshot: true,
    },
  };
}
