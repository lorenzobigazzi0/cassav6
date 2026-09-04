import { describe, expect, it } from "vitest";
import type { MenuProduct } from "../src/api/menu";
import {
  buildMenuProductSectionEntries,
  sortMenuProductsBySection,
} from "../src/shared/menu/productSections";

const product = (id: string, name: string, section: string): MenuProduct => ({
  id,
  sku: id,
  departmentId: "dept_bar",
  categoryId: "cat_drink_premium",
  section,
  name,
  description: "",
  ingredients: [],
  allergens: [],
  isFrozen: false,
  variants: [],
  available: true,
  price: 10,
  imageUrl: null,
});

describe("menu product sections", () => {
  it("mantiene l'ordine sezioni del catalogo e ordina i prodotti nella sezione", () => {
    const ginB = product("gin-b", "Gin B", "Gin");
    const ginA = product("gin-a", "Gin A", "Gin");
    const vodka = product("vodka", "Vodka", "Vodka");
    const catalog = [ginB, ginA, vodka];

    expect(sortMenuProductsBySection([vodka, ginB, ginA], catalog).map((item) => item.id)).toEqual([
      "gin-a",
      "gin-b",
      "vodka",
    ]);
  });

  it("inserisce un solo separatore prima di ogni sezione", () => {
    const entries = buildMenuProductSectionEntries(
      [
        product("gin-a", "Gin A", "Gin"),
        product("gin-b", "Gin B", "Gin"),
        product("rum", "Rum", "Rum"),
      ],
      true
    );

    expect(
      entries.map((entry) => (entry.kind === "section" ? entry.name : entry.product.id))
    ).toEqual(["Gin", "gin-a", "gin-b", "Rum", "rum"]);
  });
});
