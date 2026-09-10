import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(
  resolve(process.cwd(), "src/pages/home/tables/components/TableDetailPanel.tsx"),
  "utf8",
);
const css = readFileSync(resolve(process.cwd(), "src/styles/tables.css"), "utf8");

describe("table detail order button", () => {
  it("mostra l'azione maiuscola con un'icona semantica a sinistra", () => {
    const start = panel.indexOf("table-detail-bottom-btn-order");
    const end = panel.indexOf("</button>", start);
    const button = panel.slice(start, end);

    expect(button).toContain('className="table-detail-bottom-btn-icon"');
    expect(button.indexOf("table-detail-bottom-btn-icon")).toBeLessThan(button.indexOf("ORDINA"));
    expect(button).toContain('menuCatalogLoading ? "MENU..." : "ORDINA"');
    expect(css).toMatch(
      /\.table-detail-bottom-btn-order\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?text-transform:\s*uppercase;/,
    );
  });
});
