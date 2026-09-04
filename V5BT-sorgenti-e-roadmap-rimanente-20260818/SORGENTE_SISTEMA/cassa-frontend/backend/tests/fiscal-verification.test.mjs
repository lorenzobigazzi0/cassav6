import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_POS_FISCAL_VERIFY_ENDPOINT,
  buildFiscalReceiptPatchFromVerification,
  buildPosFiscalVerificationRequest,
  normalizePosFiscalVerificationResponse,
  requestPosFiscalVerification,
} from "../modules/fiscal-pos/fiscal-verification.js";
import { createPosFiscalIssueVerificationService } from "../modules/fiscal-pos/fiscal-issue-verification.service.js";

test("costruisce una richiesta di verifica fiscale stabile e senza endpoint client-controlled", () => {
  assert.deepEqual(
    buildPosFiscalVerificationRequest({
      operation: "void",
      paymentId: "tx_1",
      receiptId: "receipt_1",
      idempotencyKey: "fiscal_void_receipt_1",
      fiscalRequestId: "fiscal_issue_tx_1",
      payloadHash: "sha256_1",
      originalDocument: {
        fiscalProviderRef: "REF-1",
        fiscalMovementId: "MOV-1",
        fiscalReceiptDate: "2026-07-17",
        fiscalDocumentNumber: "0042",
      },
    }),
    {
      schemaVersion: 1,
      operation: "void",
      idempotencyKey: "fiscal_void_receipt_1",
      fiscalRequestId: "fiscal_issue_tx_1",
      paymentId: "tx_1",
      receiptId: "receipt_1",
      payloadHash: "sha256_1",
      originalDocument: {
        providerRef: "REF-1",
        movementId: "MOV-1",
        receiptDate: "2026-07-17",
        documentNumber: "0042",
      },
    },
  );
  assert.throws(
    () => buildPosFiscalVerificationRequest({ paymentId: "tx_1" }),
    /Idempotency key fiscale mancante/,
  );
});

test("accetta solo una risposta autorevole e coerente con chiave e operazione", () => {
  const verification = normalizePosFiscalVerificationResponse(
    {
      ok: true,
      authoritative: true,
      operation: "issue",
      idempotencyKey: "pos_fiscal_tx_1",
      found: true,
      state: "issued",
      completedAt: "2026-07-17T10:00:00.000Z",
      document: {
        providerRef: "REF-1",
        movementId: "MOV-1",
        receiptDate: "2026-07-17",
        documentNumber: "0042",
      },
    },
    { operation: "issue", idempotencyKey: "pos_fiscal_tx_1" },
  );

  assert.equal(verification.state, "ISSUED");
  assert.equal(verification.canWrite, false);
  assert.equal(verification.document.documentNumber, "0042");
  assert.throws(
    () =>
      normalizePosFiscalVerificationResponse(
        { ok: true, operation: "issue", state: "NOT_FOUND" },
        { operation: "issue", idempotencyKey: "pos_fiscal_tx_1" },
      ),
    /non ha restituito una verifica autorevole/,
  );
  assert.throws(
    () =>
      normalizePosFiscalVerificationResponse(
        {
          ok: true,
          authoritative: true,
          operation: "void",
          idempotencyKey: "other",
          state: "VOIDED",
        },
        { operation: "issue", idempotencyKey: "pos_fiscal_tx_1" },
      ),
    /operazione diversa/,
  );
});

test("NOT_FOUND autorevole consente la scrittura, PROCESSING no", () => {
  const notFound = normalizePosFiscalVerificationResponse(
    {
      ok: true,
      authoritative: true,
      operation: "issue",
      idempotencyKey: "pos_fiscal_tx_2",
      found: false,
      state: "NOT_FOUND",
    },
    { operation: "issue", idempotencyKey: "pos_fiscal_tx_2" },
  );
  const processing = normalizePosFiscalVerificationResponse(
    {
      ok: true,
      authoritative: true,
      operation: "issue",
      idempotencyKey: "pos_fiscal_tx_2",
      found: true,
      state: "PROCESSING",
    },
    { operation: "issue", idempotencyKey: "pos_fiscal_tx_2" },
  );

  assert.equal(notFound.canWrite, true);
  assert.equal(processing.canWrite, false);
});

test("riconcilia emissione e annullamento mantenendo riferimenti distinti", () => {
  const issuePatch = buildFiscalReceiptPatchFromVerification({
    authoritative: true,
    operation: "issue",
    state: "ISSUED",
    document: {
      providerRef: "REF-ISSUE",
      movementId: "MOV-ISSUE",
      receiptDate: "2026-07-17",
      documentNumber: "0100",
    },
  });
  const voidPatch = buildFiscalReceiptPatchFromVerification(
    {
      authoritative: true,
      operation: "void",
      state: "VOIDED",
      completedAt: "2026-07-17T11:00:00.000Z",
      document: {
        providerRef: "REF-VOID",
        movementId: "MOV-VOID",
        receiptDate: "2026-07-17",
        documentNumber: "9100",
      },
    },
    { nowIso: () => "fallback" },
  );

  assert.equal(issuePatch.fiscalStatus, "ISSUED");
  assert.equal(issuePatch.fiscalDocumentNumber, "0100");
  assert.equal(voidPatch.fiscalStatus, "VOIDED");
  assert.equal(voidPatch.voidDocumentNumber, "9100");
  assert.equal(voidPatch.voidedAt, "2026-07-17T11:00:00.000Z");
});

