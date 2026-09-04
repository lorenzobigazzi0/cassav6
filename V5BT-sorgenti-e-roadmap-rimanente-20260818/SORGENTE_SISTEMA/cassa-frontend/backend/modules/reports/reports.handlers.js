import {
  buildHandheldSessionReport,
  formatHandheldSessionReportText,
  recordHandheldCashSessionClose,
  recordHandheldCashSessionOpen,
  resolveHandheldSessionReportPrinterId,
} from "./handheld-session-report.js";
import {
  buildSettlementLedgerFromSalesReport,
  summarizeSettlementLedger,
} from "./settlement-ledger.js";
import { normalizeTableCovers } from "../tables/table-capacity.domain.js";

const HANDHELD_CASH_SESSION_WRITE_DOMAINS = [
  "handheldCashSessions",
  "auditEvents",
];

export function resolveReportsAuthContext(req, db, payload, validateSessionContext) {
  const context = req?.__authContext;
  if (context?.user && context?.session) return context;
  return validateSessionContext(db, payload);
}

export function createReportsHandlers({
  deleteAuditEvent,
  BAR_CHARGE_REPLACEMENT_FISCAL_TREATMENT,
  BAR_CHARGE_REPLACEMENT_LINE_TYPE,
  HttpError,
  appendAuditEvent,
  buildAuditActor,
  clampInt,
  collectLoggedInWaiters,
  enqueuePrintSpoolJob,
  hasPermission,
  isAdminUser,
  mapPaymentMethodToTransactionType,
  normalizePaymentOrderIdList,
  nowIso,
  parseTimestampMs,
  readDb,
  readAuditEventsView,
  readJsonBody,
  roundMoney,
  sanitizeAuditEvent,
  sanitizeAuditEvents,
  sanitizeCashTxDenomRecord,
  sanitizeFiscalReceipt,
  sanitizeIntegrationOrder,
  sanitizePaymentContainerRecord,
  sanitizePaymentPartRecord,
  sanitizePaymentRecord,
  sanitizePaymentTransactionRecord,
  sanitizePosSettings,
  sanitizeSmartNonFiscalEntry,
  sendJson,
  validateSessionContext,
  writeDb,
  relationalPaymentsReportsReadEnabled = false,
  buildRelationalPaymentsReportDb = null,
}) {
  async function resolvePaymentsReportReadDb(db) {
    if (!relationalPaymentsReportsReadEnabled || typeof buildRelationalPaymentsReportDb !== "function") return db;
    try {
      return (await buildRelationalPaymentsReportDb(db)) ?? db;
    } catch {
      return db;
    }
  }

  async function handleAuditEvents(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await readAuditEventsView(payload, req?.__authContext));
  }

  async function handleAuditEventDelete(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await deleteAuditEvent(payload, req?.__authContext));
  }

  function buildSalesReport(db) {
    const usersForReport = Array.isArray(db.users) ? db.users : [];
    const userDisplayName = (userId, username) => {
      const safeUserId = String(userId ?? "").trim();
      const safeUsername = String(username ?? "").trim().toLowerCase();
      const user =
        usersForReport.find((entry) => String(entry?.id ?? "").trim() === safeUserId) ||
        usersForReport.find((entry) => String(entry?.username ?? "").trim().toLowerCase() === safeUsername) ||
        null;
      if (!user) return String(username ?? "").trim() || String(userId ?? "").trim();
      const fullName =
        String(user.fullName ?? user.displayName ?? user.name ?? "").trim() ||
        [user.firstName, user.lastName].map((part) => String(part ?? "").trim()).filter(Boolean).join(" ").trim();
      return fullName || String(user.username ?? username ?? "").trim() || safeUserId;
    };

    const payments = (Array.isArray(db.payments) ? db.payments : [])
      .map((entry, index) => sanitizePaymentRecord(entry, `pay_${index + 1}`))
      .filter((entry) => entry !== null);
    const paymentContainers = (Array.isArray(db.paymentContainers) ? db.paymentContainers : [])
      .map((entry, index) => sanitizePaymentContainerRecord(entry, `payc_${index + 1}`))
      .filter((entry) => entry !== null)
      .map((entry) => ({
        ...entry,
        collectedByDisplayName: userDisplayName(entry.collectedByUserId, entry.collectedByUsername),
        createdByDisplayName: userDisplayName(entry.createdByUserId, entry.createdByUsername),
      }));
    const paymentParts = (Array.isArray(db.paymentParts) ? db.paymentParts : [])
      .map((entry, index) => sanitizePaymentPartRecord(entry, `part_${index + 1}`))
      .filter((entry) => entry !== null);
    const paymentTransactionsRaw = (Array.isArray(db.paymentTransactions) ? db.paymentTransactions : [])
      .map((entry, index) => sanitizePaymentTransactionRecord(entry, `tx_${index + 1}`))
      .filter((entry) => entry !== null);
    const paymentTransactions = [...paymentTransactionsRaw];
    const knownTxIds = new Set(paymentTransactionsRaw.map((entry) => entry.id));
    payments.forEach((payment, index) => {
      const preferredTxId = payment.paymentTxId ? String(payment.paymentTxId) : "";
      if (preferredTxId && knownTxIds.has(preferredTxId)) return;
      const fallbackTx = sanitizePaymentTransactionRecord(
        {
          id: preferredTxId || `tx_legacy_${index + 1}`,
          partId: payment.paymentPartId ? String(payment.paymentPartId) : `part_legacy_${index + 1}`,
          createdByUserId: payment.createdByUserId,
          createdByUsername: payment.createdByUsername,
          createdAt: payment.createdAt,
          method: mapPaymentMethodToTransactionType(payment.methodId, payment.methodLabel),
          paymentSource: payment.paymentSource,
          cashSource: payment.cashSource,
          automaticCashPaymentOperationId:
            payment.automaticCashPaymentOperationId,
          amountPaid: payment.amount,
          changeGiven: payment.changeGiven,
        },
        preferredTxId || `tx_legacy_${index + 1}`
      );
      if (!fallbackTx) return;
      if (knownTxIds.has(fallbackTx.id)) return;
      knownTxIds.add(fallbackTx.id);
      paymentTransactions.push(fallbackTx);
    });
    const fiscalReceipts = (Array.isArray(db.fiscalReceipts) ? db.fiscalReceipts : [])
      .map((entry, index) => sanitizeFiscalReceipt(entry, `fiscal_${index + 1}`))
      .filter((entry) => entry !== null);
    const cashTxDenoms = (Array.isArray(db.cashTxDenoms) ? db.cashTxDenoms : [])
      .map((entry, index) => sanitizeCashTxDenomRecord(entry, `denom_${index + 1}`))
      .filter((entry) => entry !== null);
    const sortedPayments = [...payments].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const totalIncassato = roundMoney(sortedPayments.reduce((sum, payment) => sum + Math.max(payment.amount, 0), 0));
    const spesaMediaPerScontrino = sortedPayments.length ? roundMoney(totalIncassato / sortedPayments.length) : 0;

    const soldItemsMap = new Map();
    const methodMap = new Map();
    const cashierMap = new Map();
    const collectorMap = new Map();
    const tableIds = new Set();
    let personeServiteDaTransazioni = 0;
    let totaleArticoliVenduti = 0;

    const denomsByTxId = new Map();
    cashTxDenoms.forEach((entry) => {
      const bucket = denomsByTxId.get(entry.txId) ?? [];
      bucket.push(entry);
      denomsByTxId.set(entry.txId, bucket);
    });

    for (const payment of sortedPayments) {
      if (payment.tableId) {
        tableIds.add(payment.tableId);
        if (Number.isFinite(payment.tableCovers) && payment.tableCovers > 0) {
          personeServiteDaTransazioni += payment.tableCovers;
        }
      }

      const methodKey = payment.methodId;
      const methodBucket = methodMap.get(methodKey) ?? {
        id: payment.methodId,
        label: payment.methodLabel,
        transactions: 0,
        total: 0,
        fiscalTransactions: 0,
        nonFiscalTransactions: 0,
        average: 0,
      };
      methodBucket.transactions += 1;
      methodBucket.total = roundMoney(methodBucket.total + payment.amount);
      if (payment.fiscal) {
        methodBucket.fiscalTransactions += 1;
      } else {
        methodBucket.nonFiscalTransactions += 1;
      }
      methodBucket.average = methodBucket.transactions ? roundMoney(methodBucket.total / methodBucket.transactions) : 0;
      methodMap.set(methodKey, methodBucket);

      const cashierKey = payment.createdByUserId;
      const cashierBucket = cashierMap.get(cashierKey) ?? {
        userId: payment.createdByUserId,
        username: payment.createdByUsername,
        transactionsCount: 0,
        totalCollected: 0,
        transactions: [],
      };
      cashierBucket.transactionsCount += 1;
      cashierBucket.totalCollected = roundMoney(cashierBucket.totalCollected + payment.amount);
      cashierBucket.transactions.push({
        id: payment.id,
        createdAt: payment.createdAt,
        amount: payment.amount,
        methodId: payment.methodId,
        methodLabel: payment.methodLabel,
        fiscal: payment.fiscal,
        tableId: payment.tableId,
        tableNumber: payment.tableNumber,
        tableLabel: payment.tableLabel,
        roomId: payment.roomId,
        orderId: payment.orderId,
        orderIds: payment.orderIds,
        billId: payment.billId,
        billIds: payment.billIds,
        tableCovers: payment.tableCovers,
        source: payment.source,
        customerId: payment.customerId,
      });
      cashierMap.set(cashierKey, cashierBucket);

      for (const item of payment.items) {
        totaleArticoliVenduti += item.qty;
        const key = `${item.name}|${item.unitPrice}|${item.variant ?? ""}`;
        const soldItem = soldItemsMap.get(key) ?? {
          name: item.name,
          variant: item.variant ?? null,
          unitPrice: item.unitPrice,
          quantity: 0,
          totalRevenue: 0,
          soldBy: new Map(),
        };
        soldItem.quantity += item.qty;
        soldItem.totalRevenue = roundMoney(soldItem.totalRevenue + item.lineTotal);
        const soldByBucket = soldItem.soldBy.get(payment.createdByUsername) ?? { username: payment.createdByUsername, quantity: 0, total: 0 };
        soldByBucket.quantity += item.qty;
        soldByBucket.total = roundMoney(soldByBucket.total + item.lineTotal);
        soldItem.soldBy.set(payment.createdByUsername, soldByBucket);
        soldItemsMap.set(key, soldItem);
      }
    }

    for (const tx of paymentTransactions) {
      const key = tx.createdByUserId;
      const bucket = collectorMap.get(key) ?? {
        userId: tx.createdByUserId,
        username: tx.createdByUsername,
        transactionsCount: 0,
        totalCollected: 0,
        cashTotal: 0,
        automaticCashTotal: 0,
        posTotal: 0,
        otherTotal: 0,
        changeGivenTotal: 0,
        refundsTotal: 0,
        txIds: [],
        denomsIn: new Map(),
        denomsOut: new Map(),
      };
      bucket.transactionsCount += 1;
      bucket.totalCollected = roundMoney(bucket.totalCollected + tx.amountPaid);
      const isAutomaticCashTx =
        tx.method === "CASH" &&
        (String(tx.paymentSource ?? "").trim() === "automatic_cash" ||
          String(tx.cashSource ?? "").trim() === "automatic" ||
          String(tx.automaticCashPaymentOperationId ?? "").trim().length > 0);
      if (isAutomaticCashTx) {
        bucket.automaticCashTotal = roundMoney(bucket.automaticCashTotal + tx.amountPaid);
      } else if (tx.method === "CASH") {
        bucket.cashTotal = roundMoney(bucket.cashTotal + tx.amountPaid);
      } else if (tx.method === "POS") {
        bucket.posTotal = roundMoney(bucket.posTotal + tx.amountPaid);
      } else {
        bucket.otherTotal = roundMoney(bucket.otherTotal + tx.amountPaid);
      }
      bucket.changeGivenTotal = roundMoney(bucket.changeGivenTotal + Math.max(Number(tx.changeGiven) || 0, 0));
      if (tx.refundedTxId || tx.refundedAt) {
        bucket.refundsTotal = roundMoney(bucket.refundsTotal + tx.amountPaid);
      }
      bucket.txIds.push(tx.id);

      const denoms = denomsByTxId.get(tx.id) ?? [];
      denoms.forEach((denom) => {
        const targetMap = denom.direction === "OUT" ? bucket.denomsOut : bucket.denomsIn;
        targetMap.set(denom.denomCents, (targetMap.get(denom.denomCents) ?? 0) + denom.qty);
      });
      collectorMap.set(key, bucket);
    }

    const soldItems = [...soldItemsMap.values()]
      .map((item) => ({
        name: item.name,
        variant: item.variant,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        totalRevenue: item.totalRevenue,
        soldBy: [...item.soldBy.values()].sort((a, b) => b.quantity - a.quantity),
      }))
      .sort((a, b) => b.quantity - a.quantity);

    const methods = [...methodMap.values()].sort((a, b) => b.total - a.total);
    const cashierTransactions = [...cashierMap.values()].sort((a, b) => b.totalCollected - a.totalCollected);
    const incassiPerUtente = [...collectorMap.values()]
      .map((entry) => ({
        userId: entry.userId,
        username: entry.username,
        transactionsCount: entry.transactionsCount,
        totalCollected: entry.totalCollected,
        cashTotal: entry.cashTotal,
        automaticCashTotal: entry.automaticCashTotal,
        posTotal: entry.posTotal,
        otherTotal: entry.otherTotal,
        changeGivenTotal: entry.changeGivenTotal,
        refundsTotal: entry.refundsTotal,
        txIds: entry.txIds,
        denomsIn: [...entry.denomsIn.entries()]
          .map(([denomCents, qty]) => ({ denomCents, qty }))
          .sort((a, b) => b.denomCents - a.denomCents),
        denomsOut: [...entry.denomsOut.entries()]
          .map(([denomCents, qty]) => ({ denomCents, qty }))
          .sort((a, b) => b.denomCents - a.denomCents),
      }))
      .sort((a, b) => b.totalCollected - a.totalCollected);

    const users = Array.isArray(db.users) ? db.users : [];
    const abilitatiRiscossione = users
      .filter((user) => hasPermission(user, "collect_payments"))
      .map((user) => {
        const stats = cashierMap.get(user.id);
        return {
          userId: user.id,
          username: user.username,
          fullName: user.fullName ?? user.username,
          totalCollected: stats ? stats.totalCollected : 0,
          transactionsCount: stats ? stats.transactionsCount : 0,
          transactions: stats ? stats.transactions : [],
        };
      })
      .sort((a, b) => b.totalCollected - a.totalCollected);

    const camerieriPresenti = collectLoggedInWaiters(db, { operatorOnly: false });

    const settings = sanitizePosSettings(db.posSettings, { menuItems: db.menuItems });
    const tables = Array.isArray(settings.tables) ? settings.tables : [];
    const tavoliNonArrivatiAttuali = tables.filter((table) => table.status === "reserved").length;
    const tavoliArrivatiAttuali = tables.filter((table) => table.status !== "reserved" && table.status !== "free").length;
    const personeInSalaAttuali = tables
      .filter((table) => table.status !== "free" && table.status !== "reserved")
      .reduce((sum, table) => sum + normalizeTableCovers(table.covers), 0);

    const smartNonFiscal = (Array.isArray(db.smartNonFiscal) ? db.smartNonFiscal : [])
      .map((entry, index) => sanitizeSmartNonFiscalEntry(entry, `smart_nf_${index + 1}`))
      .filter((entry) => entry !== null);
    const smartNonFiscalTotal = roundMoney(smartNonFiscal.reduce((sum, entry) => sum + entry.amount, 0));
    const serviceRecoveryReplacements = (Array.isArray(db.integration?.barChargeReplacements)
      ? db.integration.barChargeReplacements
      : [])
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        id: String(entry.id ?? "").trim(),
        lineType: BAR_CHARGE_REPLACEMENT_LINE_TYPE,
        chargePolicy: "BAR_INTERNAL",
        fiscalTreatment: BAR_CHARGE_REPLACEMENT_FISCAL_TREATMENT,
        tableId: String(entry.tableId ?? "").trim() || null,
        tableNumber: Number.isFinite(Number(entry.tableNumber)) ? Math.trunc(Number(entry.tableNumber)) : null,
        tableLabel: String(entry.tableLabel ?? "").trim() || null,
        roomId: String(entry.roomId ?? "").trim() || null,
        orderId: String(entry.orderId ?? "").trim() || null,
        orderIds: normalizePaymentOrderIdList(entry.orderIds, String(entry.tableId ?? "")),
        originalLineId: String(entry.originalLineId ?? "").trim() || null,
        replacementLineId: String(entry.replacementLineId ?? "").trim() || null,
        productId: String(entry.productId ?? "").trim() || null,
        productName: String(entry.productName ?? "").trim() || "Articolo",
        quantity: Math.max(Math.trunc(Number(entry.quantity) || 0), 0),
        reason: String(entry.reason ?? "").trim(),
        createdByUserId: String(entry.createdByUserId ?? "").trim() || null,
        createdByUsername: String(entry.createdByUsername ?? "").trim() || null,
        createdByDisplayName: userDisplayName(entry.createdByUserId, entry.createdByUsername),
        createdByDeviceUuid: String(entry.createdByDeviceUuid ?? "").trim() || null,
        createdAt: String(entry.createdAt ?? ""),
      }))
      .filter((entry) => entry.id);
    const serviceRecoveryQuantity = serviceRecoveryReplacements.reduce(
      (sum, entry) => sum + Math.max(Number(entry.quantity) || 0, 0),
      0
    );
    const serviceRecoveryComps = (Array.isArray(db.integration?.orderComps)
      ? db.integration.orderComps
      : [])
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        id: String(entry.id ?? "").trim(),
        orderId: String(entry.orderId ?? "").trim() || null,
        lineId: String(entry.lineId ?? entry.originalLineId ?? "").trim() || null,
        productId: String(entry.productId ?? "").trim() || null,
        productName: String(entry.productName ?? "").trim() || "Articolo",
        quantity: Math.max(Math.trunc(Number(entry.quantity) || 0), 0),
        unitPrice: roundMoney(Math.max(Number(entry.unitPrice) || 0, 0)),
        requestedAmount: roundMoney(Math.max(Number(entry.requestedAmount) || 0, 0)),
        amount: roundMoney(Math.max(Number(entry.amount) || 0, 0)),
        paidAmount: roundMoney(Math.max(Number(entry.paidAmount) || 0, 0)),
        unpaidAmount: roundMoney(Math.max(Number(entry.unpaidAmount) || 0, 0)),
        paymentVoidAmount: roundMoney(Math.max(Number(entry.paymentVoidAmount) || 0, 0)),
        paymentRechargeAmount: roundMoney(Math.max(Number(entry.paymentRechargeAmount) || 0, 0)),
        paymentStornoAmount: roundMoney(Math.max(Number(entry.paymentStornoAmount) || 0, 0)),
        rechargePaymentIds: Array.isArray(entry.rechargePaymentIds)
          ? entry.rechargePaymentIds.map((id) => String(id ?? "").trim()).filter(Boolean).slice(0, 100)
          : [],
        rechargeTransactionIds: Array.isArray(entry.rechargeTransactionIds)
          ? entry.rechargeTransactionIds.map((id) => String(id ?? "").trim()).filter(Boolean).slice(0, 100)
          : [],
        rechargePrintJobIds: Array.isArray(entry.rechargePrintJobIds)
          ? entry.rechargePrintJobIds.map((id) => String(id ?? "").trim()).filter(Boolean).slice(0, 100)
          : [],
        articleUnitIds: Array.isArray(entry.articleUnitIds)
          ? entry.articleUnitIds.map((unitId) => String(unitId ?? "").trim()).filter(Boolean).slice(0, 1000)
          : [],
        paymentReferences: Array.isArray(entry.paymentReferences) ? entry.paymentReferences : [],
        refundPlan:
          entry.refundPlan && typeof entry.refundPlan === "object"
            ? entry.refundPlan
            : null,
        reason: String(entry.reason ?? "").trim(),
        sendReplacement: entry.sendReplacement === true,
        nonFinancialReplacement: entry.nonFinancialReplacement === true,
        replacementSettlement: String(entry.replacementSettlement ?? "").trim() || null,
        financialImpact: String(entry.financialImpact ?? "").trim() || null,
        replacementOrderId: String(entry.replacementOrderId ?? "").trim() || null,
        replacementLineId: String(entry.replacementLineId ?? "").trim() || null,
        tableId: String(entry.tableId ?? "").trim() || null,
        tableNumber: Number.isFinite(Number(entry.tableNumber)) ? Math.trunc(Number(entry.tableNumber)) : null,
        tableLabel: String(entry.tableLabel ?? "").trim() || null,
        roomId: String(entry.roomId ?? "").trim() || null,
        createdByUserId: String(entry.createdByUserId ?? "").trim() || null,
        createdByUsername: String(entry.createdByUsername ?? "").trim() || null,
        createdByDisplayName: userDisplayName(entry.createdByUserId, entry.createdByUsername),
        createdByDeviceUuid: String(entry.createdByDeviceUuid ?? "").trim() || null,
        createdAt: String(entry.createdAt ?? ""),
        idempotencyKey: String(entry.idempotencyKey ?? "").trim() || null,
        stornoPrintJobId: String(entry.stornoPrintJobId ?? "").trim() || null,
      }))
      .filter((entry) => entry.id);
    const serviceRecoveryCompAmount = roundMoney(
      serviceRecoveryComps.reduce((sum, entry) => sum + Math.max(Number(entry.amount) || 0, 0), 0)
    );
    const serviceRecoveryPaidStornoAmount = roundMoney(
      serviceRecoveryComps.reduce((sum, entry) => sum + Math.max(Number(entry.paidAmount) || 0, 0), 0)
    );
    const smartByMethodMap = new Map();
    for (const entry of smartNonFiscal) {
      const bucket = smartByMethodMap.get(entry.methodId) ?? {
        methodId: entry.methodId,
        methodLabel: entry.methodLabel,
        count: 0,
        total: 0,
      };
      bucket.count += 1;
      bucket.total = roundMoney(bucket.total + entry.amount);
      smartByMethodMap.set(entry.methodId, bucket);
    }

    const integrationOrders = (Array.isArray(db.integration?.orders) ? db.integration.orders : [])
      .map((entry, index) => sanitizeIntegrationOrder(entry, String(index + 1).padStart(5, "0")))
      .sort((a, b) => {
        const left = new Date(b.createdAt).getTime();
        const right = new Date(a.createdAt).getTime();
        return left - right;
      });

    const orderStatusCounts = {
      waiting: 0,
      prep: 0,
      ready: 0,
      delivered: 0,
      other: 0,
    };
    const orderPaymentCounts = {
      unpaid: 0,
      partial: 0,
      paid: 0,
      other: 0,
    };

    const normalizedOrders = integrationOrders.map((order) => {
      const workflowStatusRaw = String(order.workflowStatus ?? "").trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(orderStatusCounts, workflowStatusRaw)) {
        orderStatusCounts[workflowStatusRaw] += 1;
      } else {
        orderStatusCounts.other += 1;
      }

      const paymentStatusRaw = String(order.paymentStatus ?? "").trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(orderPaymentCounts, paymentStatusRaw)) {
        orderPaymentCounts[paymentStatusRaw] += 1;
      } else {
        orderPaymentCounts.other += 1;
      }

      const items = Array.isArray(order.items) ? order.items : [];
      const groupedItems = new Map();
      items.forEach((item) => {
        const name = String(item?.name ?? "Articolo").trim() || "Articolo";
        const variant = String(item?.variant ?? "").trim();
        const note = String(item?.note ?? "").trim();
        const unitPriceApplied = roundMoney(Math.max(Number(item?.unitPriceApplied) || 0, 0));
        const listPriceAtTime = roundMoney(
          Math.max(Number(item?.listPriceAtTime) || unitPriceApplied || 0, 0)
        );
        const lineTotal = roundMoney(
          Math.max(Number(item?.lineTotal) || unitPriceApplied || listPriceAtTime || 0, 0)
        );
        const key = [
          name,
          variant,
          note,
          String(unitPriceApplied),
          String(listPriceAtTime),
        ].join("__");
        const current = groupedItems.get(key) ?? {
          name,
          variant: variant || null,
          note: note || null,
          qty: 0,
          doneQty: 0,
          unitPriceApplied,
          listPriceAtTime,
          lineTotal: 0,
        };
        current.qty += 1;
        if (item?.done === true) {
          current.doneQty += 1;
        }
        current.lineTotal = roundMoney(current.lineTotal + lineTotal);
        groupedItems.set(key, current);
      });

      return {
        id: order.id,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        receivedAtMs: order.receivedAtMs,
        readyAtMs: order.readyAtMs,
        completedAtMs: order.completedAtMs,
        workflowStatus: order.workflowStatus,
        paymentStatus: order.paymentStatus,
        total: order.total,
        dueAmount: order.dueAmount,
        paidAmount: order.paidAmount,
        tableId: order.tableId || null,
        tableNumber:
          Number.isFinite(Number(order.tableNumber)) && Number(order.tableNumber) > 0
            ? Math.trunc(Number(order.tableNumber))
            : null,
        roomId: order.roomId || null,
        waiter: order.waiter,
        station: order.station,
        source: order.source,
        ownerStation: order.ownerStation || null,
        parentOrderId: order.parentOrderId || null,
        isPartial: order.isPartial === true,
        transferredFromStation: order.transferredFromStation || null,
        transferredToStation: order.transferredToStation || null,
        transferredAtMs: order.transferredAtMs,
        itemsCount: items.length,
        itemsDoneCount: items.filter((item) => item?.done === true).length,
        lineItems: items.map((item, index) => ({
          index,
          id: String(item?.id ?? "").trim() || null,
          lineId: String(item?.lineId ?? item?.id ?? "").trim() || null,
          productId: String(item?.productId ?? "").trim() || null,
          productName: String(item?.productNameSnapshot ?? item?.productName ?? item?.name ?? "Articolo").trim() || "Articolo",
          qty: Math.max(Math.trunc(Number(item?.qty ?? item?.quantity) || 1), 1),
          variant: String(item?.variant ?? item?.selectedVariantName ?? "").trim() || null,
          note: String(item?.note ?? item?.notes ?? "").trim() || null,
          unitPriceApplied: roundMoney(Math.max(Number(item?.unitPriceApplied) || 0, 0)),
          lineTotal: roundMoney(Math.max(Number(item?.lineTotal) || 0, 0)),
        })),
        items: [...groupedItems.values()].sort((a, b) => {
          const nameCompare = String(a.name || "").localeCompare(String(b.name || ""), "it", {
            sensitivity: "base",
          });
          if (nameCompare !== 0) return nameCompare;
          const variantCompare = String(a.variant || "").localeCompare(String(b.variant || ""), "it", {
            sensitivity: "base",
          });
          if (variantCompare !== 0) return variantCompare;
          return String(a.note || "").localeCompare(String(b.note || ""), "it", {
            sensitivity: "base",
          });
        }),
      };
    });

    const orderEvents = (Array.isArray(db.auditEvents) ? db.auditEvents : [])
      .map((entry, index) => sanitizeAuditEvent(entry, `evt_${String(index + 1).padStart(8, "0")}`))
      .filter((event) => event !== null)
      .filter((event) => {
        const action = String(event.action ?? "").trim().toLowerCase();
        const entityType = String(event.entityType ?? "").trim().toLowerCase();
        if (action.startsWith("order.")) return true;
        return (
          entityType === "integration_order" ||
          entityType === "order_line" ||
          entityType === "order_ticket"
        );
      })
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
      .slice(0, 5000)
      .map((event) => ({
        id: event.id,
        occurredAt: event.occurredAt,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        actorUserId: event.actorUserId,
        actorRole: event.actorRole,
        roomId: event.roomId,
        payload: event.payload,
        before: event.before,
        after: event.after,
      }));

    const report = {
      generatedAt: nowIso(),
      summary: {
        transactionsCount: sortedPayments.length,
        totalIncassato,
        spesaMediaPerScontrino,
        totaleArticoliVenduti,
        tavoliServitiDaTransazioni: tableIds.size,
      },
      soldItems,
      paymentMethods: methods,
      tables: {
        tavoliArrivatiDaTransazioni: tableIds.size,
        tavoliArrivatiAttuali,
        tavoliNonArrivatiAttuali,
        personeServiteDaTransazioni,
        personeInSalaAttuali,
      },
      staff: {
        camerieriPresentiCount: camerieriPresenti.length,
        camerieriPresenti,
        abilitatiRiscossione,
        transazioniPerCameriere: cashierTransactions,
        incassiPerUtente,
      },
      paymentsTracking: {
        containersCount: paymentContainers.length,
        partsCount: paymentParts.length,
        transactionsCount: paymentTransactions.length,
        denomsCount: cashTxDenoms.length,
        containers: paymentContainers,
        parts: paymentParts,
        transactions: paymentTransactions,
        denoms: cashTxDenoms,
        fiscalReceipts,
      },
      smartNonFiscal: {
        count: smartNonFiscal.length,
        total: smartNonFiscalTotal,
        byMethod: [...smartByMethodMap.values()].sort((a, b) => b.total - a.total),
        entries: smartNonFiscal
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 500),
      },
      serviceRecovery: {
        replacementsCount: serviceRecoveryReplacements.length,
        quantity: serviceRecoveryQuantity,
        compsCount: serviceRecoveryComps.length,
        compAmount: serviceRecoveryCompAmount,
        paidStornoAmount: serviceRecoveryPaidStornoAmount,
        comps: serviceRecoveryComps
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 500),
        replacements: serviceRecoveryReplacements
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 500),
      },
      ordersTracking: {
        count: normalizedOrders.length,
        statuses: orderStatusCounts,
        payments: orderPaymentCounts,
        orders: normalizedOrders,
        events: orderEvents,
      },
      transactions: sortedPayments.map((payment) => ({
        id: payment.id,
        createdAt: payment.createdAt,
        amount: payment.amount,
        methodId: payment.methodId,
        methodLabel: payment.methodLabel,
        fiscal: payment.fiscal,
        source: payment.source,
        tableId: payment.tableId,
        tableNumber: payment.tableNumber,
        tableLabel: payment.tableLabel,
        roomId: payment.roomId,
        orderId: payment.orderId,
        orderIds: payment.orderIds,
        billId: payment.billId,
        billIds: payment.billIds,
        tableCovers: payment.tableCovers,
        createdByUserId: payment.createdByUserId,
        createdByUsername: payment.createdByUsername,
        collectedByUserId: payment.collectedByUserId,
        collectedByUsername: payment.collectedByUsername,
        tableCancellationId: payment.tableCancellationId,
        tableCancelledAt: payment.tableCancelledAt,
        tableCancelledByUserId: payment.tableCancelledByUserId,
        tableCancelledByUsername: payment.tableCancelledByUsername,
        tableCancellationReason: payment.tableCancellationReason,
        adjustmentKind: payment.adjustmentKind,
        originalPaymentId: payment.originalPaymentId,
        supersedesPaymentId: payment.supersedesPaymentId,
        supersededByPaymentId: payment.supersededByPaymentId,
        paymentVoidAmount: payment.paymentVoidAmount,
        paymentRechargeAmount: payment.paymentRechargeAmount,
        rechargePaymentIds: payment.rechargePaymentIds,
        rechargeTransactionIds: payment.rechargeTransactionIds,
        items: payment.items,
      })),
    };
    report.settlementTotals = summarizeSettlementLedger(
      buildSettlementLedgerFromSalesReport(report),
    );
    return report;
  }

  function matchesReportUser(entry, user) {
    const userId = String(user?.id ?? "").trim();
    const username = String(user?.username ?? "").trim().toLowerCase();
    const ids = [
      entry?.createdByUserId,
      entry?.collectedByUserId,
      entry?.fiscalIssuedBy,
      entry?.operatorId,
      entry?.createdBy,
      entry?.userId,
    ]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
    if (userId && ids.includes(userId)) return true;
    const names = [
      entry?.createdByUsername,
      entry?.collectedByUsername,
      entry?.operatorName,
      entry?.username,
      entry?.waiter,
    ]
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter(Boolean);
    return Boolean(username && names.includes(username));
  }

  function buildUserScopedSalesReportDb(db, user) {
    const userPayments = (Array.isArray(db.payments) ? db.payments : []).filter((entry) =>
      matchesReportUser(entry, user)
    );
    const paymentContainers = (Array.isArray(db.paymentContainers) ? db.paymentContainers : []).filter((entry) =>
      matchesReportUser(entry, user)
    );
    const paymentIds = new Set(paymentContainers.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean));
    const paymentParts = (Array.isArray(db.paymentParts) ? db.paymentParts : []).filter((entry) =>
      paymentIds.has(String(entry?.paymentId ?? "").trim())
    );
    const partIds = new Set(paymentParts.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean));
    const paymentTransactions = (Array.isArray(db.paymentTransactions) ? db.paymentTransactions : []).filter((entry) =>
      partIds.has(String(entry?.partId ?? "").trim())
    );
    const fiscalPaymentIds = new Set(
      [
        ...paymentTransactions.map((entry) => entry?.id),
        ...paymentContainers.flatMap((entry) => [entry?.id, entry?.clientPaymentId]),
        ...userPayments.flatMap((entry) => [entry?.id, entry?.paymentTxId]),
      ]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    );
    const orderComps = (Array.isArray(db.integration?.orderComps) ? db.integration.orderComps : []).filter((entry) =>
      matchesReportUser(entry, user)
    );
    const barChargeReplacements = (Array.isArray(db.integration?.barChargeReplacements)
      ? db.integration.barChargeReplacements
      : []
    ).filter((entry) => matchesReportUser(entry, user));
    const orderIds = new Set();
    const addOrderId = (value) => {
      const id = String(value ?? "").trim();
      if (id) orderIds.add(id);
    };
    paymentContainers.forEach((entry) => {
      addOrderId(entry?.orderId);
      if (Array.isArray(entry?.orderIds)) entry.orderIds.forEach(addOrderId);
    });
    orderComps.forEach((entry) => addOrderId(entry?.orderId));
    barChargeReplacements.forEach((entry) => {
      addOrderId(entry?.orderId);
      if (Array.isArray(entry?.orderIds)) entry.orderIds.forEach(addOrderId);
    });
    const orders = (Array.isArray(db.integration?.orders) ? db.integration.orders : []).filter((entry) =>
      orderIds.has(String(entry?.id ?? "").trim()) || matchesReportUser(entry, user)
    );
    return {
      ...db,
      payments: userPayments,
      paymentContainers,
      paymentParts,
      paymentTransactions,
      paymentProviderTransactions: [],
      cashTxDenoms: [],
      fiscalReceipts: (Array.isArray(db.fiscalReceipts) ? db.fiscalReceipts : []).filter(
        (entry) => fiscalPaymentIds.has(String(entry?.paymentId ?? "").trim())
      ),
      fiscalEvents: [],
      smartNonFiscal: (Array.isArray(db.smartNonFiscal) ? db.smartNonFiscal : []).filter((entry) =>
        matchesReportUser(entry, user)
      ),
      auditEvents: [],
      users: Array.isArray(db.users) ? db.users.filter((entry) => String(entry?.id ?? "").trim() === user?.id) : [],
      sessions: Array.isArray(db.sessions) ? db.sessions.filter((entry) => String(entry?.userId ?? "").trim() === user?.id) : [],
      integration: {
        ...(db.integration && typeof db.integration === "object" ? db.integration : {}),
        orders,
        orderComps,
        barChargeReplacements,
      },
    };
  }

  async function handleSalesReport(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user } = resolveReportsAuthContext(req, db, payload, validateSessionContext);
    const canViewFullReport =
      isAdminUser(user) || hasPermission(user, "view_analytics") || hasPermission(user, "manage_users");
    const canViewOwnReport = hasPermission(user, "collect_payments") || hasPermission(user, "print_orders");
    if (!canViewFullReport && !canViewOwnReport) {
      throw new HttpError(403, "Utente non autorizzato alla consultazione pagamenti.");
    }
    const paymentsReadDb = await resolvePaymentsReportReadDb(db);
    const reportDb = canViewFullReport ? paymentsReadDb : buildUserScopedSalesReportDb(paymentsReadDb, user);
    sendJson(res, 200, {
      ok: true,
      report: buildSalesReport(reportDb),
      scope: canViewFullReport ? "full" : "user",
    });
  }

  function canViewFullReports(user) {
    return isAdminUser(user) || hasPermission(user, "view_analytics") || hasPermission(user, "manage_users");
  }

  async function handleHandheldCashSessionOpen(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user, session } = resolveReportsAuthContext(req, db, payload, validateSessionContext);
    if (!hasPermission(user, "collect_payments") && !canViewFullReports(user)) {
      throw new HttpError(403, "Utente non autorizzato all'apertura fondo cassa palmare.");
    }
    const cashFloat = roundMoney(Math.max(Number(payload.cashFloat) || 0, 0));
    if (cashFloat <= 0) {
      throw new HttpError(400, "Fondo cassa non valido per la sessione palmare.");
    }
    const record = recordHandheldCashSessionOpen(
      db,
      {
        ...payload,
        userId: user.id,
        username: user.username,
        fullName: user.fullName,
        deviceUuid: payload.deviceUuid || session?.deviceUuid,
        cashFloat,
      },
      { nowIso }
    );
    if (!record) {
      throw new HttpError(400, "Impossibile registrare il fondo cassa palmare.");
    }
    appendAuditEvent(db, {
      ...buildAuditActor(user, payload),
      action: "reports.handheld_cash_session_opened",
      entityType: "handheld_cash_session",
      entityId: record.id,
      payload: {
        sessionDate: record.openedAt ? record.openedAt.slice(0, 10) : null,
        openedAt: record.openedAt,
        deviceUuid: record.deviceUuid,
        cashFloat: record.cashFloat,
        activityId: record.activityId,
        roomId: record.roomId,
      },
    });
    db.meta.lastWriteAt = nowIso();
    await writeDb(db, {
      metricLabel: "reports.handheldCashSessionOpen.appStateWrite",
      splitDomains: HANDHELD_CASH_SESSION_WRITE_DOMAINS,
    });
    sendJson(res, 200, { ok: true, session: record });
  }

  async function handleHandheldCashSessionClose(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user, session } = resolveReportsAuthContext(req, db, payload, validateSessionContext);
    if (!hasPermission(user, "collect_payments") && !canViewFullReports(user)) {
      throw new HttpError(403, "Utente non autorizzato alla chiusura fondo cassa palmare.");
    }
    const record = recordHandheldCashSessionClose(
      db,
      {
        ...payload,
        userId: user.id,
        username: user.username,
        fullName: user.fullName,
        deviceUuid: payload.deviceUuid || session?.deviceUuid,
      },
      { nowIso }
    );
    if (!record) {
      throw new HttpError(400, "Impossibile chiudere il fondo cassa palmare.");
    }
    appendAuditEvent(db, {
      ...buildAuditActor(user, payload),
      action: "reports.handheld_cash_session_closed",
      entityType: "handheld_cash_session",
      entityId: record.id,
      payload: {
        openedAt: record.openedAt,
        closedAt: record.closedAt,
        deviceUuid: record.deviceUuid,
        cashFloat: record.cashFloat,
        totals: record.totals,
        activityId: record.activityId,
        roomId: record.roomId,
      },
    });
    db.meta.lastWriteAt = nowIso();
    await writeDb(db, {
      metricLabel: "reports.handheldCashSessionClose.appStateWrite",
      splitDomains: HANDHELD_CASH_SESSION_WRITE_DOMAINS,
    });
    sendJson(res, 200, { ok: true, session: record });
  }

  async function handleHandheldSessionReport(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user } = resolveReportsAuthContext(req, db, payload, validateSessionContext);
    if (!canViewFullReports(user)) {
      throw new HttpError(403, "Utente non autorizzato alla consultazione riepilogo palmari.");
    }
    const reportDb = await resolvePaymentsReportReadDb(db);
    sendJson(res, 200, {
      ok: true,
      report: buildHandheldSessionReport(reportDb, { date: payload.date }),
    });
  }

  async function handleHandheldSessionReportPrint(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user, session } = resolveReportsAuthContext(req, db, payload, validateSessionContext);
    if (!canViewFullReports(user)) {
      throw new HttpError(403, "Utente non autorizzato alla stampa riepilogo palmari.");
    }
    if (typeof enqueuePrintSpoolJob !== "function") {
      throw new HttpError(503, "Spool di stampa non disponibile per il riepilogo palmari.");
    }

    const settings = sanitizePosSettings(db.posSettings, { menuItems: db.menuItems, users: db.users });
    const printerId = resolveHandheldSessionReportPrinterId(settings, payload.printerId);
    if (!printerId) {
      throw new HttpError(409, "Stampante preconti Bar non configurata per il riepilogo palmari.", {
        code: "HANDHELD_SESSION_REPORT_PRINTER_MISSING",
      });
    }

    const reportDb = await resolvePaymentsReportReadDb(db);
    const report = buildHandheldSessionReport(reportDb, { date: payload.date });
    const actor = buildAuditActor(user, payload);
    appendAuditEvent(db, {
      ...actor,
      action: "reports.handheld_session_print_requested",
      entityType: "report",
      entityId: `handheld_session:${report.sessionDate}`,
      payload: {
        sessionDate: report.sessionDate,
        printerId,
        requestedBySessionId: session?.id ?? null,
        totals: report.totals,
      },
    });
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);

    const printJob = await enqueuePrintSpoolJob({
      kind: "handheld_session_report",
      printerId,
      text: formatHandheldSessionReportText(report),
      userId: user.id,
      deviceUuid: payload.deviceUuid,
      clientApp: "monitor-frontend",
    });

    sendJson(res, 200, {
      ok: true,
      report,
      printJob: {
        id: printJob.id,
        printerId: printJob.printerId,
        printerName: printJob.printerName,
        status: printJob.status,
      },
    });
  }

  return {
    "audit.eventDelete": handleAuditEventDelete,
    "audit.events": handleAuditEvents,
    "reports.handheldCashSessionOpen": handleHandheldCashSessionOpen,
    "reports.handheldCashSessionClose": handleHandheldCashSessionClose,
    "reports.handheldSession": handleHandheldSessionReport,
    "reports.handheldSessionPrint": handleHandheldSessionReportPrint,
    "reports.sales": handleSalesReport,
  };
}
