import type { DiningTableOrder, DiningTableOrderLine, TableOrderState } from "./types";
import type { IntegrationOrder, IntegrationOrderItem } from "./integrationTypes";

const asMoney = (value: number) => Math.round(value * 100) / 100;

export const isTerminalIntegrationWorkflowStatus = (
  workflowStatus: IntegrationOrder["workflowStatus"]
) => workflowStatus === "delivered" || workflowStatus === "cancelled";

export const isIntegrationOrderOpen = (
  order: Pick<IntegrationOrder, "workflowStatus" | "paymentStatus">
) =>
  order.workflowStatus !== "cancelled" &&
  (order.workflowStatus !== "delivered" || order.paymentStatus !== "paid");

export const buildIntegrationOrderFingerprint = (order: IntegrationOrder) => ({
  id: order.id,
  currentRevision: order.currentRevision,
  roomId: order.roomId,
  tableId: order.tableId,
  tableNumber: order.tableNumber,
  title: order.title,
  total: order.total,
  workflowStatus: order.workflowStatus,
  paymentStatus: order.paymentStatus,
  dueAmount: order.dueAmount,
  paidAmount: order.paidAmount,
  orderNote: order.orderNote,
  orderComment: order.orderComment,
  createdAtMs: order.createdAtMs,
  updatedAtMs: order.updatedAtMs,
  items: order.items
    .map((item) => ({
      id: item.id,
      lineId: item.lineId,
      qty: item.qty,
      productId: item.productId,
      name: item.name,
      variantName: item.variant,
      note: item.note,
      modifiers: item.modifiers,
      unitFinalPrice: item.unitPriceApplied,
      unitBasePrice: item.listPriceAtTime,
      lineType: item.lineType,
      voidedAt: item.voidedAt,
      done: item.done,
    }))
    .sort((left, right) =>
      `${left.lineId}|${left.id}|${left.productId}|${left.name}`.localeCompare(
        `${right.lineId}|${right.id}|${right.productId}|${right.name}`,
        "it"
      )
    ),
});

export const groupIntegrationOrderLines = (
  items: IntegrationOrderItem[],
  compAvailability?: IntegrationOrder["compAvailability"],
  orderId = ""
): DiningTableOrderLine[] => {
  if (items.length === 0) return [];
  const grouped = new Map<string, DiningTableOrderLine>();
  const lineIndexByLineId = new Map<string, number>();
  const nextUnitIndexByLineId = new Map<string, number>();
  items
    .filter((item) => !item.voidedAt && item.lineType.toUpperCase() !== "BAR_CHARGE_REPLACEMENT")
    .forEach((item) => {
      const lineId = item.lineId || item.id;
      if (!lineIndexByLineId.has(lineId)) lineIndexByLineId.set(lineId, lineIndexByLineId.size);
      const lineIndex = lineIndexByLineId.get(lineId) ?? 0;
      const quantity = Math.max(1, Math.trunc(Number(item.qty) || 1));
      const startUnitIndex = nextUnitIndexByLineId.get(lineId) ?? 0;
      nextUnitIndexByLineId.set(lineId, startUnitIndex + quantity);
      const unitIds = Array.from({ length: quantity }, (_, offset) =>
        orderId ? `${orderId}_${lineIndex}_${startUnitIndex + offset}` : ""
      ).filter(Boolean);
      const unitFinalPrice = asMoney(item.unitPriceApplied);
      const unitBasePrice = asMoney(item.listPriceAtTime || unitFinalPrice);
      const key = [lineId, unitFinalPrice, unitBasePrice, item.variant, item.note].join("|");
      const existing = grouped.get(key);
      if (existing) {
        existing.qty += quantity;
        existing.articleUnitIds = [...(existing.articleUnitIds ?? []), ...unitIds];
        return;
      }
      grouped.set(key, {
        lineId: lineId || undefined,
        articleUnitIds: unitIds,
        productId: item.productId || undefined,
        name: item.name,
        qty: quantity,
        note: item.note || undefined,
        variantName: item.variant || undefined,
        modifiers: item.modifiers,
        unitBasePrice,
        unitFinalPrice,
        vatRate: item.vatRate,
        vatCode: item.vatCode,
        priceDelta: asMoney(unitFinalPrice - unitBasePrice),
        priceChanged: Math.abs(unitFinalPrice - unitBasePrice) > 0.009,
        priceChangeReason: Math.abs(unitFinalPrice - unitBasePrice) > 0.009 ? "manual" : undefined,
      });
    });
  return [...grouped.values()].map((line) => {
    const availability =
      (line.lineId ? compAvailability?.byLine?.[line.lineId] : undefined) ??
      (line.productId ? compAvailability?.byProduct?.[line.productId] : undefined);
    if (!availability) return line;
    const availableQuantity = Math.max(
      0,
      Math.min(line.qty, Math.trunc(Number(availability.availableQuantity) || 0))
    );
    const compedQuantity = Math.max(0, Math.trunc(Number(availability.compedQuantity) || 0));
    return {
      ...line,
      serviceRecoveryAvailableQuantity: availableQuantity,
      serviceRecoveryCompedQuantity: compedQuantity,
    };
  });
};

export const deriveOrderStateFromIntegration = (order: IntegrationOrder): TableOrderState => {
  if (order.paymentStatus === "paid") return "paid";
  if (order.workflowStatus === "delivered") return "served";
  return "in_progress";
};

export const toDiningOrderFromIntegration = (order: IntegrationOrder): DiningTableOrder => ({
  id: order.id,
  currentRevision: order.currentRevision,
  title: order.title || `Ordine #${order.id}`,
  createdAt: order.createdAtMs,
  total: order.total,
  state: deriveOrderStateFromIntegration(order),
  workflowStatus: order.workflowStatus,
  paymentStatus: order.paymentStatus,
  dueAmount: order.dueAmount,
  paidAmount: order.paidAmount,
  orderNote: order.orderNote || undefined,
  orderComment: order.orderComment || undefined,
  paidArticleUnits: [...order.paidArticleUnits],
  lines: groupIntegrationOrderLines(order.items, order.compAvailability, order.id),
});
