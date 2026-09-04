import assert from "node:assert/strict";
import test from "node:test";
import { createPosAreaConfigHelpers } from "../modules/configuration/area-config.domain.js";

const helpers = createPosAreaConfigHelpers({
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
  normalizeStringList: (value, maxLength = 16, itemMaxLength = 64) => {
    const seen = new Set();
    return (Array.isArray(value) ? value : [])
      .map((entry) => String(entry ?? "").trim().slice(0, itemMaxLength))
      .filter((entry) => {
        if (!entry || seen.has(entry)) return false;
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

test("area config normalizza minimumTables con alias e limiti", () => {
  assert.equal(helpers.resolveConfiguredAreaMinimumTables({ tableCount: "25.8" }), 25);
  assert.equal(helpers.resolveConfiguredAreaMinimumTables({ tablesCount: 999 }), 500);
  assert.equal(helpers.resolveConfiguredAreaMinimumTables({ defaultTables: -4 }), 0);
  assert.equal(helpers.resolveConfiguredAreaMinimumTables({ minimumTables: "x" }), 0);
});

test("area config sanitizza cash point filtrando stampante fiscale non configurata", () => {
  const printerIds = new Set(["printer_bar", "rt_bar"]);
  assert.deepEqual(
    helpers.sanitizePosAreaCashPoint(
      {
        id: " Cassa Bar ",
        label: " Cassa Bar ",
        code: " BAR RT ",
        printerIds: ["Printer Bar", "Missing"],
        fiscalPrinterId: "RT Bar",
      },
      "fallback",
      { printerIds }
    ),
    {
      id: "cassa_bar",
      name: "Cassa Bar",
      code: "bar_rt",
      printerIds: ["printer_bar"],
      fiscalPrinterId: "rt_bar",
    }
  );
  assert.equal(
    helpers.sanitizePosAreaCashPoint({ name: "Cassa", fiscalPrinterId: "missing" }, "fallback", { printerIds })
      .fiscalPrinterId,
    null
  );
});

test("area config sanitizza postazione con scope menu/categorie/articoli", () => {
  const workstation = helpers.sanitizePosAreaWorkstation(
    {
      id: " BAR 1 ",
      name: " Bar 1 ",
      stationName: " BAR-1 ",
      active: false,
      useOwnPrinters: true,
      printOrderEnabled: false,
      printPrecontoEnabled: true,
      printTableChangesEnabled: false,
      rooms: ["Room Bar"],
      printerIds: ["Printer Bar", "Missing"],
      billPrinterIds: ["Preconti Bar"],
      enabledMenuIds: ["Menu Drink", "Menu Missing"],
      enabledCategoryIds: ["Drink", "Drink", "Caffetteria"],
      enabledProductIds: ["Hugo Spritz"],
      disabledCategoryIds: ["Caffetteria"],
      disabledProductIds: ["Caffe"],
    },
    "fallback",
    {
      printerIds: new Set(["printer_bar", "preconti_bar"]),
      menuIds: new Set(["menu_drink"]),
    }
  );

  assert.deepEqual(workstation, {
    id: "bar_1",
    name: "Bar 1",
    stationName: "BAR-1",
    active: false,
    status: "disabled",
    useOwnPrinters: true,
    printOrderEnabled: false,
    printPrecontoEnabled: true,
    printTableChangesEnabled: false,
    roomIds: ["room_bar"],
    printerIds: ["printer_bar"],
    precontoPrinterIds: ["preconti_bar"],
    menuIds: ["menu_drink"],
    categoryIds: ["Drink", "Caffetteria"],
    productIds: ["hugo_spritz"],
    excludedCategoryIds: ["Caffetteria"],
    excludedProductIds: ["caffe"],
  });
});

test("area config sanitizza sala completa con schedule, preconti e figli", () => {
  const area = helpers.sanitizePosArea(
    {
      id: " Room Gazebo ",
      name: " Gazebo ",
      notes: " note ".repeat(80),
      defaultTableCount: 25,
      menuIds: ["Menu Drink"],
      listinoIds: ["Listino Giorno"],
      waiterUserIds: ["Giada", "Missing"],
      printerIds: ["Printer Bar"],
      precontoPrinterId: "Preconti Bar",
      menuSchedule: [{ enabled: true }],
      priceListSchedule: [{ enabled: false }],
      cashPoints: [{ name: "Cassa Gazebo", printerIds: ["Printer Bar"] }],
      workstations: [{ name: "Bar 1", printerIds: ["Printer Bar"] }],
    },
    "area_1",
    {
      printerIds: new Set(["printer_bar", "preconti_bar"]),
      menuIds: new Set(["menu_drink"]),
      userIds: new Set(["giada"]),
    }
  );

  assert.equal(area.id, "room_gazebo");
  assert.equal(area.name, "Gazebo");
  assert.equal(area.minimumTables, 25);
  assert.equal(area.notes.length, 240);
  assert.deepEqual(area.menuIds, ["menu_drink"]);
  assert.deepEqual(area.priceListIds, ["listino_giorno"]);
  assert.deepEqual(area.waiterUserIds, ["giada"]);
  assert.deepEqual(area.printerIds, ["printer_bar"]);
  assert.deepEqual(area.precontoPrinterIds, ["preconti_bar"]);
  assert.deepEqual(area.menuSchedules, [{ id: "room_gazebo_menu_schedule_1", targetField: "menuIds", enabled: true }]);
  assert.deepEqual(area.priceListSchedules, [
    { id: "room_gazebo_price_list_schedule_1", targetField: "priceListIds", enabled: false },
  ]);
  assert.deepEqual(area.cashPoints.map((entry) => entry.id), ["room_gazebo_cash_1"]);
  assert.deepEqual(area.workstations.map((entry) => entry.id), ["room_gazebo_station_1"]);
});

test("area config scarta sala, cash point e postazione senza nome", () => {
  assert.equal(helpers.sanitizePosArea(null), null);
  assert.equal(helpers.sanitizePosArea({ id: "room" }), null);
  assert.equal(helpers.sanitizePosAreaCashPoint({ id: "cash" }), null);
  assert.equal(helpers.sanitizePosAreaWorkstation({ id: "station" }), null);
});
