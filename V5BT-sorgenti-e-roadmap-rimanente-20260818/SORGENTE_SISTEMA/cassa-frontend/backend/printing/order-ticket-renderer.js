export function createOrderTicketRenderer(dependencies = {}) {
  const {
    PRIMARY_INTEGRATION_STATION,
    buildCorrectionPrintAnnotations,
    buildEscPosRasterStrikeMarker,
    buildIntegrationOrderLineSnapshots,
    buildPrintLabelLines,
    buildPrintLocationLabel,
    buildPrintTwoColumnLines,
    cleanIntegrationOrderSupplementLabelForPrint,
    cleanIntegrationOrderVariantLabelForPrint,
    extractIntegrationPrintVariantLabel,
    formatIntegrationPrintDateTime,
    formatIntegrationPrintDisplayName,
    formatIntegrationPrintOrderId,
    formatIntegrationWaiterShortLabel,
    isIntegrationSupplementText,
    normalizeIntegrationStationName,
    rasterStrikePrintableColumns,
    resolvePrintRoomLabel,
    resolvePrintTableDisplayLabelFromOrder,
    sanitizeIntegrationOrder,
    sanitizePosPrintPreferences,
    styleEscPosPrintLines,
    toPrintSafeUppercase,
    wrapPrintText,
  } = dependencies;

function buildIntegrationOrderPrintText(
  order,
  stationRaw = "",
  printPreferences = null,
  settings = null,
  options = {},
) {
  const safeOrder = sanitizeIntegrationOrder(
    order,
    String(order?.id ?? "order").trim() || "order",
  );
  const orderPreferences = sanitizePosPrintPreferences({
    order: printPreferences,
  }).order;
  const title = String(options?.title ?? "COMANDA").trim() || "COMANDA";
  const station = normalizeIntegrationStationName(
    stationRaw ||
      safeOrder.ownerStation ||
      safeOrder.station ||
      PRIMARY_INTEGRATION_STATION,
  );
  const apericenaQty = Math.max(
    Math.trunc(Number(safeOrder?.apericena) || 0),
    0,
  );
  const width = Math.max(48, orderPreferences.lineWidth);
  const headerLineStyle = { widthScale: 0, heightScale: 1, bold: true };
  const tableLineStyle = {
    align: "center",
    widthScale: 1,
    heightScale: 1,
    bold: true,
  };
  const orderLineStyle = {
    widthScale: 1,
    heightScale: 1,
    bold: true,
    charSpacing: 1,
  };
  const removedOrderLineStyle = {
    ...orderLineStyle,
    underline: false,
    italic: false,
  };
  const noteLineStyle = { widthScale: 0, heightScale: 1, bold: true };
  const communicationsLabelStyle = {
    widthScale: 0,
    heightScale: 1,
    bold: true,
  };
  const communicationsValueStyle = {
    widthScale: 0,
    heightScale: 1,
    italic: true,
  };
  const titleLineStyle = {
    align: "center",
    bold: true,
    widthScale: 2,
    heightScale: 2,
    ...(options?.titleStyle && typeof options.titleStyle === "object"
      ? options.titleStyle
      : {}),
  };
  const separatorLine = "-".repeat(Math.max(16, width));
  const articleWrapWidth = Math.max(
    10,
    Math.floor((width / ((orderLineStyle.widthScale ?? 0) + 1)) * 0.92),
  );
  const removedLineRasterScale = 4.4;
  const removedLineWrapWidth = Math.min(
    articleWrapWidth,
    rasterStrikePrintableColumns(width, removedLineRasterScale),
  );
  const lineSnapshots = [
    ...buildIntegrationOrderLineSnapshots(safeOrder).values(),
  ];
  const correctionAnnotations = buildCorrectionPrintAnnotations(
    options?.correctionRecord,
  );
  const printableLines = [
    ...lineSnapshots.map((line) => ({
      ...line,
      correctionStatus: correctionAnnotations.addedByLineId.has(
        String(line?.lineId ?? "").trim(),
      )
        ? "added"
        : correctionAnnotations.changedByLineId.has(
              String(line?.lineId ?? "").trim(),
            )
          ? "changed"
          : "",
      correctionChange:
        correctionAnnotations.changedByLineId.get(
          String(line?.lineId ?? "").trim(),
        ) ?? null,
    })),
    ...correctionAnnotations.removedLines,
  ];
  const roomName = resolvePrintRoomLabel(
    settings,
    safeOrder.roomId,
    safeOrder.roomName || station,
  );
  const tableDisplayLabel = resolvePrintTableDisplayLabelFromOrder(safeOrder);
  const stationLabel = orderPreferences.showStation
    ? toPrintSafeUppercase(
        formatIntegrationPrintDisplayName(station || roomName || "POSTAZIONE"),
      ) || "POSTAZIONE"
    : "";
  const orderIdLabel = orderPreferences.showOrderId
    ? formatIntegrationPrintOrderId(safeOrder.id)
    : "";
  const waiterLabel = formatIntegrationWaiterShortLabel(safeOrder.waiter);
  const tableLabel = orderPreferences.showTable
    ? buildPrintLocationLabel({
        tableLabel: tableDisplayLabel,
        roomLabel: roomName,
      })
    : "";
  const lines = [
    ...styleEscPosPrintLines(toPrintSafeUppercase(title), titleLineStyle),
    "",
  ];

  const topHeaderLines = buildPrintTwoColumnLines(
    stationLabel,
    orderIdLabel,
    width,
  );
  if (topHeaderLines.length > 0) {
    lines.push(...styleEscPosPrintLines(topHeaderLines, headerLineStyle));
  }

  const waiterDateLines = buildPrintTwoColumnLines(
    orderPreferences.showWaiter ? waiterLabel : "",
    orderPreferences.showTime
      ? formatIntegrationPrintDateTime(safeOrder.receivedAtMs)
      : "",
    width,
  );
  if (waiterDateLines.length > 0) {
    lines.push(...styleEscPosPrintLines(waiterDateLines, headerLineStyle));
  }

  lines.push("", ...styleEscPosPrintLines(separatorLine, headerLineStyle));

  if (tableLabel) {
    lines.push(...styleEscPosPrintLines(tableLabel, tableLineStyle));
    lines.push(...styleEscPosPrintLines(separatorLine, headerLineStyle));
  }

  lines.push("");

  if (printableLines.length === 0) {
    lines.push(
      ...styleEscPosPrintLines(
        "NESSUNA RIGA ASSEGNATA A QUESTA POSTAZIONE",
        orderLineStyle,
      ),
    );
  } else {
    printableLines.forEach((line, lineIndex) => {
      const name = toPrintSafeUppercase(
        String(line?.productNameSnapshot ?? "Articolo").trim() || "Articolo",
      );
      const qty = Math.max(1, Math.trunc(Number(line?.qty) || 1));
      const status = String(line?.correctionStatus ?? "").trim();
      const change =
        line?.correctionChange && typeof line.correctionChange === "object"
          ? line.correctionChange
          : null;
      const previousQuantity = Math.max(
        1,
        Math.trunc(Number(change?.previousQuantity) || qty),
      );
      const nextQuantity = Math.max(
        1,
        Math.trunc(Number(change?.nextQuantity) || qty),
      );
      const variantLabel = toPrintSafeUppercase(
        cleanIntegrationOrderVariantLabelForPrint(
          extractIntegrationPrintVariantLabel(line?.variants),
        ),
      );
      const qtyLabel =
        status === "changed" && previousQuantity !== nextQuantity
          ? `${previousQuantity} -> ${nextQuantity}`
          : `${qty}`;
      const effectiveArticleWrapWidth =
        status === "removed"
          ? Math.max(10, removedLineWrapWidth)
          : articleWrapWidth;
      const nameWidth = Math.max(
        4,
        effectiveArticleWrapWidth - qtyLabel.length - 1,
      );
      const wrappedName = wrapPrintText(name, nameWidth);
      const lineStyle =
        status === "removed" ? removedOrderLineStyle : orderLineStyle;
      if (wrappedName.length > 0) {
        const firstLine = `${qtyLabel} ${wrappedName[0]}`.trimEnd();
        lines.push(
          status === "removed"
            ? buildEscPosRasterStrikeMarker(firstLine, {
                scale: removedLineRasterScale,
              })
            : styleEscPosPrintLines(firstLine, lineStyle)[0],
        );
        wrappedName.slice(1).forEach((entry) => {
          const continuationLine =
            `${" ".repeat(qtyLabel.length + 1)}${entry}`.trimEnd();
          lines.push(
            status === "removed"
              ? buildEscPosRasterStrikeMarker(continuationLine, {
                  scale: removedLineRasterScale,
                })
              : styleEscPosPrintLines(continuationLine, lineStyle)[0],
          );
        });
      } else {
        const fallbackLine = `${qtyLabel} ${name}`;
        lines.push(
          status === "removed"
            ? buildEscPosRasterStrikeMarker(fallbackLine, {
                scale: removedLineRasterScale,
              })
            : styleEscPosPrintLines(fallbackLine, lineStyle)[0],
        );
      }
      if (
        status !== "removed" &&
        orderPreferences.showVariants &&
        variantLabel
      ) {
        lines.push(
          ...styleEscPosPrintLines(
            buildPrintLabelLines("VARIANTE", variantLabel, width),
            noteLineStyle,
          ),
        );
      }
      const notes = toPrintSafeUppercase(String(line?.notes ?? "").trim());
      if (status !== "removed" && orderPreferences.showLineNotes && notes) {
        const rawNotes = String(line?.notes ?? "").trim();
        if (isIntegrationSupplementText(rawNotes)) {
          const cleanedSupplementNote = toPrintSafeUppercase(
            cleanIntegrationOrderSupplementLabelForPrint(rawNotes) || rawNotes,
          );
          lines.push(
            ...styleEscPosPrintLines(
              wrapPrintText(cleanedSupplementNote, width),
              noteLineStyle,
            ),
          );
        } else {
          lines.push(
            ...styleEscPosPrintLines(
              buildPrintLabelLines("NOTE", notes, width),
              noteLineStyle,
            ),
          );
        }
      }
      if (lineIndex < printableLines.length - 1) {
        lines.push("");
      }
    });
  }

  const trailingNotes = [];
  if (orderPreferences.showCommunications && safeOrder.communications) {
    trailingNotes.push(
      ...styleEscPosPrintLines("COMUNICAZIONI:", communicationsLabelStyle),
      ...styleEscPosPrintLines(
        wrapPrintText(
          toPrintSafeUppercase(String(safeOrder.communications).trim()),
          width,
        ),
        communicationsValueStyle,
      ),
    );
  }
  if (orderPreferences.showOrderNotes && safeOrder.note) {
    trailingNotes.push(
      ...styleEscPosPrintLines("NOTE:", communicationsLabelStyle),
      ...styleEscPosPrintLines(
        wrapPrintText(
          toPrintSafeUppercase(String(safeOrder.note).trim()),
          width,
        ),
        noteLineStyle,
      ),
    );
  }
  if (apericenaQty > 0) {
    lines.push(
      "",
      ...styleEscPosPrintLines(separatorLine, headerLineStyle),
      "",
    );
    lines.push(
      ...styleEscPosPrintLines(
        wrapPrintText(`MENU APERICENA: ${apericenaQty}`, width),
        noteLineStyle,
      ),
    );
  }
  if (trailingNotes.length > 0) {
    lines.push(
      "",
      ...styleEscPosPrintLines(separatorLine, headerLineStyle),
      "",
    );
    lines.push(...trailingNotes);
  }
  orderPreferences.extraBottomLines.forEach((entry) => {
    lines.push(
      ...styleEscPosPrintLines(
        wrapPrintText(String(entry), width),
        headerLineStyle,
      ),
    );
  });
  lines.push("");
  return lines.join("\n");
}

  return {
    buildIntegrationOrderPrintText,
  };
}

