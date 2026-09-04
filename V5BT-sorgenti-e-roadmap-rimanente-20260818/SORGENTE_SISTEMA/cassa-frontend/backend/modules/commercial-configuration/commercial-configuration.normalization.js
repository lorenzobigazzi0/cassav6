import {
  COMMERCIAL_ASSIGNMENT_TARGET_TYPES,
  COMMERCIAL_DEFAULT_SETTINGS,
  COMMERCIAL_PRICING_STRATEGIES,
  COMMERCIAL_SCHEMA_VERSION,
  COMMERCIAL_SCOPE_TYPES,
  COMMERCIAL_SELLABLE_TYPES,
  COMMERCIAL_TAX_ALLOCATION_STRATEGIES,
  COMMERCIAL_WEEKDAYS,
  DEFAULT_COMMERCIAL_CURRENCY,
} from "./constants.js";
import {
  asString,
  centsFromMoney,
  clampInteger,
  deepClone,
  normalizeBoolean,
  normalizeCents,
  normalizeExternalId,
  normalizeId,
  normalizeIsoDateTime,
  uniqueStrings,
} from "./commercial-configuration.utils.js";

function normalizeStatus(value, fallback = "active") {
  const normalized = asString(value, fallback).toLowerCase();
  return ["active", "disabled"].includes(normalized) ? normalized : fallback;
}

function normalizeWeekdays(value) {
  const normalized = uniqueStrings(value, {
    limit: 7,
    normalize: (entry) => asString(entry).slice(0, 3).toLowerCase(),
  }).filter((entry) => COMMERCIAL_WEEKDAYS.includes(entry));
  return normalized.length ? normalized : [...COMMERCIAL_WEEKDAYS];
}

function normalizeVariant(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const id = normalizeId(entry.id ?? entry.variantId ?? entry.name, `variant_${index + 1}`);
  const cents = Number.isFinite(Number(entry.priceDeltaCents))
    ? normalizeCents(entry.priceDeltaCents, 0, { min: -999_999_999 })
    : centsFromMoney(entry.priceDelta ?? entry.delta ?? 0, 0);
  return {
    id,
    name: asString(entry.name ?? entry.label, `Variante ${index + 1}`).slice(0, 120),
    enabled: normalizeBoolean(entry.enabled, true),
    priceDeltaCents: normalizeCents(cents, 0, { min: -999_999_999 }),
    sku: asString(entry.sku).slice(0, 80),
    sortOrder: clampInteger(entry.sortOrder, index, -100_000, 100_000),
  };
}

function normalizeProduct(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const id = normalizeId(entry.id ?? entry.productId ?? entry.sku ?? entry.name, `product_${index + 1}`);
  const basePriceCents = Number.isFinite(Number(entry.basePriceCents))
    ? normalizeCents(entry.basePriceCents)
    : centsFromMoney(entry.basePrice ?? entry.price, 0);
  const taxRate = Number(entry.taxRate ?? entry.vatRate ?? entry.iva ?? 10);
  return {
    id,
    name: asString(entry.name ?? entry.label, `Articolo ${index + 1}`).slice(0, 160),
    description: asString(entry.description).slice(0, 2000),
    sku: asString(entry.sku ?? entry.code).slice(0, 80),
    barcode: asString(entry.barcode).slice(0, 120),
    unit: asString(entry.unit).slice(0, 32),
    enabled: normalizeBoolean(entry.enabled, entry.status !== "disabled"),
    taxRate: Number.isFinite(taxRate) ? Math.max(0, Math.min(100, Math.round(taxRate * 1000) / 1000)) : 10,
    taxCode: asString(entry.taxCode ?? entry.vatCode ?? entry.ivaCode).slice(0, 40),
    basePriceCents,
    workstationIds: uniqueStrings(entry.workstationIds ?? entry.stationIds ?? entry.stations, {
      limit: 64,
      normalize: normalizeExternalId,
    }),
    tags: uniqueStrings(entry.tags, { limit: 64, normalize: (value) => asString(value).slice(0, 80) }),
    allergens: uniqueStrings(entry.allergens, { limit: 64, normalize: (value) => asString(value).slice(0, 80) }),
    imageUrl: asString(entry.imageUrl).slice(0, 1000),
    variants: (Array.isArray(entry.variants) ? entry.variants : [])
      .map(normalizeVariant)
      .filter(Boolean)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "it-IT")),
    metadata: entry.metadata && typeof entry.metadata === "object" ? deepClone(entry.metadata) : {},
  };
}

