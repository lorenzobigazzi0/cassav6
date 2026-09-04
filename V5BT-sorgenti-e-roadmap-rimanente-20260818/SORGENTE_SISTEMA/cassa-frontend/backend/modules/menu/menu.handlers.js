import { applyPriceListsToMenuItems, resolveScheduledIds } from "./menu-configuration.js";

export function buildMenuCatalog(menuItems, { applyRuntimeMenuItemPrice, sanitizeMenuItem, shouldExposeMenuItemInRuntime }) {
  const enabledItems = menuItems.filter((item) => item.enabled !== false && shouldExposeMenuItemInRuntime(item));
  const categories = [];
  const seen = new Set();
  for (const item of enabledItems) {
    const category = String(item.category ?? "").trim();
    if (!category || seen.has(category)) continue;
    seen.add(category);
    categories.push(category);
  }

  return {
    categories,
    items: enabledItems.map((item) => sanitizeMenuItem(applyRuntimeMenuItemPrice(item))),
  };
}

function collectMenuItemCategories(menuItems) {
  const categories = [];
  const seen = new Set();
  for (const item of Array.isArray(menuItems) ? menuItems : []) {
    const category = String(item?.category ?? "").trim();
    if (!category || seen.has(category)) continue;
    seen.add(category);
    categories.push(category);
  }
  return categories.sort((a, b) => a.localeCompare(b, "it-IT"));
}

const MENU_SUGGESTION_MIN_COUNT = 3;
const MENU_SUGGESTION_DEFAULT_LIMIT = 80;
const MENU_SUGGESTION_MAX_LIMIT = 200;

function normalizeSuggestionText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeSuggestionKey(value) {
  return normalizeSuggestionText(value).toLocaleLowerCase("it-IT");
}

function moneyToCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function centsToMoney(value) {
  return Math.round(Number(value) || 0) / 100;
}

function resolveSuggestionTimestampMs(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      const normalized = value > 9999999999 ? value : value * 1000;
      if (Number.isFinite(normalized) && normalized > 0) return normalized;
      continue;
    }
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function collectSuggestionOrders(db) {
  const orders = [];
  const seen = new Set();
  const appendOrder = (entry) => {
    if (!entry || typeof entry !== "object") return;
    const id = normalizeSuggestionText(entry.id ?? entry.orderId ?? "");
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    orders.push(entry);
  };

  (Array.isArray(db?.integration?.orders) ? db.integration.orders : []).forEach(appendOrder);
  for (const table of Array.isArray(db?.posSettings?.tables) ? db.posSettings.tables : []) {
    (Array.isArray(table?.orderHistory) ? table.orderHistory : []).forEach(appendOrder);
  }
  for (const area of Array.isArray(db?.posSettings?.areas) ? db.posSettings.areas : []) {
    for (const room of Array.isArray(area?.rooms) ? area.rooms : []) {
      for (const table of Array.isArray(room?.tables) ? room.tables : []) {
        (Array.isArray(table?.orderHistory) ? table.orderHistory : []).forEach(appendOrder);
      }
    }
  }
  return orders;
}

function isCancelledSuggestionOrder(order) {
  const status = normalizeSuggestionKey(order?.status ?? order?.orderStatus ?? order?.state ?? "");
  return Boolean(
    order?.cancelledAt ||
      order?.canceledAt ||
      order?.voidedAt ||
      order?.deletedAt ||
      ["cancelled", "canceled", "annullato", "voided", "deleted", "stornato"].includes(status)
  );
}

function isVoidedSuggestionLine(line) {
  const status = normalizeSuggestionKey(line?.status ?? line?.state ?? "");
  return Boolean(
    line?.voidedAt ||
      line?.cancelledAt ||
      line?.canceledAt ||
      line?.removedAt ||
      line?.deletedAt ||
      line?.voided === true ||
      line?.cancelled === true ||
      line?.canceled === true ||
      ["voided", "cancelled", "canceled", "annullato", "deleted", "stornato"].includes(status)
  );
}

function resolveSuggestionQuantity(line) {
  const raw = Number(line?.qty ?? line?.quantity ?? line?.qta ?? 1);
  if (!Number.isFinite(raw)) return 1;
  return Math.max(Math.trunc(raw), 0);
}

