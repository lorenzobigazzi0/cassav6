import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("analytics payment detail modal", () => {
  it("resta dentro il viewport e non mostra card annidate nel dettaglio pagamento", () => {
    const css = readFileSync(resolve(repoRoot, "src/styles/tables.css"), "utf8");

    expect(css).toContain("max-height: min(");
    expect(css).toContain("72dvh");
    expect(css).toContain("width: min(390px");
    expect(css).toContain(".mobile-analytics-detail-tx {");
    expect(css).toContain("background: transparent;");
    expect(css).toContain("border: 0;");
    expect(css).toContain(".mobile-analytics-detail-print.is-advanced");
  });

  it("non mostra indicatori di sync che fanno scattare il layout", () => {
    const source = readFileSync(
      resolve(repoRoot, "src/pages/home/analytics/AnalyticsWorkspace.tsx"),
      "utf8"
    );

    expect(source).not.toContain("Sync...");
    expect(source).not.toContain("isSyncing");
  });

  it("mostra solo i campi essenziali e abilita la stampa avanzata con pressione lunga", () => {
    const source = readFileSync(
      resolve(repoRoot, "src/pages/home/analytics/AnalyticsWorkspace.tsx"),
      "utf8"
    );
    const stateSource = readFileSync(
      resolve(repoRoot, "src/pages/home/analytics/analyticsPrintState.ts"),
      "utf8"
    );

    for (const label of [
      "Data",
      "Tavolo",
      "Operatore",
      "Metodo",
      "Rif. comanda",
      "Tipo split",
      "Importo",
      "Provider",
    ]) {
      expect(source).toContain(`label="${label}"`);
    }
    expect(source).not.toContain('label="ID pagamento/movimento"');
    expect(source).not.toContain('label="Rif. articolo"');
    expect(stateSource).toContain("STAMPA AVANZATA");
    expect(stateSource).toContain("EMETTI FISCALE");
    expect(stateSource).toContain('export type AnalyticsPrintMode = "normal" | "advanced"');
    expect(stateSource).not.toContain('"normal" | "advanced" | "fiscal"');
    expect(source).toContain("ANALYTICS_PRINT_HOLD_MS");
    expect(source).toContain("onPointerDown={startPrintHold}");
    expect(source).toContain("onPointerUp={clearPrintHold}");
    expect(source).toContain("onPointerCancel={cancelPrintHold}");
    expect(source).toContain("onPointerLeave={cancelPrintHold}");
    expect(source).toContain("analyticsPrintClickAction");
    expect(source).toContain("handleFiscalIssue");
    expect(source).toContain("mobile-analytics-fiscal-action");
    expect(source).toContain("fiscalAgencyIconSrc");
    expect(source).toContain("mobile-analytics-fiscal-action-icon");
    expect(source).toContain('const printLabel = "STAMPA"');
    expect(source).toContain('if (advanced) setPrintMode("normal")');
    expect(source).toContain('printMode === "advanced"');
    expect(source).toContain("handleFiscalActionClick");
    expect(source).toContain("FiscalVoidConfirmDialog");
  });
});
