import { buildOrderTableFinancialPlan } from "./order-table-financial-plan.js";
import { normalizeTableCovers } from "../tables/table-capacity.domain.js";

export function buildOrderFinancialSyncState({ baseState, orderSnapshot } = {}) {
  const state = baseState && typeof baseState === "object" ? baseState : {};
  const snapshotOrders = Array.isArray(orderSnapshot?.orders) ? orderSnapshot.orders : null;
  if (!snapshotOrders) {
    return {
      state,
      sourceKind: "dbcache",
      externalized: false,
    };
  }
  return {
    state: {
      ...state,
      integration: {
        ...(state.integration && typeof state.integration === "object"
          ? state.integration
          : {}),
        orders: snapshotOrders,
      },
    },
    sourceKind: String(orderSnapshot.sourceKind ?? orderSnapshot.__orderWorkflowSnapshotSource ?? "order-snapshot"),
    externalized: orderSnapshot.externalized === true,
  };
}

function text(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}

function positiveMoney(value) {
  return money(Math.max(Number(value) || 0, 0));
}

function normalizeIdList(value) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(source.map(text).filter(Boolean))];
}

function normalizeRevision(value, fallback = 1) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function billSubtotal(bill = {}) {
  const lineTotal = (Array.isArray(bill.lines) ? bill.lines : []).reduce(
    (sum, line) => sum + positiveMoney(line?.lineTotal),
    0,
  );
  return positiveMoney(Math.max(Number(bill.subtotal) || 0, lineTotal));
}

function normalizeDeltaBillLine(item = {}, fallbackIndex = 0) {
  if (!item || item.voidedAt) return null;
  const qty = Math.max(1, Math.trunc(Number(item.qty ?? item.quantity) || 1));
  const unitPrice = positiveMoney(item.unitPriceApplied ?? item.unitPrice ?? item.listPriceAtTime);
  const lineTotal = positiveMoney(item.lineTotal ?? item.total ?? unitPrice * qty);
  if (lineTotal <= 0.009) return null;
  const name = text(item.productNameSnapshot || item.name) || "Articolo";
  return {
    name,
    qty,
    unitPrice: unitPrice > 0 ? unitPrice : money(lineTotal / qty),
    lineTotal,
    ...(text(item.productId) ? { productId: text(item.productId) } : {}),
    ...(text(item.lineId) ? { lineId: text(item.lineId) } : { lineId: `line_${fallbackIndex + 1}` }),
    ...(text(item.variant || item.variantName || item.selectedVariantName) ? { variant: text(item.variant || item.variantName || item.selectedVariantName) } : {}),
    ...(text(item.note || item.notes) ? { note: text(item.note || item.notes) } : {}),
  };
}

function normalizeDeltaBill(bill = {}, fallbackId = "bill") {
  const lines = (Array.isArray(bill.lines) ? bill.lines : [])
    .map((line, index) => normalizeDeltaBillLine(line, index))
    .filter(Boolean);
  const subtotal = positiveMoney(Math.max(Number(bill.subtotal) || 0, billSubtotal({ lines })));
  if (subtotal <= 0.009) return null;
  return {
    id: text(bill.id) || fallbackId,
    createdAt: text(bill.createdAt) || new Date().toISOString(),
    subtotal,
    lines: lines.length ? lines : [{ name: "Conto", qty: 1, unitPrice: subtotal, lineTotal: subtotal }],
    orderId: text(bill.orderId),
    orderIds: normalizeIdList(bill.orderIds),
  };
}

function buildDeltaBillFromOrder(order = {}, settings = {}) {
  if (!isPayable(order, settings)) return null;
  const orderId = text(order.id);
  const dueAmount = positiveMoney(order.dueAmount);
  if (!orderId || dueAmount <= 0.009 || text(order.paymentStatus).toLowerCase() === "paid") return null;
  const lines = (Array.isArray(order.items) ? order.items : [])
    .map((item, index) => normalizeDeltaBillLine(item, index))
    .filter(Boolean);
  const lineSubtotal = billSubtotal({ lines });
  const residualOnly = lineSubtotal > dueAmount + 0.009;
  return normalizeDeltaBill({
    id: `order_${orderId}`,
    createdAt: order.createdAt,
    subtotal: dueAmount,
    lines: residualOnly || !lines.length ? [{ name: `Comanda #${orderId}`, qty: 1, unitPrice: dueAmount, lineTotal: dueAmount }] : lines,
    orderId,
    orderIds: [orderId],
  }, `order_${orderId}`);
}

