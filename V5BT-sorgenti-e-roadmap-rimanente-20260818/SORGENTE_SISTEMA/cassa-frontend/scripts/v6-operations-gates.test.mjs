import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateV6OperationsRuntimeGate,
  evaluateV6PersistedOrderTarget,
  summarizeV6GuiRequestTraffic,
} from "./v6-operations-gates.mjs";

function healthyProfile(overrides = {}) {
  return {
    maximumInFlight: 30,
    cadence: { earlyActionGaps: 0, earlyDispatchActionGaps: 0 },
    actionLatencyMs: { p95ms: 2_500, maxMs: 12_000 },
    devices: [
      { id: "mobile-1", maximumInFlight: 1 },
      { id: "station-1", maximumInFlight: 2 },
    ],
    ...overrides,
  };
}

const healthyGui = [{
  kind: "mobile-p5-headed",
  index: 0,
  requests: 30,
  requestFailures: 0,
  responses5xx: 0,
  consoleErrors: 0,
  requestsByRoute: {
    "GET /api/integration/layout": 8,
    "GET /api/integration/orders": 12,
  },
}];

test("il gate runtime accetta concorrenza, latenza e traffico GUI entro i limiti", () => {
  const gate = evaluateV6OperationsRuntimeGate({
    profile: healthyProfile(),
    commandLatencyMs: { p95ms: 6_500 },
    guiDiagnostics: healthyGui,
    actionsPerDevice: 10,
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.guiRequestTraffic.perRoutePerGuiBudget, 30);
  assert.equal(gate.perDeviceViolations.length, 0);
});

test("una raffica anticipata fallisce anche quando la media resta corretta", () => {
  const gate = evaluateV6OperationsRuntimeGate({
    profile: healthyProfile({
      cadence: {
        earlyActionGaps: 1,
        earlyDispatchActionGaps: 1,
        mobileActionAverageGapMs: 3_000,
      },
    }),
    commandLatencyMs: { p95ms: 6_500 },
    guiDiagnostics: healthyGui,
    actionsPerDevice: 10,
  });
  assert.equal(gate.checks.noEarlyActionBursts, false);
  assert.equal(gate.checks.noEarlyDispatchActionBursts, false);
  assert.equal(gate.ok, false);
});

test("il gate rifiuta una raffica di dispatch anche con il piano regolare", () => {
  const gate = evaluateV6OperationsRuntimeGate({
    profile: healthyProfile({
      cadence: { earlyActionGaps: 0, earlyDispatchActionGaps: 1 },
    }),
    commandLatencyMs: { p95ms: 6_500 },
    guiDiagnostics: healthyGui,
    actionsPerDevice: 10,
  });

  assert.equal(gate.checks.noEarlyActionBursts, true);
  assert.equal(gate.checks.noEarlyDispatchActionBursts, false);
  assert.equal(gate.ok, false);
});

test("concorrenza e latenza fuori soglia sono errori indipendenti", () => {
  const gate = evaluateV6OperationsRuntimeGate({
    profile: healthyProfile({
      maximumInFlight: 61,
      actionLatencyMs: { p95ms: 3_001, maxMs: 30_001 },
      devices: [{ id: "mobile-1", maximumInFlight: 3 }],
    }),
    commandLatencyMs: { p95ms: 8_001 },
    guiDiagnostics: healthyGui,
    actionsPerDevice: 10,
  });
  assert.deepEqual(gate.perDeviceViolations, [{ deviceId: "mobile-1", maximumInFlight: 3 }]);
  assert.equal(gate.checks.globalInFlightWithinLimit, false);
  assert.equal(gate.checks.actionP95WithinLimit, false);
  assert.equal(gate.checks.commandP95WithinLimit, false);
  assert.equal(gate.checks.actionMaximumWithinLimit, false);
});

test("il budget GUI distingue le letture calde e rende bloccanti gli errori browser", () => {
  const summary = summarizeV6GuiRequestTraffic([{
    ...healthyGui[0],
    requestFailures: 1,
    requestsByRoute: {
      "GET /api/integration/layout": 31,
      "GET /api/integration/orders": 4,
    },
  }], 10);
  assert.equal(summary.devices[0].ok, false);
  assert.deepEqual(summary.devices[0].exceededRoutes, ["GET /api/integration/layout"]);
  assert.equal(summary.ok, false);
});

test("la persistenza richiede il conteggio esatto e rileva perdite e duplicati", () => {
  const pass = evaluateV6PersistedOrderTarget({
    handheldDeviceIds: ["mobile-1", "mobile-2"],
    persistedOrdersByDevice: { "mobile-1": 4, "mobile-2": 4 },
    targetPerHandheld: 4,
  });
  assert.equal(pass.ok, true);

  const fail = evaluateV6PersistedOrderTarget({
    handheldDeviceIds: ["mobile-1", "mobile-2"],
    persistedOrdersByDevice: { "mobile-1": 3, "mobile-2": 5 },
    targetPerHandheld: 4,
  });
  assert.equal(fail.ok, false);
  assert.equal(fail.missingOrders, 1);
  assert.equal(fail.duplicateOrders, 1);
});
