import { describe, expect, it } from "vitest";
import {
  isValidInvoiceVat,
  normalizeInvoiceDraft,
  validateInvoiceData,
} from "../src/pages/home/tables/payment/paymentInvoice";

describe("payment invoice helpers", () => {
  it("normalizes invoice fields without depending on UI state", () => {
    expect(
      normalizeInvoiceDraft({
        ragioneSociale: "  Dolce Vita SRL  ",
        piva: "IT-01234567890",
        indirizzo: " Via Roma 10 ",
        cap: "20100 Milano",
        citta: " Milano ",
        provincia: "mi1",
        pec: " amministrazione@dolcevita.pec.it ",
        sdi: "abc1234-extra",
      })
    ).toEqual({
      ragioneSociale: "Dolce Vita SRL",
      piva: "01234567890",
      indirizzo: "Via Roma 10",
      cap: "20100",
      citta: "Milano",
      provincia: "MI",
      pec: "amministrazione@dolcevita.pec.it",
      sdi: "ABC1234",
    });
  });

  it("validates normalized invoice recipient data", () => {
    const validDraft = normalizeInvoiceDraft({
      ragioneSociale: "Dolce Vita SRL",
      piva: "01234567890",
      indirizzo: "Via Roma 10",
      cap: "20100",
      citta: "Milano",
      provincia: "MI",
      pec: "amministrazione@dolcevita.pec.it",
      sdi: "ABC1234",
    });

    expect(isValidInvoiceVat(validDraft.piva)).toBe(true);
    expect(validateInvoiceData(validDraft)).toEqual({});
  });
});
