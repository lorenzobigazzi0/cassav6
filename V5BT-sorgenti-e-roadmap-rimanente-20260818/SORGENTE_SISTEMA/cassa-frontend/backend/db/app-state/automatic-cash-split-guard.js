export function createAutomaticCashSplitGuard({ repository, cloneJson } = {}) {
  const canRead = repository?.enabled === true && typeof repository.readObjectEntry === "function";
  const canWrite = repository?.enabled === true && typeof repository.syncObjectEntryFromAppState === "function";

  async function beforeDomainSync({ selectedDomains = null, requestRoute = "" } = {}) {
    const syncsPosSettings = !selectedDomains || selectedDomains.has("posSettings");
    if (!canRead || String(requestRoute).includes("/api/automatic-cash/")) {
      return { preserve: false, refresh: false, syncOptions: {} };
    }
    const current = await repository.readObjectEntry("posSettings", "automaticCash", null);
    return current === null
      ? { preserve: false, refresh: false, syncOptions: {} }
      : {
          preserve: syncsPosSettings,
          refresh: true,
          syncOptions: syncsPosSettings
            ? { preserveObjectEntriesByDomain: { posSettings: ["automaticCash"] } }
            : {},
        };
  }

  async function afterDomainSync({ guard, states = [] } = {}) {
    if (!guard?.refresh || !canRead) return;
    const current = await repository.readObjectEntry("posSettings", "automaticCash", null);
    if (current === null) return;
    for (const state of new Set(states)) {
      if (!state?.posSettings || typeof state.posSettings !== "object") continue;
      state.posSettings.automaticCash = cloneJson(current, current);
    }
  }

  async function refreshState(state) {
    if (!canRead || !state?.posSettings || typeof state.posSettings !== "object") return state;
    const current = await repository.readObjectEntry("posSettings", "automaticCash", null);
    if (current !== null) state.posSettings.automaticCash = cloneJson(current, current);
    return state;
  }

  async function writeEntry(db, { dbMode, writeDb, refreshHealthSnapshot } = {}) {
    if (dbMode === "mysql" && canWrite) {
      await repository.syncObjectEntryFromAppState(db, "posSettings", "automaticCash");
      refreshHealthSnapshot?.(db);
      return;
    }
    await writeDb(db, {
      metricLabel: "automaticCash.appStateWrite",
      splitDomains: ["posSettings"],
    });
  }

  return { afterDomainSync, beforeDomainSync, refreshState, writeEntry };
}
