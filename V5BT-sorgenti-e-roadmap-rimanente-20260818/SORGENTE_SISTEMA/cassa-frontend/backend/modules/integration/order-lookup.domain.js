export function buildIntegrationOrderLookupCandidates(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const candidates = new Set([raw]);
  const withoutKnownPrefix = raw
    .replace(/^comanda\s*#?\s*/i, "")
    .replace(/^ordine\s*#?\s*/i, "")
    .replace(/^order[_\s:#-]+/i, "")
    .replace(/^bill[_\s:#-]+/i, "")
    .trim();
  if (withoutKnownPrefix) candidates.add(withoutKnownPrefix);
  const digitMatches = [raw, withoutKnownPrefix]
    .map((entry) => String(entry ?? "").match(/\d{1,8}/)?.[0] ?? "")
    .filter(Boolean);
  digitMatches.forEach((digits) => {
    candidates.add(digits);
    candidates.add(digits.padStart(5, "0"));
  });
  return [...candidates].filter(Boolean);
}

export function buildIntegrationOrderLookupIndex(orders) {
  const byCandidate = new Map();
  (Array.isArray(orders) ? orders : []).forEach((order, index) => {
    const id = String(order?.id ?? "").trim();
    if (!id) return;
    [id, `order_${id}`, `#${id}`].forEach((candidate) => {
      if (!byCandidate.has(candidate)) byCandidate.set(candidate, index);
    });
  });
  return { orders, byCandidate };
}

function findIntegrationOrderIndexByLookupMap(lookupIndex, candidates) {
  const byCandidate =
    lookupIndex?.byCandidate instanceof Map ? lookupIndex.byCandidate : null;
  if (!byCandidate) return -1;
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const index = byCandidate.get(candidate);
    if (Number.isInteger(index) && index >= 0 && index < bestIndex) {
      bestIndex = index;
    }
  }
  return Number.isFinite(bestIndex) ? bestIndex : -1;
}

export function findIntegrationOrderIndexByLookup(orders, value, options = {}) {
  if (!Array.isArray(orders)) return -1;
  const candidates = buildIntegrationOrderLookupCandidates(value);
  if (candidates.length === 0) return -1;
  const indexed = findIntegrationOrderIndexByLookupMap(
    options.lookupIndex,
    candidates,
  );
  if (indexed >= 0) return indexed;
  const candidateSet = new Set(candidates);
  return orders.findIndex((order) => {
    const id = String(order?.id ?? "").trim();
    if (candidateSet.has(id)) return true;
    return candidateSet.has(`order_${id}`) || candidateSet.has(`#${id}`);
  });
}

export function buildIntegrationOrderTitleFromItems(items) {
  const parts = [];
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || item.voidedAt || item.lineType === "BAR_CHARGE_REPLACEMENT") return;
    const name = String(item.productNameSnapshot ?? item.name ?? item.productName ?? "").trim();
    if (!name) return;
    const qtyRaw = Number(item.qty ?? item.quantity);
    const qty = Number.isFinite(qtyRaw) ? Math.max(Math.trunc(qtyRaw), 1) : 1;
    parts.push(`${qty}x ${name}`);
  });
  return parts.join(" | ").slice(0, 120);
}

export function resolveIntegrationOrderDisplayTitle(order, fallback = "") {
  return (
    buildIntegrationOrderTitleFromItems(order?.items) ||
    String(fallback ?? order?.title ?? "").trim().slice(0, 120)
  );
}
