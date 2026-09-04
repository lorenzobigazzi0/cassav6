export type AnalyticsMovementType = "payment" | "storno" | "replacement";

export type AnalyticsMovementTransaction = {
  id: string;
  method: string;
  amountPaid: number;
  posTxRef: string;
  posProvider: string;
  paymentSource: string;
  cashSource: string;
  automaticCashPaymentOperationId: string;
  note: string;
};

export type AnalyticsRefundAllocation = {
  paymentId: string;
  method: string;
  action: string;
  refundAmount: number;
  voidAmount: number;
  rechargeAmount: number;
  transactionIds: string[];
  fiscalDocNo: string;
};

export type AnalyticsRefundPlan = {
  allocations: AnalyticsRefundAllocation[];
};

export type AnalyticsMovementRecord = {
  id: string;
  type: AnalyticsMovementType;
  typeLabel: string;
  amount: number;
  createdAt: number;
  operatorId: string;
  operatorName: string;
  method: string;
  methodLabel: string;
  paymentSource: string;
  cashSource: string;
  automaticCashPaymentOperationId: string;
  tableId: string;
  tableNumber?: number;
  tableLabel: string;
  roomId: string;
  note: string;
  orderIds: string[];
  orderReference: string;
  paymentId: string;
  transactionIds: string[];
  transactions: AnalyticsMovementTransaction[];
  splitMode: string;
  articleUnitIds: string[];
  articleReference: string | string[];
  fiscalDocNo: string;
  fiscalDocType: string;
  tableCancellationId: string;
  tableCancelledAt: string;
  tableCancelledByUserId: string;
  tableCancelledByUsername: string;
  tableCancellationReason: string;
  adjustmentKind: string;
  originalPaymentId: string;
  supersedesPaymentId: string;
  supersededByPaymentId: string;
  productName: string;
  quantity?: number;
  lineId: string;
  refundPlan?: AnalyticsRefundPlan;
  paymentVoidAmount?: number;
  paymentRechargeAmount?: number;
  rechargePaymentIds: string[];
  rechargeTransactionIds: string[];
  raw?: Record<string, unknown>;
};

export type AnalyticsFiscalReceipt = {
  id: string;
  paymentId: string;
  fiscalStatus: string;
  fiscalProviderRef: string;
  fiscalMovementId: string;
  fiscalReceiptDate: string;
  fiscalDocumentNumber: string;
  fiscalError: string;
  voidStatus: string;
  voidedAt: string;
  voidProviderRef: string;
  voidMovementId: string;
  voidReceiptDate: string;
  voidDocumentNumber: string;
  voidError: string;
};