function resolveSuggestionName(line) {
  return normalizeSuggestionText(
    line?.productNameSnapshot ??
      line?.productName ??
      line?.name ??
      line?.label ??
      line?.productId ??
      ""
  );
}

function resolveSuggestionPriceCents(line, qty) {
  const candidates = [
    line?.unitPriceApplied,
    line?.unit_price_applied,
    line?.unitPrice,
    line?.unit_price,
    line?.price,
    line?.listPriceAtTime,
    line?.list_price_at_time,
  ];
  for (const candidate of candidates) {
    const cents = moneyToCents(candidate);
    if (cents != null && cents >= 0) return cents;
  }
  const lineTotal = Number(line?.lineTotal ?? line?.line_total ?? line?.total);
  if (Number.isFinite(lineTotal) && qty > 0) return moneyToCents(lineTotal / qty);
  return null;
}

function resolveSuggestionCategory(line, db) {
  const direct = normalizeSuggestionText(line?.category ?? line?.productCategory ?? line?.section ?? "");
  if (direct) return direct;
  const productId = normalizeSuggestionText(line?.productId ?? "");
  if (!productId) return "";
  const matched = (Array.isArray(db?.menuItems) ? db.menuItems : []).find(
    (item) => normalizeSuggestionText(item?.id ?? "") === productId
  );
  return normalizeSuggestionText(matched?.category ?? "");
}

function resolveSuggestionStationIds(line, order) {
  const raw = [
    ...(Array.isArray(line?.routeStations) ? line.routeStations : []),
    ...(Array.isArray(line?.stationIds) ? line.stationIds : []),
    line?.station,
    line?.stationId,
    order?.assignedStationId,
    order?.ownerStation,
    order?.station,
  ];
  return [...new Set(raw.map(normalizeSuggestionText).filter(Boolean))].slice(0, 8);
}

function buildSuggestionMenuItemId(name, priceCents) {
  const slug = normalizeSuggestionKey(name)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42) || "articolo";
  return `menu_item_sug_${slug}_${priceCents}`;
}

function buildMenuSuggestionDraft(entry) {
  return {
    id: buildSuggestionMenuItemId(entry.name, entry.priceCents),
    name: entry.name,
    category: entry.category || "Altro",
    section: "",
    price: centsToMoney(entry.priceCents),
    enabled: true,
    variantRequired: false,
    variants: [],
    imageUrl: "",
    vatRate: 10,
    iva: 10,
    taxRate: 10,
    vatCode: "",
    priceListPrices: [],
    workstationIds: [],
    stationIds: [],
    menuIds: [],
    categoryIds: [],
    allergens: [],
    tags: ["suggerito"],
    sku: "",
    barcode: "",
    unit: "",
  };
}

