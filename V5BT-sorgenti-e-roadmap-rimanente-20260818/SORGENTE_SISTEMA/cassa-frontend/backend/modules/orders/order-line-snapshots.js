function fallbackRoundMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
}

function fallbackCloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function fallbackNormalizeStringList(value, maxLength = 12, itemMaxLength = 40) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const next = String(raw ?? "").trim().slice(0, itemMaxLength);
    if (!next) continue;
    const key = next.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
    if (out.length >= maxLength) break;
  }
  return out;
}

function fallbackNormalizeStationName(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function createIntegrationOrderLineSnapshotHelpers(deps = {}) {
  const roundMoney = typeof deps.roundMoney === "function" ? deps.roundMoney : fallbackRoundMoney;
  const cloneJson = typeof deps.cloneJson === "function" ? deps.cloneJson : fallbackCloneJson;
  const normalizeStringList =
    typeof deps.normalizeStringList === "function" ? deps.normalizeStringList : fallbackNormalizeStringList;
  const normalizeIntegrationStationName =
    typeof deps.normalizeIntegrationStationName === "function"
      ? deps.normalizeIntegrationStationName
      : fallbackNormalizeStationName;

  function buildIntegrationOrderLineSnapshots(order) {
    const lines = new Map();
    const items = Array.isArray(order?.items) ? order.items : [];
    items.forEach((item) => {
      if (item.voidedAt) return;
      const lineId = String(item.lineId ?? "").trim();
      if (!lineId) return;
      const current = lines.get(lineId) ?? {
        lineId,
        productId: String(item.productId ?? "").trim() || null,
        productNameSnapshot: String(item.productNameSnapshot ?? item.name ?? "").trim() || "Articolo",
        qty: 0,
        unitPriceApplied: roundMoney(Number(item.unitPriceApplied) || 0),
        listPriceAtTime: roundMoney(Number(item.listPriceAtTime) || Number(item.unitPriceApplied) || 0),
        priceOverrideApplied: item.priceOverrideApplied === true,
        lineTotal: 0,
        variants: cloneJson(item.variants, {}),
        selectedVariantId: String(item.selectedVariantId ?? "").trim() || null,
        selectedVariantName: String(item.selectedVariantName ?? item.variant ?? "").trim() || null,
        selectedVariantPriceDelta: roundMoney(Number(item.selectedVariantPriceDelta ?? item.variantPriceDelta) || 0),
        finalLinePrice: 0,
        notes: String(item.notes ?? item.note ?? "").trim(),
        allergens: normalizeStringList(item.allergens, 20, 80),
        routeStations: Array.isArray(item.routeStations)
          ? item.routeStations.map((entry) => normalizeIntegrationStationName(entry))
          : [],
      };
      const itemQty = Math.max(1, Math.trunc(Number(item?.qty) || 1));
      current.qty += itemQty;
      current.priceOverrideApplied ||= item.priceOverrideApplied === true;
      const itemLineTotal = roundMoney(Math.max(Number(item.lineTotal) || 0, 0));
      current.lineTotal = roundMoney(
        (Number(current.lineTotal) || 0) +
          (item.priceOverrideApplied === true
            ? itemLineTotal
            : itemLineTotal > 0
            ? itemLineTotal
            : Number(item.unitPriceApplied) > 0
              ? Number(item.unitPriceApplied) * itemQty
              : Number(item.listPriceAtTime) > 0
                ? Number(item.listPriceAtTime) * itemQty
                : 0)
      );
      current.finalLinePrice = current.lineTotal;
      lines.set(lineId, current);
    });
    return lines;
  }

  return {
    buildIntegrationOrderLineSnapshots,
  };
}
