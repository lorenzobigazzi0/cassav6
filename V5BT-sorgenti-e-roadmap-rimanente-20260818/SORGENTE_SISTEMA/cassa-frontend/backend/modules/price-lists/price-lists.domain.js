const DEFAULT_TIME_ZONE = "Europe/Rome";
const MENU_PRICE_SCHEDULE_FORMATTERS_MAX = 16;
const MENU_PRICE_SCHEDULE_MINUTES_CACHE_MAX = 256;
const menuPriceScheduleFormatters = new Map();
const menuPriceScheduleMinutesCache = new Map();

export function roundPriceListMoney(value) {
  return Math.round(value * 100) / 100;
}

export function readPriceListMoneyValue(value) {
  if (typeof value === "string") {
    const normalized = value
      .replace(/[^\d,.-]/g, "")
      .replace(/\.(?=\d{3}(?:\D|$))/g, "")
      .replace(",", ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed >= 0 ? roundPriceListMoney(parsed) : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? roundPriceListMoney(parsed) : null;
}

export function parseMenuClockMinutes(value) {
  const match = String(value ?? "").trim().match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

export function formatMenuClockMinutes(minutes) {
  const safeMinutes = Math.max(0, Math.min(Math.trunc(Number(minutes) || 0), 1439));
  return `${String(Math.floor(safeMinutes / 60)).padStart(2, "0")}:${String(safeMinutes % 60).padStart(2, "0")}`;
}

export function normalizeMenuItemPriceSchedule(value) {
  const source = Array.isArray(value) ? value : [];
  const normalized = [];
  source.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const startMinutes = parseMenuClockMinutes(entry.start ?? entry.from ?? entry.startTime ?? entry.fromTime);
    const endMinutes = parseMenuClockMinutes(entry.end ?? entry.to ?? entry.endTime ?? entry.toTime);
    const price = readPriceListMoneyValue(entry.price ?? entry.value ?? entry.amount);
    if (startMinutes === null || endMinutes === null || price === null || price < 0) return;
    normalized.push({
      id: String(entry.id ?? entry.name ?? entry.label ?? `schedule_${index + 1}`).trim().slice(0, 48) || `schedule_${index + 1}`,
      label: String(entry.label ?? entry.name ?? "").trim().slice(0, 80),
      start: formatMenuClockMinutes(startMinutes),
      end: formatMenuClockMinutes(endMinutes),
      price,
      enabled: entry.enabled !== false,
    });
  });
  return normalized;
}

function resolveScheduleOptions(options = {}) {
  return {
    appEnv: String(options.appEnv ?? process.env.NODE_ENV ?? "").trim(),
    env: options.env ?? process.env,
    timeZone: String(options.timeZone ?? DEFAULT_TIME_ZONE).trim() || DEFAULT_TIME_ZONE,
  };
}

function getMenuPriceScheduleFormatter(timeZone) {
  const key = String(timeZone ?? DEFAULT_TIME_ZONE).trim() || DEFAULT_TIME_ZONE;
  const cached = menuPriceScheduleFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("it-IT", {
    timeZone: key,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  menuPriceScheduleFormatters.set(key, formatter);
  while (menuPriceScheduleFormatters.size > MENU_PRICE_SCHEDULE_FORMATTERS_MAX) {
    menuPriceScheduleFormatters.delete(menuPriceScheduleFormatters.keys().next().value);
  }
  return formatter;
}

function cacheMenuPriceScheduleMinutes(key, value) {
  menuPriceScheduleMinutesCache.set(key, value);
  while (menuPriceScheduleMinutesCache.size > MENU_PRICE_SCHEDULE_MINUTES_CACHE_MAX) {
    menuPriceScheduleMinutesCache.delete(menuPriceScheduleMinutesCache.keys().next().value);
  }
  return value;
}

export function getMenuPriceScheduleDate(date = null, options = {}) {
  if (date instanceof Date) return date;
  const config = resolveScheduleOptions(options);
  if (config.appEnv === "test") {
    const override = String(config.env?.MENU_PRICE_SCHEDULE_NOW_ISO ?? "").trim();
    if (override) {
      const parsed = new Date(override);
      if (Number.isFinite(parsed.getTime())) return parsed;
    }
  }
  return new Date();
}

export function getMenuPriceScheduleMinutes(date = null, options = {}) {
  const config = resolveScheduleOptions(options);
  const effectiveDate = getMenuPriceScheduleDate(date, config);
  const timestampMs = effectiveDate instanceof Date ? effectiveDate.getTime() : NaN;
  const cacheKey = Number.isFinite(timestampMs)
    ? `${config.timeZone}|${Math.floor(timestampMs / 60_000)}`
    : "";
  if (cacheKey && menuPriceScheduleMinutesCache.has(cacheKey)) {
    return menuPriceScheduleMinutesCache.get(cacheKey);
  }
  try {
    const parts = getMenuPriceScheduleFormatter(config.timeZone).formatToParts(effectiveDate);
    const hours = Number(parts.find((part) => part.type === "hour")?.value);
    const minutes = Number(parts.find((part) => part.type === "minute")?.value);
    if (Number.isInteger(hours) && Number.isInteger(minutes)) {
      return cacheKey
        ? cacheMenuPriceScheduleMinutes(cacheKey, hours * 60 + minutes)
        : hours * 60 + minutes;
    }
  } catch {
    // Fall back to server local time if ICU/time zone data is not available.
  }
  const fallback = effectiveDate.getHours() * 60 + effectiveDate.getMinutes();
  return cacheKey ? cacheMenuPriceScheduleMinutes(cacheKey, fallback) : fallback;
}

export function menuScheduleRuleMatchesNow(rule, minutesNow = null, options = {}) {
  if (!rule || rule.enabled === false) return false;
  const start = parseMenuClockMinutes(rule.start);
  const end = parseMenuClockMinutes(rule.end);
  if (start === null || end === null || start === end) return false;
  const safeMinutesNow = minutesNow === null || minutesNow === undefined
    ? getMenuPriceScheduleMinutes(null, options)
    : minutesNow;
  return start < end
    ? safeMinutesNow >= start && safeMinutesNow < end
    : safeMinutesNow >= start || safeMinutesNow < end;
}

export function resolveMenuItemPriceSchedule(item, date = null, options = {}) {
  const basePrice = readPriceListMoneyValue(item?.price) ?? 0;
  const schedule = normalizeMenuItemPriceSchedule(
    item?.priceSchedule ?? item?.timedPrices ?? item?.timePriceSchedule ?? item?.listinoTemporizzato
  );
  const minutesNow = getMenuPriceScheduleMinutes(date, options);
  const activeRule = schedule.find((rule) => menuScheduleRuleMatchesNow(rule, minutesNow, options)) ?? null;
  const price = activeRule ? activeRule.price : basePrice;
  return {
    price: roundPriceListMoney(Math.max(Number(price) || 0, 0)),
    basePrice: roundPriceListMoney(Math.max(Number(basePrice) || 0, 0)),
    activeRule,
    schedule,
  };
}

export function applyRuntimeMenuItemPrice(item, date = null, options = {}) {
  if (!item || typeof item !== "object") return item;
  const resolution = resolveMenuItemPriceSchedule(item, date, options);
  if (resolution.schedule.length === 0) return item;
  return {
    ...item,
    price: resolution.price,
    basePrice: resolution.basePrice,
    currentPriceScheduleId: resolution.activeRule?.id ?? null,
    currentPriceScheduleLabel: resolution.activeRule?.label || resolution.activeRule?.id || null,
    priceSchedule: resolution.schedule,
  };
}

export function resolveMenuItemRuntimePrice(item, date = null, options = {}) {
  return resolveMenuItemPriceSchedule(item, date, options).price;
}

export function collectMenuPriceScheduleBoundaries(menuItems) {
  const boundaries = new Set();
  for (const item of Array.isArray(menuItems) ? menuItems : []) {
    const schedule = normalizeMenuItemPriceSchedule(
      item?.priceSchedule ?? item?.timedPrices ?? item?.timePriceSchedule ?? item?.listinoTemporizzato
    );
    for (const rule of schedule) {
      if (rule.enabled === false) continue;
      const start = parseMenuClockMinutes(rule.start);
      const end = parseMenuClockMinutes(rule.end);
      if (start === null || end === null || start === end) continue;
      boundaries.add(start);
      boundaries.add(end);
    }
  }
  return [...boundaries].sort((left, right) => left - right);
}

export function menuPriceScheduleCacheBucket(menuItems = null, date = null, options = {}) {
  const boundaries = collectMenuPriceScheduleBoundaries(menuItems);
  if (boundaries.length === 0) return "static";
  const minutesNow = getMenuPriceScheduleMinutes(date, options);
  let previousBoundary = boundaries[boundaries.length - 1] - 1440;
  let nextBoundary = boundaries[0] + 1440;
  for (const boundary of boundaries) {
    if (boundary <= minutesNow) {
      previousBoundary = boundary;
    }
    if (boundary > minutesNow) {
      nextBoundary = boundary;
      break;
    }
  }
  const previous = ((previousBoundary % 1440) + 1440) % 1440;
  const next = ((nextBoundary % 1440) + 1440) % 1440;
  return `scheduled:${formatMenuClockMinutes(previous)}-${formatMenuClockMinutes(next)}`;
}

export function createMenuPriceListResolver(options = {}) {
  return {
    parseMenuClockMinutes,
    formatMenuClockMinutes,
    normalizeMenuItemPriceSchedule,
    getMenuPriceScheduleDate: (date = null) => getMenuPriceScheduleDate(date, options),
    getMenuPriceScheduleMinutes: (date = null) => getMenuPriceScheduleMinutes(date, options),
    menuScheduleRuleMatchesNow: (rule, minutesNow = null) => menuScheduleRuleMatchesNow(rule, minutesNow, options),
    resolveMenuItemPriceSchedule: (item, date = null) => resolveMenuItemPriceSchedule(item, date, options),
    applyRuntimeMenuItemPrice: (item, date = null) => applyRuntimeMenuItemPrice(item, date, options),
    resolveMenuItemRuntimePrice: (item, date = null) => resolveMenuItemRuntimePrice(item, date, options),
    collectMenuPriceScheduleBoundaries,
    menuPriceScheduleCacheBucket: (menuItems = null, date = null) => menuPriceScheduleCacheBucket(menuItems, date, options),
  };
}
