import { normalizeMenuScheduleRules, resolveScheduledIds } from "../menu/menu-configuration.js";

const DEFAULT_LOCALE_ID = "locale_default";
const DEFAULT_ACTIVITY_ID = "activity_default";

function normalizeString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeConfigId(value, fallback = "") {
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

function normalizeReferenceIdList(value) {
  return uniqueStrings(Array.isArray(value) ? value : value ? [value] : [])
    .map((entry) => normalizeConfigId(entry, ""))
    .filter(Boolean);
}

function normalizeFiscalPolicy(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value));
  }
  return normalizeString(value, "standard");
}

function resolvedAtIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "function") {
    const value = now();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string" && value.trim()) return value;
  }
  if (typeof now === "string" && now.trim()) return now;
  return new Date().toISOString();
}

function resolvedAtDate(now) {
  const iso = resolvedAtIso(now);
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function normalizeLocale(rawLocale) {
  const source = rawLocale && typeof rawLocale === "object" ? rawLocale : {};
  return {
    id: normalizeConfigId(source.id ?? source.localeId, DEFAULT_LOCALE_ID),
    name: normalizeString(source.name ?? source.label, "Locale"),
    status: source.status === "disabled" || source.enabled === false ? "disabled" : "active",
  };
}

function normalizeActivity(rawActivity, fallbackIndex = 1) {
  if (!rawActivity || typeof rawActivity !== "object") return null;
  const id = normalizeConfigId(
    rawActivity.id ?? rawActivity.activityId ?? rawActivity.code,
    `activity_${fallbackIndex}`
  );
  if (!id) return null;
  return {
    id,
    name: normalizeString(rawActivity.name ?? rawActivity.label, id),
    type: normalizeString(rawActivity.type, "operational"),
    status: rawActivity.status === "disabled" || rawActivity.enabled === false ? "disabled" : "active",
    fiscalPolicy: normalizeFiscalPolicy(rawActivity.fiscalPolicy ?? rawActivity.fiscalPolicyId ?? rawActivity.fiscal),
    fiscalDeviceIds: normalizeReferenceIdList(
      rawActivity.fiscalDeviceIds ??
        rawActivity.rtIds ??
        rawActivity.fiscalPrinterIds ??
        (rawActivity.fiscalPrinterId ? [rawActivity.fiscalPrinterId] : [])
    ),
    menuIds: normalizeReferenceIdList(rawActivity.menuIds ?? (rawActivity.menuId ? [rawActivity.menuId] : [])),
    priceListIds: normalizeReferenceIdList(
      rawActivity.priceListIds ??
        rawActivity.listinoIds ??
        rawActivity.listiniIds ??
        (rawActivity.priceListId ? [rawActivity.priceListId] : [])
    ),
    printerIds: normalizeReferenceIdList(rawActivity.printerIds ?? (rawActivity.printerId ? [rawActivity.printerId] : [])),
    precontoPrinterIds: normalizeReferenceIdList(
      rawActivity.precontoPrinterIds ??
        rawActivity.receiptPrinterIds ??
        rawActivity.billPrinterIds ??
        (rawActivity.precontoPrinterId ? [rawActivity.precontoPrinterId] : [])
    ),
    workstationIds: normalizeReferenceIdList(
      rawActivity.workstationIds ??
        rawActivity.stationIds ??
        (rawActivity.workstationId ? [rawActivity.workstationId] : [])
    ),
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
  if (!id) return null;
  return {
    id,
    name: normalizeString(rawRoom.name ?? rawRoom.label ?? rawRoom.roomName, id),
    status: rawRoom.status === "disabled" || rawRoom.enabled === false ? "disabled" : "active",
    menuIds: normalizeReferenceIdList(rawRoom.menuIds ?? (rawRoom.menuId ? [rawRoom.menuId] : [])),
    priceListIds: normalizeReferenceIdList(
      rawRoom.priceListIds ?? rawRoom.listinoIds ?? rawRoom.listiniIds ?? (rawRoom.priceListId ? [rawRoom.priceListId] : [])
    ),
    waiterUserIds: uniqueStrings(rawRoom.waiterUserIds),
    printerIds: normalizeReferenceIdList(rawRoom.printerIds ?? (rawRoom.printerId ? [rawRoom.printerId] : [])),
    precontoPrinterIds: normalizeReferenceIdList(
      rawRoom.precontoPrinterIds ??
        rawRoom.receiptPrinterIds ??
        rawRoom.billPrinterIds ??
        (rawRoom.precontoPrinterId ? [rawRoom.precontoPrinterId] : [])
    ),
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
    raw: rawRoom,
  };
}

function collectActivities(settings) {
  const configured = (Array.isArray(settings?.activities) ? settings.activities : [])
    .map((entry, index) => normalizeActivity(entry, index + 1))
    .filter((entry) => entry !== null);
  if (configured.length > 0) return configured;
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
      workstationIds: [],
    },
  ];
}

