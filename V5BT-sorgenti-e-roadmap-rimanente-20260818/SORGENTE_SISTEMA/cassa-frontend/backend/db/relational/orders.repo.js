import { runRelationalTransaction } from "./connection.js";

function safeJsonParse(value, fallback = null) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJson(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function recordRepositoryMetric(options, label, startedAt) {
  try {
    options?.onMetric?.(label, Date.now() - startedAt);
  } catch {
    // La telemetria non deve modificare l'esito della scrittura.
  }
}

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function optionalString(value) {
  const normalized = asTrimmedString(value);
  return normalized || null;
}

function uniqueOptionalStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const normalized = optionalString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function firstString(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstString(...value);
      if (nested) return nested;
      continue;
    }
    const normalized = optionalString(value);
    if (normalized) return normalized;
  }
  return null;
}

function arrayFrom(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object") : [];
}

function normalizeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function positiveQuantity(value, fallback = 1) {
  const numeric = normalizeNumber(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function positiveInteger(value, fallback = 1) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function positiveIntegerOrNull(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function centsFromMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.round(numeric * 100));
}

function centsFromCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.trunc(numeric));
}

function firstCents({ cents = [], money = [] } = {}) {
  for (const value of cents) {
    const parsed = centsFromCents(value);
    if (parsed !== null) return parsed;
  }
  for (const value of money) {
    const parsed = centsFromMoney(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function isoFromEpochMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const date = new Date(Math.trunc(numeric));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstTimestamp(...values) {
  for (const value of values) {
    const fromMs = isoFromEpochMs(value);
    if (fromMs) return fromMs;
    if (typeof value === "string") {
      const direct = optionalString(value);
      if (direct) return direct;
    }
  }
  return null;
}

function normalizeStatus(value, fallback = "unknown") {
  const normalized = asTrimmedString(value).toLowerCase();
  return normalized || fallback;
}

function normalizeOrderStatus(order) {
  return normalizeStatus(order?.workflowStatus ?? order?.status ?? order?.paymentStatus, "waiting");
}

function isCancelledStatus(status) {
  return ["cancelled", "canceled", "voided", "annullato", "annullata"].includes(normalizeStatus(status));
}

function isDeliveredStatus(status) {
  return normalizeStatus(status) === "delivered";
}

function isPaidStatus(order) {
  return normalizeStatus(order?.paymentStatus) === "paid" || Number(order?.dueAmount) <= 0 && Number(order?.paidAmount) > 0;
}

function orderStationId(order) {
  return firstString(order?.assignedStationId, order?.ownerStation, order?.stationId, order?.station);
}

export function mapOrderToRelationalRow(order) {
  if (!order || typeof order !== "object") return null;
  const id = optionalString(order.id);
  if (!id) return null;
  const status = normalizeOrderStatus(order);
  const createdAt = firstTimestamp(order.createdAt, order.createdAtMs, order.receivedAtMs);
  const updatedAt = firstTimestamp(order.updatedAt, order.updatedAtMs, order.completedAtMs, order.readyAtMs);
  const deliveredAt = firstTimestamp(
    order.deliveredAt,
    order.deliveredAtMs,
    order.completedAt,
    isDeliveredStatus(status) ? order.completedAtMs : null,
    isDeliveredStatus(status) ? updatedAt : null
  );
  const cancelledAt = firstTimestamp(
    order.cancelledAt,
    order.canceledAt,
    order.voidedAt,
    order.cancelledAtMs,
    isCancelledStatus(status) ? updatedAt : null
  );
  const paidAt = firstTimestamp(
    order.paidAt,
    order.paymentCompletedAt,
    order.paymentCompletedAtMs,
    isPaidStatus(order) ? updatedAt ?? deliveredAt : null
  );

  return {
    id,
    tableId: optionalString(order.tableId),
    roomId: optionalString(order.roomId),
    status,
    source: optionalString(order.source),
    idempotencyKey: optionalString(order.idempotencyKey),
    createdByUserId: optionalString(order.createdByUserId),
    createdByDeviceUuid: optionalString(order.createdByDeviceUuid),
    totalCents:
      firstCents({
        cents: [order.totalCents, order.total_cents],
        money: [order.total],
      }) ?? 0,
    createdAt,
    updatedAt,
    deliveredAt,
    cancelledAt,
    paidAt,
    operatorUserId: firstString(order.createdByUserId, order.operatorUserId, order.waiterUserId),
    stationId: orderStationId(order),
    revision: positiveInteger(order.revision ?? order.currentRevision, 1),
    lastEventId: positiveIntegerOrNull(order.lastEventId ?? order.last_event_id ?? order.aggregateLastEventId),
    rawJson: stringifyJson(order, {}),
  };
}

function lineIdForItem(item, index) {
  return optionalString(item?.lineId) ?? `line_${String(index + 1).padStart(4, "0")}`;
}

function lineRowId(orderId, lineId) {
  return `${orderId}:${lineId}`;
}

function buildLineRouteStationMap(order) {
  const map = new Map();
  for (const route of arrayFrom(order?.lineRoutes)) {
    const lineId = optionalString(route.lineId);
    const stationId = firstString(route.stationId, route.station);
    if (lineId && stationId && !map.has(lineId)) map.set(lineId, stationId);
  }
  return map;
}

function buildLineGroups(order) {
  const groups = new Map();
  const items = arrayFrom(order?.items);
  items.forEach((item, index) => {
    const lineId = lineIdForItem(item, index);
    const current = groups.get(lineId) ?? {
      lineId,
      firstIndex: index,
      items: [],
    };
    current.items.push(item);
    groups.set(lineId, current);
  });
  return [...groups.values()].sort((left, right) => left.firstIndex - right.firstIndex);
}

function itemQuantity(item) {
  return positiveQuantity(item?.qty ?? item?.quantity, 1);
}

function itemPreparedQuantity(item) {
  const explicit = firstFiniteNumber(
    item?.preparedQuantity,
    item?.preparedQty,
    item?.doneQuantity,
    item?.doneQty
  );
  if (explicit !== null) return Math.max(0, explicit);
  return item?.done === true ? itemQuantity(item) : 0;
}

function itemDeliveredQuantity(item) {
  const explicit = firstFiniteNumber(item?.deliveredQuantity, item?.deliveredQty);
  return explicit === null ? null : Math.max(0, explicit);
}

function itemCancelledQuantity(item) {
  const explicit = firstFiniteNumber(
    item?.cancelledQuantity,
    item?.canceledQuantity,
    item?.cancelledQty,
    item?.canceledQty,
    item?.voidedQty
  );
  const voided = item?.voidedAt || item?.cancelledAt || item?.canceledAt;
  return Math.max(0, explicit ?? (voided ? itemQuantity(item) : 0));
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function lineTotalCents(items) {
  return items.reduce((sum, item) => {
    const lineTotal =
      firstCents({
        cents: [item?.lineTotalCents, item?.totalCents],
        money: [item?.lineTotal, item?.finalLinePrice, item?.total],
      }) ??
      (firstCents({
        cents: [item?.unitPriceCents],
        money: [item?.unitPriceApplied, item?.unitPrice, item?.listPriceAtTime],
      }) ?? 0) * itemQuantity(item);
    return sum + lineTotal;
  }, 0);
}

function lineStationId(order, lineId, items, routeStationsByLineId) {
  return (
    routeStationsByLineId.get(lineId) ??
    firstString(
      ...items.map((item) => item?.stationId),
      ...items.map((item) => item?.station),
      ...items.map((item) => item?.routeStations),
      orderStationId(order)
    )
  );
}

function lineStatus(order, items, quantity, preparedQuantity, cancelledQuantity) {
  const explicit = firstString(...items.map((item) => item?.lineStatus), ...items.map((item) => item?.status));
  if (explicit) return normalizeStatus(explicit);
  if (cancelledQuantity >= quantity && quantity > 0) return "cancelled";
  if (preparedQuantity >= quantity && quantity > 0) return "ready";
  return normalizeOrderStatus(order);
}

export function mapOrderLineToRelationalRow(order, group, routeStationsByLineId = buildLineRouteStationMap(order)) {
  if (!order || !group) return null;
  const orderId = optionalString(order.id);
  const lineId = optionalString(group.lineId);
  if (!orderId || !lineId) return null;
  const items = group.items;
  const firstItem = items[0] ?? {};
  const quantity = items.reduce((sum, item) => sum + itemQuantity(item), 0);
  const preparedQuantity = items.reduce((sum, item) => sum + itemPreparedQuantity(item), 0);
  const deliveredValues = items.map((item) => itemDeliveredQuantity(item)).filter((value) => value !== null);
  const deliveredQuantity =
    deliveredValues.length > 0
      ? deliveredValues.reduce((sum, value) => sum + value, 0)
      : isDeliveredStatus(order?.workflowStatus)
        ? Math.max(0, quantity - items.reduce((sum, item) => sum + itemCancelledQuantity(item), 0))
        : null;
  const cancelledQuantity = items.reduce((sum, item) => sum + itemCancelledQuantity(item), 0);
  const totalCents = lineTotalCents(items);
  const unitPriceCents =
    firstCents({
      cents: [firstItem.unitPriceCents],
      money: [firstItem.unitPriceApplied, firstItem.unitPrice, firstItem.listPriceAtTime],
    }) ?? (quantity > 0 ? Math.round(totalCents / quantity) : 0);

  return {
    id: lineRowId(orderId, lineId),
    orderId,
    productId: firstString(firstItem.productId, firstItem.product_id),
    productName: firstString(firstItem.productNameSnapshot, firstItem.productName, firstItem.name) ?? "Articolo",
    quantity,
    unitPriceCents,
    totalCents,
    status: lineStatus(order, items, quantity, preparedQuantity, cancelledQuantity),
    stationId: lineStationId(order, lineId, items, routeStationsByLineId),
    preparedQuantity,
    deliveredQuantity,
    cancelledQuantity,
    rawJson: stringifyJson({ lineId, items }, {}),
  };
}

function pushVariant(entries, source, fallbackName = "") {
  if (!source) return;
  if (typeof source === "string") {
    const name = optionalString(source);
    if (name) entries.push({ variantId: null, name, priceDeltaCents: 0, raw: source });
    return;
  }
  if (typeof source !== "object") return;
  const name = firstString(source.name, source.label, source.value, fallbackName);
  if (!name) return;
  entries.push({
    variantId: firstString(source.id, source.variantId, source.key),
    name,
    priceDeltaCents:
      firstCents({
        cents: [source.priceDeltaCents, source.deltaCents],
        money: [source.priceDelta, source.delta, source.price, source.amount],
      }) ?? 0,
    raw: source,
  });
}

function collectVariantEntriesFromValue(value, fallbackName = "") {
  const entries = [];
  if (!value) return entries;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => pushVariant(entries, entry, `${fallbackName || "Variante"} ${index + 1}`));
    return entries;
  }
  if (typeof value === "string") {
    pushVariant(entries, value, fallbackName);
    return entries;
  }
  if (typeof value !== "object") return entries;
  if (firstString(value.id, value.name, value.label, value.value, value.priceDelta, value.price)) {
    pushVariant(entries, value, fallbackName);
    return entries;
  }
  Object.entries(value).forEach(([key, nested]) => {
    if (nested && typeof nested === "object") {
      pushVariant(entries, { key, ...nested }, key);
      return;
    }
    const nestedName = optionalString(nested);
    if (nestedName) {
      entries.push({
        variantId: key,
        name: `${key}: ${nestedName}`,
        priceDeltaCents: 0,
        raw: { [key]: nested },
      });
    }
  });
  return entries;
}

function variantEntriesForItem(item) {
  const entries = [];
  const selectedName = firstString(item?.selectedVariantName, item?.variantName, item?.variant);
  if (selectedName) {
    entries.push({
      variantId: firstString(item?.selectedVariantId, item?.variantId),
      name: selectedName,
      priceDeltaCents:
        firstCents({
          cents: [item?.selectedVariantPriceDeltaCents, item?.variantPriceDeltaCents],
          money: [item?.selectedVariantPriceDelta, item?.variantPriceDelta],
        }) ?? 0,
      raw: {
        selectedVariantId: item?.selectedVariantId ?? item?.variantId ?? null,
        selectedVariantName: selectedName,
        selectedVariantPriceDelta: item?.selectedVariantPriceDelta ?? item?.variantPriceDelta ?? 0,
      },
    });
  }
  for (const source of [
    item?.variants,
    item?.modifiers,
    item?.supplements,
    item?.supplementi,
    item?.addons,
    item?.options,
  ]) {
    entries.push(...collectVariantEntriesFromValue(source));
  }
  return entries;
}

export function mapOrderLineVariantsToRelationalRows(group, lineRow) {
  if (!group || !lineRow) return [];
  const seen = new Set();
  const rows = [];
  for (const item of group.items) {
    for (const entry of variantEntriesForItem(item)) {
      const key = `${entry.variantId ?? ""}|${entry.name}|${entry.priceDeltaCents}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        id: `${lineRow.id}:variant:${rows.length + 1}`,
        lineId: lineRow.id,
        variantId: entry.variantId,
        name: entry.name,
        priceDeltaCents: entry.priceDeltaCents,
        rawJson: stringifyJson(entry.raw, {}),
      });
    }
  }
  return rows;
}

function orderEventSources(order) {
  return [
    ...arrayFrom(order?.events),
    ...arrayFrom(order?.history),
    ...arrayFrom(order?.statusHistory),
    ...arrayFrom(order?.workflowEvents),
  ];
}

function eventPayload(event) {
  if (event?.payload && typeof event.payload === "object") return event.payload;
  const payload = {};
  for (const key of ["from", "to", "status", "reason", "lineId", "stationId"]) {
    if (event?.[key] !== undefined) payload[key] = event[key];
  }
  return payload;
}

export function mapOrderEventToRelationalRow(order, event, index = 0) {
  if (!order || !event || typeof event !== "object") return null;
  const orderId = optionalString(order.id);
  if (!orderId) return null;
  const occurredAt = firstTimestamp(
    event.occurredAt,
    event.createdAt,
    event.at,
    event.timestamp,
    event.atMs,
    order.updatedAt,
    order.createdAt
  );
  if (!occurredAt) return null;
  return {
    id: optionalString(event.id) ?? `${orderId}:event:${index + 1}`,
    orderId,
    eventType: firstString(event.eventType, event.type, event.action, event.status) ?? "event",
    occurredAt,
    actorUserId: firstString(event.actorUserId, event.userId, event.operatorUserId),
    payloadJson: stringifyJson(eventPayload(event), {}),
    rawJson: stringifyJson(event, {}),
  };
}

export function buildOrdersRelationalRows(appState) {
  const sourceOrders = arrayFrom(appState?.integration?.orders);
  const orders = [];
  const lines = [];
  const variants = [];
  const events = [];

  for (const order of sourceOrders) {
    const orderRow = mapOrderToRelationalRow(order);
    if (!orderRow) continue;
    orders.push(orderRow);
    const routeStationsByLineId = buildLineRouteStationMap(order);
    for (const group of buildLineGroups(order)) {
      const lineRow = mapOrderLineToRelationalRow(order, group, routeStationsByLineId);
      if (!lineRow) continue;
      lines.push(lineRow);
      variants.push(...mapOrderLineVariantsToRelationalRows(group, lineRow));
    }
    orderEventSources(order).forEach((event, index) => {
      const eventRow = mapOrderEventToRelationalRow(order, event, index);
      if (eventRow) events.push(eventRow);
    });
  }

  return { orders, lines, variants, events };
}

export class OrdersRelationalRepository {
  constructor(db) {
    this.db = db;
  }

  listOrders(filters = {}) {
    const clauses = [];
    const params = [];
    this.#appendFilter(clauses, params, "table_id", filters.tableId);
    this.#appendFilterList(clauses, params, "table_id", filters.tableIds);
    this.#appendFilter(clauses, params, "room_id", filters.roomId);
    this.#appendFilter(clauses, params, "status", filters.status);
    this.#appendFilterList(clauses, params, "status", filters.statuses);
    this.#appendFilter(clauses, params, "station_id", filters.stationId);
    this.#appendFilterList(clauses, params, "station_id", filters.stationIds);
    this.#appendFilter(clauses, params, "source", filters.source);
    this.#appendDateRange(clauses, params, "created_at", filters.from ?? filters.fromCreatedAt, filters.to ?? filters.toCreatedAt);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM orders${where} ORDER BY created_at ASC, id ASC`)
      .all(...params)
      .map((row) => this.#hydrateOrder(row));
  }

  listWorkflowOrders(filters = {}) {
    const clauses = [];
    const params = [];
    this.#appendFilter(clauses, params, "table_id", filters.tableId);
    this.#appendFilterList(clauses, params, "table_id", filters.tableIds);
    this.#appendFilter(clauses, params, "room_id", filters.roomId);
    this.#appendFilter(clauses, params, "status", filters.status);
    this.#appendFilterList(clauses, params, "status", filters.statuses);
    this.#appendFilter(clauses, params, "station_id", filters.stationId);
    this.#appendFilterList(clauses, params, "station_id", filters.stationIds);
    this.#appendFilter(clauses, params, "source", filters.source);
    this.#appendDateRange(clauses, params, "created_at", filters.from ?? filters.fromCreatedAt, filters.to ?? filters.toCreatedAt);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM orders${where} ORDER BY created_at ASC, id ASC`)
      .all(...params)
      .map((row) => this.#hydrateWorkflowOrder(row));
  }

  getOrderById(id) {
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(asTrimmedString(id));
    return row ? this.#hydrateOrder(row) : null;
  }

  getMaxOrderId() {
    const row = this.db.prepare("SELECT MAX(id) AS maxId FROM orders").get();
    return row?.maxId ?? null;
  }

  allocateNextOrderId(options = {}) {
    const scope = optionalString(options.scope) ?? "integration_order";
    const minimumNextOrder = positiveInteger(options.minimumNextOrder, 1);
    return runRelationalTransaction(this.db, () => {
      const maxRow = this.db.prepare("SELECT COALESCE(MAX(CAST(id AS INTEGER)), 0) AS maxId FROM orders").get();
      const allocatorRow = this.db.prepare("SELECT next_value FROM order_id_allocator WHERE scope = ?").get(scope);
      const allocated = Math.max(1, minimumNextOrder, positiveInteger(allocatorRow?.next_value, 1), positiveInteger(maxRow?.maxId, 0) + 1);
      this.db.prepare(`
        INSERT INTO order_id_allocator (scope, next_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          next_value = excluded.next_value,
          updated_at = excluded.updated_at
      `).run(scope, allocated + 1, new Date().toISOString());
      return allocated;
    });
  }

  listOrdersUpdatedSince(sinceIso) {
    const safeSince = optionalString(sinceIso);
    if (!safeSince) return [];
    return this.db
      .prepare("SELECT * FROM orders WHERE COALESCE(updated_at, created_at) >= ? ORDER BY created_at ASC, id ASC")
      .all(safeSince)
      .map((row) => this.#hydrateOrder(row));
  }

  findOrderByIdempotencyKey(key, filters = {}) {
    const safeKey = optionalString(key);
    if (!safeKey) return null;
    const userId = optionalString(filters.userId ?? filters.user?.id);
    const deviceUuid = optionalString(filters.deviceUuid);
    const clauses = ["idempotency_key = ?"];
    const params = [safeKey];
    if (userId) {
      clauses.push("(created_by_user_id IS NULL OR created_by_user_id = ?)");
      params.push(userId);
    }
    if (deviceUuid) {
      clauses.push("(created_by_device_uuid IS NULL OR created_by_device_uuid = ?)");
      params.push(deviceUuid);
    }
    const rows = this.db
      .prepare(`SELECT * FROM orders WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC, id ASC`)
      .all(...params);
    for (const row of rows) {
      const order = this.#hydrateOrder(row);
      if (optionalString(order?.idempotencyKey) !== safeKey) continue;
      if (userId && optionalString(order?.createdByUserId) && optionalString(order.createdByUserId) !== userId) {
        continue;
      }
      if (
        deviceUuid &&
        optionalString(order?.createdByDeviceUuid) &&
        optionalString(order.createdByDeviceUuid) !== deviceUuid
      ) {
        continue;
      }
      return order;
    }
    return null;
  }

  listOrderLines(orderId) {
    const normalizedOrderId = optionalString(orderId);
    const rows = normalizedOrderId
      ? this.db
          .prepare("SELECT * FROM order_lines WHERE order_id = ? ORDER BY id ASC")
          .all(normalizedOrderId)
      : this.db.prepare("SELECT * FROM order_lines ORDER BY order_id ASC, id ASC").all();
    return rows.map((row) => this.#hydrateLine(row));
  }

  listOrderEvents(orderId) {
    const normalizedOrderId = optionalString(orderId);
    const rows = normalizedOrderId
      ? this.db
          .prepare("SELECT * FROM order_events WHERE order_id = ? ORDER BY occurred_at ASC, id ASC")
          .all(normalizedOrderId)
      : this.db.prepare("SELECT * FROM order_events ORDER BY order_id ASC, occurred_at ASC, id ASC").all();
    return rows.map((row) => this.#hydrateEvent(row));
  }

  appendOrderEvents(order, events = [], options = {}) {
    const sourceEvents = Array.isArray(events) ? events : [];
    const operation = () => {
      let inserted = 0;
      let skipped = 0;
      const rows = [];
      sourceEvents.forEach((event, index) => {
        const row = mapOrderEventToRelationalRow(order, event, index);
        if (!row) {
          skipped += 1;
          return;
        }
        const result = this.#insertEvent(row, { ignoreConflict: true });
        inserted += result.changes > 0 ? 1 : 0;
        rows.push(row);
      });
      return { inserted, skipped, rows };
    };
    if (options.transaction === false) return operation();
    return runRelationalTransaction(this.db, operation);
  }

  createOrder(order, options = {}) {
    const rows = buildOrdersRelationalRows({ integration: { orders: [order] } });
    const orderRow = rows.orders[0] ?? null;
    const operation = () => {
      if (!orderRow) return { inserted: false, order: null, rows };
      const existingOrder = this.getOrderById(orderRow.id);
      if (existingOrder) {
        if (options.ignoreExisting === true) {
          return { inserted: false, order: existingOrder, rows };
        }
        const error = new Error(`Ordine relazionale gia' esistente: ${orderRow.id}`);
        error.code = "ORDER_ALREADY_EXISTS";
        throw error;
      }
      this.#insertOrder(orderRow);
      for (const row of rows.lines) this.#insertLine(row);
      for (const row of rows.variants) this.#insertVariant(row);
      for (const row of rows.events) this.#insertEvent(row, { ignoreConflict: true });
      return {
        inserted: true,
        order: this.getOrderById(orderRow.id),
        rows,
      };
    };
    if (options.transaction === false) return operation();
    return runRelationalTransaction(this.db, operation);
  }

  replaceOrderWithRevision(order, expectedRevision, options = {}) {
    const totalStartedAt = Date.now();
    let stepStartedAt = Date.now();
    const rows = buildOrdersRelationalRows({ integration: { orders: [order] } });
    const orderRow = rows.orders[0] ?? null;
    const safeExpectedRevision = positiveInteger(expectedRevision, 0);
    recordRepositoryMetric(options, "mapRows", stepStartedAt);
    const operation = () => {
      if (!orderRow || safeExpectedRevision <= 0) return null;
      stepStartedAt = Date.now();
      const result = this.db
        .prepare(
          `
            UPDATE orders SET
              table_id = ?,
              room_id = ?,
              status = ?,
              source = ?,
              idempotency_key = ?,
              created_by_user_id = ?,
              created_by_device_uuid = ?,
              total_cents = ?,
              created_at = ?,
              updated_at = ?,
              delivered_at = ?,
              cancelled_at = ?,
              paid_at = ?,
              operator_user_id = ?,
              station_id = ?,
              last_event_id = COALESCE(?, last_event_id),
              raw_json = ?,
              revision = revision + 1
            WHERE id = ? AND revision = ?
          `
        )
        .run(
          orderRow.tableId,
          orderRow.roomId,
          orderRow.status,
          orderRow.source,
          orderRow.idempotencyKey,
          orderRow.createdByUserId,
          orderRow.createdByDeviceUuid,
          orderRow.totalCents,
          orderRow.createdAt,
          orderRow.updatedAt,
          orderRow.deliveredAt,
          orderRow.cancelledAt,
          orderRow.paidAt,
          orderRow.operatorUserId,
          orderRow.stationId,
          orderRow.lastEventId,
          orderRow.rawJson,
          orderRow.id,
          safeExpectedRevision
        );
      recordRepositoryMetric(options, "casUpdate", stepStartedAt);
      if (result.changes <= 0) return null;
      stepStartedAt = Date.now();
      this.#deleteOrderChildren(orderRow.id, { events: options.replaceEvents !== false });
      recordRepositoryMetric(options, "deleteChildren", stepStartedAt);
      stepStartedAt = Date.now();
      for (const row of rows.lines) this.#insertLine(row);
      for (const row of rows.variants) this.#insertVariant(row);
      for (const row of rows.events) this.#insertEvent(row, { ignoreConflict: true });
      recordRepositoryMetric(options, "insertChildren", stepStartedAt);
      stepStartedAt = Date.now();
      const hydratedOrder = this.getOrderById(orderRow.id);
      recordRepositoryMetric(options, "hydrateResult", stepStartedAt);
      return {
        order: hydratedOrder,
        rows,
      };
    };
    try {
      if (options.transaction === false) return operation();
      return runRelationalTransaction(this.db, operation, {
        onStep: (label, durationMs) => options?.onMetric?.(`transaction.${label}`, durationMs),
      });
    } finally {
      recordRepositoryMetric(options, "total", totalStartedAt);
    }
  }

  updateOrderWithRevision(id, expectedRevision, patch = {}) {
    const normalizedId = optionalString(id);
    const safeExpectedRevision = positiveInteger(expectedRevision, 0);
    if (!normalizedId || safeExpectedRevision <= 0) return null;
    const assignments = ["revision = revision + 1"];
    const params = [];
    const status = optionalString(patch.status ?? patch.workflowStatus);
    if (status) {
      assignments.push("status = ?");
      params.push(status);
    }
    const updatedAt = optionalString(patch.updatedAt);
    if (updatedAt) {
      assignments.push("updated_at = ?");
      params.push(updatedAt);
    }
    if (patch.rawJson !== undefined) {
      const rawJson = typeof patch.rawJson === "string" ? patch.rawJson : stringifyJson(patch.rawJson, {});
      const rawOrder = safeJsonParse(rawJson, {});
      assignments.push("raw_json = ?");
      params.push(rawJson);
      assignments.push("idempotency_key = ?");
      params.push(optionalString(rawOrder?.idempotencyKey));
      assignments.push("created_by_user_id = ?");
      params.push(optionalString(rawOrder?.createdByUserId));
      assignments.push("created_by_device_uuid = ?");
      params.push(optionalString(rawOrder?.createdByDeviceUuid));
    }
    if (patch.lastEventId !== undefined || patch.last_event_id !== undefined || patch.aggregateLastEventId !== undefined) {
      assignments.push("last_event_id = ?");
      params.push(positiveIntegerOrNull(patch.lastEventId ?? patch.last_event_id ?? patch.aggregateLastEventId));
    }
    const result = this.db
      .prepare(`UPDATE orders SET ${assignments.join(", ")} WHERE id = ? AND revision = ?`)
      .run(...params, normalizedId, safeExpectedRevision);
    return result.changes > 0 ? this.getOrderById(normalizedId) : null;
  }

  updateOrderLocationWithRevision(id, expectedRevision, patch = {}) {
    const normalizedId = optionalString(id);
    const safeExpectedRevision = positiveInteger(expectedRevision, 0);
    const tableId = optionalString(patch.tableId);
    if (!normalizedId || safeExpectedRevision <= 0 || !tableId) return null;
    const current = this.getOrderById(normalizedId);
    if (!current || positiveInteger(current.revision, 0) !== safeExpectedRevision) {
      return null;
    }
    const nextRevision = safeExpectedRevision + 1;
    const roomId = optionalString(patch.roomId) ?? optionalString(current.roomId);
    const updatedAt = optionalString(patch.updatedAt) ?? new Date().toISOString();
    const nextRaw = {
      ...current,
      tableId,
      roomId,
      ...(patch.table !== undefined ? { table: patch.table } : {}),
      ...(patch.tableNumber !== undefined ? { tableNumber: patch.tableNumber } : {}),
      ...(patch.tableLabel !== undefined ? { tableLabel: patch.tableLabel } : {}),
      ...(patch.logicalTableLabel !== undefined
        ? { logicalTableLabel: patch.logicalTableLabel }
        : {}),
      ...(patch.lastTableTransferAtMs !== undefined
        ? { lastTableTransferAtMs: patch.lastTableTransferAtMs }
        : {}),
      updatedAt,
      revision: nextRevision,
      currentRevision: nextRevision,
      aggregateVersion: nextRevision,
    };
    const result = this.db
      .prepare(
        `
          UPDATE orders SET
            table_id = ?,
            room_id = ?,
            updated_at = ?,
            raw_json = ?,
            revision = revision + 1
          WHERE id = ? AND revision = ?
        `,
      )
      .run(
        tableId,
        roomId,
        updatedAt,
        stringifyJson(nextRaw, {}),
        normalizedId,
        safeExpectedRevision,
      );
    return result.changes > 0 ? this.getOrderById(normalizedId) : null;
  }

  replaceAllFromAppState(appState, options = {}) {
    const rows = buildOrdersRelationalRows(appState);
    const operation = () => {
      this.#preserveOrderLastEventIds(rows.orders);
      this.#deleteAll();
      for (const row of rows.orders) this.#insertOrder(row);
      for (const row of rows.lines) this.#insertLine(row);
      for (const row of rows.variants) this.#insertVariant(row);
      for (const row of rows.events) this.#insertEvent(row);
      return rows;
    };
    if (options.transaction === false) {
      return operation();
    }
    return runRelationalTransaction(this.db, operation);
  }

  #appendFilter(clauses, params, columnName, value) {
    const normalized = optionalString(value);
    if (!normalized) return;
    clauses.push(`${columnName} = ?`);
    params.push(normalized);
  }

  #appendFilterList(clauses, params, columnName, values) {
    const normalized = uniqueOptionalStrings(values);
    if (normalized.length === 0) return;
    clauses.push(`${columnName} IN (${normalized.map(() => "?").join(", ")})`);
    params.push(...normalized);
  }

  #appendDateRange(clauses, params, columnName, from, to) {
    const fromValue = optionalString(from);
    const toValue = optionalString(to);
    if (fromValue) {
      clauses.push(`${columnName} >= ?`);
      params.push(fromValue);
    }
    if (toValue) {
      clauses.push(`${columnName} <= ?`);
      params.push(toValue);
    }
  }

  #deleteAll() {
    this.db.prepare("DELETE FROM order_events").run();
    this.db.prepare("DELETE FROM order_line_variants").run();
    this.db.prepare("DELETE FROM order_lines").run();
    this.db.prepare("DELETE FROM orders").run();
  }

  #preserveOrderLastEventIds(rows = []) {
    const existing = new Map(
      this.db
        .prepare("SELECT id, last_event_id FROM orders WHERE last_event_id IS NOT NULL")
        .all()
        .map((row) => [row.id, positiveIntegerOrNull(row.last_event_id)])
    );
    for (const row of rows) {
      if (!row || row.lastEventId !== null && row.lastEventId !== undefined) continue;
      row.lastEventId = existing.get(row.id) ?? null;
    }
  }

  #deleteOrderChildren(orderId, options = {}) {
    const normalizedOrderId = optionalString(orderId);
    if (!normalizedOrderId) return;
    this.db
      .prepare("DELETE FROM order_line_variants WHERE line_id IN (SELECT id FROM order_lines WHERE order_id = ?)")
      .run(normalizedOrderId);
    this.db.prepare("DELETE FROM order_lines WHERE order_id = ?").run(normalizedOrderId);
    if (options.events === true) {
      this.db.prepare("DELETE FROM order_events WHERE order_id = ?").run(normalizedOrderId);
    }
  }

  #insertOrder(row) {
    this.db
      .prepare(
        `
          INSERT INTO orders (
            id,
            table_id,
            room_id,
            status,
            source,
            idempotency_key,
            created_by_user_id,
            created_by_device_uuid,
            total_cents,
            created_at,
            updated_at,
            delivered_at,
            cancelled_at,
            paid_at,
            operator_user_id,
            station_id,
            revision,
            last_event_id,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        row.id,
        row.tableId,
        row.roomId,
        row.status,
        row.source,
        row.idempotencyKey,
        row.createdByUserId,
        row.createdByDeviceUuid,
        row.totalCents,
        row.createdAt,
        row.updatedAt,
        row.deliveredAt,
        row.cancelledAt,
        row.paidAt,
        row.operatorUserId,
        row.stationId,
        row.revision,
        row.lastEventId,
        row.rawJson
      );
  }

  #insertLine(row) {
    this.db
      .prepare(
        `
          INSERT INTO order_lines (
            id,
            order_id,
            product_id,
            product_name,
            quantity,
            unit_price_cents,
            total_cents,
            status,
            station_id,
            prepared_quantity,
            delivered_quantity,
            cancelled_quantity,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        row.id,
        row.orderId,
        row.productId,
        row.productName,
        row.quantity,
        row.unitPriceCents,
        row.totalCents,
        row.status,
        row.stationId,
        row.preparedQuantity,
        row.deliveredQuantity,
        row.cancelledQuantity,
        row.rawJson
      );
  }

  #insertVariant(row) {
    this.db
      .prepare(
        `
          INSERT INTO order_line_variants (
            id,
            line_id,
            variant_id,
            name,
            price_delta_cents,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?)
        `
      )
      .run(row.id, row.lineId, row.variantId, row.name, row.priceDeltaCents, row.rawJson);
  }

  #insertEvent(row, options = {}) {
    return this.db
      .prepare(
        `
          INSERT ${options.ignoreConflict ? "OR IGNORE " : ""}INTO order_events (
            id,
            order_id,
            event_type,
            occurred_at,
            actor_user_id,
            payload_json,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(row.id, row.orderId, row.eventType, row.occurredAt, row.actorUserId, row.payloadJson, row.rawJson);
  }

  #hydrateOrder(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      tableId: row.table_id,
      roomId: row.room_id,
      status: row.status,
      workflowStatus: raw?.workflowStatus ?? row.status,
      source: row.source,
      idempotencyKey: row.idempotency_key ?? raw?.idempotencyKey,
      createdByUserId: row.created_by_user_id ?? raw?.createdByUserId,
      createdByDeviceUuid: row.created_by_device_uuid ?? raw?.createdByDeviceUuid,
      totalCents: row.total_cents,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deliveredAt: row.delivered_at,
      cancelledAt: row.cancelled_at,
      paidAt: row.paid_at,
      operatorUserId: row.operator_user_id,
      stationId: row.station_id,
      revision: positiveInteger(row.revision, 1),
      currentRevision: positiveInteger(raw?.currentRevision ?? raw?.revision ?? row.revision, positiveInteger(row.revision, 1)),
      aggregateVersion: positiveInteger(row.revision, 1),
      lastEventId: positiveIntegerOrNull(row.last_event_id ?? raw?.lastEventId ?? raw?.last_event_id ?? raw?.aggregateLastEventId),
    };
  }

  #hydrateWorkflowOrder(row) {
    const raw = safeJsonParse(row.raw_json, {});
    const source = raw && typeof raw === "object" ? raw : {};
    const revision = positiveInteger(row.revision, 1);
    return {
      id: row.id,
      tableId: row.table_id,
      roomId: row.room_id,
      tableNumber: source.tableNumber ?? source.table,
      tableLabel: source.tableLabel ?? source.logicalTableLabel,
      logicalTableLabel: source.logicalTableLabel ?? source.tableLabel,
      status: row.status,
      workflowStatus: source.workflowStatus ?? row.status,
      paymentStatus: source.paymentStatus,
      source: row.source ?? source.source,
      idempotencyKey: row.idempotency_key ?? source.idempotencyKey,
      station: source.station ?? row.station_id,
      stationId: row.station_id,
      assignedStationId: source.assignedStationId,
      ownerStation: source.ownerStation,
      lockedByStationId: source.lockedByStationId,
      lockStatus: source.lockStatus,
      lockedByUserId: source.lockedByUserId,
      lockedAt: source.lockedAt,
      preparationStartedAt: source.preparationStartedAt,
      ownerOperator: source.ownerOperator,
      ownerRole: source.ownerRole,
      ownerAtMs: source.ownerAtMs,
      assignedStationOperatorUserId: source.assignedStationOperatorUserId,
      assignedStationOperatorUsername: source.assignedStationOperatorUsername,
      assignedStationOperatorName: source.assignedStationOperatorName,
      assignedStationDeviceUuid: source.assignedStationDeviceUuid,
      createdByUserId: row.created_by_user_id ?? source.createdByUserId ?? row.operator_user_id,
      createdByUsername: source.createdByUsername,
      createdByDeviceUuid: row.created_by_device_uuid ?? source.createdByDeviceUuid,
      receivedAtMs: source.receivedAtMs,
      readyAtMs: source.readyAtMs,
      completedAtMs: source.completedAtMs,
      total: source.total,
      dueAmount: source.dueAmount,
      paidAmount: source.paidAmount,
      totalCents: row.total_cents,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deliveredAt: row.delivered_at,
      cancelledAt: row.cancelled_at,
      paidAt: row.paid_at,
      operatorUserId: row.operator_user_id,
      revision,
      currentRevision: positiveInteger(source.currentRevision ?? source.revision ?? row.revision, revision),
      aggregateVersion: revision,
      lastEventId: positiveIntegerOrNull(row.last_event_id ?? source.lastEventId ?? source.last_event_id ?? source.aggregateLastEventId),
      items: this.#hydrateWorkflowItems(source.items),
      lineRoutes: this.#hydrateWorkflowRoutes(source.lineRoutes),
    };
  }

  #hydrateWorkflowItems(items) {
    return arrayFrom(items).map((item) => ({
      id: item.id,
      lineId: item.lineId,
      productId: item.productId,
      productNameSnapshot: item.productNameSnapshot,
      name: item.name,
      qty: item.qty,
      quantity: item.quantity,
      done: item.done,
      doneQty: item.doneQty,
      lineTotal: item.lineTotal,
      finalLinePrice: item.finalLinePrice,
      unitPriceApplied: item.unitPriceApplied,
      listPriceAtTime: item.listPriceAtTime,
      priceOverrideApplied: item.priceOverrideApplied === true,
      vatRate: item.vatRate,
      vatCode: item.vatCode,
      departmentId: item.departmentId,
      fiscalDepartment: item.fiscalDepartment,
      variants: item.variants,
      variant: item.variant,
      selectedVariantId: item.selectedVariantId,
      selectedVariantName: item.selectedVariantName,
      selectedVariantPriceDelta: item.selectedVariantPriceDelta,
      notes: item.notes,
      note: item.note,
      allergens: item.allergens,
      voidedAt: item.voidedAt,
      voidedBy: item.voidedBy,
      correctionStatus: item.correctionStatus,
      correctionId: item.correctionId,
      correctionReason: item.correctionReason,
      station: item.station,
      routeStations: Array.isArray(item.routeStations) ? item.routeStations : undefined,
    }));
  }

  #hydrateWorkflowRoutes(lineRoutes) {
    return arrayFrom(lineRoutes).map((route) => ({
      id: route.id,
      lineId: route.lineId,
      stationId: route.stationId,
      station: route.station,
      receivedAt: route.receivedAt,
      receivedByUserId: route.receivedByUserId,
      receivedByUsername: route.receivedByUsername,
      readyAt: route.readyAt,
      deliveredAt: route.deliveredAt,
      pickedUpAt: route.pickedUpAt,
    }));
  }

  #hydrateLine(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      orderId: row.order_id,
      productId: row.product_id,
      productName: row.product_name,
      quantity: row.quantity,
      unitPriceCents: row.unit_price_cents,
      totalCents: row.total_cents,
      status: row.status,
      stationId: row.station_id,
      preparedQuantity: row.prepared_quantity,
      deliveredQuantity: row.delivered_quantity,
      cancelledQuantity: row.cancelled_quantity,
    };
  }

  #hydrateEvent(row) {
    const raw = safeJsonParse(row.raw_json, {});
    return {
      ...(raw && typeof raw === "object" ? raw : {}),
      id: row.id,
      orderId: row.order_id,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      actorUserId: row.actor_user_id,
      payload: safeJsonParse(row.payload_json, raw?.payload ?? {}),
    };
  }
}
