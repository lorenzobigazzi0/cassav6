import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("table move modal visual parity", () => {
  it("usa la modale a righe v1 per lo spostamento da long press", () => {
    const source = readSource("src/pages/home/tables/components/TableGroupsDialog.tsx");

    expect(source).toContain('{ type: "move"; tableId: string }');
    expect(source).toContain('onChangeState({ type: "move", tableId: state.tableId })');
    expect(source).not.toContain('state.type === "move" && !rootGroup');
    expect(source).toContain('aria-label="Sposta tavolo"');
    expect(source).toContain("mobile-table-groups-dialog mobile-table-move-dialog");
    expect(source).toContain("mobile-table-groups-row");
    expect(source).toContain("Destinazione libera");
    expect(source).toContain("simpleFreeLogicalTableItems");
    expect(source).toContain("selectedMoveIds");
    expect(source).toContain("canSelectMoreMoveTargets");
    expect(source).toContain("onMove(state.tableId, selectedMoveIds)");
  });

  it("non usa piu la vecchia griglia nel dettaglio tavolo", () => {
    const source = readSource("src/pages/home/tables/components/TableDetailPanel.tsx");

    expect(source).toContain("const canMove = Boolean(table && !isFree)");
    expect(source).toContain(
      "mobile-table-groups-backdrop mobile-table-move-backdrop table-move-overlay"
    );
    expect(source).toContain("mobile-table-groups-dialog mobile-table-move-dialog");
    expect(source).toContain("mobile-table-groups-backdrop mobile-table-move-backdrop");
    expect(source).toContain("mobile-table-groups-row");
    expect(source).not.toContain(
      'const canMove = Boolean(table && (isReserved || (isSeated && visualState === "occupied")))'
    );
    expect(source).not.toContain("table-move-grid");
    expect(source).not.toContain("table-move-cell");
  });

  it("estende la modale fino allo stesso limite della card tavoli sopra la bottom bar", () => {
    const css = readSource("public/assets/mobile-table-groups-overrides.css");
    const source = readSource("src/pages/home/tables/components/TableGroupsDialog.tsx");

    expect(source).toContain("mobile-table-groups-dialog mobile-table-move-dialog");
    expect(source).toContain(
      "mobile-table-groups-dialog mobile-table-move-dialog mobile-table-merge-dialog"
    );
    expect(css).toContain(".mobile-table-move-dialog");
    expect(css).toMatch(
      /\.mobile-table-move-dialog\s*\{[^}]*height:\s*100%;[^}]*max-height:\s*100%;/s
    );
    expect(css).toContain(".mobile-table-groups-backdrop.mobile-table-move-backdrop");
    expect(css).toContain("--table-move-top-offset");
    expect(css).toContain("--table-move-bottom-offset");
    expect(css).toContain("inset: var(--table-move-top-offset) 0 var(--table-move-bottom-offset)");
    expect(css).toContain("align-items: flex-start");
    expect(css).toMatch(
      /\.mobile-table-move-dialog \.mobile-table-groups-list\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;/s
    );
    expect(css).toContain(".table-move-overlay.mobile-table-groups-backdrop");
  });

  it("mostra subito lo stato dei candidati nella modale unisci senza aspettare una selezione", () => {
    const source = readSource("src/pages/home/tables/components/TableGroupsDialog.tsx");
    const css = readSource("public/assets/mobile-table-groups-overrides.css");

    expect(source).toContain("getTableGroupActiveLeaves");
    expect(source).toContain("rootActiveCount");
    expect(source).toContain("selectedActiveCount");
    expect(source).toContain("sourceLeafCount");
    expect(source).toContain("hasRootContextActivity");
    expect(source).toContain("hasRootContextReservation");
    expect(source).toContain("const canShowCancelTable =");
    expect(source).toContain("{canShowCancelTable && (");
    expect(source).toContain("itemActiveCount");
    expect(source).toContain("itemRequiresConfirmation");
    expect(source).toContain("rootActiveCount + selectedActiveCount > 1");
    expect(source).toContain("rootActiveCount + itemActiveCount > 1");
    expect(source).toContain('"NON DISPONIBILE"');
    expect(source).toContain('"CONFERMA"');
    expect(source).not.toContain('"DA CONFERMA"');
    expect(source).toContain("is-warning");
    expect(source).toContain("is-incompatible");
    expect(source).toContain("mobile-table-groups-row-title-line");
    expect(css).toContain(".mobile-table-groups-row-title-line");
    expect(css).toContain(".mobile-table-merge-dialog .mobile-table-groups-row-state");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain(".mobile-table-groups-row-note-badge.is-warning");
    expect(css).toContain(".mobile-table-groups-row-note-badge.is-incompatible");
  });

  it("allinea il pulsante chiudi della modale contestuale alle altre modali", () => {
    const source = readSource("src/pages/home/tables/components/TableGroupsDialog.tsx");
    const css = readSource("public/assets/mobile-table-groups-overrides.css");

    const closeIndex = source.indexOf('className="smallbtn mobile-table-groups-context-close"');
    const titleIndex = source.indexOf("mobile-table-groups-context-title");
    const closeMarkup = source.slice(closeIndex, titleIndex);

    expect(source).toContain('<div className="mobile-table-groups-context-head">');
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeLessThan(titleIndex);
    expect(closeMarkup).toContain("table-detail-close-icon");
    expect(closeMarkup).toContain('<path d="M6 6l12 12M18 6l-12 12" />');
    expect(closeMarkup).not.toContain("&times;");
    expect(source).toContain(
      'className="mobile-table-groups-backdrop mobile-table-groups-context-backdrop"'
    );
    expect(css).toContain(".mobile-table-groups-context-close svg");
    expect(css).toContain(".mobile-table-groups-context-head");
    expect(css).toContain("flex: 0 0 34px");
    expect(css).toContain("padding-right: 0");
    expect(css).toContain("border-color: rgba(255, 118, 118, 0.82)");
    expect(css).toContain(':root[data-theme="light"] .mobile-table-groups-context-close');
    expect(css).toContain(".mobile-table-groups-context-backdrop");
    expect(css).toContain("z-index: 5200");
  });

  it("monta il dialog gruppi fuori dal GlassCard per coprire barre e system row", () => {
    const source = readSource("src/pages/home/tables/TablesWorkspace.tsx");

    const closeGlassCardIndex = source.lastIndexOf("</GlassCard>");
    const tableGroupsDialogIndex = source.lastIndexOf("{tableGroupsDialog && (");

    expect(closeGlassCardIndex).toBeGreaterThanOrEqual(0);
    expect(tableGroupsDialogIndex).toBeGreaterThan(closeGlassCardIndex);
  });

  it("mostra disponibilita sale e consente di tornare alla lista dall'header", () => {
    const source = readSource("src/pages/home/tables/components/TableGroupsDialog.tsx");
    const workspace = readSource("src/pages/home/tables/TablesWorkspace.tsx");
    const availability = readSource("src/pages/home/tables/roomMoveAvailability.ts");
    const css = readSource("public/assets/mobile-table-groups-overrides.css");

    expect(source).toContain("formatRoomMoveAvailability");
    expect(availability).toContain('"Piena"');
    expect(source).toContain("mobile-table-groups-room-availability");
    expect(source).toContain('aria-label="Torna alla lista sale"');
    expect(source).toContain('onChangeState({ type: "roomMoveRoom", tableId: state.tableId })');
    expect(workspace).toContain("fetchIntegrationLayout");
    expect(workspace).toContain("buildRoomMoveAvailability");
    expect(css).toContain(".mobile-table-groups-room-head");
    expect(css).toContain(".mobile-table-groups-back svg");
    expect(css).toContain(".mobile-table-groups-room-availability.is-free");
    expect(css).toContain(".mobile-table-groups-room-availability.is-full");
  });

  it("richiede conferma esplicita per unire tavoli gia occupati", () => {
    const dialogSource = readSource("src/pages/home/tables/components/TableGroupsDialog.tsx");
    const workspaceSource = readSource("src/pages/home/tables/TablesWorkspace.tsx");
    const confirmSource = readSource(
      "src/pages/home/tables/components/TableMergeConfirmDialog.tsx"
    );
    const groupsSource = readSource("src/api/tableGroups.ts");

    expect(dialogSource).toContain("requiresActiveMergeConfirmation");
    expect(dialogSource).toContain("requiresActiveConfirmation: requiresActiveMergeConfirmation");
    expect(confirmSource).toContain("Unisci tavoli occupati");
    expect(confirmSource).toContain("Le comande, i conti aperti, i coperti e lo storico");
    expect(confirmSource).toContain("DialogActionIcon");
    expect(confirmSource).toContain('type="cancel"');
    expect(confirmSource).toContain('type="confirm"');
    expect(confirmSource).toContain("tables-move-confirm-btn is-cancel");
    expect(confirmSource).toContain("tables-move-confirm-btn is-confirm");
    expect(confirmSource).toContain("<span>ANNULLA</span>");
    expect(confirmSource).toContain("<span>CONFERMA</span>");
    expect(confirmSource).not.toContain("tables-move-confirm-kicker");
    expect(confirmSource).toContain("tables-move-confirm-route");
    expect(confirmSource).toContain("tables-move-confirm-warning");
    expect(confirmSource).toContain("request.targetLabels.join");
    expect(workspaceSource).toContain("allowMultipleActive: true");
    expect(workspaceSource).toContain("request.toTableIds");
    expect(workspaceSource).toContain('operation: "merge"');
    expect(groupsSource).toContain("allowMultipleActive?: boolean");
    expect(groupsSource).toContain('operation?: "merge" | "split" | "move"');
  });

  it("non reintroduce bridge o manipolazioni DOM per la modale unisci/sposta/dividi", () => {
    const source = readSource("src/pages/home/tables/components/TableGroupsDialog.tsx");
    const viteConfig = readSource("vite.config.ts");
    const distIndex = readSource("dist/index.html");

    expect(source).not.toContain("document.getElementById");
    expect(source).not.toContain("querySelector");
    expect(source).not.toContain("appendChild");
    expect(source).not.toContain("mobile-table-groups-modal");
    expect(viteConfig).not.toContain("mobile-table-groups-bridge.js?v=");
    expect(distIndex).not.toContain("mobile-table-groups-bridge.js");
  });
});
