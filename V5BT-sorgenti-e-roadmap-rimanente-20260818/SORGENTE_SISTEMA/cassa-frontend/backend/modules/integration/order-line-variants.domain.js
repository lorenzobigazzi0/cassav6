export function collectIntegrationVariantMarkers(line) {
  const markers = [];
  const push = (value) => {
    if (value === null || value === undefined) return;
    const text = String(value).trim();
    if (text) markers.push(text);
  };
  const visit = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object") return;
    ["id", "value", "name", "label", "title", "code", "key"].forEach((field) => push(value[field]));
    Object.entries(value).forEach(([key, entryValue]) => {
      if (entryValue === true) {
        push(key);
        return;
      }
      if (typeof entryValue === "string" || typeof entryValue === "number") {
        push(key);
        push(entryValue);
      } else if (entryValue && typeof entryValue === "object") {
        visit(entryValue);
      }
    });
  };

  visit(line?.variant);
  visit(line?.variantName);
  visit(line?.variantId);
  visit(line?.variant_id);
  visit(line?.selectedVariant);
  visit(line?.selected_variant);
  visit(line?.variants);
  return [...new Set(markers)];
}

function cloneVariantJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

export function normalizeIntegrationVariantData(rawVariants, rawVariantName) {
  if (rawVariants && typeof rawVariants === "object") {
    return cloneVariantJson(rawVariants, {});
  }
  const variant = String(rawVariantName ?? "").trim();
  if (!variant) return {};
  return { label: variant };
}

function roundVariantMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function readVariantMoneyValue(value) {
  if (typeof value === "string") {
    const normalized = value
      .replace(/[^\d,.-]/g, "")
      .replace(/\.(?=\d{3}(?:\D|$))/g, "")
      .replace(",", ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed >= 0 ? roundVariantMoney(parsed) : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? roundVariantMoney(parsed) : null;
}

export function readIntegrationVariantDeltaCandidate(value) {
  const parsed = readVariantMoneyValue(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

export function resolveIntegrationLineExplicitVariantDelta(line) {
  const directCandidates = [
    line?.variantPriceDelta,
    line?.variant_price_delta,
    line?.variantDelta,
    line?.variant_delta,
    line?.modifierPriceDelta,
    line?.modifier_price_delta,
  ];
  for (const candidate of directCandidates) {
    const parsed = readIntegrationVariantDeltaCandidate(candidate);
    if (parsed > 0) return parsed;
  }

  const nestedSources = [line?.selectedVariant, line?.selected_variant, line?.variants];
  for (const source of nestedSources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const nestedCandidates = [
      source.priceDelta,
      source.price_delta,
      source.delta,
      source.extraPrice,
      source.extra_price,
      source.supplement,
    ];
    for (const candidate of nestedCandidates) {
      const parsed = readIntegrationVariantDeltaCandidate(candidate);
      if (parsed > 0) return parsed;
    }
  }

  if (Array.isArray(line?.variants)) {
    let total = 0;
    line.variants.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      total = roundVariantMoney(
        total +
          readIntegrationVariantDeltaCandidate(
            entry.priceDelta ?? entry.price_delta ?? entry.delta ?? entry.extraPrice ?? entry.extra_price
          )
      );
    });
    if (total > 0) return total;
  }

  return 0;
}

export function resolveIntegrationLineSupplementMarkerDelta(line) {
  const markers = collectIntegrationVariantMarkers(line)
    .concat([line?.note, line?.notes, line?.description])
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const supplementMatch = /(?:\+)\s*(\d+(?:[.,]\d{1,2})?)/i.exec(markers);
  return supplementMatch
    ? roundVariantMoney(Math.max(Number(String(supplementMatch[1]).replace(",", ".")) || 0, 0))
    : 0;
}

export function applyIntegrationVariantDeltaToBasePrice(basePrice, menuBasePrice, variantDelta) {
  const base = roundVariantMoney(Math.max(Number(basePrice) || 0, 0));
  const delta = roundVariantMoney(Math.max(Number(variantDelta) || 0, 0));
  if (base <= 0 || delta <= 0) return base;
  const menuBase = menuBasePrice !== null ? roundVariantMoney(Math.max(Number(menuBasePrice) || 0, 0)) : 0;
  const expectedPremium = roundVariantMoney(menuBase + delta);
  if (expectedPremium > 0 && base >= expectedPremium - 0.001) return base;
  if (menuBase > 0 && base <= menuBase + 0.001) return roundVariantMoney(base + delta);
  return base;
}
