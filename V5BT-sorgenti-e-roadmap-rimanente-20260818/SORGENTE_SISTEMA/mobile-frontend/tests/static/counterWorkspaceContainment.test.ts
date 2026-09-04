import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("counter workspace containment", () => {
  it("keeps Banco on the same full-size Tavoli pane surface", () => {
    const homeWorkspace = readSource("src/pages/home/components/HomeWorkspace.tsx");
    const counterWorkspace = readSource("src/pages/home/tables/counter/CounterWorkspace.tsx");
    const css = readSource("src/styles/tables.css");

    expect(homeWorkspace).toContain('className="home-tab-pane home-tab-pane-tavoli"');
    expect(homeWorkspace).toContain('counterMode={tablesWorkspaceMode === "counter"}');
    expect(counterWorkspace).toContain(
      'className="home-card workspace-card tables-workspace-card tables-counter-workspace-card"'
    );
    expect(counterWorkspace).toContain(
      'className="card-body tables-card-body tables-counter-card-body"'
    );
    expect(css).toMatch(/\.tables-counter-card-body\s*\{[\s\S]*?overflow:\s*hidden;/);
    expect(css).toMatch(
      /\.tables-counter-card-body > \.table-order-composer-backdrop\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;/
    );
    expect(css).toMatch(
      /\.tables-counter-card-body > \.table-order-composer-backdrop > \.table-order-composer\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%;[\s\S]*?height:\s*100%;/
    );
  });
});
