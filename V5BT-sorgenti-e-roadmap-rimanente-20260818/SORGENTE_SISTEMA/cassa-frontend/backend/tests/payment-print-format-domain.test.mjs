import test from "node:test";
import assert from "node:assert/strict";
import { createPaymentPrintFormatHelpers } from "../modules/payments/payment-print-format.domain.js";

const helpers = createPaymentPrintFormatHelpers({
  normalizePaymentMethodType: (value) => String(value ?? "").trim().toUpperCase(),
  normalizeStringList: (value, maxLength = 12, itemMaxLength = 40) => {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of value) {
      const next = String(raw ?? "").trim().slice(0, itemMaxLength);
      if (!next) continue;
      const key = next.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(next);
      if (out.length >= maxLength) break;
    }
    return out;
  },
  roundMoney: (value) => Math.round((Number(value) || 0) * 100) / 100,
  nowMs: () => new Date(2026, 5, 5, 10, 7).getTime(),
});

test("payment print format formatta data e fallback temporale", () => {
  assert.equal(helpers.formatIntegrationPrintDateTime(new Date(2026, 0, 2, 3, 4).getTime()), "02/01/26-03:04");
  assert.equal(helpers.formatIntegrationPrintDateTime("non-valida"), "05/06/26-10:07");
});

test("payment print format normalizza riferimenti comanda", () => {
  assert.equal(helpers.formatIntegrationPrintOrderId("000272"), "#272");
  assert.equal(helpers.formatIntegrationPrintOrderId("COMANDA-A"), "#COMANDA-A");
  assert.equal(helpers.formatIntegrationPrintOrderId(""), "#-");
});

test("payment print format rende leggibile il nome stanza/tavolo", () => {
  assert.equal(helpers.formatIntegrationPrintDisplayName("SALA GAZEBO 2"), "Sala Gazebo 2");
  assert.equal(helpers.formatIntegrationPrintDisplayName("  bar   esterno "), "Bar Esterno");
});

test("payment print format riconosce metodi che richiedono scontrino pagamento", () => {
  assert.equal(helpers.isElectronicPaymentReceiptMethod("CASH"), true);
  assert.equal(helpers.isElectronicPaymentReceiptMethod("POS"), true);
  assert.equal(helpers.isElectronicPaymentReceiptMethod("OTHER", "pay_card"), true);
  assert.equal(helpers.isElectronicPaymentReceiptMethod("OTHER", "", "Carta cliente"), true);
  assert.equal(helpers.isElectronicPaymentReceiptMethod("ROOM_CHARGE", "room"), false);
});

test("payment print format costruisce etichette ordine mobile da bill e fallback", () => {
  const bills = [
    { id: "bill_1", orderId: "0001" },
    { id: "bill_2", integrationOrderIds: ["0002", "0003"] },
    { id: "bill_3" },
  ];

  assert.equal(helpers.buildMobilePaymentOrderReferenceLabel(bills, ["bill_1"]), "COMANDA #1");
  assert.equal(helpers.buildMobilePaymentOrderReferenceLabel(bills, ["bill_2"]), "COMANDE #2, #3");
  assert.equal(helpers.buildMobilePaymentOrderReferenceLabel(bills, ["bill_3"], "0004"), "COMANDA #4");
  assert.equal(helpers.buildMobilePaymentOrderReferenceLabel([{ id: "bill_only" }], ["bill_only"]), "COMANDA #-");
  assert.equal(helpers.buildMobilePaymentOrderReferenceLabel(bills, []), "COMANDE #1, #2, #3");
});

test("payment print format normalizza note di stampa senza righe vuote", () => {
  assert.equal(helpers.normalizePaymentPrintNote(" prima riga \n\n seconda \r\n terza "), "prima riga\nseconda\nterza");
  assert.equal(helpers.normalizePaymentPrintNote("x".repeat(300)).length, 240);
});

test("payment print format etichetta metodi e azioni di rimborso", () => {
  assert.equal(helpers.formatPaymentMethodPrintLabel("cash"), "CONTANTI");
  assert.equal(helpers.formatPaymentMethodPrintLabel("pos"), "CARTA/POS");
  assert.equal(helpers.formatPaymentMethodPrintLabel("mixed"), "MISTO");
  assert.equal(helpers.formatPaymentMethodPrintLabel("room"), "ALTRO");

  assert.equal(helpers.formatRefundActionPrintLabel("cash_refund"), "RIMBORSO CONTANTI");
  assert.equal(helpers.formatRefundActionPrintLabel("pos_void_full_transaction"), "STORNO TOTALE POS");
  assert.equal(
    helpers.formatRefundActionPrintLabel("pos_void_full_transaction_and_recharge_remaining"),
    "STORNO TOTALE POS + RIADDEBITO"
  );
  assert.equal(helpers.formatRefundActionPrintLabel("custom_action"), "CUSTOM ACTION");
  assert.equal(helpers.formatRefundActionPrintLabel(""), "DA GESTIRE");
});

test("payment print format normalizza riferimenti pagamento per storno", () => {
  assert.deepEqual(
    helpers.normalizeStornoPaymentReferences([
      {
        paymentId: " pay_1 ",
        method: "pos",
        action: "pos_void_full_transaction",
        refundAmount: "7.505",
        voidAmount: "7.50",
        rechargeAmount: "5",
        transactionIds: [" tx_1 ", "tx_1", ""],
        transactions: [{ transactionId: "tx_2" }, { id: "tx_3" }],
        fiscalDocType: "RT",
        fiscalDocNo: "0972-0023",
      },
      { amount: 0, transactions: [] },
    ]),
    [
      {
        paymentId: "pay_1",
        method: "POS",
        action: "pos_void_full_transaction",
        refundAmount: 7.51,
        voidAmount: 7.5,
        rechargeAmount: 5,
        transactionIds: ["tx_1", "tx_2", "tx_3"],
        fiscalDocType: "RT",
        fiscalDocNo: "0972-0023",
      },
    ]
  );
});
