export type FiscalOutcomeState = "issued" | "voided" | "failed" | "pending" | "missing";

export type FiscalOutcomeSource = {
  type?: string;
  fiscalDocNo?: string;
  fiscalDocType?: string;
  raw?: Record<string, unknown>;
  refundPlan?: {
    allocations?: Array<{
      fiscalDocNo?: string;
    }>;
  };
};

const FISCAL_OK_STATUSES = new Set(["ISSUED", "OK", "SUCCESS", "SETTLED", "COMPLETED"]);
const FISCAL_FAILED_STATUSES = new Set([
  "FAILED",
  "FAILED_CONFIGURATION",
  "KO",
  "ERROR",
  "EXPIRED",
  "SKIPPED",
]);
const FISCAL_PENDING_STATUSES = new Set(["PENDING", "PROCESSING"]);
const FISCAL_VOIDED_STATUSES = new Set(["VOIDED", "ANNULLATO", "CANCELLED"]);

const normalize = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

export function resolveFiscalOutcomeState(source: FiscalOutcomeSource): FiscalOutcomeState {
  const rawStatus = normalize(
    source.raw?.fiscalStatus ||
      source.raw?.fiscalOutcome ||
      source.raw?.fiscalResult ||
      source.raw?.fiscalState
  ).toUpperCase();
  const voidStatus = normalize(source.raw?.voidStatus).toUpperCase();

  if (
    FISCAL_VOIDED_STATUSES.has(rawStatus) ||
    FISCAL_VOIDED_STATUSES.has(voidStatus) ||
    normalize(source.raw?.voidedAt)
  ) {
    return "voided";
  }
  if (FISCAL_OK_STATUSES.has(rawStatus)) return "issued";
  if (FISCAL_PENDING_STATUSES.has(rawStatus)) return "pending";
  if (FISCAL_FAILED_STATUSES.has(rawStatus)) return "failed";

  const hasFiscalReference =
    Boolean(normalize(source.fiscalDocNo) || normalize(source.fiscalDocType)) ||
    Boolean(
      source.refundPlan?.allocations?.some((allocation) =>
        Boolean(normalize(allocation.fiscalDocNo))
      )
    );
  return hasFiscalReference ? "issued" : "missing";
}

export function fiscalOutcomeLabelFor(source: FiscalOutcomeSource) {
  const state = resolveFiscalOutcomeState(source);
  if (state === "voided") return "ANNULLATO";
  if (state === "issued") return "OK";
  if (source.type === "replacement" && state === "missing") return "";
  return "KO";
}
