import { COMMERCIAL_SCOPE_SPECIFICITY, COMMERCIAL_WEEKDAYS } from "./constants.js";
import {
  asString,
  moneyFromCents,
  normalizeExternalId,
  normalizeId,
  sha256,
} from "./commercial-configuration.utils.js";

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdayMap = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayMap[parts.weekday] ?? "mon",
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function previousWeekday(weekday) {
  const index = COMMERCIAL_WEEKDAYS.indexOf(weekday);
  return COMMERCIAL_WEEKDAYS[(index + 6) % 7];
}

function assignmentMatchesTime(assignment, date, timeZone) {
  if (assignment.enabled === false) return false;
  const timestamp = date.getTime();
  if (assignment.validFrom && timestamp < Date.parse(assignment.validFrom)) return false;
  if (assignment.validTo && timestamp > Date.parse(assignment.validTo)) return false;
  const parts = getZonedParts(date, timeZone);
  const weekdays = Array.isArray(assignment.weekdays) && assignment.weekdays.length
    ? assignment.weekdays
    : COMMERCIAL_WEEKDAYS;
  const start = Number(assignment.startMinute);
  const end = Number(assignment.endMinute);
  if (start < end) {
    return weekdays.includes(parts.weekday) && parts.minuteOfDay >= start && parts.minuteOfDay < end;
  }
  return (
    (weekdays.includes(parts.weekday) && parts.minuteOfDay >= start) ||
    (weekdays.includes(previousWeekday(parts.weekday)) && parts.minuteOfDay < end)
  );
}

export function normalizeCommercialPricingContext(input = {}) {
  const date = input.dateTime instanceof Date ? input.dateTime : new Date(input.dateTime ?? Date.now());
  return {
    dateTime: Number.isFinite(date.getTime()) ? date : new Date(),
    channel: normalizeExternalId(input.channel ?? input.clientApp, "default"),
    activityId: normalizeExternalId(input.activityId, ""),
    roomId: normalizeExternalId(input.roomId ?? input.areaId, ""),
    workstationId: normalizeExternalId(input.workstationId ?? input.stationId ?? input.station, ""),
    role: normalizeExternalId(input.role ?? input.userRole, ""),
    userGroupIds: [...new Set(
      (Array.isArray(input.userGroupIds)
        ? input.userGroupIds
        : typeof input.userGroupIds === "string"
          ? input.userGroupIds.split(/[\n,;]+/)
          : input.userGroupIds == null
            ? []
            : [input.userGroupIds])
        .map((entry) => normalizeExternalId(entry, ""))
        .filter(Boolean),
    )],
    userId: normalizeExternalId(input.userId, ""),
    orderMode: normalizeExternalId(input.orderMode, ""),
    reservationContext: input.reservationContext && typeof input.reservationContext === "object"
      ? input.reservationContext
      : null,
  };
}

function assignmentMatchesScope(assignment, context) {
  switch (assignment.scopeType) {
    case "global": return true;
    case "channel": return assignment.scopeId === context.channel;
    case "activity": return assignment.scopeId === context.activityId;
    case "room": return assignment.scopeId === context.roomId;
    case "workstation": return assignment.scopeId === context.workstationId;
    case "role": return assignment.scopeId === context.role;
    case "user_group": return context.userGroupIds.includes(assignment.scopeId);
    case "user": return assignment.scopeId === context.userId;
    default: return false;
  }
}

function matchingAssignments(compiled, targetType, context) {
  const timeZone = compiled.settings?.timeZone || "Europe/Rome";
  return (Array.isArray(compiled.assignments) ? compiled.assignments : [])
    .filter((assignment) =>
      assignment.targetType === targetType &&
      assignmentMatchesScope(assignment, context) &&
      assignmentMatchesTime(assignment, context.dateTime, timeZone),
    )
    .sort((left, right) =>
      (left.specificity ?? COMMERCIAL_SCOPE_SPECIFICITY[left.scopeType] ?? 0) -
        (right.specificity ?? COMMERCIAL_SCOPE_SPECIFICITY[right.scopeType] ?? 0) ||
      left.priority - right.priority ||
      left.id.localeCompare(right.id),
    );
}

function findByNameIndex(index, name) {
  const key = asString(name).toLocaleLowerCase("it-IT");
  const matches = key ? index?.[key] : null;
  return Array.isArray(matches) && matches.length === 1 ? matches[0] : null;
}

