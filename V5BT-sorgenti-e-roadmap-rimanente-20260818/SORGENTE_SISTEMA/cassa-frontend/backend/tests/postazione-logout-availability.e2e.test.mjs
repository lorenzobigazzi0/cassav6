import assert from "node:assert/strict";
import test from "node:test";

import { authPayload, readJson, startBackend } from "./helpers/test-server.mjs";

async function postJson(baseUrl, pathName, payload) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-App": "postazione" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function loginPostazione(baseUrl, deviceUuid, station = "BAR-1") {
  const result = await postJson(baseUrl, "/api/auth/login", {
    username: "cashier",
    pin: "2222",
    deviceUuid,
    clientApp: "postazione",
    station,
    stationName: station,
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body?.ok, true);
  return result.body;
}

async function loginMobile(baseUrl, deviceUuid) {
  const result = await postJson(baseUrl, "/api/auth/login", {
    username: "waiter",
    pin: "3333",
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body?.ok, true);
  return result.body;
}

async function activatePostazione(baseUrl, session, deviceUuid, station = "BAR-1") {
  const result = await postJson(
    baseUrl,
    "/api/integration/stations/state",
    authPayload(session, deviceUuid, {
      station,
      active: true,
      clientApp: "postazione",
      operatorUserId: session.user.id,
      operatorUsername: session.user.username,
      operatorName: session.user.fullName,
      operatorRole: session.user.roleLabel,
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body?.station?.active, true);
}

async function readSseEvent(response, predicate, timeoutMs = 5_000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout SSE logout postazione")), remainingMs),
      ),
    ]);
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    const frames = buffer.split(/\n\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = { event: "message", data: "" };
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) event.event = line.slice(6).trim();
        if (line.startsWith("data:")) event.data += line.slice(5).trim();
      }
      if (predicate(event)) return event;
    }
  }
  throw new Error("Evento realtime di logout non ricevuto");
}

function resetStationAvailabilityState(state) {
  state.integration.stationStates = [];
  state.integration.notifications = [];
  state.integration.noActiveStationsAlert = {
    active: false,
    notifiedAtMs: 0,
    recoveredAtMs: 0,
  };
}

test("logout dell'ultima postazione la spegne e avvisa subito il mobile", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    env: {
      SSE_EVENT_PAYLOAD: "1",
      SSE_LEGACY_REFRESH: "0",
    },
    stateOverrides: resetStationAvailabilityState,
  });
  const deviceUuid = "logout-last-station-device";
  await loginMobile(baseUrl, "waiter-device");
  const session = await loginPostazione(baseUrl, deviceUuid);
  await activatePostazione(baseUrl, session, deviceUuid);

  const streamController = new AbortController();
  t.after(() => streamController.abort());
  const streamResponse = await fetch(
    `${baseUrl}/api/integration/notifications/stream?consumer=logout-last-station&clientApp=mobile-frontend&userId=u_waiter&deviceUuid=waiter-device`,
    { signal: streamController.signal },
  );
  assert.equal(streamResponse.status, 200);
  const realtimeEvent = readSseEvent(streamResponse, (event) => {
    if (event.event !== "payload") return false;
    const payload = JSON.parse(event.data || "{}");
    return payload.reason === "station_availability_alert" && payload.detail?.trigger === "auth_logout";
  });

  const logout = await postJson(
    baseUrl,
    "/api/auth/logout",
    authPayload(session, deviceUuid, {
      clientApp: "postazione",
      station: "BAR-1",
      stationName: "BAR-1",
    }),
  );
  assert.equal(logout.response.status, 200);
  assert.equal(logout.body?.loggedOut, true);
  const realtimePayload = JSON.parse((await realtimeEvent).data || "{}");
  const realtimeNotifications = Array.isArray(realtimePayload.detail?.notifications)
    ? realtimePayload.detail.notifications
    : [];
  assert.deepEqual(
    realtimeNotifications.map((entry) => entry?.meta?.eventType).sort(),
    ["no_active_stations", "station_offline"],
  );

  const state = await readJson(dbPath);
  const stationState = state.integration.stationStates.find(
    (entry) => entry.deviceUuid === deviceUuid,
  );
  assert.equal(stationState?.active, false);
  assert.equal(state.sessions.some((entry) => entry.deviceUuid === deviceUuid), false);
  assert.equal(state.integration.noActiveStationsAlert.active, true);
  assert.equal(
    state.integration.notifications.filter((entry) => entry?.meta?.eventType === "station_offline").length,
    1,
  );
  assert.equal(
    state.integration.notifications.filter((entry) => entry?.meta?.eventType === "no_active_stations").length,
    1,
  );

  const pull = await fetch(
    `${baseUrl}/api/integration/notifications/pull?consumer=logout-waiter&clientApp=mobile-frontend&userId=u_waiter&deviceUuid=waiter-device`,
  );
  assert.equal(pull.status, 200);
  const pulled = await pull.json();
  assert.ok(pulled.items.some((entry) => entry?.meta?.eventType === "no_active_stations"));
});

test("logout di una postazione non genera l'allarme globale se un'altra resta attiva", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      resetStationAvailabilityState(state);
      state.posSettings.workstations.push({
        id: "workstation_bar_2",
        name: "BAR-2",
        stationName: "BAR-2",
        active: true,
        status: "active",
        roomIds: ["room_pedana"],
        printerIds: [],
      });
      state.integration.stationStates = [
        {
          station: "BAR-2",
          active: true,
          realStation: true,
          stale: false,
          operatorUserId: "u_admin",
          operatorUsername: "admin_test",
          operatorName: "Admin Test",
          operatorRole: "Amministratore",
          deviceUuid: "other-station-device",
          clientApp: "postazione",
          updatedAtMs: Date.now(),
        },
      ];
    },
  });
  const deviceUuid = "logout-one-of-two-device";
  const session = await loginPostazione(baseUrl, deviceUuid);
  await activatePostazione(baseUrl, session, deviceUuid);

  const logout = await postJson(
    baseUrl,
    "/api/auth/logout",
    authPayload(session, deviceUuid, {
      clientApp: "postazione",
      station: "BAR-1",
      stationName: "BAR-1",
    }),
  );
  assert.equal(logout.response.status, 200);

  const state = await readJson(dbPath);
  assert.equal(state.integration.noActiveStationsAlert.active, false);
  assert.equal(
    state.integration.notifications.filter((entry) => entry?.meta?.eventType === "no_active_stations").length,
    0,
  );
  assert.equal(
    state.integration.stationStates.find((entry) => entry.deviceUuid === "other-station-device")?.active,
    true,
  );
});
