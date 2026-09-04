import { describe, expect, it } from "vitest";
import { expandOrderEmissionUnitAmounts } from "../src/shared/pricing/orderEmissionPricing";

describe("expandOrderEmissionUnitAmounts", () => {
  it("uses unitFinalPrice locked at order emission for article payments", () => {
    const units = expandOrderEmissionUnitAmounts({
      orderId: "ord_1730",
      total: 15,
      lines: [
        { qty: 1, unitFinalPrice: 7 },
        { qty: 1, unitFinalPrice: 8 },
      ],
    });

    expect(units.map((unit) => unit.amount)).toEqual([7, 8]);
    expect(units.reduce((sum, unit) => sum + unit.amount, 0)).toBe(15);
  });

  it("does not reprice an emitted order when the later menu price is different", () => {
    const emittedAt1730Price = 7;
    const currentAt1830Price = 9;
    const units = expandOrderEmissionUnitAmounts({
      orderId: "ord_1730",
      total: emittedAt1730Price,
      lines: [{ qty: 1, unitFinalPrice: emittedAt1730Price }],
    });

    expect(units[0].amount).toBe(emittedAt1730Price);
    expect(units[0].amount).not.toBe(currentAt1830Price);
  });

  it("keeps totals consistent if legacy lines do not expose unit prices", () => {
    const units = expandOrderEmissionUnitAmounts({
      orderId: "ord_legacy",
      total: 10,
      lines: [{ qty: 3 }],
    });

    expect(units.map((unit) => unit.amount)).toEqual([3.34, 3.33, 3.33]);
    expect(Math.round(units.reduce((sum, unit) => sum + unit.amount, 0) * 100) / 100).toBe(10);
  });

  it("can preserve emitted line prices even when the order total has later adjustments", () => {
    const units = expandOrderEmissionUnitAmounts({
      orderId: "ord_adjusted",
      total: 8,
      pricingMode: "preserve-line-prices",
      lines: [
        { qty: 1, unitFinalPrice: 4.5 },
        { qty: 1, unitFinalPrice: 5 },
      ],
    });

    expect(units.map((unit) => unit.amount)).toEqual([4.5, 5]);
  });

  it("keeps balancing to the order total as the default behavior", () => {
    const units = expandOrderEmissionUnitAmounts({
      orderId: "ord_adjusted",
      total: 8,
      lines: [
        { qty: 1, unitFinalPrice: 4.5 },
        { qty: 1, unitFinalPrice: 5 },
      ],
    });

    expect(units.map((unit) => unit.amount)).toEqual([3.79, 4.21]);
    expect(Math.round(units.reduce((sum, unit) => sum + unit.amount, 0) * 100) / 100).toBe(8);
  });
});
