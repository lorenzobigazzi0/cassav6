import { describe, expect, it } from "vitest";
import type { MenuProduct } from "../src/api/menu";
import {
  getProductVariants,
  isOrderableProduct,
  productMatchesOrderSearch,
  productRequiresVariantSelection,
} from "../src/pages/home/tables/components/orderComposerProductPolicy";

const product = (overrides: Partial<MenuProduct> = {}): MenuProduct => ({
  id: "product-1",
  sku: "SKU-1",
  departmentId: "department-1",
  categoryId: "category-1",
  name: "Gin riserva",
  description: "Distillato premium",
  ingredients: ["ginepro"],
  allergens: [],
  isFrozen: false,
  variants: [],
  available: true,
  price: 12,
  imageUrl: null,
  ...overrides,
});

describe("order composer product policy", () => {
  it("keeps dividers out and exposes only declared variants", () => {
    expect(isOrderableProduct(product())).toBe(true);
    expect(isOrderableProduct(product({ type: " DIVIDER " }))).toBe(false);
    expect(getProductVariants(product({ variants: undefined as never }))).toEqual([]);
  });

  it("matches product, section, category and department text", () => {
    const item = product({ section: "Digestivi" });

    expect(productMatchesOrderSearch(item, "ginepro")).toBe(true);
    expect(productMatchesOrderSearch(item, "digestivi")).toBe(true);
    expect(productMatchesOrderSearch(item, "cocktail", "Cocktail premium")).toBe(true);
    expect(productMatchesOrderSearch(item, "bar", "", "Bar")).toBe(true);
    expect(productMatchesOrderSearch(item, "pizza")).toBe(false);
  });

  it("requires a variant only when variants and an explicit premium signal coexist", () => {
    const withVariants = product({
      variants: [{ id: "variant-1", name: "Riserva", priceDelta: 3 }],
    });

    expect(productRequiresVariantSelection(withVariants)).toBe(false);
    expect(productRequiresVariantSelection(withVariants, "Drink premium")).toBe(true);
    expect(
      productRequiresVariantSelection({ ...withVariants, requiresVariantSelection: true })
    ).toBe(true);
    expect(productRequiresVariantSelection(product(), "Drink premium")).toBe(false);
  });
});
