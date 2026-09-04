function normalizeIds(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function hasDomainSelection(selection = {}) {
  return [
    ...(Array.isArray(selection.domainArrayEntries)
      ? selection.domainArrayEntries
      : []),
    ...(Array.isArray(selection.objectArrayEntries)
      ? selection.objectArrayEntries
      : []),
    ...(Array.isArray(selection.objectFields) ? selection.objectFields : []),
  ].some((entry) => {
    const ids = entry?.entryIds ?? entry?.fieldNames;
    return Array.isArray(ids) && ids.some((value) => String(value ?? "").trim());
  });
}

export function createMysqlAtomicSelectionWriter(options = {}) {
  const enabled = options.enabled === true;
  const mysqlRepository = options.mysqlRepository;
  const domainsRepository = options.domainsRepository;
  const auditEventsRepository = options.auditEventsRepository;
  const runtimeMetrics = options.runtimeMetrics;
  const refreshHealthSnapshot =
    typeof options.refreshHealthSnapshot === "function"
      ? options.refreshHealthSnapshot
      : () => {};

  const increment = (name, value = 1) =>
    runtimeMetrics?.incrementCounter?.(name, value);
  const record = (label, startedAt) =>
    runtimeMetrics?.recordOperation?.(
      "mysqlAtomicSelection",
      label,
      Date.now() - startedAt,
    );

  async function write(appState, request = {}) {
    const auditEventIds = normalizeIds(request.auditEventIds);
    const domainSelection = request.domainSelection ?? {};
    const needsDomains = hasDomainSelection(domainSelection);
    const needsAudit = auditEventIds.length > 0;
    if (!needsDomains && !needsAudit) {
      return { written: true, selectedRows: 0, changedRows: 0, auditRows: 0 };
    }

    const canWriteDomains =
      !needsDomains ||
      (domainsRepository?.enabled === true &&
        typeof domainsRepository.syncSelectedEntriesFromAppState === "function");
    const canWriteAudit =
      !needsAudit ||
      (auditEventsRepository?.enabled === true &&
        typeof auditEventsRepository.syncEntriesFromAppState === "function");
    const canAcquireConnection =
      mysqlRepository && typeof mysqlRepository.getPool === "function";
    if (!enabled || !canWriteDomains || !canWriteAudit || !canAcquireConnection) {
      increment("mysqlAtomicSelectionFallbacks");
      return {
        written: false,
        reason: !enabled
          ? "disabled"
          : !canAcquireConnection
            ? "mysql_unavailable"
            : !canWriteDomains
              ? "domains_repository_unavailable"
              : "audit_repository_unavailable",
      };
    }

    const totalStartedAt = Date.now();
    await domainsRepository.ensureStorage?.();
    if (needsAudit) await auditEventsRepository.ensureStorage?.();
    const pool = await mysqlRepository.getPool();
    const connection = await pool.getConnection();
    let transactionStarted = false;
    try {
      const beginStartedAt = Date.now();
      await connection.beginTransaction();
      transactionStarted = true;
      record("begin", beginStartedAt);

      const domainResult = needsDomains
        ? await domainsRepository.syncSelectedEntriesFromAppState(
            appState,
            domainSelection,
            {
              connection,
              metricPrefix:
                String(request.metricLabel ?? "").trim() ||
                "atomicSelection",
              preserveNewerIntegrationRecords:
                request.preserveNewerIntegrationRecords === true,
              preserveNewerPaymentMirrorRecords:
                request.preserveNewerPaymentMirrorRecords === true,
            },
          )
        : { selectedRows: 0, changedRows: 0, domains: [] };
      const auditRows = needsAudit
        ? await auditEventsRepository.syncEntriesFromAppState(
            appState,
            auditEventIds,
            { connection },
          )
        : 0;

      const commitStartedAt = Date.now();
      await connection.commit();
      transactionStarted = false;
      record("commit", commitStartedAt);
      increment("mysqlAtomicSelectionWrites");
      refreshHealthSnapshot(appState);
      return {
        written: true,
        selectedRows: domainResult?.selectedRows ?? 0,
        changedRows: domainResult?.changedRows ?? 0,
        domains: domainResult?.domains ?? [],
        auditRows,
      };
    } catch (error) {
      increment("mysqlAtomicSelectionErrors");
      if (transactionStarted) {
        try {
          const rollbackStartedAt = Date.now();
          await connection.rollback();
          increment("mysqlAtomicSelectionRollbacks");
          record("rollback", rollbackStartedAt);
        } catch {
          increment("mysqlAtomicSelectionRollbackErrors");
        }
      }
      throw error;
    } finally {
      connection.release();
      record("total", totalStartedAt);
    }
  }

  return { enabled, write };
}