function billMatchesOrder(bill = {}, orderId = "") {
  const id = text(orderId);
  if (!id) return false;
  if (text(bill.orderId) === id) return true;
  return normalizeIdList(bill.orderIds).includes(id);
}

function resolveOrderSessionAtMs(order = {}) {
  const receivedAtMs = Number(order.receivedAtMs);
  const transferredAtMs = Number(order.lastTableTransferAtMs);
  const effective = Number.isFinite(transferredAtMs) && transferredAtMs > 0 ? Math.max(receivedAtMs, transferredAtMs) : receivedAtMs;
  return Number.isFinite(effective) && effective > 0 ? Math.trunc(effective) : 0;
}

function normalizeRoomNumberKey(table = {}) {
  const roomId = text(table.roomId);
  const number = Math.trunc(Number(table.number) || 0);
  return roomId && number > 0 ? `${roomId}:${number}` : "";
}

function normalizeWorkflow(value) {
  return text(value).toLowerCase();
}

function isCancelledWorkflow(value) {
  return ["cancelled", "canceled", "voided", "annullato", "annullata"].includes(normalizeWorkflow(value));
}

function normalizeWorkflowSettings(settings = {}) {
  const workflow = settings?.orderWorkflow && typeof settings.orderWorkflow === "object" ? settings.orderWorkflow : {};
  return {
    deliveryConfirmationEnabled: workflow.deliveryConfirmationEnabled !== false,
    requireDeliveredForPayment: workflow.requireDeliveredForPayment === true,
  };
}

function routeReady(route) {
  if (!route || typeof route !== "object") return false;
  return Boolean(route.readyAt || route.deliveredAt || route.pickedUpAt || route.done === true);
}

function isReadyForDelivery(order = {}) {
  const workflow = normalizeWorkflow(order.workflowStatus);
  if (workflow === "ready" || workflow === "delivered") return true;
  if (Number.isFinite(Number(order.readyAtMs)) && Number(order.readyAtMs) > 0) return true;
  const routes = Array.isArray(order.lineRoutes) ? order.lineRoutes : [];
  return routes.length > 0 && routes.every(routeReady);
}

function isPayable(order = {}, settings = {}) {
  const workflowSettings = normalizeWorkflowSettings(settings);
  const workflow = normalizeWorkflow(order.workflowStatus);
  if (workflowSettings.requireDeliveredForPayment) return workflow === "delivered";
  if (isCancelledWorkflow(workflow)) return false;
  if (workflowSettings.deliveryConfirmationEnabled === false) return workflow === "ready" || workflow === "delivered" || isReadyForDelivery(order);
  return true;
}

function isInProgress(order = {}, settings = {}) {
  const workflowSettings = normalizeWorkflowSettings(settings);
  const workflow = normalizeWorkflow(order.workflowStatus);
  return workflow === "waiting" || workflow === "prep" || (workflow === "ready" && workflowSettings.deliveryConfirmationEnabled !== false);
}

function financialItemSignature(item = {}) {
  return {
    lineId: text(item.lineId || item.id),
    productId: text(item.productId),
    name: text(item.productNameSnapshot || item.name),
    qty: Math.max(0, Number(item.qty ?? item.quantity) || 0),
    lineTotal: money(item.lineTotal ?? item.total),
    unitPriceApplied: money(item.unitPriceApplied ?? item.unitPrice),
    listPriceAtTime: money(item.listPriceAtTime),
    voidedAt: text(item.voidedAt || item.cancelledAt || item.canceledAt),
    variant: text(item.variant || item.variantName || item.selectedVariantName),
    note: text(item.note || item.notes),
  };
}

function financialOrderSignature(order = {}, settings = {}) {
  const workflow = normalizeWorkflow(order.workflowStatus);
  return {
    id: text(order.id),
    tableId: text(order.tableId),
    roomId: text(order.roomId),
    tableNumber: text(order.tableNumber || order.table),
    total: money(order.total),
    paidAmount: money(order.paidAmount),
    dueAmount: money(order.dueAmount),
    paymentStatus: text(order.paymentStatus).toLowerCase(),
    covers: normalizeTableCovers(order.covers),
    receivedAtMs: Math.max(0, Math.trunc(Number(order.receivedAtMs) || 0)),
    lastTableTransferAtMs: Math.max(0, Math.trunc(Number(order.lastTableTransferAtMs) || 0)),
    inProgress: isInProgress(order, settings),
    payable: isPayable(order, settings),
    cancelled: isCancelledWorkflow(workflow),
    paidArticleUnits: Array.isArray(order.paidArticleUnits) ? order.paidArticleUnits.map(text).filter(Boolean).sort() : [],
    items: (Array.isArray(order.items) ? order.items : []).map(financialItemSignature),
  };
}

