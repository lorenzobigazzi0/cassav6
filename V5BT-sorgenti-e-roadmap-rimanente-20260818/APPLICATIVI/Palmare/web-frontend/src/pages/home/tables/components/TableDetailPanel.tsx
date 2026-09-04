import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { MenuCatalog } from "../../../../api/menu";
import {
  printHistoryOrder,
  printTablePreconto,
  type HistoryPrintKind,
} from "../../../../api/printing";
import { deriveTableVisualState } from "../../../../api/tables";
import type {
  DiningTable,
  DiningTableOrder,
  TableCommercialBenefitApplication,
  TablePaymentAdminAdjustment,
  TablePaymentInvoiceRecipient,
  TablePaymentReceiptType,
  TablePaymentSplitMode,
} from "../../../../api/tables";
import type { ProductClientPriceSnapshot } from "../../../../shared/pricing/productPricing";
import { AdminPaymentAdjustmentDialog } from "./AdminPaymentAdjustmentDialog";
import { TableDetailAnagraphicFields } from "./TableDetailAnagraphicFields";
import { TableOccupyConfirmButton } from "./TableOccupyConfirmButton";
import { TableOrderComposer } from "./TableOrderComposer";
import { HistoryOrderLine } from "./HistoryOrderLine";
import { TablePaymentWizard, type PaymentMethod } from "./TablePaymentWizard";
import {
  TableReservationCountBadge,
  TableReservationsManageButton,
} from "./TableReservationQuickManager";
import { formatClockTime, formatCurrency, tableDraftValidity } from "../utils";
import { shouldReserveTableForReservation } from "../../../../api/tableReservationWindow";
import { getOrderPayableAmount, getTablePayableAmount } from "../payment/paymentArticleUnits";
import { useAuthStore } from "../../../../store/authStore";
import { usePaymentSettingsStore } from "../../../../store/paymentSettingsStore";
import {
  readSessionPreference,
  writeSessionPreference,
} from "../../../../shared/storage/preferenceStorage";
import {
  isClientOptimisticActionsEnabled,
  runBackgroundOptimisticRequest,
} from "../../../../shared/optimistic/clientOptimisticActions";
import { formatElapsedCompact } from "../../utils/time";
import { useAnagraphicAutoSave } from "../useAnagraphicAutoSave";
import { TableDetailHeader } from "./TableDetailHeader";
import type { TableReservationsSeatGuard } from "./TableReservationQuickManager";
import { TableFreeConfirmDialog } from "./TableFreeConfirmDialog";
import { TableNoticeDialog } from "./TableNoticeDialog";
import { triggerLongPressHaptic } from "../../../../utils/haptics";
interface TableDetailPanelProps {
  open: boolean;
  table: DiningTable | null;
  roomName?: string;
  draftName: string;
  draftPhone: string;
  draftCovers: string;
  draftNote: string;
  hasAllergyAlert: boolean;
  selectedAllergens: string[];
  draftManualIntolerance: string;
  allergenOptions: readonly string[];
  setupMode: "occupy" | "reserve";
  reservationTime: string;
  movePickerOpen: boolean;
  moveTableMap: Array<{ id: string; number: number; isFree: boolean; isCurrent: boolean }>;
  orderComposerOpen: boolean;
  paymentWizardOpen: boolean;
  menuCatalog: MenuCatalog | null;
  menuCatalogLoading: boolean;
  menuCatalogError: string | null;
  showAnagraphicUpdate: boolean;
  canCollectPayments: boolean;
  /** A false la consegna e automatica dopo il Pronta: il pulsante non deve comparire. */
  deliveryConfirmationEnabled: boolean;
  busy: boolean;
  errorMessage: string | null;
  actionError: string | null;
  /** Falso nella sala di attesa virtuale: li' non si prenota. */
  canReserve?: boolean;
  reservationSeatGuard?: TableReservationsSeatGuard;
  onFreeTables?: (tableIds: string[]) => Promise<void>;
  onDismissActionError: () => void;
  onClose: () => void;
  onChangeSetupMode: (value: "occupy" | "reserve") => void;
  onChangeName: (value: string) => void;
  onChangePhone: (value: string) => void;
  onChangeCovers: (value: string) => void;
  onChangeNote: (value: string) => void;
  onCommitAllergies: (allergens: string[], manualIntolerance: string) => void;
  onToggleAllergen: (value: string) => void;
  onChangeManualIntolerance: (value: string) => void;
  onChangeReservationTime: (value: string) => void;
  onOpenMovePicker: () => void;
  onCloseMovePicker: () => void;
  onMoveToTable: (targetTableId: string) => void;
  onToggleOrderComposer: (open: boolean) => void;
  onTogglePaymentWizard: (open: boolean) => void;
  onSubmitOrder: (payload: {
    title: string;
    total: number;
    orderNote?: string;
    orderComment?: string;
    lines: Array<{
      name: string;
      qty: number;
      note?: string;
      variantName?: string;
      unitBasePrice?: number;
      unitFinalPrice?: number;
      priceDelta?: number;
      priceChanged?: boolean;
      priceChangeReason?: "variant" | "manual" | "supplement" | "unknown";
      productId?: string;
      clientPriceSnapshot?: ProductClientPriceSnapshot;
    }>;
  }) => Promise<void>;
  onConfirmPayment: (payload: {
    amount: number;
    method: PaymentMethod;
    orderId?: string;
    articleUnitIds?: string[];
    splitMode?: TablePaymentSplitMode;
    adminAdjustment?: TablePaymentAdminAdjustment;
    cashReceived?: number;
    cashSource?: "wallet" | "automatic";
    automaticCashPaymentOperationId?: string;
    receiptType?: TablePaymentReceiptType;
    invoiceRecipient?: TablePaymentInvoiceRecipient | null;
    clientPaymentId?: string;
    note?: string;
    romanSharesPaid?: number;
    romanSharesTotal?: number;
    commercialBenefitApplications?: TableCommercialBenefitApplication[];
  }) => Promise<void> | void;
  onApplyPaymentAdjustment: (
    adjustment: TablePaymentAdminAdjustment,
    targetOrderId?: string
  ) => Promise<void>;
  onSaveMeta: () => void;
  onReserve: () => void;
  onOccupy: () => void;
  onMarkArrived: () => void;
  onFree: () => void;
  onServeOrder: (orderId: string) => void;
  onServiceRecovery: (order: DiningTableOrder, action: ServiceRecoveryAction) => void;
}
const orderStateLabel = (state: string) => {
  if (state === "paid") return "Pagato";
  if (state === "served") return "Consegnato";
  return "In corso";
};

const isIntegrationOrderId = (value: string) => /^\d{5,}$/.test(value.trim());

