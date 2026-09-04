import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRuntimeMenuItemPrice,
  createMenuPriceListResolver,
  menuPriceScheduleCacheBucket,
  menuScheduleRuleMatchesNow,
  normalizeMenuItemPriceSchedule,
  parseMenuClockMinutes,
  readPriceListMoneyValue,
  resolveMenuItemPriceSchedule,
} from "../modules/price-lists/index.js";

test("price-lists normalizza orari, denaro e scarta fasce invalide", () => {
  assert.equal(parseMenuClockMinutes("9:05"), 545);
  assert.equal(parseMenuClockMinutes("2400"), null);
  assert.equal(readPriceListMoneyValue("EUR 1.234,50"), 1234.5);

  assert.deepEqual(
    normalizeMenuItemPriceSchedule([
      { id: "happy", label: "Happy hour", start: "09:00", end: "11:00", price: "4,50" },
      { id: "bad-time", start: "26:00", end: "27:00", price: 1 },
      { id: "bad-price", start: "12:00", end: "13:00", price: -1 },
    ]),
    [
      {
        id: "happy",
        label: "Happy hour",
        start: "09:00",
        end: "11:00",
        price: 4.5,
        enabled: true,
      },
    ]
  );
});

test("price-lists risolve fascia normale, disabilitata e attraversamento mezzanotte", () => {
  const morning = new Date("2026-01-01T10:30:00Z");
  const late = new Date("2026-01-01T23:30:00Z");
  const options = { timeZone: "UTC" };

  assert.equal(
    resolveMenuItemPriceSchedule(
      { price: 10, priceSchedule: [{ id: "morning", start: "09:00", end: "11:00", price: 4.5 }] },
      morning,
      options
    ).price,
    4.5
  );
  assert.equal(
    resolveMenuItemPriceSchedule(
      { price: 10, priceSchedule: [{ id: "off", start: "09:00", end: "11:00", price: 3, enabled: false }] },
      morning,
      options
    ).price,
    10
  );
  assert.equal(
    resolveMenuItemPriceSchedule(
      { price: 10, priceSchedule: [{ id: "night", start: "22:00", end: "02:00", price: 6 }] },
      late,
      options
    ).activeRule.id,
    "night"
  );
});

test("price-lists espone snapshot runtime compatibile con il catalogo menu", () => {
  const product = applyRuntimeMenuItemPrice(
    {
      id: "spritz",
      name: "Spritz",
      price: 8,
      listinoTemporizzato: [{ id: "aperitivo", label: "Aperitivo", start: "18:00", end: "20:00", price: 6 }],
    },
    new Date("2026-01-01T18:30:00Z"),
    { timeZone: "UTC" }
  );

  assert.equal(product.price, 6);
  assert.equal(product.basePrice, 8);
  assert.equal(product.currentPriceScheduleId, "aperitivo");
  assert.equal(product.currentPriceScheduleLabel, "Aperitivo");
  assert.equal(product.priceSchedule.length, 1);
});

test("price-lists calcola bucket cache stabile tra i confini di cambio prezzo", () => {
  const menuItems = [
    {
      price: 10,
      priceSchedule: [
        { id: "morning", start: "09:00", end: "11:00", price: 4.5 },
        { id: "evening", start: "18:00", end: "20:00", price: 7 },
      ],
    },
  ];

  assert.equal(
    menuPriceScheduleCacheBucket(menuItems, new Date("2026-01-01T10:30:00Z"), { timeZone: "UTC" }),
    "scheduled:09:00-11:00"
  );
  assert.equal(menuPriceScheduleCacheBucket([{ price: 1 }], new Date("2026-01-01T10:30:00Z"), { timeZone: "UTC" }), "static");
});

test("price-lists resolver usa override test senza accedere al monolite", () => {
  const resolver = createMenuPriceListResolver({
    appEnv: "test",
    env: { MENU_PRICE_SCHEDULE_NOW_ISO: "2026-01-01T23:30:00Z" },
    timeZone: "UTC",
  });
  const rule = { start: "22:00", end: "02:00", price: 6 };

  assert.equal(resolver.getMenuPriceScheduleMinutes(), 23 * 60 + 30);
  assert.equal(resolver.menuScheduleRuleMatchesNow(rule), true);
  assert.equal(
    resolver.resolveMenuItemPriceSchedule({
      price: 10,
      timePriceSchedule: [{ id: "night", ...rule }],
    }).price,
    6
  );
});
