const DEFAULT_INTEGRATION_OBJECT_FIELDS = ["lastWriteAt"];

function normalizeIds(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [values])
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

export function createNotificationPersistenceWriter({
  enabled = false,
  dbMode,
  mysqlDomainsRepository,
  writeSessionAuditFastDb,
  writeNotificationDb,
  refreshHealthSnapshot,
  runtimeMetrics,
} = {}) {
  if (typeof writeNotificationDb !== "function") {
    throw new TypeError("writeNotificationDb obbligatorio");
  }

  return async function writeNotificationPersistence(db, options = {}) {
    const notificationIds = normalizeIds(options.notificationIds);
    const orderIds = normalizeIds(options.orderIds);
    const sessionIds = normalizeIds(options.sessionIds);
    const auditEventIds = normalizeIds(options.auditEventIds);
    const replaceNotifications = options.replaceNotifications === true;
    const syncSessions = options.syncSessions === true;
    const sessionUpdateOnly = options.sessionUpdateOnly !== false;
    const objectFields = normalizeIds([
      options.integrationObjectFields,
      ...(replaceNotifications || notificationIds.length > 0 || orderIds.length > 0
        ? DEFAULT_INTEGRATION_OBJECT_FIELDS
        : []),
    ]);
    const metricOptions = options.metricLabel
      ? { metricLabel: options.metricLabel }
      : {};
    const scopedWriterAvailable =
      enabled === true &&
      dbMode === "mysql" &&
      mysqlDomainsRepository?.enabled === true &&
      typeof mysqlDomainsRepository.syncObjectArrayEntriesAndObjectEntriesFromAppState ===
        "function";

    if (
      !scopedWriterAvailable ||
      options.requiresFullIntegrationFallback === true
    ) {
      runtimeMetrics?.incrementCounter?.("notificationPunctualFallbacks");
      await writeNotificationDb(db, {
        ...metricOptions,
        splitDomains: sessionUpdateOnly
          ? ["integration", "auditEvents"]
          : ["integration", "sessions", "auditEvents"],
      });
      return { mode: "full-fallback" };
    }

    const objectArrayEntries = [];
    if (!replaceNotifications && notificationIds.length > 0) {
      objectArrayEntries.push({
        fieldName: "notifications",
        entryIds: notificationIds,
      });
    }
    if (orderIds.length > 0) {
      objectArrayEntries.push({ fieldName: "orders", entryIds: orderIds });
    }

    const hasIntegrationWrite =
      replaceNotifications ||
      objectArrayEntries.length > 0 ||
      objectFields.length > 0;
    if (hasIntegrationWrite) {
      await mysqlDomainsRepository.syncObjectArrayEntriesAndObjectEntriesFromAppState(
        db,
        "integration",
        {
          objectArrayEntries,
          objectFields,
          replaceObjectArrayFields: replaceNotifications
            ? ["notifications"]
            : [],
        },
      );
      runtimeMetrics?.incrementCounter?.("notificationPunctualWrites");
      if (replaceNotifications) {
        runtimeMetrics?.incrementCounter?.(
          "notificationPunctualFullReplacements",
        );
      }
    }

    if (syncSessions) {
      const sessionFastWritten =
        sessionIds.length > 0 &&
        typeof writeSessionAuditFastDb === "function" &&
        (await writeSessionAuditFastDb(db, {
          sessionIds,
          auditEventIds,
          updateOnly: sessionUpdateOnly,
        }));
      if (sessionFastWritten) {
        runtimeMetrics?.incrementCounter?.("notificationPunctualSessionWrites");
      } else {
        runtimeMetrics?.incrementCounter?.("notificationPunctualSessionFallbacks");
        if (!sessionUpdateOnly) {
          await writeNotificationDb(db, {
            ...metricOptions,
            splitDomains: ["sessions", "auditEvents"],
          });
        }
      }
    }

    refreshHealthSnapshot?.(db);
    return {
      mode: syncSessions ? "punctual-with-session" : "punctual",
    };
  };
}
