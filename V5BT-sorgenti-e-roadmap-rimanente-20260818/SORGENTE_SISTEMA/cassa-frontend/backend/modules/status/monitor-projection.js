/**
 * Proiezione del monitor: le funzioni che riducono l'app-state alla forma
 * che `/api/monitor/overview` e `/api/monitor/control` restituiscono.
 *
 * Stavano dentro la chiusura di `createStatusHandlers`. Finche restavano li,
 * le due route non potevano avere un modello di dominio che leggesse
 * l'app-state: il modello si crea nel composition root e non poteva
 * raggiungere `buildMonitorOverview`, mentre passargliela avrebbe creato una
 * dipendenza circolare -- il modello serve ai handler, e la funzione ai
 * handler sarebbe stata nel modello.
 *
 * Qui dentro non c'e **nessun accesso all'app-state e nessuna risposta**:
 * si riceve `db` e si restituiscono oggetti. Le sei dipendenze sono le
 * stesse che il blocco usava dalla factory di provenienza.
 */
import { buildHandheldSessionReport } from "../reports/handheld-session-report.js";
import { normalizeTableCovers } from "../tables/table-capacity.domain.js";

export function createMonitorProjection({
  appEnv,
  buildIntegrationStationStatesWithSessionRecovery,
  getRuntimeFeatureProfile,
  nowIso,
  resolveSettingsVersion,
  sanitizePosSettings,
}) {
  function normalizeText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function normalizeUrl(value) {
    return normalizeText(value).replace(/\/+$/, "");
  }

  function roundMoney(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }


  function toTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
    const parsed = Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function stationLookupKey(value) {
    return normalizeText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  function stationDisplayName(entry, fallback = "") {
    return normalizeText(
      entry?.station ??
      entry?.stationName ??
      entry?.stationId ??
      entry?.name ??
      entry?.label ??
      entry?.id ??
      fallback
    );
  }

  function compactConfiguredStation(entry, index, roomNameById = new Map(), inheritedRoomIds = []) {
    const station = stationDisplayName(entry, `Postazione ${index + 1}`);
    const key = stationLookupKey(station);
    if (!key) return null;
    const roomIds = [
      ...asArray(inheritedRoomIds),
      ...asArray(entry?.roomIds),
      ...asArray(entry?.rooms),
      ...asArray(entry?.areaIds),
    ].map(normalizeText).filter(Boolean);
    const roomNames = [
      ...new Set(roomIds.map((roomId) => roomNameById.get(roomId) || roomId).filter(Boolean)),
    ];
    const status = normalizeText(entry?.status).toLowerCase();
    const configuredActive = entry?.active !== false && status !== "disabled";
    return {
      station,
      active: false,
      stale: false,
      configured: true,
      configuredActive,
      realStation: false,
      operatorName: "",
      operatorRole: "",
      clientApp: "",
      updatedAtMs: 0,
      autoPrintOrders: entry?.printOrderEnabled !== false,
      autoPrintPreconto: entry?.printPrecontoEnabled !== false,
      roomIds,
      roomNames,
    };
  }

  function compactRuntimeStation(station) {
    return {
      station: stationDisplayName(station, "Postazione"),
      active: station?.active === true,
      stale: station?.stale === true,
      configured: station?.configured === true,
      configuredActive: station?.configuredActive !== false,
      realStation: station?.realStation === true,
      operatorName: normalizeText(station?.operatorName ?? station?.operatorUsername),
      operatorRole: normalizeText(station?.operatorRole),
      clientApp: normalizeText(station?.clientApp),
      updatedAtMs: Number(station?.updatedAtMs) || 0,
      autoPrintOrders: station?.autoPrintOrders === true,
      autoPrintPreconto: station?.autoPrintPreconto === true,
      roomIds: asArray(station?.roomIds).map(normalizeText).filter(Boolean),
      roomNames: asArray(station?.roomNames).map(normalizeText).filter(Boolean),
    };
  }

  function collectConfiguredStations(settings, roomNameById = new Map()) {
    const configured = [];
    asArray(settings?.workstations).forEach((entry, index) => {
      const station = compactConfiguredStation(entry, index, roomNameById);
      if (station) configured.push(station);
    });
    asArray(settings?.areas ?? settings?.rooms).forEach((area, areaIndex) => {
      const inheritedRoomIds = [area?.id ?? area?.roomId].map(normalizeText).filter(Boolean);
      asArray(area?.workstations).forEach((entry, workstationIndex) => {
        const station = compactConfiguredStation(
          entry,
          configured.length + workstationIndex + areaIndex,
          roomNameById,
          inheritedRoomIds
        );
        if (station) configured.push(station);
      });
    });
    return configured;
  }

  function buildMonitorStationStates(settings, sourceStationStates, roomNameById = new Map()) {
    const byKey = new Map();
    for (const station of collectConfiguredStations(settings, roomNameById)) {
      const key = stationLookupKey(station.station);
      if (key && !byKey.has(key)) byKey.set(key, station);
    }
    for (const runtimeStation of asArray(sourceStationStates).map(compactRuntimeStation)) {
      const key = stationLookupKey(runtimeStation.station);
      if (!key) continue;
      const configured = byKey.get(key);
      if (configured && runtimeStation.realStation !== true && runtimeStation.active !== true) {
        byKey.set(key, {
          ...configured,
          stale: runtimeStation.stale === true,
          autoPrintOrders: runtimeStation.autoPrintOrders === true || configured.autoPrintOrders === true,
          autoPrintPreconto: runtimeStation.autoPrintPreconto === true || configured.autoPrintPreconto === true,
          roomIds: runtimeStation.roomIds.length ? runtimeStation.roomIds : (configured.roomIds ?? []),
          roomNames: runtimeStation.roomNames.length ? runtimeStation.roomNames : (configured.roomNames ?? []),
        });
        continue;
      }
      byKey.set(key, {
        ...(configured || {}),
        ...runtimeStation,
        station: runtimeStation.station || configured?.station || "Postazione",
        configured: configured?.configured === true || runtimeStation.configured === true,
        configuredActive: configured?.configuredActive !== false && runtimeStation.configuredActive !== false,
        roomIds: runtimeStation.roomIds.length ? runtimeStation.roomIds : (configured?.roomIds ?? []),
        roomNames: runtimeStation.roomNames.length ? runtimeStation.roomNames : (configured?.roomNames ?? []),
      });
    }
    return [...byKey.values()].sort((left, right) => {
      const leftOnline = left.active && !left.stale ? 1 : 0;
      const rightOnline = right.active && !right.stale ? 1 : 0;
      if (leftOnline !== rightOnline) return rightOnline - leftOnline;
      const leftUpdated = Number(left.updatedAtMs) || 0;
      const rightUpdated = Number(right.updatedAtMs) || 0;
      if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;
      return normalizeText(left.station).localeCompare(normalizeText(right.station), "it-IT");
    });
  }

  function isPaidPaymentStatus(value) {
    const payment = normalizeText(value).toLowerCase();
    if (!payment || payment.includes("unpaid") || payment.includes("non pag")) return false;
    return [
      "paid",
      "pagato",
      "pagata",
      "pagati",
      "settled",
      "completed",
      "chiuso",
      "closed",
    ].includes(payment);
  }

  function orderDueAmount(order) {
    const explicit = Number(order?.dueAmount ?? order?.amountDue ?? order?.totalDue);
    if (Number.isFinite(explicit)) return roundMoney(Math.max(explicit, 0));
    const total = Number(order?.total);
    const paid = Number(order?.paidAmount);
    if (Number.isFinite(total) && Number.isFinite(paid)) return roundMoney(Math.max(total - paid, 0));
    if (Number.isFinite(total) && !isPaidPaymentStatus(order?.paymentStatus)) return roundMoney(Math.max(total, 0));
    return 0;
  }

  function orderStatusBucket(order) {
    const workflow = normalizeText(order?.workflowStatus ?? order?.status).toLowerCase();
    const payment = normalizeText(order?.paymentStatus).toLowerCase();
    const dueAmount = orderDueAmount(order);
    if (dueAmount > 0) return "payment_due";
    if (isPaidPaymentStatus(payment)) return "paid";
    if (workflow.includes("delivered") || workflow.includes("da pagare") || workflow.includes("payable")) return "payment_due";
    if (workflow.includes("ready") || workflow.includes("pront")) return "ready";
    if (workflow.includes("prep") || workflow.includes("prepar") || workflow.includes("working")) return "in_progress";
    return "sent";
  }

  function compactOrderItem(item) {
    const variants = item?.variants && typeof item.variants === "object" ? item.variants : {};
    return {
      id: normalizeText(item?.id),
      lineId: normalizeText(item?.lineId),
      name: normalizeText(item?.name ?? item?.productNameSnapshot ?? item?.productName ?? item?.productId) || "Articolo",
      qty: Math.max(0, Number(item?.qty ?? item?.quantity) || 0),
      doneQty: Math.max(0, Number(item?.doneQty) || 0),
      lineTotal: roundMoney(item?.lineTotal ?? item?.finalLinePrice),
      variant: normalizeText(item?.selectedVariantName ?? item?.variant),
      variants,
      notes: normalizeText(item?.notes ?? item?.note),
      removed: Boolean(item?.voidedAt || item?.removed || item?.isRemoved),
    };
  }

  function compactOrder(order) {
    const items = asArray(order?.items).map(compactOrderItem);
    const bucket = orderStatusBucket(order);
    const total = roundMoney(order?.total);
    const paidAmount = roundMoney(order?.paidAmount);
    const dueAmount = orderDueAmount(order);
    return {
      id: normalizeText(order?.id),
      title: normalizeText(order?.title) || items.map((item) => `${item.qty || 1}x ${item.name}`).join(" | "),
      bucket,
      workflowStatus: normalizeText(order?.workflowStatus ?? order?.status) || bucket,
      paymentStatus: normalizeText(order?.paymentStatus) || "unpaid",
      tableId: normalizeText(order?.tableId),
      tableNumber: Number(order?.tableNumber ?? order?.table),
      tableLabel: normalizeText(order?.tableLabel ?? order?.logicalTableLabel ?? order?.table),
      roomId: normalizeText(order?.roomId),
      station: normalizeText(order?.assignedStationId ?? order?.station ?? order?.ownerStation),
      waiter: normalizeText(order?.waiter ?? order?.createdByUsername),
      operator: normalizeText(order?.ownerOperator ?? order?.assignedStationOperatorName),
      covers: normalizeTableCovers(order?.covers),
      apericena: Math.max(0, Math.trunc(Number(order?.apericena) || 0)),
      total,
      paidAmount,
      dueAmount,
      note: normalizeText(order?.note),
      orderNote: normalizeText(order?.orderNote),
      orderComment: normalizeText(order?.orderComment),
      communications: normalizeText(order?.communications),
      createdAt: normalizeText(order?.createdAt),
      updatedAt: normalizeText(order?.updatedAt),
      createdAtMs: Number(order?.createdAtMs) || toTimestamp(order?.createdAt),
      readyAtMs: Number(order?.readyAtMs) || 0,
      completedAtMs: Number(order?.completedAtMs) || 0,
      itemsCount: items.reduce((sum, item) => sum + Math.max(1, item.qty || 0), 0),
      items,
    };
  }

  function tableRoomId(table) {
    return normalizeText(table?.roomId) || `room_${normalizeText(table?.type || "sala").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  }

  function compactTable(table, roomNameById = new Map()) {
    const pendingBills = asArray(table?.pendingBills);
    const orderHistory = asArray(table?.orderHistory);
    const amountDue = roundMoney(table?.amountDue ?? table?.totalDue ?? table?.dueAmount);
    const roomId = tableRoomId(table);
    const covers = normalizeTableCovers(table?.covers);
    const status = amountDue > 0
      ? "payment_due"
      : covers > 0 || normalizeText(table?.guestName ?? table?.customerName)
        ? "occupied"
        : normalizeText(table?.status) || "free";
    return {
      id: normalizeText(table?.id),
      number: Number(table?.number ?? table?.tableNumber),
      roomId,
      roomName: roomNameById.get(roomId) || normalizeText(table?.roomName ?? table?.type) || "Sala",
      status,
      rawStatus: normalizeText(table?.status) || "free",
      tableName: normalizeText(table?.guestName ?? table?.customerName ?? table?.tableName),
      covers,
      amountDue,
      pendingBillsCount: pendingBills.length,
      orderHistoryCount: orderHistory.length,
      ordersTaken: Math.max(0, Math.trunc(Number(table?.ordersTaken) || orderHistory.length || pendingBills.length || 0)),
      seatedAt: table?.seatedAt ?? null,
      note: normalizeText(table?.note ?? table?.notes),
      pendingBills: pendingBills.map((bill) => ({
        id: normalizeText(bill?.id),
        orderId: normalizeText(bill?.orderId),
        subtotal: roundMoney(bill?.subtotal ?? bill?.total ?? bill?.amountDue),
        linesCount: asArray(bill?.lines).length,
      })),
    };
  }

  function paymentMethodLabel(payment) {
    return normalizeText(
      payment?.methodLabel ??
      payment?.paymentMethodLabel ??
      payment?.methodId ??
      payment?.paymentMethod ??
      payment?.method
    ) || "Pagamento";
  }

  function compactPayment(payment) {
    return {
      id: normalizeText(payment?.id ?? payment?.paymentContainerId ?? payment?.paymentTxId),
      tableId: normalizeText(payment?.tableId),
      tableNumber: Number(payment?.tableNumber),
      tableLabel: normalizeText(payment?.tableLabel ?? payment?.tableNumber),
      roomId: normalizeText(payment?.roomId),
      orderIds: asArray(payment?.orderIds).map(normalizeText).filter(Boolean),
      amount: roundMoney(payment?.amount ?? payment?.totalAmount ?? payment?.amountPaid),
      method: paymentMethodLabel(payment),
      note: normalizeText(payment?.note),
      createdAt: normalizeText(payment?.createdAt),
      createdAtMs: toTimestamp(payment?.createdAt),
      operator: normalizeText(payment?.collectedByDisplayName ?? payment?.createdByDisplayName ?? payment?.collectedByUsername ?? payment?.createdByUsername),
      status: normalizeText(payment?.status ?? payment?.paymentStatus) || "COMPLETED",
      fiscalDocNo: normalizeText(payment?.fiscalDocNo),
      tableCancellationId: normalizeText(payment?.tableCancellationId),
      tableCancelledAt: normalizeText(payment?.tableCancelledAt),
      tableCancelledByUsername: normalizeText(payment?.tableCancelledByUsername),
      tableCancellationReason: normalizeText(payment?.tableCancellationReason),
    };
  }

  function compactFiscalReceipt(receipt) {
    const status = normalizeText(receipt?.fiscalStatus ?? receipt?.status).toUpperCase() || "UNKNOWN";
    return {
      id: normalizeText(receipt?.id),
      paymentId: normalizeText(receipt?.paymentId),
      provider: normalizeText(receipt?.fiscalProvider ?? receipt?.provider),
      status,
      requiresRetry: receipt?.requiresFiscalRetry === true,
      error: normalizeText(receipt?.fiscalError ?? receipt?.responseMessage),
      createdAt: normalizeText(receipt?.createdAt),
      createdAtMs: toTimestamp(receipt?.createdAt),
    };
  }

  function isFailureStatus(value) {
    const status = normalizeText(value).toLowerCase();
    return status.includes("fail") || status.includes("error") || status.includes("ko") || status.includes("retry");
  }

  function normalizePrintSpoolStatus(value) {
    return normalizeText(value).toLowerCase() || "unknown";
  }

  function buildPrintSpoolMetrics(printSpoolJobs) {
    const jobs = asArray(printSpoolJobs);
    const countsByStatus = {};
    for (const job of jobs) {
      const status = normalizePrintSpoolStatus(job?.status);
      countsByStatus[status] = (countsByStatus[status] || 0) + 1;
    }
    const queued = countsByStatus.queued || 0;
    const processing = countsByStatus.processing || 0;
    const failed = countsByStatus.failed || 0;
    const failedConfiguration = countsByStatus.failed_configuration || 0;
    const unknownAfterCrash = countsByStatus.unknown_after_crash || 0;
    const retryableFailed = jobs.filter((job) => {
      const status = normalizePrintSpoolStatus(job?.status);
      return status === "failed" && normalizeText(job?.nextRetryAt);
    }).length;
    const terminalFailed = failed - retryableFailed + failedConfiguration + unknownAfterCrash;
    return {
      total: jobs.length,
      queued,
      processing,
      pending: queued + processing,
      active: queued + processing,
      printed: countsByStatus.printed || 0,
      disabled: countsByStatus.disabled || 0,
      failed,
      failedRetryable: retryableFailed,
      failedTerminal: Math.max(0, terminalFailed),
      failedConfiguration,
      unknownAfterCrash,
      byStatus: countsByStatus,
    };
  }

  function actionIncludes(entry, words) {
    const action = normalizeText(entry?.action ?? entry?.type ?? entry?.command).toLowerCase();
    return words.some((word) => action.includes(word));
  }

  function buildOperationMetrics(db, payments) {
    const fiscalReceipts = asArray(db?.fiscalReceipts).map(compactFiscalReceipt).sort((left, right) => right.createdAtMs - left.createdAtMs);
    const fiscalEvents = asArray(db?.fiscalEvents);
    const auditEvents = asArray(db?.auditEvents);
    const orderCorrections = asArray(db?.integration?.orderCorrections);
    const orderComps = asArray(db?.integration?.orderComps);
    const replacements = asArray(db?.integration?.barChargeReplacements);
    const paymentTransactions = asArray(db?.paymentTransactions);
    const printSpoolJobs = asArray(db?.printSpoolJobs);
    const issuedFiscalReceipts = fiscalReceipts.filter((receipt) => receipt.status === "ISSUED" && receipt.requiresRetry !== true);
    const failedFiscalReceipts = fiscalReceipts.filter((receipt) => receipt.requiresRetry || isFailureStatus(receipt.status));
    const modificationAuditCount = auditEvents.filter((event) => actionIncludes(event, ["order.correction", "order.modified", "order.updated", "modifica"])).length;
    const stornoAuditCount = auditEvents.filter((event) => actionIncludes(event, ["storno", "refund", "reso"])).length;
    const replacementAuditCount = auditEvents.filter((event) => actionIncludes(event, ["bar_replacement", "sostituz"])).length;
    const stornoRecords = orderComps.filter((entry) => {
      const impact = normalizeText(entry?.financialImpact ?? entry?.fiscalTreatment ?? entry?.requestedOperationType ?? entry?.operationType).toLowerCase();
      return impact.includes("storno") || impact.includes("refund") || impact.includes("reso");
    });
    const zeroCostReplacements = orderComps.filter((entry) => {
      const impact = normalizeText(entry?.replacementSettlement ?? entry?.financialImpact ?? entry?.operationType).toLowerCase();
      return impact.includes("non_chargeable") || impact.includes("zero_cost") || impact === "none";
    });
    const stornoAmount = roundMoney(stornoRecords.reduce((sum, entry) => sum + Math.max(Number(entry?.amount ?? entry?.paymentStornoAmount ?? entry?.refundAmount) || 0, 0), 0));
    return {
      fiscalReceipts: {
        total: fiscalReceipts.length,
        issued: issuedFiscalReceipts.length,
        realIssued: issuedFiscalReceipts.filter((receipt) => receipt.provider && receipt.provider !== "mock").length,
        failed: failedFiscalReceipts.length,
        retry: fiscalReceipts.filter((receipt) => receipt.requiresRetry).length,
        recent: fiscalReceipts.slice(0, 12),
        events: fiscalEvents.length,
      },
      payments: {
        movements: payments.length,
        transactions: paymentTransactions.length,
      },
      orderChanges: {
        modifications: orderCorrections.length,
        correctionRecords: orderCorrections.length,
        modificationAuditEvents: modificationAuditCount,
        storni: stornoRecords.length,
        stornoAuditEvents: stornoAuditCount,
        stornoAmount,
        replacements: replacements.length + zeroCostReplacements.length,
        replacementRecords: replacements.length,
        replacementAuditEvents: replacementAuditCount,
      },
      printSpool: {
        ...buildPrintSpoolMetrics(printSpoolJobs),
      },
      audit: {
        total: auditEvents.length,
      },
    };
  }

  function buildMonitorOverview(db) {
    const settings = sanitizePosSettings(db?.posSettings, { menuItems: db?.menuItems, users: db?.users });
    const roomEntries = [...asArray(settings?.rooms), ...asArray(settings?.areas)];
    const roomSeen = new Set();
    const rooms = roomEntries.map((room) => ({
      id: normalizeText(room?.id ?? room?.roomId),
      name: normalizeText(room?.name ?? room?.label ?? room?.roomName ?? room?.type) || "Sala",
      type: normalizeText(room?.type ?? room?.name),
    })).filter((room) => {
      if (!room.id || roomSeen.has(room.id)) return false;
      roomSeen.add(room.id);
      return true;
    });
    const roomNameById = new Map(rooms.map((room) => [room.id, room.name]));
    const tables = asArray(settings?.tables).map((table) => compactTable(table, roomNameById));
    const orders = asArray(db?.integration?.orders).map(compactOrder).sort((left, right) => right.createdAtMs - left.createdAtMs);
    const paymentIds = new Set();
    const payments = [...asArray(db?.payments), ...asArray(db?.paymentContainers)]
      .map(compactPayment)
      .filter((payment) => {
        const key = payment.id || `${payment.createdAtMs}:${payment.amount}:${payment.method}:${payment.tableId}`;
        if (paymentIds.has(key)) return false;
        paymentIds.add(key);
        return true;
      })
      .sort((left, right) => right.createdAtMs - left.createdAtMs);
    const operationMetrics = buildOperationMetrics(db, payments);
    const sourceStationStates =
      typeof buildIntegrationStationStatesWithSessionRecovery === "function"
        ? buildIntegrationStationStatesWithSessionRecovery(db)
        : db?.integration?.stationStates;
    const stationStates = buildMonitorStationStates(settings, sourceStationStates, roomNameById);
    const orderCounts = orders.reduce(
      (acc, order) => {
        acc.total += 1;
        acc[order.bucket] = (acc[order.bucket] || 0) + 1;
        return acc;
      },
      { total: 0, sent: 0, in_progress: 0, ready: 0, payment_due: 0, paid: 0 }
    );
    const occupiedTables = tables.filter((table) => table.status !== "free");
    const paymentDueTables = tables.filter((table) => table.amountDue > 0);
    const totalDue = roundMoney(paymentDueTables.reduce((sum, table) => sum + table.amountDue, 0));
    const totalPaid = roundMoney(payments.reduce((sum, payment) => sum + Math.max(0, payment.amount), 0));
    const currentCovers = tables.reduce((sum, table) => sum + normalizeTableCovers(table.covers), 0);
    const orderCovers = orders.reduce((sum, order) => sum + normalizeTableCovers(order.covers), 0);
    const apericenaMarked = orders.reduce(
      (sum, order) => sum + Math.max(0, Math.trunc(Number(order.apericena) || 0)),
      0
    );
    const handheldSessionReport = buildHandheldSessionReport(db);
    return {
      ok: true,
      generatedAt: nowIso(),
      system: {
        service: "cash-backend",
        environment: appEnv,
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        dbUpdatedAt: normalizeText(db?.meta?.lastWriteAt),
        settingsVersion: resolveSettingsVersion(db?.meta),
      },
      api: {
        backend: true,
        orders: true,
        layout: true,
        payments: true,
      },
      counts: {
        orders: orderCounts,
        tables: {
          total: tables.length,
          occupied: occupiedTables.length,
          free: Math.max(0, tables.length - occupiedTables.length),
          paymentDue: paymentDueTables.length,
        },
        payments: {
          total: payments.length,
          totalPaid,
          totalDue,
          missingCount: paymentDueTables.length,
        },
        service: {
          currentCovers,
          orderCovers,
          apericenaMarked,
        },
        operations: operationMetrics,
        stations: {
          total: stationStates.length,
          active: stationStates.filter((station) => station.active && !station.stale).length,
          stale: stationStates.filter((station) => station.stale).length,
        },
      },
      rooms,
      tables,
      orders,
      payments,
      fiscalReceipts: operationMetrics.fiscalReceipts.recent,
      handheldSessionReport,
      operationMetrics,
      stations: stationStates,
      missingPayments: paymentDueTables,
      recentEvents: [
        ...orders.slice(0, 8).map((order) => ({
          type: "order",
          at: order.updatedAt || order.createdAt,
          label: `Comanda ${order.id || "-"}`,
          detail: `${order.tableLabel ? `Tavolo ${order.tableLabel}` : "Tavolo n/d"} - ${order.workflowStatus}`,
        })),
        ...payments.slice(0, 8).map((payment) => ({
          type: "payment",
          at: payment.createdAt,
          label: `Pagamento ${payment.id || "-"}`,
          detail: `${payment.method} - ${payment.amount.toFixed(2)} EUR`,
        })),
        ...operationMetrics.fiscalReceipts.recent.slice(0, 4).map((receipt) => ({
          type: "fiscal",
          at: receipt.createdAt,
          label: `Fiscale ${receipt.id || "-"}`,
          detail: `${receipt.status}${receipt.paymentId ? ` - pagamento ${receipt.paymentId}` : ""}`,
        })),
      ].sort((left, right) => toTimestamp(right.at) - toTimestamp(left.at)).slice(0, 12),
      runtimeFeatureProfile:
        typeof getRuntimeFeatureProfile === "function" ? getRuntimeFeatureProfile() : null,
    };
  }

  return {
    actionIncludes,
    asArray,
    buildMonitorOverview,
    buildMonitorStationStates,
    buildOperationMetrics,
    buildPrintSpoolMetrics,
    collectConfiguredStations,
    compactConfiguredStation,
    compactFiscalReceipt,
    compactOrder,
    compactOrderItem,
    compactPayment,
    compactRuntimeStation,
    compactTable,
    isFailureStatus,
    isPaidPaymentStatus,
    normalizePrintSpoolStatus,
    normalizeText,
    normalizeUrl,
    orderDueAmount,
    orderStatusBucket,
    paymentMethodLabel,
    roundMoney,
    stationDisplayName,
    stationLookupKey,
    tableRoomId,
    toTimestamp,
  };
}