export function resolveCommercialContext(compiled, contextInput = {}) {
  const context = normalizeCommercialPricingContext(contextInput);
  const catalogAssignments = matchingAssignments(compiled, "catalog", context);
  const defaultCatalogId = normalizeId(compiled.settings?.defaultCatalogId, "");
  const assignedCatalogId = catalogAssignments.at(-1)?.targetId;
  const catalogId = assignedCatalogId || defaultCatalogId || Object.keys(compiled.catalogsById ?? {})[0] || "";
  const catalog = compiled.catalogsById?.[catalogId] ?? null;
  if (!catalog || catalog.status === "disabled") {
    const error = new Error("Nessun catalogo commerciale attivo risolvibile per il contesto.");
    error.code = "COMMERCIAL_CATALOG_NOT_RESOLVED";
    error.details = { catalogId, context };
    throw error;
  }
  const priceListAssignments = matchingAssignments(compiled, "price_list", context)
    .filter((assignment) => compiled.priceListsById?.[assignment.targetId]?.catalogId === catalog.id);
  const chain = [];
  const visiting = new Set();
  const pushUnique = (id, source, assignment = null) => {
    if (!id || chain.some((entry) => entry.id === id)) return;
    const list = compiled.priceListsById?.[id];
    if (!list || list.status === "disabled") return;
    if (visiting.has(id)) return;
    visiting.add(id);
    if (list.inheritsFromId) {
      pushUnique(list.inheritsFromId, "inheritance", assignment);
    }
    visiting.delete(id);
    if (!chain.some((entry) => entry.id === id)) {
      chain.push({ id, name: list.name, source, assignment });
    }
  };
  pushUnique(catalog.basePriceListId, "catalog_base");
  for (const assignment of priceListAssignments) pushUnique(assignment.targetId, "assignment", assignment);
  if (chain.length === 0) {
    const error = new Error(`Il catalogo ${catalog.name} non ha un listino attivo risolvibile.`);
    error.code = "COMMERCIAL_PRICE_LIST_NOT_RESOLVED";
    error.details = { catalogId: catalog.id, context };
    throw error;
  }
  return {
    context,
    catalog,
    catalogAssignments,
    priceListAssignments,
    priceListChain: chain,
    resolvedAt: context.dateTime.toISOString(),
  };
}

function resolveEntryAcrossChain(compiled, resolvedContext, key) {
  let selected = null;
  const trace = [];
  for (const chainEntry of resolvedContext.priceListChain) {
    // La catena di contesto è un overlay: un listino più specifico modifica
    // soltanto le voci dichiarate al suo interno. L'ereditarietà viene espansa
    // in resolveCommercialContext, evitando che un listino utente vuoto
    // ripristini accidentalmente il prezzo base sopra un listino sala/attività.
    const entry = compiled.directPriceListEntries?.[chainEntry.id]?.[key]
      ?? (compiled.directPriceListEntries ? null : compiled.effectivePriceListEntries?.[chainEntry.id]?.[key]);
    if (!entry || entry.enabled === false) continue;
    selected = { ...entry, priceListId: chainEntry.id, priceListName: chainEntry.name };
    trace.push({
      type: "price_list_entry",
      priceListId: chainEntry.id,
      priceListName: chainEntry.name,
      assignmentId: chainEntry.assignment?.id ?? null,
      sellableKey: key,
      priceCents: entry.priceCents,
      available: entry.available !== false,
    });
  }
  return { selected, trace };
}

function resolveProductPrice(compiled, resolvedContext, productId, variantId = "") {
  const product = compiled.productsById?.[productId];
  if (!product || product.enabled === false) {
    const error = new Error(`Prodotto ${productId} non disponibile.`);
    error.code = "COMMERCIAL_PRODUCT_NOT_FOUND";
    throw error;
  }
  const base = resolveEntryAcrossChain(compiled, resolvedContext, `product:${productId}`);
  const basePriceCents = base.selected?.priceCents ?? product.basePriceCents ?? 0;
  const available = base.selected ? base.selected.available !== false : product.enabled !== false;
  let variantDeltaCents = 0;
  let variant = null;
  let variantTrace = [];
  if (variantId) {
    variant = (Array.isArray(product.variants) ? product.variants : []).find((entry) => entry.id === variantId) ?? null;
    if (!variant || variant.enabled === false) {
      const error = new Error(`Variante ${variantId} non valida per ${product.name}.`);
      error.code = "COMMERCIAL_VARIANT_NOT_FOUND";
      throw error;
    }
    const variantKey = `variant:${productId}:${variantId}`;
    const override = resolveEntryAcrossChain(compiled, resolvedContext, variantKey);
    variantDeltaCents = override.selected?.priceCents ?? variant.priceDeltaCents ?? 0;
    variantTrace = override.trace.length
      ? override.trace
      : [{ type: "variant_base_delta", variantId, priceCents: variantDeltaCents }];
  }
  return {
    sellableType: "product",
    sellableId: productId,
    product,
    variant,
    basePriceCents,
    variantDeltaCents,
    finalUnitPriceCents: basePriceCents + variantDeltaCents,
    available,
    trace: [
      ...(base.trace.length ? base.trace : [{ type: "product_fallback_price", productId, priceCents: basePriceCents }]),
      ...variantTrace,
    ],
  };
}

