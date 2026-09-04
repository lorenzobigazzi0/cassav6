import test from "node:test";
import assert from "node:assert/strict";
import { createIntegrationRoomHelpers } from "../modules/integration/rooms.domain.js";

function normalizeConfigId(value, fallback = "") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

function toTitle(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function createHelpers() {
  return createIntegrationRoomHelpers({
    normalizeConfigId,
    toTitle,
    nowDate: () => new Date("2026-06-05T10:15:00+02:00"),
  });
}

test("integration rooms genera slug e sale da tipo con id univoco", () => {
  const helpers = createHelpers();
  const used = new Set();

  assert.equal(helpers.toIntegrationRoomSlug(" Sala Esterna! "), "sala_esterna");
  assert.equal(helpers.toIntegrationRoomSlug("", "sala"), "sala");

  assert.deepEqual(helpers.resolveIntegrationRoomFromType("gazebo", used), {
    id: "room_gazebo",
    name: "Gazebo",
    type: "gazebo",
  });
  assert.deepEqual(helpers.resolveIntegrationRoomFromType("gazebo", used), {
    id: "room_gazebo_2",
    name: "Gazebo",
    type: "gazebo",
  });
});

test("integration rooms risolve roomId esplicito con area configurata", () => {
  const helpers = createHelpers();
  const used = new Set();
  const areas = new Map([
    ["room_gazebo", { id: "room_gazebo", name: "Gazebo" }],
  ]);

  assert.deepEqual(
    helpers.resolveIntegrationRoomFromTable({ roomId: "room_gazebo", type: "Esterno" }, used, areas),
    {
      id: "room_gazebo",
      name: "Gazebo",
      type: "Esterno",
    }
  );
  assert.equal(used.has("room_gazebo"), true);
});

test("integration rooms risolve sala da type quando manca roomId", () => {
  const helpers = createHelpers();
  const used = new Set();

  assert.deepEqual(helpers.resolveIntegrationRoomFromTable({ type: "bar" }, used), {
    id: "room_bar",
    name: "Bar",
    type: "bar",
  });
});

test("integration rooms parse prenotazione valida e scarta orari invalidi", () => {
  const helpers = createHelpers();
  const reservationAt = helpers.parseIntegrationReservationAt({ time: "19:45" });
  const parsed = new Date(reservationAt);

  assert.equal(parsed.getHours(), 19);
  assert.equal(parsed.getMinutes(), 45);
  assert.equal(helpers.parseIntegrationReservationAt({ time: "24:00" }), null);
  assert.equal(helpers.parseIntegrationReservationAt({ time: "19.45" }), null);
  assert.equal(helpers.parseIntegrationReservationAt(null), null);
});
