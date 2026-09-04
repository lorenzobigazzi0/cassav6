/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createRoomChangeHandlers({
  operationalPunctualWriters,
  posRoomChangeApproveTelemetry,
  posRoomChangeRequestTelemetry,
  RELATIONAL_ROOM_CHANGE_REQUEST_WRITE_PRIMARY,
  RELATIONAL_TABLE_SYNC_WRITE_PRIMARY,
  sanitizePosTable,
  HttpError,
  POS_TABLE_STATUSES,
  ReservationsRelationalRepository,
  TablesBillsRelationalRepository,
  appendAuditEvent,
  assertActiveTableWorkLock,
  buildPosRoomListFromSettings,
  canUserChangeRoomDirectly,
  clampInt,
  clearIntegrationHotResponseCaches,
  collectAuditEventIdsSince,
  ensurePosDataCollections,
  findPosAllowedRoomForUser,
  handleRemovedOperationalTableSync,
  isPosPrivilegedRole,
  normalizeReservation,
  normalizeSeatedAtMs,
  normalizeStringList,
  normalizeTableCovers,
  normalizeUsername,
  nowIso,
  posRoomChangeApprovePinProof,
  pruneExpiredPosRoomChangeRequests,
  publishIntegrationNotificationStreamRefresh,
  randomUUID,
  readDb,
  readJsonBody,
  relationalRuntime,
  releaseActivatedPosReservationTableGroup,
  requiresAdminForRoomChange,
  roundMoney,
  sanitizePosSettings,
  sendJson,
  timeStringFromTimestamp,
  toPosRole,
  updatePosSessionRoom,
  validateSessionContext,
  verifyPin,
  writeRoomDb,
  writeTableSyncAppStateFastDb,
}) {
  async function handlePosRoomChangeRequest(req, res) {
    const payload = await readJsonBody(req), requestTelemetry = posRoomChangeRequestTelemetry.start();
    const db = await requestTelemetry.measure("readDb.handler", () => readDb());
    const { user, session, room } = requestTelemetry.measureSync("authorization", () => {
      const context = validateSessionContext(db, payload);
      const targetRoomId = String(payload.targetRoomId ?? "").trim();
      if (!targetRoomId) throw new HttpError(400, "Sala non disponibile per questo utente.");
      const allowedRoom = findPosAllowedRoomForUser(db.posSettings, context.user, targetRoomId);
      if (!allowedRoom) throw new HttpError(403, "Sala non disponibile per questo utente.");
      return { ...context, room: allowedRoom };
    });
    if (canUserChangeRoomDirectly(user, room.id, db.posSettings)) {
      const changed = requestTelemetry.measureSync("direct.sessionMutation", () => updatePosSessionRoom(db, {
        userId: user.id,
        sessionId: session.id,
        deviceUuid: String(payload.deviceUuid ?? session.deviceUuid ?? "").trim(),
        room,
      }));
      if (changed) {
        db.meta.lastWriteAt = nowIso();
        await requestTelemetry.measure("direct.appStateWrite", async () => { if (!await operationalPunctualWriters.roomSession(db, { userIds: [user.id], sessionIds: [session.id] })) await writeRoomDb(db, { metricLabel: "rooms.session.appStateWrite", splitDomains: ["sessions", "users"] }); });
      } else requestTelemetry.record("direct.appStateWriteSkipped", 0);
      requestTelemetry.finish("direct");
      sendJson(res, 200, {
        ok: true,
        status: "approved",
        direct: true,
        room,
        lastSelectedRoomId: room.id,
      });
      return;
    }
    if (!requiresAdminForRoomChange(user, room.id, db.posSettings)) {
      requestTelemetry.finish("rejected");
      throw new HttpError(403, "Sala non disponibile per questo utente.");
    }
    const { requestId, request } = requestTelemetry.measureSync("pending.prepare", () => {
      ensurePosDataCollections(db);
      pruneExpiredPosRoomChangeRequests(db);
      const nextRequestId = `room_req_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      const nextRequest = { requestId: nextRequestId, userId: user.id, sessionId: String(session.id ?? "").trim(), deviceUuid: String(payload.deviceUuid ?? "").trim(), targetRoomId: room.id, targetRoomName: room.name, createdAt: Date.now(), revision: 1 };
      db.posRoomChangeRequests.push(nextRequest);
      db.meta.lastWriteAt = nowIso();
      return { requestId: nextRequestId, request: nextRequest };
    });
    if (RELATIONAL_ROOM_CHANGE_REQUEST_WRITE_PRIMARY) await requestTelemetry.measure("pending.relationalWrite", async () => { await relationalRuntime.initialize(); if (!relationalRuntime?.db) throw new HttpError(503, "DB relazionale prenotazioni non disponibile."); const persistedRequest = new ReservationsRelationalRepository(relationalRuntime.db).createRoomChangeRequest(request); if (!persistedRequest?.ok) throw new HttpError(persistedRequest?.reason === "exists" ? 409 : 400, "Richiesta cambio sala relazionale non valida."); });
    else requestTelemetry.record("pending.relationalWriteSkipped", 0);
    await requestTelemetry.measure("pending.appStateWrite", () => writeRoomDb(db, { metricLabel: "rooms.change.request.appStateWrite", splitDomains: ["posRoomChangeRequests"] }));
    requestTelemetry.finish("pending");
    sendJson(res, 200, {
      ok: true,
      status: "pending",
      requestId,
      room,
    });
  }
  
  async function handlePosRoomChangeApprove(req, res) {
    const payload = await readJsonBody(req), approveTelemetry = posRoomChangeApproveTelemetry.start();
    try {
      const db = await approveTelemetry.measure("readDb.handler", () => readDb());
      approveTelemetry.measureSync("prepare.prune", () => { ensurePosDataCollections(db); pruneExpiredPosRoomChangeRequests(db); });
      const requestId = String(payload.requestId ?? "").trim();
      if (!requestId) { approveTelemetry.finish("not_found"); sendJson(res, 200, { ok: false, error: "Richiesta non trovata o scaduta." }); return; }
      const requestIndex = approveTelemetry.measureSync("requestLookup", () => db.posRoomChangeRequests.findIndex((entry) => entry.requestId === requestId));
      if (requestIndex < 0) { approveTelemetry.finish("not_found"); sendJson(res, 200, { ok: false, error: "Richiesta non trovata o scaduta." }); return; }
  
      const approverUsername = String(payload.approverUsername ?? "").trim(), approverPin = String(payload.approverPin ?? "").trim(), approverDeviceUuid = String(payload.deviceUuid ?? "").trim();
      if (!approverUsername || !approverPin || !approverDeviceUuid) { approveTelemetry.finish("invalid_credentials"); sendJson(res, 200, { ok: false, error: "Credenziali autorizzatore non valide." }); return; }
      const approver = approveTelemetry.measureSync("authorization.lookup", () => db.users.find((entry) => normalizeUsername(entry.username) === normalizeUsername(approverUsername)));
      const pinProof = posRoomChangeApprovePinProof.consume(req, approver, approverUsername);
      let pinValid = false;
      if (approver && pinProof.usable) {
        approveTelemetry.record("authorization.pinProofUsed", 0);
        pinValid = pinProof.pinValid;
      } else if (approver) {
        if (pinProof.reason !== "disabled") approveTelemetry.record("authorization.pinProofFallback", 0);
        pinValid = approveTelemetry.measureSync("authorization.pinVerify", () => verifyPin(approverPin, approver.pinHash));
      }
      if (!approver || !pinValid) { approveTelemetry.finish("invalid_credentials"); sendJson(res, 200, { ok: false, error: "Credenziali autorizzatore non valide." }); return; }
      if (!approveTelemetry.measureSync("authorization.role", () => isPosPrivilegedRole(approver.role))) { approveTelemetry.finish("forbidden"); sendJson(res, 200, { ok: false, error: "Utente non autorizzato ad approvare il cambio sala." }); return; }
  
      const pending = db.posRoomChangeRequests[requestIndex];
      if (RELATIONAL_ROOM_CHANGE_REQUEST_WRITE_PRIMARY) await approveTelemetry.measure("pending.relationalDelete", async () => { await relationalRuntime.initialize(); if (!relationalRuntime?.db) throw new HttpError(503, "DB relazionale prenotazioni non disponibile."); const deletedRequest = new ReservationsRelationalRepository(relationalRuntime.db).deleteRoomChangeRequest({ requestId, expectedRevision: pending.revision }); if (!deletedRequest?.ok) throw new HttpError(deletedRequest?.reason === "missing" ? 404 : deletedRequest?.reason === "revision_conflict" ? 409 : 400, "Richiesta cambio sala relazionale non valida.", { code: "ROOM_CHANGE_REQUEST_CONFLICT" }); });
      else approveTelemetry.record("pending.relationalDeleteSkipped", 0);
      approveTelemetry.measureSync("state.requestRemoval", () => db.posRoomChangeRequests.splice(requestIndex, 1));
      const room = approveTelemetry.measureSync("state.roomResolution", () => buildPosRoomListFromSettings(db.posSettings).find((entry) => entry.id === pending.targetRoomId) || { id: pending.targetRoomId, name: pending.targetRoomName || pending.targetRoomId });
      const sessionChanged = approveTelemetry.measureSync("state.sessionMutation", () => updatePosSessionRoom(db, { userId: pending.userId, sessionId: pending.sessionId, deviceUuid: pending.deviceUuid, room }));
      approveTelemetry.record(sessionChanged ? "state.sessionChanged" : "state.sessionUnchanged", 0);
      db.meta.lastWriteAt = nowIso();
      await approveTelemetry.measure("state.appStateWrite", () => writeRoomDb(db, { metricLabel: "rooms.change.approve.appStateWrite", splitDomains: ["posRoomChangeRequests", "sessions", "users"] }));
      approveTelemetry.finish("approved");
      sendJson(res, 200, { ok: true, room, lastSelectedRoomId: room.id, approver: { username: approver.username, role: toPosRole(approver.role) } });
    } catch (error) {
      approveTelemetry.finish("error");
      throw error;
    } finally {
      posRoomChangeApprovePinProof.discard(req);
    }
  }
  
  async function handlePosRoomChangeCancel(req, res) {
    const payload = await readJsonBody(req);
    const requestId = String(payload.requestId ?? "").trim();
    if (!requestId) {
      sendJson(res, 200, {
        ok: true,
        cancelled: false,
      });
      return;
    }
    const db = await readDb();
    ensurePosDataCollections(db);
    const requestToCancel = db.posRoomChangeRequests.find((entry) => entry.requestId === requestId);
    const cancelled = Boolean(requestToCancel);
    if (cancelled) {
      if (RELATIONAL_ROOM_CHANGE_REQUEST_WRITE_PRIMARY) { await relationalRuntime.initialize(); if (!relationalRuntime?.db) throw new HttpError(503, "DB relazionale prenotazioni non disponibile."); const deletedRequest = new ReservationsRelationalRepository(relationalRuntime.db).deleteRoomChangeRequest({ requestId, expectedRevision: requestToCancel.revision }); if (!deletedRequest?.ok) throw new HttpError(deletedRequest?.reason === "missing" ? 404 : deletedRequest?.reason === "revision_conflict" ? 409 : 400, "Richiesta cambio sala relazionale non valida.", { code: "ROOM_CHANGE_REQUEST_CONFLICT" }); }
      db.posRoomChangeRequests = db.posRoomChangeRequests.filter((entry) => entry.requestId !== requestId);
      db.meta.lastWriteAt = nowIso();
      await writeRoomDb(db, { metricLabel: "rooms.change.cancel.appStateWrite", splitDomains: ["posRoomChangeRequests"] });
    }
    sendJson(res, 200, {
      ok: true,
      cancelled,
    });
  }
  
  async function handleIntegrationLayoutTableSync(req, res) {
    const payload = await readJsonBody(req);
    const tableId = String(payload.tableId ?? "").trim();
    if (!tableId) {
      throw new HttpError(400, "Tavolo non valido.");
    }
  
    const db = await readDb(), auditEventStartIndex = Array.isArray(db.auditEvents) ? db.auditEvents.length : 0;
    const { user, session } = validateSessionContext(db, payload);
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
    });
    const tableIndex = settings.tables.findIndex((table) => table.id === tableId);
    if (tableIndex < 0) {
      await handleRemovedOperationalTableSync({
        db,
        payload,
        res,
        settings,
        tableId,
        user,
        session,
      });
      return;
    }
    assertActiveTableWorkLock(db, tableId, {
      user,
      session,
      payload,
      purpose: "table.sync",
    });
  
    const current = settings.tables[tableIndex];
    const requestedStatusRaw = String(payload.status ?? "").trim();
    let safeStatus = POS_TABLE_STATUSES.has(requestedStatusRaw)
      ? requestedStatusRaw
      : "";
    if (!safeStatus) {
      const occupancy = String(payload.occupancyState ?? "").trim();
      if (occupancy === "free") safeStatus = "free";
      else if (occupancy === "reserved") safeStatus = "reserved";
      else if (occupancy === "seated") {
        safeStatus =
          current.status === "waiting" || current.status === "payment_due"
            ? current.status
            : "no_orders";
      }
    }
    if (!safeStatus)
      safeStatus = POS_TABLE_STATUSES.has(current.status)
        ? current.status
        : "free";
  
    const requestedName = String(payload.tableName ?? payload.guestName ?? "")
      .trim()
      .slice(0, 32);
    const requestedPhone = String(payload.customerPhone ?? "")
      .trim()
      .slice(0, 24);
    const requestedNote = String(payload.note ?? "")
      .trim()
      .slice(0, 240);
    const requestedManualIntolerance = String(payload.manualIntolerance ?? "")
      .trim()
      .slice(0, 64);
    const requestedAllergens = normalizeStringList(payload.allergens, 12, 40);
    // Un campo vuoto e una richiesta esplicita di cancellare, e va distinto dal
    // campo assente, che invece vuol dire "non toccare". Senza la distinzione
    // allergie, intolleranza manuale e nota non si potevano piu togliere se non
    // liberando il tavolo: il vuoto veniva letto come "nessuna richiesta" e si
    // ricadeva sempre sul valore gia salvato.
    const campoPresente = (nome) =>
      payload != null &&
      Object.prototype.hasOwnProperty.call(payload, nome) &&
      payload[nome] !== null &&
      payload[nome] !== undefined;
    const noteAutoritativa = campoPresente("note");
    const allergensAutoritativi = campoPresente("allergens");
    const manualIntoleranceAutoritativa = campoPresente("manualIntolerance");
    const requestedCoversRaw = Number(payload.covers);
    const requestedCovers = Number.isFinite(requestedCoversRaw)
      ? normalizeTableCovers(requestedCoversRaw)
      : null;
    const requestedSeatedAt = normalizeSeatedAtMs(payload.seatedAt);
    const reservationTimeRaw = String(payload.reservationTime ?? "").trim();
    const reservationTimeFromMs = timeStringFromTimestamp(payload.reservationAt);
    const reservationTime = /^([01]\d|2[0-3]):([0-5]\d)$/.test(reservationTimeRaw)
      ? reservationTimeRaw
      : reservationTimeFromMs;
  
    const hasReservationPayload = Boolean(reservationTime);
    const isRelease = safeStatus === "free" && !hasReservationPayload;
    const keepsFinancial = safeStatus === "payment_due";
    const nextSeatedAt =
      safeStatus === "free" || safeStatus === "reserved"
        ? null
        : (requestedSeatedAt ??
          normalizeSeatedAtMs(current.seatedAt) ??
          Date.now());
    // Un tavolo che non si sta liberando ha **almeno un coperto**. Il campo
    // assente lo garantiva gia' con il minimo a 1; un `covers: 0` esplicito no,
    // e passava. Da li' vengono i tavoli occupati con zero coperti, che nella
    // griglia non mostrano la pastiglia dei coperti perche' non c'e' niente da
    // mostrare: il difetto non e' la tessera, e' il dato che ci arriva.
    const nextCovers = isRelease
      ? 0
      : normalizeTableCovers(requestedCovers ?? current.covers, {
          minimum: 1,
          fallback: 1,
        });
    const nextReservation =
      safeStatus === "reserved" || hasReservationPayload
        ? normalizeReservation({
            time:
              reservationTime ||
              String(current.reservation?.time ?? "") ||
              "20:00",
            people: nextCovers,
            mergeFlag:
              payload.mergeFlag === true ||
              (current.reservation && current.reservation.mergeFlag === true),
          })
        : null;
  
    const updated = sanitizePosTable(
      {
        ...current,
        revision: clampInt(current.revision ?? current.currentRevision, 1, 1_000_000, 1) + 1,
        status: safeStatus,
        guestName: isRelease
          ? ""
          : requestedName || String(current.guestName ?? "").trim(),
        customerPhone: isRelease
          ? ""
          : requestedPhone || String(current.customerPhone ?? "").trim(),
        covers: nextCovers,
        reservation: nextReservation,
        seatedAt: nextSeatedAt,
        totalDue: keepsFinancial
          ? roundMoney(Math.max(Number(current.totalDue) || 0, 0))
          : 0,
        pendingBills: keepsFinancial
          ? Array.isArray(current.pendingBills)
            ? current.pendingBills
            : []
          : [],
        note: isRelease
          ? ""
          : noteAutoritativa
            ? requestedNote
            : String(current.note ?? "").trim(),
        allergens: isRelease
          ? []
          : allergensAutoritativi
            ? requestedAllergens
            : normalizeStringList(current.allergens, 12, 40),
        manualIntolerance: isRelease
          ? ""
          : manualIntoleranceAutoritativa
            ? requestedManualIntolerance
            : String(current.manualIntolerance ?? "").trim(),
        workLock: isRelease ? null : current.workLock,
      },
      tableIndex + 1,
    );
  
    const wasSeated = current.status !== "free" && current.status !== "reserved";
    const isSeated = updated.status !== "free" && updated.status !== "reserved";
    const wasReserved = current.status === "reserved";
    const arrivedFromReservation = wasReserved && isSeated;
    settings.tables[tableIndex] = updated;
    db.posSettings = settings;
    const reservationSplit =
      isRelease || arrivedFromReservation
        ? releaseActivatedPosReservationTableGroup(
            db,
            tableId,
            current,
            Date.now(),
            arrivedFromReservation ? "arrived" : "released",
          )
        : { changed: false, releasedReservationIds: [] };
    if (!wasSeated && isSeated) {
      appendAuditEvent(db, {
        actorUserId: String(payload.userId ?? "system"),
        actorRole: "OPERATOR",
        action: "table.session_opened",
        entityType: "table",
        entityId: updated.id,
        payload: {
          tableId: updated.id,
          tableNumber: updated.number,
          seatedAt: updated.seatedAt,
        },
      });
    } else if (wasSeated && updated.status === "free") {
      appendAuditEvent(db, {
        actorUserId: String(payload.userId ?? "system"),
        actorRole: "OPERATOR",
        action: "table.released",
        entityType: "table",
        entityId: updated.id,
        payload: {
          tableId: updated.id,
          tableNumber: updated.number,
        },
      });
    }
    if (reservationSplit.changed) {
      appendAuditEvent(db, {
        actorUserId: String(payload.userId ?? "system"),
        actorRole: "OPERATOR",
        action: "reservation.table_group_released",
        entityType: "table",
        entityId: updated.id,
        payload: {
          tableId: updated.id,
          tableNumber: updated.number,
          releasedReservationIds: reservationSplit.releasedReservationIds,
        },
      });
      clearIntegrationHotResponseCaches();
      publishIntegrationNotificationStreamRefresh(
        "reservation_table_group_released",
        {
          tableId: updated.id,
          releasedReservationIds: reservationSplit.releasedReservationIds,
        },
      );
    }
    db.meta.lastWriteAt = nowIso();
    if (RELATIONAL_TABLE_SYNC_WRITE_PRIMARY) {
      await relationalRuntime.initialize();
      if (!relationalRuntime?.db) {
        throw new HttpError(503, "DB relazionale tavoli non disponibile.");
      }
      const persistedTable = new TablesBillsRelationalRepository(relationalRuntime.db).replaceTablesFromAppState(db, [tableId]);
      if (!persistedTable?.ok) {
        throw new HttpError(400, "Sincronizzazione tavolo relazionale non valida.", {
          code: "RELATIONAL_TABLE_SYNC_FAILED",
          details: { reason: persistedTable?.reason ?? "unknown", tableId },
        });
      }
    }
    const fastAppStateWritten = await writeTableSyncAppStateFastDb(db, { tableId, auditEventIds: collectAuditEventIdsSince(db, auditEventStartIndex), requiresFullFallback: reservationSplit.changed });
    if (!fastAppStateWritten) await writeRoomDb(db, { metricLabel: "rooms.table.sync.appStateWrite", splitDomains: ["posSettings", "posReservationStates", "posReservationLocks", "auditEvents"] });
  
    sendJson(res, 200, {
      ok: true,
      table: updated,
    });
  }
  

  return {
    handlePosRoomChangeRequest,
    handlePosRoomChangeApprove,
    handlePosRoomChangeCancel,
    handleIntegrationLayoutTableSync,
  };
}
