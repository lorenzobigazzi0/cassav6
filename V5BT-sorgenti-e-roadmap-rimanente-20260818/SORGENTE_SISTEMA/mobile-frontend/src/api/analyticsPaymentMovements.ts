import { readAnalyticsTransactions } from "../utils/analyticsTransactions";
import { readRuntimeStorage } from "../utils/paymentSessionRuntime";
import {
  analyticsTokenPart,
  asAnalyticsRecord,
  buildAnalyticsMovementRecordsFromReport,
  buildLocalAnalyticsMovementRecords,
  canPrintAnalyticsMovement,
  maxAnalyticsTimestamp,
  normalizeAnalyticsFiscalReceipt,
  normalizeAnalyticsValue,
  parseAnalyticsTimestamp,
} from "./analyticsPaymentMovementModel";
import type {
  AnalyticsFiscalReceipt,
  AnalyticsMovementRecord,
} from "./analyticsPaymentMovementTypes";
import { apiFetch } from "./baseUrl";

export {
  analyticsMethodLabel,
  analyticsSplitModeLabel,
  analyticsTableLabel,
  applyFiscalReceiptToAnalyticsMovement,
  canPrintAnalyticsMovement,
  toAnalyticsMovementTime,
} from "./analyticsPaymentMovementModel";
export type {
  AnalyticsFiscalReceipt,
  AnalyticsMovementRecord,
  AnalyticsMovementTransaction,
  AnalyticsMovementType,
  AnalyticsRefundAllocation,
  AnalyticsRefundPlan,
} from "./analyticsPaymentMovementTypes";

const SALES_REPORT_PATH = "/api/reports/sales";
const REPRINT_PATH = "/api/reports/payment-movement/reprint";
const FISCAL_ISSUE_PATH = "/api/reports/payment-movement/fiscal/issue";
const FISCAL_VOID_PATH = "/api/reports/payment-movement/fiscal/void";
const SETTLEMENT_CUTOFF_PREFIX = "payment_settlement_cutoff_v1";
const RUNTIME_PREFIX = "mobile_payment_runtime_v1";
const USER_RUNTIME_PREFIX = "mobile_payment_user_runtime_v1";
const USER_RUNTIME_PREFIX_V2 = "mobile_payment_runtime_v2";

export type AnalyticsAuthContext = {
  token: string | null;
  userId: string | null;
  username?: string | null;
  fullName?: string | null;
  deviceUuid: string | null;
  sessionStartedAt?: number | null;
};

export type AnalyticsSessionContext = Required<
  Pick<AnalyticsAuthContext, "token" | "userId" | "deviceUuid">
> &
  Pick<AnalyticsAuthContext, "username" | "fullName"> & {
    sessionStartedAt: number;
    settlementCutoffAt: number;
  };

type SalesReportResponse = {
  ok?: unknown;
  report?: unknown;
  error?: unknown;
  message?: unknown;
};

const readJsonRuntime = (key: string) => {
  try {
    const parsed = JSON.parse(readRuntimeStorage(key) || "null");
    return parsed && typeof parsed === "object" ? asAnalyticsRecord(parsed) : null;
  } catch {
    return null;
  }
};

export const resolveAnalyticsSessionContext = (
  auth: AnalyticsAuthContext
): AnalyticsSessionContext => {
  const token = normalizeAnalyticsValue(auth.token);
  const userId = normalizeAnalyticsValue(auth.userId);
  const username = normalizeAnalyticsValue(auth.username);
  const fullName = normalizeAnalyticsValue(auth.fullName);
  const deviceUuid = normalizeAnalyticsValue(auth.deviceUuid);
  const userPart = analyticsTokenPart(userId || username, "anon");
  const devicePart = analyticsTokenPart(deviceUuid, "device");
  const runtime =
    userPart === "anon"
      ? null
      : readJsonRuntime(`${USER_RUNTIME_PREFIX_V2}:${userPart}`) ||
        readJsonRuntime(`${RUNTIME_PREFIX}:${userPart}:${devicePart || "device"}`) ||
        readJsonRuntime(`${USER_RUNTIME_PREFIX}:${userPart}`);
  const currentStartedAt = parseAnalyticsTimestamp(auth.sessionStartedAt);
  const storedStartedAt = parseAnalyticsTimestamp(readRuntimeStorage("pos_session_started_at"));
  const runtimeStartedAt = parseAnalyticsTimestamp(runtime?.sessionStartedAt);
  let sessionStartedAt = currentStartedAt || storedStartedAt || runtimeStartedAt || 0;
  if (runtimeStartedAt && (!sessionStartedAt || runtimeStartedAt < sessionStartedAt)) {
    sessionStartedAt = runtimeStartedAt;
  }
  const settlementCutoffAt = maxAnalyticsTimestamp([
    readRuntimeStorage(`${SETTLEMENT_CUTOFF_PREFIX}:${userPart}:${devicePart}`),
    readRuntimeStorage(`${SETTLEMENT_CUTOFF_PREFIX}:${userPart}:user`),
    readRuntimeStorage(
      `${SETTLEMENT_CUTOFF_PREFIX}:${analyticsTokenPart(userId, "anon")}:${analyticsTokenPart(token, "session")}`
    ),
  ]);

  return {
    token,
    userId,
    username,
    fullName,
    deviceUuid,
    sessionStartedAt,
    settlementCutoffAt,
  };
};

