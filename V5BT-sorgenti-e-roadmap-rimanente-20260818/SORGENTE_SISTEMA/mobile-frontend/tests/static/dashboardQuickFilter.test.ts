import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("dashboard quick table filters", () => {
  it("la home notifica un filtro temporaneo prima di aprire la pagina tavoli", () => {
    const homePage = readFileSync(resolve(repoRoot, "src/pages/HomePage.tsx"), "utf8");
    const homeCard = readFileSync(
      resolve(repoRoot, "src/pages/home/components/HomeCard.tsx"),
      "utf8"
    );

    expect(homePage).toContain("new CustomEvent(DASHBOARD_QUICK_FILTER_EVENT");
    expect(homePage).toContain('onTabChange("tavoli", { keepDashboardQuickFilter: true })');
    expect(homePage).toContain("setTablesQuickFilter(null)");
    expect(homePage).not.toContain("DASHBOARD_QUICK_FILTER_KEY");
    expect(homePage).not.toContain("DASHBOARD_QUICK_FILTER_APPLIED_KEY");
    expect(homeCard).not.toContain("DASHBOARD_QUICK_FILTER_KEY");
    expect(homeCard).not.toContain("writeSessionPreference(DASHBOARD_QUICK_FILTER_KEY");
  });

  it("la card sala della dashboard apre la modale cambio sala direttamente nella home", () => {
    const homePage = readFileSync(resolve(repoRoot, "src/pages/HomePage.tsx"), "utf8");
    const homeCard = readFileSync(
      resolve(repoRoot, "src/pages/home/components/HomeCard.tsx"),
      "utf8"
    );
    const css = readFileSync(resolve(repoRoot, "src/styles/tables.css"), "utf8");

    expect(homePage).not.toContain("const openTablesRoomPicker");
    expect(homeCard).toContain("const openRoomModal = useCallback");
    expect(homeCard).not.toContain("onOpenRoomChange");
    expect(homeCard).toContain("className={`mobile-dashboard-room-card");
    expect(homeCard).toContain('aria-label="Cambia sala"');
    expect(homeCard).toContain("tables-room-change-backdrop");
    expect(homeCard).toContain("isVirtualWaitingRoom(room)");
    expect(homeCard).not.toContain("Caricamento sale...");
    expect(homeCard).not.toContain('import { createPortal } from "react-dom"');
    expect(homeCard).not.toContain("document.body");
    expect(homeCard).toContain("tables-room-change-backdrop-home");
    expect(homeCard).toContain("fetchAvailableRooms");
    expect(homeCard).toContain("requestRoomChange");
    expect(homeCard).toContain("setRoom({");
    expect(homeCard).toContain("closeRoomModal();");
    expect(css).toContain(".tables-room-change-backdrop");
    expect(css).toContain(".tables-room-change-option.is-current");
    expect(css).toContain(".tables-room-change-option.is-virtual-waiting-room");
  });

  it("la pagina tavoli applica il filtro richiesto senza vincolare la preferenza globale", () => {
    const tablesWorkspace = readFileSync(
      resolve(repoRoot, "src/pages/home/tables/TablesWorkspace.tsx"),
      "utf8"
    );

    expect(tablesWorkspace).toContain("const applyDashboardQuickFilter = useCallback");
    expect(tablesWorkspace).toContain('setLegendFilterModeState("single")');
    expect(tablesWorkspace).not.toContain("setTableFilterMode(");
    expect(tablesWorkspace).not.toContain("DASHBOARD_QUICK_FILTER_KEY");
    expect(tablesWorkspace).not.toContain("DASHBOARD_QUICK_FILTER_APPLIED_KEY");
    expect(tablesWorkspace).toContain("setActiveLegendFilter(nextFilter)");
    expect(tablesWorkspace).toContain('setSearchQuery("")');
    expect(tablesWorkspace).toContain("setSelectedTableId(null)");
    expect(tablesWorkspace).toContain("applyDashboardQuickFilter(detail?.filter)");
    expect(tablesWorkspace).toContain("applyDashboardQuickFilter(dashboardQuickFilter.filter)");
  });

  it("i quattro widget home usano gli stessi colori semantici della legenda tavoli", () => {
    const glassCss = readFileSync(resolve(repoRoot, "src/styles/glass.css"), "utf8");
    const tablesCss = readFileSync(resolve(repoRoot, "src/styles/tables.css"), "utf8");
    const states = [
      ["free", "free"],
      ["occupied", "occupied"],
      ["ordering", "ordering"],
      ["collect", "payment"],
    ] as const;

    for (const [widgetState, tokenState] of states) {
      expect(glassCss).toContain(`--table-filter-${tokenState}-bg:`);
      expect(glassCss).toContain(`--table-filter-${tokenState}-border:`);
      expect(glassCss).toContain(`--table-filter-${tokenState}-color:`);
      expect(glassCss).toMatch(
        new RegExp(
          `\\.mobile-dashboard-widget\\.is-${widgetState}\\s*\\{[\\s\\S]*?background:\\s*var\\(--table-filter-${tokenState}-bg\\);[\\s\\S]*?border-color:\\s*var\\(--table-filter-${tokenState}-border\\);[\\s\\S]*?color:\\s*var\\(--table-filter-${tokenState}-color\\);`
        )
      );
      expect(tablesCss).toContain(`background: var(--table-filter-${tokenState}-bg);`);
      expect(tablesCss).toContain(`border-color: var(--table-filter-${tokenState}-border);`);
      expect(tablesCss).toContain(`color: var(--table-filter-${tokenState}-color);`);
    }
  });
});
