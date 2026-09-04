import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DRINK_PREMIUM_ITEMS,
  DEFAULT_MENU_ITEMS,
  replaceMenuCategoryItems,
} from "../modules/menu/default-menu-catalog.js";

const EXPECTED_SECTION_COUNTS = {
  "Amari e Liquori": 20,
  Gin: 22,
  Vodka: 5,
  Rum: 8,
  Tequila: 8,
  "Cognac e Brandy": 6,
  Wiskey: 9,
};

const EXPECTED_CATEGORY_COUNTS = {
  "Amari e Liquori": 20,
  "Drink Premium": 35,
  Rum: 8,
  "Cognac e Brandy": 6,
  Wiskey: 9,
};

const EXPECTED_PRICES = {
  Averna: 4,
  Braulio: 5,
  Jefferson: 6,
  "Sabatini London Dry": 10,
  "Presobene London Dry": 18,
  "Hendryck’s Original Distilled": 10,
  "Monkey 47 Schwarzwald Dry": 12,
  "Gin Mare Capri Mediterraneo": 14,
  "Kinobi Kyoto Dry": 15,
  "Tanqueray 0": 10,
  Tanqueray: 10,
  "Grey Goose": 10,
  Absolut: 8,
  SKYY: 10,
  "Santa Teresa Solera 1796": 10,
  "Don Papa Masskara": 12,
  "Patron Silver": 12,
  "Xaman Espadin": 12,
  Courvoisier: 10,
  "Vecchia Romagna": 8,
  "Jack Daniel’s Bourbon": 8,
  "Oban 14 Single Malt Scotch": 15,
  "Flaming Pig Irish": 10,
};

test("catalogo Drink Premium espone sezioni, instradamento e varianti completi", () => {
  assert.equal(DEFAULT_DRINK_PREMIUM_ITEMS.length, 78);

  const sectionCounts = Object.fromEntries(
    Object.keys(EXPECTED_SECTION_COUNTS).map((section) => [
      section,
      DEFAULT_DRINK_PREMIUM_ITEMS.filter((item) => item.section === section)
        .length,
    ]),
  );
  assert.deepEqual(sectionCounts, EXPECTED_SECTION_COUNTS);
  const categoryCounts = Object.fromEntries(
    Object.keys(EXPECTED_CATEGORY_COUNTS).map((category) => [
      category,
      DEFAULT_DRINK_PREMIUM_ITEMS.filter((item) => item.category === category)
        .length,
    ]),
  );
  assert.deepEqual(categoryCounts, EXPECTED_CATEGORY_COUNTS);

  const ids = DEFAULT_DRINK_PREMIUM_ITEMS.map((item) => item.id);
  const names = DEFAULT_DRINK_PREMIUM_ITEMS.map((item) =>
    item.name.toLocaleLowerCase("it-IT"),
  );
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(names).size, names.length);

  DEFAULT_DRINK_PREMIUM_ITEMS.forEach((item) => {
    assert.equal(item.enabled, true);
    assert.equal(item.department, "bar");
    assert.equal(item.reparto, "bar");
    assert.equal(item.variantRequired, true);
    assert.equal(item.isPremiumAlcohol, true);
    assert.deepEqual(
      item.variants.map((variant) => variant.name),
      ["Liscio", "Lemon", "Tonic", "Fizz"],
    );
  });
});

test("catalogo Drink Premium mantiene prezzi richiesti e prodotti preesistenti", () => {
  const itemsByName = new Map(
    DEFAULT_DRINK_PREMIUM_ITEMS.map((item) => [item.name, item]),
  );

  Object.entries(EXPECTED_PRICES).forEach(([name, price]) => {
    assert.equal(
      itemsByName.get(name)?.price,
      price,
      `Prezzo non valido per ${name}`,
    );
  });

  assert.equal(itemsByName.has("Tanqueray 0"), true);
  assert.equal(itemsByName.has("Tanqueray"), true);
  assert.equal(itemsByName.has("SKYY"), true);
});

test("catalogo generale sostituisce i vecchi Premium nella posizione originale", () => {
  const managedIds = new Set(
    DEFAULT_DRINK_PREMIUM_ITEMS.map((item) => item.id),
  );
  const premiumItems = DEFAULT_MENU_ITEMS.filter((item) =>
    managedIds.has(item.id),
  );
  assert.deepEqual(premiumItems, DEFAULT_DRINK_PREMIUM_ITEMS);

  const firstManagedIndex = DEFAULT_MENU_ITEMS.findIndex((item) =>
    managedIds.has(item.id),
  );
  const lastDrinkIndex = DEFAULT_MENU_ITEMS.findLastIndex(
    (item) => item.category === "Drink",
  );
  const firstSignatureIndex = DEFAULT_MENU_ITEMS.findIndex(
    (item) => item.category === "Signature Cocktail",
  );
  assert.equal(firstManagedIndex, lastDrinkIndex + 1);
  assert.equal(firstSignatureIndex, firstManagedIndex + premiumItems.length);

  for (const category of Object.keys(EXPECTED_CATEGORY_COUNTS)) {
    assert.equal(
      DEFAULT_MENU_ITEMS.some((item) => item.category === category),
      true,
      `Categoria mancante: ${category}`,
    );
  }

  assert.equal(
    DEFAULT_MENU_ITEMS.some((item) => item.name === "Capri"),
    false,
  );
  assert.equal(
    DEFAULT_MENU_ITEMS.some((item) => item.name === "Gin Raw"),
    false,
  );
});

test("sincronizzazione categorie Premium resta idempotente", () => {
  const synchronized = replaceMenuCategoryItems(
    DEFAULT_MENU_ITEMS,
    DEFAULT_DRINK_PREMIUM_ITEMS,
    "Drink Premium",
  );

  assert.deepEqual(synchronized, DEFAULT_MENU_ITEMS);
});
