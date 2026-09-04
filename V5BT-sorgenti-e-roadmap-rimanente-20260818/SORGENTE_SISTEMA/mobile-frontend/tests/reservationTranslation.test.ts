import { describe, expect, it } from "vitest";
import {
  intolerancesToTableAllergens,
  stripAllergyNote,
  TABLE_ALLERGY_NOTE,
  tableAllergensToIntolerances,
  withAllergyNote,
  splitCoversAcrossTables,
  coversForAssignedTable,
} from "../src/domain/tables/reservationTranslation";

describe("traduzione prenotazione <-> tavolo", () => {
  it("divide i preset dell'anagrafica dal testo libero", () => {
    expect(intolerancesToTableAllergens("Pesce, Cipolla; Solfiti")).toEqual({
      allergens: ["Pesce", "Solfiti"],
      manualIntolerance: "Cipolla",
    });
  });

  it("spezza il testo libero su virgola e punto e virgola", () => {
    expect(intolerancesToTableAllergens("Cipolla, Aglio; Peperoni").manualIntolerance).toBe(
      "Cipolla, Aglio, Peperoni"
    );
  });

  it("riconosce i sinonimi dell'anagrafica come preset", () => {
    expect(intolerancesToTableAllergens("sesamo").allergens).toEqual(["Semi di sesamo"]);
    expect(intolerancesToTableAllergens("frutta secca").allergens).toEqual(["Frutta a guscio"]);
  });

  it("torna indietro senza perdere nulla", () => {
    const originale = "Pesce, Cipolla, Solfiti";
    const tavolo = intolerancesToTableAllergens(originale);
    const ritorno = tableAllergensToIntolerances(tavolo.allergens, tavolo.manualIntolerance);
    expect(intolerancesToTableAllergens(ritorno)).toEqual(tavolo);
  });

  it("non accumula il marcatore di allergia nelle note", () => {
    const conNota = withAllergyNote("Tavolo vicino alla finestra", true);
    expect(conNota).toBe(`${TABLE_ALLERGY_NOTE}\nTavolo vicino alla finestra`);
    expect(withAllergyNote(conNota, true)).toBe(conNota);
    expect(withAllergyNote(conNota, false)).toBe("Tavolo vicino alla finestra");
    expect(stripAllergyNote(conNota)).toBe("Tavolo vicino alla finestra");
  });

  it("senza intolleranze non aggiunge il marcatore", () => {
    expect(withAllergyNote("Solo una nota", false)).toBe("Solo una nota");
    expect(tableAllergensToIntolerances([], "")).toBe("");
  });
});

describe("coperti sui tavoli uniti", () => {
  it("ripartisce il totale senza perderne", () => {
    expect(splitCoversAcrossTables(8, 2)).toEqual([4, 4]);
    expect(splitCoversAcrossTables(8, 3)).toEqual([3, 3, 2]);
    expect(splitCoversAcrossTables(2, 3)).toEqual([1, 1, 0]);
    for (const [totale, tavoli] of [
      [8, 3],
      [7, 2],
      [13, 4],
      [1, 5],
    ] as const) {
      const quote = splitCoversAcrossTables(totale, tavoli);
      expect(quote.reduce((sum, value) => sum + value, 0)).toBe(totale);
    }
  });

  it("da a ogni tavolo la sua quota, e il totale se non e' assegnato", () => {
    const assegnati = ["t1", "t2", "t3"];
    expect(assegnati.map((id) => coversForAssignedTable(8, assegnati, id))).toEqual([3, 3, 2]);
    expect(coversForAssignedTable(8, assegnati, "altro")).toBe(8);
  });
});

describe("coperti senza tavoli assegnati", () => {
  it("non va in errore e restituisce il totale", () => {
    expect(coversForAssignedTable(4, undefined, "t1")).toBe(4);
    expect(coversForAssignedTable(4, [], "t1")).toBe(4);
  });
});
