import { describe, expect, it } from "vitest";
import {
  ANALYTICS_PRINT_HOLD_MS,
  analyticsFiscalActionLabel,
  analyticsPrintClickAction,
  analyticsPrintModeLabel,
  canRunAnalyticsFiscalAction,
  nextAnalyticsPrintModeAfterHold,
  resolveAnalyticsFiscalAction,
} from "../src/pages/home/analytics/analyticsPrintState";

describe("analytics print state machine", () => {
  it("usa una soglia di pressione lunga esatta di due secondi", () => {
    expect(ANALYTICS_PRINT_HOLD_MS).toBe(2_000);
  });

  it("mantiene il clic breve nello stato corrente", () => {
    expect(analyticsPrintClickAction("normal", false)).toBe("print-normal");
    expect(analyticsPrintClickAction("advanced", false)).toBe("print-advanced");
  });

  it("sopprime il click di rilascio generato dopo una pressione lunga", () => {
    expect(analyticsPrintClickAction("normal", true)).toBe("none");
    expect(analyticsPrintClickAction("advanced", true)).toBe("none");
  });

  it("passa in modo persistente da normale ad avanzata", () => {
    const mode = nextAnalyticsPrintModeAfterHold("normal");
    expect(mode).toBe("advanced");
    expect(analyticsPrintModeLabel(mode)).toBe("STAMPA AVANZATA");
    expect(nextAnalyticsPrintModeAfterHold(mode)).toBe("advanced");
  });

  it("non usa mai il pulsante stampa per le azioni fiscali", () => {
    expect(nextAnalyticsPrintModeAfterHold("advanced")).toBe("advanced");
    expect(analyticsPrintClickAction("advanced", false)).toBe("print-advanced");
  });
});

describe("analytics fiscal action state", () => {
  it("mostra Emetti fiscale separatamente solo agli admin con documento assente o KO", () => {
    expect(
      resolveAnalyticsFiscalAction({
        role: "admin",
        permissions: ["fiscal_operations"],
        fiscalState: "failed",
        documentReference: "",
      })
    ).toBe("issue");
    expect(
      resolveAnalyticsFiscalAction({
        role: "admin",
        permissions: ["collect_payments"],
        fiscalState: "missing",
        documentReference: "",
      })
    ).toBe("issue");
    expect(
      resolveAnalyticsFiscalAction({
        role: "operator",
        permissions: ["fiscal_operations"],
        fiscalState: "failed",
        documentReference: "",
      })
    ).toBe("hidden");
    expect(analyticsFiscalActionLabel("issue")).toBe("EMETTI FISCALE");
  });

  it("trasforma il controllo admin in Annulla documento dopo l'emissione", () => {
    expect(
      resolveAnalyticsFiscalAction({
        role: "admin",
        permissions: [],
        fiscalState: "issued",
        documentReference: "Z1005-0123",
      })
    ).toBe("void");
    expect(analyticsFiscalActionLabel("void")).toBe("ANNULLA DOCUMENTO");
    expect(canRunAnalyticsFiscalAction("void")).toBe(true);
  });

  it("rende terminale e non cliccabile un documento gia annullato", () => {
    expect(
      resolveAnalyticsFiscalAction({
        role: "admin",
        permissions: [],
        fiscalState: "voided",
        documentReference: "Z1005-0123",
      })
    ).toBe("voided");
    expect(analyticsFiscalActionLabel("voided")).toBe("DOCUMENTO ANNULLATO");
    expect(canRunAnalyticsFiscalAction("voided")).toBe(false);
  });

  it("non espone un annullamento senza riferimento fiscale", () => {
    expect(
      resolveAnalyticsFiscalAction({
        role: "admin",
        permissions: [],
        fiscalState: "issued",
        documentReference: "",
      })
    ).toBe("unavailable");
    expect(
      resolveAnalyticsFiscalAction({
        role: "admin",
        permissions: [],
        fiscalState: "pending",
        documentReference: "Z1005-0123",
      })
    ).toBe("pending");
  });
});
