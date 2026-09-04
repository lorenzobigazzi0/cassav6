import { COMMERCIAL_WEEKDAYS } from "./constants.js";
import { normalizeCommercialConfiguration } from "./commercial-configuration.normalization.js";
import {
  asString,
  centsFromMoney,
  normalizeExternalId,
  normalizeId,
  uniqueStrings,
} from "./commercial-configuration.utils.js";

function normalizeLegacyVariant(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  return {
    id: normalizeId(entry.id ?? entry.variantId ?? entry.name, `variant_${index + 1}`),
    name: asString(entry.name ?? entry.label, `Variante ${index + 1}`),
    enabled: entry.enabled !== false,
    priceDeltaCents: centsFromMoney(entry.priceDelta ?? entry.delta ?? entry.price ?? 0, 0),
  };
}

function scheduleToAssignments(rules, options) {
  const assignments = [];
  (Array.isArray(rules) ? rules : []).forEach((rule, ruleIndex) => {
    const ids = Array.isArray(rule?.priceListIds)
      ? rule.priceListIds
      : rule?.priceListId
        ? [rule.priceListId]
        : [];
    ids.forEach((priceListId, targetIndex) => {
      const [startHour = "0", startMinute = "0"] = String(rule.start ?? "00:00").split(":");
      const [endHour = "24", endMinute = "0"] = String(rule.end ?? "24:00").split(":");
      assignments.push({
        id: normalizeId(rule.id, `${options.prefix}_${ruleIndex + 1}_${targetIndex + 1}`),
        targetType: "price_list",
        targetId: normalizeId(priceListId, ""),
        scopeType: options.scopeType,
        scopeId: options.scopeType === "global" ? "*" : normalizeExternalId(options.scopeId, ""),
        priority: Number(rule.priority) || 0,
        enabled: rule.enabled !== false,
        weekdays: uniqueStrings(rule.days ?? rule.weekdays, {
          limit: 7,
          normalize: (value) => asString(value).slice(0, 3).toLowerCase(),
        }).filter((value) => COMMERCIAL_WEEKDAYS.includes(value)),
        startMinute: Math.max(0, Math.min(1439, Number(startHour) * 60 + Number(startMinute))),
        endMinute: Math.max(1, Math.min(1440, Number(endHour) * 60 + Number(endMinute))),
      });
    });
  });
  return assignments;
}

