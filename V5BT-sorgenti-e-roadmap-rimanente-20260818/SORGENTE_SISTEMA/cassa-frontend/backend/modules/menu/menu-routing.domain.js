import {
  normalizeIntegrationItemKey,
  normalizeIntegrationLookupKey,
  normalizeIntegrationStationScope,
} from "../../integration/integration-utils.js";

function normalizeRoutingToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeRoutingTokenSet(value) {
  return new Set(
    (Array.isArray(value) ? value : [])
      .map(normalizeRoutingToken)
      .filter(Boolean)
  );
}

function setIntersects(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function normalizeReferenceList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,;]+/)
      : value == null
        ? []
        : [value];
  const seen = new Set();
  const out = [];
  source.forEach((entry) => {
    const text = String(entry ?? "").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push(text);
  });
  return out;
}

function normalizeStationList(value) {
  const seen = new Set();
  const out = [];
  normalizeReferenceList(value).forEach((entry) => {
    const station = normalizeIntegrationStationScope(entry);
    if (!station || seen.has(station)) return;
    seen.add(station);
    out.push(station);
  });
  return out;
}

function normalizeStationName(value, fallbackStation = "") {
  return normalizeIntegrationStationScope(value) || normalizeIntegrationStationScope(fallbackStation) || "";
}

function resolveWorkstationStationName(workstation) {
  return normalizeStationName(
    workstation?.stationName ??
      workstation?.station ??
      workstation?.name ??
      workstation?.id
  );
}

function isWorkstationEnabled(workstation) {
  if (!workstation || typeof workstation !== "object") return false;
  if (workstation.enabled === false || workstation.active === false) return false;
  const status = String(workstation.status ?? "active").trim().toLowerCase();
  return status !== "disabled" && status !== "inactive";
}

export function listConfiguredMenuRoutingWorkstations(settings) {
  return (Array.isArray(settings?.workstations) ? settings.workstations : [])
    .filter(isWorkstationEnabled)
    .map((workstation) => {
      const stationName = resolveWorkstationStationName(workstation);
      if (!stationName) return null;
      return {
        workstation,
        stationName,
        ids: normalizeReferenceList([
          workstation?.id,
          workstation?.workstationId,
          workstation?.stationId,
          workstation?.stationName,
          workstation?.station,
          workstation?.name,
        ]),
      };
    })
    .filter(Boolean);
}

export function resolveConfiguredMenuRoutingStations(settings) {
  const seen = new Set();
  const out = [];
  listConfiguredMenuRoutingWorkstations(settings).forEach((entry) => {
    if (!entry.stationName || seen.has(entry.stationName)) return;
    seen.add(entry.stationName);
    out.push(entry.stationName);
  });
  return out;
}

export function findConfiguredMenuRoutingWorkstationForStation(settings, stationRaw) {
  const station = normalizeStationName(stationRaw);
  if (!station) return null;
  const stationKey = normalizeRoutingToken(station);
  const match = listConfiguredMenuRoutingWorkstations(settings).find((entry) => {
    if (normalizeRoutingToken(entry.stationName) === stationKey) return true;
    return entry.ids.some((id) => normalizeRoutingToken(normalizeStationName(id, id)) === stationKey);
  });
  return match?.workstation ?? null;
}

function resolvePreferredConfiguredStation(settings, options = {}) {
  const configuredStations = resolveConfiguredMenuRoutingStations(settings);
  const fallbackStation = normalizeStationName(options.fallbackStation);
  if (configuredStations.length === 0) return fallbackStation;

  const preferredBarStation =
    configuredStations.find((station) => {
      const key = normalizeIntegrationLookupKey(station);
      return key === "bar 1" || key === "bar1" || key.startsWith("bar 1");
    }) ??
    configuredStations.find((station) => normalizeIntegrationLookupKey(station).startsWith("bar"));
  return preferredBarStation || configuredStations[0] || fallbackStation;
}

function resolveStationIdsFromWorkstationRefs(workstationRefs, settings) {
  const refs = normalizeReferenceList(workstationRefs);
  if (refs.length === 0) return [];
  const normalizedRefs = new Set(refs.map(normalizeRoutingToken));
  const matchedStations = [];
  listConfiguredMenuRoutingWorkstations(settings).forEach((entry) => {
    const hasMatch = entry.ids.some((id) => normalizedRefs.has(normalizeRoutingToken(id)));
    if (hasMatch) matchedStations.push(entry.stationName);
  });
  return normalizeStationList(matchedStations);
}

