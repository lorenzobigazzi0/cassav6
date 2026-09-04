import { describe, expect, it } from "vitest";
import { shouldReseedTableForm } from "../src/pages/home/tables/utils";

/**
 * Quando il modulo del dettaglio va riscritto con i dati del server.
 *
 * Questi casi esistono perche' la loro assenza ha nascosto un difetto
 * silenzioso: l'effetto riscriveva **tutti** i campi a ogni aggiornamento del
 * tavolo, senza guardare se l'utente aveva qualcosa in sospeso. Un
 * aggiornamento che arrivava fra la scelta di un'intolleranza e il suo
 * salvataggio la cancellava senza dire niente.
 *
 * Il rovescio conta quanto il dritto: cambiando tavolo si deve ripartire dai
 * dati del server anche con modifiche aperte, altrimenti la bozza di un tavolo
 * finirebbe addosso a un altro.
 */

describe("shouldReseedTableForm", () => {
  it("cambiando tavolo si riparte sempre dal server", () => {
    expect(
      shouldReseedTableForm({
        isRestoredSelection: false,
        isTableSwitch: true,
        hasUnsavedChanges: true,
      })
    ).toBe(true);
  });

  it("sullo stesso tavolo le modifiche non salvate vincono sull'aggiornamento", () => {
    expect(
      shouldReseedTableForm({
        isRestoredSelection: false,
        isTableSwitch: false,
        hasUnsavedChanges: true,
      })
    ).toBe(false);
  });

  it("sullo stesso tavolo senza nulla in sospeso si risincronizza", () => {
    expect(
      shouldReseedTableForm({
        isRestoredSelection: false,
        isTableSwitch: false,
        hasUnsavedChanges: false,
      })
    ).toBe(true);
  });

  it("la selezione ripristinata non si tocca", () => {
    // Lo stato e' appena stato rimesso com'era: riscriverlo lo butterebbe via.
    expect(
      shouldReseedTableForm({
        isRestoredSelection: true,
        isTableSwitch: false,
        hasUnsavedChanges: false,
      })
    ).toBe(false);
    expect(
      shouldReseedTableForm({
        isRestoredSelection: true,
        isTableSwitch: true,
        hasUnsavedChanges: true,
      })
    ).toBe(false);
  });
});
