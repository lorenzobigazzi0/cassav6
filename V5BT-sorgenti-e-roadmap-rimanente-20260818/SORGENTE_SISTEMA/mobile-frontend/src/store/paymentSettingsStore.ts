import { create } from "zustand";
import { resetMobilePaymentConfigOnce } from "../utils/paymentConfigReset";
import {
  PAYMENT_AUTO_CASH_FLOAT_ASSIGNMENT_ID_KEY,
  PAYMENT_AUTO_CASH_FLOAT_BUSINESS_EVENING_KEY,
  PAYMENT_AUTO_CASH_FLOAT_COMBINATION_ID_KEY,
  PAYMENT_AUTO_CASH_FLOAT_CREATED_AT_MS_KEY,
  PAYMENT_AUTO_CASH_FLOAT_ID_KEY,
  PAYMENT_AUTO_CASH_FLOAT_LOADED_KEY,
  PAYMENT_AUTO_CASH_FLOAT_QR_PAYLOAD_KEY,
  PAYMENT_CASH_FLOAT_KEY,
  PAYMENT_CASH_FLOAT_LOCKED_KEY,
  PAYMENT_CASH_MODE_KEY,
  PAYMENT_POS_ID_KEY,
  removePaymentSetting,
  writePaymentSetting,
} from "../shared/storage/paymentSessionStorage";
import {
  persistMobilePaymentRuntime,
  readPersistedPaymentSettings,
  restoreMobilePaymentRuntime,
} from "../utils/paymentSessionRuntime";
import type { CashFloatMode, LockAutoCashFloatPayload } from "../types/automaticCash";

type PaymentSettingsState = {
  posId: string | null;
  cashMode: CashFloatMode;
  cashFloat: number | null;
  cashFloatLocked: boolean;
  autoCashFloatId: string | null;
  autoCashFloatLoaded: boolean;
  autoCashFloatQrPayload: string | null;
  autoCashFloatCreatedAtMs: number | null;
  autoCashFloatAssignmentId: string | null;
  autoCashFloatCombinationId: string | null;
  autoCashFloatBusinessEveningKey: string | null;
  setPosId: (posId: string | null) => void;
  setCashMode: (mode: CashFloatMode) => void;
  lockCashFloat: (value: number) => void;
  lockManualCashFloat: (value: number) => void;
  lockAutoCashFloat: (payload: LockAutoCashFloatPayload) => void;
  clearCashFloat: () => void;
  resetCashFloat: () => void;
  resetPaymentSession: () => void;
};

resetMobilePaymentConfigOnce();
restoreMobilePaymentRuntime("payment-store-init");

const storedPaymentSettings = readPersistedPaymentSettings();

const clearAutoCashFloatSettings = () => {
  removePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_ID_KEY);
  removePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_LOADED_KEY);
  removePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_QR_PAYLOAD_KEY);
  removePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_CREATED_AT_MS_KEY);
  removePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_ASSIGNMENT_ID_KEY);
  removePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_COMBINATION_ID_KEY);
  removePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_BUSINESS_EVENING_KEY);
};

const clearCashFloatSettings = () => {
  removePaymentSetting(PAYMENT_CASH_MODE_KEY);
  removePaymentSetting(PAYMENT_CASH_FLOAT_KEY);
  removePaymentSetting(PAYMENT_CASH_FLOAT_LOCKED_KEY);
  clearAutoCashFloatSettings();
};

const emptyCashFloatState = {
  cashMode: "none" as CashFloatMode,
  cashFloat: null,
  cashFloatLocked: false,
  autoCashFloatId: null,
  autoCashFloatLoaded: false,
  autoCashFloatQrPayload: null,
  autoCashFloatCreatedAtMs: null,
  autoCashFloatAssignmentId: null,
  autoCashFloatCombinationId: null,
  autoCashFloatBusinessEveningKey: null,
};

