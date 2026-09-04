import assert from "node:assert/strict";
import test from "node:test";

import {
  apiPost,
  authHeaders,
  authPayload,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

async function stopBackend(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout arresto backend test")), 5_000)),
  ]);
}

function enableAdminPause(state) {
  const admin = state.users.find((entry) => entry.username === "admin_test");
  admin.waiterPauseSettings = {
    enabled: true,
    durationMinutes: 15,
    renewalMinutes: 120,
  };
}

async function runtimeMetrics(baseUrl, session, deviceUuid) {
  const response = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(session, deviceUuid),
  });
  assert.equal(response.status, 200);
  return (await response.json()).runtimeMetrics;
}

test("waiter pause serializza duplicati concorrenti senza doppie write o publish", async (t) => {
  const deviceUuid = "waiter-pause-idempotency-device";
  const { baseUrl, dbPath } = await startBackend(t, {
    env: { RUNTIME_METRICS: "1" },
    stateOverrides: enableAdminPause,
  });
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const payload = authPayload(session, deviceUuid, {
    clientApp: "mobile-frontend",
    roomId: "room_pedana",
    roomName: "Pedana",
  });
  const reset = await apiPost(
    baseUrl,
    "/api/monitor/runtime-metrics/reset",
    payload,
  );
  assert.equal(reset.response.status, 200);

  const starts = await Promise.all(
    Array.from({ length: 6 }, () =>
      apiPost(baseUrl, "/api/mobile/waiter-pause/start", payload)),
  );
  assert.equal(starts.every(({ response, body }) =>
    response.status === 200 && body?.pause?.active === true), true);

  let state = await readJson(dbPath);
  assert.equal(
    state.integration.waiterPauses.filter((entry) => entry.userId === session.user.id).length,
    1,
  );
  assert.equal(
    state.auditEvents.filter((entry) => entry.action === "waiter.pause_started").length,
    1,
  );
  let metrics = await runtimeMetrics(baseUrl, session, deviceUuid);
  let operations = metrics.operations.runMsByLabel;
  assert.equal(
    metrics.counters.waiterPauseLaneEnqueued +
      metrics.counters.stationStateLaneEnqueued,
    6,
  );
  assert.equal(operations["waiterPauseWorkflow:start.state.appStateWrite"]?.count, 1);
  assert.equal(operations["waiterPauseWorkflow:start.realtime.publish"]?.count, 1);
  assert.equal(operations["waiterPauseWorkflow:start.total.started"]?.count, 1);
  assert.equal(operations["waiterPauseWorkflow:start.total.already_paused"]?.count, 5);

  const resetBeforeStop = await apiPost(
    baseUrl,
    "/api/monitor/runtime-metrics/reset",
    payload,
  );
  assert.equal(resetBeforeStop.response.status, 200);
  const stops = await Promise.all(
    Array.from({ length: 6 }, () =>
      apiPost(baseUrl, "/api/mobile/waiter-pause/stop", payload)),
  );
  assert.equal(stops.every(({ response, body }) =>
    response.status === 200 && body?.pause?.active === false), true);

  state = await readJson(dbPath);
  assert.equal(
    state.auditEvents.filter((entry) => entry.action === "waiter.pause_stopped").length,
    1,
  );
  metrics = await runtimeMetrics(baseUrl, session, deviceUuid);
  operations = metrics.operations.runMsByLabel;
  assert.equal(
    metrics.counters.waiterPauseLaneEnqueued +
      metrics.counters.stationStateLaneEnqueued,
    6,
  );
  assert.equal(operations["waiterPauseWorkflow:stop.state.appStateWrite"]?.count, 1);
  assert.equal(operations["waiterPauseWorkflow:stop.realtime.publish"]?.count, 1);
  assert.equal(operations["waiterPauseWorkflow:stop.total.stopped"]?.count, 1);
  assert.equal(operations["waiterPauseWorkflow:stop.total.already_active"]?.count, 5);
});

test("waiter pause recupera stato started e stopped dopo restart", async (t) => {
  const deviceUuid = "waiter-pause-recovery-device";
  const first = await startBackend(t, { stateOverrides: enableAdminPause });
  const firstSession = await loginJson(first.baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const start = await apiPost(
    first.baseUrl,
    "/api/mobile/waiter-pause/start",
    authPayload(firstSession, deviceUuid, { clientApp: "mobile-frontend" }),
  );
  assert.equal(start.response.status, 200);
  assert.equal(start.body?.pause?.active, true);
  await stopBackend(first.child);

  const second = await startBackend(t, {
    runDir: first.runDir,
    dbPath: first.dbPath,
    preserveDb: true,
  });
  const secondSession = await loginJson(second.baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const statusAfterStart = await apiPost(
    second.baseUrl,
    "/api/mobile/waiter-pause/status",
    authPayload(secondSession, deviceUuid, { clientApp: "mobile-frontend" }),
  );
  assert.equal(statusAfterStart.response.status, 200);
  assert.equal(statusAfterStart.body?.pause?.active, true);
  const stop = await apiPost(
    second.baseUrl,
    "/api/mobile/waiter-pause/stop",
    authPayload(secondSession, deviceUuid, { clientApp: "mobile-frontend" }),
  );
  assert.equal(stop.response.status, 200);
  assert.equal(stop.body?.pause?.active, false);
  await stopBackend(second.child);

  const third = await startBackend(t, {
    runDir: first.runDir,
    dbPath: first.dbPath,
    preserveDb: true,
  });
  const thirdSession = await loginJson(third.baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const statusAfterStop = await apiPost(
    third.baseUrl,
    "/api/mobile/waiter-pause/status",
    authPayload(thirdSession, deviceUuid, { clientApp: "mobile-frontend" }),
  );
  assert.equal(statusAfterStop.response.status, 200);
  assert.equal(statusAfterStop.body?.pause?.active, false);

  const state = await readJson(first.dbPath);
  const records = state.integration.waiterPauses.filter(
    (entry) => entry.userId === thirdSession.user.id,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "active");
});