const orderWorkflowLabel = (order: DiningTableOrder) => {
  if (order.workflowStatus === "cancelled") return "Annullata";
  if (order.state === "paid") return "Pagato";
  if (order.state === "served") return "Consegnato";
  const workflow = order.workflowStatus ?? (isIntegrationOrderId(order.id) ? "waiting" : "ready");
  if (workflow === "waiting") return "Inviato";
  if (workflow === "prep") return "In preparazione";
  if (workflow === "ready") return "Da ritirare";
  if (workflow === "delivered") return "Consegnato";
  return orderStateLabel(order.state);
};

export const canServeHistoryOrder = (
  order: DiningTableOrder,
  deliveryConfirmationEnabled = true
) => {
  if (!deliveryConfirmationEnabled) return false;
  if (order.state !== "in_progress") return false;
  if (!isIntegrationOrderId(order.id)) return true;
  return (order.workflowStatus ?? "waiting") === "ready";
};

const historyPrintKey = (orderId: string, kind: HistoryPrintKind) => `${orderId}::${kind}`;

const historyPrintLabel = (kind: HistoryPrintKind, busy: boolean) => {
  if (busy) return "Stampa...";
  return kind === "order" ? "Comanda" : "Preconto";
};

const orderHistoryListTitle = (order: DiningTableOrder) =>
  order.id ? `Comanda: ${order.id}` : order.title || "Comanda";
const orderHistoryPreviewTitle = (order: DiningTableOrder) =>
  order.id ? `Comanda #${order.id}` : order.title || "Comanda";

const HistoryPrintIcon = () => (
  <span className="mobile-history-print-btn-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M7 9V4h10v5" />
      <rect x="4" y="9" width="16" height="8" rx="2" />
      <path d="M7 14h10v6H7z" />
      <path d="M16 12h.01" />
    </svg>
  </span>
);

const PaymentAdjustmentIcon = () => (
  <span className="mobile-history-print-btn-icon table-preconto-menu-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M5 4h14v16H5z" />
      <path d="M8 8h8M8 12h5" />
      <path d="M14.5 18.5 20 13" />
      <path d="M18.6 11.6 20.4 13.4" />
    </svg>
  </span>
);

export type ServiceRecoveryAction = "correction" | "replacement";

const ServiceRecoveryEditIcon = () => (
  <span
    className="mobile-history-print-btn-icon mobile-service-recovery-btn-icon"
    aria-hidden="true"
  >
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M4 20h4.2L19.4 8.8a2 2 0 0 0 0-2.8L18 4.6a2 2 0 0 0-2.8 0L4 15.8V20Z" />
      <path d="M14.8 6.2 17.8 9.2" />
    </svg>
  </span>
);

const ServiceRecoveryReplacementIcon = () => (
  <span
    className="mobile-history-print-btn-icon mobile-service-recovery-btn-icon"
    aria-hidden="true"
  >
    <img
      className="mobile-service-recovery-broken-glass"
      src="/mobile/assets/brokenglass.png"
      alt=""
    />
  </span>
);

const workflowForServiceRecovery = (order: DiningTableOrder) =>
  order.workflowStatus ?? (isIntegrationOrderId(order.id) ? "waiting" : "ready");

export const canShowServiceRecoveryCorrection = (order: DiningTableOrder) => {
  if (!isIntegrationOrderId(order.id) || order.state === "paid" || order.state === "served")
    return false;
  const workflow = workflowForServiceRecovery(order);
  return workflow !== "ready" && workflow !== "delivered";
};

export const canShowServiceRecoveryReplacement = (order: DiningTableOrder) => {
  if (!isIntegrationOrderId(order.id)) return false;
  if (workflowForServiceRecovery(order) === "cancelled") return false;
  return order.lines.some((line) => Math.trunc(Number(line.qty) || 0) > 0);
};

type TableDetailUiState = {
  allergyBoxOpen: boolean;
  anagraphicBoxOpen: boolean;
  historyOpen: boolean;
  historySort: "desc" | "asc";
  selectedHistoryOrderId: string | null;
};

type PaymentTargetState = {
  amount: number;
  orderId?: string;
  articleUnitIds?: string[];
  splitMode?: TablePaymentSplitMode;
  adminAdjustment?: TablePaymentAdminAdjustment;
};

