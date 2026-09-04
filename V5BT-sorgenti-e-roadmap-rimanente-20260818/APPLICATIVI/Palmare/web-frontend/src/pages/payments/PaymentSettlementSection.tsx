import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { apiFetch } from "../../api/baseUrl";
import {
  getAutomaticCashSettings,
  getLatestAutomaticCashSettlementRecord,
  saveAutomaticCashSettlementRecordToDb,
} from "../../api/automaticCash";
import {
  removePaymentRuntimeStorage,
  writePaymentRuntimeStorage,
} from "../../shared/storage/paymentSessionStorage";
import { formatCurrency } from "../../shared/format/currency";
import {
  isClientOptimisticActionsEnabled,
  runBackgroundOptimisticRequest,
} from "../../shared/optimistic/clientOptimisticActions";
import { useAuthStore } from "../../store/authStore";
import { usePaymentSettingsStore } from "../../store/paymentSettingsStore";
import { getOrCreateDeviceUuid } from "../../utils/device";
import {
  PAYMENT_CASH_FLOAT_KEY,
  PAYMENT_CASH_FLOAT_LOCKED_KEY,
  PAYMENT_POS_ID_KEY,
  clearMobilePaymentRuntime,
  readRuntimeStorage,
} from "../../utils/paymentSessionRuntime";
import {
  readAnalyticsTransactions,
  type AnalyticsTransactionRecord,
} from "../../utils/analyticsTransactions";
import {
  readLatestAutomaticCashSettlementRecord,
  saveAutomaticCashSettlementRecord,
  type AutomaticCashSettlementRecord,
} from "../../utils/automaticCashSettlementArchive";
import { updateAutomaticCashTicketRecordStatus } from "../../utils/automaticCashTicketRegistry";
import { triggerLongPressHaptic } from "../../utils/haptics";
import {
  fetchAnalyticsPaymentMovements,
  resolveAnalyticsSessionContext,
  type AnalyticsMovementRecord,
} from "../../api/analyticsPaymentMovements";
import {
  HANDHELD_CASH_SESSION_CLOSE_PATH,
  NON_FISCALIZED_REPORT_PATH,
  SETTLEMENT_PRINT_PATH,
  SETTLEMENT_ROOM_CHANGE_APPROVE_PATH,
  SETTLEMENT_ROOM_CHANGE_CANCEL_PATH,
  SETTLEMENT_ROOM_CHANGE_REQUEST_PATH,
} from "../../api/paymentSettlementEndpoints";
import type { CashFloatMode } from "../../types/automaticCash";
import {
  AutomaticSettlementWizard,
  type AutomaticSettlementResult,
} from "./AutomaticSettlementWizard";
import type { AutomaticSettlementContext } from "./automaticSettlementModel";
import { buildSettlementLedgerEntries, summarizeSettlementLedger } from "./settlementLedger";

const SETTLEMENT_CUTOFF_PREFIX = "payment_settlement_cutoff_v1";
const SETTLEMENT_SUMMARY_PREFIX = "payment_settlement_summary_v1";
const SETTLEMENT_MODE_HOLD_MS = 650;
const POS_LABELS: Record<string, string> = {
  pos_main: "POS Cassa Principale",
  pos_terrace: "POS Terrazza",
  pos_mobile: "POS Mobile",
};

type PaymentSettlementContext = {
  token: string;
  userId: string;
  username: string;
  fullName: string;
  activityId: string;
  roomId: string;
  roomName: string;
  sessionStartedAt: number;
  deviceUuid: string;
  posId: string;
  cashMode: CashFloatMode;
  cashFloat: number;
  cashFloatLocked: boolean;
  autoCashFloatId: string | null;
  autoCashFloatAssignmentId: string | null;
  autoCashFloatCombinationId: string | null;
  autoCashFloatBusinessEveningKey: string | null;
};

type PendingRoomBill = {
  id: string;
  number: number;
  amountDue: number;
};

type PendingRoomBills = {
  roomId: string;
  roomName: string;
  count: number;
  totalDue: number;
  tables: PendingRoomBill[];
};

type NonFiscalizedReportItem = {
  receiptId: string;
  paymentId: string;
  transactionId: string;
  orderId: string | null;
  tableLabel: string;
  method: "pos" | "cash";
  methodLabel: string;
  amount: number;
  createdAtMs: number;
  createdAt: string;
  fiscalStatus: string;
  fiscalError: string | null;
  retryCutoffAt: string | null;
};

type NonFiscalizedReport = {
  generatedAt: string;
  retryCutoffHour: number;
  count: number;
  total: number;
  posCount: number;
  posTotal: number;
  cashCount: number;
  cashTotal: number;
  items: NonFiscalizedReportItem[];
};

type SettlementAuthorization = {
  approved: true;
  approverUsername: string;
  approverRole: string;
  approverLabel: string;
  approvedAtMs: number;
};

type PaymentSettlementSnapshot = {
  context: PaymentSettlementContext;
  cutoffMs: number;
  generatedAtMs: number;
  paymentCount: number;
  lastPaymentAt: number;
  posLabel: string;
  cashMode: CashFloatMode;
  cashFloat: number;
  cashFloatLocked: boolean;
  cashTotal: number;
  posTotal: number;
  otherTotal: number;
  totalAmount: number;
  grossPaymentTotal: number;
  refundTotal: number;
  cashGrossTotal: number;
  posGrossTotal: number;
  otherGrossTotal: number;
  cashRefundTotal: number;
  posRefundTotal: number;
  otherRefundTotal: number;
  posRechargeTotal: number;
  automaticCashTotal: number;
  ledgerMovementCount: number;
  drawerGross: number;
  amountToDeposit: number;
  station: string;
  pendingRoomBills?: PendingRoomBills;
  nonFiscalizedReport?: NonFiscalizedReport;
  authorization?: SettlementAuthorization;
};

type SettlementSummary = {
  completedAtMs: number;
  generatedAtMs: number;
  automaticSettlement: boolean;
  posLabel: string;
  paymentCount: number;
  cashMode: CashFloatMode;
  cashFloat: number;
  cashTotal: number;
  posTotal: number;
  otherTotal: number;
  totalAmount: number;
  grossPaymentTotal: number;
  refundTotal: number;
  cashGrossTotal: number;
  posGrossTotal: number;
  otherGrossTotal: number;
  cashRefundTotal: number;
  posRefundTotal: number;
  otherRefundTotal: number;
  posRechargeTotal: number;
  automaticCashTotal: number;
  ledgerMovementCount: number;
  drawerGross: number;
  amountToDeposit: number;
  authorizationRequired: boolean;
  authorizationApprover: string;
  authorizationRoomName: string;
  authorizationPendingCount: number;
  authorizationPendingTotal: number;
};

type AutomaticWizardState = {
  open: boolean;
  loading: boolean;
  snapshot: PaymentSettlementSnapshot | null;
};

type SettlementLaunchMode = "automatic" | "manual";

type AutomaticCashFeedbackSettings = {
  feedbackEnabled: boolean;
  warningThresholdCents?: number;
  dangerThresholdCents?: number;
};

type SettlementCompletionResult = {
  completedAtMs: number;
  printText: string;
  automaticRecord: AutomaticCashSettlementRecord | null;
};

type ModalPhase = "confirm" | "pending-warning" | "authorize" | "completed";

type ModalState = {
  open: boolean;
  phase: ModalPhase;
  printing: boolean;
  finishing: boolean;
  error: string;
  printedAtLabel: string;
  completedAtLabel: string;
  authRequestId: string;
  authUsername: string;
  authPin: string;
  authBusy: boolean;
  snapshot: PaymentSettlementSnapshot | null;
};

type RoomChangeRequestResponse = {
  ok?: unknown;
  status?: unknown;
  requestId?: unknown;
  error?: unknown;
  message?: unknown;
  approver?: {
    username?: unknown;
    role?: unknown;
    label?: unknown;
  };
};

const emptyModalState: ModalState = {
  open: false,
  phase: "confirm",
  printing: false,
  finishing: false,
  error: "",
  printedAtLabel: "",
  completedAtLabel: "",
  authRequestId: "",
  authUsername: "",
  authPin: "",
  authBusy: false,
  snapshot: null,
};

const emptyAutomaticWizardState: AutomaticWizardState = {
  open: false,
  loading: false,
  snapshot: null,
};

const emptyAutomaticCashFeedbackSettings: AutomaticCashFeedbackSettings = {
  feedbackEnabled: false,
};

const normalize = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeComparableName = (value: unknown) =>
  normalize(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const roundMoney = (value: unknown) => Math.round((Number(value) || 0) * 100) / 100;

const moneyToCents = (value: unknown) => Math.max(0, Math.round(roundMoney(value) * 100));

const resolveSettlementAmountToDeposit = (
  cashMode: CashFloatMode,
  cashFloatLocked: boolean,
  cashTotal: number,
  cashFloat: number
) => {
  if (cashMode === "auto" && cashFloatLocked) {
    return roundMoney(cashTotal + cashFloat);
  }
  return roundMoney(Math.max(cashTotal, 0));
};

const settlementVisibleAmountLabel = (amount: number, automaticSettlement = false) =>
  automaticSettlement ? "Automatico" : formatCurrency(amount);

const resolveCompletedAmountToDeposit = (
  snapshot: Pick<PaymentSettlementSnapshot, "amountToDeposit">,
  automaticResult?: Pick<AutomaticSettlementResult, "expectedDepositTotalCents">
) =>
  automaticResult
    ? roundMoney(automaticResult.expectedDepositTotalCents / 100)
    : snapshot.amountToDeposit;

type SettlementLedgerDisplayTotals = Pick<
  PaymentSettlementSnapshot,
  | "grossPaymentTotal"
  | "refundTotal"
  | "cashGrossTotal"
  | "posGrossTotal"
  | "otherGrossTotal"
  | "cashRefundTotal"
  | "posRefundTotal"
  | "otherRefundTotal"
  | "posRechargeTotal"
  | "automaticCashTotal"
  | "ledgerMovementCount"
  | "cashTotal"
  | "posTotal"
  | "otherTotal"
  | "totalAmount"
>;

const hasSettlementLedgerDiagnostics = (snapshot: SettlementLedgerDisplayTotals) =>
  snapshot.ledgerMovementCount > 0 || snapshot.grossPaymentTotal > 0 || snapshot.refundTotal > 0;

const settlementDisplayTotals = (snapshot: SettlementLedgerDisplayTotals) => {
  if (hasSettlementLedgerDiagnostics(snapshot)) {
    return {
      grossPaymentTotal: snapshot.grossPaymentTotal,
      refundTotal: snapshot.refundTotal,
      cashGrossTotal: snapshot.cashGrossTotal,
      posGrossTotal: snapshot.posGrossTotal,
      otherGrossTotal: snapshot.otherGrossTotal,
      cashRefundTotal: snapshot.cashRefundTotal,
      posRefundTotal: snapshot.posRefundTotal,
      otherRefundTotal: snapshot.otherRefundTotal,
      posRechargeTotal: snapshot.posRechargeTotal,
      automaticCashTotal: snapshot.automaticCashTotal,
      ledgerMovementCount: snapshot.ledgerMovementCount,
    };
  }
  return {
    grossPaymentTotal: Math.max(snapshot.totalAmount, 0),
    refundTotal: 0,
    cashGrossTotal: Math.max(snapshot.cashTotal, 0),
    posGrossTotal: Math.max(snapshot.posTotal, 0),
    otherGrossTotal: Math.max(snapshot.otherTotal, 0),
    cashRefundTotal: 0,
    posRefundTotal: 0,
    otherRefundTotal: 0,
    posRechargeTotal: 0,
    automaticCashTotal: 0,
    ledgerMovementCount: 0,
  };
};

const formatRefundCurrency = (amount: number) => {
  const safeAmount = roundMoney(amount);
  return safeAmount > 0 ? `-${formatCurrency(safeAmount)}` : formatCurrency(0);
};

const parseMoney = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== "string") return Number.NaN;
  const compact = value
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^\d,.-]/g, "");
  if (!compact) return Number.NaN;
  const normalized =
    compact.includes(",") && compact.includes(".")
      ? compact.replace(/\./g, "").replace(/,/g, ".")
      : compact.replace(/,/g, ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const resolveTimestamp = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return Math.trunc(value);
    if (value > 1_000_000_000) return Math.trunc(value * 1000);
    return Number.NaN;
  }
  const raw = normalize(value);
  if (!raw) return Number.NaN;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return resolveTimestamp(numeric);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const tokenPart = (value: unknown, fallback: string) => {
  const normalized = normalize(value)
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || fallback).slice(0, 40);
};

