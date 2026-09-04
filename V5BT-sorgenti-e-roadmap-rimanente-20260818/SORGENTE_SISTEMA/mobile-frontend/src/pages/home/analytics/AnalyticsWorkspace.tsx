import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as QRCode from "qrcode";
import { apiFetch } from "../../../api/baseUrl";
import { SETTLEMENT_PRINT_PATH } from "../../../api/paymentSettlementEndpoints";
import {
  applyFiscalReceiptToAnalyticsMovement,
  type AnalyticsMovementRecord,
  analyticsSplitModeLabel,
  analyticsTableLabel,
  canPrintAnalyticsMovement,
  fetchAnalyticsPaymentMovements,
  issueAnalyticsFiscalMovement,
  printAnalyticsPaymentMovement,
  readLocalAnalyticsMovements,
  resolveAnalyticsSessionContext,
  toAnalyticsMovementTime,
  voidAnalyticsFiscalMovement,
} from "../../../api/analyticsPaymentMovements";
import fiscalAgencyIconSrc from "../../../assets/icons/fiscal/agenzia-entrate.png";
import { GlassCard } from "../../../components/GlassCard";
import { resolveFiscalOutcomeState } from "../../../domain/payments/fiscalOutcome";
import { formatCurrency } from "../../../shared/format/currency";
import { useAuthStore } from "../../../store/authStore";
import { getOrCreateDeviceUuid } from "../../../utils/device";
import { triggerLongPressHaptic } from "../../../utils/haptics";
import { readAutomaticCashTicketRecords } from "../../../utils/automaticCashTicketRegistry";
import type { CashFloatTicketRecord } from "../../payments/cashFloatTicket";
import {
  buildAnalyticsAdvancedPrintDetails,
  fiscalOutcomeLabel,
  paymentProviderLabel,
} from "./paymentDetailLines";
import {
  ANALYTICS_PRINT_HOLD_MS,
  analyticsFiscalActionLabel,
  analyticsPrintClickAction,
  analyticsPrintModeLabel,
  canRunAnalyticsFiscalAction,
  nextAnalyticsPrintModeAfterHold,
  resolveAnalyticsFiscalAction,
  type AnalyticsPrintMode,
} from "./analyticsPrintState";
import { CashMovementsView } from "./CashMovementsView";
import { FiscalVoidConfirmDialog } from "./FiscalVoidConfirmDialog";

const ANALYTICS_STORAGE_KEY = "pos_analytics_transactions_v1";
const REFRESH_MS = 12000;
const CASH_FLOAT_AMOUNT_MASK = "€***,**";

export type AnalyticsViewMode = "payments" | "cash_movements" | "cash_floats";

const formatRecordDateTime = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "-";
  try {
    return new Intl.DateTimeFormat("it-IT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString("it-IT");
  }
};

const normalize = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const lower = (value: unknown) => normalize(value).toLowerCase();

const formatDetailValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.map(formatDetailValue).filter(Boolean).join(", ");
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return normalize(value);
};

const movementKindClass = (record: AnalyticsMovementRecord) => {
  if (record.type === "storno") return "kind-storno";
  if (record.type === "replacement") return "kind-replacement";
  return "kind-payment";
};

const movementPillLabel = (record: AnalyticsMovementRecord) => {
  if (record.type === "storno") return "STORNO";
  if (record.type === "replacement") return record.typeLabel;
  return record.methodLabel;
};

const paymentMethodKind = (record: AnalyticsMovementRecord) => {
  if (record.type !== "payment") return "";
  const method = lower(record.methodLabel);
  if (/(contant|cash)/.test(method)) return "method-cash";
  if (/(carta|card|pos|bancomat|visa|mastercard)/.test(method)) return "method-card";
  return "";
};

const PaymentMethodIcon = ({ record }: { record: AnalyticsMovementRecord }) => {
  const kind = paymentMethodKind(record);
  if (kind === "method-cash") {
    return (
      <svg className="analytics-kind-pill-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <circle cx="12" cy="12" r="3" />
        <path d="M6 9h.01M18 15h.01" />
      </svg>
    );
  }
  if (kind === "method-card") {
    return (
      <svg className="analytics-kind-pill-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 10h18M7 15h4" />
      </svg>
    );
  }
  return null;
};

const movementAmountClass = (record: AnalyticsMovementRecord) => {
  if (record.amount < 0) return "is-negative";
  if (record.amount > 0) return "is-positive";
  return "is-zero";
};

