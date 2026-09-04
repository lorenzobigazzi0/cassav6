function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeLookup(value) {
  return normalize(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function roundSettlementMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
}

function positiveMoney(value) {
  return Math.max(roundSettlementMoney(value), 0);
}

export function settlementBucketFromMethod(method, methodLabel = "") {
  const haystack = normalizeLookup(`${method ?? ""} ${methodLabel ?? ""}`);
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
    haystack.includes("debit") ||
    haystack.includes("elettron")
  ) {
    return "pos";
  }
  return "other";
}

function paymentStatusAllowsSettlement(payment) {
  const status = normalizeLookup(payment?.status);
  if (!status) return true;
  return ["completed", "paid", "closed", "complete"].includes(status);
}

function paymentMethod(payment) {
  return payment?.paymentMethod ?? payment?.methodId ?? payment?.method ?? payment?.type ?? "";
}

function paymentMethodLabel(payment) {
  return payment?.methodLabel ?? payment?.label ?? payment?.paymentLabel ?? "";
}

function isAutomaticCashPayment(payment) {
  const operationId = normalize(
    payment?.automaticCashPaymentOperationId ??
      payment?.automaticCashOperationId ??
      payment?.cashOperationId,
  );
  if (operationId) return true;
  const haystack = normalizeLookup(
    `${payment?.paymentSource ?? ""} ${payment?.cashSource ?? ""}`,
  );
  return (
    haystack === "automatic" ||
    haystack === "automatic cash" ||
    haystack.includes("automatic cash")
  );
}

function paymentAmount(payment) {
  return roundSettlementMoney(payment?.amount ?? payment?.total ?? payment?.amountPaid ?? 0);
}

function allocationNegativeAmount(allocation) {
  const voidAmount = positiveMoney(allocation?.voidAmount);
  const refundAmount = positiveMoney(
    allocation?.refundAmount ?? allocation?.amount ?? allocation?.paymentStornoAmount,
  );
  const amountToSubtract = voidAmount > 0 ? voidAmount : refundAmount;
  return roundSettlementMoney(-amountToSubtract);
}

function entryKindFromAllocation(allocation, bucket) {
  const action = normalize(allocation?.action);
  if (action) return action;
  if (bucket === "cash") return "cash_refund";
  if (bucket === "pos" && positiveMoney(allocation?.voidAmount) > 0) return "pos_void";
  if (bucket === "pos") return "storno";
  return "other_refund";
}

function buildPaymentLedgerEntries(payments = []) {
  return payments.flatMap((payment, index) => {
    if (!payment || typeof payment !== "object") return [];
    if (!paymentStatusAllowsSettlement(payment)) return [];
    const amount = paymentAmount(payment);
    if (amount <= 0) return [];
    const adjustmentKind = normalize(payment?.adjustmentKind);
    const id = normalize(payment?.id) || `payment_${index + 1}`;
    const bucket = settlementBucketFromMethod(paymentMethod(payment), paymentMethodLabel(payment));
    const automaticCash = bucket === "cash" && isAutomaticCashPayment(payment);
    return [
      {
        id: `payment:${id}`,
        sourceType: "payment",
        kind: automaticCash
          ? "automatic_cash_payment"
          : adjustmentKind === "pos_recharge_after_full_void"
            ? "pos_recharge"
            : "payment",
        bucket,
        automaticCash,
        amount,
        createdAt: normalize(payment?.createdAt ?? payment?.paidAt ?? payment?.completedAt),
        paymentId: id,
        originalPaymentId: normalize(payment?.originalPaymentId),
      },
    ];
  });
}

function fallbackCompAmount(comp) {
  const amount =
    positiveMoney(comp?.paymentStornoAmount) ||
    positiveMoney(comp?.paymentVoidAmount) ||
    positiveMoney(comp?.paidAmount) ||
    positiveMoney(comp?.amount);
  return roundSettlementMoney(-amount);
}

function buildCompLedgerEntries(comps = []) {
  return comps.flatMap((comp, compIndex) => {
    if (!comp || typeof comp !== "object") return [];
    const financialImpact = normalizeLookup(comp?.financialImpact ?? comp?.replacementSettlement);
    const refundPlanStatus = normalizeLookup(comp?.refundPlan?.status);
    if (
      comp.nonFinancialReplacement === true ||
      refundPlanStatus === "not required" ||
      refundPlanStatus === "not_required" ||
      financialImpact === "none" ||
      financialImpact === "non financial" ||
      financialImpact === "non_financial"
    ) {
      return [];
    }
    const compId = normalize(comp?.id) || `comp_${compIndex + 1}`;
    const allocations = Array.isArray(comp?.refundPlan?.allocations)
      ? comp.refundPlan.allocations
      : [];
    if (allocations.length > 0) {
      return allocations.flatMap((allocation, allocationIndex) => {
        const amount = allocationNegativeAmount(allocation);
        if (amount === 0) return [];
        const bucket = settlementBucketFromMethod(allocation?.method, allocation?.action);
        return [
          {
            id: `storno:${compId}:allocation:${allocationIndex}`,
            sourceType: "storno",
            kind: entryKindFromAllocation(allocation, bucket),
            bucket,
            amount,
            createdAt: normalize(comp?.createdAt),
            paymentId: normalize(allocation?.paymentId),
            compId,
          },
        ];
      });
    }

    const amount = fallbackCompAmount(comp);
    if (amount === 0) return [];
    return [
      {
        id: `storno:${compId}`,
        sourceType: "storno",
        kind: "storno",
        bucket: settlementBucketFromMethod(
          comp?.method ?? comp?.paymentMethod,
          comp?.methodLabel ?? comp?.paymentMethodLabel,
        ),
        amount,
        createdAt: normalize(comp?.createdAt),
        paymentId: compId,
        compId,
      },
    ];
  });
}