const readStoredValue = (key: string) => readRuntimeStorage(key);

const writeStoredValue = (key: string, value: string) => {
  writePaymentRuntimeStorage(key, value);
};

const removeStoredValue = (key: string) => {
  removePaymentRuntimeStorage(key);
};

const settlementCutoffKey = (context: PaymentSettlementContext) =>
  `${SETTLEMENT_CUTOFF_PREFIX}:${tokenPart(context.userId || context.username, "anon")}:${tokenPart(context.deviceUuid, "device")}`;

const settlementUserCutoffKey = (context: PaymentSettlementContext) =>
  `${SETTLEMENT_CUTOFF_PREFIX}:${tokenPart(context.userId || context.username, "anon")}:user`;

const settlementCutoffKeys = (context: PaymentSettlementContext) =>
  Array.from(new Set([settlementCutoffKey(context), settlementUserCutoffKey(context)]));

const legacySettlementCutoffKey = (context: PaymentSettlementContext) =>
  `${SETTLEMENT_CUTOFF_PREFIX}:${tokenPart(context.userId, "anon")}:${tokenPart(context.token, "session")}`;

const settlementSummaryKey = (context: PaymentSettlementContext) =>
  `${SETTLEMENT_SUMMARY_PREFIX}:${tokenPart(context.userId || context.username, "anon")}:${tokenPart(context.deviceUuid, "device")}`;

const readStoredTimestamp = (key: string) =>
  ((timestamp) => (Number.isFinite(timestamp) ? timestamp : 0))(
    resolveTimestamp(readStoredValue(key))
  );
const readSettlementCutoff = (context: PaymentSettlementContext) =>
  Math.max(
    ...settlementCutoffKeys(context).map(readStoredTimestamp),
    readStoredTimestamp(legacySettlementCutoffKey(context)),
    0
  );

