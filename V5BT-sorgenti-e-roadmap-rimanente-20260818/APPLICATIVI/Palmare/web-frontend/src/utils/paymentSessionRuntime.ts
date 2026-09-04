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
  PAYMENT_SESSION_STARTED_AT_KEY,
  readPaymentRuntimeStorage,
  removePaymentRuntimeStorage,
  writePaymentRuntimeStorage,
} from "../shared/storage/paymentSessionStorage";
import type { CashFloatMode } from "../types/automaticCash";

const LEGACY_RUNTIME_PREFIX = "mobile_payment_runtime_v1";
const LEGACY_USER_RUNTIME_PREFIX = "mobile_payment_user_runtime_v1";
const USER_RUNTIME_PREFIX = "mobile_payment_runtime_v2";
const RUNTIME_OWNER_KEY = "mobile_payment_runtime_owner_v1";

const PAYMENT_AUTO_CASH_FLOAT_KEYS = [
  PAYMENT_AUTO_CASH_FLOAT_ID_KEY,
  PAYMENT_AUTO_CASH_FLOAT_LOADED_KEY,
  PAYMENT_AUTO_CASH_FLOAT_QR_PAYLOAD_KEY,
  PAYMENT_AUTO_CASH_FLOAT_CREATED_AT_MS_KEY,
  PAYMENT_AUTO_CASH_FLOAT_ASSIGNMENT_ID_KEY,
  PAYMENT_AUTO_CASH_FLOAT_COMBINATION_ID_KEY,
  PAYMENT_AUTO_CASH_FLOAT_BUSINESS_EVENING_KEY,
] as const;

const PAYMENT_CASH_FLOAT_KEYS = [
  PAYMENT_CASH_MODE_KEY,
  PAYMENT_CASH_FLOAT_KEY,
  PAYMENT_CASH_FLOAT_LOCKED_KEY,
  ...PAYMENT_AUTO_CASH_FLOAT_KEYS,
] as const;

const PAYMENT_CONFIG_KEYS = [PAYMENT_POS_ID_KEY, ...PAYMENT_CASH_FLOAT_KEYS] as const;

export {
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
  PAYMENT_SESSION_STARTED_AT_KEY,
};

const TOKEN_KEY = "pos_token";
const USER_ID_KEY = "pos_user_id";
const USERNAME_KEY = "pos_user";
const FULL_NAME_KEY = "pos_full_name";
const DEVICE_UUID_KEY = "pos_device_uuid";

type PaymentRuntimeIdentity = {
  token: string;
  userId: string;
  username: string;
  fullName: string;
  deviceUuid: string;
};

type PaymentRuntimeSnapshot = PaymentRuntimeIdentity & {
  posId: string;
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
  sessionStartedAt: number;
  hasActivePaymentConfig: boolean;
};

type SavedPaymentRuntime = {
  version?: number;
  savedAt?: number;
  savedReason?: string;
  userId?: string;
  username?: string;
  fullName?: string;
  deviceUuid?: string;
  posId?: string;
  cashMode?: CashFloatMode | string;
  cashFloat?: number | string | null;
  cashFloatLocked?: boolean;
  autoCashFloatId?: string | null;
  autoCashFloatLoaded?: boolean;
  autoCashFloatQrPayload?: string | null;
  autoCashFloatCreatedAtMs?: number | string | null;
  autoCashFloatAssignmentId?: string | null;
  autoCashFloatCombinationId?: string | null;
  autoCashFloatBusinessEveningKey?: string | null;
  sessionStartedAt?: number | string | null;
  hasActivePaymentConfig?: boolean;
};

const hasBrowserStorage = () => typeof window !== "undefined";

const normalize = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const tokenPart = (value: unknown, fallback: string) => {
  const normalized = normalize(value)
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || fallback).slice(0, 48);
};

export const parsePaymentMoney = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, value) : null;
  const raw = normalize(value);
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, "").replace(/[^\d,.-]/g, "");
  if (!compact) return null;
  const normalized =
    compact.includes(",") && compact.includes(".")
      ? compact.replace(/\./g, "").replace(/,/g, ".")
      : compact.replace(/,/g, ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100) / 100) : null;
};

