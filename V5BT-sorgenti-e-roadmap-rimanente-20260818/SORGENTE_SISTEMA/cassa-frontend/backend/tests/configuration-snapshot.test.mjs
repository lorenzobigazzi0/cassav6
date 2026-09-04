import assert from "node:assert/strict";
import test from "node:test";
import { buildConfigurationSnapshot } from "../modules/configuration/index.js";

test("configuration snapshot espone una configurazione legacy come locale operativo pubblicato", () => {
  const snapshot = buildConfigurationSnapshot({
    generatedAt: "2026-06-03T10:00:00.000Z",
    meta: {
      settingsVersion: 7,
      settingsLastWriteAt: "2026-06-03T09:59:00.000Z",
    },
    settings: {
      areas: [{ id: "room_gazebo", name: "Gazebo" }],
      tables: [
        { id: "table_1", number: 1, type: "Gazebo", roomId: "room_gazebo" },
        { id: "table_2", number: 2, type: "Pedana", roomId: "room_pedana" },
      ],
      printers: [{ id: "bar", name: "Bar", host: "192.168.1.100", port: 9100 }],
      areaMenus: [{ id: "drink", name: "Drink" }],
    },
    users: [{ id: "u1", username: "giada", fullName: "Giada Imperato", enabledRoomIds: ["room_gazebo"] }],
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.status, "published");
  assert.equal(snapshot.settingsVersion, 7);
  assert.deepEqual(snapshot.locale, { id: "locale_default", name: "Locale", status: "active" });
  assert.deepEqual(snapshot.activities, [
    {
      id: "activity_default",
      name: "Operativa",
      type: "operational",
      status: "active",
      fiscalPolicy: "standard",
      fiscalDeviceIds: [],
      menuIds: [],
      priceListIds: [],
      printerIds: [],
      precontoPrinterIds: [],
      workstationIds: [],
    },
  ]);
  assert.deepEqual(
    snapshot.rooms.map((room) => room.id).sort(),
    ["room_gazebo", "room_pedana"]
  );
  assert.deepEqual(
    snapshot.activityRoomBindings.map((binding) => [binding.activityId, binding.roomId]).sort(),
    [
      ["activity_default", "room_gazebo"],
      ["activity_default", "room_pedana"],
    ]
  );
  assert.equal(snapshot.printers[0].host, "192.168.1.100");
  assert.equal(snapshot.staffAssignments[0].fullName, "Giada Imperato");
  assert.equal(snapshot.menuScopes[0].name, "Drink");
});

test("configuration snapshot supporta attivita multiple e sale condivise senza duplicare la sala", () => {
  const snapshot = buildConfigurationSnapshot({
    settings: {
      areas: [
        { id: "room_gazebo", name: "Gazebo" },
        { id: "room_bar", name: "Bar" },
      ],
      tables: [
        { id: "g1", number: 1, type: "Gazebo", roomId: "room_gazebo" },
        { id: "b1", number: 1, type: "Bar", roomId: "room_bar" },
      ],
    },
    rawSettings: {
      locale: { id: "locale_amalia", name: "Amalia" },
      activities: [
        { id: "activity_bar", name: "Bar" },
        { id: "activity_ristorante", name: "Ristorante" },
      ],
      activityRoomBindings: [
        { activityId: "activity_bar", roomId: "room_gazebo" },
        { activityId: "activity_ristorante", roomId: "room_gazebo" },
        { activityId: "activity_bar", roomId: "room_bar" },
      ],
    },
  });

  assert.equal(snapshot.locale.id, "locale_amalia");
  assert.deepEqual(
    snapshot.activities.map((activity) => activity.id).sort(),
    ["activity_bar", "activity_ristorante"]
  );
  assert.deepEqual(
    snapshot.rooms.map((room) => room.id).sort(),
    ["room_bar", "room_gazebo"]
  );
  assert.deepEqual(
    snapshot.activityRoomBindings.map((binding) => `${binding.activityId}:${binding.roomId}`).sort(),
    [
      "activity_bar:room_bar",
      "activity_bar:room_gazebo",
      "activity_ristorante:room_gazebo",
    ]
  );
});

test("configuration snapshot ignora binding non validi e mantiene invarianti runtime", () => {
  const snapshot = buildConfigurationSnapshot({
    settings: {
      areas: [{ id: "room_pedana", name: "Pedana" }],
      tables: [],
    },
    rawSettings: {
      activities: [{ id: "activity_spiaggia", name: "Spiaggia" }],
      activityRoomBindings: [
        { activityId: "activity_spiaggia", roomId: "room_pedana" },
        { activityId: "activity_missing", roomId: "room_pedana" },
        { activityId: "activity_spiaggia", roomId: "room_missing" },
      ],
    },
  });

  assert.deepEqual(
    snapshot.activityRoomBindings.map((binding) => `${binding.activityId}:${binding.roomId}`),
    ["activity_spiaggia:room_pedana"]
  );
  assert.equal(snapshot.invariants.backendOwnsPriceResolution, true);
  assert.equal(snapshot.invariants.backendOwnsPrinterRouting, true);
  assert.equal(snapshot.invariants.ordersKeepCreationSnapshot, true);
});

test("configuration snapshot espone postazioni e cash point con sale e stampanti collegate", () => {
  const snapshot = buildConfigurationSnapshot({
    settings: {
      areas: [
        {
          id: "room_bar",
          name: "Bar",
          cashPoints: [
            {
              id: "cassa_bar",
              code: "BAR-RT",
              name: "Cassa Bar",
              printerIds: ["printer_rt_bar"],
            },
          ],
          workstations: [
            {
              id: "postazione_bar",
              name: "Postazione Bar",
              stationName: "Bar 1",
              printerIds: ["printer_bar"],
            },
            {
              id: "postazione_condivisa",
              name: "Postazione Condivisa",
              stationName: "Shared",
              printerIds: ["printer_bar"],
            },
          ],
        },
        {
          id: "room_gazebo",
          name: "Gazebo",
          workstations: [
            {
              id: "postazione_condivisa",
              name: "Postazione Condivisa",
              stationName: "Shared",
              printerIds: ["printer_gazebo"],
            },
          ],
        },
      ],
      printers: [
        { id: "printer_bar", name: "Bar", host: "192.168.1.100" },
        { id: "printer_gazebo", name: "Gazebo", host: "192.168.1.196" },
        { id: "printer_rt_bar", name: "RT Bar", host: "192.168.1.200", purpose: "fiscal" },
      ],
    },
  });

  const barStation = snapshot.workstations.find((entry) => entry.id === "postazione_bar");
  const sharedStation = snapshot.workstations.find((entry) => entry.id === "postazione_condivisa");
  const cashPoint = snapshot.workstations.find((entry) => entry.id === "cassa_bar");
  const barRoom = snapshot.rooms.find((entry) => entry.id === "room_bar");
  const rtBar = snapshot.fiscalDevices.find((entry) => entry.printerId === "printer_rt_bar");

  assert.deepEqual(barStation.roomIds, ["room_bar"]);
  assert.deepEqual(barStation.printerIds, ["printer_bar"]);
  assert.equal(barStation.type, "workstation");

  assert.deepEqual(sharedStation.roomIds, ["room_bar", "room_gazebo"]);
  assert.deepEqual(sharedStation.printerIds, ["printer_bar", "printer_gazebo"]);

  assert.equal(cashPoint.type, "cash_point");
  assert.deepEqual(cashPoint.roomIds, ["room_bar"]);
  assert.deepEqual(cashPoint.cashPointIds, ["cassa_bar"]);
  assert.deepEqual(cashPoint.printerIds, ["printer_rt_bar"]);

  assert.deepEqual(barRoom.printerIds, ["printer_bar"]);
  assert.equal(barRoom.fiscalPrinterIds, undefined);
  assert.deepEqual(barRoom.legacyFiscalPrinterIds, ["printer_rt_bar"]);
  assert.deepEqual(barRoom.legacyCashPointIds, ["cassa_bar"]);
  assert.deepEqual(barRoom.workstationIds, ["postazione_bar", "postazione_condivisa"]);

  assert.deepEqual(rtBar.activityIds, []);
  assert.deepEqual(rtBar.legacyRoomIds, ["room_bar"]);
  assert.deepEqual(rtBar.legacyCashPointIds, ["cassa_bar"]);
  assert.equal(rtBar.host, "192.168.1.200");
  assert.deepEqual(
    snapshot.legacyRoomFiscalAssignments.map((entry) => `${entry.roomId}:${entry.targetType}:${entry.printerId}`),
    ["room_bar:cash_point:printer_rt_bar"]
  );

  assert.deepEqual(
    snapshot.printerAssignments.map((entry) => `${entry.roomId}:${entry.targetType}:${entry.printerId}`).sort(),
    [
      "room_bar:cash_point:printer_rt_bar",
      "room_bar:workstation:printer_bar",
      "room_bar:workstation:printer_bar",
      "room_gazebo:workstation:printer_gazebo",
    ]
  );
});

test("configuration snapshot v2 risolve Terrazza condivisa con RT solo su attivita", () => {
  const snapshot = buildConfigurationSnapshot({
    generatedAt: "2026-06-04T08:00:00.000Z",
    settings: {
      locale: { id: "locale_amalia", name: "Amalia" },
      activities: [
        {
          id: "activity_bar",
          name: "Bar",
          fiscalPolicy: "bar_policy",
          fiscalDeviceIds: ["rt_bar"],
          menuIds: ["menu_bar"],
          priceListIds: ["price_bar"],
          printerIds: ["printer_bar"],
          workstationIds: ["station_bar"],
        },
        {
          id: "activity_ristorante",
          name: "Ristorante",
          fiscalPolicy: "restaurant_policy",
          fiscalDeviceIds: ["rt_ristorante"],
          menuIds: ["menu_ristorante"],
          priceListIds: ["price_ristorante"],
          printerIds: ["printer_ristorante"],
          workstationIds: ["station_ristorante"],
        },
      ],
      activityRoomBindings: [
        { activityId: "activity_bar", roomId: "room_terrazza" },
        { activityId: "activity_ristorante", roomId: "room_terrazza" },
      ],
      areas: [
        {
          id: "room_terrazza",
          name: "Terrazza",
          menuIds: ["menu_terrazza"],
          priceListIds: ["price_terrazza"],
          waiterUserIds: ["u_giada"],
          printerIds: ["printer_terrazza", "rt_legacy"],
          cashPoints: [{ id: "legacy_cash", name: "Legacy cash", fiscalPrinterId: "rt_legacy", printerIds: [] }],
        },
      ],
      tables: [
        { id: "t_1", number: 1, roomId: "room_terrazza" },
        { id: "t_2", number: 2, roomId: "room_terrazza" },
      ],
      printers: [
        { id: "printer_bar", name: "Bar", host: "10.0.0.10", purpose: "production" },
        { id: "printer_ristorante", name: "Ristorante", host: "10.0.0.11", purpose: "production" },
        { id: "printer_terrazza", name: "Terrazza", host: "10.0.0.12", purpose: "production" },
        { id: "rt_bar", name: "RT Bar", host: "10.0.0.20", purpose: "fiscal" },
        { id: "rt_ristorante", name: "RT Ristorante", host: "10.0.0.21", purpose: "fiscal" },
        { id: "rt_legacy", name: "RT Legacy Sala", host: "10.0.0.22", purpose: "fiscal" },
      ],
      areaMenus: [
        { id: "menu_bar", name: "Menu Bar", categories: ["Bar"] },
        { id: "menu_ristorante", name: "Menu Ristorante", categories: ["Cucina"] },
        { id: "menu_terrazza", name: "Menu Terrazza", categories: ["Terrazza"] },
      ],
    },
  });

  assert.equal(snapshot.schemaVersion, 2);
  assert.deepEqual(snapshot.rooms.map((room) => room.id), ["room_terrazza"]);
  assert.equal(snapshot.rooms[0].fiscalPrinterIds, undefined);
  assert.deepEqual(snapshot.rooms[0].legacyFiscalPrinterIds, ["rt_legacy"]);
  assert.deepEqual(snapshot.rooms[0].legacyCashPointIds, ["legacy_cash"]);

  const barContext = snapshot.resolvedContexts.find(
    (entry) => entry.activityId === "activity_bar" && entry.roomId === "room_terrazza"
  );
  const restaurantContext = snapshot.resolvedContexts.find(
    (entry) => entry.activityId === "activity_ristorante" && entry.roomId === "room_terrazza"
  );

  assert.deepEqual(barContext.fiscalDeviceIds, ["rt_bar"]);
  assert.equal(barContext.fiscalPolicy, "bar_policy");
  assert.deepEqual(barContext.effectiveMenuIds, ["menu_bar", "menu_terrazza"]);
  assert.deepEqual(barContext.effectivePriceListIds, ["price_bar", "price_terrazza"]);
  assert.deepEqual(barContext.effectivePrinterIds, ["printer_bar", "printer_terrazza"]);
  assert.deepEqual(barContext.tableIds, ["t_1", "t_2"]);
  assert.deepEqual(barContext.waiterUserIds, ["u_giada"]);
  assert.deepEqual(barContext.workstationIds, ["station_bar"]);
  assert.ok(barContext.legacyWarnings.some((warning) => warning.code === "legacy_room_fiscal_assignment_ignored"));

  assert.deepEqual(restaurantContext.fiscalDeviceIds, ["rt_ristorante"]);
  assert.equal(restaurantContext.fiscalPolicy, "restaurant_policy");
  assert.deepEqual(restaurantContext.effectiveMenuIds, ["menu_ristorante", "menu_terrazza"]);
  assert.deepEqual(restaurantContext.effectivePriceListIds, ["price_ristorante", "price_terrazza"]);
  assert.deepEqual(restaurantContext.effectivePrinterIds, ["printer_ristorante", "printer_terrazza"]);
  assert.deepEqual(restaurantContext.workstationIds, ["station_ristorante"]);

  assert.deepEqual(
    snapshot.activityFiscalAssignments.map((entry) => `${entry.activityId}:${entry.printerId}`).sort(),
    ["activity_bar:rt_bar", "activity_ristorante:rt_ristorante"]
  );
  assert.deepEqual(
    snapshot.legacyRoomFiscalAssignments.map((entry) => `${entry.roomId}:${entry.printerId}`),
    ["room_terrazza:rt_legacy"]
  );
});

test("configuration snapshot espone assegnazioni personale e menu per sala", () => {
  const snapshot = buildConfigurationSnapshot({
    settings: {
      areas: [
        {
          id: "room_spiaggia",
          name: "Spiaggia",
          menuIds: ["menu_drink", "menu_food"],
          waiterUserIds: ["u_giada"],
        },
      ],
      areaMenus: [
        { id: "menu_drink", name: "Drink", categories: ["Cocktail", "Bevande"] },
        { id: "menu_food", name: "Food", categories: ["Apericena"] },
      ],
    },
    users: [
      {
        id: "u_giada",
        username: "giada",
        fullName: "Giada Imperato",
        enabledRoomIds: ["room_spiaggia"],
        notificationPriorities: { ordine: "alta", consegna: "media", ritiro: "bassa" },
      },
      {
        id: "u_anna",
        username: "anna",
        fullName: "Anna Campana",
        authorizedRoomIds: ["room_spiaggia"],
        notificationPriorities: ["ritiro"],
      },
    ],
  });

  assert.deepEqual(
    snapshot.rooms.find((entry) => entry.id === "room_spiaggia").menuIds,
    ["menu_drink", "menu_food"]
  );
  assert.deepEqual(
    snapshot.rooms.find((entry) => entry.id === "room_spiaggia").waiterUserIds,
    ["u_giada"]
  );
  assert.deepEqual(
    snapshot.roomMenuAssignments.map((entry) => `${entry.roomId}:${entry.menuId}:${entry.categories.join(",")}`),
    ["room_spiaggia:menu_drink:Cocktail,Bevande", "room_spiaggia:menu_food:Apericena"]
  );
  assert.deepEqual(
    snapshot.roomStaffAssignments.map((entry) => `${entry.roomId}:${entry.username}:${entry.assignmentTypes.join(",")}`).sort(),
    [
      "room_spiaggia:anna:authorized",
      "room_spiaggia:giada:enabled,waiter",
    ]
  );
  const giadaAssignment = snapshot.roomStaffAssignments.find((entry) => entry.username === "giada");
  assert.equal(giadaAssignment.notificationPriorities.ordine, "alta");
  assert.deepEqual(giadaAssignment.sources.sort(), ["area.waiterUserIds", "user.enabledRoomIds"]);
  const annaAssignment = snapshot.roomStaffAssignments.find((entry) => entry.username === "anna");
  assert.equal(annaAssignment.notificationPriorities.ordine, "disabled");
  assert.equal(annaAssignment.notificationPriorities.ritiro, "enabled");
});

test("configuration snapshot risolve menu e listini temporizzati per attivita e sala", () => {
  const alwaysDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const snapshot = buildConfigurationSnapshot({
    generatedAt: "2026-06-04T10:00:00.000Z",
    settings: {
      locale: { id: "locale_demo", name: "Demo" },
      activities: [
        {
          id: "activity_bar",
          name: "Bar",
          fiscalPolicy: "bar_policy",
          fiscalDeviceIds: ["rt_bar"],
          menuIds: ["menu_bar"],
          priceListIds: ["price_base"],
          menuSchedules: [
            { id: "activity_menu_lunch", days: alwaysDays, start: "00:00", end: "23:59", menuIds: ["menu_pranzo"] },
          ],
          priceListSchedules: [
            { id: "activity_price_happy", days: alwaysDays, start: "00:00", end: "23:59", priceListIds: ["price_happy"] },
          ],
        },
      ],
      activityRoomBindings: [{ activityId: "activity_bar", roomId: "room_terrazza" }],
      areas: [
        {
          id: "room_terrazza",
          name: "Terrazza",
          menuIds: ["menu_terrazza"],
          priceListIds: ["price_terrazza"],
          menuSchedules: [
            { id: "room_menu_serale", days: alwaysDays, start: "00:00", end: "23:59", menuIds: ["menu_serale"] },
          ],
          priceListSchedules: [
            { id: "room_price_serale", days: alwaysDays, start: "00:00", end: "23:59", priceListIds: ["price_serale"] },
          ],
        },
      ],
      fiscalDevices: [{ id: "rt_bar", name: "RT Bar", type: "api" }],
      menus: [
        { id: "menu_bar", name: "Menu Bar", categories: [{ id: "cat_bar", name: "Bar", productIds: ["p_1"] }] },
        { id: "menu_pranzo", name: "Menu Pranzo", categories: [{ id: "cat_food", name: "Pranzo", productIds: ["p_2"] }] },
        { id: "menu_terrazza", name: "Menu Terrazza", categories: [{ id: "cat_terr", name: "Terrazza", productIds: ["p_3"] }] },
        { id: "menu_serale", name: "Menu Serale", categories: [{ id: "cat_evening", name: "Serale", productIds: ["p_4"] }] },
      ],
      priceLists: [
        { id: "price_base", name: "Base", prices: [{ productId: "p_1", price: 5 }] },
        { id: "price_happy", name: "Happy hour", prices: [{ productId: "p_1", price: 4 }] },
        { id: "price_terrazza", name: "Terrazza", prices: [{ productId: "p_3", price: 6 }] },
        { id: "price_serale", name: "Serale", prices: [{ productId: "p_4", price: 7 }] },
      ],
    },
  });

  const context = snapshot.resolvedContexts.find(
    (entry) => entry.activityId === "activity_bar" && entry.roomId === "room_terrazza"
  );

  assert.deepEqual(context.fiscalDeviceIds, ["rt_bar"]);
  assert.deepEqual(context.effectiveMenuIds, ["menu_bar", "menu_pranzo", "menu_terrazza", "menu_serale"]);
  assert.deepEqual(context.effectivePriceListIds, ["price_base", "price_happy", "price_terrazza", "price_serale"]);
  assert.deepEqual(context.scheduledActivityMenuIds, ["menu_pranzo"]);
  assert.deepEqual(context.scheduledRoomMenuIds, ["menu_serale"]);
  assert.deepEqual(context.scheduledActivityPriceListIds, ["price_happy"]);
  assert.deepEqual(context.scheduledRoomPriceListIds, ["price_serale"]);
  assert.equal(snapshot.menus.length, 4);
  assert.equal(snapshot.priceLists.length, 4);
});