function buildMenuRoutingTokens(item) {
  return {
    productIds: normalizeRoutingTokenSet([
      item?.productId,
      item?.product_id,
      item?.itemId,
      item?.id,
      item?.sku,
      item?.name,
    ]),
    categoryIds: normalizeRoutingTokenSet([
      item?.categoryId,
      item?.category,
      item?.categoryName,
      item?.subcategory,
      item?.subCategory,
      item?.section,
    ]),
    menuIds: normalizeRoutingTokenSet([
      ...(Array.isArray(item?.menuIds) ? item.menuIds : []),
      item?.menuId,
    ]),
  };
}

function buildMenuRoutingLineTokens(line, menuItem = {}) {
  return {
    productIds: normalizeRoutingTokenSet([
      line?.productId,
      line?.product_id,
      line?.itemId,
      line?.id,
      menuItem?.id,
      menuItem?.sku,
      menuItem?.productId,
      menuItem?.name,
    ]),
    categoryIds: normalizeRoutingTokenSet([
      line?.category,
      line?.categoryId,
      line?.categoryName,
      line?.subcategory,
      line?.subCategory,
      line?.section,
      menuItem?.category,
      menuItem?.categoryId,
      menuItem?.categoryName,
      menuItem?.subcategory,
      menuItem?.subCategory,
      menuItem?.section,
    ]),
    menuIds: normalizeRoutingTokenSet([
      ...(Array.isArray(line?.menuIds) ? line.menuIds : []),
      ...(Array.isArray(menuItem?.menuIds) ? menuItem.menuIds : []),
      line?.menuId,
      menuItem?.menuId,
    ]),
  };
}

function workstationHasRoutingAllowList(workstation) {
  return (
    normalizeRoutingTokenSet(workstation?.productIds).size > 0 ||
    normalizeRoutingTokenSet(workstation?.categoryIds).size > 0 ||
    normalizeRoutingTokenSet(workstation?.menuIds).size > 0
  );
}

function isMenuOnlyAllowList(workstation) {
  return (
    normalizeRoutingTokenSet(workstation?.menuIds).size > 0 &&
    normalizeRoutingTokenSet(workstation?.productIds).size === 0 &&
    normalizeRoutingTokenSet(workstation?.categoryIds).size === 0
  );
}

export function workstationAllowsMenuRoutingLine(workstation, line, menuItem = {}) {
  if (!workstation || typeof workstation !== "object") return true;
  const tokens = buildMenuRoutingLineTokens(line, menuItem);
  if (setIntersects(tokens.productIds, normalizeRoutingTokenSet(workstation.excludedProductIds))) return false;
  if (setIntersects(tokens.categoryIds, normalizeRoutingTokenSet(workstation.excludedCategoryIds))) return false;
  if (setIntersects(tokens.menuIds, normalizeRoutingTokenSet(workstation.excludedMenuIds))) return false;

  const allowedProductIds = normalizeRoutingTokenSet(workstation.productIds);
  const allowedCategoryIds = normalizeRoutingTokenSet(workstation.categoryIds);
  const allowedMenuIds = normalizeRoutingTokenSet(workstation.menuIds);
  const hasAllowList =
    allowedProductIds.size > 0 || allowedCategoryIds.size > 0 || allowedMenuIds.size > 0;
  if (!hasAllowList) return true;
  // Compatibilita' catalogo legacy: molte righe ordine portano categoria/prodotto
  // ma non ancora menuId. Una postazione limitata solo al menu principale non deve
  // risultare "non eleggibile" per tutte le comande per assenza del token menu.
  if (isMenuOnlyAllowList(workstation) && tokens.menuIds.size === 0) return true;
  return (
    setIntersects(tokens.productIds, allowedProductIds) ||
    setIntersects(tokens.categoryIds, allowedCategoryIds) ||
    setIntersects(tokens.menuIds, allowedMenuIds)
  );
}

function workstationAllowsMenuItem(workstation, item) {
  if (!workstation || typeof workstation !== "object") return false;
  const tokens = buildMenuRoutingTokens(item);
  if (setIntersects(tokens.productIds, normalizeRoutingTokenSet(workstation.excludedProductIds))) return false;
  if (setIntersects(tokens.categoryIds, normalizeRoutingTokenSet(workstation.excludedCategoryIds))) return false;
  if (setIntersects(tokens.menuIds, normalizeRoutingTokenSet(workstation.excludedMenuIds))) return false;

  const allowedProductIds = normalizeRoutingTokenSet(workstation.productIds);
  const allowedCategoryIds = normalizeRoutingTokenSet(workstation.categoryIds);
  const allowedMenuIds = normalizeRoutingTokenSet(workstation.menuIds);
  if (allowedProductIds.size === 0 && allowedCategoryIds.size === 0 && allowedMenuIds.size === 0) {
    return false;
  }
  if (isMenuOnlyAllowList(workstation) && tokens.menuIds.size === 0) return true;
  return (
    setIntersects(tokens.productIds, allowedProductIds) ||
    setIntersects(tokens.categoryIds, allowedCategoryIds) ||
    setIntersects(tokens.menuIds, allowedMenuIds)
  );
}