const parseTimestamp = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return Math.trunc(value);
    if (value > 1_000_000_000) return Math.trunc(value * 1000);
    return null;
  }
  const raw = normalize(value);
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return parseTimestamp(numeric);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeCashMode = (
  value: unknown,
  cashFloatLocked: boolean,
  autoCashFloatLoaded: boolean
): CashFloatMode => {
  const raw = normalize(value).toLowerCase();
  if (raw === "auto" && autoCashFloatLoaded) return "auto";
  if (raw === "manual" && cashFloatLocked) return "manual";
  if (raw === "none") return "none";
  if (autoCashFloatLoaded) return "auto";
  if (cashFloatLocked) return "manual";
  return "none";
};

const readAutoCashFloatFields = () => {
  const autoCashFloatId = normalize(readRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_ID_KEY)) || null;
  const autoCashFloatQrPayload =
    normalize(readRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_QR_PAYLOAD_KEY)) || null;
  const autoCashFloatCreatedAtMs = parseTimestamp(
    readRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_CREATED_AT_MS_KEY)
  );
  const autoCashFloatAssignmentId =
    normalize(readRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_ASSIGNMENT_ID_KEY)) || null;
  const autoCashFloatCombinationId =
    normalize(readRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_COMBINATION_ID_KEY)) || null;
  const autoCashFloatBusinessEveningKey =
    normalize(readRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_BUSINESS_EVENING_KEY)) || null;
  const autoCashFloatLoaded =
    normalize(readRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_LOADED_KEY)) === "1" ||
    Boolean(autoCashFloatId || autoCashFloatQrPayload);

  return {
    autoCashFloatId,
    autoCashFloatLoaded,
    autoCashFloatQrPayload,
    autoCashFloatCreatedAtMs,
    autoCashFloatAssignmentId,
    autoCashFloatCombinationId,
    autoCashFloatBusinessEveningKey,
  };
};

const normalizeSavedAutoCashFloatFields = (
  saved: Pick<
    SavedPaymentRuntime,
    | "autoCashFloatId"
    | "autoCashFloatLoaded"
    | "autoCashFloatQrPayload"
    | "autoCashFloatCreatedAtMs"
    | "autoCashFloatAssignmentId"
    | "autoCashFloatCombinationId"
    | "autoCashFloatBusinessEveningKey"
  >
) => {
  const autoCashFloatId = normalize(saved.autoCashFloatId) || null;
  const autoCashFloatQrPayload = normalize(saved.autoCashFloatQrPayload) || null;
  return {
    autoCashFloatId,
    autoCashFloatLoaded:
      saved.autoCashFloatLoaded === true || Boolean(autoCashFloatId || autoCashFloatQrPayload),
    autoCashFloatQrPayload,
    autoCashFloatCreatedAtMs: parseTimestamp(saved.autoCashFloatCreatedAtMs),
    autoCashFloatAssignmentId: normalize(saved.autoCashFloatAssignmentId) || null,
    autoCashFloatCombinationId: normalize(saved.autoCashFloatCombinationId) || null,
    autoCashFloatBusinessEveningKey: normalize(saved.autoCashFloatBusinessEveningKey) || null,
  };
};

export const readRuntimeStorage = (key: string): string | null => {
  if (!hasBrowserStorage()) return null;
  return readPaymentRuntimeStorage(key);
};

const writeRuntimeStorage = (key: string, value: string) => {
  if (!hasBrowserStorage()) return;
  writePaymentRuntimeStorage(key, value);
};

const removeRuntimeStorage = (key: string) => {
  if (!hasBrowserStorage()) return;
  removePaymentRuntimeStorage(key);
};

const readIdentity = (): PaymentRuntimeIdentity => ({
  token: normalize(readRuntimeStorage(TOKEN_KEY)),
  userId: normalize(readRuntimeStorage(USER_ID_KEY)),
  username: normalize(readRuntimeStorage(USERNAME_KEY)),
  fullName: normalize(readRuntimeStorage(FULL_NAME_KEY)),
  deviceUuid: normalize(readRuntimeStorage(DEVICE_UUID_KEY)),
});

const legacyRuntimeDeviceKey = (
  identity: Pick<PaymentRuntimeIdentity, "userId" | "username" | "deviceUuid">
) => {
  const userPart = tokenPart(identity.userId || identity.username, "anon");
  const devicePart = tokenPart(identity.deviceUuid, "device");
  return userPart === "anon" ? "" : `${LEGACY_RUNTIME_PREFIX}:${userPart}:${devicePart}`;
};

const legacyRuntimeUserKey = (
  identity: Pick<PaymentRuntimeIdentity, "userId" | "username">
) => {
  const userPart = tokenPart(identity.userId || identity.username, "anon");
  return userPart === "anon" ? "" : `${LEGACY_USER_RUNTIME_PREFIX}:${userPart}`;
};

