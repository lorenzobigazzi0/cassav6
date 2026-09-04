import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSettlementLedgerEntries,
  buildSettlementLedgerFromSalesReport,
  summarizeSettlementLedger,
} from "../modules/reports/settlement-ledger.js";

function summaryFor(input) {
  return summarizeSettlementLedger(buildSettlementLedgerEntries(input));
}

test("backend settlement ledger keeps a simple cash payment as net cash", () => {
  const summary = summaryFor({
    payments: [{ id: "cash-30", status: "COMPLETED", amount: 30, paymentMethod: "cash", methodLabel: "Contanti" }],
  });

  assert.equal(summary.cashGrossTotal, 30);
  assert.equal(summary.cashRefundTotal, 0);
  assert.equal(summary.cashNetTotal, 30);
  assert.equal(summary.netTotal, 30);
});

test("backend settlement ledger keeps automatic cash income out of cash deposit", () => {
  const summary = summaryFor({
    payments: [
      {
        id: "auto-cash-20",
        status: "COMPLETED",
        amount: 20,
        paymentMethod: "cash",
        methodLabel: "Contanti",
        paymentSource: "automatic_cash",
        cashSource: "automatic",
        automaticCashPaymentOperationId: "cashpay_test_1",
      },
      {
        id: "wallet-cash-5",
        status: "COMPLETED",
        amount: 5,
        paymentMethod: "cash",
        methodLabel: "Contanti",
      },
    ],
  });

  assert.equal(summary.cashNetTotal, 25);
  assert.equal(summary.netTotal, 25);
  assert.equal(summary.automaticCashTotal, 20);
  assert.equal(summary.cashDepositNetTotal, 5);
});

test("backend settlement ledger subtracts a cash refund from the cash net total", () => {
  const summary = summaryFor({
    payments: [{ id: "cash-30", status: "COMPLETED", amount: 30, paymentMethod: "cash", methodLabel: "Contanti" }],
    comps: [
      {
        id: "comp-cash",
        refundPlan: {
          allocations: [
            {
              paymentId: "cash-30",
              method: "CASH",
              action: "cash_refund",
              refundAmount: 8,
              voidAmount: 0,
              rechargeAmount: 0,
            },
          ],
        },
      },
    ],
  });

  assert.equal(summary.cashGrossTotal, 30);
  assert.equal(summary.cashRefundTotal, 8);
  assert.equal(summary.cashNetTotal, 22);
  assert.equal(summary.netTotal, 22);
});

test("backend settlement ledger nets same-turn POS full void plus recharge", () => {
  const summary = summaryFor({
    payments: [
      { id: "pos-21", status: "COMPLETED", amount: 21, paymentMethod: "POS" },
      {
        id: "pos-recharge-9",
        status: "COMPLETED",
        amount: 9,
        paymentMethod: "POS",
        adjustmentKind: "pos_recharge_after_full_void",
        originalPaymentId: "pos-21",
        supersedesPaymentId: "pos-21",
      },
    ],
    comps: [
      {
        id: "comp-pos",
        refundPlan: {
          allocations: [
            {
              paymentId: "pos-21",
              method: "POS",
              action: "pos_void_full_transaction_and_recharge_remaining",
              refundAmount: 12,
              voidAmount: 21,
              rechargeAmount: 9,
            },
          ],
        },
      },
    ],
  });

  assert.equal(summary.posGrossTotal, 21);
  assert.equal(summary.posRefundTotal, 21);
  assert.equal(summary.posRechargeTotal, 9);
  assert.equal(summary.posNetTotal, 9);
  assert.equal(summary.netTotal, 9);
});

test("backend settlement ledger nets next-turn POS void plus recharge as negative adjustment", () => {
  const summary = summaryFor({
    payments: [
      {
        id: "pos-recharge-9",
        status: "COMPLETED",
        amount: 9,
        paymentMethod: "POS",
        adjustmentKind: "pos_recharge_after_full_void",
        originalPaymentId: "old-pos-21",
      },
    ],
    comps: [
      {
        id: "comp-pos",
        refundPlan: {
          allocations: [
            {
              paymentId: "old-pos-21",
              method: "POS",
              action: "pos_void_full_transaction_and_recharge_remaining",
              refundAmount: 12,
              voidAmount: 21,
              rechargeAmount: 9,
            },
          ],
        },
      },
    ],
  });

  assert.equal(summary.posGrossTotal, 0);
  assert.equal(summary.posRefundTotal, 21);
  assert.equal(summary.posRechargeTotal, 9);
  assert.equal(summary.posNetTotal, -12);
  assert.equal(summary.netTotal, -12);
});

