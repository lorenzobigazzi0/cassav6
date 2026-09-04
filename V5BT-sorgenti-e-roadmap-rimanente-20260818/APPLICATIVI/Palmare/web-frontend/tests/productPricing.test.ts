import { describe, expect, it } from "vitest";
import {
  getTimedPricingBadgeLabel,
  normalizeProductPricing,
} from "../src/shared/pricing/productPricing";

describe("normalizeProductPricing", () => {
  it("uses price when only the legacy price is available", () => {
    const pricing = normalizeProductPricing({ price: 8.5 });

    expect(pricing.displayPrice).toBe(8.5);
    expect(pricing.basePrice).toBe(8.5);
    expect(pricing.hasTimedPricing).toBe(false);
    expect(pricing.pricingSource).toBe("price");
  });

  it("prefers activePrice over basePrice", () => {
    const pricing = normalizeProductPricing({ basePrice: 10, activePrice: 7.5 });

    expect(pricing.displayPrice).toBe(7.5);
    expect(pricing.basePrice).toBe(10);
    expect(pricing.hasTimedPricing).toBe(true);
    expect(pricing.isFrontendEstimate).toBe(false);
  });

  it("accepts activePrice as a numeric string", () => {
    const pricing = normalizeProductPricing({ price: 9, activePrice: "6,50" });

    expect(pricing.displayPrice).toBe(6.5);
    expect(pricing.pricingSource).toBe("activePrice");
  });

  it("ignores invalid activePrice and falls back to price", () => {
    const pricing = normalizeProductPricing({ price: 9, activePrice: "non valido" });

    expect(pricing.displayPrice).toBe(9);
    expect(pricing.pricingSource).toBe("price");
  });

  it("does not calculate a final price from schedule without an explicit active price", () => {
    const pricing = normalizeProductPricing({
      price: 9,
      priceSchedule: [{ label: "Happy hour", price: 6, startTime: "18:00", endTime: "20:00" }],
    });

    expect(pricing.displayPrice).toBe(9);
    expect(pricing.hasTimedPricing).toBe(true);
    expect(getTimedPricingBadgeLabel(pricing)).toBe("Listino ora");
  });

  it("keeps a valid nextPriceChangeAt for refresh scheduling", () => {
    const pricing = normalizeProductPricing({
      price: 9,
      nextPriceChangeAt: "2026-05-22T20:00:00.000Z",
    });

    expect(pricing.nextPriceChangeAt).toBe("2026-05-22T20:00:00.000Z");
  });

  it("ignores malformed nextPriceChangeAt values", () => {
    const pricing = normalizeProductPricing({ price: 9, nextPriceChangeAt: "domani sera" });

    expect(pricing.nextPriceChangeAt).toBeUndefined();
  });
});