export const readLocalAnalyticsMovements = () =>
  buildLocalAnalyticsMovementRecords(readAnalyticsTransactions());

export const buildAnalyticsMovementRecords = (report: unknown): AnalyticsMovementRecord[] => {
  if (!report || typeof report !== "object") return readLocalAnalyticsMovements();
  return buildAnalyticsMovementRecordsFromReport(report);
};

const errorMessageFromPayload = (payload: SalesReportResponse | null, fallback: string) => {
  const message = normalizeAnalyticsValue(payload?.error || payload?.message);
  return message || fallback;
};

export async function fetchAnalyticsPaymentMovements(
  auth: AnalyticsSessionContext,
  signal?: AbortSignal
): Promise<AnalyticsMovementRecord[]> {
  if (!auth.token || !auth.userId || !auth.deviceUuid) return readLocalAnalyticsMovements();

  const response = await apiFetch(SALES_REPORT_PATH, {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
      "X-Device-Uuid": auth.deviceUuid,
      "X-User-Id": auth.userId,
    },
    body: JSON.stringify({
      token: auth.token,
      userId: auth.userId,
      deviceUuid: auth.deviceUuid,
    }),
  });

  const payload = (await response.json().catch(() => null)) as SalesReportResponse | null;
  if (!response.ok || payload?.ok !== true) {
    throw new Error(errorMessageFromPayload(payload, "Report pagamenti non disponibile."));
  }

  return buildAnalyticsMovementRecords(payload.report);
}

export async function printAnalyticsPaymentMovement(
  auth: AnalyticsSessionContext,
  record: AnalyticsMovementRecord,
  options: { advanced?: boolean; advancedDetails?: { label: string; value: string }[] } = {}
): Promise<void> {
  if (!canPrintAnalyticsMovement(record)) return;
  if (!auth.token || !auth.userId || !auth.deviceUuid) {
    throw new Error("Sessione non disponibile.");
  }

  const response = await apiFetch(REPRINT_PATH, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
      "X-Device-Uuid": auth.deviceUuid,
      "X-User-Id": auth.userId,
    },
    body: JSON.stringify({
      token: auth.token,
      userId: auth.userId,
      username: auth.username || "",
      deviceUuid: auth.deviceUuid,
      clientApp: "mobile-frontend",
      type: record.type,
      recordId: record.id,
      movementId: record.paymentId,
      advanced: options.advanced === true,
      advancedDetails: options.advancedDetails || [],
    }),
  });

  const payload = (await response.json().catch(() => null)) as SalesReportResponse | null;
  if (!response.ok || payload?.ok !== true) {
    throw new Error(errorMessageFromPayload(payload, "Stampa non riuscita."));
  }
}

async function requestAnalyticsFiscalAction(
  auth: AnalyticsSessionContext,
  record: AnalyticsMovementRecord,
  path: string,
  extra: Record<string, unknown> = {}
): Promise<AnalyticsFiscalReceipt> {
  if (!auth.token || !auth.userId || !auth.deviceUuid) {
    throw new Error("Sessione non disponibile.");
  }
  const response = await apiFetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
      "X-Device-Uuid": auth.deviceUuid,
      "X-User-Id": auth.userId,
    },
    body: JSON.stringify({
      token: auth.token,
      userId: auth.userId,
      username: auth.username || "",
      deviceUuid: auth.deviceUuid,
      clientApp: "mobile-frontend",
      movementId: record.paymentId,
      receiptId: normalizeAnalyticsValue(record.raw?.fiscalReceiptId),
      ...extra,
    }),
  });
  const payload = (await response.json().catch(() => null)) as
    | (SalesReportResponse & { receipt?: unknown })
    | null;
  if (!response.ok || payload?.ok !== true || !payload.receipt) {
    throw new Error(errorMessageFromPayload(payload, "Operazione fiscale non riuscita."));
  }
  return normalizeAnalyticsFiscalReceipt(payload.receipt);
}

export const issueAnalyticsFiscalMovement = (
  auth: AnalyticsSessionContext,
  record: AnalyticsMovementRecord
) => requestAnalyticsFiscalAction(auth, record, FISCAL_ISSUE_PATH);

export const voidAnalyticsFiscalMovement = (
  auth: AnalyticsSessionContext,
  record: AnalyticsMovementRecord
) =>
  requestAnalyticsFiscalAction(auth, record, FISCAL_VOID_PATH, {
    reason: "Annullamento da dettaglio pagamento",
  });
