import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("menu categories scrolling", () => {
  it("disabilita lo scroll orizzontale nella lista categorie", () => {
    const css = readFileSync(resolve(repoRoot, "src/styles/menu.css"), "utf8");

    expect(css).toContain(".menu-browser-content");
    expect(css).toContain("overflow-x: hidden;");
    expect(css).toContain(".menu-level-list");
    expect(css).toContain("max-width: 100%;");
    expect(css).toContain(".menu-level-card");
    expect(css).toContain("overflow: hidden;");
  });
});
