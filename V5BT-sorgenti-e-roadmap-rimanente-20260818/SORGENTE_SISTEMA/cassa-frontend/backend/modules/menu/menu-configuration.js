const WEEKDAY_IDS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAY_ALIASES = new Map([
  ["lun", "mon"],
  ["lunedi", "mon"],
  ["lunedì", "mon"],
  ["monday", "mon"],
  ["mon", "mon"],
  ["mar", "tue"],
  ["martedi", "tue"],
  ["martedì", "tue"],
  ["tuesday", "tue"],
  ["tue", "tue"],
  ["mer", "wed"],
  ["mercoledi", "wed"],
  ["mercoledì", "wed"],
  ["wednesday", "wed"],
  ["wed", "wed"],
  ["gio", "thu"],
  ["giovedi", "thu"],
  ["giovedì", "thu"],
  ["thursday", "thu"],
  ["thu", "thu"],
  ["ven", "fri"],
  ["venerdi", "fri"],
  ["venerdì", "fri"],
  ["friday", "fri"],
  ["fri", "fri"],
  ["sab", "sat"],
  ["sabato", "sat"],
  ["saturday", "sat"],
  ["sat", "sat"],
  ["dom", "sun"],
  ["domenica", "sun"],
  ["sunday", "sun"],
  ["sun", "sun"],
]);

export const MENU_WEEKDAY_OPTIONS = WEEKDAY_IDS.map((id) => ({
  id,
  label: {
    mon: "Lunedi",
    tue: "Martedi",
    wed: "Mercoledi",
    thu: "Giovedi",
    fri: "Venerdi",
    sat: "Sabato",
    sun: "Domenica",
  }[id],
}));