function resolveStationsFromWorkstationRules(item, settings) {
  const routedStations = [];
  listConfiguredMenuRoutingWorkstations(settings).forEach(({ workstation, stationName }) => {
    if (!workstationHasRoutingAllowList(workstation)) return;
    if (workstationAllowsMenuItem(workstation, item)) routedStations.push(stationName);
  });
  return normalizeStationList(routedStations);
}

export function normalizeMenuRoutingStationList(value) {
  return normalizeStationList(value);
}

export function sanitizeMenuItemAvailabilityMap(source, options = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }
  const nowIso = typeof options.nowIso === "function" ? options.nowIso : () => new Date().toISOString();
  const next = {};
  Object.entries(source).forEach(([rawKey, rawValue]) => {
    const key = normalizeIntegrationItemKey(rawKey);
    if (!key) return;
    if (rawValue === false) {
      next[key] = false;
      return;
    }
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      return;
    }
    const scope = String(rawValue.scope ?? "").trim().toLowerCase();
    const stationsSource =
      rawValue.stations ?? rawValue.stationIds ?? rawValue.station ?? rawValue.stationName ?? [];
    const stations = normalizeStationList(stationsSource);
    if (rawValue.global === true || scope === "global" || (rawValue.disabled === true && stations.length === 0)) {
      next[key] = false;
      return;
    }
    if (stations.length === 0 && scope !== "station") {
      return;
    }
    next[key] = {
      scope: "station",
      stations,
      updatedAt: String(rawValue.updatedAt ?? nowIso()),
      updatedBy: String(rawValue.updatedBy ?? "").trim().slice(0, 64),
    };
  });
  return next;
}

