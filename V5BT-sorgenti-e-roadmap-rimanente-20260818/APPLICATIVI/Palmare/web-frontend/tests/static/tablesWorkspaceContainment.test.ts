import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("tables workspace containment", () => {
  it("contiene la card tavoli dentro lo shell e il pane dedicati", () => {
    const homePage = readSource("src/pages/HomePage.tsx");
    const css = readSource("src/styles/tables.css");

    expect(homePage).toContain("home-page-tavoli");
    expect(homePage).toContain("home-shell-tavoli");
    expect(homePage).toContain('activeTab === "tavoli"');
    expect(css).toContain(".home-page .home-shell.home-shell-tavoli");
    expect(css).not.toContain(".home-page.home-page-tavoli");
    expect(css).not.toContain("--home-shell-side-expand: 0px;");
    const shellBlock =
      css.match(/\.home-page \.home-shell\.home-shell-tavoli\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(shellBlock).toContain("min-width: 0;");
    expect(shellBlock).toContain("overflow: visible;");
    expect(shellBlock).not.toMatch(/(^|\n)\s*width\s*:/);
    expect(shellBlock).not.toMatch(/(^|\n)\s*max-width\s*:/);
    expect(shellBlock).not.toMatch(/(^|\n)\s*margin-left\s*:/);
    expect(shellBlock).not.toMatch(/(^|\n)\s*margin-right\s*:/);
    const systemRowBlock =
      css.match(
        /\.home-page \.home-shell\.home-shell-tavoli > \.system-row\s*\{([\s\S]*?)\}/
      )?.[1] ?? "";
    expect(systemRowBlock).toContain("overflow: visible;");
    expect(systemRowBlock).not.toMatch(/(^|\n)\s*margin-top\s*:/);
    expect(systemRowBlock).not.toMatch(/(^|\n)\s*padding-top\s*:/);
    expect(css).toMatch(/\.home-content\.home-content-tavoli\s*\{[\s\S]*?overflow:\s*visible;/);
    expect(css).toContain("> .home-tab-pane-tavoli");
    expect(css).toContain("min-inline-size: 0");
    expect(css).toContain("> .tables-workspace-card.home-card.workspace-card");
    expect(css).toContain("max-inline-size: 100%");
    expect(css).toContain("box-sizing: border-box;");
    expect(css).toMatch(/\.tables-workspace-card\s*\{[\s\S]*?overflow:\s*hidden;/);
  });
});
