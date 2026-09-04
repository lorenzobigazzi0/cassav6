function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireRefresh(name, refresh) {
  if (typeof refresh !== "function") {
    throw new TypeError(`${name} deve essere una funzione`);
  }
  return refresh;
}

async function runMeasuredRefresh(label, refresh, candidate, options) {
  const startedAt = options.now();
  try {
    const refreshed = await refresh(candidate);
    if (!isObjectRecord(refreshed)) {
      throw new TypeError(`${label} non ha restituito uno snapshot valido`);
    }
    return refreshed;
  } catch (error) {
    if (error && typeof error === "object" && !error.orderCreateRefreshStage) {
      error.orderCreateRefreshStage = label;
    }
    throw error;
  } finally {
    options.recordStep(label, Math.max(0, options.now() - startedAt));
  }
}

export async function refreshOrderCreateExternalizedReadsInParallel(options = {}) {
  const db = options.db;
  if (!isObjectRecord(db)) {
    throw new TypeError("db deve essere uno snapshot valido");
  }

  const refreshTableLocks = requireRefresh(
    "refreshTableLocks",
    options.refreshTableLocks,
  );
  const refreshStationStates = requireRefresh(
    "refreshStationStates",
    options.refreshStationStates,
  );
  const now = typeof options.now === "function" ? options.now : Date.now;
  const recordStep =
    typeof options.recordStep === "function" ? options.recordStep : () => {};

  // I refresh lavorano su viste separate. Il db condiviso viene aggiornato
  // soltanto dopo il successo di entrambi, evitando snapshot parziali.
  const tableLocksCandidate = { ...db };
  const stationStatesCandidate = {
    ...db,
    integration: isObjectRecord(db.integration)
      ? { ...db.integration }
      : db.integration,
  };
  const measuredOptions = { now, recordStep };

  const [tableLocksDb, stationStatesDb] = await Promise.all([
    runMeasuredRefresh(
      "refreshTableLocks",
      refreshTableLocks,
      tableLocksCandidate,
      measuredOptions,
    ),
    runMeasuredRefresh(
      "refreshStationStates",
      refreshStationStates,
      stationStatesCandidate,
      measuredOptions,
    ),
  ]);

  db.posSettings = tableLocksDb.posSettings;
  if (isObjectRecord(stationStatesDb.integration)) {
    db.integration = {
      ...(isObjectRecord(db.integration) ? db.integration : {}),
      stationStates: stationStatesDb.integration.stationStates,
    };
  }
  return db;
}
