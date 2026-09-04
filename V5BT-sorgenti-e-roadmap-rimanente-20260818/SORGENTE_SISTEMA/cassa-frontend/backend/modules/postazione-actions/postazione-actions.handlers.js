function toPostazioneActionSummary(action) {
  const type = String(action?.type ?? "").trim();
  if (!type) return null;

  if (type === "notify_waiters_item_out") {
    const itemName = String(action?.itemName ?? "Articolo").trim() || "Articolo";
    const station = String(action?.station ?? "Postazione").trim() || "Postazione";
    const scope = String(action?.scope ?? "").trim().toLowerCase();
    const scopeLabel =
      scope === "global"
        ? "tutte le postazioni"
        : `postazione ${station}`;
    return {
      type: "general",
      title: "Articolo terminato",
      description: `${itemName} terminato (${scopeLabel}).`,
      meta: { ...action, scope: scope || "station" },
    };
  }

  if (type === "order_partial_transfer") {
    const orderId = String(action?.parentOrderId ?? action?.orderId ?? "").trim();
    const toStation = String(action?.toStation ?? "altra postazione").trim() || "altra postazione";
    const itemName = String(action?.itemName ?? "articoli").trim() || "articoli";
    const count = Math.max(1, Math.trunc(Number(action?.itemsCount) || 1));
    return {
      type: "general",
      title: "Trasferimento parziale",
      description: `Comanda ${orderId ? `#${orderId} ` : ""}inoltrata a ${toStation} (${count}x ${itemName}).`,
      meta: { ...action },
    };
  }

  if (type === "item_disable" || type === "item_enable") {
    const itemName = String(action?.itemName ?? "Articolo").trim() || "Articolo";
    const scope = String(action?.scope ?? "").trim().toLowerCase();
    const station = String(action?.station ?? "").trim();
    const scopeLabel =
      scope === "global"
        ? "su tutte le postazioni"
        : station
          ? `sulla postazione ${station}`
          : "su una singola postazione";
    return {
      type: "general",
      title: type === "item_disable" ? "Articolo terminato" : "Disponibilita articolo",
      description:
        type === "item_disable"
          ? `${itemName}: terminato ${scopeLabel}.`
          : `${itemName}: riattivato ${scopeLabel}.`,
      meta: { ...action },
    };
  }

  if (type === "temp_item_add" || type === "temp_item_update" || type === "temp_item_delete") {
    const itemName =
      String(action?.item?.name ?? action?.name ?? action?.itemName ?? "Articolo").trim() || "Articolo";
    const actionLabel =
      type === "temp_item_add" ? "aggiunto" : type === "temp_item_update" ? "aggiornato" : "rimosso";
    return {
      type: "general",
      title: "Articolo temporaneo",
      description: `${itemName} ${actionLabel}.`,
      meta: { ...action },
    };
  }

  return {
    type: "general",
    title: "Azione postazione",
    description: `Azione ricevuta: ${type}.`,
    meta: { ...action },
  };
}

