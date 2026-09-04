import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("premium drink variant modal", () => {
  it("mantiene i flag backend e apre la modale obbligatoria prima di aggiungere drink premium", () => {
    const menuApi = readFileSync(resolve(repoRoot, "src/api/menu.ts"), "utf8");
    const menuTypes = readFileSync(resolve(repoRoot, "src/api/menuTypes.ts"), "utf8");
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
    const styles = readFileSync(resolve(repoRoot, "src/styles/tables.css"), "utf8");

    expect(menuTypes).toContain("variantRequired?: boolean");
    expect(menuTypes).toContain("requiresVariantSelection?: boolean");
    expect(menuTypes).toContain("isPremiumAlcohol?: boolean");
    expect(menuApi).toContain("item.variantRequired === true");
    expect(menuApi).toContain("item.requiresVariantSelection === true");

    expect(composer).toContain("productRequiresVariantSelection(");
    expect(productPolicy).toContain("export const productRequiresVariantSelection");
    expect(productPolicy).toContain("category.includes(\"premium\")");
    expect(composer).toContain("openProductQuickAdd(productId)");
    expect(composer).toContain("!quickVariantRequired || Boolean(quickAdd.variantId)");
    expect(composer).toContain("Variante obbligatoria per Drink Premium");
    expect(styles).toContain(".table-order-variant-field.is-required-missing");
  });
});
