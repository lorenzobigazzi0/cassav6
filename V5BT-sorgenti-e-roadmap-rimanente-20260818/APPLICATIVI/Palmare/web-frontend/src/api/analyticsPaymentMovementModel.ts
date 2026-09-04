import type { AnalyticsTransactionRecord } from "../utils/analyticsTransactions";
import type {
  AnalyticsFiscalReceipt,
  AnalyticsMovementRecord,
  AnalyticsMovementTransaction,
  AnalyticsRefundPlan,
} from "./analyticsPaymentMovementTypes";

type ArticleLookup = {
  byUnitId: Map<string, string>;
  byLineKey: Map<string, string>;
};

export const normalizeAnalyticsValue = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const lower = (value: unknown) => normalizeAnalyticsValue(value).toLowerCase();

export const asAnalyticsRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const toNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
};

const toPositiveAmount = (value: unknown) => Math.abs(toNumber(value));

const toOptionalNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed * 100) / 100;
};

const toOptionalInt = (value: unknown): number | undefined => {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export const toAnalyticsMovementTime = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

export const parseAnalyticsTimestamp = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return Math.trunc(value);
    if (value > 1_000_000_000) return Math.trunc(value * 1000);
    return 0;
  }
  const raw = normalizeAnalyticsValue(value);
  if (!raw) return 0;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return parseAnalyticsTimestamp(numeric);
  return toAnalyticsMovementTime(raw);
};

export const analyticsTokenPart = (value: unknown, fallback: string) => {
  const normalized = normalizeAnalyticsValue(value)
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || fallback).slice(0, 40);
};

export const maxAnalyticsTimestamp = (values: unknown[]) =>
  values.reduce<number>((latest, value) => Math.max(latest, parseAnalyticsTimestamp(value)), 0);