function collectRooms(settings) {
  const roomsById = new Map();
  const isRichRoomRaw = (raw) =>
    raw &&
    typeof raw === "object" &&
    (Array.isArray(raw.cashPoints) ||
      Array.isArray(raw.workstations) ||
      Array.isArray(raw.menuIds) ||
      Array.isArray(raw.waiterUserIds) ||
      Array.isArray(raw.printerIds));
  const addRoom = (room, index) => {
    const normalized = normalizeRoom(room, index);
    if (!normalized) return;
    const current = roomsById.get(normalized.id);
    const raw = isRichRoomRaw(current?.raw) && !isRichRoomRaw(normalized.raw)
      ? current.raw
      : normalized.raw ?? current?.raw;
    roomsById.set(normalized.id, {
      ...current,
      ...normalized,
      menuIds: normalized.menuIds.length > 0 ? normalized.menuIds : current?.menuIds ?? [],
      priceListIds: normalized.priceListIds.length > 0 ? normalized.priceListIds : current?.priceListIds ?? [],
      waiterUserIds: normalized.waiterUserIds.length > 0 ? normalized.waiterUserIds : current?.waiterUserIds ?? [],
      printerIds: normalized.printerIds.length > 0 ? normalized.printerIds : current?.printerIds ?? [],
      precontoPrinterIds:
        normalized.precontoPrinterIds.length > 0 ? normalized.precontoPrinterIds : current?.precontoPrinterIds ?? [],
      menuSchedules: normalized.menuSchedules.length > 0 ? normalized.menuSchedules : current?.menuSchedules ?? [],
      priceListSchedules: normalized.priceListSchedules.length > 0 ? normalized.priceListSchedules : current?.priceListSchedules ?? [],
      raw,
    });
  };
  (Array.isArray(settings?.areas) ? settings.areas : []).forEach((area, index) => addRoom(area, index + 1));
  (Array.isArray(settings?.rooms) ? settings.rooms : []).forEach((room, index) => addRoom(room, index + 1));
  (Array.isArray(settings?.tables) ? settings.tables : []).forEach((table, index) => {
    const roomId = normalizeConfigId(table?.roomId ?? table?.areaId, "");
    const roomName = normalizeString(table?.roomName ?? table?.type ?? roomId);
    if (!roomId && !roomName) return;
    addRoom({ id: roomId || normalizeConfigId(roomName, `room_from_table_${index + 1}`), name: roomName }, index + 1);
  });
  return [...roomsById.values()];
}

function collectBindings(settings) {
  return (Array.isArray(settings?.activityRoomBindings) ? settings.activityRoomBindings : [])
    .map((entry, index) => {
      const activityId = normalizeConfigId(entry?.activityId ?? entry?.activity ?? entry?.attivitaId, "");
      const roomId = normalizeConfigId(entry?.roomId ?? entry?.room ?? entry?.salaId, "");
      if (!activityId || !roomId) return null;
      return {
        id: normalizeConfigId(entry?.id, `activity_room_${index + 1}`),
        activityId,
        roomId,
        status: entry?.status === "disabled" || entry?.enabled === false ? "disabled" : "active",
      };
    })
    .filter((entry) => entry !== null);
}

