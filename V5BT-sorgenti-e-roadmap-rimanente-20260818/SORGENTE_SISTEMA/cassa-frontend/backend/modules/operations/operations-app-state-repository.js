/**
 * Persistence boundary for operational workflows that still use the legacy
 * application-state snapshot during the PostgreSQL cutover.
 *
 * Keeping this adapter explicit lets handlers and application services depend
 * on the operations repository contract instead of the global readDb/writeDb
 * implementation. The adapter remains deliberately stateless: the canonical
 * source of truth is still the configured app-state repository.
 */
export function createOperationsAppStateRepository({
  readDb,
  writeDb,
  writeStationPresenceDb,
  writeStationStatesDb,
} = {}) {
  if (typeof readDb !== "function") {
    throw new TypeError("operations app-state repository requires readDb");
  }
  if (typeof writeDb !== "function") {
    throw new TypeError("operations app-state repository requires writeDb");
  }

  return Object.freeze({
    read(options) {
      return readDb(options);
    },

    write(snapshot, options) {
      return writeDb(snapshot, options);
    },

    writeStationPresence(snapshot, options) {
      if (typeof writeStationPresenceDb !== "function") {
        throw new TypeError("operations app-state repository requires writeStationPresenceDb");
      }
      return writeStationPresenceDb(snapshot, options);
    },

    writeStationStates(snapshot, options) {
      if (typeof writeStationStatesDb !== "function") {
        throw new TypeError("operations app-state repository requires writeStationStatesDb");
      }
      return writeStationStatesDb(snapshot, options);
    },
  });
}
