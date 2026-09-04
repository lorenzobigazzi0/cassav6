/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createIntegrationOrderTransferRequestHandlers({
  HttpError,
  PRIMARY_INTEGRATION_STATION,
  REALTIME_BACKBONE_CONFIG,
  clampInt,
  createDefaultIntegrationState,
  findIntegrationOrderIndexByLookup,
  findRelationalOrderById,
  isIntegrationOrderCancelled,
  normalizeIntegrationStationName,
  normalizeIntegrationWorkflowStatus,
  nowIso,
  pruneIntegrationState,
  publishIntegrationNotificationStreamRefresh,
  queueIntegrationNotification,
  readDb,
  readJsonBody,
  RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY,
  relationalRuntime,
  runtimeMetrics,
  sanitizeIntegrationOrder,
  sendJson,
  syncRelationalOrderPrimary,
  writeIntegrationOrderSyncDb,
}) {
  async function handleIntegrationOrderTransferRequest(req, res) {
    const payload = await readJsonBody(req);
    const orderId = String(payload.orderId ?? payload.id ?? "").trim();
    const requestedTransferRevision = clampInt(payload.expectedRevision ?? payload.currentRevision ?? payload.revision, 0, 1_000_000, 0);
    if (!orderId) {
      throw new HttpError(400, "ID comanda non valido.");
    }
  
    const requesterStation = normalizeIntegrationStationName(
      String(
        payload.requesterStation ?? payload.station ?? payload.toStation ?? "",
      ).trim(),
    );
    const requesterOperator =
      String(
        payload.requesterOperator ??
          payload.toOperator ??
          payload.operatorName ??
          "",
      ).trim() || "Operatore";
    const requesterRole =
      String(
        payload.requesterRole ??
          payload.toOperatorRole ??
          payload.operatorRole ??
          "",
      ).trim() || "Operatore";
    const mode =
      String(payload.mode ?? "")
        .trim()
        .toLowerCase() === "transfer"
        ? "transfer"
        : "takeover";
    const targetStation =
      mode === "transfer"
        ? normalizeIntegrationStationName(
            String(
              payload.targetStation ?? payload.toStation ?? requesterStation,
            ).trim(),
          )
        : requesterStation;
  
    const db = await readDb();
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    db.integration.orders = Array.isArray(db.integration.orders) ? db.integration.orders : [];
    let orderIndex = findIntegrationOrderIndexByLookup(db.integration.orders, orderId);
    let currentOrder = orderIndex >= 0 ? sanitizeIntegrationOrder(db.integration.orders[orderIndex], String(db.integration.orders[orderIndex]?.id ?? orderId).trim() || orderId) : null;
    const relationalTransferRequestCurrentOrder = await findRelationalOrderById({ enabled: RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY, orderId: currentOrder?.id ?? orderId, relationalRuntime, runtimeMetrics });
    if (relationalTransferRequestCurrentOrder) {
      currentOrder = sanitizeIntegrationOrder(relationalTransferRequestCurrentOrder, String(relationalTransferRequestCurrentOrder.id ?? orderId).trim() || orderId);
      if (orderIndex < 0) { db.integration.orders.push(currentOrder); orderIndex = db.integration.orders.length - 1; } else db.integration.orders[orderIndex] = currentOrder;
    }
    if (!currentOrder || orderIndex < 0) throw new HttpError(404, "Comanda non trovata.");
  
    if (isIntegrationOrderCancelled(currentOrder)) {
      throw new HttpError(409, "Comanda annullata: non e trasferibile.", {
        code: "ORDER_CANCELLED",
      });
    }
    const currentWorkflow = normalizeIntegrationWorkflowStatus(
      currentOrder.workflowStatus,
      currentOrder.items,
      currentOrder.completedAtMs,
    );
    if (currentWorkflow === "ready" || currentWorkflow === "delivered") {
      throw new HttpError(409, "Comanda non trasferibile nello stato corrente.");
    }
  
    const fromStation = normalizeIntegrationStationName(
      currentOrder.ownerStation ||
        currentOrder.station ||
        PRIMARY_INTEGRATION_STATION,
    );
    if (mode !== "transfer" && fromStation === requesterStation) {
      throw new HttpError(409, "La comanda e gia in carico a questa postazione.");
    }
    if (mode === "transfer" && fromStation === targetStation) {
      throw new HttpError(
        409,
        "La comanda e gia in carico alla postazione richiesta.",
      );
    }
  
    const pendingAuthRequest = {
      orderId: currentOrder.id,
      fromStation,
      toStation: targetStation,
      toOperator: requesterOperator,
      toOperatorRole: requesterRole,
      requestedAtMs: Date.now(),
      mode,
      shownToOwner: false,
    };
  
    const currentRevision = clampInt(currentOrder.revision ?? currentOrder.currentRevision, 1, 1_000_000, 1);
    if (RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY && requestedTransferRevision > 0 && currentRevision !== requestedTransferRevision) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision, expectedRevision: requestedTransferRevision } });
    const nextRevision = currentRevision + 1;
    const nextOrder = sanitizeIntegrationOrder({ ...currentOrder, pendingAuthRequest, revision: nextRevision, currentRevision: nextRevision, updatedAt: nowIso() }, currentOrder.id);
    const relationalTransferRequestResult = await syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY, order: nextOrder, previousRevision: requestedTransferRevision > 0 ? requestedTransferRevision : currentRevision, relationalRuntime, runtimeMetrics });
    if (RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY && !relationalTransferRequestResult) throw new HttpError(409, "La comanda e stata modificata da un altro dispositivo. Ricarica la comanda e riprova.", { code: "REVISION_CONFLICT", details: { currentRevision: nextRevision } });
    db.integration.orders[orderIndex] = nextOrder;
    const notification = queueIntegrationNotification(db, {
      type: "general",
      title: fromStation,
      description: `Richiesta trasferimento #${currentOrder.id} da ${requesterOperator}`,
      meta: {
        eventType: "transfer_request",
        orderId: currentOrder.id,
        fromStation,
        toStation: targetStation,
        requesterOperator,
        requesterRole,
        targetStation: fromStation,
        targetClientApp: "postazione",
        mode,
      },
    });
    db.integration.lastWriteAt = nowIso();
    db.meta.lastWriteAt = nowIso();
    pruneIntegrationState(db.integration);
    await writeIntegrationOrderSyncDb(db, { orderIds: [nextOrder.id], syncNotifications: true, notificationIds: [notification?.id], metricLabel: "orders.transfer.request.appStateWrite" });
    publishIntegrationNotificationStreamRefresh("transfer_request", { orderId: nextOrder.id, notificationId: notification?.id ?? "", notification, fromStation, toStation: targetStation, targetStation: fromStation, mode }, { requireOutbox: RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY && REALTIME_BACKBONE_CONFIG.eventOutboxEnabled });
    sendJson(res, 200, {
      ok: true,
      order: nextOrder,
    });
  }
  

  return {
    handleIntegrationOrderTransferRequest,
  };
}
