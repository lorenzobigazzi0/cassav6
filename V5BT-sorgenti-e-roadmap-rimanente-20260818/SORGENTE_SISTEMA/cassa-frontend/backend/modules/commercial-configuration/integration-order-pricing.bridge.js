function asString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function asIdList(value, limit = 100) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => asString(entry)).filter(Boolean))].slice(0, limit);
}

function asCents(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function sanitizeSelection(value) {
  if (!value || typeof value !== "object") return null;
  const groupId = asString(value.groupId ?? value.group_id);
  const optionId = asString(value.optionId ?? value.option_id ?? value.id);
  if (!groupId || !optionId) return null;
  return {
    groupId,
    optionId,
    productId: asString(value.productId ?? value.product_id) || null,
    quantity: Math.max(1, Math.trunc(Number(value.quantity ?? value.qty) || 1)),
  };
}

function sanitizeTraceEntry(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const key of [
    "type",
    "catalogId",
    "priceListId",
    "assignmentId",
    "sellableType",
    "sellableId",
    "productId",
    "offerId",
    "variantId",
    "groupId",
    "optionId",
    "source",
    "reason",
    "resolvedAt",
  ]) {
    const normalized = asString(value[key]);
    if (normalized) result[key] = normalized;
  }
  for (const key of ["priceCents", "deltaCents", "basePriceCents", "finalUnitPriceCents", "quantity"]) {
    const parsed = Number(value[key]);
    if (Number.isFinite(parsed)) result[key] = Math.round(parsed);
  }
  return Object.keys(result).length ? result : null;
}

export function buildCommercialLinePricingRequest({ line, menuItem, selectedVariant, quantity, lineName } = {}) {
  const source = line && typeof line === "object" ? line : {};
  const menuSource = menuItem && typeof menuItem === "object" ? menuItem : {};
  const explicitType = asString(
    source.commercialSellableType ?? source.sellableType ?? source.type,
  ).toLowerCase();
  const isOffer =
    explicitType === "offer" ||
    source.isOffer === true ||
    Boolean(source.offerId) ||
    menuSource.isOffer === true ||
    asString(menuSource.type).toLowerCase() === "offer";
  const sellableType = isOffer ? "offer" : "product";
  const sellableId = asString(
    source.commercialSellableId ??
      source.sellableId ??
      (isOffer ? source.offerId : source.productId) ??
      menuSource.id ??
      source.id,
  );
  return {
    sellableType,
    sellableId,
    ...(sellableType === "offer" ? { offerId: sellableId } : { productId: sellableId }),
    name: asString(lineName ?? source.name),
    quantity: Math.max(1, Math.trunc(Number(quantity ?? source.qty) || 1)),
    variantId: asString(
      selectedVariant?.id ?? source.variantId ?? source.selectedVariantId,
    ),
    offerSelections:
      source.offerSelections ?? source.commercialSelections ?? source.selections ?? [],
  };
}

export function isManualCommercialLine(line, menuItem) {
  const source = line && typeof line === "object" ? line : {};
  const reason = asString(source.priceChangeReason).toLowerCase();
  if (reason === "manual") return true;
  if (source.custom === true || source.isCustom === true) return true;
  const productId = asString(
    source.commercialSellableId ??
      source.sellableId ??
      source.productId ??
      source.offerId ??
      menuItem?.id,
  );
  return !productId;
}

export function sanitizeCommercialPricingSnapshot(input, overrides = {}) {
  if (!input || typeof input !== "object") return null;
  const source = input.pricingSnapshot && typeof input.pricingSnapshot === "object"
    ? input.pricingSnapshot
    : input;
  const sellableType = asString(source.sellableType).toLowerCase();
  const sellableId = asString(source.sellableId);
  const configurationVersionId = asString(source.configurationVersionId);
  const catalogId = asString(source.catalogId);
  if (!sellableId || !catalogId) return null;
  const selectionSnapshot = Array.isArray(source.selectionSnapshot)
    ? source.selectionSnapshot.map(sanitizeSelection).filter(Boolean).slice(0, 100)
    : [];
  const pricingTrace = Array.isArray(source.pricingTrace)
    ? source.pricingTrace.map(sanitizeTraceEntry).filter(Boolean).slice(0, 100)
    : [];
  const priceListChain = Array.isArray(source.priceListChain)
    ? source.priceListChain
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const id = asString(entry.id);
          if (!id) return null;
          return {
            id,
            name: asString(entry.name),
            source: asString(entry.source),
            assignmentId: asString(entry.assignmentId) || null,
          };
        })
        .filter(Boolean)
        .slice(0, 50)
    : [];
  const finalUnitPriceCents = asCents(
    overrides.finalUnitPriceCents ?? source.finalUnitPriceCents,
  );
  const quantity = Math.max(
    1,
    Math.trunc(Number(overrides.quantity ?? source.quantity) || 1),
  );
  return {
    schemaVersion: Math.max(2, Math.trunc(Number(source.schemaVersion) || 2)),
    configurationVersionId: configurationVersionId || null,
    configurationVersionNumber: Number.isFinite(Number(source.configurationVersionNumber))
      ? Math.trunc(Number(source.configurationVersionNumber))
      : null,
    configurationChecksum: asString(source.configurationChecksum),
    catalogId,
    priceListChain,
    appliedAssignmentIds: asIdList(source.appliedAssignmentIds),
    sellableType: sellableType === "offer" ? "offer" : "product",
    sellableId,
    basePriceCents: asCents(source.basePriceCents),
    variantDeltaCents: Math.round(Number(source.variantDeltaCents) || 0),
    offerSupplementCents: Math.round(Number(source.offerSupplementCents) || 0),
    finalUnitPriceCents,
    quantity,
    lineTotalCents: asCents(
      overrides.lineTotalCents ?? source.lineTotalCents ?? finalUnitPriceCents * quantity,
    ),
    selectionSnapshot,
    priceFingerprint: asString(source.priceFingerprint),
    resolvedAt: asString(source.resolvedAt),
    pricingTrace,
  };
}
