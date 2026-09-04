import { describe, expect, it } from "vitest";
import type { MenuProduct } from "../src/api/menu";
import { dedupeMenuCatalogProducts } from "../src/api/menuDedupe";

const makeProduct = (patch: Partial<MenuProduct>): MenuProduct => ({
  id: "prd_1",
  sku: "prd_1",
  departmentId: "dept_bar",
  categoryId: "cat_drink_premium",
  section: "Gin",
  name: "Hendrick's",
  description: "",
  ingredients: [],
  allergens: [],
  isFrozen: false,
  variants: [],
  available: true,
  price: 12,
  imageUrl: null,
  ...patch,
});

describe("menu catalog dedupe", () => {
  it("mostra un solo prodotto quando due import hanno stesso nome categoria e sottocategoria", () => {
    const result = dedupeMenuCatalogProducts([
      makeProduct({ id: "menu_drink_premium_hendrick_s", sku: "menu_drink_premium_hendrick_s" }),
      makeProduct({ id: "menu_drink_premium_hendricks", sku: "menu_drink_premium_hendricks" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Hendrick's");
  });

  it("non unisce prodotti con stesso nome in categorie diverse", () => {
    const result = dedupeMenuCatalogProducts([
      makeProduct({ id: "gin_bar", sku: "gin_bar", categoryId: "cat_drink_premium" }),
      makeProduct({ id: "gin_signature", sku: "gin_signature", categoryId: "cat_signature" }),
    ]);

    expect(result.map((product) => product.id).sort()).toEqual(["gin_bar", "gin_signature"]);
  });
});