const runtimeUserKey = (
  identity: Pick<PaymentRuntimeIdentity, "userId" | "username">
) => {
  const userPart = tokenPart(identity.userId || identity.username, "anon");
  return userPart === "anon" ? "" : `${USER_RUNTIME_PREFIX}:${userPart}`;
};

const runtimeUserPart = (identity: Pick<PaymentRuntimeIdentity, "userId" | "username">) =>
  tokenPart(identity.userId || identity.username, "anon");

const runtimeWriteKeys = (identity: Pick<PaymentRuntimeIdentity, "userId" | "username">) =>
  Array.from(new Set([runtimeUserKey(identity), legacyRuntimeUserKey(identity)].filter(Boolean)));

const runtimeReadKeys = (
  identity: Pick<PaymentRuntimeIdentity, "userId" | "username" | "deviceUuid">
) =>
  Array.from(
    new Set(
      [
        runtimeUserKey(identity),
        legacyRuntimeUserKey(identity),
        legacyRuntimeDeviceKey(identity),
      ].filter(Boolean)
    )
  );

const runtimeClearKeys = (
  identity: Pick<PaymentRuntimeIdentity, "userId" | "username" | "deviceUuid">
) =>
  Array.from(new Set([...runtimeReadKeys(identity), ...runtimeWriteKeys(identity)].filter(Boolean)));

const readRuntime = (key: string): SavedPaymentRuntime | null => {
  if (!key) return null;
  const raw = readRuntimeStorage(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SavedPaymentRuntime) : null;
  } catch {
    removeRuntimeStorage(key);
    return null;
  }
};

const readPreferredRuntime = (
  identity: Pick<PaymentRuntimeIdentity, "userId" | "username" | "deviceUuid">
) => {
  for (const key of runtimeReadKeys(identity)) {
    const saved = readRuntime(key);
    if (saved) return { key, saved };
  }
  return null;
};

const clearActivePaymentConfig = () => {
  PAYMENT_CONFIG_KEYS.forEach((key) => removeRuntimeStorage(key));
  removeRuntimeStorage(PAYMENT_SESSION_STARTED_AT_KEY);
  removeRuntimeStorage(RUNTIME_OWNER_KEY);
};

const clearPaymentConfigValues = () => {
  PAYMENT_CONFIG_KEYS.forEach((key) => removeRuntimeStorage(key));
};

const clearCashFloatValues = () => {
  PAYMENT_CASH_FLOAT_KEYS.forEach((key) => removeRuntimeStorage(key));
};

const clearAutoCashFloatValues = () => {
  PAYMENT_AUTO_CASH_FLOAT_KEYS.forEach((key) => removeRuntimeStorage(key));
};

const writeAutoCashFloatValues = (
  autoFields: ReturnType<typeof normalizeSavedAutoCashFloatFields>
) => {
  if (autoFields.autoCashFloatId) {
    writeRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_ID_KEY, autoFields.autoCashFloatId);
  } else {
    removeRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_ID_KEY);
  }
  writeRuntimeStorage(
    PAYMENT_AUTO_CASH_FLOAT_LOADED_KEY,
    autoFields.autoCashFloatLoaded ? "1" : "0"
  );
  if (autoFields.autoCashFloatQrPayload) {
    writeRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_QR_PAYLOAD_KEY, autoFields.autoCashFloatQrPayload);
  } else {
    removeRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_QR_PAYLOAD_KEY);
  }
  if (autoFields.autoCashFloatCreatedAtMs) {
    writeRuntimeStorage(
      PAYMENT_AUTO_CASH_FLOAT_CREATED_AT_MS_KEY,
      String(autoFields.autoCashFloatCreatedAtMs)
    );
  } else {
    removeRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_CREATED_AT_MS_KEY);
  }
  if (autoFields.autoCashFloatAssignmentId) {
    writeRuntimeStorage(
      PAYMENT_AUTO_CASH_FLOAT_ASSIGNMENT_ID_KEY,
      autoFields.autoCashFloatAssignmentId
    );
  } else {
    removeRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_ASSIGNMENT_ID_KEY);
  }
  if (autoFields.autoCashFloatCombinationId) {
    writeRuntimeStorage(
      PAYMENT_AUTO_CASH_FLOAT_COMBINATION_ID_KEY,
      autoFields.autoCashFloatCombinationId
    );
  } else {
    removeRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_COMBINATION_ID_KEY);
  }
  if (autoFields.autoCashFloatBusinessEveningKey) {
    writeRuntimeStorage(
      PAYMENT_AUTO_CASH_FLOAT_BUSINESS_EVENING_KEY,
      autoFields.autoCashFloatBusinessEveningKey
    );
  } else {
    removeRuntimeStorage(PAYMENT_AUTO_CASH_FLOAT_BUSINESS_EVENING_KEY);
  }
};

