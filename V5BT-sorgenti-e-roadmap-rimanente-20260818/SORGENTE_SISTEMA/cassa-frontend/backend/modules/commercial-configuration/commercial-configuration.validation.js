import {
  COMMERCIAL_SCOPE_SPECIFICITY,
  COMMERCIAL_WEEKDAYS,
} from "./constants.js";
import { normalizeCommercialConfiguration } from "./commercial-configuration.normalization.js";
import { asString, normalizeId } from "./commercial-configuration.utils.js";

function issue(code, message, path = "", details = {}) {
  return { code, message, path, ...details };
}

function collectDuplicates(entries, keySelector) {
  const seen = new Map();
  const duplicates = [];
  entries.forEach((entry, index) => {
    const key = keySelector(entry, index);
    if (!key) return;
    if (seen.has(key)) duplicates.push({ key, firstIndex: seen.get(key), index });
    else seen.set(key, index);
  });
  return duplicates;
}

function dateRangesOverlap(left, right) {
  const leftStart = left.validFrom ? Date.parse(left.validFrom) : Number.NEGATIVE_INFINITY;
  const leftEnd = left.validTo ? Date.parse(left.validTo) : Number.POSITIVE_INFINITY;
  const rightStart = right.validFrom ? Date.parse(right.validFrom) : Number.NEGATIVE_INFINITY;
  const rightEnd = right.validTo ? Date.parse(right.validTo) : Number.POSITIVE_INFINITY;
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function assignmentWeeklyIntervals(assignment) {
  const intervals = [];
  const days = Array.isArray(assignment.weekdays) && assignment.weekdays.length
    ? assignment.weekdays
    : COMMERCIAL_WEEKDAYS;
  const start = Number(assignment.startMinute);
  const end = Number(assignment.endMinute);
  for (const day of days) {
    const dayIndex = COMMERCIAL_WEEKDAYS.indexOf(day);
    if (dayIndex < 0) continue;
    const base = dayIndex * 1440;
    if (start < end) {
      intervals.push([base + start, base + end]);
    } else {
      intervals.push([base + start, base + 1440]);
      intervals.push([((dayIndex + 1) % 7) * 1440, ((dayIndex + 1) % 7) * 1440 + end]);
    }
  }
  return intervals;
}

function timeRangesOverlap(left, right) {
  const leftIntervals = assignmentWeeklyIntervals(left);
  const rightIntervals = assignmentWeeklyIntervals(right);
  return leftIntervals.some(([leftStart, leftEnd]) =>
    rightIntervals.some(([rightStart, rightEnd]) => leftStart < rightEnd && rightStart < leftEnd),
  );
}

function validatePriceListInheritance(config, errors) {
  const listsById = new Map(config.priceLists.map((entry) => [entry.id, entry]));
  const state = new Map();
  const visit = (id, chain = []) => {
    const currentState = state.get(id);
    if (currentState === "done") return;
    if (currentState === "visiting") {
      errors.push(issue(
        "PRICE_LIST_INHERITANCE_CYCLE",
        `Ciclo di ereditarietà rilevato nei listini: ${[...chain, id].join(" → ")}.`,
        `priceLists.${id}.inheritsFromId`,
      ));
      return;
    }
    state.set(id, "visiting");
    const parentId = listsById.get(id)?.inheritsFromId;
    if (parentId) {
      if (!listsById.has(parentId)) {
        errors.push(issue(
          "PRICE_LIST_PARENT_NOT_FOUND",
          `Il listino ${id} eredita da ${parentId}, che non esiste.`,
          `priceLists.${id}.inheritsFromId`,
        ));
      } else {
        visit(parentId, [...chain, id]);
      }
    }
    state.set(id, "done");
  };
  config.priceLists.forEach((entry) => visit(entry.id));
}

function buildCatalogSellableKeys(catalog) {
  const keys = [];
  for (const category of catalog.categories) {
    for (const entry of category.entries) {
      if (entry.enabled !== false && entry.visible !== false) keys.push(`${entry.sellableType}:${entry.sellableId}`);
    }
  }
  return [...new Set(keys)];
}

export function validateCommercialConfiguration(input, options = {}) {
  const config = normalizeCommercialConfiguration(input);
  const errors = [];
  const warnings = [];

  for (const [collectionName, entries] of [
    ["products", config.products],
    ["catalogs", config.catalogs],
    ["priceLists", config.priceLists],
    ["offers", config.offers],
    ["assignments", config.assignments],
  ]) {
    for (const duplicate of collectDuplicates(entries, (entry) => entry.id)) {
      errors.push(issue(
        "DUPLICATE_ID",
        `ID duplicato ${duplicate.key} nella raccolta ${collectionName}.`,
        `${collectionName}[${duplicate.index}].id`,
      ));
    }
  }

  const productsById = new Map(config.products.map((entry) => [entry.id, entry]));
  const offersById = new Map(config.offers.map((entry) => [entry.id, entry]));
  const catalogsById = new Map(config.catalogs.map((entry) => [entry.id, entry]));
  const priceListsById = new Map(config.priceLists.map((entry) => [entry.id, entry]));

  if (config.catalogs.length === 0) {
    errors.push(issue("CATALOG_REQUIRED", "È necessario almeno un catalogo.", "catalogs"));
  }
  if (!catalogsById.has(config.settings.defaultCatalogId)) {
    errors.push(issue(
      "DEFAULT_CATALOG_NOT_FOUND",
      `Il catalogo predefinito ${config.settings.defaultCatalogId} non esiste.`,
      "settings.defaultCatalogId",
    ));
  }

  for (const catalog of config.catalogs) {
    if (!catalog.basePriceListId) {
      errors.push(issue(
        "BASE_PRICE_LIST_REQUIRED",
        `Il catalogo ${catalog.name} non ha un listino base.`,
        `catalogs.${catalog.id}.basePriceListId`,
      ));
    } else {
      const baseList = priceListsById.get(catalog.basePriceListId);
      if (!baseList) {
        errors.push(issue(
          "BASE_PRICE_LIST_NOT_FOUND",
          `Il listino base ${catalog.basePriceListId} del catalogo ${catalog.name} non esiste.`,
          `catalogs.${catalog.id}.basePriceListId`,
        ));
      } else if (baseList.catalogId && baseList.catalogId !== catalog.id) {
        errors.push(issue(
          "BASE_PRICE_LIST_WRONG_CATALOG",
          `Il listino ${baseList.name} appartiene al catalogo ${baseList.catalogId}, non a ${catalog.id}.`,
          `catalogs.${catalog.id}.basePriceListId`,
        ));
      }
    }

    for (const category of catalog.categories) {
      for (const duplicate of collectDuplicates(category.groups, (entry) => entry.id)) {
        errors.push(issue(
          "DUPLICATE_GROUP_ID",
          `Gruppo ${duplicate.key} duplicato nella categoria ${category.name}.`,
          `catalogs.${catalog.id}.categories.${category.id}.groups`,
        ));
      }
      for (const duplicate of collectDuplicates(category.entries, (entry) => entry.id)) {
        errors.push(issue(
          "DUPLICATE_CATALOG_ENTRY_ID",
          `Voce ${duplicate.key} duplicata nella categoria ${category.name}.`,
          `catalogs.${catalog.id}.categories.${category.id}.entries`,
        ));
      }
      const groupsById = new Map(category.groups.map((entry) => [entry.id, entry]));
      for (const entry of category.entries) {
        if (entry.groupId && !groupsById.has(entry.groupId)) {
          errors.push(issue(
            "CATALOG_GROUP_NOT_FOUND",
            `La voce ${entry.id} fa riferimento al gruppo inesistente ${entry.groupId}.`,
            `catalogs.${catalog.id}.categories.${category.id}.entries.${entry.id}.groupId`,
          ));
        }
        if (entry.sellableType === "product" && !productsById.has(entry.sellableId)) {
          errors.push(issue(
            "CATALOG_PRODUCT_NOT_FOUND",
            `La voce ${entry.id} fa riferimento al prodotto inesistente ${entry.sellableId}.`,
            `catalogs.${catalog.id}.categories.${category.id}.entries.${entry.id}.sellableId`,
          ));
        }
        if (entry.sellableType === "offer" && !offersById.has(entry.sellableId)) {
          errors.push(issue(
            "CATALOG_OFFER_NOT_FOUND",
            `La voce ${entry.id} fa riferimento all'offerta inesistente ${entry.sellableId}.`,
            `catalogs.${catalog.id}.categories.${category.id}.entries.${entry.id}.sellableId`,
          ));
        }
      }
    }
  }

  for (const priceList of config.priceLists) {
    if (!catalogsById.has(priceList.catalogId)) {
      errors.push(issue(
        "PRICE_LIST_CATALOG_NOT_FOUND",
        `Il listino ${priceList.name} è associato al catalogo inesistente ${priceList.catalogId}.`,
        `priceLists.${priceList.id}.catalogId`,
      ));
    }
    if (priceList.currency !== config.currency) {
      errors.push(issue(
        "PRICE_LIST_CURRENCY_MISMATCH",
        `Il listino ${priceList.name} usa ${priceList.currency}, mentre la configurazione usa ${config.currency}.`,
        `priceLists.${priceList.id}.currency`,
      ));
    }
    for (const duplicate of collectDuplicates(priceList.entries, (entry) => `${entry.sellableType}:${entry.sellableId}`)) {
      errors.push(issue(
        "DUPLICATE_PRICE_ENTRY",
        `Prezzo duplicato per ${duplicate.key} nel listino ${priceList.name}.`,
        `priceLists.${priceList.id}.entries[${duplicate.index}]`,
      ));
    }
    for (const entry of priceList.entries) {
      if (entry.sellableType === "product" && !productsById.has(normalizeId(entry.sellableId, ""))) {
        errors.push(issue(
          "PRICE_PRODUCT_NOT_FOUND",
          `Il listino ${priceList.name} contiene un prezzo per il prodotto inesistente ${entry.sellableId}.`,
          `priceLists.${priceList.id}.entries.${entry.id}`,
        ));
      }
      if (entry.sellableType === "offer" && !offersById.has(normalizeId(entry.sellableId, ""))) {
        errors.push(issue(
          "PRICE_OFFER_NOT_FOUND",
          `Il listino ${priceList.name} contiene un prezzo per l'offerta inesistente ${entry.sellableId}.`,
          `priceLists.${priceList.id}.entries.${entry.id}`,
        ));
      }
    }
  }
  validatePriceListInheritance(config, errors);

  for (const offer of config.offers) {
    for (const included of offer.includedItems) {
      if (!productsById.has(included.productId)) {
        errors.push(issue(
          "OFFER_PRODUCT_NOT_FOUND",
          `L'offerta ${offer.name} include il prodotto inesistente ${included.productId}.`,
          `offers.${offer.id}.includedItems.${included.id}`,
        ));
      }
    }
    for (const duplicate of collectDuplicates(offer.choiceGroups, (entry) => entry.id)) {
      errors.push(issue(
        "DUPLICATE_CHOICE_GROUP_ID",
        `Gruppo di scelta ${duplicate.key} duplicato nell'offerta ${offer.name}.`,
        `offers.${offer.id}.choiceGroups`,
      ));
    }
    for (const group of offer.choiceGroups) {
      if (group.minSelections > group.maxSelections) {
        errors.push(issue(
          "CHOICE_GROUP_MIN_GT_MAX",
          `Nel gruppo ${group.name} il minimo supera il massimo.`,
          `offers.${offer.id}.choiceGroups.${group.id}`,
        ));
      }
      if (group.required && group.minSelections === 0) {
        warnings.push(issue(
          "REQUIRED_GROUP_WITH_ZERO_MIN",
          `Il gruppo ${group.name} è obbligatorio ma consente zero selezioni.`,
          `offers.${offer.id}.choiceGroups.${group.id}`,
        ));
      }
      if (group.options.length === 0 && group.minSelections > 0) {
        errors.push(issue(
          "REQUIRED_GROUP_WITHOUT_OPTIONS",
          `Il gruppo ${group.name} richiede selezioni ma non contiene opzioni.`,
          `offers.${offer.id}.choiceGroups.${group.id}.options`,
        ));
      }
      for (const duplicate of collectDuplicates(group.options, (entry) => entry.id)) {
        errors.push(issue(
          "DUPLICATE_CHOICE_OPTION_ID",
          `Opzione ${duplicate.key} duplicata nel gruppo ${group.name}.`,
          `offers.${offer.id}.choiceGroups.${group.id}.options`,
        ));
      }
      for (const option of group.options) {
        if (!productsById.has(option.productId)) {
          errors.push(issue(
            "CHOICE_OPTION_PRODUCT_NOT_FOUND",
            `L'opzione ${option.id} fa riferimento al prodotto inesistente ${option.productId}.`,
            `offers.${offer.id}.choiceGroups.${group.id}.options.${option.id}`,
          ));
        }
      }
    }
  }

  for (const assignment of config.assignments) {
    if (assignment.targetType === "catalog" && !catalogsById.has(assignment.targetId)) {
      errors.push(issue(
        "ASSIGNMENT_CATALOG_NOT_FOUND",
        `La regola ${assignment.id} punta al catalogo inesistente ${assignment.targetId}.`,
        `assignments.${assignment.id}.targetId`,
      ));
    }
    if (assignment.targetType === "price_list" && !priceListsById.has(assignment.targetId)) {
      errors.push(issue(
        "ASSIGNMENT_PRICE_LIST_NOT_FOUND",
        `La regola ${assignment.id} punta al listino inesistente ${assignment.targetId}.`,
        `assignments.${assignment.id}.targetId`,
      ));
    }
    if (assignment.scopeType !== "global" && !assignment.scopeId) {
      errors.push(issue(
        "ASSIGNMENT_SCOPE_ID_REQUIRED",
        `La regola ${assignment.id} richiede uno scopeId per ${assignment.scopeType}.`,
        `assignments.${assignment.id}.scopeId`,
      ));
    }
    if (assignment.validFrom && assignment.validTo && Date.parse(assignment.validFrom) > Date.parse(assignment.validTo)) {
      errors.push(issue(
        "ASSIGNMENT_DATE_RANGE_INVALID",
        `La regola ${assignment.id} termina prima di iniziare.`,
        `assignments.${assignment.id}`,
      ));
    }
  }

  const enabledAssignments = config.assignments.filter((entry) => entry.enabled !== false);
  for (let leftIndex = 0; leftIndex < enabledAssignments.length; leftIndex += 1) {
    const left = enabledAssignments[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < enabledAssignments.length; rightIndex += 1) {
      const right = enabledAssignments[rightIndex];
      if (
        left.targetType !== right.targetType ||
        left.scopeType !== right.scopeType ||
        left.scopeId !== right.scopeId ||
        left.priority !== right.priority ||
        COMMERCIAL_SCOPE_SPECIFICITY[left.scopeType] !== COMMERCIAL_SCOPE_SPECIFICITY[right.scopeType]
      ) continue;
      if (!dateRangesOverlap(left, right) || !timeRangesOverlap(left, right)) continue;
      if (left.targetId === right.targetId) {
        warnings.push(issue(
          "DUPLICATE_ASSIGNMENT_WINDOW",
          `Le regole ${left.id} e ${right.id} applicano lo stesso obiettivo nello stesso intervallo.`,
          "assignments",
        ));
      } else {
        errors.push(issue(
          "AMBIGUOUS_ASSIGNMENT",
          `Le regole ${left.id} e ${right.id} hanno stessa specificità e priorità ma obiettivi diversi.`,
          "assignments",
          { assignmentIds: [left.id, right.id] },
        ));
      }
    }
  }

  for (const catalog of config.catalogs) {
    const baseList = priceListsById.get(catalog.basePriceListId);
    if (!baseList) continue;
    const inheritedEntries = new Map();
    const collectEntries = (list, seen = new Set()) => {
      if (!list || seen.has(list.id)) return;
      seen.add(list.id);
      if (list.inheritsFromId) collectEntries(priceListsById.get(list.inheritsFromId), seen);
      list.entries.filter((entry) => entry.enabled !== false).forEach((entry) => inheritedEntries.set(`${entry.sellableType}:${entry.sellableId}`, entry));
    };
    collectEntries(baseList);
    for (const key of buildCatalogSellableKeys(catalog)) {
      const [type, id] = key.split(":");
      const fallback = type === "product" ? productsById.get(id)?.basePriceCents : offersById.get(id)?.basePriceCents;
      if (!inheritedEntries.has(key) && !(Number.isFinite(fallback) && fallback >= 0)) {
        errors.push(issue(
          "BASE_PRICE_MISSING",
          `Manca il prezzo base per ${key} nel catalogo ${catalog.name}.`,
          `catalogs.${catalog.id}`,
        ));
      }
    }
  }

  const usedProductIds = new Set();
  for (const catalog of config.catalogs) {
    for (const category of catalog.categories) {
      for (const entry of category.entries) {
        if (entry.sellableType === "product") usedProductIds.add(entry.sellableId);
      }
    }
  }
  for (const offer of config.offers) {
    offer.includedItems.forEach((entry) => usedProductIds.add(entry.productId));
    offer.choiceGroups.forEach((group) => group.options.forEach((entry) => usedProductIds.add(entry.productId)));
  }
  for (const product of config.products) {
    if (!usedProductIds.has(product.id)) {
      warnings.push(issue(
        "UNUSED_PRODUCT",
        `Il prodotto ${product.name} non è utilizzato in cataloghi o offerte.`,
        `products.${product.id}`,
      ));
    }
  }

  const usedPriceListIds = new Set(config.catalogs.map((entry) => entry.basePriceListId).filter(Boolean));
  config.assignments.filter((entry) => entry.targetType === "price_list").forEach((entry) => usedPriceListIds.add(entry.targetId));
  for (const list of config.priceLists) {
    if (!usedPriceListIds.has(list.id) && list.status !== "disabled") {
      warnings.push(issue(
        "UNUSED_PRICE_LIST",
        `Il listino ${list.name} non è base di un catalogo e non è assegnato.`,
        `priceLists.${list.id}`,
      ));
    }
  }

  if (options.knownScopes && typeof options.knownScopes === "object") {
    for (const assignment of config.assignments) {
      if (assignment.scopeType === "global") continue;
      const known = options.knownScopes[assignment.scopeType];
      if (Array.isArray(known) && !known.map(String).includes(String(assignment.scopeId))) {
        warnings.push(issue(
          "UNKNOWN_SCOPE_REFERENCE",
          `La regola ${assignment.id} fa riferimento a ${assignment.scopeType}:${assignment.scopeId}, non presente nello snapshot operativo corrente.`,
          `assignments.${assignment.id}.scopeId`,
        ));
      }
    }
  }

  return {
    ok: errors.length === 0,
    configuration: config,
    errors,
    warnings,
    summary: {
      products: config.products.length,
      catalogs: config.catalogs.length,
      priceLists: config.priceLists.length,
      offers: config.offers.length,
      assignments: config.assignments.length,
      errors: errors.length,
      warnings: warnings.length,
    },
  };
}
