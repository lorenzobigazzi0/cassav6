import test from "node:test";
import assert from "node:assert/strict";
import { createFiscalReceiptHelpers } from "../modules/payments/fiscal-receipts.domain.js";

const helpers = createFiscalReceiptHelpers({
  normalizeConfigId: (value, fallback = "config") => {
    const raw = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, "_");
    return raw || fallback;
  },
  normalizePosFiscalApiPath: (pathname, fallback = "/api/fiscal/reprint") => {
    const raw = String(pathname ?? "").trim() || fallback;
    return raw.startsWith("/") ? raw : `/${raw}`;
  },
  nowIso: () => "2026-06-05T10:00:00.000Z",
});

test("fiscal receipts normalizza scalari fiscali evitando oggetti serializzati", () => {
  assert.equal(helpers.normalizeFiscalApiScalar(" MF000050 "), "MF000050");
  assert.equal(helpers.normalizeFiscalApiScalar(23), "23");
  assert.equal(helpers.normalizeFiscalApiScalar(123n), "123");
  assert.equal(helpers.normalizeFiscalApiScalar("[object Object]"), "");
  assert.equal(helpers.normalizeFiscalApiScalar({ value: "x" }), "");
});

test("fiscal receipts prende il primo scalare fiscale valido", () => {
  assert.equal(helpers.firstFiscalApiScalar(null, "", "[object Object]", "0972-0023"), "0972-0023");
  assert.equal(helpers.firstFiscalApiScalar(null, {}, ""), "");
});

test("fiscal receipts sanitizza un receipt fiscale completo", () => {
  assert.deepEqual(
    helpers.sanitizeFiscalReceipt(
      {
        id: "fiscal_1",
        paymentId: 123,
        command: "print_receipt",
        status: "ok",
        responseCode: "OK",
        responseMessage: "Emesso",
        fiscalStatus: "issued",
        fiscalProvider: " pos-api ",
        fiscalDeviceId: " RT Bar 1 ",
        fiscalApiBaseUrl: "http://192.168.1.200:8765///",
        fiscalStatusEndpoint: "api/fiscal/status",
        fiscalVerifyEndpoint: "api/fiscal/receipt/verify",
        fiscalReceiptEndpoint: "/api//fiscal/receipt",
        fiscalReprintEndpoint: "/api/fiscal/reprint",
        fiscalVoidEndpoint: "api/fiscal/void",
        fiscalProviderRef: "ref_1",
        movementId: "MF000050",
        receiptDate: "2026-05-29",
        documentNumber: 23,
        fiscalRequestId: "req_1",
        idempotencyKey: "idem_1",
        payloadSnapshot: { paymentId: "pay_1", items: [{ name: "Caffe", price: "1.00", quantity: "1" }] },
        payloadHash: "hash_1",
        attemptCount: 2,
        lastAttemptAt: "2026-06-05T10:01:00.000Z",
        nextRetryAt: "2026-06-05T10:02:00.000Z",
        retryCutoffAt: "2026-06-06T05:00:00.000Z",
        manualRetryStartedAt: "2026-06-05T10:00:30.000Z",
        voidStatus: "FAILED",
        voidRequestId: "void_1",
        voidRequestedAt: "2026-06-05T10:03:00.000Z",
        voidedAt: null,
        voidedByUserId: "admin_1",
        voidedByUsername: "lorenzo",
        voidReason: "Rettifica documento",
        voidProviderRef: "void_ref_1",
        voidMovementId: "MFVOID0001",
        voidReceiptDate: "2026-06-05",
        voidDocumentNumber: "0042",
        voidError: "gateway non disponibile",
        fiscalError: "x".repeat(300),
        requiresFiscalRetry: true,
      },
      "fallback"
    ),
    {
      id: "fiscal_1",
      paymentId: "123",
      command: "print_receipt",
      status: "ok",
      responseCode: "OK",
      responseMessage: "Emesso",
      fiscalStatus: "ISSUED",
      fiscalProvider: "pos-api",
      fiscalDeviceId: "rt_bar_1",
      fiscalApiBaseUrl: "http://192.168.1.200:8765",
      fiscalStatusEndpoint: "/api/fiscal/status",
      fiscalVerifyEndpoint: "/api/fiscal/receipt/verify",
      fiscalReceiptEndpoint: "/api//fiscal/receipt",
      fiscalReprintEndpoint: "/api/fiscal/reprint",
      fiscalVoidEndpoint: "/api/fiscal/void",
      fiscalProviderRef: "ref_1",
      fiscalMovementId: "MF000050",
      fiscalReceiptDate: "2026-05-29",
      fiscalDocumentNumber: "23",
      fiscalError: "x".repeat(240),
      requiresFiscalRetry: true,
      fiscalRequestId: "req_1",
      idempotencyKey: "idem_1",
      payloadSnapshot: { paymentId: "pay_1", items: [{ name: "Caffe", price: "1.00", quantity: "1" }] },
      payloadHash: "hash_1",
      attemptCount: 2,
      lastAttemptAt: "2026-06-05T10:01:00.000Z",
      nextRetryAt: "2026-06-05T10:02:00.000Z",
      retryCutoffAt: "2026-06-06T05:00:00.000Z",
      manualRetryStartedAt: "2026-06-05T10:00:30.000Z",
      voidStatus: "FAILED",
      voidRequestId: "void_1",
      voidRequestedAt: "2026-06-05T10:03:00.000Z",
      voidedAt: null,
      voidedByUserId: "admin_1",
      voidedByUsername: "lorenzo",
      voidReason: "Rettifica documento",
      voidProviderRef: "void_ref_1",
      voidMovementId: "MFVOID0001",
      voidReceiptDate: "2026-06-05",
      voidDocumentNumber: "0042",
      voidError: "gateway non disponibile",
      createdAt: "2026-06-05T10:00:00.000Z",
    }
  );
});

test("fiscal receipts applica fallback compatibili e scarta input invalidi", () => {
  assert.equal(helpers.sanitizeFiscalReceipt(null, "fallback"), null);
  assert.deepEqual(helpers.sanitizeFiscalReceipt({}, "fallback"), {
    id: "fallback",
    paymentId: null,
    command: "print_receipt",
    status: "UNKNOWN",
    responseCode: "UNKNOWN",
    responseMessage: "Stato fiscale non verificato.",
    fiscalStatus: "UNKNOWN",
    fiscalProvider: null,
    fiscalDeviceId: null,
    fiscalApiBaseUrl: null,
    fiscalStatusEndpoint: null,
    fiscalVerifyEndpoint: null,
    fiscalReceiptEndpoint: null,
    fiscalReprintEndpoint: null,
    fiscalVoidEndpoint: null,
    fiscalProviderRef: null,
    fiscalMovementId: null,
    fiscalReceiptDate: null,
    fiscalDocumentNumber: null,
    fiscalError: null,
    requiresFiscalRetry: false,
    fiscalRequestId: null,
    idempotencyKey: null,
    payloadSnapshot: null,
    payloadHash: null,
    attemptCount: 0,
    lastAttemptAt: null,
    nextRetryAt: null,
    retryCutoffAt: null,
    manualRetryStartedAt: null,
    voidStatus: null,
    voidRequestId: null,
    voidRequestedAt: null,
    voidedAt: null,
    voidedByUserId: null,
    voidedByUsername: null,
    voidReason: null,
    voidProviderRef: null,
    voidMovementId: null,
    voidReceiptDate: null,
    voidDocumentNumber: null,
    voidError: null,
    createdAt: "2026-06-05T10:00:00.000Z",
  });
});
