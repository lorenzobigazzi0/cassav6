import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspace = readFileSync("src/pages/home/analytics/AnalyticsWorkspace.tsx", "utf8");
const styles = readFileSync("src/styles/tables.css", "utf8");

describe("layout statistiche mobile V6", () => {
  it("mantiene leggibili le card e uniformi le pill", () => {
    expect(styles).toMatch(/height:\s*116px;\s*min-height:\s*116px;\s*max-height:\s*116px/);
    expect(styles).toMatch(/width:\s*132px;[\s\S]*height:\s*28px/);
  });

  it("applica un tema light esplicito al toggle operatori", () => {
    expect(styles).toContain(':root[data-theme="light"] .analytics-operator-scope-toggle');
    expect(styles).toContain("background: #eef4ff");
    expect(styles).toContain("color: #172033");
  });

  it("mostra fondi demo solo quando il backend dichiara il simulatore", () => {
    expect(workspace).toContain("simulatorDeclared");
    expect(workspace).toContain("buildDemoCashFloatTickets()");
    expect(workspace).toContain('className="analytics-list cash-floats-list"');
    expect(workspace).toContain("filter((record) => !record.demo)");
  });
});
