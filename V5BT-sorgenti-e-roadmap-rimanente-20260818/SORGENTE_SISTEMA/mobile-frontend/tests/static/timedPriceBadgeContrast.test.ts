import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("timed price badge contrast", () => {
  it("uses dedicated high-contrast colors in light mode", () => {
    const menuCss = readSource("src/styles/menu.css");
    const tablesCss = readSource("src/styles/tables.css");

    expect(menuCss).toMatch(
      /:root\[data-theme="light"\] \.menu-timed-price-badge,[\s\S]*?color:\s*rgba\(20,54,116,0\.98\);/
    );
    expect(menuCss).toMatch(
      /:root:not\(\[data-theme\]\) \.menu-timed-price-badge[\s\S]*?background:\s*rgba\(219,234,254,0\.96\);/
    );
    expect(tablesCss).toMatch(
      /:root\[data-theme="light"\] \.table-order-timed-price-badge,[\s\S]*?color:\s*rgba\(20, 54, 116, 0\.98\);/
    );
    expect(tablesCss).toMatch(
      /:root:not\(\[data-theme\]\) \.table-order-timed-price-badge[\s\S]*?background:\s*rgba\(219, 234, 254, 0\.96\);/
    );
  });
});