export const usePaymentSettingsStore = create<PaymentSettingsState>((set) => ({
  posId: storedPaymentSettings.posId,
  cashMode: storedPaymentSettings.cashMode,
  cashFloat: storedPaymentSettings.cashFloat,
  cashFloatLocked: storedPaymentSettings.cashFloatLocked,
  autoCashFloatId: storedPaymentSettings.autoCashFloatId,
  autoCashFloatLoaded: storedPaymentSettings.autoCashFloatLoaded,
  autoCashFloatQrPayload: storedPaymentSettings.autoCashFloatQrPayload,
  autoCashFloatCreatedAtMs: storedPaymentSettings.autoCashFloatCreatedAtMs,
  autoCashFloatAssignmentId: storedPaymentSettings.autoCashFloatAssignmentId,
  autoCashFloatCombinationId: storedPaymentSettings.autoCashFloatCombinationId,
  autoCashFloatBusinessEveningKey: storedPaymentSettings.autoCashFloatBusinessEveningKey,
  setPosId: (posId) => {
    const normalized = posId && posId.trim() ? posId.trim() : null;
    if (normalized) {
      writePaymentSetting(PAYMENT_POS_ID_KEY, normalized);
    } else {
      removePaymentSetting(PAYMENT_POS_ID_KEY);
    }
    set({ posId: normalized });
    persistMobilePaymentRuntime("set-pos");
  },
  setCashMode: (mode) => {
    if (mode === "none") {
      clearCashFloatSettings();
      set(emptyCashFloatState);
    } else {
      writePaymentSetting(PAYMENT_CASH_MODE_KEY, mode);
      set({ cashMode: mode });
    }
    persistMobilePaymentRuntime("set-cash-mode");
  },
  lockCashFloat: (value) => {
    usePaymentSettingsStore.getState().lockManualCashFloat(value);
  },
  lockManualCashFloat: (value) => {
    const normalized = Math.max(0, Math.round(value * 100) / 100);
    writePaymentSetting(PAYMENT_CASH_MODE_KEY, "manual");
    writePaymentSetting(PAYMENT_CASH_FLOAT_KEY, normalized.toFixed(2));
    writePaymentSetting(PAYMENT_CASH_FLOAT_LOCKED_KEY, "1");
    clearAutoCashFloatSettings();
    set({
      cashMode: "manual",
      cashFloat: normalized,
      cashFloatLocked: true,
      autoCashFloatId: null,
      autoCashFloatLoaded: false,
      autoCashFloatQrPayload: null,
      autoCashFloatCreatedAtMs: null,
      autoCashFloatAssignmentId: null,
      autoCashFloatCombinationId: null,
      autoCashFloatBusinessEveningKey: null,
    });
    persistMobilePaymentRuntime("lock-manual-cash-float");
  },
  lockAutoCashFloat: (payload) => {
    const normalized = Math.max(0, Math.round(payload.value * 100) / 100);
    writePaymentSetting(PAYMENT_CASH_MODE_KEY, "auto");
    writePaymentSetting(PAYMENT_CASH_FLOAT_KEY, normalized.toFixed(2));
    writePaymentSetting(PAYMENT_CASH_FLOAT_LOCKED_KEY, "1");
    writePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_ID_KEY, payload.id);
    writePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_LOADED_KEY, "1");
    writePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_QR_PAYLOAD_KEY, payload.qrPayload);
    writePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_CREATED_AT_MS_KEY, String(payload.createdAtMs));
    if (payload.assignmentId) {
      writePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_ASSIGNMENT_ID_KEY, payload.assignmentId);
    } else {
      removePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_ASSIGNMENT_ID_KEY);
    }
    if (payload.combinationId) {
      writePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_COMBINATION_ID_KEY, payload.combinationId);
    } else {
      removePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_COMBINATION_ID_KEY);
    }
    if (payload.businessEveningKey) {
      writePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_BUSINESS_EVENING_KEY, payload.businessEveningKey);
    } else {
      removePaymentSetting(PAYMENT_AUTO_CASH_FLOAT_BUSINESS_EVENING_KEY);
    }
    set({
      cashMode: "auto",
      cashFloat: normalized,
      cashFloatLocked: true,
      autoCashFloatId: payload.id,
      autoCashFloatLoaded: true,
      autoCashFloatQrPayload: payload.qrPayload,
      autoCashFloatCreatedAtMs: payload.createdAtMs,
      autoCashFloatAssignmentId: payload.assignmentId ?? null,
      autoCashFloatCombinationId: payload.combinationId ?? null,
      autoCashFloatBusinessEveningKey: payload.businessEveningKey ?? null,
    });
    persistMobilePaymentRuntime("lock-auto-cash-float");
  },
  clearCashFloat: () => {
    clearCashFloatSettings();
    set(emptyCashFloatState);
    persistMobilePaymentRuntime("clear-cash-float");
  },
  resetCashFloat: () => {
    usePaymentSettingsStore.getState().clearCashFloat();
  },
  resetPaymentSession: () => {
    removePaymentSetting(PAYMENT_POS_ID_KEY);
    clearCashFloatSettings();
    set({ posId: null, ...emptyCashFloatState });
    persistMobilePaymentRuntime("reset-payment-session");
  },
}));

const syncPaymentStoreFromStorage = () => {
  const next = readPersistedPaymentSettings();
  usePaymentSettingsStore.setState(next);
};

window.addEventListener("mobile:payment-config-restored", syncPaymentStoreFromStorage);
window.addEventListener("mobile:payment-config-reset", syncPaymentStoreFromStorage);
