/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createAssignBillHandlers({
  buildIntegrationOrderLineSnapshots,
  buildPosSettingsPayload,
  ensurePaymentTrackingArrays,
  HttpError,
  appendAuditEvent,
  assertActiveTableWorkLock,
  buildAuditActor,
  normalizePosBillLine,
  normalizeSeatedAtMs,
  normalizeTableCovers,
  nowIso,
  queueIntegrationOrdersFromPosBill,
  randomUUID,
  readDb,
  readJsonBody,
  roundMoney,
  sanitizePosSettings,
  sendJson,
  validateSessionContext,
  writeDb,
}) {
  async function handleAssignBillToTable(req, res) {
    const payload = await readJsonBody(req);
    const tableId =
      typeof payload.tableId === "string" ? payload.tableId.trim() : "";
    const amount = Number(payload.amount);
    const itemCount = Number(payload.itemCount);
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
  
    if (!tableId) {
      throw new HttpError(400, "Tavolo non valido.");
    }
  
    const safeLines = lines
      .map((line) => normalizePosBillLine(line))
      .filter((line) => line !== null);
    const linesSubtotal = roundMoney(
      safeLines.reduce((sum, line) => sum + line.lineTotal, 0),
    );
  
    const subtotal =
      Number.isFinite(amount) && amount > 0 ? roundMoney(amount) : linesSubtotal;
  
    if (subtotal <= 0) {
      throw new HttpError(400, "Importo conto non valido.");
    }
  
    const db = await readDb();
    const { user, session } = validateSessionContext(db, payload);
    ensurePaymentTrackingArrays(db);
  
    let settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
    });
    let tableIndex = settings.tables.findIndex((table) => table.id === tableId);
    if (tableIndex < 0) {
      throw new HttpError(404, "Tavolo non trovato.");
    }
    assertActiveTableWorkLock(db, tableId, {
      user,
      session,
      payload,
      purpose: "table.assign_bill",
    });
    settings = sanitizePosSettings(db.posSettings, { menuItems: db.menuItems });
    tableIndex = settings.tables.findIndex((table) => table.id === tableId);
  
    const current = settings.tables[tableIndex];
    const newBill = {
      id: `bill_${randomUUID().replace(/-/g, "")}`,
      createdAt: nowIso(),
      subtotal,
      lines: safeLines.length
        ? safeLines
        : [
            {
              name: "Conto",
              qty: 1,
              unitPrice: subtotal,
              lineTotal: subtotal,
            },
          ],
    };
    const pendingBills = [...(current.pendingBills ?? []), newBill];
    const totalDue = roundMoney(
      pendingBills.reduce((sum, bill) => sum + Math.max(bill.subtotal, 0), 0),
    );
    const updated = {
      ...current,
      status: "payment_due",
      totalDue,
      covers: Math.max(
        normalizeTableCovers(current.covers),
        Number.isFinite(itemCount)
          ? normalizeTableCovers(itemCount, { minimum: 1, fallback: 1 })
          : 1,
      ),
      reservation: null,
      seatedAt: normalizeSeatedAtMs(current.seatedAt) ?? Date.now(),
      pendingBills,
    };
  
    settings.tables[tableIndex] = updated;
    const createdIntegrationOrders = queueIntegrationOrdersFromPosBill(db, {
      lines: safeLines,
      subtotal,
      table: updated,
      user,
      roomId: typeof payload.roomId === "string" ? payload.roomId : "",
      title: `Comanda tavolo ${updated.number}`,
    });
    const createdOrderIds = [
      ...new Set(
        createdIntegrationOrders
          .map((order) => String(order?.id ?? "").trim())
          .filter(Boolean),
      ),
    ];
    newBill.orderId = createdOrderIds[0] ?? "";
    newBill.orderIds = createdOrderIds;
    const auditActor = buildAuditActor(user, payload);
    const previouslyEmpty =
      !Array.isArray(current.pendingBills) || current.pendingBills.length === 0;
    if (previouslyEmpty) {
      appendAuditEvent(db, {
        ...auditActor,
        action: "table.session_opened",
        entityType: "table",
        entityId: updated.id,
        payload: {
          tableId: updated.id,
          tableNumber: updated.number,
          covers: updated.covers,
        },
      });
    }
    createdIntegrationOrders.forEach((order) => {
      appendAuditEvent(db, {
        ...auditActor,
        action: "order.created",
        entityType: "integration_order",
        entityId: order.id,
        roomId: order.roomId || auditActor.roomId,
        payload: {
          orderId: order.id,
          tableId: order.tableId,
          tableNumber: order.tableNumber,
          source: "cassa-frontend",
        },
        after: {
          id: order.id,
          workflowStatus: order.workflowStatus,
        },
      });
  
      const lineSnapshots = [
        ...buildIntegrationOrderLineSnapshots(order).values(),
      ];
      lineSnapshots.forEach((line) => {
        appendAuditEvent(db, {
          ...auditActor,
          action: "order.line_added",
          entityType: "order_line",
          entityId: `${order.id}:${line.lineId}`,
          roomId: order.roomId || auditActor.roomId,
          payload: {
            orderId: order.id,
            lineId: line.lineId,
            qty: line.qty,
            productNameSnapshot: line.productNameSnapshot,
            unitPriceApplied: line.unitPriceApplied,
            listPriceAtTime: line.listPriceAtTime,
            routeStations: line.routeStations,
          },
        });
      });
  
      (Array.isArray(order.tickets) ? order.tickets : []).forEach((ticket) => {
        appendAuditEvent(db, {
          ...auditActor,
          action: "order.ticket_created",
          entityType: "order_ticket",
          entityId: ticket.id,
          roomId: order.roomId || auditActor.roomId,
          payload: {
            orderId: order.id,
            ticketId: ticket.id,
            stationId: ticket.stationId,
          },
        });
        appendAuditEvent(db, {
          ...auditActor,
          action: "order.ticket_sent",
          entityType: "order_ticket",
          entityId: ticket.id,
          roomId: order.roomId || auditActor.roomId,
          payload: {
            orderId: order.id,
            ticketId: ticket.id,
            stationId: ticket.stationId,
            sentAt: ticket.createdAt,
          },
        });
      });
    });
    db.posSettings = settings;
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);
  
    sendJson(res, 200, {
      ...buildPosSettingsPayload(settings),
      table: updated,
      integration: {
        createdOrdersCount: createdIntegrationOrders.length,
        createdOrderIds: createdIntegrationOrders.map((order) => order.id),
      },
    });
  }
  

  return {
    handleAssignBillToTable,
  };
}
