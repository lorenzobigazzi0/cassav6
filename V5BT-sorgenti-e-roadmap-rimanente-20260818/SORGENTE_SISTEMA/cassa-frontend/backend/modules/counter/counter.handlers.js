import { randomUUID } from "node:crypto";
import { COUNTER_COLLECTION_WRITE_DOMAINS } from "./counter-collection-writer.js";

const COUNTER_TABLE_ID = "counter:banco";
const COUNTER_TABLE_LABEL = "Banco";
const RECEIPT_WIDTH = 42;
const PAYMENT_METHODS = {
  cash: { method: "CASH", methodId: "pay_cash", methodLabel: "Contanti" },
  card: { method: "POS", methodId: "pay_card", methodLabel: "Carta" },
  voucher: {
    method: "OTHER",
    methodId: "pay_smart",
    methodLabel: "Buono pasto",
  },
  satispay: {
    method: "OTHER",
    methodId: "pay_smart",
    methodLabel: "Satispay Business",
  },
  suspended: {
    method: "OTHER",
    methodId: "pay_smart",
    methodLabel: "Conto sospeso",
  },
  check: { method: "OTHER", methodId: "pay_smart", methodLabel: "Assegno" },
  wire: { method: "OTHER", methodId: "pay_smart", methodLabel: "Bonifico" },
};

const compactId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "")}`;

const moneyToCents = (value) =>
  Math.round(Math.max(0, Number(value) || 0) * 100);
const centsToMoney = (value) =>
  Math.round(Math.max(0, Number(value) || 0)) / 100;
const roundMoneyLocal = (value) => Math.round((Number(value) || 0) * 100) / 100;
const padLeft = (value, width) => String(value).padStart(width, " ");
const padRight = (value, width) => {
  const text = String(value ?? "");
  return text.length > width ? text.slice(0, width) : text.padEnd(width, " ");
};
const center = (value) => {
  const text = String(value ?? "");
  return text.padStart(Math.floor((RECEIPT_WIDTH + text.length) / 2), " ");
};
const divider = () => "-".repeat(RECEIPT_WIDTH);

function formatMoney(cents) {
  return (Math.round(cents) / 100).toLocaleString("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function normalizeVatRate(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed * 1000) / 1000;
}

function vatAmountFromGross(grossCents, vatRate) {
  if (!Number.isFinite(vatRate) || vatRate <= 0 || grossCents <= 0) return 0;
  const net = grossCents / (1 + vatRate / 100);
  return Math.round(grossCents - net);
}

function formatDateTime(isoOrMs) {
  const date = new Date(isoOrMs);
  const valid = Number.isFinite(date.getTime()) ? date : new Date();
  return valid
    .toLocaleString("it-IT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
    .replace(",", "");
}

function buildOperatorReceiptName(input = {}) {
  const clean = (value) =>
    String(value ?? "")
      .trim()
      .replace(/\s+/g, " ");
  const fullName = clean(input.fullName ?? input.operator?.fullName);
  if (fullName) {
    const parts = fullName.split(" ").filter(Boolean);
    if (parts.length >= 2)
      return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
    return parts[0];
  }
  return (
    clean(input.username ?? input.operator?.username) ||
    clean(input.operator?.label) ||
    "Operatore"
  );
}

function normalizeCounterLine(line, index, { HttpError }) {
  const name =
    String(line?.name ?? "")
      .trim()
      .slice(0, 96) || "Articolo";
  const qty = Math.max(1, Math.min(99, Math.trunc(Number(line?.qty) || 1)));
  const unitFinalPrice = Number.isFinite(Number(line?.unitFinalPrice))
    ? roundMoneyLocal(Math.max(Number(line.unitFinalPrice), 0))
    : null;
  const lineTotalFromInput = Number.isFinite(Number(line?.lineTotal))
    ? roundMoneyLocal(Math.max(Number(line.lineTotal), 0))
    : null;
  const lineTotal =
    lineTotalFromInput ??
    roundMoneyLocal(
      unitFinalPrice !== null
        ? unitFinalPrice * qty
        : centsToMoney(line?.totalCents),
    );
  const vatRate = normalizeVatRate(line?.vatRate ?? line?.iva ?? line?.taxRate);
  if (vatRate === null) {
    throw new HttpError(400, `Aliquota IVA mancante per "${name}".`, {
      code: "COUNTER_VAT_RATE_REQUIRED",
      details: { lineIndex: index },
    });
  }
  if (lineTotal <= 0) {
    throw new HttpError(400, `Riga Banco #${index + 1} non valida.`, {
      code: "COUNTER_LINE_INVALID",
    });
  }
  return {
    lineId: String(line?.lineId ?? `counter_line_${index + 1}`)
      .trim()
      .slice(0, 96),
    productId:
      String(line?.productId ?? "")
        .trim()
        .slice(0, 96) || undefined,
    name,
    qty,
    note:
      String(line?.note ?? "")
        .trim()
        .slice(0, 180) || undefined,
    variantName:
      String(line?.variantName ?? "")
        .trim()
        .slice(0, 80) || undefined,
    unitPrice: unitFinalPrice ?? roundMoneyLocal(lineTotal / qty),
    unitPriceApplied: unitFinalPrice ?? roundMoneyLocal(lineTotal / qty),
    lineTotal,
    lineTotalCents: moneyToCents(lineTotal),
    vatRate,
    vatCode:
      String(line?.vatCode ?? line?.ivaCode ?? line?.taxCode ?? "")
        .trim()
        .slice(0, 40) || undefined,
    clientPriceSnapshot:
      line?.clientPriceSnapshot && typeof line.clientPriceSnapshot === "object"
        ? line.clientPriceSnapshot
        : undefined,
  };
}