export function createPostazioneActionHandlers({
  appendAuditEvent,
  buildAuditActor,
  createDefaultIntegrationState,
  normalizeIntegrationItemKey,
  normalizeIntegrationStationName,
  normalizeIntegrationStationScope,
  nowIso,
  publishIntegrationNotificationStreamRefresh,
  queueIntegrationNotification,
  readDb,
  readJsonBody,
  resolveIntegrationItemAvailabilityInfo,
  sanitizeIntegrationItemAvailabilityMap,
  sendJson,
  validateSessionContext,
  writeDb,
}) {
  async function handlePostazioneFlags(_req, res) {
    sendJson(res, 200, {
      ok: true,
      allowTransferWaiting: false,
    });
  }

  async function handlePostazioneAction(req, res) {
    const payload = await readJsonBody(req);
    const action = payload && typeof payload === "object" ? payload : {};
    const actionType = String(action?.type ?? "").trim();
    const summary = toPostazioneActionSummary(action);
    if (!summary) {
      sendJson(res, 200, { ok: true, received: false });
      return;
    }

    const db = await readDb();
    const { user, session } = validateSessionContext(db, payload);
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }

    const nextItemAvailability = sanitizeIntegrationItemAvailabilityMap(
      db.integration.itemAvailability
    );
    const itemNameKey = normalizeIntegrationItemKey(action?.itemName);
    const actionScope = String(action?.scope ?? "").trim().toLowerCase();
    const actionStation = normalizeIntegrationStationScope(action?.station ?? action?.stationName ?? "");
    let availabilityChanged = false;
    const availabilityBefore = itemNameKey
      ? resolveIntegrationItemAvailabilityInfo(
          { id: itemNameKey, name: action?.itemName },
          nextItemAvailability,
          actionStation
        )
      : null;
    if (itemNameKey) {
      if (actionType === "item_disable" || actionType === "notify_waiters_item_out") {
        if (actionScope === "global") {
          if (nextItemAvailability[itemNameKey] !== false) {
            nextItemAvailability[itemNameKey] = false;
            availabilityChanged = true;
          }
        } else {
          const currentEntry = nextItemAvailability[itemNameKey];
          const currentStations =
            currentEntry && typeof currentEntry === "object" && Array.isArray(currentEntry.stations)
              ? currentEntry.stations.map((entry) => normalizeIntegrationStationName(entry)).filter(Boolean)
              : [];
          if (actionStation && !currentStations.includes(actionStation)) {
            currentStations.push(actionStation);
            nextItemAvailability[itemNameKey] = {
              scope: "station",
              stations: currentStations,
              updatedAt: nowIso(),
              updatedBy: String(action?.station ?? action?.userName ?? action?.username ?? "").trim().slice(0, 64),
            };
            availabilityChanged = true;
          } else if (currentStations.length > 0) {
            nextItemAvailability[itemNameKey] = {
              scope: "station",
              stations: currentStations,
              updatedAt: nowIso(),
              updatedBy: String(action?.station ?? action?.userName ?? action?.username ?? "").trim().slice(0, 64),
            };
          } else if (actionStation && nextItemAvailability[itemNameKey] !== false) {
            nextItemAvailability[itemNameKey] = {
              scope: "station",
              stations: [actionStation],
              updatedAt: nowIso(),
              updatedBy: String(action?.station ?? action?.userName ?? action?.username ?? "").trim().slice(0, 64),
            };
            availabilityChanged = true;
          }
        }
      } else if (actionType === "item_enable") {
        if (actionScope === "global" || !actionStation) {
          if (Object.prototype.hasOwnProperty.call(nextItemAvailability, itemNameKey)) {
            delete nextItemAvailability[itemNameKey];
            availabilityChanged = true;
          }
        } else {
          const currentEntry = nextItemAvailability[itemNameKey];
          if (currentEntry === false) {
            delete nextItemAvailability[itemNameKey];
            availabilityChanged = true;
          } else if (currentEntry && typeof currentEntry === "object") {
            const currentStations = Array.isArray(currentEntry.stations)
              ? currentEntry.stations.map((entry) => normalizeIntegrationStationName(entry)).filter(Boolean)
              : [];
            const nextStations = currentStations.filter((entry) => entry !== actionStation);
            if (nextStations.length === 0) {
              delete nextItemAvailability[itemNameKey];
            } else {
              nextItemAvailability[itemNameKey] = {
                scope: "station",
                stations: nextStations,
                updatedAt: nowIso(),
                updatedBy: String(action?.station ?? action?.userName ?? action?.username ?? "").trim().slice(0, 64),
              };
            }
            availabilityChanged = true;
          }
        }
      }
    }
    if (availabilityChanged) {
      db.integration.itemAvailability = nextItemAvailability;
      db.integration.lastWriteAt = nowIso();
      appendAuditEvent(db, {
        ...buildAuditActor(user, { ...payload, deviceUuid: session.deviceUuid, sessionId: session.id }),
        action: actionType === "item_enable" ? "menu.item_availability_enabled" : "menu.item_availability_disabled",
        entityType: "menu_item",
        entityId: itemNameKey || String(action?.itemName ?? "").trim() || "menu_item",
        payload: {
          itemName: String(action?.itemName ?? "").trim(),
          scope: actionScope === "global" ? "global" : "station",
          station: actionStation || null,
        },
        before: availabilityBefore,
        after: resolveIntegrationItemAvailabilityInfo(
          { id: itemNameKey, name: action?.itemName },
          nextItemAvailability,
          actionStation
        ),
      });
    }

    const notification = queueIntegrationNotification(db, summary);
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);
    publishIntegrationNotificationStreamRefresh(
      actionType === "item_enable"
        ? "item_enable"
        : actionType === "item_disable" || actionType === "notify_waiters_item_out"
          ? "item_disable"
          : "postazione_action",
      {
        actionType,
        itemName: String(action?.itemName ?? "").trim(),
        station: actionStation || null,
      }
    );

    sendJson(res, 200, {
      ok: true,
      received: true,
      notification,
    });
  }

  return {
    "postazione.flags": handlePostazioneFlags,
    "postazione.actions": handlePostazioneAction,
  };
}
