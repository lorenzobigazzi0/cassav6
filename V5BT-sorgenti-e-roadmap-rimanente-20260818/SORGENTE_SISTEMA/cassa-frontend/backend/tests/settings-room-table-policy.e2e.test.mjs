import assert from "node:assert/strict";
import test from "node:test";
import { apiPost, authPayload, loginJson, startBackend } from "./helpers/test-server.mjs";

const ADMIN_DEVICE = "admin-settings-device";

function cloneConfigurationPayload(settings, areas) {
  return {
    locale: settings.locale,
    activities: settings.activities,
    activityRoomBindings: settings.activityRoomBindings,
    areas,
    areaMenus: settings.areaMenus,
    printers: settings.printers,
  };
}

function cloneAreas(settings) {
  return (Array.isArray(settings.areas) ? settings.areas : []).map((area) => ({
    ...area,
    menuIds: Array.isArray(area.menuIds) ? [...area.menuIds] : [],
    priceListIds: Array.isArray(area.priceListIds) ? [...area.priceListIds] : [],
    waiterUserIds: Array.isArray(area.waiterUserIds) ? [...area.waiterUserIds] : [],
    printerIds: Array.isArray(area.printerIds) ? [...area.printerIds] : [],
    cashPoints: Array.isArray(area.cashPoints) ? structuredClone(area.cashPoints) : [],
    workstations: Array.isArray(area.workstations) ? structuredClone(area.workstations) : [],
  }));
}

function setAreaMinimumTables(areas, roomId, minimumTables) {
  const index = areas.findIndex((area) => String(area?.id ?? "") === roomId);
  assert.notEqual(index, -1, `area ${roomId} non trovata`);
  areas[index] = {
    ...areas[index],
    minimumTables,
  };
  return areas;
}

async function loginAdmin(baseUrl) {
  return loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: ADMIN_DEVICE,
    clientApp: "cassa-frontend",
  });
}

async function readPosSettings(baseUrl, session) {
  const { response, body } = await apiPost(
    baseUrl,
    "/api/settings/pos",
    authPayload(session, ADMIN_DEVICE)
  );
  assert.equal(response.status, 200);
  return body;
}

async function saveAreas(baseUrl, session, settings, areas) {
  return apiPost(
    baseUrl,
    "/api/settings/pos/areas/save",
    authPayload(session, ADMIN_DEVICE, cloneConfigurationPayload(settings, areas))
  );
}

test("settings espone la sala di attesa virtuale default con 10 tavoli", async (t) => {
  const { baseUrl } = await startBackend(t);
  const session = await loginAdmin(baseUrl);
  const settings = await readPosSettings(baseUrl, session);

  const room = settings.areas.find((area) => area.id === "room_attesa_virtuale");
  assert.equal(room?.name, "Attesa virtuale");
  assert.equal(room?.minimumTables, 10);

  const waitingTables = settings.tables.filter((table) => table.roomId === "room_attesa_virtuale");
  assert.equal(waitingTables.length, 10);
  assert.equal(waitingTables.every((table) => table.status === "free"), true);
});

test("settings consente di aggiungere tavoli solo a sala libera e senza utenti attivi", async (t) => {
  const { baseUrl } = await startBackend(t);
  const session = await loginAdmin(baseUrl);
  const settings = await readPosSettings(baseUrl, session);
  const areas = setAreaMinimumTables(cloneAreas(settings), "room_sala", 3);

  const { response, body } = await saveAreas(baseUrl, session, settings, areas);

  assert.equal(response.status, 200);
  const roomTables = body.tables.filter((table) => table.roomId === "room_sala");
  assert.equal(roomTables.length >= 3, true);
});

test("settings blocca aggiunta tavoli se la sala ha tavoli occupati", async (t) => {
  const { baseUrl } = await startBackend(t, {
    stateOverrides(state) {
      const table = state.posSettings.tables.find((entry) => entry.id === "room_sala_t01");
      table.status = "seated";
      table.covers = 2;
    },
  });
  const session = await loginAdmin(baseUrl);
  const settings = await readPosSettings(baseUrl, session);
  const areas = setAreaMinimumTables(cloneAreas(settings), "room_sala", 3);

  const { response, body } = await saveAreas(baseUrl, session, settings, areas);

  assert.equal(response.status, 409);
  assert.equal(body?.code, "ROOM_TABLE_EXPANSION_BLOCKED");
  assert.equal(body?.details?.rooms?.[0]?.roomId, "room_sala");
  assert.deepEqual(body?.details?.rooms?.[0]?.occupiedTableIds, ["room_sala_t01"]);
});

test("settings blocca aggiunta tavoli se la sala ha utenti mobile attivi", async (t) => {
  const now = new Date().toISOString();
  const { baseUrl } = await startBackend(t, {
    stateOverrides(state) {
      state.sessions.push({
        id: "sess_waiter_room_sala",
        tokenHash: "test-token-hash",
        userId: "u_waiter",
        deviceUuid: "waiter-room-device",
        clientApp: "mobile-frontend",
        roomId: "room_sala",
        roomName: "Sala",
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    },
  });
  const session = await loginAdmin(baseUrl);
  const settings = await readPosSettings(baseUrl, session);
  const areas = setAreaMinimumTables(cloneAreas(settings), "room_sala", 3);

  const { response, body } = await saveAreas(baseUrl, session, settings, areas);

  assert.equal(response.status, 409);
  assert.equal(body?.code, "ROOM_TABLE_EXPANSION_BLOCKED");
  assert.equal(body?.details?.rooms?.[0]?.roomId, "room_sala");
  assert.deepEqual(body?.details?.rooms?.[0]?.activeUserIds, ["u_waiter"]);
});
