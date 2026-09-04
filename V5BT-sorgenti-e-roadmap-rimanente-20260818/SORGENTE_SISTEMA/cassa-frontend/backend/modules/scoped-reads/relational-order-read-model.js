import { OrdersRelationalRepository } from "../../db/relational/index.js";
import {
  findScopedOpenOrderForTable,
  normalizeScopedReadId,
} from "./scoped-reads.domain.js";

function sanitizeRelationalScopedOrder(order) {
  if (!order || typeof order !== "object") return null;
  const id = normalizeScopedReadId(order.id);
  if (!id) return null;
  return {
    ...order,
    id,
    tableId: normalizeScopedReadId(order.tableId),
    roomId: normalizeScopedReadId(order.roomId),
  };
}

export function createRelationalScopedOrderReader(options = {}) {
  const {
    enabled = false,
    logger = console,
    relationalRuntime = null,
  } = options;

  async function createRepository() {
    if (!enabled || !relationalRuntime) return null;
    await relationalRuntime.initialize?.();
    if (!relationalRuntime.db) return null;
    return new OrdersRelationalRepository(relationalRuntime.db);
  }

  async function findOpenOrderForTable(tableId) {
    const id = normalizeScopedReadId(tableId);
    if (!id) return null;
    try {
      const repository = await createRepository();
      if (!repository) return null;
      const orders = repository
        .listOrders({ tableId: id })
        .map(sanitizeRelationalScopedOrder)
        .filter(Boolean);
      return {
        order: findScopedOpenOrderForTable(orders, id),
      };
    } catch (error) {
      logger.warn?.(
        `[scoped-reads] relational open order fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  return {
    enabled,
    findOpenOrderForTable,
  };
}
