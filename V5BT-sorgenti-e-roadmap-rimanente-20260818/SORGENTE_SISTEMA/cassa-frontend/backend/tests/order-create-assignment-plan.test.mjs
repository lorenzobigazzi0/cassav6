import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrderCreateAutoAssignmentPlan,
  buildOrderCreateStationEligibilityChecker,
} from "../modules/integration/order-create-assignment-plan.js";

function settingsWithWorkstations(workstations) {
  return { workstations };
}

test("MP-4y orders/create eligibility rispetta allow-list postazione", () => {
  const settings = settingsWithWorkstations([
    {
      id: "workstation_bar_1",
      stationName: "BAR-1",
      categoryIds: ["caffetteria"],
      active: true,
      status: "active",
    },
    {
      id: "workstation_bar_2",
      stationName: "BAR-2",
      productIds: ["menu_drink_hugo_spritz"],
      active: true,
      status: "active",
    },
  ]);
  const menuItemsByName = new Map([
    ["hugo", { id: "menu_drink_hugo_spritz", name: "Hugo Spritz", category: "Drink" }],
    ["caffe", { id: "menu_caffe", name: "Caffe", category: "Caffetteria" }],
  ]);
  const checker = buildOrderCreateStationEligibilityChecker({
    settings,
    menuItemsByName,
    findMenuItemForLine(line, map) {
      return map.get(String(line?.lookup ?? ""));
    },
  });

  assert.equal(
    checker({ station: "BAR-2" }, { items: [{ name: "Hugo", lookup: "hugo" }] }),
    true,
  );
  assert.equal(
    checker({ station: "BAR-2" }, { items: [{ name: "Caffe", lookup: "caffe" }] }),
    false,
  );
});

test("MP-4y orders/create assignment plan produce queued_unassigned senza postazioni eleggibili", () => {
  const plan = buildOrderCreateAutoAssignmentPlan({
    chooseBestStationForOrder(state, order, options) {
      assert.equal(options.isStationEligible({ station: "BAR-1" }, order), false);
      return { station: null, stationId: null, reason: "no_eligible_active_station" };
    },
    findMenuItemForLine() {
      return { id: "menu_caffe", category: "Caffetteria" };
    },
    menuItemsByName: new Map(),
    nowIso: () => "2026-07-04T19:30:00.000Z",
    order: { id: "001", station: "BAR-1", items: [{ name: "Caffe" }] },
    settings: settingsWithWorkstations([
      {
        stationName: "BAR-1",
        productIds: ["menu_drink_hugo_spritz"],
        active: true,
        status: "active",
      },
    ]),
    state: { integration: { orders: [] } },
  });

  assert.equal(plan.changed, true);
  assert.equal(plan.shouldReroute, false);
  assert.equal(plan.targetStationId, null);
  assert.deepEqual(plan.orderPatch, {
    assignedStationId: null,
    originalAssignedStationId: null,
    assignedStationOperatorUserId: "",
    assignedStationOperatorUsername: "",
    assignedStationOperatorName: "",
    assignedStationDeviceUuid: "",
    assignedStationClientApp: "",
    assignmentReason: "auto",
    assignmentStatus: "queued_unassigned",
    assignmentReasonDetail: "no_eligible_active_station",
    updatedAt: "2026-07-04T19:30:00.000Z",
  });
});

test("MP-4y orders/create assignment plan normalizza postazione e operatore scelti", () => {
  const plan = buildOrderCreateAutoAssignmentPlan({
    chooseBestStationForOrder() {
      return {
        stationId: " bar secondaria ",
        reason: "least_estimated_workload",
        station: {
          operatorUserId: "user_2",
          operatorUsername: "chiara",
          operatorName: "Chiara",
          deviceUuid: "device-2",
          clientApp: "postazione",
        },
      };
    },
    normalizeClientApp(value) {
      return String(value).trim().toLowerCase();
    },
    normalizeStation(value) {
      return String(value).trim().toUpperCase();
    },
    nowIso: () => "2026-07-04T19:31:00.000Z",
    order: { id: "002", station: "BAR PRINCIPALE", assignedStationId: "BAR PRINCIPALE" },
    settings: settingsWithWorkstations([]),
    state: { integration: { orders: [] } },
  });

  assert.equal(plan.changed, true);
  assert.equal(plan.shouldReroute, true);
  assert.equal(plan.targetStationId, "BAR SECONDARIA");
  assert.deepEqual(plan.orderPatch, {
    station: "BAR SECONDARIA",
    assignedStationId: "BAR SECONDARIA",
    originalAssignedStationId: "BAR SECONDARIA",
    assignedStationOperatorUserId: "user_2",
    assignedStationOperatorUsername: "chiara",
    assignedStationOperatorName: "Chiara",
    assignedStationDeviceUuid: "device-2",
    assignedStationClientApp: "postazione",
    assignmentReason: "auto",
    assignmentStatus: "assigned",
    assignmentReasonDetail: "least_estimated_workload",
    ownerStation: null,
    ownerOperator: null,
    ownerRole: null,
    ownerAtMs: null,
    updatedAt: "2026-07-04T19:31:00.000Z",
  });
});