function findTable(settings = {}, tableId = "") {
  const id = text(tableId);
  if (!id) return null;
  return (Array.isArray(settings.tables) ? settings.tables : []).find((table) => text(table?.id) === id) ?? null;
}

function pendingBillMatchesOrder(table = {}, signature = {}) {
  const orderId = text(signature.id);
  if (!orderId) return false;
  return (Array.isArray(table.pendingBills) ? table.pendingBills : []).some((bill) => {
    if (text(bill?.orderId) === orderId) return true;
    return Array.isArray(bill?.orderIds) && bill.orderIds.some((entry) => text(entry) === orderId);
  });
}

function tableLooksCompatible(settings = {}, signature = {}) {
  const table = findTable(settings, signature.tableId);
  if (!table) return false;
  const status = text(table.status).toLowerCase();
  const totalDue = money(table.totalDue ?? table.amountDue ?? table.dueAmount);
  if (signature.payable && signature.dueAmount > 0.009) return pendingBillMatchesOrder(table, signature) || totalDue + 0.009 >= signature.dueAmount;
  if (signature.inProgress) return Math.trunc(Number(table.ordersInProgress) || 0) > 0 || totalDue > 0.009 || !["", "free", "no_orders", "reserved"].includes(status);
  return true;
}

export function buildOrderSyncFinancialNoopFastPath({
  currentOrder,
  enabled = true,
  mergedOrder,
  queuePromotions = [],
  selectionHandoffDemotions = [],
  settings = {},
} = {}) {
  if (enabled !== true) return { skipped: false, reason: "disabled", financialSync: null };
  if ((Array.isArray(queuePromotions) && queuePromotions.length > 0) || (Array.isArray(selectionHandoffDemotions) && selectionHandoffDemotions.length > 0)) {
    return { skipped: false, reason: "queue_side_effects", financialSync: null };
  }
  const before = financialOrderSignature(currentOrder, settings);
  const after = financialOrderSignature(mergedOrder, settings);
  if (!before.id || !after.id || before.id !== after.id || !after.tableId || before.tableId !== after.tableId) {
    return { skipped: false, reason: "target_changed", financialSync: null };
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return { skipped: false, reason: "financial_signature_changed", financialSync: null };
  }
  if (!tableLooksCompatible(settings, after)) {
    return { skipped: false, reason: "table_not_compatible", financialSync: null };
  }
  return {
    skipped: true,
    reason: "financial_signature_unchanged",
    financialSync: { changed: false, tableIds: [], tableSnapshotsById: new Map() },
  };
}

export function buildOrderCreateFinancialDeltaFastPath({
  appState,
  enabled = true,
  linkedTableIds = [],
  order,
  targetTableIds = [],
} = {}) {
  if (enabled !== true) return { applied: false, reason: "disabled", financialSync: null };
  const tableId = text(order?.tableId);
  const orderId = text(order?.id);
  const targetIds = normalizeIdList(targetTableIds);
  const linkedIds = normalizeIdList(linkedTableIds);
  if (!orderId || !tableId || targetIds.length !== 1 || targetIds[0] !== tableId) return { applied: false, reason: "target_not_single", financialSync: null };
  if (linkedIds.some((id) => id !== tableId)) return { applied: false, reason: "linked_tables", financialSync: null };
  const settings = appState?.posSettings && typeof appState.posSettings === "object" ? appState.posSettings : {};
  const tables = Array.isArray(settings.tables) ? settings.tables : [];
  const tableIndex = tables.findIndex((table) => text(table?.id) === tableId);
  if (tableIndex < 0) return { applied: false, reason: "table_not_found", financialSync: null };
  const orderBill = buildDeltaBillFromOrder(order, settings);
  const orderInProgress = isInProgress(order, settings);
  if (!orderBill && !orderInProgress) return { applied: false, reason: "order_not_payable", financialSync: null };
  const currentTable = tables[tableIndex] && typeof tables[tableIndex] === "object" ? tables[tableIndex] : {};
  const currentPendingBills = (Array.isArray(currentTable.pendingBills) ? currentTable.pendingBills : []).map((bill, index) => normalizeDeltaBill(bill, `${tableId}_bill_${index + 1}`)).filter(Boolean);
  const nextPendingBills = (orderBill ? [...currentPendingBills.filter((bill) => !billMatchesOrder(bill, orderId)), orderBill] : currentPendingBills).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const amountDue = positiveMoney(nextPendingBills.reduce((sum, bill) => sum + billSubtotal(bill), 0));
  const orderAtMs = resolveOrderSessionAtMs(order);
  const live = { amountDue, covers: Math.max(normalizeTableCovers(currentTable.covers), normalizeTableCovers(order.covers)), earliestOrderAtMs: orderAtMs || null, ordersInProgress: orderInProgress ? 1 : 0, pendingBills: nextPendingBills };
  const plan = buildOrderTableFinancialPlan({ currentTable, currentPendingBills, live, nextPendingBills, roundMoney: money, sessionStartMs: Number(currentTable.seatedAt) || orderAtMs || 0 });
  const nextSettings = plan.changed ? { ...settings, tables: tables.map((table, index) => (index === tableIndex ? plan.nextTable : table)) } : settings;
  if (plan.changed && appState && typeof appState === "object") appState.posSettings = nextSettings;
  const byId = new Map([[tableId, live]]);
  const roomKey = normalizeRoomNumberKey(currentTable);
  const byRoomNumber = new Map(roomKey ? [[roomKey, live]] : []);
  return { applied: true, reason: plan.changed ? (orderBill ? "delta_applied" : "waiting_delta_applied") : "already_current", financialSync: { settings: nextSettings, liveStats: { byId, byRoomNumber }, tableSnapshotsById: new Map(), changed: plan.changed, tableIds: plan.changed ? [tableId] : [] } };
}

