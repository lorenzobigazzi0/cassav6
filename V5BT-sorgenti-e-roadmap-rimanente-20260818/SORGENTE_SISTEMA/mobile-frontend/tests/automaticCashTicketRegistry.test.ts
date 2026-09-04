import { beforeEach, describe, expect, it } from "vitest";
import {
  buildAutomaticCashFloatTicketText,
  type CashFloatTicketRecord,
} from "../src/pages/payments/cashFloatTicket";
import {
  normalizeAutomaticCashTicketRecord,
  readAutomaticCashTicketRecords,
  saveAutomaticCashTicketRecord,
  updateAutomaticCashTicketRecordStatus,
} from "../src/utils/automaticCashTicketRegistry";

const makeRecord = (overrides: Partial<CashFloatTicketRecord> = {}): CashFloatTicketRecord => ({
  cashFloatId: "FCA-1",
  assignmentId: "ASN-1",
  combinationId: "COMBO-1",
  businessEveningKey: "2026-06-26",
  createdAtMs: 1_782_444_000_000,
  operatorName: "Operatore",
  totalCents: 12000,
  qrPayload: "FCA:payload",
  printText: "FONDO CASSA AUTOMATICO\n{{ESC_POS_RAW_BASE64:test}}",
  status: "generated",
  ...overrides,
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("automatic cash ticket registry", () => {
  it("normalizes and persists generated ticket records without clear print amount fields", () => {
    const printText = buildAutomaticCashFloatTicketText({
      cashFloatId: "FCA-1",
      assignmentId: "ASN-1",
      combinationId: "COMBO-1",
      businessEveningKey: "2026-06-26",
      createdAtMs: 1_782_444_000_000,
      operatorName: "Operatore",
      qrPayload: "FCA:payload",
    });
    const record = saveAutomaticCashTicketRecord(makeRecord({ printText }));

    expect(record.status).toBe("generated");
    expect(record.totalCents).toBe(12000);
    expect(record.printText).toContain("FONDO CASSA AUTOMATICO");
    expect(record.printText).toContain("Valore codificato - non visibile");
    expect(record.printText).toContain("{{ESC_POS_RAW_BASE64:");
    expect(record.printText).not.toContain("--- QR PAYLOAD START ---");
    expect(record.printText).not.toContain("FCA:payload");
    expect(record.printText).not.toContain("120,00");
    expect(readAutomaticCashTicketRecords()).toEqual([record]);
  });

  it("deduplicates by cashFloatId and keeps the saved print text for reprints", () => {
    saveAutomaticCashTicketRecord(makeRecord({ printText: "TESTO ORIGINALE" }));
    const updated = saveAutomaticCashTicketRecord(
      makeRecord({ status: "loaded", printText: "TESTO NUOVO" })
    );

    expect(updated.status).toBe("loaded");
    expect(updated.printText).toBe("TESTO ORIGINALE");
    expect(readAutomaticCashTicketRecords()).toHaveLength(1);
  });

  it("updates record status and ignores malformed records", () => {
    expect(normalizeAutomaticCashTicketRecord({ cashFloatId: "FCA-1" })).toBeNull();
    saveAutomaticCashTicketRecord(makeRecord());

    const updated = updateAutomaticCashTicketRecordStatus("FCA-1", "used_in_settlement");

    expect(updated?.status).toBe("used_in_settlement");
    expect(readAutomaticCashTicketRecords()[0]?.status).toBe("used_in_settlement");
  });
});
