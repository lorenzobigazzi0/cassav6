import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("reservation multi-table assignment", () => {
  it("mantiene assignedTableIds nel contratto mobile e nel payload di salvataggio", () => {
    const api = readSource("src/api/reservations.ts");
    const model = readSource("src/api/reservationModel.ts");
    // La schermata di assegnazione e intolleranze vive nel componente estratto.
    const workspace =
      readSource("src/pages/home/reservations/ReservationsWorkspace.tsx") +
      readSource("src/pages/home/reservations/ReservationEditorScreen.tsx");

    expect(model).toContain("assignedTableIds: string[]");
    expect(model).toContain("export const normalizeAssignedTableIds");
    expect(api).toContain("normalizeAssignedTableIds");
    expect(workspace).toContain("assignedTableIds: form.assignedTableIds");
    expect(workspace).toContain("const selected = new Set(prev.assignedTableIds)");
  });

  it("usa assignedTableIds anche nella finestra operativa dei 30 minuti", () => {
    const windowSource = readSource("src/api/tableReservationWindow.ts");
    // La schermata di assegnazione e intolleranze vive nel componente estratto.
    const workspace =
      readSource("src/pages/home/reservations/ReservationsWorkspace.tsx") +
      readSource("src/pages/home/reservations/ReservationEditorScreen.tsx");

    expect(windowSource).toContain("assignedTableIds.some");
    expect(windowSource).toContain("assignedTableIds: [params.tableId]");
    expect(workspace).toContain("form.assignedTableIds.includes(table.id)");
    expect(workspace).toContain("Tavoli assegnati");
  });

  it("mantiene assegnazione tavolo senza riepilogo, rimuovi o indietro", () => {
    // La schermata di assegnazione e intolleranze vive nel componente estratto.
    const workspace =
      readSource("src/pages/home/reservations/ReservationsWorkspace.tsx") +
      readSource("src/pages/home/reservations/ReservationEditorScreen.tsx");
    const css = readSource("src/styles/reservations.css");
    const assignStart = workspace.indexOf("return isAssignTableScreen ? (");
    const intoleranceStart = workspace.indexOf(") : isIntoleranceScreen ? (", assignStart);
    const assignBlock = workspace.slice(assignStart, intoleranceStart);

    expect(assignStart).toBeGreaterThan(-1);
    expect(intoleranceStart).toBeGreaterThan(assignStart);
    expect(assignBlock).toContain('aria-label="Chiudi assegnazione tavolo"');
    expect(assignBlock).toContain("reservations-icon-btn is-close");
    expect(assignBlock).toContain("reservations-assign-page-actions is-confirm-only");
    expect(assignBlock).not.toContain("reservations-assign-summary");
    expect(assignBlock).not.toContain("Rimuovi");
    expect(assignBlock).not.toContain('{"<"} Indietro');
    expect(workspace).not.toContain(
      "Assegnazione non possibile: tavolo occupato nello stesso orario."
    );
    expect(workspace).toContain('if (availability.status === "conflict")');
    expect(css).not.toContain(".reservations-assign-summary");
  });

  it("permette solo agli admin di cambiare la data prenotazioni senza usare giorni passati", () => {
    // La schermata di assegnazione e intolleranze vive nel componente estratto.
    const workspace =
      readSource("src/pages/home/reservations/ReservationsWorkspace.tsx") +
      readSource("src/pages/home/reservations/ReservationEditorScreen.tsx");

    expect(workspace).toContain('const canChangeServiceDate = role === "admin"');
    expect(workspace).toContain('type="date"');
    expect(workspace).toContain("min={todayServiceDate}");
    expect(workspace).toContain("Non puoi salvare prenotazioni in date passate.");
  });

  it("esclude la sala attesa virtuale dalle sale prenotabili", () => {
    // La schermata di assegnazione e intolleranze vive nel componente estratto.
    const workspace =
      readSource("src/pages/home/reservations/ReservationsWorkspace.tsx") +
      readSource("src/pages/home/reservations/ReservationEditorScreen.tsx");
    const roomUtils = readSource("src/utils/rooms.ts");

    expect(roomUtils).toContain("isVirtualWaitingRoom");
    expect(roomUtils).toContain("reservableRoomOptions");
    expect(roomUtils).toContain("attesa virtuale");
    expect(workspace).toContain("import { reservableRoomOptions }");
    expect(workspace).toContain("reservableRoomOptions(roomsQuery.data ?? [], fallbackRoom)");
    expect(workspace).toContain("roomOptions.some((room) => room.id === selectedRoomId)");
  });

  it("usa icone condivise e modale custom per le intolleranze prenotazione", () => {
    // La schermata di assegnazione e intolleranze vive nel componente estratto.
    const workspace =
      readSource("src/pages/home/reservations/ReservationsWorkspace.tsx") +
      readSource("src/pages/home/reservations/ReservationEditorScreen.tsx");
    const icons = readSource("src/pages/home/reservations/components/ReservationIcons.tsx");
    const modal = readSource(
      "src/pages/home/reservations/components/ReservationCustomIntoleranceModal.tsx"
    );
    const css = readSource("src/styles/reservations.css");

    expect(icons).toContain("/mobile/assets/arrivati.png");
    expect(icons).toContain("/mobile/assets/noshow.png");
    expect(icons).toContain("/mobile/assets/cancel.png");
    expect(workspace).toContain('<ReservationActionIcon action="arrived" />');
    expect(workspace).toContain('<ReservationActionIcon action="no_show" />');
    expect(workspace).toContain('<ReservationActionIcon action="delete" />');
    expect(workspace).toContain("Segnala intolleranze");
    expect(workspace).not.toContain("Assegna intolleranze");
    expect(workspace).toContain("customIntoleranceModalOpen");
    expect(workspace).toContain("reservations-assign-page-actions is-confirm-only");
    expect(workspace).toContain("<AllergenIcon allergen={option} />");
    expect(workspace).toContain("<AllergenIcon allergen={token} />");
    expect(workspace).toContain("<AllergenIcon allergen={intoleranceTokens[0]} />");
    expect(modal).toContain("Allergie e intolleranze personalizzate");
    expect(modal).toContain("X");
    expect(css).toContain(".reservations-intolerance-modal");
    expect(css).toContain(".reservations-allergen-icon");
    expect(icons).toContain("SharedAllergenIcon");
    expect(icons).toContain("reservations-allergen-icon table-detail-allergen-icon");
  });

  it("mostra un badge compatto per allergie e intolleranze nella lista prenotazioni", () => {
    // La schermata di assegnazione e intolleranze vive nel componente estratto.
    const workspace =
      readSource("src/pages/home/reservations/ReservationsWorkspace.tsx") +
      readSource("src/pages/home/reservations/ReservationEditorScreen.tsx");
    const badge = readSource(
      "src/pages/home/reservations/components/ReservationIntoleranceBadge.tsx"
    );
    const tokens = readSource("src/utils/intoleranceTokens.ts");
    const css = readSource("src/styles/reservations.css");

    expect(tokens).toContain("export const parseIntoleranceTokens");
    expect(tokens).toContain("export const composeIntoleranceTokens");
    expect(workspace).toContain("<ReservationIntoleranceBadge value={reservation.intolerances} />");
    expect(workspace).toContain('className="reservations-field is-status"');
    expect(badge).toContain("extraCount = tokens.length - 1");
    expect(badge).toContain("allergen={tokens[0]}");
    expect(badge).toContain("reservations-intolerance-badge-count");
    expect(css).toContain(".reservations-intolerance-badge");
    expect(css).toContain(':root[data-theme="light"] .reservations-intolerance-badge');
    expect(css).toContain(".reservations-status-inline svg");
    expect(css).toContain("flex: 0 0 18px;");
  });

  it("non blocca la visualizzazione della lista mentre carica tavoli e fallback", () => {
    // La schermata di assegnazione e intolleranze vive nel componente estratto.
    const workspace =
      readSource("src/pages/home/reservations/ReservationsWorkspace.tsx") +
      readSource("src/pages/home/reservations/ReservationEditorScreen.tsx");
    const api = readSource("src/api/reservations.ts");
    const listFunction = api.slice(
      api.indexOf("export async function fetchReservationsForDay"),
      api.indexOf("export async function createDiningReservation")
    );

    expect(workspace).toContain("const tableNumberById = useMemo");
    expect(workspace).toContain("const listLoading = reservationsQuery.isLoading;");
    expect(workspace).not.toContain(
      "const listLoading = reservationsQuery.isLoading || tablesQuery.isLoading;"
    );
    expect(workspace).toContain('return tableIds.length === 1 ? "Tavolo assegnato"');
    expect(listFunction).not.toContain("await sleep(");
  });

  it("mantiene data, orario/persone e azioni editor nel layout mobile richiesto", () => {
    // La schermata di assegnazione e intolleranze vive nel componente estratto.
    const workspace =
      readSource("src/pages/home/reservations/ReservationsWorkspace.tsx") +
      readSource("src/pages/home/reservations/ReservationEditorScreen.tsx");
    const icons = readSource("src/pages/home/reservations/components/ReservationIcons.tsx");
    const css = readSource("src/styles/reservations.css");
    const headerOverrides = readSource("public/assets/mobile-reservations-header-overrides.css");

    expect(css).toContain("grid-template-columns: 189px minmax(0, 1fr) 44px;");
    expect(css).toContain("grid-template-columns: 175px minmax(0, 1fr) 42px;");
    expect(headerOverrides).toContain("minmax(108px, 1.15fr)");
    expect(headerOverrides).toContain("minmax(101px, 1.15fr)");
    expect(headerOverrides).toContain("minmax(90px, 1.15fr)");
    expect(workspace).toContain('className="reservations-field is-time"');
    expect(workspace).toContain('className="reservations-field is-covers"');
    expect(workspace).toContain('label htmlFor="reservation-time" className="is-time"');
    expect(workspace).toContain('label htmlFor="reservation-covers" className="is-covers"');
    expect(workspace).toContain('aria-label="Chiudi modifica prenotazione"');
    expect(workspace).toContain("ReservationSaveIcon");
    expect(workspace).toContain('"has-delete"');
    expect(icons).toContain("export function ReservationSaveIcon");
    expect(css).toContain(".reservations-detail.is-editing > .reservations-detail-head");
    expect(css).toContain("margin: -12px -12px 0;");
    expect(css).toContain(
      ':root[data-theme="light"] .reservations-detail.is-editing > .reservations-detail-head'
    );
    expect(css).toContain(".reservations-editor-actions.has-delete");
  });

  it("vincola header e azioni nel dettaglio prenotazione lasciando scrollare solo il corpo", () => {
    // La schermata di assegnazione e intolleranze vive nel componente estratto.
    const workspace =
      readSource("src/pages/home/reservations/ReservationsWorkspace.tsx") +
      readSource("src/pages/home/reservations/ReservationEditorScreen.tsx");
    const css = readSource("src/styles/reservations.css");

    expect(workspace).toContain('isEditing ? "is-editing" : "is-viewing"');
    expect(workspace).toContain('className="reservations-detail-view-body"');
    expect(css).toContain(".reservations-detail.is-viewing");
    expect(css).toContain(".reservations-detail-view-body");
    expect(css).toContain(".reservations-detail-view-body::-webkit-scrollbar");
    expect(css).toContain(".reservations-detail.is-viewing .reservations-detail-head");
    expect(css).toContain(".reservations-detail.is-viewing .reservations-detail-terminal-actions");
    expect(css).toContain("padding: 10px 12px calc(10px + env(safe-area-inset-bottom));");
    expect(css).toContain(
      ':root[data-theme="light"] .reservations-detail.is-viewing .reservations-detail-head'
    );
    expect(css).toContain(
      ':root[data-theme="light"] .reservations-detail.is-viewing .reservations-detail-terminal-actions'
    );
  });
});
