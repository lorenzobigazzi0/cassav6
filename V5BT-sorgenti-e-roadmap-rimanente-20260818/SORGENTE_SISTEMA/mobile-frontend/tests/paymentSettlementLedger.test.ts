import { describe, expect, it } from "vitest";
import type { AnalyticsMovementRecord } from "../src/api/analyticsPaymentMovements";
import {
  buildSettlementLedgerEntries,
  summarizeSettlementLedger,
} from "../src/pages/payments/settlementLedger";

const baseMovement = (overrides: Partial<AnalyticsMovementRecord>): AnalyticsMovementRecord => ({
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

const summaryFor = (movements: AnalyticsMovementRecord[]) =>
  summarizeSettlementLedger(buildSettlementLedgerEntries(movements));

describe("payment settlement ledger", () => {
  it("keeps a simple cash payment as net cash", () => {
    const summary = summaryFor([
      baseMovement({ id: "payment:cash-30", amount: 30, method: "cash", methodLabel: "Contanti" }),
    ]);

    expect(summary.gross.cash).toBe(30);
    expect(summary.refunds.cash).toBe(0);
    expect(summary.net.cash).toBe(30);
    expect(summary.netTotal).toBe(30);
  });

  it("keeps automatic cash as income but excludes it from cash deposit", () => {
    const summary = summaryFor([
      baseMovement({
        id: "payment:auto-cash-20",
        amount: 20,
        method: "cash",
        methodLabel: "Contanti",
        paymentSource: "automatic_cash",
        cashSource: "automatic",
        automaticCashPaymentOperationId: "cashpay_test_1",
      }),
      baseMovement({
        id: "payment:wallet-cash-5",
        amount: 5,
        method: "cash",
        methodLabel: "Contanti",
      }),
    ]);

    expect(summary.net.cash).toBe(25);
    expect(summary.netTotal).toBe(25);
    expect(summary.automaticCashTotal).toBe(20);
    expect(summary.cashDepositNetTotal).toBe(5);
  });

  it("subtracts a cash refund from the cash net total", () => {
    const summary = summaryFor([
      baseMovement({ id: "payment:cash-30", amount: 30, method: "cash", methodLabel: "Contanti" }),
      baseMovement({
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
    ]);

    expect(summary.gross.cash).toBe(30);
    expect(summary.refunds.cash).toBe(8);
    expect(summary.net.cash).toBe(22);
    expect(summary.netTotal).toBe(22);
  });

  it("computes same-turn POS full void plus recharge as the residual POS amount", () => {
    const summary = summaryFor([
      baseMovement({
        id: "payment:pos-21",
        amount: 21,
        method: "POS",
        methodLabel: "Carta/POS",
        paymentId: "pos-21",
      }),
      baseMovement({
        id: "storno:pos-void-21",
        type: "storno",
        typeLabel: "Storno",
        amount: -21,
        method: "POS",
        methodLabel: "Carta/POS",
        paymentVoidAmount: 21,
        paymentRechargeAmount: 9,
        refundPlan: {
          allocations: [
            {
              paymentId: "pos-21",
              method: "POS",
              action: "pos_void_full_transaction_and_recharge_remaining",
              refundAmount: 12,
              voidAmount: 21,
              rechargeAmount: 9,
              transactionIds: ["tx-pos-21"],
              fiscalDocNo: "",
            },
          ],
        },
      }),
      baseMovement({
        id: "payment:pos-recharge-9",
        amount: 9,
        method: "POS",
        methodLabel: "Carta/POS",
        adjustmentKind: "pos_recharge_after_full_void",
        originalPaymentId: "pos-21",
        supersedesPaymentId: "pos-21",
      }),
    ]);

    expect(summary.gross.pos).toBe(21);
    expect(summary.refunds.pos).toBe(21);
    expect(summary.posRechargeTotal).toBe(9);
    expect(summary.net.pos).toBe(9);
    expect(summary.grossTotal).toBe(21);
    expect(summary.netTotal).toBe(9);
  });

  it("computes next-turn POS void plus recharge as a negative adjustment", () => {
    const summary = summaryFor([
      baseMovement({
        id: "storno:pos-void-21",
        type: "storno",
        typeLabel: "Storno",
        amount: -21,
        method: "POS",
        methodLabel: "Carta/POS",
        paymentVoidAmount: 21,
        paymentRechargeAmount: 9,
        refundPlan: {
          allocations: [
            {
              paymentId: "old-pos-21",
              method: "POS",
              action: "pos_void_full_transaction_and_recharge_remaining",
              refundAmount: 12,
              voidAmount: 21,
              rechargeAmount: 9,
              transactionIds: ["tx-old-pos-21"],
              fiscalDocNo: "",
            },
          ],
        },
      }),
      baseMovement({
        id: "payment:pos-recharge-9",
        amount: 9,
        method: "POS",
        methodLabel: "Carta/POS",
        adjustmentKind: "pos_recharge_after_full_void",
        originalPaymentId: "old-pos-21",
        supersedesPaymentId: "old-pos-21",
      }),
    ]);

    expect(summary.gross.pos).toBe(0);
    expect(summary.refunds.pos).toBe(21);
    expect(summary.posRechargeTotal).toBe(9);
    expect(summary.net.pos).toBe(-12);
    expect(summary.grossTotal).toBe(0);
    expect(summary.netTotal).toBe(-12);
  });

  it("splits mixed refunds by refundPlan allocation instead of the combined method label", () => {
    const summary = summaryFor([
      baseMovement({ id: "payment:cash-20", amount: 20, method: "cash", methodLabel: "Contanti" }),
      baseMovement({ id: "payment:pos-20", amount: 20, method: "POS", methodLabel: "Carta/POS" }),
      baseMovement({
        id: "storno:mixed",
        type: "storno",
        typeLabel: "Storno",
        amount: -15,
        method: "cash, POS",
        methodLabel: "Contanti + Carta/POS",
        refundPlan: {
          allocations: [
            {
              paymentId: "cash-20",
              method: "CASH",
              action: "cash_refund",
              refundAmount: 5,
              voidAmount: 0,
              rechargeAmount: 0,
              transactionIds: [],
              fiscalDocNo: "",
            },
            {
              paymentId: "pos-20",
              method: "POS",
              action: "pos_void_full_transaction_and_recharge_remaining",
              refundAmount: 10,
              voidAmount: 10,
              rechargeAmount: 0,
              transactionIds: ["tx-pos-20"],
              fiscalDocNo: "",
            },
          ],
        },
      }),
    ]);

    expect(summary.net.cash).toBe(15);
    expect(summary.net.pos).toBe(10);
    expect(summary.netTotal).toBe(25);
  });

  it("ignores zero-cost replacements in settlement totals", () => {
    const summary = summaryFor([
      baseMovement({
        id: "replacement:zero-cost",
        type: "replacement",
        typeLabel: "Sostituzione",
        amount: 0,
        method: "",
        methodLabel: "",
      }),
    ]);

    expect(summary.entryCount).toBe(0);
    expect(summary.grossTotal).toBe(0);
    expect(summary.refundTotal).toBe(0);
    expect(summary.netTotal).toBe(0);
  });
});
