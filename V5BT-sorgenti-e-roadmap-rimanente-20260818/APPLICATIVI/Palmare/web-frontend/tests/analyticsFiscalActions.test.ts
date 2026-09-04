import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/api/baseUrl";
import {
  applyFiscalReceiptToAnalyticsMovement,
  fetchAnalyticsPaymentMovements,
  issueAnalyticsFiscalMovement,
  issueAnalyticsFiscalPaymentById,
  type AnalyticsMovementRecord,
  type AnalyticsSessionContext,
  voidAnalyticsFiscalMovement,
} from "../src/api/analyticsPaymentMovements";
import {
  buildAnalyticsAdvancedPrintDetails,
  fiscalOutcomeLabel,
} from "../src/pages/home/analytics/paymentDetailLines";

vi.mock("../src/api/baseUrl", () => ({ apiFetch: vi.fn() }));

const session: AnalyticsSessionContext = {
  token: "token",
  userId: "user_admin",
  username: "admin",
  fullName: "Admin",
  deviceUuid: "device_1",
  sessionStartedAt: 0,
  settlementCutoffAt: 0,
};

const movement = (): AnalyticsMovementRecord => ({
  id: "movement_1",
  type: "payment",
  typeLabel: "Pagamento",
  amount: 12,
  createdAt: 1,
  operatorId: "user_admin",
  operatorName: "Admin",
  method: "cash",
  methodLabel: "Contanti",
  paymentSource: "table",
  cashSource: "wallet",
  automaticCashPaymentOperationId: "",
  tableId: "table_1",
  tableNumber: 1,
  tableLabel: "1",
  roomId: "room_1",
  note: "",
  orderIds: ["order_1"],
  orderReference: "#order_1",
  paymentId: "payment_1",
  transactionIds: ["tx_1"],
  transactions: [],
  splitMode: "single",
  articleUnitIds: [],
  articleReference: "",
  fiscalDocNo: "",
  fiscalDocType: "",
  tableCancellationId: "",
  tableCancelledAt: "",
  tableCancelledByUserId: "",
  tableCancelledByUsername: "",
  tableCancellationReason: "",
  adjustmentKind: "",
  originalPaymentId: "",
  supersedesPaymentId: "",
  supersededByPaymentId: "",
  productName: "",
  lineId: "",
  rechargePaymentIds: [],
  rechargeTransactionIds: [],
  raw: { fiscalStatus: "FAILED" },
});

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe("analytics fiscal actions", () => {
  it("inoltra l'emissione al vero endpoint backend e usa soltanto la ricevuta restituita", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        receipt: {
          id: "fiscal_1",
          paymentId: "tx_1",
          fiscalStatus: "ISSUED",
          fiscalDocumentNumber: "Z1005-0123",
          fiscalProviderRef: "provider_123",
        },
      }),
    } as Response);

    const receipt = await issueAnalyticsFiscalMovement(session, movement());
    const [path, request] = vi.mocked(apiFetch).mock.calls[0] ?? [];
    expect(path).toBe("/api/reports/payment-movement/fiscal/issue");
    expect(request?.method).toBe("POST");
    expect(request?.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer token",
      "Content-Type": "application/json",
      "X-Device-Uuid": "device_1",
      "X-User-Id": "user_admin",
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      token: "token",
      movementId: "payment_1",
      userId: "user_admin",
      username: "admin",
      deviceUuid: "device_1",
      clientApp: "mobile-frontend",
      receiptId: "",
    });
    expect(receipt.fiscalStatus).toBe("ISSUED");
    expect(receipt.fiscalDocumentNumber).toBe("Z1005-0123");
  });

  it("non produce un falso OK quando il backend fiscale rifiuta la richiesta", async () => {
    const record = movement();
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, message: "Gateway fiscale non raggiungibile" }),
    } as Response);

    await expect(issueAnalyticsFiscalMovement(session, record)).rejects.toThrow(
      "Gateway fiscale non raggiungibile"
    );
    expect(fiscalOutcomeLabel(record)).toBe("KO");
    expect(record.fiscalDocNo).toBe("");
  });

  it("riusa la stessa identità della coda durante una forzatura esplicita", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        receipt: {
          id: "fiscal_2",
          paymentId: "tx_1",
          fiscalStatus: "ISSUED",
        },
      }),
    } as Response);

    await issueAnalyticsFiscalPaymentById(session, "payment_1", {
      requestId: "request_1",
      idempotencyKey: "idempotency_1",
    });

    const [, request] = vi.mocked(apiFetch).mock.calls[0] ?? [];
    expect(request?.headers).toMatchObject({
      "X-Command-Request-Id": "request_1",
      "X-Idempotency-Key": "idempotency_1",
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      token: "token",
      movementId: "payment_1",
      userId: "user_admin",
      username: "admin",
      deviceUuid: "device_1",
      clientApp: "mobile-frontend",
      receiptId: "",
      requestId: "request_1",
      idempotencyKey: "idempotency_1",
    });
  });

  it("mantiene invariato il payload fiscale di annullamento", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        receipt: { id: "fiscal_1", fiscalStatus: "VOIDED" },
      }),
    } as Response);
    const record = movement();
    record.raw = { ...record.raw, fiscalReceiptId: "receipt_1" };

    await voidAnalyticsFiscalMovement(session, record);

    const [path, request] = vi.mocked(apiFetch).mock.calls[0] ?? [];
    expect(path).toBe("/api/reports/payment-movement/fiscal/void");
    expect(JSON.parse(String(request?.body))).toEqual({
      token: "token",
      userId: "user_admin",
      username: "admin",
      deviceUuid: "device_1",
      clientApp: "mobile-frontend",
      movementId: "payment_1",
      receiptId: "receipt_1",
      reason: "Annullamento da dettaglio pagamento",
    });
  });

  it("rifiuta una verifica fiscale servita dalla cache offline", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name === "X-Palmare-Offline-Cache" ? "1" : null),
      },
      json: async () => ({ ok: true, report: {} }),
    } as Response);

    await expect(
      fetchAnalyticsPaymentMovements(session, undefined, { requireLive: true })
    ).rejects.toThrow("Verifica live non disponibile");
  });

  it("visualizza ANNULLATO solo dopo la ricevuta VOIDED restituita dal backend", () => {
    const updated = applyFiscalReceiptToAnalyticsMovement(movement(), {
      id: "fiscal_1",
      paymentId: "tx_1",
      fiscalStatus: "VOIDED",
      fiscalProviderRef: "provider_123",
      fiscalMovementId: "movement_fiscal_1",
      fiscalReceiptDate: "2026-07-15T10:00:00.000Z",
      fiscalDocumentNumber: "Z1005-0123",
      fiscalError: "",
      voidStatus: "VOIDED",
      voidedAt: "2026-07-15T10:05:00.000Z",
      voidProviderRef: "VOID-0042",
      voidMovementId: "MFVOID0042",
      voidReceiptDate: "2026-07-15",
      voidDocumentNumber: "0042",
      voidError: "",
    });

    expect(fiscalOutcomeLabel(updated)).toBe("ANNULLATO");
    expect(updated.raw?.voidStatus).toBe("VOIDED");
    expect(updated.fiscalDocNo).toBe("Z1005-0123");
    const advancedDetails = buildAnalyticsAdvancedPrintDetails(updated, "15/07/2026, 12:00");
    expect(advancedDetails).toContainEqual({
      label: "Documento fiscale originale",
      value: "RECEIPT Z1005-0123",
    });
    expect(advancedDetails).toContainEqual({
      label: "Documento di annullamento",
      value: "0042",
    });
  });
});
