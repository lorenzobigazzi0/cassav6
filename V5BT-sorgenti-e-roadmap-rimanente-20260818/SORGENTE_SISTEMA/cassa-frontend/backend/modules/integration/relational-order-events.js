import { OrdersRelationalRepository } from "../../db/relational/index.js";

function text(value) {
  return String(value ?? "").trim();
}

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? fallback : value));
  } catch {
    return fallback;
  }
}

export function mergeOrderEvents(existingEvents = [], nextEvents = []) {
  const merged = [];
  const seen = new Set();
  for (const event of [...existingEvents, ...nextEvents]) {
    if (!event || typeof event !== "object") continue;
    const key = text(event.id) || `${text(event.eventType ?? event.type ?? event.action)}:${merged.length + 1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(cloneJson(event, {}));
  }
  return merged;
}

export function buildOrderCreationRelationalEvents({
  actor = {},
  lineSnapshots = [],
  occurredAt,
  order,
  source,
} = {}) {
  const orderId = text(order?.id);
  const safeOccurredAt = text(occurredAt ?? order?.createdAt ?? order?.updatedAt);
  if (!orderId || !safeOccurredAt) return [];
  const actorUserId = text(actor.userId ?? actor.actorUserId ?? order?.createdByUserId) || null;
  const base = {
    occurredAt: safeOccurredAt,
    actorUserId,
  };
  const events = [
    {
      ...base,
      id: `${orderId}:order.created`,
      eventType: "order.created",
      type: "order.created",
      payload: {
        orderId,
        tableId: text(order?.tableId) || null,
        tableNumber: Number.isFinite(Number(order?.tableNumber)) ? Math.trunc(Number(order.tableNumber)) : null,
        source: text(source ?? order?.source) || null,
        roomId: text(order?.roomId) || null,
      },
    },
  ];
  for (const line of Array.isArray(lineSnapshots) ? lineSnapshots : []) {
    const lineId = text(line?.lineId);
    if (!lineId) continue;
    events.push({
      ...base,
      id: `${orderId}:${lineId}:order.line_added`,
      eventType: "order.line_added",
      type: "order.line_added",
      payload: {
        orderId,
        lineId,
        qty: Number(line?.qty) || 0,
        productNameSnapshot: text(line?.productNameSnapshot) || null,
        unitPriceApplied: Number.isFinite(Number(line?.unitPriceApplied)) ? Number(line.unitPriceApplied) : null,
        listPriceAtTime: Number.isFinite(Number(line?.listPriceAtTime)) ? Number(line.listPriceAtTime) : null,
        routeStations: Array.isArray(line?.routeStations) ? line.routeStations.map(text).filter(Boolean) : [],
      },
    });
  }
  return events;
}

export function buildOrderTransferResolutionRelationalEvents({
  actorUserId,
  approve = false,
  approverOperator,
  approverStation,
  fromStation,
  occurredAt,
  order,
  pending,
  revision,
} = {}) {
  const orderId = text(order?.id);
  const safeOccurredAt = text(occurredAt ?? order?.updatedAt);
  const safeRevision = Math.trunc(Number(revision));
  if (!orderId || !safeOccurredAt || !Number.isFinite(safeRevision) || safeRevision <= 0) return [];
  return [
    {
      id: `${orderId}:order.transfer_resolved:${safeRevision}`,
      eventType: "order.transfer_resolved",
      type: "order.transfer_resolved",
      occurredAt: safeOccurredAt,
      actorUserId: text(actorUserId) || null,
      payload: {
        orderId,
        approved: approve === true,
        fromStation: text(fromStation) || null,
        toStation: text(pending?.toStation) || text(order?.station) || null,
        mode: pending?.mode === "transfer" ? "transfer" : "takeover",
        approverStation: text(approverStation) || null,
        approverOperator: text(approverOperator) || null,
        revision: safeRevision,
      },
    },
  ];
}

export function buildOrderLinePriceOverrideRelationalEvents({
  actorUserId,
  lineId,
  occurredAt,
  order,
  previousUnitPrice,
  reason,
  revision,
  unitPriceApplied,
} = {}) {
  const orderId = text(order?.id);
  const safeLineId = text(lineId);
  const safeOccurredAt = text(occurredAt ?? order?.updatedAt);
  const safeRevision = Math.trunc(Number(revision));
  if (!orderId || !safeLineId || !safeOccurredAt || !Number.isFinite(safeRevision) || safeRevision <= 0) return [];
  return [
    {
      id: `${orderId}:${safeLineId}:order.line_price_overridden:${safeRevision}`,
      eventType: "order.line_price_overridden",
      type: "order.line_price_overridden",
      occurredAt: safeOccurredAt,
      actorUserId: text(actorUserId) || null,
      payload: {
        orderId,
        lineId: safeLineId,
        unitPriceApplied: Number.isFinite(Number(unitPriceApplied)) ? Number(unitPriceApplied) : null,
        previousUnitPrice: Number.isFinite(Number(previousUnitPrice)) ? Number(previousUnitPrice) : null,
        reason: text(reason) || null,
        revision: safeRevision,
      },
    },
  ];
}

export function buildOrderTransferForceRelationalEvents({
  actorUserId,
  fromStation,
  occurredAt,
  operatorName,
  operatorRole,
  order,
  revision,
  toStation,
} = {}) {
  const orderId = text(order?.id);
  const safeOccurredAt = text(occurredAt ?? order?.updatedAt);
  const safeRevision = Math.trunc(Number(revision));
  if (!orderId || !safeOccurredAt || !Number.isFinite(safeRevision) || safeRevision <= 0) return [];
  return [
    {
      id: `${orderId}:order.transfer_forced:${safeRevision}`,
      eventType: "order.transfer_forced",
      type: "order.transfer_forced",
      occurredAt: safeOccurredAt,
      actorUserId: text(actorUserId) || null,
      payload: {
        orderId,
        fromStation: text(fromStation) || null,
        toStation: text(toStation) || null,
        operatorName: text(operatorName) || null,
        operatorRole: text(operatorRole) || null,
        revision: safeRevision,
      },
    },
  ];
}

export async function appendRelationalOrderEvents({
  enabled = false,
  events = [],
  logger = console,
  order,
  relationalRuntime,
  runtimeMetrics,
} = {}) {
  if (!enabled || !Array.isArray(events) || events.length === 0) return null;
  const startedAt = Date.now();
  try {
    await relationalRuntime?.initialize?.();
    const db = relationalRuntime?.db;
    if (!db) return null;
    return new OrdersRelationalRepository(db).appendOrderEvents(order, events);
  } catch (error) {
    logger.warn?.(
      `[relational-orders] append eventi ordine fallback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  } finally {
    runtimeMetrics?.recordOperation?.("orderWorkflow", "orders.events.relationalAppend", Date.now() - startedAt);
  }
}
