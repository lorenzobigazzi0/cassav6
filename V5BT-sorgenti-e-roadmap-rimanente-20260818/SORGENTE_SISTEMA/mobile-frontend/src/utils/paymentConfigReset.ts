import {
  clearPaymentRuntimeStorage,
  readPaymentRuntimeStorage,
  writePaymentRuntimeStorage,
} from "../shared/storage/paymentSessionStorage";

const RESET_VERSION = "20260517-monitor-operational-cash-reset-1";
const RESET_MARKER_KEY = "mobile:payment-config-reset-version";
const TARGET_KEYS = [
  "payment_pos_id",
  "payment_cash_mode",
  "payment_cash_float",
  "payment_cash_float_locked",
  "payment_auto_cash_float_id",
  "payment_auto_cash_float_loaded",
  "payment_auto_cash_float_qr_payload",
  "payment_auto_cash_float_created_at_ms",
  "payment_auto_cash_float_assignment_id",
  "payment_auto_cash_float_combination_id",
  "payment_auto_cash_float_business_evening_key",
  "pos_session_started_at",
  "pos_analytics_transactions_v1",
  "mobile_payment_runtime_owner_v1",
] as const;
const TARGET_PREFIXES = [
  "mobile_payment_runtime_v2:",
  "mobile_payment_runtime_v1:",
  "mobile_payment_user_runtime_v1:",
  "payment_settlement_cutoff_v1:",
  "payment_settlement_summary_v1:",
];

function readMarker() {
  return readPaymentRuntimeStorage(RESET_MARKER_KEY) || "";
}

function writeMarker() {
  writePaymentRuntimeStorage(RESET_MARKER_KEY, RESET_VERSION);
}

function clearPaymentRuntime() {
  return clearPaymentRuntimeStorage(TARGET_KEYS, TARGET_PREFIXES);
}

export function resetMobilePaymentConfigOnce() {
  if (readMarker() === RESET_VERSION) return;

  const clearedKeys = clearPaymentRuntime();
  writeMarker();

  window.dispatchEvent(
    new CustomEvent("mobile:payment-config-reset", {
      detail: { version: RESET_VERSION, clearedKeys },
    })
  );
}
