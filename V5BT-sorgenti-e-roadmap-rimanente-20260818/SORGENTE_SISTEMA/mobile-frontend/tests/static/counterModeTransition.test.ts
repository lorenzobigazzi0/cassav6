import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("counter mode transition", () => {
  it("fades title, active icon and workspace when switching Tavoli/Banco", () => {
    const homePage = readSource("src/pages/HomePage.tsx");
    const css = readSource("src/styles/tables.css");

    expect(homePage).toContain("TABLES_COUNTER_FADE_MS");
    expect(homePage).toContain("tablesCounterTransitioning");
    expect(homePage).toContain("is-tables-counter-transitioning");
    expect(homePage).toContain("window.setTimeout");
    expect(homePage).toContain("window.requestAnimationFrame");
    expect(homePage).toMatch(
      /setTablesCounterTransitioning\(true\);[\s\S]*setTablesWorkspaceMode\(\(current\) =>[\s\S]*setTablesCounterTransitioning\(false\);/
    );

    expect(css).toContain(".home-page .home-shell.home-shell-tavoli .topbar-title");
    expect(css).toContain(
      ".home-page .home-shell.home-shell-tavoli .bottom-btn.is-active .bottom-btn-icon"
    );
    expect(css).toContain(".home-tab-pane-tavoli");
    expect(css).toContain("> .tables-workspace-card");
    expect(css).toMatch(
      /\.home-page[\s\S]*\.home-shell\.home-shell-tavoli\.is-tables-counter-transitioning[\s\S]*\.topbar-title[\s\S]*opacity:\s*0;/
    );
  });
});
