import test from "node:test";
import assert from "node:assert/strict";
import { createIntegrationStationStateHelpers } from "../modules/integration/station-states.domain.js";
import {
  dedupeConfiguredIntegrationStations,
  normalizeIntegrationStationName,
} from "../modules/integration/stations.domain.js";

function createHelpers(overrides = {}) {
  return createIntegrationStationStateHelpers({
    normalizeUsername: (value) => String(value ?? "").trim().toLowerCase(),
    normalizeClientApp: (value) => String(value ?? "postazione").trim() || "postazione",
    normalizeIntegrationStationName,
    dedupeConfiguredIntegrationStations,
    primaryIntegrationStation: "",
    integrationStations: ["BAR-1"],
    stationStaleMs: 60_000,
    heartbeatWriteMinIntervalMs: 45_000,
    showDemoStations: false,
    nowMs: () => 1_000_000,
    ...overrides,
  });
}

test("station states normalizza una postazione reale e calcola key stabile", () => {
  const helpers = createHelpers();
  const entry = helpers.sanitizeIntegrationStationStateEntry({
    station: "BAR-1",
    operatorName: "Roberto",
    operatorRole: "Bar",
    operatorUserId: "user_roberto",
    deviceUuid: "device-1",
    active: true,
    autoPrintOrders: true,
    updatedAtMs: 990_000,
  });

  assert.equal(entry.station, "BAR-1");
  assert.equal(entry.realStation, true);
  assert.equal(entry.active, true);
  assert.equal(entry.stale, false);
  assert.equal(helpers.integrationStationStateKey(entry), "BAR-1::user_roberto");
});

test("station states disattiva demo fallback quando non abilitati", () => {
  const helpers = createHelpers({ showDemoStations: false });
  const entry = helpers.sanitizeIntegrationStationStateEntry({
    station: "BAR-1",
    operatorName: "Guest",
    operatorRole: "Non autenticato",
    active: true,
  });

  assert.equal(entry.isDemoFallback, true);
  assert.equal(entry.realStation, false);
  assert.equal(entry.active, false);
});

test("station states marca stale le postazioni reali troppo vecchie", () => {
  const helpers = createHelpers();
  const entry = helpers.sanitizeIntegrationStationStateEntry({
    station: "BAR-1",
    deviceUuid: "device-1",
    active: true,
    updatedAtMs: 900_000,
  });

  assert.equal(helpers.isIntegrationStationStale(900_000, 1_000_000), true);
  assert.equal(entry.stale, true);
  assert.equal(entry.active, false);
});

test("station states mantiene eleggibile la postazione entro la finestra operativa di 5 minuti", () => {
  const helpers = createHelpers({ stationStaleMs: 5 * 60_000 });
  const entry = helpers.sanitizeIntegrationStationStateEntry({
    station: "BAR-1",
    deviceUuid: "device-1",
    active: true,
    updatedAtMs: 1_000_000 - 2 * 60_000,
  });

  assert.equal(helpers.isIntegrationStationStale(1_000_000 - 2 * 60_000, 1_000_000), false);
  assert.equal(entry.stale, false);
  assert.equal(entry.active, true);
});

test("station states aggiunge placeholder configurati e filtra station non configurate inattive", () => {
  const helpers = createHelpers();
  const states = helpers.buildIntegrationStationStates(
    {
      stationStates: [
        { station: "BAR-1", deviceUuid: "device-1", active: true, updatedAtMs: 990_000 },
        { station: "OLD-STATION", active: false, updatedAtMs: 990_000 },
      ],
    },
    ["BAR-1", "BAR-2"]
  );

  assert.deepEqual(states.map((entry) => entry.station), ["BAR-1", "BAR-2"]);
  assert.equal(states[0].realStation, true);
  assert.equal(states[1].configuredStation, true);
  assert.equal(states[1].active, false);
});

