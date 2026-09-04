import { describe, expect, it } from "vitest";
import {
  fiscalOutcomeLabelFor,
  resolveFiscalOutcomeState,
} from "../src/domain/payments/fiscalOutcome";

describe("fiscal outcome model", () => {
  it("distingue un esito ancora pendente da un fallimento realmente ripetibile", () => {
    expect(resolveFiscalOutcomeState({ raw: { fiscalStatus: "PROCESSING" } })).toBe(
      "pending"
    );
    expect(resolveFiscalOutcomeState({ raw: { fiscalStatus: "FAILED" } })).toBe(
      "failed"
    );
    expect(resolveFiscalOutcomeState({ raw: { fiscalStatus: "ISSUED" } })).toBe(
      "issued"
    );
  });

  it("mantiene le label storiche del dettaglio pagamento", () => {
    expect(fiscalOutcomeLabelFor({ raw: { fiscalStatus: "PROCESSING" } })).toBe(
      "KO"
    );
    expect(fiscalOutcomeLabelFor({ raw: { fiscalStatus: "VOIDED" } })).toBe(
      "ANNULLATO"
    );
  });
});
