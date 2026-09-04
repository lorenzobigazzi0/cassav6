import { OrdersRelationalRepository } from "../../db/relational/index.js";

function text(value) {
  return String(value ?? "").trim();
}

async function requireRelationalOrdersDb(relationalRuntime) {
  await relationalRuntime?.initialize?.();
  const db = relationalRuntime?.db;
  if (!db) {
    throw new Error("DB relazionale orders non disponibile per write-primary.");
  }
  return db;
}

function recordOrderWorkflowMetric(runtimeMetrics, label, startedAt) {
  runtimeMetrics?.recordOperation?.("orderWorkflow", label, Date.now() - startedAt);
}

function uniqueTexts(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const next = text(value);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

function listScopedRelationalOrders(repository, { orderId, stationId, stationIds, tableId, tableIds } = {}, options = {}) {
  const orderIds = uniqueTexts(orderId);
  const targetStationIds = uniqueTexts([
    stationId,
    ...(Array.isArray(stationIds) ? stationIds : [stationIds]),
  ]);
  const targetTableIds = uniqueTexts([
    tableId,
    ...(Array.isArray(tableIds) ? tableIds : [tableIds]),
  ]);
  const workflowStatuses = uniqueTexts(options.workflowStatuses);
  const listScopedOrders =
    options.workflowLight === true && typeof repository.listWorkflowOrders === "function"
      ? (filters) => repository.listWorkflowOrders(filters)
      : (filters) => repository.listOrders(filters);
  if (orderIds.length === 0 && targetStationIds.length === 0 && targetTableIds.length === 0) {
    return listScopedOrders(workflowStatuses.length > 0 ? { statuses: workflowStatuses } : {});
  }

  const byId = new Map();
  const addOrder = (order) => {
    const id = text(order?.id);
    if (!id || byId.has(id)) return;
    byId.set(id, order);
  };
  orderIds.forEach((id) => addOrder(repository.getOrderById(id)));
  if (targetStationIds.length > 0) listScopedOrders({ stationIds: targetStationIds, ...(workflowStatuses.length > 0 ? { statuses: workflowStatuses } : {}) }).forEach(addOrder);
  if (targetTableIds.length > 0) listScopedOrders({ tableIds: targetTableIds }).forEach(addOrder);
  return [...byId.values()];
}

export async function findRelationalOrderCreateIdempotencyRecord({
  deviceUuid,
  enabled = false,
  idempotencyKey,
  relationalRuntime,
  user,
} = {}) {
  const safeKey = text(idempotencyKey);
  if (!enabled || !safeKey) return null;
  const db = await requireRelationalOrdersDb(relationalRuntime);
  return new OrdersRelationalRepository(db).findOrderByIdempotencyKey(safeKey, {
    deviceUuid,
    user,
  });
}

export async function findRelationalOrderById({
  enabled = false,
  orderId,
  relationalRuntime,
  runtimeMetrics,
} = {}) {
  const safeOrderId = text(orderId);
  if (!enabled || !safeOrderId) return null;
  const startedAt = Date.now();
  try {
    const db = await requireRelationalOrdersDb(relationalRuntime);
    return new OrdersRelationalRepository(db).getOrderById(safeOrderId);
  } finally {
    recordOrderWorkflowMetric(runtimeMetrics, "orders.sync.relationalRead", startedAt);
  }
}

export async function listRelationalOrderWorkflowSnapshot({
  enabled = false,
  logger = console,
  metricLabel = "orders.sync.relationalSnapshotRead",
  orderId,
  relationalRuntime,
  runtimeMetrics,
  stationId,
  stationIds,
  tableId,
  tableIds,
  workflowStatuses,
  workflowLight = false,
} = {}) {
  if (!enabled) return null;
  const startedAt = Date.now();
  try {
    const db = await requireRelationalOrdersDb(relationalRuntime);
    const repository = new OrdersRelationalRepository(db);
    const scoped = uniqueTexts([orderId, stationId, tableId, ...(Array.isArray(stationIds) ? stationIds : [stationIds]), ...(Array.isArray(tableIds) ? tableIds : [tableIds])]).length > 0;
    const orders = listScopedRelationalOrders(repository, {
      orderId,
      stationId,
      stationIds,
      tableId,
      tableIds,
    }, {
      workflowStatuses,
      workflowLight,
    });
    return {
      __orderWorkflowSnapshotSource: "relational-orders",
      sourceKind: "relational-orders",
      orders: Array.isArray(orders) ? orders : [],
      externalized: true,
      generatedAt: new Date().toISOString(),
      scoped,
    };
  } catch (error) {
    logger.warn?.(
      `[relational-orders] orders/sync snapshot fallback: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  } finally {
    recordOrderWorkflowMetric(runtimeMetrics, metricLabel, startedAt);
  }
}

export async function createRelationalOrderPrimary({
  enabled = false,
  order,
  relationalRuntime,
  runtimeMetrics,
} = {}) {
  if (!enabled) return null;
  const startedAt = Date.now();
  try {
    const db = await requireRelationalOrdersDb(relationalRuntime);
    const result = new OrdersRelationalRepository(db).createOrder(order);
    if (!result?.order) {
      throw new Error("Creazione ordine relazionale write-primary non riuscita.");
    }
    return result;
  } finally {
    recordOrderWorkflowMetric(runtimeMetrics, "orders.create.relationalWrite", startedAt);
  }
}

export async function syncRelationalOrderPrimary({
  enabled = false,
  metricScope = "sync",
  order,
  previousRevision,
  relationalRuntime,
  runtimeMetrics,
} = {}) {
  if (!enabled) return null;
  const startedAt = Date.now();
  const recordInternal = (label, durationMs) => runtimeMetrics?.recordOperation?.(
    "orderRelationalWriteInternal",
    `${text(metricScope) || "mutation"}.${label}`,
    durationMs,
  );
  try {
    const requireDbStartedAt = Date.now();
    const db = await requireRelationalOrdersDb(relationalRuntime);
    recordInternal("requireDb", Date.now() - requireDbStartedAt);
    return new OrdersRelationalRepository(db).replaceOrderWithRevision(
      order,
      previousRevision,
      { onMetric: recordInternal },
    );
  } finally {
    recordOrderWorkflowMetric(runtimeMetrics, "orders.sync.relationalWrite", startedAt);
  }
}

export function advanceIntegrationOrderSequencePastId(integration, orderId) {
  if (!integration || typeof integration !== "object") return;
  if (!integration.sequence || typeof integration.sequence !== "object") {
    integration.sequence = {};
  }
  const numericId = Math.trunc(Number(text(orderId).replace(/\D+/g, "")));
  if (!Number.isFinite(numericId) || numericId <= 0) return;
  const current = Math.max(
    1,
    Math.trunc(Number(integration.sequence.order) || 1),
  );
  integration.sequence.order = Math.max(current, numericId + 1);
}

export async function mirrorRelationalOrderCreateRecordToAppState({
  createDefaultIntegrationState,
  db,
  findIntegrationOrderIndexByLookup,
  nowIso,
  order,
  pruneIntegrationState,
  sanitizeIntegrationOrder,
  writeIntegrationOrderDb,
} = {}) {
  const orderId = text(order?.id);
  if (!orderId) return null;
  if (!db.integration || typeof db.integration !== "object") {
    db.integration = createDefaultIntegrationState();
  }
  const mirroredOrder = sanitizeIntegrationOrder(order, orderId);
  const orderIndex = findIntegrationOrderIndexByLookup(
    db.integration.orders,
    orderId,
  );
  if (orderIndex >= 0) {
    db.integration.orders[orderIndex] = mirroredOrder;
  } else {
    db.integration.orders.push(mirroredOrder);
  }
  advanceIntegrationOrderSequencePastId(db.integration, orderId);
  db.integration.lastWriteAt = nowIso();
  pruneIntegrationState(db.integration);
  if (!db.meta || typeof db.meta !== "object") db.meta = {};
  db.meta.lastWriteAt = nowIso();
  await writeIntegrationOrderDb(db);
  return mirroredOrder;
}