test("backend settlement ledger splits mixed refunds by allocation", () => {
  const summary = summaryFor({
    payments: [
      { id: "cash-20", status: "COMPLETED", amount: 20, paymentMethod: "cash", methodLabel: "Contanti" },
      { id: "pos-20", status: "COMPLETED", amount: 20, paymentMethod: "POS", methodLabel: "Carta/POS" },
    ],
    comps: [
      {
        id: "comp-mixed",
        methodLabel: "Contanti + POS",
        refundPlan: {
          allocations: [
            {
              paymentId: "cash-20",
              method: "CASH",
              action: "cash_refund",
              refundAmount: 5,
              voidAmount: 0,
            },
            {
              paymentId: "pos-20",
              method: "POS",
              action: "pos_void_full_transaction_and_recharge_remaining",
              refundAmount: 10,
              voidAmount: 10,
            },
          ],
        },
      },
    ],
  });

  assert.equal(summary.cashNetTotal, 15);
  assert.equal(summary.posNetTotal, 10);
  assert.equal(summary.netTotal, 25);
});

test("backend settlement ledger ignores non-financial replacements", () => {
  const summary = summaryFor({
    payments: [{ id: "cash-20", status: "COMPLETED", amount: 20, paymentMethod: "cash", methodLabel: "Contanti" }],
    comps: [
      {
        id: "comp-zero",
        amount: 20,
        paidAmount: 20,
        nonFinancialReplacement: true,
        refundPlan: { status: "not_required", allocations: [] },
      },
    ],
  });

  assert.equal(summary.cashGrossTotal, 20);
  assert.equal(summary.refundTotal, 0);
  assert.equal(summary.netTotal, 20);
});

test("backend settlement ledger can be built from the sales report shape", () => {
  const ledger = buildSettlementLedgerFromSalesReport({
    paymentsTracking: {
      containers: [{ id: "cash-30", status: "COMPLETED", amount: 30, paymentMethod: "cash" }],
    },
    serviceRecovery: {
      comps: [
        {
          id: "comp-cash",
          refundPlan: {
            allocations: [{ paymentId: "cash-30", method: "CASH", action: "cash_refund", refundAmount: 8 }],
          },
        },
      ],
    },
  });
  const summary = summarizeSettlementLedger(ledger);

  assert.equal(summary.cashNetTotal, 22);
});

test("backend settlement ledger infers container methods from payment transactions", () => {
  const ledger = buildSettlementLedgerFromSalesReport({
    paymentsTracking: {
      containers: [{ id: "mixed-30", status: "COMPLETED", amount: 30 }],
      parts: [{ id: "part-1", paymentId: "mixed-30", amountDue: 30, status: "PAID" }],
      transactions: [
        { id: "tx-cash", partId: "part-1", method: "CASH", amountPaid: 12 },
        { id: "tx-pos", partId: "part-1", method: "POS", amountPaid: 18 },
      ],
    },
    serviceRecovery: { comps: [] },
  });
  const summary = summarizeSettlementLedger(ledger);

  assert.equal(summary.cashGrossTotal, 12);
  assert.equal(summary.posGrossTotal, 18);
  assert.equal(summary.otherGrossTotal, 0);
  assert.equal(summary.netTotal, 30);
});

test("backend sales report shape keeps POS recharge separated from POS gross", () => {
  const ledger = buildSettlementLedgerFromSalesReport({
    paymentsTracking: {
      containers: [
        { id: "pos-21", status: "COMPLETED", amount: 21, paymentMethod: "POS" },
        {
          id: "pos-recharge-9",
          status: "COMPLETED",
          amount: 9,
          paymentMethod: "POS",
          adjustmentKind: "pos_recharge_after_full_void",
        },
      ],
    },
    serviceRecovery: {
      comps: [
        {
          id: "comp-pos",
          refundPlan: {
            allocations: [
              {
                paymentId: "pos-21",
                method: "POS",
                action: "pos_void_full_transaction_and_recharge_remaining",
                voidAmount: 21,
              },
            ],
          },
        },
      ],
    },
  });
  const summary = summarizeSettlementLedger(ledger);

  assert.equal(summary.posGrossTotal, 21);
  assert.equal(summary.posRefundTotal, 21);
  assert.equal(summary.posRechargeTotal, 9);
  assert.equal(summary.posNetTotal, 9);
});
