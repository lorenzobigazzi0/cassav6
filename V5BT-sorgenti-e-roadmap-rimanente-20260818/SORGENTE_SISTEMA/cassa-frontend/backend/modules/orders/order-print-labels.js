function fallbackStripPrecontoSupplementUnitSuffix(value) {
  return String(value ?? "").trim();
}

function fallbackNormalizePrecontoInlineSupplementLabel(value) {
  return String(value ?? "").trim();
}

const PRINTABLE_VARIANT_LABEL_KEYS = new Set([
  "displayname",
  "label",
  "name",
  "selectedvariantname",
  "title",
  "value",
  "variantname",
]);

const TECHNICAL_VARIANT_KEYS = new Set([
  "amount",
  "code",
  "delta",
  "displayorder",
  "extraprice",
  "id",
  "key",
  "metadata",
  "price",
  "pricedelta",
  "productid",
  "selectedvariantid",
  "sku",
  "sortorder",
  "variantid",
]);

function normalizeVariantObjectKey(key) {
  return String(key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isTechnicalVariantKey(key) {
  const normalized = normalizeVariantObjectKey(key);
  if (!normalized) return true;
  if (TECHNICAL_VARIANT_KEYS.has(normalized)) return true;
  return normalized.endsWith("id") && normalized !== "fluid";
}

function isPrintableVariantScalar(value) {
  if (value == null) return false;
  if (typeof value === "boolean") return false;
  if (typeof value === "number") return false;
  const cleaned = String(value).trim();
  if (!cleaned) return false;
  if (/^\[object\s+object\]$/i.test(cleaned)) return false;
  return !/^[+-]?\d+(?:[.,]\d+)?$/.test(cleaned);
}

export function createIntegrationOrderPrintLabelHelpers(deps = {}) {
  const stripPrecontoSupplementUnitSuffix =
    typeof deps.stripPrecontoSupplementUnitSuffix === "function"
      ? deps.stripPrecontoSupplementUnitSuffix
      : fallbackStripPrecontoSupplementUnitSuffix;
  const normalizePrecontoInlineSupplementLabel =
    typeof deps.normalizePrecontoInlineSupplementLabel === "function"
      ? deps.normalizePrecontoInlineSupplementLabel
      : fallbackNormalizePrecontoInlineSupplementLabel;

  function extractIntegrationPrintVariantLabel(variants) {
    if (!variants) return "";
    if (typeof variants === "string") {
      return variants.trim().slice(0, 120);
    }
    if (Array.isArray(variants)) {
      return variants
        .map((entry) => {
          if (entry && typeof entry === "object") {
            return extractIntegrationPrintVariantLabel(entry);
          }
          return String(entry ?? "").trim();
        })
        .filter(Boolean)
        .join(" / ")
        .slice(0, 120);
    }
    if (typeof variants !== "object") return "";

    const directLabel = Object.entries(variants)
      .filter(([key]) => PRINTABLE_VARIANT_LABEL_KEYS.has(normalizeVariantObjectKey(key)))
      .map(([, value]) => String(value ?? "").trim())
      .find(Boolean);
    const parts = directLabel ? [directLabel] : [];
    Object.entries(variants).forEach(([key, value]) => {
      const normalizedKey = normalizeVariantObjectKey(key);
      if (PRINTABLE_VARIANT_LABEL_KEYS.has(normalizedKey)) return;
      if (isTechnicalVariantKey(key)) return;
      if (!isPrintableVariantScalar(value)) return;
      const cleaned = String(value ?? "").trim();
      if (parts.includes(cleaned)) return;
      parts.push(cleaned);
    });
    return parts.join(" / ").slice(0, 120);
  }

  function cleanIntegrationOrderVariantLabelForPrint(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    const cleanedParts = raw
      .split(/(?:[|\n]+|\s+\/\s+)/)
      .map((entry) => stripPrecontoSupplementUnitSuffix(normalizePrecontoInlineSupplementLabel(entry)))
      .filter(Boolean);
    const normalized =
      cleanedParts.length > 0 ? cleanedParts.join(" / ") : stripPrecontoSupplementUnitSuffix(raw) || raw;
    return normalized.slice(0, 120);
  }

  function isIntegrationSupplementText(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return false;
    return /(?:\+\s*\d[\d.,]*\s*(?:eur|\u20ac|euro)?|\bsupplement\w*\b|\bextra\b|\baggiunt\w*\b|\bapericena\b|\bmenu\b)/i.test(
      raw
    );
  }

  function cleanIntegrationOrderSupplementLabelForPrint(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    const cleanedParts = raw
      .split(/(?:[|\n]+|\s+\/\s+)/)
      .map((entry) =>
        stripPrecontoSupplementUnitSuffix(
          String(entry ?? "")
            .replace(/^(?:note?|nota|commento)\b\s*:?/i, "")
            .trim()
        )
      )
      .map((entry) => entry.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return (cleanedParts.join(" / ") || raw).slice(0, 120);
  }

  function formatIntegrationWaiterShortLabel(value) {
    const raw = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return "Cameriere";
    const parts = raw.split(" ").filter(Boolean);
    if (parts.length <= 1) return raw;
    const firstName = parts[0];
    const lastInitial = String(parts[parts.length - 1] ?? "").trim().charAt(0).toUpperCase();
    return lastInitial ? `${firstName} ${lastInitial}.` : firstName;
  }

  return {
    cleanIntegrationOrderSupplementLabelForPrint,
    cleanIntegrationOrderVariantLabelForPrint,
    extractIntegrationPrintVariantLabel,
    formatIntegrationWaiterShortLabel,
    isIntegrationSupplementText,
  };
}
