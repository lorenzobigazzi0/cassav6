import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateAutomaticCashConfigFile } from "../src/utils/automaticCashConfigValidation";

const fixtureCandidates = [
  resolve(process.cwd(), "../cassa-frontend/backend/tests/fixtures"),
  resolve(process.cwd(), "../../../SORGENTE_SISTEMA/cassa-frontend/backend/tests/fixtures"),
];
const fixtureRoot = fixtureCandidates.find((candidate) => existsSync(candidate));

describe("automatic cash config validation", () => {
  it("accepts the bundled example config file and builds a summary", () => {
    const raw = readFileSync(
      resolve(fixtureRoot ?? "", "fondo_cassa_15_combinazioni_casuali.example.json"),
      "utf8"
    );

    const result = validateAutomaticCashConfigFile(JSON.parse(raw));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary?.currency).toBe("EUR");
    expect(result.summary?.combinationsCount).toBe(15);
    expect(result.summary?.minTotalCents).toBe(12030);
    expect(result.summary?.maxTotalCents).toBeGreaterThan(result.summary?.minTotalCents ?? 0);
    expect(result.warnings.join(" ")).toContain("massimo 15 operatori");
  });

  it("rejects duplicate ids and inconsistent totals", () => {
    const result = validateAutomaticCashConfigFile({
      nome: "Config errata",
      valuta: "EUR",
      denominazioni_centesimi: { "1_euro": 100 },
      combinazioni: [
        {
          id: "DUP",
          totale_centesimi: 100,
          pezzi_totali: 1,
          tagli: { "1_euro": 1 },
        },
        {
          id: "DUP",
          totale_centesimi: 250,
          pezzi_totali: 3,
          tagli: { "1_euro": 2 },
        },
      ],
    });

    const errors = result.errors.join(" ");
    expect(result.ok).toBe(false);
    expect(errors).toContain("Combinazione duplicata: DUP");
    expect(errors).toContain("totale calcolato 200 diverso da 250");
    expect(errors).toContain("pezzi calcolati 2 diversi da 3");
  });
});
