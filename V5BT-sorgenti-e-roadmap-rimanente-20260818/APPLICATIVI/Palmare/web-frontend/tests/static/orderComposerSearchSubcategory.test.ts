import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("order composer search", () => {
  it("cerca gli articoli anche per sezione, categoria e reparto quando si digita nella comanda", () => {
    const composer = readFileSync(
      resolve(repoRoot, "src/pages/home/tables/components/TableOrderComposer.tsx"),
      "utf8"
    );
    const productPolicy = readFileSync(
      resolve(
        repoRoot,
        "src/pages/home/tables/components/orderComposerProductPolicy.ts"
      ),
      "utf8"
    );
    const menuApi = readFileSync(resolve(repoRoot, "src/api/menu.ts"), "utf8");
    const menuTypes = readFileSync(resolve(repoRoot, "src/api/menuTypes.ts"), "utf8");

    expect(menuTypes).toContain("section?: string");
    expect(menuApi).toContain('section: String(item.section ?? item.subcategory ?? "").trim()');
    expect(composer).toContain("productMatchesOrderSearch(");
    expect(productPolicy).toContain("export const productMatchesOrderSearch");
    expect(productPolicy).toContain("getMenuProductSection(product)");
    expect(productPolicy).toContain("textPartsMatchProductSearch");
    expect(composer).toContain("hasProductSearchQuery");
    expect(composer).toMatch(
      /normalizeProductSearchText\(search\)\.length <= 1\s*\? search\s*:\s*deferredSearch/
    );
    expect(productPolicy).toContain("categoryName");
    expect(productPolicy).toContain("departmentName");
    expect(composer).toContain("if (hasSearchQuery) return true");
    expect(composer).not.toContain("deferredSearch.trim().toLowerCase()");
    expect(composer).not.toContain("if (query) return true");
    expect(composer).not.toContain("item.name.toLowerCase().includes(query)");
    expect(readFileSync(resolve(repoRoot, "src/utils/productSearch.ts"), "utf8")).toContain(
      '.replace(/ck/g, "k")'
    );
  });
});
