import { describe, expect, it } from "vitest";
import type { MenuCatalog } from "../src/api/menu";
import type { DiningTableOrderLine } from "../src/api/tables";
import { attachCounterVatRates, findMissingCounterVatLine } from "../src/pages/home/tables/counter/counterVat";
import {
  COUNTER_TABLE_ID,
  COUNTER_TABLE_LABEL,
  createCounterOrderFromSubmit,
  createCounterVirtualTable,
} from "../src/pages/home/tables/counter/counterVirtualTable";
import type { TableOrderSubmitPayload } from "../src/pages/home/tables/orderDraftPricing";

const product = (id: string, vatRate?: number): MenuCatalog["products"][number] => ({
  id,
  sku: id,
  departmentId: "dept",
  categoryId: "cat",
  name: id,
  description: "",
  ingredients: [],
  allergens: [],
  isFrozen: false,
  variants: [],
  available: true,
  price: 1,
  vatRate,
  imageUrl: null,
});

describe("counter mode helpers", () => {
  it("builds a virtual Banco table without real table occupancy", () => {
    const payload: TableOrderSubmitPayload = {
      title: "1x Caffe",
      total: 1.3,
      lines: [{ productId: "caffe", name: "Caffe", qty: 1, unitFinalPrice: 1.3 }],
    };
    const order = createCounterOrderFromSubmit(payload, 1_000);
    const table = createCounterVirtualTable(order);

    expect(table.id).toBe(COUNTER_TABLE_ID);
    expect(table.tableLabel).toBe(COUNTER_TABLE_LABEL);
    expect(table.number).toBe(0);
    expect(table.ordersTaken).toBe(1);
    expect(table.orderHistory[0]?.paymentStatus).toBe("unpaid");
    expect(table.orderHistory[0]?.lines[0]?.lineId).toContain(order.id);
  });

  it("attaches product VAT and reports missing VAT before Banco collection", () => {
    const lines: DiningTableOrderLine[] = [
      { lineId: "l1", productId: "caffe", name: "Caffe", qty: 1, unitFinalPrice: 1.3 },
      { lineId: "l2", productId: "custom", name: "Varie", qty: 1, unitFinalPrice: 2 },
    ];
    const products = new Map([["caffe", product("caffe", 10)]]);
    const withVat = attachCounterVatRates(lines, products);

    expect(withVat[0]?.vatRate).toBe(10);
    expect(findMissingCounterVatLine(withVat)?.lineId).toBe("l2");
    expect(findMissingCounterVatLine([{ ...lines[1], vatRate: 22 }])).toBeNull();
  });
});