const cashFloatStatusLabel = (status: CashFloatTicketRecord["status"]) => {
  if (status === "generated") return "Generato";
  if (status === "loaded") return "Caricato";
  if (status === "used_in_settlement") return "Scaricato";
  if (status === "cancelled") return "Annullato";
  return "Fondo cassa";
};

const DetailLine = ({ label, value }: { label: string; value: unknown }) => {
  const text = formatDetailValue(value);
  if (!text) return null;
  return (
    <div className="mobile-analytics-detail-line">
      <span>{label}</span>
      <strong>{text}</strong>
    </div>
  );
};

const PrintIcon = () => (
  <svg className="mobile-analytics-detail-print-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 8V4h10v4" />
    <path d="M6 17H5a3 3 0 0 1-3-3v-2a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3h-1" />
    <path d="M7 14h10v6H7z" />
    <path d="M18 12h.01" />
  </svg>
);

const EyeIcon = ({ crossed }: { crossed: boolean }) => (
  <svg className="mobile-analytics-detail-eye-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
    <circle cx="12" cy="12" r="3" />
    {crossed ? <path d="M4 4l16 16" /> : null}
  </svg>
);

const sanitizeCents = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
};

const parseCashFloatAmountCentsFromQrPayload = (payload: string): number | null => {
  const text = payload.trim();
  if (!text) return null;
  const candidates = [text];
  const jsonStart = text.indexOf("{");
  if (jsonStart >= 0) candidates.push(text.slice(jsonStart));
  if (text.startsWith("FCA:")) candidates.push(text.slice(4));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const cents = sanitizeCents(
        parsed.totalCents ?? parsed.amountCents ?? parsed.cashFloatCents ?? parsed.valueCents
      );
      if (cents !== null) return cents;
    } catch {
      // Old QR payloads are not guaranteed to be JSON.
    }
  }
  return null;
};

const resolveCashFloatAmountCents = (record: CashFloatTicketRecord | null): number | null => {
  if (!record) return null;
  return (
    sanitizeCents(record.totalCents) ?? parseCashFloatAmountCentsFromQrPayload(record.qrPayload)
  );
};

const CashFloatQrCode = ({ payload }: { payload: string }) => {
  const qr = useMemo(() => {
    try {
      return QRCode.create(payload, { errorCorrectionLevel: "M" });
    } catch {
      return null;
    }
  }, [payload]);

  if (!qr) {
    return <div className="mobile-analytics-cash-qr-unavailable">QR non disponibile</div>;
  }

  const style = { "--cash-qr-size": qr.modules.size } as CSSProperties;
  const cells = Array.from(qr.modules.data, (value) => value === 1);

  return (
    <div className="mobile-analytics-cash-qr-code" style={style} aria-label="QR fondo cassa">
      {cells.map((dark, index) => (
        <span key={index} className={dark ? "is-dark" : undefined} aria-hidden="true" />
      ))}
    </div>
  );
};

type AnalyticsWorkspaceProps = {
  viewMode?: AnalyticsViewMode;
};

