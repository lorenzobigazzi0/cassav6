import assert from "node:assert/strict";
import test from "node:test";

import { ensureV5btOrderTableCapacity } from "./v5bt-order-table-capacity.mjs";

function handheld(id, authorizedRoomIds = []) {
  return {
    id,
    kind: "handheld",
    session: { user: { authorizedRoomIds } },
  };
}

test("aggiunge al palmare ristretto solo tavoli runtime autorizzati", () => {
  const existing = [
    { id: "pedana-1", roomId: "pedana" },
    { id: "sala-1", roomId: "sala" },
  ];
  const runtime = [
    { id: "sala-2", roomId: "sala" },
    { id: "pedana-2", roomId: "pedana" },
    { id: "pedana-3", roomId: "pedana" },
  ];

  const result = ensureV5btOrderTableCapacity({
    handhelds: [handheld("mobile-20", ["pedana"])],
    orderTables: existing,
    runtimeTables: runtime,
    minimumPerHandheld: 3,
  });

  assert.deepEqual(
    result.addedTables.map((table) => table.id),
    ["pedana-2", "pedana-3"],
  );
  assert.deepEqual(result.capacityByHandheld, [
    { deviceId: "mobile-20", authorizedTables: 3 },
  ]);
  assert.equal(result.orderTables.some((table) => table.id === "sala-2"), false);
});

test("non reinserisce tavoli fixture esclusi dal pool runtime", () => {
  const result = ensureV5btOrderTableCapacity({
    handhelds: [handheld("mobile-1", ["sala"])],
    orderTables: [{ id: "sala-1", roomId: "sala" }],
    runtimeTables: [
      { id: "fixture-1", roomId: "sala" },
      { id: "sala-2", roomId: "sala" },
      { id: "sala-3", roomId: "sala" },
    ],
    excludedTableIds: new Set(["fixture-1"]),
    minimumPerHandheld: 3,
  });

  assert.deepEqual(
    result.orderTables.map((table) => table.id),
    ["sala-1", "sala-2", "sala-3"],
  );
  assert.equal(result.addedTables.some((table) => table.id === "fixture-1"), false);
});

test("riusa un tavolo runtime compatibile tra palmari della stessa sala", () => {
  const result = ensureV5btOrderTableCapacity({
    handhelds: [handheld("mobile-1", ["sala"]), handheld("mobile-2", ["sala"])],
    orderTables: [
      { id: "sala-1", roomId: "sala" },
      { id: "sala-2", roomId: "sala" },
    ],
    runtimeTables: [{ id: "sala-3", roomId: "sala" }],
    minimumPerHandheld: 3,
  });

  assert.equal(result.addedTables.length, 1);
  assert.deepEqual(result.capacityByHandheld, [
    { deviceId: "mobile-1", authorizedTables: 3 },
    { deviceId: "mobile-2", authorizedTables: 3 },
  ]);
});

test("fallisce se i runtime compatibili non raggiungono la soglia", () => {
  assert.throws(
    () =>
      ensureV5btOrderTableCapacity({
        handhelds: [handheld("mobile-20", ["pedana"])],
        orderTables: [{ id: "pedana-1", roomId: "pedana" }],
        runtimeTables: [{ id: "sala-1", roomId: "sala" }],
        minimumPerHandheld: 3,
      }),
    /mobile-20.*\(1\/3\)/,
  );
});

test("ignora le postazioni nel calcolo della capacità mobile", () => {
  const result = ensureV5btOrderTableCapacity({
    handhelds: [
      handheld("mobile-1", ["sala"]),
      { id: "station-1", kind: "station", session: { user: {} } },
    ],
    orderTables: [{ id: "sala-1", roomId: "sala" }],
    runtimeTables: [{ id: "sala-2", roomId: "sala" }],
    minimumPerHandheld: 2,
  });

  assert.deepEqual(result.capacityByHandheld, [
    { deviceId: "mobile-1", authorizedTables: 2 },
  ]);
});

test("non modifica pool ed esclusioni ricevuti", () => {
  const orderTables = [{ id: "sala-1", roomId: "sala" }];
  const runtimeTables = [{ id: "sala-2", roomId: "sala" }];
  const excludedTableIds = new Set(["fixture-1"]);

  ensureV5btOrderTableCapacity({
    handhelds: [handheld("mobile-1", ["sala"])],
    orderTables,
    runtimeTables,
    excludedTableIds,
    minimumPerHandheld: 2,
  });

  assert.deepEqual(orderTables, [{ id: "sala-1", roomId: "sala" }]);
  assert.deepEqual(runtimeTables, [{ id: "sala-2", roomId: "sala" }]);
  assert.deepEqual([...excludedTableIds], ["fixture-1"]);
});
