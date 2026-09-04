import { readLocalPreference, writeLocalPreference } from "../shared/storage/preferenceStorage";

export type AnalyticsEventKind =
  | "table_occupied"
  | "consumption"
  | "payment"
  | "table_freed"
  | "cash_float_locked";

export type AnalyticsPaymentMethod =
  | "cash"
  | "card"
  | "voucher"
  | "satispay"
  | "suspended"
  | "check"
  | "wire"
  | "unknown";

export type AnalyticsPriceChangeReason = "variant" | "manual" | "supplement" | "unknown";

export type AnalyticsOrderLine = {
  name: string;
  qty: number;
  note?: string;
  variantName?: string;
  unitBasePrice?: number;
  unitFinalPrice?: number;
  priceDelta?: number;
  priceChanged?: boolean;
  priceChangeReason?: AnalyticsPriceChangeReason;
};

/** Id del pagamento appena creato, se la risposta del backend lo espone. */
export const readBackendPaymentId = (body: unknown): string | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const payment = (body as Record<string, unknown>).payment;
  if (!payment || typeof payment !== "object") return undefined;
  const id = (payment as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
};

export type AnalyticsTransactionRecord = {
  id: string;
  createdAt: number;
  kind: AnalyticsEventKind;
  tableId?: string;
  tableNumber?: number;
  // Sala e id di pagamento arrivano gia dal flusso che scrive il record: senza
  // di questi la card locale mostra meno del corrispettivo del server, e al
  // primo caricamento delle statistiche si vede cambiare sotto gli occhi.
  roomId?: string;
  paymentId?: string;
  customerName?: string;
  operatorName?: string;
  operatorId?: string;
  shiftToken?: string;
  description?: string;
  amount?: number;
  paymentMethod?: AnalyticsPaymentMethod;
  orderId?: string;
  orderLines?: AnalyticsOrderLine[];
  cashFloatAmount?: number;
};

type AnalyticsTransactionInput = Omit<AnalyticsTransactionRecord, "id" | "createdAt"> & {
  id?: string;
  createdAt?: number;
};

const STORAGE_KEY = "pos_analytics_transactions_v1";
const MAX_RECORDS = 600;

export const ANALYTICS_PAYMENT_METHOD_LABEL: Record<AnalyticsPaymentMethod, string> = {
  cash: "Contanti",
  card: "Carta",
  voucher: "Buono pasto",
  satispay: "Satispay",
  suspended: "Conto sospeso",
  check: "Assegno",
  wire: "Bonifico",
  unknown: "Non specificato",
};

export const ANALYTICS_EVENT_LABEL: Record<AnalyticsEventKind, string> = {
  table_occupied: "Tavolo occupato",
  consumption: "Consumazione",
  payment: "Pagamento",
  table_freed: "Tavolo liberato",
  cash_float_locked: "Fondo cassa confermato",
};

const sanitizePositiveMoney = (value: unknown): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed * 100) / 100;
};

const sanitizeNonNegativeMoney = (value: unknown): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed * 100) / 100;
};

const sanitizeSignedMoney = (value: unknown): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed * 100) / 100;
};

const sanitizeString = (value: unknown, limit: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, limit);
};

const sanitizeBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  return undefined;
};

const sanitizeMethod = (value: unknown): AnalyticsPaymentMethod | undefined => {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return undefined;
  if (raw === "cash") return "cash";
  if (raw === "card") return "card";
  if (raw === "voucher") return "voucher";
  if (raw === "satispay") return "satispay";
  if (raw === "suspended") return "suspended";
  if (raw === "check") return "check";
  if (raw === "wire") return "wire";
  return "unknown";
};

const sanitizeKind = (value: unknown): AnalyticsEventKind | null => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "table_occupied") return "table_occupied";
  if (raw === "consumption") return "consumption";
  if (raw === "payment") return "payment";
  if (raw === "table_freed") return "table_freed";
  if (raw === "cash_float_locked") return "cash_float_locked";
  return null;
};

const sanitizePriceChangeReason = (value: unknown): AnalyticsPriceChangeReason | undefined => {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return undefined;
  if (raw === "variant") return "variant";
  if (raw === "manual") return "manual";
  if (raw === "supplement") return "supplement";
  return "unknown";
};

