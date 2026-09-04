import { describe, expect, it } from "vitest";
import {
  HACCP_ALLERGEN_OPTIONS,
  normalizeAllergenLabel,
  normalizeAllergenList,
} from "../src/domain/allergens";

describe("HACCP allergen options", () => {
  it("mantiene la lista ufficiale richiesta", () => {
    expect(HACCP_ALLERGEN_OPTIONS).toEqual([
      "Glutine",
      "Crostacei",
      "Uova",
      "Pesce",
      "Arachidi",
      "Soia",
      "Latte",
      "Frutta a guscio",
      "Sedano",
      "Senape",
      "Semi di sesamo",
      "Solfiti",
      "Lupini",
      "Molluschi",
    ]);
  });

  it("normalizza etichette vecchie senza perdere valori custom", () => {
    expect(normalizeAllergenLabel(" sesamo ")).toBe("Semi di sesamo");
    expect(normalizeAllergenLabel("frutta secca")).toBe("Frutta a guscio");
    expect(normalizeAllergenList([" latte ", "Latte", "sesamo", "Nickel"])).toEqual([
      "Latte",
      "Semi di sesamo",
      "Nickel",
    ]);
  });
});
