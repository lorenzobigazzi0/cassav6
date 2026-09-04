import test from "node:test";
import assert from "node:assert/strict";
import {
  auditRoomPermissionsState,
  collectConfiguredRooms,
  parseAuditArgs,
} from "../scripts/audit-room-permissions.mjs";

test("collectConfiguredRooms includes v2 Gazebo seed and configured custom areas", () => {
  const rooms = collectConfiguredRooms({
    areas: [{ id: "room_rooftop", name: "Rooftop", minimumTables: 2 }],
    tables: [{ id: "veranda_1", number: 1, type: "Veranda", roomId: "room_veranda" }],
  });
  const ids = rooms.map((room) => room.id);
  assert.ok(ids.includes("room_gazebo"));
  assert.ok(ids.includes("room_pedana"));
  assert.ok(ids.includes("room_rooftop"));
  assert.ok(ids.includes("room_veranda"));
});

test("auditRoomPermissionsState reports missing Gazebo enabled/authorized users without flagging privileged users", () => {
  const report = auditRoomPermissionsState({
    posSettings: { tables: [] },
    users: [
      {
        id: "u_admin",
        username: "admin",
        role: "admin",
        enabledRoomIds: ["room_pedana"],
        authorizedRoomIds: ["room_pedana"],
      },
      {
        id: "u_giada",
        username: "giada",
        fullName: "Giada Imperato",
        role: "operator",
      },
      {
        id: "u_cashier",
        username: "cashier",
        role: "operator",
        enabledRoomIds: ["room_pedana"],
        authorizedRoomIds: ["room_pedana"],
      },
      {
        id: "u_waiter",
        username: "waiter",
        role: "operator",
        enabledRoomIds: ["room_pedana", "room_gazebo"],
        authorizedRoomIds: ["room_pedana"],
      },
      {
        id: "u_ok",
        username: "ok",
        role: "operator",
        enabledRoomIds: ["room_pedana", "room_gazebo"],
        authorizedRoomIds: ["room_gazebo"],
      },
      {
        id: "u_disabled",
        username: "disabled",
        role: "operator",
        disabled: true,
        enabledRoomIds: ["room_pedana"],
        authorizedRoomIds: ["room_pedana"],
      },
    ],
  });

  assert.equal(report.configured, true);
  assert.equal(report.totals.users, 6);
  assert.equal(report.totals.activeUsers, 5);
  assert.equal(report.totals.privilegedUsers, 1);
  assert.equal(report.totals.missingEnabled, 1);
  assert.equal(report.totals.missingAuthorized, 1);
  assert.deepEqual(report.missingEnabled.map((entry) => entry.username), ["cashier"]);
  assert.deepEqual(report.missingAuthorized.map((entry) => entry.username), ["waiter"]);
  assert.equal(report.findings.find((entry) => entry.username === "admin")?.status, "ok");
  assert.equal(report.findings.find((entry) => entry.username === "giada")?.status, "ok");
});

test("parseAuditArgs supports flag and value arguments", () => {
  assert.deepEqual(parseAuditArgs(["--db", "/tmp/app-state.json", "--json", "--room", "room_gazebo"]), {
    db: "/tmp/app-state.json",
    json: "1",
    room: "room_gazebo",
  });
});
