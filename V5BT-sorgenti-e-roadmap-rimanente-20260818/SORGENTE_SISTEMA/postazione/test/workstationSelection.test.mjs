import assert from "node:assert/strict";
import test from "node:test";

import {
  findAvailableWorkstation,
  normalizeAvailableWorkstations,
  normalizeSelectedWorkstation,
} from "../src/workstationSelection.js";

test("normalizza soltanto la allowlist restituita dal login", () => {
  const workstations = normalizeAvailableWorkstations({
    availableWorkstations: [
      { id: "station_bar_1", name: "Bar principale", stationName: "BAR-1" },
      { id: "station_bar_1", name: "Duplicata", stationName: "BAR-1" },
      { id: "", name: "Invalida", stationName: "BAR-2" },
      { id: "station_bar_2", name: "Spenta", stationName: "BAR-2", active: false },
      { id: "station_name_only", name: "Senza nome operativo" },
      "BAR-2",
    ],
  });

  assert.deepEqual(workstations, [
    { id: "station_bar_1", name: "Bar principale", stationName: "BAR-1" },
  ]);
});

test("una risposta assente o malformata non usa fallback locali", () => {
  assert.deepEqual(normalizeAvailableWorkstations(null), []);
  assert.deepEqual(normalizeAvailableWorkstations({}), []);
  assert.deepEqual(
    normalizeAvailableWorkstations({ availableWorkstations: ["BAR-1"] }),
    [],
  );
});

test("la postazione confermata e la ricerca usano l'identificatore server", () => {
  const list = [
    { id: "station_bar_2", name: "Bar due", stationName: "BAR-2" },
  ];
  assert.deepEqual(findAvailableWorkstation(list, "station_bar_2"), list[0]);
  assert.equal(findAvailableWorkstation(list, "BAR-2"), null);
  assert.deepEqual(
    normalizeSelectedWorkstation({ selectedWorkstation: list[0] }),
    list[0],
  );
});
