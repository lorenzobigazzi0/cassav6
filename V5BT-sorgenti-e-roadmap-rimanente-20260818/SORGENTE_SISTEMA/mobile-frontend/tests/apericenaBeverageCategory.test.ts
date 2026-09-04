import { describe, expect, it } from "vitest";
import type { MenuProduct } from "../src/api/menu";
import {
  isApericenaBeverageCategory,
  isApericenaBeverageProduct,
} from "../src/pages/home/tables/components/beverageApericenaCategory";

const makeProduct = (categoryId: string): MenuProduct => ({
  id: `prd_${categoryId}`,
  sku: `SKU-${categoryId}`,
  departmentId: "dept_bar",
  categoryId,
  name: "Prodotto",
  description: "",
  ingredients: [],
  allergens: [],
  isFrozen: false,
  variants: [],
  available: true,
  price: 4,
  imageUrl: null,
});

describe("apericena beverage category", () => {
  it("abilita le opzioni apericena bevande solo sulla categoria Bevande", () => {
    expect(isApericenaBeverageCategory("cat_bevande", "Bevande")).toBe(true);
    expect(isApericenaBeverageCategory("bevande", "")).toBe(true);
    expect(isApericenaBeverageCategory("legacy_category", "Bevande")).toBe(true);

    expect(isApericenaBeverageCategory("cat_drink", "Drink")).toBe(false);
    expect(isApericenaBeverageCategory("cat_birre", "Birre")).toBe(false);
    expect(isApericenaBeverageCategory("cat_drink_premium", "Drink Premium")).toBe(false);
    expect(isApericenaBeverageCategory("cat_vino_e_prosecco", "Vino e Prosecco")).toBe(false);
    expect(isApericenaBeverageCategory("cat_caffetteria", "Caffetteria")).toBe(false);
  });

  it("non usa il reparto per abilitare la categoria Bevande", () => {
    expect(isApericenaBeverageProduct(makeProduct("cat_bevande"))).toBe(true);
    expect(isApericenaBeverageProduct({ ...makeProduct("cat_drink"), departmentId: "dept_drinks" })).toBe(false);
  });
});