test("usa il path standard e distingue endpoint assente da NOT_FOUND autorevole", async () => {
  const calls = [];
  const result = await requestPosFiscalVerification({
    fetchJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        authoritative: true,
        operation: "issue",
        idempotencyKey: "pos_fiscal_tx_3",
        found: false,
        state: "NOT_FOUND",
      };
    },
    fiscalDevice: {
      id: "rt_1",
      apiBaseUrl: "http://127.0.0.1:9000",
    },
    operation: "issue",
    paymentId: "tx_3",
    idempotencyKey: "pos_fiscal_tx_3",
  });

  assert.equal(calls[0].pathname, DEFAULT_POS_FISCAL_VERIFY_ENDPOINT);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(result.supported, true);
  assert.equal(result.state, "NOT_FOUND");

  const missing = await requestPosFiscalVerification({
    fetchJson: async () => {
      const error = new Error("not found");
      error.status = 404;
      throw error;
    },
    fiscalDevice: {
      id: "rt_1",
      apiBaseUrl: "http://127.0.0.1:9000",
    },
    operation: "issue",
    paymentId: "tx_3",
    idempotencyKey: "pos_fiscal_tx_3",
  });
  assert.equal(missing.supported, false);
  assert.equal(missing.reason, "verify_endpoint_not_found");
});

function buildIssueVerificationService(fetchJson) {
  const db = {
    meta: {},
    fiscalReceipts: [
      {
        id: "receipt_1",
        paymentId: "tx_1",
        fiscalStatus: "PROCESSING",
      },
    ],
    fiscalEvents: [],
  };
  let linked = 0;
  const service = createPosFiscalIssueVerificationService({
    appendEvent: (target, event) => target.fiscalEvents.push(event),
    buildRetryResult: (job) => ({ retry: true, job, delayMs: 10 }),
    ensureFiscalTrackingArrays: () => {},
    errorMessage: (error) => error.message,
    fetchJson,
    linkReceipt: () => {
      linked += 1;
    },
    logger: { error() {}, warn() {} },
    nowIso: () => "2026-07-17T12:00:00.000Z",
    publishRefresh: () => {},
    readDb: async () => db,
    retryDelayMs: 10,
    updateReceipt: (target, paymentId, patch) => {
      const receipt = target.fiscalReceipts.find(
        (entry) => entry.paymentId === paymentId,
      );
      Object.assign(receipt, patch);
      return receipt;
    },
    withDbMutation: async (_key, mutation) => mutation(),
    writeFiscalDb: async () => {},
  });
  return { db, service, linked: () => linked };
}

test("un documento gia emesso viene riconciliato senza autorizzare una seconda scrittura", async () => {
  const { db, service, linked } = buildIssueVerificationService(async () => ({
    ok: true,
    authoritative: true,
    operation: "issue",
    idempotencyKey: "pos_fiscal_tx_1",
    state: "ISSUED",
    found: true,
    document: {
      providerRef: "REF-1",
      documentNumber: "0042",
    },
  }));
  const result = await service.verifyBeforeWrite({
    job: {
      paymentId: "tx_1",
      paymentContainerId: "payment_1",
      idempotencyKey: "pos_fiscal_tx_1",
    },
    fiscalDevice: {
      id: "rt_1",
      apiBaseUrl: "http://127.0.0.1:9000",
    },
    receipt: {
      id: "receipt_1",
      paymentId: "tx_1",
      attemptCount: 2,
    },
    attempt: 2,
  });

  assert.equal(result.handled, true);
  assert.equal(result.result.issued, true);
  assert.equal(result.result.reconciled, true);
  assert.equal(db.fiscalReceipts[0].fiscalStatus, "ISSUED");
  assert.equal(db.fiscalReceipts[0].fiscalDocumentNumber, "0042");
  assert.equal(linked(), 1);
});

test("un gateway legacy consente il primo invio ma blocca ogni retry incerto", async () => {
  const missingEndpoint = async () => {
    const error = new Error("not found");
    error.status = 404;
    throw error;
  };
  const first = buildIssueVerificationService(missingEndpoint);
  const firstResult = await first.service.verifyBeforeWrite({
    job: {
      paymentId: "tx_1",
      idempotencyKey: "pos_fiscal_tx_1",
    },
    fiscalDevice: {
      id: "rt_1",
      apiBaseUrl: "http://127.0.0.1:9000",
    },
    receipt: { id: "receipt_1", attemptCount: 1 },
    attempt: 1,
  });
  assert.equal(firstResult.handled, false);

  const retry = buildIssueVerificationService(missingEndpoint);
  const retryResult = await retry.service.verifyBeforeWrite({
    job: {
      paymentId: "tx_1",
      idempotencyKey: "pos_fiscal_tx_1",
    },
    fiscalDevice: {
      id: "rt_1",
      apiBaseUrl: "http://127.0.0.1:9000",
    },
    receipt: { id: "receipt_1", attemptCount: 2 },
    attempt: 2,
  });
  assert.equal(retryResult.handled, true);
  assert.equal(retryResult.result.retry, true);
  assert.equal(retry.db.fiscalReceipts[0].fiscalStatus, "FAILED");
});
