import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/tables-modern.css"), "utf8");

describe("table detail anagraphic toggle", () => {
  it("mantiene altezza e posizione dell'icona tra stato chiuso e aperto", () => {
    expect(css).toMatch(
      /\.table-detail-anagraphic-toggle\s*\{[\s\S]*?min-height:\s*48px;/
    );
    expect(css).toMatch(
      /\.table-detail-anagraphic-toggle \.table-detail-anagraphic-icon-btn\s*\{[\s\S]*?align-self:\s*center;/
    );
  });
});
