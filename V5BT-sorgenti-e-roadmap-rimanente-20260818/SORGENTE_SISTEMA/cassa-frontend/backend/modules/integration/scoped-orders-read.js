import { OrdersRelationalRepository } from "../../db/relational/index.js";
import { shouldPreferRelationalOrderCorrectionReadModel } from "./order-correction-read-model.js";
import { normalizeIntegrationStationName } from "./stations.domain.js";

export const DEFAULT_SCOPED_STATION_DONE_HISTORY_LIMIT = 30;

function hasFlag(searchParams, name) {
  return String(searchParams.get(name) ?? "").trim() === "1";
}

function shouldUseScopedOrdersRead(requestUrl) {
  const searchParams = requestUrl?.searchParams;
  if (!searchParams) return false;
  if (hasFlag(searchParams, "currentSessionOnly")) return false;
  return true;
}

function shouldUseRelationalOrdersHistoryRead(requestUrl) {
  const searchParams = requestUrl?.searchParams;
  if (!searchParams) return false;
  if (!hasFlag(searchParams, "includeDone")) return false;
  if (hasFlag(searchParams, "currentSessionOnly")) return false;
  if (orderLookupCandidates(searchParams).length > 0) return false;
  return true;
}

function normalizeSearchParam(searchParams, name) {
  return String(searchParams?.get(name) ?? "").trim();
}

