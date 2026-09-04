import { describe, expect, it } from "vitest";
import {
  expectedOrderRevisionForServiceRecovery,
  lineKeyForOrderService,
} from "../src/api/orderServiceRecovery";
import type { DiningTableOrder, DiningTableOrderLine } from "../src/api/tables";

const line = (patch: Partial<DiningTableOrderLine>): DiningTableOrderLine => ({
  name: "Hendrick's",
  qty: 1,
  productId: "menu_gin_hendricks",
  unitBasePrice: 12,
  unitFinalPrice: 12,
  ...patch,
});

describe("order service recovery line identity", () => {
  it("mantiene il lineId backend come identita primaria della riga", () => {
    expect(lineKeyForOrderService(line({ lineId: "line_001" }), 3)).toBe("line_001");
  });

  it("non collassa righe diverse dello stesso prodotto quando manca il lineId", () => {
    const first = lineKeyForOrderService(line({ lineId: undefined, note: "ghiaccio" }), 0);
    const second = lineKeyForOrderService(line({ lineId: undefined, note: "ghiaccio" }), 1);

    expect(first).not.toBe(second);
    expect(first).toContain("menu_gin_hendricks");
    expect(second).toContain("menu_gin_hendricks");
  });

  it("distingue varianti e note nel fallback grafico", () => {
    const tonic = lineKeyForOrderService(
      line({ lineId: undefined, variantName: "Tonic", note: "limone" }),
      0
    );
    const lemon = lineKeyForOrderService(
      line({ lineId: undefined, variantName: "Lemon", note: "limone" }),
      0
    );

    expect(tonic).not.toBe(lemon);
  });
});

describe("order service recovery revision", () => {
  const order = (currentRevision?: number) =>
    ({
      id: "order_1",
      currentRevision,
      title: "Comanda 1",
      createdAt: 1,
      total: 12,
      state: "in_progress",
      paidArticleUnits: [],
      lines: [],
    }) satisfies DiningTableOrder;

  it("uses the latest revision returned by the backend", () => {
    expect(expectedOrderRevisionForServiceRecovery(order(2))).toBe(2);
    expect(expectedOrderRevisionForServiceRecovery(order(9))).toBe(9);
  });

  it("keeps revision 1 only as a compatibility fallback", () => {
    expect(expectedOrderRevisionForServiceRecovery(order())).toBe(1);
  });
});
