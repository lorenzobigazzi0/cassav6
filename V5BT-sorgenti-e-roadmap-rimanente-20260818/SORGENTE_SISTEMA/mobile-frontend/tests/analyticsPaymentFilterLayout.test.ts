import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const analytics = readFileSync(
  resolve(process.cwd(), "src/pages/home/analytics/AnalyticsWorkspace.tsx"),
  "utf8",
);
const model = readFileSync(
  resolve(process.cwd(), "src/api/analyticsPaymentMovementModel.ts"),
  "utf8",
);
const css = readFileSync(resolve(process.cwd(), "src/styles/tables.css"), "utf8");

describe("analytics payment method filters", () => {
  it("mantiene sempre due colonne e non propone il metodo misto", () => {
    expect(css).toMatch(
      /\.analytics-filter-options\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/,
    );
    expect(css).not.toMatch(
      /@media\s*\(max-width:\s*420px\)[\s\S]*?\.analytics-filter-options\s*\{[\s\S]*?grid-template-columns:\s*1fr;/,
    );
    expect(analytics).not.toContain('{ id: "mixed", label: "Misto" }');
    expect(model).not.toContain('| "mixed"');
    expect(css).not.toContain("method-mixed");
  });
});
