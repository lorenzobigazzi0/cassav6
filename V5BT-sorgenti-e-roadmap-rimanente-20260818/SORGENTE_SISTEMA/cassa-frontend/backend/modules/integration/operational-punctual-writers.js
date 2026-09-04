function ids(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => String(value ?? "").trim()).filter(Boolean))];
}

export function createOperationalPunctualWriters(options = {}) {
  const repository = options.repository;
  const enabled = options.dbMode === "mysql" && repository?.enabled === true &&
    typeof repository.syncDomainArrayEntriesFromAppState === "function" &&
    typeof repository.syncObjectArrayEntriesAndObjectEntriesFromAppState === "function";
  const finish = (db, counter) => {
    options.runtimeMetrics?.incrementCounter?.(counter);
    options.refreshHealthSnapshot?.(db);
    return true;
  };

  async function roomSession(db, mutation = {}) {
    const userIds = ids(mutation.userIds), sessionIds = ids(mutation.sessionIds);
    if (!enabled || userIds.length === 0 || sessionIds.length === 0 ||
      typeof options.syncSessionEntries !== "function") return false;
    await Promise.all([
      repository.syncDomainArrayEntriesFromAppState(db, "users", userIds),
      options.syncSessionEntries(db, sessionIds),
    ]);
    return finish(db, "roomSessionPunctualWrites");
  }

  async function reservation(db, mutation = {}) {
    const stateKeys = ids(mutation.reservationStateKeys);
    if (!enabled || stateKeys.length === 0 || mutation.requiresFullFallback === true) return false;
    await repository.syncDomainArrayEntriesFromAppState(db, "posReservationStates", stateKeys);
    const tableIds = ids(mutation.tableIds);
    if (tableIds.length > 0) await options.syncPosSettingsTables?.(db, tableIds);
    if (mutation.integrationTableGroupsChanged === true) {
      await options.syncIntegrationObjectFields?.(repository, db, ["tableGroups", "lastWriteAt"]);
    }
    return finish(db, "reservationPunctualWrites");
  }

  async function tableMove(db, mutation = {}) {
    if (!enabled || mutation.requiresFullFallback === true) return false;
    const tableIds = ids(mutation.tableIds), orderIds = ids(mutation.orderIds);
    if (tableIds.length !== 2) return false;
    await options.syncPosSettingsTables?.(db, tableIds);
    await repository.syncObjectArrayEntriesAndObjectEntriesFromAppState(db, "integration", {
      objectArrayEntries: orderIds.length > 0 ? [{ fieldName: "orders", entryIds: orderIds }] : [],
      objectFields: ["lastWriteAt"],
    });
    const auditEventIds = ids(mutation.auditEventIds);
    if (auditEventIds.length > 0) await options.syncAuditEvents?.(db, auditEventIds);
    const printJobIds = ids(mutation.printJobIds);
    if (printJobIds.length > 0) await options.syncPrintSpoolEntries?.(db, printJobIds);
    return finish(db, "tableMovePunctualWrites");
  }

  return { enabled, reservation, roomSession, tableMove };
}
