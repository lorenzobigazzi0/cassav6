/**
 * Compatibility boundary for sales workflows that still require the legacy
 * app-state snapshot while PostgreSQL repositories are enabled progressively.
 *
 * The repository is deliberately stateless: it owns no cache and forwards the
 * exact read/write options to the existing infrastructure boundary.
 */
export function createSalesAppStateRepository({ readDb, writeDb } = {}) {
  if (typeof readDb !== "function") {
    throw new TypeError("sales app-state repository requires readDb");
  }
  if (typeof writeDb !== "function") {
    throw new TypeError("sales app-state repository requires writeDb");
  }

  return Object.freeze({
    read(options) {
      return readDb(options);
    },

    write(snapshot, options) {
      return writeDb(snapshot, options);
    },
  });
}
