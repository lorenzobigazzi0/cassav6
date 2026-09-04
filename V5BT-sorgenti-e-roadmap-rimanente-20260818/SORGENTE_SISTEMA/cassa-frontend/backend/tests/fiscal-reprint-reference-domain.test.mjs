import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFiscalReprintJobKey,
  findFiscalReferencePatchFromEvents,
  findReprintableFiscalReceipts,
  isFiscalReceiptVoided,
  resolveFiscalReprintTarget,
} from "../modules/payments/fiscal-reprint-reference.domain.js";

test("ristampa fiscale usa il movimento del documento originale", () => {
  assert.deepEqual(
    resolveFiscalReprintTarget({
      fiscalStatus: "ISSUED",
      fiscalProviderRef: "0972-0023",
      fiscalMovementId: "MF000050",
      fiscalReceiptDate: "2026-05-29",
      fiscalDocumentNumber: "0023",
    }),
    {
      documentKind: "receipt",
      request: { movementId: "MF000050" },
      providerRef: "0972-0023",
      movementId: "MF000050",
      receiptDate: "2026-05-29",
      documentNumber: "0023",
    },
  );
});

test("documento annullato usa soltanto i riferimenti dell'annullamento", () => {
  const receipt = {
    fiscalStatus: "VOIDED",
    fiscalProviderRef: "0972-0023",
    fiscalMovementId: "MF000050",
    fiscalReceiptDate: "2026-05-29",
    fiscalDocumentNumber: "0023",
    voidProviderRef: "VOID-9001",
    voidMovementId: "MFVOID0001",
    voidReceiptDate: "2026-07-17",
    voidDocumentNumber: "9001",
  };

  assert.equal(isFiscalReceiptVoided(receipt), true);
  assert.deepEqual(resolveFiscalReprintTarget(receipt), {
    documentKind: "void",
    request: { movementId: "MFVOID0001" },
    providerRef: "VOID-9001",
    movementId: "MFVOID0001",
    receiptDate: "2026-07-17",
    documentNumber: "9001",
  });
});

test("documento annullato senza riferimenti di annullamento non ricade sull'originale", () => {
  assert.equal(
    resolveFiscalReprintTarget({
      fiscalStatus: "VOIDED",
      fiscalProviderRef: "0972-0023",
      fiscalMovementId: "MF000050",
      fiscalReceiptDate: "2026-05-29",
      fiscalDocumentNumber: "0023",
    }),
    null,
  );
});

test("ristampa usa data e numero quando il movimento non e disponibile", () => {
  assert.deepEqual(
    resolveFiscalReprintTarget({
      fiscalStatus: "ISSUED",
      fiscalProviderRef: "0972-0023",
      fiscalReceiptDate: "2026-05-29T14:00:00.000Z",
    }),
    {
      documentKind: "receipt",
      request: {
        receiptDate: "2026-05-29",
        documentNumber: "0023",
      },
      providerRef: "0972-0023",
      movementId: null,
      receiptDate: "2026-05-29",
      documentNumber: "0023",
    },
  );
});

test("selezione e recovery distinguono ricevuta originale e annullamento", () => {
  const db = {
    fiscalReceipts: [
      {
        id: "fiscal_1",
        paymentId: "payment_1",
        fiscalProvider: "pos-api",
        fiscalStatus: "VOIDED",
        voidStatus: "VOIDED",
      },
      {
        id: "fiscal_2",
        paymentId: "payment_2",
        fiscalProvider: "altro-provider",
        fiscalStatus: "ISSUED",
      },
    ],
    fiscalEvents: [
      {
        provider: "pos-api",
        paymentId: "payment_1",
        command: "pos_receipt",
        result: "issued",
        payload: { response: { movementId: "MF000050" } },
      },
      {
        provider: "pos-api",
        paymentId: "payment_1",
        command: "pos_receipt_void",
        result: "voided",
        payload: { response: { movementId: "MFVOID0001" } },
      },
    ],
  };
  const receipts = findReprintableFiscalReceipts(
    db,
    ["payment_1", "payment_2"],
    {
      provider: "pos-api",
      sanitizeFiscalReceipt: (receipt) => receipt,
    },
  );
  assert.deepEqual(receipts.map((receipt) => receipt.id), ["fiscal_1"]);

  const extractReferences = (response) => ({
    fiscalProviderRef: response.movementId,
    fiscalMovementId: response.movementId,
    fiscalReceiptDate: null,
    fiscalDocumentNumber: null,
  });
  assert.deepEqual(
    findFiscalReferencePatchFromEvents(db, "payment_1", "fiscal_1", {
      documentKind: "receipt",
      extractReferences,
      provider: "pos-api",
    }),
    {
      fiscalProviderRef: "MF000050",
      fiscalMovementId: "MF000050",
      fiscalReceiptDate: null,
      fiscalDocumentNumber: null,
    },
  );
  assert.deepEqual(
    findFiscalReferencePatchFromEvents(db, "payment_1", "fiscal_1", {
      documentKind: "void",
      extractReferences,
      provider: "pos-api",
    }),
    {
      voidProviderRef: "MFVOID0001",
      voidMovementId: "MFVOID0001",
      voidReceiptDate: null,
      voidDocumentNumber: null,
    },
  );
  assert.equal(
    buildFiscalReprintJobKey({
      paymentId: "payment_1",
      receiptId: "fiscal_1",
      documentKind: "void",
    }),
    "payment_1:fiscal_1:void",
  );
});
