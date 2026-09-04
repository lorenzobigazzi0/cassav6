import type { DiningTableOrder } from "../../../../api/tables";
import { expandOrderEmissionUnitAmounts } from "../../../../shared/pricing/orderEmissionPricing";

export type PaymentArticleUnit = {
  id: string;
  orderId: string;
  lineId: string;
  lineIndex: number;
  unitIndex: number;
  orderTitle: string;
  orderNumber: string;
  orderCreatedAt: number;
  name: string;
  note?: string;
  variantName?: string;
  amount: number;
  paid: boolean;
  adjustable: boolean;
};

export type PaymentArticleGroup = {
  orderId: string;
  orderTitle: string;
  orderNumber: string;
  orderCreatedAt: number;
  units: PaymentArticleUnit[];
};

type PayableTableSnapshot = {
  amountDue: number;
  orderHistory: DiningTableOrder[];
};

/**
 * Numero leggibile della comanda. Le comande che arrivano dall'integrazione
 * hanno gia un id numerico; per quelle locali l'id e tecnico e non va mostrato.
 */
export const getPaymentArticleOrderNumber = (orderId: string) =>
  /^\d{1,10}$/.test(orderId.trim()) ? orderId.trim().replace(/^0+(?=\d)/, "") : "";

export const formatPaymentArticleTime = (timestamp: number) =>
  new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));

export const getOrderPayableAmount = (order: DiningTableOrder) => {
  if (order.paymentStatus === "paid" || order.state === "paid") return 0;
  if (order.state !== "served" && order.workflowStatus !== "delivered") return 0;
  if (typeof order.dueAmount === "number" && Number.isFinite(order.dueAmount)) {
    return Math.max(0, order.dueAmount);
  }
  return Math.max(0, order.total);
};

export const isOrderPayable = (order: DiningTableOrder) => getOrderPayableAmount(order) > 0.009;

export const getOrdersPayableAmount = (orders: DiningTableOrder[]) =>
  Math.max(
    0,
    Math.round(orders.reduce((sum, order) => sum + getOrderPayableAmount(order), 0) * 100) / 100
  );

export const getTablePayableAmount = (table: PayableTableSnapshot | null | undefined) => {
  const payableAmount = getOrdersPayableAmount(table?.orderHistory ?? []);
  return payableAmount > 0.009 ? payableAmount : (table?.amountDue ?? 0);
};

const expandOrdersToUnits = (orders: DiningTableOrder[], includePaid: boolean) => {
  const units: PaymentArticleUnit[] = [];

  orders.forEach((order) => {
    const paidUnitSet = new Set(order.paidArticleUnits ?? []);
    const expandedLines: Array<{
      name: string;
      note?: string;
      variantName?: string;
      lineId: string;
      articleUnitId?: string;
      rowIndex: number;
      unitIndex: number;
    }> = [];

    order.lines.forEach((line, rowIndex) => {
      const qty = Math.max(1, Math.round(line.qty) || 1);
      for (let unitIndex = 0; unitIndex < qty; unitIndex += 1) {
        expandedLines.push({
          name: line.name,
          note: line.note,
          variantName: line.variantName,
          lineId: line.lineId ?? `line_${rowIndex + 1}`,
          articleUnitId: line.articleUnitIds?.[unitIndex],
          rowIndex,
          unitIndex,
        });
      }
    });

    if (expandedLines.length === 0) return;

    const emissionAmounts = expandOrderEmissionUnitAmounts({
      orderId: order.id,
      total: order.total,
      pricingMode: "preserve-line-prices",
      lines: order.lines.map((line) => ({
        qty: line.qty,
        unitBasePrice: line.unitBasePrice,
        unitFinalPrice: line.unitFinalPrice,
      })),
    });
    const amountByUnitId = new Map(emissionAmounts.map((unit) => [unit.id, unit.amount]));

    expandedLines.forEach((entry) => {
      const unitId = entry.articleUnitId || `${order.id}_${entry.rowIndex}_${entry.unitIndex}`;
      const amount = amountByUnitId.get(`${order.id}_${entry.rowIndex}_${entry.unitIndex}`) ?? 0;
      const stableIndexMatch = new RegExp(
        `^${order.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)_(\\d+)$`
      ).exec(unitId);
      const stableLineIndex = stableIndexMatch ? Number(stableIndexMatch[1]) : entry.rowIndex;
      const stableUnitIndex = stableIndexMatch ? Number(stableIndexMatch[2]) : entry.unitIndex;
      const paid = paidUnitSet.has(unitId);
      if (paid && !includePaid) return;

      units.push({
        id: unitId,
        orderId: order.id,
        lineId: entry.lineId,
        lineIndex: stableLineIndex,
        unitIndex: stableUnitIndex,
        orderTitle: order.title,
        orderNumber: getPaymentArticleOrderNumber(order.id),
        orderCreatedAt: order.createdAt,
        name: entry.name,
        note: entry.note,
        variantName: entry.variantName,
        amount,
        paid,
        adjustable: !paid && amount > 0,
      });
    });
  });

  // Ordine di emissione: e il contratto di questa funzione, e la rettifica dei
  // prezzi ci si appoggia. L'ordine alfabetico e una scelta di presentazione e
  // sta piu in basso, in `sortPaymentArticleUnitsByName`.
  return units;
};

export const expandOrderToArticleUnits = (orders: DiningTableOrder[]) =>
  expandOrdersToUnits(orders, false);

export const expandOrdersToAdjustmentUnits = (orders: DiningTableOrder[]) =>
  expandOrdersToUnits(orders, true);

/** Ordine alfabetico per nome, a parita di nome resta l'ordine della comanda. */
const comparePaymentArticleUnitsByName = (
  left: PaymentArticleUnit,
  right: PaymentArticleUnit
) =>
  left.name.localeCompare(right.name, "it-IT", { sensitivity: "base" }) ||
  left.lineIndex - right.lineIndex ||
  left.unitIndex - right.unitIndex;

/**
 * Elenco unico in ordine alfabetico. Fra articoli con lo stesso nome ma di
 * comande diverse vince la comanda piu recente, come nel raggruppamento.
 * Non muta l'array ricevuto.
 */
export const sortPaymentArticleUnitsByName = (articleUnits: PaymentArticleUnit[]) =>
  [...articleUnits].sort(
    (left, right) =>
      comparePaymentArticleUnitsByName(left, right) ||
      right.orderCreatedAt - left.orderCreatedAt
  );

export const groupPaymentArticleUnits = (articleUnits: PaymentArticleUnit[]) => {
  const groups = new Map<string, PaymentArticleGroup>();

  articleUnits.forEach((unit) => {
    const existing = groups.get(unit.orderId);
    if (existing) {
      existing.units.push(unit);
      return;
    }
    groups.set(unit.orderId, {
      orderId: unit.orderId,
      orderTitle: unit.orderTitle,
      orderNumber: unit.orderNumber,
      orderCreatedAt: unit.orderCreatedAt,
      units: [unit],
    });
  });

  groups.forEach((group) => {
    group.units.sort(comparePaymentArticleUnitsByName);
  });

  return [...groups.values()].sort((left, right) => right.orderCreatedAt - left.orderCreatedAt);
};
