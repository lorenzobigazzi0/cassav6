/**
 * Modello di `monitor.control` (P2b, dominio `app_meta`).
 *
 * E l'unica route amministrativa del dominio che muta l'app-state, e comprende
 * `reset_all_tables`. Il handler non era estraibile da solo: si portava dietro
 * un grappolo di 25 funzioni locali per 521 righe, che sono qui insieme a lui.
 *
 * La chiusura transitiva e stata calcolata inseguendo i **riferimenti** e non
 * solo le chiamate: `paymentIsActive` e passata a `.filter()` e con il solo
 * criterio delle chiamate sarebbe rimasta indietro.
 *
 * Rispetto al codice di partenza cambiano due sole cose: `payload` arriva come
 * parametro invece che dalla richiesta, e l'unica risposta viene restituita
 * invece che inviata. La guardia di configurazione si divide: qui resta la
 * meta su `writeDb`, nel handler quella su `readJsonBody`.
 *
 * `removePaymentsForOrderIds` viaggia con il blocco e **non e usata da
 * nessuno**: e arrivata cosi ed e stata spostata com'era. Cancellarla e una
 * decisione a se.
 */
import { normalizeTableCovers } from "../tables/table-capacity.domain.js";

export function createMonitorControlModel({
  HttpError,
  appendAuditEvent,
  asArray,
  buildAuditActor,
  buildMonitorOverview,
  clearIntegrationHotResponseCaches,
  compactOrder,
  compactOrderItem,
  isPaidPaymentStatus,
  normalizeText,
  nowIso,
  orderDueAmount,
  publishIntegrationNotificationStreamRefresh,
  readDb,
  roundMoney,
  syncMonitorResetExternalStores,
  tableRoomId,
  writeDb,
}) {
  const MONITOR_RESET_ALL_WRITE_DOMAINS = [
    "integration",
    "posSettings",
    "payments",
    "paymentContainers",
    "paymentParts",
    "paymentTransactions",
    "cashTxDenoms",
    "paymentProviderTransactions",
    "fiscalReceipts",
    "fiscalEvents",
    "printSpoolJobs",
    "tableLocks",
    "posTableRoomMoveRequests",
    "posRoomChangeRequests",
    "posReservationLocks",
    "posReservationStates",
    "saleSessions",
    "auditEvents",
    "smartNonFiscal",
    "commercialBenefitApplications",
    "commercialBenefitRedemptions",
  ];
  function createControlError(status, message, details = null) {
    if (typeof HttpError === "function") {
      return new HttpError(status, message, details ? { details } : undefined);
    }
    const error = new Error(message);
    error.status = status;
    if (details) error.details = details;
    return error;
  }

  function cloneJson(value, fallback = null) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return fallback;
    }
  }

  function orderLookupTokens(value) {
    const raw = normalizeText(value).toLowerCase();
    if (!raw) return new Set();
    const compact = raw
      .replace(/^comanda\s*/i, "")
      .replace(/^order[_\s:#-]*/i, "")
      .replace(/^#/, "")
      .trim();
    const noZeros = compact.replace(/^0+/, "") || "0";
    return new Set([raw, compact, `#${compact}`, `order_${compact}`, noZeros, `#${noZeros}`, `order_${noZeros}`]);
  }

  function findOrderIndex(db, orderId) {
    const orders = asArray(db?.integration?.orders);
    const tokens = orderLookupTokens(orderId);
    return orders.findIndex((order) => {
      const id = normalizeText(order?.id);
      if (!id) return false;
      const idTokens = orderLookupTokens(id);
      for (const token of tokens) {
        if (idTokens.has(token)) return true;
      }
      return false;
    });
  }

  function normalizeStatus(value, allowed, fallback) {
    const status = normalizeText(value).toLowerCase();
    return allowed.has(status) ? status : fallback;
  }

  function findTableIndex(db, input = {}) {
    const tables = asArray(db?.posSettings?.tables);
    const tableId = normalizeText(input.tableId ?? input.id);
    const roomId = normalizeText(input.roomId);
    const tableNumber = Number(input.tableNumber ?? input.number);
    if (tableId) {
      const byId = tables.findIndex((table) => normalizeText(table?.id) === tableId);
      if (byId >= 0) return byId;
    }
    if (roomId && Number.isFinite(tableNumber)) {
      return tables.findIndex(
        (table) =>
          tableRoomId(table) === roomId &&
          Number(table?.number ?? table?.tableNumber) === Math.trunc(tableNumber)
      );
    }
    if (Number.isFinite(tableNumber)) {
      return tables.findIndex((table) => Number(table?.number ?? table?.tableNumber) === Math.trunc(tableNumber));
    }
    return -1;
  }

  function resetTableRecord(table) {
    return {
      ...table,
      status: "free",
      guestName: "",
      customerName: "",
      customerPhone: "",
      note: "",
      notes: "",
      allergens: [],
      manualIntolerance: "",
      covers: 0,
      totalDue: 0,
      amountDue: 0,
      dueAmount: 0,
      pendingBills: [],
      orderHistory: [],
      ordersTaken: 0,
      ordersInProgress: 0,
      seatedAt: null,
      workLock: null,
      reservation: null,
      currentOrderId: null,
      activeOrderIds: [],
      paymentSession: null,
    };
  }

  function compactBillFromOrder(order) {
    const orderId = normalizeText(order?.id);
    const lines = asArray(order?.items)
      .filter((item) => !item?.voidedAt && !item?.removed && !item?.isRemoved)
      .map((item, index) => {
        const qty = Math.max(0, Number(item?.qty ?? item?.quantity) || 0);
        const lineTotal = roundMoney(item?.lineTotal ?? item?.finalLinePrice ?? 0);
        const unitPrice = qty > 0 ? roundMoney(lineTotal / qty) : roundMoney(item?.unitPriceApplied ?? item?.unitPrice ?? 0);
        return {
          name: normalizeText(item?.name ?? item?.productNameSnapshot ?? item?.productId) || "Articolo",
          qty,
          unitPrice,
          lineTotal,
          productId: normalizeText(item?.productId),
          lineId: normalizeText(item?.lineId) || `line_${index + 1}`,
        };
      })
      .filter((line) => line.qty > 0);
    return {
      id: orderId ? `order_${orderId}` : `order_${Date.now()}`,
      createdAt: normalizeText(order?.createdAt) || nowIso(),
      subtotal: orderDueAmount(order),
      lines,
      orderId,
      orderIds: orderId ? [orderId] : [],
    };
  }

  function syncTableBillForOrder(db, order) {
    const tableIndex = findTableIndex(db, {
      tableId: order?.tableId,
      roomId: order?.roomId,
      tableNumber: order?.tableNumber ?? order?.table,
    });
    if (tableIndex < 0) return;
    const table = db.posSettings.tables[tableIndex];
    const orderId = normalizeText(order?.id);
    const bills = asArray(table.pendingBills).filter((bill) => normalizeText(bill?.orderId) !== orderId);
    const due = orderDueAmount(order);
    const workflow = normalizeText(order?.workflowStatus).toLowerCase();
    const shouldKeepBill = orderId && due > 0 && workflow !== "cancelled" && !isPaidPaymentStatus(order?.paymentStatus);
    if (shouldKeepBill) {
      bills.push(compactBillFromOrder(order));
    }
    const totalDue = roundMoney(bills.reduce((sum, bill) => sum + Math.max(Number(bill?.subtotal ?? bill?.total) || 0, 0), 0));
    db.posSettings.tables[tableIndex] = {
      ...table,
      pendingBills: bills,
      totalDue,
      amountDue: totalDue,
      dueAmount: totalDue,
      ordersTaken: Math.max(Math.trunc(Number(table?.ordersTaken) || 0), bills.length),
      status: totalDue > 0 ? "payment_due" : bills.length > 0 ? "waiting" : table?.covers > 0 ? "occupied" : "free",
      guestName: totalDue > 0 || bills.length > 0 ? normalizeText(table?.guestName) || `Tavolo ${table?.number ?? ""}`.trim() : normalizeText(table?.guestName),
    };
    if (totalDue <= 0 && bills.length === 0 && Number(table?.covers || 0) <= 0) {
      db.posSettings.tables[tableIndex] = resetTableRecord(db.posSettings.tables[tableIndex]);
    }
  }

  function removeTableBillForOrderId(db, orderId) {
    const safeOrderId = normalizeText(orderId);
    if (!safeOrderId) return;
    db.posSettings.tables = asArray(db?.posSettings?.tables).map((table) => {
      const bills = asArray(table.pendingBills).filter((bill) => normalizeText(bill?.orderId) !== safeOrderId);
      if (bills.length === asArray(table.pendingBills).length) return table;
      const totalDue = roundMoney(bills.reduce((sum, bill) => sum + Math.max(Number(bill?.subtotal ?? bill?.total) || 0, 0), 0));
      const next = { ...table, pendingBills: bills, totalDue, amountDue: totalDue, dueAmount: totalDue };
      if (totalDue <= 0 && bills.length === 0 && Number(next.covers || 0) <= 0) return resetTableRecord(next);
      next.status = totalDue > 0 ? "payment_due" : next.status;
      return next;
    });
  }

  function collectOrderIdsFromPayments(records) {
    return [
      ...new Set(
        asArray(records)
          .flatMap((payment) => [payment?.orderId, ...asArray(payment?.orderIds)])
          .map(normalizeText)
          .filter(Boolean)
      ),
    ];
  }

  function paymentRecordMatches(record, paymentId) {
    const target = normalizeText(paymentId);
    return [
      record?.id,
      record?.paymentId,
      record?.paymentContainerId,
      record?.paymentTxId,
      record?.clientPaymentId,
    ].some((value) => normalizeText(value) === target);
  }

  function paymentIsActive(record) {
    const status = normalizeText(record?.status ?? record?.paymentStatus).toLowerCase();
    return !["cancelled", "canceled", "voided", "deleted", "failed"].includes(status);
  }

  function paymentIsPending(record) {
    const status = normalizeText(record?.status ?? record?.paymentStatus).toLowerCase();
    if (!status) return true;
    return ![
      "completed",
      "complete",
      "settled",
      "paid",
      "pagato",
      "pagata",
      "cancelled",
      "canceled",
      "voided",
      "deleted",
      "failed",
    ].includes(status);
  }

  function removeIntegrationOrderArtifacts(db, orderId) {
    const safeOrderId = normalizeText(orderId);
    if (!safeOrderId || !db.integration || typeof db.integration !== "object") return;
    db.integration.orderCorrections = asArray(db.integration.orderCorrections).filter(
      (entry) => normalizeText(entry?.orderId) !== safeOrderId
    );
    db.integration.orderCorrectionRequests = asArray(db.integration.orderCorrectionRequests).filter(
      (entry) => normalizeText(entry?.orderId) !== safeOrderId
    );
    db.integration.orderComps = asArray(db.integration.orderComps).filter(
      (entry) => normalizeText(entry?.orderId) !== safeOrderId
    );
    db.integration.barChargeReplacements = asArray(db.integration.barChargeReplacements).filter(
      (entry) =>
        normalizeText(entry?.orderId) !== safeOrderId &&
        normalizeText(entry?.originalOrderId) !== safeOrderId
    );
    db.integration.tickets = asArray(db.integration.tickets).filter(
      (entry) => normalizeText(entry?.orderId) !== safeOrderId
    );
  }

  function collectTableGroupIdsForTable(db, tableId) {
    const safeTableId = normalizeText(tableId);
    const ids = new Set(safeTableId ? [safeTableId] : []);
    if (!safeTableId) return ids;
    const flattenNodeIds = (node, output = []) => {
      const nodeId = normalizeText(node?.id ?? node?.tableId);
      if (nodeId) output.push(nodeId);
      asArray(node?.children).forEach((child) => flattenNodeIds(child, output));
      return output;
    };
    for (const group of asArray(db?.integration?.tableGroups)) {
      const groupIds = [
        group?.id,
        group?.tableId,
        group?.mainTableId,
        group?.sourceTableId,
        group?.targetTableId,
        ...asArray(group?.tableIds),
        ...asArray(group?.tables).map((table) => table?.id ?? table?.tableId),
        ...flattenNodeIds(group),
      ].map(normalizeText).filter(Boolean);
      if (!groupIds.includes(safeTableId)) continue;
      groupIds.forEach((id) => ids.add(id));
    }
    return ids;
  }

  function recalculateOrdersPaymentState(db, orderIds) {
    const ids = new Set(asArray(orderIds).map(normalizeText).filter(Boolean));
    if (ids.size === 0) return;
    const activePayments = [...asArray(db?.paymentContainers), ...asArray(db?.payments)].filter(paymentIsActive);
    db.integration.orders = asArray(db?.integration?.orders).map((entry) => {
      const order = { ...entry };
      const orderId = normalizeText(order.id);
      if (!ids.has(orderId)) return entry;
      const paid = roundMoney(
        activePayments.reduce((sum, payment) => {
          const paymentOrderIds = collectOrderIdsFromPayments([payment]);
          if (!paymentOrderIds.includes(orderId)) return sum;
          return sum + Math.max(Number(payment?.amount ?? payment?.totalAmount ?? payment?.amountPaid) || 0, 0);
        }, 0)
      );
      const total = roundMoney(order.total);
      const due = roundMoney(Math.max(total - paid, 0));
      order.paidAmount = paid;
      order.dueAmount = due;
      order.paymentStatus = due <= 0 && total > 0 ? "paid" : paid > 0 ? "partial" : "unpaid";
      order.updatedAt = nowIso();
      syncTableBillForOrder(db, order);
      return order;
    });
  }

  function removePaymentsForOrderIds(db, orderIds) {
    const ids = new Set(asArray(orderIds).map(normalizeText).filter(Boolean));
    if (ids.size === 0) return { removedContainers: [], removedPayments: [] };
    const matchesOrder = (payment) => collectOrderIdsFromPayments([payment]).some((orderId) => ids.has(orderId));
    const removedContainers = asArray(db.paymentContainers).filter(matchesOrder);
    const removedPayments = asArray(db.payments).filter(matchesOrder);
    const removedPaymentIds = new Set([...removedContainers, ...removedPayments].map((payment) => normalizeText(payment?.id)).filter(Boolean));
    db.paymentContainers = asArray(db.paymentContainers).filter((payment) => !matchesOrder(payment));
    db.payments = asArray(db.payments).filter((payment) => !matchesOrder(payment));
    db.paymentParts = asArray(db.paymentParts).filter((part) => !removedPaymentIds.has(normalizeText(part?.paymentId)));
    const remainingPartIds = new Set(asArray(db.paymentParts).map((part) => normalizeText(part?.id)).filter(Boolean));
    db.paymentTransactions = asArray(db.paymentTransactions).filter((tx) => !tx?.partId || remainingPartIds.has(normalizeText(tx.partId)));
    db.cashTxDenoms = asArray(db.cashTxDenoms).filter((denom) =>
      asArray(db.paymentTransactions).some((tx) => normalizeText(tx?.id) === normalizeText(denom?.txId))
    );
    return { removedContainers, removedPayments };
  }

  function ensureMonitorControlConfirm(payload, action) {
    if (payload?.confirm !== true) {
      throw createControlError(400, "Conferma operazione mancante.");
    }
    if (action === "reset_all_tables" && normalizeText(payload?.confirmText).toUpperCase() !== "RESET") {
      throw createControlError(400, "Per il reset totale scrivi RESET nella conferma.");
    }
  }

  function auditMonitorControl(db, req, payload, options = {}) {
    if (typeof appendAuditEvent !== "function") return;
    const context = req?.__authContext ?? {};
    const user = context.user ?? null;
    const session = context.session ?? null;
    const actor = typeof buildAuditActor === "function"
      ? buildAuditActor(user, { ...payload, sessionId: session?.id, deviceUuid: session?.deviceUuid })
      : {
          actorUserId: normalizeText(user?.id) || "system",
          actorRole: normalizeText(user?.role).toUpperCase() || "ADMIN",
          deviceId: normalizeText(session?.deviceUuid) || null,
          sessionId: normalizeText(session?.id) || null,
          username: normalizeText(user?.username) || "system",
        };
    appendAuditEvent(db, {
      ...actor,
      action: `monitor.${options.action ?? payload?.action ?? "control"}`,
      entityType: options.entityType ?? "monitor",
      entityId: options.entityId ?? (normalizeText(payload?.id ?? payload?.orderId ?? payload?.tableId ?? payload?.paymentId) || "control"),
      payload: {
        reason: normalizeText(payload?.reason),
        action: payload?.action,
        details: options.details ?? {},
      },
      before: options.before,
      after: options.after,
    });
  }

  function updateOrderFromPatch(order, patch = {}) {
    const next = { ...order };
    const workflowStatuses = new Set(["sent", "received", "preparation", "in_progress", "ready", "delivered", "cancelled"]);
    const paymentStatuses = new Set(["unpaid", "partial", "paid"]);
    if (patch.workflowStatus !== undefined) {
      next.workflowStatus = normalizeStatus(patch.workflowStatus, workflowStatuses, next.workflowStatus || "sent");
      if (next.workflowStatus === "ready" && !next.readyAtMs) next.readyAtMs = Date.now();
      if (["delivered", "cancelled"].includes(next.workflowStatus) && !next.completedAtMs) next.completedAtMs = Date.now();
    }
    if (patch.paymentStatus !== undefined) {
      next.paymentStatus = normalizeStatus(patch.paymentStatus, paymentStatuses, next.paymentStatus || "unpaid");
    }
    if (patch.note !== undefined) next.note = normalizeText(patch.note).slice(0, 500);
    if (patch.orderNote !== undefined) next.orderNote = normalizeText(patch.orderNote).slice(0, 500);
    if (patch.orderComment !== undefined) next.orderComment = normalizeText(patch.orderComment).slice(0, 500);
    if (patch.communications !== undefined) next.communications = normalizeText(patch.communications).slice(0, 500);
    if (patch.covers !== undefined && Number.isFinite(Number(patch.covers))) {
      next.covers = normalizeTableCovers(patch.covers);
    }
    if (Array.isArray(patch.items)) {
      next.items = patch.items.map(compactOrderItem).map((item, index) => ({
        ...asArray(order.items)[index],
        ...item,
        id: item.id || asArray(order.items)[index]?.id || `oi_${index + 1}`,
        lineId: item.lineId || asArray(order.items)[index]?.lineId || `line_${index + 1}`,
        qty: Math.max(0, Number(item.qty) || 0),
        lineTotal: roundMoney(item.lineTotal),
        finalLinePrice: roundMoney(item.lineTotal),
      }));
      if (patch.recalculateTotal !== false) {
        next.total = roundMoney(next.items.reduce((sum, item) => sum + Math.max(Number(item.lineTotal) || 0, 0), 0));
      }
    }
    if (patch.total !== undefined && Number.isFinite(Number(patch.total))) {
      next.total = roundMoney(Math.max(Number(patch.total), 0));
    }
    if (patch.paidAmount !== undefined && Number.isFinite(Number(patch.paidAmount))) {
      next.paidAmount = roundMoney(Math.max(Number(patch.paidAmount), 0));
    }
    const total = roundMoney(next.total);
    const paid = next.paymentStatus === "paid" ? total : roundMoney(next.paidAmount);
    next.paidAmount = paid;
    next.dueAmount = next.paymentStatus === "paid" ? 0 : roundMoney(Math.max(total - paid, 0));
    if (next.dueAmount <= 0 && total > 0) next.paymentStatus = "paid";
    if (next.workflowStatus === "cancelled") {
      const cancelledAt = nowIso();
      next.paymentStatus = "unpaid";
      next.paidAmount = 0;
      next.dueAmount = 0;
      next.completedAtMs = Date.parse(cancelledAt);
      next.items = asArray(next.items).map((item) => ({ ...item, voidedAt: item.voidedAt || cancelledAt }));
    }
    next.updatedAt = nowIso();
    return next;
  }

  function tableResetShouldCancelOrder(order) {
    if (!order || typeof order !== "object") return false;
    if (isPaidPaymentStatus(order?.paymentStatus)) return false;
    const workflow = normalizeText(order?.workflowStatus ?? order?.status).toLowerCase();
    if (["cancelled", "canceled", "voided", "deleted"].includes(workflow)) return false;
    return true;
  }

  function cancelOrdersForResetTableIds(db, tableIds) {
    const ids = new Set(asArray(tableIds).map(normalizeText).filter(Boolean));
    if (ids.size === 0 || !db.integration || typeof db.integration !== "object") {
      return [];
    }
    const cancelledOrderIds = [];
    db.integration.orders = asArray(db.integration.orders).map((order) => {
      const tableId = normalizeText(order?.tableId);
      if (!ids.has(tableId) || !tableResetShouldCancelOrder(order)) return order;
      const cancelled = updateOrderFromPatch(order, {
        workflowStatus: "cancelled",
        paymentStatus: "unpaid",
        paidAmount: 0,
        recalculateTotal: false,
      });
      cancelled.monitorResetAt = nowIso();
      cancelled.monitorResetReason = "table_reset";
      cancelledOrderIds.push(normalizeText(cancelled.id));
      return cancelled;
    });
    return cancelledOrderIds.filter(Boolean);
  }

  function resetTableLocksForIds(db, tableIds) {
    const ids = new Set(asArray(tableIds).map(normalizeText).filter(Boolean));
    if (ids.size === 0) return;
    db.tableLocks = asArray(db.tableLocks).filter((entry) => !ids.has(normalizeText(entry?.tableId)));
    db.posTableRoomMoveRequests = asArray(db.posTableRoomMoveRequests).filter((entry) => {
      return !ids.has(normalizeText(entry?.tableId)) && !ids.has(normalizeText(entry?.sourceTableId));
    });
    db.posReservationLocks = asArray(db.posReservationLocks).filter((entry) => !ids.has(normalizeText(entry?.tableId)));
    db.posReservationStates = asArray(db.posReservationStates).filter((entry) => !ids.has(normalizeText(entry?.tableId)));
    if (db.integration && typeof db.integration === "object") {
      db.integration.tableGroups = asArray(db.integration.tableGroups).filter((group) => {
        const groupTableIds = [
          group?.tableId,
          group?.mainTableId,
          group?.sourceTableId,
          group?.targetTableId,
          ...asArray(group?.tableIds),
          ...asArray(group?.tables).map((table) => table?.id ?? table?.tableId),
        ].map(normalizeText).filter(Boolean);
        return !groupTableIds.some((tableId) => ids.has(tableId));
      });
    }
  }

  function resetAllTablesState(db) {
    if (!db.posSettings || typeof db.posSettings !== "object") db.posSettings = {};
    const tableIds = asArray(db.posSettings.tables).map((table) => normalizeText(table?.id)).filter(Boolean);
    const before = {
      orders: asArray(db.integration?.orders).length,
      notifications: asArray(db.integration?.notifications).length,
      payments: asArray(db.payments).length + asArray(db.paymentContainers).length,
      paymentParts: asArray(db.paymentParts).length,
      paymentTransactions: asArray(db.paymentTransactions).length,
      providerTransactions: asArray(db.paymentProviderTransactions).length,
      fiscalReceipts: asArray(db.fiscalReceipts).length,
      fiscalEvents: asArray(db.fiscalEvents).length,
      printSpoolJobs: asArray(db.printSpoolJobs).length,
      auditEvents: asArray(db.auditEvents).length,
      saleSessions: asArray(db.saleSessions).length,
      reservationStates: asArray(db.posReservationStates).length,
    };
    db.posSettings.tables = asArray(db.posSettings.tables).map(resetTableRecord);
    if (!db.integration || typeof db.integration !== "object") db.integration = {};
    resetTableLocksForIds(db, tableIds);
    db.integration.orders = [];
    db.integration.notifications = [];
    db.integration.tickets = [];
    db.integration.recentBellClaims = [];
    db.integration.tableGroups = [];
    db.integration.barChargeReplacements = [];
    db.integration.orderCorrections = [];
    db.integration.orderCorrectionRequests = [];
    db.integration.orderFulfillmentHistory = [];
    db.integration.fulfillmentAnomalyStats = {};
    db.integration.orderComps = [];
    db.integration.noActiveStationsAlert = null;
    db.integration.waiterPauses = [];
    db.integration.waiterDeferredCalls = [];
    db.integration.orderTransferRequests = [];
    db.payments = [];
    db.paymentContainers = [];
    db.paymentParts = [];
    db.paymentTransactions = [];
    db.cashTxDenoms = [];
    db.paymentProviderTransactions = [];
    db.fiscalReceipts = [];
    db.fiscalEvents = [];
    db.printSpoolJobs = [];
    db.tableLocks = [];
    db.posTableRoomMoveRequests = [];
    db.posRoomChangeRequests = [];
    db.posReservationLocks = [];
    db.posReservationStates = [];
    db.saleSessions = [];
    db.auditEvents = [];
    db.integration.lastWriteAt = nowIso();
    return {
      resetTableIds: tableIds,
      cleared: before,
      preservedConfiguration: true,
      preservedUsers: asArray(db.users).length,
      preservedMenuItems: asArray(db.menuItems).length,
      preservedStationStates: asArray(db.integration.stationStates).length,
    };
  }

  async function applyMonitorControl(payload, req) {
    if (typeof writeDb !== "function") {
      throw createControlError(500, "Controlli monitor non configurati.");
    }
    const action = normalizeText(payload?.action).toLowerCase();
    ensureMonitorControlConfirm(payload, action);
    const db = await readDb();
    if (!db.integration || typeof db.integration !== "object") db.integration = {};
    if (!db.posSettings || typeof db.posSettings !== "object") db.posSettings = {};
    const beforeSummary = {
      orders: asArray(db.integration.orders).length,
      tables: asArray(db.posSettings.tables).filter((table) => table.status !== "free").length,
      payments: asArray(db.paymentContainers).length + asArray(db.payments).length,
    };
    let result = null;
    let entityType = "monitor";
    let entityId = "control";
    let before = null;
    let after = null;

    if (action === "order_update" || action === "order_state" || action === "order_cancel") {
      const index = findOrderIndex(db, payload.orderId);
      if (index < 0) throw createControlError(404, "Comanda non trovata.");
      before = cloneJson(db.integration.orders[index], {});
      const patch = action === "order_cancel"
        ? { workflowStatus: "cancelled", paymentStatus: "unpaid" }
        : payload.patch && typeof payload.patch === "object"
          ? payload.patch
          : {};
      const next = updateOrderFromPatch(db.integration.orders[index], patch);
      db.integration.orders[index] = next;
      syncTableBillForOrder(db, next);
      after = cloneJson(next, {});
      entityType = "order";
      entityId = normalizeText(next.id);
      result = { order: compactOrder(next) };
    } else if (action === "order_delete") {
      const index = findOrderIndex(db, payload.orderId);
      if (index < 0) throw createControlError(404, "Comanda non trovata.");
      const [removed] = db.integration.orders.splice(index, 1);
      const orderId = normalizeText(removed?.id);
      removeTableBillForOrderId(db, orderId);
      removeIntegrationOrderArtifacts(db, orderId);
      before = cloneJson(removed, {});
      entityType = "order";
      entityId = orderId;
      result = { deletedOrderId: orderId };
    } else if (action === "table_cancel_full") {
      const index = findTableIndex(db, payload);
      if (index < 0) throw createControlError(404, "Tavolo non trovato.");
      const reason = normalizeText(payload.reason);
      if (reason.length < 3) throw createControlError(400, "Motivazione obbligatoria.");
      const table = db.posSettings.tables[index];
      const primaryTableId = normalizeText(table?.id);
      const tableIds = collectTableGroupIdsForTable(db, primaryTableId);
      asArray(payload.tableIds).map(normalizeText).filter(Boolean).forEach((tableId) => tableIds.add(tableId));
      const orderMatchesTable = (order) => tableIds.has(normalizeText(order?.tableId));
      const cancellableOrders = asArray(db.integration.orders).filter(
        (order) => orderMatchesTable(order) && tableResetShouldCancelOrder(order)
      );
      const cancelledOrderIds = cancellableOrders.map((order) => normalizeText(order?.id)).filter(Boolean);
      const cancelledOrderIdSet = new Set(cancelledOrderIds);
      const paymentMatchesTableOrOrders = (payment) => {
        if (tableIds.has(normalizeText(payment?.tableId))) return true;
        return collectOrderIdsFromPayments([payment]).some((orderId) => cancelledOrderIdSet.has(orderId));
      };
      const removedContainers = asArray(db.paymentContainers).filter(
        (payment) => paymentMatchesTableOrOrders(payment) && paymentIsPending(payment)
      );
      const removedPayments = asArray(db.payments).filter(
        (payment) => paymentMatchesTableOrOrders(payment) && paymentIsPending(payment)
      );
      const completedContainersToMark = asArray(db.paymentContainers).filter(
        (payment) => paymentMatchesTableOrOrders(payment) && !paymentIsPending(payment)
      );
      const completedPaymentsToMark = asArray(db.payments).filter(
        (payment) => paymentMatchesTableOrOrders(payment) && !paymentIsPending(payment)
      );
      const removedPaymentIds = new Set(
        [...removedContainers, ...removedPayments].map((payment) => normalizeText(payment?.id)).filter(Boolean)
      );
      const cancellationId = `table_cancel_${Date.now()}_${primaryTableId || "table"}`;
      const cancellationAt = nowIso();
      const authContext = req?.__authContext ?? {};
      const cancelUser = authContext.user ?? null;
      const cancelledByUserId = normalizeText(cancelUser?.id) || normalizeText(payload?.userId) || "system";
      const cancelledByUsername = normalizeText(cancelUser?.username) || normalizeText(payload?.username) || "system";
      const markCompletedPayment = (payment) => {
        if (!paymentMatchesTableOrOrders(payment) || paymentIsPending(payment)) return payment;
        return {
          ...payment,
          tableCancellationId: normalizeText(payment?.tableCancellationId) || cancellationId,
          tableCancelledAt: normalizeText(payment?.tableCancelledAt) || cancellationAt,
          tableCancelledByUserId: normalizeText(payment?.tableCancelledByUserId) || cancelledByUserId,
          tableCancelledByUsername: normalizeText(payment?.tableCancelledByUsername) || cancelledByUsername,
          tableCancellationReason: normalizeText(payment?.tableCancellationReason) || reason,
        };
      };
      before = {
        tables: cloneJson(
          asArray(db.posSettings.tables).filter((entry) => tableIds.has(normalizeText(entry?.id))),
          []
        ),
        orders: cloneJson(cancellableOrders, []),
        paymentContainers: cloneJson(removedContainers, []),
        payments: cloneJson(removedPayments, []),
        markedPaymentContainers: cloneJson(completedContainersToMark, []),
        markedPayments: cloneJson(completedPaymentsToMark, []),
      };
      db.integration.orders = asArray(db.integration.orders).map((order) => {
        const orderId = normalizeText(order?.id);
        if (!cancelledOrderIdSet.has(orderId)) return order;
        const cancelled = updateOrderFromPatch(order, {
          workflowStatus: "cancelled",
          paymentStatus: "unpaid",
          paidAmount: 0,
          recalculateTotal: false,
        });
        return {
          ...cancelled,
          monitorResetAt: cancellationAt,
          monitorResetReason: "table_cancel_full",
          tableCancellationId: cancellationId,
          tableCancelledAt: cancellationAt,
          tableCancelledByUserId: cancelledByUserId,
          tableCancelledByUsername: cancelledByUsername,
          tableCancellationReason: reason,
        };
      });
      cancelledOrderIds.forEach((orderId) => {
        removeTableBillForOrderId(db, orderId);
      });
      db.paymentContainers = asArray(db.paymentContainers).filter(
        (payment) => !(paymentMatchesTableOrOrders(payment) && paymentIsPending(payment))
      ).map(markCompletedPayment);
      db.payments = asArray(db.payments).filter(
        (payment) => !(paymentMatchesTableOrOrders(payment) && paymentIsPending(payment))
      ).map(markCompletedPayment);
      db.paymentParts = asArray(db.paymentParts).filter(
        (part) => !removedPaymentIds.has(normalizeText(part?.paymentId))
      );
      const remainingPartIds = new Set(asArray(db.paymentParts).map((part) => normalizeText(part?.id)).filter(Boolean));
      db.paymentTransactions = asArray(db.paymentTransactions).filter(
        (tx) => !tx?.partId || remainingPartIds.has(normalizeText(tx.partId))
      );
      db.cashTxDenoms = asArray(db.cashTxDenoms).filter((denom) =>
        asArray(db.paymentTransactions).some((tx) => normalizeText(tx?.id) === normalizeText(denom?.txId))
      );
      resetTableLocksForIds(db, Array.from(tableIds));
      db.posSettings.tables = asArray(db.posSettings.tables).map((entry) =>
        tableIds.has(normalizeText(entry?.id)) ? resetTableRecord(entry) : entry
      );
      after = {
        tables: cloneJson(
          asArray(db.posSettings.tables).filter((entry) => tableIds.has(normalizeText(entry?.id))),
          []
        ),
        markedPaymentContainers: cloneJson(
          asArray(db.paymentContainers).filter((payment) => normalizeText(payment?.tableCancellationId) === cancellationId),
          []
        ),
        markedPayments: cloneJson(
          asArray(db.payments).filter((payment) => normalizeText(payment?.tableCancellationId) === cancellationId),
          []
        ),
        cancelledOrders: cloneJson(
          asArray(db.integration.orders).filter((order) => cancelledOrderIdSet.has(normalizeText(order?.id))),
          []
        ),
      };
      entityType = "table";
      entityId = primaryTableId;
      result = {
        resetTableId: primaryTableId,
        resetTableIds: Array.from(tableIds),
        deletedOrderIds: [],
        cancelledOrderIds,
        deletedPendingPaymentIds: Array.from(removedPaymentIds),
        markedCompletedPaymentIds: [
          ...completedContainersToMark,
          ...completedPaymentsToMark,
        ].map((payment) => normalizeText(payment?.id)).filter(Boolean),
        tableCancellationId: cancellationId,
        reason,
      };
    } else if (action === "table_reset") {
      const index = findTableIndex(db, payload);
      if (index < 0) throw createControlError(404, "Tavolo non trovato.");
      const table = db.posSettings.tables[index];
      before = cloneJson(table, {});
      const tableId = normalizeText(table?.id);
      const linkedOrderIds = asArray(db.integration.orders)
        .filter((order) => normalizeText(order?.tableId) === tableId)
        .map((order) => normalizeText(order?.id))
        .filter(Boolean);
      const cancelledOrderIds = cancelOrdersForResetTableIds(db, [tableId]);
      resetTableLocksForIds(db, [tableId]);
      db.posSettings.tables[index] = resetTableRecord(table);
      after = cloneJson(db.posSettings.tables[index], {});
      entityType = "table";
      entityId = tableId;
      result = {
        resetTableId: tableId,
        linkedOrderIds,
        cancelledOrderIds,
        preservedPayments: true,
        preservedFiscalReceipts: true,
      };
    } else if (action === "table_move") {
      const sourceIndex = findTableIndex(db, payload.source ?? payload);
      const targetIndex = findTableIndex(db, payload.target ?? {});
      if (sourceIndex < 0 || targetIndex < 0) throw createControlError(404, "Tavolo sorgente o destinazione non trovato.");
      if (sourceIndex === targetIndex) throw createControlError(400, "Il tavolo destinazione deve essere diverso.");
      const source = db.posSettings.tables[sourceIndex];
      const target = db.posSettings.tables[targetIndex];
      before = { source: cloneJson(source, {}), target: cloneJson(target, {}) };
      const sourceId = normalizeText(source?.id);
      const targetId = normalizeText(target?.id);
      const targetRoomId = tableRoomId(target);
      const targetNumber = Number(target?.number ?? target?.tableNumber);
      db.integration.orders = asArray(db.integration.orders).map((order) => {
        if (normalizeText(order?.tableId) !== sourceId) return order;
        return {
          ...order,
          tableId: targetId,
          roomId: targetRoomId,
          tableNumber: targetNumber,
          tableLabel: String(targetNumber),
          logicalTableLabel: String(targetNumber),
          lastTableTransferAtMs: Date.now(),
          updatedAt: nowIso(),
        };
      });
      const movePayment = (payment) =>
        normalizeText(payment?.tableId) === sourceId
          ? { ...payment, tableId: targetId, roomId: targetRoomId, tableNumber: targetNumber, tableLabel: String(targetNumber) }
          : payment;
      db.paymentContainers = asArray(db.paymentContainers).map(movePayment);
      db.payments = asArray(db.payments).map(movePayment);
      db.posSettings.tables[targetIndex] = {
        ...target,
        status: source.status,
        guestName: normalizeText(source.guestName) || normalizeText(target.guestName),
        customerName: normalizeText(source.customerName) || normalizeText(target.customerName),
        customerPhone: normalizeText(source.customerPhone) || normalizeText(target.customerPhone),
        note: normalizeText(source.note) || normalizeText(target.note),
        covers: Math.max(normalizeTableCovers(source.covers), normalizeTableCovers(target.covers)),
        totalDue: roundMoney((Number(target.totalDue) || 0) + (Number(source.totalDue) || Number(source.amountDue) || 0)),
        amountDue: roundMoney((Number(target.amountDue) || 0) + (Number(source.amountDue) || Number(source.totalDue) || 0)),
        dueAmount: roundMoney((Number(target.dueAmount) || 0) + (Number(source.dueAmount) || Number(source.totalDue) || 0)),
        pendingBills: [...asArray(target.pendingBills), ...asArray(source.pendingBills)],
        orderHistory: [...asArray(target.orderHistory), ...asArray(source.orderHistory)],
        ordersTaken: Math.max(0, Number(target.ordersTaken) || 0) + Math.max(0, Number(source.ordersTaken) || 0),
        seatedAt: target.seatedAt || source.seatedAt || null,
      };
      db.posSettings.tables[sourceIndex] = resetTableRecord(source);
      after = { source: cloneJson(db.posSettings.tables[sourceIndex], {}), target: cloneJson(db.posSettings.tables[targetIndex], {}) };
      entityType = "table";
      entityId = `${sourceId}->${targetId}`;
      result = { sourceTableId: sourceId, targetTableId: targetId };
    } else if (action === "payment_delete") {
      const paymentId = normalizeText(payload.paymentId);
      if (!paymentId) throw createControlError(400, "Pagamento non valido.");
      const removedContainers = asArray(db.paymentContainers).filter((payment) => paymentRecordMatches(payment, paymentId));
      const removedPayments = asArray(db.payments).filter((payment) => paymentRecordMatches(payment, paymentId));
      if (removedContainers.length === 0 && removedPayments.length === 0) throw createControlError(404, "Pagamento non trovato.");
      const impactedOrderIds = collectOrderIdsFromPayments([...removedContainers, ...removedPayments]);
      before = { paymentContainers: cloneJson(removedContainers, []), payments: cloneJson(removedPayments, []) };
      const removedPartPaymentIds = new Set([...removedContainers, ...removedPayments].map((payment) => normalizeText(payment?.id)).filter(Boolean));
      const removedPartIds = new Set(asArray(db.paymentParts).filter((part) => removedPartPaymentIds.has(normalizeText(part?.paymentId))).map((part) => normalizeText(part?.id)));
      db.paymentContainers = asArray(db.paymentContainers).filter((payment) => !paymentRecordMatches(payment, paymentId));
      db.payments = asArray(db.payments).filter((payment) => !paymentRecordMatches(payment, paymentId));
      db.paymentParts = asArray(db.paymentParts).filter((part) => !removedPartPaymentIds.has(normalizeText(part?.paymentId)));
      db.paymentTransactions = asArray(db.paymentTransactions).filter((tx) => !removedPartIds.has(normalizeText(tx?.partId)));
      recalculateOrdersPaymentState(db, impactedOrderIds);
      entityType = "payment";
      entityId = paymentId;
      result = { deletedPaymentId: paymentId, impactedOrderIds };
    } else if (action === "payment_update") {
      const paymentId = normalizeText(payload.paymentId);
      if (!paymentId) throw createControlError(400, "Pagamento non valido.");
      const patch = payload.patch && typeof payload.patch === "object" ? payload.patch : {};
      let found = false;
      const impacted = [];
      const updatePayment = (payment) => {
        if (!paymentRecordMatches(payment, paymentId)) return payment;
        found = true;
        impacted.push(payment);
        const next = { ...payment };
        if (patch.amount !== undefined && Number.isFinite(Number(patch.amount))) next.amount = roundMoney(Math.max(Number(patch.amount), 0));
        if (patch.method !== undefined) {
          next.method = normalizeText(patch.method);
          next.paymentMethod = normalizeText(patch.method);
          next.methodId = normalizeText(patch.method);
        }
        if (patch.note !== undefined) next.note = normalizeText(patch.note).slice(0, 240);
        if (patch.status !== undefined) next.status = normalizeText(patch.status).toUpperCase() || next.status;
        return next;
      };
      db.paymentContainers = asArray(db.paymentContainers).map(updatePayment);
      db.payments = asArray(db.payments).map(updatePayment);
      if (!found) throw createControlError(404, "Pagamento non trovato.");
      const impactedOrderIds = collectOrderIdsFromPayments(impacted);
      recalculateOrdersPaymentState(db, impactedOrderIds);
      before = cloneJson(impacted, []);
      after = cloneJson([...asArray(db.paymentContainers), ...asArray(db.payments)].filter((payment) => paymentRecordMatches(payment, paymentId)), []);
      entityType = "payment";
      entityId = paymentId;
      result = { updatedPaymentId: paymentId, impactedOrderIds };
    } else if (action === "reset_all_tables") {
      before = beforeSummary;
      const resetSummary = resetAllTablesState(db);
      entityType = "system";
      entityId = "tables-reset";
      after = {
        orders: asArray(db.integration.orders).length,
        tables: asArray(db.posSettings.tables).filter((table) => table.status !== "free").length,
        payments: asArray(db.paymentContainers).length + asArray(db.payments).length,
      };
      result = { reset: true, ...resetSummary };
    } else {
      throw createControlError(400, "Azione monitor non supportata.");
    }

    db.meta = db.meta && typeof db.meta === "object" ? db.meta : {};
    db.meta.lastWriteAt = nowIso();
    db.meta.settingsLastWriteAt = db.meta.lastWriteAt;
    db.meta.monitorControlLastAction = { action, at: db.meta.lastWriteAt, entityType, entityId };
    if (db.integration && typeof db.integration === "object") {
      db.integration.lastWriteAt = db.meta.lastWriteAt;
    }
    auditMonitorControl(db, req, payload, {
      action,
      entityType,
      entityId,
      before,
      after,
      details: result,
    });
    await writeDb(
      db,
      action === "reset_all_tables"
        ? {
            metricLabel: "monitor.resetAll.operationalReset.appStateWrite",
            splitDomains: MONITOR_RESET_ALL_WRITE_DOMAINS,
          }
        : undefined
    );
    if (action === "reset_all_tables" && typeof syncMonitorResetExternalStores === "function") {
      result.externalStores = await syncMonitorResetExternalStores(db);
    }
    if (typeof clearIntegrationHotResponseCaches === "function") {
      clearIntegrationHotResponseCaches();
    }
    if (typeof publishIntegrationNotificationStreamRefresh === "function") {
      publishIntegrationNotificationStreamRefresh(`monitor_${action}`, {
        action,
        entityType,
        entityId,
      });
    }
    return {
      ok: true,
      action,
      result,
      overview: buildMonitorOverview(db),
    };
  }

  return {
    applyMonitorControl,
    createControlError,
  };
}
