import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readSource = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

describe("order composer best sellers", () => {
  it("reorders the normal grid and no longer renders a separate panel", () => {
    const composer = readSource("src/pages/home/tables/components/TableOrderComposer.tsx");
    const helper = readSource("src/utils/orderBestSellers.ts");
    const settings = readSource("src/pages/SettingsPage.tsx");
    const styles = readSource("src/styles/tables.css");

    expect(composer).toContain("sortProductsByBestSellerRank(normalProducts");
    expect(composer).toContain("const normalProducts = useNormalProductSectionOrder");
    expect(composer).not.toContain("selectProductsByBestSellerRank");
    expect(helper).toContain("ORDER_BEST_SELLER_LIMIT = 7");
    expect(composer).toContain("buildBestSellerRankByProductId(topSoldItems)");
    expect(composer).toContain("limit: ORDER_BEST_SELLER_LIMIT");
    expect(composer).toContain("table-order-product-best-seller-star");
    expect(composer).toContain('bestSellerRank ? " is-best-seller"');
    expect(composer).toContain(
      "bestSellersActive && displayIndex <= ORDER_BEST_SELLER_LIMIT"
    );
    expect(composer).toContain("getOrderBestSellersEnabled()");
    expect(composer.indexOf("name: CUSTOM_PRODUCT_LABEL")).toBeLessThan(
      composer.indexOf("...buildMenuProductSectionEntries(")
    );
    expect(composer).not.toMatch(/\.\.\.\(bestSellersActive\s*\?\s*\[\]/);
    expect(composer).not.toContain("table-order-top-sold-toolbar");
    expect(composer).not.toContain("table-order-top-sold-panel");
    expect(settings).toContain("Mostra best-seller");
    expect(settings).toContain("fino a 7 articoli più usati");
    expect(settings).toContain("setOrderBestSellersEnabled(next)");
    expect(styles).toMatch(
      /\.table-order-filters\.is-compact\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 34px;/
    );
    expect(styles).toMatch(
      /\.table-order-product-best-seller-star\s*\{[\s\S]*?top:\s*7px;[\s\S]*?right:\s*8px;/
    );
    expect(styles).toContain(
      ".table-order-product-row.is-best-seller.has-draft-qty .mobile-order-draft-qty-badge"
    );
    expect(styles).not.toContain(".table-order-top-sold-panel");
  });
});
