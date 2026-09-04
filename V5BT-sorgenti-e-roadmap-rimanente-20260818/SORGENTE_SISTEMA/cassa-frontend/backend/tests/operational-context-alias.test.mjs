import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveConfiguredWorkstationId,
  resolveOperationalContext,
} from "../modules/configuration/index.js";

test("[BE][CONFIG] alias visibile della postazione risolve l'id configurato", () => {
  const settings = {
    locale: { id: "locale_amalia", name: "Amalia Laghi" },
    activities: [
      {
        id: "activity_bar",
        name: "Bar",
        workstationIds: ["workstation_bar_1"],
        precontoPrinterIds: ["printer_bar"],
        fiscalDeviceIds: ["rt_bar_api"],
      },
    ],
    areas: [{ id: "room_gazebo", name: "Gazebo" }],
    activityRoomBindings: [{ id: "bar_gazebo", activityId: "activity_bar", roomId: "room_gazebo" }],
    workstations: [
      {
        id: "workstation_bar_1",
        name: "BAR-1",
        stationName: "BAR-1",
      },
    ],
  };

  assert.equal(resolveConfiguredWorkstationId(settings, "BAR-1"), "workstation_bar_1");
  assert.equal(resolveConfiguredWorkstationId(settings, "bar 1"), "workstation_bar_1");

  const context = resolveOperationalContext({
    settings,
    activityId: "activity_bar",
    roomId: "room_gazebo",
    workstationId: "BAR-1",
  });

  assert.equal(context.activityId, "activity_bar");
  assert.equal(context.roomId, "room_gazebo");
  assert.equal(context.workstationId, "workstation_bar_1");
  assert.deepEqual(context.effectivePrecontoPrinterIds, ["printer_bar"]);
});

test("[BE][CONFIG] preconti usano solo stampanti preconto dedicate del proprio contesto", () => {
  const settings = {
    locale: { id: "locale_amalia", name: "Amalia Laghi" },
    printers: [
      { id: "printer_bar", name: "Preconti Bar", purpose: "generic", active: true },
      { id: "printer_pizza", name: "Preconti Pizza", purpose: "generic", active: true },
      { id: "rt_bar", name: "RT Bar", purpose: "fiscal", active: true },
    ],
    activities: [
      {
        id: "activity_bar",
        name: "Bar",
        printerIds: ["printer_bar", "rt_bar"],
        precontoPrinterIds: ["printer_bar"],
        fiscalDeviceIds: ["rt_bar"],
      },
      {
        id: "activity_pizza",
        name: "Pizza",
        printerIds: ["printer_pizza"],
        precontoPrinterIds: [],
        fiscalDeviceIds: [],
      },
    ],
    areas: [
      { id: "room_gazebo", name: "Gazebo" },
      { id: "room_pizza", name: "Pizza in Riva" },
    ],
    activityRoomBindings: [
      { id: "bar_gazebo", activityId: "activity_bar", roomId: "room_gazebo" },
      { id: "pizza_room", activityId: "activity_pizza", roomId: "room_pizza" },
    ],
  };

  const barContext = resolveOperationalContext({
    settings,
    activityId: "activity_bar",
    roomId: "room_gazebo",
  });
  const pizzaContext = resolveOperationalContext({
    settings,
    activityId: "activity_pizza",
    roomId: "room_pizza",
  });

  assert.deepEqual(barContext.effectivePrinterIds, ["printer_bar"]);
  assert.deepEqual(barContext.effectivePrecontoPrinterIds, ["printer_bar"]);
  assert.deepEqual(barContext.fiscalDeviceIds, ["rt_bar"]);
  assert.deepEqual(pizzaContext.effectivePrinterIds, ["printer_pizza"]);
  assert.deepEqual(pizzaContext.effectivePrecontoPrinterIds, []);
  assert.deepEqual(pizzaContext.fiscalDeviceIds, []);
});
