/**
 * Legacy app-state boundary for reservation workflows during the PostgreSQL
 * cutover. Relational repositories remain authoritative whenever their feature
 * flags are enabled; this adapter owns only the compatibility snapshot access
 * and the existing punctual-write strategies.
 */
export function createReservationsAppStateRepository({
  readDb,
  writeDb,
  writeRoomDb,
  writeTableRoomMoveRequestAppStateFastDb,
  writeTableSyncAppStateFastDb,
} = {}) {
  if (typeof readDb !== "function") {
    throw new TypeError("reservations app-state repository requires readDb");
  }
  if (typeof writeDb !== "function") {
    throw new TypeError("reservations app-state repository requires writeDb");
  }
  if (typeof writeRoomDb !== "function") {
    throw new TypeError("reservations app-state repository requires writeRoomDb");
  }

  return Object.freeze({
    read(options) {
      return readDb(options);
    },

    write(snapshot, options) {
      return writeDb(snapshot, options);
    },

    writeRoom(snapshot, options) {
      return writeRoomDb(snapshot, options);
    },

    writeTableRoomMoveRequest(snapshot, options) {
      if (typeof writeTableRoomMoveRequestAppStateFastDb !== "function") {
        throw new TypeError(
          "reservations app-state repository requires writeTableRoomMoveRequestAppStateFastDb",
        );
      }
      return writeTableRoomMoveRequestAppStateFastDb(snapshot, options);
    },

    writeTableSync(snapshot, options) {
      if (typeof writeTableSyncAppStateFastDb !== "function") {
        throw new TypeError(
          "reservations app-state repository requires writeTableSyncAppStateFastDb",
        );
      }
      return writeTableSyncAppStateFastDb(snapshot, options);
    },
  });
}