const readCurrentSnapshot = (): PaymentRuntimeSnapshot => {
  const identity = readIdentity();
  const posId = normalize(readRuntimeStorage(PAYMENT_POS_ID_KEY));
  const cashFloat = parsePaymentMoney(readRuntimeStorage(PAYMENT_CASH_FLOAT_KEY));
  const cashFloatLocked =
    normalize(readRuntimeStorage(PAYMENT_CASH_FLOAT_LOCKED_KEY)) === "1" && cashFloat !== null;
  const autoFields = readAutoCashFloatFields();
  const autoCashFloatLoaded = autoFields.autoCashFloatLoaded && cashFloatLocked;
  const cashMode = normalizeCashMode(
    readRuntimeStorage(PAYMENT_CASH_MODE_KEY),
    cashFloatLocked,
    autoCashFloatLoaded
  );
  const hasActivePaymentConfig = Boolean(posId) || cashFloatLocked || autoCashFloatLoaded;
  let sessionStartedAt = parseTimestamp(readRuntimeStorage(PAYMENT_SESSION_STARTED_AT_KEY));
  if (!sessionStartedAt && hasActivePaymentConfig) {
    sessionStartedAt = Date.now();
    writeRuntimeStorage(PAYMENT_SESSION_STARTED_AT_KEY, String(sessionStartedAt));
  }
  return {
    ...identity,
    posId,
    cashMode,
    cashFloat,
    cashFloatLocked,
    ...autoFields,
    autoCashFloatLoaded,
    sessionStartedAt: sessionStartedAt || Date.now(),
    hasActivePaymentConfig,
  };
};

const snapshotSignature = (snapshot: PaymentRuntimeSnapshot) =>
  [
    snapshot.userId,
    snapshot.username,
    snapshot.deviceUuid,
    snapshot.posId,
    snapshot.cashMode,
    snapshot.cashFloatLocked ? "1" : "0",
    snapshot.cashFloat === null ? "" : snapshot.cashFloat.toFixed(2),
    snapshot.autoCashFloatId || "",
    snapshot.autoCashFloatLoaded ? "1" : "0",
    snapshot.autoCashFloatQrPayload || "",
    snapshot.autoCashFloatCreatedAtMs || "",
    snapshot.autoCashFloatAssignmentId || "",
    snapshot.autoCashFloatCombinationId || "",
    snapshot.autoCashFloatBusinessEveningKey || "",
    snapshot.sessionStartedAt,
  ].join("|");

let lastRuntimeKey = "";
let lastSavedSignature = "";
let restoreSuppressedUntil = 0;
let scheduledSync = 0;
let installed = false;

const emitPaymentRuntimeEvent = (name: string, detail: Record<string, unknown>) => {
  if (!hasBrowserStorage()) return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
};

export const readPersistedPaymentSettings = () => {
  const cashFloat = parsePaymentMoney(readRuntimeStorage(PAYMENT_CASH_FLOAT_KEY));
  const cashFloatLocked =
    normalize(readRuntimeStorage(PAYMENT_CASH_FLOAT_LOCKED_KEY)) === "1" && cashFloat !== null;
  const autoFields = readAutoCashFloatFields();
  const autoCashFloatLoaded = autoFields.autoCashFloatLoaded && cashFloatLocked;
  const cashMode = normalizeCashMode(
    readRuntimeStorage(PAYMENT_CASH_MODE_KEY),
    cashFloatLocked,
    autoCashFloatLoaded
  );
  const posId = normalize(readRuntimeStorage(PAYMENT_POS_ID_KEY));
  return {
    posId: posId || null,
    cashMode,
    cashFloat,
    cashFloatLocked,
    ...autoFields,
    autoCashFloatLoaded,
  };
};