export function TableDetailPanel({
  open,
  table,
  roomName,
  draftName,
  draftPhone,
  draftCovers,
  draftNote,
  hasAllergyAlert,
  selectedAllergens,
  draftManualIntolerance,
  allergenOptions,
  setupMode,
  reservationTime,
  movePickerOpen,
  moveTableMap,
  orderComposerOpen,
  paymentWizardOpen,
  menuCatalog,
  menuCatalogLoading,
  menuCatalogError,
  showAnagraphicUpdate,
  canCollectPayments,
  deliveryConfirmationEnabled,
  busy,
  errorMessage,
  actionError,
  canReserve = true,
  reservationSeatGuard,
  onFreeTables,
  onDismissActionError,
  onClose,
  onChangeSetupMode,
  onChangeName,
  onChangePhone,
  onChangeCovers,
  onChangeNote,
  onCommitAllergies,
  onToggleAllergen,
  onChangeManualIntolerance,
  onChangeReservationTime,
  onOpenMovePicker,
  onCloseMovePicker,
  onMoveToTable,
  onToggleOrderComposer,
  onTogglePaymentWizard,
  onSubmitOrder,
  onConfirmPayment,
  onApplyPaymentAdjustment,
  onSaveMeta,
  onReserve,
  onOccupy,
  onMarkArrived,
  onFree,
  onServeOrder,
  onServiceRecovery,
}: TableDetailPanelProps) {
  const [allergyBoxOpen, setAllergyBoxOpen] = useState(false);
  const [anagraphicBoxOpen, setAnagraphicBoxOpen] = useState(false);
  const [selectedHistoryOrder, setSelectedHistoryOrder] = useState<DiningTableOrder | null>(null);
  const [paymentTarget, setPaymentTarget] = useState<PaymentTargetState | null>(null);
  const [adminPaymentAdjustmentTarget, setAdminPaymentAdjustmentTarget] =
    useState<PaymentTargetState | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySort, setHistorySort] = useState<"desc" | "asc">("desc");
  const [freeConfirmOpen, setFreeConfirmOpen] = useState(false);
  const [timeNow, setTimeNow] = useState(() => Date.now());
  const [historyPrintBusy, setHistoryPrintBusy] = useState<Record<string, boolean>>({});
  const [historyPrintToast, setHistoryPrintToast] = useState<{
    id: number;
    message: string;
    tone: "success" | "error";
  } | null>(null);
  const [tablePrecontoMenuOpen, setTablePrecontoMenuOpen] = useState(false);
  const [tablePrecontoBusy, setTablePrecontoBusy] = useState(false);
  const payLongPressTimerRef = useRef<number | null>(null);
  const payLongPressTriggeredRef = useRef(false);
  const { token, userId, username, fullName, role, deviceUuid, activityId, roomId } =
    useAuthStore();
  const { posId, cashFloat, cashFloatLocked } = usePaymentSettingsStore();
  const optimisticActionsEnabled = useMemo(() => isClientOptimisticActionsEnabled(), []);
  const tableDetailUiKey = table ? `tables_detail_ui_${table.id}` : "";
  const effectiveTableName = table?.tableName?.trim() || (table ? `Tavolo ${table.number}` : "");
  const visualState = table ? deriveTableVisualState(table) : "free";
  const isFree = table?.occupancyState === "free";
  const isReserved = table?.occupancyState === "reserved";
  const isSeated = table?.occupancyState === "seated";
  // La finestra e' quella della piattaforma: entro trenta minuti il tavolo e'
  // bloccato dalla prenotazione, prima si usa come libero.
  const withinReservationWindow =
    isReserved && shouldReserveTableForReservation(table?.reservationAt ?? 0, timeNow);
  // Solo un tavolo libero, o prenotato ma fuori finestra, si usa come vuoto:
  // un tavolo accomodato resta accomodato.
  const actsAsFree = isFree || (isReserved && !withinReservationWindow);
  const hasPos = Boolean(posId);
  const hasCashFloat = cashFloatLocked && cashFloat !== null;
  const paymentConfigured = hasPos || hasCashFloat;
  const canMove = Boolean(table && !isFree);
  const canFree = Boolean(table && table.ordersInProgress <= 0 && table.amountDue <= 0);
  const canOrder = Boolean(table && isSeated);
  const orderMenuReady = Boolean(menuCatalog && menuCatalog.products.length > 0);
  const orderMenuError = canOrder
    ? !menuCatalogLoading && !orderMenuReady
      ? menuCatalogError || "Menu non disponibile per questa sala e attivita."
      : menuCatalogError
    : null;
  const canPay = Boolean(table && table.amountDue > 0 && canCollectPayments && paymentConfigured);
  const canUseAdminPaymentAdjustments = role === "admin";
  const adminTablePaymentAmount = getTablePayableAmount(table);
  const availableMoveTargets = moveTableMap.filter((entry) => entry.isFree && !entry.isCurrent);
  const historyOrderCount = table?.orderHistory.length ?? 0;
  const showFreeAction = canFree && !actsAsFree;
  const hasSecondaryAction = Boolean(canPay || showFreeAction);
  const showBottomActions =
    actsAsFree || showFreeAction || ((isSeated || isReserved) && (canOrder || canPay));
  const showStats = Boolean(
    table && (table.ordersTaken > 0 || table.ordersInProgress > 0 || table.amountDue > 0)
  );
  const pendingTableAdminPaymentTarget =
    paymentTarget?.adminAdjustment && !paymentTarget.orderId ? paymentTarget : null;
  const tablePayAmount = pendingTableAdminPaymentTarget?.amount ?? adminTablePaymentAmount;
  const reserveMode = canReserve && setupMode === "reserve";
  const showReservationFields = Boolean((actsAsFree && reserveMode) || withinReservationWindow);
  const showOccupyFields = Boolean(
    (actsAsFree && !reserveMode) || (isSeated && !isReserved)
  );
  const showPhoneField = showReservationFields || showOccupyFields;
  const canEditAnagraphic = showOccupyFields || showReservationFields;
  const showAnagraphicCard = !actsAsFree && canEditAnagraphic;
  const { canOccupy: canConfirmOccupy, canReserve: canConfirmReserve } = tableDraftValidity({
    covers: draftCovers,
    name: draftName,
    phone: draftPhone,
    time: reservationTime,
  });
  const previewName = draftName.trim() || effectiveTableName || "-";
  const previewPhone = draftPhone.trim() || table?.customerPhone?.trim() || "";
  const previewCovers =
    Number(draftCovers) > 0 ? `${draftCovers} coperti` : `${table?.covers ?? 0} coperti`;
  const previewHasIntolerances =
    hasAllergyAlert && (selectedAllergens.length > 0 || Boolean(draftManualIntolerance.trim()));

  const arrivalTimeLabel =
    isSeated && table?.seatedAt ? formatElapsedCompact(table.seatedAt, timeNow) : "";
  const toggleAnagraphicBox = () => {
    const next = !anagraphicBoxOpen;
    setAnagraphicBoxOpen(next);
    if (next) setHistoryOpen(false);
  };

  const toggleHistoryBox = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) setAnagraphicBoxOpen(false);
  };

  const historyHeader = (
    <div
      className="table-history-head"
      onClick={() => {
        if (!busy) toggleHistoryBox();
      }}
    >
      <div className="table-history-title">Storico ordini ({historyOrderCount})</div>
      <div className="table-history-head-actions">
        {historyOpen && (
          <button
            type="button"
            className="smallbtn table-history-toggle-btn table-history-icon-btn"
            onClick={(event) => {
              event.stopPropagation();
              setHistorySort((prev) => (prev === "desc" ? "asc" : "desc"));
            }}
            disabled={busy}
            aria-label={historySort === "desc" ? "Ordina per più recenti" : "Ordina per più vecchi"}
            title={historySort === "desc" ? "Ordina per più recenti" : "Ordina per più vecchi"}
          >
            <svg
              viewBox="0 0 24 24"
              className={`table-history-sort-icon ${historySort === "asc" ? "is-asc" : ""}`}
              aria-hidden="true"
            >
              <path d="M12 4v12M7 11l5 5 5-5" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={`smallbtn table-history-toggle-btn table-history-icon-btn table-history-expand-btn ${
            historyOpen ? "is-open" : ""
          }`}
          onClick={(event) => {
            event.stopPropagation();
            toggleHistoryBox();
          }}
          disabled={busy}
          aria-expanded={historyOpen}
          aria-label={historyOpen ? "Comprimi storico ordini" : "Espandi storico ordini"}
          title={historyOpen ? "Comprimi storico ordini" : "Espandi storico ordini"}
        >
          <svg
            viewBox="0 0 24 24"
            className={`table-history-chevron ${historyOpen ? "is-open" : ""}`}
            aria-hidden="true"
          >
            <path d="M6 15l6-6 6 6" />
          </svg>
        </button>
      </div>
    </div>
  );

  useEffect(() => {
    if (!table) {
      setAllergyBoxOpen(false);
      setAnagraphicBoxOpen(false);
      setSelectedHistoryOrder(null);
      setPaymentTarget(null);
      setAdminPaymentAdjustmentTarget(null);
      setHistorySort("desc");
      setHistoryOpen(false);
      setFreeConfirmOpen(false);
      setHistoryPrintBusy({});
      setHistoryPrintToast(null);
      return;
    }

    let restoredState: TableDetailUiState | null = null;
    try {
      const raw = readSessionPreference(tableDetailUiKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<TableDetailUiState>;
        const anagraphicBoxOpen = Boolean(parsed.anagraphicBoxOpen);
        restoredState = {
          allergyBoxOpen: Boolean(parsed.allergyBoxOpen),
          anagraphicBoxOpen,
          historyOpen: anagraphicBoxOpen ? false : Boolean(parsed.historyOpen),
          historySort: parsed.historySort === "asc" ? "asc" : "desc",
          selectedHistoryOrderId:
            typeof parsed.selectedHistoryOrderId === "string" &&
            parsed.selectedHistoryOrderId.trim()
              ? parsed.selectedHistoryOrderId
              : null,
        };
      }
    } catch {
      restoredState = null;
    }

    setAllergyBoxOpen(restoredState?.allergyBoxOpen ?? false);
    setAnagraphicBoxOpen(restoredState?.anagraphicBoxOpen ?? false);
    setHistorySort(restoredState?.historySort ?? "desc");
    setHistoryOpen(restoredState?.historyOpen ?? false);
    setSelectedHistoryOrder(
      restoredState?.selectedHistoryOrderId
        ? (table.orderHistory.find((order) => order.id === restoredState.selectedHistoryOrderId) ??
            null)
        : null
    );
    setPaymentTarget(null);
    setAdminPaymentAdjustmentTarget(null);
    setFreeConfirmOpen(false);
    setHistoryPrintBusy({});
    setHistoryPrintToast(null);
  }, [table?.id, tableDetailUiKey]);

  useEffect(() => {
    if (!table) return;
    const payload: TableDetailUiState = {
      allergyBoxOpen,
      anagraphicBoxOpen,
      historyOpen,
      historySort,
      selectedHistoryOrderId: selectedHistoryOrder?.id ?? null,
    };
    try {
      writeSessionPreference(tableDetailUiKey, JSON.stringify(payload));
    } catch {
      // ignore storage failures
    }
  }, [
    allergyBoxOpen,
    anagraphicBoxOpen,
    historyOpen,
    historySort,
    selectedHistoryOrder?.id,
    table?.id,
    tableDetailUiKey,
  ]);

  useEffect(() => {
    if (!table || !selectedHistoryOrder) return;
    const refreshedOrder =
      table.orderHistory.find((order) => order.id === selectedHistoryOrder.id) ?? null;
    if (!refreshedOrder) {
      setSelectedHistoryOrder(null);
      return;
    }
    if (refreshedOrder !== selectedHistoryOrder) setSelectedHistoryOrder(refreshedOrder);
  }, [selectedHistoryOrder, table?.id, table?.orderHistory]);

  useEffect(() => {
    if (!historyOpen) {
      setSelectedHistoryOrder(null);
    }
  }, [historyOpen]);

  useEffect(() => {
    if (!showFreeAction) setFreeConfirmOpen(false);
  }, [showFreeAction]);

  useEffect(() => {
    if (!open) return;
    setTimeNow(Date.now());
    const intervalId = window.setInterval(() => setTimeNow(Date.now()), 60_000);
    return () => window.clearInterval(intervalId);
  }, [open, table?.id]);

  useEffect(() => {
    if (!historyPrintToast) return;
    const timeoutId = window.setTimeout(() => setHistoryPrintToast(null), 2600);
    return () => window.clearTimeout(timeoutId);
  }, [historyPrintToast]);

  useEffect(() => {
    if (!canPay) {
      setTablePrecontoMenuOpen(false);
      setAdminPaymentAdjustmentTarget(null);
    }
  }, [canPay]);

  useEffect(() => {
    return () => {
      if (payLongPressTimerRef.current !== null) {
        window.clearTimeout(payLongPressTimerRef.current);
        payLongPressTimerRef.current = null;
      }
    };
  }, []);

  const orderedHistory = useMemo(() => {
    const source = table?.orderHistory ?? [];
    return [...source].sort((left, right) =>
      historySort === "desc" ? right.createdAt - left.createdAt : left.createdAt - right.createdAt
    );
  }, [historySort, table?.orderHistory]);

  const openHistoryItems = useMemo(() => {
    if (historyOpen) return orderedHistory;
    return [];
  }, [historyOpen, orderedHistory]);

  const showHistoryPrintToast = (message: string, tone: "success" | "error") => {
    setHistoryPrintToast({ id: Date.now(), message, tone });
  };

  const clearPayLongPressTimer = () => {
    if (payLongPressTimerRef.current !== null) {
      window.clearTimeout(payLongPressTimerRef.current);
      payLongPressTimerRef.current = null;
    }
  };

  const openAdminPaymentAdjustment = (target?: PaymentTargetState) => {
    if (!table || !canUseAdminPaymentAdjustments) return false;
    setTablePrecontoMenuOpen(false);
    setAdminPaymentAdjustmentTarget(target ?? { amount: adminTablePaymentAmount });
    return true;
  };

  const startPayLongPressTimer = (target?: PaymentTargetState) => {
    if (!table || !canPay || busy) return;
    clearPayLongPressTimer();
    payLongPressTriggeredRef.current = false;
    payLongPressTimerRef.current = window.setTimeout(() => {
      payLongPressTriggeredRef.current = true;
      triggerLongPressHaptic();
      if (!target?.orderId) {
        setAdminPaymentAdjustmentTarget(null);
        setTablePrecontoMenuOpen(true);
        return;
      }
      if (!openAdminPaymentAdjustment(target)) {
        setTablePrecontoMenuOpen(false);
      }
    }, 560);
  };

  const requestTablePrecontoPrint = async (mode: "complete" | "current") => {
    if (!table || tablePrecontoBusy) return;
    const label = mode === "current" ? "Preconto attuale" : "Preconto completo";
    const request = () =>
      printTablePreconto(
        { token, userId, username, fullName, deviceUuid },
        {
          activityId,
          roomId,
          tableId: table.id,
          tableNumber: table.number,
          tableLabel:
            table.mobileComplexLabel ||
            table.tableLabel ||
            table.logicalTableLabel ||
            table.tableName,
          amountDue: table.amountDue,
          orders: table.orderHistory.map((order) => ({
            id: order.id,
            title: order.title,
            total: order.total,
            createdAt: order.createdAt,
          })),
          mode,
        }
      );
    const showSuccess = (result: Awaited<ReturnType<typeof request>>) => {
      showHistoryPrintToast(
        result.printer ? `${label} inviato su ${result.printer}` : `${label} inviato in stampa`,
        "success"
      );
    };
    if (optimisticActionsEnabled) {
      setTablePrecontoBusy(true);
      setTablePrecontoMenuOpen(false);
      showHistoryPrintToast(`${label} richiesto in stampa`, "success");
      runBackgroundOptimisticRequest(request, {
        onSuccess: showSuccess,
        onError: (error) => {
          showHistoryPrintToast(
            error instanceof Error ? error.message : "Stampa preconto totale non riuscita.",
            "error"
          );
        },
        onSettled: () => setTablePrecontoBusy(false),
      });
      return;
    }
    setTablePrecontoBusy(true);
    try {
      const result = await request();
      showSuccess(result);
      setTablePrecontoMenuOpen(false);
    } catch (error) {
      showHistoryPrintToast(
        error instanceof Error ? error.message : "Stampa preconto totale non riuscita.",
        "error"
      );
    } finally {
      setTablePrecontoBusy(false);
    }
  };

  const requestHistoryPrint = async (orderId: string, kind: HistoryPrintKind) => {
    const printKey = historyPrintKey(orderId, kind);
    if (historyPrintBusy[printKey]) return;
    const label = kind === "order" ? "Comanda" : "Preconto";
    const request = () =>
      printHistoryOrder(
        { token, userId, username, fullName, deviceUuid },
        { activityId, roomId, orderId, kind }
      );
    const showSuccess = (result: Awaited<ReturnType<typeof request>>) => {
      showHistoryPrintToast(
        result.printer ? `${label} inviata su ${result.printer}` : `${label} inviata in stampa`,
        "success"
      );
    };
    setHistoryPrintBusy((current) => ({ ...current, [printKey]: true }));
    if (optimisticActionsEnabled) {
      showHistoryPrintToast(`${label} richiesta in stampa`, "success");
      runBackgroundOptimisticRequest(request, {
        onSuccess: showSuccess,
        onError: (error) => {
          showHistoryPrintToast(
            error instanceof Error ? error.message : "Stampa non riuscita.",
            "error"
          );
        },
        onSettled: () => {
          setHistoryPrintBusy((current) => {
            const next = { ...current };
            delete next[printKey];
            return next;
          });
        },
      });
      return;
    }
    try {
      const result = await request();
      showSuccess(result);
    } catch (error) {
      showHistoryPrintToast(
        error instanceof Error ? error.message : "Stampa non riuscita.",
        "error"
      );
    } finally {
      setHistoryPrintBusy((current) => {
        const next = { ...current };
        delete next[printKey];
        return next;
      });
    }
  };

  const renderHistoryPrintButton = (
    orderId: string,
    kind: HistoryPrintKind,
    placement: "row" | "preview"
  ) => {
    const printKey = historyPrintKey(orderId, kind);
    const isPrinting = Boolean(historyPrintBusy[printKey]);
    const label = historyPrintLabel(kind, isPrinting);
    const kindLabel = kind === "order" ? "comanda" : "preconto";
    return (
      <button
        type="button"
        className={`smallbtn mobile-history-print-btn mobile-history-print-btn-${kind} ${
          placement === "preview" ? "table-history-preview-action" : ""
        } ${isPrinting ? "is-busy" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          void requestHistoryPrint(orderId, kind);
        }}
        disabled={busy || isPrinting}
        data-mobile-order-id={orderId}
        data-mobile-print-kind={kind}
        aria-label={`Stampa ${kindLabel}`}
      >
        <HistoryPrintIcon />
        <span className="mobile-history-print-btn-label">{label}</span>
      </button>
    );
  };

  const renderServiceRecoveryButton = (order: DiningTableOrder, action: ServiceRecoveryAction) => {
    const label = action === "correction" ? "Modifica" : "Reso";
    const ariaLabel = action === "correction" ? "Modifica comanda" : "Reso";
    return (
      <button
        type="button"
        className={`smallbtn mobile-history-print-btn mobile-service-recovery-btn mobile-service-recovery-btn-${action} table-history-preview-action`}
        onClick={(event) => {
          event.stopPropagation();
          onServiceRecovery(order, action);
        }}
        disabled={busy}
        data-order-id={order.id}
        data-msr-native-action={action}
        data-msr-order-id={order.id}
        aria-label={ariaLabel}
      >
        {action === "correction" ? <ServiceRecoveryEditIcon /> : <ServiceRecoveryReplacementIcon />}
        <span className="mobile-history-print-btn-label">{label}</span>
      </button>
    );
  };

  const renderServiceRecoveryActions = (order: DiningTableOrder) => {
    const showCorrection = canShowServiceRecoveryCorrection(order);
    const showReplacement = canShowServiceRecoveryReplacement(order);
    if (!showCorrection && !showReplacement) return null;
    return (
      <div
        className={`mobile-service-recovery-actions native-service-recovery-actions ${
          (showCorrection ? 1 : 0) + (showReplacement ? 1 : 0) <= 1 ? "is-single" : ""
        }`}
        data-native-service-recovery-actions="1"
        data-order-id={order.id}
        data-msr-order-id={order.id}
      >
        {showCorrection ? renderServiceRecoveryButton(order, "correction") : null}
        {showReplacement ? renderServiceRecoveryButton(order, "replacement") : null}
      </div>
    );
  };

  useAnagraphicAutoSave({
    // Mentre il tavolo si usa come libero non si scrive nulla sulla prenotazione.
    enabled: showAnagraphicUpdate && !busy && !actsAsFree,
    table,
    draft: { name: draftName, phone: draftPhone, covers: draftCovers, note: draftNote },
    intolerances: { list: selectedAllergens, manual: draftManualIntolerance },
    save: isReserved ? onReserve : onSaveMeta,
  });

  const anagraphicFields = canEditAnagraphic ? (
    <TableDetailAnagraphicFields
      key={table?.id}
      draftName={draftName}
      draftPhone={draftPhone}
      draftCovers={draftCovers}
      draftNote={draftNote}
      hasAllergyAlert={hasAllergyAlert}
      selectedAllergens={selectedAllergens}
      draftManualIntolerance={draftManualIntolerance}
      allergenOptions={allergenOptions}
      showReservationFields={showReservationFields}
      showPhoneField={showPhoneField}
      reservationTime={reservationTime}
      busy={busy}
      onChangeName={onChangeName}
      onChangePhone={onChangePhone}
      onChangeCovers={onChangeCovers}
      onChangeNote={onChangeNote}
      onCommitAllergies={onCommitAllergies}
      onChangeReservationTime={onChangeReservationTime}
    />
  ) : null;

  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (busy || event.target !== event.currentTarget) return;
    onClose();
  };

  const closeMovePickerFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (busy || event.target !== event.currentTarget) return;
    onCloseMovePicker();
  };

  const stopPanelClick = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const stopDialogClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  return (
    <div className={`table-detail-backdrop ${open ? "is-open" : ""}`} onClick={closeFromBackdrop}>
      <section
        className={`table-detail-panel ${open ? "is-open" : ""}`}
        onClick={stopPanelClick}
        aria-hidden={!open}
      >
        {table ? (
          <>
            <TableDetailHeader
              table={table}
              busy={busy}
              canMove={canMove}
              arrivalTimeLabel={arrivalTimeLabel}
              onOpenMovePicker={onOpenMovePicker}
              onMarkArrived={onMarkArrived}
              onFree={onFree}
              onClose={onClose}
              seatGuard={reservationSeatGuard}
              onFreeTables={onFreeTables}
            />

            <div className="table-detail-scroll">
              {errorMessage && <div className="table-detail-error">{errorMessage}</div>}
              <TableNoticeDialog message={actionError} onDismiss={onDismissActionError} />
              {orderMenuError && <div className="table-detail-error">{orderMenuError}</div>}

              {actsAsFree && (
                <div className="table-setup-mode">
                  <button
                    type="button"
                    className={`smallbtn table-setup-mode-occupy ${setupMode === "occupy" ? "is-active" : ""}`}
                    onClick={() => onChangeSetupMode("occupy")}
                    disabled={busy}
                  >
                    OCCUPA
                  </button>
                  {canReserve ? (
                    <button
                      type="button"
                      className={`smallbtn table-setup-mode-reserve ${
                        setupMode === "reserve" ? "is-active" : ""
                      }`}
                      onClick={() => onChangeSetupMode("reserve")}
                      disabled={busy}
                    >
                      <span>PRENOTA</span>
                      <TableReservationCountBadge table={table} />
                    </button>
                  ) : null}
                </div>
              )}

              {actsAsFree && anagraphicFields}

              {showAnagraphicCard && (
                <div className="table-detail-anagraphic">
                  <button
                    type="button"
                    className={`table-detail-anagraphic-toggle ${anagraphicBoxOpen ? "is-open" : ""}`}
                    onClick={toggleAnagraphicBox}
                    aria-expanded={anagraphicBoxOpen}
                  >
                    <span>Anagrafica tavolo</span>
                    {!anagraphicBoxOpen && (
                      <span className="table-detail-anagraphic-preview" aria-hidden="true">
                        <span className="table-detail-anagraphic-preview-name">{previewName}</span>
                        {previewPhone ? (
                          <span className="table-detail-anagraphic-preview-phone">
                            {previewPhone}
                          </span>
                        ) : null}
                        <span className="table-detail-anagraphic-preview-covers">
                          {previewCovers}
                        </span>
                        {previewHasIntolerances ? (
                          <span className="table-detail-anagraphic-preview-allergy">
                            Intolleranze
                          </span>
                        ) : null}
                      </span>
                    )}
                    <span
                      className="smallbtn table-history-toggle-btn table-history-icon-btn table-detail-anagraphic-icon-btn"
                      aria-hidden="true"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className={`table-detail-anagraphic-chevron ${anagraphicBoxOpen ? "is-open" : ""}`}
                      >
                        <path d="M7 10l5 5 5-5" />
                      </svg>
                    </span>
                  </button>
                  {anagraphicBoxOpen && (
                    <div className="table-detail-anagraphic-body">
                      {anagraphicFields}
                    </div>
                  )}
                </div>
              )}

              {!isFree && showStats && (
                <div className="table-detail-stats">
                  <div className="table-detail-stat">
                    <span>Ordini presi</span>
                    <strong>{table.ordersTaken}</strong>
                  </div>
                  <div className="table-detail-stat">
                    <span>Ordini in corso</span>
                    <strong>{table.ordersInProgress}</strong>
                  </div>
                  <div className="table-detail-stat">
                    <span>Da riscuotere</span>
                    <strong>{formatCurrency(table.amountDue)}</strong>
                  </div>
                </div>
              )}

              <div className="table-detail-actions table-detail-actions-top">
              </div>

              {isSeated && !canCollectPayments && (
                <div className="table-payment-lock-hint">
                  Pagamento non abilitato per questo operatore.
                </div>
              )}
              {isSeated && canCollectPayments && !paymentConfigured && (
                <div className="table-payment-lock-hint">
                  Pagamenti disabilitati: inserisci un POS o conferma il fondo cassa.
                </div>
              )}
            </div>

            {isSeated && (
              <div
                className={`table-history table-history-docked ${
                  historyOpen ? "is-open" : "is-collapsed"
                } ${showBottomActions ? "" : "is-last"}`}
              >
                {historyHeader}
                {historyOpen && openHistoryItems.length === 0 ? (
                  <div className="table-history-empty">Nessuna comanda per questo tavolo.</div>
                ) : null}
                {openHistoryItems.length > 0 && (
                  <>
                    <div className="table-history-list">
                      {openHistoryItems.map((order) => {
                        const isSelected = selectedHistoryOrder?.id === order.id;
                        const canServeOrder = canServeHistoryOrder(
                          order,
                          deliveryConfirmationEnabled
                        );
                        const payableAmount = getOrderPayableAmount(order);
                        const canPayOrder =
                          payableAmount > 0.009 && canCollectPayments && paymentConfigured;
                        return (
                          <div
                            key={order.id}
                            className={`table-history-row ${isSelected ? "is-selected" : ""}`}
                            data-order-id={order.id}
                            data-table-id={table?.id ?? ""}
                            data-table-label={effectiveTableName}
                            data-table-number={table?.number ?? ""}
                            onClick={() => setSelectedHistoryOrder(order)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setSelectedHistoryOrder(order);
                              }
                            }}
                          >
                            <div className="table-history-copy">
                              <div className="table-history-order-title">
                                {orderHistoryListTitle(order)}
                              </div>
                              <div className="table-history-time">
                                {formatClockTime(order.createdAt)}
                              </div>
                            </div>
                            <div className="table-history-right">
                              <span className={`table-history-state is-${order.state}`}>
                                {orderWorkflowLabel(order)}
                                {order.state === "served" ? (
                                  <svg
                                    viewBox="0 0 24 24"
                                    className="table-history-state-icon"
                                    aria-hidden="true"
                                  >
                                    <path d="M12 3v18M4 12h16" />
                                  </svg>
                                ) : null}
                              </span>
                              <span className="table-history-total">
                                {formatCurrency(order.total)}
                              </span>
                              {canServeOrder ? (
                                <button
                                  type="button"
                                  className="smallbtn table-history-action"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onServeOrder(order.id);
                                  }}
                                  disabled={busy}
                                >
                                  Segna consegnato
                                </button>
                              ) : null}
                              {canPayOrder ? (
                                <button
                                  type="button"
                                  className="smallbtn table-history-action table-history-pay-action"
                                  onPointerDown={(event) => {
                                    event.stopPropagation();
                                    startPayLongPressTimer({
                                      amount: payableAmount,
                                      orderId: order.id,
                                    });
                                  }}
                                  onPointerUp={clearPayLongPressTimer}
                                  onPointerLeave={clearPayLongPressTimer}
                                  onPointerCancel={clearPayLongPressTimer}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    if (payLongPressTriggeredRef.current) {
                                      payLongPressTriggeredRef.current = false;
                                      return;
                                    }
                                    setPaymentTarget({ amount: payableAmount, orderId: order.id });
                                    onTogglePaymentWizard(true);
                                  }}
                                  disabled={busy}
                                >
                                  Riscuoti
                                </button>
                              ) : null}
                              <div className="mobile-history-print-actions">
                                {renderHistoryPrintButton(order.id, "order", "row")}
                                {renderHistoryPrintButton(order.id, "preconto", "row")}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {showBottomActions && (
              <div className="table-detail-bottom-actions">
                {withinReservationWindow && (
                  <TableReservationsManageButton
                    table={table}
                    disabled={busy}
                    label="GESTISCI"
                    openDirect
                    className="table-detail-bottom-btn table-detail-arrived-btn"
                    onMarkArrived={onMarkArrived}
                    onFreeTable={onFree}
                    seatGuard={reservationSeatGuard}
                    onFreeTables={onFreeTables}
                  />
                )}
                {isSeated && canOrder && (
                  <button
                    type="button"
                    className={`smallbtn table-detail-bottom-btn table-detail-bottom-btn-order ${
                      !hasSecondaryAction ? "is-full" : ""
                    }`}
                    onClick={() => {
                      if (busy || !canOrder || menuCatalogLoading || !orderMenuReady) return;
                      onToggleOrderComposer(true);
                    }}
                    disabled={busy || !canOrder || menuCatalogLoading || !orderMenuReady}
                  >
                    {menuCatalogLoading ? "Menu..." : "Ordina"}
                  </button>
                )}
                {canPay && (
                  <button
                    type="button"
                    className={`smallbtn table-detail-bottom-btn table-detail-bottom-btn-pay ${
                      !canOrder ? "is-full" : ""
                    }`}
                    onPointerDown={() =>
                      startPayLongPressTimer({ amount: adminTablePaymentAmount })
                    }
                    onPointerUp={clearPayLongPressTimer}
                    onPointerLeave={clearPayLongPressTimer}
                    onPointerCancel={clearPayLongPressTimer}
                    onClick={() => {
                      if (payLongPressTriggeredRef.current) {
                        payLongPressTriggeredRef.current = false;
                        return;
                      }
                      if (!pendingTableAdminPaymentTarget) setPaymentTarget(null);
                      onTogglePaymentWizard(true);
                    }}
                    disabled={busy || !canPay}
                  >
                    Riscuoti tavolo ({formatCurrency(tablePayAmount)})
                  </button>
                )}
                {actsAsFree &&
                  (reserveMode ? (
                    <button
                      type="button"
                      className="occupy-confirm reserve-confirm"
                      onClick={onReserve}
                      disabled={busy || !canConfirmReserve}
                    >
                      CONFERMA PRENOTAZIONE
                    </button>
                  ) : (
                    <TableOccupyConfirmButton
                      busy={busy || !canConfirmOccupy}
                      onConfirm={onOccupy}
                    />
                  ))}
                {showFreeAction && (
                  <button
                    type="button"
                    className={`smallbtn table-detail-bottom-btn table-detail-bottom-btn-free ${
                      !canOrder && !canPay && !isReserved ? "is-full" : ""
                    }`}
                    onClick={() => setFreeConfirmOpen(true)}
                    disabled={busy || !canFree}
                  >
                    LIBERA
                  </button>
                )}
              </div>
            )}

            {tablePrecontoMenuOpen && (
              <div
                className="table-preconto-menu-backdrop"
                onClick={() => setTablePrecontoMenuOpen(false)}
              >
                <div
                  className="table-preconto-menu-card"
                  onClick={(event) => event.stopPropagation()}
                >
                  <strong>Azioni pagamento</strong>
                  <p>Scegli se rettificare l'incasso oppure ristampare il preconto del tavolo.</p>
                  {canUseAdminPaymentAdjustments ? (
                    <button
                      type="button"
                      className="smallbtn table-preconto-menu-print table-preconto-menu-adjustment"
                      onClick={() => {
                        setTablePrecontoMenuOpen(false);
                        setAdminPaymentAdjustmentTarget({ amount: adminTablePaymentAmount });
                      }}
                      disabled={busy || tablePrecontoBusy}
                    >
                      <PaymentAdjustmentIcon />
                      Rettifica pagamento
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="smallbtn table-preconto-menu-print table-preconto-menu-print-complete"
                    onClick={() => void requestTablePrecontoPrint("complete")}
                    disabled={tablePrecontoBusy}
                  >
                    <HistoryPrintIcon />
                    {tablePrecontoBusy ? "Stampa..." : "Preconto completo"}
                  </button>
                  <button
                    type="button"
                    className="smallbtn table-preconto-menu-print table-preconto-menu-print-current"
                    onClick={() => void requestTablePrecontoPrint("current")}
                    disabled={tablePrecontoBusy}
                  >
                    <HistoryPrintIcon />
                    {tablePrecontoBusy ? "Stampa..." : "Preconto attuale"}
                  </button>
                </div>
              </div>
            )}

            <AdminPaymentAdjustmentDialog
              open={Boolean(adminPaymentAdjustmentTarget)}
              table={table}
              targetOrderId={adminPaymentAdjustmentTarget?.orderId}
              targetAmount={adminPaymentAdjustmentTarget?.amount}
              busy={busy}
              onClose={() => setAdminPaymentAdjustmentTarget(null)}
              onApply={async (payload, options) => {
                await onApplyPaymentAdjustment(
                  payload.adminAdjustment,
                  adminPaymentAdjustmentTarget?.orderId
                );
                setPaymentTarget({
                  amount: payload.amount,
                  orderId: adminPaymentAdjustmentTarget?.orderId,
                });
                setAdminPaymentAdjustmentTarget(null);
                if (options?.collectNow === true) onTogglePaymentWizard(true);
              }}
            />

            <TableFreeConfirmDialog
              open={freeConfirmOpen}
              busy={busy}
              canFree={canFree}
              onClose={() => setFreeConfirmOpen(false)}
              onFree={onFree}
            />

            {selectedHistoryOrder && (
              <div
                className="table-history-preview-backdrop"
                onClick={() => setSelectedHistoryOrder(null)}
              >
                <div
                  className="table-history-preview-card"
                  data-order-id={selectedHistoryOrder.id}
                  data-table-id={table?.id ?? ""}
                  data-table-label={effectiveTableName}
                  data-table-number={table?.number ?? ""}
                  onClick={(event) => event.stopPropagation()}
                >
                  <header className="table-history-preview-head">
                    <div>
                      <div className="table-history-preview-title">
                        {orderHistoryPreviewTitle(selectedHistoryOrder)}
                      </div>
                      <div className="table-history-preview-time">
                        {formatClockTime(selectedHistoryOrder.createdAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="smallbtn table-history-preview-close"
                      onClick={() => setSelectedHistoryOrder(null)}
                      aria-label="Chiudi"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className="table-detail-close-icon"
                        aria-hidden="true"
                      >
                        <path d="M6 6l12 12M18 6l-12 12" />
                      </svg>
                    </button>
                  </header>
                  <div className="table-history-preview-meta">
                    <span className={`table-history-state is-${selectedHistoryOrder.state}`}>
                      {orderWorkflowLabel(selectedHistoryOrder)}
                    </span>
                    <strong className="table-history-total">
                      {formatCurrency(selectedHistoryOrder.total)}
                    </strong>
                  </div>
                  <div className="table-history-preview-body">
                    {(selectedHistoryOrder.orderNote || selectedHistoryOrder.orderComment) && (
                      <div className="table-history-preview-notes">
                        {selectedHistoryOrder.orderNote && (
                          <div className="table-history-preview-note">
                            <span>Nota ordine</span>
                            <strong>{selectedHistoryOrder.orderNote}</strong>
                          </div>
                        )}
                        {selectedHistoryOrder.orderComment && (
                          <div className="table-history-preview-note">
                            <span>Commento ordine</span>
                            <strong>{selectedHistoryOrder.orderComment}</strong>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="table-history-lines">
                      {selectedHistoryOrder.lines.length > 0 ? (
                        selectedHistoryOrder.lines.map((line, index) => (
                          <HistoryOrderLine
                            key={`${selectedHistoryOrder.id}_preview_${line.lineId ?? index}`}
                            line={line}
                          />
                        ))
                      ) : (
                        <div className="table-history-line table-history-line-empty">
                          Contenuto ordine non disponibile.
                        </div>
                      )}
                    </div>
                  </div>
                  <div
                    className="table-history-preview-actions"
                    data-order-id={selectedHistoryOrder.id}
                    data-table-id={table?.id ?? ""}
                    data-table-label={effectiveTableName}
                    data-table-number={table?.number ?? ""}
                  >
                    <div className="mobile-history-print-preview-actions">
                      {renderHistoryPrintButton(selectedHistoryOrder.id, "order", "preview")}
                      {renderHistoryPrintButton(selectedHistoryOrder.id, "preconto", "preview")}
                    </div>
                    {renderServiceRecoveryActions(selectedHistoryOrder)}
                  </div>
                </div>
              </div>
            )}

            {historyPrintToast && (
              <div className="mobile-history-print-toast-layer" aria-live="polite">
                <div
                  key={historyPrintToast.id}
                  className={`mobile-history-print-toast is-visible ${
                    historyPrintToast.tone === "error" ? "is-error" : ""
                  }`}
                >
                  {historyPrintToast.message}
                </div>
              </div>
            )}

            <TableOrderComposer
              open={orderComposerOpen}
              busy={busy}
              catalog={menuCatalog}
              persistKey={table ? `table_order_composer_${table.id}` : undefined}
              onClose={() => onToggleOrderComposer(false)}
              onSubmit={async (payload) => {
                await onSubmitOrder(payload);
                onToggleOrderComposer(false);
              }}
            />
            <TablePaymentWizard
              open={paymentWizardOpen}
              busy={busy}
              table={table}
              roomName={roomName}
              targetAmount={paymentTarget?.amount}
              targetOrderId={paymentTarget?.orderId}
              adminAdjustment={paymentTarget?.adminAdjustment}
              adminArticleUnitIds={paymentTarget?.articleUnitIds}
              adminSplitMode={paymentTarget?.splitMode}
              onClose={() => {
                onTogglePaymentWizard(false);
                setPaymentTarget(null);
              }}
              onConfirm={(payload) =>
                onConfirmPayment({
                  amount: payload.amount,
                  method: payload.method,
                  orderId: paymentTarget?.orderId,
                  articleUnitIds: payload.articleUnitIds ?? paymentTarget?.articleUnitIds,
                  splitMode: payload.splitMode ?? paymentTarget?.splitMode,
                  adminAdjustment: payload.adminAdjustment ?? paymentTarget?.adminAdjustment,
                  cashReceived: payload.cashReceived,
                  cashSource: payload.cashSource,
                  automaticCashPaymentOperationId: payload.automaticCashPaymentOperationId,
                  receiptType: payload.receiptType,
                  invoiceRecipient: payload.invoiceRecipient,
                  clientPaymentId: payload.clientPaymentId,
                  note: payload.note,
                  romanSharesPaid: payload.romanSharesPaid,
                  romanSharesTotal: payload.romanSharesTotal,
                  commercialBenefitApplications: payload.commercialBenefitApplications,
                })
              }
            />
          </>
        ) : null}
      </section>
      {movePickerOpen && (
        <div
          className="mobile-table-groups-backdrop mobile-table-move-backdrop table-move-overlay"
          onClick={closeMovePickerFromBackdrop}
        >
          <div
            className="mobile-table-groups-dialog mobile-table-move-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Sposta tavolo"
            onClick={stopDialogClick}
          >
            <div className="mobile-table-groups-head">
              <strong>Sposta tavolo</strong>
              <button
                type="button"
                className="mobile-table-groups-close"
                disabled={busy}
                onClick={onCloseMovePicker}
                aria-label="Chiudi"
              />
            </div>
            <div className="mobile-table-groups-list">
              {availableMoveTargets.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="mobile-table-groups-row"
                  disabled={busy}
                  onClick={() => onMoveToTable(entry.id)}
                >
                  <span className="mobile-table-groups-row-main">
                    <strong>Tavolo {entry.number}</strong>
                    <span className="mobile-table-groups-row-history">Destinazione libera</span>
                  </span>
                  <span className="mobile-table-groups-select-mark" aria-hidden="true" />
                  <span className="mobile-table-groups-row-state">Libero</span>
                </button>
              ))}
              {availableMoveTargets.length === 0 && (
                <div className="mobile-table-groups-empty">Nessun tavolo libero disponibile.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
