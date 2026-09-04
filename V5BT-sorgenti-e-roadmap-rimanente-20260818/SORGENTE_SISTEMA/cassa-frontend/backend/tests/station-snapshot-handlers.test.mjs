import assert from "node:assert/strict";
import test from "node:test";

import { createIntegrationStationSnapshotHandlers } from "../modules/integration/station-snapshot.handlers.js";

function createHandlerHarness({ stationStates }) {
  let readDbCalled = false;
  const handlers = createIntegrationStationSnapshotHandlers({
    buildIntegrationStationStates: (state) => state.stationStates,
    buildIntegrationStationStatesWithSessionRecovery: () => {
      throw new Error("fallback readDb non atteso");
    },
    createDefaultIntegrationState: () => ({ stationStates: [] }),
    getActiveStations: (state) =>
      (state.integration.stationStates ?? []).filter((entry) => entry.active !== false),
    integrationStationsFastResponseCache: new Map(),
    maybeQueueNoActiveStationsNotification: () => false,
    nowIso: () => "2026-07-08T12:00:00.000Z",
    publishIntegrationNotificationStreamRefresh: () => {},
    readDb: async () => {
      readDbCalled = true;
      return { integration: { stationStates: [] }, meta: {} };
    },
    readFastJsonCache: () => null,
    resolveConfiguredIntegrationStations: () => ["BAR PRINCIPALE", "CUCINA"],
    resolveIntegrationStationStatesVersionMs: () => 1234,
    scopedReadsEnabled: true,
    sendJsonString: (res, status, json) => {
      res.status = status;
      res.body = JSON.parse(json);
    },
    writeDb: async () => {},
    writeFastJsonCache: (_cache, _key, payload) => ({ json: JSON.stringify(payload) }),
    domainsRepository: {
      enabled: true,
      async readObjectArrayField() {
        return stationStates;
      },
      async readDomainValue() {
        return {};
      },
    },
  });
  return { handlers, readDbCalled: () => readDbCalled };
}

test("station snapshot scoped read autorevole anche con zero postazioni attive", async () => {
  const { handlers, readDbCalled } = createHandlerHarness({
    stationStates: [
      {
        station: "BAR PRINCIPALE",
        active: false,
        deviceUuid: "station-a",
        realStation: true,
      },
    ],
  });
  const res = {};

  await handlers.handleIntegrationActiveStations({}, res);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.stations, []);
  assert.equal(readDbCalled(), false);
});