export function buildSettlementLedgerEntries({ payments = [], comps = [] } = {}) {
  return [
    ...buildPaymentLedgerEntries(Array.isArray(payments) ? payments : []),
    ...buildCompLedgerEntries(Array.isArray(comps) ? comps : []),
  ];
}

export function buildSettlementLedgerFromSalesReport(report = {}) {
  const paymentsTracking =
    report?.paymentsTracking && typeof report.paymentsTracking === "object"
      ? report.paymentsTracking
      : {};
  const serviceRecovery =
    report?.serviceRecovery && typeof report.serviceRecovery === "object"
      ? report.serviceRecovery
      : {};
  const parts = Array.isArray(paymentsTracking.parts) ? paymentsTracking.parts : [];
  const transactions = Array.isArray(paymentsTracking.transactions)
    ? paymentsTracking.transactions
    : [];
  const partsByPaymentId = new Map();
  for (const part of parts) {
    const paymentId = normalize(part?.paymentId);
    if (!paymentId) continue;
    const bucket = partsByPaymentId.get(paymentId) ?? [];
    bucket.push(part);
    partsByPaymentId.set(paymentId, bucket);
  }
  const transactionsByPartId = new Map();
  for (const transaction of transactions) {
    const partId = normalize(transaction?.partId);
    if (!partId) continue;
    const bucket = transactionsByPartId.get(partId) ?? [];
    bucket.push(transaction);
    transactionsByPartId.set(partId, bucket);
  }
  const containers = Array.isArray(paymentsTracking.containers)
    ? paymentsTracking.containers
    : [];
  const payments = containers.flatMap((container) => {
    const paymentId = normalize(container?.id);
    const paymentParts = partsByPaymentId.get(paymentId) ?? [];
    const paymentTransactions = paymentParts.flatMap((part) => transactionsByPartId.get(normalize(part?.id)) ?? []);
    if (paymentTransactions.length === 0) return [container];
    return paymentTransactions.map((transaction) => ({
      ...container,
      id: `${paymentId}:${normalize(transaction?.id)}`,
      amount: transaction?.amountPaid,
      paymentMethod: transaction?.method,
      methodLabel: transaction?.method,
      paymentSource: transaction?.paymentSource ?? container?.paymentSource,
      cashSource: transaction?.cashSource ?? container?.cashSource,
      automaticCashPaymentOperationId:
        transaction?.automaticCashPaymentOperationId ??
        container?.automaticCashPaymentOperationId,
      paymentTransactionId: normalize(transaction?.id),
    }));
  });
  return buildSettlementLedgerEntries({
    payments,
    comps: Array.isArray(serviceRecovery.comps) ? serviceRecovery.comps : [],
  });
}

const emptyBuckets = () => ({ cash: 0, pos: 0, other: 0 });

function sumBuckets(value) {
  return roundSettlementMoney(value.cash + value.pos + value.other);
}

export function summarizeSettlementLedger(ledger = []) {
  const gross = emptyBuckets();
  const refunds = emptyBuckets();
  const net = emptyBuckets();
  let posRechargeTotal = 0;
  let automaticCashTotal = 0;
  let paymentEntryCount = 0;
  let refundEntryCount = 0;

  for (const entry of Array.isArray(ledger) ? ledger : []) {
    const bucket = ["cash", "pos", "other"].includes(entry?.bucket) ? entry.bucket : "other";
    const amount = roundSettlementMoney(entry?.amount);
    if (amount === 0) continue;
    net[bucket] = roundSettlementMoney(net[bucket] + amount);
    if (amount > 0) {
      if (bucket === "cash" && entry?.automaticCash === true) {
        automaticCashTotal = roundSettlementMoney(automaticCashTotal + amount);
      }
      if (bucket === "pos" && entry?.kind === "pos_recharge") {
        posRechargeTotal = roundSettlementMoney(posRechargeTotal + amount);
      } else {
        gross[bucket] = roundSettlementMoney(gross[bucket] + amount);
      }
      paymentEntryCount += 1;
    } else {
      refunds[bucket] = roundSettlementMoney(refunds[bucket] + Math.abs(amount));
      refundEntryCount += 1;
    }
  }

  return {
    gross,
    refunds,
    net,
    grossTotal: sumBuckets(gross),
    refundTotal: sumBuckets(refunds),
    netTotal: sumBuckets(net),
    cashGrossTotal: gross.cash,
    cashRefundTotal: refunds.cash,
    cashNetTotal: net.cash,
    automaticCashTotal: roundSettlementMoney(automaticCashTotal),
    cashDepositGrossTotal: roundSettlementMoney(gross.cash - automaticCashTotal),
    cashDepositRefundTotal: refunds.cash,
    cashDepositNetTotal: roundSettlementMoney(net.cash - automaticCashTotal),
    posGrossTotal: gross.pos,
    posRefundTotal: refunds.pos,
    posRechargeTotal: roundSettlementMoney(posRechargeTotal),
    posNetTotal: net.pos,
    otherGrossTotal: gross.other,
    otherRefundTotal: refunds.other,
    otherNetTotal: net.other,
    entryCount: Array.isArray(ledger) ? ledger.length : 0,
    paymentEntryCount,
    refundEntryCount,
  };
}

export function buildSettlementTotals(input = {}) {
  return summarizeSettlementLedger(buildSettlementLedgerEntries(input));
}
