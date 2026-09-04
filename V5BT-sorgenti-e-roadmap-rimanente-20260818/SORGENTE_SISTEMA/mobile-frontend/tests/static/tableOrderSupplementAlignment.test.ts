import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("table order supplement alignment", () => {
  it("mostra il supplemento apericena su riga piena con dropdown leggibile", () => {
    // Il blocco espanso della riga carrello vive in CartItemDetails dopo la
    // decomposizione del compositore, mentre l'aggiunta rapida resta nel
    // compositore: il presidio vale sull'insieme dei due.
    const source = [
      "src/pages/home/tables/components/TableOrderComposer.tsx",
      "src/pages/home/tables/components/CartItemDetails.tsx",
    ]
      .map((file) => readFileSync(resolve(repoRoot, file), "utf8"))
      .join("\n");
    const supplementPricing = readFileSync(
      resolve(repoRoot, "src/pages/home/tables/components/menuSupplementPricing.ts"),
      "utf8"
    );
    const styles = readFileSync(resolve(repoRoot, "src/styles/tables.css"), "utf8");

    expect(source.match(/className="table-order-supplement-field"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source.match(/className="table-order-supplement-dropdown"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(supplementPricing).toContain("const APERICENA_STANDARD_TARGET_PRICE = 12");
    expect(supplementPricing).toContain("const APERICENA_RESERVATION_TARGET_PRICE = 14");
    expect(supplementPricing).toContain("const APERICENA_PREMIUM_TARGET_PRICE = 17");
    expect(supplementPricing).toContain("const APERICENA_BEVERAGE_TARGET_PRICE = 10");
    expect(supplementPricing).toContain('const MENU_UNDER4_SUPPLEMENT_LABEL = "Apericena sotto 4 anni"');
    expect(supplementPricing).toContain("basePrice < APERICENA_STANDARD_TARGET_PRICE");
    expect(supplementPricing).toContain('const MENU_RESERVATION_SUPPLEMENT_LABEL = "Prenotazione"');
    expect(supplementPricing).toContain('"menu_apericena_prenotazione"');
    expect(supplementPricing).toContain('"menu_apericena_under4"');
    expect(source).toContain("isApericenaBeverageProduct");
    expect(styles).toContain(".table-order-item-row .table-order-supplement-field");
    expect(styles).toContain("grid-column: 1 / -1");
    expect(styles).toContain(".table-order-supplement-dropdown .table-glass-dropdown-label");
    expect(styles).toContain("white-space: normal");
  });
});
