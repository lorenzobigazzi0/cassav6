import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("service recovery modal visual shell", () => {
  it("monta la modale nativa V2 dentro la card Tavoli", () => {
    const css = readSource("public/assets/mobile-order-service-recovery.css");

    expect(css).toContain(".msr-backdrop.table-order-composer-backdrop");
    expect(css).toContain("position: absolute;");
    expect(css).toContain("z-index: 42;");
    expect(css).toContain(".msr-composer-modal.table-order-composer-modal");
    expect(css).toContain("position: relative;");
    expect(css).toContain("transform: none;");
    expect(css).toContain("align-items: center;");
    expect(css).toContain("width: min(720px, calc(100% - 12px));");
    expect(css).toContain("height: min(96%, 820px);");
    expect(css).toContain("max-height: calc(100% - 20px);");
    expect(css).toContain("overscroll-behavior: contain;");
    expect(css).toContain(
      ".msr-composer-modal.table-order-composer-modal .msr-replacement-action-row"
    );
    expect(css).toContain("grid-template-columns: 40px 56px 40px;");
    expect(css).toContain("height: 36px;");
    expect(css).toContain(
      ".msr-composer-modal.table-order-composer-modal .msr-replacement-qty > span"
    );
    expect(css).toContain("display: none;");
  });

  it("nel reso mostra solo le due azioni operative nel footer", () => {
    const source = readSource("src/pages/home/tables/components/TableServiceRecoveryDialog.tsx");

    expect(source).toContain('action === "replacement" ? "msr-foot-replacement"');
    expect(source).toContain("msr-replacement-submit-refund");
    expect(source).toContain("msr-replacement-submit-swap");
    expect(source).toContain('selection.selected ? "is-selected" : ""');
    expect(source).not.toContain('selection.selected ? "is-selected is-open" : ""');
    expect(source).not.toContain("msr-replacement-swipe-row");
    expect(source).toContain("replacementLineDetails");
    expect(source).toContain("openReplacementLineKey");
    expect(source).toContain("startReplacementDetailsLongPress");
    expect(source).toContain("consumeReplacementDetailsLongPress");
    expect(source).toContain("triggerLongPressHaptic");
    expect(source).toContain("msr-replacement-details");
    expect(source).not.toContain('className="msr-line-details"');
    expect(source).toContain('{hasDetails ? " *" : ""}');
    expect(source).toContain('setReplacementReasonValidation("alert")');
    expect(source).toContain('setReplacementReasonValidation("invalid")');
    expect(source).toContain('aria-invalid={replacementReasonValidation !== "idle"}');

    const footerStart = source.indexOf(
      'action === "correction" && correctionMode === "choice" ? null'
    );
    expect(footerStart).toBeGreaterThan(-1);

    const correctionBlockStart = source.indexOf('action === "correction" ? (', footerStart);
    const replacementBlockStart = source.indexOf("msr-replacement-submit-refund");
    expect(correctionBlockStart).toBeGreaterThan(-1);
    expect(replacementBlockStart).toBeGreaterThan(correctionBlockStart);

    const correctionBlock = source.slice(correctionBlockStart, replacementBlockStart);
    const replacementBlock = source.slice(replacementBlockStart);
    expect(correctionBlock).not.toContain("Annulla");
    expect(correctionBlock).not.toContain("msr-secondary");
    expect(replacementBlock).not.toContain(">Chiudi<");
  });

  it("riporta la modifica comanda alla struttura visiva V1 senza bridge DOM", () => {
    const source = readSource("src/pages/home/tables/components/TableServiceRecoveryDialog.tsx");
    const choiceSource = readSource(
      "src/pages/home/tables/components/TableServiceRecoveryChoice.tsx"
    );

    expect(source).toContain("correctionMode");
    expect(source).toContain('correctionMode === "choice"');
    expect(source).toContain("is-choice-mode");
    expect(source).toContain("isRecoveryForm");
    expect(source).toContain("is-recovery-form-backdrop");
    expect(source).toContain("is-correction-form-backdrop");
    expect(source).toContain("is-correction-form");
    expect(source).toContain("is-replacement-form");
    expect(source).toContain("ServiceRecoveryChoicePanel");
    expect(choiceSource).toContain("Che cosa vuoi fare?");
    expect(choiceSource).toContain("Annulla comanda");
    expect(choiceSource).toContain("Modifica comanda");
    expect(choiceSource).toContain("Conferma annullamento");
    expect(choiceSource).toContain("Motivo annullamento");
    expect(choiceSource).toContain("ServiceRecoveryAlertDialog");
    expect(choiceSource).toContain('role="alertdialog"');
    expect(source).toContain("<ServiceRecoveryAlertDialog");
    expect(source).not.toContain('{error ? <div className="msr-error">{error}</div> : null}');
    expect(choiceSource).toContain("ANNULLA");
    expect(choiceSource).toContain("CONFERMA");
    expect(choiceSource).not.toContain('"Conferma annulla"');
    expect(choiceSource).toContain("msr-cancel-confirm-modal");
    expect(choiceSource).toContain("onClick={onBack}");
    expect(choiceSource.match(/onClick=\{\(event\) => event\.stopPropagation\(\)\}/g)).toHaveLength(
      2
    );
    expect(source).toContain("orderNumberLabel");
    expect(source).toContain("msr-replacement-context");
    expect(source).toContain("<b>Comanda</b>");
    expect(source).toContain("<b>Tavolo</b>");
    expect(source).toContain("<b>Sala</b>");
    expect(source).not.toContain("<strong>Seleziona righe</strong>");
    expect(source).not.toContain('onClick={() => setCorrectionMode("choice")}');
    expect(source).toContain(
      "`Comanda ${orderNumberLabel} - Tavolo ${tableLabel} - Sala ${roomLabel}`"
    );
    expect(source).toContain("setCancelReasonError(null)");
    expect(source).toContain("openCorrectionLineKey");
    expect(source).toContain("setOpenCorrectionLineKey");
    expect(source).not.toContain("msr-correction-swipe-row");
    expect(source).toContain("hasCorrectionDetails");
    expect(source).toContain('{hasDetails ? " *" : ""}');
    expect(source).toContain("Espandi dettaglio articolo");
    expect(source).toContain("Riduci dettaglio articolo");
    expect(source).not.toContain("msr-line-detail-chip");
    expect(source).toContain("GlassDropdown");
    expect(source).toContain("serviceRecoverySupplementOptions");
    expect(source).toContain("updateLineSupplement");
    expect(source).toContain("Nessun supplemento");
    expect(source).toContain("Supplemento");
    expect(source).not.toContain("Note ordine e comunicazioni");
    expect(source).not.toContain("notesOpen");
    expect(source).toContain("msr-correction-form");
    expect(source).toContain("msr-correction-reason-inline");
    expect(source).toContain("msr-reason-dock");
    expect(source).toContain("maxQty > 1");
    expect(source).toContain('className="smallbtn table-detail-close msr-close"');
    expect(source).not.toContain("msr-correction-edit-card");
    expect(source).not.toContain("msr-correction-reason-field");
    expect(source).not.toContain("msr-correction-section-items");
    expect(source).not.toContain("Comanda attuale");
    expect(source).not.toContain("<span>MODIFICA</span>");
    expect(source).not.toContain("<em>{lineDrafts.length} righe</em>");
    expect(source).toContain("msr-foot-correction");
    expect(source).toContain("table-order-submit-icon");
    expect(source).toContain("msr-submit-spinner");
    expect(source).toContain("aria-busy={localBusy}");
    expect(source).toContain("Invio...");
    expect(source).not.toContain("Aggiungi riga");
    expect(source).not.toContain("msr-empty-add");
    expect(source).not.toContain("nextVariant: event.target.value");
    expect(source).not.toContain("document.querySelector");
    expect(source).not.toContain("appendChild");

    const css = readSource("public/assets/mobile-order-service-recovery.css");
    expect(css).toContain(".msr-foot.msr-foot-correction");
    expect(css).toContain(".msr-composer-modal.table-order-composer-modal.is-choice-mode");
    expect(css).toContain(".msr-backdrop.table-order-composer-backdrop.is-recovery-form-backdrop");
    expect(css).toContain(
      ".msr-backdrop.table-order-composer-backdrop.is-correction-form-backdrop"
    );
    expect(css).toContain(".msr-composer-modal.table-order-composer-modal.is-correction-form");
    expect(css).toContain(".msr-composer-modal.table-order-composer-modal.is-replacement-form");
    expect(css).toContain("height: min(86%, 620px)");
    expect(css).toContain("max-height: calc(100% - 24px)");
    expect(css).toContain("position: static;");
    expect(css).toContain("max-height: 118px;");
    expect(css).toContain("max-height: min(76%, 440px)");
    expect(css).toContain("min-height: 94px;");
    expect(css).toContain("max-height: 94px;");
    expect(css).toContain(".msr-reason-modal::-webkit-scrollbar");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(css).toContain(".msr-line-edit-grid");
    expect(css).toContain(".msr-correction-form");
    expect(css).toContain(".msr-correction-reason-inline");
    expect(css).toContain(".msr-reason-dock");
    expect(css).toContain(
      ".msr-composer-modal.table-order-composer-modal.is-correction-form .msr-body"
    );
    expect(css).not.toContain(".msr-correction-edit-card");
    expect(css).toContain("z-index: 210;");
    expect(css).toContain(".msr-order-notes-card .table-order-item-info");
    expect(css).toContain("background: transparent;");
    expect(css).toContain(".msr-composer-modal.table-order-composer-modal .msr-close path");
    expect(css).toContain("stroke: #c9142f;");
    expect(css).toContain(".msr-cancel-confirm-modal footer .smallbtn");
    expect(css).toContain("flex: 1 1 0;");
    expect(css).toContain(".msr-replacement-row.table-order-item.is-details-open");
    expect(css).toContain(".msr-replacement-details");
    expect(css).toContain("position: absolute;");
    expect(css).toContain("right: 10px;");
    expect(css).toContain("bottom: 10px;");
    expect(css).toContain(".msr-textarea.is-invalid");
    expect(css).toContain("border-color: #cf1937;");
    expect(css).not.toContain("border-color: #cf1937 !important;");

    const nightCss = readSource("public/assets/mobile-night-modal-overrides.css");
    expect(nightCss).toContain(".msr-reason-dock");
    expect(nightCss).toContain(".msr-close.table-detail-close");
    expect(nightCss).toContain(".msr-composer-modal.table-order-composer-modal .msr-close path");
    expect(nightCss).toContain("stroke: #ff5b6e;");
    expect(nightCss).toContain(".msr-correction-row .table-order-item-total");
    expect(nightCss).toContain("color: rgba(255, 255, 255, 0.96);");
    expect(nightCss).toContain(".msr-textarea.is-invalid");
    expect(nightCss).toContain("border-color: #ff6f7f !important;");
  });
});
