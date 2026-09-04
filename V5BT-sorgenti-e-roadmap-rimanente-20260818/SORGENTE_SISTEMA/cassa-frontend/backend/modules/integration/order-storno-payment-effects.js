function paymentContainerReferencesOrder(container, orderId, normalizePaymentOrderIdList) {
  const safeOrderId = String(orderId ?? "").trim();
  if (!safeOrderId || !container) return false;
  return normalizePaymentOrderIdList(
    container.orderIds,
    String(container.tableId ?? "").trim(),
  ).some((candidate) => candidate === safeOrderId);
}

function isSupersededPaymentContainer(container) {
  if (!container || typeof container !== "object") return false;
  return Boolean(
    String(container.supersededByPaymentId ?? "").trim() ||
      String(container.supersededByCompId ?? "").trim() ||
      String(container.supersededByStornoId ?? "").trim() ||
      String(container.supersededAt ?? "").trim(),
  );
}

function allocateCentsProportionally(entries, targetCents, weightFn) {
  const safeEntries = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const safeTarget = Math.max(Math.trunc(Number(targetCents) || 0), 0);
  if (!safeEntries.length || safeTarget <= 0) return [];
  const weightedEntries = safeEntries.map((entry, index) => {
    const weight = Math.max(Math.trunc(Number(weightFn(entry)) || 0), 0);
    return { entry, index, weight };
  });
  const totalWeight = weightedEntries.reduce(
    (sum, entry) => sum + entry.weight,
    0,
  );
  if (totalWeight <= 0) return [];

  let assigned = 0;
  const allocations = weightedEntries.map((entry) => {
    const exact = (safeTarget * entry.weight) / totalWeight;
    const amount = Math.min(Math.floor(exact), entry.weight);
    assigned += amount;
    return {
      entry: entry.entry,
      index: entry.index,
      amount,
      remainder: exact - amount,
      maxAmount: entry.weight,
    };
  });

  let remaining = safeTarget - assigned;
  allocations
    .sort(
      (left, right) =>
        right.remainder - left.remainder || left.index - right.index,
    )
    .forEach((allocation) => {
      if (remaining <= 0) return;
      if (allocation.amount >= allocation.maxAmount) return;
      allocation.amount += 1;
      remaining -= 1;
    });

  return allocations
    .sort((left, right) => left.index - right.index)
    .filter((allocation) => allocation.amount > 0)
    .map(({ entry, amount }) => ({ entry, amount }));
}

function allocateCentsSequentially(entries, targetCents, amountFn) {
  const allocations = [];
  let remaining = Math.max(Math.trunc(Number(targetCents) || 0), 0);
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (remaining <= 0) break;
    const available = Math.max(Math.trunc(Number(amountFn(entry)) || 0), 0);
    const amount = Math.min(available, remaining);
    if (amount <= 0) continue;
    allocations.push({ entry, amount });
    remaining -= amount;
  }
  return allocations;
}