export const persistMobilePaymentRuntime = (reason = "sync") => {
  if (!hasBrowserStorage()) return;
  const snapshot = readCurrentSnapshot();
  const keys = runtimeWriteKeys(snapshot);
  const existingKeys = runtimeReadKeys(snapshot);
  if (!keys.length) return;

  const previousStartedAt = existingKeys
    .map((key) => parseTimestamp(readRuntime(key)?.sessionStartedAt))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)[0];
  if (previousStartedAt && previousStartedAt < snapshot.sessionStartedAt) {
    snapshot.sessionStartedAt = previousStartedAt;
    writeRuntimeStorage(PAYMENT_SESSION_STARTED_AT_KEY, String(previousStartedAt));
  }

  const currentSignature = snapshotSignature(snapshot);
  const keySignature = keys.join("|");
  if (keySignature === lastRuntimeKey && currentSignature === lastSavedSignature) return;

  const payload: SavedPaymentRuntime = {
    version: 2,
    savedAt: Date.now(),
    savedReason: normalize(reason) || "sync",
    userId: snapshot.userId,
    username: snapshot.username,
    fullName: snapshot.fullName,
    deviceUuid: snapshot.deviceUuid,
    posId: snapshot.posId,
    cashMode: snapshot.cashMode,
    cashFloat: snapshot.cashFloat,
    cashFloatLocked: snapshot.cashFloatLocked,
    autoCashFloatId: snapshot.autoCashFloatId,
    autoCashFloatLoaded: snapshot.autoCashFloatLoaded,
    autoCashFloatQrPayload: snapshot.autoCashFloatQrPayload,
    autoCashFloatCreatedAtMs: snapshot.autoCashFloatCreatedAtMs,
    autoCashFloatAssignmentId: snapshot.autoCashFloatAssignmentId,
    autoCashFloatCombinationId: snapshot.autoCashFloatCombinationId,
    autoCashFloatBusinessEveningKey: snapshot.autoCashFloatBusinessEveningKey,
    sessionStartedAt: snapshot.sessionStartedAt,
    hasActivePaymentConfig: snapshot.hasActivePaymentConfig,
  };

  keys.forEach((key) => writeRuntimeStorage(key, JSON.stringify(payload)));
  writeRuntimeStorage(RUNTIME_OWNER_KEY, runtimeUserPart(snapshot));
  lastRuntimeKey = keySignature;
  lastSavedSignature = currentSignature;
};

