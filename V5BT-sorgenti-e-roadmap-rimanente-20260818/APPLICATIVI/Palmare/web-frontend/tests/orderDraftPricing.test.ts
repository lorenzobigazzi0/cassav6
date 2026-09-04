import { describe, expect, it } from "vitest";
import type { MenuProduct } from "../src/api/menu";
import {
  buildOrderDraftSubmit,
  refreshDraftPricingSnapshots,
  type OrderDraftPricingItem,
} from "../src/pages/home/tables/orderDraftPricing";

const makeProduct = (patch: Partial<MenuProduct>): MenuProduct => ({
  id: "prd_1",
  sku: "SKU-1",
  departmentId: "dept",
  categoryId: "cat",
  name: "Spritz",
  description: "Drink",
  ingredients: [],
  allergens: [],
  isFrozen: false,
  variants: [],
  available: true,
  price: 8,
  imageUrl: null,
  ...patch,
});

const config = {
  customProductId: "custom_varie",
  customProductLabel: "Varie",
  menuSupplementLabel: "Menu Apericena",
  getSupplementLabel: (supplement: string) =>
    supplement === "menu_apericena_under4"
      ? "Apericena sotto 4 anni"
      : supplement === "menu_apericena_prenotazione"
        ? "Apericena Prenotazione"
        : "Menu Apericena",
  computeSupplementAmount: (basePrice: number, supplement: string, context: { product: MenuProduct | null }) => {
    if (context.product?.departmentId === "dept_drinks") {
      return supplement === "menu_apericena" && basePrice < 10 ? 10 - basePrice : 0;
    }
    return supplement === "menu_apericena_prenotazione" && basePrice < 12
      ? 14 - basePrice
      : supplement === "menu_apericena" && basePrice < 12
        ? 12 - basePrice
        : supplement === "menu_apericena" && basePrice < 17
          ? 17 - basePrice
          : 0;
  },
  shouldIncludeSupplementNote: (
    _basePrice: number,
    supplement: string,
    context: { product: MenuProduct | null }
  ) => supplement === "menu_apericena_under4" && context.product?.departmentId === "dept_drinks",
};