function normalizeCatalogGroup(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  return {
    id: normalizeId(entry.id ?? entry.groupId ?? entry.name, `group_${index + 1}`),
    name: asString(entry.name ?? entry.label, `Gruppo ${index + 1}`).slice(0, 140),
    enabled: normalizeBoolean(entry.enabled, entry.status !== "disabled"),
    sortOrder: clampInteger(entry.sortOrder, index, -100_000, 100_000),
  };
}

function normalizeCatalogEntry(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const sellableType = asString(entry.sellableType ?? entry.type, "product").toLowerCase();
  if (!["product", "offer"].includes(sellableType)) return null;
  const sellableId = normalizeId(entry.sellableId ?? entry.productId ?? entry.offerId ?? entry.refId, "");
  if (!sellableId) return null;
  return {
    id: normalizeId(entry.id, `entry_${index + 1}_${sellableType}_${sellableId}`),
    sellableType,
    sellableId,
    groupId: normalizeId(entry.groupId, "") || null,
    visible: normalizeBoolean(entry.visible, true),
    enabled: normalizeBoolean(entry.enabled, true),
    sortOrder: clampInteger(entry.sortOrder, index, -100_000, 100_000),
    labelOverride: asString(entry.labelOverride).slice(0, 160),
  };
}

function normalizeCatalogCategory(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const id = normalizeId(entry.id ?? entry.categoryId ?? entry.name, `category_${index + 1}`);
  return {
    id,
    name: asString(entry.name ?? entry.label, `Categoria ${index + 1}`).slice(0, 140),
    departmentId: normalizeId(entry.departmentId, "dept_menu"),
    departmentName: asString(entry.departmentName, "Menu").slice(0, 140),
    enabled: normalizeBoolean(entry.enabled, entry.status !== "disabled"),
    sortOrder: clampInteger(entry.sortOrder, index, -100_000, 100_000),
    groups: (Array.isArray(entry.groups) ? entry.groups : [])
      .map(normalizeCatalogGroup)
      .filter(Boolean)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "it-IT")),
    entries: (Array.isArray(entry.entries) ? entry.entries : [])
      .map(normalizeCatalogEntry)
      .filter(Boolean)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)),
  };
}

function normalizeCatalog(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const id = normalizeId(entry.id ?? entry.catalogId ?? entry.name, `catalog_${index + 1}`);
  return {
    id,
    name: asString(entry.name ?? entry.label, `Catalogo ${index + 1}`).slice(0, 140),
    status: normalizeStatus(entry.status, normalizeBoolean(entry.enabled, true) ? "active" : "disabled"),
    isDefault: normalizeBoolean(entry.isDefault, index === 0),
    basePriceListId: normalizeId(entry.basePriceListId ?? entry.defaultPriceListId, ""),
    notes: asString(entry.notes ?? entry.description).slice(0, 1000),
    categories: (Array.isArray(entry.categories) ? entry.categories : [])
      .map(normalizeCatalogCategory)
      .filter(Boolean)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "it-IT")),
  };
}

function normalizePriceListEntry(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const sellableType = asString(entry.sellableType ?? entry.type, "product").toLowerCase();
  if (!COMMERCIAL_SELLABLE_TYPES.includes(sellableType)) return null;
  const sellableId = normalizeExternalId(
    entry.sellableId ?? entry.productId ?? entry.offerId ?? entry.variantId ?? entry.optionId,
    "",
  );
  if (!sellableId) return null;
  const cents = Number.isFinite(Number(entry.priceCents))
    ? normalizeCents(entry.priceCents, 0, { min: -999_999_999 })
    : centsFromMoney(entry.price ?? entry.amount ?? entry.value, 0);
  return {
    id: normalizeId(entry.id, `price_${index + 1}_${sellableType}_${normalizeId(sellableId, "item")}`),
    sellableType,
    sellableId,
    priceCents: normalizeCents(cents, 0, { min: sellableType === "variant" || sellableType === "offer_option" ? -999_999_999 : 0 }),
    available: normalizeBoolean(entry.available, true),
    enabled: normalizeBoolean(entry.enabled, true),
    notes: asString(entry.notes).slice(0, 500),
  };
}

function normalizePriceList(entry, index, defaultCurrency) {
  if (!entry || typeof entry !== "object") return null;
  const id = normalizeId(entry.id ?? entry.priceListId ?? entry.name, `price_list_${index + 1}`);
  return {
    id,
    catalogId: normalizeId(entry.catalogId, ""),
    name: asString(entry.name ?? entry.label, `Listino ${index + 1}`).slice(0, 140),
    currency: asString(entry.currency, defaultCurrency).toUpperCase().slice(0, 8),
    status: normalizeStatus(entry.status, normalizeBoolean(entry.enabled, true) ? "active" : "disabled"),
    inheritsFromId: normalizeId(entry.inheritsFromId ?? entry.parentPriceListId, "") || null,
    notes: asString(entry.notes ?? entry.description).slice(0, 1000),
    entries: (Array.isArray(entry.entries) ? entry.entries : Array.isArray(entry.prices) ? entry.prices : [])
      .map(normalizePriceListEntry)
      .filter(Boolean),
  };
}

