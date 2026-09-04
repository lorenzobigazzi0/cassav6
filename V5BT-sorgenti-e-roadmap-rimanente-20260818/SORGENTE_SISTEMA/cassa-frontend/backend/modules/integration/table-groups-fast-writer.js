export function createTableGroupsFastWriter(options = {}) {
  const repository = options.repository;
  const enabled =
    options.dbMode === "mysql" &&
    repository?.enabled === true &&
    typeof repository.syncObjectEntryFromAppState === "function" &&
    typeof options.syncIntegrationObjectFields === "function" &&
    typeof options.syncPosSettingsTables === "function";
  const refreshHealthSnapshot =
    typeof options.refreshHealthSnapshot === "function"
      ? options.refreshHealthSnapshot
      : () => {};
  const writePrintSpool =
    typeof options.writePrintSpool === "function"
      ? options.writePrintSpool
      : async () => {};

  return async function writeTableGroupsFast(db, writeOptions = {}) {
    if (!enabled) {
      options.runtimeMetrics?.incrementCounter?.("tableGroupsFastFallbacks");
      return false;
    }
    const tableIds = [
      ...new Set(
        (Array.isArray(writeOptions.tableIds)
          ? writeOptions.tableIds
          : [writeOptions.tableIds]
        )
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean),
      ),
    ];
    await options.syncIntegrationObjectFields(repository, db, ["tableGroups"]);
    await options.syncIntegrationObjectFields(repository, db, ["lastWriteAt"]);
    if (tableIds.length > 0) await options.syncPosSettingsTables(db, tableIds);
    const printJobIds = [
      ...new Set(
        (Array.isArray(writeOptions.printJobIds)
          ? writeOptions.printJobIds
          : [writeOptions.printJobIds]
        )
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean),
      ),
    ];
    if (writeOptions.printJobsChanged === true) {
      await writePrintSpool(db, printJobIds);
    }
    options.runtimeMetrics?.incrementCounter?.("tableGroupsFastWrites");
    refreshHealthSnapshot(db);
    return true;
  };
}
