import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("analytics workspace containment", () => {
  it("keeps Statistiche on the same full-size workspace surface as Tavoli", () => {
    const homePage = readSource("src/pages/HomePage.tsx");
    const analyticsWorkspace = readSource("src/pages/home/analytics/AnalyticsWorkspace.tsx");
    const css = readSource("src/styles/tables.css");

    expect(homePage).toContain("home-content-${activeTab}");
    expect(analyticsWorkspace).toContain(
      'className="home-card workspace-card analytics-workspace-card mobile-analytics-clean"'
    );
    expect(analyticsWorkspace).toContain('className="card-body analytics-body"');
    expect(css).toMatch(/\.home-content\.home-content-analytics\s*\{[\s\S]*?overflow:\s*visible;/);
    expect(css).toContain("> .analytics-workspace-card.home-card.workspace-card");
    expect(css).toContain("> .analytics-body.card-body");
    expect(css).toMatch(/\.home-view\.view-analytics \.analytics-workspace-card\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?height:\s*100%;/);
    expect(css).toMatch(/\.analytics-workspace-card\s*\{[\s\S]*?max-inline-size:\s*100%;[\s\S]*?overflow:\s*hidden;/);
    expect(css).toMatch(/\.analytics-body\s*\{[\s\S]*?position:\s*relative;[\s\S]*?max-width:\s*100%;/);
    expect(css).toMatch(
      /\.analytics-workspace-card\.mobile-analytics-clean \.analytics-body\s*\{[\s\S]*?padding:\s*8px;/
    );
  });
});
