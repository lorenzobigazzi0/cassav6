import { describe, expect, it } from "vitest";
import {
  analyticsPaymentMethodKind,
  buildAnalyticsMovementRecordsFromReport,
  buildLocalAnalyticsMovementRecords,
  isAnalyticsMovementVisibleForUser,
  normalizeAnalyticsFiscalReceipt,
} from "../src/api/analyticsPaymentMovementModel";
import type { AnalyticsTransactionRecord } from "../src/utils/analyticsTransactions";

describe("analytics payment movement model", () => {
  it.each([
    ["cash", "Contanti", "cash"],
    ["card", "Carta", "card"],
    ["satispay", "Satispay", "satispay"],
    ["voucher", "Buono pasto", "voucher"],
    ["suspended", "Conto sospeso", "suspended"],
    ["check", "Assegno", "check"],
    ["wire", "Bonifico", "wire"],
    ["cash, card", "Contanti + Carta", "other"],
    ["custom", "Altro", "other"],
  ])("classifica il metodo %s nel pill %s", (method, methodLabel, expected) => {
    expect(analyticsPaymentMethodKind({ method, methodLabel })).toBe(expected);
  });

  it("mantiene la cronologia fra login e device e applica solo il cutoff di scarico", () => {
    const record = {
      id: "payment:pay_1",
      type: "payment" as const,
      typeLabel: "Pagamento",
      paymentId: "pay_1",
      amount: 25,
      method: "cash",
      methodLabel: "Contanti",
      createdAt: Date.parse("2026-09-10T08:00:00Z"),
      operatorId: "user_1",
      operatorName: "Giada Imperato",
      transactionIds: [],
      orderIds: [],
      orderReference: "",
      note: "",
      raw: {},
    };

    expect(
      isAnalyticsMovementVisibleForUser(record, {
        userId: "user_1",
        userName: "Giada Imperato",
        settlementCutoffAt: 0,
      })
    ).toBe(true);
    expect(
      isAnalyticsMovementVisibleForUser(record, {
        userId: "user_1",
        userName: "Giada Imperato",
        settlementCutoffAt: Date.parse("2026-09-10T09:00:00Z"),
      })
    ).toBe(false);
    expect(
      isAnalyticsMovementVisibleForUser(record, {
        userId: "user_2",
        userName: "Altro operatore",
        settlementCutoffAt: 0,
      })
    ).toBe(false);
  });

  it("converte solo i pagamenti locali e li ordina senza mutare la sorgente", () => {
    const records: AnalyticsTransactionRecord[] = [
      {
        id: "payment_old",
        createdAt: 100,
        kind: "payment",
        amount: 12.345,
        paymentMethod: "cash",
        orderId: "order_1",
        description: "  saldo   tavolo  ",
      },
      { id: "consumption", createdAt: 300, kind: "consumption", amount: 99 },
      {
        id: "payment_new",
        createdAt: 200,
        kind: "payment",
        amount: 8,
        paymentMethod: "card",
      },
    ];
    const snapshot = structuredClone(records);

    const movements = buildLocalAnalyticsMovementRecords(records);

    expect(movements.map((movement) => movement.id)).toEqual([
      "local:payment_new",
      "local:payment_old",
    ]);
    expect(movements[1]).toMatchObject({
      amount: 12.35,
      methodLabel: "Contanti",
      // `description` e un'etichetta di tipo e il record del server non la
      // riporta: mappandola su `note` la riga compariva e spariva al primo
      // aggiornamento. Deve restare vuota.
      note: "",
      orderReference: "#order_1",
    });
    expect(records).toEqual(snapshot);
  });

  it("costruisce il pagamento dal report e associa la ricevuta fiscale restituita", () => {
    const movements = buildAnalyticsMovementRecordsFromReport({
      paymentsTracking: {
        containers: [
          {
            id: "payment_1",
            status: "COMPLETED",
            amount: "10.556",
            createdAt: "2026-07-15T10:00:00.000Z",
            orderIds: ["order_1"],
            articleUnitIds: ["order_1_0_0"],
          },
          { id: "pending", status: "PENDING", amount: 50 },
        ],
        parts: [{ id: "part_1", paymentId: "payment_1" }],
        transactions: [
          {
            id: "tx_1",
            partId: "part_1",
            method: "card",
            amountPaid: 10.556,
          },
        ],
        fiscalReceipts: [
          {
            id: "receipt_1",
            paymentId: "tx_1",
            fiscalStatus: "ISSUED",
            fiscalDocumentNumber: "DOC-42",
          },
        ],
      },
      ordersTracking: {
        orders: [
          {
            id: "order_1",
            lineItems: [{ lineId: "line_1", productName: "Pizza", qty: 1 }],
          },
        ],
      },
    });

    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      id: "payment:payment_1",
      amount: 10.56,
      method: "card",
      methodLabel: "Carta",
      transactionIds: ["tx_1"],
      fiscalDocNo: "DOC-42",
      fiscalDocType: "RECEIPT",
      articleReference: ["Pizza - riga line_1 - unita order_1_0_0"],
      raw: { fiscalReceiptId: "receipt_1", fiscalStatus: "ISSUED" },
    });
  });

  it("normalizza in modo deterministico la ricevuta fiscale", () => {
    expect(
      normalizeAnalyticsFiscalReceipt({
        id: " receipt_1 ",
        paymentId: 42,
        status: " issued ",
        voidStatus: " voided ",
        fiscalDocumentNumber: null,
      })
    ).toEqual({
      id: "receipt_1",
      paymentId: "42",
      fiscalStatus: "ISSUED",
      fiscalProviderRef: "",
      fiscalMovementId: "",
      fiscalReceiptDate: "",
      fiscalDocumentNumber: "",
      fiscalError: "",
      voidStatus: "VOIDED",
      voidedAt: "",
      voidProviderRef: "",
      voidMovementId: "",
      voidReceiptDate: "",
      voidDocumentNumber: "",
      voidError: "",
    });
  });
});
