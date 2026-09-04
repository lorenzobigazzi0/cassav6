import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOrderHistory,
  configuredStationsFromPayload,
  findStationOccupant,
  formatDurationHHMMSS,
  isHistoricalOrder,
  isRealActiveStation,
  isStationOccupiedByOther,
  normalizeActiveStationsPayload,
  normalizeStationName,
  sortOrdersOperationalFirst,
  stationSessionMatchesIdentity,
  tableLabelForOrder,
} from "../src/stationRuntime.js";

test("station names and configured payload values are normalized and deduplicated", () => {
  assert.equal(normalizeStationName("  postazione attiva Bar principale "), "BAR-1");
  assert.equal(normalizeStationName("caffetteria"), "BAR-1");
  assert.equal(normalizeStationName("Bar 2"), "BAR-2");
  assert.equal(normalizeStationName("undefined"), "");

  assert.deepEqual(
    configuredStationsFromPayload(
      {
        configuredStations: ["bar principale", "PIZZA IN RIVA"],
        integrationStations: [{ name: "bar 2" }],
        workstations: [{ stationName: "Cocktail" }, { id: "BAR-2" }],
        stations: [{ station: "pizza in riva" }, "CHIRINGUITO-1"],
      },
      ["cocktail", "MOBILE"]
    ),
    ["BAR-1", "PIZZA IN RIVA", "BAR-2", "COCKTAIL", "CHIRINGUITO-1", "MOBILE"]
  );
});

test("active-stations payload keeps normalized sessions and exposes only real available ones", () => {
  const base = { active: true, stale: false, realStation: true };
  const payload = {
    ok: true,
    showDemoStations: true,
    configuredStations: ["BAR-1", "BAR-2", "PIZZA IN RIVA"],
    stations: [
      { ...base, station: "Bar principale", operatorUserId: "u1", deviceUuid: "d1" },
      { ...base, station: "BAR-2", stale: true },
      { ...base, station: "PIZZA IN RIVA", active: false },
      { ...base, station: "CHIRINGUITO-1", realStation: false },
      { ...base, station: "CHIRINGUITO-2", isDemoFallback: true },
      { ...base, station: "MOBILE", configuredStation: true },
      { ...base, station: "BAR-3", onPause: true },
      { ...base, station: "BAR-4", pauseStatus: { active: true } },
      { ...base, station: "BAR-5", status: "pausa" },
    ],
  };

  const normalized = normalizeActiveStationsPayload(payload);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.showDemoStations, true);
  assert.equal(normalized.sessions.length, 9);
  assert.deepEqual(normalized.activeStations, ["BAR-1"]);
  assert.equal(normalized.activeSessions[0].operatorUserId, "u1");
  assert.equal(normalized.activeSessions[0].deviceUuid, "d1");
  assert.equal(isRealActiveStation(payload.stations[0]), true);
  assert.equal(isRealActiveStation(payload.stations[1]), false);
  assert.equal(isRealActiveStation(payload.stations[6]), false);
});

test("station occupancy ignores the current identity and detects another operator or device", () => {
  const sessions = [
    {
      station: "BAR-1",
      active: true,
      stale: false,
      realStation: true,
      operatorUserId: "user-current",
      operatorUsername: "mario",
      deviceUuid: "device-current",
    },
    {
      station: "BAR-2",
      active: true,
      stale: false,
      realStation: true,
      operatorUserId: "user-other",
      operatorUsername: "luigi",
      deviceUuid: "device-other",
    },
  ];
  const current = { userId: "user-current", username: "mario", deviceUuid: "device-current" };

  assert.equal(stationSessionMatchesIdentity(sessions[0], current), true);
  assert.equal(isStationOccupiedByOther(sessions, "BAR-1", current), false);
  assert.equal(isStationOccupiedByOther(sessions, "BAR-2", current), true);
  assert.equal(findStationOccupant(sessions, "BAR-2", current)?.operatorUsername, "luigi");
  assert.equal(isStationOccupiedByOther(sessions, "BAR-3", current), false);
});

test("table labels prefer logical labels and timers always use HH:MM:SS", () => {
  assert.equal(tableLabelForOrder({ tableLabel: "Tavolo 12/A", logicalTableLabel: "12" }), "12/A");
  assert.equal(tableLabelForOrder({ logicalTableLabel: "7/B", tableNumber: 7 }), "7/B");
  assert.equal(tableLabelForOrder({ tableNumber: 9.9 }), "9");
  assert.equal(tableLabelForOrder({}, "N/D"), "N/D");

  assert.equal(formatDurationHHMMSS(0), "00:00:00");
  assert.equal(formatDurationHHMMSS(62_999), "00:01:02");
  assert.equal(formatDurationHHMMSS(3_661_999), "01:01:01");
  assert.equal(formatDurationHHMMSS(-1), "00:00:00");
});

test("historical orders are classified and placed after operational orders", () => {
  const orders = [
    { id: "history-old", workflowStatus: "delivered", receivedAtMs: 100 },
    { id: "active-old", workflowStatus: "waiting", receivedAtMs: 200 },
    { id: "history-new", paymentStatus: "paid", receivedAtMs: 400 },
    { id: "active-new", workflowStatus: "prep", receivedAtMs: 300 },
    { id: "history-zero-due", workflowStatus: "waiting", dueAmount: 0, receivedAtMs: 500 },
  ];

  assert.equal(isHistoricalOrder(orders[0]), true);
  assert.equal(isHistoricalOrder(orders[1]), false);
  assert.equal(classifyOrderHistory(orders[2]), "history");
  assert.equal(classifyOrderHistory(orders[3]), "operational");
  assert.deepEqual(
    sortOrdersOperationalFirst(orders).map((order) => order.id),
    ["active-new", "active-old", "history-zero-due", "history-new", "history-old"]
  );
  assert.deepEqual(
    orders.map((order) => order.id),
    ["history-old", "active-old", "history-new", "active-new", "history-zero-due"]
  );
});