export function buildMenuSuggestionsPayload({ db, threshold = MENU_SUGGESTION_MIN_COUNT, limit = MENU_SUGGESTION_DEFAULT_LIMIT }) {
  const safeThreshold = Math.max(Math.trunc(Number(threshold) || MENU_SUGGESTION_MIN_COUNT), MENU_SUGGESTION_MIN_COUNT);
  const safeLimit = Math.min(
    Math.max(Math.trunc(Number(limit) || MENU_SUGGESTION_DEFAULT_LIMIT), 1),
    MENU_SUGGESTION_MAX_LIMIT
  );
  const existingMenuNameKeys = new Set(
    (Array.isArray(db?.menuItems) ? db.menuItems : [])
      .map((item) => normalizeSuggestionKey(item?.name ?? ""))
      .filter(Boolean)
  );
  const groups = new Map();

  for (const order of collectSuggestionOrders(db)) {
    if (isCancelledSuggestionOrder(order)) continue;
    const items = Array.isArray(order?.items)
      ? order.items
      : Array.isArray(order?.lines)
        ? order.lines
        : Array.isArray(order?.orderLines)
          ? order.orderLines
          : [];
    for (const line of items) {
      if (!line || typeof line !== "object" || isVoidedSuggestionLine(line)) continue;
      const qty = resolveSuggestionQuantity(line);
      if (qty <= 0) continue;
      const name = resolveSuggestionName(line);
      const nameKey = normalizeSuggestionKey(name);
      if (!nameKey || ["articolo", "conto"].includes(nameKey) || nameKey.startsWith("residuo comanda")) continue;
      if (existingMenuNameKeys.has(nameKey)) continue;
      const priceCents = resolveSuggestionPriceCents(line, qty);
      if (priceCents == null || priceCents < 0) continue;
      const key = `${nameKey}|${priceCents}`;
      const lastSeenAtMs = resolveSuggestionTimestampMs(
        line?.createdAtMs,
        line?.createdAt,
        line?.updatedAtMs,
        line?.updatedAt,
        order?.createdAtMs,
        order?.createdAt,
        order?.receivedAtMs,
        order?.receivedAt,
        order?.updatedAtMs,
        order?.updatedAt
      );
      const current = groups.get(key) ?? {
        key,
        name,
        nameKey,
        priceCents,
        count: 0,
        linesCount: 0,
        categoryVotes: new Map(),
        stationIds: new Set(),
        sampleOrderIds: [],
        lastSeenAtMs: 0,
      };
      current.count += qty;
      current.linesCount += 1;
      const category = resolveSuggestionCategory(line, db);
      if (category) current.categoryVotes.set(category, (current.categoryVotes.get(category) || 0) + qty);
      for (const stationId of resolveSuggestionStationIds(line, order)) current.stationIds.add(stationId);
      const orderId = normalizeSuggestionText(order?.id ?? order?.orderId ?? "");
      if (orderId && current.sampleOrderIds.length < 6 && !current.sampleOrderIds.includes(orderId)) {
        current.sampleOrderIds.push(orderId);
      }
      if (lastSeenAtMs > current.lastSeenAtMs) current.lastSeenAtMs = lastSeenAtMs;
      groups.set(key, current);
    }
  }

  const suggestions = [...groups.values()]
    .filter((entry) => entry.count >= safeThreshold)
    .map((entry) => {
      const category = [...entry.categoryVotes.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "Altro";
      const suggestion = {
        id: buildSuggestionMenuItemId(entry.name, entry.priceCents),
        name: entry.name,
        price: centsToMoney(entry.priceCents),
        priceCents: entry.priceCents,
        count: entry.count,
        linesCount: entry.linesCount,
        category,
        stationIds: [...entry.stationIds],
        sampleOrderIds: entry.sampleOrderIds,
        lastSeenAt: entry.lastSeenAtMs ? new Date(entry.lastSeenAtMs).toISOString() : null,
      };
      return {
        ...suggestion,
        menuItemDraft: buildMenuSuggestionDraft(suggestion),
      };
    })
    .sort((left, right) => {
      const leftSeenAtMs = Date.parse(left.lastSeenAt ?? "");
      const rightSeenAtMs = Date.parse(right.lastSeenAt ?? "");
      return (
        right.count - left.count ||
        (Number.isFinite(rightSeenAtMs) ? rightSeenAtMs : 0) - (Number.isFinite(leftSeenAtMs) ? leftSeenAtMs : 0) ||
        left.name.localeCompare(right.name, "it-IT")
      );
    })
    .slice(0, safeLimit);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    threshold: safeThreshold,
    suggestions,
  };
}

export function buildMenuSettingsPayload({ db, settings, sanitizeMenuItem, resolveSettingsLastWriteAt, resolveSettingsVersion }) {
  const lastWriteAt = resolveSettingsLastWriteAt(db.meta);
  return {
    ok: true,
    categories: collectMenuItemCategories(db.menuItems),
    items: db.menuItems.map(sanitizeMenuItem),
    menus: settings.menus ?? [],
    areaMenus: settings.areaMenus ?? [],
    priceLists: settings.priceLists ?? [],
    priceListSchedules: settings.priceListSchedules ?? [],
    menuSchedules: settings.menuSchedules ?? [],
    workstationOptions: settings.workstations ?? [],
    lastWriteAt,
    version: resolveSettingsVersion(db.meta),
  };
}

export function createMenuHandlers({
  readJsonBody,
  readMenuCatalogView,
  readMenuSuggestionsView,
  resolvePosMenuSettings,
  sendJson,
}) {

  async function handleMenuCatalog(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await readMenuCatalogView(payload));
  }

  async function handlePosMenuSettings(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await resolvePosMenuSettings(payload));
  }

  async function handleMenuSuggestions(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await readMenuSuggestionsView(payload));
  }

  return {
    "menu.catalog": handleMenuCatalog,
    "settings.menu": handlePosMenuSettings,
    "settings.menuSuggestions": handleMenuSuggestions,
  };
}
