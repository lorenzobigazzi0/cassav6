import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnagraphicAutoSave } from "../src/pages/home/tables/useAnagraphicAutoSave";
import type { DiningTable } from "../src/api/tables";

/**
 * Il salvataggio automatico dell'anagrafica e l'unico modo in cui
 * un'intolleranza segnata dalla modale arriva al server: non c'e piu un
 * pulsante "Aggiorna" da premere.
 *
 * Questi casi esistono perche la loro assenza ha nascosto due difetti, ed
 * erano entrambi silenziosi — la scelta spariva senza un messaggio:
 *
 *  - allergeni e intolleranza manuale **non erano nel confronto**, quindi su un
 *    tavolo che aveva gia il marcatore in nota nessun campo guardato cambiava e
 *    il salvataggio non partiva mai;
 *  - il rinvio di 900 ms veniva **annullato** dalla pulizia dell'effetto quando
 *    il pannello si chiudeva, cosi chi segnava l'intolleranza e passava oltre
 *    subito la perdeva. E il "troppo velocemente" segnalato in esercizio.
 */

const RITARDO = 900;

const tavolo = (extra: Partial<DiningTable> = {}) =>
  ({
    id: "room_test_t01",
    tableName: "Rossi",
    customerPhone: "",
    covers: 4,
    note: "",
    allergens: [],
    manualIntolerance: "",
    occupancyState: "occupied",
    ...extra,
  }) as unknown as DiningTable;

type BozzaParziale = {
  name?: string;
  phone?: string;
  covers?: string;
  note?: string;
  allergens?: string[];
  manualIntolerance?: string;
};

function Banco({
  table,
  bozza,
  save,
  enabled = true,
}: {
  table: DiningTable | null;
  bozza: BozzaParziale;
  save: () => void;
  enabled?: boolean;
}) {
  useAnagraphicAutoSave({
    enabled,
    table,
    draft: {
      name: bozza.name ?? table?.tableName ?? "",
      phone: bozza.phone ?? table?.customerPhone ?? "",
      covers: bozza.covers ?? String(table?.covers ?? 4),
      note: bozza.note ?? table?.note ?? "",
    },
    intolerances: {
      list: bozza.allergens ?? table?.allergens ?? [],
      manual: bozza.manualIntolerance ?? table?.manualIntolerance ?? "",
    },
    save,
  });
  return null;
}

describe("salvataggio automatico dell'anagrafica: allergie e intolleranze", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("salva una seconda intolleranza anche se la nota non cambia", () => {
    const save = vi.fn();
    // Il tavolo ha gia il marcatore in nota e un allergene: aggiungendone un
    // altro nessuno dei campi di testo si muove.
    const table = tavolo({ note: "ALLERGIE / INTOLLERANZE", allergens: ["Latte"] });
    render(<Banco table={table} bozza={{ allergens: ["Latte", "Crostacei"] }} save={save} />);

    act(() => {
      vi.advanceTimersByTime(RITARDO);
    });

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("salva l'intolleranza scritta a mano anche se la nota non cambia", () => {
    const save = vi.fn();
    const table = tavolo({ note: "ALLERGIE / INTOLLERANZE", allergens: ["Latte"] });
    render(
      <Banco
        table={table}
        bozza={{ allergens: ["Latte"], manualIntolerance: "Nickel" }}
        save={save}
      />
    );

    act(() => {
      vi.advanceTimersByTime(RITARDO);
    });

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("chiudere il pannello prima dei 900 ms non perde la scelta", () => {
    const save = vi.fn();
    const table = tavolo({ note: "ALLERGIE / INTOLLERANZE" });
    const vista = render(<Banco table={table} bozza={{ allergens: ["Crostacei"] }} save={save} />);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(save).not.toHaveBeenCalled();

    act(() => {
      vista.unmount();
    });

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("cambiare tavolo mentre il salvataggio e in attesa salva comunque", () => {
    const save = vi.fn();
    const primo = tavolo({ note: "ALLERGIE / INTOLLERANZE" });
    const vista = render(<Banco table={primo} bozza={{ allergens: ["Crostacei"] }} save={save} />);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    const secondo = tavolo({ id: "room_test_t02", tableName: "Bianchi" });
    act(() => {
      vista.rerender(<Banco table={secondo} bozza={{}} save={save} />);
    });

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("senza modifiche non salva, nemmeno chiudendo il pannello", () => {
    const save = vi.fn();
    const table = tavolo({ allergens: ["Latte"] });
    const vista = render(<Banco table={table} bozza={{ allergens: ["Latte"] }} save={save} />);

    act(() => {
      vi.advanceTimersByTime(RITARDO * 2);
    });
    act(() => {
      vista.unmount();
    });

    expect(save).not.toHaveBeenCalled();
  });

  it("lo stesso elenco in ordine diverso non e una modifica", () => {
    const save = vi.fn();
    const table = tavolo({ allergens: ["Latte", "Crostacei"] });
    render(<Banco table={table} bozza={{ allergens: ["Crostacei", "Latte"] }} save={save} />);

    act(() => {
      vi.advanceTimersByTime(RITARDO * 2);
    });

    expect(save).not.toHaveBeenCalled();
  });

  it("il salvataggio in attesa non parte se nel frattempo il tavolo si libera", () => {
    const save = vi.fn();
    const table = tavolo({ note: "ALLERGIE / INTOLLERANZE" });
    const vista = render(<Banco table={table} bozza={{ allergens: ["Crostacei"] }} save={save} />);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    // `enabled` a falso e come si segnala che sul tavolo non si deve scrivere.
    act(() => {
      vista.rerender(
        <Banco table={table} bozza={{ allergens: ["Crostacei"] }} save={save} enabled={false} />
      );
    });
    act(() => {
      vista.unmount();
    });

    expect(save).not.toHaveBeenCalled();
  });
});
