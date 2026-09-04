import test from "node:test";
import assert from "node:assert/strict";
import { createPosRoomsHandlers } from "../modules/pos-rooms/pos-rooms.handlers.js";

test("pos.rooms usa il runtime db quando le static settings restituiscono zero sale", async () => {
  const db = {
    posSettings: {
      areas: [{ id: "room_bar", name: "Bar" }],
    },
  };
  let statusCode = 0;
  let responseBody = null;

  const handlers = createPosRoomsHandlers({
    buildMobileRoomSettings(_user, rooms) {
      return {
        rooms,
        enabledRoomIds: rooms.map((room) => room.roomId),
        authorizedRoomIds: rooms.map((room) => room.roomId),
      };
    },
    buildPosRoomListFromSettings(settings) {
      return (Array.isArray(settings?.areas) ? settings.areas : []).map((area) => ({
        roomId: area.id,
        roomName: area.name,
      }));
    },
    menuSettingsRepository: {
      getStaticPosSettings() {
        return { areas: [] };
      },
    },
    async readDb() {
      return db;
    },
    async readJsonBody() {
      return {};
    },
    resolveMobileInitialRoom(_user, roomSettings) {
      return roomSettings.rooms[0] ?? null;
    },
    sendJson(_res, status, body) {
      statusCode = status;
      responseBody = body;
    },
    validateSessionContext() {
      return { user: { id: "u_giada", role: "operator" } };
    },
  });

  await handlers["pos.rooms"]({}, {});

  assert.equal(statusCode, 200);
  assert.deepEqual(responseBody.rooms, [{ roomId: "room_bar", roomName: "Bar" }]);
  assert.deepEqual(responseBody.enabledRoomIds, ["room_bar"]);
  assert.deepEqual(responseBody.authorizedRoomIds, ["room_bar"]);
});

test("pos.rooms riusa il contesto autenticato dal router multiprocesso", async () => {
  const authenticatedUser = { id: "u_live", role: "operator" };
  let validatedAgain = false;
  let observedUser = null;
  const handlers = createPosRoomsHandlers({
    buildMobileRoomSettings(user) {
      observedUser = user;
      return { rooms: [], enabledRoomIds: [], authorizedRoomIds: [] };
    },
    buildPosRoomListFromSettings() {
      return [];
    },
    menuSettingsRepository: { getStaticPosSettings: () => ({ areas: [] }) },
    readDb: async () => ({ posSettings: { areas: [] }, sessions: [] }),
    readJsonBody: async () => ({ token: "valid-shared-token", deviceUuid: "mobile-1" }),
    resolveMobileInitialRoom: () => null,
    sendJson: () => undefined,
    validateSessionContext() {
      validatedAgain = true;
      throw new Error("La cache locale del worker non contiene ancora la sessione.");
    },
  });

  await handlers["pos.rooms"]({
    __authContext: { user: authenticatedUser, session: { id: "shared-session" } },
  }, {});

  assert.equal(validatedAgain, false);
  assert.equal(observedUser, authenticatedUser);
});

test("pos.rooms non espone sale disabilitate al refresh operativo", async () => {
  let responseBody = null;
  const handlers = createPosRoomsHandlers({
    buildMobileRoomSettings() {
      return {
        rooms: [
          {
            roomId: "room_enabled",
            roomName: "Abilitata",
            enabled: true,
            authorized: true,
            requiresAdminAuth: false,
          },
          {
            roomId: "room_disabled",
            roomName: "Disabilitata",
            enabled: false,
            authorized: false,
            requiresAdminAuth: false,
          },
          {
            roomId: "room_inconsistent",
            roomName: "Incoerente",
            enabled: true,
            authorized: true,
            requiresAdminAuth: false,
          },
        ],
        enabledRoomIds: ["room_enabled"],
        authorizedRoomIds: ["room_enabled"],
      };
    },
    buildPosRoomListFromSettings() {
      return [{ roomId: "room_enabled", roomName: "Abilitata" }];
    },
    menuSettingsRepository: { getStaticPosSettings: () => null },
    readDb: async () => ({ posSettings: { areas: [] }, sessions: [] }),
    readJsonBody: async () => ({}),
    resolveMobileInitialRoom(_user, roomSettings) {
      return roomSettings.rooms[0] ?? null;
    },
    sendJson(_res, _status, body) {
      responseBody = body;
    },
    validateSessionContext() {
      return { user: { id: "u_mobile", role: "operator" } };
    },
  });

  await handlers["pos.rooms"]({}, {});

  assert.deepEqual(responseBody.rooms.map((room) => room.roomId), ["room_enabled"]);
  assert.equal(responseBody.initialRoom.roomId, "room_enabled");
  assert.deepEqual(responseBody.enabledRoomIds, ["room_enabled"]);
});
