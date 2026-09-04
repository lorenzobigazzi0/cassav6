import { readLocalPreference, writeLocalPreference } from "../shared/storage/preferenceStorage";
import type {
  CashFloatTicketRecord,
  CashFloatTicketRecordStatus,
} from "../pages/payments/cashFloatTicket";

const STORAGE_KEY = "automatic_cash_float_ticket_records_v1";
const MAX_RECORDS = 250;

const VALID_STATUSES = new Set<CashFloatTicketRecordStatus>([
  "generated",
  "loaded",
  "used_in_settlement",
  "cancelled",
]);

const sanitizeString = (value: unknown, limit: number): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, limit) : null;
};

const sanitizeOptionalString = (value: unknown, limit: number): string | null => {
  const normalized = sanitizeString(value, limit);
  return normalized ?? null;
};

const sanitizeCreatedAtMs = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now();
  return Math.trunc(parsed);
};

const sanitizeOptionalTotalCents = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
};

const sanitizeStatus = (value: unknown): CashFloatTicketRecordStatus | null => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return VALID_STATUSES.has(normalized as CashFloatTicketRecordStatus)
    ? (normalized as CashFloatTicketRecordStatus)
    : null;
};

export function normalizeAutomaticCashTicketRecord(value: unknown): CashFloatTicketRecord | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const cashFloatId = sanitizeString(source.cashFloatId, 120);
  const operatorName = sanitizeString(source.operatorName, 120);
  const qrPayload = sanitizeString(source.qrPayload, 4096);
  const printText = sanitizeString(source.printText, 12000);
  const status = sanitizeStatus(source.status);

  if (!cashFloatId || !operatorName || !qrPayload || !printText || !status) return null;

  return {
    cashFloatId,
    assignmentId: sanitizeOptionalString(source.assignmentId, 120),
    combinationId: sanitizeOptionalString(source.combinationId, 120),
    businessEveningKey: sanitizeOptionalString(source.businessEveningKey, 120),
    createdAtMs: sanitizeCreatedAtMs(source.createdAtMs),
    operatorName,
    totalCents: sanitizeOptionalTotalCents(source.totalCents),
    qrPayload,
    printText,
    status,
  };
}

const persist = (records: CashFloatTicketRecord[]) => {
  if (typeof window === "undefined") return;
  try {
    writeLocalPreference(STORAGE_KEY, JSON.stringify(records));
    window.dispatchEvent(
      new CustomEvent("mobile:automatic-cash-ticket-records-changed", { detail: records[0] })
    );
  } catch {
    // ignore storage failures
  }
};

export function readAutomaticCashTicketRecords(): CashFloatTicketRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = readLocalPreference(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeAutomaticCashTicketRecord)
      .filter((entry): entry is CashFloatTicketRecord => entry !== null)
      .sort((left, right) => right.createdAtMs - left.createdAtMs)
      .slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
}

export function saveAutomaticCashTicketRecord(input: CashFloatTicketRecord): CashFloatTicketRecord {
  const normalized = normalizeAutomaticCashTicketRecord(input);
  if (!normalized) {
    throw new Error("Scontrino fondo cassa automatico non valido.");
  }

  const current = readAutomaticCashTicketRecords();
  const previous = current.find((record) => record.cashFloatId === normalized.cashFloatId);
  const nextRecord: CashFloatTicketRecord = previous
    ? {
        ...previous,
        ...normalized,
        createdAtMs: previous.createdAtMs || normalized.createdAtMs,
        totalCents: normalized.totalCents ?? previous.totalCents ?? null,
        printText: previous.printText || normalized.printText,
      }
    : normalized;
  const next = [
    nextRecord,
    ...current.filter((record) => record.cashFloatId !== normalized.cashFloatId),
  ]
    .sort((left, right) => right.createdAtMs - left.createdAtMs)
    .slice(0, MAX_RECORDS);

  persist(next);
  return nextRecord;
}

export function updateAutomaticCashTicketRecordStatus(
  cashFloatId: string,
  status: CashFloatTicketRecordStatus
): CashFloatTicketRecord | null {
  if (!VALID_STATUSES.has(status)) return null;
  const id = cashFloatId.trim();
  if (!id) return null;
  const current = readAutomaticCashTicketRecords();
  const existing = current.find((record) => record.cashFloatId === id);
  if (!existing) return null;
  const nextRecord = { ...existing, status };
  const next = [nextRecord, ...current.filter((record) => record.cashFloatId !== id)].sort(
    (left, right) => right.createdAtMs - left.createdAtMs
  );
  persist(next);
  return nextRecord;
}