function collectConfiguredWorkstationAliases(settings) {
  const aliases = [];
  const addWorkstation = (workstation) => {
    if (!workstation || typeof workstation !== "object") return;
    const id = normalizeConfigId(
      workstation.id ?? workstation.workstationId ?? workstation.stationId,
      ""
    );
    if (!id) return;
    const tokens = [
      workstation.id,
      workstation.workstationId,
      workstation.stationId,
      workstation.stationName,
      workstation.station,
      workstation.name,
      workstation.label,
    ]
      .map((entry) => normalizeConfigId(entry, ""))
      .filter(Boolean);
    aliases.push({ id, tokens: uniqueStrings([id, ...tokens]) });
  };
  (Array.isArray(settings?.workstations) ? settings.workstations : []).forEach(addWorkstation);
  for (const area of Array.isArray(settings?.areas) ? settings.areas : []) {
    (Array.isArray(area?.workstations) ? area.workstations : []).forEach(addWorkstation);
  }
  for (const room of Array.isArray(settings?.rooms) ? settings.rooms : []) {
    (Array.isArray(room?.workstations) ? room.workstations : []).forEach(addWorkstation);
  }
  return aliases;
}

export function resolveConfiguredWorkstationId(settings, value) {
  const token = normalizeConfigId(value, "");
  if (!token) return "";
  const aliases = collectConfiguredWorkstationAliases(settings);
  const match = aliases.find((entry) => entry.tokens.includes(token));
  return match?.id ?? token;
}

function collectTableIdsForRoom(settings, roomId, roomName) {
  const safeRoomId = normalizeConfigId(roomId, "");
  const safeRoomName = normalizeString(roomName).toLowerCase();
  return uniqueStrings(
    (Array.isArray(settings?.tables) ? settings.tables : [])
      .filter((table) => {
        const tableRoomId = normalizeConfigId(table?.roomId ?? table?.areaId, "");
        if (tableRoomId) return tableRoomId === safeRoomId;
        return normalizeString(table?.roomName ?? table?.type).toLowerCase() === safeRoomName;
      })
      .map((table) => table?.id ?? table?.tableId)
  );
}

function collectPrintersById(settings) {
  return new Map(
    (Array.isArray(settings?.printers) ? settings.printers : [])
      .map((printer) => {
        const id = normalizeConfigId(printer?.id ?? printer?.printerId, "");
        if (!id) return null;
        return [
          id,
          {
            id,
            purpose: normalizeString(printer?.purpose, "generic").toLowerCase(),
            active: printer?.active !== false && printer?.status !== "disabled",
          },
        ];
      })
      .filter((entry) => entry !== null)
  );
}

function isFiscalPrinterId(printerId, printersById, fiscalDeviceIds) {
  const safePrinterId = normalizeConfigId(printerId, "");
  if (!safePrinterId) return false;
  const printer = printersById.get(safePrinterId);
  if (printer?.purpose === "fiscal") return true;
  const fiscalIds = new Set(fiscalDeviceIds.map((entry) => normalizeConfigId(entry, "")));
  return fiscalIds.has(safePrinterId) || fiscalIds.has(`rt_${safePrinterId}`);
}

function filterNonFiscalPrinterIds(printerIds, printersById, fiscalDeviceIds) {
  return normalizeReferenceIdList(printerIds).filter(
    (printerId) => !isFiscalPrinterId(printerId, printersById, fiscalDeviceIds)
  );
}

function collectLegacyFiscalIdsFromRoom(room) {
  const raw = room?.raw ?? room;
  const directIds = normalizeReferenceIdList(
    raw?.fiscalPrinterIds ?? raw?.fiscalDeviceIds ?? (raw?.fiscalPrinterId ? [raw.fiscalPrinterId] : [])
  );
  const cashPointFiscalIds = [];
  for (const cashPoint of Array.isArray(raw?.cashPoints) ? raw.cashPoints : []) {
    const fiscalId = normalizeConfigId(cashPoint?.fiscalPrinterId ?? cashPoint?.fiscalDeviceId, "");
    if (fiscalId) cashPointFiscalIds.push(fiscalId);
  }
  return uniqueStrings([...directIds, ...cashPointFiscalIds]);
}