export function createOrderStornoPaymentEffects(deps = {}) {
  const {
    PRIMARY_INTEGRATION_STATION,
    appendPrintSpoolJobToDb,
    buildMobileElectronicPaymentPrintText,
    buildMobilePaymentStornoPrintText,
    centsToMoney,
    collectPaymentPartsAndTransactionsForContainer,
    ensurePaymentTrackingArrays,
    formatIntegrationPrintOrderId,
    mapPaymentMethodToTransactionType,
    moneyToCents,
    normalizePaymentContinuationSplitMode,
    normalizePaymentMethodType,
    normalizePaymentOrderIdList,
    normalizeStornoPaymentReferences,
    normalizeStringList,
    nowIso,
    parseTimestampMs,
    randomUUID,
    resolvePrintRoomLabel,
    roundMoney,
    sanitizeIntegrationTableLabel,
    sanitizePaymentContainerRecord,
    sanitizePaymentPartRecord,
    sanitizePaymentRecord,
    sanitizePaymentTransactionRecord,
    sanitizePosSettings,
  } = deps;

  function listCompletedPaymentContainersForOrder(db, orderId) {
    const safeOrderId = String(orderId ?? "").trim();
    if (!safeOrderId) return [];
    return (Array.isArray(db?.paymentContainers) ? db.paymentContainers : [])
      .map((entry, index) =>
        sanitizePaymentContainerRecord(entry, `payc_${index + 1}`),
      )
      .filter((container) => {
        if (!container || container.status !== "COMPLETED") return false;
        if (isSupersededPaymentContainer(container)) return false;
        if (
          !paymentContainerReferencesOrder(
            container,
            safeOrderId,
            normalizePaymentOrderIdList,
          )
        )
          return false;
        return moneyToCents(container.amount) > 0;
      })
      .sort(
        (left, right) =>
          parseTimestampMs(left.createdAt, 0) -
          parseTimestampMs(right.createdAt, 0),
      );
  }

  function inferPaymentContainerRefundMethod(container, transactions) {
    const methods = [
      ...new Set(
        (Array.isArray(transactions) ? transactions : [])
          .map((tx) => normalizePaymentMethodType(tx?.method))
          .filter((method) => method !== "OTHER"),
      ),
    ];
    if (methods.length === 1) return methods[0];
    if (methods.length > 1) return "MIXED";
    return normalizePaymentMethodType(
      mapPaymentMethodToTransactionType(
        container?.paymentMethod,
        container?.paymentMethod,
      ),
    );
  }

  function resolveOrderCompPaymentReferences(db, options = {}) {
    const order =
      options?.order && typeof options.order === "object" ? options.order : null;
    const orderId = String(order?.id ?? options?.orderId ?? "").trim();
    const targetCents = moneyToCents(options?.amount);
    if (!orderId || targetCents <= 0) return [];
    const requireArticleUnitMatch = options?.requireArticleUnitMatch === true;
    const selectedArticleUnitIds = new Set(
      normalizeStringList(options?.articleUnitIds, 1000, 120),
    );
    const containers = (
      Array.isArray(db?.paymentContainers) ? db.paymentContainers : []
    )
      .map((entry, index) =>
        sanitizePaymentContainerRecord(entry, `payc_${index + 1}`),
      )
      .filter((container) => {
        if (!container || container.status !== "COMPLETED") return false;
        if (isSupersededPaymentContainer(container)) return false;
        if (
          !paymentContainerReferencesOrder(
            container,
            orderId,
            normalizePaymentOrderIdList,
          )
        )
          return false;
        return moneyToCents(container.amount) > 0;
      })
      .map((container) => {
        const containerArticleUnitIds = normalizeStringList(
          container.articleUnitIds,
          1000,
          120,
        );
        const exactArticleMatch =
          selectedArticleUnitIds.size > 0 &&
          containerArticleUnitIds.some((unitId) =>
            selectedArticleUnitIds.has(unitId),
          );
        const articleFallback =
          !exactArticleMatch &&
          selectedArticleUnitIds.size > 0 &&
          containerArticleUnitIds.length === 0 &&
          normalizePaymentContinuationSplitMode(container.splitMode) ===
            "article";
        return {
          container,
          rank: exactArticleMatch ? 0 : articleFallback ? 1 : 2,
        };
      })
      .filter((entry) => !requireArticleUnitMatch || entry.rank < 2)
      .sort((left, right) => {
        if (left.rank !== right.rank) return left.rank - right.rank;
        return (
          parseTimestampMs(left.container.createdAt, 0) -
          parseTimestampMs(right.container.createdAt, 0)
        );
      });

    let remainingCents = targetCents;
    const references = [];
    for (const { container } of containers) {
      if (remainingCents <= 0) break;
      let containerRemainingCents = Math.min(
        moneyToCents(container.amount),
        remainingCents,
      );
      if (containerRemainingCents <= 0) continue;
      const { transactions } = collectPaymentPartsAndTransactionsForContainer(
        db,
        container.id,
      );
      const txCandidates =
        transactions.length > 0
          ? transactions.sort(
              (left, right) =>
                parseTimestampMs(left.createdAt, 0) -
                parseTimestampMs(right.createdAt, 0),
            )
          : [
              {
                id: "",
                method: container.paymentMethod ?? "OTHER",
                amountPaid: centsToMoney(containerRemainingCents),
                createdAt: container.createdAt,
              },
            ];
      for (const tx of txCandidates) {
        if (containerRemainingCents <= 0 || remainingCents <= 0) break;
        const txCents = moneyToCents(tx.amountPaid);
        if (txCents <= 0) continue;
        const allocatedCents = Math.min(
          txCents,
          containerRemainingCents,
          remainingCents,
        );
        if (allocatedCents <= 0) continue;
        references.push({
          paymentId: container.id,
          transactionId: String(tx.id ?? "").trim() || null,
          method: normalizePaymentMethodType(tx.method),
          amount: centsToMoney(allocatedCents),
          createdAt: String(tx.createdAt ?? container.createdAt ?? nowIso()),
          fiscalDocNo: container.fiscalDocNo ?? null,
          fiscalDocType: container.fiscalDocType ?? null,
          articleUnitIds: normalizeStringList(
            container.articleUnitIds,
            1000,
            120,
          ),
        });
        containerRemainingCents -= allocatedCents;
        remainingCents -= allocatedCents;
      }
    }
    return references;
  }

  function buildRefundPlanAllocation(db, entry, amountCents) {
    const container = entry?.container ?? entry;
    const safeAmountCents = Math.max(Math.trunc(Number(amountCents) || 0), 0);
    const containerAmountCents = moneyToCents(container?.amount);
    const { transactions } = collectPaymentPartsAndTransactionsForContainer(
      db,
      container?.id,
    );
    const method = inferPaymentContainerRefundMethod(container, transactions);
    const articleUnitIds = normalizeStringList(entry?.articleUnitIds, 1000, 120);
    const transactionRefs = (
      transactions.length > 0
        ? transactions
        : [
            {
              id: null,
              method,
              amountPaid: container?.amount,
              posProvider: null,
              posTxRef: null,
              createdAt: container?.createdAt,
            },
          ]
    ).map((tx) => ({
      transactionId: tx?.id ? String(tx.id) : null,
      method: normalizePaymentMethodType(tx?.method),
      amount: centsToMoney(moneyToCents(tx?.amountPaid)),
      posProvider: tx?.posProvider ? String(tx.posProvider) : null,
      posTxRef: tx?.posTxRef ? String(tx.posTxRef) : null,
      createdAt: String(tx?.createdAt ?? container?.createdAt ?? nowIso()),
    }));
    const isPos = method === "POS";
    const posPartialSupported = false;
    const rechargeCents = isPos
      ? Math.max(containerAmountCents - safeAmountCents, 0)
      : 0;
    const action =
      method === "CASH"
        ? "cash_refund"
        : isPos && rechargeCents > 0
          ? "pos_void_full_transaction_and_recharge_remaining"
          : isPos
            ? "pos_void_full_transaction"
            : method === "MIXED"
              ? "manual_mixed_refund"
              : "manual_refund";

    return {
      paymentId: String(container?.id ?? "").trim(),
      transactionIds: transactionRefs
        .map((tx) => tx.transactionId)
        .filter(Boolean),
      transactions: transactionRefs,
      method,
      paymentMethod: container?.paymentMethod
        ? String(container.paymentMethod)
        : null,
      splitMode:
        normalizePaymentContinuationSplitMode(container?.splitMode) ?? null,
      amount: centsToMoney(safeAmountCents),
      refundAmount: centsToMoney(safeAmountCents),
      action,
      posPartialSupported: isPos ? posPartialSupported : null,
      voidAmount: isPos ? centsToMoney(containerAmountCents) : 0,
      rechargeAmount: isPos ? centsToMoney(rechargeCents) : 0,
      articleUnitIds,
      fiscalDocType: container?.fiscalDocType ?? null,
      fiscalDocNo: container?.fiscalDocNo ?? null,
      createdAt: String(container?.createdAt ?? nowIso()),
    };
  }

  function buildOrderCompRefundPlan(db, options = {}) {
    const order =
      options?.order && typeof options.order === "object" ? options.order : null;
    const orderId = String(order?.id ?? options?.orderId ?? "").trim();
    const refundCents = moneyToCents(options?.amount);
    const compId = String(options?.compId ?? "").trim();
    if (!orderId || refundCents <= 0) {
      return {
        id: compId
          ? `refund_${compId}`
          : `refund_${randomUUID().replace(/-/g, "")}`,
        status: "not_required",
        mode: "none",
        amount: 0,
        allocations: [],
      };
    }

    const selectedArticleUnitIds = new Set(
      normalizeStringList(options?.articleUnitIds, 1000, 120),
    );
    const containers = listCompletedPaymentContainersForOrder(db, orderId);
    const articleEntries = containers
      .map((container) => {
        const containerArticleUnitIds = normalizeStringList(
          container.articleUnitIds,
          1000,
          120,
        );
        const matchedArticleUnitIds = containerArticleUnitIds.filter((unitId) =>
          selectedArticleUnitIds.has(unitId),
        );
        const isLegacyArticleContainer =
          selectedArticleUnitIds.size > 0 &&
          matchedArticleUnitIds.length === 0 &&
          containerArticleUnitIds.length === 0 &&
          normalizePaymentContinuationSplitMode(container.splitMode) ===
            "article";
        return matchedArticleUnitIds.length > 0 || isLegacyArticleContainer
          ? {
              container,
              articleUnitIds: matchedArticleUnitIds,
              legacyTraceFallback: isLegacyArticleContainer,
            }
          : null;
      })
      .filter((entry) => entry !== null);

    const hasArticleTrace = articleEntries.length > 0;
    const splitModes = new Set(
      containers
        .map((container) =>
          normalizePaymentContinuationSplitMode(container.splitMode),
        )
        .filter(Boolean),
    );
    const mode = hasArticleTrace
      ? "article_transaction"
      : splitModes.has("roman")
        ? "roman_proportional"
        : splitModes.has("amount")
          ? "amount_proportional"
          : containers.length === 1
            ? "single_payment"
            : "mixed_payment_proportional";
    const allocationSeeds = hasArticleTrace
      ? allocateCentsSequentially(articleEntries, refundCents, (entry) =>
          moneyToCents(entry.container.amount),
        )
      : allocateCentsProportionally(
          containers.map((container) => ({ container, articleUnitIds: [] })),
          refundCents,
          (entry) => moneyToCents(entry.container.amount),
        );
    const allocations = allocationSeeds.map(({ entry, amount }) => ({
      ...buildRefundPlanAllocation(db, entry, amount),
      ...(entry.legacyTraceFallback
        ? { traceQuality: "legacy_article_payment_without_unit_ids" }
        : {}),
    }));

    return {
      id: compId
        ? `refund_${compId}`
        : `refund_${randomUUID().replace(/-/g, "")}`,
      status:
        allocations.length > 0
          ? "requires_manual_execution"
          : "unmatched_payment",
      mode,
      amount: centsToMoney(refundCents),
      fiscalReturnAmount: centsToMoney(refundCents),
      posPartialSupported: false,
      articleUnitIds: [...selectedArticleUnitIds],
      allocations,
      instructions:
        "I pagamenti originali restano tracciati. Per POS senza storno parziale: annullare la transazione indicata e riaddebitare il residuo; per contanti rimborsare solo l'importo allocato.",
    };
  }

  function buildPaymentReferencesFromRefundPlan(refundPlan) {
    return normalizeStornoPaymentReferences(
      refundPlan && Array.isArray(refundPlan.allocations)
        ? refundPlan.allocations
        : [],
    ).map((reference) => ({
      paymentId: reference.paymentId,
      method: reference.method,
      action: reference.action,
      refundAmount: reference.refundAmount,
      voidAmount: reference.voidAmount,
      rechargeAmount: reference.rechargeAmount,
      transactionIds: reference.transactionIds,
      fiscalDocType: reference.fiscalDocType || null,
      fiscalDocNo: reference.fiscalDocNo || null,
    }));
  }

  function paymentMethodLabelForAdjustment(settings, methodId, methodType) {
    const safeMethodId = String(methodId ?? "").trim();
    const methods = Array.isArray(settings?.paymentMethods)
      ? settings.paymentMethods
      : [];
    const configured = methods.find(
      (method) => String(method?.id ?? "").trim() === safeMethodId,
    );
    if (configured && String(configured.label ?? "").trim())
      return String(configured.label).trim();
    const normalizedType = normalizePaymentMethodType(methodType);
    if (normalizedType === "POS") return "Carta/POS";
    if (normalizedType === "CASH") return "Contanti";
    return safeMethodId || "Pagamento";
  }

  async function applyOrderCompPaymentAdjustmentsForRefundPlan(db, options = {}) {
    const refundPlan =
      options?.refundPlan && typeof options.refundPlan === "object"
        ? options.refundPlan
        : {};
    const allocations = Array.isArray(refundPlan.allocations)
      ? refundPlan.allocations
      : [];
    const settings = sanitizePosSettings(options?.settings ?? db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const user =
      options?.user && typeof options.user === "object" ? options.user : {};
    const session =
      options?.session && typeof options.session === "object"
        ? options.session
        : {};
    const order =
      options?.order && typeof options.order === "object" ? options.order : {};
    const compId = String(options?.compId ?? "").trim();
    const roomId = String(options?.roomId ?? order.roomId ?? "").trim();
    const roomName = resolvePrintRoomLabel(
      settings,
      roomId,
      options?.roomName ?? "",
    );
    const tableLabel =
      sanitizeIntegrationTableLabel(
        options?.tableLabel ?? order.tableLabel ?? order.logicalTableLabel,
      ) || (order.tableNumber ? String(order.tableNumber) : "");
    const tableNumber = Number.isFinite(Number(order.tableNumber))
      ? Math.trunc(Number(order.tableNumber))
      : 0;
    const waiterName =
      String(user.fullName ?? user.username ?? order.waiter ?? "").trim() ||
      "Cameriere";
    const createdAt = String(options?.createdAt ?? nowIso());
    const adjustment = {
      voidAmount: 0,
      rechargeAmount: 0,
      stornoAmount: 0,
      rechargePaymentIds: [],
      rechargeTransactionIds: [],
      rechargePrintJobIds: [],
      rechargePrintPayloads: [],
      mutationSummary: {
        supersededPaymentIds: [],
        createdPaymentIds: [],
        createdPaymentPartIds: [],
        createdPaymentTransactionIds: [],
        createdLegacyPaymentIds: [],
      },
    };

    ensurePaymentTrackingArrays(db);
    if (!Array.isArray(db.payments)) db.payments = [];

    for (const allocation of allocations) {
      const action = String(allocation?.action ?? "").trim();
      const refundAmount = roundMoney(
        Math.max(Number(allocation?.refundAmount ?? allocation?.amount) || 0, 0),
      );
      const voidAmount = roundMoney(
        Math.max(Number(allocation?.voidAmount) || 0, 0),
      );
      const rechargeAmount = roundMoney(
        Math.max(Number(allocation?.rechargeAmount) || 0, 0),
      );
      adjustment.stornoAmount = roundMoney(
        adjustment.stornoAmount + (voidAmount > 0 ? voidAmount : refundAmount),
      );
      if (voidAmount > 0)
        adjustment.voidAmount = roundMoney(adjustment.voidAmount + voidAmount);
      if (
        rechargeAmount <= 0 ||
        action !== "pos_void_full_transaction_and_recharge_remaining"
      )
        continue;

      const originalPaymentId = String(allocation?.paymentId ?? "").trim();
      if (!originalPaymentId) continue;
      const originalIndex = db.paymentContainers.findIndex(
        (entry) => String(entry?.id ?? "").trim() === originalPaymentId,
      );
      if (originalIndex < 0) continue;
      const originalContainer = sanitizePaymentContainerRecord(
        db.paymentContainers[originalIndex],
        originalPaymentId,
      );
      if (!originalContainer || isSupersededPaymentContainer(originalContainer))
        continue;

      const idSuffix = randomUUID().replace(/-/g, "");
      const paymentId = `pay_recharge_${idSuffix}`;
      const partId = `part_recharge_${idSuffix}`;
      const txId = `tx_recharge_${idSuffix}`;
      const methodType = normalizePaymentMethodType(allocation?.method ?? "POS");
      const paymentMethod =
        originalContainer.paymentMethod ||
        (methodType === "POS" ? "pay_card" : "pay_cash");
      const methodLabel = paymentMethodLabelForAdjustment(
        settings,
        paymentMethod,
        methodType,
      );
      const note = `Riaddebito dopo storno ${compId || ""}`.trim();
      const refundedArticleUnitIds = new Set(
        normalizeStringList(allocation?.articleUnitIds, 1000, 120),
      );
      const rechargeArticleUnitIds =
        refundedArticleUnitIds.size > 0
          ? originalContainer.articleUnitIds.filter(
              (unitId) => !refundedArticleUnitIds.has(unitId),
            )
          : originalContainer.articleUnitIds;
      const basePaymentRefs = {
        tableId: originalContainer.tableId || order.tableId || null,
        tableNumber: originalContainer.tableNumber ?? tableNumber,
        tableLabel: originalContainer.tableLabel || tableLabel || null,
        roomId: originalContainer.roomId || roomId || null,
        orderId: originalContainer.orderId || order.id || null,
        orderIds: originalContainer.orderIds?.length
          ? originalContainer.orderIds
          : [order.id].filter(Boolean),
        billId: originalContainer.billId || null,
        billIds: originalContainer.billIds || [],
      };
      const paymentContainer = sanitizePaymentContainerRecord(
        {
          id: paymentId,
          ...basePaymentRefs,
          createdByUserId: user.id,
          createdByUsername: user.username,
          collectedByUserId: user.id,
          collectedByUsername: user.username,
          collectedByDeviceUuid: session.deviceUuid,
          paymentMethod,
          amount: rechargeAmount,
          note,
          createdAt,
          status: "COMPLETED",
          splitType: originalContainer.splitType,
          splitMode: originalContainer.splitMode,
          articleUnitIds: rechargeArticleUnitIds,
          adjustmentKind: "pos_recharge_after_full_void",
          originalPaymentId,
          supersedesPaymentId: originalPaymentId,
          rechargeAmount,
          idempotencyKey: compId
            ? `${compId}:recharge:${originalPaymentId}`
            : null,
        },
        paymentId,
      );
      const paymentPart = sanitizePaymentPartRecord(
        {
          id: partId,
          paymentId,
          partNo: 1,
          amountDue: rechargeAmount,
          status: "PAID",
        },
        partId,
      );
      const firstOriginalTx = Array.isArray(allocation?.transactions)
        ? allocation.transactions[0]
        : null;
      const paymentTx = sanitizePaymentTransactionRecord(
        {
          id: txId,
          partId,
          createdByUserId: user.id,
          createdByUsername: user.username,
          createdAt,
          method: methodType,
          amountPaid: rechargeAmount,
          posProvider: firstOriginalTx?.posProvider || methodLabel,
          posTxRef: null,
          note,
        },
        txId,
      );
      if (!paymentContainer || !paymentPart || !paymentTx) continue;

      db.paymentContainers[originalIndex] = {
        ...db.paymentContainers[originalIndex],
        supersededByPaymentId: paymentId,
        supersededByCompId: compId || null,
        supersededByStornoId: compId || null,
        supersededAt: createdAt,
        voidedAmount: voidAmount,
        rechargeAmount,
      };
      db.paymentContainers.push(paymentContainer);
      db.paymentParts.push(paymentPart);
      db.paymentTransactions.push(paymentTx);

      const legacyPayment = sanitizePaymentRecord(
        {
          id: paymentId,
          ...basePaymentRefs,
          tableCovers: order.covers,
          amount: rechargeAmount,
          note,
          methodId: paymentMethod,
          methodLabel,
          fiscal: false,
          source: "pos_recharge_after_storno",
          createdAt,
          createdByUserId: user.id,
          createdByUsername: user.username,
          collectedByUserId: user.id,
          collectedByUsername: user.username,
          collectedByDeviceUuid: session.deviceUuid,
          paymentContainerId: paymentContainer.id,
          paymentPartId: paymentPart.id,
          paymentTxId: paymentTx.id,
          idempotencyKey: compId
            ? `${compId}:legacy-recharge:${originalPaymentId}`
            : null,
          items: [],
        },
        paymentId,
      );
      if (legacyPayment) db.payments.push(legacyPayment);

      const rechargePrintPayload = {
        kind: "payment",
        orderId: paymentContainer.id,
        roomId,
        station: PRIMARY_INTEGRATION_STATION,
        fallbackStation: PRIMARY_INTEGRATION_STATION,
        text: buildMobileElectronicPaymentPrintText(
          {
            waiter: waiterName,
            tableNumber,
            tableLabel,
            roomName,
            orderReference: order.id
              ? `COMANDA ${formatIntegrationPrintOrderId(order.id)}`
              : "COMANDA #-",
            amount: rechargeAmount,
            methodType,
            methodLabel,
            transactionId: txId,
            note,
            createdAtMs: parseTimestampMs(createdAt, Date.now()),
          },
          settings.printPreferences?.order,
        ),
        printPreferences: settings.printPreferences,
        clientApp: session.clientApp,
        userId: user.id,
        deviceUuid: session.deviceUuid,
      };

      adjustment.rechargeAmount = roundMoney(
        adjustment.rechargeAmount + rechargeAmount,
      );
      adjustment.rechargePaymentIds.push(paymentContainer.id);
      adjustment.rechargeTransactionIds.push(paymentTx.id);
      adjustment.rechargePrintPayloads.push(rechargePrintPayload);
      adjustment.mutationSummary.supersededPaymentIds.push(originalPaymentId);
      adjustment.mutationSummary.createdPaymentIds.push(paymentContainer.id);
      adjustment.mutationSummary.createdPaymentPartIds.push(paymentPart.id);
      adjustment.mutationSummary.createdPaymentTransactionIds.push(paymentTx.id);
      if (legacyPayment) {
        adjustment.mutationSummary.createdLegacyPaymentIds.push(
          legacyPayment.id,
        );
      }
    }

    return adjustment;
  }

  async function appendPaymentStornoPrintJobToDb(db, options = {}) {
    const settings = sanitizePosSettings(options?.settings ?? db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const compRecord =
      options?.compRecord && typeof options.compRecord === "object"
        ? options.compRecord
        : {};
    const order =
      options?.order && typeof options.order === "object" ? options.order : {};
    const line =
      options?.line && typeof options.line === "object" ? options.line : {};
    const roomId = String(
      options?.roomId ?? compRecord.roomId ?? order.roomId ?? "",
    ).trim();
    const roomName = resolvePrintRoomLabel(
      settings,
      roomId,
      options?.roomName ?? "",
    );
    const tableNumber = Number.isFinite(
      Number(compRecord.tableNumber ?? order.tableNumber),
    )
      ? Math.trunc(Number(compRecord.tableNumber ?? order.tableNumber))
      : 0;
    return appendPrintSpoolJobToDb(db, {
      kind: "payment_storno",
      orderId: compRecord.id || order.id || "storno",
      roomId,
      station: PRIMARY_INTEGRATION_STATION,
      fallbackStation: PRIMARY_INTEGRATION_STATION,
      userId: options?.user?.id,
      deviceUuid: options?.session?.deviceUuid,
      clientApp: options?.session?.clientApp,
      text: buildMobilePaymentStornoPrintText(
        {
          stornoId: compRecord.id,
          waiter:
            options?.user?.fullName ?? options?.user?.username ?? order.waiter,
          tableNumber,
          tableLabel: compRecord.tableLabel ?? order.tableLabel,
          roomName,
          orderReference: `COMANDA #${String(order.id ?? compRecord.orderId ?? "").trim() || "-"}`,
          amount: compRecord.amount,
          quantity: compRecord.quantity,
          productName: compRecord.productName ?? line.productName,
          reason: compRecord.reason,
          paymentReferences: options?.paymentReferences,
          refundPlan: compRecord.refundPlan,
          createdAtMs: parseTimestampMs(compRecord.createdAt, Date.now()),
        },
        settings.printPreferences?.order,
      ),
      printPreferences: settings.printPreferences,
    });
  }

  return {
    appendPaymentStornoPrintJobToDb,
    applyOrderCompPaymentAdjustmentsForRefundPlan,
    buildOrderCompRefundPlan,
    buildPaymentReferencesFromRefundPlan,
    isSupersededPaymentContainer,
    resolveOrderCompPaymentReferences,
  };
}