function distributeAdjustedTotals(lines, targetTotalCents) {
  const originalTotalCents = lines.reduce(
    (sum, line) => sum + line.lineTotalCents,
    0,
  );
  if (originalTotalCents <= 0 || targetTotalCents === originalTotalCents)
    return lines;
  let assigned = 0;
  return lines.map((line, index) => {
    const isLast = index === lines.length - 1;
    const nextCents = isLast
      ? Math.max(0, targetTotalCents - assigned)
      : Math.max(
          0,
          Math.round(
            (line.lineTotalCents * targetTotalCents) / originalTotalCents,
          ),
        );
    assigned += nextCents;
    return {
      ...line,
      lineTotalCents: nextCents,
      lineTotal: centsToMoney(nextCents),
      unitPriceApplied:
        line.qty > 0
          ? roundMoneyLocal(centsToMoney(nextCents) / line.qty)
          : line.unitPriceApplied,
    };
  });
}

function buildNonFiscalReceiptText({
  settings,
  lines,
  totalCents,
  payment,
  operatorLabel,
  createdAt,
}) {
  const company = settings?.company ?? settings?.general ?? {};
  const rows = [];
  const dateTime = formatDateTime(createdAt);
  const companyName = String(
    company.companyName ?? company.name ?? settings?.companyName ?? "",
  ).trim();
  const companyAddress = String(
    company.address ?? settings?.companyAddress ?? "",
  ).trim();
  const companyCity = String(
    company.city ?? settings?.companyCity ?? "",
  ).trim();
  const companyVat = String(
    company.vatNumber ?? company.piva ?? settings?.vatNumber ?? "",
  ).trim();

  if (companyName) rows.push(center(companyName.toUpperCase()));
  if (companyAddress) rows.push(center(companyAddress));
  if (companyCity) rows.push(center(companyCity));
  if (companyVat) rows.push(center(`P.IVA ${companyVat}`));
  rows.push("", divider(), center("SCONTRINO NON FISCALE"), divider(), "");
  rows.push("Modalita: BANCO");
  rows.push(`Operatore: ${operatorLabel}`);
  rows.push(`Data/Ora: ${dateTime}`);
  rows.push("", divider());
  rows.push(
    `${padRight("DESCRIZIONE", 26)}${padLeft("IVA", 5)}${padLeft("EURO", 11)}`,
  );
  rows.push(divider());

  lines.forEach((line) => {
    const label = line.qty > 1 ? `${line.qty}x ${line.name}` : line.name;
    rows.push(
      `${padRight(label, 26)}${padLeft(`${line.vatRate}%`, 5)}${padLeft(formatMoney(line.lineTotalCents), 11)}`,
    );
  });

  rows.push("", divider());
  rows.push(
    `${padRight("TOTALE COMPLESSIVO", 31)}${padLeft(formatMoney(totalCents), 11)}`,
  );
  rows.push(divider(), "");

  const vatGroups = new Map();
  lines.forEach((line) => {
    vatGroups.set(
      line.vatRate,
      (vatGroups.get(line.vatRate) ?? 0) + line.lineTotalCents,
    );
  });
  [...vatGroups.entries()]
    .sort(([left], [right]) => left - right)
    .forEach(([vatRate, grossCents]) => {
      rows.push(
        `${padRight(`di cui IVA ${vatRate}%`, 31)}${padLeft(formatMoney(vatAmountFromGross(grossCents, vatRate)), 11)}`,
      );
    });

  rows.push("", divider());
  rows.push(
    `${padRight(payment.methodLabel, 31)}${padLeft(formatMoney(totalCents), 11)}`,
  );
  rows.push(
    `${padRight("Importo pagato", 31)}${padLeft(formatMoney(totalCents), 11)}`,
  );
  rows.push(divider(), "", dateTime, "");
  rows.push(center("SCONTRINO NON FISCALE"));
  rows.push(center("Documento interno gestionale"));
  rows.push(center("Non valido ai fini fiscali"));
  rows.push("", divider(), center("Grazie"));
  return rows.join("\n");
}

