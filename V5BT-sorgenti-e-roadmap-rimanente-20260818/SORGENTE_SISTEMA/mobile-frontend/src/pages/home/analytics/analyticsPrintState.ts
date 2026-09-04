import { canIssueFiscalDocument } from "../../../domain/payments/fiscalAuthorization";
import type { FiscalOutcomeState } from "../../../domain/payments/fiscalOutcome";

export const ANALYTICS_PRINT_HOLD_MS = 2_000;

export type AnalyticsPrintMode = "normal" | "advanced";
export type AnalyticsPrintAction = "none" | "print-normal" | "print-advanced";
export type AnalyticsFiscalActionMode =
  | "hidden"
  | "issue"
  | "void"
  | "voided"
  | "pending"
  | "unavailable";

export function nextAnalyticsPrintModeAfterHold(
  mode: AnalyticsPrintMode
): AnalyticsPrintMode {
  if (mode === "normal") return "advanced";
  return mode;
}

export const analyticsPrintModeLabel = (mode: AnalyticsPrintMode) => {
  if (mode === "advanced") return "STAMPA AVANZATA";
  return "STAMPA";
};

export function analyticsPrintClickAction(
  mode: AnalyticsPrintMode,
  suppressReleaseClick: boolean
): AnalyticsPrintAction {
  if (suppressReleaseClick) return "none";
  if (mode === "advanced") return "print-advanced";
  return "print-normal";
}

export function resolveAnalyticsFiscalAction(params: {
  role: string | null | undefined;
  permissions: readonly string[] | null | undefined;
  fiscalState: FiscalOutcomeState;
  documentReference: string;
}): AnalyticsFiscalActionMode {
  if (!canIssueFiscalDocument(params)) return "hidden";
  if (params.fiscalState === "voided") return "voided";
  if (params.fiscalState === "pending") return "pending";
  if (params.fiscalState === "issued") {
    return params.documentReference.trim() ? "void" : "unavailable";
  }
  return "issue";
}

export const analyticsFiscalActionLabel = (mode: AnalyticsFiscalActionMode) => {
  if (mode === "issue") return "EMETTI FISCALE";
  if (mode === "void") return "ANNULLA DOCUMENTO";
  if (mode === "voided") return "DOCUMENTO ANNULLATO";
  if (mode === "pending") return "OPERAZIONE FISCALE...";
  if (mode === "unavailable") return "RIFERIMENTO MANCANTE";
  return "";
};

export const canRunAnalyticsFiscalAction = (mode: AnalyticsFiscalActionMode) =>
  mode === "issue" || mode === "void";
