function normalizeIds(values = []) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function containsIds(entries, ids) {
  const available = new Set(
    (Array.isArray(entries) ? entries : [])
      .map((entry) => String(entry?.id ?? entry?.requestId ?? "").trim())
      .filter(Boolean),
  );
  return ids.every((id) => available.has(id));
}

export function createTableRoomMoveRequestAppStateFastPath({
  enabled = false,
  dbMode,
  mysqlDomainsRepository,
  refreshHealthSnapshot,
  runtimeMetrics,
} = {}) {
  const fallbackCounters = {
    collectionPruned:
      "tableRoomMoveRequestAppStateFastFallbackCollectionPruned",
    invalidScope: "tableRoomMoveRequestAppStateFastFallbackInvalidScope",
    requestWriterUnavailable:
      "tableRoomMoveRequestAppStateFastFallbackRequestWriterUnavailable",
    integrationWriterUnavailable:
      "tableRoomMoveRequestAppStateFastFallbackIntegrationWriterUnavailable",
  };

  function recordFallback(reason) {
    runtimeMetrics?.incrementCounter?.(
      "tableRoomMoveRequestAppStateFastFallbacks",
    );
    runtimeMetrics?.incrementCounter?.(fallbackCounters[reason]);
    return false;
  }

  return async function writeTableRoomMoveRequestAppStateFast(
    db,
    options = {},
  ) {
    const requestIds = normalizeIds(options.requestIds ?? options.requestId);
    const notificationIds = normalizeIds(
      options.notificationIds ?? options.notificationId,
    );
    const domains = Array.isArray(mysqlDomainsRepository?.domains)
      ? mysqlDomainsRepository.domains
      : [];
    const canWriteRequest =
      enabled === true &&
      dbMode === "mysql" &&
      mysqlDomainsRepository?.enabled === true &&
      domains.includes("posTableRoomMoveRequests") &&
      typeof mysqlDomainsRepository.syncDomainArrayEntriesFromAppState ===
        "function";
    const canWriteIntegration =
      enabled === true &&
      dbMode === "mysql" &&
      mysqlDomainsRepository?.enabled === true &&
      domains.includes("integration") &&
      typeof mysqlDomainsRepository
        .syncObjectArrayEntriesAndObjectEntriesFromAppState === "function";
    const validScope =
      requestIds.length === 1 &&
      containsIds(db?.posTableRoomMoveRequests, requestIds) &&
      containsIds(db?.integration?.notifications, notificationIds);

    if (options.requiresFullFallback === true) {
      return recordFallback("collectionPruned");
    }
    if (!validScope) return recordFallback("invalidScope");
    if (!canWriteRequest) return recordFallback("requestWriterUnavailable");
    if (!canWriteIntegration) {
      return recordFallback("integrationWriterUnavailable");
    }

    const startedAt = Date.now();
    const recordStep = async (label, action) => {
      const stepStartedAt = Date.now();
      try {
        return await action();
      } finally {
        runtimeMetrics?.recordOperation?.(
          "tableRoomMoveRequestWrite",
          label,
          Date.now() - stepStartedAt,
        );
      }
    };

    try {
      await recordStep("mysql.integration", () =>
        mysqlDomainsRepository.syncObjectArrayEntriesAndObjectEntriesFromAppState(
          db,
          "integration",
          {
            objectArrayEntries:
              notificationIds.length > 0
                ? [
                    {
                      fieldName: "notifications",
                      entryIds: notificationIds,
                    },
                  ]
                : [],
            objectFields: [
              ...(notificationIds.length > 0 ? ["sequence"] : []),
              ...(options.deferredCallsChanged === true
                ? ["waiterDeferredCalls"]
                : []),
              "lastWriteAt",
            ],
          },
        ),
      );
      await recordStep("mysql.request", () =>
        mysqlDomainsRepository.syncDomainArrayEntriesFromAppState(
          db,
          "posTableRoomMoveRequests",
          requestIds,
        ),
      );
      refreshHealthSnapshot?.(db);
      runtimeMetrics?.incrementCounter?.(
        "tableRoomMoveRequestAppStateFastWrites",
      );
      return true;
    } finally {
      runtimeMetrics?.recordOperation?.(
        "tableRoomMoveRequestWrite",
        "total",
        Date.now() - startedAt,
      );
    }
  };
}
