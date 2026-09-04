import { normalizeTableCovers } from "../tables/table-capacity.domain.js";

function defaultRoundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeSeatedAt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function resolveNowMs(nowMs) {
  const value = typeof nowMs === "function" ? nowMs() : nowMs;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : Date.now();
}

export function buildOrderTableFinancialPlan({
  currentTable,
  currentPendingBills = [],
  live,
  nextPendingBills = [],
  nowMs = Date.now,
  roundMoney = defaultRoundMoney,
  sessionStartMs = 0,
} = {}) {
  const table = currentTable && typeof currentTable === "object" ? currentTable : {};
  const safeLive = live && typeof live === "object" ? live : {};
  const tableId = String(table.id ?? "").trim();
  const money = typeof roundMoney === "function" ? roundMoney : defaultRoundMoney;
  const currentSeatedAtMs = normalizeSeatedAt(table.seatedAt);
  const safeSessionStartMs = Number.isFinite(Number(sessionStartMs)) && Number(sessionStartMs) > 0
    ? Math.trunc(Number(sessionStartMs))
    : 0;
  const liveEarliestOrderAtMs =
    Number.isFinite(Number(safeLive.earliestOrderAtMs)) &&
    Number(safeLive.earliestOrderAtMs) > 0
      ? Math.trunc(Number(safeLive.earliestOrderAtMs))
      : null;
  const nextTotalDue = money(Math.max(Number(safeLive.amountDue) || 0, 0));
  const nextOrdersInProgress = Math.max(
    Math.trunc(Number(safeLive.ordersInProgress) || 0),
    0,
  );
  const currentCovers = normalizeTableCovers(table.covers);
  const liveCovers = normalizeTableCovers(safeLive.covers);
  const nextStatus =
    nextTotalDue > 0
      ? "payment_due"
      : nextOrdersInProgress > 0
        ? "waiting"
        : table.status === "payment_due" || table.status === "waiting"
          ? "no_orders"
          : table.status;
  const nextIsSeated = nextStatus !== "free" && nextStatus !== "reserved";
  const nextCovers = nextIsSeated
    ? Math.max(currentCovers, liveCovers)
    : nextStatus === "free"
      ? 0
      : currentCovers;
  let nextSeatedAt = null;
  if (nextIsSeated) {
    const fallbackSessionStartMs = safeSessionStartMs > 0 ? safeSessionStartMs : null;
    if (
      liveEarliestOrderAtMs &&
      (!currentSeatedAtMs || currentSeatedAtMs > liveEarliestOrderAtMs + 1000)
    ) {
      nextSeatedAt = liveEarliestOrderAtMs;
    } else {
      nextSeatedAt =
        currentSeatedAtMs ??
        fallbackSessionStartMs ??
        liveEarliestOrderAtMs ??
        resolveNowMs(nowMs);
    }
  }

  const changed = !(
    nextTotalDue === money(Math.max(Number(table.totalDue) || 0, 0)) &&
    nextTotalDue === money(Math.max(Number(table.amountDue) || 0, 0)) &&
    nextTotalDue === money(Math.max(Number(table.dueAmount) || 0, 0)) &&
    JSON.stringify(nextPendingBills) === JSON.stringify(currentPendingBills) &&
    nextStatus === table.status &&
    nextCovers === currentCovers &&
    nextSeatedAt === currentSeatedAtMs
  );
  const patch = {
    status: nextStatus,
    seatedAt: nextSeatedAt,
    covers: nextCovers,
    totalDue: nextTotalDue,
    amountDue: nextTotalDue,
    dueAmount: nextTotalDue,
    pendingBills: nextPendingBills,
  };
  return {
    changed,
    tableId,
    patch,
    nextTable: changed ? { ...table, ...patch } : table,
  };
}