function buildCounterCommandOrder({
  counterOrderId,
  lines,
  payload,
  user,
  createdAt,
}) {
  return {
    id: counterOrderId,
    roomId: String(payload.roomId ?? "").trim(),
    roomName: String(payload.roomName ?? "").trim() || "Banco",
    tableId: COUNTER_TABLE_ID,
    tableNumber: 0,
    tableLabel: COUNTER_TABLE_LABEL,
    logicalTableId: COUNTER_TABLE_ID,
    logicalTableLabel: COUNTER_TABLE_LABEL,
    waiter: buildOperatorReceiptName({
      fullName: user?.fullName ?? payload.fullName,
      username: user?.username ?? payload.username,
      operator: payload.operator,
    }),
    receivedAtMs:
      Number(payload.order?.createdAt) || Date.parse(createdAt) || Date.now(),
    workflowStatus: "delivered",
    ownerStation: "BANCO",
    station: "BANCO",
    items: lines.map((line) => ({
      id: line.lineId,
      lineId: line.lineId,
      productId: line.productId,
      name: line.name,
      qty: line.qty,
      note: line.note,
      variantName: line.variantName,
      unitPriceApplied: line.unitPriceApplied,
      lineTotal: line.lineTotal,
      station: "BANCO",
      routeStations: ["BANCO"],
    })),
  };
}

