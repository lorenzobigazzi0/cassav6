import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("payment action buttons visual contract", () => {
  it("mantiene icone e colori distinti nel menu preconto tavolo", () => {
    const source = readSource("src/pages/home/tables/components/TableDetailPanel.tsx");
    const css = readSource("src/styles/tables.css");

    expect(source).toContain("const PaymentAdjustmentIcon");
    expect(source).toContain("<PaymentAdjustmentIcon />");
    expect(source).toContain("<HistoryPrintIcon />");
    expect(source).toContain("table-preconto-menu-adjustment");
    expect(source).toContain("table-preconto-menu-print-complete");
    expect(source).toContain("table-preconto-menu-print-current");
    expect(css).toContain(".table-preconto-menu-print {");
    expect(css).toContain(".smallbtn.table-preconto-menu-print.table-preconto-menu-print-complete");
    expect(css).toMatch(
      /\.smallbtn\.table-preconto-menu-print\.table-preconto-menu-print-complete,\s*\.smallbtn\.table-preconto-menu-print\.table-preconto-menu-print-current,\s*\.smallbtn\.table-preconto-menu-print\.table-preconto-menu-adjustment\s*\{\s*color: #fff;/
    );
    expect(css).toContain("background: linear-gradient(135deg, #1e40af, #1d4ed8);");
    expect(css).toContain(".smallbtn.table-preconto-menu-print.table-preconto-menu-print-current");
    expect(css).toContain("background: linear-gradient(135deg, #115e59, #0f766e);");
    expect(css).toContain(".smallbtn.table-preconto-menu-print.table-preconto-menu-adjustment");
    expect(css).toContain("background: linear-gradient(135deg, #9a3412, #c2410c);");
    expect(css).toContain(".table-preconto-menu-print svg");
  });

  it("mantiene icone salvataggio e incasso nella rettifica admin", () => {
    const source = readSource("src/pages/home/tables/components/AdminPaymentAdjustmentDialog.tsx");
    const css = readSource("src/styles/tables.css");

    expect(source).toContain("const AdminPaymentSaveIcon");
    expect(source).toContain("const AdminPaymentCollectIcon");
    expect(source).toContain("<AdminPaymentSaveIcon />");
    expect(source).toContain("<AdminPaymentCollectIcon />");
    expect(css).toContain(".admin-payment-apply-only");
    expect(css).toContain("background: linear-gradient(135deg, #4338ca, #2563eb);");
    expect(css).toContain(".admin-payment-apply-collect");
    expect(css).toContain("background: linear-gradient(135deg, #047857, #f59e0b);");
    expect(css).toContain(".admin-payment-action-icon");
  });

  it("salva la rettifica prima di chiudere o aprire la riscossione", () => {
    const dialog = readSource("src/pages/home/tables/components/AdminPaymentAdjustmentDialog.tsx");
    const detailPanel = readSource("src/pages/home/tables/components/TableDetailPanel.tsx");
    const workspace = readSource("src/pages/home/tables/TablesWorkspace.tsx");

    expect(dialog).toContain("await onApply(");
    expect(dialog).toContain("setSubmitError(");
    const persistIndex = detailPanel.indexOf("await onApplyPaymentAdjustment(");
    const closeIndex = detailPanel.indexOf("setAdminPaymentAdjustmentTarget(null);", persistIndex);
    const collectIndex = detailPanel.indexOf(
      "if (options?.collectNow === true) onTogglePaymentWizard(true);",
      persistIndex
    );
    expect(persistIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeGreaterThan(persistIndex);
    expect(collectIndex).toBeGreaterThan(closeIndex);
    expect(workspace).toContain("await persistTablePaymentAdjustment({");
    expect(workspace).toContain("const refreshed = await tablesQuery.refetch();");
    expect(workspace).toContain("setSelectedTableSnapshot(nextTable);");
  });

  it("mantiene icone gomma e salvataggio nella modale motivazione rettifica", () => {
    const source = readSource("src/pages/home/tables/components/AdminPaymentAdjustmentDialog.tsx");
    const css = readSource("src/styles/tables.css");

    expect(source).toContain("const AdminPaymentEraserIcon");
    expect(source).toContain("admin-payment-reason-clear");
    expect(source).toContain("<AdminPaymentEraserIcon />");
    expect(source).toContain("<AdminPaymentSaveIcon />");
    expect(css).toContain(".admin-payment-reason-actions .smallbtn");
    expect(css).toContain(".admin-payment-reason-clear");
  });

  it("mantiene layout compatto del dettaglio pagamento", () => {
    const wizard = readSource("src/pages/home/tables/components/TablePaymentWizard.tsx");
    const detailPanel = readSource("src/pages/home/tables/components/TableDetailPanel.tsx");
    const workspace = readSource("src/pages/home/tables/TablesWorkspace.tsx");
    const css = readSource("src/styles/tables.css");

    expect(workspace).toContain('roomName={roomName || "Operativa"}');
    expect(workspace).toMatch(
      /canCollectPayments=\{canCollectPayments\}\s*\/>\s*<\/div>\s*<TableReservationReleaseDialog/
    );
    expect(detailPanel).toContain("roomName={roomName}");
    expect(wizard).toContain('import backIconSrc from "../../../../assets/icons/indietro.png";');
    expect(wizard).toContain('import { createPortal } from "react-dom";');
    expect(wizard).toContain(
      'document.getElementsByClassName("home-tab-pane home-tab-pane-tavoli").item(0)'
    );
    expect(wizard).toContain("createPortal(paymentContent, paymentLayerRoot)");
    expect(wizard).toContain(
      'className={`table-payment-head ${headerBackAction ? "has-method-back" : ""}`}'
    );
    expect(wizard).toContain('className="table-payment-head-info"');
    // Prima riga il passo, seconda riga tavolo e sala; il nome accessibile
    // le nomina entrambe nello stesso ordine.
    expect(wizard).toContain(
      'aria-label={`${headerStepLabel} - ${tableDisplayLabel} - ${roomName?.trim() || "-"}`}'
    );
    expect(wizard).toContain("<strong>{headerStepLabel}</strong>");
    expect(wizard).toContain('{tableDisplayLabel} - Sala: {roomName?.trim() || "-"}');
    expect(wizard).not.toContain("<h4>Pagamento {tableDisplayLabel}</h4>");
    expect(wizard).not.toContain("table-payment-step-head");
    expect(wizard).not.toContain("table-payment-step-back");
    expect(wizard).toContain("table-payment-method-back");
    expect(wizard).toContain("table-payment-method-back-icon");
    expect(wizard).not.toContain("table-payment-method-back-label");
    expect(wizard).toContain("Torna ai metodi di pagamento, ${selectedPaymentMethodLabel}");
    expect(wizard).toContain("src={backIconSrc}");
    expect(wizard).not.toContain("< Divisione conto");
    expect(wizard).not.toContain("< Selezione articoli");
    expect(wizard).not.toContain('<path d="M15 18l-6-6 6-6" />');
    expect(wizard).toContain("table-payment-summary-row");
    expect(wizard).toContain('renderPaymentNoteButton(false, "table-payment-summary-note")');
    expect(wizard).not.toContain('renderPaymentNoteButton(false, "mobile-payment-inline-note")');
    expect(wizard).not.toContain(
      '<div className="table-payment-note-row">{renderPaymentNoteButton()}</div>'
    );
    expect(wizard).toContain("table-cash-reset");
    expect(wizard).toContain("Azzera contanti ricevuti");
    expect(wizard).toContain('<path d="M4 15.5 12.5 7');
    expect(css).toContain(".table-payment-summary-row");
    expect(css).toContain(".table-payment-summary-note");
    expect(css).toContain(".table-payment-method-back-icon");
    expect(css).toContain(".table-payment-head.has-method-back");
    expect(css).toContain("--tables-workspace-radius: var(--radius);");
    expect(css).toContain("border-radius: var(--tables-workspace-radius, var(--radius));");
    expect(css).toMatch(
      /\.table-payment-panel\s*\{[\s\S]*?width: 100%;[\s\S]*?max-height: 100%;[\s\S]*?overflow: hidden;/
    );
    expect(css).toContain(".table-payment-mode-icon img");
    expect(css).toContain("isolation: isolate;");
    expect(css).toContain(".table-cash-reset svg");
    expect(existsSync(resolve(repoRoot, "src/assets/icons/indietro.png"))).toBe(true);
    for (const icon of ["articolo.png", "contounico.png", "importolibero.png", "romana.png"]) {
      expect(existsSync(resolve(repoRoot, "src/assets/icons/payment-modes", icon))).toBe(true);
    }
  });

  it("mantiene uno slide-to coerente per pagamento, liberazione e fondo cassa", () => {
    const wizard = readSource("src/pages/home/tables/components/TablePaymentWizard.tsx");
    const detailPanel = readSource("src/pages/home/tables/components/TableDetailPanel.tsx");
    const manualCash = readSource("src/pages/payments/ManualCashFloatModal.tsx");
    const css = readSource("src/styles/tables.css");

    expect(wizard).toContain("table-payment-confirm-slide");
    expect(wizard).toContain('aria-label="Scorri per confermare il pagamento"');
    expect(detailPanel).toContain("table-detail-free-slide");
    expect(detailPanel).toContain('aria-label="Scorri per liberare il tavolo"');
    expect(manualCash).toContain("payments-confirm-slide");
    expect(manualCash).toContain('aria-label="Scorri per confermare il fondo cassa"');
    expect(css).toContain(".table-payment-slide::before");
    expect(css).toContain(".table-payment-slide-label::after");
    expect(css).toContain(".table-payment-slide.is-disabled");
    expect(css).toContain(".table-payment-slide:focus-within");
    expect(css).toContain("@keyframes table-payment-slide-direction");
  });

  it("evidenzia i metodi disabilitati e separa il tipo bonifico", () => {
    const wizard = readSource("src/pages/home/tables/components/TablePaymentWizard.tsx");
    const css = readSource("src/styles/tables.css");

    expect(wizard).toContain('type WireTransferType = "instant" | "ordinary";');
    expect(wizard).toContain("transferType: WireTransferType | null");
    expect(wizard).toContain("WIRE_TRANSFER_LABEL");
    expect(wizard).toContain("table-payment-wire-type-row");
    expect(wizard).toContain('required={wireDraft.transferType === "instant"}');
    expect(wizard).toContain(
      'wireDraft.transferType === "ordinary" || Boolean(wireDraft.cro.trim())'
    );
    expect(css).toContain(".table-payment-method-card.is-disabled::after");
    expect(css).toContain("background: rgba(239, 68, 68, 0.96);");
    expect(css).toContain(".table-payment-wire-type.is-selected");
  });
});
