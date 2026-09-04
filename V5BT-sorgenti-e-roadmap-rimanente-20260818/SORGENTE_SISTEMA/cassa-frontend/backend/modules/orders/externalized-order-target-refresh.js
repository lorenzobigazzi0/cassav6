export async function refreshExternalizedIntegrationOrderTarget(
  db,
  options = {},
  dependencies = {},
) {
  const orderId = String(
    options.refreshExternalizedIntegrationOrderId ?? "",
  ).trim();
  const repository = dependencies.repository;
  if (
    !orderId ||
    repository?.enabled !== true ||
    typeof repository.readObjectArrayEntry !== "function" ||
    !db ||
    typeof db !== "object"
  ) {
    return db;
  }

  const candidates = dependencies.buildLookupCandidates?.(orderId) ?? [orderId];
  let remoteOrder = null;
  for (const candidate of candidates) {
    remoteOrder = await repository.readObjectArrayEntry(
      "integration",
      "orders",
      candidate,
      null,
    );
    if (remoteOrder && typeof remoteOrder === "object") break;
  }
  if (!remoteOrder || typeof remoteOrder !== "object") {
    dependencies.incrementCounter?.("orderTargetRefreshMisses");
    return db;
  }

  if (!db.integration || typeof db.integration !== "object") {
    db.integration = dependencies.createDefaultIntegrationState?.() ?? {
      orders: [],
    };
  }
  const orders = Array.isArray(db.integration.orders)
    ? [...db.integration.orders]
    : [];
  const index = dependencies.findOrderIndex?.(orders, orderId) ?? -1;
  if (index >= 0) orders[index] = remoteOrder;
  else orders.push(remoteOrder);
  db.integration.orders = orders;
  dependencies.incrementCounter?.("orderTargetRefreshHits");
  return db;
}
