export const PAYMENT_PROVIDER_TRANSACTION_STATES = new Set([
  "created",
  "cash_accepting",
  "cash_collected",
  "settlement_pending",
  "settlement_failed",
  "manual_reconciliation_required",
  "settled",
  "cancelled",
  "failed",
]);

export const PAYMENT_PROVIDER_TERMINAL_STATES = new Set(["settled", "cancelled", "failed"]);

export const ALLOWED_PAYMENT_PROVIDER_TRANSITIONS = Object.freeze({
  created: new Set([
    "cash_accepting",
    "cash_collected",
    "settlement_pending",
    "settled",
    "cancelled",
    "failed",
  ]),
  cash_accepting: new Set(["cash_collected", "cancelled", "failed"]),
  cash_collected: new Set(["settlement_pending", "manual_reconciliation_required", "settled"]),
  settlement_pending: new Set(["settled", "settlement_failed", "manual_reconciliation_required", "failed"]),
  settlement_failed: new Set(["settlement_pending", "manual_reconciliation_required", "failed"]),
  manual_reconciliation_required: new Set(["settlement_pending", "settled", "cancelled", "failed"]),
  settled: new Set([]),
  cancelled: new Set([]),
  failed: new Set([]),
});

function normalizePaymentProviderStatusKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizePaymentProviderTransactionStatus(value, fallback = "created") {
  const normalized = normalizePaymentProviderStatusKey(value);
  if (PAYMENT_PROVIDER_TRANSACTION_STATES.has(normalized)) return normalized;
  const fallbackStatus = normalizePaymentProviderStatusKey(fallback);
  return PAYMENT_PROVIDER_TRANSACTION_STATES.has(fallbackStatus) ? fallbackStatus : "created";
}

export function canTransitionPaymentProviderStatus(fromStatus, toStatus, options = {}) {
  const from = normalizePaymentProviderTransactionStatus(fromStatus);
  const to = normalizePaymentProviderStatusKey(toStatus);
  if (!PAYMENT_PROVIDER_TRANSACTION_STATES.has(to)) return false;
  if (from === to) return true;
  if (options.allowOverride === true) return Boolean(String(options.overrideReason ?? "").trim());
  return ALLOWED_PAYMENT_PROVIDER_TRANSITIONS[from]?.has(to) === true;
}

export function assertPaymentProviderTransitionAllowed(fromStatus, toStatus, options = {}) {
  if (canTransitionPaymentProviderStatus(fromStatus, toStatus, options)) {
    return true;
  }
  const from = normalizePaymentProviderTransactionStatus(fromStatus);
  const toCandidate = normalizePaymentProviderStatusKey(toStatus);
  const to = PAYMENT_PROVIDER_TRANSACTION_STATES.has(toCandidate)
    ? toCandidate
    : String(toStatus ?? "").trim() || "(vuoto)";
  throw new Error(`Transizione pagamento provider non ammessa: ${from} -> ${to}`);
}
