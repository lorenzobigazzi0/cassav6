import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("reservation table selection visual shell", () => {
  it("mantiene un riquadro visibile intorno ai tavoli nella scelta prenotazione", () => {
    const css = readSource("src/styles/reservations.css");

    expect(css).toContain(".reservations-table-tile");
    expect(css).toContain("border: 1px solid rgba(20,40,80,0.28);");
    expect(css).toContain("inset 0 0 0 1px rgba(255,255,255,0.42)");
    expect(css).toContain(':root:not([data-theme="light"]) .reservations-table-tile');
    expect(css).toContain("border-color: rgba(210,228,255,0.34);");
  });

  it("applica nella pagina prenotazioni gli stessi segnali operativi dei 30 minuti", () => {
    const source = readSource("src/pages/home/reservations/ReservationsWorkspace.tsx");
    const css = readSource("src/styles/reservations.css");

    expect(source).toContain("shouldReserveTableForReservation");
    expect(source).toContain("shouldWarnTableReleaseForReservation");
    expect(source).toContain("Lascia 10'");
    expect(source).toContain("tablesQueryKey(effectiveRoomId)");
    expect(css).toContain(".reservations-window-rule");
    expect(css).toContain(".reservations-table-window-badge");
    expect(css).toContain(".reservations-table-tile.has-window-warning");
  });

  it("chiude il dettaglio tavolo dopo conferma prenotazione e mantiene badge leggibili", () => {
    const source = readSource("src/pages/home/tables/TablesWorkspace.tsx");
    const tile = readSource("src/pages/home/tables/components/TableTile.tsx");
    const badge = readSource("src/pages/home/tables/components/TableIntoleranceBadge.tsx");
    const css = readSource("src/styles/tables.css");

    expect(source).toMatch(
      /\{\s*clearSelection:\s*true,\s*lockPurpose:\s*TABLE_LAYOUT_SYNC_LOCK_PURPOSE,\s*offlineContinuation:\s*true,?\s*\}/
    );
    expect(tile).toContain("<TableIntoleranceBadge table={table} />");
    expect(badge).toContain("collectIntoleranceTokens(table.allergens, table.manualIntolerance)");
    expect(badge).toContain("extraCount = tokens.length - 1");
    expect(css).toContain(".table-intolerance-badge");
    expect(css).toContain(':root[data-theme="light"] .table-intolerance-badge');
    expect(css).toContain(".table-reservation-preview-badge");
    expect(css).toContain("linear-gradient(135deg, rgba(146, 64, 14, 0.92)");
    expect(css).toContain(".table-reservation-preview-badge.is-warning");
    expect(css).toContain("linear-gradient(135deg, rgba(153, 27, 27, 0.95)");
  });
});
