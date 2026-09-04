import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupeConfiguredIntegrationStations,
  isInvalidIntegrationStationName,
  normalizeConfiguredIntegrationStationName,
  normalizeIntegrationStationName,
  normalizeOptionalIntegrationStationName,
  resolveConfiguredIntegrationStations,
  resolveConfiguredIntegrationStationsFromSettings,
  resolvePrimaryIntegrationStation,
} from "../modules/integration/stations.domain.js";

test("integration stations normalizza nomi e scarta placeholder non validi", () => {
  assert.equal(normalizeIntegrationStationName(" bar 1 "), "bar 1");
  assert.equal(normalizeIntegrationStationName("", "BAR-1"), "BAR-1");
  assert.equal(normalizeOptionalIntegrationStationName(""), null);
  assert.equal(normalizeOptionalIntegrationStationName("mobile"), "mobile");
  assert.equal(isInvalidIntegrationStationName("undefined"), true);
  assert.equal(isInvalidIntegrationStationName("Postazione"), true);
  assert.equal(isInvalidIntegrationStationName("BAR-1"), false);
  assert.equal(normalizeConfiguredIntegrationStationName(" undefined "), "");
});

test("integration stations deduplica e conserva ordine configurato", () => {
  assert.deepEqual(dedupeConfiguredIntegrationStations(["bar-1", "BAR 1", "bar-2", "station", "mobile"]), [
    "BAR-1",
    "BAR 1",
    "BAR-2",
    "MOBILE",
  ]);
});

test("integration stations legge solo postazioni abilitate da settings/db", () => {
  const settings = {
    workstations: [
      { id: "ws_1", stationName: "BAR-1", enabled: true },
      { id: "ws_2", stationName: "BAR-2", enabled: false },
      { id: "ws_3", station: "CHIRINGUITO-1", status: "enabled" },
      { id: "ws_4", name: "MOBILE", status: "disabled" },
    ],
  };

  assert.deepEqual(resolveConfiguredIntegrationStationsFromSettings(settings), ["BAR-1", "CHIRINGUITO-1"]);
  assert.deepEqual(resolveConfiguredIntegrationStations({ posSettings: settings }), ["BAR-1", "CHIRINGUITO-1"]);
  assert.equal(resolvePrimaryIntegrationStation({ posSettings: settings }, "FALLBACK"), "BAR-1");
  assert.equal(resolvePrimaryIntegrationStation({ workstations: [] }, "FALLBACK"), "FALLBACK");
});
