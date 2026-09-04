const INTEGRATION_FIELDS = ["waiterPauses", "waiterDeferredCalls", "lastWriteAt"];

function passthroughMeasure(_label, action) {
  return action();
}

function normalizeIds(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

export function createWaiterPauseWriter({
  enabled = false,
  dbMode,
  mysqlDomainsRepository,
  syncIntegrationObjectFields,
  writeSessionAuditFastDb,
  writeNotificationDb,
  refreshHealthSnapshot,
  runtimeMetrics,
} = {}) {
  if (typeof syncIntegrationObjectFields !== "function") {
    throw new TypeError("syncIntegrationObjectFields obbligatorio");
  }
  if (typeof writeNotificationDb !== "function") {
    throw new TypeError("writeNotificationDb obbligatorio");
  }

  return async function writeWaiterPauseDb(db, options = {}) {
    const measure = typeof options.measure === "function"
      ? options.measure
      : passthroughMeasure;
    const sessionIds = normalizeIds(options.sessionIds);
    const auditEventIds = normalizeIds(options.auditEventIds);
    const {
      measure: _measure,
      sessionIds: _sessionIds,
      auditEventIds: _auditEventIds,
      skipIntegrationFields: _skipIntegrationFields,
      ...writeOptions
    } = options;
    const skipIntegrationFields = options.skipIntegrationFields === true;
    const scopedWriterAvailable =
      dbMode === "mysql" &&
      mysqlDomainsRepository?.enabled === true &&
      typeof mysqlDomainsRepository.syncObjectEntryFromAppState === "function";

    if (!scopedWriterAvailable) {
      runtimeMetrics?.incrementCounter?.("waiterPauseAppStateFullFallbacks");
      await measure("state.notificationFullFallback", () =>
        writeNotificationDb(db, {
          ...writeOptions,
          splitDomains: ["integration", "sessions", "auditEvents"],
        }));
      return { mode: "full-fallback" };
    }

    if (!skipIntegrationFields) {
      await measure("state.integrationFields", () =>
        syncIntegrationObjectFields(
          mysqlDomainsRepository,
          db,
          INTEGRATION_FIELDS,
        ));
      runtimeMetrics?.incrementCounter?.("waiterPauseAppStateSequentialWrites");
    } else {
      runtimeMetrics?.incrementCounter?.("waiterPauseRecoveryIntegrationWriteSkips");
    }

    let sessionAuditFastWritten = false;
    if (enabled === true && typeof writeSessionAuditFastDb === "function") {
      sessionAuditFastWritten = await measure("state.sessionAuditFast", () =>
        writeSessionAuditFastDb(db, {
          sessionIds,
          auditEventIds,
        }));
      runtimeMetrics?.incrementCounter?.(
        sessionAuditFastWritten
          ? "waiterPauseSessionAuditFastWrites"
          : "waiterPauseSessionAuditFastFallbacks",
      );
    }
    if (!sessionAuditFastWritten) {
      await measure("state.notificationSplit", () =>
        writeNotificationDb(db, {
          ...writeOptions,
          splitDomains: ["sessions", "auditEvents"],
        }));
    }
    refreshHealthSnapshot?.(db);
    return {
      mode: skipIntegrationFields
        ? "session-audit-recovery"
        : sessionAuditFastWritten
          ? "session-audit-fast"
          : "sequential",
    };
  };
}
