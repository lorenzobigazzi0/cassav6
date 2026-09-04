export function collectPosBillOrderIds(bill) {
  const directOrderId = String(bill?.orderId ?? "").trim();
  return [...new Set(
    [directOrderId, ...(Array.isArray(bill?.orderIds) ? bill.orderIds : [])]
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean)
  )];
}

export function collectOrderIdsFromBills(bills) {
  return [...new Set(
    (Array.isArray(bills) ? bills : [])
      .flatMap((bill) => collectPosBillOrderIds(bill))
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean)
  )];
}

export function collectOrderIdsFromSelectedBills(allBills, selectedBillIds) {
  const selected = new Set(
    (selectedBillIds instanceof Set ? [...selectedBillIds] : Array.isArray(selectedBillIds) ? selectedBillIds : [])
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean)
  );
  return collectOrderIdsFromBills(
    (Array.isArray(allBills) ? allBills : []).filter((bill) => selected.has(String(bill?.id ?? "").trim()))
  );
}

export function collectOrderIdsFromLineSelections(allBills, lineSelections) {
  const selectedBillIds = [
    ...new Set(
      (Array.isArray(lineSelections) ? lineSelections : [])
        .map((entry) => String(entry?.billId ?? "").trim())
        .filter(Boolean)
    ),
  ];
  return collectOrderIdsFromSelectedBills(allBills, selectedBillIds);
}

export function normalizePaymentOrderIdList(orderIds, tableId = "") {
  const safeTableId = String(tableId ?? "").trim();
  return [...new Set(
    (Array.isArray(orderIds) ? orderIds : [])
      .map((entry) => String(entry ?? "").trim())
      .filter((entry) => entry && entry !== safeTableId)
  )];
}

export function resolvePaymentOrderRefs({
  tableBills,
  selectedBillIds,
  lineSelections,
  targetOrderId,
  tableId,
} = {}) {
  const safeTableId = String(tableId ?? "").trim();
  const explicitOrderId = String(targetOrderId ?? "").trim();
  let orderIds = [];
  if (explicitOrderId && explicitOrderId !== safeTableId) {
    orderIds = [explicitOrderId];
  } else if (Array.isArray(lineSelections) && lineSelections.length > 0) {
    orderIds = collectOrderIdsFromLineSelections(tableBills, lineSelections);
  } else if (
    selectedBillIds instanceof Set
      ? selectedBillIds.size > 0
      : Array.isArray(selectedBillIds) && selectedBillIds.length > 0
  ) {
    orderIds = collectOrderIdsFromSelectedBills(tableBills, selectedBillIds);
  } else {
    orderIds = collectOrderIdsFromBills(tableBills);
  }
  orderIds = normalizePaymentOrderIdList(orderIds, safeTableId);

  const billIds = [
    ...new Set(
      [
        ...(selectedBillIds instanceof Set ? [...selectedBillIds] : Array.isArray(selectedBillIds) ? selectedBillIds : []),
        ...(Array.isArray(lineSelections) ? lineSelections.map((entry) => entry?.billId) : []),
      ]
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
    ),
  ];

  return {
    tableId: safeTableId || null,
    orderId: orderIds.length === 1 ? orderIds[0] : null,
    orderIds,
    billId: billIds.length === 1 ? billIds[0] : null,
    billIds,
  };
}
