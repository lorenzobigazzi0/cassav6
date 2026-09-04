import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { validateInvoiceRecipient } from "../../../../api/invoice";
import { verifyCompanyByVat } from "../../../../api/company";
import {
  releaseCommercialBenefit,
  validateCommercialBenefit,
  type CommercialBenefitApplication,
  type CommercialBenefitSource,
} from "../../../../api/commercialBenefits";
import backIconSrc from "../../../../assets/icons/indietro.png";
import paymentModeArticleIconSrc from "../../../../assets/icons/payment-modes/articolo.png";
import methodCashIconSrc from "../../../../assets/icons/payments/contanti.png";
import methodCardIconSrc from "../../../../assets/icons/payments/carta.png";
import methodSatispayIconSrc from "../../../../assets/icons/payments/satispay.png";
import methodVoucherIconSrc from "../../../../assets/icons/payments/buono-pasto.png";
import methodSuspendedIconSrc from "../../../../assets/icons/payments/conto-sospeso.png";
import methodCheckIconSrc from "../../../../assets/icons/payments/assegno.png";
import methodWireIconSrc from "../../../../assets/icons/payments/bonifico.png";
import receiptSlipIconSrc from "../../../../assets/icons/payments/scontrino.png";
import receiptInvoiceIconSrc from "../../../../assets/icons/payments/fattura.png";
import paymentModeSingleIconSrc from "../../../../assets/icons/payment-modes/contounico.png";
import paymentModeAmountIconSrc from "../../../../assets/icons/payment-modes/importolibero.png";
import paymentModeRomanIconSrc from "../../../../assets/icons/payment-modes/romana.png";
import type {
  DiningTable,
  TablePaymentAdminAdjustment,
  TableCommercialBenefitApplication,
  TablePaymentInvoiceRecipient,
  TablePaymentSplitMode,
} from "../../../../api/tables";
import { useAuthStore } from "../../../../store/authStore";
import { usePaymentSettingsStore } from "../../../../store/paymentSettingsStore";
import { normalizeTableCovers } from "../../../../domain/tables/capacity";
import { formatCurrency } from "../utils";
import {
  expandOrderToArticleUnits,
  formatPaymentArticleTime,
  getOrderPayableAmount,
  groupPaymentArticleUnits,
  sortPaymentArticleUnitsByName,
  isOrderPayable,
  type PaymentArticleUnit,
} from "../payment/paymentArticleUnits";
import {
  DEFAULT_INVOICE_CLIENTS,
  isValidInvoiceVat,
  normalizeInvoiceDraft,
  normalizeInvoiceVat,
  validateInvoiceData,
  type InvoiceClient,
} from "../payment/paymentInvoice";
import { readArticleSplitLock, writeArticleSplitLock } from "../payment/articleSplitLockStorage";
import { QrCameraScanner } from "../../../payments/QrCameraScanner";
import {
  cancelAutomaticCashPayment,
  completeAutomaticCashPayment,
  getAutomaticCashGatewayState,
  getAutomaticCashPaymentState,
  startAutomaticCashPayment,
} from "../../../../api/automaticCash";
import { formatAutomaticCashError } from "../../../../utils/automaticCashErrors";
type SplitMode = "single" | "roman" | "amount" | "article";
type WireTransferType = "instant" | "ordinary";
type CashCollectionSource = "wallet" | "automatic";
type NativeNfcEventDetail = {
  token?: unknown;
  nfcToken?: unknown;
  code?: unknown;
  payload?: unknown;
  raw?: unknown;
  id?: unknown;
  readId?: unknown;
  at?: unknown;
  source?: unknown;
};
type BenefitNfcReaderSession = {
  id: string;
  startedAt: number;
};
type BenefitInputMode = "manual" | "qr" | "nfc";
type BenefitInputFailure = {
  source: CommercialBenefitSource;
  message: string;
};
export type PaymentMethod =
  | "cash"
  | "card"
  | "voucher"
  | "satispay"
  | "suspended"
  | "check"
  | "wire";
type ReceiptType = "scontrino" | "fattura";
type WizardStep = "mode" | "article" | "method" | "details" | "receipt" | "invoice";
interface TablePaymentWizardProps {
  open: boolean;
  busy: boolean;
  table: DiningTable | null;
  roomName?: string;
  targetAmount?: number;
  targetOrderId?: string;
  adminAdjustment?: TablePaymentAdminAdjustment;
  adminArticleUnitIds?: string[];
  adminSplitMode?: TablePaymentSplitMode;
  cashContext?: "table" | "counter";
  cashDefaultSource?: CashCollectionSource;
  onClose: () => void;
  onConfirm: (payload: {
    amount: number;
    method: PaymentMethod;
    articleUnitIds?: string[];
    splitMode?: SplitMode;
    adminAdjustment?: TablePaymentAdminAdjustment;
    cashReceived?: number;
    cashSource?: CashCollectionSource;
    automaticCashPaymentOperationId?: string;
    receiptType?: ReceiptType;
    invoiceRecipient?: TablePaymentInvoiceRecipient | null;
    clientPaymentId?: string;
    note?: string;
    romanSharesPaid?: number;
    romanSharesTotal?: number;
    commercialBenefitApplications?: TableCommercialBenefitApplication[];
  }) => Promise<void> | void;
}
type PaymentChunk = {
  id: string;
  amount: number;
  method: PaymentMethod;
  splitMode: SplitMode;
  change: number;
  cashReceived?: number;
  note?: string;
  articleUnitIds?: string[];
  cashSource?: CashCollectionSource;
  automaticCashPaymentOperationId?: string;
  romanSharesPaid?: number;
  romanSharesTotal?: number;
  commercialBenefitApplications?: TableCommercialBenefitApplication[];
};
const chunkId = () => `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const CASH_DENOMINATIONS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100] as const;
const CHECK_BENEFICIARY = "Ristorante Demo SRL";
const WIRE_COORDS = {
  beneficiary: "Ristorante Demo SRL",
  iban: "IT60X0542811101000000123456",
  bank: "Banca Demo",
};
const WIRE_TRANSFER_LABEL: Record<WireTransferType, string> = {
  instant: "Istantaneo",
  ordinary: "Ordinario",
};
const BENEFIT_INPUT_MODES: Array<{
  mode: BenefitInputMode;
  source: CommercialBenefitSource;
  label: string;
}> = [
  { mode: "manual", source: "code", label: "Manuale" },
  { mode: "qr", source: "qr", label: "QR" },
  { mode: "nfc", source: "nfc", label: "NFC" },
];
const BENEFIT_CODE_GROUP_LENGTH = 4;
const BENEFIT_CODE_GROUP_COUNT = 3;
const BENEFIT_CODE_LENGTH = BENEFIT_CODE_GROUP_LENGTH * BENEFIT_CODE_GROUP_COUNT;
const BENEFIT_CODE_SLOT_INDEXES = Array.from({ length: BENEFIT_CODE_LENGTH }, (_, index) => index);
const BENEFIT_CODE_GROUP_INDEXES = Array.from(
  { length: BENEFIT_CODE_GROUP_COUNT },
  (_, index) => index
);
const normalizeArticleDetailText = (value?: string) => value?.trim().replace(/\s+/g, " ") ?? "";
const getPaymentArticleUnitDetails = (unit: PaymentArticleUnit) => {
  const orderTitle = normalizeArticleDetailText(unit.orderTitle);
  const parts = [unit.variantName, unit.note]
    .map(normalizeArticleDetailText)
    .filter(Boolean)
    .filter((part) => part !== orderTitle);
  return [...new Set(parts)].join(" · ");
};
const PAYMENT_METHOD_ID_BY_KEY: Record<PaymentMethod, string> = {
  cash: "pay_cash",
  card: "pay_card",
  voucher: "pay_voucher",
  satispay: "pay_satispay",
  suspended: "pay_suspended",
  check: "pay_check",
  wire: "pay_wire",
};
const SUSPENDED_CONTACTS = [
  { id: "susp_1", name: "Hotel Aurora SPA", code: "ACC-0021" },
  { id: "susp_2", name: "Studio Medico La Fenice", code: "ACC-0144" },
  { id: "susp_3", name: "Azienda Energia Nord", code: "ACC-0312" },
  { id: "susp_4", name: "Sig. Marco Rinaldi", code: "ACC-0560" },
] as const;
const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "Contanti",
  card: "Carta",
  voucher: "Buono pasto",
  satispay: "Satispay Business",
  suspended: "Conto sospeso",
  check: "Assegno",
  wire: "Bonifico",
};

const buildCommercialBenefitPaymentRefs = (
  application: CommercialBenefitApplication
): TableCommercialBenefitApplication[] => [
  {
    applicationId: application.id,
    benefitAmountCents: application.benefitAmountCents,
    benefitKind: application.benefitKind,
    residualPolicy: application.residualPolicy ?? null,
  },
];

const sanitizeBenefitCodeInput = (value: string) =>
  String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, BENEFIT_CODE_LENGTH);

const formatBenefitCodeInput = (value: string) => {
  const normalized = sanitizeBenefitCodeInput(value);
  const groups = [];
  for (let index = 0; index < normalized.length; index += BENEFIT_CODE_GROUP_LENGTH) {
    groups.push(normalized.slice(index, index + BENEFIT_CODE_GROUP_LENGTH));
  }
  return groups.join("-");
};

function extractNativeNfcToken(detail: unknown): string {
  if (typeof detail === "string") return detail.trim();
  if (!detail || typeof detail !== "object") return "";
  const candidate = detail as NativeNfcEventDetail;
  const rawFirst = Array.isArray(candidate.raw)
    ? candidate.raw.find((entry) => typeof entry === "string")
    : "";
  const values = [
    candidate.token,
    candidate.nfcToken,
    candidate.payload,
    candidate.code,
    rawFirst,
    candidate.id,
  ];
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function createBenefitNfcReaderSession(): BenefitNfcReaderSession {
  return {
    id: `nfc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now(),
  };
}

function getNativeNfcEventTime(detail: unknown): number | null {
  if (!detail || typeof detail !== "object") return null;
  const at = Number((detail as NativeNfcEventDetail).at);
  return Number.isFinite(at) && at > 0 ? at : null;
}

function getNativeNfcReadId(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const candidate = (detail as NativeNfcEventDetail).readId;
  return typeof candidate === "string" ? candidate.trim() : "";
}

function stableTextHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildNfcClientApplicationId(params: {
  token: string;
  tableId: string;
  orderId?: string;
  deviceUuid?: string | null;
  userId?: string | null;
  readerSessionId: string;
  nativeReadId?: string;
}): string {
  const parts = [
    "nfc",
    params.deviceUuid || "device",
    params.userId || "user",
    params.tableId,
    params.orderId || "table",
    params.readerSessionId,
    params.nativeReadId || stableTextHash(params.token),
  ];
  return `cbapp_${stableTextHash(parts.join("|"))}`;
}
const DIGITAL_APP_LABEL: Record<"voucher" | "satispay", string> = {
  voucher: "Edenred Fast",
  satispay: "Satispay Business",
};
const ROMAN_PEOPLE_PRESETS = [2, 3, 4, 5, 6] as const;
const clampRomanPeople = (value: number | string) => {
  return normalizeTableCovers(value, { minimum: 2, fallback: 2 });
};
const clampRomanSharesToPay = (value: number | string, max: number) => {
  const numeric = Math.trunc(Number(value) || 0);
  return Math.max(1, Math.min(Math.max(1, max), numeric));
};
const roundToFiveCents = (value: number) => Math.round(value * 20) / 20;
const parsePaymentInputAmount = (value: string) => {
  const parsed = Number(String(value ?? "").replace(",", "."));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Number(parsed.toFixed(2)));
};
export function TablePaymentWizard({
  open,
  busy,
  table,
  roomName,
  targetAmount,
  targetOrderId,
  adminAdjustment,
  adminArticleUnitIds,
  adminSplitMode,
  cashContext = "table",
  cashDefaultSource = "wallet",
  onClose,
  onConfirm,
}: TablePaymentWizardProps) {
  const targetOrder = targetOrderId
    ? ((table?.orderHistory ?? []).find((order) => order.id === targetOrderId) ?? null)
    : null;
  const targetOrderDue = targetOrder ? getOrderPayableAmount(targetOrder) : 0;
  const tableDue = Math.max(0, table?.amountDue ?? 0);
  const hasAdminAdjustment = Boolean(adminAdjustment);
  const targetDue =
    targetAmount && targetAmount > 0 ? targetAmount : targetOrderId ? targetOrderDue : tableDue;
  const dueAmount = targetOrderId
    ? Math.max(0, Math.min(targetDue, tableDue > 0 ? tableDue : targetDue))
    : Math.max(0, Math.min(tableDue, targetDue));
  const [step, setStep] = useState<WizardStep>("mode");
  const [mode, setMode] = useState<SplitMode | null>(null);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [remaining, setRemaining] = useState(dueAmount);
  const [romanPeople, setRomanPeople] = useState(2);
  const [romanRemainingParts, setRomanRemainingParts] = useState(2);
  const [romanSharesToPay, setRomanSharesToPay] = useState(1);
  const [romanPickerOpen, setRomanPickerOpen] = useState(false);
  const [romanPickerValue, setRomanPickerValue] = useState(2);
  const [romanPickerError, setRomanPickerError] = useState("");
  const [customAmount, setCustomAmount] = useState("");
  const [cashReceived, setCashReceived] = useState(0);
  const [cashSource, setCashSource] = useState<CashCollectionSource>("wallet");
  const [cashSourcePickerOpen, setCashSourcePickerOpen] = useState(false);
  const [automaticCashPaymentAvailable, setAutomaticCashPaymentAvailable] = useState(false);
  const [automaticCashPaymentLoading, setAutomaticCashPaymentLoading] = useState(false);
  const [automaticCashPaymentOperationId, setAutomaticCashPaymentOperationId] = useState("");
  const [automaticCashPaymentBusy, setAutomaticCashPaymentBusy] = useState(false);
  const [automaticCashPaymentError, setAutomaticCashPaymentError] = useState("");
  const [automaticCashPaymentModalOpen, setAutomaticCashPaymentModalOpen] = useState(false);
  const [selectedArticleUnitIds, setSelectedArticleUnitIds] = useState<string[]>([]);
  const [articleSplitByOrder, setArticleSplitByOrder] = useState(false);
  const [committedArticleUnitIds, setCommittedArticleUnitIds] = useState<string[]>([]);
  const [chunks, setChunks] = useState<PaymentChunk[]>([]);
  const [slideValue, setSlideValue] = useState(0);
  const [slideLocked, setSlideLocked] = useState(false);
  const [receiptType, setReceiptType] = useState<ReceiptType>("scontrino");
  const [invoiceClients, setInvoiceClients] = useState<InvoiceClient[]>(DEFAULT_INVOICE_CLIENTS);
  const [invoiceMode, setInvoiceMode] = useState<"search" | "new">("search");
  const [invoiceSearch, setInvoiceSearch] = useState("");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [invoiceDraft, setInvoiceDraft] = useState({
    ragioneSociale: "",
    piva: "",
    indirizzo: "",
    cap: "",
    citta: "",
    provincia: "",
    pec: "",
    sdi: "",
  });
  const [invoiceErrors, setInvoiceErrors] = useState<Record<string, string>>({});
  const [invoiceLookupBusy, setInvoiceLookupBusy] = useState(false);
  const [invoiceAutoLookupVat, setInvoiceAutoLookupVat] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [checkMessage, setCheckMessage] = useState("");
  const [finalizing, setFinalizing] = useState(false);
  const [pendingChunk, setPendingChunk] = useState<PaymentChunk | null>(null);
  const confirmedAutomaticCashChunkIdsRef = useRef(new Set<string>());
  const [paymentNote, setPaymentNote] = useState("");
  const [paymentNoteEditorOpen, setPaymentNoteEditorOpen] = useState(false);
  const [benefitModalOpen, setBenefitModalOpen] = useState(false);
  const [benefitInputMode, setBenefitInputMode] = useState<BenefitInputMode>("manual");
  const [benefitCode, setBenefitCode] = useState("");
  const [benefitNfcStatus, setBenefitNfcStatus] = useState("Avvicina il tag NFC");
  const [benefitNfcReaderSession, setBenefitNfcReaderSession] = useState<BenefitNfcReaderSession>(
    () => createBenefitNfcReaderSession()
  );
  const [benefitBusy, setBenefitBusy] = useState(false);
  const benefitBusyRef = useRef(false);
  const cashLongPressTimerRef = useRef<number | null>(null);
  const cashLongPressTriggeredRef = useRef(false);
  const benefitCodeInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [benefitFailure, setBenefitFailure] = useState<BenefitInputFailure | null>(null);
  const [appliedBenefit, setAppliedBenefit] = useState<CommercialBenefitApplication | null>(null);
  const [localArticleSplitLocked, setLocalArticleSplitLocked] = useState(false);
  const [digitalStage, setDigitalStage] = useState<"launch" | "confirm">("launch");
  const [digitalAmount, setDigitalAmount] = useState("");
  const [suspendedSearch, setSuspendedSearch] = useState("");
  const [selectedSuspendedId, setSelectedSuspendedId] = useState<string | null>(null);
  const [checkDraft, setCheckDraft] = useState({
    abi: "",
    cab: "",
    account: "",
    number: "",
    payer: "",
  });
  const [wireDraft, setWireDraft] = useState<{
    transferType: WireTransferType | null;
    payer: string;
    cro: string;
  }>({
    transferType: null,
    payer: "",
    cro: "",
  });
  const { posId, cashFloat, cashFloatLocked } = usePaymentSettingsStore();
  const authToken = useAuthStore((state) => state.token);
  const authUserId = useAuthStore((state) => state.userId);
  const authUsername = useAuthStore((state) => state.username);
  const authFullName = useAuthStore((state) => state.fullName);
  const authDeviceUuid = useAuthStore((state) => state.deviceUuid);
  const authRoomId = useAuthStore((state) => state.roomId);
  const authActivityId = useAuthStore((state) => state.activityId);
  const allowedPaymentMethodIds = useAuthStore((state) => state.allowedPaymentMethodIds);
  const allowedPaymentMethodSet = useMemo(
    () => new Set(allowedPaymentMethodIds.map((entry) => entry.trim()).filter(Boolean)),
    [allowedPaymentMethodIds]
  );
  const hasPos = Boolean(posId);
  const hasCashFloat = cashFloatLocked && cashFloat !== null;
  const canUseCard = hasPos;
  const canUseAutomaticCashPayment = automaticCashPaymentAvailable;
  const canUseCash = hasCashFloat || canUseAutomaticCashPayment;
  const paymentsEnabled = hasPos || canUseCash;
  const hasEnabledMethods = paymentsEnabled;
  const articleSplitLocked = localArticleSplitLocked || table?.paymentArticleSplitLocked === true;
  useEffect(() => {
    if (!open || !table) return;
    const covers = normalizeTableCovers(table.covers, { minimum: 2, fallback: 2 });
    setRemaining(dueAmount);
    setStep(hasAdminAdjustment ? "method" : "mode");
    setMode(hasAdminAdjustment ? "single" : null);
    setRomanPeople(covers);
    setRomanRemainingParts(covers);
    setRomanSharesToPay(1);
    setRomanPickerOpen(false);
    setRomanPickerValue(covers);
    setRomanPickerError("");
    setMethod(null);
    setCustomAmount("");
    setCashReceived(0);
    setCashSource(cashContext === "counter" ? cashDefaultSource : "wallet");
    setCashSourcePickerOpen(false);
    setAutomaticCashPaymentOperationId("");
    setAutomaticCashPaymentBusy(false);
    setAutomaticCashPaymentError("");
    setAutomaticCashPaymentModalOpen(false);
    const targetArticleUnits = targetOrderId
      ? expandOrderToArticleUnits(
          (table.orderHistory ?? []).filter(
            (order) => isOrderPayable(order) && order.id === targetOrderId
          )
        )
      : [];
    setSelectedArticleUnitIds(adminArticleUnitIds ?? targetArticleUnits.map((unit) => unit.id));
    setArticleSplitByOrder(false);
    setCommittedArticleUnitIds([]);
    setChunks([]);
    setSlideValue(0);
    setSlideLocked(false);
    setReceiptType("scontrino");
    setInvoiceMode("search");
    setInvoiceSearch("");
    setSelectedInvoiceId(null);
    setInvoiceDraft({
      ragioneSociale: "",
      piva: "",
      indirizzo: "",
      cap: "",
      citta: "",
      provincia: "",
      pec: "",
      sdi: "",
    });
    setInvoiceErrors({});
    setInvoiceLookupBusy(false);
    setInvoiceAutoLookupVat(null);
    setError("");
    setCheckMessage("");
    setFinalizing(false);
    setPendingChunk(null);
    confirmedAutomaticCashChunkIdsRef.current.clear();
    setPaymentNote("");
    setPaymentNoteEditorOpen(false);
    setBenefitModalOpen(false);
    setBenefitCode("");
    setBenefitBusy(false);
    setAppliedBenefit(null);
    setLocalArticleSplitLocked(readArticleSplitLock(table.id, targetOrderId));
    setDigitalStage("launch");
    setDigitalAmount("");
    setSuspendedSearch("");
    setSelectedSuspendedId(null);
    setCheckDraft({
      abi: "",
      cab: "",
      account: "",
      number: "",
      payer: "",
    });
    setWireDraft({
      transferType: null,
      payer: "",
      cro: "",
    });
  }, [
    adminArticleUnitIds,
    cashContext,
    cashDefaultSource,
    dueAmount,
    hasAdminAdjustment,
    open,
    table?.id,
    targetOrderId,
  ]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setAutomaticCashPaymentLoading(true);
    void getAutomaticCashGatewayState()
      .then((gateway) => {
        if (alive)
          setAutomaticCashPaymentAvailable(Boolean(gateway.configured && gateway.reachable));
      })
      .catch(() => {
        if (alive) setAutomaticCashPaymentAvailable(false);
      })
      .finally(() => {
        if (alive) setAutomaticCashPaymentLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open]);
  useEffect(() => {
    setRomanSharesToPay((prev) => clampRomanSharesToPay(prev, romanRemainingParts));
  }, [romanRemainingParts]);
  useEffect(() => {
    if (!open) return;
    setSlideValue(0);
    setSlideLocked(false);
  }, [mode, method, open, remaining, step]);
  useEffect(() => {
    if (!method) return;
    const enabled =
      method === "cash" ? canUseCash : method === "card" ? canUseCard : paymentsEnabled;
    if (!enabled) {
      setMethod(null);
      setStep("method");
    }
  }, [canUseCash, canUseCard, method, paymentsEnabled]);
  const benefitSession = useMemo(() => {
    if (!authToken || !authUserId || !authDeviceUuid || !authRoomId) return null;
    return {
      token: authToken,
      userId: authUserId,
      username: authUsername ?? undefined,
      fullName: authFullName ?? undefined,
      deviceUuid: authDeviceUuid,
      activityId: authActivityId ?? undefined,
      roomId: authRoomId,
    };
  }, [
    authActivityId,
    authDeviceUuid,
    authFullName,
    authRoomId,
    authToken,
    authUserId,
    authUsername,
  ]);
  const payableOrders = useMemo(
    () => (table?.orderHistory ?? []).filter(isOrderPayable),
    [table?.orderHistory]
  );
  const committedArticleUnitIdSet = useMemo(
    () => new Set(committedArticleUnitIds),
    [committedArticleUnitIds]
  );
  const articleUnits = useMemo(
    () =>
      expandOrderToArticleUnits(payableOrders).filter(
        (unit) => !committedArticleUnitIdSet.has(unit.id)
      ),
    [committedArticleUnitIdSet, payableOrders]
  );
  const articleUnitMap = useMemo(
    () => new Map(articleUnits.map((unit) => [unit.id, unit])),
    [articleUnits]
  );
  const selectedArticleUnitIdSet = useMemo(
    () => new Set(selectedArticleUnitIds),
    [selectedArticleUnitIds]
  );
  const selectedArticleTotal = useMemo(
    () =>
      selectedArticleUnitIds.reduce((sum, unitId) => {
        const unit = articleUnitMap.get(unitId);
        return sum + (unit?.amount ?? 0);
      }, 0),
    [articleUnitMap, selectedArticleUnitIds]
  );
  const articleGroups = useMemo(() => groupPaymentArticleUnits(articleUnits), [articleUnits]);
  // L'elenco unico si vede in ordine alfabetico; `articleUnits` resta in ordine
  // di emissione perche e quello che indicizza selezioni e rettifiche.
  const sortedArticleUnits = useMemo(
    () => sortPaymentArticleUnitsByName(articleUnits),
    [articleUnits]
  );
  useEffect(() => {
    setSelectedArticleUnitIds((prev) => prev.filter((unitId) => articleUnitMap.has(unitId)));
  }, [articleUnitMap]);
  const filteredInvoiceClients = useMemo(() => {
    const needle = invoiceSearch.trim().toLowerCase();
    if (!needle) return invoiceClients;
    return invoiceClients.filter(
      (client) =>
        client.ragioneSociale.toLowerCase().includes(needle) || client.piva.includes(needle)
    );
  }, [invoiceClients, invoiceSearch]);
  const filteredSuspendedContacts = useMemo(() => {
    const needle = suspendedSearch.trim().toLowerCase();
    if (!needle) return SUSPENDED_CONTACTS;
    return SUSPENDED_CONTACTS.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) || entry.code.toLowerCase().includes(needle)
    );
  }, [suspendedSearch]);
  const selectedInvoiceClient = useMemo(
    () => invoiceClients.find((client) => client.id === selectedInvoiceId) ?? null,
    [invoiceClients, selectedInvoiceId]
  );
  const currentAmount = useMemo(() => {
    if (!table) return 0;
    if (!mode) return 0;
    if (mode === "single") return remaining;
    if (mode === "roman") {
      const parts = Math.max(1, romanRemainingParts);
      const shares = clampRomanSharesToPay(romanSharesToPay, parts);
      return Math.min(remaining, Number((roundToFiveCents(remaining / parts) * shares).toFixed(2)));
    }
    if (mode === "amount") {
      return parsePaymentInputAmount(customAmount);
    }
    return Math.min(remaining, Number(selectedArticleTotal.toFixed(2)));
  }, [
    customAmount,
    mode,
    remaining,
    romanRemainingParts,
    romanSharesToPay,
    selectedArticleTotal,
    table,
  ]);
  const activeAmount = Math.min(remaining, currentAmount);
  const isDigital = method === "voucher" || method === "satispay";
  const digitalAmountValue = useMemo(() => {
    if (!isDigital) return 0;
    return Math.min(remaining, parsePaymentInputAmount(digitalAmount));
  }, [digitalAmount, isDigital, remaining]);
  const methodAmount = isDigital ? digitalAmountValue : activeAmount;
  const change = useMemo(() => {
    if (method !== "cash") return 0;
    const received = cashReceived;
    if (received <= 0 || methodAmount <= 0) return 0;
    return Math.max(0, Number((received - methodAmount).toFixed(2)));
  }, [cashReceived, method, methodAmount]);
  const cashMissing = useMemo(() => {
    if (method !== "cash") return 0;
    return Math.max(0, Number((methodAmount - cashReceived).toFixed(2)));
  }, [cashReceived, method, methodAmount]);
  const isMethodEnabled = (value: PaymentMethod) => {
    if (!paymentsEnabled) return false;
    if (
      allowedPaymentMethodSet.size > 0 &&
      !allowedPaymentMethodSet.has(PAYMENT_METHOD_ID_BY_KEY[value])
    ) {
      return false;
    }
    if (value === "cash") return canUseCash;
    if (value === "card") return canUseCard;
    return true;
  };
  const suspendedReady = Boolean(selectedSuspendedId);
  const checkReady =
    checkDraft.abi.trim() &&
    checkDraft.cab.trim() &&
    checkDraft.account.trim() &&
    checkDraft.number.trim() &&
    checkDraft.payer.trim();
  const wireReady =
    wireDraft.transferType !== null &&
    Boolean(wireDraft.payer.trim()) &&
    (wireDraft.transferType === "ordinary" || Boolean(wireDraft.cro.trim()));
  const digitalReady = !isDigital ? true : digitalStage === "confirm" && digitalAmountValue > 0;
  const methodReady =
    method === "suspended"
      ? Boolean(suspendedReady)
      : method === "check"
        ? Boolean(checkReady)
        : method === "wire"
          ? Boolean(wireReady)
          : digitalReady;
  const canShowSlideConfirm =
    method !== null &&
    isMethodEnabled(method) &&
    remaining > 0 &&
    methodAmount > 0 &&
    methodReady &&
    (method !== "cash" || cashReceived >= methodAmount);
  const normalizedInvoiceVat = normalizeInvoiceVat(invoiceDraft.piva);
  const invoiceAutoLookupLocked =
    invoiceAutoLookupVat !== null && invoiceAutoLookupVat === normalizedInvoiceVat;
  const invoiceAutofillReadonly = invoiceAutoLookupLocked;
  const selectMode = (nextMode: SplitMode) => {
    if (nextMode === "article" && articleSplitLocked) {
      setError(
        "Pagamento per articolo non disponibile: il tavolo e gia stato iniziato alla romana o con importo libero."
      );
      return;
    }
    setMode(nextMode);
    setStep(nextMode === "article" ? "article" : "method");
    setError("");
    setMethod(null);
    setCashReceived(0);
    setSlideValue(0);
    setSlideLocked(false);
  };
  const updateRomanPeople = (value: number | string) => {
    const next = clampRomanPeople(value);
    setRomanPeople(next);
    setRomanRemainingParts(next);
    setRomanSharesToPay(1);
  };
  const openRomanPicker = () => {
    const next = clampRomanPeople(table?.covers || romanPeople || 2);
    setRomanPickerValue(next);
    setRomanPickerError("");
    setRomanPickerOpen(true);
  };
  const confirmRomanPicker = () => {
    const next = clampRomanPeople(romanPickerValue);
    if (next < 2) {
      setRomanPickerError("Inserisci almeno 2 persone.");
      return;
    }
    updateRomanPeople(next);
    setRomanPickerOpen(false);
    selectMode("roman");
  };
  const toggleArticleUnitSelection = (unitId: string) => {
    setSelectedArticleUnitIds((prev) =>
      prev.includes(unitId) ? prev.filter((currentId) => currentId !== unitId) : [...prev, unitId]
    );
  };
  const toggleOrderArticleSelection = (orderId: string) => {
    const group = articleGroups.find((entry) => entry.orderId === orderId);
    if (!group) return;
    const groupIds = group.units.map((unit) => unit.id);
    const allSelected = groupIds.every((unitId) => selectedArticleUnitIdSet.has(unitId));
    setSelectedArticleUnitIds((prev) => {
      if (allSelected) {
        return prev.filter((unitId) => !groupIds.includes(unitId));
      }
      const next = new Set(prev);
      groupIds.forEach((unitId) => next.add(unitId));
      return [...next];
    });
  };
  const selectMethod = (
    nextMethod: PaymentMethod,
    options: { cashSource?: CashCollectionSource } = {}
  ) => {
    if (mode === "article" && selectedArticleUnitIds.length === 0) return;
    if (!isMethodEnabled(nextMethod)) return;
    if (nextMethod === "cash") {
      const requestedSource = options.cashSource ?? cashSource;
      const nextCashSource =
        requestedSource === "automatic" && canUseAutomaticCashPayment
          ? "automatic"
          : hasCashFloat
            ? "wallet"
            : canUseAutomaticCashPayment
              ? "automatic"
              : "wallet";
      if (nextCashSource === "wallet" && !hasCashFloat) return;
      if (nextCashSource === "automatic" && !canUseAutomaticCashPayment) return;
      setCashSource(nextCashSource);
    } else {
      setCashSource("wallet");
    }
    setMethod(nextMethod);
    setStep("details");
    setError("");
    setCashReceived(0);
    setCashSourcePickerOpen(false);
    setAutomaticCashPaymentOperationId("");
    setAutomaticCashPaymentBusy(false);
    setAutomaticCashPaymentError("");
    setAutomaticCashPaymentModalOpen(false);
    setSlideValue(0);
    setSlideLocked(false);
    setPaymentNote("");
    setPaymentNoteEditorOpen(false);
    if (nextMethod === "voucher" || nextMethod === "satispay") {
      const prefill = Math.min(remaining, currentAmount);
      setDigitalStage("launch");
      setDigitalAmount(prefill > 0 ? prefill.toFixed(2) : "");
    }
    if (nextMethod === "suspended") {
      setSuspendedSearch("");
      setSelectedSuspendedId(null);
    }
    if (nextMethod === "check") {
      setCheckDraft({
        abi: "",
        cab: "",
        account: "",
        number: "",
        payer: "",
      });
    }
    if (nextMethod === "wire") {
      setWireDraft({
        transferType: null,
        payer: "",
        cro: "",
      });
    }
  };
  const selectCashMethodWithDefault = () => {
    const preferred =
      cashContext === "counter" && cashDefaultSource === "automatic" ? "automatic" : "wallet";
    const nextSource =
      preferred === "automatic" && canUseAutomaticCashPayment
        ? "automatic"
        : hasCashFloat
          ? "wallet"
          : "automatic";
    selectMethod("cash", { cashSource: nextSource });
  };
  const openCashSourcePicker = () => {
    if (!canUseCash) return;
    setCashSourcePickerOpen(true);
  };
  const clearCashLongPressTimer = () => {
    if (cashLongPressTimerRef.current !== null) {
      window.clearTimeout(cashLongPressTimerRef.current);
      cashLongPressTimerRef.current = null;
    }
  };
  const startCashLongPressTimer = () => {
    if (!canUseCash) return;
    cashLongPressTriggeredRef.current = false;
    clearCashLongPressTimer();
    cashLongPressTimerRef.current = window.setTimeout(() => {
      cashLongPressTriggeredRef.current = true;
      openCashSourcePicker();
    }, 620);
  };
  const handleCashMethodClick = () => {
    if (cashLongPressTriggeredRef.current) {
      cashLongPressTriggeredRef.current = false;
      return;
    }
    selectCashMethodWithDefault();
  };
  const startAutomaticCashCollection = async () => {
    if (automaticCashPaymentOperationId) {
      setAutomaticCashPaymentModalOpen(true);
      return;
    }
    if (automaticCashPaymentBusy || methodAmount <= 0) return;
    setAutomaticCashPaymentBusy(true);
    setAutomaticCashPaymentError("");
    setCashReceived(0);
    try {
      const response = await startAutomaticCashPayment({
        expectedTotalCents: Math.round(methodAmount * 100),
        deviceUuid: authDeviceUuid ?? undefined,
        activityId: authActivityId ?? undefined,
        roomId: authRoomId ?? undefined,
        note: `${cashContext === "counter" ? "Banco" : "Tavolo"} ${
          table?.tableLabel ?? table?.tableName ?? table?.number ?? ""
        }`,
      });
      setAutomaticCashPaymentOperationId(response.operationId);
      setAutomaticCashPaymentModalOpen(true);
    } catch (caught) {
      setAutomaticCashPaymentError(
        formatAutomaticCashError(caught, "Avvio incasso cassa automatica non riuscito.")
      );
    } finally {
      setAutomaticCashPaymentBusy(false);
    }
  };
  const cancelAutomaticCashCollection = async () => {
    if (!automaticCashPaymentOperationId || automaticCashPaymentBusy) return;
    setAutomaticCashPaymentBusy(true);
    setAutomaticCashPaymentError("");
    try {
      await cancelAutomaticCashPayment(automaticCashPaymentOperationId);
      setAutomaticCashPaymentOperationId("");
      setAutomaticCashPaymentModalOpen(false);
      setCashReceived(0);
    } catch (caught) {
      setAutomaticCashPaymentError(
        formatAutomaticCashError(caught, "Annullamento incasso cassa automatica non riuscito.")
      );
    } finally {
      setAutomaticCashPaymentBusy(false);
    }
  };
  useEffect(() => {
    if (
      !open ||
      method !== "cash" ||
      cashSource !== "automatic" ||
      !automaticCashPaymentOperationId ||
      !automaticCashPaymentModalOpen
    ) {
      return undefined;
    }
    let alive = true;
    let inFlight = false;
    const pollAutomaticCashState = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await getAutomaticCashPaymentState(automaticCashPaymentOperationId);
        if (!alive) return;
        setCashReceived(Math.max(0, response.depositedTotalCents) / 100);
        setAutomaticCashPaymentError("");
      } catch (caught) {
        if (!alive) return;
        setAutomaticCashPaymentError(
          formatAutomaticCashError(caught, "Lettura incasso cassa automatica non riuscita.")
        );
      } finally {
        inFlight = false;
      }
    };
    void pollAutomaticCashState();
    const timer = window.setInterval(() => {
      void pollAutomaticCashState();
    }, 750);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [automaticCashPaymentModalOpen, automaticCashPaymentOperationId, cashSource, method, open]);
  const updateInvoiceDraftField = (field: keyof typeof invoiceDraft, value: string) => {
    setInvoiceDraft((prev) => ({ ...prev, [field]: value }));
    if (field === "piva") {
      const normalized = normalizeInvoiceVat(value);
      setInvoiceAutoLookupVat((prev) => (prev && prev !== normalized ? null : prev));
    }
    setInvoiceErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };
  const handleAutoInvoiceLookup = async () => {
    const normalizedVat = normalizeInvoiceVat(invoiceDraft.piva);
    if (!isValidInvoiceVat(normalizedVat)) {
      setInvoiceErrors((prev) => ({ ...prev, piva: "Partita IVA non valida (11 numeri)." }));
      return;
    }
    setInvoiceLookupBusy(true);
    setError("");
    setCheckMessage("");
    try {
      const result = await verifyCompanyByVat(normalizedVat);
      setInvoiceDraft((prev) => ({
        ...prev,
        piva: normalizedVat,
        ragioneSociale: result.ragioneSociale || prev.ragioneSociale,
        indirizzo: result.indirizzo || prev.indirizzo,
        cap: result.cap || prev.cap,
        citta: result.citta || prev.citta,
        provincia: result.provincia ? result.provincia.toUpperCase() : prev.provincia,
        sdi: result.sdi ? result.sdi.toUpperCase() : prev.sdi,
        pec: result.pec && result.pec !== "Non disponibile" ? result.pec : prev.pec,
      }));
      setInvoiceAutoLookupVat(normalizedVat);
      setInvoiceErrors({});
      setCheckMessage("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ricerca automatica fallita.";
      setError(message);
    } finally {
      setInvoiceLookupBusy(false);
    }
  };
  const addCashDenomination = (value: number) => {
    setCashReceived((prev) => Number((prev + value).toFixed(2)));
  };
  const resetSlideIfNeeded = () => {
    if (slideLocked) return;
    if (slideValue < 96) {
      setSlideValue(0);
    }
  };
  const buildPaymentNote = () => {
    const baseNote = paymentNote.trim();
    if (method !== "wire") return baseNote.slice(0, 240) || undefined;
    const wireDetails = [
      wireDraft.transferType ? `Bonifico ${WIRE_TRANSFER_LABEL[wireDraft.transferType]}` : "",
      wireDraft.payer.trim() ? `Nominativo: ${wireDraft.payer.trim()}` : "",
      wireDraft.cro.trim() ? `CRO: ${wireDraft.cro.trim()}` : "",
    ]
      .filter(Boolean)
      .join(" - ");
    return [baseNote, wireDetails].filter(Boolean).join(" | ").slice(0, 240) || undefined;
  };
  const appliedBenefitPaymentRef = appliedBenefit
    ? buildCommercialBenefitPaymentRefs(appliedBenefit)
    : undefined;
  const clearAppliedBenefit = async (restoreAmount: boolean) => {
    const current = appliedBenefit;
    if (!current) return;
    setAppliedBenefit(null);
    if (restoreAmount) {
      setRemaining((prev) =>
        Number((prev + Math.max(0, current.benefitAmountCents / 100)).toFixed(2))
      );
    }
    if (benefitSession) {
      await releaseCommercialBenefit(benefitSession, current.id).catch(() => undefined);
    }
  };
  useEffect(() => {
    benefitBusyRef.current = benefitBusy;
  }, [benefitBusy]);
  const showBenefitFailure = (source: CommercialBenefitSource, message: string) => {
    setBenefitFailure({
      source,
      message: message.trim() || "Codice non applicabile.",
    });
    setError("");
  };
  const resetBenefitNfcReader = () => {
    setBenefitNfcReaderSession(createBenefitNfcReaderSession());
    setBenefitNfcStatus("Avvicina il tag NFC");
  };
  const benefitCodeRaw = sanitizeBenefitCodeInput(benefitCode);
  const benefitCodeSlotValues = BENEFIT_CODE_SLOT_INDEXES.map(
    (slotIndex) => benefitCodeRaw[slotIndex] ?? ""
  );
  const focusBenefitCodeSlot = (slotIndex: number) => {
    const nextIndex = Math.max(0, Math.min(BENEFIT_CODE_LENGTH - 1, slotIndex));
    window.setTimeout(() => benefitCodeInputRefs.current[nextIndex]?.focus(), 0);
  };
  const setBenefitCodeFromChars = (chars: string[]) => {
    setBenefitCode(formatBenefitCodeInput(chars.join("")));
  };
  const updateBenefitCodeSlot = (slotIndex: number, value: string) => {
    const incoming = sanitizeBenefitCodeInput(value);
    const nextChars = sanitizeBenefitCodeInput(benefitCode)
      .padEnd(BENEFIT_CODE_LENGTH, " ")
      .split("");
    if (!incoming) {
      nextChars.splice(slotIndex, 1);
      setBenefitCodeFromChars(nextChars);
      focusBenefitCodeSlot(slotIndex);
      return;
    }
    incoming.split("").forEach((char, offset) => {
      const targetIndex = slotIndex + offset;
      if (targetIndex < BENEFIT_CODE_LENGTH) nextChars[targetIndex] = char;
    });
    setBenefitCodeFromChars(nextChars);
    focusBenefitCodeSlot(Math.min(slotIndex + incoming.length, BENEFIT_CODE_LENGTH - 1));
  };
  const pasteBenefitCode = (event: ClipboardEvent<HTMLDivElement>) => {
    const pasted = sanitizeBenefitCodeInput(event.clipboardData.getData("text"));
    if (!pasted) return;
    event.preventDefault();
    setBenefitCode(formatBenefitCodeInput(pasted));
    focusBenefitCodeSlot(Math.min(pasted.length, BENEFIT_CODE_LENGTH - 1));
  };
  const handleBenefitCodeSlotKeyDown = (
    slotIndex: number,
    event: KeyboardEvent<HTMLInputElement>
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleApplyBenefitCode();
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      const nextChars = sanitizeBenefitCodeInput(benefitCode).split("");
      if (nextChars[slotIndex]) {
        nextChars.splice(slotIndex, 1);
        setBenefitCode(formatBenefitCodeInput(nextChars.join("")));
        focusBenefitCodeSlot(slotIndex);
        return;
      }
      if (slotIndex > 0) {
        nextChars.splice(slotIndex - 1, 1);
        setBenefitCode(formatBenefitCodeInput(nextChars.join("")));
        focusBenefitCodeSlot(slotIndex - 1);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusBenefitCodeSlot(slotIndex - 1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusBenefitCodeSlot(slotIndex + 1);
    }
  };
  const selectBenefitInputMode = (nextMode: BenefitInputMode) => {
    setBenefitInputMode(nextMode);
    setBenefitFailure(null);
    setError("");
    if (nextMode === "nfc") {
      resetBenefitNfcReader();
    }
  };
  const openBenefitModal = () => {
    setBenefitInputMode("manual");
    setBenefitFailure(null);
    setError("");
    resetBenefitNfcReader();
    setBenefitModalOpen(true);
  };
  const retryBenefitInput = () => {
    const source = benefitFailure?.source;
    setBenefitFailure(null);
    setError("");
    if (source === "qr") {
      setBenefitInputMode("qr");
      return;
    }
    if (source === "nfc") {
      setBenefitInputMode("nfc");
      resetBenefitNfcReader();
      return;
    }
    setBenefitInputMode("manual");
  };
  const cancelBenefitInput = () => {
    setBenefitFailure(null);
    setError("");
    setBenefitInputMode("manual");
    setBenefitModalOpen(false);
  };
  const applyCommercialBenefitToken = async (
    source: CommercialBenefitSource,
    token: string,
    nfcDetail?: NativeNfcEventDetail
  ) => {
    if (!table || !benefitSession) {
      showBenefitFailure(source, "Sessione non disponibile per il buono.");
      return;
    }
    if (!token) {
      showBenefitFailure(
        source,
        source === "nfc"
          ? "Tag NFC senza token leggibile."
          : source === "qr"
            ? "QR senza codice leggibile."
            : "Inserisci il codice buono/sconto."
      );
      return;
    }
    setBenefitBusy(true);
    benefitBusyRef.current = true;
    setBenefitFailure(null);
    if (source === "nfc") {
      setBenefitNfcStatus("NFC letto, verifica...");
    }
    setError("");
    try {
      if (appliedBenefit) {
        await clearAppliedBenefit(true);
      }
      const result = await validateCommercialBenefit({
        ...benefitSession,
        source,
        benefitToken: token,
        payableBeforeCents: Math.round(Math.max(remaining, 0) * 100),
        tableId: table.id,
        orderId: targetOrderId,
        ...(source === "nfc"
          ? {
              clientApplicationId: buildNfcClientApplicationId({
                token,
                tableId: table.id,
                orderId: targetOrderId,
                deviceUuid: benefitSession.deviceUuid,
                userId: benefitSession.userId,
                readerSessionId: benefitNfcReaderSession.id,
                nativeReadId: getNativeNfcReadId(nfcDetail),
              }),
              nativeReadId: getNativeNfcReadId(nfcDetail),
              nativeReadAt: getNativeNfcEventTime(nfcDetail) ?? undefined,
              readerSessionId: benefitNfcReaderSession.id,
            }
          : {}),
      });
      const amount = Math.max(0, result.application.benefitAmountCents / 100);
      if (amount <= 0) {
        await releaseCommercialBenefit(benefitSession, result.application.id).catch(
          () => undefined
        );
        showBenefitFailure(source, "Questo buono non contiene un valore applicabile.");
        return;
      }
      if (amount >= remaining - 0.009) {
        const articleUnitIds =
          hasAdminAdjustment && (adminArticleUnitIds?.length ?? 0) > 0
            ? adminArticleUnitIds
            : mode === "article"
              ? [...new Set(selectedArticleUnitIds)].filter((unitId) => articleUnitMap.has(unitId))
              : undefined;
        setAppliedBenefit(result.application);
        setRemaining(0);
        setBenefitCode("");
        setBenefitNfcStatus("Buono NFC applicato");
        setBenefitFailure(null);
        setBenefitModalOpen(false);
        setPendingChunk({
          id: chunkId(),
          amount: 0,
          method: "cash",
          splitMode: hasAdminAdjustment ? (adminSplitMode ?? "single") : (mode ?? "amount"),
          change: 0,
          note: buildPaymentNote(),
          articleUnitIds,
          romanSharesPaid:
            mode === "roman"
              ? clampRomanSharesToPay(romanSharesToPay, romanRemainingParts)
              : undefined,
          romanSharesTotal: mode === "roman" ? romanPeople : undefined,
          commercialBenefitApplications: buildCommercialBenefitPaymentRefs(result.application),
        });
        setReceiptType("scontrino");
        setStep("receipt");
        return;
      }
      setAppliedBenefit(result.application);
      setRemaining((prev) => Math.max(0, Number((prev - amount).toFixed(2))));
      setBenefitCode("");
      setBenefitNfcStatus("Buono NFC applicato");
      setBenefitFailure(null);
      setBenefitModalOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Buono/Sconto non applicabile.";
      showBenefitFailure(source, message);
      if (source === "nfc") {
        setBenefitNfcStatus("NFC non applicabile");
      }
    } finally {
      setBenefitBusy(false);
      benefitBusyRef.current = false;
    }
  };
  const handleApplyBenefitCode = async () => {
    await applyCommercialBenefitToken("code", benefitCode.trim());
  };
  const handleApplyBenefitQr = (payload: string) => {
    void applyCommercialBenefitToken("qr", payload.trim());
  };
  useEffect(() => {
    if (
      !benefitModalOpen ||
      step !== "details" ||
      appliedBenefit ||
      benefitBusy ||
      benefitFailure ||
      benefitInputMode !== "nfc"
    ) {
      return undefined;
    }
    const handleNativeNfc = (event: Event) => {
      if (benefitBusyRef.current) return;
      const detail = (event as CustomEvent<NativeNfcEventDetail>).detail;
      const eventTime = getNativeNfcEventTime(detail);
      if (eventTime !== null && eventTime + 1_000 < benefitNfcReaderSession.startedAt) {
        return;
      }
      const token = extractNativeNfcToken(detail);
      void applyCommercialBenefitToken("nfc", token, detail);
    };
    window.addEventListener("native:nfc", handleNativeNfc);
    return () => {
      window.removeEventListener("native:nfc", handleNativeNfc);
    };
  });
  const buildChunk = () => {
    if (!table || !method) return null;
    setError("");
    const articleUnitIds = hasAdminAdjustment
      ? adminArticleUnitIds
      : mode === "article"
        ? [...new Set(selectedArticleUnitIds)].filter((unitId) => articleUnitMap.has(unitId))
        : undefined;
    if (
      !hasAdminAdjustment &&
      mode === "article" &&
      (!articleUnitIds || articleUnitIds.length === 0)
    ) {
      setError("Seleziona almeno un articolo.");
      return null;
    }
    const amount = hasAdminAdjustment ? remaining : Math.min(remaining, methodAmount);
    if (amount <= 0) {
      setError("Importo non valido per questa quota.");
      return null;
    }
    if (!isMethodEnabled(method)) {
      setError("Metodo non disponibile.");
      return null;
    }
    if (method === "cash") {
      if (cashSource === "automatic" && !automaticCashPaymentOperationId) {
        setError("Avvia l'incasso dalla cassa automatica prima di confermare.");
        return null;
      }
      const received = cashReceived;
      if (received < amount) {
        setError("Contanti ricevuti insufficienti.");
        return null;
      }
    }
    if (method === "voucher" || method === "satispay") {
      if (digitalAmountValue <= 0) {
        setError("Inserisci l'importo utilizzato.");
        return null;
      }
    }
    if (method === "suspended" && !selectedSuspendedId) {
      setError("Seleziona un contatto autorizzato.");
      return null;
    }
    if (method === "check" && !checkReady) {
      setError("Completa tutti i dati dell'assegno.");
      return null;
    }
    if (method === "wire" && !wireReady) {
      setError(
        wireDraft.transferType === null
          ? "Seleziona bonifico istantaneo o ordinario."
          : wireDraft.transferType === "instant"
            ? "Completa nominativo e CRO del bonifico istantaneo."
            : "Completa il nominativo del bonifico ordinario."
      );
      return null;
    }
    return {
      id: chunkId(),
      amount,
      method,
      splitMode: hasAdminAdjustment ? (adminSplitMode ?? "single") : (mode ?? "amount"),
      change: method === "cash" ? change : 0,
      cashReceived: method === "cash" ? cashReceived : undefined,
      note: buildPaymentNote(),
      articleUnitIds,
      cashSource: method === "cash" ? cashSource : undefined,
      automaticCashPaymentOperationId:
        method === "cash" && cashSource === "automatic"
          ? automaticCashPaymentOperationId
          : undefined,
      romanSharesPaid:
        !hasAdminAdjustment && mode === "roman"
          ? clampRomanSharesToPay(romanSharesToPay, romanRemainingParts)
          : undefined,
      romanSharesTotal: !hasAdminAdjustment && mode === "roman" ? romanPeople : undefined,
      commercialBenefitApplications: appliedBenefitPaymentRef,
    };
  };
  const commitChunk = (chunk: PaymentChunk) => {
    const nextRemaining = Math.max(0, Number((remaining - chunk.amount).toFixed(2)));
    setChunks((prev) => [...prev, chunk]);
    setRemaining(nextRemaining);
    setCashReceived(0);
    setCustomAmount("");
    setPaymentNote("");
    setPaymentNoteEditorOpen(false);
    setAppliedBenefit(null);
    if (mode === "roman") {
      setRomanRemainingParts((prev) => Math.max(1, prev - (chunk.romanSharesPaid ?? 1)));
      setRomanSharesToPay(1);
    }
    if (mode === "article") {
      const paidUnits = chunk.articleUnitIds;
      if (paidUnits && paidUnits.length > 0) {
        setCommittedArticleUnitIds((prev) => [...new Set([...prev, ...paidUnits])]);
      }
      setSelectedArticleUnitIds([]);
    }
    if (chunk.splitMode === "roman" || chunk.splitMode === "amount") {
      setLocalArticleSplitLocked(true);
      if (table?.id) writeArticleSplitLock(table.id, targetOrderId);
    }
    setSlideValue(0);
    setSlideLocked(false);
    return nextRemaining;
  };
  const isAutomaticCashChunk = (chunk: PaymentChunk) =>
    chunk.method === "cash" &&
    chunk.cashSource === "automatic" &&
    Boolean(chunk.automaticCashPaymentOperationId);
  const buildConfirmPayload = (
    chunk: PaymentChunk,
    nextReceiptType: ReceiptType,
    invoiceRecipient?: TablePaymentInvoiceRecipient | null
  ) => ({
    amount: chunk.amount,
    method: chunk.method,
    articleUnitIds: chunk.articleUnitIds,
    splitMode: chunk.splitMode,
    cashReceived: chunk.cashReceived,
    cashSource: chunk.method === "cash" ? chunk.cashSource : undefined,
    automaticCashPaymentOperationId:
      chunk.method === "cash" && chunk.cashSource === "automatic"
        ? chunk.automaticCashPaymentOperationId
        : undefined,
    receiptType: nextReceiptType,
    invoiceRecipient,
    adminAdjustment,
    clientPaymentId: chunk.id,
    note: chunk.note,
    romanSharesPaid: chunk.romanSharesPaid,
    romanSharesTotal: chunk.romanSharesTotal,
    commercialBenefitApplications: chunk.commercialBenefitApplications,
  });
  const completeAutomaticCashChunk = async (chunk: PaymentChunk) => {
    const operationId = chunk.automaticCashPaymentOperationId;
    if (!isAutomaticCashChunk(chunk) || !operationId) return;
    try {
      await completeAutomaticCashPayment(operationId, {
        expectedTotalCents: Math.round(chunk.amount * 100),
        depositedTotalCents: Math.round((chunk.cashReceived ?? 0) * 100),
        changeDueCents: Math.round((chunk.change ?? 0) * 100),
      });
      setAutomaticCashPaymentOperationId((current) => (current === operationId ? "" : current));
      setAutomaticCashPaymentModalOpen(false);
      setAutomaticCashPaymentError("");
    } catch (caught) {
      const message = formatAutomaticCashError(
        caught,
        "Chiusura incasso cassa automatica non riuscita."
      );
      setAutomaticCashPaymentError(message);
      throw new Error(message);
    }
  };
  const confirmPaymentChunk = async (
    chunk: PaymentChunk,
    nextReceiptType: ReceiptType,
    invoiceRecipient?: TablePaymentInvoiceRecipient | null
  ) => {
    const requiresGatewayCompletion = isAutomaticCashChunk(chunk);
    const appPaymentAlreadyConfirmed =
      requiresGatewayCompletion && confirmedAutomaticCashChunkIdsRef.current.has(chunk.id);
    if (!appPaymentAlreadyConfirmed) {
      await onConfirm(buildConfirmPayload(chunk, nextReceiptType, invoiceRecipient));
      if (requiresGatewayCompletion) {
        confirmedAutomaticCashChunkIdsRef.current.add(chunk.id);
      }
    }
    if (requiresGatewayCompletion) {
      await completeAutomaticCashChunk(chunk);
      confirmedAutomaticCashChunkIdsRef.current.delete(chunk.id);
    }
  };
  const confirmChunkWithSlide = () => {
    if (slideLocked || busy || remaining <= 0 || !method) return;
    setSlideLocked(true);
    const chunk = buildChunk();
    if (!chunk) {
      setSlideValue(0);
      setSlideLocked(false);
      return;
    }
    setPendingChunk(chunk);
    setReceiptType("scontrino");
    setStep("receipt");
  };
  const confirmReceipt = async () => {
    if (!pendingChunk || !table) return;
    if (receiptType === "fattura") {
      setStep("invoice");
      setError("");
      return;
    }
    setFinalizing(true);
    setError("");
    try {
      await confirmPaymentChunk(pendingChunk, "scontrino");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Pagamento non riuscito.";
      setError(message);
      setFinalizing(false);
      return;
    }
    const nextRemaining = commitChunk(pendingChunk);
    setPendingChunk(null);
    setFinalizing(false);
    if (nextRemaining <= 0.009) {
      onClose();
      return;
    }
    setMethod(null);
    setStep(mode === "article" ? "article" : "method");
  };
  const confirmInvoiceSelection = async (client: InvoiceClient | null) => {
    if (!pendingChunk || !table) return;
    if (!client) {
      setError("Seleziona o crea un cliente per la fattura.");
      return;
    }
    const normalized = normalizeInvoiceDraft(client);
    const validationErrors = validateInvoiceData(normalized);
    if (Object.keys(validationErrors).length > 0) {
      setInvoiceErrors(validationErrors);
      setError("Compila tutti i campi fattura in modo corretto.");
      return;
    }
    setFinalizing(true);
    try {
      const result = await validateInvoiceRecipient({
        vatNumber: normalized.piva,
        pec: normalized.pec,
      });
      setCheckMessage(result.message);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await confirmPaymentChunk(pendingChunk, "fattura", normalized);
      const nextRemaining = commitChunk(pendingChunk);
      setPendingChunk(null);
      if (nextRemaining <= 0.009) {
        onClose();
        return;
      }
      setMethod(null);
      setStep(mode === "article" ? "article" : "method");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Pagamento non riuscito.";
      setError(message);
    } finally {
      setFinalizing(false);
    }
  };
  const handleUseNewInvoiceClient = async () => {
    const normalized = normalizeInvoiceDraft(invoiceDraft);
    const validationErrors = validateInvoiceData(normalized);
    if (Object.keys(validationErrors).length > 0) {
      setInvoiceErrors(validationErrors);
      setError("Compila tutti i campi fattura in modo corretto.");
      return;
    }
    const newClient: InvoiceClient = {
      id: `cli_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ...normalized,
    };
    setInvoiceClients((prev) => [newClient, ...prev]);
    setSelectedInvoiceId(newClient.id);
    await confirmInvoiceSelection(newClient);
  };
  const renderPaymentNoteButton = (withLabel = false, extraClass = "") => (
    <button
      type="button"
      className={`smallbtn table-payment-note-btn ${paymentNote.trim() ? "is-filled" : ""} ${extraClass}`.trim()}
      onClick={() => setPaymentNoteEditorOpen(true)}
      aria-label="Aggiungi nota pagamento"
      title="Nota pagamento"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4h14v16H5z" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </svg>
      {withLabel ? <span className="table-payment-note-label">Nota</span> : null}
    </button>
  );
  const renderBenefitButton = () => (
    <button
      type="button"
      className={`smallbtn table-payment-benefit-btn ${appliedBenefit ? "is-filled" : ""}`}
      onClick={openBenefitModal}
      aria-label="Buono o sconto commerciale"
      title="Buono/Sconto"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 8a2 2 0 0 0 0 4v4h16v-4a2 2 0 0 1 0-4V5H4z" />
        <path d="M9 9h.01M15 13h.01M9 15l6-6" />
      </svg>
      {appliedBenefit ? <span>-{formatCurrency(appliedBenefit.benefitAmount)}</span> : null}
    </button>
  );
  const paymentMethods: Array<{ key: PaymentMethod; label: string; icon: JSX.Element }> = [
    {
      key: "cash",
      label: PAYMENT_METHOD_LABEL.cash,
      icon: (
        <img className="table-payment-method-glyph" src={methodCashIconSrc} alt="" aria-hidden="true" />
      ),
    },
    {
      key: "card",
      label: PAYMENT_METHOD_LABEL.card,
      icon: (
        <img className="table-payment-method-glyph" src={methodCardIconSrc} alt="" aria-hidden="true" />
      ),
    },
    {
      key: "voucher",
      label: PAYMENT_METHOD_LABEL.voucher,
      icon: (
        <img className="table-payment-method-glyph" src={methodVoucherIconSrc} alt="" aria-hidden="true" />
      ),
    },
    {
      key: "satispay",
      label: PAYMENT_METHOD_LABEL.satispay,
      icon: (
        <img className="table-payment-method-glyph" src={methodSatispayIconSrc} alt="" aria-hidden="true" />
      ),
    },
    {
      key: "suspended",
      label: PAYMENT_METHOD_LABEL.suspended,
      icon: (
        <img className="table-payment-method-glyph" src={methodSuspendedIconSrc} alt="" aria-hidden="true" />
      ),
    },
    {
      key: "check",
      label: PAYMENT_METHOD_LABEL.check,
      icon: (
        <img className="table-payment-method-glyph" src={methodCheckIconSrc} alt="" aria-hidden="true" />
      ),
    },
    {
      key: "wire",
      label: PAYMENT_METHOD_LABEL.wire,
      icon: (
        <img className="table-payment-method-glyph" src={methodWireIconSrc} alt="" aria-hidden="true" />
      ),
    },
  ];
  if (!open || !table) return null;
  const tableDisplayLabel =
    table.tableLabel?.trim() || table.tableName?.trim() || `Tavolo ${table.number}`;
  const selectedPaymentMethodLabel = method ? PAYMENT_METHOD_LABEL[method] : "Metodo pagamento";
  const pendingAutomaticCashCompletion = pendingChunk
    ? confirmedAutomaticCashChunkIdsRef.current.has(pendingChunk.id)
    : false;
  const headerStepLabel =
    step === "article"
      ? "Seleziona articoli"
      : step === "method"
        ? "Metodo di pagamento"
        : step === "details"
          ? selectedPaymentMethodLabel
          : step === "receipt"
            ? "Ricevuta"
            : step === "invoice"
              ? "Cliente fattura"
              : "Divisione conto";
  const headerBackAction =
    step === "article"
      ? {
          label: "Torna alla divisione conto",
          run: () => {
            setMode(null);
            setMethod(null);
            setStep("mode");
            setSelectedArticleUnitIds([]);
          },
        }
      : step === "method"
        ? {
            label: mode === "article" ? "Torna alla selezione articoli" : "Torna alla divisione conto",
            run: () => {
              if (mode === "article") {
                setMethod(null);
                setStep("article");
                return;
              }
              setMode(null);
              setStep("mode");
            },
          }
        : step === "details"
          ? {
              label: `Torna ai metodi di pagamento, ${selectedPaymentMethodLabel}`,
              run: () => {
                setMethod(null);
                setStep("method");
              },
            }
          : step === "receipt"
            ? {
                label: "Torna al pagamento",
                run: () => {
                  if (pendingAutomaticCashCompletion) return;
                  setPendingChunk(null);
                  setSlideLocked(false);
                  setSlideValue(0);
                  setStep("details");
                },
              }
            : step === "invoice"
              ? {
                  label: "Torna alla ricevuta",
                  run: () => {
                    if (!pendingAutomaticCashCompletion) setStep("receipt");
                  },
                }
              : null;
  const handleCloseWizard = () => {
    if (pendingAutomaticCashCompletion || finalizing) return;
    if (appliedBenefit) {
      void clearAppliedBenefit(false);
    }
    onClose();
  };
  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (
      busy ||
      finalizing ||
      pendingAutomaticCashCompletion ||
      event.target !== event.currentTarget
    )
      return;
    handleCloseWizard();
  };
  const paymentLayerRoot =
    typeof document === "undefined"
      ? null
      : document.getElementsByClassName("home-tab-pane home-tab-pane-tavoli").item(0);
  const paymentContent = (
    <div className="table-payment-backdrop" onClick={closeFromBackdrop}>
      <section className="table-payment-panel" onClick={(event) => event.stopPropagation()}>
        <header className={`table-payment-head ${headerBackAction ? "has-method-back" : ""}`}>
          {headerBackAction ? (
            <button
              type="button"
              className="smallbtn table-payment-method-back"
              onClick={headerBackAction.run}
              disabled={pendingAutomaticCashCompletion}
              aria-label={headerBackAction.label}
              title={headerBackAction.label}
            >
              <img
                className="table-payment-method-back-icon"
                src={backIconSrc}
                alt=""
                aria-hidden="true"
              />
              <span className="table-payment-method-back-context" aria-hidden="true">
                {selectedPaymentMethodLabel}
              </span>
            </button>
          ) : null}
          <h4
            className="table-payment-head-info"
            aria-label={`${headerStepLabel} - ${tableDisplayLabel} - ${roomName?.trim() || "-"}`}
          >
            <strong>{headerStepLabel}</strong>
            <span>
              {tableDisplayLabel} - Sala: {roomName?.trim() || "-"}
            </span>
          </h4>
          <button
            type="button"
            className="smallbtn table-payment-close"
            disabled={busy || finalizing || pendingAutomaticCashCompletion}
            onClick={handleCloseWizard}
            aria-label="Chiudi"
          >
            <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </header>
        <div className="table-payment-scroll">
          {error && <div className="table-detail-error">{error}</div>}
          {checkMessage && <div className="table-payment-check">{checkMessage}</div>}
          {step === "mode" && (
            <div className="table-payment-mode-grid">
              <button
                type="button"
                className="table-payment-mode-card"
                onClick={() => selectMode("single")}
              >
                <span className="table-payment-mode-icon">
                  <img src={paymentModeSingleIconSrc} alt="" aria-hidden="true" />
                </span>
                <span className="table-payment-mode-title">Conto unico</span>
              </button>
              <button type="button" className="table-payment-mode-card" onClick={openRomanPicker}>
                <span className="table-payment-mode-icon">
                  <img src={paymentModeRomanIconSrc} alt="" aria-hidden="true" />
                </span>
                <span className="table-payment-mode-title">Alla romana</span>
              </button>
              <button
                type="button"
                className="table-payment-mode-card"
                onClick={() => selectMode("amount")}
              >
                <span className="table-payment-mode-icon">
                  <img src={paymentModeAmountIconSrc} alt="" aria-hidden="true" />
                </span>
                <span className="table-payment-mode-title">Importo libero</span>
              </button>
              <button
                type="button"
                className={`table-payment-mode-card ${articleSplitLocked ? "is-disabled" : ""}`}
                onClick={() => selectMode("article")}
                disabled={articleSplitLocked}
                title={
                  articleSplitLocked
                    ? "Pagamento per articolo non disponibile: il tavolo e gia stato iniziato alla romana o con importo libero."
                    : undefined
                }
              >
                <span className="table-payment-mode-icon">
                  <img src={paymentModeArticleIconSrc} alt="" aria-hidden="true" />
                </span>
                <span className="table-payment-mode-title">Per articolo</span>
              </button>
              {articleSplitLocked ? (
                <div className="table-payment-lock-hint table-payment-article-lock-hint">
                  Pagamento per articolo non disponibile: il tavolo e gia stato iniziato alla romana
                  o con importo libero.
                </div>
              ) : null}
            </div>
          )}
          {step === "article" && mode === "article" && (
            <>
              <div className="table-payment-summary">
                <div>Totale da pagare</div>
                <strong>{formatCurrency(dueAmount)}</strong>
                <div>Residuo</div>
                <strong>{formatCurrency(remaining)}</strong>
              </div>
              <div className="table-payment-article-top">
                <div className="table-payment-hint">
                  Articoli selezionati: {selectedArticleUnitIds.length} · Quota:{" "}
                  {formatCurrency(Math.min(remaining, selectedArticleTotal))}
                </div>
                <div className="table-payment-article-actions">
                  <button
                    type="button"
                    className={`smallbtn table-payment-article-split ${articleSplitByOrder ? "is-active" : ""}`}
                    onClick={() => setArticleSplitByOrder((prev) => !prev)}
                  >
                    {articleSplitByOrder ? "Elenco unico articoli" : "Dividi per comanda"}
                  </button>
                  <button
                    type="button"
                    className="smallbtn table-payment-article-continue"
                    onClick={() => {
                      setError("");
                      setMethod(null);
                      setStep("method");
                    }}
                    disabled={selectedArticleUnitIds.length === 0}
                  >
                    Continua
                  </button>
                </div>
              </div>
              <div className="table-payment-article-list">
                {sortedArticleUnits.length === 0 ? (
                  <div className="table-payment-empty">
                    Nessun articolo disponibile per il pagamento parziale.
                  </div>
                ) : articleSplitByOrder ? (
                  articleGroups.map((group) => {
                    const allSelected = group.units.every((unit) =>
                      selectedArticleUnitIdSet.has(unit.id)
                    );
                    return (
                      <div key={group.orderId} className="table-payment-article-group">
                        <div className="table-payment-article-group-head">
                          <div>
                            <strong>
                              {group.orderNumber ? `Comanda ${group.orderNumber}` : "Comanda"}
                            </strong>
                            <span>{formatPaymentArticleTime(group.orderCreatedAt)}</span>
                          </div>
                          <label className="table-payment-article-check">
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={() => toggleOrderArticleSelection(group.orderId)}
                              aria-label={`Seleziona tutti gli articoli della comanda delle ${formatPaymentArticleTime(group.orderCreatedAt)}`}
                            />
                          </label>
                        </div>
                        <div className="table-payment-article-group-items">
                          {group.units.map((unit) => {
                            const isSelected = selectedArticleUnitIdSet.has(unit.id);
                            const detailText = getPaymentArticleUnitDetails(unit);
                            return (
                              <button
                                key={unit.id}
                                type="button"
                                className={`table-payment-article-row ${
                                  isSelected ? "is-selected" : ""
                                }`}
                                onClick={() => toggleArticleUnitSelection(unit.id)}
                              >
                                <div className="table-payment-article-row-copy">
                                  <strong>{unit.name}</strong>
                                  {detailText ? <span>{detailText}</span> : null}
                                </div>
                                <div className="table-payment-article-row-side">
                                  <span>{formatCurrency(unit.amount)}</span>
                                  <span className="table-payment-article-check is-static">
                                    <input
                                      type="checkbox"
                                      checked={isSelected}
                                      readOnly
                                      tabIndex={-1}
                                      aria-hidden="true"
                                    />
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  sortedArticleUnits.map((unit) => {
                    const isSelected = selectedArticleUnitIdSet.has(unit.id);
                    const detailText = getPaymentArticleUnitDetails(unit);
                    return (
                      <button
                        key={unit.id}
                        type="button"
                        className={`table-payment-article-row ${isSelected ? "is-selected" : ""}`}
                        onClick={() => toggleArticleUnitSelection(unit.id)}
                      >
                        <div className="table-payment-article-row-copy">
                          <strong>{unit.name}</strong>
                          {detailText ? <span>{detailText}</span> : null}
                        </div>
                        <div className="table-payment-article-row-side">
                          <span>{formatCurrency(unit.amount)}</span>
                          <span className="table-payment-article-check is-static">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              readOnly
                              tabIndex={-1}
                              aria-hidden="true"
                            />
                          </span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          )}
          {step === "method" && (
            <>
              <div className="table-payment-summary">
                <div>Totale da pagare</div>
                <strong>{formatCurrency(dueAmount)}</strong>
                <div>Residuo</div>
                <strong>{formatCurrency(remaining)}</strong>
              </div>
              <div className="table-payment-method-grid">
                {paymentMethods.map((entry) => {
                  const isDisabled = !isMethodEnabled(entry.key);
                  const isCash = entry.key === "cash";
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      className={`table-payment-method-card ${method === entry.key ? "is-active" : ""} ${
                        isDisabled ? "is-disabled" : ""
                      }`}
                      onPointerDown={isCash ? startCashLongPressTimer : undefined}
                      onPointerUp={isCash ? clearCashLongPressTimer : undefined}
                      onPointerLeave={isCash ? clearCashLongPressTimer : undefined}
                      onPointerCancel={isCash ? clearCashLongPressTimer : undefined}
                      onContextMenu={
                        isCash
                          ? (event) => {
                              event.preventDefault();
                              openCashSourcePicker();
                            }
                          : undefined
                      }
                      onClick={() => (isCash ? handleCashMethodClick() : selectMethod(entry.key))}
                      disabled={isDisabled}
                    >
                      <span className="table-payment-method-icon">{entry.icon}</span>
                      <span className="table-payment-method-label">{entry.label}</span>
                    </button>
                  );
                })}
              </div>
              {cashSourcePickerOpen ? (
                <div className="table-payment-cash-source-picker">
                  <button
                    type="button"
                    className={`table-payment-cash-source ${hasCashFloat ? "" : "is-disabled"}`}
                    disabled={!hasCashFloat}
                    onClick={() => selectMethod("cash", { cashSource: "wallet" })}
                  >
                    <strong>Borsellino</strong>
                    <span>Usa il fondo cassa del palmare.</span>
                  </button>
                  <button
                    type="button"
                    className={`table-payment-cash-source ${
                      canUseAutomaticCashPayment ? "" : "is-disabled"
                    }`}
                    disabled={!canUseAutomaticCashPayment}
                    onClick={() => selectMethod("cash", { cashSource: "automatic" })}
                  >
                    <strong>Cassa automatica</strong>
                    <span>
                      {automaticCashPaymentLoading
                        ? "Verifica gateway..."
                        : "Legge i contanti inseriti nella macchina."}
                    </span>
                  </button>
                </div>
              ) : null}
              {!hasEnabledMethods ? (
                <div className="table-payment-lock-hint">
                  Nessun metodo di riscossione attivo. Configura POS o fondo cassa.
                </div>
              ) : (
                <div className="table-payment-hint">Seleziona un metodo per continuare.</div>
              )}
            </>
          )}
          {step === "details" && (
            <>
              <div className="table-payment-summary-row">
                <div className="table-payment-summary">
                  <div>Totale da pagare</div>
                  <strong>{formatCurrency(dueAmount)}</strong>
                  {appliedBenefit ? (
                    <>
                      <div>Buono/Sconto</div>
                      <strong>-{formatCurrency(appliedBenefit.benefitAmount)}</strong>
                    </>
                  ) : null}
                  <div>Residuo</div>
                  <strong>{formatCurrency(remaining)}</strong>
                </div>
                {renderBenefitButton()}
                {renderPaymentNoteButton(false, "table-payment-summary-note")}
              </div>
              {mode === "roman" && (
                <div className="table-payment-note-row has-roman-shares">
                  <div className="table-payment-roman-share-wrap">
                    <div className="table-payment-roman-share-control">
                      <button
                        type="button"
                        className="table-payment-roman-share-btn"
                        onClick={() => updateRomanPeople(romanPeople - 1)}
                        disabled={romanPeople <= 2}
                        aria-label="Diminuisci persone"
                      >
                        -
                      </button>
                      <input
                        type="text"
                        name="roman_people"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={3}
                        value={romanPeople}
                        onChange={(event) =>
                          updateRomanPeople(event.target.value.replace(/\D/g, "").slice(0, 3))
                        }
                        aria-label="Persone per divisione"
                      />
                      <button
                        type="button"
                        className="table-payment-roman-share-btn"
                        onClick={() => updateRomanPeople(romanPeople + 1)}
                        aria-label="Aumenta persone"
                      >
                        +
                      </button>
                    </div>
                    <div className="table-payment-roman-share-caption">Dividi per persone</div>
                    <div
                      className="table-payment-roman-share-presets"
                      aria-label="Scelte rapide persone"
                    >
                      {ROMAN_PEOPLE_PRESETS.map((value) => (
                        <button
                          key={value}
                          type="button"
                          className={`table-payment-roman-share-preset ${romanPeople === value ? "is-active" : ""}`}
                          onClick={() => updateRomanPeople(value)}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                    <div className="table-payment-roman-share-control table-payment-roman-pay-control">
                      <button
                        type="button"
                        className="table-payment-roman-share-btn"
                        onClick={() =>
                          setRomanSharesToPay((value) =>
                            clampRomanSharesToPay(value - 1, romanRemainingParts)
                          )
                        }
                        disabled={romanSharesToPay <= 1}
                        aria-label="Diminuisci quote da pagare"
                      >
                        -
                      </button>
                      <input
                        type="text"
                        name="roman_shares_to_pay"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={3}
                        value={romanSharesToPay}
                        onChange={(event) =>
                          setRomanSharesToPay(
                            clampRomanSharesToPay(
                              event.target.value.replace(/\D/g, "").slice(0, 3),
                              romanRemainingParts
                            )
                          )
                        }
                        aria-label="Quote da pagare"
                      />
                      <button
                        type="button"
                        className="table-payment-roman-share-btn"
                        onClick={() =>
                          setRomanSharesToPay((value) =>
                            clampRomanSharesToPay(value + 1, romanRemainingParts)
                          )
                        }
                        disabled={romanSharesToPay >= romanRemainingParts}
                        aria-label="Aumenta quote da pagare"
                      >
                        +
                      </button>
                    </div>
                    <div className="table-payment-roman-share-caption">
                      Quote da pagare ora: {romanSharesToPay} di {romanRemainingParts}
                    </div>
                    {romanRemainingParts >= 2 ? (
                      <div
                        className="table-payment-roman-share-presets"
                        aria-label="Scelte rapide quote"
                      >
                        {Array.from({ length: romanRemainingParts }, (_, index) => index + 1)
                          .filter((value) => value >= 2)
                          .map((value) => (
                            <button
                              key={value}
                              type="button"
                              className={`table-payment-roman-share-preset ${romanSharesToPay === value ? "is-active" : ""}`}
                              onClick={() => setRomanSharesToPay(value)}
                            >
                              {value}
                            </button>
                          ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
              {mode === "amount" && (
                <label className="table-detail-field mobile-payment-inline-field">
                  <span>Quota da pagare ora</span>
                  <div className="mobile-payment-inline-controls">
                    <input
                      type="number"
                      name="custom_amount"
                      min={0}
                      step="0.01"
                      value={customAmount}
                      onChange={(event) => setCustomAmount(event.target.value)}
                    />
                  </div>
                </label>
              )}
              {isDigital && digitalStage === "launch" && (
                <div className="table-payment-digital-card">
                  <div className="table-payment-digital-title">
                    Apri{" "}
                    {method ? DIGITAL_APP_LABEL[method === "voucher" ? "voucher" : "satispay"] : ""}
                  </div>
                  <div className="table-payment-digital-desc">
                    Completa la transazione nell'app selezionata, poi prosegui con la conferma.
                  </div>
                  <div className="table-payment-digital-actions">
                    <button
                      type="button"
                      className="smallbtn table-payment-digital-next"
                      onClick={() => setDigitalStage("confirm")}
                    >
                      Continua
                    </button>
                  </div>
                </div>
              )}
              {isDigital && digitalStage === "confirm" && (
                <div className="table-payment-digital-confirm">
                  <label className="table-detail-field">
                    <span>Importo utilizzato</span>
                    <input
                      type="number"
                      name="digital_amount"
                      min={0}
                      step="0.01"
                      value={digitalAmount}
                      onChange={(event) => setDigitalAmount(event.target.value)}
                    />
                  </label>
                </div>
              )}
              {method === "suspended" && (
                <div className="table-payment-suspended">
                  <label
                    className="table-detail-field table-payment-suspended-search"
                    htmlFor="suspended_search"
                  >
                    <span>Cerca contatto autorizzato</span>
                    <input
                      id="suspended_search"
                      name="suspended_search"
                      type="text"
                      value={suspendedSearch}
                      onChange={(event) => {
                        setSuspendedSearch(event.target.value);
                        setSelectedSuspendedId(null);
                      }}
                      placeholder="Azienda o persona"
                    />
                  </label>
                  <div className="table-payment-suspended-list">
                    {filteredSuspendedContacts.length === 0 ? (
                      <div className="table-payment-empty">Nessun contatto trovato.</div>
                    ) : (
                      filteredSuspendedContacts.map((entry) => {
                        const isSelected = selectedSuspendedId === entry.id;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className={`table-payment-suspended-card ${isSelected ? "is-selected" : ""}`}
                            onClick={() => setSelectedSuspendedId(entry.id)}
                          >
                            <div className="table-payment-suspended-info">
                              <strong>{entry.name}</strong>
                              <span>{entry.code}</span>
                            </div>
                            {isSelected ? (
                              <span className="table-payment-suspended-check" aria-hidden="true">
                                <svg viewBox="0 0 24 24">
                                  <path d="M5 13l4 4L19 7" />
                                </svg>
                              </span>
                            ) : null}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
              {method === "check" && (
                <div className="table-payment-check-box">
                  <div className="table-payment-check-info">
                    <div>
                      <span>Intestato a</span>
                      <strong>{CHECK_BENEFICIARY}</strong>
                    </div>
                    <div>
                      <span>Importo</span>
                      <strong>{formatCurrency(methodAmount)}</strong>
                    </div>
                  </div>
                  <div className="table-payment-check-grid">
                    <label className="table-detail-field">
                      <span>ABI</span>
                      <input
                        type="text"
                        name="check_abi"
                        value={checkDraft.abi}
                        onChange={(event) =>
                          setCheckDraft((prev) => ({ ...prev, abi: event.target.value }))
                        }
                      />
                    </label>
                    <label className="table-detail-field">
                      <span>CAB</span>
                      <input
                        type="text"
                        name="check_cab"
                        value={checkDraft.cab}
                        onChange={(event) =>
                          setCheckDraft((prev) => ({ ...prev, cab: event.target.value }))
                        }
                      />
                    </label>
                    <label className="table-detail-field">
                      <span>Numero conto</span>
                      <input
                        type="text"
                        name="check_account"
                        value={checkDraft.account}
                        onChange={(event) =>
                          setCheckDraft((prev) => ({ ...prev, account: event.target.value }))
                        }
                      />
                    </label>
                    <label className="table-detail-field">
                      <span>Numero assegno</span>
                      <input
                        type="text"
                        name="check_number"
                        value={checkDraft.number}
                        onChange={(event) =>
                          setCheckDraft((prev) => ({ ...prev, number: event.target.value }))
                        }
                      />
                    </label>
                    <label className="table-detail-field table-payment-span">
                      <span>Nome pagatore</span>
                      <input
                        type="text"
                        name="check_payer"
                        value={checkDraft.payer}
                        onChange={(event) =>
                          setCheckDraft((prev) => ({ ...prev, payer: event.target.value }))
                        }
                      />
                    </label>
                  </div>
                </div>
              )}
              {method === "wire" && (
                <div className="table-payment-wire-box">
                  <div className="table-payment-wire-info">
                    <div>
                      <span>Beneficiario</span>
                      <strong>{WIRE_COORDS.beneficiary}</strong>
                    </div>
                    <div>
                      <span>IBAN</span>
                      <strong>{WIRE_COORDS.iban}</strong>
                    </div>
                    <div>
                      <span>Banca</span>
                      <strong>{WIRE_COORDS.bank}</strong>
                    </div>
                    <div>
                      <span>Importo</span>
                      <strong>{formatCurrency(methodAmount)}</strong>
                    </div>
                  </div>
                  <div
                    className="table-payment-wire-type-row"
                    role="group"
                    aria-label="Tipo bonifico"
                  >
                    {(Object.keys(WIRE_TRANSFER_LABEL) as WireTransferType[]).map((entry) => {
                      const isSelected = wireDraft.transferType === entry;
                      return (
                        <button
                          key={entry}
                          type="button"
                          className={`table-payment-wire-type ${isSelected ? "is-selected" : ""}`}
                          onClick={() =>
                            setWireDraft((prev) => ({
                              ...prev,
                              transferType: entry,
                            }))
                          }
                          aria-pressed={isSelected}
                        >
                          {WIRE_TRANSFER_LABEL[entry]}
                        </button>
                      );
                    })}
                  </div>
                  {wireDraft.transferType === null ? (
                    <div className="table-payment-hint">Scegli prima il tipo di bonifico.</div>
                  ) : (
                    <div className="table-payment-wire-grid">
                      <label className="table-detail-field">
                        <span>Nominativo pagatore</span>
                        <input
                          type="text"
                          name="wire_payer"
                          value={wireDraft.payer}
                          onChange={(event) =>
                            setWireDraft((prev) => ({ ...prev, payer: event.target.value }))
                          }
                        />
                      </label>
                      <label className="table-detail-field">
                        <span>
                          CRO bonifico
                          {wireDraft.transferType === "ordinary" ? " (opzionale)" : ""}
                        </span>
                        <input
                          type="text"
                          name="wire_cro"
                          required={wireDraft.transferType === "instant"}
                          value={wireDraft.cro}
                          onChange={(event) =>
                            setWireDraft((prev) => ({ ...prev, cro: event.target.value }))
                          }
                        />
                      </label>
                    </div>
                  )}
                </div>
              )}
              {method === "card" && (
                <div className="table-payment-hint">
                  Importo da inserire nel POS: {formatCurrency(methodAmount)}
                </div>
              )}
              {method === "cash" && cashSource === "automatic" && (
                <div className="table-cash-box table-cash-box-automatic">
                  <div className="table-payment-automatic-cash-card">
                    <button
                      type="button"
                      className="smallbtn table-payment-automatic-cash-start"
                      disabled={automaticCashPaymentBusy && !automaticCashPaymentOperationId}
                      onClick={() => void startAutomaticCashCollection()}
                    >
                      {automaticCashPaymentOperationId ? "Mostra incasso" : "Avvia incasso"}
                    </button>
                  </div>
                  {automaticCashPaymentError && !automaticCashPaymentModalOpen ? (
                    <div className="table-payment-automatic-cash-error">
                      {automaticCashPaymentError}
                    </div>
                  ) : null}
                </div>
              )}
              {method === "cash" && cashSource === "wallet" && (
                <div className="table-cash-box">
                  <label className="table-detail-field mobile-payment-inline-field">
                    <span>Contanti ricevuti</span>
                    <input
                      type="number"
                      name="cash_received"
                      min={0}
                      step="0.01"
                      value={cashReceived || ""}
                      onChange={(event) =>
                        setCashReceived(parsePaymentInputAmount(event.target.value))
                      }
                    />
                  </label>
                  <div className="table-cash-denominations">
                    {CASH_DENOMINATIONS.map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={`table-cash-token ${value < 5 ? "is-coin" : "is-note"}`}
                        onClick={() => addCashDenomination(value)}
                        disabled={busy || remaining <= 0}
                      >
                        <span className="table-cash-token-icon" aria-hidden="true">
                          {value < 5 ? (
                            <svg viewBox="0 0 24 24">
                              <circle cx="12" cy="12" r="8.4" />
                              <circle cx="12" cy="12" r="4.2" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24">
                              <rect x="3.5" y="6.5" width="17" height="11" rx="2.8" />
                              <circle cx="12" cy="12" r="2.2" />
                            </svg>
                          )}
                        </span>
                        <span>{formatCurrency(value)}</span>
                      </button>
                    ))}
                  </div>
                  <div className="table-cash-received">
                    <span>Ricevuto</span>
                    <strong>{formatCurrency(cashReceived)}</strong>
                    <button
                      type="button"
                      className="smallbtn table-cash-reset"
                      onClick={() => setCashReceived(0)}
                      disabled={busy || cashReceived <= 0}
                      aria-label="Azzera contanti ricevuti"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 15.5 12.5 7a2.4 2.4 0 0 1 3.4 0L19 10.1a2.4 2.4 0 0 1 0 3.4L13.5 19H8z" />
                        <path d="M9.5 12.5 14 17" />
                        <path d="M13.5 19H21" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
              <div className="table-payment-ledger">
                <div className="table-payment-ledger-item">
                  <span>Totale quota</span>
                  <strong>{formatCurrency(methodAmount)}</strong>
                </div>
                <div className="table-payment-ledger-item">
                  <span>Manca</span>
                  <strong>{formatCurrency(method === "cash" ? cashMissing : methodAmount)}</strong>
                </div>
                <div className="table-payment-ledger-item">
                  <span>Resto</span>
                  <strong>{formatCurrency(method === "cash" ? change : 0)}</strong>
                </div>
              </div>
              {canShowSlideConfirm ? (
                <div
                  className={`table-payment-slide table-payment-confirm-slide ${
                    slideValue > 0 ? "is-dragging" : ""
                  } ${slideLocked || busy ? "is-disabled" : ""}`}
                >
                  <div className="table-payment-slide-label">Scorri per confermare</div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={slideValue}
                    name="payment_confirm"
                    aria-label="Scorri per confermare il pagamento"
                    style={{ "--slide-progress": `${slideValue}%` } as CSSProperties}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setSlideValue(next);
                      if (next >= 96) {
                        confirmChunkWithSlide();
                      }
                    }}
                    onMouseUp={resetSlideIfNeeded}
                    onTouchEnd={resetSlideIfNeeded}
                    onKeyUp={resetSlideIfNeeded}
                    disabled={slideLocked || busy}
                  />
                </div>
              ) : null}
              {chunks.length > 0 && (
                <div className="table-payment-chunks">
                  {chunks.map((chunk) => (
                    <div key={chunk.id} className="table-payment-chunk">
                      <span>{PAYMENT_METHOD_LABEL[chunk.method]}</span>
                      <strong>{formatCurrency(chunk.amount)}</strong>
                      {chunk.note ? (
                        <small className="table-payment-chunk-note">Nota: {chunk.note}</small>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {step === "receipt" && pendingChunk && (
            <>
              <div className="table-payment-summary">
                <div>Pagamento</div>
                <strong>{formatCurrency(pendingChunk.amount)}</strong>
                {pendingChunk.commercialBenefitApplications?.length ? (
                  <>
                    <div>Buono/Sconto</div>
                    <strong>
                      -
                      {formatCurrency(
                        pendingChunk.commercialBenefitApplications.reduce(
                          (sum, entry) =>
                            sum + Math.max(0, Number(entry.benefitAmountCents) || 0) / 100,
                          0
                        )
                      )}
                    </strong>
                  </>
                ) : null}
                <div>Metodo</div>
                <strong>
                  {pendingChunk.amount <= 0 && pendingChunk.commercialBenefitApplications?.length
                    ? "Buono/Sconto"
                    : PAYMENT_METHOD_LABEL[pendingChunk.method]}
                </strong>
              </div>
              {pendingChunk.note ? (
                <div className="table-payment-hint">Nota: {pendingChunk.note}</div>
              ) : null}
              <div className="table-payment-receipt-grid">
                <button
                  type="button"
                  className={`table-payment-receipt-card ${receiptType === "scontrino" ? "is-active" : ""}`}
                  onClick={() => setReceiptType("scontrino")}
                >
                  <span className="table-payment-receipt-icon">
                    <img
                      className="table-payment-receipt-glyph"
                      src={receiptSlipIconSrc}
                      alt=""
                      aria-hidden="true"
                    />
                  </span>
                  <span className="table-payment-receipt-label">Scontrino</span>
                </button>
                <button
                  type="button"
                  className={`table-payment-receipt-card ${receiptType === "fattura" ? "is-active" : ""}`}
                  onClick={() => setReceiptType("fattura")}
                >
                  <span className="table-payment-receipt-icon">
                    <img
                      className="table-payment-receipt-glyph"
                      src={receiptInvoiceIconSrc}
                      alt=""
                      aria-hidden="true"
                    />
                  </span>
                  <span className="table-payment-receipt-label">Fattura</span>
                </button>
              </div>
              <div className="table-payment-confirm-wrap">
                <button
                  type="button"
                  className={`smallbtn table-payment-confirm ${
                    finalizing && receiptType === "scontrino" ? "is-mobile-confirm-pending" : ""
                  }`}
                  onClick={confirmReceipt}
                  disabled={busy || finalizing}
                >
                  {finalizing && receiptType === "scontrino"
                    ? "Confermo e stampo..."
                    : receiptType === "fattura"
                      ? "Continua"
                      : "Conferma pagamento"}
                </button>
              </div>
            </>
          )}
          {step === "invoice" && pendingChunk && (
            <>
              <div className="table-payment-summary">
                <div>Pagamento</div>
                <strong>{formatCurrency(pendingChunk.amount)}</strong>
                <div>Metodo</div>
                <strong>{PAYMENT_METHOD_LABEL[pendingChunk.method]}</strong>
              </div>
              <div className="table-invoice-mode">
                <button
                  type="button"
                  className={`table-invoice-mode-btn ${invoiceMode === "search" ? "is-active" : ""}`}
                  onClick={() => {
                    setInvoiceMode("search");
                    setError("");
                  }}
                >
                  Cerca cliente
                </button>
                <button
                  type="button"
                  className={`table-invoice-mode-btn ${invoiceMode === "new" ? "is-active" : ""}`}
                  onClick={() => {
                    setInvoiceMode("new");
                    setError("");
                  }}
                >
                  Nuovo cliente
                </button>
              </div>
              {invoiceMode === "search" ? (
                <div className="table-invoice-search-pane">
                  <label
                    className="table-detail-field table-invoice-search-field"
                    htmlFor="invoice_search"
                  >
                    <span>Ricerca cliente</span>
                    <input
                      id="invoice_search"
                      name="invoice_search"
                      type="text"
                      placeholder="Ragione sociale o P.IVA"
                      value={invoiceSearch}
                      onChange={(event) => {
                        setInvoiceSearch(event.target.value);
                        setSelectedInvoiceId(null);
                      }}
                    />
                  </label>
                  <div className="table-invoice-list">
                    {filteredInvoiceClients.length === 0 ? (
                      <div className="table-invoice-empty">
                        Nessun cliente trovato. Usa "Nuovo cliente" per inserirne uno.
                      </div>
                    ) : (
                      filteredInvoiceClients.map((client) => {
                        const isSelected = selectedInvoiceId === client.id;
                        return (
                          <button
                            key={client.id}
                            type="button"
                            className={`table-invoice-card ${isSelected ? "is-selected" : ""}`}
                            onClick={() => setSelectedInvoiceId(client.id)}
                          >
                            <div className="table-invoice-card-head">
                              <strong>{client.ragioneSociale}</strong>
                              <span>{client.piva}</span>
                            </div>
                            <div className="table-invoice-card-body">
                              <span>
                                {client.indirizzo}, {client.cap} {client.citta} ({client.provincia})
                              </span>
                              <span>PEC: {client.pec}</span>
                              <span>SDI: {client.sdi}</span>
                            </div>
                            {isSelected ? (
                              <span className="table-invoice-card-check" aria-hidden="true">
                                <svg viewBox="0 0 24 24">
                                  <path d="M5 13l4 4L19 7" />
                                </svg>
                              </span>
                            ) : null}
                          </button>
                        );
                      })
                    )}
                  </div>
                  <div className="table-invoice-actions is-single">
                    <button
                      type="button"
                      className={`smallbtn table-payment-confirm table-invoice-confirm ${
                        finalizing ? "is-mobile-confirm-pending" : ""
                      }`}
                      onClick={() => confirmInvoiceSelection(selectedInvoiceClient)}
                      disabled={finalizing || !selectedInvoiceClient}
                    >
                      {finalizing ? "Confermo e stampo..." : "Conferma pagamento"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="table-invoice-form">
                  <label
                    className={`table-detail-field table-invoice-span ${invoiceErrors.ragioneSociale ? "is-error" : ""}`}
                    htmlFor="invoice_ragione_sociale"
                  >
                    <span>Ragione sociale</span>
                    <input
                      id="invoice_ragione_sociale"
                      name="invoice_ragione_sociale"
                      type="text"
                      value={invoiceDraft.ragioneSociale}
                      readOnly={invoiceAutofillReadonly}
                      onChange={(event) =>
                        updateInvoiceDraftField("ragioneSociale", event.target.value)
                      }
                    />
                    {invoiceErrors.ragioneSociale ? (
                      <small className="table-invoice-error">{invoiceErrors.ragioneSociale}</small>
                    ) : null}
                  </label>
                  <label
                    className={`table-detail-field table-invoice-span ${invoiceErrors.piva ? "is-error" : ""}`}
                    htmlFor="invoice_piva"
                  >
                    <span>Partita IVA</span>
                    <div className="table-invoice-vat-row">
                      <input
                        id="invoice_piva"
                        name="invoice_piva"
                        type="text"
                        inputMode="numeric"
                        maxLength={11}
                        value={invoiceDraft.piva}
                        onChange={(event) => updateInvoiceDraftField("piva", event.target.value)}
                      />
                      <button
                        type="button"
                        className={`table-invoice-auto-btn ${invoiceAutoLookupLocked ? "is-success" : ""}`}
                        onClick={handleAutoInvoiceLookup}
                        disabled={invoiceLookupBusy || invoiceAutoLookupLocked}
                        aria-label={
                          invoiceAutoLookupLocked
                            ? "Dati aziendali recuperati"
                            : "Compila automaticamente da Partita IVA"
                        }
                      >
                        {invoiceAutoLookupLocked ? (
                          <span className="table-invoice-auto-check" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                              <path d="M5 13l4 4L19 7" />
                            </svg>
                          </span>
                        ) : (
                          <>
                            <span className="table-invoice-auto-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24">
                                <path d="M12 4a8 8 0 1 0 8 8" />
                                <path d="M16 4h4v4" />
                                <path d="M8.5 12h7" />
                                <path d="M12 8.5v7" />
                              </svg>
                            </span>
                            Auto
                          </>
                        )}
                      </button>
                    </div>
                    {invoiceErrors.piva ? (
                      <small className="table-invoice-error">{invoiceErrors.piva}</small>
                    ) : null}
                  </label>
                  <label
                    className={`table-detail-field table-invoice-span ${invoiceErrors.indirizzo ? "is-error" : ""}`}
                    htmlFor="invoice_indirizzo"
                  >
                    <span>Indirizzo</span>
                    <input
                      id="invoice_indirizzo"
                      name="invoice_indirizzo"
                      type="text"
                      value={invoiceDraft.indirizzo}
                      readOnly={invoiceAutofillReadonly}
                      onChange={(event) => updateInvoiceDraftField("indirizzo", event.target.value)}
                    />
                    {invoiceErrors.indirizzo ? (
                      <small className="table-invoice-error">{invoiceErrors.indirizzo}</small>
                    ) : null}
                  </label>
                  <label
                    className={`table-detail-field ${invoiceErrors.cap ? "is-error" : ""}`}
                    htmlFor="invoice_cap"
                  >
                    <span>CAP</span>
                    <input
                      id="invoice_cap"
                      name="invoice_cap"
                      type="text"
                      inputMode="numeric"
                      maxLength={5}
                      value={invoiceDraft.cap}
                      readOnly={invoiceAutofillReadonly}
                      onChange={(event) => updateInvoiceDraftField("cap", event.target.value)}
                    />
                    {invoiceErrors.cap ? (
                      <small className="table-invoice-error">{invoiceErrors.cap}</small>
                    ) : null}
                  </label>
                  <label
                    className={`table-detail-field ${invoiceErrors.citta ? "is-error" : ""}`}
                    htmlFor="invoice_citta"
                  >
                    <span>Città</span>
                    <input
                      id="invoice_citta"
                      name="invoice_citta"
                      type="text"
                      value={invoiceDraft.citta}
                      readOnly={invoiceAutofillReadonly}
                      onChange={(event) => updateInvoiceDraftField("citta", event.target.value)}
                    />
                    {invoiceErrors.citta ? (
                      <small className="table-invoice-error">{invoiceErrors.citta}</small>
                    ) : null}
                  </label>
                  <label
                    className={`table-detail-field ${invoiceErrors.provincia ? "is-error" : ""}`}
                    htmlFor="invoice_provincia"
                  >
                    <span>Provincia</span>
                    <input
                      id="invoice_provincia"
                      name="invoice_provincia"
                      type="text"
                      maxLength={2}
                      value={invoiceDraft.provincia}
                      readOnly={invoiceAutofillReadonly}
                      onChange={(event) =>
                        updateInvoiceDraftField("provincia", event.target.value.toUpperCase())
                      }
                    />
                    {invoiceErrors.provincia ? (
                      <small className="table-invoice-error">{invoiceErrors.provincia}</small>
                    ) : null}
                  </label>
                  <label
                    className={`table-detail-field ${invoiceErrors.sdi ? "is-error" : ""}`}
                    htmlFor="invoice_sdi"
                  >
                    <span>Codice SDI</span>
                    <input
                      id="invoice_sdi"
                      name="invoice_sdi"
                      type="text"
                      maxLength={7}
                      value={invoiceDraft.sdi}
                      readOnly={invoiceAutofillReadonly}
                      onChange={(event) =>
                        updateInvoiceDraftField("sdi", event.target.value.toUpperCase())
                      }
                    />
                    {invoiceErrors.sdi ? (
                      <small className="table-invoice-error">{invoiceErrors.sdi}</small>
                    ) : null}
                  </label>
                  <label
                    className={`table-detail-field table-invoice-span ${invoiceErrors.pec ? "is-error" : ""}`}
                    htmlFor="invoice_pec"
                  >
                    <span>PEC</span>
                    <input
                      id="invoice_pec"
                      name="invoice_pec"
                      type="email"
                      value={invoiceDraft.pec}
                      readOnly={invoiceAutofillReadonly}
                      onChange={(event) => updateInvoiceDraftField("pec", event.target.value)}
                    />
                    {invoiceErrors.pec ? (
                      <small className="table-invoice-error">{invoiceErrors.pec}</small>
                    ) : null}
                  </label>
                  <div className="table-invoice-actions is-single">
                    <button
                      type="button"
                      className={`smallbtn table-payment-confirm table-invoice-confirm ${
                        finalizing ? "is-mobile-confirm-pending" : ""
                      }`}
                      onClick={handleUseNewInvoiceClient}
                      disabled={finalizing || invoiceLookupBusy}
                    >
                      {finalizing ? "Confermo e stampo..." : "Conferma pagamento"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </section>
      {romanPickerOpen && (
        <div
          className="mobile-roman-split-modal-backdrop"
          onClick={() => setRomanPickerOpen(false)}
        >
          <div
            className="mobile-roman-split-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-roman-split-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mobile-roman-split-modal-head">
              <div>
                <span className="mobile-roman-split-kicker">Alla romana</span>
                <strong id="mobile-roman-split-title">Persone</strong>
              </div>
              <button
                type="button"
                className="mobile-roman-split-close"
                onClick={() => setRomanPickerOpen(false)}
                aria-label="Chiudi"
              >
                x
              </button>
            </div>
            <label className="mobile-roman-split-field">
              <span>Dividi per</span>
              <div className="mobile-roman-split-stepper">
                <button
                  type="button"
                  onClick={() => {
                    setRomanPickerValue((value) => clampRomanPeople(value - 1));
                    setRomanPickerError("");
                  }}
                  aria-label="Diminuisci"
                >
                  -
                </button>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={3}
                  value={romanPickerValue}
                  autoFocus
                  onChange={(event) => {
                    setRomanPickerValue(
                      clampRomanPeople(event.target.value.replace(/\D/g, "").slice(0, 3))
                    );
                    setRomanPickerError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      confirmRomanPicker();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    setRomanPickerValue((value) => clampRomanPeople(value + 1));
                    setRomanPickerError("");
                  }}
                  aria-label="Aumenta"
                >
                  +
                </button>
              </div>
            </label>
            <div className="mobile-roman-split-presets" aria-label="Scelte rapide">
              {ROMAN_PEOPLE_PRESETS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setRomanPickerValue(value);
                    setRomanPickerError("");
                  }}
                >
                  {value}
                </button>
              ))}
            </div>
            {romanPickerError ? (
              <p className="mobile-roman-split-error">{romanPickerError}</p>
            ) : null}
            <div className="mobile-roman-split-actions">
              <button
                type="button"
                className="mobile-roman-split-secondary"
                onClick={() => setRomanPickerOpen(false)}
              >
                Annulla
              </button>
              <button
                type="button"
                className="mobile-roman-split-primary"
                onClick={confirmRomanPicker}
              >
                Continua
              </button>
            </div>
          </div>
        </div>
      )}
      {automaticCashPaymentModalOpen &&
      step === "details" &&
      method === "cash" &&
      cashSource === "automatic" &&
      automaticCashPaymentOperationId ? (
        <div className="table-payment-note-backdrop table-payment-automatic-cash-modal-backdrop">
          <div
            className="table-payment-note-card table-payment-automatic-cash-modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="automatic_cash_payment_modal_title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="table-payment-note-head">
              <strong id="automatic_cash_payment_modal_title">Incasso cassa automatica</strong>
              <button
                type="button"
                className="smallbtn table-payment-note-close"
                onClick={() => setAutomaticCashPaymentModalOpen(false)}
                aria-label="Chiudi"
              >
                <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </button>
            </div>
            <div className="table-payment-automatic-cash-modal-body" aria-live="polite">
              <div className="table-payment-automatic-cash-modal-amount">
                <span>Importo dovuto</span>
                <strong>{formatCurrency(methodAmount)}</strong>
              </div>
              <div className="table-payment-automatic-cash-modal-amount is-inserted">
                <span>Totale inserito</span>
                <strong>{formatCurrency(cashReceived)}</strong>
              </div>
              <div className="table-payment-automatic-cash-modal-amount">
                <span>Resto dovuto</span>
                <strong>{formatCurrency(change)}</strong>
              </div>
            </div>
            {automaticCashPaymentError ? (
              <div className="table-payment-automatic-cash-error">{automaticCashPaymentError}</div>
            ) : null}
            <div className="table-payment-note-actions table-payment-automatic-cash-modal-actions">
              <button
                type="button"
                className="smallbtn table-payment-automatic-cash-modal-cancel"
                disabled={automaticCashPaymentBusy}
                onClick={() => void cancelAutomaticCashCollection()}
              >
                {automaticCashPaymentBusy ? "Annullamento..." : "Annulla"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {paymentNoteEditorOpen && step === "details" && (
        <div
          className="table-payment-note-backdrop"
          onClick={() => setPaymentNoteEditorOpen(false)}
        >
          <div className="table-payment-note-card" onClick={(event) => event.stopPropagation()}>
            <div className="table-payment-note-head">
              <strong>Nota pagamento</strong>
              <button
                type="button"
                className="smallbtn table-payment-note-close"
                onClick={() => setPaymentNoteEditorOpen(false)}
                aria-label="Chiudi"
              >
                <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </button>
            </div>
            <label className="table-detail-field" htmlFor="payment_note_modal">
              <span>Inserisci nota</span>
              <textarea
                id="payment_note_modal"
                name="payment_note_modal"
                value={paymentNote}
                rows={3}
                maxLength={120}
                autoFocus
                onChange={(event) => setPaymentNote(event.target.value)}
              />
            </label>
            <div className="table-payment-note-actions">
              <button
                type="button"
                className="smallbtn"
                onClick={() => setPaymentNote("")}
                disabled={!paymentNote.trim()}
              >
                Svuota
              </button>
              <button
                type="button"
                className="smallbtn table-payment-note-save"
                onClick={() => setPaymentNoteEditorOpen(false)}
              >
                Conferma
              </button>
            </div>
          </div>
        </div>
      )}
      {benefitModalOpen && step === "details" && (
        <div className="table-payment-note-backdrop" onClick={() => setBenefitModalOpen(false)}>
          <div className="table-payment-benefit-card" onClick={(event) => event.stopPropagation()}>
            <div className="table-payment-note-head">
              <strong>Buono/Sconto</strong>
              <button
                type="button"
                className="smallbtn table-payment-note-close"
                onClick={() => setBenefitModalOpen(false)}
                aria-label="Chiudi"
              >
                <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </button>
            </div>
            {appliedBenefit ? (
              <div className="table-payment-benefit-applied">
                <strong>{appliedBenefit.title}</strong>
                <span>
                  {appliedBenefit.codeMasked ?? "Applicato"} · -
                  {formatCurrency(appliedBenefit.benefitAmount)}
                </span>
                <button
                  type="button"
                  className="smallbtn"
                  disabled={benefitBusy}
                  onClick={() => {
                    void clearAppliedBenefit(true);
                    setBenefitModalOpen(false);
                  }}
                >
                  Rimuovi
                </button>
              </div>
            ) : (
              <>
                <div
                  className="table-payment-benefit-mode-grid"
                  aria-label="Modalita buono o sconto"
                >
                  {BENEFIT_INPUT_MODES.map((option) => (
                    <button
                      key={option.mode}
                      type="button"
                      className={`smallbtn table-payment-benefit-mode table-payment-benefit-mode-${option.mode} ${
                        benefitInputMode === option.mode ? "is-active" : ""
                      }`.trim()}
                      data-benefit-source={option.source}
                      disabled={benefitBusy}
                      onClick={() => selectBenefitInputMode(option.mode)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {benefitInputMode === "manual" ? (
                  <div className="table-payment-benefit-panel">
                    <div
                      className="table-payment-benefit-code-field"
                      aria-labelledby="payment_benefit_code_label"
                    >
                      <span id="payment_benefit_code_label">Codice</span>
                      <div className="table-payment-benefit-code-grid" onPaste={pasteBenefitCode}>
                        {BENEFIT_CODE_GROUP_INDEXES.map((groupIndex) => (
                          <div key={groupIndex} className="table-payment-benefit-code-cluster">
                            <div className="table-payment-benefit-code-group">
                              {BENEFIT_CODE_SLOT_INDEXES.slice(
                                groupIndex * BENEFIT_CODE_GROUP_LENGTH,
                                groupIndex * BENEFIT_CODE_GROUP_LENGTH + BENEFIT_CODE_GROUP_LENGTH
                              ).map((slotIndex) => (
                                <input
                                  key={slotIndex}
                                  ref={(node) => {
                                    benefitCodeInputRefs.current[slotIndex] = node;
                                  }}
                                  id={slotIndex === 0 ? "payment_benefit_code" : undefined}
                                  name={`payment_benefit_code_${slotIndex + 1}`}
                                  className="table-payment-benefit-code-slot"
                                  value={benefitCodeSlotValues[slotIndex]}
                                  autoComplete="off"
                                  autoCapitalize="characters"
                                  inputMode="text"
                                  maxLength={1}
                                  aria-label={`Codice carattere ${slotIndex + 1}`}
                                  disabled={benefitBusy}
                                  onChange={(event) =>
                                    updateBenefitCodeSlot(slotIndex, event.target.value)
                                  }
                                  onKeyDown={(event) =>
                                    handleBenefitCodeSlotKeyDown(slotIndex, event)
                                  }
                                />
                              ))}
                            </div>
                            {groupIndex < BENEFIT_CODE_GROUP_COUNT - 1 ? (
                              <span
                                className="table-payment-benefit-code-separator"
                                aria-hidden="true"
                              >
                                -
                              </span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="table-payment-note-actions">
                      <button
                        type="button"
                        className="smallbtn table-payment-note-save"
                        disabled={benefitBusy}
                        onClick={handleApplyBenefitCode}
                      >
                        {benefitBusy ? "Verifica..." : "Applica"}
                      </button>
                    </div>
                  </div>
                ) : null}
                {benefitInputMode === "qr" ? (
                  <div className="table-payment-benefit-panel table-payment-benefit-qr-panel">
                    <strong>Scansiona QR</strong>
                    <QrCameraScanner
                      active={benefitModalOpen && !benefitBusy && !benefitFailure}
                      disabled={benefitBusy}
                      onDetected={handleApplyBenefitQr}
                      onError={(message) => showBenefitFailure("qr", message)}
                    />
                  </div>
                ) : null}
                {benefitInputMode === "nfc" ? (
                  <div className="table-payment-benefit-panel table-payment-benefit-nfc-panel">
                    <div className="table-payment-benefit-nfc-visual" aria-hidden="true">
                      <span className="table-payment-benefit-nfc-phone" />
                      <span className="table-payment-benefit-nfc-card" />
                      <span className="table-payment-benefit-nfc-wave is-one" />
                      <span className="table-payment-benefit-nfc-wave is-two" />
                    </div>
                    <div className="table-payment-benefit-nfc" aria-live="polite">
                      <span>NFC</span>
                      <strong>{benefitBusy ? "Verifica in corso..." : benefitNfcStatus}</strong>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
      {benefitFailure ? (
        <div
          className="table-payment-note-backdrop table-payment-benefit-result-backdrop"
          onClick={cancelBenefitInput}
        >
          <div
            className="table-payment-note-card table-payment-benefit-result-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="payment_benefit_result_title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="table-payment-note-head">
              <strong id="payment_benefit_result_title">Codice non applicato</strong>
            </div>
            <p className="table-payment-benefit-result-message">{benefitFailure.message}</p>
            <div className="table-payment-note-actions table-payment-benefit-result-actions">
              <button
                type="button"
                className="smallbtn table-payment-benefit-retry"
                onClick={retryBenefitInput}
              >
                Riprova
              </button>
              <button
                type="button"
                className="smallbtn table-payment-benefit-cancel"
                onClick={cancelBenefitInput}
              >
                Annulla
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
  return paymentLayerRoot ? createPortal(paymentContent, paymentLayerRoot) : paymentContent;
}
