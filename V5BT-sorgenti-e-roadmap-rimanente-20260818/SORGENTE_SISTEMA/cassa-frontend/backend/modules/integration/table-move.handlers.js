/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createTableMoveHandlers({
  operationalPunctualWriters,
  RELATIONAL_ORDERS_ANY_WRITE_PRIMARY,
  RELATIONAL_TABLE_MOVE_WRITE_PRIMARY,
  RELATIONAL_RESERVATIONS_UPDATE_WRITE_PRIMARY,
  buildIntegrationPrecontoPrintTextWithOptions,
  buildIntegrationOrderPrintText,
  relationalRuntime,
  sanitizePosTable,
  HttpError,
  POS_TABLE_STATUSES,
  PRIMARY_INTEGRATION_STATION,
  ReservationsRelationalRepository,
  appendAuditEvent,
  appendPrintSpoolJobToDb,
  assertActiveTableWorkLock,
  assertRemovedSourceReservationsTransferable,
  assertUserCanOperateInRemovedTableRoom,
  buildAuditActor,
  buildIntegrationCurrentTableSessions,
  buildIntegrationLayoutFromSettings,
  buildIntegrationTableLiveStats,
  buildRemovedSourceOperationalSettings,
  buildTableMoveUpdatePrintText,
  clampInt,
  cloneJson,
  collectAuditEventIdsSince,
  findIntegrationLayoutTableSnapshot,
  isActiveIntegrationOrderForTableMove,
  normalizeSeatedAtMs,
  normalizeStringList,
  normalizeTableCovers,
  nowIso,
  overlayIntegrationLayoutFinancials,
  persistRelationalTableMoveWithRuntime,
  publishIntegrationNotificationStreamRefresh,
  queuePrintSpoolWorker,
  readDb,
  readJsonBody,
  resolveIntegrationOrderPrintStation,
  resolveRemovedSourceTableMoveContext,
  roundMoney,
  sanitizeIntegrationOrder,
  sanitizePosSettings,
  sendJson,
  shouldIncludeIntegrationOrderForCurrentTableSession,
  syncPosTableFinancialsFromIntegrationOrders,
  transferRemovedSourceReservations,
  validateSessionContext,
  writeRoomDb,
}) {
  async function handleIntegrationLayoutTableMove(req, res) {
    const payload = await readJsonBody(req);
    const fromTableId = String(
      payload.fromTableId ?? payload.tableId ?? "",
    ).trim();
    const toTableId = String(
      payload.toTableId ?? payload.targetTableId ?? "",
    ).trim();
    if (!fromTableId || !toTableId) {
      throw new HttpError(400, "Tavoli non validi.");
    }
    if (fromTableId === toTableId) {
      throw new HttpError(400, "Seleziona un tavolo destinazione diverso.");
    }
  
    const db = await readDb();
    const { user, session } = validateSessionContext(db, payload);
    const initialSettings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const sourceInitiallyConfigured = initialSettings.tables.some(
      (table) => String(table.id ?? "").trim() === fromTableId,
    );
    if (sourceInitiallyConfigured && payload.removedSourceSnapshot) {
      throw new HttpError(409, "Il tavolo sorgente risulta ancora configurato.", {
        code: "REMOVED_SOURCE_STILL_CONFIGURED",
      });
    }
    const removedSourceContext = sourceInitiallyConfigured
      ? null
      : resolveRemovedSourceTableMoveContext(
          db,
          initialSettings,
          payload,
          fromTableId,
        );
    if (removedSourceContext) {
      assertUserCanOperateInRemovedTableRoom(user, initialSettings, {
        roomId: removedSourceContext.sourceRoomId,
        removedOperationalEvidenceUserIds: removedSourceContext.evidenceUserIds,
      }, { session });
    } else {
      assertActiveTableWorkLock(db, fromTableId, {
        user,
        session,
        payload,
        purpose: "table.move_source",
      });
    }
    assertActiveTableWorkLock(db, toTableId, {
      user,
      session,
      payload,
      purpose: "table.move_target",
      requireExisting: Boolean(removedSourceContext),
    });
    let { settings, liveStats } = syncPosTableFinancialsFromIntegrationOrders(
      db,
      [fromTableId, toTableId],
    );
    const sourceIndex = settings.tables.findIndex(
      (table) => table.id === fromTableId,
    );
    const targetIndex = settings.tables.findIndex(
      (table) => table.id === toTableId,
    );
    if ((!removedSourceContext && sourceIndex < 0) || targetIndex < 0) {
      throw new HttpError(404, "Tavolo sorgente o destinazione non trovato.");
    }
  
    const sourceTable = removedSourceContext
      ? removedSourceContext.sourceTable
      : sanitizePosTable(settings.tables[sourceIndex], sourceIndex + 1);
    const targetTable = sanitizePosTable(
      settings.tables[targetIndex],
      targetIndex + 1,
    );
    const operationalSettings = removedSourceContext
      ? buildRemovedSourceOperationalSettings(settings, sourceTable)
      : settings;
    const operationalLiveStats = removedSourceContext
      ? buildIntegrationTableLiveStats(
          { ...db, posSettings: operationalSettings },
          { targetTableIds: [fromTableId, toTableId] },
        )
      : liveStats;
    const liveLayout = overlayIntegrationLayoutFinancials(
      buildIntegrationLayoutFromSettings(operationalSettings),
      operationalLiveStats,
    );
    const liveTablesById = new Map(
      (Array.isArray(liveLayout?.tables) ? liveLayout.tables : []).map(
        (table) => [String(table?.id ?? "").trim(), table],
      ),
    );
    const liveSource = liveTablesById.get(fromTableId) ?? null;
    const liveTarget = liveTablesById.get(toTableId) ?? null;
    if (!liveSource || !liveTarget) {
      throw new HttpError(404, "Tavolo sorgente o destinazione non trovato.");
    }
    const sourceRoomId = String(
      removedSourceContext?.sourceRoomId ?? liveSource.roomId ?? payload.roomId ?? "",
    ).trim();
    const targetRoomId = String(
      liveTarget?.roomId ?? payload.targetRoomId ?? payload.roomId ?? "",
    ).trim();
  
    const sourceIsFree =
      String(liveSource?.occupancyState ?? "").trim() === "free" &&
      Math.max(Number(liveSource?.amountDue) || 0, 0) <= 0.009 &&
      Math.max(Math.trunc(Number(liveSource?.ordersInProgress) || 0), 0) <= 0;
    if (sourceIsFree) {
      throw new HttpError(409, "Il tavolo sorgente e gia libero.");
    }
  
    const targetIsFree =
      String(liveTarget?.occupancyState ?? "").trim() === "free" &&
      Math.max(Number(liveTarget?.amountDue) || 0, 0) <= 0.009 &&
      Math.max(Math.trunc(Number(liveTarget?.ordersInProgress) || 0), 0) <= 0;
    if (!targetIsFree) {
      throw new HttpError(409, "Il tavolo destinazione deve essere libero.");
    }
    assertRemovedSourceReservationsTransferable(
      removedSourceContext,
      db,
      toTableId,
      targetRoomId,
    );
  
    const sourceStatus = POS_TABLE_STATUSES.has(sourceTable.status)
      ? sourceTable.status
      : "free";
    const nextTarget = sanitizePosTable(
      {
        ...targetTable,
        revision: clampInt(targetTable.revision ?? targetTable.currentRevision, 1, 1_000_000, 1) + 1,
        status: sourceStatus === "free" ? "no_orders" : sourceStatus,
        guestName: String(sourceTable.guestName ?? "").trim(),
        customerPhone: String(sourceTable.customerPhone ?? "").trim(),
        covers: normalizeTableCovers(sourceTable.covers),
        reservation: cloneJson(sourceTable.reservation, null),
        seatedAt: normalizeSeatedAtMs(sourceTable.seatedAt),
        totalDue: roundMoney(Math.max(Number(sourceTable.totalDue) || 0, 0)),
        pendingBills: cloneJson(sourceTable.pendingBills, []),
        note: String(sourceTable.note ?? "").trim(),
        allergens: normalizeStringList(sourceTable.allergens, 12, 40),
        manualIntolerance: String(sourceTable.manualIntolerance ?? "").trim(),
        workLock: null,
      },
      targetIndex + 1,
    );
    const nextSource = sanitizePosTable(
      {
        ...sourceTable,
        revision: clampInt(sourceTable.revision ?? sourceTable.currentRevision, 1, 1_000_000, 1) + 1,
        status: "free",
        guestName: "",
        customerPhone: "",
        covers: 0,
        reservation: null,
        seatedAt: null,
        totalDue: 0,
        pendingBills: [],
        note: "",
        allergens: [],
        manualIntolerance: "",
        workLock: null,
      },
      sourceIndex >= 0 ? sourceIndex + 1 : sourceTable.number,
    );
  
    const currentTableSessions = buildIntegrationCurrentTableSessions({
      ...db,
      posSettings: operationalSettings,
    });
    const moveTimestampMs = Date.now();
    const moveTimestampIso = nowIso();
    let movedOrdersCount = 0;
    const movedOrders = [];
    if (Array.isArray(db.integration?.orders)) {
      db.integration.orders = db.integration.orders.map((entry, index) => {
        const currentOrder = sanitizeIntegrationOrder(
          entry,
          String(index + 1).padStart(5, "0"),
        );
        const matchesSource =
          String(currentOrder.tableId ?? "").trim() === fromTableId;
        const belongsToCurrentSession =
          shouldIncludeIntegrationOrderForCurrentTableSession(
            currentOrder,
            currentTableSessions,
          );
        const isStillActive = isActiveIntegrationOrderForTableMove(currentOrder);
        if (!matchesSource || !belongsToCurrentSession || !isStillActive) {
          return currentOrder;
        }
        movedOrdersCount += 1;
        const nextOrder = sanitizeIntegrationOrder(
          {
            ...currentOrder,
            roomId: targetRoomId || String(currentOrder.roomId ?? "").trim(),
            tableId: nextTarget.id,
            table: nextTarget.number,
            tableNumber: nextTarget.number,
            tableLabel: String(nextTarget.number),
            logicalTableLabel: String(nextTarget.number),
            lastTableTransferAtMs: moveTimestampMs,
            updatedAt: moveTimestampIso,
          },
          currentOrder.id,
        );
        movedOrders.push(nextOrder);
        return nextOrder;
      });
      if (movedOrdersCount > 0) {
        db.integration.lastWriteAt = moveTimestampIso;
      }
    }
  
    if (sourceIndex >= 0) {
      settings.tables[sourceIndex] = nextSource;
    }
    settings.tables[targetIndex] = nextTarget;
    transferRemovedSourceReservations(
      db,
      removedSourceContext,
      fromTableId,
      toTableId,
    );
    db.posSettings = settings;
    ({ settings } = syncPosTableFinancialsFromIntegrationOrders(
      db,
      removedSourceContext ? [toTableId] : [fromTableId, toTableId],
    ));
    const syncedSourceIndex = settings.tables.findIndex(
      (table) => String(table.id ?? "").trim() === fromTableId,
    );
    if (syncedSourceIndex >= 0) {
      settings.tables[syncedSourceIndex] = sanitizePosTable(
        {
          ...settings.tables[syncedSourceIndex],
          revision: nextSource.revision,
          status: "free",
          guestName: "",
          customerPhone: "",
          covers: 0,
          reservation: null,
          seatedAt: null,
          totalDue: 0,
          amountDue: 0,
          dueAmount: 0,
          pendingBills: [],
          note: "",
          allergens: [],
          manualIntolerance: "",
          workLock: null,
        },
        syncedSourceIndex + 1,
      );
    }
    settings.tables = settings.tables.map((table, index) => {
      if (String(table.id ?? "").trim() !== toTableId) return table;
      const removedSourceOperationalFields = removedSourceContext
        ? {
            status:
              sourceTable.status === "reserved" || movedOrdersCount === 0
                ? nextTarget.status
                : table.status,
            guestName: nextTarget.guestName,
            customerPhone: nextTarget.customerPhone,
            covers: nextTarget.covers,
            reservation: cloneJson(nextTarget.reservation, null),
            seatedAt: nextTarget.seatedAt,
            note: nextTarget.note,
            allergens: cloneJson(nextTarget.allergens, []),
            manualIntolerance: nextTarget.manualIntolerance,
          }
        : {};
      return sanitizePosTable(
        {
          ...table,
          ...removedSourceOperationalFields,
          revision: nextTarget.revision,
          workLock: null,
        },
        index + 1,
      );
    });
    db.posSettings = settings;
  
    const tableMovePrintJobs = [];
    if (movedOrders.length > 0) {
      for (const movedOrder of movedOrders) {
        const updatePrintJob = await appendPrintSpoolJobToDb(db, {
          kind: "table_update",
          orderId: movedOrder.id,
          roomId: targetRoomId || movedOrder.roomId,
          station: PRIMARY_INTEGRATION_STATION,
          fallbackStation: PRIMARY_INTEGRATION_STATION,
          userId: user.id,
          deviceUuid: session.deviceUuid,
          clientApp: session.clientApp,
          text: buildTableMoveUpdatePrintText({
            order: movedOrder,
            fromTable: sourceTable,
            toTable: nextTarget,
            sourceRoomId,
            targetRoomId,
            settings,
          }),
          printPreferences: settings.printPreferences,
        });
        const orderPrintStation = resolveIntegrationOrderPrintStation(
          movedOrder,
          {
            station:
              movedOrder.station ||
              movedOrder.ownerStation ||
              PRIMARY_INTEGRATION_STATION,
          },
        );
        const orderPrintJob = await appendPrintSpoolJobToDb(db, {
          kind: "order",
          orderId: movedOrder.id,
          roomId: targetRoomId || movedOrder.roomId,
          station: orderPrintStation,
          fallbackStation: PRIMARY_INTEGRATION_STATION,
          userId: user.id,
          deviceUuid: session.deviceUuid,
          clientApp: session.clientApp,
          text: buildIntegrationOrderPrintText(
            movedOrder,
            orderPrintStation,
            settings.printPreferences?.order,
            settings,
          ),
          printPreferences: settings.printPreferences,
        });
        const precontoPrintJob = await appendPrintSpoolJobToDb(db, {
          kind: "preconto",
          orderId: movedOrder.id,
          roomId: targetRoomId || movedOrder.roomId,
          station: PRIMARY_INTEGRATION_STATION,
          fallbackStation: PRIMARY_INTEGRATION_STATION,
          userId: user.id,
          deviceUuid: session.deviceUuid,
          clientApp: session.clientApp,
          precontoProfile: "cash",
          text: buildIntegrationPrecontoPrintTextWithOptions(
            movedOrder,
            settings.printPreferences,
            settings,
            { profile: "cash" },
          ),
          printPreferences: settings.printPreferences,
        });
        tableMovePrintJobs.push({
          orderId: movedOrder.id,
          updatePrintJobId: updatePrintJob?.id ?? null,
          orderPrintJobId: orderPrintJob?.id ?? null,
          precontoPrintJobId: precontoPrintJob?.id ?? null,
        });
      }
    }
  
    const tableMoveAuditStartIndex = Array.isArray(db.auditEvents) ? db.auditEvents.length : 0;
    const actor = buildAuditActor(user, {
      ...payload,
      deviceUuid: session.deviceUuid,
      sessionId: session.id,
    });
    appendAuditEvent(db, {
      ...actor,
      action: "table.moved",
      entityType: "table",
      entityId: fromTableId,
      roomId: targetRoomId || null,
      payload: {
        fromTableId,
        fromTableNumber: sourceTable.number,
        toTableId,
        toTableNumber: targetTable.number,
        movedOrdersCount,
      },
    });
    appendAuditEvent(db, {
      ...actor,
      action: "table.released",
      entityType: "table",
      entityId: fromTableId,
      roomId: sourceRoomId || String(payload.roomId ?? "").trim() || null,
      payload: {
        tableId: fromTableId,
        tableNumber: sourceTable.number,
        movedToTableId: toTableId,
        movedToTableNumber: targetTable.number,
      },
    });
    if (nextTarget.status !== "free" && nextTarget.status !== "reserved") {
      appendAuditEvent(db, {
        ...actor,
        action: "table.session_opened",
        entityType: "table",
        entityId: toTableId,
        roomId: targetRoomId || null,
        payload: {
          tableId: toTableId,
          tableNumber: nextTarget.number,
          seatedAt: normalizeSeatedAtMs(nextTarget.seatedAt) ?? moveTimestampMs,
          movedFromTableId: fromTableId,
          movedFromTableNumber: sourceTable.number,
        },
      });
    }
  
    db.meta.lastWriteAt = nowIso();
    const relationalReservationTransfer =
      RELATIONAL_RESERVATIONS_UPDATE_WRITE_PRIMARY &&
      removedSourceContext?.activeReservations.length > 0
        ? {
            reservationIds: removedSourceContext.activeReservations.map(
              ({ reservation }) => reservation.id,
            ),
            fromTableId,
            toTableId,
            nowMs: moveTimestampMs,
          }
        : null;
    if (RELATIONAL_TABLE_MOVE_WRITE_PRIMARY) await persistRelationalTableMoveWithRuntime({
      relationalRuntime, appState: db, tableIds: [fromTableId, toTableId], movedOrders,
      reservationTransfer: relationalReservationTransfer,
      requireRelationalOrders: RELATIONAL_ORDERS_ANY_WRITE_PRIMARY,
      httpErrorFactory: (status, message, options) => new HttpError(status, message, options),
    });
    if (relationalReservationTransfer && !RELATIONAL_TABLE_MOVE_WRITE_PRIMARY) {
      await relationalRuntime.initialize();
      if (!relationalRuntime?.db) {
        throw new HttpError(503, "DB relazionale prenotazioni non disponibile.");
      }
      const relationalReservationResult =
        new ReservationsRelationalRepository(
          relationalRuntime.db,
        ).transferReservationTableAssignments(relationalReservationTransfer);
      if (!relationalReservationResult?.ok) {
        throw new HttpError(
          409,
          "Conflitto assegnazione prenotazione durante lo spostamento tavolo.",
          {
            code: "RELATIONAL_TABLE_MOVE_RESERVATION_CONFLICT",
            details: {
              reason: relationalReservationResult?.reason ?? "unknown",
              reservationId:
                relationalReservationResult?.reservationId ?? null,
            },
          },
        );
      }
    }
    const tableMoveFastWritten = await operationalPunctualWriters.tableMove(db, { tableIds: [fromTableId, toTableId], orderIds: movedOrders.map((entry) => entry.id), auditEventIds: collectAuditEventIdsSince(db, tableMoveAuditStartIndex), printJobIds: tableMovePrintJobs.flatMap((entry) => [entry.updatePrintJobId, entry.orderPrintJobId, entry.precontoPrintJobId]), requiresFullFallback: Boolean(removedSourceContext) });
    if (!tableMoveFastWritten) await writeRoomDb(db, { metricLabel: "rooms.table.move.appStateWrite", splitDomains: ["posSettings", "integration", "auditEvents", "printSpoolJobs", "tableLocks", ...(removedSourceContext?.activeReservations.length > 0 ? ["posReservationStates"] : [])] });
    if (tableMovePrintJobs.length > 0) {
      queuePrintSpoolWorker();
    }
    const finalTablesById = new Map(
      settings.tables.map((table, index) => [
        String(table.id ?? "").trim(),
        sanitizePosTable(table, index + 1),
      ]),
    );
    const finalFromTable = finalTablesById.get(fromTableId) ?? nextSource;
    const persistedFinalToTable = finalTablesById.get(toTableId) ?? nextTarget;
    const finalToTable = removedSourceContext
      ? {
          ...persistedFinalToTable,
          occupancyState: removedSourceContext.snapshot.occupancyState,
          reservationAt: removedSourceContext.snapshot.reservationAt,
        }
      : persistedFinalToTable;
    const realtimeFromTable =
      findIntegrationLayoutTableSnapshot(db, fromTableId) ?? finalFromTable;
    const realtimeToTable =
      findIntegrationLayoutTableSnapshot(db, toTableId) ?? finalToTable;
    publishIntegrationNotificationStreamRefresh("table_moved", {
      fromTableId,
      toTableId,
      fromRoomId: sourceRoomId,
      toRoomId: targetRoomId,
      movedOrdersCount,
      fromTable: realtimeFromTable,
      toTable: realtimeToTable,
    });
  
    sendJson(res, 200, {
      ok: true,
      movedOrdersCount,
      fromTable: finalFromTable,
      toTable: finalToTable,
      tableMovePrintJobs,
    });
  }
  

  return {
    handleIntegrationLayoutTableMove,
  };
}