export function resolveMenuItemAvailabilityInfo(item, itemAvailabilityByKey, stationRaw = "", options = {}) {
  const availability =
    itemAvailabilityByKey && typeof itemAvailabilityByKey === "object"
      ? itemAvailabilityByKey
      : null;
  const currentStation = normalizeIntegrationStationScope(stationRaw);
  if (!availability) {
    return {
      available: true,
      scope: null,
      stations: [],
      matchesStation: false,
    };
  }

  const evaluateEntry = (entry) => {
    if (entry === false) {
      return {
        available: false,
        scope: "global",
        stations: [],
        matchesStation: false,
      };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const scope = String(entry.scope ?? "").trim().toLowerCase();
    const stations = normalizeStationList(entry.stations);
    if (scope === "global") {
      return {
        available: false,
        scope: "global",
        stations,
        matchesStation: currentStation ? stations.includes(currentStation) : false,
      };
    }
    if (stations.length === 0) {
      return null;
    }
    const matchesStation = currentStation ? stations.includes(currentStation) : false;
    const routeStations = currentStation
      ? []
      : resolveMenuRoutingStationsForItem(item, {
          settings: options.settings,
          fallbackStation: options.fallbackStation,
        });
    const blockedOnAllRouteStations =
      !currentStation &&
      routeStations.length > 0 &&
      routeStations.every((station) => stations.includes(station));
    return {
      available: currentStation ? !matchesStation : !blockedOnAllRouteStations,
      scope: "station",
      stations,
      matchesStation,
    };
  };

  const itemIdKey = normalizeIntegrationItemKey(item?.id);
  if (itemIdKey && Object.prototype.hasOwnProperty.call(availability, itemIdKey)) {
    const info = evaluateEntry(availability[itemIdKey]);
    if (info) return info;
  }

  const itemNameKey = normalizeIntegrationItemKey(item?.name);
  if (itemNameKey && Object.prototype.hasOwnProperty.call(availability, itemNameKey)) {
    const info = evaluateEntry(availability[itemNameKey]);
    if (info) return info;
  }

  return {
    available: true,
    scope: null,
    stations: [],
    matchesStation: false,
  };
}

export function resolveMenuItemAvailability(item, itemAvailabilityByKey, stationRaw = "", options = {}) {
  return resolveMenuItemAvailabilityInfo(item, itemAvailabilityByKey, stationRaw, options).available;
}

export function buildMenuItemAvailabilityList(itemAvailabilityByKey, stationRaw = "", options = {}) {
  const sanitized = sanitizeMenuItemAvailabilityMap(itemAvailabilityByKey, options);
  const currentStation = normalizeIntegrationStationScope(stationRaw);
  return Object.entries(sanitized)
    .map(([key, entry]) => {
      if (entry === false) {
        return {
          key,
          available: false,
          availabilityScope: "global",
          unavailableStations: [],
          unavailableForStation: false,
        };
      }
      const stations = normalizeStationList(
        entry?.stations ?? entry?.stationIds ?? entry?.station ?? entry?.stationName ?? []
      );
      return {
        key,
        available: currentStation ? !stations.includes(currentStation) : true,
        availabilityScope: "station",
        unavailableStations: stations,
        unavailableForStation: currentStation ? stations.includes(currentStation) : false,
        updatedAt: String(entry?.updatedAt ?? "").trim(),
        updatedBy: String(entry?.updatedBy ?? "").trim(),
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key, "it-IT"));
}

export function isPremiumAlcoholText(...values) {
  const text = normalizeIntegrationLookupKey(values.filter((entry) => entry !== null && entry !== undefined).join(" "));
  if (!text) return false;
  const hasPremium = text.includes("premium");
  const hasAlcoholMarker =
    text.includes("alcol") ||
    text.includes("alcool") ||
    text.includes("drink") ||
    text.includes("cocktail") ||
    text.includes("gin") ||
    text.includes("vodka") ||
    text.includes("rum") ||
    text.includes("negroni") ||
    text.includes("americano") ||
    text.includes("spritz") ||
    text.includes("mojito") ||
    text.includes("long island") ||
    text.includes("whisky") ||
    text.includes("wisky");
  return hasPremium && hasAlcoholMarker;
}

export function resolveMenuRoutingDepartment(categoryRaw) {
  const category = String(categoryRaw ?? "").trim().toLowerCase();
  if (category.includes("caff")) {
    return { id: "dept_caffetteria", name: "Caffetteria" };
  }
  return { id: "dept_bar", name: "Bar" };
}

export function resolveMenuRoutingStationsForItem(item, options = {}) {
  const settings = options.settings && typeof options.settings === "object" ? options.settings : null;
  const fallbackStation = normalizeStationName(options.fallbackStation);
  const explicitStations = normalizeStationList(
    item?.stations ?? item?.stationIds ?? item?.station ?? item?.stationName ?? []
  );
  if (explicitStations.length > 0) return explicitStations;

  const workstationStations = resolveStationIdsFromWorkstationRefs(
    item?.workstationIds ?? item?.workstationId ?? [],
    settings
  );
  if (workstationStations.length > 0) return workstationStations;

  const workstationRuleStations = resolveStationsFromWorkstationRules(item, settings);
  if (workstationRuleStations.length > 0) return workstationRuleStations;

  const category = normalizeIntegrationLookupKey(item?.category);
  if (isPremiumAlcoholText(category) || category.includes("cocktail")) {
    const preferredStation = resolvePreferredConfiguredStation(settings, { fallbackStation });
    return preferredStation ? [preferredStation] : [];
  }

  const configuredStations = resolveConfiguredMenuRoutingStations(settings);
  if (configuredStations.length > 0) return [configuredStations[0]];
  return fallbackStation ? [fallbackStation] : [];
}

export function resolveMenuCatalogStationsForItem(item, categoryLabel, activeStations = [], options = {}) {
  const routeStations = resolveMenuRoutingStationsForItem(
    {
      ...item,
      category: categoryLabel,
    },
    options
  );
  const activeStationList = normalizeStationList(activeStations);
  if (activeStationList.length === 0) {
    return routeStations;
  }

  const activeStationSet = new Set(activeStationList);
  const activeRouteStations = routeStations.filter((station) => activeStationSet.has(station));
  if (activeRouteStations.length > 0) {
    return activeRouteStations;
  }

  return activeStationList;
}

export function pickMenuRoutingStationForLine(line, options = {}) {
  const menuItem = options.menuItem && typeof options.menuItem === "object" ? options.menuItem : null;
  const markers = Array.isArray(options.markers) ? options.markers : [];
  const variantDelta = Number(options.variantDelta) || 0;
  const settings = options.settings && typeof options.settings === "object" ? options.settings : null;
  const fallbackStation = normalizeStationName(options.fallbackStation);

  if (
    isPremiumAlcoholText(
      line?.name,
      line?.productNameSnapshot,
      line?.category,
      menuItem?.name,
      menuItem?.category,
      ...markers
    ) ||
    (variantDelta > 0 && isPremiumAlcoholText("premium", line?.name, menuItem?.category, ...markers))
  ) {
    return resolvePreferredConfiguredStation(settings, { fallbackStation });
  }

  const routeStations = resolveMenuRoutingStationsForItem(menuItem ?? { category: line?.category }, {
    settings,
    fallbackStation,
  });
  return normalizeStationName(routeStations[0], fallbackStation);
}