const dateTimeLabel = (timestampMs: number) => {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "--";
  try {
    return new Intl.DateTimeFormat("it-IT", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(timestampMs);
  } catch {
    return new Date(timestampMs).toLocaleString("it-IT");
  }
};

const resolvePosLabel = (posId: string) => POS_LABELS[posId] || posId || "Nessun POS";

const resolveRecordMethod = (record: AnalyticsTransactionRecord) => {
  const method = normalize(record.paymentMethod).toLowerCase();
  if (method === "cash" || method.includes("contant") || method.includes("cash")) return "cash";
  if (method === "card" || method === "pos" || method.includes("carta") || method.includes("card"))
    return "pos";
  return "other";
};

const recordMatchesSettlement = (
  record: AnalyticsTransactionRecord,
  context: PaymentSettlementContext,
  cutoffMs: number
) => {
  if (record.kind !== "payment") return false;
  const amount = Number(record.amount);
  if (!Number.isFinite(amount) || amount <= 0) return false;

  const operatorId = normalize(record.operatorId);
  if (context.userId && operatorId && operatorId !== context.userId) return false;

  if (!operatorId && (context.fullName || context.username)) {
    const recordName = normalizeComparableName(record.operatorName);
    if (recordName) {
      const ctxFullName = normalizeComparableName(context.fullName);
      const ctxUsername = normalizeComparableName(context.username);
      if (recordName !== ctxFullName && recordName !== ctxUsername) return false;
    }
  }

  if (
    context.token &&
    record.shiftToken &&
    record.shiftToken !== context.token &&
    !operatorId &&
    !record.operatorName
  ) {
    return false;
  }

  if (cutoffMs && record.createdAt && record.createdAt < cutoffMs) return false;
  return true;
};

const buildLocalSettlementSnapshot = (
  context: PaymentSettlementContext
): PaymentSettlementSnapshot => {
  const storedCutoff = readSettlementCutoff(context);
  const cutoffMs = Math.max(context.sessionStartedAt || 0, storedCutoff);
  const records = readAnalyticsTransactions().filter((record) =>
    recordMatchesSettlement(record, context, cutoffMs)
  );

  let cashTotal = 0;
  let posTotal = 0;
  let otherTotal = 0;
  let lastPaymentAt = 0;

  records.forEach((record) => {
    const amount = roundMoney(record.amount);
    const method = resolveRecordMethod(record);
    if (record.createdAt > lastPaymentAt) lastPaymentAt = record.createdAt;
    if (method === "cash") cashTotal += amount;
    else if (method === "pos") posTotal += amount;
    else otherTotal += amount;
  });

  cashTotal = roundMoney(cashTotal);
  posTotal = roundMoney(posTotal);
  otherTotal = roundMoney(otherTotal);
  const totalAmount = roundMoney(cashTotal + posTotal + otherTotal);
  const cashFloat = roundMoney(context.cashFloat);
  const drawerGross = roundMoney(cashFloat + cashTotal);
  const amountToDeposit = resolveSettlementAmountToDeposit(
    context.cashMode,
    context.cashFloatLocked,
    cashTotal,
    cashFloat
  );

  return {
    context,
    cutoffMs,
    generatedAtMs: Date.now(),
    paymentCount: records.length,
    lastPaymentAt,
    posLabel: resolvePosLabel(context.posId),
    cashMode: context.cashMode,
    cashFloat,
    cashFloatLocked: context.cashFloatLocked,
    cashTotal,
    posTotal,
    otherTotal,
    totalAmount,
    grossPaymentTotal: 0,
    refundTotal: 0,
    cashGrossTotal: 0,
    posGrossTotal: 0,
    otherGrossTotal: 0,
    cashRefundTotal: 0,
    posRefundTotal: 0,
    otherRefundTotal: 0,
    posRechargeTotal: 0,
    automaticCashTotal: 0,
    ledgerMovementCount: 0,
    drawerGross,
    amountToDeposit,
    station: context.activityId,
  };
};

const movementMatchesSettlement = (
  record: AnalyticsMovementRecord,
  context: PaymentSettlementContext,
  cutoffMs: number
) => {
  if (record.type !== "payment" && record.type !== "storno" && record.type !== "replacement") {
    return false;
  }
  const amount = Number(record.amount);
  if (!Number.isFinite(amount) || amount === 0) return false;
  if (cutoffMs && record.createdAt && record.createdAt < cutoffMs) return false;

  const operatorId = normalize(record.operatorId);
  if (context.userId && operatorId && operatorId !== context.userId) return false;

  if (!operatorId && (context.fullName || context.username)) {
    const recordName = normalizeComparableName(record.operatorName);
    if (recordName) {
      const ctxFullName = normalizeComparableName(context.fullName);
      const ctxUsername = normalizeComparableName(context.username);
      if (recordName !== ctxFullName && recordName !== ctxUsername) return false;
    }
  }

  return true;
};

const buildSettlementSnapshotFromMovements = (
  context: PaymentSettlementContext,
  movements: AnalyticsMovementRecord[],
  cutoffMs: number
): PaymentSettlementSnapshot => {
  const records = movements.filter((record) =>
    movementMatchesSettlement(record, context, cutoffMs)
  );
  const ledgerEntries = buildSettlementLedgerEntries(records);
  const ledgerSummary = summarizeSettlementLedger(ledgerEntries);
  const lastPaymentAt = records.reduce(
    (latest, record) => Math.max(latest, Number(record.createdAt) || 0),
    0
  );

  const automaticCashTotal = roundMoney(ledgerSummary.automaticCashTotal);
  const cashTotal = roundMoney(ledgerSummary.cashDepositNetTotal);
  const posTotal = roundMoney(ledgerSummary.net.pos);
  const otherTotal = roundMoney(ledgerSummary.net.other);
  const totalAmount = roundMoney(ledgerSummary.netTotal);
  const cashFloat = roundMoney(context.cashFloat);
  const drawerGross = roundMoney(cashFloat + cashTotal);
  const amountToDeposit = resolveSettlementAmountToDeposit(
    context.cashMode,
    context.cashFloatLocked,
    cashTotal,
    cashFloat
  );

  return {
    context,
    cutoffMs,
    generatedAtMs: Date.now(),
    paymentCount: records.length,
    lastPaymentAt,
    posLabel: resolvePosLabel(context.posId),
    cashMode: context.cashMode,
    cashFloat,
    cashFloatLocked: context.cashFloatLocked,
    cashTotal,
    posTotal,
    otherTotal,
    totalAmount,
    grossPaymentTotal: roundMoney(ledgerSummary.grossTotal),
    refundTotal: roundMoney(ledgerSummary.refundTotal),
    cashGrossTotal: roundMoney(ledgerSummary.cashDepositGrossTotal),
    posGrossTotal: roundMoney(ledgerSummary.gross.pos),
    otherGrossTotal: roundMoney(ledgerSummary.gross.other),
    cashRefundTotal: roundMoney(ledgerSummary.refunds.cash),
    posRefundTotal: roundMoney(ledgerSummary.refunds.pos),
    otherRefundTotal: roundMoney(ledgerSummary.refunds.other),
    posRechargeTotal: roundMoney(ledgerSummary.posRechargeTotal),
    automaticCashTotal,
    ledgerMovementCount: ledgerSummary.entryCount,
    drawerGross,
    amountToDeposit,
    station: context.activityId,
  };
};

const normalizeNonFiscalizedReport = (payload: unknown): NonFiscalizedReport | undefined => {
  const report =
    payload && typeof payload === "object" && "report" in payload
      ? (payload as { report?: unknown }).report
      : payload;
  if (!report || typeof report !== "object") return undefined;
  const raw = report as Record<string, unknown>;
  const items = Array.isArray(raw.items)
    ? raw.items
        .map((entry) => {
          const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
          const method = normalize(item.method).toLowerCase() === "cash" ? "cash" : "pos";
          return {
            receiptId: normalize(item.receiptId),
            paymentId: normalize(item.paymentId),
            transactionId: normalize(item.transactionId),
            orderId: normalize(item.orderId) || null,
            tableLabel: normalize(item.tableLabel),
            method,
            methodLabel: normalize(item.methodLabel) || (method === "cash" ? "Contanti" : "POS"),
            amount: roundMoney(item.amount),
            createdAtMs: resolveTimestamp(item.createdAtMs ?? item.createdAt),
            createdAt: normalize(item.createdAt),
            fiscalStatus: normalize(item.fiscalStatus),
            fiscalError: normalize(item.fiscalError) || null,
            retryCutoffAt: normalize(item.retryCutoffAt) || null,
          } satisfies NonFiscalizedReportItem;
        })
        .filter((item) => item.amount > 0)
    : [];
  return {
    generatedAt: normalize(raw.generatedAt),
    retryCutoffHour: Math.max(0, Math.trunc(Number(raw.retryCutoffHour) || 5)),
    count: Math.max(0, Math.trunc(Number(raw.count) || items.length)),
    total: roundMoney(raw.total),
    posCount: Math.max(
      0,
      Math.trunc(Number(raw.posCount) || items.filter((item) => item.method === "pos").length)
    ),
    posTotal: roundMoney(raw.posTotal),
    cashCount: Math.max(
      0,
      Math.trunc(Number(raw.cashCount) || items.filter((item) => item.method === "cash").length)
    ),
    cashTotal: roundMoney(raw.cashTotal),
    items,
  };
};

const fetchNonFiscalizedReport = async (
  context: PaymentSettlementContext,
  cutoffMs: number
): Promise<NonFiscalizedReport | undefined> => {
  if (!context.token || !context.userId || !context.deviceUuid) return undefined;
  const response = await apiFetch(NON_FISCALIZED_REPORT_PATH, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${context.token}`,
      "X-User-Id": context.userId,
      "X-Device-Uuid": context.deviceUuid,
    },
    body: JSON.stringify({
      token: context.token,
      userId: context.userId,
      deviceUuid: context.deviceUuid,
      sinceMs: cutoffMs,
      expiredOnly: true,
      clientApp: "mobile-frontend",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) return undefined;
  return normalizeNonFiscalizedReport(payload);
};

const withNonFiscalizedReport = async (
  snapshot: PaymentSettlementSnapshot,
  cutoffMs: number
): Promise<PaymentSettlementSnapshot> => {
  try {
    const report = await fetchNonFiscalizedReport(snapshot.context, cutoffMs);
    return report ? { ...snapshot, nonFiscalizedReport: report } : snapshot;
  } catch {
    return snapshot;
  }
};

const buildSettlementSnapshot = async (
  context: PaymentSettlementContext
): Promise<PaymentSettlementSnapshot> => {
  const analyticsContext = resolveAnalyticsSessionContext(context);
  const runtimeContext = {
    ...context,
    sessionStartedAt: analyticsContext.sessionStartedAt || context.sessionStartedAt,
  };
  const fallback = buildLocalSettlementSnapshot(runtimeContext);
  if (!analyticsContext.token || !analyticsContext.userId || !analyticsContext.deviceUuid) {
    return withNonFiscalizedReport(fallback, fallback.cutoffMs);
  }

  try {
    const movements = await fetchAnalyticsPaymentMovements(analyticsContext);
    const cutoffMs = Math.max(
      runtimeContext.sessionStartedAt || 0,
      analyticsContext.settlementCutoffAt || 0
    );
    const snapshot = buildSettlementSnapshotFromMovements(runtimeContext, movements, cutoffMs);
    return withNonFiscalizedReport(snapshot, cutoffMs);
  } catch {
    return withNonFiscalizedReport(fallback, fallback.cutoffMs);
  }
};

const readSettlementSummary = (context: PaymentSettlementContext): SettlementSummary | null => {
  const rawValue = readStoredValue(settlementSummaryKey(context));
  if (!rawValue) return null;
  try {
    const parsed = JSON.parse(rawValue) as Partial<SettlementSummary>;
    if (!parsed || typeof parsed !== "object") return null;
    const completedAtMs = resolveTimestamp(parsed.completedAtMs);
    const parsedCashMode: CashFloatMode = normalize(parsed.cashMode) === "auto" ? "auto" : "manual";
    const hasAutomaticSettlementFlag = Object.prototype.hasOwnProperty.call(
      parsed,
      "automaticSettlement"
    );
    return {
      completedAtMs: Number.isFinite(completedAtMs) ? completedAtMs : 0,
      generatedAtMs: resolveTimestamp(parsed.generatedAtMs),
      automaticSettlement: hasAutomaticSettlementFlag
        ? parsed.automaticSettlement === true
        : parsedCashMode === "auto",
      posLabel: normalize(parsed.posLabel) || "Nessun POS",
      paymentCount: Math.max(0, Math.trunc(Number(parsed.paymentCount) || 0)),
      cashMode: parsedCashMode,
      cashFloat: roundMoney(parsed.cashFloat),
      cashTotal: roundMoney(parsed.cashTotal),
      posTotal: roundMoney(parsed.posTotal),
      otherTotal: roundMoney(parsed.otherTotal),
      totalAmount: roundMoney(parsed.totalAmount),
      grossPaymentTotal: roundMoney(parsed.grossPaymentTotal),
      refundTotal: roundMoney(parsed.refundTotal),
      cashGrossTotal: roundMoney(parsed.cashGrossTotal),
      posGrossTotal: roundMoney(parsed.posGrossTotal),
      otherGrossTotal: roundMoney(parsed.otherGrossTotal),
      cashRefundTotal: roundMoney(parsed.cashRefundTotal),
      posRefundTotal: roundMoney(parsed.posRefundTotal),
      otherRefundTotal: roundMoney(parsed.otherRefundTotal),
      posRechargeTotal: roundMoney(parsed.posRechargeTotal),
      automaticCashTotal: roundMoney(parsed.automaticCashTotal),
      ledgerMovementCount: Math.max(0, Math.trunc(Number(parsed.ledgerMovementCount) || 0)),
      drawerGross: roundMoney(parsed.drawerGross),
      amountToDeposit: roundMoney(parsed.amountToDeposit),
      authorizationRequired: parsed.authorizationRequired === true,
      authorizationApprover: normalize(parsed.authorizationApprover),
      authorizationRoomName: normalize(parsed.authorizationRoomName),
      authorizationPendingCount: Math.max(
        0,
        Math.trunc(Number(parsed.authorizationPendingCount) || 0)
      ),
      authorizationPendingTotal: roundMoney(parsed.authorizationPendingTotal),
    };
  } catch {
    return null;
  }
};

const persistSettlementSummary = (
  snapshot: PaymentSettlementSnapshot,
  completedAtMs: number,
  options: { automaticSettlement?: boolean; amountToDeposit?: number } = {}
) => {
  writeStoredValue(
    settlementSummaryKey(snapshot.context),
    JSON.stringify({
      completedAtMs,
      generatedAtMs: snapshot.generatedAtMs,
      automaticSettlement: options.automaticSettlement === true,
      posLabel: snapshot.posLabel,
      paymentCount: snapshot.paymentCount,
      cashMode: snapshot.cashMode,
      cashFloat: snapshot.cashFloat,
      cashTotal: snapshot.cashTotal,
      posTotal: snapshot.posTotal,
      otherTotal: snapshot.otherTotal,
      totalAmount: snapshot.totalAmount,
      grossPaymentTotal: snapshot.grossPaymentTotal,
      refundTotal: snapshot.refundTotal,
      cashGrossTotal: snapshot.cashGrossTotal,
      posGrossTotal: snapshot.posGrossTotal,
      otherGrossTotal: snapshot.otherGrossTotal,
      cashRefundTotal: snapshot.cashRefundTotal,
      posRefundTotal: snapshot.posRefundTotal,
      otherRefundTotal: snapshot.otherRefundTotal,
      posRechargeTotal: snapshot.posRechargeTotal,
      automaticCashTotal: snapshot.automaticCashTotal,
      ledgerMovementCount: snapshot.ledgerMovementCount,
      drawerGross: snapshot.drawerGross,
      amountToDeposit: roundMoney(options.amountToDeposit ?? snapshot.amountToDeposit),
      authorizationRequired: snapshot.authorization?.approved === true,
      authorizationApprover: normalize(snapshot.authorization?.approverLabel),
      authorizationRoomName: normalize(snapshot.pendingRoomBills?.roomName),
      authorizationPendingCount: Math.max(
        0,
        Math.trunc(Number(snapshot.pendingRoomBills?.count) || 0)
      ),
      authorizationPendingTotal: roundMoney(snapshot.pendingRoomBills?.totalDue),
    })
  );
};

const clearSettlementSummary = (context: PaymentSettlementContext) =>
  removeStoredValue(settlementSummaryKey(context));

const padLine = (left: string, right: string, width: number) => {
  const safeLeft = normalize(left);
  const safeRight = normalize(right);
  const minGap = 2;
  if (!safeRight) return safeLeft.slice(0, width);
  const maxLeft = Math.max(0, width - safeRight.length - minGap);
  const finalLeft = safeLeft.length > maxLeft ? safeLeft.slice(0, maxLeft) : safeLeft;
  const spaces = Math.max(minGap, width - finalLeft.length - safeRight.length);
  return `${finalLeft}${" ".repeat(spaces)}${safeRight}`;
};

const centerLine = (value: string, width: number) => {
  const safe = normalize(value).slice(0, width);
  const leftPad = Math.max(0, Math.floor((width - safe.length) / 2));
  return `${" ".repeat(leftPad)}${safe}`;
};

const automaticFeedbackPrintLabel = (feedbackKind: AutomaticSettlementResult["feedbackKind"]) => {
  if (feedbackKind === "happy") return "OK";
  if (feedbackKind === "sad") return "DIFFERENZA ENTRO SOGLIA";
  return "DIFFERENZA OLTRE SOGLIA";
};

const buildPrintText = (
  snapshot: PaymentSettlementSnapshot,
  automaticResult?: AutomaticSettlementResult
) => {
  const width = 42;
  const divider = "-".repeat(width);
  const isAutomaticSettlement = Boolean(automaticResult);
  const cashFloatLabel = settlementVisibleAmountLabel(snapshot.cashFloat, isAutomaticSettlement);
  const drawerGrossLabel = settlementVisibleAmountLabel(
    snapshot.drawerGross,
    isAutomaticSettlement
  );
  const amountToDepositLabel = settlementVisibleAmountLabel(
    snapshot.amountToDeposit,
    isAutomaticSettlement
  );
  const ledgerTotals = settlementDisplayTotals(snapshot);
  const hasLedger = hasSettlementLedgerDiagnostics(snapshot);
  const lines = [
    centerLine("SCARICO CASSA", width),
    "",
    padLine(
      "OPERATORE",
      snapshot.context.fullName || snapshot.context.username || "Operatore",
      width
    ),
    padLine("POS", snapshot.posLabel, width),
    dateTimeLabel(snapshot.generatedAtMs),
    divider,
    padLine("INCASSO LORDO", formatCurrency(ledgerTotals.grossPaymentTotal), width),
    padLine("RESI/STORNI", formatRefundCurrency(ledgerTotals.refundTotal), width),
    padLine("TOTALE NETTO", formatCurrency(snapshot.totalAmount), width),
    divider,
    padLine("CONTANTI LORDI", formatCurrency(ledgerTotals.cashGrossTotal), width),
    padLine("RESI CONTANTI", formatRefundCurrency(ledgerTotals.cashRefundTotal), width),
    padLine("CONTANTI NETTI", formatCurrency(snapshot.cashTotal), width),
    ...(ledgerTotals.automaticCashTotal > 0
      ? [padLine("CASSA AUTOMATICA", formatCurrency(ledgerTotals.automaticCashTotal), width)]
      : []),
    padLine("POS LORDO", formatCurrency(ledgerTotals.posGrossTotal), width),
    padLine("VOID/STORNI POS", formatRefundCurrency(ledgerTotals.posRefundTotal), width),
    padLine("RIADDEBITI POS", formatCurrency(ledgerTotals.posRechargeTotal), width),
    padLine("POS NETTO", formatCurrency(snapshot.posTotal), width),
    padLine("ALTRE FORME NETTE", formatCurrency(snapshot.otherTotal), width),
    divider,
    padLine("FONDO CASSA", cashFloatLabel, width),
    padLine("CASSA LORDA", drawerGrossLabel, width),
    padLine("DA VERSARE", amountToDepositLabel, width),
    divider,
    padLine(
      hasLedger ? "MOVIMENTI LEDGER" : "MOVIMENTI",
      String(hasLedger ? ledgerTotals.ledgerMovementCount : snapshot.paymentCount),
      width
    ),
  ];

  if (Number.isFinite(snapshot.lastPaymentAt) && snapshot.lastPaymentAt > 0) {
    lines.push(padLine("ULTIMO INCASSO", dateTimeLabel(snapshot.lastPaymentAt), width));
  }

  if (snapshot.authorization?.approved && Number(snapshot.pendingRoomBills?.count) > 0) {
    const pendingTables = snapshot.pendingRoomBills?.tables || [];
    const tableList = pendingTables
      .slice(0, 8)
      .map((entry) => (entry.number > 0 ? String(entry.number) : "?"))
      .join(", ");
    lines.push(
      divider,
      "AUTORIZZAZIONE SCARICO",
      padLine(
        "SALA",
        snapshot.pendingRoomBills?.roomName || snapshot.context.roomName || "Sala",
        width
      ),
      padLine("TAVOLI DA PAGARE", String(snapshot.pendingRoomBills?.count || 0), width),
      padLine("TOTALE CONTI SALA", formatCurrency(snapshot.pendingRoomBills?.totalDue || 0), width),
      `TAVOLI: ${tableList}${pendingTables.length > 8 ? ", ..." : ""}`.slice(0, width),
      `APPROVATO DA: ${normalize(snapshot.authorization.approverLabel) || "Autorizzatore"}`.slice(
        0,
        width
      )
    );
  }

  if (automaticResult) {
    lines.push(
      divider,
      "SCARICO AUTOMATICO",
      padLine("ATTESO", formatCurrency(automaticResult.expectedDepositTotalCents / 100), width),
      padLine("DEPOSITATO", formatCurrency(automaticResult.depositedTotalCents / 100), width),
      padLine("DIFFERENZA", formatCurrency(automaticResult.differenceCents / 100), width),
      padLine("ESITO", automaticFeedbackPrintLabel(automaticResult.feedbackKind), width)
    );
  }

  const nonFiscalized = snapshot.nonFiscalizedReport;
  if (nonFiscalized && nonFiscalized.count > 0) {
    lines.push(
      divider,
      "NON FISCALIZZATI",
      padLine("TOTALE", formatCurrency(nonFiscalized.total), width),
      padLine(
        "POS",
        `${nonFiscalized.posCount} / ${formatCurrency(nonFiscalized.posTotal)}`,
        width
      ),
      padLine(
        "CONTANTI",
        `${nonFiscalized.cashCount} / ${formatCurrency(nonFiscalized.cashTotal)}`,
        width
      ),
      `Finestra retry chiusa alle ${String(nonFiscalized.retryCutoffHour).padStart(2, "0")}:00`.slice(
        0,
        width
      )
    );
    nonFiscalized.items.slice(0, 8).forEach((item) => {
      const ref = item.transactionId || item.paymentId || item.receiptId;
      lines.push(
        padLine(
          `${item.method === "cash" ? "CONT" : "POS"} ${item.orderId ? `#${item.orderId}` : ref.slice(-8)}`,
          formatCurrency(item.amount),
          width
        )
      );
    });
    if (nonFiscalized.items.length > 8) {
      lines.push(`Altri movimenti: ${nonFiscalized.items.length - 8}`.slice(0, width));
    }
  }

  lines.push(
    "",
    `Routing backend: ${snapshot.context.activityId || "attivita"} / ${
      snapshot.context.roomName || snapshot.context.roomId || "sala"
    }`
  );
  return lines.join("\n").trim();
};

const fetchJson = async <T,>(
  path: string,
  options: RequestInit = {},
  context?: PaymentSettlementContext
): Promise<T> => {
  const headers = new Headers(options.headers);
  headers.set("Accept", headers.get("Accept") || "application/json");
  if (context?.token) headers.set("Authorization", `Bearer ${context.token}`);
  if (context?.userId) headers.set("X-User-Id", context.userId);
  if (context?.deviceUuid) headers.set("X-Device-Uuid", context.deviceUuid);

  const response = await apiFetch(path, {
    ...options,
    headers,
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    ok?: unknown;
    error?: unknown;
    message?: unknown;
  };
  if (!response.ok || payload.ok === false) {
    throw new Error(normalize(payload.error || payload.message) || "Operazione non riuscita.");
  }
  return payload;
};

const summarizePendingRoomBills = (
  context: PaymentSettlementContext,
  layoutPayload: unknown
): PendingRoomBills => {
  const payload =
    layoutPayload && typeof layoutPayload === "object"
      ? (layoutPayload as Record<string, unknown>)
      : {};
  const rooms = Array.isArray(payload.rooms) ? (payload.rooms as Record<string, unknown>[]) : [];
  const tables = Array.isArray(payload.tables) ? (payload.tables as Record<string, unknown>[]) : [];
  const room =
    rooms.find((entry) => normalize(entry.id) === context.roomId) ||
    rooms.find((entry) => normalize(entry.name) === context.roomName) ||
    null;
  const roomId = normalize(room?.id) || context.roomId;
  const roomName = normalize(room?.name) || context.roomName || "Sala";
  const pendingTables = tables
    .filter((entry) => normalize(entry.roomId) === roomId)
    .map((entry) => ({
      id: normalize(entry.id),
      number: Math.max(Math.trunc(Number(entry.number) || 0), 0),
      amountDue: roundMoney(Math.max(Number(entry.amountDue) || 0, 0)),
    }))
    .filter((entry) => entry.amountDue > 0);
  return {
    roomId,
    roomName,
    count: pendingTables.length,
    totalDue: roundMoney(pendingTables.reduce((sum, entry) => sum + entry.amountDue, 0)),
    tables: pendingTables,
  };
};

const fetchPendingRoomBills = async (context: PaymentSettlementContext) => {
  const payload = await fetchJson<unknown>(`/api/integration/layout?_=${Date.now()}`, {}, context);
  return summarizePendingRoomBills(context, payload);
};

const requestSettlementAuthorization = async (snapshot: PaymentSettlementSnapshot) => {
  const { context } = snapshot;
  if (!context.token || !context.userId || !context.deviceUuid || !context.roomId) {
    throw new Error("Sessione sala non valida per l'autorizzazione dello scarico.");
  }

  const payload = await fetchJson<RoomChangeRequestResponse>(
    SETTLEMENT_ROOM_CHANGE_REQUEST_PATH,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: context.token,
        userId: context.userId,
        deviceUuid: context.deviceUuid,
        targetRoomId: context.roomId,
      }),
    },
    context
  );

  const status = normalize(payload.status);
  if (status === "approved") {
    return {
      status: "approved" as const,
      requestId: "",
      approver: {
        username: context.username || context.fullName || "operatore",
        role: "privileged",
        label: context.fullName || context.username || "Operatore autorizzato",
      },
    };
  }
  if (status === "pending" && normalize(payload.requestId)) {
    return { status: "pending" as const, requestId: normalize(payload.requestId) };
  }
  throw new Error("Autorizzazione scarico non disponibile.");
};

const approveSettlementAuthorization = async (
  requestId: string,
  context: PaymentSettlementContext,
  approverUsername: string,
  approverPin: string
) =>
  fetchJson<RoomChangeRequestResponse>(
    SETTLEMENT_ROOM_CHANGE_APPROVE_PATH,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        approverUsername,
        approverPin,
        deviceUuid: context.deviceUuid,
      }),
    },
    context
  );

const cancelSettlementAuthorization = async (
  requestId: string,
  context: PaymentSettlementContext | null
) => {
  if (!requestId) return;
  try {
    await fetchJson(
      SETTLEMENT_ROOM_CHANGE_CANCEL_PATH,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      },
      context || undefined
    );
  } catch {
    // ignore cancellation failures
  }
};

const withSettlementAuthorization = (
  snapshot: PaymentSettlementSnapshot,
  approval: { username?: unknown; role?: unknown; label?: unknown }
): PaymentSettlementSnapshot => ({
  ...snapshot,
  authorization: {
    approved: true,
    approverUsername: normalize(approval.username),
    approverRole: normalize(approval.role),
    approverLabel: normalize(approval.label) || normalize(approval.username) || "Autorizzatore",
    approvedAtMs: Date.now(),
  },
});

const printSettlementText = async (context: PaymentSettlementContext, text: string) => {
  if (!context.activityId) {
    throw new Error("Attivita operativa non configurata: impossibile risolvere la stampa.");
  }
  await fetchJson(
    SETTLEMENT_PRINT_PATH,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "preconto",
        clientApp: "mobile-frontend",
        token: context.token,
        userId: context.userId,
        deviceUuid: context.deviceUuid,
        operationalSchemaVersion: 2,
        ignoreWorkstationRouting: true,
        activityId: context.activityId,
        roomId: context.roomId,
        precontoProfile: "cash",
        text,
      }),
    },
    context
  );
};

const printSettlement = async (snapshot: PaymentSettlementSnapshot) =>
  printSettlementText(snapshot.context, buildPrintText(snapshot));

const registerSettlementClose = async (
  snapshot: PaymentSettlementSnapshot,
  completedAtMs: number,
  options: { amountToDeposit?: number } = {}
) => {
  if (!snapshot.cashFloatLocked || snapshot.cashFloat <= 0) return;
  const amountToDeposit = roundMoney(options.amountToDeposit ?? snapshot.amountToDeposit);
  await fetchJson(
    HANDHELD_CASH_SESSION_CLOSE_PATH,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: snapshot.context.token,
        userId: snapshot.context.userId,
        deviceUuid: snapshot.context.deviceUuid,
        clientApp: "mobile-frontend",
        cashFloat: snapshot.cashFloat,
        posId: snapshot.context.posId,
        activityId: snapshot.context.activityId,
        roomId: snapshot.context.roomId,
        roomName: snapshot.context.roomName,
        sessionStartedAt: snapshot.cutoffMs || snapshot.context.sessionStartedAt,
        cutoffMs: snapshot.cutoffMs,
        generatedAtMs: snapshot.generatedAtMs,
        completedAtMs,
        totals: {
          totalAmount: snapshot.totalAmount,
          cashTotal: snapshot.cashTotal,
          posTotal: snapshot.posTotal,
          otherTotal: snapshot.otherTotal,
          grossPaymentTotal: snapshot.grossPaymentTotal,
          refundTotal: snapshot.refundTotal,
          cashGrossTotal: snapshot.cashGrossTotal,
          posGrossTotal: snapshot.posGrossTotal,
          otherGrossTotal: snapshot.otherGrossTotal,
          cashRefundTotal: snapshot.cashRefundTotal,
          posRefundTotal: snapshot.posRefundTotal,
          otherRefundTotal: snapshot.otherRefundTotal,
          posRechargeTotal: snapshot.posRechargeTotal,
          automaticCashTotal: snapshot.automaticCashTotal,
          ledgerMovementCount: snapshot.ledgerMovementCount,
          paymentCount: snapshot.paymentCount,
          drawerGross: snapshot.drawerGross,
          amountToDeposit,
        },
      }),
    },
    snapshot.context
  );
};

const buildAutomaticSettlementRecord = (
  snapshot: PaymentSettlementSnapshot,
  result: AutomaticSettlementResult,
  completedAtMs: number,
  printText = buildPrintText(snapshot, result)
): AutomaticCashSettlementRecord => {
  const cashFloatId = snapshot.context.autoCashFloatId || `manual_${completedAtMs}`;
  return {
    id: `${cashFloatId}:${completedAtMs}`,
    operationId: result.operationId,
    cashFloatId,
    assignmentId: snapshot.context.autoCashFloatAssignmentId,
    combinationId: snapshot.context.autoCashFloatCombinationId,
    businessEveningKey: snapshot.context.autoCashFloatBusinessEveningKey,
    userId: snapshot.context.userId || null,
    deviceUuid: snapshot.context.deviceUuid || null,
    operatorName: snapshot.context.fullName || snapshot.context.username || null,
    station: snapshot.station || snapshot.context.activityId || null,
    roomId: snapshot.context.roomId || null,
    roomName: snapshot.context.roomName || null,
    expectedDepositTotalCents: result.expectedDepositTotalCents,
    depositedTotalCents: result.depositedTotalCents,
    differenceCents: result.differenceCents,
    mismatchConfirmed: result.mismatchConfirmed,
    feedbackKind: result.feedbackKind,
    printText,
    details: {
      result: {
        operationId: result.operationId,
        expectedDepositTotalCents: result.expectedDepositTotalCents,
        depositedTotalCents: result.depositedTotalCents,
        differenceCents: result.differenceCents,
        feedbackKind: result.feedbackKind,
      },
      snapshot: {
        generatedAtMs: snapshot.generatedAtMs,
        cutoffMs: snapshot.cutoffMs,
        paymentCount: snapshot.paymentCount,
        cashMode: snapshot.cashMode,
        cashFloatLocked: snapshot.cashFloatLocked,
        cashFloat: snapshot.cashFloat,
        cashTotal: snapshot.cashTotal,
        posTotal: snapshot.posTotal,
        otherTotal: snapshot.otherTotal,
        totalAmount: snapshot.totalAmount,
        grossPaymentTotal: snapshot.grossPaymentTotal,
        refundTotal: snapshot.refundTotal,
        cashGrossTotal: snapshot.cashGrossTotal,
        posGrossTotal: snapshot.posGrossTotal,
        otherGrossTotal: snapshot.otherGrossTotal,
        cashRefundTotal: snapshot.cashRefundTotal,
        posRefundTotal: snapshot.posRefundTotal,
        otherRefundTotal: snapshot.otherRefundTotal,
        posRechargeTotal: snapshot.posRechargeTotal,
        automaticCashTotal: snapshot.automaticCashTotal,
        ledgerMovementCount: snapshot.ledgerMovementCount,
        drawerGross: snapshot.drawerGross,
        amountToDeposit: snapshot.amountToDeposit,
        posLabel: snapshot.posLabel,
        station: snapshot.station,
        pendingRoomBills: snapshot.pendingRoomBills ?? null,
        authorization: snapshot.authorization ?? null,
      },
      context: {
        userId: snapshot.context.userId,
        username: snapshot.context.username,
        fullName: snapshot.context.fullName,
        deviceUuid: snapshot.context.deviceUuid,
        activityId: snapshot.context.activityId,
        roomId: snapshot.context.roomId,
        roomName: snapshot.context.roomName,
        posId: snapshot.context.posId,
      },
    },
    completedAtMs,
  };
};

const toAutomaticSettlementContext = (
  snapshot: PaymentSettlementSnapshot
): AutomaticSettlementContext => ({
  cashTotalCents: moneyToCents(snapshot.cashTotal),
  automaticCashFloatCents: moneyToCents(snapshot.cashFloat),
  cashFloatId: snapshot.context.autoCashFloatId,
  assignmentId: snapshot.context.autoCashFloatAssignmentId,
  combinationId: snapshot.context.autoCashFloatCombinationId,
  businessEveningKey: snapshot.context.autoCashFloatBusinessEveningKey,
  deviceUuid: snapshot.context.deviceUuid,
});

export function PaymentSettlementSection({
  cashDraft,
  onRequestNewAutoCashFloat,
  automaticGatewayOperational = true,
}: {
  cashDraft: string;
  onRequestNewAutoCashFloat?: () => void;
  automaticGatewayOperational?: boolean;
}) {
  void onRequestNewAutoCashFloat;
  const {
    token,
    userId,
    username,
    fullName,
    deviceUuid,
    activityId,
    roomId,
    roomName,
    sessionStartedAt,
  } = useAuthStore();
  const {
    posId,
    cashMode,
    cashFloat,
    cashFloatLocked,
    autoCashFloatId,
    autoCashFloatAssignmentId,
    autoCashFloatCombinationId,
    autoCashFloatBusinessEveningKey,
    setPosId,
    resetCashFloat,
  } = usePaymentSettingsStore();
  const [modal, setModal] = useState<ModalState>(emptyModalState);
  const [automaticWizard, setAutomaticWizard] =
    useState<AutomaticWizardState>(emptyAutomaticWizardState);
  const [settlementLaunchMode, setSettlementLaunchMode] =
    useState<SettlementLaunchMode>("automatic");
  const settlementModeHoldTimerRef = useRef<number | null>(null);
  const settlementModeHoldTriggeredRef = useRef(false);
  const [summaryVersion, setSummaryVersion] = useState(0);
  const [automaticArchiveVersion, setAutomaticArchiveVersion] = useState(0);
  const [automaticReprintBusy, setAutomaticReprintBusy] = useState(false);
  const [automaticReprintMessage, setAutomaticReprintMessage] = useState("");
  const [automaticDetailOpen, setAutomaticDetailOpen] = useState(false);
  const [latestAutomaticSettlementFromDb, setLatestAutomaticSettlementFromDb] =
    useState<AutomaticCashSettlementRecord | null>(null);
  const [automaticCashFeedbackSettings, setAutomaticCashFeedbackSettings] =
    useState<AutomaticCashFeedbackSettings>(emptyAutomaticCashFeedbackSettings);
  const optimisticActionsEnabled = useMemo(() => isClientOptimisticActionsEnabled(), []);

  const context = useMemo<PaymentSettlementContext>(
    () => ({
      token: normalize(token),
      userId: normalize(userId),
      username: normalize(username),
      fullName: normalize(fullName) || normalize(username) || "Operatore",
      activityId: normalize(activityId),
      roomId: normalize(roomId),
      roomName: normalize(roomName),
      sessionStartedAt: sessionStartedAt ?? 0,
      deviceUuid: normalize(deviceUuid) || getOrCreateDeviceUuid(),
      posId: normalize(posId),
      cashMode,
      cashFloat: Math.max(
        0,
        roundMoney(cashFloat ?? parseMoney(readStoredValue(PAYMENT_CASH_FLOAT_KEY)))
      ),
      cashFloatLocked,
      autoCashFloatId: normalize(autoCashFloatId) || null,
      autoCashFloatAssignmentId: normalize(autoCashFloatAssignmentId) || null,
      autoCashFloatCombinationId: normalize(autoCashFloatCombinationId) || null,
      autoCashFloatBusinessEveningKey: normalize(autoCashFloatBusinessEveningKey) || null,
    }),
    [
      autoCashFloatAssignmentId,
      autoCashFloatBusinessEveningKey,
      autoCashFloatCombinationId,
      autoCashFloatId,
      cashFloat,
      cashFloatLocked,
      cashMode,
      deviceUuid,
      fullName,
      activityId,
      posId,
      roomId,
      roomName,
      sessionStartedAt,
      token,
      userId,
      username,
    ]
  );

  const summary = useMemo(() => {
    void summaryVersion;
    return readSettlementSummary(context);
  }, [context, summaryVersion]);
  const latestAutomaticSettlement = useMemo(() => {
    void automaticArchiveVersion;
    return (
      latestAutomaticSettlementFromDb ??
      readLatestAutomaticCashSettlementRecord({
        userId: context.userId,
        deviceUuid: context.deviceUuid,
      })
    );
  }, [
    automaticArchiveVersion,
    context.deviceUuid,
    context.userId,
    latestAutomaticSettlementFromDb,
  ]);

  useEffect(() => {
    const refresh = () => setSummaryVersion((value) => value + 1);
    window.addEventListener("storage", refresh);
    window.addEventListener("mobile:payment-config-reset", refresh);
    window.addEventListener("mobile:payments:settlement-completed", refresh);
    window.addEventListener("mobile:automatic-cash-settlement-records-changed", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("mobile:payment-config-reset", refresh);
      window.removeEventListener("mobile:payments:settlement-completed", refresh);
      window.removeEventListener("mobile:automatic-cash-settlement-records-changed", refresh);
    };
  }, []);

  useEffect(
    () => () => {
      if (settlementModeHoldTimerRef.current !== null) {
        window.clearTimeout(settlementModeHoldTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    let alive = true;
    void getAutomaticCashSettings()
      .then((settings) => {
        if (!alive) return;
        setAutomaticCashFeedbackSettings({
          feedbackEnabled: settings.feedbackEnabled === true,
          warningThresholdCents: settings.warningThresholdCents,
          dangerThresholdCents: settings.dangerThresholdCents,
        });
      })
      .catch(() => {
        if (alive) setAutomaticCashFeedbackSettings(emptyAutomaticCashFeedbackSettings);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const refresh = () => setAutomaticArchiveVersion((value) => value + 1);
    window.addEventListener("storage", refresh);
    window.addEventListener("mobile:automatic-cash-settlement-records-changed", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("mobile:automatic-cash-settlement-records-changed", refresh);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void getLatestAutomaticCashSettlementRecord()
      .then((payload) => {
        if (!alive) return;
        setLatestAutomaticSettlementFromDb(payload.record ?? null);
      })
      .catch(() => {
        if (alive) setLatestAutomaticSettlementFromDb(null);
      });
    return () => {
      alive = false;
    };
  }, [automaticArchiveVersion, context.deviceUuid, context.userId]);

  useEffect(() => {
    if (!summary) return;
    if (context.posId || (context.cashFloatLocked && context.cashFloat > 0) || cashDraft.trim()) {
      clearSettlementSummary(context);
      setSummaryVersion((value) => value + 1);
    }
  }, [cashDraft, context, summary]);

  const openAutomaticSettlementWizard = () => {
    const fallbackSnapshot = buildLocalSettlementSnapshot(context);
    setAutomaticWizard({
      open: true,
      loading: true,
      snapshot: fallbackSnapshot,
    });
    void buildSettlementSnapshot(context).then((snapshot) => {
      setAutomaticWizard((current) => {
        if (!current.open) return current;
        return { open: true, loading: false, snapshot };
      });
    });
  };

  const openManualSettlementModal = () => {
    const fallbackSnapshot = buildLocalSettlementSnapshot(context);
    setModal({
      ...emptyModalState,
      open: true,
      printing: true,
      snapshot: fallbackSnapshot,
    });
    void buildSettlementSnapshot(context).then((snapshot) => {
      setModal((current) => {
        if (!current.open) return current;
        return {
          ...current,
          printing: false,
          snapshot,
        };
      });
    });
  };

  const startManualSettlement = () => {
    setSettlementLaunchMode("automatic");
    openManualSettlementModal();
  };

  const startAutomaticSettlement = () => {
    if (!automaticGatewayOperational) {
      startManualSettlement();
      return;
    }
    setSettlementLaunchMode("automatic");
    openAutomaticSettlementWizard();
  };

  const clearSettlementModeHoldTimer = () => {
    if (settlementModeHoldTimerRef.current === null) return;
    window.clearTimeout(settlementModeHoldTimerRef.current);
    settlementModeHoldTimerRef.current = null;
  };

  const handleSettlementLaunchPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!automaticGatewayOperational) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    clearSettlementModeHoldTimer();
    settlementModeHoldTriggeredRef.current = false;
    settlementModeHoldTimerRef.current = window.setTimeout(() => {
      settlementModeHoldTimerRef.current = null;
      settlementModeHoldTriggeredRef.current = true;
      setSettlementLaunchMode("manual");
      triggerLongPressHaptic();
    }, SETTLEMENT_MODE_HOLD_MS);
  };

  const handleSettlementLaunchPointerEnd = () => {
    clearSettlementModeHoldTimer();
  };

  const handleSettlementLaunchClick = () => {
    if (settlementModeHoldTriggeredRef.current) {
      settlementModeHoldTriggeredRef.current = false;
      return;
    }
    if (!automaticGatewayOperational || settlementLaunchMode === "manual") {
      startManualSettlement();
      return;
    }
    startAutomaticSettlement();
  };

  const closeAutomaticWizard = () => {
    if (automaticWizard.loading) return;
    setAutomaticWizard(emptyAutomaticWizardState);
  };

  const closeModal = () => {
    if (modal.printing || modal.finishing || modal.authBusy) return;
    const requestId = modal.authRequestId;
    const snapshotContext = modal.snapshot?.context || context;
    setModal(emptyModalState);
    if (requestId) void cancelSettlementAuthorization(requestId, snapshotContext);
  };

  const setModalState = (nextState: Partial<ModalState>) => {
    setModal((current) => ({ ...current, ...nextState }));
  };

  const handlePrint = async () => {
    if (!modal.snapshot || modal.printing || modal.finishing) return;
    const snapshot = modal.snapshot;
    const previousPrintedAtLabel = modal.printedAtLabel;
    if (optimisticActionsEnabled) {
      setModalState({
        printing: false,
        error: "",
        printedAtLabel: dateTimeLabel(Date.now()),
      });
      runBackgroundOptimisticRequest(() => printSettlement(snapshot), {
        onError: (error) => {
          setModalState({
            printing: false,
            printedAtLabel: previousPrintedAtLabel,
            error: error instanceof Error ? error.message : "Stampa scarico non riuscita.",
          });
        },
      });
      return;
    }
    setModalState({ printing: true, error: "" });
    try {
      await printSettlement(snapshot);
      setModalState({ printing: false, error: "", printedAtLabel: dateTimeLabel(Date.now()) });
    } catch (error) {
      setModalState({
        printing: false,
        error: error instanceof Error ? error.message : "Stampa scarico non riuscita.",
      });
    }
  };

  const handleAutomaticReprint = async () => {
    if (!latestAutomaticSettlement || automaticReprintBusy) return;
    const record = latestAutomaticSettlement;
    if (optimisticActionsEnabled) {
      setAutomaticReprintBusy(false);
      setAutomaticReprintMessage(`Ristampa richiesta alle ${dateTimeLabel(Date.now())}.`);
      runBackgroundOptimisticRequest(() => printSettlementText(context, record.printText), {
        onSuccess: () => {
          setAutomaticReprintMessage(
            `Ultimo scarico automatico ristampato alle ${dateTimeLabel(Date.now())}.`
          );
        },
        onError: (error) => {
          setAutomaticReprintMessage(
            error instanceof Error ? error.message : "Ristampa scarico automatico non riuscita."
          );
        },
      });
      return;
    }
    setAutomaticReprintBusy(true);
    setAutomaticReprintMessage("");
    try {
      await printSettlementText(context, record.printText);
      setAutomaticReprintMessage(
        `Ultimo scarico automatico ristampato alle ${dateTimeLabel(Date.now())}.`
      );
    } catch (error) {
      setAutomaticReprintMessage(
        error instanceof Error ? error.message : "Ristampa scarico automatico non riuscita."
      );
    } finally {
      setAutomaticReprintBusy(false);
    }
  };

  const completeSettlement = async (
    snapshot: PaymentSettlementSnapshot | null,
    automaticResult?: AutomaticSettlementResult,
    options: { throwOnError?: boolean } = {}
  ): Promise<SettlementCompletionResult | false> => {
    if (!snapshot) return false;
    setModalState({ finishing: true, error: "", snapshot });
    try {
      const printText = buildPrintText(snapshot, automaticResult);
      await printSettlementText(snapshot.context, printText);
      const completedAtMs = Date.now();
      const completedAmountToDeposit = resolveCompletedAmountToDeposit(snapshot, automaticResult);
      await registerSettlementClose(snapshot, completedAtMs, {
        amountToDeposit: completedAmountToDeposit,
      });
      let automaticRecord: AutomaticCashSettlementRecord | null = null;
      if (automaticResult) {
        const record = buildAutomaticSettlementRecord(
          snapshot,
          automaticResult,
          completedAtMs,
          printText
        );
        const savedRecord = await saveAutomaticCashSettlementRecordToDb(record)
          .then((payload) => payload.record)
          .catch((error) => {
            throw error instanceof Error
              ? error
              : new Error("Salvataggio dettaglio scarico automatico non riuscito.");
          });
        const normalizedRecord = saveAutomaticCashSettlementRecord(savedRecord ?? record);
        automaticRecord = normalizedRecord;
        setLatestAutomaticSettlementFromDb(normalizedRecord);
        updateAutomaticCashTicketRecordStatus(normalizedRecord.cashFloatId, "used_in_settlement");
      }
      persistSettlementSummary(snapshot, completedAtMs, {
        automaticSettlement: Boolean(automaticResult),
        amountToDeposit: completedAmountToDeposit,
      });
      settlementCutoffKeys(snapshot.context).forEach((key) =>
        writeStoredValue(key, String(Math.max(snapshot.generatedAtMs, completedAtMs)))
      );
      setPosId(null);
      resetCashFloat();
      removeStoredValue(PAYMENT_POS_ID_KEY);
      removeStoredValue(PAYMENT_CASH_FLOAT_KEY);
      removeStoredValue(PAYMENT_CASH_FLOAT_LOCKED_KEY);
      clearMobilePaymentRuntime("settlement-completed");
      window.dispatchEvent(
        new CustomEvent("mobile:payment-config-reset", {
          detail: {
            source: "mobile-payments-settlement-native",
            keys: [
              PAYMENT_POS_ID_KEY,
              PAYMENT_CASH_FLOAT_KEY,
              PAYMENT_CASH_FLOAT_LOCKED_KEY,
              "pos_session_started_at",
            ],
          },
        })
      );
      window.dispatchEvent(
        new CustomEvent("mobile:payments:settlement-completed", {
          detail: {
            generatedAtMs: snapshot.generatedAtMs,
            completedAtMs,
            amountToDeposit: completedAmountToDeposit,
            totalAmount: snapshot.totalAmount,
            grossPaymentTotal: snapshot.grossPaymentTotal,
            refundTotal: snapshot.refundTotal,
            posRechargeTotal: snapshot.posRechargeTotal,
            automaticCashTotal: snapshot.automaticCashTotal,
            cashTotal: snapshot.cashTotal,
            posTotal: snapshot.posTotal,
            otherTotal: snapshot.otherTotal,
            automaticSettlement: Boolean(automaticResult),
          },
        })
      );
      setSummaryVersion((value) => value + 1);
      setModalState({
        phase: "completed",
        printing: false,
        finishing: false,
        authBusy: false,
        authRequestId: "",
        authUsername: "",
        authPin: "",
        error: "",
        printedAtLabel: dateTimeLabel(completedAtMs),
        completedAtLabel: dateTimeLabel(completedAtMs),
        snapshot,
      });
      return { completedAtMs, printText, automaticRecord };
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error("Termina scarico non riuscito.");
      setModalState({
        printing: false,
        finishing: false,
        authBusy: false,
        error: normalizedError.message,
        snapshot,
      });
      if (options.throwOnError) throw normalizedError;
      return false;
    }
  };

  const handleFinish = async () => {
    if (!modal.snapshot || modal.printing || modal.finishing || modal.authBusy) return;
    let snapshot = modal.snapshot;
    if (!snapshot.authorization?.approved) {
      setModalState({ finishing: true, error: "" });
      try {
        const pendingRoomBills = await fetchPendingRoomBills(snapshot.context);
        snapshot = { ...snapshot, pendingRoomBills };
        if (pendingRoomBills.count > 0) {
          setModalState({
            phase: "pending-warning",
            printing: false,
            finishing: false,
            authBusy: false,
            authRequestId: "",
            authUsername: "",
            authPin: "",
            error: "",
            snapshot,
          });
          return;
        }
      } catch (error) {
        setModalState({
          printing: false,
          finishing: false,
          authBusy: false,
          error:
            error instanceof Error
              ? error.message
              : "Impossibile verificare i tavoli aperti della sala.",
          snapshot,
        });
        return;
      }
    }
    await completeSettlement(snapshot);
  };

  const handleAutomaticSettlementCompleted = async (result: AutomaticSettlementResult) => {
    const snapshot = automaticWizard.snapshot;
    if (!snapshot) throw new Error("Scarico automatico non pronto.");
    const completion = await completeSettlement(snapshot, result, { throwOnError: true });
    if (!completion || !completion.automaticRecord) {
      throw new Error("Dettaglio scarico automatico non disponibile per la ristampa.");
    }
    return completion.automaticRecord;
  };

  const handleAutomaticSettlementReprint = async (record: AutomaticCashSettlementRecord) => {
    const printContext = automaticWizard.snapshot?.context ?? context;
    await printSettlementText(printContext, record.printText);
  };

  const handlePendingBillsConfirm = async () => {
    if (!modal.snapshot || modal.printing || modal.finishing || modal.authBusy) return;
    const snapshot = modal.snapshot;
    const pendingCount = Math.max(0, Math.trunc(Number(snapshot.pendingRoomBills?.count) || 0));
    if (pendingCount <= 0 || snapshot.authorization?.approved) {
      await completeSettlement(snapshot);
      return;
    }
    setModalState({ authBusy: true, error: "" });
    try {
      const authorizationRequest = await requestSettlementAuthorization(snapshot);
      if (authorizationRequest.status === "pending") {
        setModalState({
          phase: "authorize",
          printing: false,
          finishing: false,
          authBusy: false,
          authRequestId: authorizationRequest.requestId,
          authUsername: "",
          authPin: "",
          error: "",
          snapshot,
        });
        return;
      }
      const authorizedSnapshot = withSettlementAuthorization(
        snapshot,
        authorizationRequest.approver
      );
      setModalState({
        phase: "confirm",
        authBusy: false,
        authRequestId: "",
        authUsername: "",
        authPin: "",
        error: "",
        snapshot: authorizedSnapshot,
      });
      await completeSettlement(authorizedSnapshot);
    } catch (error) {
      setModalState({
        authBusy: false,
        error: error instanceof Error ? error.message : "Autorizzazione scarico non disponibile.",
      });
    }
  };

  const handleAuthorizeAndFinish = async () => {
    if (
      !modal.snapshot ||
      !modal.authRequestId ||
      modal.printing ||
      modal.finishing ||
      modal.authBusy
    )
      return;
    const approverUsername = normalize(modal.authUsername);
    const approverPin = normalize(modal.authPin);
    if (!approverUsername || !approverPin) {
      setModalState({ error: "Inserisci utente e PIN dell'autorizzatore." });
      return;
    }
    setModalState({ authBusy: true, error: "" });
    try {
      const approvalPayload = await approveSettlementAuthorization(
        modal.authRequestId,
        modal.snapshot.context,
        approverUsername,
        approverPin
      );
      const approval = approvalPayload.approver || {};
      const approvedSnapshot = withSettlementAuthorization(modal.snapshot, {
        username: approval.username || approverUsername,
        role: approval.role || "",
        label: approval.label || approval.username || approverUsername,
      });
      setModalState({
        phase: "confirm",
        authBusy: false,
        authRequestId: "",
        authUsername: "",
        authPin: "",
        error: "",
        snapshot: approvedSnapshot,
      });
      await completeSettlement(approvedSnapshot);
    } catch (error) {
      setModalState({
        authBusy: false,
        error: error instanceof Error ? error.message : "Autorizzazione scarico non riuscita.",
      });
    }
  };

  const snapshot = modal.snapshot;
  const pendingRoomBills = snapshot?.pendingRoomBills || {
    count: 0,
    totalDue: 0,
    tables: [],
    roomName: snapshot?.context.roomName || "Sala",
  };
  const pendingTableLabels = pendingRoomBills.tables
    .map((entry) => (entry.number > 0 ? `Tavolo ${entry.number}` : ""))
    .filter(Boolean)
    .join(", ");
  const completed = modal.phase === "completed";
  const authorizing = modal.phase === "authorize";
  const pendingWarning = modal.phase === "pending-warning";
  const summaryLedgerTotals = summary ? settlementDisplayTotals(summary) : null;
  const summaryHasLedger = summary ? hasSettlementLedgerDiagnostics(summary) : false;
  const snapshotLedgerTotals = snapshot ? settlementDisplayTotals(snapshot) : null;

  return (
    <>
      <div className="payments-section mobile-payments-settlement-section">
        <div className="payments-section-title">Scarico cassa</div>
        <div className="mobile-payments-settlement-copy">
          Chiude il turno corrente, stampa il riepilogo tramite routing backend e poi azzera POS e
          fondo cassa.
        </div>
        {summary ? (
          <>
            <div className="payments-section-title mobile-payments-settlement-history-title">
              Ultimo scarico completato
            </div>
            <div className="mobile-payments-settlement-preview">
              <div className="mobile-payments-settlement-preview-card">
                <span>Incasso lordo</span>
                <strong>{formatCurrency(summaryLedgerTotals?.grossPaymentTotal ?? 0)}</strong>
              </div>
              <div className="mobile-payments-settlement-preview-card">
                <span>Resi/Storni</span>
                <strong>{formatRefundCurrency(summaryLedgerTotals?.refundTotal ?? 0)}</strong>
              </div>
              <div className="mobile-payments-settlement-preview-card">
                <span>Totale netto</span>
                <strong>{formatCurrency(summary.totalAmount)}</strong>
              </div>
              <div className="mobile-payments-settlement-preview-card">
                <span>Da versare</span>
                <strong>
                  {settlementVisibleAmountLabel(
                    summary.amountToDeposit,
                    summary.automaticSettlement
                  )}
                </strong>
              </div>
              <div className="mobile-payments-settlement-preview-card">
                <span>Contanti netti</span>
                <strong>{formatCurrency(summary.cashTotal)}</strong>
              </div>
              {(summaryLedgerTotals?.automaticCashTotal ?? 0) > 0 ? (
                <div className="mobile-payments-settlement-preview-card">
                  <span>Cassa automatica</span>
                  <strong>{formatCurrency(summaryLedgerTotals?.automaticCashTotal ?? 0)}</strong>
                </div>
              ) : null}
              <div className="mobile-payments-settlement-preview-card">
                <span>POS netto</span>
                <strong>{formatCurrency(summary.posTotal)}</strong>
              </div>
              <div className="mobile-payments-settlement-preview-card">
                <span>Riaddebiti POS</span>
                <strong>{formatCurrency(summaryLedgerTotals?.posRechargeTotal ?? 0)}</strong>
              </div>
            </div>
            <div className="mobile-payments-settlement-meta-line">
              <span>Completato: {dateTimeLabel(summary.completedAtMs)}</span>
              <span>POS usato: {summary.posLabel}</span>
              <span>
                {summaryHasLedger ? "Movimenti ledger" : "Movimenti"}:{" "}
                {summaryHasLedger
                  ? summaryLedgerTotals?.ledgerMovementCount || 0
                  : summary.paymentCount}
              </span>
            </div>
            {summary.automaticSettlement && latestAutomaticSettlement ? (
              <div className="payments-actions mobile-payments-settlement-section-actions">
                <button
                  type="button"
                  className="smallbtn mobile-payments-settlement-eye"
                  aria-label="Dettaglio ultimo scarico"
                  onClick={() => setAutomaticDetailOpen(true)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="smallbtn mobile-payments-settlement-launch"
                  disabled={automaticReprintBusy}
                  onClick={() => void handleAutomaticReprint()}
                >
                  {automaticReprintBusy ? "Ristampa..." : "Ristampa ultimo automatico"}
                </button>
              </div>
            ) : null}
            {automaticReprintMessage ? (
              <div className="mobile-payments-settlement-note">{automaticReprintMessage}</div>
            ) : null}
            {summary.authorizationRequired ? (
              <div className="mobile-payments-settlement-note is-warning">
                Scarico autorizzato per {summary.authorizationRoomName || "sala"} con{" "}
                {summary.authorizationPendingCount} tavoli da pagare. Approvato da{" "}
                {summary.authorizationApprover || "autorizzatore"}.
              </div>
            ) : null}
          </>
        ) : null}
        <div className="payments-actions mobile-payments-settlement-section-actions">
          <button
            type="button"
            className={`smallbtn mobile-payments-settlement-launch ${
              !automaticGatewayOperational || settlementLaunchMode === "manual"
                ? "is-manual"
                : "is-auto"
            }`}
            title={
              !automaticGatewayOperational
                ? "Gateway non aggiornato: disponibile solo lo scarico manuale"
                : settlementLaunchMode === "manual"
                  ? "Premi per avviare lo scarico manuale"
                  : "Tieni premuto per passare allo scarico manuale"
            }
            onPointerDown={handleSettlementLaunchPointerDown}
            onPointerUp={handleSettlementLaunchPointerEnd}
            onPointerCancel={handleSettlementLaunchPointerEnd}
            onClick={handleSettlementLaunchClick}
          >
            {!automaticGatewayOperational || settlementLaunchMode === "manual"
              ? "Scarico manuale"
              : "Scarico automatico"}
          </button>
        </div>
      </div>

      {modal.open && snapshot ? (
        <div className="mobile-payments-settlement-backdrop" onPointerDown={closeModal}>
          <div
            className="mobile-payments-settlement-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Scarico cassa"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="mobile-payments-settlement-head">
              <strong>
                {completed
                  ? "Report scarico"
                  : authorizing
                    ? "Autorizzazione scarico"
                    : pendingWarning
                      ? "Tavoli da riscuotere"
                      : "Conferma scarico"}
              </strong>
              <button
                type="button"
                className="smallbtn mobile-payments-settlement-close"
                onClick={closeModal}
              >
                Chiudi
              </button>
            </div>
            <div className="mobile-payments-settlement-body">
              <div className="mobile-payments-settlement-meta">
                <span>Operatore: {snapshot.context.fullName || "Operatore"}</span>
                <span>POS: {snapshot.posLabel}</span>
                <span>Ora: {dateTimeLabel(snapshot.generatedAtMs)}</span>
              </div>

              {authorizing || pendingWarning ? (
                <>
                  <div className="mobile-payments-settlement-note is-warning">
                    Sala {pendingRoomBills.roomName || snapshot.context.roomName || "Sala"}:{" "}
                    {pendingRoomBills.count} tavoli da pagare per{" "}
                    {formatCurrency(pendingRoomBills.totalDue)}.
                  </div>
                  {pendingTableLabels ? (
                    <div className="mobile-payments-settlement-note is-warning">
                      Tavoli con conto aperto: {pendingTableLabels}.
                    </div>
                  ) : null}
                </>
              ) : null}

              {pendingWarning ? (
                <div className="mobile-payments-settlement-note is-warning">
                  Attenzione: ci sono ancora tavoli da riscuotere. Se continui, lo scarico verra
                  chiuso con conti aperti e restera tracciato nel report.
                </div>
              ) : null}

              {authorizing ? (
                <>
                  <div className="mobile-payments-settlement-note">
                    Per terminare lo scarico con conti ancora aperti in sala serve l'autorizzazione
                    di un responsabile o amministratore.
                  </div>
                  <div className="mobile-payments-settlement-auth-grid">
                    <label className="mobile-payments-settlement-field">
                      <span>Utente autorizzatore</span>
                      <input
                        type="text"
                        autoComplete="username"
                        value={modal.authUsername}
                        placeholder="Username autorizzatore"
                        onChange={(event) =>
                          setModalState({ authUsername: event.target.value, error: "" })
                        }
                      />
                    </label>
                    <label className="mobile-payments-settlement-field">
                      <span>PIN autorizzatore</span>
                      <input
                        type="password"
                        inputMode="numeric"
                        autoComplete="current-password"
                        value={modal.authPin}
                        placeholder="PIN autorizzatore"
                        onChange={(event) =>
                          setModalState({ authPin: event.target.value, error: "" })
                        }
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          void handleAuthorizeAndFinish();
                        }}
                      />
                    </label>
                  </div>
                </>
              ) : null}

              {completed && snapshotLedgerTotals ? (
                <div className="mobile-payments-settlement-summary">
                  <div className="mobile-payments-settlement-row">
                    <span>Incasso lordo</span>
                    <strong>{formatCurrency(snapshotLedgerTotals.grossPaymentTotal)}</strong>
                  </div>
                  <div className="mobile-payments-settlement-row">
                    <span>Resi/Storni</span>
                    <strong>{formatRefundCurrency(snapshotLedgerTotals.refundTotal)}</strong>
                  </div>
                  <div className="mobile-payments-settlement-row is-highlight">
                    <span>Totale netto</span>
                    <strong>{formatCurrency(snapshot.totalAmount)}</strong>
                  </div>
                  <div className="mobile-payments-settlement-row">
                    <span>Contanti lordi</span>
                    <strong>{formatCurrency(snapshotLedgerTotals.cashGrossTotal)}</strong>
                  </div>
                  <div className="mobile-payments-settlement-row">
                    <span>Resi contanti</span>
                    <strong>{formatRefundCurrency(snapshotLedgerTotals.cashRefundTotal)}</strong>
                  </div>
                  <div className="mobile-payments-settlement-row">
                    <span>Contanti netti</span>
                    <strong>{formatCurrency(snapshot.cashTotal)}</strong>
                  </div>
                  {snapshotLedgerTotals.automaticCashTotal > 0 ? (
                    <div className="mobile-payments-settlement-row">
                      <span>Cassa automatica</span>
                      <strong>{formatCurrency(snapshotLedgerTotals.automaticCashTotal)}</strong>
                    </div>
                  ) : null}
                  <div className="mobile-payments-settlement-row">
                    <span>POS lordo</span>
                    <strong>{formatCurrency(snapshotLedgerTotals.posGrossTotal)}</strong>
                  </div>
                  <div className="mobile-payments-settlement-row">
                    <span>Void/Storni POS</span>
                    <strong>{formatRefundCurrency(snapshotLedgerTotals.posRefundTotal)}</strong>
                  </div>
                  <div className="mobile-payments-settlement-row">
                    <span>Riaddebiti POS</span>
                    <strong>{formatCurrency(snapshotLedgerTotals.posRechargeTotal)}</strong>
                  </div>
                  <div className="mobile-payments-settlement-row">
                    <span>POS netto</span>
                    <strong>{formatCurrency(snapshot.posTotal)}</strong>
                  </div>
                  <div className="mobile-payments-settlement-row">
                    <span>Altre forme nette</span>
                    <strong>{formatCurrency(snapshot.otherTotal)}</strong>
                  </div>
                  <div className="mobile-payments-settlement-row">
                    <span>Fondo cassa</span>
                    <strong>{formatCurrency(snapshot.cashFloat)}</strong>
                  </div>
                  <div className="mobile-payments-settlement-row">
                    <span>Cassa lorda</span>
                    <strong>{formatCurrency(snapshot.drawerGross)}</strong>
                  </div>
                  <div className="mobile-payments-settlement-row is-highlight">
                    <span>Da versare in cassa</span>
                    <strong>{settlementVisibleAmountLabel(snapshot.amountToDeposit)}</strong>
                  </div>
                </div>
              ) : null}

              {completed && snapshot.authorization?.approved ? (
                <div className="mobile-payments-settlement-note is-warning">
                  Scarico autorizzato per{" "}
                  {snapshot.pendingRoomBills?.roomName || snapshot.context.roomName || "sala"} con{" "}
                  {snapshot.pendingRoomBills?.count || 0} tavoli ancora da pagare. Approvato da{" "}
                  {snapshot.authorization.approverLabel || "autorizzatore"}.
                </div>
              ) : null}

              {completed && modal.printedAtLabel ? (
                <div className="mobile-payments-settlement-note is-success">
                  Scarico terminato alle {modal.completedAtLabel || modal.printedAtLabel} e stampato
                  alle {modal.printedAtLabel}.
                </div>
              ) : authorizing ? null : snapshot.authorization?.approved ? (
                <div className="mobile-payments-settlement-note is-success">
                  Autorizzazione registrata per la sala{" "}
                  {snapshot.pendingRoomBills?.roomName || snapshot.context.roomName || "Sala"}.
                  Termina per stampare il report e chiudere il turno.
                </div>
              ) : (
                <div className="mobile-payments-settlement-note">
                  Premendo Termina lo scarico viene stampato tramite la configurazione operativa
                  backend, poi azzera fondo cassa e POS usato.
                </div>
              )}

              {modal.error ? (
                <div className="mobile-payments-settlement-note is-error">{modal.error}</div>
              ) : null}
            </div>
            <div className="mobile-payments-settlement-actions">
              {completed ? (
                <button
                  type="button"
                  className="smallbtn mobile-payments-settlement-btn"
                  disabled={modal.printing || modal.finishing || modal.authBusy}
                  onClick={() => void handlePrint()}
                >
                  {modal.printing ? "Ristampa..." : "Ristampa"}
                </button>
              ) : (
                <button
                  type="button"
                  className="smallbtn mobile-payments-settlement-btn is-secondary"
                  disabled={modal.printing || modal.finishing || modal.authBusy}
                  onClick={() => {
                    if (pendingWarning)
                      setModalState({
                        phase: "confirm",
                        finishing: false,
                        authBusy: false,
                        error: "",
                      });
                    else closeModal();
                  }}
                >
                  {pendingWarning ? "Torna" : "Annulla"}
                </button>
              )}

              {completed ? (
                <button
                  type="button"
                  className="smallbtn mobile-payments-settlement-btn is-primary"
                  disabled={modal.printing || modal.finishing || modal.authBusy}
                  onClick={closeModal}
                >
                  Chiudi
                </button>
              ) : authorizing ? (
                <button
                  type="button"
                  className="smallbtn mobile-payments-settlement-btn is-primary"
                  disabled={modal.printing || modal.finishing || modal.authBusy}
                  onClick={() => void handleAuthorizeAndFinish()}
                >
                  {modal.authBusy ? "Verifica..." : "Autorizza e termina"}
                </button>
              ) : pendingWarning ? (
                <button
                  type="button"
                  className="smallbtn mobile-payments-settlement-btn is-primary"
                  disabled={modal.printing || modal.finishing || modal.authBusy}
                  onClick={() => void handlePendingBillsConfirm()}
                >
                  {modal.authBusy ? "Verifica..." : "Conferma e continua"}
                </button>
              ) : (
                <button
                  type="button"
                  className="smallbtn mobile-payments-settlement-btn is-primary"
                  disabled={modal.printing || modal.finishing || modal.authBusy}
                  onClick={() => void handleFinish()}
                >
                  {modal.finishing ? "Termina..." : "Termina"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <AutomaticSettlementWizard
        open={automaticWizard.open}
        loading={automaticWizard.loading}
        context={
          automaticWizard.snapshot ? toAutomaticSettlementContext(automaticWizard.snapshot) : null
        }
        feedbackEnabled={automaticCashFeedbackSettings.feedbackEnabled}
        warningThresholdCents={automaticCashFeedbackSettings.warningThresholdCents}
        dangerThresholdCents={automaticCashFeedbackSettings.dangerThresholdCents}
        onClose={closeAutomaticWizard}
        onCompleted={handleAutomaticSettlementCompleted}
        onReprint={handleAutomaticSettlementReprint}
      />

      {automaticDetailOpen && latestAutomaticSettlement ? (
        <div
          className="mobile-payments-settlement-backdrop"
          onPointerDown={() => setAutomaticDetailOpen(false)}
        >
          <section
            className="mobile-payments-settlement-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Dettaglio ultimo scarico automatico"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="mobile-payments-settlement-head">
              <strong>Ultimo scarico automatico</strong>
              <button
                type="button"
                className="smallbtn mobile-payments-settlement-close"
                onClick={() => setAutomaticDetailOpen(false)}
              >
                Chiudi
              </button>
            </div>
            <div className="mobile-payments-settlement-body">
              <div className="mobile-payments-settlement-summary">
                <div className="mobile-payments-settlement-row">
                  <span>Completato</span>
                  <strong>{dateTimeLabel(latestAutomaticSettlement.completedAtMs)}</strong>
                </div>
                <div className="mobile-payments-settlement-row">
                  <span>ID fondo</span>
                  <strong>{latestAutomaticSettlement.cashFloatId}</strong>
                </div>
                <div className="mobile-payments-settlement-row">
                  <span>Differenza</span>
                  <strong>{formatCurrency(latestAutomaticSettlement.differenceCents / 100)}</strong>
                </div>
                <div className="mobile-payments-settlement-row">
                  <span>Mismatch confermato</span>
                  <strong>{latestAutomaticSettlement.mismatchConfirmed ? "Si" : "No"}</strong>
                </div>
              </div>
              <pre className="payments-ticket-preview">{latestAutomaticSettlement.printText}</pre>
              {automaticReprintMessage ? (
                <div className="mobile-payments-settlement-note">{automaticReprintMessage}</div>
              ) : null}
            </div>
            <div className="mobile-payments-settlement-actions">
              <button
                type="button"
                className="smallbtn mobile-payments-settlement-btn is-secondary"
                onClick={() => setAutomaticDetailOpen(false)}
              >
                Chiudi
              </button>
              <button
                type="button"
                className="smallbtn mobile-payments-settlement-btn is-primary"
                disabled={automaticReprintBusy}
                onClick={() => void handleAutomaticReprint()}
              >
                {automaticReprintBusy ? "Ristampa..." : "Ristampa"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