export function buildOrderCreateFinancialDeltaBeforeSnapshotFastPath({
  appState,
  enabled = true,
  guardTokens = [],
  linkedTableIds = [],
  order,
  targetTableIds = [],
} = {}) {
  if (enabled !== true) return { applied: false, reason: "disabled", financialSync: null };
  const targetIds = normalizeIdList(targetTableIds);
  if (targetIds.length !== 1) return { applied: false, reason: "target_not_single", financialSync: null };
  const tableId = targetIds[0];
  const settings = appState?.posSettings && typeof appState.posSettings === "object" ? appState.posSettings : {};
  const table = (Array.isArray(settings.tables) ? settings.tables : []).find((entry) => text(entry?.id ?? entry?.tableId) === tableId);
  const token = (Array.isArray(guardTokens) ? guardTokens : []).find((entry) => text(entry?.tableId) === tableId);
  if (!table || !token?.exists) return { applied: false, reason: "guard_missing", financialSync: null };
  if (normalizeRevision(table.revision ?? table.currentRevision, 1) !== normalizeRevision(token.revision, 1)) {
    return { applied: false, reason: "guard_mismatch", financialSync: null };
  }
  return buildOrderCreateFinancialDeltaFastPath({
    appState,
    enabled,
    linkedTableIds,
    order,
    targetTableIds,
  });
}

