import {
  OrdersRelationalRepository,
  ReservationsRelationalRepository,
  TablesBillsRelationalRepository,
  withRelationalTransaction,
} from "../../db/relational/index.js";

function text(value) {
  return String(value ?? "").trim();
}

function persistenceError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

const HTTP_STATUS_BY_ERROR_CODE = Object.freeze({
  RELATIONAL_TABLE_MOVE_DB_UNAVAILABLE: 503,
  RELATIONAL_TABLE_MOVE_TABLE_REVISION_CONFLICT: 409,
  RELATIONAL_TABLE_MOVE_ORDER_REVISION_CONFLICT: 409,
  RELATIONAL_TABLE_MOVE_ORDER_MISSING: 409,
  RELATIONAL_TABLE_MOVE_RESERVATION_CONFLICT: 409,
  RELATIONAL_TABLE_MOVE_INVALID: 400,
  RELATIONAL_TABLE_MOVE_TABLE_WRITE_FAILED: 400,
});

export function persistRelationalTableMove({
  relationalDb,
  appState,
  tableIds = [],
  movedOrders = [],
  reservationTransfer = null,
  requireRelationalOrders = false,
} = {}) {
  if (!relationalDb) {
    throw persistenceError(
      "RELATIONAL_TABLE_MOVE_DB_UNAVAILABLE",
      "DB relazionale tavoli non disponibile.",
    );
  }
  const normalizedTableIds = [
    ...new Set((Array.isArray(tableIds) ? tableIds : [tableIds]).map(text).filter(Boolean)),
  ];
  if (normalizedTableIds.length === 0) {
    throw persistenceError(
      "RELATIONAL_TABLE_MOVE_INVALID",
      "Tavoli dello spostamento non validi.",
    );
  }

  return withRelationalTransaction(relationalDb, () => {
    const tablesRepository = new TablesBillsRelationalRepository(relationalDb);
    const tableResult = tablesRepository.replaceTablesFromAppState(
      appState,
      normalizedTableIds,
      { enforceRevision: true, transaction: false },
    );
    if (tableResult?.reason === "revision_conflict") {
      throw persistenceError(
        "RELATIONAL_TABLE_MOVE_TABLE_REVISION_CONFLICT",
        "Conflitto revisione tavolo.",
        { conflicts: tableResult.conflicts ?? [] },
      );
    }
    if (!tableResult?.ok) {
      throw persistenceError(
        "RELATIONAL_TABLE_MOVE_TABLE_WRITE_FAILED",
        "Spostamento tavolo relazionale non valido.",
        { reason: tableResult?.reason ?? "unknown" },
      );
    }

    const ordersRepository = new OrdersRelationalRepository(relationalDb);
    const syncedOrderIds = [];
    const skippedOrderIds = [];
    for (const movedOrder of Array.isArray(movedOrders) ? movedOrders : []) {
      const orderId = text(movedOrder?.id);
      if (!orderId) continue;
      const current = ordersRepository.getOrderById(orderId);
      if (!current) {
        if (requireRelationalOrders) {
          throw persistenceError(
            "RELATIONAL_TABLE_MOVE_ORDER_MISSING",
            "Comanda relazionale dello spostamento non trovata.",
            { orderId },
          );
        }
        skippedOrderIds.push(orderId);
        continue;
      }
      const updated = ordersRepository.updateOrderLocationWithRevision(
        orderId,
        current.revision,
        {
          tableId: movedOrder.tableId,
          roomId: movedOrder.roomId,
          table: movedOrder.table,
          tableNumber: movedOrder.tableNumber,
          tableLabel: movedOrder.tableLabel,
          logicalTableLabel: movedOrder.logicalTableLabel,
          lastTableTransferAtMs: movedOrder.lastTableTransferAtMs,
          updatedAt: movedOrder.updatedAt,
        },
      );
      if (!updated) {
        throw persistenceError(
          "RELATIONAL_TABLE_MOVE_ORDER_REVISION_CONFLICT",
          "Conflitto revisione comanda durante lo spostamento tavolo.",
          { orderId, expectedRevision: current.revision },
        );
      }
      syncedOrderIds.push(orderId);
    }

    let reservationResult = null;
    if (reservationTransfer) {
      reservationResult = new ReservationsRelationalRepository(
        relationalDb,
      ).transferReservationTableAssignments(reservationTransfer, {
        transaction: false,
      });
      if (!reservationResult?.ok) {
        throw persistenceError(
          "RELATIONAL_TABLE_MOVE_RESERVATION_CONFLICT",
          "Conflitto assegnazione prenotazione durante lo spostamento tavolo.",
          {
            reason: reservationResult?.reason ?? "unknown",
            reservationId: reservationResult?.reservationId ?? null,
          },
        );
      }
    }

    return {
      ok: true,
      tableResult,
      syncedOrderIds,
      skippedOrderIds,
      reservationResult,
    };
  });
}

export async function persistRelationalTableMoveWithRuntime({
  relationalRuntime,
  httpErrorFactory,
  ...options
} = {}) {
  await relationalRuntime?.initialize?.();
  try {
    return persistRelationalTableMove({
      ...options,
      relationalDb: relationalRuntime?.db,
    });
  } catch (error) {
    const status = HTTP_STATUS_BY_ERROR_CODE[error?.code];
    if (!status || typeof httpErrorFactory !== "function") throw error;
    throw httpErrorFactory(status, error.message, {
      code: error.code,
      details: error.details,
    });
  }
}
