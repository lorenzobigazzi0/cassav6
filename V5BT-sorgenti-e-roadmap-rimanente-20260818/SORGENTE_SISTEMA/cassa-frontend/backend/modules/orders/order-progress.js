export function markIntegrationOrderItemsReady(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const qty = Math.max(Math.trunc(Number(item?.qty) || 0), 0);
    const doneQty = Math.max(Math.trunc(Number(item?.doneQty) || 0), 0);
    return {
      ...item,
      done: true,
      doneQty: qty > 0 ? Math.max(doneQty, qty) : doneQty,
    };
  });
}

export function buildIntegrationItemProgressAuditSnapshot(order) {
  return (Array.isArray(order?.items) ? order.items : []).map((item, index) => ({
    id: String(item?.id ?? `item_${index + 1}`).trim(),
    lineId: String(item?.lineId ?? "").trim(),
    qty: Math.max(Math.trunc(Number(item?.qty) || 0), 0),
    done: item?.done === true,
    doneQty: Math.max(Math.trunc(Number(item?.doneQty) || 0), 0),
    voided: Boolean(item?.voidedAt),
  }));
}

function hasDifferentProgressField(previousItem, nextItem, index) {
  return (
    String(previousItem?.id ?? `item_${index + 1}`).trim() !==
      String(nextItem?.id ?? `item_${index + 1}`).trim() ||
    String(previousItem?.lineId ?? "").trim() !==
      String(nextItem?.lineId ?? "").trim() ||
    Math.max(Math.trunc(Number(previousItem?.qty) || 0), 0) !==
      Math.max(Math.trunc(Number(nextItem?.qty) || 0), 0) ||
    (previousItem?.done === true) !== (nextItem?.done === true) ||
    Math.max(Math.trunc(Number(previousItem?.doneQty) || 0), 0) !==
      Math.max(Math.trunc(Number(nextItem?.doneQty) || 0), 0) ||
    Boolean(previousItem?.voidedAt) !== Boolean(nextItem?.voidedAt)
  );
}

export function hasIntegrationItemProgressAuditChange(previousOrder, nextOrder) {
  const previousItems = Array.isArray(previousOrder?.items)
    ? previousOrder.items
    : [];
  const nextItems = Array.isArray(nextOrder?.items) ? nextOrder.items : [];
  if (previousItems.length !== nextItems.length) return true;
  for (let index = 0; index < previousItems.length; index += 1) {
    if (hasDifferentProgressField(previousItems[index], nextItems[index], index)) {
      return true;
    }
  }
  return false;
}
