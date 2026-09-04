import {
  readDualStorageString,
  removeDualStorageString,
  removeMatchingStorageKeys,
  writeDualStorageString,
  writeLocalStorageString,
  removeLocalStorageString,
} from "./storageAdapter";

export const PAYMENT_POS_ID_KEY = "payment_pos_id";
export const PAYMENT_CASH_MODE_KEY = "payment_cash_mode";
export const PAYMENT_CASH_FLOAT_KEY = "payment_cash_float";
export const PAYMENT_CASH_FLOAT_LOCKED_KEY = "payment_cash_float_locked";
export const PAYMENT_AUTO_CASH_FLOAT_ID_KEY = "payment_auto_cash_float_id";
export const PAYMENT_AUTO_CASH_FLOAT_LOADED_KEY = "payment_auto_cash_float_loaded";
export const PAYMENT_AUTO_CASH_FLOAT_QR_PAYLOAD_KEY = "payment_auto_cash_float_qr_payload";
export const PAYMENT_AUTO_CASH_FLOAT_CREATED_AT_MS_KEY =
  "payment_auto_cash_float_created_at_ms";
export const PAYMENT_AUTO_CASH_FLOAT_ASSIGNMENT_ID_KEY =
  "payment_auto_cash_float_assignment_id";
export const PAYMENT_AUTO_CASH_FLOAT_COMBINATION_ID_KEY =
  "payment_auto_cash_float_combination_id";
export const PAYMENT_AUTO_CASH_FLOAT_BUSINESS_EVENING_KEY =
  "payment_auto_cash_float_business_evening_key";
export const PAYMENT_SESSION_STARTED_AT_KEY = "pos_session_started_at";

export function readPaymentRuntimeStorage(key: string) {
  return readDualStorageString(key);
}

export function writePaymentRuntimeStorage(key: string, value: string) {
  writeDualStorageString(key, value);
}

export function removePaymentRuntimeStorage(key: string) {
  removeDualStorageString(key);
}

export function writePaymentSetting(key: string, value: string) {
  writeLocalStorageString(key, value);
}

export function removePaymentSetting(key: string) {
  removeLocalStorageString(key);
}

export function clearPaymentRuntimeStorage(keys: readonly string[], prefixes: readonly string[]) {
  return removeMatchingStorageKeys(prefixes, keys);
}
