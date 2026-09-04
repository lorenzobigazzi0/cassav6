import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("payment commercial benefit input modes", () => {
  it("mantiene la modale buono/sconto senza autofocus e con Manuale, QR, NFC separati", () => {
    const wizard = readSource("src/pages/home/tables/components/TablePaymentWizard.tsx");

    const benefitInput = wizard.slice(
      wizard.indexOf('id="payment_benefit_code"'),
      wizard.indexOf('{benefitInputMode === "qr"')
    );

    expect(wizard).toContain('import { QrCameraScanner } from "../../../payments/QrCameraScanner";');
    expect(wizard).toContain('type BenefitInputMode = "manual" | "qr" | "nfc";');
    expect(wizard).toContain('{ mode: "manual", source: "code", label: "Manuale" }');
    expect(wizard).toContain('{ mode: "qr", source: "qr", label: "QR" }');
    expect(wizard).toContain('{ mode: "nfc", source: "nfc", label: "NFC" }');
    expect(wizard).toContain("const BENEFIT_CODE_GROUP_LENGTH = 4;");
    expect(wizard).toContain("formatBenefitCodeInput");
    expect(wizard).toContain('className="table-payment-benefit-code-grid"');
    expect(wizard).toContain('className="table-payment-benefit-code-slot"');
    expect(benefitInput).not.toContain("autoFocus");
  });

  it("attiva QR e NFC solo dalla rispettiva modalita e mostra l'errore in una modale dedicata", () => {
    const wizard = readSource("src/pages/home/tables/components/TablePaymentWizard.tsx");
    const css = readSource("src/styles/tables.css");

    expect(wizard).toContain('benefitInputMode !== "nfc"');
    expect(wizard).toContain('<QrCameraScanner');
    expect(wizard).toContain('active={benefitModalOpen && !benefitBusy && !benefitFailure}');
    expect(wizard).toContain('onDetected={handleApplyBenefitQr}');
    expect(wizard).toContain('className="table-payment-note-backdrop table-payment-benefit-result-backdrop"');
    expect(wizard).toContain("Riprova");
    expect(wizard).toContain("Annulla");
    expect(css).toContain(".table-payment-benefit-mode-grid");
    expect(css).toContain(".table-payment-benefit-code-grid");
    expect(css).toContain(".table-payment-benefit-code-separator");
    expect(css).toContain(".table-payment-benefit-qr-panel .payments-qr-view");
    expect(css).toContain(".table-payment-benefit-nfc-visual");
    expect(css).toContain("@keyframes benefit-nfc-card-approach");
  });

  it("non sovrascrive il token sessione con il codice sconto nel payload validate", () => {
    const api = readSource("src/api/commercialBenefits.ts");

    expect(api).toContain("const benefitTokenPayload");
    expect(api).toContain("benefitToken: string;");
    expect(api).toContain("input.benefitToken");
    expect(api).toContain('if (source === "nfc") return { nfcToken: token };');
    expect(api).toContain('if (source === "qr") return { qrPayload: token };');
    expect(api).toContain("return { code: token };");
    expect(api).not.toContain("source: input.source,\n      token: input.token,");
  });
});
