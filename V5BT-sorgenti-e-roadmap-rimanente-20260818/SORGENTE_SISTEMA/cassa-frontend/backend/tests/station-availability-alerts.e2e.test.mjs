import assert from "node:assert/strict";
import test from "node:test";
import { apiPost, authPayload, loginJson, readJson, startBackend } from "./helpers/test-server.mjs";

async function getJson(url, expectedStatus = 200) {
  const response = await fetch(url, { cache: "no-store" });
  assert.equal(response.status, expectedStatus);
  return response.json();
}

test("notifica i camerieri quando non ci sono postazioni attive e non duplica durante un flap rapido", async (t) => {
  const nowMs = Date.now();
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      state.integration.stationStates = [
        {
          station: "BAR-1",
          active: false,
          autoPrintOrders: false,
          autoPrintPreconto: false,
          operatorUserId: "u_cashier",
          operatorUsername: "cashier",
          operatorName: "Cashier Test",
          operatorRole: "Operatore",
          deviceUuid: "station-device",
          clientApp: "postazione",
          updatedAtMs: nowMs,
          realStation: true,
          isDemoFallback: false,
          stale: false,
        },
      ];
      state.integration.noActiveStationsAlert = { active: false, notifiedAtMs: 0, recoveredAtMs: 0 };
    },
  });
  await loginJson(baseUrl, "waiter", "3333", {
    clientApp: "mobile-frontend",
    deviceUuid: "waiter-device",
  });

  const firstActive = await getJson(`${baseUrl}/api/integration/stations/active`);
  assert.deepEqual(firstActive.stations, []);

  const firstPull = await getJson(
    `${baseUrl}/api/integration/notifications/pull?consumer=waiter-test&clientApp=mobile-frontend&userId=u_waiter&username=waiter&deviceUuid=waiter-device`
  );
  assert.equal(firstPull.items.length, 1);
  assert.equal(firstPull.items[0].title, "Nessuna postazione attiva");
  assert.equal(firstPull.items[0].meta.eventType, "no_active_stations");

  await getJson(`${baseUrl}/api/integration/stations/active`);
  let state = await readJson(dbPath);
  assert.equal(
    state.integration.notifications.filter((entry) => entry?.meta?.eventType === "no_active_stations").length,
    1
  );

  const session = await loginJson(baseUrl, "cashier", "2222", {
    clientApp: "postazione",
    deviceUuid: "station-device",
  });
  const selected = await apiPost(
    baseUrl,
    "/api/auth/workstation/select",
    authPayload(session, "station-device", {
      clientApp: "postazione",
      workstationId: "workstation_bar_1",
    }),
  );
  assert.equal(selected.response.status, 200);
  const activateResponse = await fetch(`${baseUrl}/api/integration/stations/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      authPayload(session, "station-device", {
        station: "BAR-1",
        active: true,
        clientApp: "postazione",
        operatorUserId: session.user.id,
        operatorUsername: session.user.username,
        operatorName: session.user.fullName,
        operatorRole: session.user.roleLabel,
      })
    ),
  });
  assert.equal(activateResponse.status, 200);
  const activeAgain = await getJson(`${baseUrl}/api/integration/stations/active`);
  assert.equal(activeAgain.stations.length, 1);
  state = await readJson(dbPath);
  assert.equal(state.integration.noActiveStationsAlert.active, false);
  assert.equal(
    state.integration.notifications.filter((entry) => entry?.meta?.eventType === "active_stations_restored").length,
    1
  );
  assert.equal(
    state.integration.notifications.filter((entry) => entry?.meta?.eventType === "station_online").length,
    1
  );

  const deactivateResponse = await fetch(`${baseUrl}/api/integration/stations/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      station: "BAR-1",
      active: false,
      clientApp: "postazione",
      deviceUuid: "station-device",
      operatorUserId: session.user.id,
      operatorUsername: session.user.username,
      operatorName: session.user.fullName,
      operatorRole: session.user.roleLabel,
    }),
  });
  assert.equal(deactivateResponse.status, 200);
  state = await readJson(dbPath);
  assert.equal(
    state.integration.notifications.filter((entry) => entry?.meta?.eventType === "no_active_stations").length,
    1
  );
  assert.equal(
    state.integration.notifications.filter((entry) => entry?.meta?.eventType === "station_offline").length,
    1
  );

  const reactivateResponse = await fetch(`${baseUrl}/api/integration/stations/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      authPayload(session, "station-device", {
        station: "BAR-1",
        active: true,
        clientApp: "postazione",
        operatorUserId: session.user.id,
        operatorUsername: session.user.username,
        operatorName: session.user.fullName,
        operatorRole: session.user.roleLabel,
      })
    ),
  });
  assert.equal(reactivateResponse.status, 200);
  state = await readJson(dbPath);
  assert.equal(state.integration.noActiveStationsAlert.active, false);
  assert.equal(
    state.integration.notifications.filter((entry) => entry?.meta?.eventType === "station_online").length,
    1
  );
  assert.equal(
    state.integration.notifications.filter((entry) => entry?.meta?.eventType === "active_stations_restored").length,
    1
  );
});
