import { describe, expect, it } from "vitest";
import {
  sanitizeAllergens,
  sanitizeManualIntolerance,
  sanitizePhone,
  sanitizeTableName,
} from "../src/api/tables/inputSanitizers";

describe("table input sanitizers", () => {
  it("normalizes bounded customer fields and preserves the table fallback", () => {
    expect(sanitizeTableName("   ", "Tavolo 4")).toBe("Tavolo 4");
    expect(sanitizeTableName(` ${"A".repeat(20)} `, "fallback")).toBe("A".repeat(16));
    expect(sanitizePhone(` ${"1".repeat(30)} `)).toBe("1".repeat(24));
    expect(sanitizeManualIntolerance(` ${"x".repeat(70)} `)).toBe("x".repeat(64));
  });

  it("deduplicates and caps normalized allergens", () => {
    const allergens = Array.from({ length: 20 }, (_, index) => ` allergene ${index} `);
    expect(sanitizeAllergens([" Latte ", "latte", ...allergens])).toHaveLength(12);
    expect(sanitizeAllergens(undefined)).toEqual([]);
  });
});
