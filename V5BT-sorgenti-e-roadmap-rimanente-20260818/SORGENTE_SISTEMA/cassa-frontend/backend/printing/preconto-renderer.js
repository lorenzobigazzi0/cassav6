export function createPrecontoRenderer(dependencies = {}) {
  const {
    APERICENA_STANDARD_TARGET_PRICE,
    DEFAULT_POS_SETTINGS,
    buildIntegrationOrderLineSnapshots,
    buildIntegrationPrecontoBrandingFooter,
    buildIntegrationPrecontoBrandingHeader,
    buildIntegrationPrecontoColumnLayout,
    buildIntegrationPrecontoItemLines,
    buildPrecontoLocationLabel,
    buildPrecontoReferenceLabel,
    buildPrintTwoColumnLines,
    centerPrintText,
    extractIntegrationPrintVariantLabel,
    formatIntegrationPrintDateTime,
    formatPrintAmountLine,
    formatPrintMoney,
    getPrecontoEntrySupplementEntries,
    isPrecontoApericenaLabel,
    makePrintSeparator,
    padPrintRight,
    resolvePrecontoEntryBaseUnitValue,
    resolvePrecontoEntryDisplayTotalValue,
    resolvePrintRoomLabel,
    resolvePrintTableDisplayLabelFromOrder,
    roundMoney,
    sanitizeIntegrationOrder,
    sanitizePosPrintPreferences,
    styleEscPosPrintLine,
    wrapPrintText,
  } = dependencies;

function buildIntegrationPrecontoModel(order, settings = null) {
  const safeOrder = sanitizeIntegrationOrder(
    order,
    String(order?.id ?? "preconto").trim() || "preconto",
  );
  const lineSnapshots = [
    ...buildIntegrationOrderLineSnapshots(safeOrder).values(),
  ];
  const apericenaQty = Math.max(
    Math.trunc(Number(safeOrder?.apericena) || 0),
    0,
  );
  const apericenaUnitValue = APERICENA_STANDARD_TARGET_PRICE;
  let lines = lineSnapshots.map((line) => {
    const qty = Math.max(1, Math.trunc(Number(line?.qty) || 1));
    const explicitUnitValue = roundMoney(
      line?.priceOverrideApplied === true
        ? Number(line?.unitPriceApplied) || 0
        : Number(line?.unitPriceApplied) || Number(line?.listPriceAtTime) || 0,
    );
    const explicitListUnitValue = roundMoney(
      Number(line?.listPriceAtTime) || 0,
    );
    const explicitTotalValue = roundMoney(Number(line?.lineTotal) || 0);
    const totalValue =
      explicitTotalValue > 0
        ? explicitTotalValue
        : roundMoney(explicitUnitValue * qty);
    const unitValue =
      explicitUnitValue > 0 ? explicitUnitValue : roundMoney(totalValue / qty);
    const supplements = [];
    const variantLabel = extractIntegrationPrintVariantLabel(line?.variants);
    if (variantLabel) {
      supplements.push(`Variante: ${variantLabel}`);
    }
    const notes = String(line?.notes ?? "").trim();
    if (notes) {
      supplements.push(`Note: ${notes}`);
    }
    return {
      name:
        String(line?.productNameSnapshot ?? "Articolo").trim() || "Articolo",
      qty: `${qty}x`,
      qtyValue: qty,
      totalValue,
      unitValue,
      listUnitValue: explicitListUnitValue,
      supplements,
      descriptions: [],
    };
  });
  const hasInlineApericenaSupplement = lines.some((entry) =>
    getPrecontoEntrySupplementEntries(entry).some((supplement) =>
      isPrecontoApericenaLabel(supplement?.label),
    ),
  );
  if (apericenaQty > 0 && !hasInlineApericenaSupplement) {
    lines.push({
      name: "Menu Apericena",
      qty: String(apericenaQty),
      qtyValue: apericenaQty,
      totalValue: roundMoney(apericenaUnitValue * apericenaQty),
      unitValue: apericenaUnitValue,
      listUnitValue: apericenaUnitValue,
      supplements: [],
      descriptions: [],
    });
  }
  lines = lines.map((entry) => {
    const supplementEntries = getPrecontoEntrySupplementEntries(entry);
    if (supplementEntries.length === 0) {
      return entry;
    }
    const baseUnitValue = resolvePrecontoEntryBaseUnitValue(
      entry,
      supplementEntries,
    );
    return {
      ...entry,
      totalValue: resolvePrecontoEntryDisplayTotalValue(
        entry,
        supplementEntries,
        baseUnitValue,
      ),
    };
  });
  let computedTotal = roundMoney(
    lines.reduce(
      (sum, entry) => sum + roundMoney(Number(entry?.totalValue) || 0),
      0,
    ),
  );
  const orderTotal = roundMoney(
    Number(safeOrder.total) > 0 ? Number(safeOrder.total) : 0,
  );
  if (
    orderTotal > computedTotal &&
    lines.some((entry) => Number(entry?.totalValue) <= 0)
  ) {
    const remainingTotal = roundMoney(orderTotal - computedTotal);
    const missingQtyTotal = lines
      .filter((entry) => Number(entry?.totalValue) <= 0)
      .reduce(
        (sum, entry) => sum + Math.max(Number(entry?.qtyValue) || 1, 1),
        0,
      );
    if (remainingTotal > 0 && missingQtyTotal > 0) {
      lines = lines.map((entry) => {
        if (Number(entry?.totalValue) > 0) return entry;
        const qty = Math.max(Number(entry?.qtyValue) || 1, 1);
        const totalValue = roundMoney((remainingTotal * qty) / missingQtyTotal);
        return {
          ...entry,
          totalValue,
          unitValue: roundMoney(totalValue / qty),
        };
      });
      computedTotal = roundMoney(
        lines.reduce(
          (sum, entry) => sum + roundMoney(Number(entry?.totalValue) || 0),
          0,
        ),
      );
    }
  }
  const hasResolvedApericenaSupplement = lines.some((entry) =>
    getPrecontoEntrySupplementEntries(entry).some((supplement) =>
      isPrecontoApericenaLabel(supplement?.label),
    ),
  );
  const total = hasResolvedApericenaSupplement
    ? computedTotal > 0
      ? computedTotal
      : orderTotal
    : orderTotal > 0
      ? Math.max(orderTotal, computedTotal)
      : computedTotal;
  const roomLabel = resolvePrintRoomLabel(
    settings,
    safeOrder.roomId,
    safeOrder.roomName ||
      safeOrder.station ||
      safeOrder.ownerStation ||
      "BANCO",
  );
  const tableDisplayLabel = resolvePrintTableDisplayLabelFromOrder(safeOrder);
  return {
    referenceLabel: buildPrecontoReferenceLabel(safeOrder.id),
    locationLabel: buildPrecontoLocationLabel(tableDisplayLabel, roomLabel),
    printTimestampLabel: formatIntegrationPrintDateTime(Date.now()),
    total,
    groups: [
      {
        title: "",
        subtotalText: formatPrintMoney(total),
        subtotalValue: total,
        lines,
      },
    ],
  };
}

function getIntegrationPrecontoEffectiveWidth(rawWidth) {
  const totalWidth = Math.max(32, Math.trunc(Number(rawWidth) || 48));
  return Math.max(16, Math.floor(totalWidth / 2));
}

function getIntegrationCashPrecontoEffectiveWidth(rawWidth) {
  const configuredWidth = Math.max(32, Math.trunc(Number(rawWidth) || 48));
  return Math.max(44, Math.min(44, configuredWidth));
}

function buildIntegrationPrecontoPrintText(
  order,
  rawPreferences = null,
  settings = null,
) {
  return buildIntegrationPrecontoPrintTextWithOptions(
    order,
    rawPreferences,
    settings,
    {},
  );
}

function normalizePrecontoPaymentSummary(value) {
  if (!value || typeof value !== "object") return null;
  const paidAmount = roundMoney(Math.max(Number(value.paidAmount) || 0, 0));
  const dueAmount = roundMoney(Math.max(Number(value.dueAmount) || 0, 0));
  if (paidAmount <= 0.009 && dueAmount <= 0.009) return null;
  return { paidAmount, dueAmount };
}

function appendPrecontoPaymentSummaryLines(
  lines,
  width,
  summary,
  pushLine = null,
) {
  const safeSummary = normalizePrecontoPaymentSummary(summary);
  if (!safeSummary || safeSummary.paidAmount <= 0.009) return;
  const emit =
    typeof pushLine === "function" ? pushLine : (value) => lines.push(value);
  emit("");
  emit(
    formatPrintAmountLine(
      "GIA' PAGATO",
      formatPrintMoney(safeSummary.paidAmount),
      width,
    ),
  );
  emit(
    formatPrintAmountLine(
      "RIMANENZA",
      formatPrintMoney(safeSummary.dueAmount),
      width,
    ),
  );
}

function buildIntegrationCashPrecontoPrintText(
  order,
  rawPreferences = null,
  settings = null,
) {
  return buildIntegrationCashPrecontoPrintTextWithOptions(
    order,
    rawPreferences,
    settings,
    {},
  );
}

function buildIntegrationCashPrecontoPrintTextWithOptions(
  order,
  rawPreferences = null,
  settings = null,
  options = {},
) {
  const preferences = sanitizePosPrintPreferences(
    rawPreferences ?? DEFAULT_POS_SETTINGS.printPreferences,
  );
  const model = buildIntegrationPrecontoModel(order, settings);
  const width = getIntegrationCashPrecontoEffectiveWidth(
    preferences.preconto.lineWidth,
  );
  const layout = buildIntegrationPrecontoColumnLayout(width, model);
  const lines = [];
  const pushCashLine = (value, options = { charSpacing: 1 }) => {
    if (!value) {
      lines.push("");
      return;
    }
    lines.push(styleEscPosPrintLine(value, options));
  };
  const pushCashLines = (values, options = { charSpacing: 1 }) => {
    (Array.isArray(values) ? values : [values]).forEach((value) => {
      pushCashLine(value, options);
    });
  };

  pushCashLine("PRECONTO", {
    align: "center",
    bold: true,
    widthScale: 1,
    heightScale: 1,
    charSpacing: 1,
  });

  const headerLines = buildPrintTwoColumnLines(
    model.locationLabel,
    model.referenceLabel,
    width,
  );
  if (headerLines.length > 0) {
    lines.push("");
    pushCashLines(headerLines);
  }
  lines.push("");
  pushCashLine(makePrintSeparator(width));
  lines.push("");

  model.groups.forEach((group, index) => {
    if (index > 0) {
      lines.push("");
    }
    pushCashLine(
      [
        padPrintRight("QTA", layout.qtyWidth),
        padPrintRight("ARTICOLO", layout.nameWidth),
        padPrintRight("P.U.", layout.unitWidth),
        "TOT.".padStart(layout.subtotalWidth),
      ]
        .join(" ")
        .trimEnd(),
      { charSpacing: 1, bold: true },
    );
    (Array.isArray(group?.lines) ? group.lines : []).forEach((entry) => {
      pushCashLines(buildIntegrationPrecontoItemLines(entry, layout));
    });
  });

  lines.push("");
  pushCashLine(makePrintSeparator(width));
  lines.push("");
  pushCashLine(
    formatPrintAmountLine("TOTALE", formatPrintMoney(model.total), width),
    {
      bold: true,
      heightScale: 1,
      charSpacing: 1,
    },
  );
  appendPrecontoPaymentSummaryLines(
    lines,
    width,
    options?.paymentSummary,
    (value) => pushCashLine(value, { charSpacing: 1 }),
  );
  pushCashLine(centerPrintText(model.printTimestampLabel, width));

  if (preferences.preconto.showDocumentLabel) {
    lines.push("");
    wrapPrintText("Richiedere lo scontrino fiscale alla cassa", width).forEach(
      (entry) => {
        pushCashLine(centerPrintText(entry, width));
      },
    );
  }

  return `${lines.join("\n")}\n`;
}

function buildIntegrationPrecontoPrintTextWithOptions(
  order,
  rawPreferences = null,
  settings = null,
  options = {},
) {
  const profile = String(options?.profile ?? "")
    .trim()
    .toLowerCase();
  if (profile === "cash") {
    return buildIntegrationCashPrecontoPrintTextWithOptions(
      order,
      rawPreferences,
      settings,
      options,
    );
  }

  const preferences = sanitizePosPrintPreferences(
    rawPreferences ?? DEFAULT_POS_SETTINGS.printPreferences,
  );
  const model = buildIntegrationPrecontoModel(order, settings);
  const width = getIntegrationPrecontoEffectiveWidth(
    preferences.preconto.lineWidth,
  );
  const layout = buildIntegrationPrecontoColumnLayout(width, model);
  const lines = [];

  buildIntegrationPrecontoBrandingHeader(preferences, width).forEach(
    (entry) => {
      lines.push(entry);
    },
  );
  if (lines.length > 0) {
    lines.push("");
  }

  lines.push(centerPrintText("PRECONTO", width));
  const headerLines = buildPrintTwoColumnLines(
    model.locationLabel,
    model.referenceLabel,
    width,
  );
  if (headerLines.length > 0) {
    lines.push("");
    lines.push(...headerLines);
  }
  lines.push("", makePrintSeparator(width));

  model.groups.forEach((group, index) => {
    if (index > 0) {
      lines.push("");
    }
    lines.push(
      [
        padPrintRight("QTA", layout.qtyWidth),
        padPrintRight("ARTICOLO", layout.nameWidth),
        padPrintRight("P.U.", layout.unitWidth),
        "TOT.".padStart(layout.subtotalWidth),
      ]
        .join(" ")
        .trimEnd(),
    );
    (Array.isArray(group?.lines) ? group.lines : []).forEach((entry) => {
      buildIntegrationPrecontoItemLines(entry, layout).forEach((line) => {
        lines.push(line);
      });
    });
  });

  lines.push(makePrintSeparator(width));
  lines.push(
    formatPrintAmountLine("TOTALE", formatPrintMoney(model.total), width),
  );
  appendPrecontoPaymentSummaryLines(lines, width, options?.paymentSummary);
  lines.push(centerPrintText(model.printTimestampLabel, width));

  const footerLines = buildIntegrationPrecontoBrandingFooter(
    preferences,
    width,
  );
  if (footerLines.length > 0) {
    lines.push("");
    footerLines.forEach((entry) => {
      lines.push(entry);
    });
  }

  if (preferences.preconto.showDocumentLabel) {
    lines.push("");
    wrapPrintText("Richiedere lo scontrino fiscale alla cassa", width).forEach(
      (entry) => {
        lines.push(centerPrintText(entry, width));
      },
    );
  }

  return `${lines.join("\n")}\n`;
}

  return {
    appendPrecontoPaymentSummaryLines,
    buildIntegrationCashPrecontoPrintText,
    buildIntegrationCashPrecontoPrintTextWithOptions,
    buildIntegrationPrecontoModel,
    buildIntegrationPrecontoPrintText,
    buildIntegrationPrecontoPrintTextWithOptions,
    getIntegrationCashPrecontoEffectiveWidth,
    getIntegrationPrecontoEffectiveWidth,
    normalizePrecontoPaymentSummary,
  };
}

