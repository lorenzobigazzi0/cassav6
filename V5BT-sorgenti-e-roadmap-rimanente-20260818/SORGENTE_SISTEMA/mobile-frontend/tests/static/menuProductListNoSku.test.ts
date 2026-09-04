import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("menu product list", () => {
  it("non mostra lo SKU nell'elenco prodotti delle categorie", () => {
    const source = readFileSync(
      resolve(repoRoot, "src/pages/home/menu/components/MenuProductList.tsx"),
      "utf8"
    );

    expect(source).not.toContain("menu-sku");
    expect(source).not.toContain("product.sku");
  });
});
