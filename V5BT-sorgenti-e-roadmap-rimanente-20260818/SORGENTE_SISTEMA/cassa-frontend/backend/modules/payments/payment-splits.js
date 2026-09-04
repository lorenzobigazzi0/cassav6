export const PAYMENT_SPLIT_TYPES = new Set(["SINGLE", "FREE_SPLIT"]);

function normalizeStringList(value, maxLength = 12, itemMaxLength = 40) {
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

export function normalizePaymentSplitType(value) {
  const candidate = String(value ?? "SINGLE").trim().toUpperCase();
  return PAYMENT_SPLIT_TYPES.has(candidate) ? candidate : "SINGLE";
}

export function normalizePaymentContinuationSplitMode(value, options = {}) {
  const candidate = String(value ?? "").trim().toLowerCase();
  if (
    candidate === "single" ||
    candidate === "bill" ||
    candidate === "roman" ||
    candidate === "amount" ||
    candidate === "article"
  ) {
    return candidate;
  }
  if (options.hasLineSelections === true) return "article";
  if (normalizeStringList(options.articleUnitIds, 1000, 120).length > 0) return "article";
  if (options.hasRequestedBills === true) return "bill";
  if (
    Object.prototype.hasOwnProperty.call(options, "splitType") &&
    normalizePaymentSplitType(options.splitType) === "SINGLE"
  ) {
    return "single";
  }
  return null;
}

export function isAmountStylePaymentContinuationMode(value) {
  const mode = normalizePaymentContinuationSplitMode(value);
  return mode === "roman" || mode === "amount";
}

export function normalizePaymentLineSelections(value) {
  return (Array.isArray(value) ? value : []).filter((entry) => {
    const billId = String(entry?.billId ?? "").trim();
    const qty = Number(entry?.qty);
    return billId.length > 0 && Number.isFinite(Number(entry?.lineIndex)) && Number.isFinite(qty) && qty > 0;
  });
}

export function collectArticleUnitIdsFromPaymentItems(items) {
  return [
    ...new Set(
      (Array.isArray(items) ? items : [])
        .flatMap((item) => normalizeStringList(item?.articleUnitIds, 1000, 120))
    ),
  ].slice(0, 1000);
}