function collectLegacyWarnings(room, workstationId) {
  const warnings = [];
  const raw = room?.raw ?? room;
  const legacyFiscalIds = collectLegacyFiscalIdsFromRoom(room);
  if (legacyFiscalIds.length > 0) {
    warnings.push({
      code: "legacy_room_fiscal_assignment_ignored",
      message: "Fiscalita legacy presente sulla sala: ignorata dal modello operativo v2.",
      fiscalDeviceIds: legacyFiscalIds,
    });
  }
  if (Array.isArray(raw?.cashPoints) && raw.cashPoints.length > 0) {
    warnings.push({
      code: "legacy_room_cash_points_present",
      message: "Cash point legacy presenti sulla sala: disponibili solo per migrazione/diagnostica.",
      cashPointIds: uniqueStrings(raw.cashPoints.map((entry) => entry?.id ?? entry?.code)).map((entry) =>
        normalizeConfigId(entry, "")
      ).filter(Boolean),
    });
  }
  if (Array.isArray(raw?.workstations) && raw.workstations.length > 0) {
    warnings.push({
      code: "legacy_room_workstations_present",
      message: "Postazioni legacy presenti sulla sala: il modello operativo v2 usa postazioni assegnate all'attivita.",
      workstationIds: uniqueStrings(raw.workstations.map((entry) => entry?.id ?? entry?.stationId)).map((entry) =>
        normalizeConfigId(entry, "")
      ).filter(Boolean),
    });
  }
  if (workstationId) {
    warnings.push({
      code: "workstation_context_requested",
      message: "Il contesto operativo include una postazione esplicita.",
      workstationId,
    });
  }
  return warnings;
}