test("station states throttle heartbeat ma persiste cambi o stato inattivo", () => {
  const helpers = createHelpers();
  const current = { station: "BAR-1", deviceUuid: "device-1", active: true, updatedAtMs: 990_000 };
  const sameFast = { station: "BAR-1", deviceUuid: "device-1", active: true, updatedAtMs: 999_000 };
  const sameSlow = { station: "BAR-1", deviceUuid: "device-1", active: true, updatedAtMs: 999_000 };
  const changed = { station: "BAR-1", deviceUuid: "device-1", active: true, autoPrintOrders: true, updatedAtMs: 999_000 };
  const inactive = { station: "BAR-1", deviceUuid: "device-1", active: false, updatedAtMs: 999_000 };

  assert.equal(helpers.shouldPersistIntegrationStationHeartbeat(current, sameFast, 1_000_000), false);
  assert.equal(helpers.shouldPersistIntegrationStationHeartbeat(current, sameSlow, 1_040_000), true);
  assert.equal(helpers.shouldPersistIntegrationStationHeartbeat(current, changed, 1_000_000), true);
  assert.equal(helpers.shouldPersistIntegrationStationHeartbeat(current, inactive, 1_000_000), true);
});

test("station states non persiste heartbeat identico se cambiano solo label operatore", () => {
  const helpers = createHelpers();
  const current = {
    station: "BAR-1",
    deviceUuid: "device-1",
    operatorUserId: "u_roberto",
    operatorUsername: "roberto",
    operatorName: "Roberto",
    operatorRole: "Operatore",
    active: true,
    updatedAtMs: 990_000,
  };
  const sameOperationalState = {
    ...current,
    operatorName: "Roberto Pratesi",
    operatorRole: "Responsabile sala",
    updatedAtMs: 999_000,
  };

  assert.equal(
    helpers.shouldPersistIntegrationStationHeartbeat(current, sameOperationalState, 1_000_000),
    false
  );
});

test("logout postazione disattiva solo lo stato della sessione e del dispositivo indicati", () => {
  const helpers = createHelpers();
  const states = [
    {
      station: "BAR-1",
      active: true,
      operatorUserId: "u_roberto",
      operatorName: "Roberto",
      deviceUuid: "device-roberto",
      updatedAtMs: 990_000,
    },
    {
      station: "BAR-1",
      active: true,
      operatorUserId: "u_lorenzo",
      operatorName: "Lorenzo",
      deviceUuid: "device-lorenzo",
      updatedAtMs: 990_000,
    },
  ];

  const result = helpers.deactivateIntegrationStationStatesForSession(states, {
    session: {
      clientApp: "postazione",
      deviceUuid: "device-roberto",
      userId: "u_roberto",
    },
    user: { id: "u_roberto" },
    payload: { station: "BAR-1" },
    updatedAtMs: 1_000_000,
  });

  assert.equal(result.changed, true);
  assert.equal(result.deactivated.length, 1);
  assert.equal(result.deactivated[0].active, false);
  assert.equal(result.deactivated[0].updatedAtMs, 1_000_000);
  assert.equal(result.stationStates[1].active, true);
  assert.equal(states[0].active, true, "la transizione non deve mutare l'input");
});

test("logout non postazione non modifica gli stati operativi", () => {
  const helpers = createHelpers();
  const states = [
    {
      station: "BAR-1",
      active: true,
      operatorUserId: "u_roberto",
      deviceUuid: "device-roberto",
      updatedAtMs: 990_000,
    },
  ];

  const result = helpers.deactivateIntegrationStationStatesForSession(states, {
    session: {
      clientApp: "mobile-frontend",
      deviceUuid: "device-roberto",
      userId: "u_roberto",
    },
    user: { id: "u_roberto" },
    payload: { station: "BAR-1" },
  });

  assert.equal(result.changed, false);
  assert.equal(result.deactivated.length, 0);
  assert.equal(result.stationStates[0].active, true);
});

test("logout materializza offline una postazione online ricostruita dalla sessione", () => {
  const helpers = createHelpers();
  const result = helpers.deactivateIntegrationStationStatesForSession([], {
    session: {
      clientApp: "postazione",
      deviceUuid: "device-session-only",
      userId: "u_roberto",
      stationName: "BAR-1",
    },
    user: {
      id: "u_roberto",
      username: "roberto",
      fullName: "Roberto Pratesi",
      roleLabel: "Operatore",
    },
    payload: { station: "BAR-1" },
    updatedAtMs: 1_000_000,
  });

  assert.equal(result.changed, true);
  assert.equal(result.deactivated.length, 1);
  assert.equal(result.stationStates.length, 1);
  assert.equal(result.stationStates[0].station, "BAR-1");
  assert.equal(result.stationStates[0].active, false);
  assert.equal(result.stationStates[0].realStation, true);
});
