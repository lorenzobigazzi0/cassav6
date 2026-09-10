import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/tables.css"), "utf8");
const analytics = readFileSync(
  resolve(process.cwd(), "src/pages/home/analytics/AnalyticsWorkspace.tsx"),
  "utf8"
);

describe("table detail stats and analytics filter polish", () => {
  it("usa l'icona come filigrana e lascia tutta la riga al valore", () => {
    expect(css).toMatch(
      /\.table-detail-stat-icon\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*50%;[\s\S]*?left:\s*50%;[\s\S]*?transform:\s*translate\(-50%,\s*-50%\);[\s\S]*?opacity:\s*0\.18;/
    );
    expect(css).toMatch(
      /\.table-detail-stat-value\s*\{[\s\S]*?width:\s*100%;[\s\S]*?text-align:\s*right;/
    );
    expect(css).toMatch(/\.table-detail-stat\s*\{[\s\S]*?min-height:\s*62px;/);
  });

  it("mantiene lo scroll della modale senza mostrarne la barra o l'eyebrow", () => {
    expect(css).toMatch(
      /\.analytics-filter-modal\s*\{[\s\S]*?overflow:\s*auto;[\s\S]*?scrollbar-width:\s*none;/
    );
    expect(css).toContain(".analytics-filter-modal::-webkit-scrollbar");
    expect(analytics).not.toContain("<span>Statistiche</span>");
  });
});
