import { apiJson } from "../baseUrl";
import type {
  DiningTableOrder,
  TablePaymentAdminAdjustment,
  TableCommercialBenefitApplication,
  TablePaymentInvoiceRecipient,
  TablePaymentMethod,
  TablePaymentReceiptType,
  TablePaymentSplitMode,
  TableSessionRequest,
} from "../../domain/tables/types";

type CounterCollectPayment = {
  amount: number;
  method: TablePaymentMethod;
  articleUnitIds?: string[];
  splitMode?: TablePaymentSplitMode;
  adminAdjustment?: TablePaymentAdminAdjustment;
  commercialBenefitApplications?: TableCommercialBenefitApplication[];
  cashReceived?: number;
  cashSource?: "wallet" | "automatic";
  automaticCashPaymentOperationId?: string;
  receiptType?: TablePaymentReceiptType;
  invoiceRecipient?: TablePaymentInvoiceRecipient | null;
  clientPaymentId?: string;
  note?: string;
  romanSharesPaid?: number;
  romanSharesTotal?: number;
};

type CounterCollectResult = {
  ok: true;
  idempotent?: boolean;
  counterOrderId: string;
  paymentId: string;
  printJobs?: {
    command?: { id?: string; status?: string; printerName?: string } | null;
    receipt?: { id?: string; status?: string; printerName?: string } | null;
  };
  printWarning?: string;
};

const moneyToCents = (value: number) => Math.round(Math.max(0, Number(value) || 0) * 100);

const buildCounterClientPaymentId = (order: DiningTableOrder, explicit?: string) => {
  const normalized = explicit?.trim();
  if (normalized) return normalized;
  return `counter_${order.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

export async function collectCounterOrder(
  params: TableSessionRequest & {
    order: DiningTableOrder;
    payment: CounterCollectPayment;
    tableId: string;
    tableLabel: string;
    operatorLabel: string;
  }
) {
  const clientPaymentId = buildCounterClientPaymentId(params.order, params.payment.clientPaymentId);
  const automaticCashPaymentOperationId =
    params.payment.automaticCashPaymentOperationId?.trim() || "";
  const isAutomaticCashPayment =
    params.payment.method === "cash" &&
    (params.payment.cashSource === "automatic" || automaticCashPaymentOperationId.length > 0);
  return apiJson<CounterCollectResult>("/api/tables/counter/orders/collect", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-User-Id": params.userId,
      "X-Device-Uuid": params.deviceUuid,
      "X-Client-App": "mobile-frontend",
      ...(params.token ? { Authorization: `Bearer ${params.token}` } : {}),
    },
    body: JSON.stringify({
      token: params.token,
      userId: params.userId,
      username: params.username,
      fullName: params.fullName,
      deviceUuid: params.deviceUuid,
      activityId: params.activityId,
      roomId: params.roomId,
      clientApp: "mobile-frontend",
      idempotencyKey: clientPaymentId,
      clientPaymentId,
      context: "counter",
      tableId: params.tableId,
      tableLabel: params.tableLabel,
      operator: {
        userId: params.userId,
        username: params.username,
        fullName: params.fullName,
        label: params.operatorLabel,
      },
      order: {
        id: params.order.id,
        title: params.order.title,
        createdAt: params.order.createdAt,
        totalCents: moneyToCents(params.order.total),
        note: params.order.orderNote,
        comment: params.order.orderComment,
        lines: params.order.lines.map((line) => ({
          lineId: line.lineId,
          productId: line.productId,
          name: line.name,
          qty: line.qty,
          note: line.note,
          variantName: line.variantName,
          unitBasePrice: line.unitBasePrice,
          unitFinalPrice: line.unitFinalPrice,
          priceDelta: line.priceDelta,
          vatRate: line.vatRate,
          vatCode: line.vatCode,
          clientPriceSnapshot: line.clientPriceSnapshot,
        })),
      },
      payment: {
        amountCents: moneyToCents(params.payment.amount),
        method: params.payment.method,
        articleUnitIds: params.payment.articleUnitIds,
        splitMode: params.payment.splitMode,
        adminAdjustment: params.payment.adminAdjustment,
        paymentSource: isAutomaticCashPayment ? "automatic_cash" : undefined,
        cashSource: isAutomaticCashPayment ? "automatic" : undefined,
        automaticCashPaymentOperationId:
          isAutomaticCashPayment && automaticCashPaymentOperationId
            ? automaticCashPaymentOperationId
            : undefined,
        cashReceivedCents:
          params.payment.cashReceived !== undefined
            ? moneyToCents(params.payment.cashReceived)
            : undefined,
        receiptType: params.payment.receiptType ?? "scontrino",
        invoiceRecipient: params.payment.invoiceRecipient ?? null,
        note: params.payment.note,
        romanSharesPaid: params.payment.romanSharesPaid,
        romanSharesTotal: params.payment.romanSharesTotal,
      },
      commercialBenefitApplications: params.payment.commercialBenefitApplications,
    }),
  });
}
