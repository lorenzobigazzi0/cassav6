import { describe, expect, it } from "vitest";
import type { MenuProduct } from "../src/api/menu";
import type { OrderCorrectionLineDraft } from "../src/api/orderServiceRecovery";
import type { DiningTableOrder } from "../src/api/tables";
import {
  buildServiceRecoveryProductIndex,
  clampQuantity,
  correctionPayloadForOrder,
  defaultReplacementSelections,
  hasCorrectionDetails,
  lineTotalLabel,
  productForLine,
  replacementAvailableQuantity,
  replacementLineDetails,
  selectedReplacementEntriesForLines,
  variantOptionsForLine,
  withModifier,
} from "../src/pages/home/tables/components/TableServiceRecoveryModel";

const orderLine = (
  overrides: Partial<DiningTableOrder["lines"][number]> = {}
): DiningTableOrder["lines"][number] => ({
  lineId: "line-1",
  productId: "product-1",
  name: "Pizza",
  qty: 3,
  unitFinalPrice: 2.5,
  ...overrides,
});

const orderWithLines = (lines: DiningTableOrder["lines"]): DiningTableOrder => ({
  id: "order-1",
  title: "Comanda",
  createdAt: 1,
  total: 0,
  state: "in_progress",
  paidArticleUnits: [],
  lines,
});

const correctionLine = (
  overrides: Partial<OrderCorrectionLineDraft> = {}
): OrderCorrectionLineDraft => ({
  lineKey: "line-1",
  lineId: "line-1",
  productId: "product-1",
  productName: "Pizza",
  originalQuantity: 1,
  nextQuantity: 1,
  originalNotes: "",
  nextNotes: "",
  originalVariant: "",
  nextVariant: "",
  originalModifiers: {},
  nextModifiers: {},
  unitPrice: 10,
  nextUnitPrice: 10,
  ...overrides,
});

const menuProduct = (overrides: Partial<MenuProduct> = {}): MenuProduct => ({
  id: "product-1",
  sku: "PIZZA",
  departmentId: "food",
  categoryId: "pizza",
  name: "Pizza",
  description: "",
  ingredients: [],
  allergens: [],
  isFrozen: false,
  variants: [{ id: "large", name: "Grande", priceDelta: 2 }],
  available: true,
  price: 10,
  imageUrl: null,
  ...overrides,
});

describe("table service recovery model", () => {
  it("normalizza quantita disponibili e totali senza mutare la riga", () => {
    const line = orderLine({ serviceRecoveryAvailableQuantity: 7 });

    expect(clampQuantity("4.8", 1, 4, 1)).toBe(4);
    expect(clampQuantity("invalid", 1, 4, 2)).toBe(2);
    expect(replacementAvailableQuantity(line)).toBe(3);
    expect(lineTotalLabel(line, 2)).toContain("5,00");
    expect(line.serviceRecoveryAvailableQuantity).toBe(7);
  });

  it("estrae solo dettagli operativi e aggiorna i modificatori in modo immutabile", () => {
    const details = replacementLineDetails(
      orderLine({
        variantName: " Grande ",
        note: " Senza sale ",
        modifiers: {
          label: "Ignora",
          Variante: "Ignora",
          Extra: " Salsa ",
          Secondo: "Salsa",
          Vuoto: " ",
        },
      })
    );
    const modifiers = { Extra: "Salsa" };

    expect(details).toEqual({
      variant: "Grande",
      additions: ["Salsa"],
      note: "Senza sale",
    });
    expect(hasCorrectionDetails(correctionLine({ originalModifiers: { Extra: "Salsa" } }))).toBe(
      true
    );
    expect(hasCorrectionDetails(correctionLine({ originalModifiers: { label: "Pizza" } }))).toBe(
      false
    );
    expect(withModifier(modifiers, "Extra", " ")).toEqual({});
    expect(modifiers).toEqual({ Extra: "Salsa" });
  });

  it("costruisce lookup catalogo e opzioni variante preservando il valore corrente", () => {
    const product = menuProduct();
    const index = buildServiceRecoveryProductIndex([product]);

    expect(productForLine(correctionLine(), index)).toBe(product);
    expect(productForLine(correctionLine({ productId: "", productName: " pizza " }), index)).toBe(
      product
    );
    expect(variantOptionsForLine(correctionLine({ nextVariant: "Famiglia" }), product)).toEqual([
      { value: "Famiglia", label: "Attuale: Famiglia" },
      { value: "", label: "Nessuna variante" },
      { value: "Grande", label: "Grande (+2.00 EUR)" },
    ]);
  });

  it("deriva selezioni e payload senza includere righe indisponibili", () => {
    const available = orderLine({ serviceRecoveryAvailableQuantity: 2 });
    const unavailable = orderLine({
      lineId: "line-2",
      qty: 1,
      serviceRecoveryAvailableQuantity: 0,
    });
    const order = orderWithLines([available, unavailable]);
    const defaults = defaultReplacementSelections(order);
    const drafts = [correctionLine()];

    expect(defaults).toEqual({ "line-1": { selected: false, quantity: 2 } });
    expect(
      selectedReplacementEntriesForLines([available], {
        "line-1": { selected: true, quantity: 99 },
      })
    ).toEqual([
      {
        lineKey: "line-1",
        lineId: "line-1",
        productId: "product-1",
        productName: "Pizza",
        quantity: 3,
      },
    ]);
    expect(correctionPayloadForOrder(drafts, undefined, " Cucina ", " Motivo ")).toEqual({
      lineDrafts: drafts,
      addedItems: [],
      orderNote: "",
      orderComment: " Cucina ",
      reason: " Motivo ",
    });
  });
});
