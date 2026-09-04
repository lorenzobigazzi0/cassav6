import { describe, expect, it } from "vitest";
import { buildBackendFreeSplitPaymentPayload } from "../src/api/tables";

const baseSession = {
  token: "token_1",
  userId: "user_1",
  username: "giada",
  deviceUuid: "device_1",
  roomId: "room_pedana",
};

describe("backend free split payment payload", () => {
  it("maps an article cash payment to the backend payment domain", () => {
    const payload = buildBackendFreeSplitPaymentPayload({
      ...baseSession,
      tableId: "room_pedana_t12",
      amount: 1.3,
      paymentMethod: "cash",
      articleUnitIds: [" ord_1_0_0 ", "ord_1_0_0"],
      splitMode: "article",
      cashReceived: 2,
      receiptType: "scontrino",
      note: "quota antipasto",
      clientPaymentId: "pay-test-cash",
    });

    expect(payload).toMatchObject({
      tableId: "room_pedana_t12",
      roomId: "room_pedana",
      splitType: "FREE_SPLIT",
      splitMode: "article",
      articleUnitIds: ["ord_1_0_0"],
      amount: 1.3,
      idempotencyKey: "pay-test-cash",
      clientPaymentId: "pay-test-cash",
      releaseTable: true,
      receiptType: "scontrino",
      issueFiscal: true,
      fiscalDocType: "RECEIPT",
    });
    expect(payload.orderId).toBeUndefined();
    expect(payload.parts[0].transactions[0]).toMatchObject({
      method: "CASH",
      methodId: "pay_cash",
      methodLabel: "Contanti",
      amountPaid: 1.3,
      cashGiven: 2,
      note: "quota antipasto",
    });
  });

  it("marks automatic cash payments without changing the cash method", () => {
    const payload = buildBackendFreeSplitPaymentPayload({
      ...baseSession,
      tableId: "room_pedana_t12",
      amount: 20,
      paymentMethod: "cash",
      cashReceived: 20,
      cashSource: "automatic",
      automaticCashPaymentOperationId: "cashpay_test_1",
      clientPaymentId: "pay-test-auto-cash",
    });

    expect(payload).toMatchObject({
      paymentMethod: "cash",
      paymentSource: "automatic_cash",
      cashSource: "automatic",
      automaticCashPaymentOperationId: "cashpay_test_1",
    });
    expect(payload.parts[0].transactions[0]).toMatchObject({
      method: "CASH",
      paymentSource: "automatic_cash",
      cashSource: "automatic",
      automaticCashPaymentOperationId: "cashpay_test_1",
    });
  });

  it("maps card payments as POS transactions with a mobile POS provider", () => {
    const payload = buildBackendFreeSplitPaymentPayload({
      ...baseSession,
      tableId: "room_pedana_t04",
      orderId: "123456",
      amount: 18.5,
      paymentMethod: "card",
      splitMode: "roman",
      clientPaymentId: "pay-test-card",
    });

    expect(payload).toMatchObject({
      orderId: "123456",
      splitMode: "roman",
      amount: 18.5,
      receiptType: "scontrino",
      fiscalDocType: "RECEIPT",
    });
    expect(payload.parts[0].transactions[0]).toMatchObject({
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      amountPaid: 18.5,
      posProvider: "mobile-pos",
    });
  });

  it("maps non-cash non-card mobile methods to the configured smart payment method", () => {
    const payload = buildBackendFreeSplitPaymentPayload({
      ...baseSession,
      tableId: "room_pedana_t02",
      amount: 9,
      paymentMethod: "voucher",
      splitMode: "amount",
      receiptType: "fattura",
      invoiceRecipient: {
        ragioneSociale: "Dolce Vita SRL",
        piva: "01234567890",
        indirizzo: "Via Roma 10",
        cap: "20100",
        citta: "Milano",
        provincia: "MI",
        pec: "amministrazione@dolcevita.pec.it",
        sdi: "ABC1234",
      },
      clientPaymentId: "pay-test-voucher",
    });

    expect(payload).toMatchObject({
      splitMode: "amount",
      receiptType: "fattura",
      fiscalDocType: "INVOICE",
      issueFiscal: true,
      invoiceRecipient: {
        ragioneSociale: "Dolce Vita SRL",
        piva: "01234567890",
      },
    });
    expect(payload.parts[0].transactions[0]).toMatchObject({
      method: "OTHER",
      methodId: "pay_smart",
      methodLabel: "Buono pasto",
      amountPaid: 9,
    });
  });

  it("passes admin payment adjustments to the backend payload", () => {
    const payload = buildBackendFreeSplitPaymentPayload({
      ...baseSession,
      tableId: "room_pedana_t02",
      amount: 18,
      paymentMethod: "cash",
      splitMode: "article",
      articleUnitIds: ["123456_0_0", "123456_0_1"],
      adminAdjustment: {
        type: "line_price_override",
        reason: "Prezzo concordato",
        originalAmount: 20,
        adjustedAmount: 18,
        discountAmount: 2,
        lineAdjustments: [
          {
            articleUnitId: "123456_0_0",
            orderId: "123456",
            name: "Piatto",
            originalAmount: 10,
            adjustedAmount: 9,
          },
          {
            articleUnitId: "123456_0_1",
            orderId: "123456",
            name: "Piatto",
            originalAmount: 10,
            adjustedAmount: 9,
          },
        ],
      },
      clientPaymentId: "pay-test-admin-adjustment",
    });

    expect(payload).toMatchObject({
      amount: 18,
      splitMode: "article",
      articleUnitIds: ["123456_0_0", "123456_0_1"],
      adminAdjustment: {
        type: "line_price_override",
        reason: "Prezzo concordato",
        originalAmount: 20,
        adjustedAmount: 18,
        discountAmount: 2,
      },
    });
  });

  it("builds a benefit-only payload without fake payment transactions", () => {
    const payload = buildBackendFreeSplitPaymentPayload({
      ...baseSession,
      tableId: "room_pedana_t05",
      orderId: "order_100",
      amount: 0,
      paymentMethod: "cash",
      splitMode: "amount",
      receiptType: "scontrino",
      clientPaymentId: "pay-benefit-only",
      commercialBenefitApplications: [
        {
          applicationId: "cbapp_100",
          benefitAmountCents: 130,
          benefitKind: "percentage_discount",
        },
      ],
    });

    expect(payload).toMatchObject({
      amount: 0,
      issueFiscal: false,
      commercialBenefitApplications: [
        {
          applicationId: "cbapp_100",
          benefitAmountCents: 130,
          benefitKind: "percentage_discount",
        },
      ],
      parts: [
        {
          amountDue: 0,
          transactions: [],
        },
      ],
    });
  });
});
