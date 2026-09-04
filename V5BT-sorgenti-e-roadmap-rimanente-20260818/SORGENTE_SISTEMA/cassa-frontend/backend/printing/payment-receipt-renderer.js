export function createPaymentReceiptRenderer(dependencies = {}) {
  const {
    buildPrintLabelLines,
    buildPrintLocationLabel,
    buildPrintTwoColumnLines,
    centerPrintText,
    formatIntegrationPrintDateTime,
    formatIntegrationPrintDisplayName,
    formatIntegrationWaiterShortLabel,
    formatPaymentMethodPrintLabel,
    formatPrintMoney,
    formatRefundActionPrintLabel,
    makePrintSeparator,
    normalizePaymentMethodType,
    normalizePaymentPrintNote,
    normalizeStornoPaymentReferences,
    roundMoney,
    sanitizeIntegrationTableLabel,
    sanitizePosPrintPreferences,
    styleEscPosPrintLines,
    toPrintSafeUppercase,
  } = dependencies;

function buildMobileElectronicPaymentPrintText(payment, rawPreferences = null) {
  const orderPreferences = sanitizePosPrintPreferences({
    order: rawPreferences,
  }).order;
  const width = Math.max(48, orderPreferences.lineWidth);
  const separatorLine = makePrintSeparator(width);
  const paymentMethodType = normalizePaymentMethodType(
    payment?.methodType ?? payment?.method,
  );
  const title =
    paymentMethodType === "CASH"
      ? "PAGAMENTO CONTANTI"
      : paymentMethodType === "POS"
        ? "PAGAMENTO ELETTRONICO"
        : "PAGAMENTO";
  const waiterLabel = formatIntegrationWaiterShortLabel(
    String(payment?.waiter ?? "").trim() || "Cameriere",
  );
  const tableNumberRaw = Number(payment?.tableNumber);
  const logicalTableLabel = sanitizeIntegrationTableLabel(
    payment?.tableLabel ?? payment?.logicalTableLabel,
  );
  const roomLabel = toPrintSafeUppercase(
    formatIntegrationPrintDisplayName(
      payment?.roomName ?? payment?.roomLabel ?? "",
    ),
  );
  const tableLabel =
    buildPrintLocationLabel({
      tableLabel: logicalTableLabel,
      tableNumber:
        Number.isFinite(tableNumberRaw) && tableNumberRaw > 0
          ? String(Math.trunc(tableNumberRaw))
          : "-",
      roomLabel,
    }) || "TAV. -";
  const orderReferenceLabel =
    String(payment?.orderReference ?? "").trim() || "COMANDA #-";
  const amount = roundMoney(Math.max(Number(payment?.amount) || 0, 0));
  const cashGiven = roundMoney(Math.max(Number(payment?.cashGiven) || 0, 0));
  const changeGiven = roundMoney(
    Math.max(Number(payment?.changeGiven ?? payment?.change) || 0, 0),
  );
  const paymentNote = normalizePaymentPrintNote(
    payment?.note ?? payment?.paymentNote,
  );
  const transactionId = String(
    payment?.transactionId ?? payment?.txId ?? payment?.id ?? "",
  ).trim();
  const createdAtMsRaw = Number(payment?.createdAtMs);
  const createdAtMs =
    Number.isFinite(createdAtMsRaw) && createdAtMsRaw > 0
      ? createdAtMsRaw
      : Date.now();
  const titleStyle = {
    align: "center",
    bold: true,
    widthScale: 1,
    heightScale: 3,
    charSpacing: 0,
  };
  const metaStyle = { widthScale: 0, heightScale: 1, bold: true };
  const amountStyle = {
    align: "center",
    bold: true,
    widthScale: 2,
    heightScale: 2,
    charSpacing: 0,
  };
  const infoStyle = { widthScale: 0, heightScale: 1 };
  const lines = [...styleEscPosPrintLines(title, titleStyle)];
  const headerLines = buildPrintTwoColumnLines(
    toPrintSafeUppercase(tableLabel),
    toPrintSafeUppercase(orderReferenceLabel),
    width,
  );
  if (headerLines.length > 0) {
    lines.push(...styleEscPosPrintLines(headerLines, metaStyle));
  }
  lines.push(
    ...styleEscPosPrintLines(
      buildPrintLabelLines("CAMERIERE", waiterLabel, width),
      infoStyle,
    ),
  );
  if (transactionId) {
    lines.push(
      ...styleEscPosPrintLines(
        buildPrintLabelLines(
          "ID TX",
          toPrintSafeUppercase(transactionId),
          width,
        ),
        infoStyle,
      ),
    );
  }
  lines.push(...styleEscPosPrintLines(separatorLine, metaStyle));
  lines.push(...styleEscPosPrintLines(formatPrintMoney(amount), amountStyle));
  if (paymentMethodType === "CASH" && cashGiven > 0) {
    lines.push(
      ...styleEscPosPrintLines(
        buildPrintTwoColumnLines(
          `RICEVUTO ${formatPrintMoney(cashGiven)}`,
          `RESTO ${formatPrintMoney(changeGiven)}`,
          width,
        ),
        infoStyle,
      ),
    );
  }
  if (paymentNote) {
    lines.push(...styleEscPosPrintLines(separatorLine, metaStyle));
    lines.push(
      ...styleEscPosPrintLines(
        buildPrintLabelLines("NOTA", toPrintSafeUppercase(paymentNote), width),
        infoStyle,
      ),
    );
  }
  lines.push(
    ...styleEscPosPrintLines(
      centerPrintText(formatIntegrationPrintDateTime(createdAtMs), width),
      infoStyle,
    ),
  );
  lines.push("");
  return lines.join("\n");
}

function buildMobilePaymentStornoPrintText(storno, rawPreferences = null) {
  const orderPreferences = sanitizePosPrintPreferences({
    order: rawPreferences,
  }).order;
  const width = Math.max(48, orderPreferences.lineWidth);
  const separatorLine = makePrintSeparator(width);
  const waiterLabel = formatIntegrationWaiterShortLabel(
    String(storno?.waiter ?? "").trim() || "Cameriere",
  );
  const tableNumberRaw = Number(storno?.tableNumber);
  const logicalTableLabel = sanitizeIntegrationTableLabel(
    storno?.tableLabel ?? storno?.logicalTableLabel,
  );
  const roomLabel = toPrintSafeUppercase(
    formatIntegrationPrintDisplayName(
      storno?.roomName ?? storno?.roomLabel ?? "",
    ),
  );
  const tableLabel =
    buildPrintLocationLabel({
      tableLabel: logicalTableLabel,
      tableNumber:
        Number.isFinite(tableNumberRaw) && tableNumberRaw > 0
          ? String(Math.trunc(tableNumberRaw))
          : "-",
      roomLabel,
    }) || "TAV. -";
  const orderReferenceLabel =
    String(storno?.orderReference ?? "").trim() || "COMANDA #-";
  const amount = roundMoney(Math.max(Number(storno?.amount) || 0, 0));
  const quantity = Math.max(Math.trunc(Number(storno?.quantity) || 0), 1);
  const productName = toPrintSafeUppercase(
    String(storno?.productName ?? "Articolo").trim() || "Articolo",
  );
  const reason = normalizePaymentPrintNote(storno?.reason);
  const stornoId = String(storno?.stornoId ?? storno?.id ?? "").trim();
  const paymentReferences = normalizeStornoPaymentReferences(
    Array.isArray(storno?.paymentReferences) &&
      storno.paymentReferences.length > 0
      ? storno.paymentReferences
      : storno?.refundPlan?.allocations,
  );
  const createdAtMsRaw = Number(storno?.createdAtMs);
  const createdAtMs =
    Number.isFinite(createdAtMsRaw) && createdAtMsRaw > 0
      ? createdAtMsRaw
      : Date.now();
  const titleStyle = {
    align: "center",
    bold: true,
    widthScale: 1,
    heightScale: 3,
    charSpacing: 0,
  };
  const metaStyle = { widthScale: 0, heightScale: 1, bold: true };
  const amountStyle = {
    align: "center",
    bold: true,
    widthScale: 2,
    heightScale: 2,
    charSpacing: 0,
  };
  const infoStyle = { widthScale: 0, heightScale: 1 };
  const lines = [...styleEscPosPrintLines("STORNO PAGAMENTO", titleStyle)];
  const headerLines = buildPrintTwoColumnLines(
    toPrintSafeUppercase(tableLabel),
    toPrintSafeUppercase(orderReferenceLabel),
    width,
  );
  if (headerLines.length > 0) {
    lines.push(...styleEscPosPrintLines(headerLines, metaStyle));
  }
  lines.push(
    ...styleEscPosPrintLines(
      buildPrintLabelLines("CAMERIERE", waiterLabel, width),
      infoStyle,
    ),
  );
  if (stornoId) {
    lines.push(
      ...styleEscPosPrintLines(
        buildPrintLabelLines(
          "ID STORNO",
          toPrintSafeUppercase(stornoId),
          width,
        ),
        infoStyle,
      ),
    );
  }
  lines.push(
    ...styleEscPosPrintLines(
      buildPrintLabelLines("ARTICOLO", `${quantity} X ${productName}`, width),
      infoStyle,
    ),
  );
  if (reason) {
    lines.push(
      ...styleEscPosPrintLines(
        buildPrintLabelLines("MOTIVO", toPrintSafeUppercase(reason), width),
        infoStyle,
      ),
    );
  }
  lines.push(...styleEscPosPrintLines(separatorLine, metaStyle));
  lines.push(
    ...styleEscPosPrintLines(`-${formatPrintMoney(amount)}`, amountStyle),
  );
  if (paymentReferences.length > 0) {
    lines.push(...styleEscPosPrintLines(separatorLine, metaStyle));
    lines.push(...styleEscPosPrintLines("PAGAMENTI DA STORNARE", metaStyle));
    paymentReferences.forEach((reference, index) => {
      const refLabel = reference.paymentId || `RIF. ${index + 1}`;
      lines.push(
        ...styleEscPosPrintLines(
          buildPrintLabelLines(
            "PAGAMENTO",
            toPrintSafeUppercase(refLabel),
            width,
          ),
          infoStyle,
        ),
      );
      lines.push(
        ...styleEscPosPrintLines(
          buildPrintLabelLines(
            "MODALITA",
            toPrintSafeUppercase(
              `${formatPaymentMethodPrintLabel(reference.method)} - ${formatRefundActionPrintLabel(reference.action)}`,
            ),
            width,
          ),
          infoStyle,
        ),
      );
      if (reference.transactionIds.length > 0) {
        lines.push(
          ...styleEscPosPrintLines(
            buildPrintLabelLines(
              "ID TX",
              toPrintSafeUppercase(reference.transactionIds.join(", ")),
              width,
            ),
            infoStyle,
          ),
        );
      }
      lines.push(
        ...styleEscPosPrintLines(
          buildPrintLabelLines(
            "RIMBORSO",
            toPrintSafeUppercase(formatPrintMoney(reference.refundAmount)),
            width,
          ),
          infoStyle,
        ),
      );
      if (reference.voidAmount > 0) {
        lines.push(
          ...styleEscPosPrintLines(
            buildPrintLabelLines(
              "STORNA POS",
              toPrintSafeUppercase(formatPrintMoney(reference.voidAmount)),
              width,
            ),
            infoStyle,
          ),
        );
      }
      if (reference.rechargeAmount > 0) {
        lines.push(
          ...styleEscPosPrintLines(
            buildPrintLabelLines(
              "RIADDEBITA",
              toPrintSafeUppercase(formatPrintMoney(reference.rechargeAmount)),
              width,
            ),
            infoStyle,
          ),
        );
      }
      const fiscalRef = [reference.fiscalDocType, reference.fiscalDocNo]
        .filter(Boolean)
        .join(" ");
      if (fiscalRef) {
        lines.push(
          ...styleEscPosPrintLines(
            buildPrintLabelLines(
              "DOC ORIG.",
              toPrintSafeUppercase(fiscalRef),
              width,
            ),
            infoStyle,
          ),
        );
      }
    });
  }
  lines.push(...styleEscPosPrintLines(separatorLine, metaStyle));
  lines.push(
    ...styleEscPosPrintLines(
      centerPrintText(formatIntegrationPrintDateTime(createdAtMs), width),
      infoStyle,
    ),
  );
  lines.push("");
  return lines.join("\n");
}

  return {
    buildMobileElectronicPaymentPrintText,
    buildMobilePaymentStornoPrintText,
  };
}

