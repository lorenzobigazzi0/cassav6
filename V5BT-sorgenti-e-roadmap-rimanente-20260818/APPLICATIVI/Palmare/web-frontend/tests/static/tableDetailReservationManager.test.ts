import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("table detail reservation manager", () => {
  it("mostra prenota con badge e gestione prenotazioni del giorno", () => {
    const detailPanel = readSource("src/pages/home/tables/components/TableDetailPanel.tsx");
    const anagraphicFields = readSource(
      "src/pages/home/tables/components/TableDetailAnagraphicFields.tsx"
    );
    const allergenIcon = readSource("src/shared/allergens/AllergenIcon.tsx");
    const tableBadge = readSource("src/pages/home/tables/components/TableIntoleranceBadge.tsx");
    const manager = readSource("src/pages/home/tables/components/TableReservationQuickManager.tsx");
    const css = readSource("src/styles/tables.css");

    expect(detailPanel).not.toContain("Dettaglio Tavolo");
    expect(detailPanel).toContain("TableReservationCountBadge");
    expect(detailPanel).toContain("TableReservationsManageButton");
    expect(detailPanel).toContain("const showReservationManager = Boolean");
    expect(detailPanel).toContain("!isFree || setupMode === \"reserve\" || table.reservationPreview");
    expect(anagraphicFields).toContain("table-detail-required-mark");
    expect(anagraphicFields).toContain("TableAllergenIcon");
    expect(anagraphicFields).toContain("table-detail-allergen-icon");
    expect(anagraphicFields).toContain("table-detail-allergen-label");
    expect(anagraphicFields).toContain("table-detail-check-label");
    expect(anagraphicFields).toContain("<TableAllergenIcon allergen={allergen} />");
    expect(tableBadge).toContain("allergen={tokens[0]}");
    expect(tableBadge).toContain("table-intolerance-icon table-detail-allergen-icon");
    expect(allergenIcon).toContain("ALLERGEN_ICON_SRC_BY_LABEL");
    expect(allergenIcon).toContain(
      '"Frutta a guscio": "/mobile/assets/allergen-frutta-a-guscio.png"'
    );
    expect(allergenIcon).toContain('"Semi di sesamo": "/mobile/assets/allergen-sesamo.png"');
    expect(anagraphicFields).not.toContain("(obbligatorio)");
    expect(anagraphicFields).toContain("has-reservation-time");
    expect(anagraphicFields).toContain("Orario arrivo");
    expect(manager).toContain("fetchReservationsForDay");
    expect(manager).toContain("updateDiningReservationStatus");
    expect(manager).toContain("deleteDiningReservation");
    expect(manager).not.toContain("query.refetch()");
    expect(manager).toContain("Gestisci prenotazioni");
    expect(manager).toContain("/mobile/assets/arrivati.png");
    expect(manager).toContain("/mobile/assets/noshow.png");
    expect(manager).toContain("/mobile/assets/cancel.png");
    expect(manager).toContain("table-reservation-action-grid");
    expect(css).toContain(".table-reservation-count-badge");
    expect(css).toContain(".table-reservations-modal-backdrop");
    expect(css).toContain(".table-reservation-action-backdrop");
    expect(css).toMatch(/\.table-reservations-modal,[\s\S]*?color:\s*#f8fafc;/);
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.table-reservations-modal,[\s\S]*?color:\s*#0f172a;/
    );
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.table-reservation-list-row\s*\{[\s\S]*?background:\s*rgba\(248, 250, 252, 0\.92\);[\s\S]*?color:\s*#0f172a;/
    );
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.table-reservation-status-badge\.is-arrived\s*\{[\s\S]*?color:\s*#166534;/
    );
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.table-reservation-action-btn\.is-delete\s*\{[\s\S]*?color:\s*#7f1d1d;/
    );
    expect(css).toContain(".table-detail-form-grid.has-reservation-time");
    expect(css).toContain(".table-detail-allergen-label");
    expect(css).toContain(".table-detail-check-label");
    expect(css).toContain("display: inline-flex");
    expect(css).toContain("flex: 0 0 16px;");
    expect(css).toContain("filter: grayscale(1) saturate(0)");
    expect(css).toContain("justify-content: flex-start");

    expect(existsSync(resolve(repoRoot, "public/assets/arrivati.png"))).toBe(true);
    expect(existsSync(resolve(repoRoot, "public/assets/noshow.png"))).toBe(true);
    expect(existsSync(resolve(repoRoot, "public/assets/cancel.png"))).toBe(true);
    [
      "glutine",
      "crostacei",
      "uova",
      "pesce",
      "arachidi",
      "soia",
      "latte",
      "frutta-a-guscio",
      "sedano",
      "senape",
      "sesamo",
      "solfiti",
      "lupini",
      "molluschi",
    ].forEach((name) => {
      expect(existsSync(resolve(repoRoot, `public/assets/allergen-${name}.png`))).toBe(true);
    });
  });
});
