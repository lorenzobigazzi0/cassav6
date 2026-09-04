function defaultRoundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function createPrecontoSupplementHelpers(options = {}) {
  const {
    apericenaStandardTargetPrice = 12,
    roundMoney = defaultRoundMoney,
  } = options;

  function normalizePrecontoInlineSupplementLabel(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    return raw
      .replace(/^(?:variante|varianti|supplemento|supplementi|extra|aggiunta|aggiunte)\b\s*:?/i, "")
      .replace(/^(?:note?|nota|commento)\b\s*:?/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isPrecontoApericenaLabel(value) {
    const normalized = normalizePrecontoInlineSupplementLabel(value)
      .toLocaleLowerCase("it-IT")
      .replace(/\s+/g, " ")
      .trim();
    return normalized === "apericena" || normalized.includes("apericena");
  }

  function formatPrecontoApericenaLabel(value) {
    const raw = normalizePrecontoInlineSupplementLabel(value);
    const normalized = raw.toLocaleLowerCase("it-IT").replace(/\s+/g, " ").trim();
    if (!normalized.includes("apericena")) return raw;
    return normalized.includes("prenotazione") ? "Apericena Prenotazione" : "Menu Apericena";
  }

  function parsePrecontoLooseMoneyValue(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    let normalized = raw.replace(/[^\d,.-]/g, "");
    if (!normalized) return null;
    const commaCount = (normalized.match(/,/g) || []).length;
    const dotCount = (normalized.match(/\./g) || []).length;
    if (commaCount > 0 && dotCount > 0) {
      if (normalized.lastIndexOf(",") > normalized.lastIndexOf(".")) {
        normalized = normalized.replace(/\./g, "").replace(",", ".");
      } else {
        normalized = normalized.replace(/,/g, "");
      }
    } else if (commaCount > 0) {
      normalized = commaCount === 1 ? normalized.replace(",", ".") : normalized.replace(/,/g, "");
    } else if (dotCount > 1) {
      const lastDotIndex = normalized.lastIndexOf(".");
      normalized = `${normalized.slice(0, lastDotIndex).replace(/\./g, "")}.${normalized.slice(lastDotIndex + 1)}`;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? roundMoney(Math.abs(parsed)) : null;
  }

  function extractPrecontoSupplementUnitValue(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const patterns = [
      /\(\s*\+\s*([\d.,]+)\s*(?:eur|\u20ac)?\s*\)\s*$/i,
      /\+\s*([\d.,]+)\s*(?:eur|\u20ac)?\s*$/i,
    ];
    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (!match) continue;
      const parsed = parsePrecontoLooseMoneyValue(match[1]);
      if (parsed !== null && parsed > 0) {
        return parsed;
      }
    }
    return null;
  }

  function extractPrecontoSupplementTargetUnitValue(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const normalized = normalizePrecontoInlineSupplementLabel(raw);
    if (!normalized) return null;
    const patterns = [
      /^([\d.,]+)\s*(?:eur|\u20ac|euro)?$/i,
      /\bda\s*([\d.,]+)\s*(?:eur|\u20ac|euro)?$/i,
      /(?:^|[\s:])([\d.,]+)\s*(?:eur|\u20ac|euro)?$/i,
    ];
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (!match) continue;
      const parsed = parsePrecontoLooseMoneyValue(match[1]);
      if (parsed !== null && parsed > 0) {
        return parsed;
      }
    }
    return null;
  }

  function stripPrecontoSupplementUnitSuffix(value) {
    return String(value ?? "")
      .replace(/\s*\(\s*\+\s*[\d.,]+\s*(?:eur|\u20ac|euro)?(?:\s+importo)?\s*\)\s*$/i, "")
      .replace(/\s*\+\s*[\d.,]+\s*(?:eur|\u20ac|euro)?(?:\s+importo)?\s*$/i, "")
      .replace(/\s+[\d.,]+\s*(?:eur|\u20ac|euro)?(?:\s+importo)?\s*$/i, "")
      .replace(/\s+(?:eur|\u20ac|euro|importo)\s*$/i, "")
      .replace(/\s*\(\s*\)\s*$/i, "")
      .trim();
  }

  function extractPrecontoEntryNameUnitHintValue(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const match = raw.match(/(?:^|[\s(])(\d{1,4}(?:[.,]\d{1,2})?)\s*$/);
    if (!match) return null;
    const parsed = parsePrecontoLooseMoneyValue(match[1]);
    return parsed !== null && parsed > 0 ? parsed : null;
  }

  function shouldKeepPrecontoSupplementLabel(value, allowPlain = false) {
    const raw = String(value ?? "").trim();
    if (!raw) return false;
    if (allowPlain) return true;
    return /(?:\+\s*\d[\d.,]*\s*(?:eur|\u20ac)?|\bmenu\b|\bapericena\b|\bsupplement\w*\b|\bextra\b|\baggiunt\w*\b)/i.test(raw);
  }

  function splitPrecontoSupplementSegments(value) {
    return String(value ?? "")
      .split(/(?:[|\n]+|\s+\/\s+)/)
      .map((entry) => normalizePrecontoInlineSupplementLabel(entry))
      .filter(Boolean);
  }

  function buildPrecontoSupplementEntry(value, allowPlain = false) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    if (!shouldKeepPrecontoSupplementLabel(raw, allowPlain)) return null;
    const rawUnitValue = extractPrecontoSupplementUnitValue(raw);
    const rawTargetUnitValue = extractPrecontoSupplementTargetUnitValue(raw);
    const strippedLabel = stripPrecontoSupplementUnitSuffix(normalizePrecontoInlineSupplementLabel(raw));
    const label = isPrecontoApericenaLabel(strippedLabel)
      ? formatPrecontoApericenaLabel(strippedLabel)
      : strippedLabel;
    if (!label) return null;
    return {
      label,
      rawLabel: raw,
      unitValue: rawUnitValue,
      targetUnitValue: rawTargetUnitValue,
    };
  }

  function resolvePrecontoApericenaSupplementUnitValue(entry, supplement = null) {
    const explicitSupplementValue = roundMoney(Math.max(Number(supplement?.unitValue) || 0, 0));
    if (explicitSupplementValue > 0) {
      return explicitSupplementValue;
    }

    const listUnitValue = roundMoney(Math.max(Number(entry?.listUnitValue) || 0, 0));
    const unitValue = roundMoney(Math.max(Number(entry?.unitValue) || 0, 0));
    const qtyValue = Math.max(1, Math.trunc(Number(entry?.qtyValue) || 1));
    const nameUnitHintValue = roundMoney(
      Math.max(
        extractPrecontoEntryNameUnitHintValue(entry?.name) ||
          extractPrecontoEntryNameUnitHintValue(entry?.productNameSnapshot) ||
          0,
        0
      )
    );
    const totalUnitValue =
      unitValue > 0
        ? unitValue
        : roundMoney(Math.max(Number(entry?.totalValue) || 0, 0) / qtyValue);
    const baseReferenceValue =
      listUnitValue > 0
        ? listUnitValue
        : nameUnitHintValue > 0
          ? nameUnitHintValue
          : totalUnitValue > 0
            ? totalUnitValue
            : 0;
    const targetUnitValue = roundMoney(Math.max(Number(supplement?.targetUnitValue) || 0, 0));
    if (targetUnitValue > 0) {
      if (baseReferenceValue > 0) {
        const derivedSupplementValue = roundMoney(targetUnitValue - baseReferenceValue);
        if (derivedSupplementValue > 0) {
          return derivedSupplementValue;
        }
      }
      return targetUnitValue;
    }
    if (listUnitValue > 0 && unitValue > listUnitValue) {
      return roundMoney(unitValue - listUnitValue);
    }
    if (baseReferenceValue <= 0) {
      return apericenaStandardTargetPrice;
    }
    return roundMoney(Math.max(apericenaStandardTargetPrice - baseReferenceValue, 0));
  }

  function extractPrecontoSupplementEntries(values) {
    const sourceValues = Array.isArray(values) ? values : [values];
    const entries = [];
    sourceValues.forEach((value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return;
      const hasVariantPrefix = /^(?:variante|varianti|supplemento|supplementi|extra|aggiunta|aggiunte)\b\s*:?/i.test(raw);
      splitPrecontoSupplementSegments(raw).forEach((segment) => {
        const entry = buildPrecontoSupplementEntry(segment, hasVariantPrefix);
        if (!entry) return;
        entries.push(entry);
      });
    });
    const seen = new Set();
    return entries.filter((entry) => {
      const key = `${entry.label.toLowerCase()}|${entry.unitValue === null ? "" : entry.unitValue}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function getPrecontoEntrySupplementEntries(entry) {
    const rawSupplements = Array.isArray(entry?.supplements)
      ? entry.supplements
      : Array.isArray(entry?.descriptions)
        ? entry.descriptions
        : [];
    const supplementEntries = extractPrecontoSupplementEntries(rawSupplements).map((supplement) =>
      isPrecontoApericenaLabel(supplement?.label)
        ? {
            ...supplement,
            label: formatPrecontoApericenaLabel(supplement?.label),
            unitValue: resolvePrecontoApericenaSupplementUnitValue(entry, supplement),
          }
        : supplement
    );
    const unitValue = roundMoney(Math.max(Number(entry?.unitValue) || 0, 0));
    const listUnitValue = roundMoney(Math.max(Number(entry?.listUnitValue) || 0, 0));
    const pricedTotal = roundMoney(
      supplementEntries.reduce((sum, supplement) => sum + Math.max(Number(supplement?.unitValue) || 0, 0), 0)
    );
    const unpricedEntries = supplementEntries.filter((supplement) => !(Number(supplement?.unitValue) > 0));
    const baseReferenceValue = listUnitValue > 0 ? listUnitValue : unitValue > 0 ? unitValue : 0;
    if (unpricedEntries.length === 1 && baseReferenceValue > 0) {
      const targetUnitValue = extractPrecontoSupplementTargetUnitValue(unpricedEntries[0]?.label);
      const hintedSupplementValue =
        targetUnitValue !== null ? roundMoney(targetUnitValue - baseReferenceValue - pricedTotal) : 0;
      if (hintedSupplementValue > 0 && hintedSupplementValue <= Math.max(20, roundMoney(baseReferenceValue * 2))) {
        return supplementEntries.map((supplement) =>
          supplement === unpricedEntries[0]
            ? {
                ...supplement,
                unitValue: hintedSupplementValue,
              }
            : supplement
        );
      }
    }
    if (unpricedEntries.length === 1 && listUnitValue > 0 && listUnitValue < unitValue) {
      const remainingValue = roundMoney(unitValue - listUnitValue - pricedTotal);
      if (remainingValue > 0) {
        return supplementEntries.map((supplement) =>
          supplement === unpricedEntries[0]
            ? {
                ...supplement,
                unitValue: remainingValue,
              }
            : supplement
        );
      }
    }
    return supplementEntries;
  }

  return {
    buildPrecontoSupplementEntry,
    extractPrecontoEntryNameUnitHintValue,
    extractPrecontoSupplementEntries,
    extractPrecontoSupplementTargetUnitValue,
    extractPrecontoSupplementUnitValue,
    formatPrecontoApericenaLabel,
    getPrecontoEntrySupplementEntries,
    isPrecontoApericenaLabel,
    normalizePrecontoInlineSupplementLabel,
    parsePrecontoLooseMoneyValue,
    resolvePrecontoApericenaSupplementUnitValue,
    shouldKeepPrecontoSupplementLabel,
    splitPrecontoSupplementSegments,
    stripPrecontoSupplementUnitSuffix,
  };
}
