import { describe, expect, it } from "vitest";
import { formatElapsedCoarse, formatElapsedCompact } from "../src/pages/home/utils/time";

/**
 * Le due forme della durata di occupazione, ai confini.
 *
 * Sono due perche' servono a due posti diversi: la tessera della vista tavoli
 * ha poco spazio e si ferma a **due** unita'; il dettaglio del tavolo ne mostra
 * fino a tre e le perde allontanandosi, perche' i minuti di un mese fa non
 * interessano piu' a nessuno.
 *
 * I confini sono la parte che si sbaglia: 24 ore esatte, 30 giorni, un anno.
 */

const MINUTO = 60_000;
const ORA = 60 * MINUTO;
const GIORNO = 24 * ORA;
const ADESSO = Date.UTC(2026, 8, 4, 12, 0, 0);
const fa = (ms: number) => ADESSO - ms;

describe("formatElapsedCoarse: la durata nella tessera", () => {
  it("sotto l'ora conta i minuti", () => {
    expect(formatElapsedCoarse(fa(0), ADESSO)).toBe("0min");
    expect(formatElapsedCoarse(fa(59 * MINUTO), ADESSO)).toBe("59min");
  });

  it("da un'ora in su conta ore e minuti", () => {
    expect(formatElapsedCoarse(fa(ORA), ADESSO)).toBe("1h");
    expect(formatElapsedCoarse(fa(3 * ORA + 20 * MINUTO), ADESSO)).toBe("3h 20min");
    expect(formatElapsedCoarse(fa(23 * ORA + 59 * MINUTO), ADESSO)).toBe("23h 59min");
  });

  it("dalle 24 ore passa a giorni e ore, e i minuti spariscono", () => {
    expect(formatElapsedCoarse(fa(GIORNO), ADESSO)).toBe("1g");
    expect(formatElapsedCoarse(fa(GIORNO + 2 * ORA + 40 * MINUTO), ADESSO)).toBe("1g 2h");
    expect(formatElapsedCoarse(fa(29 * GIORNO + 23 * ORA), ADESSO)).toBe("29g 23h");
  });

  it("dai 30 giorni resta il solo numero di giorni", () => {
    expect(formatElapsedCoarse(fa(30 * GIORNO + 5 * ORA), ADESSO)).toBe("30g");
    expect(formatElapsedCoarse(fa(400 * GIORNO + 5 * ORA), ADESSO)).toBe("400g");
  });
});

describe("formatElapsedCompact: la durata nel dettaglio", () => {
  it("sotto le 24 ore si comporta come prima", () => {
    expect(formatElapsedCompact(fa(59 * MINUTO), ADESSO)).toBe("59min");
    expect(formatElapsedCompact(fa(ORA), ADESSO)).toBe("1h");
    expect(formatElapsedCompact(fa(3 * ORA + 20 * MINUTO), ADESSO)).toBe("3h 20min");
    expect(formatElapsedCompact(fa(23 * ORA + 59 * MINUTO), ADESSO)).toBe("23h 59min");
  });

  it("dalle 24 ore mostra giorni, ore e minuti", () => {
    expect(formatElapsedCompact(fa(GIORNO), ADESSO)).toBe("1g");
    expect(formatElapsedCompact(fa(GIORNO + 2 * ORA + 5 * MINUTO), ADESSO)).toBe("1g 2h 5min");
    expect(formatElapsedCompact(fa(29 * GIORNO + 23 * ORA + 59 * MINUTO), ADESSO)).toBe(
      "29g 23h 59min"
    );
  });

  it("dai 30 giorni perde i minuti e dall'anno perde anche le ore", () => {
    expect(formatElapsedCompact(fa(30 * GIORNO + 5 * ORA + 20 * MINUTO), ADESSO)).toBe("30g 5h");
    expect(formatElapsedCompact(fa(364 * GIORNO + 5 * ORA), ADESSO)).toBe("364g 5h");
    expect(formatElapsedCompact(fa(365 * GIORNO + 5 * ORA), ADESSO)).toBe("365g");
    expect(formatElapsedCompact(fa(400 * GIORNO + 5 * ORA + 20 * MINUTO), ADESSO)).toBe("400g");
  });

  it("i componenti a zero non si scrivono", () => {
    expect(formatElapsedCompact(fa(2 * GIORNO + 20 * MINUTO), ADESSO)).toBe("2g 20min");
    expect(formatElapsedCompact(fa(2 * GIORNO), ADESSO)).toBe("2g");
  });
});

describe("un tempo futuro non diventa negativo", () => {
  it("vale zero", () => {
    expect(formatElapsedCoarse(ADESSO + GIORNO, ADESSO)).toBe("0min");
    expect(formatElapsedCompact(ADESSO + GIORNO, ADESSO)).toBe("0min");
  });
});