export class OperationalContextError extends Error {
  constructor(message, { code = "OPERATIONAL_CONTEXT_ERROR", status = 400, details = {} } = {}) {
    super(message);
    this.name = "OperationalContextError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new OperationalContextError(message, { code, details });
}

export function resolveOperationalContext({
  settings,
  activityId,
  roomId,
  workstationId = "",
  userId = "",
  now,
} = {}) {
  const locale = normalizeLocale(settings?.locale);
  const activities = collectActivities(settings);
  const rooms = collectRooms(settings);
  const bindings = collectBindings(settings);
  const safeActivityId = normalizeConfigId(activityId, "");
  const safeRoomId = normalizeConfigId(roomId, "");
  const safeWorkstationId = resolveConfiguredWorkstationId(settings, workstationId);
  const safeUserId = normalizeString(userId);

  if (!safeActivityId) {
    fail("activity_required", "activityId obbligatorio per il contesto operativo.");
  }
  if (!safeRoomId) {
    fail("room_required", "roomId obbligatorio per il contesto operativo.");
  }

  const activity = activities.find((entry) => entry.id === safeActivityId);
  if (!activity || activity.status === "disabled") {
    fail("activity_not_found", "Attivita non configurata o non attiva.", { activityId: safeActivityId });
  }

  const room = rooms.find((entry) => entry.id === safeRoomId);
  if (!room || room.status === "disabled") {
    fail("room_not_found", "Sala non configurata o non attiva.", { roomId: safeRoomId });
  }

  const binding = bindings.find(
    (entry) => entry.activityId === activity.id && entry.roomId === room.id && entry.status !== "disabled"
  );
  if (!binding) {
    fail("activity_room_binding_not_found", "Sala non collegata all'attivita operativa corrente.", {
      activityId: activity.id,
      roomId: room.id,
    });
  }

  if (
    safeWorkstationId &&
    activity.workstationIds.length > 0 &&
    !activity.workstationIds.includes(safeWorkstationId)
  ) {
    fail("workstation_not_bound_to_activity", "Postazione non collegata all'attivita operativa corrente.", {
      activityId: activity.id,
      roomId: room.id,
      workstationId: safeWorkstationId,
    });
  }

  const printersById = collectPrintersById(settings);
  const fiscalDeviceIds = normalizeReferenceIdList(activity.fiscalDeviceIds);
  const resolutionDate = resolvedAtDate(now);
  const activityPrinterIds = filterNonFiscalPrinterIds(activity.printerIds, printersById, fiscalDeviceIds);
  const roomPrinterIds = filterNonFiscalPrinterIds(room.printerIds, printersById, fiscalDeviceIds);
  const activityPrecontoPrinterIds = filterNonFiscalPrinterIds(activity.precontoPrinterIds, printersById, fiscalDeviceIds);
  const roomPrecontoPrinterIds = filterNonFiscalPrinterIds(room.precontoPrinterIds, printersById, fiscalDeviceIds);
  const scheduledActivityMenuIds = resolveScheduledIds(
    [...normalizeMenuScheduleRules(settings?.menuSchedules, "menuIds", "global_menu_schedule"), ...activity.menuSchedules],
    "menuIds",
    resolutionDate
  );
  const scheduledRoomMenuIds = resolveScheduledIds(room.menuSchedules, "menuIds", resolutionDate);
  const scheduledActivityPriceListIds = resolveScheduledIds(
    [...normalizeMenuScheduleRules(settings?.priceListSchedules, "priceListIds", "global_price_list_schedule"), ...activity.priceListSchedules],
    "priceListIds",
    resolutionDate
  );
  const scheduledRoomPriceListIds = resolveScheduledIds(room.priceListSchedules, "priceListIds", resolutionDate);
  const effectiveMenuIds = uniqueStrings([
    ...activity.menuIds,
    ...scheduledActivityMenuIds,
    ...room.menuIds,
    ...scheduledRoomMenuIds,
  ]);
  const effectivePriceListIds = uniqueStrings([
    ...activity.priceListIds,
    ...scheduledActivityPriceListIds,
    ...room.priceListIds,
    ...scheduledRoomPriceListIds,
  ]);
  const effectivePrinterIds = uniqueStrings([...activityPrinterIds, ...roomPrinterIds]);
  const effectivePrecontoPrinterIds = roomPrecontoPrinterIds.length > 0
    ? uniqueStrings(roomPrecontoPrinterIds)
    : activityPrecontoPrinterIds.length > 0
      ? uniqueStrings(activityPrecontoPrinterIds)
      : [];
  const tableIds = collectTableIdsForRoom(settings, room.id, room.name);
  const waiterUserIds = uniqueStrings(room.waiterUserIds);
  const legacyWarnings = collectLegacyWarnings(room, safeWorkstationId);

  return {
    schemaVersion: 2,
    localeId: locale.id,
    activityId: activity.id,
    activityName: activity.name,
    roomId: room.id,
    roomName: room.name,
    bindingId: binding.id,
    workstationId: safeWorkstationId,
    userId: safeUserId,
    fiscalPolicy: activity.fiscalPolicy,
    fiscalDeviceIds,
    effectiveMenuIds,
    menuIds: effectiveMenuIds,
    scheduledActivityMenuIds,
    scheduledRoomMenuIds,
    effectivePriceListIds,
    priceListIds: effectivePriceListIds,
    scheduledActivityPriceListIds,
    scheduledRoomPriceListIds,
    effectivePrinterIds,
    effectivePrecontoPrinterIds,
    printerIds: effectivePrinterIds,
    precontoPrinterIds: effectivePrecontoPrinterIds,
    activityPrinterIds,
    roomPrinterIds,
    activityPrecontoPrinterIds,
    roomPrecontoPrinterIds,
    tableIds,
    waiterUserIds,
    workstationIds: uniqueStrings(activity.workstationIds),
    legacyWarnings,
    resolvedAt: resolvedAtIso(now),
  };
}
