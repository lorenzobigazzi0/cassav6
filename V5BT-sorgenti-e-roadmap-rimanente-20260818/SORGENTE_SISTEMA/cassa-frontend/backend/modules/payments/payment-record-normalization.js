export function createPaymentRecordNormalization(dependencies = {}) {
  const {
    CASH_DENOM_DIRECTIONS,
    PAYMENT_CONTAINER_STATUSES,
    PAYMENT_METHOD_TYPES,
    PAYMENT_PART_STATUSES,
    clampInt,
    cloneJson,
    normalizePaymentContinuationSplitMode,
    normalizePaymentOrderIdList,
    normalizePaymentSplitType,
    normalizeStringList,
    nowIso,
    roundMoney,
    sanitizePaymentAdminAdjustmentRecord,
  } = dependencies;

  function normalizePaymentContainerStatus(value) {
    const candidate = String(value ?? "OPEN")
      .trim()
      .toUpperCase();
    return PAYMENT_CONTAINER_STATUSES.has(candidate) ? candidate : "OPEN";
  }

  function normalizePaymentPartStatus(value) {
    const candidate = String(value ?? "PENDING")
      .trim()
      .toUpperCase();
    return PAYMENT_PART_STATUSES.has(candidate) ? candidate : "PENDING";
  }

  function normalizePaymentMethodType(value) {
    const candidate = String(value ?? "")
      .trim()
      .toUpperCase();
    return PAYMENT_METHOD_TYPES.has(candidate) ? candidate : "OTHER";
  }

  function normalizeCashDenomDirection(value) {
    const candidate = String(value ?? "")
      .trim()
      .toUpperCase();
    return CASH_DENOM_DIRECTIONS.has(candidate) ? candidate : "IN";
  }

  function mapPaymentMethodToTransactionType(methodId, methodLabel) {
    const id = String(methodId ?? "")
      .trim()
      .toLowerCase();
    const label = String(methodLabel ?? "")
      .trim()
      .toLowerCase();
    if (id.includes("cash") || label.includes("contant")) return "CASH";
    if (
      id.includes("card") ||
      id.includes("pos") ||
      label.includes("carta") ||
      label.includes("pos")
    ) {
      return "POS";
    }
    return "OTHER";
  }

  function normalizeAutomaticCashPaymentOperationId(record) {
    const raw =
      record?.automaticCashPaymentOperationId ??
      record?.automaticCashOperationId ??
      record?.cashOperationId;
    const value = String(raw ?? "").trim();
    return value || null;
  }

  function normalizePaymentCollectionMetadata(record, methodType = null) {
    const normalizedMethod = methodType
      ? normalizePaymentMethodType(methodType)
      : null;
    const paymentSource = String(record?.paymentSource ?? "")
      .trim()
      .toLowerCase();
    const cashSource = String(record?.cashSource ?? "")
      .trim()
      .toLowerCase();
    const operationId = normalizeAutomaticCashPaymentOperationId(record);
    const isAutomaticCash =
      (normalizedMethod === null || normalizedMethod === "CASH") &&
      (paymentSource === "automatic_cash" ||
        paymentSource === "automatic-cash" ||
        cashSource === "automatic" ||
        Boolean(operationId));
    return {
      paymentSource: isAutomaticCash ? "automatic_cash" : null,
      cashSource: isAutomaticCash ? "automatic" : null,
      automaticCashPaymentOperationId: isAutomaticCash ? operationId : null,
    };
  }

  function sanitizePaymentContainerRecord(
    record,
    fallbackId = `payc_${Date.now()}`,
  ) {
    if (!record || typeof record !== "object") return null;
    const collectionMetadata = normalizePaymentCollectionMetadata(record);
    const createdByUserId =
      String(record.createdByUserId ?? "").trim() || "system";
    const tableId = record.tableId ? String(record.tableId).trim() : null;
    const orderIds = normalizePaymentOrderIdList(
      [
        record.orderId,
        ...(Array.isArray(record.orderIds) ? record.orderIds : []),
      ],
      tableId ?? "",
    );
    const splitMode = normalizePaymentContinuationSplitMode(record.splitMode);
    return {
      id: String(record.id ?? fallbackId),
      tableId,
      tableNumber: Number.isFinite(Number(record.tableNumber))
        ? Math.max(Math.trunc(Number(record.tableNumber)), 0)
        : null,
      tableLabel: record.tableLabel ? String(record.tableLabel).trim() : null,
      orderId: orderIds.length === 1 ? orderIds[0] : null,
      orderIds,
      billId: record.billId ? String(record.billId).trim() : null,
      billIds: [
        ...new Set(
          (Array.isArray(record.billIds) ? record.billIds : [record.billId])
            .map((entry) => String(entry ?? "").trim())
            .filter(Boolean),
        ),
      ],
      roomId: record.roomId ? String(record.roomId) : null,
      createdByUserId,
      createdByUsername: String(record.createdByUsername ?? "system"),
      collectedByUserId: String(record.collectedByUserId ?? createdByUserId),
      collectedByUsername: String(
        record.collectedByUsername ?? record.createdByUsername ?? "system",
      ),
      collectedByDeviceUuid: record.collectedByDeviceUuid
        ? String(record.collectedByDeviceUuid).trim()
        : null,
      paymentMethod: record.paymentMethod
        ? String(record.paymentMethod).trim()
        : null,
      paymentSource: collectionMetadata.paymentSource,
      cashSource: collectionMetadata.cashSource,
      automaticCashPaymentOperationId:
        collectionMetadata.automaticCashPaymentOperationId,
      amount: Number.isFinite(Number(record.amount))
        ? roundMoney(Math.max(Number(record.amount), 0))
        : null,
      note:
        record.note || record.paymentNote
          ? String(record.note ?? record.paymentNote)
              .trim()
              .slice(0, 240) || null
          : null,
      idempotencyKey: record.idempotencyKey
        ? String(record.idempotencyKey).trim()
        : null,
      clientPaymentId: record.clientPaymentId
        ? String(record.clientPaymentId).trim()
        : null,
      createdAt: String(record.createdAt ?? nowIso()),
      status: normalizePaymentContainerStatus(record.status),
      splitType: normalizePaymentSplitType(record.splitType),
      ...(splitMode ? { splitMode } : {}),
      fiscalDocType: record.fiscalDocType
        ? String(record.fiscalDocType).trim().toUpperCase()
        : null,
      fiscalDocNo: record.fiscalDocNo ? String(record.fiscalDocNo) : null,
      fiscalIssuedAt: record.fiscalIssuedAt
        ? String(record.fiscalIssuedAt)
        : null,
      fiscalIssuedBy: record.fiscalIssuedBy
        ? String(record.fiscalIssuedBy)
        : null,
      fiscalVoidStatus: record.fiscalVoidStatus
        ? String(record.fiscalVoidStatus).trim().toUpperCase()
        : null,
      fiscalVoidedAt: record.fiscalVoidedAt
        ? String(record.fiscalVoidedAt).trim()
        : null,
      fiscalVoidedByUserId: record.fiscalVoidedByUserId
        ? String(record.fiscalVoidedByUserId).trim()
        : null,
      articleUnitIds: normalizeStringList(record.articleUnitIds, 1000, 120),
      adjustmentKind: record.adjustmentKind
        ? String(record.adjustmentKind).trim()
        : null,
      adminAdjustment: sanitizePaymentAdminAdjustmentRecord(
        record.adminAdjustment,
      ),
      originalPaymentId: record.originalPaymentId
        ? String(record.originalPaymentId).trim()
        : null,
      commercialBenefitApplicationIds: normalizeStringList(
        record.commercialBenefitApplicationIds,
        100,
        120,
      ),
      commercialBenefitAmountCents: Math.max(
        Math.trunc(Number(record.commercialBenefitAmountCents) || 0),
        0,
      ),
      commercialBenefitAmount: Number.isFinite(
        Number(record.commercialBenefitAmount),
      )
        ? roundMoney(Math.max(Number(record.commercialBenefitAmount), 0))
        : 0,
      supersedesPaymentId: record.supersedesPaymentId
        ? String(record.supersedesPaymentId).trim()
        : null,
      supersededByPaymentId: record.supersededByPaymentId
        ? String(record.supersededByPaymentId).trim()
        : null,
      supersededByCompId: record.supersededByCompId
        ? String(record.supersededByCompId).trim()
        : null,
      supersededByStornoId: record.supersededByStornoId
        ? String(record.supersededByStornoId).trim()
        : null,
      supersededAt: record.supersededAt
        ? String(record.supersededAt).trim()
        : null,
      tableCancellationId: record.tableCancellationId
        ? String(record.tableCancellationId).trim()
        : null,
      tableCancelledAt: record.tableCancelledAt
        ? String(record.tableCancelledAt).trim()
        : null,
      tableCancelledByUserId: record.tableCancelledByUserId
        ? String(record.tableCancelledByUserId).trim()
        : null,
      tableCancelledByUsername: record.tableCancelledByUsername
        ? String(record.tableCancelledByUsername).trim()
        : null,
      tableCancellationReason: record.tableCancellationReason
        ? String(record.tableCancellationReason).trim().slice(0, 240)
        : null,
      voidedAmount:
        Number.isFinite(Number(record.voidedAmount)) &&
        Number(record.voidedAmount) >= 0
          ? roundMoney(Math.max(Number(record.voidedAmount), 0))
          : null,
      rechargeAmount:
        Number.isFinite(Number(record.rechargeAmount)) &&
        Number(record.rechargeAmount) >= 0
          ? roundMoney(Math.max(Number(record.rechargeAmount), 0))
          : null,
    };
  }

  function sanitizePaymentPartRecord(
    record,
    fallbackId = `part_${Date.now()}`,
  ) {
    if (!record || typeof record !== "object") return null;
    const amountDue = Number(record.amountDue);
    if (!Number.isFinite(amountDue) || amountDue < 0) return null;
    return {
      id: String(record.id ?? fallbackId),
      paymentId: String(record.paymentId ?? "").trim(),
      partNo: clampInt(record.partNo, 1, 999_999, 1),
      amountDue: roundMoney(Math.max(amountDue, 0)),
      status: normalizePaymentPartStatus(record.status),
    };
  }

  function sanitizePaymentTransactionRecord(
    record,
    fallbackId = `tx_${Date.now()}`,
  ) {
    if (!record || typeof record !== "object") return null;
    const amountPaid = Number(record.amountPaid);
    if (!Number.isFinite(amountPaid) || amountPaid <= 0) return null;
    const method = normalizePaymentMethodType(record.method);
    const collectionMetadata = normalizePaymentCollectionMetadata(
      record,
      method,
    );
    const cashGivenRaw = Number(record.cashGiven);
    const changeGivenRaw = Number(record.changeGiven);
    return {
      id: String(record.id ?? fallbackId),
      partId: String(record.partId ?? "").trim(),
      createdByUserId: String(record.createdByUserId ?? "system"),
      createdByUsername: String(record.createdByUsername ?? "system"),
      createdAt: String(record.createdAt ?? nowIso()),
      method,
      paymentSource: collectionMetadata.paymentSource,
      cashSource: collectionMetadata.cashSource,
      automaticCashPaymentOperationId:
        collectionMetadata.automaticCashPaymentOperationId,
      amountPaid: roundMoney(Math.max(amountPaid, 0)),
      cashGiven:
        Number.isFinite(cashGivenRaw) && cashGivenRaw >= 0
          ? roundMoney(Math.max(cashGivenRaw, 0))
          : null,
      changeGiven:
        Number.isFinite(changeGivenRaw) && changeGivenRaw >= 0
          ? roundMoney(Math.max(changeGivenRaw, 0))
          : null,
      posProvider: record.posProvider ? String(record.posProvider) : null,
      posTxRef: record.posTxRef ? String(record.posTxRef) : null,
      refundedTxId: record.refundedTxId ? String(record.refundedTxId) : null,
      refundedAt: record.refundedAt ? String(record.refundedAt) : null,
      refundedBy: record.refundedBy ? String(record.refundedBy) : null,
      refundReason: record.refundReason
        ? String(record.refundReason).slice(0, 240)
        : null,
      note:
        record.note || record.paymentNote
          ? String(record.note ?? record.paymentNote)
              .trim()
              .slice(0, 240) || null
          : null,
    };
  }

  function sanitizeCashTxDenomRecord(
    record,
    fallbackId = `denom_${Date.now()}`,
  ) {
    if (!record || typeof record !== "object") return null;
    const txId = String(record.txId ?? "").trim();
    if (!txId) return null;
    const denomCents = clampInt(record.denomCents, 1, 1_000_000, 0);
    const qty = clampInt(record.qty, 1, 1_000_000, 0);
    if (denomCents <= 0 || qty <= 0) return null;
    return {
      id: String(record.id ?? fallbackId),
      txId,
      direction: normalizeCashDenomDirection(record.direction),
      denomCents,
      qty,
    };
  }

  function ensurePaymentTrackingArrays(db) {
    if (!Array.isArray(db.paymentContainers)) db.paymentContainers = [];
    if (!Array.isArray(db.paymentParts)) db.paymentParts = [];
    if (!Array.isArray(db.paymentTransactions)) db.paymentTransactions = [];
    if (!Array.isArray(db.cashTxDenoms)) db.cashTxDenoms = [];
  }

  function sanitizePaymentItem(item) {
    if (!item || typeof item !== "object") return null;
    const name = String(item.name ?? "").trim();
    const qtyRaw = Number(item.qty);
    const qty = Number.isFinite(qtyRaw) ? Math.max(Math.trunc(qtyRaw), 0) : 0;
    const unitPriceRaw = Number(item.unitPrice);
    const unitPrice = Number.isFinite(unitPriceRaw)
      ? roundMoney(Math.max(unitPriceRaw, 0))
      : 0;
    const variantPriceRaw = Number(
      item.variantPrice ?? item.selectedVariant?.price ?? item.variant?.price,
    );
    const variantPrice =
      Number.isFinite(variantPriceRaw) && variantPriceRaw >= 0
        ? roundMoney(variantPriceRaw)
        : null;
    const unitPriceAppliedRaw = Number(item.unitPriceApplied);
    const unitPriceApplied =
      variantPrice !== null
        ? variantPrice
        : Number.isFinite(unitPriceAppliedRaw) && unitPriceAppliedRaw >= 0
          ? roundMoney(Math.max(unitPriceAppliedRaw, 0))
          : unitPrice;
    const lineTotalRaw = Number(item.lineTotal);
    const lineTotal = Number.isFinite(lineTotalRaw)
      ? roundMoney(Math.max(lineTotalRaw, 0))
      : roundMoney(unitPriceApplied * qty);
    if (!name || qty <= 0 || lineTotal <= 0) return null;
    const vatRateRaw = Number(item.vatRate ?? item.iva ?? item.taxRate);
    const vatRate =
      Number.isFinite(vatRateRaw) && vatRateRaw >= 0 && vatRateRaw <= 100
        ? Math.round(vatRateRaw * 1000) / 1000
        : null;
    const vatCode = String(item.vatCode ?? item.ivaCode ?? item.taxCode ?? "")
      .trim()
      .slice(0, 40);
    return {
      name,
      qty,
      unitPrice,
      unitPriceApplied,
      listPriceAtTime:
        Number.isFinite(Number(item.listPriceAtTime)) &&
        Number(item.listPriceAtTime) >= 0
          ? roundMoney(Math.max(Number(item.listPriceAtTime), 0))
          : unitPrice,
      lineTotal,
      description: item.description ? String(item.description) : undefined,
      variant: item.variant ? String(item.variant) : undefined,
      variantId: item.variantId ? String(item.variantId).trim() : undefined,
      variantName:
        item.variantName || item.selectedVariant?.name
          ? String(item.variantName ?? item.selectedVariant?.name).trim()
          : undefined,
      variantPrice: variantPrice !== null ? variantPrice : undefined,
      note: item.note ? String(item.note) : undefined,
      productId: item.productId ? String(item.productId) : undefined,
      lineId: item.lineId ? String(item.lineId) : undefined,
      vatRate: vatRate !== null ? vatRate : undefined,
      vatCode: vatCode || undefined,
      articleUnitIds: normalizeStringList(item.articleUnitIds, 1000, 120),
      variants:
        item.variants && typeof item.variants === "object"
          ? cloneJson(item.variants, {})
          : undefined,
      allergens: Array.isArray(item.allergens)
        ? normalizeStringList(item.allergens, 20, 80)
        : undefined,
    };
  }

  function sanitizePaymentRecord(record, fallbackId) {
    if (!record || typeof record !== "object") return null;
    const amount = Number(record.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const collectionMetadata = normalizePaymentCollectionMetadata(record);
    const items = (Array.isArray(record.items) ? record.items : [])
      .map((item) => sanitizePaymentItem(item))
      .filter((item) => item !== null);
    const tableCoversRaw = Number(record.tableCovers);
    const tableCovers = Number.isFinite(tableCoversRaw)
      ? Math.max(Math.trunc(tableCoversRaw), 0)
      : null;
    const tableId = record.tableId ? String(record.tableId).trim() : null;
    const orderIds = normalizePaymentOrderIdList(
      [
        record.orderId,
        ...(Array.isArray(record.orderIds) ? record.orderIds : []),
      ],
      tableId ?? "",
    );
    return {
      id: String(record.id ?? fallbackId),
      tableId,
      tableNumber: Number.isFinite(Number(record.tableNumber))
        ? Math.max(Math.trunc(Number(record.tableNumber)), 0)
        : null,
      tableLabel: record.tableLabel ? String(record.tableLabel).trim() : null,
      roomId: record.roomId ? String(record.roomId).trim() : null,
      orderId: orderIds.length === 1 ? orderIds[0] : null,
      orderIds,
      billId: record.billId ? String(record.billId).trim() : null,
      billIds: [
        ...new Set(
          (Array.isArray(record.billIds) ? record.billIds : [record.billId])
            .map((entry) => String(entry ?? "").trim())
            .filter(Boolean),
        ),
      ],
      tableCovers,
      amount: roundMoney(Math.max(amount, 0)),
      note:
        record.note || record.paymentNote
          ? String(record.note ?? record.paymentNote)
              .trim()
              .slice(0, 240) || null
          : null,
      methodId: String(record.methodId ?? "pay_cash"),
      methodLabel: String(record.methodLabel ?? "Contanti"),
      paymentSource: collectionMetadata.paymentSource,
      cashSource: collectionMetadata.cashSource,
      automaticCashPaymentOperationId:
        collectionMetadata.automaticCashPaymentOperationId,
      fiscal: record.fiscal !== false,
      source: String(record.source ?? "table_payment"),
      customerId: record.customerId ? String(record.customerId) : null,
      createdAt: String(record.createdAt ?? nowIso()),
      createdByUserId: String(record.createdByUserId ?? "system"),
      createdByUsername: String(record.createdByUsername ?? "system"),
      collectedByUserId: String(
        record.collectedByUserId ?? record.createdByUserId ?? "system",
      ),
      collectedByUsername: String(
        record.collectedByUsername ?? record.createdByUsername ?? "system",
      ),
      collectedByDeviceUuid: record.collectedByDeviceUuid
        ? String(record.collectedByDeviceUuid).trim()
        : null,
      idempotencyKey: record.idempotencyKey
        ? String(record.idempotencyKey).trim()
        : null,
      clientPaymentId: record.clientPaymentId
        ? String(record.clientPaymentId).trim()
        : null,
      adjustmentKind: record.adjustmentKind
        ? String(record.adjustmentKind).trim()
        : null,
      adminAdjustment: sanitizePaymentAdminAdjustmentRecord(
        record.adminAdjustment,
      ),
      receiptId: record.receiptId ? String(record.receiptId) : null,
      paymentContainerId: record.paymentContainerId
        ? String(record.paymentContainerId)
        : null,
      paymentPartId: record.paymentPartId ? String(record.paymentPartId) : null,
      paymentTxId: record.paymentTxId ? String(record.paymentTxId) : null,
      tableCancellationId: record.tableCancellationId
        ? String(record.tableCancellationId).trim()
        : null,
      tableCancelledAt: record.tableCancelledAt
        ? String(record.tableCancelledAt).trim()
        : null,
      tableCancelledByUserId: record.tableCancelledByUserId
        ? String(record.tableCancelledByUserId).trim()
        : null,
      tableCancelledByUsername: record.tableCancelledByUsername
        ? String(record.tableCancelledByUsername).trim()
        : null,
      tableCancellationReason: record.tableCancellationReason
        ? String(record.tableCancellationReason).trim().slice(0, 240)
        : null,
      changeGiven:
        Number.isFinite(Number(record.changeGiven)) &&
        Number(record.changeGiven) >= 0
          ? roundMoney(Math.max(Number(record.changeGiven), 0))
          : null,
      items,
    };
  }

  return {
    ensurePaymentTrackingArrays,
    mapPaymentMethodToTransactionType,
    normalizeAutomaticCashPaymentOperationId,
    normalizeCashDenomDirection,
    normalizePaymentCollectionMetadata,
    normalizePaymentContainerStatus,
    normalizePaymentMethodType,
    normalizePaymentPartStatus,
    sanitizeCashTxDenomRecord,
    sanitizePaymentContainerRecord,
    sanitizePaymentItem,
    sanitizePaymentPartRecord,
    sanitizePaymentRecord,
    sanitizePaymentTransactionRecord,
  };
}
