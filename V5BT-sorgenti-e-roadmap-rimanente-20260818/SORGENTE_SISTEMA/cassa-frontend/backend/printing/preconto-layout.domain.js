function defaultRoundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function createPrecontoLayoutHelpers(options = {}) {
  const {
    extractPrecontoEntryNameUnitHintValue = () => null,
    formatPrintMoneyCompact = (value) => String(Number(value) || 0),
    getPrecontoEntrySupplementEntries = () => [],
    isPrecontoApericenaLabel = () => false,
    padPrintRight = (value, width) => String(value ?? "").padEnd(Math.max(0, Number(width) || 0)),
    roundMoney = defaultRoundMoney,
    wrapPrintText = (value) => [String(value ?? "").trim()].filter(Boolean),
  } = options;

  function resolvePrecontoEntryDisplayTotalValue(entry, supplementEntries = null, baseUnitValue = null) {
    const resolvedSupplementEntries =
      supplementEntries && Array.isArray(supplementEntries) ? supplementEntries : getPrecontoEntrySupplementEntries(entry);
    const qtyValue = Math.max(1, Math.trunc(Number(entry?.qtyValue) || 1));
    const resolvedBaseUnitValue =
      baseUnitValue !== null && Number.isFinite(Number(baseUnitValue))
        ? roundMoney(Math.max(Number(baseUnitValue) || 0, 0))
        : resolvePrecontoEntryBaseUnitValue(entry, resolvedSupplementEntries);
    const entryTotalValue = roundMoney(Math.max(Number(entry?.totalValue) || 0, 0));
    if (resolvedSupplementEntries.length === 0) {
      return entryTotalValue > 0 ? entryTotalValue : roundMoney(resolvedBaseUnitValue * qtyValue);
    }
    const supplementUnitTotal = roundMoney(
      resolvedSupplementEntries.reduce((sum, supplement) => sum + Math.max(Number(supplement?.unitValue) || 0, 0), 0)
    );
    const computedTotal = roundMoney((resolvedBaseUnitValue + supplementUnitTotal) * qtyValue);
    const hasApericenaSupplement = resolvedSupplementEntries.some((supplement) =>
      isPrecontoApericenaLabel(supplement?.label)
    );
    if (hasApericenaSupplement) {
      return computedTotal > 0 ? computedTotal : entryTotalValue;
    }
    return Math.max(entryTotalValue, computedTotal);
  }

  function resolvePrecontoEntryBaseUnitValue(entry, supplementEntries = null) {
    const unitValue = roundMoney(Math.max(Number(entry?.unitValue) || 0, 0));
    const listUnitValue = roundMoney(Math.max(Number(entry?.listUnitValue) || 0, 0));
    const nameUnitHintValue = roundMoney(
      Math.max(
        extractPrecontoEntryNameUnitHintValue(entry?.name) ||
          extractPrecontoEntryNameUnitHintValue(entry?.productNameSnapshot) ||
          0,
        0
      )
    );
    const resolvedSupplementEntries =
      supplementEntries && Array.isArray(supplementEntries) ? supplementEntries : getPrecontoEntrySupplementEntries(entry);
    if (resolvedSupplementEntries.length === 0) {
      return unitValue > 0 ? unitValue : nameUnitHintValue;
    }
    if (listUnitValue > 0 && (!(unitValue > 0) || listUnitValue <= unitValue)) {
      return listUnitValue;
    }
    if (nameUnitHintValue > 0 && !(unitValue > 0)) {
      return nameUnitHintValue;
    }
    const pricedTotal = roundMoney(
      resolvedSupplementEntries.reduce((sum, supplement) => sum + Math.max(Number(supplement?.unitValue) || 0, 0), 0)
    );
    if (pricedTotal > 0 && pricedTotal <= unitValue) {
      return roundMoney(unitValue - pricedTotal);
    }
    return unitValue;
  }

  function collectPrecontoEntryLayoutUnitValues(entry) {
    const supplementEntries = getPrecontoEntrySupplementEntries(entry);
    const values = [];
    const baseUnitValue = resolvePrecontoEntryBaseUnitValue(entry, supplementEntries);
    if (supplementEntries.length === 0 || baseUnitValue > 0) {
      values.push(baseUnitValue);
    }
    supplementEntries.forEach((supplement) => {
      const value = roundMoney(Math.max(Number(supplement?.unitValue) || 0, 0));
      if (value > 0) {
        values.push(value);
      }
    });
    return values;
  }

  function buildIntegrationPrecontoColumnLayout(width, model) {
    const totalWidth = Math.max(32, Math.trunc(Number(width) || 48));
    const allEntries = Array.isArray(model?.groups)
      ? model.groups.flatMap((group) => (Array.isArray(group?.lines) ? group.lines : []))
      : [];
    const formatPrecontoQtyLabel = (entry) => {
      const rawQty = String(entry?.qty ?? "").trim();
      if (rawQty) {
        const normalized = rawQty.replace(/\s*[xX]\s*$/, "").trim();
        if (normalized) return normalized;
      }
      return String(Math.max(1, Math.trunc(Number(entry?.qtyValue) || 1)));
    };
    const qtyWidth = Math.max(
      3,
      "QTA".length,
      ...allEntries.map((entry) => formatPrecontoQtyLabel(entry).length)
    );
    const unitWidth = Math.max(
      7,
      "P.U.".length,
      ...allEntries.flatMap((entry) =>
        collectPrecontoEntryLayoutUnitValues(entry).map((value) => formatPrintMoneyCompact(value).length)
      )
    );
    const subtotalWidth = Math.max(
      7,
      "TOT.".length,
      ...allEntries.map((entry) =>
        formatPrintMoneyCompact(resolvePrecontoEntryDisplayTotalValue(entry)).length
      )
    );
    const gapWidth = 3;
    const nameWidth = Math.max(6, totalWidth - qtyWidth - unitWidth - subtotalWidth - gapWidth);
    return {
      width: totalWidth,
      qtyWidth,
      nameWidth,
      unitWidth,
      subtotalWidth,
    };
  }

  function buildIntegrationPrecontoItemLines(entry, layout) {
    const rawQtyLabel = String(entry?.qty ?? "").trim();
    const qtyLabel =
      rawQtyLabel.replace(/\s*[xX]\s*$/, "").trim() ||
      String(Math.max(1, Math.trunc(Number(entry?.qtyValue) || 1)));
    const displayName = String(entry?.name ?? "").trim() || "Articolo";
    const wrappedName = wrapPrintText(displayName, layout.nameWidth);
    const supplementEntries = getPrecontoEntrySupplementEntries(entry);
    const baseUnitValue = resolvePrecontoEntryBaseUnitValue(entry, supplementEntries);
    const hasSupplements = supplementEntries.length > 0;
    const baseUnitText =
      !hasSupplements || baseUnitValue > 0 ? formatPrintMoneyCompact(baseUnitValue) : "";
    const displayTotalValue = resolvePrecontoEntryDisplayTotalValue(entry, supplementEntries, baseUnitValue);
    const totalText = String(formatPrintMoneyCompact(displayTotalValue)).padStart(layout.subtotalWidth);
    const blankTotalText = " ".repeat(layout.subtotalWidth);
    const firstLine = [
      padPrintRight(qtyLabel, layout.qtyWidth),
      padPrintRight(wrappedName.shift() || displayName, layout.nameWidth),
      padPrintRight(baseUnitText, layout.unitWidth),
      !hasSupplements && wrappedName.length === 0 ? totalText : blankTotalText,
    ].join(" ");
    const lines = [firstLine.trimEnd()];
    wrappedName.forEach((nameLine, index) => {
      const isLastLine = index === wrappedName.length - 1;
      lines.push(
        [
          padPrintRight("", layout.qtyWidth),
          padPrintRight(nameLine, layout.nameWidth),
          padPrintRight("", layout.unitWidth),
          !hasSupplements && isLastLine ? totalText : blankTotalText,
        ].join(" ").trimEnd()
      );
    });
    supplementEntries.forEach((supplement, supplementIndex) => {
      const supplementLabel = String(supplement?.label ?? "").trim();
      if (!supplementLabel) return;
      const wrappedSupplement = wrapPrintText(supplementLabel, layout.nameWidth);
      const supplementUnitValue = roundMoney(Math.max(Number(supplement?.unitValue) || 0, 0));
      const supplementUnitText = supplementUnitValue > 0 ? formatPrintMoneyCompact(supplementUnitValue) : "";
      const firstSupplementLine = wrappedSupplement.shift() || supplementLabel;
      lines.push(
        [
          padPrintRight("", layout.qtyWidth),
          padPrintRight(firstSupplementLine, layout.nameWidth),
          padPrintRight(supplementUnitText, layout.unitWidth),
          supplementIndex === supplementEntries.length - 1 && wrappedSupplement.length === 0 ? totalText : blankTotalText,
        ].join(" ").trimEnd()
      );
      wrappedSupplement.forEach((supplementLine, index) => {
        const isLastSupplementLine = index === wrappedSupplement.length - 1;
        lines.push(
          [
            padPrintRight("", layout.qtyWidth),
            padPrintRight(supplementLine, layout.nameWidth),
            padPrintRight("", layout.unitWidth),
            supplementIndex === supplementEntries.length - 1 && isLastSupplementLine ? totalText : blankTotalText,
          ].join(" ").trimEnd()
        );
      });
    });
    return lines;
  }

  return {
    buildIntegrationPrecontoColumnLayout,
    buildIntegrationPrecontoItemLines,
    collectPrecontoEntryLayoutUnitValues,
    resolvePrecontoEntryBaseUnitValue,
    resolvePrecontoEntryDisplayTotalValue,
  };
}
