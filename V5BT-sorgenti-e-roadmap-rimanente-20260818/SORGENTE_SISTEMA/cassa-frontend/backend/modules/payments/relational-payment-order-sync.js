import { OrdersRelationalRepository } from "../../db/relational/index.js";

export function createRelationalPaymentOrderStateSync({
  relationalOrdersAnyWritePrimary = false,
  normalizeIntegrationOrderWriteIds,
  findIntegrationOrderIndexByLookup,
  sanitizeIntegrationOrder,
  clampInt,
  roundMoney,
  nowIso,
  HttpError,
  runtimeMetrics,
} = {}) {
  return function syncRelationalPaymentOrderStatesFromAppState(
    connection,
    { appState, orderIds, source = "payments" } = {},
  ) {
    const ids = normalizeIntegrationOrderWriteIds(orderIds);
    if (!relationalOrdersAnyWritePrimary || ids.length === 0) {
      return { synced: 0, skipped: ids.length, orderIds: [] };
    }
    const startedAt = Date.now();
    try {
      const orders = Array.isArray(appState?.integration?.orders)
        ? appState.integration.orders
        : [];
      const repo = new OrdersRelationalRepository(connection);
      const syncedOrderIds = [];
      const skippedOrderIds = [];
      ids.forEach((orderId) => {
        const orderIndex = findIntegrationOrderIndexByLookup(orders, orderId);
        if (orderIndex < 0) {
          skippedOrderIds.push(orderId);
          return;
        }
        const appOrder = sanitizeIntegrationOrder(orders[orderIndex], orderId);
        const relationalOrder = repo.getOrderById(appOrder.id);
        if (!relationalOrder) {
          skippedOrderIds.push(orderId);
          return;
        }
        const currentRevision = clampInt(
          relationalOrder.revision ?? relationalOrder.currentRevision,
          1,
          1_000_000,
          1,
        );
        const nextRevision = currentRevision + 1;
        const paymentStatus =
          String(appOrder.paymentStatus ?? "").trim() ||
          String(relationalOrder.paymentStatus ?? "").trim() ||
          "unpaid";
        const updatedAt =
          appOrder.updatedAt ?? relationalOrder.updatedAt ?? nowIso();
        const paidAt =
          appOrder.paidAt ??
          appOrder.paymentCompletedAt ??
          relationalOrder.paidAt ??
          relationalOrder.paymentCompletedAt ??
          (paymentStatus.toLowerCase() === "paid" ? updatedAt : null);
        const appTransferAt = Math.max(
          0,
          Number(appOrder.lastTableTransferAtMs) || 0,
        );
        const relationalTransferAt = Math.max(
          0,
          Number(relationalOrder.lastTableTransferAtMs) || 0,
        );
        const appLocationIsNewer = appTransferAt > relationalTransferAt;
        const nextOrder = sanitizeIntegrationOrder(
          {
            ...relationalOrder,
            ...(appLocationIsNewer
              ? {
                  tableId: appOrder.tableId,
                  roomId: appOrder.roomId,
                  table: appOrder.table,
                  tableNumber: appOrder.tableNumber,
                  tableLabel: appOrder.tableLabel,
                  logicalTableLabel: appOrder.logicalTableLabel,
                  lastTableTransferAtMs: appOrder.lastTableTransferAtMs,
                }
              : {}),
            total: roundMoney(
              Math.max(Number(appOrder.total ?? relationalOrder.total) || 0, 0),
            ),
            paidAmount: roundMoney(
              Math.max(
                Number(appOrder.paidAmount ?? relationalOrder.paidAmount) || 0,
                0,
              ),
            ),
            dueAmount: roundMoney(
              Math.max(
                Number(appOrder.dueAmount ?? relationalOrder.dueAmount) || 0,
                0,
              ),
            ),
            paymentStatus,
            paidArticleUnits: Array.isArray(appOrder.paidArticleUnits)
              ? appOrder.paidArticleUnits
              : relationalOrder.paidArticleUnits,
            paymentCompletedAt:
              appOrder.paymentCompletedAt ??
              relationalOrder.paymentCompletedAt ??
              paidAt,
            paymentCompletedAtMs:
              appOrder.paymentCompletedAtMs ??
              relationalOrder.paymentCompletedAtMs,
            paidAt,
            adminPaymentAdjustments: Array.isArray(
              appOrder.adminPaymentAdjustments,
            )
              ? appOrder.adminPaymentAdjustments
              : relationalOrder.adminPaymentAdjustments,
            updatedAt,
            revision: nextRevision,
            currentRevision: nextRevision,
          },
          appOrder.id,
        );
        const result = repo.replaceOrderWithRevision(
          nextOrder,
          currentRevision,
          { transaction: false },
        );
        if (!result?.order) {
          throw new HttpError(
            409,
            "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.",
            {
              code: "REVISION_CONFLICT",
              details: { orderId: appOrder.id, source, currentRevision },
            },
          );
        }
        orders[orderIndex] = result.order;
        syncedOrderIds.push(appOrder.id);
      });
      return {
        synced: syncedOrderIds.length,
        skipped: skippedOrderIds.length,
        orderIds: syncedOrderIds,
        skippedOrderIds,
      };
    } finally {
      runtimeMetrics?.recordOperation?.(
        "orderWorkflow",
        "payments.orders.relationalPaymentStateSync",
        Date.now() - startedAt,
      );
    }
  };
}
