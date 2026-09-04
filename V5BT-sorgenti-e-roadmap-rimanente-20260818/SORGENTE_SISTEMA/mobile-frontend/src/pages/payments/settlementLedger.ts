import type {
  AnalyticsMovementRecord,
  AnalyticsRefundAllocation,
} from "../../api/analyticsPaymentMovements";

export type SettlementLedgerBucket = "cash" | "pos" | "other";

export type SettlementLedgerEntryKind =
  | "payment"
  | "pos_recharge"
  | "storno"
  | "cash_refund"
  | "pos_void"
  | "other_refund";

export type SettlementLedgerEntry = {
  id: string;
  sourceMovementId: string;
  sourceType: AnalyticsMovementRecord["type"];
  kind: SettlementLedgerEntryKind | string;
  bucket: SettlementLedgerBucket;
  amount: number;
  createdAt: number;
  operatorId: string;
  operatorName: string;
  method: string;
  methodLabel: string;
  paymentSource: string;
  cashSource: string;
  automaticCashPaymentOperationId: string;
  automaticCash: boolean;
  paymentId: string;
  transactionIds: string[];
  note: string;
};

export type SettlementLedgerBucketTotals = {
  cash: number;
  pos: number;
  other: number;
};

export type SettlementLedgerSummary = {
  gross: SettlementLedgerBucketTotals;
  refunds: SettlementLedgerBucketTotals;
  net: SettlementLedgerBucketTotals;
  posRechargeTotal: number;
  automaticCashTotal: number;
  cashDepositGrossTotal: number;
  cashDepositRefundTotal: number;
  cashDepositNetTotal: number;
  grossTotal: number;
  refundTotal: number;
  netTotal: number;
  entryCount: number;
  paymentEntryCount: number;
  refundEntryCount: number;
};

const normalize = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

export const roundLedgerMoney = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
};

const positiveMoney = (value: unknown) => Math.max(roundLedgerMoney(value), 0);

export const settlementBucketFromMethod = (
  method: unknown,
  methodLabel: unknown = ""
): SettlementLedgerBucket => {
  const haystack = normalize(`${method ?? ""} ${methodLabel ?? ""}`).toLowerCase();
  if (
    haystack.includes("cash") ||
    haystack.includes("contant") ||
    haystack.includes("contanti") ||
    haystack.includes("contante") ||
    haystack.includes("denaro")
  ) {
    return "cash";
  }
  if (
    haystack.includes("pos") ||
    haystack.includes("card") ||
    haystack.includes("carta") ||
    haystack.includes("bancomat") ||
    haystack.includes("credito") ||
    haystack.includes("debit")
  ) {
    return "pos";
  }
  return "other";
};

const allocationNegativeAmount = (allocation: AnalyticsRefundAllocation) => {
  const voidAmount = positiveMoney(allocation.voidAmount);
  const refundAmount = positiveMoney(allocation.refundAmount);
  const amountToSubtract = voidAmount > 0 ? voidAmount : refundAmount;
  return roundLedgerMoney(-amountToSubtract);
};

const entryKindFromAllocation = (
  allocation: AnalyticsRefundAllocation,
  bucket: SettlementLedgerBucket
): SettlementLedgerEntryKind | string => {
  const action = normalize(allocation.action);
  if (action) return action;
  if (bucket === "cash") return "cash_refund";
  if (bucket === "pos" && positiveMoney(allocation.voidAmount) > 0) return "pos_void";
  if (bucket === "pos") return "storno";
  return "other_refund";
};

const isAutomaticCashPayment = (record: AnalyticsMovementRecord): boolean => {
  const transactions = Array.isArray(record.transactions) ? record.transactions : [];
  const hasOperationId =
    normalize(record.automaticCashPaymentOperationId).length > 0 ||
    transactions.some((tx) => normalize(tx.automaticCashPaymentOperationId).length > 0);
  if (hasOperationId) return true;
  const sourceValues = [record.paymentSource, record.cashSource].concat(
    transactions.flatMap((tx) => [tx.paymentSource, tx.cashSource])
  );
  return sourceValues.some((value) => {
    const normalized = normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, " ");
    return (
      normalized === "automatic" ||
      normalized === "automatic cash" ||
      normalized.includes("automatic cash")
    );
  });
};

const buildPaymentLedgerEntry = (record: AnalyticsMovementRecord): SettlementLedgerEntry[] => {
  const amount = roundLedgerMoney(record.amount);
  if (amount === 0) return [];
  const bucket = settlementBucketFromMethod(record.method, record.methodLabel);
  const adjustmentKind = normalize(record.adjustmentKind);
  const automaticCash = bucket === "cash" && isAutomaticCashPayment(record);
  return [
    {
      id: `ledger:${record.id}`,
      sourceMovementId: record.id,
      sourceType: record.type,
      kind: automaticCash
        ? "automatic_cash_payment"
        : adjustmentKind === "pos_recharge_after_full_void"
          ? "pos_recharge"
          : "payment",
      bucket,
      amount,
      createdAt: record.createdAt,
      operatorId: normalize(record.operatorId),
      operatorName: normalize(record.operatorName),
      method: normalize(record.method),
      methodLabel: normalize(record.methodLabel),
      paymentSource: normalize(record.paymentSource),
      cashSource: normalize(record.cashSource),
      automaticCashPaymentOperationId: normalize(record.automaticCashPaymentOperationId),
      automaticCash,
      paymentId: normalize(record.paymentId),
      transactionIds: Array.isArray(record.transactionIds) ? record.transactionIds : [],
      note: normalize(record.note),
    },
  ];
};