function normalizeIncludedItem(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const productId = normalizeId(entry.productId ?? entry.sellableId, "");
  if (!productId) return null;
  return {
    id: normalizeId(entry.id, `included_${index + 1}_${productId}`),
    productId,
    quantity: clampInteger(entry.quantity ?? entry.qty, 1, 1, 999),
  };
}

function normalizeChoiceOption(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const productId = normalizeId(entry.productId ?? entry.sellableId, "");
  if (!productId) return null;
  const supplementCents = Number.isFinite(Number(entry.supplementCents))
    ? normalizeCents(entry.supplementCents, 0, { min: -999_999_999 })
    : centsFromMoney(entry.supplement ?? entry.priceDelta ?? 0, 0);
  return {
    id: normalizeId(entry.id ?? entry.optionId ?? productId, `option_${index + 1}`),
    productId,
    labelOverride: asString(entry.labelOverride ?? entry.name).slice(0, 160),
    quantity: clampInteger(entry.quantity ?? entry.qty, 1, 1, 999),
    supplementCents: normalizeCents(supplementCents, 0, { min: -999_999_999 }),
    enabled: normalizeBoolean(entry.enabled, true),
    sortOrder: clampInteger(entry.sortOrder, index, -100_000, 100_000),
  };
}

function normalizeChoiceGroup(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const minSelections = clampInteger(entry.minSelections ?? entry.min, entry.required === false ? 0 : 1, 0, 999);
  const maxSelections = clampInteger(entry.maxSelections ?? entry.max, Math.max(minSelections, 1), 0, 999);
  return {
    id: normalizeId(entry.id ?? entry.groupId ?? entry.name, `choice_group_${index + 1}`),
    name: asString(entry.name ?? entry.label, `Scelta ${index + 1}`).slice(0, 140),
    required: normalizeBoolean(entry.required, minSelections > 0),
    minSelections,
    maxSelections,
    includedSelections: clampInteger(entry.includedSelections ?? entry.included, maxSelections, 0, 999),
    allowRepeat: normalizeBoolean(entry.allowRepeat, false),
    sortOrder: clampInteger(entry.sortOrder, index, -100_000, 100_000),
    options: (Array.isArray(entry.options) ? entry.options : [])
      .map(normalizeChoiceOption)
      .filter(Boolean)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)),
  };
}

function normalizeOffer(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const id = normalizeId(entry.id ?? entry.offerId ?? entry.name, `offer_${index + 1}`);
  const pricingStrategy = asString(entry.pricingStrategy, "fixed").toLowerCase();
  const taxAllocationStrategy = asString(entry.taxAllocationStrategy, "proportional").toLowerCase();
  const basePriceCents = Number.isFinite(Number(entry.basePriceCents))
    ? normalizeCents(entry.basePriceCents)
    : centsFromMoney(entry.basePrice ?? entry.price, 0);
  return {
    id,
    name: asString(entry.name ?? entry.label, `Offerta ${index + 1}`).slice(0, 160),
    description: asString(entry.description).slice(0, 2000),
    enabled: normalizeBoolean(entry.enabled, entry.status !== "disabled"),
    pricingStrategy: COMMERCIAL_PRICING_STRATEGIES.includes(pricingStrategy) ? pricingStrategy : "fixed",
    taxAllocationStrategy: COMMERCIAL_TAX_ALLOCATION_STRATEGIES.includes(taxAllocationStrategy)
      ? taxAllocationStrategy
      : "proportional",
    basePriceCents,
    workstationIds: uniqueStrings(entry.workstationIds ?? entry.stationIds, {
      limit: 64,
      normalize: normalizeExternalId,
    }),
    includedItems: (Array.isArray(entry.includedItems) ? entry.includedItems : [])
      .map(normalizeIncludedItem)
      .filter(Boolean),
    choiceGroups: (Array.isArray(entry.choiceGroups) ? entry.choiceGroups : [])
      .map(normalizeChoiceGroup)
      .filter(Boolean)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)),
    metadata: entry.metadata && typeof entry.metadata === "object" ? deepClone(entry.metadata) : {},
  };
}

