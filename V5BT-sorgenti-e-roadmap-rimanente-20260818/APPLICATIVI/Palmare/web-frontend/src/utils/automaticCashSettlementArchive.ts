import { readLocalPreference, writeLocalPreference } from "../shared/storage/preferenceStorage";

export type SettlementFeedbackKind = "happy" | "sad" | "angry";

export type AutomaticCashSettlementRecord = {
  id: string;
  operationId?: string | null;
  cashFloatId: string;
  assignmentId: string | null;
  combinationId: string | null;
  businessEveningKey: string | null;
  userId: string | null;
  deviceUuid: string | null;
  operatorName?: string | null;
  station?: string | null;
  roomId?: string | null;
  roomName?: string | null;
  expectedDepositTotalCents: number;
  depositedTotalCents: number;
  differenceCents: number;
  mismatchConfirmed: boolean;
  feedbackKind: SettlementFeedbackKind;
  printText: string;
  details?: Record<string, unknown>;
  completedAtMs: number;
};

const STORAGE_KEY = "automatic_cash_settlement_records_v1";
const MAX_RECORDS = 120;

const sanitizeString = (value: unknown, limit: number): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, limit) : null;
};

const sanitizeOptionalString = (value: unknown, limit: number) => sanitizeString(value, limit);

const sanitizeNonNegativeInteger = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed);
};

const sanitizeTimestamp = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now();
  return Math.trunc(parsed);
};

const sanitizeThresholdCents = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.trunc(parsed);
};

export function resolveSettlementFeedback(input: {
  expectedDepositTotalCents: number;
  depositedTotalCents: number;
  warningThresholdCents: number;
  dangerThresholdCents?: number;
}): SettlementFeedbackKind {
  const diff = Math.abs(input.expectedDepositTotalCents - input.depositedTotalCents);
  const warningThresholdCents = sanitizeThresholdCents(input.warningThresholdCents, 1000);
  const dangerThresholdCents = Math.max(
    warningThresholdCents,
    sanitizeThresholdCents(input.dangerThresholdCents, warningThresholdCents)
  );
  if (diff <= 1) return "happy";
  if (diff <= dangerThresholdCents) return "sad";
  return "angry";
}

export const SETTLEMENT_FEEDBACK_COPY: Record<SettlementFeedbackKind, string> = {
  happy: "Ottimo lavoro!",
  sad: "Ci sei quasi, presta piu attenzione.",
  angry: "Attenzione, supervisore avvisato.",
};

const sanitizeFeedbackKind = (value: unknown): SettlementFeedbackKind | null => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "happy" || normalized === "sad" || normalized === "angry") {
    return normalized;
  }
  return null;
};

export function normalizeAutomaticCashSettlementRecord(
  value: unknown
): AutomaticCashSettlementRecord | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const id = sanitizeString(source.id, 160);
  const cashFloatId = sanitizeString(source.cashFloatId, 120);
  const printText = sanitizeString(source.printText, 14000);
  const feedbackKind = sanitizeFeedbackKind(source.feedbackKind);
  if (!id || !cashFloatId || !printText || !feedbackKind) return null;

  const expectedDepositTotalCents = sanitizeNonNegativeInteger(source.expectedDepositTotalCents);
  const depositedTotalCents = sanitizeNonNegativeInteger(source.depositedTotalCents);
  const differenceCents = sanitizeNonNegativeInteger(
    source.differenceCents ?? Math.abs(expectedDepositTotalCents - depositedTotalCents)
  );

  return {
    id,
    operationId: sanitizeOptionalString(source.operationId, 120),
    cashFloatId,
    assignmentId: sanitizeOptionalString(source.assignmentId, 120),
    combinationId: sanitizeOptionalString(source.combinationId, 120),
    businessEveningKey: sanitizeOptionalString(source.businessEveningKey, 120),
    userId: sanitizeOptionalString(source.userId, 120),
    deviceUuid: sanitizeOptionalString(source.deviceUuid, 160),
    operatorName: sanitizeOptionalString(source.operatorName, 160),
    station: sanitizeOptionalString(source.station, 160),
    roomId: sanitizeOptionalString(source.roomId, 120),
    roomName: sanitizeOptionalString(source.roomName, 160),
    expectedDepositTotalCents,
    depositedTotalCents,
    differenceCents,
    mismatchConfirmed: source.mismatchConfirmed === true,
    feedbackKind,
    printText,
    details:
      source.details && typeof source.details === "object" && !Array.isArray(source.details)
        ? (source.details as Record<string, unknown>)
        : {},
    completedAtMs: sanitizeTimestamp(source.completedAtMs),
  };
}

const persist = (records: AutomaticCashSettlementRecord[]) => {
  if (typeof window === "undefined") return;
  try {
    writeLocalPreference(STORAGE_KEY, JSON.stringify(records));
    window.dispatchEvent(
      new CustomEvent("mobile:automatic-cash-settlement-records-changed", {
        detail: records[0],
      })
    );
  } catch {
    // ignore storage failures
  }
};

export function readAutomaticCashSettlementRecords(): AutomaticCashSettlementRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = readLocalPreference(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeAutomaticCashSettlementRecord)
      .filter((entry): entry is AutomaticCashSettlementRecord => entry !== null)
      .sort((left, right) => right.completedAtMs - left.completedAtMs)
      .slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
}

export function saveAutomaticCashSettlementRecord(
  input: AutomaticCashSettlementRecord
): AutomaticCashSettlementRecord {
  const normalized = normalizeAutomaticCashSettlementRecord(input);
  if (!normalized) {
    throw new Error("Scarico automatico non valido.");
  }
  const current = readAutomaticCashSettlementRecords();
  const next = [normalized, ...current.filter((record) => record.id !== normalized.id)]
    .sort((left, right) => right.completedAtMs - left.completedAtMs)
    .slice(0, MAX_RECORDS);
  persist(next);
  return normalized;
}

export function readLatestAutomaticCashSettlementRecord(filter: {
  userId?: string | null;
  deviceUuid?: string | null;
}): AutomaticCashSettlementRecord | null {
  const userId = String(filter.userId ?? "").trim();
  const deviceUuid = String(filter.deviceUuid ?? "").trim();
  return (
    readAutomaticCashSettlementRecords().find((record) => {
      if (userId && record.userId && record.userId !== userId) return false;
      if (deviceUuid && record.deviceUuid && record.deviceUuid !== deviceUuid) return false;
      return true;
    }) ?? null
  );
}
