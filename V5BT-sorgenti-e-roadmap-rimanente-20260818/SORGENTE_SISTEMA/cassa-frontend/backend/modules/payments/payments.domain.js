export const PAYMENT_REALTIME_PENDING_FISCAL_STATUS = "PENDING_FISCAL";
export const PAYMENT_REALTIME_COMPLETED_STATUS = "COMPLETED";
export const PAYMENT_REALTIME_OPEN_STATUS = "OPEN";

import { resolvePaymentRuntimeState } from "./payment-state-machine.js";

function normalizeFiscalStatus(value) {
  return String(value ?? "").trim().toUpperCase();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

export function isFiscalReceiptIssued(receipt) {
  if (!receipt || typeof receipt !== "object") return false;
  const status = normalizeFiscalStatus(receipt.fiscalStatus ?? receipt.status);
  return status === "ISSUED" && receipt.requiresFiscalRetry !== true;
}

export function isFiscalReceiptBoundaryOpen(receipt) {
  if (!receipt || typeof receipt !== "object") return false;
  if (isFiscalReceiptIssued(receipt)) return false;
  const status = normalizeFiscalStatus(receipt.fiscalStatus ?? receipt.status);
  if (["PENDING", "PROCESSING"].includes(status)) return true;
  return receipt.requiresFiscalRetry === true;
}

export function isFiscalResultBoundaryOpen(result) {
  if (!result || typeof result !== "object") return false;
  if (result.pending === true || result.requiresRetry === true) return true;
  return isFiscalReceiptBoundaryOpen(result.receipt);
}

export function hasOpenFiscalBoundary(results) {
  return asArray(results).some((result) => isFiscalResultBoundaryOpen(result));
}

export function hasRetryableFiscalBoundary(results) {
  return asArray(results).some((result) => {
    if (!result || typeof result !== "object") return false;
    if (result.requiresRetry === true) return true;
    return result.receipt?.requiresFiscalRetry === true;
  });
}

export function buildPaymentRealtimeBoundary({
  completed = true,
  fiscalResults = [],
  paymentStateMachineEnabled = true,
} = {}) {
  const fiscalPending = hasOpenFiscalBoundary(fiscalResults);
  const fiscalRecoveryRequired = hasRetryableFiscalBoundary(fiscalResults);
  const runtimeState = paymentStateMachineEnabled
    ? resolvePaymentRuntimeState({
        settled: true,
        fiscalResults,
        reason: "payment_realtime_boundary",
      })
    : { paymentState: null, path: [] };
  const paymentStatus = fiscalPending
    ? PAYMENT_REALTIME_PENDING_FISCAL_STATUS
    : completed
      ? PAYMENT_REALTIME_COMPLETED_STATUS
      : PAYMENT_REALTIME_OPEN_STATUS;
  return {
    reason: completed && !fiscalPending ? "payment_completed" : "payment_status_changed",
    paymentStatus,
    paymentState: runtimeState.paymentState,
    paymentStatePath: runtimeState.path,
    fiscalPending,
    fiscalRecoveryRequired,
  };
}
