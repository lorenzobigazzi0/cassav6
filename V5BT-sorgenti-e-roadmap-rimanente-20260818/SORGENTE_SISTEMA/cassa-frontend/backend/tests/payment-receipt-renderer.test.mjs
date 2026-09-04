import assert from "node:assert/strict";
import test from "node:test";

import { createPaymentPrintFormatHelpers } from "../modules/payments/payment-print-format.domain.js";
import { createEscPosStyleHelpers } from "../printing/escpos-style.js";
import { createPaymentReceiptRenderer } from "../printing/payment-receipt-renderer.js";
import {
  buildPrintLabelLines,
  buildPrintTwoColumnLines,
  centerPrintText,
  formatPrintMoney,
  makePrintSeparator,
  toPrintSafeUppercase,
} from "../printing/print-utils.js";

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const normalizePaymentMethodType = (value) =>
  String(value ?? "").trim().toUpperCase();
const normalizeStringList = (value, maxLength = 12, itemMaxLength = 40) => {
  const output = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const item = String(raw ?? "").trim().slice(0, itemMaxLength);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    output.push(item);
    if (output.length >= maxLength) break;
  }
  return output;
};

const paymentFormat = createPaymentPrintFormatHelpers({
  normalizePaymentMethodType,
  normalizeStringList,
  roundMoney,
  nowMs: () => 1_788_000_000_000,
});
const escPosStyle = createEscPosStyleHelpers();
const renderer = createPaymentReceiptRenderer({
  ...paymentFormat,
  ...escPosStyle,
  buildPrintLabelLines,
  buildPrintLocationLabel: ({ tableLabel, tableNumber, roomLabel }) =>
    [roomLabel, tableLabel || tableNumber].filter(Boolean).join(" - "),
  buildPrintTwoColumnLines,
  centerPrintText,
  formatIntegrationWaiterShortLabel: (value) =>
    String(value ?? "").trim().toUpperCase(),
  formatPrintMoney,
  makePrintSeparator,
  normalizePaymentMethodType,
  roundMoney,
  sanitizeIntegrationTableLabel: (value) => String(value ?? "").trim(),
  sanitizePosPrintPreferences: (value) => ({
    order: {
      lineWidth: Math.max(48, Number(value?.order?.lineWidth) || 48),
    },
  }),
  toPrintSafeUppercase,
});

test("payment receipt renderer mantiene dati operativi e importi", () => {
  const output = renderer.buildMobileElectronicPaymentPrintText(
    {
      waiter: "Mario Rossi",
      tableLabel: "12A",
      roomName: "Sala Mare",
      orderReference: "COMANDA #42",
      amount: 12.5,
      methodType: "POS",
      methodLabel: "Carta",
      transactionId: "tx-001",
      note: "Cliente esterno",
      createdAtMs: 1_788_000_000_000,
    },
    { lineWidth: 48 },
  );

  assert.match(output, /PAGAMENTO ELETTRONICO/);
  assert.match(output, /SALA MARE - 12A/);
  assert.match(output, /COMANDA #42/);
  assert.match(output, /12,50 EUR/);
  assert.match(output, /TX: TX-001/);
  assert.match(output, /NOTA: CLIENTE ESTERNO/);
});

test("payment storno renderer mantiene riferimenti, azione e importi", () => {
  const output = renderer.buildMobilePaymentStornoPrintText({
    waiter: "Anna",
    tableLabel: "B7",
    roomName: "Terrazza",
    orderReference: "COMANDA #8",
    amount: 7.5,
    quantity: 2,
    productName: "Spritz",
    reason: "Errore articolo",
    stornoId: "storno-1",
    paymentReferences: [
      {
        paymentId: "pay-1",
        method: "POS",
        action: "pos_void_full_transaction",
        refundAmount: 7.5,
        voidAmount: 7.5,
        transactionIds: ["tx-9"],
        fiscalDocType: "RT",
        fiscalDocNo: "10-2",
      },
    ],
    createdAtMs: 1_788_000_000_000,
  });

  assert.match(output, /STORNO PAGAMENTO/);
  assert.match(output, /2 X SPRITZ/);
  assert.match(output, /-7,50 EUR/);
  assert.match(output, /STORNO TOTALE POS/);
  assert.match(output, /TX-9/);
  assert.match(output, /RT 10-2/);
});
