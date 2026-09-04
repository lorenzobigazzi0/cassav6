export function createPostazioneLogoutStationService(options = {}) {
  const {
    allowDemoStations = false,
    buildIntegrationStationStatesWithSessionRecovery,
    clearStationCaches = () => {},
    createDefaultIntegrationState,
    deactivateIntegrationStationStatesForSession,
    filterPersistentIntegrationStationStates,
    getActiveStations,
    maybeQueueNoActiveStationsNotification,
    normalizeClientApp,
    nowIso,
    publishIntegrationNotificationStreamRefresh,
    queueStationAvailabilityNotification,
    resolveConfiguredIntegrationStations,
  } = options;

  function apply(db, context = {}) {
    const session = context.session && typeof context.session === "object" ? context.session : {};
    if (normalizeClientApp(session.clientApp) !== "postazione") {
      return { changed: false };
    }
    if (!db.integration || typeof db.integration !== "object") {
      db.integration = createDefaultIntegrationState();
    }

    const notificationIdsBefore = new Set(
      (Array.isArray(db.integration.notifications) ? db.integration.notifications : [])
        .map((entry) => String(entry?.id ?? "").trim())
        .filter(Boolean),
    );
    const stationStates = buildIntegrationStationStatesWithSessionRecovery(db);
    const transition = deactivateIntegrationStationStatesForSession(stationStates, {
      ...context,
      updatedAtMs: Date.now(),
    });
    const persistentStationStates = filterPersistentIntegrationStationStates(
      transition.stationStates,
      resolveConfiguredIntegrationStations(db),
    );
    db.integration.stationStates = persistentStationStates;

    const stationNotifications = [];
    transition.deactivated.forEach((entry) => {
      const notification = queueStationAvailabilityNotification(db, {
        eventType: "station_offline",
        severity: "warning",
        title: "Postazione offline",
        description: `La postazione ${entry.station} risulta offline${entry.operatorName ? ` (${entry.operatorName})` : ""}.`,
        station: entry.station,
        operatorName: entry.operatorName,
        deviceUuid: entry.deviceUuid,
        trigger: "auth_logout",
      });
      if (notification) stationNotifications.push(notification);
    });

    const activeStations = getActiveStations(
      { integration: { ...db.integration, stationStates: persistentStationStates } },
      { allowDemoStations },
    );
    const noActiveStationsAlertChanged = maybeQueueNoActiveStationsNotification(
      db,
      activeStations,
      { trigger: "auth_logout" },
    );
    const notificationIds = (Array.isArray(db.integration.notifications)
      ? db.integration.notifications
      : [])
      .map((entry) => String(entry?.id ?? "").trim())
      .filter((id) => id && !notificationIdsBefore.has(id));
    const notificationIdSet = new Set(notificationIds);
    const notifications = (Array.isArray(db.integration.notifications)
      ? db.integration.notifications
      : [])
      .filter((entry) => notificationIdSet.has(String(entry?.id ?? "").trim()));
    const changed = transition.changed || noActiveStationsAlertChanged || notificationIds.length > 0;

    if (changed) {
      db.integration.lastWriteAt = nowIso();
      clearStationCaches();
    }

    return {
      changed,
      stationStateChanged: transition.changed,
      noActiveStationsAlertChanged,
      activeStations,
      notificationIds,
      notifications,
      stationNotifications,
      stationStates: persistentStationStates,
      deactivatedStations: transition.deactivated.map((entry) => entry.station),
      deactivatedStationStates: transition.deactivated,
    };
  }

  function publish(result = {}) {
    const activeStations = Array.isArray(result.activeStations) ? result.activeStations : [];
    const notifications = Array.isArray(result.notifications) ? result.notifications : [];
    if (result.noActiveStationsAlertChanged === true) {
      publishIntegrationNotificationStreamRefresh("station_availability_alert", {
        activeStations: activeStations.length,
        trigger: "auth_logout",
        notifications,
      });
    }
    if (result.stationStateChanged === true || result.stationNotifications?.length > 0) {
      publishIntegrationNotificationStreamRefresh("station_state_changed", {
        activeStations: activeStations.length,
        stations: Array.isArray(result.deactivatedStationStates)
          ? result.deactivatedStationStates
          : [],
        active: false,
        trigger: "auth_logout",
        notifications: result.noActiveStationsAlertChanged === true ? [] : notifications,
      });
    }
  }

  return { apply, publish };
}
