function orderId(order) {
  return String(order?.id ?? "").trim();
}

export function filterV6StationWorkflowCandidates(
  orders,
  {
    fallbackOrderId = "",
    eligibleOrderIds = null,
    reservedOrderIds = null,
  } = {},
) {
  const fallbackId = String(fallbackOrderId ?? "").trim();
  const hasEligibilityInventory = eligibleOrderIds instanceof Set;
  const hasReservationLedger = reservedOrderIds instanceof Set;
  return (Array.isArray(orders) ? orders : []).filter((candidate) => {
    const candidateId = orderId(candidate);
    if (!candidateId) return false;
    if (
      hasEligibilityInventory &&
      candidateId !== fallbackId &&
      !eligibleOrderIds.has(candidateId)
    ) {
      return false;
    }
    return (
      !hasReservationLedger ||
      candidateId === fallbackId ||
      !reservedOrderIds.has(candidateId)
    );
  });
}

export function claimV6StationWorkflowTarget(target, reservedOrderIds) {
  const targetId = orderId(target);
  if (targetId && reservedOrderIds instanceof Set) {
    reservedOrderIds.add(targetId);
  }
  return targetId || null;
}