export function normalizeMenuConfigId(value, fallback = "") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function normalizeString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  const source = Array.isArray(values)
    ? values
    : typeof values === "string"
      ? values.split(/[\n,;]+/)
      : values == null
        ? []
        : [values];
  for (const value of source) {
    const normalized = normalizeString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeReferenceList(value, maxLength = 500) {
  return uniqueStrings(value)
    .map((entry) => normalizeMenuConfigId(entry, ""))
    .filter(Boolean)
    .slice(0, maxLength);
}

function readMoney(value) {
  if (typeof value === "string") {
    const normalized = value
      .replace(/[^\d,.-]/g, "")
      .replace(/\.(?=\d{3}(?:\D|$))/g, "")
      .replace(",", ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : null;
}

function parseClockMinutes(value) {
  const match = String(value ?? "").trim().match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatClockMinutes(minutes) {
  const safe = Math.max(0, Math.min(Math.trunc(Number(minutes) || 0), 1439));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

export function normalizeMenuWeekdays(value) {
  if (value === "all" || value === "*" || value === true) return [...WEEKDAY_IDS];
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,;]+/)
      : [];
  const selected = [];
  const seen = new Set();
  for (const entry of source) {
    const key = String(entry ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
    const day = WEEKDAY_ALIASES.get(key);
    if (!day || seen.has(day)) continue;
    seen.add(day);
    selected.push(day);
  }
  return selected.length ? selected : [...WEEKDAY_IDS];
}

export function normalizeMenuScheduleRules(value, targetField = "menuIds", fallbackPrefix = "schedule") {
  const source = Array.isArray(value) ? value : [];
  const rules = [];
  source.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const start = parseClockMinutes(entry.start ?? entry.from ?? entry.startTime ?? entry.fromTime);
    const end = parseClockMinutes(entry.end ?? entry.to ?? entry.endTime ?? entry.toTime);
    const ids = normalizeReferenceList(
      entry[targetField] ??
        entry.targetIds ??
        entry.targets ??
        (targetField === "menuIds" ? entry.menuId ?? entry.menuIds : entry.priceListId ?? entry.priceListIds),
      32
    );
    if (start === null || end === null || start === end || ids.length === 0) return;
    rules.push({
      id: normalizeMenuConfigId(entry.id ?? entry.code, `${fallbackPrefix}_${index + 1}`),
      label: normalizeString(entry.label ?? entry.name).slice(0, 100),
      days: normalizeMenuWeekdays(entry.days ?? entry.weekdays ?? entry.giorni),
      start: formatClockMinutes(start),
      end: formatClockMinutes(end),
      [targetField]: ids,
      enabled: entry.enabled !== false && entry.status !== "disabled",
    });
  });
  return rules;
}

function weekdayIdFromDate(date = new Date()) {
  return WEEKDAY_IDS[(date.getDay() + 6) % 7];
}

function minutesFromDate(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

export function menuScheduleRuleMatches(rule, now = new Date()) {
  if (!rule || rule.enabled === false) return false;
  const days = normalizeMenuWeekdays(rule.days);
  if (!days.includes(weekdayIdFromDate(now))) return false;
  const start = parseClockMinutes(rule.start);
  const end = parseClockMinutes(rule.end);
  if (start === null || end === null || start === end) return false;
  const current = minutesFromDate(now);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function resolveScheduledIds(rules, targetField = "menuIds", now = new Date()) {
  const active = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!menuScheduleRuleMatches(rule, now)) continue;
    active.push(...normalizeReferenceList(rule[targetField], 32));
  }
  return [...new Set(active)];
}

function normalizePriceListPrice(entry, fallbackIndex = 1) {
  if (!entry || typeof entry !== "object") return null;
  const productId = normalizeMenuConfigId(
    entry.productId ?? entry.itemId ?? entry.menuItemId ?? entry.articleId,
    ""
  );
  const price = readMoney(entry.price ?? entry.value ?? entry.amount);
  if (!productId || price === null) return null;
  return {
    id: normalizeMenuConfigId(entry.id ?? `${productId}_${fallbackIndex}`, `price_${fallbackIndex}`),
    productId,
    price,
    enabled: entry.enabled !== false && entry.status !== "disabled",
  };
}

function normalizePriceEntries(source) {
  if (Array.isArray(source)) {
    return source.map((entry, index) => normalizePriceListPrice(entry, index + 1)).filter(Boolean);
  }
  if (source && typeof source === "object") {
    return Object.entries(source)
      .map(([productId, price], index) => normalizePriceListPrice({ productId, price }, index + 1))
      .filter(Boolean);
  }
  return [];
}

export function normalizePriceList(entry, fallbackIndex = 1) {
  if (!entry || typeof entry !== "object") return null;
  const id = normalizeMenuConfigId(entry.id ?? entry.priceListId ?? entry.code, `price_list_${fallbackIndex}`);
  const name = normalizeString(entry.name ?? entry.label, `Listino ${fallbackIndex}`).slice(0, 100);
  const prices = normalizePriceEntries(entry.prices ?? entry.items ?? entry.productPrices ?? entry.priceByProduct);
  return {
    id,
    name,
    currency: normalizeString(entry.currency, "EUR").slice(0, 8),
    status: entry.status === "disabled" || entry.enabled === false ? "disabled" : "active",
    prices,
    notes: normalizeString(entry.notes ?? entry.description).slice(0, 240),
  };
}

function normalizeMenuCategory(entry, fallbackIndex = 1, menuItems = []) {
  if (typeof entry === "string") {
    const name = normalizeString(entry, `Categoria ${fallbackIndex}`);
    return {
      id: normalizeMenuConfigId(name, `category_${fallbackIndex}`),
      name,
      productIds: menuItems
        .filter((item) => String(item?.category ?? "Altro").trim() === name)
        .map((item) => normalizeMenuConfigId(item?.id, ""))
        .filter(Boolean),
    };
  }
  if (!entry || typeof entry !== "object") return null;
  const name = normalizeString(entry.name ?? entry.label, `Categoria ${fallbackIndex}`).slice(0, 100);
  return {
    id: normalizeMenuConfigId(entry.id ?? entry.categoryId ?? name, `category_${fallbackIndex}`),
    name,
    productIds: normalizeReferenceList(entry.productIds ?? entry.itemIds ?? entry.products ?? entry.items, 1000),
    workstationIds: normalizeReferenceList(entry.workstationIds, 64),
    stationIds: uniqueStrings(entry.stationIds ?? entry.stations).slice(0, 64),
  };
}

export function buildDefaultMenusFromItems(menuItems = []) {
  const categoriesByName = new Map();
  for (const item of Array.isArray(menuItems) ? menuItems : []) {
    const itemId = normalizeMenuConfigId(item?.id, "");
    if (!itemId) continue;
    const categoryName = normalizeString(item?.category, "Altro");
    const current = categoriesByName.get(categoryName) ?? {
      id: normalizeMenuConfigId(categoryName, "altro"),
      name: categoryName,
      productIds: [],
    };
    current.productIds.push(itemId);
    categoriesByName.set(categoryName, current);
  }
  return [
    {
      id: "menu_main",
      name: "Menu principale",
      status: "active",
      categories: [...categoriesByName.values()].sort((left, right) =>
        left.name.localeCompare(right.name, "it-IT")
      ),
      schedule: [],
      notes: "Menu generato dal catalogo prodotti esistente.",
    },
  ];
}

export function normalizeMenu(entry, fallbackIndex = 1, menuItems = []) {
  if (!entry || typeof entry !== "object") return null;
  const id = normalizeMenuConfigId(entry.id ?? entry.menuId ?? entry.code, `menu_${fallbackIndex}`);
  const name = normalizeString(entry.name ?? entry.label, `Menu ${fallbackIndex}`).slice(0, 100);
  const rawCategories = Array.isArray(entry.categories) ? entry.categories : [];
  const categories = rawCategories
    .map((category, index) => normalizeMenuCategory(category, index + 1, menuItems))
    .filter(Boolean);
  return {
    id,
    name,
    status: entry.status === "disabled" || entry.enabled === false ? "disabled" : "active",
    categories,
    schedule: normalizeMenuScheduleRules(entry.schedule ?? entry.menuSchedule, "menuIds", `${id}_schedule`),
    notes: normalizeString(entry.notes ?? entry.description).slice(0, 240),
  };
}

export function normalizeMenuConfiguration(settings = {}, menuItems = []) {
  const rawMenus = Array.isArray(settings?.menus) && settings.menus.length
    ? settings.menus
    : Array.isArray(settings?.areaMenus) && settings.areaMenus.length
      ? settings.areaMenus
      : buildDefaultMenusFromItems(menuItems);
  const menus = rawMenus
    .map((entry, index) => normalizeMenu(entry, index + 1, menuItems))
    .filter(Boolean);
  const safeMenus = menus.length ? menus : buildDefaultMenusFromItems(menuItems);
  const priceLists = (Array.isArray(settings?.priceLists) ? settings.priceLists : [])
    .map((entry, index) => normalizePriceList(entry, index + 1))
    .filter(Boolean);
  const priceListSchedules = normalizeMenuScheduleRules(
    settings?.priceListSchedules ?? settings?.listinoSchedules ?? settings?.priceScheduleRules,
    "priceListIds",
    "price_list_schedule"
  );
  const menuSchedules = normalizeMenuScheduleRules(
    settings?.menuSchedules ?? settings?.menuScheduleRules,
    "menuIds",
    "menu_schedule"
  );
  const areaMenus = safeMenus.map((menu) => ({
    id: menu.id,
    name: menu.name,
    categories: menu.categories.map((category) => category.name),
    enabled: menu.status !== "disabled",
  }));
  return {
    menus: safeMenus,
    areaMenus,
    priceLists,
    priceListSchedules,
    menuSchedules,
  };
}

export function applyPriceListsToMenuItems(menuItems = [], priceLists = [], priceListIds = []) {
  const activeIds = normalizeReferenceList(priceListIds, 32);
  if (!activeIds.length) return Array.isArray(menuItems) ? menuItems : [];
  const listsById = new Map((Array.isArray(priceLists) ? priceLists : []).map((list) => [list.id, list]));
  const priceByProduct = new Map();
  for (const priceListId of activeIds) {
    const list = listsById.get(priceListId);
    if (!list || list.status === "disabled") continue;
    for (const price of Array.isArray(list.prices) ? list.prices : []) {
      if (!price?.productId || price.enabled === false) continue;
      priceByProduct.set(price.productId, {
        price: price.price,
        priceListId: list.id,
        priceListName: list.name,
      });
    }
  }
  return (Array.isArray(menuItems) ? menuItems : []).map((item) => {
    const itemId = normalizeMenuConfigId(item?.id, "");
    const match = priceByProduct.get(itemId);
    if (!match) return item;
    return {
      ...item,
      basePrice: readMoney(item?.price) ?? 0,
      price: match.price,
      activePriceListId: match.priceListId,
      activePriceListName: match.priceListName,
    };
  });
}