export const restoreMobilePaymentRuntime = (reason = "restore") => {
  if (!hasBrowserStorage() || Date.now() < restoreSuppressedUntil) return false;
  const current = readCurrentSnapshot();
  if (!current.token || !(current.userId || current.username)) return false;

  const restored = readPreferredRuntime(current);
  const saved = restored?.saved ?? null;
  if (!saved) {
    const owner = normalize(readRuntimeStorage(RUNTIME_OWNER_KEY));
    const currentOwner = runtimeUserPart(current);
    if (current.hasActivePaymentConfig && owner && owner !== currentOwner) {
      clearActivePaymentConfig();
      emitPaymentRuntimeEvent("mobile:payment-config-reset", {
        source: "payment-session-runtime",
        reason: "user-switch",
        keys: [...PAYMENT_CONFIG_KEYS, PAYMENT_SESSION_STARTED_AT_KEY],
      });
    } else if (current.hasActivePaymentConfig || current.sessionStartedAt) {
      persistMobilePaymentRuntime("adopt-current");
    }
    return false;
  }

  const savedPosId = normalize(saved.posId);
  const savedCashFloat = parsePaymentMoney(saved.cashFloat);
  const savedCashFloatLocked = saved.cashFloatLocked === true && savedCashFloat !== null;
  const savedAutoFields = normalizeSavedAutoCashFloatFields(saved);
  const savedAutoCashFloatLoaded = savedAutoFields.autoCashFloatLoaded && savedCashFloatLocked;
  const savedCashMode = normalizeCashMode(
    saved.cashMode,
    savedCashFloatLocked,
    savedAutoCashFloatLoaded
  );
  const savedStartedAt = parseTimestamp(saved.sessionStartedAt);
  const currentStartedAt = parseTimestamp(readRuntimeStorage(PAYMENT_SESSION_STARTED_AT_KEY));
  let changed = false;

  if (saved.hasActivePaymentConfig === true) {
    if (savedPosId) {
      if (normalize(readRuntimeStorage(PAYMENT_POS_ID_KEY)) !== savedPosId) {
        writeRuntimeStorage(PAYMENT_POS_ID_KEY, savedPosId);
        changed = true;
      }
    } else if (normalize(readRuntimeStorage(PAYMENT_POS_ID_KEY))) {
      removeRuntimeStorage(PAYMENT_POS_ID_KEY);
      changed = true;
    }

    if (savedCashFloatLocked && savedCashFloat !== null) {
      const formattedCashFloat = savedCashFloat.toFixed(2);
      if (normalize(readRuntimeStorage(PAYMENT_CASH_MODE_KEY)) !== savedCashMode) {
        writeRuntimeStorage(PAYMENT_CASH_MODE_KEY, savedCashMode);
        changed = true;
      }
      if (normalize(readRuntimeStorage(PAYMENT_CASH_FLOAT_KEY)) !== formattedCashFloat) {
        writeRuntimeStorage(PAYMENT_CASH_FLOAT_KEY, formattedCashFloat);
        changed = true;
      }
      if (normalize(readRuntimeStorage(PAYMENT_CASH_FLOAT_LOCKED_KEY)) !== "1") {
        writeRuntimeStorage(PAYMENT_CASH_FLOAT_LOCKED_KEY, "1");
        changed = true;
      }

      if (savedCashMode === "auto") {
        const beforeAuto = JSON.stringify(readAutoCashFloatFields());
        writeAutoCashFloatValues({ ...savedAutoFields, autoCashFloatLoaded: true });
        if (JSON.stringify(readAutoCashFloatFields()) !== beforeAuto) changed = true;
      } else if (PAYMENT_AUTO_CASH_FLOAT_KEYS.some((key) => normalize(readRuntimeStorage(key)))) {
        clearAutoCashFloatValues();
        changed = true;
      }
    } else if (PAYMENT_CASH_FLOAT_KEYS.some((key) => normalize(readRuntimeStorage(key)))) {
      clearCashFloatValues();
      changed = true;
    }
  } else if (current.hasActivePaymentConfig) {
    clearPaymentConfigValues();
    changed = true;
  }

  if (savedStartedAt && (!currentStartedAt || savedStartedAt < currentStartedAt)) {
    writeRuntimeStorage(PAYMENT_SESSION_STARTED_AT_KEY, String(savedStartedAt));
    changed = true;
  }

  writeRuntimeStorage(RUNTIME_OWNER_KEY, runtimeUserPart(current));

  if (changed) {
    lastRuntimeKey = runtimeWriteKeys(current).join("|");
    lastSavedSignature = "";
    const detail = {
      source: "payment-session-runtime",
      reason: normalize(reason) || "restore",
      keys: [...PAYMENT_CONFIG_KEYS, PAYMENT_SESSION_STARTED_AT_KEY],
    };
    emitPaymentRuntimeEvent("mobile:payment-config-reset", detail);
    emitPaymentRuntimeEvent("mobile:payment-config-restored", detail);
  }

  persistMobilePaymentRuntime("post-restore");
  return changed;
};

export const clearMobilePaymentRuntime = (reason = "settlement") => {
  runtimeClearKeys(readIdentity()).forEach((key) => removeRuntimeStorage(key));
  clearActivePaymentConfig();
  restoreSuppressedUntil = Date.now() + 5000;
  lastRuntimeKey = "";
  lastSavedSignature = "";
  emitPaymentRuntimeEvent("mobile:payment-runtime-cleared", {
    source: "payment-session-runtime",
    reason: normalize(reason) || "settlement",
  });
};

const scheduleRuntimeSync = (reason: string) => {
  if (!hasBrowserStorage()) return;
  if (scheduledSync) window.clearTimeout(scheduledSync);
  scheduledSync = window.setTimeout(() => {
    scheduledSync = 0;
    persistMobilePaymentRuntime(reason);
    restoreMobilePaymentRuntime(reason);
  }, 140);
};

export const installMobilePaymentSessionRuntime = () => {
  if (!hasBrowserStorage() || installed) return;
  installed = true;

  window.addEventListener("beforeunload", () => persistMobilePaymentRuntime("beforeunload"));
  window.addEventListener("mobile:payments:settlement-completed", () =>
    clearMobilePaymentRuntime("settlement-completed")
  );
  window.addEventListener("mobile:session-expired", () =>
    persistMobilePaymentRuntime("session-expired")
  );
  window.addEventListener("focus", () => scheduleRuntimeSync("focus"));
  window.addEventListener("pageshow", () => scheduleRuntimeSync("pageshow"));
  window.addEventListener("storage", () => scheduleRuntimeSync("storage"));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleRuntimeSync("visibility");
  });

  scheduleRuntimeSync("boot");
};
