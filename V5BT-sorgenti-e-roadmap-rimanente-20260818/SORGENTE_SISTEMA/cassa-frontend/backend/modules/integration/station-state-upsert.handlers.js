/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createStationStateUpsertHandlers({
  shouldPersistIntegrationStationHeartbeat,
  sanitizeIntegrationStationStateEntry,
  integrationStationStateKey,
  HttpError,
  SHOW_DEMO_STATIONS,
  assertUserLoginWorkstationAllowed,
  assignQueuedUnassignedIntegrationOrders,
  backfillStationOperatorAssignments,
  buildIntegrationMenuItemsByName,
  buildIntegrationStationStatesWithSessionRecovery,
  buildOrderCreateStationEligibilityChecker,
  chooseBestStationForOrder,
  createDefaultIntegrationState,
  createStationStateFastPathWorkingDb,
  deactivateActiveStationStateSiblingsForDevice,
  deviceStatusSplitRepository,
  enqueueStationStateMutation,
  filterPersistentIntegrationStationStates,
  filterStationPauseTransferDestinations,
  findIntegrationMenuItemForLine,
  getActiveStations,
  integrationOrderAssignmentStation,
  integrationStationStateMysqlRecordId,
  integrationStationsFastResponseCache,
  integrationWaitersFastResponseCache,
  isIntegrationOrderOpenForOperatorAssignment,
  maybeQueueNoActiveStationsNotification,
  normalizeClientApp,
  normalizeIntegrationStationName,
  normalizeIntegrationWorkflowStatus,
  normalizeStationPauseTransferMode,
  normalizeUsername,
  nowIso,
  parkPausedStationOperatorQueueOrders,
  pruneIntegrationState,
  publishIntegrationNotificationStreamRefresh,
  queueStationAvailabilityNotification,
  readDb,
  readJsonBody,
  refreshHealthSnapshotFromDb,
  rerouteOrderOperationalStation,
  resolveConfiguredIntegrationStations,
  resolvePrimaryIntegrationStation,
  resolveRequestPathname,
  resolveStationConfiguredPrintDefaults,
  restoreOrdersForReturnedStation,
  runtimeMetrics,
  sanitizeIntegrationOrder,
  sanitizePosSettings,
  sendJson,
  touchSessionHeartbeat,
  transferPausedStationOperatorQueueOrders,
  validateSessionContext,
  writeDb,
  writeIntegrationStationPresenceDb,
  writeIntegrationStationStatesDb,
}) {
  async function handleIntegrationStationStateUpsert(req, res) {
    const payload = await readJsonBody(req);
    const stationRaw = String(
      payload.station ?? payload.stationName ?? "",
    ).trim();
    if (!stationRaw) {
      throw new HttpError(400, "Postazione non valida.");
    }
    let station = normalizeIntegrationStationName(stationRaw);
    let operatorName =
      String(payload.operatorName ?? payload.operator ?? "Guest").trim() ||
      "Guest";
    let operatorUserId = String(
      payload.operatorUserId ?? payload.userId ?? "",
    ).trim();
    let operatorUsername = String(
      payload.operatorUsername ?? payload.username ?? "",
    ).trim();
    let operatorRole =
      String(payload.operatorRole ?? payload.role ?? "Non autenticato").trim() ||
      "Non autenticato";
    let active = payload.active !== false;
    const clientApp =
      normalizeClientApp(payload.clientApp ?? "postazione") || "postazione";
    const deviceUuid = String(payload.deviceUuid ?? "").trim();
    const updatedAtMs = Date.now();
    let sessionHeartbeatTouched = false;
  
    const sourceDb = await readDb(
      req.__stationStateFastPath === true ? { preferCache: true } : {},
    );
    const db = createStationStateFastPathWorkingDb(sourceDb, req.__stationStateFastPath === true);
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }
    if (!station) {
      station = resolvePrimaryIntegrationStation(db);
    }
    if (!station) {
      throw new HttpError(400, "Nessuna postazione configurata.");
    }
    if (active) {
      const heartbeatToken = String(payload.token ?? "").trim();
      const heartbeatUserId = String(
        payload.userId ?? operatorUserId ?? "",
      ).trim();
      if (!heartbeatToken || !heartbeatUserId || !deviceUuid) {
        active = false;
      } else {
        try {
          const { user, session } = validateSessionContext(db, {
            token: heartbeatToken,
            userId: heartbeatUserId,
            deviceUuid,
            clientApp,
          });
          const boundWorkstationId = String(session.workstationId ?? "").trim();
          const boundStation = normalizeIntegrationStationName(
            session.stationName ?? "",
          );
          if (!boundWorkstationId || !boundStation) {
            throw new HttpError(409, "Seleziona la postazione prima di attivarla.", {
              code: "WORKSTATION_SELECTION_REQUIRED",
            });
          }
          if (boundStation !== station) {
            throw new HttpError(403, "La postazione non coincide con la sessione attiva.", {
              code: "WORKSTATION_SESSION_MISMATCH",
              workstationId: boundWorkstationId,
              stationName: boundStation,
            });
          }
          assertUserLoginWorkstationAllowed(db, user, {
            workstationId: boundWorkstationId,
            stationName: boundStation,
          });
          sessionHeartbeatTouched = touchSessionHeartbeat(db, {
            userId: user.id,
            username: user.username,
            deviceUuid,
            clientApp,
            roomId: payload.roomId,
            roomName: payload.roomName,
          });
          operatorUserId = user.id;
          operatorUsername = user.username;
          operatorName =
            String(user.fullName ?? user.username ?? operatorName).trim() ||
            operatorName;
          operatorRole =
            String(user.roleLabel ?? user.role ?? operatorRole).trim() ||
            operatorRole;
        } catch (error) {
          if (
            [
              "WORKSTATION_SELECTION_REQUIRED",
              "WORKSTATION_SESSION_MISMATCH",
              "WORKSTATION_NOT_ALLOWED",
            ].includes(String(error?.code ?? ""))
          ) {
            throw error;
          }
          active = false;
        }
      }
    }
    const stationStates = buildIntegrationStationStatesWithSessionRecovery(db);
    const requestedStateKey = integrationStationStateKey({
      station,
      operatorUserId,
      operatorUsername,
      deviceUuid,
      isDemoFallback: false,
    });
    const requestedOperatorKey = String(operatorUserId || "").trim()
      ? `user:${String(operatorUserId || "").trim()}`
      : String(operatorUsername || "").trim()
        ? `username:${normalizeUsername(operatorUsername)}`
        : deviceUuid
          ? `device:${deviceUuid}`
          : "";
    if (active) {
      const occupiedByAnotherOperator = stationStates
        .map((entry) => sanitizeIntegrationStationStateEntry(entry))
        .find((entry) => {
          if (!entry || typeof entry !== "object") return false;
          if (normalizeIntegrationStationName(entry.station) !== station)
            return false;
          if (integrationStationStateKey(entry) === requestedStateKey)
            return false;
          if (
            entry.active === false ||
            entry.stale === true ||
            entry.realStation !== true
          )
            return false;
          const entryOperatorKey = String(entry.operatorUserId || "").trim()
            ? `user:${String(entry.operatorUserId || "").trim()}`
            : String(entry.operatorUsername || "").trim()
              ? `username:${normalizeUsername(entry.operatorUsername)}`
              : String(entry.deviceUuid || "").trim()
                ? `device:${String(entry.deviceUuid || "").trim()}`
                : "";
          if (
            deviceUuid &&
            String(entry.deviceUuid || "").trim() === deviceUuid
          ) {
            return false;
          }
          return Boolean(
            entryOperatorKey &&
            requestedOperatorKey &&
            entryOperatorKey !== requestedOperatorKey,
          );
        });
      if (occupiedByAnotherOperator) {
        throw new HttpError(
          409,
          `La postazione ${station} è già occupata da ${occupiedByAnotherOperator.operatorName || occupiedByAnotherOperator.operatorUsername || "un altro operatore"}.`,
          {
            code: "STATION_ALREADY_OCCUPIED",
            station,
            occupiedBy: {
              operatorUserId: occupiedByAnotherOperator.operatorUserId,
              operatorUsername: occupiedByAnotherOperator.operatorUsername,
              operatorName: occupiedByAnotherOperator.operatorName,
            },
          },
        );
      }
    }
    const currentEntry =
      stationStates.find(
        (entry) => integrationStationStateKey(entry) === requestedStateKey,
      ) || null;
    const wasActive = currentEntry ? currentEntry.active !== false : false;
    const configuredPrintDefaults = resolveStationConfiguredPrintDefaults(
      db,
      station,
    );
    const autoPrintOrders = Object.prototype.hasOwnProperty.call(
      payload,
      "autoPrintOrders",
    )
      ? payload.autoPrintOrders === true
      : configuredPrintDefaults.autoPrintOrders;
    const autoPrintPreconto = Object.prototype.hasOwnProperty.call(
      payload,
      "autoPrintPreconto",
    )
      ? payload.autoPrintPreconto === true
      : configuredPrintDefaults.autoPrintPreconto;
    const nextEntry = sanitizeIntegrationStationStateEntry({
      station,
      active,
      autoPrintOrders,
      autoPrintPreconto,
      operatorUserId,
      operatorUsername,
      operatorName,
      operatorRole,
      clientApp,
      deviceUuid,
      updatedAtMs,
    });
  
    const hasPauseTransferDirective = [
      "pauseTransferMode",
      "pauseTransferTargetStation",
      "transferTargetStation",
      "targetStation",
      "toStation",
    ].some((key) => Object.prototype.hasOwnProperty.call(payload, key));
    const hasSameDeviceActiveSibling =
      nextEntry.active !== false &&
      Boolean(nextEntry.deviceUuid) &&
      stationStates.some((entry) => {
        if (!entry || typeof entry !== "object") return false;
        if (integrationStationStateKey(entry) === requestedStateKey) return false;
        const safe = sanitizeIntegrationStationStateEntry(entry);
        return (
          safe.active !== false &&
          safe.stale !== true &&
          String(safe.deviceUuid ?? "").trim() === nextEntry.deviceUuid
        );
      });
    const shouldPersistHeartbeat = shouldPersistIntegrationStationHeartbeat(
      currentEntry,
      nextEntry,
      updatedAtMs,
    );
    const canUseStationStateFastPath =
      req.__stationStateFastPath === true &&
      currentEntry &&
      wasActive &&
      nextEntry.active !== false &&
      !sessionHeartbeatTouched &&
      !hasPauseTransferDirective &&
      !hasSameDeviceActiveSibling;
    if (req.__stationStateFastPath === true && !canUseStationStateFastPath) {
      req.__stationStateFastPath = false;
      await enqueueStationStateMutation(req, res, resolveRequestPathname(req), async () => handleIntegrationStationStateUpsert(req, res));
      return;
    }
    if (
      currentEntry &&
      currentEntry.active !== false &&
      nextEntry.active !== false &&
      !shouldPersistHeartbeat &&
      !sessionHeartbeatTouched &&
      !hasPauseTransferDirective &&
      !hasSameDeviceActiveSibling
    ) {
      runtimeMetrics.incrementCounter("stationStateHeartbeatPersistenceSkipped");
      runtimeMetrics.recordOperation("stationStateWorkflow", "heartbeatNoop", 0);
      req.__preserveIntegrationHotCaches = true;
      sendJson(res, 200, {
        ok: true,
        station: nextEntry,
        heartbeatOnly: true,
      });
      return;
    }
  
    const index = stationStates.findIndex(
      (entry) => integrationStationStateKey(entry) === requestedStateKey,
    );
    let siblingStationStateChanged = false;
    if (index >= 0) {
      stationStates[index] = nextEntry;
    } else {
      stationStates.push(nextEntry);
    }
    siblingStationStateChanged = deactivateActiveStationStateSiblingsForDevice(
      stationStates,
      nextEntry,
    );
  
    if (canUseStationStateFastPath && !siblingStationStateChanged) {
      runtimeMetrics.incrementCounter("stationStateHeartbeatPersistenceWrites");
      db.integration.stationStates = filterPersistentIntegrationStationStates(
        stationStates,
        resolveConfiguredIntegrationStations(db),
      );
      integrationStationsFastResponseCache.clear();
      integrationWaitersFastResponseCache.clear();
      db.integration.lastWriteAt = nowIso();
      if (
        deviceStatusSplitRepository.externalized &&
        typeof deviceStatusSplitRepository.upsertStationState === "function"
      ) {
        await deviceStatusSplitRepository.upsertStationState(nextEntry);
        refreshHealthSnapshotFromDb(db);
      } else {
        await writeIntegrationStationStatesDb(db, {
          stationStateIds: [integrationStationStateMysqlRecordId(nextEntry)],
        });
      }
      sendJson(res, 200, {
        ok: true,
        station: nextEntry,
        stationStateFastPath: true,
      });
      return;
    }
  
    db.integration.stationStates = stationStates;
    const hasOtherActiveSameStation = stationStates.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (integrationStationStateKey(entry) === requestedStateKey) return false;
      if (normalizeIntegrationStationName(entry.station) !== station)
        return false;
      const safe = sanitizeIntegrationStationStateEntry(entry);
      return (
        safe.active !== false &&
        safe.stale !== true &&
        (safe.realStation === true || SHOW_DEMO_STATIONS)
      );
    });
    const pauseTransferMode = normalizeStationPauseTransferMode(payload);
    const requestedPauseTransferTargetStation = normalizeIntegrationStationName(
      String(
        payload.pauseTransferTargetStation ??
          payload.transferTargetStation ??
          payload.targetStation ??
          payload.toStation ??
          "",
      ).trim(),
    );
    const activeStationsAfterStateUpdate = getActiveStations(
      { integration: { ...db.integration, stationStates } },
      { allowDemoStations: SHOW_DEMO_STATIONS },
    );
    const availableTransferStations =
      wasActive && nextEntry.active === false
        ? filterStationPauseTransferDestinations(
            activeStationsAfterStateUpdate,
            nextEntry,
          )
        : [];
    let rebalancedOrders = [];
    let parkedOrders = [];
    let restoredOrders = [];
    let assignedPendingOrders = [];
    let assignedOperatorOrders = [];
    const stationAvailabilityNotifications = [];
    const stationStateNotificationIdsBefore = new Set((Array.isArray(db.integration?.notifications) ? db.integration.notifications : []).map((entry) => String(entry?.id ?? "").trim()).filter(Boolean));
    const stationAvailabilityStateChanged = (wasActive && nextEntry.active === false) || (!wasActive && nextEntry.active !== false);
    if (wasActive && nextEntry.active === false) {
      const pauseQueueOptions = {
        station,
        pausedStation: nextEntry,
        includeUnassignedStationOrders: !hasOtherActiveSameStation,
        releaseInProgressOrders: true,
        getOrderAssignmentStation: integrationOrderAssignmentStation,
        isOrderOpenForOperatorAssignment:
          isIntegrationOrderOpenForOperatorAssignment,
        normalizeClientApp,
        normalizeStationName: normalizeIntegrationStationName,
        nowIso,
        resolveWorkflowStatus: (order) =>
          normalizeIntegrationWorkflowStatus(
            order.workflowStatus,
            order.items,
            order.completedAtMs,
            {
              lineRoutes: order.lineRoutes,
              ownerStation: order.ownerStation,
            },
          ),
        sanitizeOrder: sanitizeIntegrationOrder,
      };
      const pauseStationEligibility = buildOrderCreateStationEligibilityChecker({
        settings: sanitizePosSettings(db.posSettings, {
          menuItems: db.menuItems,
          users: db.users,
        }),
        menuItemsByName: buildIntegrationMenuItemsByName(db),
        findMenuItemForLine: findIntegrationMenuItemForLine,
      });
      if (
        pauseTransferMode === "transfer" &&
        availableTransferStations.length > 0
      ) {
        const selectedTransferStation = requestedPauseTransferTargetStation
          ? availableTransferStations.find(
              (entry) =>
                normalizeIntegrationStationName(entry.station) ===
                requestedPauseTransferTargetStation,
            )
          : null;
        const requestedTransferStationIsAvailable =
          !requestedPauseTransferTargetStation || selectedTransferStation;
        if (requestedTransferStationIsAvailable) {
          const choosePauseTransferStationForOrder = selectedTransferStation
            ? (_state, order) =>
                pauseStationEligibility(selectedTransferStation, order)
                  ? {
                      station: selectedTransferStation,
                      stationId: normalizeIntegrationStationName(
                        selectedTransferStation.station,
                      ),
                      reason: "operator_selected_pause_transfer_target",
                      candidates: availableTransferStations,
                    }
                  : {
                      station: null,
                      stationId: null,
                      reason: "selected_station_not_eligible",
                      candidates: [],
                    }
            : (state, order, options) =>
                chooseBestStationForOrder(state, order, {
                  ...options,
                  isStationEligible: pauseStationEligibility,
                });
          rebalancedOrders = transferPausedStationOperatorQueueOrders(db, {
            ...pauseQueueOptions,
            allowDemoStations: SHOW_DEMO_STATIONS,
            chooseBestStationForOrder: choosePauseTransferStationForOrder,
            rerouteOrderOperationalStation,
          });
        }
      }
      parkedOrders = parkPausedStationOperatorQueueOrders(db, pauseQueueOptions);
      if (rebalancedOrders.length > 0 || parkedOrders.length > 0) {
        db.integration.lastWriteAt = nowIso();
        db.meta.lastWriteAt = nowIso();
      }
    } else if (!wasActive && nextEntry.active !== false) {
      restoredOrders = restoreOrdersForReturnedStation(db, station, {
        nowIso: nowIso(),
      });
    }
    if (wasActive && nextEntry.active === false) {
      const notification = queueStationAvailabilityNotification(db, { eventType: "station_offline", severity: "warning", title: "Postazione offline", description: `La postazione ${station} è offline${operatorName ? ` (${operatorName})` : ""}.`, station, operatorName, deviceUuid, trigger: "station_state_upsert" });
      if (notification) stationAvailabilityNotifications.push(notification);
    } else if (!wasActive && nextEntry.active !== false) {
      const notification = queueStationAvailabilityNotification(db, { eventType: "station_online", severity: "success", title: "Postazione online", description: `La postazione ${station} è tornata online${operatorName ? ` (${operatorName})` : ""}.`, station, operatorName, deviceUuid, trigger: "station_state_upsert" });
      if (notification) stationAvailabilityNotifications.push(notification);
    }
    if (nextEntry.active !== false) {
      assignedPendingOrders = assignQueuedUnassignedIntegrationOrders(db, {
        station,
        source: "station_state_upsert",
      });
      assignedOperatorOrders = backfillStationOperatorAssignments(db, {
        station,
      });
    }
    const activeStationsAfterUpsert = activeStationsAfterStateUpdate;
    const noActiveStationsAlertChanged = maybeQueueNoActiveStationsNotification(
      db,
      activeStationsAfterUpsert,
      {
        trigger: "station_state_upsert",
      },
    );
    const shouldPersistStationState =
      shouldPersistHeartbeat ||
      siblingStationStateChanged ||
      rebalancedOrders.length > 0 ||
      parkedOrders.length > 0 ||
      restoredOrders.length > 0 ||
      assignedPendingOrders.length > 0 ||
      assignedOperatorOrders.length > 0 ||
      sessionHeartbeatTouched ||
      stationAvailabilityNotifications.length > 0 ||
      noActiveStationsAlertChanged;
    if (shouldPersistStationState) {
      integrationStationsFastResponseCache.clear();
      integrationWaitersFastResponseCache.clear();
      db.integration.lastWriteAt = nowIso();
      db.meta.lastWriteAt = nowIso();
      pruneIntegrationState(
        db.integration,
        resolveConfiguredIntegrationStations(db),
      );
      const stationStateNotificationIds = (Array.isArray(db.integration?.notifications) ? db.integration.notifications : []).map((entry) => String(entry?.id ?? "").trim()).filter((id) => id && !stationStateNotificationIdsBefore.has(id));
      const canUsePresenceFastWrite = !sessionHeartbeatTouched && rebalancedOrders.length === 0 && parkedOrders.length === 0 && restoredOrders.length === 0 && assignedPendingOrders.length === 0 && assignedOperatorOrders.length === 0;
      if (!(canUsePresenceFastWrite && await writeIntegrationStationPresenceDb(db, { stationStateIds: [integrationStationStateMysqlRecordId(nextEntry)], notificationIds: stationStateNotificationIds, syncNoActiveStationsAlert: noActiveStationsAlertChanged }))) await writeDb(db, {
        metricLabel: "stationState.upsert.appStateWrite",
        splitDomains: ["integration", "sessions", "auditEvents"],
        sessionsSync: { deleteMissing: false },
      });
    }
    if (noActiveStationsAlertChanged) {
      publishIntegrationNotificationStreamRefresh("station_availability_alert", {
        activeStations: activeStationsAfterUpsert.length,
      });
    }
    if (stationAvailabilityStateChanged || stationAvailabilityNotifications.length > 0) {
      publishIntegrationNotificationStreamRefresh("station_state_changed", {
        station,
        active: nextEntry.active !== false,
        stationState: nextEntry,
        rebalancedOrders,
        parkedOrders,
        restoredOrders,
        assignedPendingOrders,
        assignedOperatorOrders,
        notifications: stationAvailabilityNotifications.map(
          (notification) => notification.id,
        ),
      });
    }
  
    sendJson(res, 200, {
      ok: true,
      station: nextEntry,
      ...(availableTransferStations.length ? { availableTransferStations } : {}),
      ...(rebalancedOrders.length ? { rebalancedOrders } : {}),
      ...(parkedOrders.length ? { parkedOrders } : {}),
      ...(restoredOrders.length ? { restoredOrders } : {}),
      ...(assignedPendingOrders.length ? { assignedPendingOrders } : {}),
      ...(assignedOperatorOrders.length ? { assignedOperatorOrders } : {}),
    });
  }
  

  return {
    handleIntegrationStationStateUpsert,
  };
}
