export function createMigrateDbSecurity(deps = {}) {
  const {
    ensureArrayProperty,
    ensurePaymentProviderPersistence,
    createDefaultIntegrationState,
    buildIntegrationStationStates,
    nowIso,
    sanitizeIntegrationOrder,
    sanitizeIntegrationNotification,
    sanitizeIntegrationFulfillmentHistoryEvent,
    INTEGRATION_MAX_ORDER_FULFILLMENT_HISTORY,
    buildIntegrationFulfillmentAnomalyStats,
    sanitizeIntegrationItemAvailabilityMap,
    sanitizeIntegrationTableGroups,
    sanitizeIntegrationStationStateEntry,
    integrationStationStateKey,
    INTEGRATION_STATIONS,
    INTEGRATION_MAX_STATION_STATES,
    pruneIntegrationState,
    cloneDefaultPosSettings,
    ensurePizzaInRivaConfiguration,
    parsePinHash,
    hashPin,
    normalizeUserRole,
    roleLabelFromRole,
    sanitizePermissionList,
    resolveDefaultAuthorizedRoomIdsForUser,
    sanitizeAuthorizedRoomIds,
    sanitizeEnabledRoomIds,
    resolveDefaultPaymentMethodIdsForUser,
    sanitizeUserPaymentMethodIds,
    hashSessionToken,
    randomUUID,
    normalizeClientApp,
    DEFAULT_SALE_SESSION_TEMPLATES,
    normalizeTemplate,
    DEFAULT_MENU_ITEMS,
    normalizeMenuItem,
    normalizeMenuItemVariants,
    menuItemRequiresVariantSelection,
    isPremiumAlcoholMenuItem,
    sanitizePosSettings,
    sanitizePrintSpoolJobs,
    prunePrintSpoolJobs,
    buildPosRoomListFromSettings,
    sanitizePosRoomChangeRequestRecord,
    sanitizePosReservationStateRecord,
    sanitizePosReservationRecord,
    sanitizePosReservationLockRecord,
    localDateKeyFromIso,
    localDateKeyFromDate,
    sanitizeSmartCustomer,
    shouldSeedDemoData,
    DEFAULT_SMART_CUSTOMERS,
    pad2,
    sanitizeSmartNonFiscalEntry,
    sanitizePaymentRecord,
    sanitizePaymentContainerRecord,
    sanitizePaymentPartRecord,
    sanitizePaymentTransactionRecord,
    sanitizeCashTxDenomRecord,
    sanitizeAuditEvents,
    pruneAuditEvents,
    sanitizeFiscalReceipt,
  } = deps;

  return function migrateDbSecurity(data) {
  let changed = false;

  changed = ensureArrayProperty(data, "users") || changed;
  changed = ensureArrayProperty(data, "userGroups") || changed;
  changed = ensureArrayProperty(data, "sessions") || changed;
  changed = ensureArrayProperty(data, "saleSessionTemplates") || changed;
  changed = ensureArrayProperty(data, "menuItems") || changed;
  changed = ensureArrayProperty(data, "saleSessions") || changed;
  changed = ensureArrayProperty(data, "solarClosures") || changed;
  changed = ensureArrayProperty(data, "payments") || changed;
  changed = ensureArrayProperty(data, "paymentContainers") || changed;
  changed = ensureArrayProperty(data, "paymentParts") || changed;
  changed = ensureArrayProperty(data, "paymentTransactions") || changed;
  changed = ensureArrayProperty(data, "paymentProviderTransactions") || changed;
  changed = ensureArrayProperty(data, "cashTxDenoms") || changed;
  changed = ensureArrayProperty(data, "handheldCashSessions") || changed;
  changed = ensureArrayProperty(data, "commercialBenefitCampaigns") || changed;
  changed = ensureArrayProperty(data, "commercialBenefitCoupons") || changed;
  changed = ensureArrayProperty(data, "commercialBenefitApplications") || changed;
  changed = ensureArrayProperty(data, "commercialBenefitRedemptions") || changed;
  for (const obsoleteKey of ["gloryOperations", "gloryOperationEvents", "gloryState"]) {
    if (Object.hasOwn(data, obsoleteKey)) {
      delete data[obsoleteKey];
      changed = true;
    }
  }
  ensurePaymentProviderPersistence(data);
  changed = ensureArrayProperty(data, "fiscalReceipts") || changed;
  changed = ensureArrayProperty(data, "fiscalEvents") || changed;
  changed = ensureArrayProperty(data, "printSpoolJobs") || changed;
  changed = ensureArrayProperty(data, "smartNonFiscal") || changed;
  changed = ensureArrayProperty(data, "smartCustomers") || changed;
  changed = ensureArrayProperty(data, "auditEvents") || changed;
  changed = ensureArrayProperty(data, "posRoomChangeRequests") || changed;
  changed = ensureArrayProperty(data, "posTableRoomMoveRequests") || changed;
  changed = ensureArrayProperty(data, "posReservationStates") || changed;
  changed = ensureArrayProperty(data, "posReservationLocks") || changed;

  if (!data.integration || typeof data.integration !== "object") {
    data.integration = createDefaultIntegrationState();
    changed = true;
  }

  if (!Array.isArray(data.integration.orders)) {
    data.integration.orders = [];
    changed = true;
  }

  if (!Array.isArray(data.integration.barChargeReplacements)) {
    data.integration.barChargeReplacements = [];
    changed = true;
  }

  if (!Array.isArray(data.integration.orderComps)) {
    data.integration.orderComps = [];
    changed = true;
  }

  if (!Array.isArray(data.integration.orderCorrections)) {
    data.integration.orderCorrections = [];
    changed = true;
  }

  if (!Array.isArray(data.integration.orderCorrectionRequests)) {
    data.integration.orderCorrectionRequests = [];
    changed = true;
  }

  if (!Array.isArray(data.integration.notifications)) {
    data.integration.notifications = [];
    changed = true;
  }

  if (!Array.isArray(data.integration.orderFulfillmentHistory)) {
    data.integration.orderFulfillmentHistory = [];
    changed = true;
  }

  if (
    !data.integration.itemAvailability ||
    typeof data.integration.itemAvailability !== "object" ||
    Array.isArray(data.integration.itemAvailability)
  ) {
    data.integration.itemAvailability = {};
    changed = true;
  }

  if (!Array.isArray(data.integration.tableGroups)) {
    data.integration.tableGroups = [];
    changed = true;
  }

  if (!Array.isArray(data.integration.stationStates)) {
    data.integration.stationStates = buildIntegrationStationStates(data.integration);
    changed = true;
  }

  if (!data.integration.sequence || typeof data.integration.sequence !== "object") {
    data.integration.sequence = {
      order: 1,
      notification: 1,
    };
    changed = true;
  }

  const sequenceOrder = Number.parseInt(String(data.integration.sequence.order ?? ""), 10);
  if (!Number.isFinite(sequenceOrder) || sequenceOrder <= 0) {
    data.integration.sequence.order = 1;
    changed = true;
  } else {
    data.integration.sequence.order = sequenceOrder;
  }

  const sequenceNotification = Number.parseInt(
    String(data.integration.sequence.notification ?? ""),
    10
  );
  if (!Number.isFinite(sequenceNotification) || sequenceNotification <= 0) {
    data.integration.sequence.notification = 1;
    changed = true;
  } else {
    data.integration.sequence.notification = sequenceNotification;
  }

  if (
    typeof data.integration.lastWriteAt !== "string" ||
    data.integration.lastWriteAt.trim().length === 0
  ) {
    data.integration.lastWriteAt = nowIso();
    changed = true;
  }

  const normalizedIntegrationOrders = data.integration.orders
    .filter((order) => order && typeof order === "object")
    .map((order, index) => sanitizeIntegrationOrder(order, String(index + 1).padStart(5, "0")));
  if (JSON.stringify(data.integration.orders) !== JSON.stringify(normalizedIntegrationOrders)) {
    changed = true;
  }
  data.integration.orders = normalizedIntegrationOrders;

  const normalizedIntegrationNotifications = data.integration.notifications
    .filter((notification) => notification && typeof notification === "object")
    .map((notification, index) =>
      sanitizeIntegrationNotification(
        notification,
        `ntf_${String(index + 1).padStart(7, "0")}`
      )
    );
  if (
    JSON.stringify(data.integration.notifications) !==
    JSON.stringify(normalizedIntegrationNotifications)
  ) {
    changed = true;
  }
  data.integration.notifications = normalizedIntegrationNotifications;

  const normalizedFulfillmentHistory = data.integration.orderFulfillmentHistory
    .map((event, index) =>
      sanitizeIntegrationFulfillmentHistoryEvent(event, `fulfillment_${index + 1}`)
    )
    .filter((event) => event !== null)
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
    .slice(-INTEGRATION_MAX_ORDER_FULFILLMENT_HISTORY);
  if (
    JSON.stringify(data.integration.orderFulfillmentHistory) !==
    JSON.stringify(normalizedFulfillmentHistory)
  ) {
    changed = true;
  }
  data.integration.orderFulfillmentHistory = normalizedFulfillmentHistory;

  const normalizedFulfillmentAnomalyStats = buildIntegrationFulfillmentAnomalyStats(
    data.integration.orderFulfillmentHistory
  );
  if (
    JSON.stringify(data.integration.fulfillmentAnomalyStats) !==
    JSON.stringify(normalizedFulfillmentAnomalyStats)
  ) {
    changed = true;
  }
  data.integration.fulfillmentAnomalyStats = normalizedFulfillmentAnomalyStats;

  const normalizedItemAvailability = sanitizeIntegrationItemAvailabilityMap(
    data.integration.itemAvailability
  );
  if (
    JSON.stringify(data.integration.itemAvailability) !==
    JSON.stringify(normalizedItemAvailability)
  ) {
    changed = true;
  }
  data.integration.itemAvailability = normalizedItemAvailability;

  const normalizedTableGroups = sanitizeIntegrationTableGroups(data.integration.tableGroups);
  if (JSON.stringify(data.integration.tableGroups) !== JSON.stringify(normalizedTableGroups)) {
    changed = true;
  }
  data.integration.tableGroups = normalizedTableGroups;

  const normalizedStationStates = data.integration.stationStates
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => sanitizeIntegrationStationStateEntry(entry));
  const stationStateByKey = new Map();
  normalizedStationStates.forEach((entry) => {
    const key = integrationStationStateKey(entry);
    const current = stationStateByKey.get(key);
    if (!current || entry.updatedAtMs >= current.updatedAtMs) {
      stationStateByKey.set(key, entry);
    }
  });
  const completedStationStates = [...stationStateByKey.values()]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, INTEGRATION_MAX_STATION_STATES);
  if (JSON.stringify(data.integration.stationStates) !== JSON.stringify(completedStationStates)) {
    changed = true;
  }
  data.integration.stationStates = completedStationStates;

  const maxOrderSeq = data.integration.orders.reduce((max, order) => {
    const parsed = Number.parseInt(String(order.id ?? "").replace(/[^\d]/g, ""), 10);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
  if (data.integration.sequence.order <= maxOrderSeq) {
    data.integration.sequence.order = maxOrderSeq + 1;
    changed = true;
  }

  const maxNotificationSeq = data.integration.notifications.reduce((max, notification) => {
    const parsed = Number.parseInt(String(notification.id ?? "").replace(/[^\d]/g, ""), 10);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
  if (data.integration.sequence.notification <= maxNotificationSeq) {
    data.integration.sequence.notification = maxNotificationSeq + 1;
    changed = true;
  }

  if (!data.posSettings || typeof data.posSettings !== "object") {
    data.posSettings = cloneDefaultPosSettings();
    changed = true;
  }

  if (!data.meta || typeof data.meta !== "object") {
    data.meta = {};
    changed = true;
  }

  changed = ensurePizzaInRivaConfiguration(data) || changed;
  const configuredWorkstations = [];
  if (Array.isArray(data.posSettings?.workstations)) {
    configuredWorkstations.push(...data.posSettings.workstations);
  }
  for (const area of Array.isArray(data.posSettings?.areas) ? data.posSettings.areas : []) {
    if (Array.isArray(area?.workstations)) {
      configuredWorkstations.push(...area.workstations);
    }
  }
  for (const room of Array.isArray(data.posSettings?.rooms) ? data.posSettings.rooms : []) {
    if (Array.isArray(room?.workstations)) {
      configuredWorkstations.push(...room.workstations);
    }
  }
  const configuredStationNames = configuredWorkstations.map(
    (workstation) => workstation?.stationName ?? workstation?.station ?? workstation?.name ?? workstation?.id
  );
  changed = pruneIntegrationState(data.integration, configuredStationNames) || changed;

  for (const user of data.users) {
    if (typeof user.pinHash !== "string" || !parsePinHash(user.pinHash)) {
      if (typeof user.pin === "string" && /^\d{4,6}$/.test(user.pin)) {
        user.pinHash = hashPin(user.pin);
      } else {
        user.pinHash = "";
      }
      changed = true;
    }

    if ("pin" in user) {
      delete user.pin;
      changed = true;
    }

    const normalizedRole = normalizeUserRole(user.role);
    if (user.role !== normalizedRole) {
      user.role = normalizedRole;
      changed = true;
    }

    const normalizedRoleLabel = roleLabelFromRole(user.role);
    if (user.roleLabel !== normalizedRoleLabel) {
      user.roleLabel = normalizedRoleLabel;
      changed = true;
    }

    const normalizedPermissions = sanitizePermissionList(user.permissions, {
      role: user.role,
      includeRoleDefaults: !Array.isArray(user.permissions),
    });
    if (JSON.stringify(user.permissions ?? null) !== JSON.stringify(normalizedPermissions)) {
      user.permissions = normalizedPermissions;
      changed = true;
    }

    const defaultAuthorizedRoomIds = Array.isArray(user.authorizedRoomIds)
      ? user.authorizedRoomIds
      : resolveDefaultAuthorizedRoomIdsForUser(user, data.posSettings);
    const normalizedAuthorizedRoomIds = sanitizeAuthorizedRoomIds(defaultAuthorizedRoomIds, data.posSettings);
    if (JSON.stringify(user.authorizedRoomIds ?? null) !== JSON.stringify(normalizedAuthorizedRoomIds)) {
      user.authorizedRoomIds = normalizedAuthorizedRoomIds;
      changed = true;
    }

    const normalizedEnabledRoomIds = sanitizeEnabledRoomIds(user.enabledRoomIds, data.posSettings);
    const nextAuthorizedSubset = normalizedAuthorizedRoomIds.filter((roomId) => normalizedEnabledRoomIds.includes(roomId));
    if (JSON.stringify(user.enabledRoomIds ?? null) !== JSON.stringify(normalizedEnabledRoomIds)) {
      user.enabledRoomIds = normalizedEnabledRoomIds;
      changed = true;
    }
    if (JSON.stringify(user.authorizedRoomIds ?? null) !== JSON.stringify(nextAuthorizedSubset)) {
      user.authorizedRoomIds = nextAuthorizedSubset;
      changed = true;
    }

    const defaultPaymentMethodIds = Array.isArray(user.allowedPaymentMethodIds)
      ? user.allowedPaymentMethodIds
      : resolveDefaultPaymentMethodIdsForUser(user, data.posSettings);
    const normalizedPaymentMethodIds = sanitizeUserPaymentMethodIds(defaultPaymentMethodIds, data.posSettings);
    if (JSON.stringify(user.allowedPaymentMethodIds ?? null) !== JSON.stringify(normalizedPaymentMethodIds)) {
      user.allowedPaymentMethodIds = normalizedPaymentMethodIds;
      changed = true;
    }
  }

  for (const session of data.sessions) {
    if (typeof session.tokenHash !== "string") {
      const fallbackToken =
        typeof session.token === "string" && session.token.trim().length > 0
          ? session.token
          : randomUUID();
      session.tokenHash = hashSessionToken(fallbackToken);
      changed = true;
    }

    if ("token" in session) {
      delete session.token;
      changed = true;
    }

    const normalizedClientApp = normalizeClientApp(session.clientApp);
    if ((session.clientApp ?? "") !== normalizedClientApp) {
      session.clientApp = normalizedClientApp;
      changed = true;
    }

    const normalizedLastSeenAt = String(session.lastSeenAt ?? session.createdAt ?? nowIso());
    if (String(session.lastSeenAt ?? "") !== normalizedLastSeenAt) {
      session.lastSeenAt = normalizedLastSeenAt;
      changed = true;
    }
  }

  if (data.saleSessionTemplates.length === 0) {
    const createdAt = nowIso();
    data.saleSessionTemplates = DEFAULT_SALE_SESSION_TEMPLATES.map((template) => ({
      ...template,
      createdByUserId: "system",
      createdAt,
      updatedAt: createdAt,
    }));
    changed = true;
  } else {
    data.saleSessionTemplates = data.saleSessionTemplates.map((template, index) => {
      const normalized = normalizeTemplate(template, `tpl_${index + 1}`);
      if (JSON.stringify(template) !== JSON.stringify(normalized)) {
        changed = true;
      }
      return normalized;
    });
  }

  if (data.menuItems.length === 0) {
    const createdAt = nowIso();
    data.menuItems = DEFAULT_MENU_ITEMS.map((item) => ({
      ...item,
      createdByUserId: "system",
      createdAt,
      updatedAt: createdAt,
    }));
    changed = true;
  } else {
    data.menuItems = data.menuItems
      .filter((item) => item && typeof item === "object")
      .map((item, index) => {
        const normalized = normalizeMenuItem(item, `menu_item_${index + 1}`);
        if (JSON.stringify(item) !== JSON.stringify(normalized)) {
          changed = true;
        }
        return normalized;
      });
  }

  const defaultMenuItemsById = new Map(
    DEFAULT_MENU_ITEMS.map((item) => [String(item.id ?? "").trim(), item]).filter(([id]) => Boolean(id))
  );
  const nowForVariantDefaults = nowIso();
  data.menuItems = data.menuItems.map((item) => {
    const defaultItem = defaultMenuItemsById.get(String(item?.id ?? "").trim());
    const defaultVariants = normalizeMenuItemVariants(defaultItem?.variants);
    const defaultVariantRequired = menuItemRequiresVariantSelection(defaultItem);
    const defaultPremiumAlcohol = isPremiumAlcoholMenuItem(defaultItem);
    if (defaultVariants.length === 0 && !defaultVariantRequired && !defaultPremiumAlcohol) return item;
    const currentVariants = normalizeMenuItemVariants(item?.variants);
    const nextDraft = { ...item };
    let needsUpdate = false;
    if (defaultVariants.length > 0 && currentVariants.length === 0) {
      nextDraft.variants = defaultVariants;
      needsUpdate = true;
    }
    if (defaultVariantRequired && item?.variantRequired !== true) {
      nextDraft.variantRequired = true;
      nextDraft.requiresVariantSelection = true;
      needsUpdate = true;
    }
    if (defaultPremiumAlcohol && item?.isPremiumAlcohol !== true) {
      nextDraft.isPremiumAlcohol = true;
      needsUpdate = true;
    }
    if (!needsUpdate) return item;
    changed = true;
    return normalizeMenuItem(
      {
        ...nextDraft,
        updatedAt: nowForVariantDefaults,
      },
      item.id
    );
  });

  const existingMenuIds = new Set(
    data.menuItems.map((item) => (item && typeof item === "object" ? String(item.id ?? "").trim() : "")).filter(Boolean)
  );
  const nowForDefaults = nowIso();
  for (const defaultItem of DEFAULT_MENU_ITEMS) {
    if (!isPremiumAlcoholMenuItem(defaultItem)) continue;
    if (existingMenuIds.has(defaultItem.id)) continue;
    data.menuItems.push(
      normalizeMenuItem(
        {
          ...defaultItem,
          createdByUserId: "system",
          createdAt: nowForDefaults,
          updatedAt: nowForDefaults,
        },
        defaultItem.id
      )
    );
    changed = true;
  }

  const normalizedPosSettings = sanitizePosSettings(data.posSettings, {
    menuItems: data.menuItems,
    users: data.users,
  });
  if (JSON.stringify(data.posSettings) !== JSON.stringify(normalizedPosSettings)) {
    data.posSettings = {
      sideBars: normalizedPosSettings.sideBars,
      demoMode: normalizedPosSettings.demoMode,
      locale: normalizedPosSettings.locale,
      locales: normalizedPosSettings.locales,
      activities: normalizedPosSettings.activities,
      activityRoomBindings: normalizedPosSettings.activityRoomBindings,
      paymentMethods: normalizedPosSettings.paymentMethods,
      paymentTerminals: normalizedPosSettings.paymentTerminals,
      smartCash: normalizedPosSettings.smartCash,
      tables: normalizedPosSettings.tables,
      menus: normalizedPosSettings.menus,
      areaMenus: normalizedPosSettings.areaMenus,
      priceLists: normalizedPosSettings.priceLists,
      priceListSchedules: normalizedPosSettings.priceListSchedules,
      menuSchedules: normalizedPosSettings.menuSchedules,
      printers: normalizedPosSettings.printers,
      fiscalDevices: normalizedPosSettings.fiscalDevices,
      mobileDevices: normalizedPosSettings.mobileDevices,
      automaticCash: normalizedPosSettings.automaticCash,
      radioChannels: normalizedPosSettings.radioChannels,
      radioPreferences: normalizedPosSettings.radioPreferences,
      workstations: normalizedPosSettings.workstations,
      areas: normalizedPosSettings.areas,
      orderWorkflow: normalizedPosSettings.orderWorkflow,
      printPreferences: normalizedPosSettings.printPreferences,
    };
    changed = true;
  }

  const normalizedPrintSpoolJobs = sanitizePrintSpoolJobs(data.printSpoolJobs);
  if (JSON.stringify(data.printSpoolJobs) !== JSON.stringify(normalizedPrintSpoolJobs)) {
    data.printSpoolJobs = normalizedPrintSpoolJobs;
    changed = true;
  }
  prunePrintSpoolJobs(data);

  if (Array.isArray(data.posReservations) && data.posReservations.length > 0) {
    data.posReservations = [];
    changed = true;
  }

  const layoutRooms = buildPosRoomListFromSettings(data.posSettings);
  const layoutRoomById = new Map(layoutRooms.map((room) => [room.id, room]));
  const normalizedPosRoomChangeRequests = data.posRoomChangeRequests
    .map((entry) => sanitizePosRoomChangeRequestRecord(entry, layoutRoomById))
    .filter((entry) => entry !== null);
  if (JSON.stringify(data.posRoomChangeRequests) !== JSON.stringify(normalizedPosRoomChangeRequests)) {
    changed = true;
  }
  data.posRoomChangeRequests = normalizedPosRoomChangeRequests;

  const stateByKey = new Map();
  data.posReservationStates.forEach((entry) => {
    const state = sanitizePosReservationStateRecord(entry);
    if (!state) return;
    const nextReservations = state.reservations
      .map((reservation, index) =>
        sanitizePosReservationRecord(reservation, {
          id: `res_${state.roomId}_${state.serviceDate}_${index + 1}`,
          roomId: state.roomId,
          serviceDate: state.serviceDate,
        })
      )
      .filter((reservation) => reservation !== null)
      .map((reservation) => ({
        ...reservation,
        roomId: state.roomId,
        serviceDate: state.serviceDate,
      }));
    const normalized = {
      key: state.key,
      roomId: state.roomId,
      serviceDate: state.serviceDate,
      version: state.version,
      reservations: nextReservations,
    };
    const current = stateByKey.get(normalized.key);
    if (!current || normalized.version >= current.version) {
      stateByKey.set(normalized.key, normalized);
    }
  });

  const normalizedPosReservationStates = [...stateByKey.values()].sort((left, right) => {
    if (left.serviceDate !== right.serviceDate) return left.serviceDate.localeCompare(right.serviceDate);
    if (left.roomId !== right.roomId) return left.roomId.localeCompare(right.roomId);
    return left.key.localeCompare(right.key);
  });
  if (JSON.stringify(data.posReservationStates) !== JSON.stringify(normalizedPosReservationStates)) {
    changed = true;
  }
  data.posReservationStates = normalizedPosReservationStates;

  const knownReservationIds = new Set();
  data.posReservationStates.forEach((state) => {
    state.reservations.forEach((reservation) => {
      knownReservationIds.add(reservation.id);
    });
  });
  const lockNow = Date.now();
  const normalizedPosReservationLocks = data.posReservationLocks
    .map((entry) => sanitizePosReservationLockRecord(entry))
    .filter(
      (entry) => entry !== null && entry.expiresAt > lockNow && knownReservationIds.has(entry.reservationId)
    );
  if (JSON.stringify(data.posReservationLocks) !== JSON.stringify(normalizedPosReservationLocks)) {
    changed = true;
  }
  data.posReservationLocks = normalizedPosReservationLocks;

  data.saleSessions = data.saleSessions
    .filter((session) => session && typeof session === "object")
    .map((session) => {
      const normalized = {
        id: String(session.id ?? `sale_${randomUUID().replace(/-/g, "")}`),
        templateId: String(session.templateId ?? "tpl_unknown"),
        templateName: String(session.templateName ?? "Sessione Vendita"),
        scheduledStart: typeof session.scheduledStart === "string" ? session.scheduledStart : "09:00",
        scheduledEnd: typeof session.scheduledEnd === "string" ? session.scheduledEnd : "17:00",
        businessDate:
          typeof session.businessDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(session.businessDate)
            ? session.businessDate
            : localDateKeyFromIso(session.startedAt ?? nowIso()),
        startedAt: String(session.startedAt ?? nowIso()),
        startedByUserId: String(session.startedByUserId ?? "system"),
        startedByUsername: String(session.startedByUsername ?? "system"),
        endedAt: session.endedAt ? String(session.endedAt) : null,
        endedByUserId: session.endedByUserId ? String(session.endedByUserId) : null,
        endedByUsername: session.endedByUsername ? String(session.endedByUsername) : null,
      };

      if (JSON.stringify(session) !== JSON.stringify(normalized)) {
        changed = true;
      }

      return normalized;
    });

  data.solarClosures = data.solarClosures
    .filter((closure) => closure && typeof closure === "object")
    .map((closure, index) => {
      const now = nowIso();
      const normalized = {
        id: String(closure.id ?? `solar_${index + 1}`),
        key:
          typeof closure.key === "string" && /^\d{4}-\d{2}-\d{2}$/.test(closure.key)
            ? closure.key
            : localDateKeyFromDate(new Date()),
        transmittedAt: String(closure.transmittedAt ?? now),
        closedAt: String(closure.closedAt ?? closure.transmittedAt ?? now),
        printerStatus: closure.printerStatus === "accepted" ? "accepted" : "accepted",
        printerResponseCode:
          typeof closure.printerResponseCode === "string" && closure.printerResponseCode.trim().length > 0
            ? closure.printerResponseCode
            : "RT_OK",
        printerResponseMessage:
          typeof closure.printerResponseMessage === "string" &&
          closure.printerResponseMessage.trim().length > 0
            ? closure.printerResponseMessage
            : "Trasmissione fiscale e chiusura solare completate.",
        totalSaleSessions: Number.isFinite(closure.totalSaleSessions)
          ? Math.max(Number(closure.totalSaleSessions), 0)
          : 0,
        saleSessionIds: Array.isArray(closure.saleSessionIds)
          ? closure.saleSessionIds.map((id) => String(id))
          : [],
      };

      if (JSON.stringify(closure) !== JSON.stringify(normalized)) {
        changed = true;
      }

      return normalized;
    });

  data.smartCustomers = data.smartCustomers
    .filter((customer) => customer && typeof customer === "object")
    .map((customer, index) => {
      const normalized = sanitizeSmartCustomer(customer, `smart_cli_${pad2(index + 1)}`);
      if (JSON.stringify(customer) !== JSON.stringify(normalized)) {
        changed = true;
      }
      return normalized;
    });

  if (data.smartCustomers.length === 0 && shouldSeedDemoData()) {
    const createdAt = nowIso();
    data.smartCustomers = DEFAULT_SMART_CUSTOMERS.map((customer, index) =>
      sanitizeSmartCustomer(
        {
          ...customer,
          id: customer.id ?? `smart_cli_${pad2(index + 1)}`,
          createdAt,
          updatedAt: createdAt,
        },
        `smart_cli_${pad2(index + 1)}`
      )
    );
    changed = true;
  }

  const normalizedSmartNonFiscal = data.smartNonFiscal
    .filter((entry) => entry && typeof entry === "object")
    .map((entry, index) => sanitizeSmartNonFiscalEntry(entry, `smart_nf_${index + 1}`))
    .filter((entry) => entry !== null);
  if (JSON.stringify(data.smartNonFiscal) !== JSON.stringify(normalizedSmartNonFiscal)) {
    changed = true;
  }
  data.smartNonFiscal = normalizedSmartNonFiscal;

  const knownPaymentTableIds = new Set(
    (Array.isArray(data.posSettings?.tables) ? data.posSettings.tables : [])
      .map((table) => String(table?.id ?? "").trim())
      .filter(Boolean)
  );
  const knownPaymentOrderIds = new Set(
    (Array.isArray(data.integration?.orders) ? data.integration.orders : [])
      .map((order) => String(order?.id ?? "").trim())
      .filter(Boolean)
  );
  const migratePaymentOrderRefs = (record) => {
    if (!record || typeof record !== "object") return record;
    const next = { ...record };
    const orderId = String(next.orderId ?? "").trim();
    if (orderId && knownPaymentTableIds.has(orderId) && !knownPaymentOrderIds.has(orderId)) {
      changed = true;
      if (!String(next.tableId ?? "").trim()) {
        next.tableId = orderId;
      }
      next.orderId = null;
      next.orderIds = (Array.isArray(next.orderIds) ? next.orderIds : [])
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => entry && entry !== orderId);
      data.meta.paymentOrderRefMigration = {
        ...(data.meta.paymentOrderRefMigration && typeof data.meta.paymentOrderRefMigration === "object"
          ? data.meta.paymentOrderRefMigration
          : {}),
        lastAppliedAt: nowIso(),
        note: "Moved table-like orderId values into tableId without inventing ambiguous order links.",
      };
    }
    return next;
  };

  const normalizedPayments = data.payments
    .filter((record) => record && typeof record === "object")
    .map((record, index) => sanitizePaymentRecord(migratePaymentOrderRefs(record), `pay_${index + 1}`))
    .filter((record) => record !== null);
  if (JSON.stringify(data.payments) !== JSON.stringify(normalizedPayments)) {
    changed = true;
  }
  data.payments = normalizedPayments;

  const normalizedPaymentContainers = data.paymentContainers
    .filter((record) => record && typeof record === "object")
    .map((record, index) => sanitizePaymentContainerRecord(migratePaymentOrderRefs(record), `payc_${index + 1}`))
    .filter((record) => record !== null);
  if (JSON.stringify(data.paymentContainers) !== JSON.stringify(normalizedPaymentContainers)) {
    changed = true;
  }
  data.paymentContainers = normalizedPaymentContainers;

  const knownContainerIds = new Set(normalizedPaymentContainers.map((entry) => entry.id));
  const normalizedPaymentParts = data.paymentParts
    .filter((record) => record && typeof record === "object")
    .map((record, index) => sanitizePaymentPartRecord(record, `part_${index + 1}`))
    .filter((record) => record !== null && knownContainerIds.has(record.paymentId));
  if (JSON.stringify(data.paymentParts) !== JSON.stringify(normalizedPaymentParts)) {
    changed = true;
  }
  data.paymentParts = normalizedPaymentParts;

  const knownPartIds = new Set(normalizedPaymentParts.map((entry) => entry.id));
  const normalizedPaymentTransactions = data.paymentTransactions
    .filter((record) => record && typeof record === "object")
    .map((record, index) => sanitizePaymentTransactionRecord(record, `tx_${index + 1}`))
    .filter((record) => record !== null && knownPartIds.has(record.partId));
  if (JSON.stringify(data.paymentTransactions) !== JSON.stringify(normalizedPaymentTransactions)) {
    changed = true;
  }
  data.paymentTransactions = normalizedPaymentTransactions;

  const knownTxIds = new Set(normalizedPaymentTransactions.map((entry) => entry.id));
  const normalizedCashTxDenoms = data.cashTxDenoms
    .filter((record) => record && typeof record === "object")
    .map((record, index) => sanitizeCashTxDenomRecord(record, `denom_${index + 1}`))
    .filter((record) => record !== null && knownTxIds.has(record.txId));
  if (JSON.stringify(data.cashTxDenoms) !== JSON.stringify(normalizedCashTxDenoms)) {
    changed = true;
  }
  data.cashTxDenoms = normalizedCashTxDenoms;

  const normalizedAuditEvents = sanitizeAuditEvents(data.auditEvents);
  if (JSON.stringify(data.auditEvents) !== JSON.stringify(normalizedAuditEvents)) {
    changed = true;
  }
  data.auditEvents = normalizedAuditEvents;
  pruneAuditEvents(data);

  const normalizedFiscalReceipts = data.fiscalReceipts
    .filter((receipt) => receipt && typeof receipt === "object")
    .map((receipt, index) => sanitizeFiscalReceipt(receipt, `fiscal_${index + 1}`))
    .filter((receipt) => receipt !== null);
  if (JSON.stringify(data.fiscalReceipts) !== JSON.stringify(normalizedFiscalReceipts)) {
    changed = true;
  }
  data.fiscalReceipts = normalizedFiscalReceipts;

  const normalizedFiscalEvents = data.fiscalEvents
    .filter((entry) => entry && typeof entry === "object")
    .map((entry, index) => ({
      id: String(entry.id ?? `fiscal_evt_${index + 1}`),
      command: String(entry.command ?? "generic"),
      createdAt: String(entry.createdAt ?? nowIso()),
      createdByUserId: String(entry.createdByUserId ?? "system"),
      createdByUsername: String(entry.createdByUsername ?? "system"),
      result: String(entry.result ?? "ok"),
      message: String(entry.message ?? "Comando eseguito."),
    }));
  if (JSON.stringify(data.fiscalEvents) !== JSON.stringify(normalizedFiscalEvents)) {
    changed = true;
  }
  data.fiscalEvents = normalizedFiscalEvents;

  if (!data.meta.crypto || typeof data.meta.crypto !== "object") {
    data.meta.crypto = {
      pinHash: "scrypt",
      sessionTokenHash: "hmac-sha256",
    };
    changed = true;
  }

  if (
    typeof data.meta.settingsLastWriteAt !== "string" ||
    data.meta.settingsLastWriteAt.trim().length === 0
  ) {
    data.meta.settingsLastWriteAt = String(data.meta.lastWriteAt ?? nowIso());
    changed = true;
  }

  if (changed) {
    data.meta.lastSecurityMigrationAt = nowIso();
  }

  return changed;
};
}
