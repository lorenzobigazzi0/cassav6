export function createPosAreaConfigHelpers(options = {}) {
  const {
    normalizeConfigId = (value, fallback = "config") => String(value ?? "").trim() || fallback,
    normalizeReferenceIdList = (value) =>
      (Array.isArray(value) ? value : []).map((entry) => normalizeConfigId(entry, "")).filter(Boolean),
    normalizeStringList = (value, maxLength = 16, itemMaxLength = 64) =>
      (Array.isArray(value) ? value : []).map((entry) => String(entry ?? "").trim().slice(0, itemMaxLength)).filter(Boolean).slice(0, maxLength),
    normalizeMenuScheduleRules = () => [],
  } = options;

  function resolveConfiguredAreaMinimumTables(area) {
    const parsed = Number(
      area?.minimumTables ??
        area?.tableCount ??
        area?.tablesCount ??
        area?.defaultTableCount ??
        area?.defaultTables ??
        0
    );
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(Math.min(Math.trunc(parsed), 500), 0);
  }

  function sanitizePosAreaCashPoint(entry, fallbackId = "cash_point", options = {}) {
    if (!entry || typeof entry !== "object") return null;
    const name = String(entry.name ?? entry.label ?? "").trim().slice(0, 64);
    if (!name) return null;
    const printerIds = normalizeReferenceIdList(entry.printerIds, options.printerIds, 12);
    const fiscalPrinterId = normalizeConfigId(entry.fiscalPrinterId, "");
    return {
      id: normalizeConfigId(entry.id, fallbackId),
      name,
      code: normalizeConfigId(entry.code ?? entry.name, fallbackId),
      printerIds,
      fiscalPrinterId: options.printerIds?.has(fiscalPrinterId) ? fiscalPrinterId : null,
    };
  }

  function sanitizePosAreaWorkstation(entry, fallbackId = "workstation", options = {}) {
    if (!entry || typeof entry !== "object") return null;
    const name = String(entry.name ?? entry.label ?? "").trim().slice(0, 64);
    if (!name) return null;
    const requestedStationName = String(entry.stationName ?? entry.station ?? "").trim().slice(0, 64);
    return {
      id: normalizeConfigId(entry.id, fallbackId),
      name,
      stationName: requestedStationName || name,
      active: entry.active !== false && entry.status !== "disabled",
      status: entry.active === false || entry.status === "disabled" ? "disabled" : "active",
      useOwnPrinters: entry.useOwnPrinters === true,
      printOrderEnabled: entry.printOrderEnabled !== false,
      printPrecontoEnabled: entry.printPrecontoEnabled !== false,
      printTableChangesEnabled: entry.printTableChangesEnabled !== false,
      roomIds: normalizeReferenceIdList(entry.roomIds ?? entry.rooms ?? entry.areaIds, null, 64),
      printerIds: normalizeReferenceIdList(entry.printerIds, options.printerIds, 12),
      precontoPrinterIds: normalizeReferenceIdList(
        entry.precontoPrinterIds ??
          entry.receiptPrinterIds ??
          entry.billPrinterIds ??
          (entry.precontoPrinterId ? [entry.precontoPrinterId] : []),
        options.printerIds,
        12
      ),
      menuIds: normalizeReferenceIdList(entry.menuIds ?? entry.enabledMenuIds, options.menuIds ?? null, 32),
      categoryIds: normalizeStringList(entry.categoryIds ?? entry.enabledCategoryIds, 80, 80),
      productIds: normalizeReferenceIdList(entry.productIds ?? entry.enabledProductIds, null, 400),
      excludedCategoryIds: normalizeStringList(
        entry.excludedCategoryIds ?? entry.excludeCategoryIds ?? entry.disabledCategoryIds,
        80,
        80
      ),
      excludedProductIds: normalizeReferenceIdList(
        entry.excludedProductIds ?? entry.excludeProductIds ?? entry.disabledProductIds,
        null,
        400
      ),
    };
  }

  function sanitizePosArea(entry, fallbackId = "area", options = {}) {
    if (!entry || typeof entry !== "object") return null;
    const name = String(entry.name ?? "").trim().slice(0, 64);
    if (!name) return null;
    const id = normalizeConfigId(entry.id, fallbackId);
    const minimumTables = resolveConfiguredAreaMinimumTables(entry);
    return {
      id,
      name,
      ...(minimumTables > 0 ? { minimumTables } : {}),
      notes: String(entry.notes ?? "").trim().slice(0, 240),
      menuIds: normalizeReferenceIdList(entry.menuIds, options.menuIds, 16),
      priceListIds: normalizeReferenceIdList(
        entry.priceListIds ?? entry.listinoIds ?? entry.listiniIds,
        null,
        16
      ),
      waiterUserIds: normalizeReferenceIdList(entry.waiterUserIds, options.userIds, 20),
      printerIds: normalizeReferenceIdList(entry.printerIds, options.printerIds, 12),
      precontoPrinterIds: normalizeReferenceIdList(
        entry.precontoPrinterIds ??
          entry.receiptPrinterIds ??
          entry.billPrinterIds ??
          (entry.precontoPrinterId ? [entry.precontoPrinterId] : []),
        options.printerIds,
        12
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
      cashPoints: (Array.isArray(entry.cashPoints) ? entry.cashPoints : [])
        .map((item, index) =>
          sanitizePosAreaCashPoint(item, `${id}_cash_${index + 1}`, options)
        )
        .filter((item) => item !== null),
      workstations: (Array.isArray(entry.workstations) ? entry.workstations : [])
        .map((item, index) =>
          sanitizePosAreaWorkstation(item, `${id}_station_${index + 1}`, options)
        )
        .filter((item) => item !== null),
    };
  }

  return {
    resolveConfiguredAreaMinimumTables,
    sanitizePosArea,
    sanitizePosAreaCashPoint,
    sanitizePosAreaWorkstation,
  };
}
