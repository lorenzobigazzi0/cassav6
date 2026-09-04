import { beforeEach, describe, expect, it } from "vitest";
import {
  automaticSettlementDifferenceCents,
  automaticSettlementExpectedDepositTotalCents,
} from "../src/pages/payments/automaticSettlementModel";
import {
  buildSettlementLedgerEntries,
  summarizeSettlementLedger,
} from "../src/pages/payments/settlementLedger";
import type { AnalyticsMovementRecord } from "../src/api/analyticsPaymentMovements";
import {
  readAutomaticCashSettlementRecords,
  readLatestAutomaticCashSettlementRecord,
  resolveSettlementFeedback,
  saveAutomaticCashSettlementRecord,
  type AutomaticCashSettlementRecord,
} from "../src/utils/automaticCashSettlementArchive";

const makeRecord = (
  overrides: Partial<AutomaticCashSettlementRecord> = {}
): AutomaticCashSettlementRecord => ({
  id: "FCA-1:1782444000000",
  cashFloatId: "FCA-1",
  assignmentId: "ASN-1",
  combinationId: "COMBO-1",
  businessEveningKey: "2026-06-26",
  userId: "u-1",
  deviceUuid: "device-1",
  expectedDepositTotalCents: 18450,
  depositedTotalCents: 18450,
  differenceCents: 0,
  mismatchConfirmed: false,
  feedbackKind: "happy",
  printText: "SCARICO CASSA\nDA VERSARE Automatico",
  completedAtMs: 1_782_444_000_000,
  ...overrides,
});

const movement = (overrides: Partial<AnalyticsMovementRecord>): AnalyticsMovementRecord => ({
  id: overrides.id || "payment:p-1",
  type: overrides.type || "payment",
  typeLabel: overrides.typeLabel || "Pagamento",
  amount: overrides.amount ?? 0,
  createdAt: overrides.createdAt ?? 1_782_444_000_000,
  operatorId: overrides.operatorId || "u-1",
  operatorName: overrides.operatorName || "Operatore",
  method: overrides.method || "cash",
  methodLabel: overrides.methodLabel || "Contanti",
  paymentSource: overrides.paymentSource || "",
  cashSource: overrides.cashSource || "",
  automaticCashPaymentOperationId: overrides.automaticCashPaymentOperationId || "",
  tableId: overrides.tableId || "table-1",
  tableNumber: overrides.tableNumber,
  tableLabel: overrides.tableLabel || "1",
  roomId: overrides.roomId || "room-1",
  note: overrides.note || "",
  orderIds: overrides.orderIds || ["ord-1"],
  orderReference: overrides.orderReference || "#ord-1",
  paymentId: overrides.paymentId || "p-1",
  transactionIds: overrides.transactionIds || [],
  transactions: overrides.transactions || [],
  splitMode: overrides.splitMode || "",
  articleUnitIds: overrides.articleUnitIds || [],
  articleReference: overrides.articleReference || "",
  fiscalDocNo: overrides.fiscalDocNo || "",
  fiscalDocType: overrides.fiscalDocType || "",
  tableCancellationId: overrides.tableCancellationId || "",
  tableCancelledAt: overrides.tableCancelledAt || "",
  tableCancelledByUserId: overrides.tableCancelledByUserId || "",
  tableCancelledByUsername: overrides.tableCancelledByUsername || "",
  tableCancellationReason: overrides.tableCancellationReason || "",
  adjustmentKind: overrides.adjustmentKind || "",
  originalPaymentId: overrides.originalPaymentId || "",
  supersedesPaymentId: overrides.supersedesPaymentId || "",
  supersededByPaymentId: overrides.supersededByPaymentId || "",
  productName: overrides.productName || "",
  quantity: overrides.quantity,
  lineId: overrides.lineId || "",
  refundPlan: overrides.refundPlan,
  paymentVoidAmount: overrides.paymentVoidAmount,
  paymentRechargeAmount: overrides.paymentRechargeAmount,
  rechargePaymentIds: overrides.rechargePaymentIds || [],
  rechargeTransactionIds: overrides.rechargeTransactionIds || [],
  raw: overrides.raw,
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("automatic cash settlement archive", () => {
  it("computes automatic expected deposit as cash total plus hidden cash float", () => {
    expect(
      automaticSettlementExpectedDepositTotalCents({
        cashTotalCents: 4300,
        automaticCashFloatCents: 14130,
        cashFloatId: "FCA-1",
      })
    ).toBe(18430);
    expect(automaticSettlementDifferenceCents(18430, 18300)).toBe(130);
  });

  it("uses net cash after refunds for automatic expected deposit", () => {
    const summary = summarizeSettlementLedger(
      buildSettlementLedgerEntries([
        movement({
          id: "payment:cash-30",
          amount: 30,
          method: "cash",
          methodLabel: "Contanti",
        }),
        movement({
          id: "storno:cash-8",
          type: "storno",
          typeLabel: "Storno",
          amount: -8,
          method: "cash",
          methodLabel: "Contanti",
          refundPlan: {
            allocations: [
              {
                paymentId: "payment:cash-30",
                method: "CASH",
                action: "cash_refund",
                refundAmount: 8,
                voidAmount: 0,
                rechargeAmount: 0,
                transactionIds: [],
                fiscalDocNo: "",
              },
            ],
          },
        }),
      ])
    );

    expect(summary.gross.cash).toBe(30);
    expect(summary.refunds.cash).toBe(8);
    expect(summary.net.cash).toBe(22);
    expect(
      automaticSettlementExpectedDepositTotalCents({
        cashTotalCents: Math.round(summary.net.cash * 100),
        automaticCashFloatCents: 10_000,
        cashFloatId: "FCA-1",
      })
    ).toBe(12_200);
  });

  it("persists latest automatic settlement for reprint", () => {
    saveAutomaticCashSettlementRecord(makeRecord());
    saveAutomaticCashSettlementRecord(
      makeRecord({
        id: "FCA-2:1782445000000",
        cashFloatId: "FCA-2",
        completedAtMs: 1_782_445_000_000,
        printText: "ULTIMO REPORT",
      })
    );

    expect(readAutomaticCashSettlementRecords()).toHaveLength(2);
    expect(
      readLatestAutomaticCashSettlementRecord({ userId: "u-1", deviceUuid: "device-1" })?.printText
    ).toBe("ULTIMO REPORT");
  });

  it("classifies feedback from deposit mismatch", () => {
    expect(
      resolveSettlementFeedback({
        expectedDepositTotalCents: 10_000,
        depositedTotalCents: 10_000,
        warningThresholdCents: 500,
        dangerThresholdCents: 2000,
      })
    ).toBe("happy");
    expect(
      resolveSettlementFeedback({
        expectedDepositTotalCents: 10_000,
        depositedTotalCents: 9_000,
        warningThresholdCents: 100,
        dangerThresholdCents: 1500,
      })
    ).toBe("sad");
    expect(
      resolveSettlementFeedback({
        expectedDepositTotalCents: 10_000,
        depositedTotalCents: 9_000,
        warningThresholdCents: 1000,
        dangerThresholdCents: 1000,
      })
    ).toBe("sad");
    expect(
      resolveSettlementFeedback({
        expectedDepositTotalCents: 10_000,
        depositedTotalCents: 8_999,
        warningThresholdCents: 1000,
        dangerThresholdCents: 1000,
      })
    ).toBe("angry");
  });
});
