/**
 * Write model delle sette route di scrittura di `settings`
 * (P2b, dominio `configuration`).
 *
 * Possiede l'unico accesso all'app-state per queste route: gli handler non
 * vedono piu `db`. I corpi arrivano invariati da `settings.handlers.js`,
 * compresi i controlli di permesso e i messaggi dei 403, che restano distinti
 * per route.
 *
 * Due delle sette non seguono lo schema delle altre e vanno lette come casi a
 * se: `saveUserPaymentPreferences` scrive sull'utente e non sulle impostazioni,
 * e `ringMobileDevice` non scrive impostazioni affatto ma accoda una notifica,
 * quindi attraversa il dominio `messaging`.
 */
import {
  findRoomTableExpansionViolations,
  looksLikeIpAddress,
  normalizeIp,
  writeUserPaymentPreferences,
} from "./settings.handlers.js";

export function createSettingsWriteModel({
  HttpError,
  syncPosTableFinancialsFromIntegrationOrders,
  shouldAutoDeliverReadyIntegrationOrder,
  sanitizeIntegrationOrder,
  markIntegrationOrderDeliveredForWorkflow,
  buildAuditActor,
  applyIntegrationWorkflowRouteTransitions,
  appendAuditEvent,
  buildPosAreasPayload,
  buildPosSettingsPayload,
  collectActiveWaitersInRoom,
  hasPermission,
  isPosPrivilegedRole,
  nowIso,
  publishIntegrationNotificationStreamRefresh,
  queueIntegrationNotification,
  readDb,
  resolveSettingsLastWriteAt,
  resolveSettingsVersion,
  sanitizePosSettings,
  touchSettingsMetadata,
  validateSessionContext,
  writeDb,
}) {
  function publishSettingsUpdated(db, source) {
    if (typeof publishIntegrationNotificationStreamRefresh !== "function")
      return;
    const lastWriteAt = resolveSettingsLastWriteAt(db?.meta);
    const version = resolveSettingsVersion(db?.meta);
    publishIntegrationNotificationStreamRefresh("settings_updated", {
      source: String(source || "settings").trim() || "settings",
      lastWriteAt,
      version,
      settingsVersion: version,
    });
  }

  async function saveposAreas(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    if (
      !isPosPrivilegedRole(user.role) &&
      !hasPermission(user, "manage_menu")
    ) {
      throw new HttpError(
        403,
        "Utente non autorizzato alla configurazione aree e stampanti.",
      );
    }

    const currentSettings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const settings = sanitizePosSettings(
      {
        ...db.posSettings,
        locale: payload.locale ?? db.posSettings?.locale,
        locales: payload.locales ?? db.posSettings?.locales,
        demoMode: payload.demoMode ?? db.posSettings?.demoMode,
        mobileDevices: payload.mobileDevices ?? db.posSettings?.mobileDevices,
        activities: payload.activities ?? db.posSettings?.activities,
        activityRoomBindings:
          payload.activityRoomBindings ?? db.posSettings?.activityRoomBindings,
        areas: payload.areas,
        menus: payload.menus ?? db.posSettings?.menus,
        areaMenus: payload.areaMenus,
        priceLists: payload.priceLists ?? db.posSettings?.priceLists,
        priceListSchedules:
          payload.priceListSchedules ?? db.posSettings?.priceListSchedules,
        menuSchedules: payload.menuSchedules ?? db.posSettings?.menuSchedules,
        printers: payload.printers,
        fiscalDevices: payload.fiscalDevices ?? db.posSettings?.fiscalDevices,
        workstations: payload.workstations ?? db.posSettings?.workstations,
      },
      {
        menuItems: db.menuItems,
        users: db.users,
      },
    );
    const tableExpansionViolations = findRoomTableExpansionViolations({
      currentSettings,
      nextSettings: settings,
      db,
      collectActiveWaitersInRoom,
    });
    if (tableExpansionViolations.length > 0) {
      throw new HttpError(
        409,
        "Puoi aggiungere tavoli solo quando la sala non ha tavoli occupati e nessun utente attivo.",
        {
          code: "ROOM_TABLE_EXPANSION_BLOCKED",
          details: {
            rooms: tableExpansionViolations,
          },
        },
      );
    }
    db.posSettings = settings;
    touchSettingsMetadata(db);
    await writeDb(db);
    publishSettingsUpdated(db, "pos-areas");

    const lastWriteAt = resolveSettingsLastWriteAt(db.meta);
    const version = resolveSettingsVersion(db.meta);
    return {
      ...buildPosAreasPayload(db, settings),
      lastWriteAt,
      version,
    };
  }

  async function savePrintPreferences(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    if (
      !isPosPrivilegedRole(user.role) &&
      !hasPermission(user, "manage_menu")
    ) {
      throw new HttpError(
        403,
        "Utente non autorizzato alla configurazione stampa.",
      );
    }

    const settings = sanitizePosSettings(
      {
        ...db.posSettings,
        printPreferences: payload.printPreferences,
      },
      {
        menuItems: db.menuItems,
        users: db.users,
      },
    );
    db.posSettings = settings;
    touchSettingsMetadata(db);
    await writeDb(db);
    publishSettingsUpdated(db, "print-preferences");

    const lastWriteAt = resolveSettingsLastWriteAt(db.meta);
    const version = resolveSettingsVersion(db.meta);
    return {
      ...buildPosSettingsPayload(settings),
      lastWriteAt,
      version,
    };
  }

  async function saveGeneralSettings(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    if (
      !isPosPrivilegedRole(user.role) &&
      !hasPermission(user, "manage_menu")
    ) {
      throw new HttpError(
        403,
        "Utente non autorizzato alla configurazione generale.",
      );
    }

    const settings = sanitizePosSettings(
      {
        ...db.posSettings,
        sideBars: payload.sideBars ?? db.posSettings?.sideBars,
        demoMode: payload.demoMode ?? db.posSettings?.demoMode,
        mobileDevices: payload.mobileDevices ?? db.posSettings?.mobileDevices,
        orderWorkflow: payload.orderWorkflow ?? db.posSettings?.orderWorkflow,
      },
      {
        menuItems: db.menuItems,
        users: db.users,
      },
    );
    db.posSettings = settings;
    touchSettingsMetadata(db);
    await writeDb(db);
    publishSettingsUpdated(db, "general-settings");

    const lastWriteAt = resolveSettingsLastWriteAt(db.meta);
    const version = resolveSettingsVersion(db.meta);
    return {
      ...buildPosSettingsPayload(settings),
      lastWriteAt,
      version,
    };
  }

  async function savePaymentMethods(payload) {
    const db = await readDb();
    validateSessionContext(db, payload);

    const settings = sanitizePosSettings(
      {
        ...db.posSettings,
        paymentMethods: payload.methods,
        smartCash: payload.smartCash ?? db.posSettings?.smartCash,
      },
      { menuItems: db.menuItems },
    );
    db.posSettings = settings;
    touchSettingsMetadata(db);
    await writeDb(db);
    publishSettingsUpdated(db, "payment-methods");

    const lastWriteAt = resolveSettingsLastWriteAt(db.meta);
    const version = resolveSettingsVersion(db.meta);
    return {
      ...buildPosSettingsPayload(settings),
      lastWriteAt,
      version,
    };
  }

  async function saveUserPaymentPreferences(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    const userId = String(user?.id ?? "").trim();
    const targetUser =
      (Array.isArray(db.users)
        ? db.users.find((entry) => String(entry?.id ?? "").trim() === userId)
        : null) ?? user;
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    const preferences = writeUserPaymentPreferences(
      targetUser,
      payload.preferences ?? payload,
      updatedAt,
    );
    if (db.meta && typeof db.meta === "object") {
      db.meta.lastWriteAt = updatedAt;
    }
    await writeDb(db);

    return {
      ok: true,
      preferences,
      updatedAt,
    };
  }

  async function saveMobileDevices(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    if (
      !isPosPrivilegedRole(user.role) &&
      !hasPermission(user, "manage_menu")
    ) {
      throw new HttpError(
        403,
        "Utente non autorizzato alla configurazione palmari.",
      );
    }

    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    const mobileDevices = (
      Array.isArray(payload.mobileDevices) ? payload.mobileDevices : []
    ).map((device) => ({
      ...device,
      updatedAt,
      updatedBy: user.username || user.id,
    }));
    const settings = sanitizePosSettings(
      {
        ...db.posSettings,
        mobileDevices,
      },
      {
        menuItems: db.menuItems,
        users: db.users,
      },
    );
    db.posSettings = settings;
    touchSettingsMetadata(db);
    await writeDb(db);
    publishSettingsUpdated(db, "mobile-devices");

    const lastWriteAt = resolveSettingsLastWriteAt(db.meta);
    const version = resolveSettingsVersion(db.meta);
    return {
      ...buildPosSettingsPayload(settings),
      lastWriteAt,
      version,
    };
  }

  async function ringMobileDevice(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    if (
      !isPosPrivilegedRole(user.role) &&
      !hasPermission(user, "manage_menu")
    ) {
      throw new HttpError(403, "Utente non autorizzato alla gestione palmari.");
    }
    const deviceId = String(
      payload.deviceId ?? payload.deviceUuid ?? "",
    ).trim();
    if (!deviceId) {
      throw new HttpError(400, "Palmare non valido.");
    }
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    const configuredDevice =
      (settings.mobileDevices || []).find(
        (device) => device.deviceId === deviceId,
      ) ?? null;
    const deviceName =
      String(
        payload.deviceName ?? configuredDevice?.deviceName ?? deviceId,
      ).trim() || deviceId;
    const targetClientIp = normalizeIp(
      payload.clientIp ??
        configuredDevice?.clientIp ??
        configuredDevice?.ip ??
        (looksLikeIpAddress(deviceId) ? deviceId : ""),
    );
    const targetDeviceUuid = looksLikeIpAddress(deviceId)
      ? ""
      : String(
          payload.deviceUuid ??
            configuredDevice?.deviceUuid ??
            configuredDevice?.uuid ??
            deviceId,
        ).trim();
    const targetDeviceIdAliases = [
      deviceId,
      payload.deviceUuid,
      configuredDevice?.deviceUuid,
      configuredDevice?.uuid,
      configuredDevice?.id,
    ]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
    const notification = queueIntegrationNotification(db, {
      type: "general",
      title: "Squillo palmare",
      description: `Squillo richiesto per ${deviceName}.`,
      meta: {
        eventType: "handheld_ring",
        severity: "attention",
        targetClientApp: "mobile-frontend",
        ...(targetDeviceUuid ? { targetDeviceUuid } : {}),
        ...(targetClientIp ? { targetClientIp } : {}),
        targetDeviceIdAliases,
        deviceId,
        deviceName,
        requestedByUserId: user.id,
        requestedByUsername: user.username,
      },
    });
    db.meta.lastWriteAt =
      typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    await writeDb(db);
    if (typeof publishIntegrationNotificationStreamRefresh === "function") {
      publishIntegrationNotificationStreamRefresh("handheld_ring", {
        id: notification?.id ?? "",
        ...(targetDeviceUuid ? { targetDeviceUuid } : {}),
        ...(targetClientIp ? { targetClientIp } : {}),
        deviceId,
      });
    }
    return {
      ok: true,
      notification,
    };
  }

  async function saveOrderWorkflow(payload) {
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    if (
      !isPosPrivilegedRole(user.role) &&
      !hasPermission(user, "manage_settings") &&
      !hasPermission(user, "manage_menu")
    ) {
      throw new HttpError(
        403,
        "Utente non autorizzato alla configurazione comande.",
      );
    }
    const settings = sanitizePosSettings(
      {
        ...db.posSettings,
        orderWorkflow: payload.orderWorkflow,
      },
      {
        menuItems: db.menuItems,
        users: db.users,
      },
    );
    db.posSettings = settings;
    if (
      settings.orderWorkflow.deliveryConfirmationEnabled === false &&
      Array.isArray(db.integration?.orders)
    ) {
      let autoDeliveredCount = 0;
      const actor = buildAuditActor(user, payload);
      db.integration.orders = db.integration.orders.map((entry, index) => {
        const currentOrder = sanitizeIntegrationOrder(
          entry,
          String(index + 1).padStart(5, "0"),
        );
        if (!shouldAutoDeliverReadyIntegrationOrder(currentOrder, settings)) {
          return currentOrder;
        }
        let nextOrder = markIntegrationOrderDeliveredForWorkflow(
          currentOrder,
          currentOrder.id,
        );
        const routeTransition = applyIntegrationWorkflowRouteTransitions(
          nextOrder,
          currentOrder.workflowStatus,
          {
            userId: user.id,
            username: user.username,
          },
        );
        nextOrder = sanitizeIntegrationOrder(
          {
            ...nextOrder,
            lineRoutes: routeTransition.lineRoutes,
            updatedAt: nowIso(),
          },
          currentOrder.id,
        );
        autoDeliveredCount += 1;
        appendAuditEvent(db, {
          ...actor,
          action: "order.auto_delivered_by_workflow_setting",
          entityType: "integration_order",
          entityId: nextOrder.id,
          roomId: nextOrder.roomId || actor.roomId,
          payload: {
            orderId: nextOrder.id,
            previousStatus: currentOrder.workflowStatus,
            nextStatus: nextOrder.workflowStatus,
          },
        });
        return nextOrder;
      });
      if (autoDeliveredCount > 0) {
        syncPosTableFinancialsFromIntegrationOrders(db);
        if (db.integration && typeof db.integration === "object") {
          db.integration.lastWriteAt = nowIso();
        }
      }
    }
    touchSettingsMetadata(db);
    await writeDb(db);
    const lastWriteAt = resolveSettingsLastWriteAt(db.meta);
    const version = resolveSettingsVersion(db.meta);
    return {
      ok: true,
      orderWorkflow: settings.orderWorkflow,
      lastWriteAt,
      settingsVersion: version,
      version,
    };
  }

  return {
    saveposAreas,
    savePrintPreferences,
    saveGeneralSettings,
    savePaymentMethods,
    saveUserPaymentPreferences,
    saveMobileDevices,
    ringMobileDevice,
    saveOrderWorkflow,
  };
}
