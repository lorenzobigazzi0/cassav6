import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDeviceStatusSplitRepository } from "../db/app-state/index.js";

function buildSession(id, deviceUuid) {
  return {
    id,
    userId: "u_cashier",
    username: "cashier",
    tokenHash: `hash_${id}`,
    deviceUuid,
    clientApp: "mobile-frontend",
    createdAt: "2026-07-06T09:00:00.000Z",
    lastSeenAt: "2026-07-06T09:00:00.000Z",
    expiresAt: "2026-07-06T19:00:00.000Z",
  };
}

test("[BE][P1] device-status split mantiene sessioni concorrenti quando il login richiede sync additiva", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "cassav4-device-status-split-"));
  const split = createDeviceStatusSplitRepository({
    mode: "externalized",
    dbPath: path.join(runDir, "device-status.sqlite"),
    nowIso: () => "2026-07-06T09:00:00.000Z",
    logger: { info() {}, warn() {} },
  });

  await split.syncFromAppState({
    sessions: [buildSession("session_a", "device-a")],
    integration: { stationStates: [] },
    meta: { lastWriteAt: "2026-07-06T09:00:00.000Z" },
  });
  await split.syncFromAppState(
    {
      sessions: [buildSession("session_b", "device-b")],
      integration: { stationStates: [] },
      meta: { lastWriteAt: "2026-07-06T09:00:01.000Z" },
    },
    { sessionsSync: { deleteMissing: false } },
  );

  const hydrated = await split.hydrateAppState({ sessions: [], integration: {} });
  assert.deepEqual(
    hydrated.sessions.map((entry) => entry.id).sort(),
    ["session_a", "session_b"],
  );

  await split.syncFromAppState(
    {
      sessions: [],
      integration: {
        stationStates: [
          {
            station: "BAR-1",
            active: true,
            operatorUsername: "cashier",
            deviceUuid: "station-device",
            updatedAtMs: 1783328400000,
          },
        ],
      },
      meta: { lastWriteAt: "2026-07-06T09:00:01.500Z" },
    },
    { sessionsSync: { skip: true } },
  );
  const afterStationOnly = await split.hydrateAppState({
    sessions: [],
    integration: {},
  });
  assert.deepEqual(
    afterStationOnly.sessions.map((entry) => entry.id).sort(),
    ["session_a", "session_b"],
  );
  assert.equal(afterStationOnly.integration.stationStates.length, 1);

  await split.syncFromAppState({
    sessions: [buildSession("session_b", "device-b")],
    integration: { stationStates: [] },
    meta: { lastWriteAt: "2026-07-06T09:00:02.000Z" },
  });
  const pruned = await split.hydrateAppState({ sessions: [], integration: {} });
  assert.deepEqual(
    pruned.sessions.map((entry) => entry.id).sort(),
    ["session_b"],
  );

  split.close();
});