const sanitizeId = (value: unknown): string => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw) return raw.slice(0, 80);
  return `trx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const sanitizeCreatedAt = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now();
  return Math.trunc(parsed);
};

const sanitizeQty = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(99, Math.round(parsed)));
};

const normalizeOrderLine = (value: unknown): AnalyticsOrderLine | null => {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const name = sanitizeString(source.name, 120);
  if (!name) return null;

  const qty = sanitizeQty(source.qty);
  const unitBasePrice = sanitizeNonNegativeMoney(source.unitBasePrice);
  const unitFinalPrice = sanitizeNonNegativeMoney(source.unitFinalPrice);
  const priceDelta = sanitizeSignedMoney(source.priceDelta);
  const priceChangeReason = sanitizePriceChangeReason(source.priceChangeReason);
  const explicitPriceChanged = sanitizeBoolean(source.priceChanged);
  const priceChanged =
    explicitPriceChanged !== undefined
      ? explicitPriceChanged
      : Boolean((priceDelta !== undefined && Math.abs(priceDelta) > 0.0001) || priceChangeReason);

  return {
    name,
    qty,
    note: sanitizeString(source.note, 240),
    variantName: sanitizeString(source.variantName, 120),
    unitBasePrice,
    unitFinalPrice,
    priceDelta,
    priceChanged,
    priceChangeReason,
  };
};

const normalizeOrderLines = (value: unknown): AnalyticsOrderLine[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const lines = value
    .map(normalizeOrderLine)
    .filter((entry): entry is AnalyticsOrderLine => entry !== null)
    .slice(0, 50);
  return lines.length > 0 ? lines : undefined;
};

const normalizeRecord = (value: unknown): AnalyticsTransactionRecord | null => {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const kind = sanitizeKind(source.kind);
  if (!kind) return null;

  const tableNumberRaw = Number(source.tableNumber);
  const tableNumber =
    Number.isFinite(tableNumberRaw) && tableNumberRaw > 0 ? Math.trunc(tableNumberRaw) : undefined;

  return {
    id: sanitizeId(source.id),
    createdAt: sanitizeCreatedAt(source.createdAt),
    kind,
    tableId: sanitizeString(source.tableId, 80),
    tableNumber,
    customerName: sanitizeString(source.customerName, 80),
    operatorName: sanitizeString(source.operatorName, 80),
    operatorId: sanitizeString(source.operatorId, 80),
    shiftToken: sanitizeString(source.shiftToken, 160),
    description: sanitizeString(source.description, 200),
    amount: sanitizePositiveMoney(source.amount),
    paymentMethod: sanitizeMethod(source.paymentMethod),
    orderId: sanitizeString(source.orderId, 80),
    orderLines: normalizeOrderLines(source.orderLines),
    cashFloatAmount: sanitizeNonNegativeMoney(source.cashFloatAmount),
  };
};

const persist = (records: AnalyticsTransactionRecord[]) => {
  if (typeof window === "undefined") return;
  try {
    writeLocalPreference(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // ignore storage failures
  }
};

export const readAnalyticsTransactions = (): AnalyticsTransactionRecord[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = readLocalPreference(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeRecord)
      .filter((entry): entry is AnalyticsTransactionRecord => entry !== null)
      .sort((left, right) => right.createdAt - left.createdAt);
  } catch {
    return [];
  }
};

export const appendAnalyticsTransaction = (
  input: AnalyticsTransactionInput
): AnalyticsTransactionRecord => {
  const normalized = normalizeRecord({
    ...input,
    id: sanitizeId(input.id),
    createdAt: sanitizeCreatedAt(input.createdAt),
  });
  const fallback: AnalyticsTransactionRecord = {
    id: sanitizeId(input.id),
    createdAt: sanitizeCreatedAt(input.createdAt),
    kind: "consumption",
  };
  const nextRecord = normalized ?? fallback;
  const next = [nextRecord, ...readAnalyticsTransactions()].slice(0, MAX_RECORDS);
  persist(next);
  return nextRecord;
};