export function buildCommercialConfigurationFromLegacy(db = {}) {
  const menuItems = Array.isArray(db.menuItems) ? db.menuItems : [];
  const settings = db.posSettings && typeof db.posSettings === "object" ? db.posSettings : {};
  const products = menuItems.map((item, index) => ({
    id: normalizeId(item.id ?? item.sku ?? item.name, `product_${index + 1}`),
    name: asString(item.name, `Articolo ${index + 1}`),
    description: asString(item.description),
    sku: asString(item.sku ?? item.id),
    barcode: asString(item.barcode),
    enabled: item.enabled !== false,
    taxRate: Number(item.taxRate ?? item.vatRate ?? item.iva ?? 10),
    taxCode: asString(item.taxCode ?? item.vatCode ?? item.ivaCode),
    basePriceCents: centsFromMoney(item.price, 0),
    workstationIds: uniqueStrings(item.workstationIds ?? item.stationIds ?? item.stations, {
      limit: 64,
      normalize: normalizeExternalId,
    }),
    tags: uniqueStrings(item.tags, {
      limit: 64,
      normalize: (value) => asString(value).slice(0, 80),
    }),
    allergens: uniqueStrings(item.allergens ?? item.allergeni, {
      limit: 64,
      normalize: (value) => asString(value).slice(0, 80),
    }),
    variants: (Array.isArray(item.variants) ? item.variants : []).map(normalizeLegacyVariant).filter(Boolean),
    imageUrl: asString(item.imageUrl),
    metadata: {
      legacyCategory: asString(item.category),
      legacySection: asString(item.section),
      legacyIngredientLabels: uniqueStrings(item.ingredients ?? item.ingredientLabels, {
        limit: 128,
        normalize: (value) => asString(value).slice(0, 120),
      }),
    },
  }));
  const productByLegacyId = new Map(menuItems.map((item, index) => [String(item.id ?? ""), products[index]?.id]));
  const categories = [];
  const categoriesByName = new Map();
  menuItems.forEach((item, index) => {
    const categoryName = asString(item.category, "Altro");
    let category = categoriesByName.get(categoryName);
    if (!category) {
      category = {
        id: normalizeId(categoryName, `category_${categories.length + 1}`),
        name: categoryName,
        departmentId: "dept_menu",
        departmentName: "Menu",
        sortOrder: categories.length,
        enabled: true,
        groups: [],
        entries: [],
      };
      categoriesByName.set(categoryName, category);
      categories.push(category);
    }
    const sectionName = asString(item.section ?? item.subcategory, "");
    let groupId = null;
    if (sectionName) {
      groupId = normalizeId(`${category.id}_${sectionName}`, "");
      if (!category.groups.some((entry) => entry.id === groupId)) {
        category.groups.push({ id: groupId, name: sectionName, enabled: true, sortOrder: category.groups.length });
      }
    }
    category.entries.push({
      id: `entry_${products[index].id}`,
      sellableType: "product",
      sellableId: products[index].id,
      groupId,
      visible: item.enabled !== false,
      enabled: item.enabled !== false,
      sortOrder: category.entries.length,
    });
  });
  const basePriceList = {
    id: "price_list_base",
    catalogId: "catalog_main",
    name: "Listino base migrato",
    currency: "EUR",
    status: "active",
    entries: products.map((product) => ({
      id: `price_base_${product.id}`,
      sellableType: "product",
      sellableId: product.id,
      priceCents: product.basePriceCents,
      available: product.enabled,
      enabled: true,
    })),
  };
  const legacyPriceLists = (Array.isArray(settings.priceLists) ? settings.priceLists : []).map((list, index) => ({
    id: normalizeId(list.id ?? list.priceListId ?? list.name, `price_list_${index + 1}`),
    catalogId: "catalog_main",
    name: asString(list.name ?? list.label, `Listino ${index + 1}`),
    currency: asString(list.currency, "EUR"),
    status: list.status === "disabled" || list.enabled === false ? "disabled" : "active",
    inheritsFromId: normalizeId(
      list.inheritsFromId ?? list.parentPriceListId,
      "price_list_base",
    ),
    entries: (Array.isArray(list.prices) ? list.prices : Array.isArray(list.entries) ? list.entries : []).map((price, priceIndex) => ({
      id: normalizeId(price.id, `price_${index + 1}_${priceIndex + 1}`),
      sellableType: "product",
      sellableId: productByLegacyId.get(String(price.productId ?? price.itemId ?? "")) ?? normalizeId(price.productId ?? price.itemId, ""),
      priceCents: centsFromMoney(price.price ?? price.value ?? price.amount, 0),
      available: price.available !== false,
      enabled: price.enabled !== false,
    })).filter((entry) => entry.sellableId),
  }));
  const assignments = [
    ...scheduleToAssignments(settings.priceListSchedules, { prefix: "legacy_global_schedule", scopeType: "global", scopeId: "*" }),
  ];
  for (const activity of Array.isArray(settings.activities) ? settings.activities : []) {
    const activityId = normalizeExternalId(activity.id ?? activity.activityId, "");
    for (const [index, listId] of (Array.isArray(activity.priceListIds) ? activity.priceListIds : []).entries()) {
      assignments.push({
        id: `legacy_activity_${normalizeId(activityId, "activity")}_${index + 1}`,
        targetType: "price_list",
        targetId: normalizeId(listId, ""),
        scopeType: "activity",
        scopeId: activityId,
        priority: 0,
        enabled: true,
        weekdays: [...COMMERCIAL_WEEKDAYS],
        startMinute: 0,
        endMinute: 1440,
      });
    }
    assignments.push(...scheduleToAssignments(activity.priceListSchedules, {
      prefix: `legacy_activity_${normalizeId(activityId, "activity")}_schedule`,
      scopeType: "activity",
      scopeId: activityId,
    }));
  }
  const rooms = [...(Array.isArray(settings.areas) ? settings.areas : []), ...(Array.isArray(settings.rooms) ? settings.rooms : [])];
  for (const room of rooms) {
    const roomId = normalizeExternalId(room.id ?? room.roomId, "");
    for (const [index, listId] of (Array.isArray(room.priceListIds) ? room.priceListIds : []).entries()) {
      assignments.push({
        id: `legacy_room_${normalizeId(roomId, "room")}_${index + 1}`,
        targetType: "price_list",
        targetId: normalizeId(listId, ""),
        scopeType: "room",
        scopeId: roomId,
        priority: 0,
        enabled: true,
        weekdays: [...COMMERCIAL_WEEKDAYS],
        startMinute: 0,
        endMinute: 1440,
      });
    }
    assignments.push(...scheduleToAssignments(room.priceListSchedules, {
      prefix: `legacy_room_${normalizeId(roomId, "room")}_schedule`,
      scopeType: "room",
      scopeId: roomId,
    }));
  }
  for (const user of Array.isArray(db.users) ? db.users : []) {
    const listIds = Array.isArray(user.priceListIds)
      ? user.priceListIds
      : user.priceListId
        ? [user.priceListId]
        : [];
    listIds.forEach((listId, index) => assignments.push({
      id: `legacy_user_${normalizeId(user.id, "user")}_${index + 1}`,
      targetType: "price_list",
      targetId: normalizeId(listId, ""),
      scopeType: "user",
      scopeId: normalizeExternalId(user.id, ""),
      priority: 0,
      enabled: true,
      weekdays: [...COMMERCIAL_WEEKDAYS],
      startMinute: 0,
      endMinute: 1440,
    }));
  }
  return normalizeCommercialConfiguration({
    id: "commercial_migrated_legacy",
    name: "Configurazione commerciale migrata",
    currency: "EUR",
    products,
    catalogs: [{
      id: "catalog_main",
      name: "Catalogo principale",
      status: "active",
      isDefault: true,
      basePriceListId: "price_list_base",
      categories,
    }],
    priceLists: [basePriceList, ...legacyPriceLists.filter((entry) => entry.id !== "price_list_base")],
    offers: [],
    assignments,
    settings: {
      defaultCatalogId: "catalog_main",
      timeZone: "Europe/Rome",
      currency: "EUR",
      allowManualPriceOverride: false,
    },
    metadata: {
      migratedFromLegacyAt: new Date().toISOString(),
      legacyMenuItemsCount: menuItems.length,
      legacyPriceListsCount: legacyPriceLists.length,
      note: "Le offerte speciali codificate devono essere convertite manualmente in offerte generiche dopo la migrazione automatica.",
    },
  });
}
