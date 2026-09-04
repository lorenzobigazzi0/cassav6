import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMenuItemAvailabilityList,
  findConfiguredMenuRoutingWorkstationForStation,
  pickMenuRoutingStationForLine,
  resolveConfiguredMenuRoutingStations,
  resolveMenuCatalogStationsForItem,
  resolveMenuItemAvailabilityInfo,
  resolveMenuRoutingStationsForItem,
  sanitizeMenuItemAvailabilityMap,
  workstationAllowsMenuRoutingLine,
} from "../modules/menu/menu-routing.domain.js";

function settingsWithWorkstations(workstations = []) {
  return {
    workstations,
  };
}

test("menu routing risolve Drink Premium sulla prima postazione bar configurata", () => {
  const settings = settingsWithWorkstations([
    { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", active: true, status: "active" },
    { id: "workstation_bar_2", name: "BAR-2", stationName: "BAR-2", active: true, status: "active" },
  ]);

  assert.deepEqual(
    resolveMenuRoutingStationsForItem({ id: "capri", name: "Capri", category: "Drink Premium" }, { settings }),
    ["BAR-1"]
  );
});

test("menu routing mappa workstationIds espliciti su stationName configurata", () => {
  const settings = settingsWithWorkstations([
    { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", active: true, status: "active" },
    { id: "workstation_chiringuito_1", name: "CHIRINGUITO-1", stationName: "CHIRINGUITO-1", active: true, status: "active" },
  ]);

  assert.deepEqual(
    resolveMenuRoutingStationsForItem(
      { id: "mojito", name: "Mojito", category: "Drink", workstationIds: ["workstation_chiringuito_1"] },
      { settings }
    ),
    ["CHIRINGUITO-1"]
  );
});

test("menu routing usa allow-list di postazione per categoria e articolo", () => {
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

  assert.deepEqual(
    resolveMenuRoutingStationsForItem(
      { id: "menu_drink_hugo_spritz", name: "Hugo Spritz", category: "Drink" },
      { settings }
    ),
    ["BAR-2"]
  );
  assert.deepEqual(
    resolveMenuRoutingStationsForItem(
      { id: "menu_caffe", name: "Caffe", category: "Caffetteria" },
      { settings }
    ),
    ["BAR-1"]
  );
});

test("menu routing senza postazioni configurate non inventa stationId vuoti", () => {
  assert.deepEqual(
    resolveConfiguredMenuRoutingStations(settingsWithWorkstations([])),
    []
  );
  assert.deepEqual(
    resolveMenuRoutingStationsForItem(
      { id: "capri", name: "Capri", category: "Drink Premium" },
      { settings: settingsWithWorkstations([]) }
    ),
    []
  );
});

test("catalogo usa postazioni attive solo quando la postazione teorica non e attiva", () => {
  const settings = settingsWithWorkstations([
    { id: "workstation_bar_1", stationName: "BAR-1", active: true, status: "active" },
    { id: "workstation_bar_2", stationName: "BAR-2", active: true, status: "active" },
  ]);

  assert.deepEqual(
    resolveMenuCatalogStationsForItem(
      { id: "capri", name: "Capri", category: "Drink Premium" },
      "Drink Premium",
      ["BAR-2"],
      { settings }
    ),
    ["BAR-2"]
  );
});

test("pick station per riga premium usa configurazione e non costanti statiche", () => {
  const settings = settingsWithWorkstations([
    { id: "workstation_bar_1", stationName: "BAR-1", active: true, status: "active" },
  ]);

  assert.equal(
    pickMenuRoutingStationForLine(
      { name: "Gin Tonic", category: "Drink", variant: "Gin premium" },
      {
        settings,
        menuItem: { id: "menu_drink_gin_tonic", name: "Gin Tonic", category: "Drink" },
        markers: ["Gin premium"],
        variantDelta: 2.5,
      }
    ),
    "BAR-1"
  );
});

test("menu routing trova la postazione configurata tramite stationName e alias", () => {
  const settings = settingsWithWorkstations([
    { id: "workstation_bar_1", name: "BAR-1", stationName: "BAR-1", active: true, status: "active" },
  ]);

  const workstation = findConfiguredMenuRoutingWorkstationForStation(settings, "BAR-1");
  assert.equal(workstation?.id, "workstation_bar_1");
  assert.equal(findConfiguredMenuRoutingWorkstationForStation(settings, "postazione sconosciuta"), null);
});

test("menu routing eligibility rispetta allow-list ed esclusioni della postazione", () => {
  const workstation = {
    id: "workstation_bar_2",
    stationName: "BAR-2",
    productIds: ["menu_drink_hugo_spritz"],
    categoryIds: ["signature cocktail"],
    excludedProductIds: ["menu_signature_amarcord"],
  };

  assert.equal(
    workstationAllowsMenuRoutingLine(
      workstation,
      { productId: "menu_drink_hugo_spritz", name: "Hugo Spritz", category: "Drink" },
      {}
    ),
    true
  );
  assert.equal(
    workstationAllowsMenuRoutingLine(
      workstation,
      { productId: "menu_signature_boccaccio_70", name: "Boccaccio 70" },
      { category: "Signature Cocktail" }
    ),
    true
  );
  assert.equal(
    workstationAllowsMenuRoutingLine(
      workstation,
      { productId: "menu_signature_amarcord", name: "Amarcord" },
      { category: "Signature Cocktail" }
    ),
    false
  );
  assert.equal(
    workstationAllowsMenuRoutingLine(
      workstation,
      { productId: "menu_caffetteria_caffe", name: "Caffe", category: "Caffetteria" },
      {}
    ),
    false
  );
});

test("menu routing eligibility senza allow-list accetta salvo esclusioni", () => {
  const workstation = {
    id: "workstation_bar_1",
    stationName: "BAR-1",
    excludedCategoryIds: ["caffetteria"],
  };

  assert.equal(
    workstationAllowsMenuRoutingLine(
      workstation,
      { productId: "menu_drink_aperol_spritz", name: "Aperol Spritz", category: "Drink" },
      {}
    ),
    true
  );
  assert.equal(
    workstationAllowsMenuRoutingLine(
      workstation,
      { productId: "menu_caffe", name: "Caffe" },
      { category: "Caffetteria" }
    ),
    false
  );
});

test("menu routing eligibility accetta righe legacy senza menuId su postazione limitata al menu principale", () => {
  const workstation = {
    id: "workstation_bar_1",
    stationName: "BAR-1",
    menuIds: ["menu_main"],
    excludedCategoryIds: ["gelati"],
  };

  assert.equal(
    workstationAllowsMenuRoutingLine(
      workstation,
      { productId: "menu_drink_hugo_spritz", name: "Hugo Spritz", category: "Drink" },
      {}
    ),
    true
  );
  assert.equal(
    workstationAllowsMenuRoutingLine(
      workstation,
      { productId: "menu_gelato_coppetta", name: "Coppetta", category: "Gelati" },
      {}
    ),
    false
  );
});

test("menu routing eligibility continua a rispettare menuId espliciti quando presenti", () => {
  const workstation = {
    id: "workstation_bar_1",
    stationName: "BAR-1",
    menuIds: ["menu_main"],
  };

  assert.equal(
    workstationAllowsMenuRoutingLine(
      workstation,
      { productId: "menu_drink_hugo_spritz", name: "Hugo Spritz", menuId: "menu_main" },
      {}
    ),
    true
  );
  assert.equal(
    workstationAllowsMenuRoutingLine(
      workstation,
      { productId: "menu_extra_partner", name: "Extra partner", menuId: "menu_partner" },
      {}
    ),
    false
  );
});

test("menu availability normalizza blocchi globali e per stazione", () => {
  const sanitized = sanitizeMenuItemAvailabilityMap(
    {
      "Capri Premium": { scope: "station", stationIds: ["BAR-1", "BAR-1"], updatedBy: "admin" },
      caffe: { disabled: true },
      empty_station_scope: { scope: "station", stations: [] },
    },
    { nowIso: () => "2026-06-05T10:00:00.000Z" }
  );

  assert.deepEqual(sanitized.capri_premium, {
    scope: "station",
    stations: ["BAR-1"],
    updatedAt: "2026-06-05T10:00:00.000Z",
    updatedBy: "admin",
  });
  assert.equal(sanitized.caffe, false);
  assert.deepEqual(sanitized.empty_station_scope.stations, []);
});

test("menu availability risolve disponibilita globale e per station", () => {
  const availability = sanitizeMenuItemAvailabilityMap({
    capri: { scope: "station", stations: ["BAR-1"] },
    caffe: false,
  });

  assert.deepEqual(
    resolveMenuItemAvailabilityInfo({ id: "capri", name: "Capri", stations: ["BAR-1"] }, availability, "BAR-1"),
    { available: false, scope: "station", stations: ["BAR-1"], matchesStation: true }
  );
  assert.deepEqual(
    resolveMenuItemAvailabilityInfo({ id: "capri", name: "Capri", stations: ["BAR-1"] }, availability, "BAR-2"),
    { available: true, scope: "station", stations: ["BAR-1"], matchesStation: false }
  );
  assert.deepEqual(
    resolveMenuItemAvailabilityInfo({ id: "caffe", name: "Caffe" }, availability, "BAR-1"),
    { available: false, scope: "global", stations: [], matchesStation: false }
  );
});

test("menu availability list espone dati ordinati per frontend", () => {
  const list = buildMenuItemAvailabilityList(
    {
      zeta: { scope: "station", stations: ["BAR-2"], updatedAt: "2026-06-05T11:00:00.000Z" },
      alpha: false,
    },
    "BAR-2"
  );

  assert.deepEqual(list.map((entry) => entry.key), ["alpha", "zeta"]);
  assert.equal(list[0].availabilityScope, "global");
  assert.equal(list[1].available, false);
  assert.equal(list[1].unavailableForStation, true);
});