function orderLookupCandidates(searchParams) {
  const raw =
    normalizeSearchParam(searchParams, "orderId") ||
    normalizeSearchParam(searchParams, "id");
  const normalized = raw.replace(/^#/, "").replace(/^order_/i, "").trim();
  return [...new Set([raw, normalized].map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function positiveRevision(value, fallback = 0) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldDefaultScopedStationDoneHistoryLimit(searchParams) {
  return (
    searchParams &&
    hasFlag(searchParams, "includeDone") &&
    !searchParams.has("doneHistoryLimit") &&
    !searchParams.has("historyLimit") &&
    !normalizeSearchParam(searchParams, "orderId") &&
    !normalizeSearchParam(searchParams, "id") &&
    !normalizeSearchParam(searchParams, "roomId")
  );
}

function ensureScopedStationDoneHistoryLimit(searchParams) {
  if (shouldDefaultScopedStationDoneHistoryLimit(searchParams)) {
    searchParams.set("doneHistoryLimit", String(DEFAULT_SCOPED_STATION_DONE_HISTORY_LIMIT));
  }
}

function parseDoneHistoryLimit(searchParams) {
  const raw = searchParams?.get("doneHistoryLimit") ?? searchParams?.get("historyLimit");
  return normalizeScopedStationDoneHistoryLimit(raw);
}

function normalizeScopedStationDoneHistoryLimit(
  raw,
  defaultLimit = DEFAULT_SCOPED_STATION_DONE_HISTORY_LIMIT,
) {
  if (raw === null || raw === undefined) return Math.min(Math.max(Math.trunc(Number(defaultLimit)) || 0, 0), 200);
  const parsed = Math.trunc(Number(raw));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(parsed, 200);
}

function normalizeUsernameForCache(value) {
  return String(value ?? "").trim().toLowerCase();
}

function pushCacheEntry(entries, key, value) {
  const safeValue = String(value ?? "").trim();
  if (safeValue) entries.push([key, safeValue]);
}

export function buildIntegrationOrdersFastCacheKey(requestUrl, options = {}) {
  const searchParams = requestUrl?.searchParams;
  if (!searchParams) return "[]";

  const defaultDoneHistoryLimit = Math.min(
    Math.max(Math.trunc(Number(options.defaultDoneHistoryLimit)) || DEFAULT_SCOPED_STATION_DONE_HISTORY_LIMIT, 0),
    200,
  );
  const entries = [];
  const station = normalizeIntegrationStationName(searchParams.get("station"));
  const orderId = normalizeSearchParam(searchParams, "orderId") || normalizeSearchParam(searchParams, "id");
  const roomId = normalizeSearchParam(searchParams, "roomId");
  const operatorUserId =
    normalizeSearchParam(searchParams, "operatorUserId") ||
    normalizeSearchParam(searchParams, "userId");
  const operatorUsername = normalizeUsernameForCache(
    normalizeSearchParam(searchParams, "operatorUsername") ||
      normalizeSearchParam(searchParams, "username"),
  );
  const deviceUuid = normalizeSearchParam(searchParams, "deviceUuid");
  const includeDone = hasFlag(searchParams, "includeDone");
  const includeTransferred = hasFlag(searchParams, "includeTransferred");
  const currentSessionOnly = hasFlag(searchParams, "currentSessionOnly");

  pushCacheEntry(entries, "station", station);
  pushCacheEntry(entries, "orderId", orderId);
  pushCacheEntry(entries, "roomId", roomId);
  pushCacheEntry(entries, "operatorUserId", operatorUserId);
  pushCacheEntry(entries, "operatorUsername", operatorUsername);
  pushCacheEntry(entries, "deviceUuid", deviceUuid);
  if (includeDone) entries.push(["includeDone", "1"]);
  if (includeTransferred) entries.push(["includeTransferred", "1"]);
  if (currentSessionOnly) entries.push(["currentSessionOnly", "1"]);

  if (station && includeDone && !orderId && !roomId) {
    const rawLimit = searchParams.get("doneHistoryLimit") ?? searchParams.get("historyLimit");
    const limit = normalizeScopedStationDoneHistoryLimit(rawLimit, defaultDoneHistoryLimit);
    entries.push(["doneHistoryLimit", String(limit === null ? defaultDoneHistoryLimit : limit)]);
  }

  entries.sort((left, right) => {
    const keyCompare = left[0].localeCompare(right[0]);
    return keyCompare || left[1].localeCompare(right[1]);
  });
  return JSON.stringify(entries);
}

function scopedOrderMoney(value) {
  return Math.round(Math.max(Number(value) || 0, 0) * 100) / 100;
}

function isScopedStationHistoricalOrder(order) {
  const workflow = String(order?.workflowStatus ?? "")
    .trim()
    .toLowerCase();
  const paymentStatus = String(order?.paymentStatus ?? "")
    .trim()
    .toLowerCase();
  const dueAmount = scopedOrderMoney(order?.dueAmount);
  return (
    paymentStatus === "paid" ||
    dueAmount <= 0.009 ||
    [
      "ready",
      "delivered",
      "done",
      "completed",
      "cancelled",
      "annullata",
      "voided",
    ].includes(workflow)
  );
}

function scopedOrderReceivedAtMs(order) {
  const parsed = Number(order?.receivedAtMs ?? order?.createdAtMs ?? order?.updatedAtMs ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareScopedOrdersByAge(left, right) {
  return (
    scopedOrderReceivedAtMs(left) - scopedOrderReceivedAtMs(right) ||
    String(left?.id ?? "").localeCompare(String(right?.id ?? ""), "it-IT")
  );
}

function compareScopedOrdersByRecentAge(left, right) {
  return -compareScopedOrdersByAge(left, right);
}

function limitScopedStationDoneHistory(orders, searchParams) {
  const limit = parseDoneHistoryLimit(searchParams);
  if (limit === null || !Array.isArray(orders) || orders.length === 0) return orders;
  if (!hasFlag(searchParams, "includeDone")) return orders;
  if (normalizeSearchParam(searchParams, "orderId") || normalizeSearchParam(searchParams, "id")) {
    return orders;
  }
  if (normalizeSearchParam(searchParams, "roomId")) return orders;

  const activeOrders = [];
  const historicalOrders = [];
  for (const order of orders) {
    if (isScopedStationHistoricalOrder(order)) {
      historicalOrders.push(order);
    } else {
      activeOrders.push(order);
    }
  }
  if (historicalOrders.length <= limit) return orders;

  const recentHistoricalOrders = historicalOrders
    .sort(compareScopedOrdersByRecentAge)
    .slice(0, limit);
  return [...activeOrders, ...recentHistoricalOrders].sort(compareScopedOrdersByAge);
}

async function readRelationalOrdersHistory(options = {}) {
  const {
    enabled,
    logger = console,
    relationalOrdersRepository,
    relationalRuntime,
    requestUrl,
  } = options;
  if (!enabled || !shouldUseRelationalOrdersHistoryRead(requestUrl)) return null;
  try {
    if (relationalOrdersRepository?.listOrders) {
      const orders = await relationalOrdersRepository.listOrders();
      return Array.isArray(orders) ? orders : null;
    }
    await relationalRuntime?.initialize?.();
    const relationalDb = relationalRuntime?.db;
    if (!relationalDb) return null;
    const orders = new OrdersRelationalRepository(relationalDb).listOrders();
    return Array.isArray(orders) ? orders : null;
  } catch (error) {
    logger.warn?.(
      `[scoped-reads] relational integration.orders fallback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function readRelationalOrderLookup(options = {}) {
  const {
    enabled,
    logger = console,
    relationalOrdersRepository,
    relationalRuntime,
    requestUrl,
  } = options;
  const candidates = orderLookupCandidates(requestUrl?.searchParams);
  if (!enabled || candidates.length === 0) return null;
  try {
    if (relationalOrdersRepository?.getOrderById) {
      for (const candidate of candidates) {
        const order = await relationalOrdersRepository.getOrderById(candidate);
        if (order) return order;
      }
      return null;
    }
    await relationalRuntime?.initialize?.();
    const relationalDb = relationalRuntime?.db;
    if (!relationalDb) return null;
    const repo = new OrdersRelationalRepository(relationalDb);
    for (const candidate of candidates) {
      const order = repo.getOrderById(candidate);
      if (order) return order;
    }
    return null;
  } catch (error) {
    logger.warn?.(
      `[scoped-reads] relational integration.orders lookup fallback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function mergeRelationalLookupOrder(orders, relationalOrder) {
  if (!relationalOrder?.id) return Array.isArray(orders) ? orders : [];
  const currentOrders = Array.isArray(orders) ? orders : [];
  const targetId = String(relationalOrder.id ?? "").trim();
  const nextOrders = [...currentOrders];
  const index = nextOrders.findIndex((order) => String(order?.id ?? "").trim() === targetId);
  if (index < 0) return [...nextOrders, relationalOrder];
  const appRevision = positiveRevision(nextOrders[index]?.revision ?? nextOrders[index]?.currentRevision);
  const relationalRevision = positiveRevision(relationalOrder.revision ?? relationalOrder.currentRevision);
  if (
    relationalRevision <= appRevision &&
    !shouldPreferRelationalOrderCorrectionReadModel(nextOrders[index], relationalOrder)
  ) {
    return nextOrders;
  }
  const appStateOrder = nextOrders[index];
  const appTransferAt = Math.max(0, Number(appStateOrder?.lastTableTransferAtMs) || 0);
  const relationalTransferAt = Math.max(0, Number(relationalOrder?.lastTableTransferAtMs) || 0);
  nextOrders[index] = appTransferAt > relationalTransferAt
    ? {
        ...relationalOrder,
        tableId: appStateOrder.tableId,
        roomId: appStateOrder.roomId,
        table: appStateOrder.table,
        tableNumber: appStateOrder.tableNumber,
        tableLabel: appStateOrder.tableLabel,
        logicalTableLabel: appStateOrder.logicalTableLabel,
        lastTableTransferAtMs: appStateOrder.lastTableTransferAtMs,
      }
    : relationalOrder;
  return nextOrders;
}

export async function readScopedIntegrationOrdersDb(options = {}) {
  const {
    createDefaultIntegrationState,
    domainsRepository,
    enabled,
    logger = console,
    relationalOrdersHistoryReadEnabled = false,
    relationalOrdersLookupReadEnabled = false,
    relationalOrdersRepository,
    relationalRuntime,
    requestUrl,
  } = options;
  if (!enabled || !domainsRepository?.enabled || !shouldUseScopedOrdersRead(requestUrl)) return null;
  if (
    typeof domainsRepository.readObjectArrayField !== "function" ||
    typeof domainsRepository.readObjectEntry !== "function" ||
    typeof domainsRepository.readDomainValue !== "function" ||
    typeof createDefaultIntegrationState !== "function"
  ) {
    return null;
  }

  try {
    const station = String(requestUrl?.searchParams?.get("station") ?? "").trim();
    if (station) ensureScopedStationDoneHistoryLimit(requestUrl?.searchParams);
    const includeTransferred =
      String(requestUrl?.searchParams?.get("includeTransferred") ?? "").trim() === "1";
    const lookupCandidates = orderLookupCandidates(requestUrl?.searchParams);
    const hasOrderLookup = lookupCandidates.length > 0;
    const relationalOrders = await readRelationalOrdersHistory({
      enabled: relationalOrdersHistoryReadEnabled,
      logger,
      relationalOrdersRepository,
      relationalRuntime,
      requestUrl,
    });
    const relationalLookupOrderPromise = readRelationalOrderLookup({
      enabled: relationalOrdersLookupReadEnabled && !Array.isArray(relationalOrders) && hasOrderLookup,
      logger,
      relationalOrdersRepository,
      relationalRuntime,
      requestUrl,
    });
    const readScopedOrders = async () => {
      if (station) {
        if (typeof domainsRepository.readIntegrationOrdersForStation === "function") {
          const indexedOrders = await domainsRepository.readIntegrationOrdersForStation(
            station,
            { includeTransferred, fallback: null },
          );
          if (Array.isArray(indexedOrders)) return indexedOrders;
        }
        if (typeof domainsRepository.readObjectArrayFieldMatchingText === "function") {
          return domainsRepository.readObjectArrayFieldMatchingText("integration", "orders", station, []);
        }
      }
      return domainsRepository.readObjectArrayField("integration", "orders", []);
    };
    const readScopedOrderLookup = async () => {
      if (!hasOrderLookup || station || typeof domainsRepository.readObjectArrayEntry !== "function") {
        return readScopedOrders();
      }
      for (const candidate of lookupCandidates) {
        const order = await domainsRepository.readObjectArrayEntry(
          "integration",
          "orders",
          candidate,
          null,
        );
        if (order) return [order];
      }
      return [];
    };
    const readOrders = Array.isArray(relationalOrders)
      ? relationalOrders
      : hasOrderLookup
        ? readScopedOrderLookup()
        : readScopedOrders();
    const [
      orders,
      tableGroups,
      orderComps,
      orderCorrections,
      lastWriteAt,
      posSettings,
      menuItems,
      users,
      relationalLookupOrder,
    ] = await Promise.all([
      readOrders,
      domainsRepository.readObjectEntry("integration", "tableGroups", []),
      domainsRepository.readObjectEntry("integration", "orderComps", []),
      domainsRepository.readObjectEntry("integration", "orderCorrections", []),
      domainsRepository.readObjectEntry("integration", "lastWriteAt", ""),
      domainsRepository.readDomainValue("posSettings", {}),
      domainsRepository.readDomainValue("menuItems", []),
      domainsRepository.readDomainValue("users", []),
      relationalLookupOrderPromise,
    ]);
    const createdAt = String(lastWriteAt || new Date().toISOString());
    const reconciledOrders = mergeRelationalLookupOrder(orders, relationalLookupOrder);
    const responseOrders = station
      ? limitScopedStationDoneHistory(reconciledOrders, requestUrl?.searchParams)
      : reconciledOrders;
    return {
      __scopedReadOnly: "integration.orders",
      meta: { lastWriteAt: createdAt },
      integration: {
        ...createDefaultIntegrationState(createdAt),
        lastWriteAt: createdAt,
        orders: responseOrders,
        tableGroups: Array.isArray(tableGroups) ? tableGroups : [],
        orderComps: Array.isArray(orderComps) ? orderComps : [],
        orderCorrections: Array.isArray(orderCorrections) ? orderCorrections : [],
      },
      menuItems: Array.isArray(menuItems) ? menuItems : [],
      posSettings: posSettings && typeof posSettings === "object" ? posSettings : {},
      users: Array.isArray(users) ? users : [],
    };
  } catch (error) {
    logger.warn?.(
      `[scoped-reads] integration.orders fallback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
