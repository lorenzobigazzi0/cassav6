const READY_DUPLICATE_SYNC_STATUS_ONLY_FIELDS = new Set([
  "id",
  "orderId",
  "ownerStation",
  "station",
  "workflowStatus",
]);

export function isStatusOnlyReadyDuplicateOrderSync(rawOrder) {
  if (!rawOrder || typeof rawOrder !== "object" || Array.isArray(rawOrder)) return false;
  const keys = Object.keys(rawOrder);
  return (
    keys.includes("workflowStatus") &&
    keys.every((key) => READY_DUPLICATE_SYNC_STATUS_ONLY_FIELDS.has(key))
  );
}

export function isTerminalDuplicateOrderSyncNoop(currentOrder, requestedWorkflowStatus, rawOrder) {
  if (!currentOrder || typeof currentOrder !== "object") return false;
  if (currentOrder.workflowStatus === "delivered" && ["ready", "delivered"].includes(requestedWorkflowStatus)) return true;
  return (
    currentOrder.workflowStatus === "ready" &&
    requestedWorkflowStatus === "ready" &&
    isStatusOnlyReadyDuplicateOrderSync(rawOrder)
  );
}

export async function tryHandleTerminalDuplicateOrderSyncPreLane(req, res, pathname, options = {}) {
  const skip = (reason) => { options.runtimeMetrics?.recordOperation?.("orderWorkflow", `terminalDuplicatePreLane.skip.${reason}`, 0); return false; };
  if (String(req?.method ?? "").trim().toUpperCase() !== "POST") return skip("method");
  if (String(pathname ?? "").trim() !== "/api/integration/orders/sync") return skip("path");
  const payload = req?.__jsonBodyPayload && typeof req.__jsonBodyPayload === "object" ? req.__jsonBodyPayload : {};
  const rawOrder = payload.order && typeof payload.order === "object" ? payload.order : null;
  const id = String(payload.id ?? payload.orderId ?? rawOrder?.id ?? rawOrder?.orderId ?? "").trim();
  if (!id || !rawOrder) return skip("payload");
  const requestedWorkflowStatus = options.normalizeIntegrationWorkflowStatus?.(rawOrder.workflowStatus, [], null, { lineRoutes: [], ownerStation: rawOrder.ownerStation });
  if (!["ready", "delivered"].includes(requestedWorkflowStatus)) return skip("workflow");
  if (!isStatusOnlyReadyDuplicateOrderSync(rawOrder)) return skip("fullPayload");
  try {
    // Con write-primary relazionale l'ordine arriva da readRelationalOrderById e
    // con MySQL split il solo ordine target viene riletto dal dominio condiviso.
    // Il reload completo resta come fallback per gli storage legacy.
    const db = await options.readDb?.(
      options.relationalSyncWritePrimary === true
        ? { refreshExternalizedSessions: true }
        : options.appStateOrderTargetedRefresh === true
          ? {
              refreshExternalizedSessions: true,
              refreshExternalizedIntegrationOrderId: id,
            }
          : { forceReload: true, refreshExternalizedSessions: true },
    );
    const authPayload = options.mergeRequestAuthPayload?.(req, payload) ?? payload;
    if (req?.__authContext && typeof req.__authContext === "object") {
      // Gia validato dalla policy route: non rivalidare contro uno snapshot locale.
    } else {
      options.validateSessionContext?.(db, authPayload);
    }
    let storedOrder = null;
    let source = "appState";
    if (options.relationalSyncWritePrimary === true) {
      if (typeof options.readRelationalOrderById !== "function") return skip("relationalReader");
      storedOrder = await options.readRelationalOrderById(id);
      source = "relational";
    } else {
      if (!db?.integration || typeof db.integration !== "object") return skip("integration");
      const orderIndex = options.findIntegrationOrderIndexByLookup?.(db.integration.orders, id) ?? -1;
      if (orderIndex < 0) return skip("missing");
      storedOrder = db.integration.orders[orderIndex];
    }
    if (!storedOrder) return skip(`${source}Missing`);
    const currentOrder = options.sanitizeIntegrationOrder?.(storedOrder, String(storedOrder?.id ?? id).trim() || id) ?? storedOrder;
    if (!currentOrder || options.isIntegrationOrderCancelled?.(currentOrder) || !isTerminalDuplicateOrderSyncNoop(currentOrder, requestedWorkflowStatus, rawOrder)) return skip("current");
    options.runtimeMetrics?.incrementCounter?.("orderTerminalDuplicateSyncNoops");
    options.runtimeMetrics?.incrementCounter?.("orderTerminalDuplicateSyncPreLaneNoops");
    if (source === "relational") options.runtimeMetrics?.incrementCounter?.("orderTerminalDuplicateSyncRelationalPreLaneNoops");
    options.orderLaneMetricLabeler?.rememberOrder?.(currentOrder);
    options.applyCors?.(req, res);
    options.sendJson?.(res, 200, { ok: true, idempotent: true, noop: true, preLane: true, source, order: currentOrder, selectionHandoffDemotions: [] });
    return true;
  } catch {
    return skip("error");
  }
}
