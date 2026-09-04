import assert from "node:assert/strict";
import test from "node:test";

import {
  V5BT_ORDER_TABLE_AVAILABILITY_TIMEOUT,
  V5btOrderTableAvailabilityTimeoutError,
  acquireV5btOrderCreateTable,
} from "./v5bt-order-table-acquisition.mjs";

test("attende una contesa locale e riserva atomicamente il primo tavolo liberato", async () => {
  const inFlightTableIds = new Set(["table-1", "table-2"]);
  let now = 1_000;
  const waits = [];

  const acquired = await acquireV5btOrderCreateTable({
    authorizedTables: [{ id: "table-1" }, { id: "table-2" }],
    inFlightTableIds,
    timeoutMs: 500,
    pollIntervalMs: 50,
    monotonicNow: () => now,
    wait: async (delayMs) => {
      waits.push(delayMs);
      now += delayMs;
      if (waits.length === 2) inFlightTableIds.delete("table-2");
    },
  });

  assert.equal(acquired.tableId, "table-2");
  assert.equal(acquired.scanCount, 3);
  assert.equal(acquired.waitedMs, 100);
  assert.deepEqual(waits, [50, 50]);
  assert.equal(inFlightTableIds.has("table-2"), true);
});

test("due acquisizioni concorrenti non ricevono lo stesso tavolo", async () => {
  const inFlightTableIds = new Set();
  const tables = [{ id: "table-1" }, { id: "table-2" }];

  const [first, second] = await Promise.all([
    acquireV5btOrderCreateTable({
      authorizedTables: tables,
      inFlightTableIds,
      selectTable: (available) => available[0],
    }),
    acquireV5btOrderCreateTable({
      authorizedTables: tables,
      inFlightTableIds,
      selectTable: (available) => available[0],
    }),
  ]);

  assert.notEqual(first.tableId, second.tableId);
  assert.deepEqual([...inFlightTableIds].sort(), ["table-1", "table-2"]);
});

test("il timeout e' tipizzato e non altera le prenotazioni esistenti", async () => {
  const inFlightTableIds = new Set(["table-1"]);
  let now = 50;

  await assert.rejects(
    acquireV5btOrderCreateTable({
      authorizedTables: [{ id: "table-1" }],
      inFlightTableIds,
      timeoutMs: 120,
      pollIntervalMs: 50,
      monotonicNow: () => now,
      wait: async (delayMs) => {
        now += delayMs;
      },
    }),
    (error) => {
      assert.ok(error instanceof V5btOrderTableAvailabilityTimeoutError);
      assert.equal(error.code, V5BT_ORDER_TABLE_AVAILABILITY_TIMEOUT);
      assert.equal(error.timeoutMs, 120);
      assert.equal(error.authorizedTableCount, 1);
      assert.equal(error.scanCount, 4);
      return true;
    },
  );
  assert.deepEqual([...inFlightTableIds], ["table-1"]);
});

test("rispetta esclusioni fixture, deduplica gli ID e valida il selettore", async () => {
  const inFlightTableIds = new Set();
  const acquired = await acquireV5btOrderCreateTable({
    authorizedTables: [
      { id: "table-1" },
      { id: "table-1" },
      { id: "table-2" },
    ],
    reservedTableIds: new Set(["table-1"]),
    inFlightTableIds,
  });
  assert.equal(acquired.tableId, "table-2");

  await assert.rejects(
    acquireV5btOrderCreateTable({
      authorizedTables: [{ id: "table-3" }],
      inFlightTableIds: new Set(),
      selectTable: () => ({ id: "table-foreign" }),
    }),
    /tavolo disponibile/,
  );
});
