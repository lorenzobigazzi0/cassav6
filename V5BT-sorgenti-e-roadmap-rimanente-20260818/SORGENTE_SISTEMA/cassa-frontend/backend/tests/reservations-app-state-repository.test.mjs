import assert from "node:assert/strict";
import test from "node:test";

import { createReservationsAppStateRepository } from "../modules/reservations/index.js";

function createInfrastructure(overrides = {}) {
  return {
    readDb: async () => ({}),
    writeDb: async () => undefined,
    writeRoomDb: async () => undefined,
    ...overrides,
  };
}

test("reservations repository forwards reads without owning a second snapshot", async () => {
  const snapshot = { posReservationStates: [] };
  const calls = [];
  const repository = createReservationsAppStateRepository(
    createInfrastructure({
      readDb: async (options) => {
        calls.push(options);
        return snapshot;
      },
    }),
  );

  const result = await repository.read({ forceReload: true });

  assert.equal(result, snapshot);
  assert.deepEqual(calls, [{ forceReload: true }]);
});

test("reservations repository preserves generic and room write contracts", async () => {
  const snapshot = { posReservationStates: [] };
  const calls = [];
  const repository = createReservationsAppStateRepository(
    createInfrastructure({
      writeDb: async (value, options) => {
        calls.push({ kind: "reservation", value, options });
        return "reservation-write";
      },
      writeRoomDb: async (value, options) => {
        calls.push({ kind: "room", value, options });
        return "room-write";
      },
    }),
  );

  assert.equal(await repository.write(snapshot, { splitDomains: ["posReservations"] }), "reservation-write");
  assert.equal(await repository.writeRoom(snapshot, { splitDomains: ["posRoomChangeRequests"] }), "room-write");
  assert.equal(calls[0].value, snapshot);
  assert.equal(calls[1].value, snapshot);
});

test("reservations repository delegates punctual table writes", async () => {
  const snapshot = { posSettings: { areas: [] } };
  const calls = [];
  const repository = createReservationsAppStateRepository(
    createInfrastructure({
      writeTableRoomMoveRequestAppStateFastDb: async (value, options) => {
        calls.push({ kind: "move", value, options });
        return true;
      },
      writeTableSyncAppStateFastDb: async (value, options) => {
        calls.push({ kind: "sync", value, options });
        return false;
      },
    }),
  );

  assert.equal(await repository.writeTableRoomMoveRequest(snapshot, { requestId: "move-1" }), true);
  assert.equal(await repository.writeTableSync(snapshot, { tableId: "table-1" }), false);
  assert.deepEqual(calls.map((entry) => entry.kind), ["move", "sync"]);
});

test("reservations repository rejects incomplete infrastructure wiring", () => {
  assert.throws(
    () => createReservationsAppStateRepository({ readDb: async () => ({}) }),
    /requires writeDb/,
  );
  assert.throws(
    () => createReservationsAppStateRepository({ readDb: async () => ({}), writeDb: async () => undefined }),
    /requires writeRoomDb/,
  );
});