function normalizeOfferSelections(value) {
  const source = Array.isArray(value) ? value : [];
  return source.map((entry) => ({
    groupId: normalizeId(entry?.groupId, ""),
    optionId: normalizeId(entry?.optionId, ""),
    quantity: Math.max(1, Math.trunc(Number(entry?.quantity ?? entry?.qty) || 1)),
  })).filter((entry) => entry.groupId && entry.optionId);
}

function validateOfferSelections(offer, selections) {
  const selectionsByGroup = new Map();
  for (const selection of selections) {
    const current = selectionsByGroup.get(selection.groupId) ?? [];
    current.push(selection);
    selectionsByGroup.set(selection.groupId, current);
  }
  for (const group of offer.choiceGroups ?? []) {
    const groupSelections = selectionsByGroup.get(group.id) ?? [];
    const total = groupSelections.reduce((sum, entry) => sum + entry.quantity, 0);
    if (total < group.minSelections || total > group.maxSelections) {
      const error = new Error(`Il gruppo ${group.name} richiede da ${group.minSelections} a ${group.maxSelections} selezioni.`);
      error.code = "COMMERCIAL_OFFER_SELECTION_COUNT_INVALID";
      error.details = { offerId: offer.id, groupId: group.id, total };
      throw error;
    }
    if (!group.allowRepeat && groupSelections.some((entry) => entry.quantity > 1)) {
      const error = new Error(`Il gruppo ${group.name} non consente ripetizioni.`);
      error.code = "COMMERCIAL_OFFER_REPEAT_NOT_ALLOWED";
      throw error;
    }
    const optionsById = new Map((group.options ?? []).map((entry) => [entry.id, entry]));
    for (const selection of groupSelections) {
      const option = optionsById.get(selection.optionId);
      if (!option || option.enabled === false) {
        const error = new Error(`Opzione ${selection.optionId} non valida per il gruppo ${group.name}.`);
        error.code = "COMMERCIAL_OFFER_OPTION_NOT_FOUND";
        throw error;
      }
    }
  }
  for (const groupId of selectionsByGroup.keys()) {
    if (!(offer.choiceGroups ?? []).some((entry) => entry.id === groupId)) {
      const error = new Error(`Gruppo di scelta ${groupId} non valido per l'offerta ${offer.name}.`);
      error.code = "COMMERCIAL_OFFER_GROUP_NOT_FOUND";
      throw error;
    }
  }
}

