import test from "node:test";
import assert from "node:assert/strict";
import { createMenuItemDomain } from "../modules/menu/index.js";

function createDomain(overrides = {}) {
  return createMenuItemDomain({
    isPremiumAlcoholText: (...values) =>
      values.join(" ").toLowerCase().includes("premium cocktail"),
    normalizeMenuItemPriceSchedule: (value) =>
      Array.isArray(value) ? value.map((entry) => ({ ...entry })) : [],
    nowIso: () => "2026-01-01T10:00:00.000Z",
    slugifyId: (value, fallback = "item") =>
      String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || fallback,
    ...overrides,
  });
}

test("menu domain normalizza varianti, duplicati e disponibilita", () => {
  const { normalizeMenuItemVariants } = createDomain();

  assert.deepEqual(
    normalizeMenuItemVariants([
      { label: "Grande", price: "1.25" },
      { name: "Grande", priceDelta: 2 },
      { id: "small", name: "Piccola", delta: -0.5, enabled: false },
      null,
    ]),
    [
      { id: "grande_1", name: "Grande", priceDelta: 1.25 },
      {
        id: "small",
        name: "Piccola",
        priceDelta: -0.5,
        enabled: false,
        available: false,
      },
    ],
  );
});

test("menu domain mantiene il backend source of truth per schedule e premium variant", () => {
  const { sanitizeMenuItem } = createDomain();
  const sanitized = sanitizeMenuItem({
    id: "spritz",
    name: "Premium Cocktail",
    price: "8.50",
    category: "Bar",
    imageUrl: " /img/spritz.png ",
    ingredienti: [" prosecco ", "", " bitter "],
    reparto: "BAR",
    variants: [{ name: "Base" }],
    listinoTemporizzato: [
      { id: "happy", start: "18:00", end: "20:00", price: 6 },
    ],
  });

  assert.equal(sanitized.price, 8.5);
  assert.equal(sanitized.imageUrl, "/img/spritz.png");
  assert.equal(sanitized.isPremiumAlcohol, true);
  assert.equal(sanitized.variantRequired, true);
  assert.equal(sanitized.requiresVariant, true);
  assert.equal(sanitized.requiresVariantSelection, true);
  assert.deepEqual(sanitized.ingredients, ["prosecco", "bitter"]);
  assert.deepEqual(sanitized.priceSchedule, [
    { id: "happy", start: "18:00", end: "20:00", price: 6 },
  ]);
});

test("menu domain normalizza allergeni HACCP con etichette ufficiali", () => {
  const { normalizeMenuItem, sanitizeMenuItem } = createDomain();

  const normalized = normalizeMenuItem(
    {
      name: "Piatto",
      price: 9,
      category: "Cucina",
      allergens: [
        " sesamo ",
        "Semi di sesamo",
        "frutta secca",
        "Lupini",
        "Nickel",
      ],
    },
    "fallback",
  );
  const sanitized = sanitizeMenuItem({
    id: "piatto",
    name: "Piatto",
    price: 9,
    category: "Cucina",
    allergeni: ["glutine", "molluschi", "sesamo"],
  });

  assert.deepEqual(normalized.allergens, [
    "Semi di sesamo",
    "Frutta a guscio",
    "Lupini",
    "Nickel",
  ]);
  assert.deepEqual(sanitized.allergens, [
    "Glutine",
    "Molluschi",
    "Semi di sesamo",
  ]);
});

test("menu domain normalizza item persistito con timestamp iniettato", () => {
  const { normalizeMenuItem } = createDomain();
  const normalized = normalizeMenuItem(
    {
      name: "  Articolo ",
      price: "2.345",
      category: "",
      subcategory: " Bevande ",
      kind: "divider",
      desc: "Descrizione",
      department: "Bar",
      variants: [{ name: "Normale" }],
      timedPrices: [{ id: "lunch", start: "12:00", end: "14:00", price: 2 }],
    },
    "fallback",
  );

  assert.equal(normalized.id, "fallback");
  assert.equal(normalized.name, "Articolo");
  assert.equal(normalized.price, 2.35);
  assert.equal(normalized.category, "Altro");
  assert.equal(normalized.section, "Bevande");
  assert.equal(normalized.type, "divider");
  assert.equal(normalized.createdByUserId, "system");
  assert.equal(normalized.createdAt, "2026-01-01T10:00:00.000Z");
  assert.equal(normalized.updatedAt, "2026-01-01T10:00:00.000Z");
  assert.deepEqual(normalized.priceSchedule, [
    { id: "lunch", start: "12:00", end: "14:00", price: 2 },
  ]);
});

test("menu domain espone mock/demo solo con opt-in", () => {
  assert.equal(
    createDomain().shouldExposeMenuItemInRuntime({ source: "mock" }),
    false,
  );
  assert.equal(
    createDomain({ enableMockMenu: true }).shouldExposeMenuItemInRuntime({
      source: "mock",
    }),
    true,
  );
  assert.equal(
    createDomain({ enableDemoProducts: true }).shouldExposeMenuItemInRuntime({
      source: "demo",
    }),
    true,
  );
  assert.equal(
    createDomain().shouldExposeMenuItemInRuntime({ source: "catalog" }),
    true,
  );
});