export function buildOrderCancelFinancialDeltaBeforeSnapshotFastPath({
  appState,
  currentOrder,
  enabled = true,
  guardTokens = [],
  linkedTableIds = [],
  nextOrder,
  targetTableIds = [],
} = {}) {
  if (enabled !== true) return { applied: false, reason: "disabled", financialSync: null };
  const targetIds = normalizeIdList(targetTableIds);
  const linkedIds = normalizeIdList(linkedTableIds);
  const orderId = text(nextOrder?.id || currentOrder?.id);
  const tableId = text(nextOrder?.tableId || currentOrder?.tableId);
  if (!orderId || !tableId || targetIds.length !== 1 || targetIds[0] !== tableId) return { applied: false, reason: "target_not_single", financialSync: null };
  if (linkedIds.some((id) => id !== tableId)) return { applied: false, reason: "linked_tables", financialSync: null };
  const settings = appState?.posSettings && typeof appState.posSettings === "object" ? appState.posSettings : {};
  const tables = Array.isArray(settings.tables) ? settings.tables : [];
  const tableIndex = tables.findIndex((table) => text(table?.id ?? table?.tableId) === tableId);
  const currentTable = tableIndex >= 0 && tables[tableIndex] && typeof tables[tableIndex] === "object" ? tables[tableIndex] : null;
  const token = (Array.isArray(guardTokens) ? guardTokens : []).find((entry) => text(entry?.tableId) === tableId);
  const tokenTable = token?.tableSnapshot && typeof token.tableSnapshot === "object" && text(token.tableSnapshot.id ?? token.tableSnapshot.tableId) === tableId ? { ...token.tableSnapshot, id: tableId, tableId } : null;
  if ((!currentTable && !tokenTable) || !token?.exists) return { applied: false, reason: "guard_missing", financialSync: null };
  const currentRevisionMatches = currentTable && normalizeRevision(currentTable.revision ?? currentTable.currentRevision, 1) === normalizeRevision(token.revision, 1);
  if (!currentRevisionMatches && !tokenTable) {
    return { applied: false, reason: "guard_mismatch", financialSync: null };
  }
  const effectiveTables = currentRevisionMatches ? tables : (tableIndex >= 0 ? tables.map((table, index) => (index === tableIndex ? tokenTable : table)) : [...tables, tokenTable]);
  const effectiveTableIndex = currentRevisionMatches ? tableIndex : effectiveTables.findIndex((table) => text(table?.id ?? table?.tableId) === tableId);
  const effectiveTable = effectiveTableIndex >= 0 ? effectiveTables[effectiveTableIndex] : null;
  if (!effectiveTable) return { applied: false, reason: "guard_missing", financialSync: null };
  const effectiveSettings = currentRevisionMatches ? settings : { ...settings, tables: effectiveTables };
  const before = financialOrderSignature(currentOrder, effectiveSettings);
  const after = financialOrderSignature(nextOrder, effectiveSettings);
  if (!before.id || !after.id || before.id !== orderId || after.id !== orderId || before.tableId !== tableId || after.tableId !== tableId) {
    return { applied: false, reason: "target_changed", financialSync: null };
  }
  if (!after.cancelled || after.dueAmount > 0.009 || after.total > 0.009) {
    return { applied: false, reason: "not_cancelled", financialSync: null };
  }
  const beforeHadPendingBill = pendingBillMatchesOrder(effectiveTable, before);
  if (before.payable && before.dueAmount > 0.009 && !beforeHadPendingBill) {
    return { applied: false, reason: "missing_pending_bill", financialSync: null };
  }
  const currentPendingBills = (Array.isArray(effectiveTable.pendingBills) ? effectiveTable.pendingBills : [])
    .map((bill, index) => normalizeDeltaBill(bill, `${tableId}_bill_${index + 1}`))
    .filter(Boolean);
  const nextPendingBills = currentPendingBills.filter((bill) => !billMatchesOrder(bill, orderId));
  const amountDue = positiveMoney(nextPendingBills.reduce((sum, bill) => sum + billSubtotal(bill), 0));
  const currentOrdersInProgress = Math.max(Math.trunc(Number(effectiveTable.ordersInProgress) || 0), 0);
  const nextOrdersInProgress = Math.max(currentOrdersInProgress - (before.inProgress ? 1 : 0), 0);
  const live = {
    amountDue,
    covers: Math.max(normalizeTableCovers(effectiveTable.covers), normalizeTableCovers(currentOrder?.covers)),
    earliestOrderAtMs: null,
    ordersInProgress: nextOrdersInProgress,
    pendingBills: nextPendingBills,
  };
  const plan = buildOrderTableFinancialPlan({
    currentTable: effectiveTable,
    currentPendingBills,
    live,
    nextPendingBills,
    roundMoney: money,
    sessionStartMs: Number(effectiveTable.seatedAt) || 0,
  });
  const nextSettings = plan.changed ? { ...effectiveSettings, tables: effectiveTables.map((table, index) => (index === effectiveTableIndex ? plan.nextTable : table)) } : effectiveSettings;
  if (plan.changed && appState && typeof appState === "object") appState.posSettings = nextSettings;
  const byId = new Map([[tableId, live]]);
  const roomKey = normalizeRoomNumberKey(effectiveTable);
  const byRoomNumber = new Map(roomKey ? [[roomKey, live]] : []);
  return {
    applied: true,
    reason: plan.changed ? "delta_applied" : "already_current",
    financialSync: {
      settings: nextSettings,
      liveStats: { byId, byRoomNumber },
      tableSnapshotsById: new Map(),
      changed: plan.changed,
      tableIds: plan.changed ? [tableId] : [],
    },
  };
}

export function addOrderSyncFinancialNoopTableSnapshot(financialSync = {}, tableId = "", tableSnapshot = null) {
  const id = text(tableId);
  if (!id || !tableSnapshot || typeof tableSnapshot !== "object") return financialSync;
  if (!(financialSync.tableSnapshotsById instanceof Map)) financialSync.tableSnapshotsById = new Map();
  if (!financialSync.tableSnapshotsById.has(id)) financialSync.tableSnapshotsById.set(id, tableSnapshot);
  return financialSync;
}