function resolveOfferPrice(compiled, resolvedContext, offerId, selectionsInput, options = {}) {
  const offer = compiled.offersById?.[offerId];
  if (!offer || offer.enabled === false) {
    const error = new Error(`Offerta ${offerId} non disponibile.`);
    error.code = "COMMERCIAL_OFFER_NOT_FOUND";
    throw error;
  }
  const selections = normalizeOfferSelections(selectionsInput);
  if (options.preview !== true) validateOfferSelections(offer, selections);
  const trace = [];
  let basePriceCents = 0;
  if (offer.pricingStrategy === "fixed") {
    const base = resolveEntryAcrossChain(compiled, resolvedContext, `offer:${offerId}`);
    basePriceCents = base.selected?.priceCents ?? offer.basePriceCents ?? 0;
    trace.push(...(base.trace.length ? base.trace : [{ type: "offer_fallback_price", offerId, priceCents: basePriceCents }]));
  } else {
    for (const included of offer.includedItems ?? []) {
      const productResolution = resolveProductPrice(compiled, resolvedContext, included.productId);
      const componentCents = productResolution.finalUnitPriceCents * included.quantity;
      basePriceCents += componentCents;
      trace.push({
        type: "offer_included_product",
        productId: included.productId,
        quantity: included.quantity,
        priceCents: componentCents,
      });
    }
  }
  let supplementCents = 0;
  for (const selection of selections) {
    const group = (offer.choiceGroups ?? []).find((entry) => entry.id === selection.groupId);
    const option = group?.options?.find((entry) => entry.id === selection.optionId);
    if (!group || !option) continue;
    const overrideKey = `offer_option:${offerId}:${group.id}:${option.id}`;
    const override = resolveEntryAcrossChain(compiled, resolvedContext, overrideKey);
    let optionSupplementCents = override.selected?.priceCents ?? option.supplementCents ?? 0;
    if (offer.pricingStrategy === "sum_components") {
      const productResolution = resolveProductPrice(compiled, resolvedContext, option.productId);
      optionSupplementCents += productResolution.finalUnitPriceCents * option.quantity;
    }
    const applied = optionSupplementCents * selection.quantity;
    supplementCents += applied;
    trace.push({
      type: "offer_choice",
      groupId: group.id,
      optionId: option.id,
      productId: option.productId,
      quantity: selection.quantity,
      priceCents: applied,
      priceListId: override.selected?.priceListId ?? null,
    });
  }
  return {
    sellableType: "offer",
    sellableId: offerId,
    offer,
    selections,
    basePriceCents,
    offerSupplementCents: supplementCents,
    finalUnitPriceCents: basePriceCents + supplementCents,
    available: true,
    trace,
  };
}

export function resolveCommercialSellable(compiled, contextInput, request = {}) {
  const resolvedContext = request.resolvedContext ?? resolveCommercialContext(compiled, contextInput);
  let sellableType = asString(request.sellableType ?? request.type, "").toLowerCase();
  let sellableId = normalizeId(request.sellableId ?? request.productId ?? request.offerId ?? request.id, "");
  if (!sellableType && request.offerId) sellableType = "offer";
  if (!sellableType) sellableType = "product";
  if (!sellableId && request.name) {
    sellableId = sellableType === "offer"
      ? findByNameIndex(compiled.offerNameIndex, request.name)
      : findByNameIndex(compiled.productNameIndex, request.name);
  }
  if (!sellableId) {
    const error = new Error("Articolo non identificabile: productId/offerId obbligatorio o nome non univoco.");
    error.code = "COMMERCIAL_SELLABLE_NOT_IDENTIFIED";
    throw error;
  }
  const resolution = sellableType === "offer"
    ? resolveOfferPrice(
        compiled,
        resolvedContext,
        sellableId,
        request.offerSelections ?? request.selections,
        { preview: request.preview === true },
      )
    : resolveProductPrice(compiled, resolvedContext, sellableId, normalizeId(request.variantId ?? request.selectedVariantId, ""));
  if (resolution.available === false) {
    const error = new Error("Articolo non disponibile nel listino applicato.");
    error.code = "COMMERCIAL_SELLABLE_UNAVAILABLE";
    throw error;
  }
  const quantity = Math.max(1, Math.trunc(Number(request.quantity ?? request.qty) || 1));
  const finalUnitPriceCents = Math.max(0, Math.round(resolution.finalUnitPriceCents));
  const lineTotalCents = finalUnitPriceCents * quantity;
  const pricingTrace = [
    {
      type: "context",
      catalogId: resolvedContext.catalog.id,
      priceListChain: resolvedContext.priceListChain.map((entry) => entry.id),
      resolvedAt: resolvedContext.resolvedAt,
    },
    ...resolution.trace,
  ];
  const priceFingerprint = sha256({
    sourceChecksum: compiled.sourceChecksum,
    context: {
      channel: resolvedContext.context.channel,
      activityId: resolvedContext.context.activityId,
      roomId: resolvedContext.context.roomId,
      workstationId: resolvedContext.context.workstationId,
      role: resolvedContext.context.role,
      userGroupIds: resolvedContext.context.userGroupIds,
      userId: resolvedContext.context.userId,
    },
    sellableType: resolution.sellableType,
    sellableId: resolution.sellableId,
    variantId: resolution.variant?.id ?? null,
    selections: resolution.selections ?? [],
    finalUnitPriceCents,
  });
  return {
    ok: true,
    sellableType: resolution.sellableType,
    sellableId: resolution.sellableId,
    name: resolution.product?.name ?? resolution.offer?.name ?? resolution.sellableId,
    quantity,
    basePriceCents: resolution.basePriceCents,
    variantDeltaCents: resolution.variantDeltaCents ?? 0,
    offerSupplementCents: resolution.offerSupplementCents ?? 0,
    finalUnitPriceCents,
    lineTotalCents,
    finalUnitPrice: moneyFromCents(finalUnitPriceCents),
    lineTotal: moneyFromCents(lineTotalCents),
    catalogId: resolvedContext.catalog.id,
    catalogName: resolvedContext.catalog.name,
    priceListChain: resolvedContext.priceListChain.map((entry) => ({
      id: entry.id,
      name: entry.name,
      source: entry.source,
      assignmentId: entry.assignment?.id ?? null,
    })),
    appliedAssignmentIds: [
      ...resolvedContext.catalogAssignments.map((entry) => entry.id),
      ...resolvedContext.priceListAssignments.map((entry) => entry.id),
    ],
    configurationChecksum: compiled.sourceChecksum,
    resolvedAt: resolvedContext.resolvedAt,
    priceFingerprint,
    pricingTrace,
    selectionSnapshot: resolution.selections ?? [],
  };
}

