/**
 * Compatibility boundary for payment workflows that still need the legacy
 * app-state snapshot during the PostgreSQL cutover.
 *
 * Domain-specific writers remain authoritative for payment, provider and
 * fiscal mutations. This adapter centralizes the remaining snapshot reads and
 * the generic fallbacks without owning or caching a second copy of the state.
 */
export function createPaymentsAppStateRepository({
  readAutomaticCashDb,
  readDb,
  writeAutomaticCashDb,
  writeCounterCollectionDb,
  writeDb,
} = {}) {
  if (typeof readDb !== "function") {
    throw new TypeError("payments app-state repository requires readDb");
  }
  if (typeof writeDb !== "function") {
    throw new TypeError("payments app-state repository requires writeDb");
  }

  return Object.freeze({
    read(options) {
      return readDb(options);
    },

    readAutomaticCash(options) {
      return typeof readAutomaticCashDb === "function"
        ? readAutomaticCashDb(options)
        : readDb(options);
    },

    write(snapshot, options) {
      return writeDb(snapshot, options);
    },

    writeAutomaticCash(snapshot) {
      return typeof writeAutomaticCashDb === "function"
        ? writeAutomaticCashDb(snapshot)
        : writeDb(snapshot);
    },

    writeCounterCollection(snapshot, mutation, fallbackOptions) {
      return typeof writeCounterCollectionDb === "function"
        ? writeCounterCollectionDb(snapshot, mutation)
        : writeDb(snapshot, fallbackOptions);
    },
  });
}
