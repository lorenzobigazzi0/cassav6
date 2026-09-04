import assert from "node:assert/strict";
import test from "node:test";

import {
  collectLoginWorkstations,
  findUserLoginWorkstation,
  resolveUserLoginWorkstations,
} from "../auth/workstation-selection.js";

const settings = {
  workstations: [
    { id: "station_bar", name: "Bar", stationName: "BAR-1", active: true },
    { id: "station_disabled", name: "Spenta", active: false },
  ],
  areas: [
    {
      id: "room_kitchen",
      workstations: [
        { id: "station_kitchen", name: "Cucina", stationName: "CUCINA" },
        { id: "station_bar", name: "Duplicata", stationName: "ALTRO" },
      ],
    },
  ],
};

test("login workstations include only active configured entries and deduplicate ids", () => {
  assert.deepEqual(collectLoginWorkstations(settings), [
    { id: "station_bar", name: "Bar", stationName: "BAR-1" },
    { id: "station_kitchen", name: "Cucina", stationName: "CUCINA" },
  ]);
});

test("an explicit user allowlist is exact and an explicit empty list fails closed", () => {
  assert.deepEqual(
    resolveUserLoginWorkstations({ workstationIds: ["station_kitchen"] }, settings),
    [{ id: "station_kitchen", name: "Cucina", stationName: "CUCINA" }],
  );
  assert.deepEqual(resolveUserLoginWorkstations({ workstationIds: [] }, settings), []);
  assert.equal(
    findUserLoginWorkstation(
      { workstationIds: ["station_kitchen"] },
      settings,
      "station_bar",
    ),
    null,
  );
});

test("legacy users without the workstationIds field retain configured access", () => {
  assert.equal(resolveUserLoginWorkstations({}, settings).length, 2);
});
