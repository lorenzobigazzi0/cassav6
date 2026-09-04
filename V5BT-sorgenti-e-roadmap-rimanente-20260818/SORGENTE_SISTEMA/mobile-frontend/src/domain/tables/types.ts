import type { ProductClientPriceSnapshot } from "../../shared/pricing/productPricing";
import type { IntegrationLayoutOfflineLifecycle } from "./integrationTypes";

export type TableOccupancyState = "free" | "reserved" | "seated";
export type TableOrderState = "in_progress" | "served" | "paid";
export type DiningTableVisualState = "free" | "occupied" | "ordering" | "payment_due";
export type IntegrationOrderWorkflowStatus =
  | "waiting"
  | "prep"
  | "ready"
  | "delivered"
  | "cancelled";
export type PosTableStatus = "free" | "reserved" | "no_orders" | "waiting" | "payment_due";
export type TablePaymentMethod =
  | "cash"
  | "card"
  | "voucher"
  | "satispay"
  | "suspended"
  | "check"
  | "wire";
export type TablePaymentSplitMode = "single" | "roman" | "amount" | "article";
export type TablePaymentReceiptType = "scontrino" | "fattura";
export type TablePaymentAdminAdjustmentType =
  | "manual_total"
  | "discount"
  | "allowance"
  | "line_price_override";

export type TablePaymentInvoiceRecipient = {
  ragioneSociale?: string;
  piva?: string;
  indirizzo?: string;
  cap?: string;
  citta?: string;
  provincia?: string;
  pec?: string;
  sdi?: string;
};

export type TablePaymentAdminLineAdjustment = {
  articleUnitId: string;
  orderId: string;
  lineId: string;
  lineIndex: number;
  unitIndex: number;
  name: string;
  originalAmount: number;
  adjustedAmount: number;
};

export type TablePaymentAdminAdjustment = {
  type: TablePaymentAdminAdjustmentType;
  reason: string;
  originalAmount: number;
  adjustedAmount: number;
  discountAmount: number;
  differenceAmount?: number;
  percent?: number;
  lineAdjustments?: TablePaymentAdminLineAdjustment[];
};

export type TableCommercialBenefitApplication = {
  applicationId: string;
  benefitAmountCents?: number;
  benefitKind?: "fixed_discount" | "value_voucher" | "percentage_discount";
  residualPolicy?: "forfeit_remaining" | "keep_balance" | "no_partial_use" | null;
};

export type DiningOrderPriceChangeReason = "variant" | "manual" | "supplement" | "unknown";

export type DiningTableOrderLine = {
  lineId?: string;
  articleUnitIds?: string[];
  productId?: string;
  name: string;
  qty: number;
  note?: string;
  variantName?: string;
  modifiers?: Record<string, string>;
  unitBasePrice?: number;
  unitFinalPrice?: number;
  priceDelta?: number;
  priceChanged?: boolean;
  priceChangeReason?: DiningOrderPriceChangeReason;
  vatRate?: number;
  vatCode?: string;
  clientPriceSnapshot?: ProductClientPriceSnapshot;
  serviceRecoveryAvailableQuantity?: number;
  serviceRecoveryCompedQuantity?: number;
};

export type DiningTableOrder = {
  id: string;
  currentRevision?: number;
  title: string;
  createdAt: number;
  total: number;
  state: TableOrderState;
  workflowStatus?: IntegrationOrderWorkflowStatus;
  paymentStatus?: "unpaid" | "partial" | "paid";
  dueAmount?: number;
  paidAmount?: number;
  orderNote?: string;
  orderComment?: string;
  paidArticleUnits: string[];
  lines: DiningTableOrderLine[];
};

export type TableReservationPreview = {
  id: string;
  reservationAt: number;
  customerName: string;
  customerPhone: string;
  covers: number;
  note: string;
  withinBlockWindow: boolean;
  shouldWarnRelease: boolean;
};

export type DiningTable = {
  id: string;
  number: number;
  tableName: string;
  customerPhone: string;
  covers: number;
  occupancyState: TableOccupancyState;
  reservationAt: number | null;
  seatedAt: number | null;
  ordersTaken: number;
  ordersInProgress: number;
  amountDue: number;
  note: string;
  allergens: string[];
  manualIntolerance: string;
  orderHistory: DiningTableOrder[];
  reservationPreview?: TableReservationPreview | null;
  mobileComplex?: boolean;
  mobileComplexLabel?: string;
  mobileLeafTableIds?: string[];
  mobileActiveTableId?: string;
  logicalTableId?: string;
  logicalTableLabel?: string;
  tableLabel?: string;
  paymentArticleSplitLocked?: boolean;
  offlineLifecycle?: IntegrationLayoutOfflineLifecycle;
};

export type TableSessionRequest = {
  token: string;
  userId: string;
  username?: string;
  fullName?: string;
  deviceUuid: string;
  activityId?: string;
  roomId: string;
  logicalTableId?: string;
  logicalTableLabel?: string;
  tableLabel?: string;
};
