import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("table history sync", () => {
  it("riapplica le comande quando il layout cambia e mostra lo storico solo a tavolo occupato", () => {
    const tablesApi = readFileSync(resolve(repoRoot, "src/api/tables.ts"), "utf8");
    const detailPanel = readFileSync(
      resolve(repoRoot, "src/pages/home/tables/components/TableDetailPanel.tsx"),
      "utf8"
    );

    expect(tablesApi).toContain("roomIntegrationFingerprint.delete(requestedRoomId)");
    expect(tablesApi).not.toContain("const effectiveRoomId =");
    expect(detailPanel).toContain("Storico ordini ({historyOrderCount})");
    expect(detailPanel).toContain("{isSeated && (");
  });

  it("richiede al backend solo la sessione corrente per evitare comande fantasma", () => {
    const integrationClient = readFileSync(
      resolve(repoRoot, "src/api/tables/integrationClient.ts"),
      "utf8"
    );

    expect(integrationClient).toContain('includeDone: "1"');
    expect(integrationClient).toContain('includeTransferred: "1"');
    expect(integrationClient).toContain('currentSessionOnly: "1"');
  });

  it("mostra il numero comanda nello storico invece del dettaglio articoli", () => {
    const detailPanel = readFileSync(
      resolve(repoRoot, "src/pages/home/tables/components/TableDetailPanel.tsx"),
      "utf8"
    );

    expect(detailPanel).toContain("const orderHistoryListTitle");
    expect(detailPanel).toContain("`Comanda: ${order.id}`");
    expect(detailPanel).toContain("const orderHistoryPreviewTitle");
    expect(detailPanel).toContain("`Comanda #${order.id}`");
    expect(detailPanel).toContain("{orderHistoryListTitle(order)}");
    expect(detailPanel).toContain("{orderHistoryPreviewTitle(selectedHistoryOrder)}");
    expect(detailPanel).not.toContain(
      '<div className="table-history-order-title">{order.title}</div>'
    );
    expect(detailPanel).not.toContain("{selectedHistoryOrder.title}");
  });

  it("collassa davvero lo storico, inclusi gli ordini inviati o in corso", () => {
    const detailPanel = readFileSync(
      resolve(repoRoot, "src/pages/home/tables/components/TableDetailPanel.tsx"),
      "utf8"
    );

    expect(detailPanel).toContain('historyOpen ? "is-open" : "is-collapsed"');
    expect(detailPanel).toContain("if (historyOpen) return orderedHistory;");
    expect(detailPanel).toContain("return [];");
    expect(detailPanel).not.toContain("showHistoryPeek");
    expect(detailPanel).not.toContain("pendingHistoryItems");
  });

  it("apre lo storico dalla testata e mantiene indipendenti ordinamento e freccia", () => {
    const detailPanel = readFileSync(
      resolve(repoRoot, "src/pages/home/tables/components/TableDetailPanel.tsx"),
      "utf8"
    );
    const tablesCss = readFileSync(resolve(repoRoot, "src/styles/tables.css"), "utf8");
    const historyHeader = detailPanel.slice(
      detailPanel.indexOf("const historyHeader = ("),
      detailPanel.indexOf("useEffect(() =>", detailPanel.indexOf("const historyHeader = ("))
    );

    expect(historyHeader).toMatch(
      /className="table-history-head"\s+onClick=\{\(\) => \{\s+if \(!busy\) toggleHistoryBox\(\);/
    );
    expect(historyHeader.match(/event\.stopPropagation\(\)/g)).toHaveLength(2);
    expect(historyHeader).toContain('<path d="M6 15l6-6 6 6" />');
    expect(historyHeader).toContain('historySort === "asc" ? "is-asc" : ""');
    expect(historyHeader).toContain("table-history-expand-btn");
    expect(historyHeader).toContain('historyOpen ? "is-open" : ""');
    expect(tablesCss).toMatch(/\.table-history-head\s*\{[^}]*cursor:\s*pointer;/s);
    expect(tablesCss).toMatch(
      /\.table-history-icon-btn\s*\{[^}]*transition:[^}]*transform 180ms[^}]*border-color 180ms[^}]*box-shadow 180ms[^;]*;/s
    );
    expect(tablesCss).toMatch(
      /\.table-history-icon-btn:not\(:disabled\):active\s*\{[^}]*scale\(0\.88\);/s
    );
    expect(tablesCss).toMatch(
      /\.table-history-expand-btn\.is-open\s*\{[^}]*scale\(1\.04\);[^}]*box-shadow:/s
    );
    expect(tablesCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("presenta la freccia anagrafica come controllo dello storico senza bordare la riga", () => {
    const detailPanel = readFileSync(
      resolve(repoRoot, "src/pages/home/tables/components/TableDetailPanel.tsx"),
      "utf8"
    );
    const tablesCss = readFileSync(resolve(repoRoot, "src/styles/tables.css"), "utf8");

    expect(detailPanel).toContain(
      'className="smallbtn table-history-toggle-btn table-history-icon-btn table-detail-anagraphic-icon-btn"'
    );
    expect(tablesCss).toMatch(/\.table-detail-anagraphic-toggle\s*\{[^}]*border:\s*0;/s);
    expect(tablesCss).toMatch(
      /\.table-detail-anagraphic-icon-btn\s*\{[^}]*grid-column:\s*3;[^}]*pointer-events:\s*none;/s
    );
  });

  it("riallinea il dettaglio comanda aperto quando lo storico tavolo viene aggiornato", () => {
    const detailPanel = readFileSync(
      resolve(repoRoot, "src/pages/home/tables/components/TableDetailPanel.tsx"),
      "utf8"
    );
    const tablesWorkspace = readFileSync(
      resolve(repoRoot, "src/pages/home/tables/TablesWorkspace.tsx"),
      "utf8"
    );

    expect(detailPanel).toContain("const refreshedOrder =");
    expect(detailPanel).toContain(
      "table.orderHistory.find((order) => order.id === selectedHistoryOrder.id)"
    );
    expect(detailPanel).toContain("setSelectedHistoryOrder(refreshedOrder)");
    expect(tablesWorkspace).toContain("const refreshed = await tablesQuery.refetch()");
    expect(tablesWorkspace).toContain("setSelectedTableSnapshot(nextSelectedTable)");
  });

  it("quando apre modifica/reso da numero comanda preferisce match esatto prima del fallback senza zeri", () => {
    const tablesWorkspace = readFileSync(
      resolve(repoRoot, "src/pages/home/tables/TablesWorkspace.tsx"),
      "utf8"
    );

    expect(tablesWorkspace).toContain("const candidates = sourceTables.flatMap");
    expect(tablesWorkspace).toContain(
      'candidates.find(({ order }) => String(order.id ?? "").trim() === normalizedOrderId)'
    );
    expect(tablesWorkspace).toContain(
      'currentId.replace(/^0+/, "") === normalizedOrderId.replace(/^0+/, "")'
    );
  });
});
