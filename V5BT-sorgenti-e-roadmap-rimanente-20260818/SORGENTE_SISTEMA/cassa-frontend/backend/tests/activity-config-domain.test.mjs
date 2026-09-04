import assert from "node:assert/strict";
import test from "node:test";
import { createPosActivityConfigHelpers } from "../modules/configuration/activity-config.domain.js";

const helpers = createPosActivityConfigHelpers({
  normalizeConfigId: (value, fallback = "config") => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
    return normalized || fallback;
  },
  normalizeReferenceIdList: (value, validIds = null, maxLength = 16) => {
    const seen = new Set();
    return (Array.isArray(value) ? value : [])
      .map((entry) =>
        String(entry ?? "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "_")
          .replace(/^_+|_+$/g, "")
      )
      .filter((entry) => {
        if (!entry || seen.has(entry)) return false;
        if (validIds && !validIds.has(entry)) return false;
        seen.add(entry);
        return true;
      })
      .slice(0, maxLength);
  },
  normalizeMenuScheduleRules: (value, targetField, fallbackPrefix) =>
    (Array.isArray(value) ? value : []).map((entry, index) => ({
      id: `${fallbackPrefix}_${index + 1}`,
      targetField,
      enabled: entry?.enabled !== false,
    })),
});

test("activity config sanitizza attivita con alias legacy e schedule", () => {
  const activity = helpers.sanitizePosActivity(
    {
      activityId: " Bar Operativo ",
      label: " Bar ",
      type: "food-beverage",
      fiscal: { mode: "mixed", nested: { enabled: true } },
      rtIds: ["RT Bar", "RT Bar"],
      menuId: "Menu Drink",
      listinoIds: ["Listino Giorno", "Listino Sera"],
      printerId: "Stampante Bar",
      billPrinterIds: ["Preconti Bar"],
      stationIds: ["BAR-1"],
      menuSchedule: [{ enabled: true }],
      listinoSchedules: [{ enabled: false }],
    },
    "fallback"
  );

  assert.deepEqual(activity, {
    id: "bar_operativo",
    name: "Bar",
    type: "food-beverage",
    status: "active",
    fiscalPolicy: { mode: "mixed", nested: { enabled: true } },
    fiscalDeviceIds: ["rt_bar"],
    menuIds: ["menu_drink"],
    priceListIds: ["listino_giorno", "listino_sera"],
    printerIds: ["stampante_bar"],
    precontoPrinterIds: ["preconti_bar"],
    workstationIds: ["bar-1"],
    menuSchedules: [{ id: "bar_operativo_menu_schedule_1", targetField: "menuIds", enabled: true }],
    priceListSchedules: [{ id: "bar_operativo_price_list_schedule_1", targetField: "priceListIds", enabled: false }],
  });
});

test("activity config normalizza policy fiscale stringa e fallback standard", () => {
  assert.equal(helpers.sanitizePosActivityFiscalPolicy(" speciale "), "speciale");
  assert.equal(helpers.sanitizePosActivityFiscalPolicy(""), "standard");
  assert.deepEqual(helpers.sanitizePosActivityFiscalPolicy({ a: 1 }), { a: 1 });
  assert.deepEqual(helpers.sanitizePosActivityFiscalPolicy(null), "standard");
});

test("activity config ignora attivita incomplete e rispetta stato disabled", () => {
  assert.equal(helpers.sanitizePosActivity(null), null);
  const activity = helpers.sanitizePosActivity({ id: "spiaggia", name: "Spiaggia", enabled: false });
  assert.equal(activity.status, "disabled");
  assert.deepEqual(activity.menuSchedules, []);
  assert.deepEqual(activity.priceListSchedules, []);
});

test("activity config filtra binding con attivita o sale non autorizzate", () => {
  const options = {
    activityIds: new Set(["activity_bar"]),
    roomIds: new Set(["room_gazebo"]),
  };

  assert.deepEqual(
    helpers.sanitizePosActivityRoomBinding(
      { activity: "activity_bar", salaId: "room_gazebo", status: "disabled" },
      "binding_1",
      options
    ),
    {
      id: "binding_1",
      activityId: "activity_bar",
      roomId: "room_gazebo",
      status: "disabled",
    }
  );
  assert.equal(
    helpers.sanitizePosActivityRoomBinding({ activityId: "activity_missing", roomId: "room_gazebo" }, "binding_2", options),
    null
  );
  assert.equal(
    helpers.sanitizePosActivityRoomBinding({ activityId: "activity_bar", roomId: "room_missing" }, "binding_3", options),
    null
  );
});

test("activity config crea binding automatici sulla prima attivita attiva", () => {
  assert.deepEqual(
    helpers.buildDefaultPosActivityRoomBindings(
      [
        { id: "activity_disabled", status: "disabled" },
        { id: "activity_bar", status: "active" },
      ],
      [{ id: "room_bar" }, { id: "room_gazebo" }, { id: "" }]
    ),
    [
      { id: "activity_room_1", activityId: "activity_bar", roomId: "room_bar", status: "active" },
      { id: "activity_room_2", activityId: "activity_bar", roomId: "room_gazebo", status: "active" },
    ]
  );
  assert.deepEqual(helpers.buildDefaultPosActivityRoomBindings([], [{ id: "room_bar" }]), []);
});