function normalizeAssignment(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const targetType = asString(entry.targetType, "price_list").toLowerCase();
  const scopeType = asString(entry.scopeType, "global").toLowerCase();
  if (!COMMERCIAL_ASSIGNMENT_TARGET_TYPES.includes(targetType) || !COMMERCIAL_SCOPE_TYPES.includes(scopeType)) return null;
  const targetId = normalizeId(entry.targetId ?? entry.catalogId ?? entry.priceListId, "");
  if (!targetId) return null;
  const startMinute = clampInteger(entry.startMinute, 0, 0, 1439);
  const endMinute = clampInteger(entry.endMinute, 1440, 1, 1440);
  return {
    id: normalizeId(entry.id, `assignment_${index + 1}_${targetType}_${targetId}`),
    targetType,
    targetId,
    scopeType,
    scopeId: scopeType === "global" ? "*" : normalizeExternalId(entry.scopeId, ""),
    priority: clampInteger(entry.priority, 0, -100_000, 100_000),
    enabled: normalizeBoolean(entry.enabled, true),
    validFrom: normalizeIsoDateTime(entry.validFrom, null),
    validTo: normalizeIsoDateTime(entry.validTo, null),
    weekdays: normalizeWeekdays(entry.weekdays ?? entry.days),
    startMinute,
    endMinute,
    notes: asString(entry.notes).slice(0, 1000),
  };
}

export function createEmptyCommercialConfiguration() {
  return {
    schemaVersion: COMMERCIAL_SCHEMA_VERSION,
    id: "commercial_default",
    name: "Configurazione commerciale",
    currency: DEFAULT_COMMERCIAL_CURRENCY,
    products: [],
    catalogs: [
      {
        id: "catalog_main",
        name: "Catalogo principale",
        status: "active",
        isDefault: true,
        basePriceListId: "price_list_base",
        notes: "",
        categories: [],
      },
    ],
    priceLists: [
      {
        id: "price_list_base",
        catalogId: "catalog_main",
        name: "Listino base",
        currency: DEFAULT_COMMERCIAL_CURRENCY,
        status: "active",
        inheritsFromId: null,
        notes: "",
        entries: [],
      },
    ],
    offers: [],
    assignments: [],
    settings: { ...COMMERCIAL_DEFAULT_SETTINGS },
    metadata: {},
  };
}

export function normalizeCommercialConfiguration(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const currency = asString(source.currency ?? source.settings?.currency, DEFAULT_COMMERCIAL_CURRENCY).toUpperCase().slice(0, 8);
  const products = (Array.isArray(source.products) ? source.products : []).map(normalizeProduct).filter(Boolean);
  const catalogs = (Array.isArray(source.catalogs) ? source.catalogs : []).map(normalizeCatalog).filter(Boolean);
  const priceLists = (Array.isArray(source.priceLists) ? source.priceLists : [])
    .map((entry, index) => normalizePriceList(entry, index, currency))
    .filter(Boolean);
  const offers = (Array.isArray(source.offers) ? source.offers : []).map(normalizeOffer).filter(Boolean);
  const assignments = (Array.isArray(source.assignments) ? source.assignments : []).map(normalizeAssignment).filter(Boolean);
  const defaultCatalog = catalogs.find((entry) => entry.isDefault && entry.status !== "disabled") ?? catalogs.find((entry) => entry.status !== "disabled");
  const settingsSource = source.settings && typeof source.settings === "object" ? source.settings : {};
  return {
    schemaVersion: COMMERCIAL_SCHEMA_VERSION,
    id: normalizeId(source.id, "commercial_default"),
    name: asString(source.name, "Configurazione commerciale").slice(0, 160),
    currency,
    products,
    catalogs,
    priceLists,
    offers,
    assignments,
    settings: {
      ...COMMERCIAL_DEFAULT_SETTINGS,
      ...deepClone(settingsSource),
      currency,
      timeZone: asString(settingsSource.timeZone, COMMERCIAL_DEFAULT_SETTINGS.timeZone).slice(0, 80),
      defaultCatalogId: normalizeId(settingsSource.defaultCatalogId, defaultCatalog?.id ?? "catalog_main"),
      allowManualPriceOverride: normalizeBoolean(settingsSource.allowManualPriceOverride, false),
      requireExplicitActivityAndRoom: normalizeBoolean(settingsSource.requireExplicitActivityAndRoom, false),
      pricingPrecedence: uniqueStrings(settingsSource.pricingPrecedence, {
        limit: COMMERCIAL_SCOPE_TYPES.length,
        normalize: (entry) => asString(entry).toLowerCase(),
      }).filter((entry) => COMMERCIAL_SCOPE_TYPES.includes(entry)),
    },
    metadata: source.metadata && typeof source.metadata === "object" ? deepClone(source.metadata) : {},
  };
}
