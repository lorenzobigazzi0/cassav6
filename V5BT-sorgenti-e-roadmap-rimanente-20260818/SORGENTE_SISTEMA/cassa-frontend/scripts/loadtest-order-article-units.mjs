function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeStringSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean),
  );
}

export function resolveRefreshedOrder(currentOrder, response) {
  const refreshedOrder = response?.body?.orders?.[0] ?? null;
  if (response?.status === 404 || response?.status === 200) {
    return refreshedOrder;
  }
  return refreshedOrder || currentOrder;
}

export function isStalePaymentArticleSelectionResponse(response) {
  const error = String(response?.body?.error ?? response?.error ?? "").trim().toLowerCase();
  return (
    Number(response?.status) === 400 &&
    error.includes("articolo selezionato non appartenente al tavolo")
  );
}

export function enumerateOrderArticleUnits(order) {
  const orderId = String(order?.id ?? "").trim();
  if (!orderId) return [];

  const units = [];
  const lineIndexByLineId = new Map();
  const nextUnitIndexByLineIndex = new Map();
  const resolveLineIndex = (item, fallbackIndex) => {
    const lineId = String(item?.lineId ?? "").trim();
    if (!lineId) return fallbackIndex;
    if (!lineIndexByLineId.has(lineId)) {
      lineIndexByLineId.set(lineId, lineIndexByLineId.size);
    }
    return lineIndexByLineId.get(lineId);
  };

  (Array.isArray(order?.items) ? order.items : []).forEach((item, itemIndex) => {
    if (!item || item.voidedAt) return;
    const qtyRaw = Number(item.qty);
    const qty = Number.isFinite(qtyRaw) ? Math.max(Math.trunc(qtyRaw), 1) : 1;
    const unitPriceCandidate =
      item.priceOverrideApplied === true && Number.isFinite(Number(item.unitPriceApplied))
        ? Number(item.unitPriceApplied)
        : Number(item.unitPriceApplied) > 0
          ? Number(item.unitPriceApplied)
          : Number(item.listPriceAtTime) > 0
            ? Number(item.listPriceAtTime)
            : Number(item.lineTotal) > 0
              ? Number(item.lineTotal) / qty
              : 0;
    const unitPrice = roundMoney(Math.max(unitPriceCandidate, 0));
    const lineTotal = roundMoney(
      Math.max(
        item.priceOverrideApplied === true
          ? Number(item.lineTotal) || 0
          : Number(item.lineTotal) || unitPrice * qty,
        0,
      ),
    );
    const lineIndex = resolveLineIndex(item, itemIndex);
    const startUnitIndex = nextUnitIndexByLineIndex.get(lineIndex) ?? 0;
    nextUnitIndexByLineIndex.set(lineIndex, startUnitIndex + qty);
    const lineTotalCents = Math.max(Math.round(lineTotal * 100), 0);
    const baseUnitTotalCents = Math.floor(lineTotalCents / qty);
    let extraUnitTotalCents = lineTotalCents - baseUnitTotalCents * qty;

    for (let unitOffset = 0; unitOffset < qty; unitOffset += 1) {
      const unitIndex = startUnitIndex + unitOffset;
      const amountCents = baseUnitTotalCents + (extraUnitTotalCents > 0 ? 1 : 0);
      if (extraUnitTotalCents > 0) extraUnitTotalCents -= 1;
      units.push({
        unitId: `${orderId}_${lineIndex}_${unitIndex}`,
        amount: roundMoney(amountCents / 100),
        amountCents,
        orderId,
        lineIndex,
        unitIndex,
      });
    }
  });

  return units;
}

export function firstPayableOrderArticleUnit(order) {
  if (String(order?.paymentStatus ?? "").trim().toLowerCase() === "paid") {
    return null;
  }
  const paidUnitIds = normalizeStringSet(order?.paidArticleUnits);
  return (
    enumerateOrderArticleUnits(order).find(
      (unit) => unit.amountCents > 0 && !paidUnitIds.has(unit.unitId),
    ) ?? null
  );
}
