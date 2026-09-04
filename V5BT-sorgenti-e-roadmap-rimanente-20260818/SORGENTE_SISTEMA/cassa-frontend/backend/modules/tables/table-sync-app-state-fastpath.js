function normalizeIds(values = []) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

export function createTableSyncAppStateFastPath({
  enabled = false,
  dbMode,
  mysqlDomainsRepository,
  tableStateRepository,
  mysqlAuditEventsRepository,
  auditEventsRepository,
  prepareTableSyncState,
  refreshHealthSnapshot,
  runtimeMetrics,
} = {}) {
  const fallbackCounters = {
    relatedDomain: "tableSyncAppStateFastFallbackRelatedDomain",
    tableWriterUnavailable: "tableSyncAppStateFastFallbackTableWriterUnavailable",
    tableStateWriterUnavailable: "tableSyncAppStateFastFallbackTableStateWriterUnavailable",
    auditWriterUnavailable: "tableSyncAppStateFastFallbackAuditWriterUnavailable",
  };

  function recordFallback(reason) {
    runtimeMetrics?.incrementCounter?.("tableSyncAppStateFastFallbacks");
    runtimeMetrics?.incrementCounter?.(fallbackCounters[reason]);
    return false;
  }

  return async function writeTableSyncAppStateFast(db, options = {}) {
    const startedAt = Date.now();
    const tableIds = normalizeIds(options.tableIds ?? options.tableId);
    const auditEventIds = normalizeIds(options.auditEventIds);
    const canWriteTable =
      enabled === true &&
      dbMode === "mysql" &&
      tableIds.length === 1 &&
      mysqlDomainsRepository?.enabled === true &&
      mysqlDomainsRepository.domains?.includes("posSettings") &&
      typeof mysqlDomainsRepository.syncObjectArrayEntriesFromAppState === "function" &&
      typeof prepareTableSyncState === "function";
    const canWriteTableState =
      tableStateRepository?.enabled !== true ||
      typeof tableStateRepository.syncEntriesFromAppState === "function";
    const canWriteAudit =
      auditEventIds.length === 0 ||
      (mysqlAuditEventsRepository?.enabled === true &&
        typeof mysqlAuditEventsRepository.syncEntriesFromAppState === "function" &&
        (auditEventsRepository?.enabled !== true ||
          typeof auditEventsRepository.syncEntriesFromAppState === "function"));

    if (options.requiresFullFallback === true) return recordFallback("relatedDomain");
    if (!canWriteTable) return recordFallback("tableWriterUnavailable");
    if (!canWriteTableState) return recordFallback("tableStateWriterUnavailable");
    if (!canWriteAudit) return recordFallback("auditWriterUnavailable");

    const recordStep = async (label, action) => {
      const stepStartedAt = Date.now();
      try {
        return await action();
      } finally {
        runtimeMetrics?.recordOperation?.(
          "tableSyncWrite",
          label,
          Date.now() - stepStartedAt,
        );
      }
    };

    try {
      const syncState = prepareTableSyncState(db);
      await recordStep("mysql.posSettingsTable", () =>
        mysqlDomainsRepository.syncObjectArrayEntriesFromAppState(
          syncState,
          "posSettings",
          "tables",
          tableIds,
        ),
      );
      if (tableStateRepository?.enabled === true) {
        await recordStep("sqlite.tableState", () =>
          tableStateRepository.syncEntriesFromAppState(syncState, tableIds),
        );
      }
      if (auditEventIds.length > 0) {
        await recordStep("mysql.auditEvents", () =>
          mysqlAuditEventsRepository.syncEntriesFromAppState(db, auditEventIds),
        );
        if (auditEventsRepository?.enabled === true) {
          await recordStep("sqlite.auditEvents", () =>
            auditEventsRepository.syncEntriesFromAppState(db, auditEventIds),
          );
        }
      }
      refreshHealthSnapshot?.(db);
      runtimeMetrics?.incrementCounter?.("tableSyncAppStateFastWrites");
      return true;
    } finally {
      runtimeMetrics?.recordOperation?.(
        "tableSyncWrite",
        "total",
        Date.now() - startedAt,
      );
    }
  };
}