export function createCounterHandlers(context) {
  const {
    HttpError,
    appendAuditEvent,
    assertUserPaymentMethodAllowed,
    buildAuditActor,
    buildIntegrationOrderPrintText,
    commercialBenefitCentsToMoney,
    enqueuePrintSpoolJob,
    ensureCommercialBenefitCollections,
    ensurePaymentTrackingArrays,
    findExistingPaymentByIdempotency,
    normalizePaymentCommercialBenefitApplicationRefs,
    normalizeIdempotencyKey,
    nowIso,
    readDb,
    readJsonBody,
    roundMoney,
    sanitizePaymentContainerRecord,
    sanitizePaymentPartRecord,
    sanitizePaymentRecord,
    sanitizePaymentTransactionRecord,
    sanitizePosSettings,
    sendJson,
    summarizePaymentCommercialBenefitApplications,
    redeemCommercialBenefitApplications,
    validateSessionContext,
    writeCounterCollectionDb,
    writeDb,
  } = context;

  async function handleCounterCollect(req, res) {
    const payload = await readJsonBody(req);
    if (String(payload?.context ?? "").trim() !== "counter") {
      throw new HttpError(400, "Contesto Banco non valido.", {
        code: "COUNTER_CONTEXT_REQUIRED",
      });
    }
    if (String(payload?.tableId ?? "").trim() !== COUNTER_TABLE_ID) {
      throw new HttpError(400, "Tavolo virtuale Banco non valido.", {
        code: "COUNTER_TABLE_INVALID",
      });
    }

    const db = await readDb();
    const { user, session } = validateSessionContext(db, payload);
    ensurePaymentTrackingArrays(db);
    ensureCommercialBenefitCollections?.(db);
    if (!Array.isArray(db.payments)) db.payments = [];
    const auditStartIndex = Array.isArray(db.auditEvents)
      ? db.auditEvents.length
      : 0;
    const redemptionStartIndex = Array.isArray(
      db.commercialBenefitRedemptions,
    )
      ? db.commercialBenefitRedemptions.length
      : 0;

    const idempotencyKey = normalizeIdempotencyKey(payload);
    const existing = findExistingPaymentByIdempotency(
      db,
      idempotencyKey,
      user,
      session,
    );
    if (existing) {
      sendJson(res, 200, {
        ok: true,
        idempotent: true,
        counterOrderId: existing.container.orderId,
        paymentId: existing.container.id,
        payment: existing.container,
      });
      return;
    }

    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const paymentMethodKey = String(payload?.payment?.method ?? "cash").trim();
    const paymentMeta =
      PAYMENT_METHODS[paymentMethodKey] ?? PAYMENT_METHODS.cash;
    assertUserPaymentMethodAllowed(user, paymentMeta.methodId, settings);

    const rawLines = Array.isArray(payload?.order?.lines)
      ? payload.order.lines
      : [];
    if (rawLines.length === 0) {
      throw new HttpError(400, "Ordine Banco senza righe.", {
        code: "COUNTER_ORDER_EMPTY",
      });
    }
    const normalizedLines = rawLines.map((line, index) =>
      normalizeCounterLine(line, index, { HttpError }),
    );
    const originalTotalCents = normalizedLines.reduce(
      (sum, line) => sum + line.lineTotalCents,
      0,
    );
    const requestedTotalCents = Math.max(
      0,
      Math.trunc(Number(payload?.payment?.amountCents) || 0),
    );
    const commercialBenefitApplicationRefs =
      normalizePaymentCommercialBenefitApplicationRefs
        ? normalizePaymentCommercialBenefitApplicationRefs(
            payload.commercialBenefitApplications ??
              payload.payment?.commercialBenefitApplications ??
              payload.commercialBenefitApplicationIds ??
              payload.commercialBenefits,
          )
        : [];
    const commercialBenefitPaymentSummary =
      commercialBenefitApplicationRefs.length > 0 &&
      summarizePaymentCommercialBenefitApplications
        ? summarizePaymentCommercialBenefitApplications(
            db,
            commercialBenefitApplicationRefs,
            { user, session },
          )
        : { applications: [], totalBenefitCents: 0 };
    const commercialBenefitAmountCents = Math.max(
      Math.trunc(
        Number(commercialBenefitPaymentSummary.totalBenefitCents) || 0,
      ),
      0,
    );
    const commercialBenefitAmount = commercialBenefitCentsToMoney
      ? commercialBenefitCentsToMoney(commercialBenefitAmountCents)
      : centsToMoney(commercialBenefitAmountCents);
    const benefitOnlyPayment =
      requestedTotalCents <= 0 &&
      commercialBenefitApplicationRefs.length > 0 &&
      commercialBenefitAmountCents > 0;
    if (requestedTotalCents <= 0 && !benefitOnlyPayment) {
      throw new HttpError(400, "Importo Banco non valido.", {
        code: "COUNTER_AMOUNT_INVALID",
      });
    }
    if (
      benefitOnlyPayment &&
      commercialBenefitAmountCents + 1 < originalTotalCents
    ) {
      throw new HttpError(
        409,
        "Beneficio commerciale insufficiente per chiudere il Banco senza incasso.",
        { code: "COMMERCIAL_BENEFIT_INSUFFICIENT_FOR_COUNTER" },
      );
    }
    const effectiveLineTotalCents = benefitOnlyPayment
      ? originalTotalCents
      : requestedTotalCents;
    const lines = distributeAdjustedTotals(
      normalizedLines,
      effectiveLineTotalCents,
    );
    const totalPaid = roundMoney(centsToMoney(requestedTotalCents));
    const createdAt = nowIso();
    const counterOrderId =
      String(payload?.order?.id ?? "")
        .trim()
        .slice(0, 96) || compactId("co");
    const paymentId = compactId("pay");
    const partId = compactId("part");
    const txId = compactId("tx");
    const cashGiven =
      paymentMeta.method === "CASH"
        ? roundMoney(
            centsToMoney(
              Number(payload?.payment?.cashReceivedCents) ||
                requestedTotalCents,
            ),
          )
        : null;
    const changeGiven =
      paymentMeta.method === "CASH" && cashGiven !== null
        ? roundMoney(Math.max(cashGiven - totalPaid, 0))
        : null;
    const paymentNote =
      String(payload?.payment?.note ?? "")
        .trim()
        .slice(0, 240) || null;
    const automaticCashPaymentOperationId =
      String(
        payload?.payment?.automaticCashPaymentOperationId ??
          payload?.payment?.automaticCashOperationId ??
          "",
      ).trim() || null;
    const paymentSource = String(payload?.payment?.paymentSource ?? "")
      .trim()
      .toLowerCase();
    const cashSource = String(payload?.payment?.cashSource ?? "")
      .trim()
      .toLowerCase();
    const isAutomaticCashPayment =
      paymentMeta.method === "CASH" &&
      (paymentSource === "automatic_cash" ||
        paymentSource === "automatic-cash" ||
        cashSource === "automatic" ||
        Boolean(automaticCashPaymentOperationId));
    const collectionMetadata = {
      paymentSource: isAutomaticCashPayment ? "automatic_cash" : null,
      cashSource: isAutomaticCashPayment ? "automatic" : null,
      automaticCashPaymentOperationId: isAutomaticCashPayment
        ? automaticCashPaymentOperationId
        : null,
    };
    const adminAdjustment =
      payload?.payment?.adminAdjustment &&
      typeof payload.payment.adminAdjustment === "object"
        ? payload.payment.adminAdjustment
        : null;

    const paymentContainer = sanitizePaymentContainerRecord(
      {
        id: paymentId,
        tableId: COUNTER_TABLE_ID,
        tableNumber: 0,
        tableLabel: COUNTER_TABLE_LABEL,
        orderId: counterOrderId,
        orderIds: [counterOrderId],
        roomId: String(payload.roomId ?? "").trim() || null,
        createdByUserId: user.id,
        createdByUsername: user.username,
        collectedByUserId: user.id,
        collectedByUsername: user.username,
        collectedByDeviceUuid: session.deviceUuid,
        paymentMethod: paymentMeta.methodLabel,
        ...collectionMetadata,
        amount: totalPaid,
        note: paymentNote,
        createdAt,
        status: "COMPLETED",
        splitType: "FREE_SPLIT",
        splitMode:
          String(payload?.payment?.splitMode ?? "single").trim() || "single",
        adjustmentKind: adminAdjustment?.type ?? null,
        adminAdjustment,
        idempotencyKey: idempotencyKey || null,
        clientPaymentId:
          String(payload.clientPaymentId ?? "").trim() ||
          idempotencyKey ||
          null,
        fiscalDocType: null,
        fiscalDocNo: null,
        fiscalIssuedAt: null,
        fiscalIssuedBy: null,
        commercialBenefitApplicationIds: commercialBenefitApplicationRefs,
        commercialBenefitAmountCents,
        commercialBenefitAmount,
      },
      paymentId,
    );
    const paymentPart = benefitOnlyPayment
      ? null
      : sanitizePaymentPartRecord(
          {
            id: partId,
            paymentId,
            partNo: 1,
            amountDue: totalPaid,
            status: "PAID",
          },
          partId,
        );
    const paymentTransaction = benefitOnlyPayment
      ? null
      : sanitizePaymentTransactionRecord(
          {
            id: txId,
            partId,
            createdByUserId: user.id,
            createdByUsername: user.username,
            createdAt,
            method: paymentMeta.method,
            ...collectionMetadata,
            amountPaid: totalPaid,
            cashGiven,
            changeGiven,
            posProvider: paymentMeta.method === "POS" ? "mobile-pos" : null,
            note: paymentNote,
          },
          txId,
        );
    const legacyPayment = benefitOnlyPayment
      ? null
      : sanitizePaymentRecord(
          {
            id: compactId("pay"),
            tableId: COUNTER_TABLE_ID,
            tableNumber: 0,
            tableLabel: COUNTER_TABLE_LABEL,
            roomId: String(payload.roomId ?? "").trim() || null,
            orderId: counterOrderId,
            orderIds: [counterOrderId],
            tableCovers: 1,
            amount: totalPaid,
            note: paymentNote,
            methodId: paymentMeta.methodId,
            methodLabel: paymentMeta.methodLabel,
            ...collectionMetadata,
            fiscal: false,
            source: "counter_payment",
            adjustmentKind: adminAdjustment?.type ?? null,
            adminAdjustment,
            createdAt,
            createdByUserId: user.id,
            createdByUsername: user.username,
            collectedByUserId: user.id,
            collectedByUsername: user.username,
            collectedByDeviceUuid: session.deviceUuid,
            paymentContainerId: paymentId,
            paymentPartId: partId,
            paymentTxId: txId,
            changeGiven,
            idempotencyKey: idempotencyKey || null,
            clientPaymentId:
              String(payload.clientPaymentId ?? "").trim() ||
              idempotencyKey ||
              null,
            items: lines.map((line) => ({
              name: line.name,
              qty: line.qty,
              unitPrice: line.unitPrice,
              unitPriceApplied: line.unitPriceApplied,
              lineTotal: line.lineTotal,
              note: line.note,
              variantName: line.variantName,
              productId: line.productId,
              lineId: line.lineId,
              vatRate: line.vatRate,
              vatCode: line.vatCode,
            })),
          },
          compactId("pay"),
        );

    if (
      !paymentContainer ||
      (!benefitOnlyPayment &&
        (!paymentPart || !paymentTransaction || !legacyPayment))
    ) {
      throw new HttpError(500, "Impossibile registrare pagamento Banco.");
    }

    db.paymentContainers.push(paymentContainer);
    if (paymentPart) db.paymentParts.push(paymentPart);
    if (paymentTransaction) db.paymentTransactions.push(paymentTransaction);
    if (legacyPayment) db.payments.push(legacyPayment);
    let redeemedCommercialBenefits = [];
    if (
      commercialBenefitApplicationRefs.length > 0 &&
      redeemCommercialBenefitApplications
    ) {
      try {
        redeemedCommercialBenefits = redeemCommercialBenefitApplications(
          db,
          commercialBenefitApplicationRefs,
          {
            now: createdAt,
            paymentId: paymentContainer.id,
            user,
            session,
          },
        );
      } catch (error) {
        throw new HttpError(
          409,
          error instanceof Error
            ? error.message
            : "Beneficio commerciale non riscattabile.",
          {
            code: error?.code || "COMMERCIAL_BENEFIT_REDEEM_FAILED",
            details: error?.details ?? {},
          },
        );
      }
    }

    const auditActor = buildAuditActor(user, payload);
    appendAuditEvent(db, {
      ...auditActor,
      action: "counter.order_collected",
      entityType: "payment",
      entityId: paymentId,
      roomId: paymentContainer.roomId || auditActor.roomId,
      payload: {
        paymentId,
        counterOrderId,
        totalPaid,
        commercialBenefitAmount,
        originalTotal: centsToMoney(originalTotalCents),
        adjusted: originalTotalCents !== effectiveLineTotalCents,
        lineCount: lines.length,
        vatRates: [...new Set(lines.map((line) => line.vatRate))],
      },
    });
    appendAuditEvent(db, {
      ...auditActor,
      action: "payment.created",
      entityType: "payment",
      entityId: paymentId,
      roomId: paymentContainer.roomId || auditActor.roomId,
      payload: {
        paymentId,
        tableId: COUNTER_TABLE_ID,
        orderId: counterOrderId,
        splitType: "FREE_SPLIT",
        totalDue: totalPaid,
        totalPaid,
        commercialBenefitAmount,
        collectedByUserId: user.id,
        collectedByUsername: user.username,
        deviceUuid: session.deviceUuid,
        adjustmentKind: adminAdjustment?.type ?? null,
      },
    });
    appendAuditEvent(db, {
      ...auditActor,
      action: "payment.completed",
      entityType: "payment",
      entityId: paymentId,
      roomId: paymentContainer.roomId || auditActor.roomId,
      payload: { paymentId, totalPaid },
    });
    redeemedCommercialBenefits.forEach((application) => {
      appendAuditEvent(db, {
        ...auditActor,
        action: "commercial_benefit.redeemed",
        entityType: "commercial_benefit_application",
        entityId: application.id,
        roomId: paymentContainer.roomId || auditActor.roomId,
        payload: {
          applicationId: application.id,
          campaignId: application.campaignId,
          couponId: application.couponId,
          paymentId: paymentContainer.id,
          benefitAmountCents: application.benefitAmountCents,
          balanceAfterCents: application.balanceAfterPreviewCents,
          forfeitedCents: application.forfeitedPreviewCents,
        },
      });
    });

    if (!db.meta || typeof db.meta !== "object") db.meta = {};
    db.meta.lastWriteAt = nowIso();
    const counterMutation = {
      paymentIds: legacyPayment?.id ? [legacyPayment.id] : [],
      paymentContainerIds: [paymentContainer.id],
      paymentPartIds: paymentPart?.id ? [paymentPart.id] : [],
      paymentTransactionIds: paymentTransaction?.id
        ? [paymentTransaction.id]
        : [],
      commercialBenefitCouponIds: redeemedCommercialBenefits.map(
        (application) => application?.couponId,
      ),
      commercialBenefitApplicationIds: redeemedCommercialBenefits.map(
        (application) => application?.id,
      ),
      commercialBenefitRedemptionIds: (
        Array.isArray(db.commercialBenefitRedemptions)
          ? db.commercialBenefitRedemptions.slice(redemptionStartIndex)
          : []
      ).map((redemption) => redemption?.id),
      auditEventIds: (
        Array.isArray(db.auditEvents)
          ? db.auditEvents.slice(auditStartIndex)
          : []
      ).map((event) => event?.id),
    };
    if (typeof writeCounterCollectionDb === "function") {
      await writeCounterCollectionDb(db, counterMutation);
    } else {
      await writeDb(db, {
        metricLabel: "counter.collect.appStateWrite",
        splitDomains: COUNTER_COLLECTION_WRITE_DOMAINS,
      });
    }

    const operatorLabel = buildOperatorReceiptName({
      fullName: user.fullName ?? payload.fullName,
      username: user.username ?? payload.username,
      operator: payload.operator,
    });
    const commandOrder = buildCounterCommandOrder({
      counterOrderId,
      lines,
      payload,
      user,
      createdAt,
    });
    const printJobs = {};
    const printErrors = [];
    try {
      printJobs.command = await enqueuePrintSpoolJob({
        kind: "order",
        printKind: "counter_command",
        orderId: counterOrderId,
        tableId: COUNTER_TABLE_ID,
        tableLabel: COUNTER_TABLE_LABEL,
        roomId: String(payload.roomId ?? "").trim() || null,
        text: buildIntegrationOrderPrintText(
          commandOrder,
          "BANCO",
          settings.printPreferences?.order,
          settings,
          {
            title: "COMANDA BANCO",
          },
        ),
        userId: user.id,
        deviceUuid: session.deviceUuid,
        clientApp: "mobile-frontend",
      });
    } catch (error) {
      printErrors.push(
        error instanceof Error
          ? error.message
          : "Stampa comanda Banco non riuscita.",
      );
    }

    if (String(payload?.payment?.receiptType ?? "scontrino") === "scontrino") {
      try {
        printJobs.receipt = await enqueuePrintSpoolJob({
          kind: "counter_non_fiscal_receipt",
          orderId: paymentId,
          tableId: COUNTER_TABLE_ID,
          tableLabel: COUNTER_TABLE_LABEL,
          roomId: String(payload.roomId ?? "").trim() || null,
          text: buildNonFiscalReceiptText({
            settings,
            lines,
            totalCents: effectiveLineTotalCents,
            payment: paymentMeta,
            operatorLabel,
            createdAt,
          }),
          userId: user.id,
          deviceUuid: session.deviceUuid,
          clientApp: "mobile-frontend",
        });
      } catch (error) {
        printErrors.push(
          error instanceof Error
            ? error.message
            : "Stampa scontrino non fiscale non riuscita.",
        );
      }
    }

    sendJson(res, 200, {
      ok: true,
      counterOrderId,
      paymentId,
      payment: paymentContainer,
      printJobs,
      printWarning: printErrors.length ? printErrors.join(" ") : undefined,
    });
  }

  return {
    "payments.counterCollect": handleCounterCollect,
  };
}