describe("order draft pricing", () => {
  it("preserves productId and client price snapshot in submit lines", () => {
    const product = makeProduct({
      activePrice: 6.5,
      variants: [{ id: "large", name: "Grande", priceDelta: 1 }],
    });
    const draft: OrderDraftPricingItem[] = [
      {
        productId: product.id,
        variantId: "large",
        note: "poco ghiaccio",
        quantity: 2,
        supplement: "none",
      },
    ];

    const result = buildOrderDraftSubmit(draft, new Map([[product.id, product]]), config);

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      productId: product.id,
      name: "Spritz",
      qty: 2,
      note: "poco ghiaccio",
      variantName: "Grande",
      unitBasePrice: 6.5,
      unitFinalPrice: 7.5,
      priceDelta: 1,
      priceChanged: true,
      priceChangeReason: "variant",
    });
    expect(result.lines[0].clientPriceSnapshot?.displayPrice).toBe(6.5);
    expect(result.total).toBe(15);
  });

  it("leaves custom rows without productId or timed pricing snapshot", () => {
    const draft: OrderDraftPricingItem[] = [
      {
        productId: "custom_varie",
        variantId: "",
        note: "fuori menu",
        quantity: 1,
        supplement: "none",
        customName: "Articolo custom",
        customPrice: 4,
      },
    ];

    const result = buildOrderDraftSubmit(draft, new Map(), config);

    expect(result.lines[0]).toMatchObject({
      productId: undefined,
      name: "Articolo custom",
      qty: 1,
      note: "fuori menu",
      unitBasePrice: 4,
      unitFinalPrice: 4,
      priceChangeReason: "manual",
    });
    expect(result.lines[0].clientPriceSnapshot).toBeUndefined();
  });

  it("calcola i supplementi apericena a 12, prenotazione a 14 solo sullo scaglione base e premium a 17", () => {
    const baseDrink = makeProduct({ id: "spritz", name: "Spritz", price: 8 });
    const premiumDrink = makeProduct({ id: "gin_mare", name: "Gin Mare", price: 12 });
    const draft: OrderDraftPricingItem[] = [
      {
        productId: baseDrink.id,
        variantId: "",
        note: "",
        quantity: 1,
        supplement: "menu_apericena",
      },
      {
        productId: baseDrink.id,
        variantId: "",
        note: "",
        quantity: 1,
        supplement: "menu_apericena_prenotazione",
      },
      {
        productId: premiumDrink.id,
        variantId: "",
        note: "",
        quantity: 1,
        supplement: "menu_apericena",
      },
      {
        productId: premiumDrink.id,
        variantId: "",
        note: "",
        quantity: 1,
        supplement: "menu_apericena_prenotazione",
      },
    ];

    const result = buildOrderDraftSubmit(
      draft,
      new Map([
        [baseDrink.id, baseDrink],
        [premiumDrink.id, premiumDrink],
      ]),
      config
    );

    expect(result.lines.map((line) => line.unitFinalPrice)).toEqual([12, 14, 17, 12]);
    expect(result.lines[0].note).toBe("Menu Apericena +4.00 EUR");
    expect(result.lines[1].note).toBe("Apericena Prenotazione +6.00 EUR");
    expect(result.lines[2].note).toBe("Menu Apericena +5.00 EUR");
    expect(result.lines[3].note).toBeUndefined();
    expect(result.total).toBe(55);
  });

  it("per le bevande porta l'apericena a 10 euro e sotto 4 anni conta senza supplemento", () => {
    const cola = makeProduct({
      id: "cola",
      name: "Cola",
      departmentId: "dept_drinks",
      categoryId: "cat_bibite",
      price: 4,
    });
    const draft: OrderDraftPricingItem[] = [
      {
        productId: cola.id,
        variantId: "",
        note: "",
        quantity: 1,
        supplement: "menu_apericena",
      },
      {
        productId: cola.id,
        variantId: "",
        note: "",
        quantity: 1,
        supplement: "menu_apericena_under4",
      },
    ];

    const result = buildOrderDraftSubmit(draft, new Map([[cola.id, cola]]), config);

    expect(result.lines.map((line) => line.unitFinalPrice)).toEqual([10, 4]);
    expect(result.lines[0].note).toBe("Menu Apericena +6.00 EUR");
    expect(result.lines[1].note).toBe("Apericena sotto 4 anni");
    expect(result.total).toBe(14);
  });

  it("non crasha con prodotti legacy privi di variants durante l'invio comanda", () => {
    const legacyProduct = makeProduct({
      id: "legacy_gin",
      name: "Gin legacy",
      price: 12,
      variants: undefined as unknown as MenuProduct["variants"],
    });
    const draft: OrderDraftPricingItem[] = [
      {
        productId: legacyProduct.id,
        variantId: "tonic",
        note: "",
        quantity: 1,
        supplement: "none",
      },
    ];

    const result = buildOrderDraftSubmit(draft, new Map([[legacyProduct.id, legacyProduct]]), config);

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      productId: legacyProduct.id,
      name: "Gin legacy",
      qty: 1,
      unitBasePrice: 12,
      unitFinalPrice: 12,
    });
    expect(result.total).toBe(12);
  });

  it("refreshes draft preview prices while keeping user edits", () => {
    const oldProduct = makeProduct({ id: "prd_1", price: 8 });
    const newProduct = makeProduct({
      id: "prd_1",
      price: 8,
      activePrice: 6,
      pricingLabel: "Happy hour",
    });
    const draft: OrderDraftPricingItem[] = [
      {
        productId: oldProduct.id,
        variantId: "large",
        note: "senza arancia",
        quantity: 3,
        supplement: "none",
      },
    ];

    const refreshed = refreshDraftPricingSnapshots(
      draft,
      new Map([[newProduct.id, newProduct]]),
      "custom_varie"
    );

    expect(refreshed.changed).toBe(true);
    expect(refreshed.items[0]).toMatchObject({
      productId: "prd_1",
      variantId: "large",
      note: "senza arancia",
      quantity: 3,
      supplement: "none",
    });
    expect(refreshed.items[0].clientPriceSnapshot?.displayPrice).toBe(6);
    expect(refreshed.items[0].clientPriceSnapshot?.activeScheduleLabel).toBe("Happy hour");
  });
});