const buildStornoLedgerEntries = (record: AnalyticsMovementRecord): SettlementLedgerEntry[] => {
  const allocations = Array.isArray(record.refundPlan?.allocations)
    ? record.refundPlan.allocations
    : [];

  if (allocations.length > 0) {
    return allocations
      .map((allocation, index): SettlementLedgerEntry | null => {
        const amount = allocationNegativeAmount(allocation);
        if (amount === 0) return null;
        const bucket = settlementBucketFromMethod(allocation.method, allocation.action);
        return {
          id: `ledger:${record.id}:allocation:${index}`,
          sourceMovementId: record.id,
          sourceType: record.type,
          kind: entryKindFromAllocation(allocation, bucket),
          bucket,
          amount,
          createdAt: record.createdAt,
          operatorId: normalize(record.operatorId),
          operatorName: normalize(record.operatorName),
          method: normalize(allocation.method || record.method),
          methodLabel: normalize(record.methodLabel),
          paymentSource: "",
          cashSource: "",
          automaticCashPaymentOperationId: "",
          automaticCash: false,
          paymentId: normalize(allocation.paymentId || record.paymentId),
          transactionIds: Array.isArray(allocation.transactionIds) ? allocation.transactionIds : [],
          note: normalize(record.note),
        };
      })
      .filter((entry): entry is SettlementLedgerEntry => Boolean(entry));
  }

  const amount = roundLedgerMoney(record.amount);
  if (amount === 0) return [];
  return [
    {
      id: `ledger:${record.id}`,
      sourceMovementId: record.id,
      sourceType: record.type,
      kind: "storno",
      bucket: settlementBucketFromMethod(record.method, record.methodLabel),
      amount,
      createdAt: record.createdAt,
      operatorId: normalize(record.operatorId),
      operatorName: normalize(record.operatorName),
      method: normalize(record.method),
      methodLabel: normalize(record.methodLabel),
      paymentSource: "",
      cashSource: "",
      automaticCashPaymentOperationId: "",
      automaticCash: false,
      paymentId: normalize(record.paymentId),
      transactionIds: Array.isArray(record.transactionIds) ? record.transactionIds : [],
      note: normalize(record.note),
    },
  ];
};

export const buildSettlementLedgerEntries = (
  movements: AnalyticsMovementRecord[]
): SettlementLedgerEntry[] =>
  movements.flatMap((record) => {
    if (record.type === "payment") return buildPaymentLedgerEntry(record);
    if (record.type === "storno") return buildStornoLedgerEntries(record);
    return [];
  });

const emptyBucketTotals = (): SettlementLedgerBucketTotals => ({
  cash: 0,
  pos: 0,
  other: 0,
});

const roundBucketTotals = (totals: SettlementLedgerBucketTotals): SettlementLedgerBucketTotals => ({
  cash: roundLedgerMoney(totals.cash),
  pos: roundLedgerMoney(totals.pos),
  other: roundLedgerMoney(totals.other),
});

const sumBuckets = (totals: SettlementLedgerBucketTotals) =>
  roundLedgerMoney(totals.cash + totals.pos + totals.other);

export const summarizeSettlementLedger = (
  entries: SettlementLedgerEntry[]
): SettlementLedgerSummary => {
  const gross = emptyBucketTotals();
  const refunds = emptyBucketTotals();
  const net = emptyBucketTotals();
  let posRechargeTotal = 0;
  let automaticCashTotal = 0;
  let paymentEntryCount = 0;
  let refundEntryCount = 0;

  entries.forEach((entry) => {
    const amount = roundLedgerMoney(entry.amount);
    if (amount === 0) return;
    net[entry.bucket] = roundLedgerMoney(net[entry.bucket] + amount);
    if (amount > 0) {
      if (entry.bucket === "cash" && entry.automaticCash) {
        automaticCashTotal = roundLedgerMoney(automaticCashTotal + amount);
      }
      if (entry.bucket === "pos" && entry.kind === "pos_recharge") {
        posRechargeTotal = roundLedgerMoney(posRechargeTotal + amount);
      } else {
        gross[entry.bucket] = roundLedgerMoney(gross[entry.bucket] + amount);
      }
      paymentEntryCount += 1;
    } else {
      refunds[entry.bucket] = roundLedgerMoney(refunds[entry.bucket] + Math.abs(amount));
      refundEntryCount += 1;
    }
  });

  const roundedGross = roundBucketTotals(gross);
  const roundedRefunds = roundBucketTotals(refunds);
  const roundedNet = roundBucketTotals(net);
  const roundedAutomaticCashTotal = roundLedgerMoney(automaticCashTotal);

  return {
    gross: roundedGross,
    refunds: roundedRefunds,
    net: roundedNet,
    posRechargeTotal: roundLedgerMoney(posRechargeTotal),
    automaticCashTotal: roundedAutomaticCashTotal,
    cashDepositGrossTotal: roundLedgerMoney(roundedGross.cash - roundedAutomaticCashTotal),
    cashDepositRefundTotal: roundedRefunds.cash,
    cashDepositNetTotal: roundLedgerMoney(roundedNet.cash - roundedAutomaticCashTotal),
    grossTotal: sumBuckets(roundedGross),
    refundTotal: sumBuckets(roundedRefunds),
    netTotal: sumBuckets(roundedNet),
    entryCount: entries.length,
    paymentEntryCount,
    refundEntryCount,
  };
};