const firstPositiveInt = (values: unknown[]) => {
  for (const value of values) {
    const parsed = Math.trunc(Number(value));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
};

const uniq = (values: unknown[]) =>
  Array.from(new Set(values.map(normalizeAnalyticsValue).filter(Boolean)));

const formatOrderReference = (orderIds: unknown[]) => {
  const ids = uniq(orderIds);
  if (!ids.length) return "";
  return ids.map((id) => (id.charAt(0) === "#" ? id : `#${id}`)).join(", ");
};

export const analyticsMethodLabel = (value: unknown) => {
  const raw = lower(value);
  if (raw === "cash" || raw === "pay_cash" || raw.includes("cash") || raw.includes("contant")) {
    return "Contanti";
  }
  if (
    raw === "pos" ||
    raw === "card" ||
    raw === "pay_card" ||
    raw.includes("card") ||
    raw.includes("carta")
  ) {
    return "Carta";
  }
  if (raw === "mixed") return "Misto";
  return normalizeAnalyticsValue(value) || "Non specificato";
};

const roomLabel = (roomId: unknown) => {
  const raw = normalizeAnalyticsValue(roomId);
  if (!raw) return "";
  return raw
    .replace(/^room_/, "")
    .replace(/^sala_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
};

export const analyticsTableLabel = (
  record: Pick<AnalyticsMovementRecord, "roomId" | "tableLabel" | "tableNumber">
) => {
  const room = roomLabel(record.roomId);
  const table = record.tableLabel || record.tableNumber || "";
  if (table && room) return `Tavolo ${table} - ${room}`;
  if (table) return `Tavolo ${table}`;
  return room || "Tavolo n/d";
};

export const analyticsSplitModeLabel = (
  record: Pick<AnalyticsMovementRecord, "splitMode" | "raw">
) => {
  const rawRecord = asAnalyticsRecord(record.raw);
  const mode = lower(record.splitMode || rawRecord.splitMode || rawRecord.mode);
  if (!mode || mode === "single" || mode === "bill" || mode === "full" || mode === "conto_unico") {
    return "Conto unico";
  }
  if (mode.includes("roman") || mode.includes("romana") || mode.includes("quote")) {
    const paidShares = firstPositiveInt([
      rawRecord.paidShares,
      rawRecord.sharesPaid,
      rawRecord.romanPaidShares,
      rawRecord.romanSharesPaid,
      rawRecord.quotesPaid,
      rawRecord.paidQuoteCount,
      rawRecord.shareCount,
      rawRecord.quoteCount,
    ]);
    const totalShares = firstPositiveInt([
      rawRecord.totalShares,
      rawRecord.sharesTotal,
      rawRecord.romanTotalShares,
      rawRecord.romanSharesTotal,
      rawRecord.quotesTotal,
      rawRecord.totalQuoteCount,
      rawRecord.splitPeople,
      rawRecord.people,
    ]);
    if (paidShares && totalShares) return `Alla romana (${paidShares}/${totalShares} quote)`;
    if (paidShares) return `Alla romana (${paidShares} quote)`;
    return "Alla romana";
  }
  if (mode.includes("free") || mode.includes("amount") || mode.includes("importo")) {
    return "Importo libero";
  }
  if (mode.includes("article") || mode.includes("articolo") || mode.includes("item")) {
    return "Per articolo";
  }
  if (mode === "mixed") return "Misto";
  return normalizeAnalyticsValue(record.splitMode) || "Conto unico";
};

export const canPrintAnalyticsMovement = (record: AnalyticsMovementRecord | null | undefined) =>
  record?.type === "payment" || record?.type === "storno";

const buildArticleLookup = (report: unknown): ArticleLookup => {
  const ordersTracking = asAnalyticsRecord(asAnalyticsRecord(report).ordersTracking);
  const orders = asArray(ordersTracking.orders).map(asAnalyticsRecord);
  const byUnitId = new Map<string, string>();
  const byLineKey = new Map<string, string>();

  orders.forEach((order) => {
    const orderId = normalizeAnalyticsValue(order.id);
    const items = (
      Array.isArray(order.lineItems)
        ? order.lineItems
        : Array.isArray(order.items)
          ? order.items
          : []
    ).map(asAnalyticsRecord);
    items.forEach((item, index) => {
      const lineId = normalizeAnalyticsValue(item.lineId || item.id);
      const productName = normalizeAnalyticsValue(
        item.productNameSnapshot || item.productName || item.name || item.title || item.productId
      );
      const quantity = Math.max(Math.trunc(Number(item.qty ?? item.quantity) || 1), 1);
      const itemIndex = Number.isFinite(Number(item.index))
        ? Math.max(Math.trunc(Number(item.index)), 0)
        : index;
      if (!productName && !lineId) return;
      const articleLabel = [productName || "Articolo", lineId ? `riga ${lineId}` : ""]
        .filter(Boolean)
        .join(" - ");
      if (orderId && lineId) byLineKey.set(`${orderId}|${lineId}`, articleLabel);
      if (!orderId) return;
      for (let unitIndex = 0; unitIndex < quantity; unitIndex += 1) {
        const unitId = `${orderId}_${itemIndex}_${unitIndex}`;
        byUnitId.set(unitId, `${articleLabel} - unita ${unitId}`);
      }
    });
  });

  return { byUnitId, byLineKey };
};

const resolveArticleReference = (
  lookup: ArticleLookup,
  orderIds: unknown[],
  articleUnitIds: unknown,
  fallback: Record<string, unknown>
) => {
  const units = uniq(asArray(articleUnitIds));
  if (units.length) {
    return units.map((unitId) => lookup.byUnitId.get(unitId) || `unita ${unitId}`);
  }
  const lineId = normalizeAnalyticsValue(fallback.lineId);
  const productName = normalizeAnalyticsValue(fallback.productName);
  if (lineId) {
    const orderId = uniq(orderIds)[0] || "";
    const fromOrder = orderId ? lookup.byLineKey.get(`${orderId}|${lineId}`) : "";
    return fromOrder || [productName || "Articolo", `riga ${lineId}`].filter(Boolean).join(" - ");
  }
  return productName || "";
};

const normalizeTransaction = (tx: Record<string, unknown>): AnalyticsMovementTransaction => ({
  id: normalizeAnalyticsValue(tx.id),
  method: normalizeAnalyticsValue(tx.method || tx.paymentMethod),
  amountPaid: toNumber(tx.amountPaid ?? tx.amount),
  posTxRef: normalizeAnalyticsValue(tx.posTxRef),
  posProvider: normalizeAnalyticsValue(tx.posProvider),
  paymentSource: normalizeAnalyticsValue(tx.paymentSource),
  cashSource: normalizeAnalyticsValue(tx.cashSource),
  automaticCashPaymentOperationId: normalizeAnalyticsValue(tx.automaticCashPaymentOperationId),
  note: normalizeAnalyticsValue(tx.note),
});

const paymentTxMap = (report: unknown) => {
  const paymentsTracking = asAnalyticsRecord(asAnalyticsRecord(report).paymentsTracking);
  const parts = asArray(paymentsTracking.parts).map(asAnalyticsRecord);
  const txs = asArray(paymentsTracking.transactions).map(asAnalyticsRecord);
  const partToPayment = new Map<string, string>();

  parts.forEach((part) => {
    const partId = normalizeAnalyticsValue(part.id);
    const paymentId = normalizeAnalyticsValue(part.paymentId);
    if (partId && paymentId) partToPayment.set(partId, paymentId);
  });

  const byPayment = new Map<string, AnalyticsMovementTransaction[]>();
  txs.forEach((tx) => {
    const partId = normalizeAnalyticsValue(tx.partId);
    const paymentId = partToPayment.get(partId);
    if (!paymentId) return;
    const list = byPayment.get(paymentId) || [];
    list.push(normalizeTransaction(tx));
    byPayment.set(paymentId, list);
  });

  return byPayment;
};

const paymentRecords = (
  report: unknown,
  articleLookup: ArticleLookup
): AnalyticsMovementRecord[] => {
  const paymentsTracking = asAnalyticsRecord(asAnalyticsRecord(report).paymentsTracking);
  const containers = asArray(paymentsTracking.containers).map(asAnalyticsRecord);
  const fiscalReceipts = asArray(paymentsTracking.fiscalReceipts).map(asAnalyticsRecord);
  const txByPayment = paymentTxMap(report);

  return containers
    .filter((payment) => normalizeAnalyticsValue(payment.status) === "COMPLETED")
    .map((payment) => {
      const id = normalizeAnalyticsValue(payment.id);
      const transactions = txByPayment.get(id) || [];
      const method = normalizeAnalyticsValue(
        payment.paymentMethod || transactions[0]?.method || "unknown"
      );
      const paymentSource =
        normalizeAnalyticsValue(payment.paymentSource) ||
        normalizeAnalyticsValue(transactions.find((tx) => tx.paymentSource)?.paymentSource);
      const cashSource =
        normalizeAnalyticsValue(payment.cashSource) ||
        normalizeAnalyticsValue(transactions.find((tx) => tx.cashSource)?.cashSource);
      const automaticCashPaymentOperationId =
        normalizeAnalyticsValue(payment.automaticCashPaymentOperationId) ||
        normalizeAnalyticsValue(
          transactions.find((tx) => tx.automaticCashPaymentOperationId)
            ?.automaticCashPaymentOperationId
        );
      const orderIds = uniq(
        asArray(payment.orderIds).length ? asArray(payment.orderIds) : [payment.orderId]
      );
      const articleUnitIds = uniq(asArray(payment.articleUnitIds));
      const fiscalCandidateIds = new Set([
        id,
        normalizeAnalyticsValue(payment.clientPaymentId),
        ...transactions.map((transaction) => transaction.id),
      ]);
      const fiscalReceipt = fiscalReceipts
        .filter((receipt) => fiscalCandidateIds.has(normalizeAnalyticsValue(receipt.paymentId)))
        .sort(
          (left, right) =>
            toAnalyticsMovementTime(right.voidedAt || right.createdAt) -
            toAnalyticsMovementTime(left.voidedAt || left.createdAt)
        )[0];
      const fiscalRaw = fiscalReceipt
        ? {
            ...payment,
            fiscalReceiptId: normalizeAnalyticsValue(fiscalReceipt.id),
            fiscalStatus: normalizeAnalyticsValue(
              fiscalReceipt.fiscalStatus || fiscalReceipt.status
            ),
            fiscalError: normalizeAnalyticsValue(fiscalReceipt.fiscalError),
            fiscalProviderRef: normalizeAnalyticsValue(fiscalReceipt.fiscalProviderRef),
            fiscalMovementId: normalizeAnalyticsValue(fiscalReceipt.fiscalMovementId),
            fiscalReceiptDate: normalizeAnalyticsValue(fiscalReceipt.fiscalReceiptDate),
            fiscalDocumentNumber: normalizeAnalyticsValue(fiscalReceipt.fiscalDocumentNumber),
            voidStatus: normalizeAnalyticsValue(fiscalReceipt.voidStatus),
            voidedAt: normalizeAnalyticsValue(fiscalReceipt.voidedAt),
            voidProviderRef: normalizeAnalyticsValue(fiscalReceipt.voidProviderRef),
            voidMovementId: normalizeAnalyticsValue(fiscalReceipt.voidMovementId),
            voidReceiptDate: normalizeAnalyticsValue(fiscalReceipt.voidReceiptDate),
            voidDocumentNumber: normalizeAnalyticsValue(fiscalReceipt.voidDocumentNumber),
            voidError: normalizeAnalyticsValue(fiscalReceipt.voidError),
          }
        : payment;
      return {
        id: `payment:${id}`,
        type: "payment",
        typeLabel: "Pagamento",
        amount: toNumber(payment.amount),
        createdAt: toAnalyticsMovementTime(payment.createdAt),
        operatorId: normalizeAnalyticsValue(payment.collectedByUserId || payment.createdByUserId),
        operatorName: normalizeAnalyticsValue(
          payment.collectedByDisplayName ||
            payment.createdByDisplayName ||
            payment.collectedByUsername ||
            payment.createdByUsername
        ),
        method,
        methodLabel: analyticsMethodLabel(method),
        paymentSource,
        cashSource,
        automaticCashPaymentOperationId,
        tableId: normalizeAnalyticsValue(payment.tableId),
        tableNumber: toOptionalInt(payment.tableNumber),
        tableLabel: normalizeAnalyticsValue(payment.tableLabel),
        roomId: normalizeAnalyticsValue(payment.roomId),
        note: normalizeAnalyticsValue(payment.note),
        orderIds,
        orderReference: formatOrderReference(orderIds),
        paymentId: id,
        transactionIds: uniq(transactions.map((tx) => tx.id)),
        transactions,
        splitMode: normalizeAnalyticsValue(payment.splitMode),
        articleUnitIds,
        articleReference: resolveArticleReference(articleLookup, orderIds, articleUnitIds, payment),
        fiscalDocNo:
          normalizeAnalyticsValue(fiscalReceipt?.fiscalDocumentNumber) ||
          normalizeAnalyticsValue(fiscalReceipt?.fiscalProviderRef) ||
          normalizeAnalyticsValue(payment.fiscalDocNo),
        fiscalDocType:
          normalizeAnalyticsValue(payment.fiscalDocType) || (fiscalReceipt ? "RECEIPT" : ""),
        tableCancellationId: normalizeAnalyticsValue(payment.tableCancellationId),
        tableCancelledAt: normalizeAnalyticsValue(payment.tableCancelledAt),
        tableCancelledByUserId: normalizeAnalyticsValue(payment.tableCancelledByUserId),
        tableCancelledByUsername: normalizeAnalyticsValue(payment.tableCancelledByUsername),
        tableCancellationReason: normalizeAnalyticsValue(payment.tableCancellationReason),
        adjustmentKind: normalizeAnalyticsValue(payment.adjustmentKind),
        originalPaymentId: normalizeAnalyticsValue(payment.originalPaymentId),
        supersedesPaymentId: normalizeAnalyticsValue(payment.supersedesPaymentId),
        supersededByPaymentId: normalizeAnalyticsValue(payment.supersededByPaymentId),
        productName: normalizeAnalyticsValue(payment.productName),
        quantity: toOptionalInt(payment.quantity),
        lineId: normalizeAnalyticsValue(payment.lineId),
        rechargePaymentIds: [],
        rechargeTransactionIds: [],
        raw: fiscalRaw,
      } satisfies AnalyticsMovementRecord;
    });
};

const normalizeRefundPlan = (value: unknown): AnalyticsRefundPlan | undefined => {
  const refundPlan = asAnalyticsRecord(value);
  const allocations = asArray(refundPlan.allocations)
    .map(asAnalyticsRecord)
    .map((allocation) => ({
      paymentId: normalizeAnalyticsValue(allocation.paymentId),
      method: normalizeAnalyticsValue(allocation.method),
      action: normalizeAnalyticsValue(allocation.action),
      refundAmount: toNumber(allocation.refundAmount),
      voidAmount: toNumber(allocation.voidAmount),
      rechargeAmount: toNumber(allocation.rechargeAmount),
      transactionIds: uniq(asArray(allocation.transactionIds)),
      fiscalDocNo: normalizeAnalyticsValue(allocation.fiscalDocNo),
    }));
  return allocations.length ? { allocations } : undefined;
};

const stornoRecords = (
  report: unknown,
  articleLookup: ArticleLookup
): AnalyticsMovementRecord[] => {
  const serviceRecovery = asAnalyticsRecord(asAnalyticsRecord(report).serviceRecovery);
  const comps = asArray(serviceRecovery.comps).map(asAnalyticsRecord);

  return comps
    .filter((comp) => {
      const rawAmount = comp.paidAmount != null ? comp.paidAmount : comp.amount;
      return toPositiveAmount(rawAmount) > 0;
    })
    .map((comp) => {
      const rawAmount = comp.paidAmount != null ? comp.paidAmount : comp.amount;
      const movementAmount =
        toPositiveAmount(comp.paymentStornoAmount || comp.paymentVoidAmount) ||
        toPositiveAmount(rawAmount);
      const refundPlan = normalizeRefundPlan(comp.refundPlan);
      const allocations = refundPlan?.allocations || [];
      const methods = uniq(allocations.map((entry) => entry.method));
      const txIds = uniq(allocations.flatMap((entry) => entry.transactionIds));
      const orderIds = uniq([comp.orderId]);
      const articleUnitIds = uniq(asArray(comp.articleUnitIds));
      return {
        id: `storno:${normalizeAnalyticsValue(comp.id)}`,
        type: "storno",
        typeLabel: "Storno",
        amount: -movementAmount,
        createdAt: toAnalyticsMovementTime(comp.createdAt),
        operatorId: normalizeAnalyticsValue(comp.createdByUserId),
        operatorName: normalizeAnalyticsValue(comp.createdByDisplayName || comp.createdByUsername),
        method: methods.join(", ") || "manual",
        methodLabel: methods.map(analyticsMethodLabel).join(" + ") || "Manuale",
        paymentSource: "",
        cashSource: "",
        automaticCashPaymentOperationId: "",
        tableId: normalizeAnalyticsValue(comp.tableId),
        tableNumber: toOptionalInt(comp.tableNumber),
        tableLabel: normalizeAnalyticsValue(comp.tableLabel),
        roomId: normalizeAnalyticsValue(comp.roomId),
        note: normalizeAnalyticsValue(comp.reason),
        orderIds,
        orderReference: formatOrderReference(orderIds),
        paymentId: normalizeAnalyticsValue(comp.id),
        transactionIds: txIds,
        transactions: [],
        splitMode: "",
        productName: normalizeAnalyticsValue(comp.productName),
        quantity: toOptionalInt(comp.quantity),
        lineId: normalizeAnalyticsValue(comp.lineId),
        articleUnitIds,
        articleReference: resolveArticleReference(articleLookup, orderIds, articleUnitIds, comp),
        refundPlan,
        fiscalDocNo: "",
        fiscalDocType: "",
        tableCancellationId: "",
        tableCancelledAt: "",
        tableCancelledByUserId: "",
        tableCancelledByUsername: "",
        tableCancellationReason: "",
        adjustmentKind: "",
        originalPaymentId: "",
        supersedesPaymentId: "",
        supersededByPaymentId: "",
        paymentVoidAmount: toOptionalNumber(comp.paymentVoidAmount),
        paymentRechargeAmount: toOptionalNumber(comp.paymentRechargeAmount),
        rechargePaymentIds: uniq(asArray(comp.rechargePaymentIds)),
        rechargeTransactionIds: uniq(asArray(comp.rechargeTransactionIds)),
        raw: comp,
      } satisfies AnalyticsMovementRecord;
    });
};

const replacementRecords = (
  report: unknown,
  articleLookup: ArticleLookup
): AnalyticsMovementRecord[] => {
  const serviceRecovery = asAnalyticsRecord(asAnalyticsRecord(report).serviceRecovery);
  const replacements = asArray(serviceRecovery.replacements).map(asAnalyticsRecord);

  return replacements.map((replacement) => {
    const orderIds = uniq(
      asArray(replacement.orderIds).length ? asArray(replacement.orderIds) : [replacement.orderId]
    );
    const articleUnitIds = uniq(asArray(replacement.articleUnitIds));
    return {
      id: `replacement:${normalizeAnalyticsValue(replacement.id)}`,
      type: "replacement",
      typeLabel: "Sostituzione bar",
      amount: 0,
      createdAt: toAnalyticsMovementTime(replacement.createdAt),
      operatorId: normalizeAnalyticsValue(replacement.createdByUserId),
      operatorName: normalizeAnalyticsValue(
        replacement.createdByDisplayName || replacement.createdByUsername
      ),
      method: "bar_internal",
      methodLabel: "Carico bar",
      paymentSource: "",
      cashSource: "",
      automaticCashPaymentOperationId: "",
      tableId: normalizeAnalyticsValue(replacement.tableId),
      tableNumber: toOptionalInt(replacement.tableNumber),
      tableLabel: normalizeAnalyticsValue(replacement.tableLabel),
      roomId: normalizeAnalyticsValue(replacement.roomId),
      note: normalizeAnalyticsValue(replacement.reason),
      orderIds,
      orderReference: formatOrderReference(orderIds),
      paymentId: normalizeAnalyticsValue(replacement.id),
      transactionIds: [],
      transactions: [],
      splitMode: "",
      productName: normalizeAnalyticsValue(replacement.productName),
      quantity: toOptionalInt(replacement.quantity),
      lineId: normalizeAnalyticsValue(replacement.lineId),
      articleUnitIds,
      articleReference: resolveArticleReference(
        articleLookup,
        orderIds,
        articleUnitIds,
        replacement
      ),
      fiscalDocNo: "",
      fiscalDocType: "",
      tableCancellationId: "",
      tableCancelledAt: "",
      tableCancelledByUserId: "",
      tableCancelledByUsername: "",
      tableCancellationReason: "",
      adjustmentKind: "",
      originalPaymentId: "",
      supersedesPaymentId: "",
      supersededByPaymentId: "",
      rechargePaymentIds: [],
      rechargeTransactionIds: [],
      raw: replacement,
    } satisfies AnalyticsMovementRecord;
  });
};

const localRecordToMovement = (record: AnalyticsTransactionRecord): AnalyticsMovementRecord => {
  const orderIds = uniq([record.orderId]);
  const method = normalizeAnalyticsValue(record.paymentMethod || "unknown");
  return {
    id: `local:${normalizeAnalyticsValue(record.id)}`,
    type: "payment",
    typeLabel: "Pagamento",
    amount: toNumber(record.amount),
    createdAt: toAnalyticsMovementTime(record.createdAt),
    operatorId: normalizeAnalyticsValue(record.operatorId),
    operatorName: normalizeAnalyticsValue(record.operatorName),
    method,
    methodLabel: analyticsMethodLabel(method),
    paymentSource: "",
    cashSource: "",
    automaticCashPaymentOperationId: "",
    tableId: normalizeAnalyticsValue(record.tableId),
    tableNumber: record.tableNumber,
    tableLabel: "",
    roomId: normalizeAnalyticsValue(record.roomId),
    // `description` e un'etichetta di tipo ("Pagamento tavolo"), gia detta dalla
    // pill del movimento, e il record del server non la riporta: mostrarla come
    // nota faceva comparire una riga che spariva al primo aggiornamento.
    note: "",
    orderIds,
    orderReference: formatOrderReference(orderIds),
    paymentId: normalizeAnalyticsValue(record.paymentId) || normalizeAnalyticsValue(record.id),
    transactionIds: [],
    transactions: [],
    splitMode: "",
    articleUnitIds: [],
    articleReference: "",
    fiscalDocNo: "",
    fiscalDocType: "",
    tableCancellationId: "",
    tableCancelledAt: "",
    tableCancelledByUserId: "",
    tableCancelledByUsername: "",
    tableCancellationReason: "",
    adjustmentKind: "",
    originalPaymentId: "",
    supersedesPaymentId: "",
    supersededByPaymentId: "",
    productName: "",
    lineId: "",
    rechargePaymentIds: [],
    rechargeTransactionIds: [],
  };
};

export const buildLocalAnalyticsMovementRecords = (records: AnalyticsTransactionRecord[]) =>
  records
    .filter((record) => record.kind === "payment")
    .map(localRecordToMovement)
    .sort(
      (left, right) =>
        toAnalyticsMovementTime(right.createdAt) - toAnalyticsMovementTime(left.createdAt)
    );

export const buildAnalyticsMovementRecordsFromReport = (
  report: unknown
): AnalyticsMovementRecord[] => {
  const articleLookup = buildArticleLookup(report);
  return [
    ...paymentRecords(report, articleLookup),
    ...stornoRecords(report, articleLookup),
    ...replacementRecords(report, articleLookup),
  ].sort(
    (left, right) =>
      toAnalyticsMovementTime(right.createdAt) - toAnalyticsMovementTime(left.createdAt)
  );
};

export const normalizeAnalyticsFiscalReceipt = (value: unknown): AnalyticsFiscalReceipt => {
  const receipt = asAnalyticsRecord(value);
  return {
    id: normalizeAnalyticsValue(receipt.id),
    paymentId: normalizeAnalyticsValue(receipt.paymentId),
    fiscalStatus: normalizeAnalyticsValue(receipt.fiscalStatus || receipt.status).toUpperCase(),
    fiscalProviderRef: normalizeAnalyticsValue(receipt.fiscalProviderRef),
    fiscalMovementId: normalizeAnalyticsValue(receipt.fiscalMovementId),
    fiscalReceiptDate: normalizeAnalyticsValue(receipt.fiscalReceiptDate),
    fiscalDocumentNumber: normalizeAnalyticsValue(receipt.fiscalDocumentNumber),
    fiscalError: normalizeAnalyticsValue(receipt.fiscalError),
    voidStatus: normalizeAnalyticsValue(receipt.voidStatus).toUpperCase(),
    voidedAt: normalizeAnalyticsValue(receipt.voidedAt),
    voidProviderRef: normalizeAnalyticsValue(receipt.voidProviderRef),
    voidMovementId: normalizeAnalyticsValue(receipt.voidMovementId),
    voidReceiptDate: normalizeAnalyticsValue(receipt.voidReceiptDate),
    voidDocumentNumber: normalizeAnalyticsValue(receipt.voidDocumentNumber),
    voidError: normalizeAnalyticsValue(receipt.voidError),
  };
};

export function applyFiscalReceiptToAnalyticsMovement(
  record: AnalyticsMovementRecord,
  receipt: AnalyticsFiscalReceipt
): AnalyticsMovementRecord {
  return {
    ...record,
    fiscalDocNo: receipt.fiscalDocumentNumber || receipt.fiscalProviderRef || record.fiscalDocNo,
    fiscalDocType: record.fiscalDocType || "RECEIPT",
    raw: {
      ...(record.raw ?? {}),
      fiscalReceiptId: receipt.id,
      fiscalStatus: receipt.fiscalStatus,
      fiscalProviderRef: receipt.fiscalProviderRef,
      fiscalMovementId: receipt.fiscalMovementId,
      fiscalReceiptDate: receipt.fiscalReceiptDate,
      fiscalDocumentNumber: receipt.fiscalDocumentNumber,
      fiscalError: receipt.fiscalError,
      voidStatus: receipt.voidStatus,
      voidedAt: receipt.voidedAt,
      voidProviderRef: receipt.voidProviderRef,
      voidMovementId: receipt.voidMovementId,
      voidReceiptDate: receipt.voidReceiptDate,
      voidDocumentNumber: receipt.voidDocumentNumber,
      voidError: receipt.voidError,
    },
  };
}