export function buildCommercialLegacyMenuItems(compiled, contextInput = {}) {
  const resolvedContext = resolveCommercialContext(compiled, contextInput);
  const items = [];
  for (const category of resolvedContext.catalog.categories ?? []) {
    if (category.enabled === false) continue;
    const groupsById = Object.fromEntries((category.groups ?? []).map((entry) => [entry.id, entry]));
    for (const entry of category.entries ?? []) {
      if (entry.enabled === false || entry.visible === false) continue;
      try {
        const price = resolveCommercialSellable(compiled, contextInput, {
          resolvedContext,
          sellableType: entry.sellableType,
          sellableId: entry.sellableId,
          quantity: 1,
          offerSelections: [],
          preview: true,
        });
        const sellable = entry.sellableType === "offer"
          ? compiled.offersById?.[entry.sellableId]
          : compiled.productsById?.[entry.sellableId];
        if (!sellable || sellable.enabled === false) continue;
        const group = entry.groupId ? groupsById[entry.groupId] : null;
        items.push({
          id: sellable.id,
          name: entry.labelOverride || sellable.name,
          category: category.name,
          categoryId: category.id,
          departmentId: category.departmentId,
          departmentName: category.departmentName,
          section: group?.name ?? "",
          groupId: group?.id ?? null,
          groupName: group?.name ?? null,
          type: entry.sellableType === "offer" ? "offer" : "product",
          isOffer: entry.sellableType === "offer",
          offerDefinition: entry.sellableType === "offer" ? sellable : null,
          price: price.finalUnitPrice,
          priceFrom: entry.sellableType === "offer" && (sellable.choiceGroups ?? []).some(
            (choiceGroup) => Number(choiceGroup.maxSelections ?? 0) > 0,
          ),
          basePrice: moneyFromCents(price.basePriceCents),
          enabled: true,
          variants: entry.sellableType === "product"
            ? (sellable.variants ?? []).map((variant) => ({
                id: variant.id,
                name: variant.name,
                label: variant.name,
                priceDelta: moneyFromCents(variant.priceDeltaCents),
                enabled: variant.enabled,
              }))
            : [],
          variantRequired: false,
          vatRate: sellable.taxRate ?? null,
          vatCode: sellable.taxCode ?? "",
          description: sellable.description ?? "",
          imageUrl: sellable.imageUrl ?? "",
          workstationIds: sellable.workstationIds ?? [],
          stationIds: sellable.workstationIds ?? [],
          stations: sellable.workstationIds ?? [],
          commercialPricing: {
            catalogId: price.catalogId,
            priceListChain: price.priceListChain,
            configurationChecksum: price.configurationChecksum,
            priceFingerprint: price.priceFingerprint,
          },
        });
      } catch (error) {
        if (["COMMERCIAL_OFFER_SELECTION_COUNT_INVALID", "COMMERCIAL_SELLABLE_UNAVAILABLE"].includes(error?.code)) continue;
        throw error;
      }
    }
  }
  return {
    ok: true,
    active: true,
    configurationChecksum: compiled.sourceChecksum,
    catalogId: resolvedContext.catalog.id,
    catalogName: resolvedContext.catalog.name,
    priceListChain: resolvedContext.priceListChain,
    activePriceListIds: resolvedContext.priceListChain.map((entry) => entry.id),
    appliedAssignmentIds: [
      ...resolvedContext.catalogAssignments.map((entry) => entry.id),
      ...resolvedContext.priceListAssignments.map((entry) => entry.id),
    ],
    resolvedAt: resolvedContext.resolvedAt,
    items,
  };
}