export function AnalyticsWorkspace({ viewMode = "payments" }: AnalyticsWorkspaceProps) {
  const {
    userId,
    fullName,
    username,
    token,
    sessionStartedAt,
    deviceUuid,
    activityId,
    roomId,
    role,
    permissions,
  } = useAuthStore();
  const [search, setSearch] = useState("");
  const [records, setRecords] = useState<AnalyticsMovementRecord[]>(() =>
    readLocalAnalyticsMovements()
  );
  const [cashFloatTickets, setCashFloatTickets] = useState<CashFloatTicketRecord[]>(() =>
    readAutomaticCashTicketRecords()
  );
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [selectedCashFloatId, setSelectedCashFloatId] = useState<string | null>(null);
  const [printStatus, setPrintStatus] = useState<"idle" | "printing" | "success" | "error">("idle");
  const [cashFloatPrintStatus, setCashFloatPrintStatus] = useState<
    "idle" | "printing" | "success" | "error"
  >("idle");
  const [printError, setPrintError] = useState("");
  const [cashFloatPrintError, setCashFloatPrintError] = useState("");
  const [printMode, setPrintMode] = useState<AnalyticsPrintMode>("normal");
  const [printHolding, setPrintHolding] = useState(false);
  const [fiscalVoidOpen, setFiscalVoidOpen] = useState(false);
  const [fiscalActionStatus, setFiscalActionStatus] = useState<
    "idle" | "running" | "success" | "error"
  >("idle");
  const [fiscalActionError, setFiscalActionError] = useState("");
  const [cashFloatAmountVisible, setCashFloatAmountVisible] = useState(false);
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const printHoldTimer = useRef<number | null>(null);
  const printLongPressTriggered = useRef(false);

  const effectiveDeviceUuid = useMemo(
    () => (deviceUuid && deviceUuid.trim() ? deviceUuid : getOrCreateDeviceUuid()),
    [deviceUuid]
  );

  const session = useMemo(() => {
    void sessionRefreshKey;
    return resolveAnalyticsSessionContext({
      token,
      userId,
      username,
      fullName,
      deviceUuid: effectiveDeviceUuid,
      sessionStartedAt,
    });
  }, [effectiveDeviceUuid, fullName, sessionRefreshKey, sessionStartedAt, token, userId, username]);

  const selectedCashFloatTicket = useMemo(
    () => cashFloatTickets.find((record) => record.cashFloatId === selectedCashFloatId) || null,
    [cashFloatTickets, selectedCashFloatId]
  );

  const selectedCashFloatAmountCents = useMemo(
    () => resolveCashFloatAmountCents(selectedCashFloatTicket),
    [selectedCashFloatTicket]
  );

  const selectedCashFloatAmountLabel =
    cashFloatAmountVisible && selectedCashFloatAmountCents !== null
      ? formatCurrency(selectedCashFloatAmountCents / 100)
      : cashFloatAmountVisible
        ? "Non disponibile"
        : CASH_FLOAT_AMOUNT_MASK;

  useEffect(() => {
    if (viewMode !== "payments") return;
    let alive = true;
    let controller: AbortController | null = null;

    const refresh = async () => {
      controller?.abort();
      const nextController = new AbortController();
      controller = nextController;
      try {
        const nextRecords = await fetchAnalyticsPaymentMovements(session, nextController.signal);
        if (alive) {
          setRecords((current) =>
            JSON.stringify(current) === JSON.stringify(nextRecords) ? current : nextRecords
          );
        }
      } catch {
        if (!alive || nextController.signal.aborted) return;
        setRecords(readLocalAnalyticsMovements());
      }
    };

    void refresh();
    const timerId = window.setInterval(() => {
      void refresh();
    }, REFRESH_MS);
    const onRefresh = () => {
      setSessionRefreshKey((value) => value + 1);
      void refresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (
        event.key !== null &&
        event.key !== ANALYTICS_STORAGE_KEY &&
        event.key !== "pos_session_started_at" &&
        !event.key.startsWith("payment_settlement_cutoff_v1")
      ) {
        return;
      }
      void refresh();
    };

    window.addEventListener("focus", onRefresh);
    window.addEventListener("storage", onStorage);
    window.addEventListener("mobile:payment-config-restored", onRefresh);
    window.addEventListener("mobile:payment-config-reset", onRefresh);
    window.addEventListener("mobile:payments:settlement-completed", onRefresh);

    return () => {
      alive = false;
      controller?.abort();
      window.clearInterval(timerId);
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("mobile:payment-config-restored", onRefresh);
      window.removeEventListener("mobile:payment-config-reset", onRefresh);
      window.removeEventListener("mobile:payments:settlement-completed", onRefresh);
    };
  }, [session, viewMode]);

  useEffect(() => {
    if (viewMode !== "cash_floats") return;
    const refreshCashFloatTickets = () => setCashFloatTickets(readAutomaticCashTicketRecords());
    window.addEventListener("focus", refreshCashFloatTickets);
    window.addEventListener("storage", refreshCashFloatTickets);
    window.addEventListener(
      "mobile:automatic-cash-ticket-records-changed",
      refreshCashFloatTickets
    );
    window.addEventListener(
      "mobile:automatic-cash-settlement-records-changed",
      refreshCashFloatTickets
    );
    return () => {
      window.removeEventListener("focus", refreshCashFloatTickets);
      window.removeEventListener("storage", refreshCashFloatTickets);
      window.removeEventListener(
        "mobile:automatic-cash-ticket-records-changed",
        refreshCashFloatTickets
      );
      window.removeEventListener(
        "mobile:automatic-cash-settlement-records-changed",
        refreshCashFloatTickets
      );
    };
  }, [viewMode]);

  useEffect(() => {
    if (!selectedRecordId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedRecordId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedRecordId]);

  useEffect(() => {
    setPrintStatus("idle");
    setPrintError("");
    setPrintMode("normal");
    setPrintHolding(false);
    setFiscalVoidOpen(false);
    setFiscalActionStatus("idle");
    setFiscalActionError("");
    printLongPressTriggered.current = false;
    if (printHoldTimer.current !== null) {
      window.clearTimeout(printHoldTimer.current);
      printHoldTimer.current = null;
    }
  }, [selectedRecordId]);

  useEffect(() => {
    setCashFloatPrintStatus("idle");
    setCashFloatPrintError("");
    setCashFloatAmountVisible(false);
  }, [selectedCashFloatId]);

  useEffect(() => {
    setSelectedRecordId(null);
    setSelectedCashFloatId(null);
  }, [viewMode]);

  useEffect(() => {
    const cancelPendingHold = () => {
      if (printHoldTimer.current !== null) {
        window.clearTimeout(printHoldTimer.current);
        printHoldTimer.current = null;
      }
      printLongPressTriggered.current = false;
      setPrintHolding(false);
    };
    window.addEventListener("blur", cancelPendingHold);
    return () => {
      window.removeEventListener("blur", cancelPendingHold);
      cancelPendingHold();
    };
  }, []);

  const filteredMovements = useMemo(() => {
    const query = search.trim().toLowerCase();
    const userName = lower(session.fullName || session.username);
    const cutoff = Math.max(session.sessionStartedAt || 0, session.settlementCutoffAt || 0);

    return records.filter((record) => {
      const recordUserId = normalize(record.operatorId);
      const recordUserName = lower(record.operatorName);
      if (session.userId && recordUserId && recordUserId !== session.userId) return false;
      if (
        session.userId &&
        !recordUserId &&
        userName &&
        recordUserName &&
        recordUserName !== userName
      )
        return false;
      const recordTime = toAnalyticsMovementTime(record.createdAt);
      if (cutoff && recordTime && recordTime < cutoff) return false;
      if (!query) return true;

      return [
        record.typeLabel,
        record.methodLabel,
        analyticsTableLabel(record),
        record.productName,
        record.note,
        record.paymentId,
        record.transactionIds.join(" "),
        record.orderIds.join(" "),
        record.orderReference,
        formatDetailValue(record.articleReference),
      ].some((value) => lower(value).includes(query));
    });
  }, [
    records,
    search,
    session.fullName,
    session.sessionStartedAt,
    session.settlementCutoffAt,
    session.userId,
    session.username,
  ]);

  const filteredCashFloatTickets = useMemo(() => {
    const query = search.trim().toLowerCase();
    return cashFloatTickets.filter((record) => {
      if (!query) return true;
      return [
        record.cashFloatId,
        record.assignmentId,
        record.combinationId,
        record.businessEveningKey,
        record.operatorName,
        cashFloatStatusLabel(record.status),
      ].some((value) => lower(value).includes(query));
    });
  }, [cashFloatTickets, search]);

  const totals = useMemo(() => {
    const byLabel = new Map<string, { label: string; count: number; total: number }>();
    filteredMovements.forEach((record) => {
      const label =
        normalize(record.type === "payment" ? record.methodLabel : record.typeLabel) ||
        "Non specificato";
      const current = byLabel.get(label) || { label, count: 0, total: 0 };
      current.count += 1;
      current.total += record.amount;
      byLabel.set(label, current);
    });
    return {
      groups: [...byLabel.values()].sort(
        (left, right) => Math.abs(right.total) - Math.abs(left.total)
      ),
    };
  }, [filteredMovements]);

  const cashFloatTotals = useMemo(() => {
    const byStatus = new Map<string, { label: string; count: number }>();
    filteredCashFloatTickets.forEach((record) => {
      const label = cashFloatStatusLabel(record.status);
      const current = byStatus.get(label) || { label, count: 0 };
      current.count += 1;
      byStatus.set(label, current);
    });
    return [...byStatus.values()].sort((left, right) => right.count - left.count);
  }, [filteredCashFloatTickets]);

  const selectedRecord = useMemo(
    () => records.find((record) => record.id === selectedRecordId) || null,
    [records, selectedRecordId]
  );
  const selectedFiscalState = selectedRecord
    ? resolveFiscalOutcomeState(selectedRecord)
    : "missing";
  const selectedFiscalDocumentLabel = selectedRecord
    ? [
        selectedRecord.fiscalDocType || "Documento",
        selectedRecord.fiscalDocNo || normalize(selectedRecord.raw?.fiscalReceiptId),
      ]
        .filter(Boolean)
        .join(" ") || `Pagamento ${selectedRecord.paymentId}`
    : "Documento fiscale";
  const selectedFiscalAction = resolveAnalyticsFiscalAction({
    role,
    permissions,
    fiscalState: selectedFiscalState,
    documentReference:
      selectedRecord?.fiscalDocNo || normalize(selectedRecord?.raw?.fiscalReceiptId),
  });
  const fiscalActionBusy = fiscalActionStatus === "running";
  const fiscalActionVisible = selectedFiscalAction !== "hidden";
  const fiscalActionEnabled = canRunAnalyticsFiscalAction(selectedFiscalAction);

  const updateSelectedFiscalReceipt = (
    receipt: Awaited<ReturnType<typeof issueAnalyticsFiscalMovement>>
  ) => {
    if (!selectedRecord) return;
    setRecords((current) =>
      current.map((record) =>
        record.id === selectedRecord.id
          ? applyFiscalReceiptToAnalyticsMovement(record, receipt)
          : record
      )
    );
  };

  const handlePrint = async (advanced = false) => {
    if (!selectedRecord || printStatus === "printing" || fiscalActionBusy) return;
    setPrintStatus("printing");
    setPrintError("");
    try {
      await printAnalyticsPaymentMovement(session, selectedRecord, {
        advanced,
        advancedDetails: advanced
          ? buildAnalyticsAdvancedPrintDetails(
              selectedRecord,
              formatRecordDateTime(selectedRecord.createdAt)
            )
          : undefined,
      });
      if (advanced) setPrintMode("normal");
      setPrintStatus("success");
      window.setTimeout(() => setPrintStatus("idle"), 1400);
    } catch (error) {
      setPrintStatus("error");
      setPrintError(error instanceof Error ? error.message : "Stampa non riuscita.");
      window.setTimeout(() => setPrintStatus("idle"), 1800);
    }
  };

  const handleFiscalIssue = async () => {
    if (
      !selectedRecord ||
      printStatus === "printing" ||
      fiscalActionBusy ||
      selectedFiscalAction !== "issue"
    )
      return;
    setFiscalActionStatus("running");
    setFiscalActionError("");
    try {
      const receipt = await issueAnalyticsFiscalMovement(session, selectedRecord);
      updateSelectedFiscalReceipt(receipt);
      setFiscalActionStatus("success");
      window.setTimeout(() => setFiscalActionStatus("idle"), 1400);
    } catch (error) {
      setFiscalActionStatus("error");
      setFiscalActionError(
        error instanceof Error ? error.message : "Emissione fiscale non riuscita."
      );
    }
  };

  const handleFiscalVoidConfirm = async () => {
    if (!selectedRecord || fiscalActionBusy || selectedFiscalAction !== "void") return;
    setFiscalActionStatus("running");
    setFiscalActionError("");
    try {
      const receipt = await voidAnalyticsFiscalMovement(session, selectedRecord);
      updateSelectedFiscalReceipt(receipt);
      setFiscalVoidOpen(false);
      setFiscalActionStatus("success");
      window.setTimeout(() => setFiscalActionStatus("idle"), 1400);
    } catch (error) {
      setFiscalActionStatus("error");
      setFiscalActionError(
        error instanceof Error ? error.message : "Annullamento fiscale non riuscito."
      );
    }
  };

  const handleCashFloatPrint = async () => {
    if (!selectedCashFloatTicket || cashFloatPrintStatus === "printing") return;
    setCashFloatPrintStatus("printing");
    setCashFloatPrintError("");
    try {
      const effectiveUserId = session.userId || userId || "";
      const response = await apiFetch(SETTLEMENT_PRINT_PATH, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(effectiveUserId ? { "X-User-Id": effectiveUserId } : {}),
          ...(effectiveDeviceUuid ? { "X-Device-Uuid": effectiveDeviceUuid } : {}),
        },
        body: JSON.stringify({
          kind: "preconto",
          clientApp: "mobile-automatic-cash-monitor",
          token: token || "",
          userId: effectiveUserId,
          username: session.username || "",
          fullName: session.fullName || "",
          deviceUuid: effectiveDeviceUuid,
          ignoreWorkstationRouting: true,
          operationalSchemaVersion: 2,
          activityId: activityId || "",
          roomId: roomId || "",
          precontoProfile: "cash",
          text: selectedCashFloatTicket.printText,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: unknown;
        error?: unknown;
        message?: unknown;
      } | null;
      if (!response.ok || payload?.ok === false) {
        throw new Error(
          normalize(payload?.error ?? payload?.message) || "Ristampa fondo cassa non riuscita."
        );
      }
      setCashFloatPrintStatus("success");
      window.setTimeout(() => setCashFloatPrintStatus("idle"), 1400);
    } catch (error) {
      setCashFloatPrintStatus("error");
      setCashFloatPrintError(
        error instanceof Error ? error.message : "Ristampa fondo cassa non riuscita."
      );
      window.setTimeout(() => setCashFloatPrintStatus("idle"), 1800);
    }
  };

  const clearPrintHold = () => {
    setPrintHolding(false);
    if (printHoldTimer.current === null) return;
    window.clearTimeout(printHoldTimer.current);
    printHoldTimer.current = null;
  };

  const cancelPrintHold = () => {
    clearPrintHold();
    printLongPressTriggered.current = false;
  };

  const startPrintHold = () => {
    if (!selectedRecord || printStatus === "printing" || fiscalActionBusy) return;
    clearPrintHold();
    printLongPressTriggered.current = false;
    setPrintHolding(true);
    printHoldTimer.current = window.setTimeout(() => {
      printHoldTimer.current = null;
      printLongPressTriggered.current = true;
      setPrintHolding(false);
      triggerLongPressHaptic();
      setPrintMode((current) => nextAnalyticsPrintModeAfterHold(current));
    }, ANALYTICS_PRINT_HOLD_MS);
  };

  const handlePrintClick = () => {
    const action = analyticsPrintClickAction(printMode, printLongPressTriggered.current);
    printLongPressTriggered.current = false;
    if (action === "none") return;
    void handlePrint(action === "print-advanced");
  };

  const handleFiscalActionClick = () => {
    if (!fiscalActionEnabled || fiscalActionBusy || printStatus === "printing") return;
    if (selectedFiscalAction === "issue") {
      void handleFiscalIssue();
      return;
    }
    if (selectedFiscalAction === "void") {
      setFiscalActionError("");
      setFiscalVoidOpen(true);
    }
  };

  const printLabel = "STAMPA";
  const fiscalActionLabel =
    fiscalActionBusy && selectedFiscalAction === "issue"
      ? "EMISSIONE..."
      : fiscalActionBusy && selectedFiscalAction === "void"
        ? "ANNULLAMENTO..."
        : analyticsFiscalActionLabel(selectedFiscalAction);

  return (
    <GlassCard className="home-card workspace-card analytics-workspace-card mobile-analytics-clean">
      <div className="card-body analytics-body">
        <label className="analytics-search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              viewMode === "cash_movements"
                ? "Cerca per tipo, operatore, motivo..."
                : viewMode === "cash_floats"
                  ? "Cerca fondo cassa, operatore, ID..."
                  : "Cerca per tavolo, metodo, ID..."
            }
          />
        </label>

        {viewMode === "payments" ? (
          <>
            <div className="analytics-methods">
              {totals.groups.length === 0 ? (
                <div className="analytics-empty">Nessun pagamento trovato per questo turno.</div>
              ) : (
                totals.groups.map((entry) => (
                  <section
                    key={`movement-summary-${entry.label}`}
                    className="analytics-method-card"
                  >
                    <header className="analytics-method-head">
                      <strong>{entry.label}</strong>
                      <span>{entry.count} operazioni</span>
                    </header>
                    <div className="analytics-method-total">{formatCurrency(entry.total)}</div>
                  </section>
                ))
              )}
            </div>

            <div className="analytics-list">
              {filteredMovements.length === 0 ? (
                <div className="analytics-empty">Nessun pagamento trovato per questo turno.</div>
              ) : (
                filteredMovements.map((record) => (
                  <article
                    key={record.id}
                    className={`analytics-row ${movementKindClass(record)} mobile-analytics-payment-row-native`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedRecordId(record.id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setSelectedRecordId(record.id);
                    }}
                  >
                    <div className="analytics-row-top">
                      <span
                        className={`analytics-kind-pill ${movementKindClass(record)} ${paymentMethodKind(record)}`}
                      >
                        <PaymentMethodIcon record={record} />
                        {movementPillLabel(record)}
                      </span>
                      <span className="analytics-time">
                        {formatRecordDateTime(record.createdAt)}
                      </span>
                    </div>
                    <div className="analytics-row-main">
                      <strong className={movementAmountClass(record)}>
                        {formatCurrency(record.amount)}
                      </strong>
                      <span>{analyticsTableLabel(record)}</span>
                    </div>
                    <div className="analytics-row-meta">
                      {[
                        record.methodLabel,
                        record.productName ? `Prodotto: ${record.productName}` : "",
                        record.paymentId ? `ID: ${record.paymentId}` : "",
                      ]
                        .filter(Boolean)
                        .join(" - ") || "-"}
                    </div>
                    {record.note ? (
                      <div className="analytics-row-note">
                        <strong>Nota: </strong>
                        {record.note}
                      </div>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          </>
        ) : viewMode === "cash_movements" ? (
          <CashMovementsView search={search} />
        ) : (
          <>
            <div className="analytics-methods">
              {cashFloatTotals.length === 0 ? (
                <div className="analytics-empty">Nessun fondo cassa trovato.</div>
              ) : (
                cashFloatTotals.map((entry) => (
                  <section
                    key={`cash-float-summary-${entry.label}`}
                    className="analytics-method-card"
                  >
                    <header className="analytics-method-head">
                      <strong>{entry.label}</strong>
                      <span>{entry.count} scontrini</span>
                    </header>
                    <div className="analytics-method-total">{entry.count}</div>
                  </section>
                ))
              )}
            </div>

            <div className="analytics-list">
              {filteredCashFloatTickets.length === 0 ? (
                <div className="analytics-empty">Nessun fondo cassa trovato.</div>
              ) : (
                filteredCashFloatTickets.map((record) => (
                  <article
                    key={record.cashFloatId}
                    className="analytics-row kind-payment mobile-analytics-payment-row-native mobile-analytics-cash-float-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedCashFloatId(record.cashFloatId)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setSelectedCashFloatId(record.cashFloatId);
                    }}
                  >
                    <div className="analytics-row-top">
                      <span className="analytics-kind-pill kind-payment">
                        {cashFloatStatusLabel(record.status)}
                      </span>
                      <span className="analytics-time">
                        {formatRecordDateTime(record.createdAtMs)}
                      </span>
                    </div>
                    <div className="analytics-row-main">
                      <strong>{record.cashFloatId}</strong>
                      <span>{record.operatorName}</span>
                    </div>
                    <div className="analytics-row-meta">
                      {[
                        record.businessEveningKey ? `Serata: ${record.businessEveningKey}` : "",
                        record.assignmentId ? `Assegnazione: ${record.assignmentId}` : "",
                        record.combinationId ? `Config: ${record.combinationId}` : "",
                      ]
                        .filter(Boolean)
                        .join(" - ") || "-"}
                    </div>
                  </article>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {selectedRecord ? (
        <div
          className="mobile-analytics-detail-backdrop"
          onPointerDown={() => setSelectedRecordId(null)}
        >
          <section
            className="mobile-analytics-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Dettaglio movimento pagamento"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header className="mobile-analytics-detail-head">
              <div>
                <strong>DETTAGLIO PAGAMENTO</strong>
              </div>
              <div className="mobile-analytics-detail-actions">
                <button
                  type="button"
                  className="smallbtn mobile-analytics-detail-close"
                  aria-label="Chiudi"
                  onClick={() => setSelectedRecordId(null)}
                >
                  X
                </button>
              </div>
            </header>
            <div className="mobile-analytics-detail-body">
              <DetailLine label="Data" value={formatRecordDateTime(selectedRecord.createdAt)} />
              <DetailLine label="Tavolo" value={analyticsTableLabel(selectedRecord)} />
              <DetailLine
                label="Operatore"
                value={selectedRecord.operatorName || selectedRecord.operatorId}
              />
              <DetailLine label="Metodo" value={selectedRecord.methodLabel} />
              <DetailLine
                label="Rif. comanda"
                value={selectedRecord.orderReference || selectedRecord.orderIds}
              />
              <DetailLine label="Tipo split" value={analyticsSplitModeLabel(selectedRecord)} />
              <DetailLine label="Importo" value={formatCurrency(selectedRecord.amount)} />
              <DetailLine label="Provider" value={paymentProviderLabel(selectedRecord)} />
              <DetailLine label="Esito Fiscale" value={fiscalOutcomeLabel(selectedRecord)} />
              {printError || fiscalActionError ? (
                <div className="mobile-analytics-detail-error">
                  {printError || fiscalActionError}
                </div>
              ) : null}
            </div>
            {canPrintAnalyticsMovement(selectedRecord) ? (
              <footer
                className={`mobile-analytics-detail-foot ${
                  fiscalActionVisible ? "has-fiscal-action" : ""
                }`}
              >
                {fiscalActionVisible ? (
                  <button
                    type="button"
                    className={`smallbtn mobile-analytics-fiscal-action is-${selectedFiscalAction}`}
                    disabled={
                      !fiscalActionEnabled || fiscalActionBusy || printStatus === "printing"
                    }
                    aria-label={analyticsFiscalActionLabel(selectedFiscalAction)}
                    aria-busy={fiscalActionBusy}
                    onClick={handleFiscalActionClick}
                  >
                    {selectedFiscalAction === "issue" ? (
                      <img
                        src={fiscalAgencyIconSrc}
                        className="mobile-analytics-fiscal-action-icon"
                        alt=""
                        aria-hidden="true"
                      />
                    ) : null}
                    <span>{fiscalActionLabel}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`smallbtn mobile-analytics-detail-print ${
                    printStatus === "error"
                      ? "is-error"
                      : printMode === "advanced"
                        ? "is-advanced"
                        : printStatus === "success"
                          ? "is-success"
                          : printStatus === "printing"
                            ? "is-printing"
                            : printHolding
                              ? "is-holding"
                              : ""
                  }`}
                  disabled={printStatus === "printing" || fiscalActionBusy}
                  aria-label={analyticsPrintModeLabel(printMode)}
                  aria-pressed={printMode !== "normal"}
                  aria-busy={printStatus === "printing"}
                  onPointerDown={startPrintHold}
                  onPointerUp={clearPrintHold}
                  onPointerCancel={cancelPrintHold}
                  onPointerLeave={cancelPrintHold}
                  onBlur={cancelPrintHold}
                  onClick={handlePrintClick}
                >
                  <PrintIcon />
                  <span>{printLabel}</span>
                </button>
              </footer>
            ) : null}
          </section>
          <FiscalVoidConfirmDialog
            open={fiscalVoidOpen}
            documentLabel={selectedFiscalDocumentLabel}
            busy={fiscalActionBusy}
            error={fiscalActionError}
            onClose={() => {
              if (!fiscalActionBusy) setFiscalVoidOpen(false);
            }}
            onConfirm={() => void handleFiscalVoidConfirm()}
          />
        </div>
      ) : null}

      {selectedCashFloatTicket ? (
        <div
          className="mobile-analytics-detail-backdrop"
          onPointerDown={() => setSelectedCashFloatId(null)}
        >
          <section
            className="mobile-analytics-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Dettaglio fondo cassa"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header className="mobile-analytics-detail-head">
              <div>
                <span>{cashFloatStatusLabel(selectedCashFloatTicket.status)}</span>
                <strong>{selectedCashFloatTicket.cashFloatId}</strong>
              </div>
              <div className="mobile-analytics-detail-actions">
                <button
                  type="button"
                  className="smallbtn mobile-analytics-detail-close"
                  aria-label="Chiudi"
                  onClick={() => setSelectedCashFloatId(null)}
                >
                  X
                </button>
              </div>
            </header>
            <div className="mobile-analytics-detail-body">
              <DetailLine
                label="Data"
                value={formatRecordDateTime(selectedCashFloatTicket.createdAtMs)}
              />
              <DetailLine label="Operatore" value={selectedCashFloatTicket.operatorName} />
              <DetailLine label="Assegnazione" value={selectedCashFloatTicket.assignmentId} />
              <DetailLine label="Combinazione" value={selectedCashFloatTicket.combinationId} />
              <DetailLine label="Serata" value={selectedCashFloatTicket.businessEveningKey} />
              <DetailLine
                label="Stato"
                value={cashFloatStatusLabel(selectedCashFloatTicket.status)}
              />
              <div className="mobile-analytics-cash-secure">
                <div className="mobile-analytics-cash-amount-card">
                  <span>Importo fondo cassa</span>
                  <strong>{selectedCashFloatAmountLabel}</strong>
                  <button
                    type="button"
                    className="smallbtn mobile-analytics-cash-amount-eye"
                    aria-label={cashFloatAmountVisible ? "Nascondi importo" : "Mostra importo"}
                    onClick={() => setCashFloatAmountVisible((value) => !value)}
                  >
                    <EyeIcon crossed={!cashFloatAmountVisible} />
                  </button>
                </div>
                <div className="mobile-analytics-cash-qr-card">
                  <span>QR Code</span>
                  <CashFloatQrCode payload={selectedCashFloatTicket.qrPayload} />
                </div>
              </div>
              {cashFloatPrintError ? (
                <div className="mobile-analytics-detail-error">{cashFloatPrintError}</div>
              ) : null}
            </div>
            <footer className="mobile-analytics-detail-foot">
              <button
                type="button"
                className={`smallbtn mobile-analytics-detail-print ${
                  cashFloatPrintStatus === "printing"
                    ? "is-printing"
                    : cashFloatPrintStatus === "success"
                      ? "is-success"
                      : cashFloatPrintStatus === "error"
                        ? "is-error"
                        : ""
                }`}
                disabled={cashFloatPrintStatus === "printing"}
                onClick={() => void handleCashFloatPrint()}
              >
                <PrintIcon />
                <span>
                  {cashFloatPrintStatus === "printing"
                    ? "RISTAMPA..."
                    : cashFloatPrintStatus === "success"
                      ? "INVIATO"
                      : cashFloatPrintStatus === "error"
                        ? "ERRORE"
                        : "RISTAMPA"}
                </span>
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </GlassCard>
  );
}
