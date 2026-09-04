import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("table free action availability", () => {
  it("mostra Libera anche per tavoli vuoti, occupati o prenotati senza conti sospesi", () => {
    const detailPanel = readSource("src/pages/home/tables/components/TableDetailPanel.tsx");

    expect(detailPanel).toContain(
      "const canFree = Boolean(table && table.ordersInProgress <= 0 && table.amountDue <= 0)"
    );
    // Fuori dalla finestra dei 30 minuti un tavolo prenotato si gestisce come libero.
    expect(detailPanel).toContain("const showFreeAction = canFree && !actsAsFree;");
    expect(detailPanel).toContain("shouldReserveTableForReservation(table?.reservationAt ?? 0");
    // Fuori finestra il pannello non precompila e non salva sulla prenotazione.
    expect(detailPanel).toContain("const showAnagraphicCard = !actsAsFree && canEditAnagraphic;");
    expect(detailPanel).toContain("CONFERMA PRENOTAZIONE");
    expect(detailPanel).toContain("<TableOccupyConfirmButton");
    expect(detailPanel).toContain(
      "showFreeAction || ((isSeated || isReserved) && (canOrder || canPay))"
    );
    expect(detailPanel).toContain('!canOrder && !canPay && !isReserved ? "is-full" : ""');
    expect(detailPanel).not.toContain("showFreeAction = Boolean(canFree && hasAnyOrder)");
  });

  it("affianca GESTISCI e LIBERA nella barra inferiore del tavolo prenotato", () => {
    const detailPanel = readSource("src/pages/home/tables/components/TableDetailPanel.tsx");
    const bottomActionsStart = detailPanel.indexOf("{showBottomActions && (");
    const bottomActionsEnd = detailPanel.indexOf("{tablePrecontoMenuOpen && (", bottomActionsStart);
    const bottomActions = detailPanel.slice(bottomActionsStart, bottomActionsEnd);

    // GESTISCI compare solo dentro la finestra dei 30 minuti.
    expect(bottomActions).toContain("{withinReservationWindow && (");
    expect(bottomActions).toContain("table-detail-bottom-btn table-detail-arrived-btn");
    // ARRIVATI non sta piu' qui: e' una delle azioni dietro GESTISCI.
    expect(bottomActions).toContain('label="GESTISCI"');
    expect(bottomActions).toContain("onMarkArrived={onMarkArrived}");
    expect(bottomActions).not.toContain("onClick={onMarkArrived}");
    expect(bottomActions).toContain("LIBERA");
    expect(bottomActions.indexOf("GESTISCI")).toBeLessThan(bottomActions.indexOf("LIBERA"));
  });

  it("mostra la durata di occupazione con la clessidra senza la scritta Seduto da", () => {
    const detailPanel = readSource("src/pages/home/tables/components/TableDetailPanel.tsx");

    expect(detailPanel).toContain("formatElapsedCompact(table.seatedAt, timeNow)");
    expect(readSource("src/pages/home/tables/components/TableDetailHeader.tsx")).toContain(
      "<TableArrivalPill"
    );
    expect(readSource("src/pages/home/tables/components/TableArrivalPill.tsx")).toContain(
      "hourglass.png"
    );
    expect(detailPanel).not.toContain("`Seduto da ${formatRelativeTime");

    // La stessa durata compare nella tessera: clessidra, valore e unita'.
    const tile = readSource("src/pages/home/tables/components/TableTile.tsx");
    expect(tile).toContain("hourglass.png");
    // Oltre le 24 ore un tavolo si misura in giorni: prima non era cosi', e
    // questa asserzione fissava la regola opposta. Le progressioni sono due,
    // perche' la tessera ha meno spazio del dettaglio, e il comportamento vero
    // e' fissato caso per caso da tests/elapsedDuration.test.ts.
    const timing = readSource("src/pages/home/utils/time.ts");
    expect(timing).toContain("formatElapsedCompact");
    expect(timing).toContain("formatElapsedCoarse");
    expect(timing).toContain("GIORNI_SENZA_MINUTI");
    expect(timing).toContain("GIORNI_SENZA_ORE");
    // La tessera usa la forma corta, non quella estesa del dettaglio.
    expect(readSource("src/pages/home/tables/utils.ts")).toContain(
      "formatElapsedCoarse(table.seatedAt, now)"
    );
  });

  it("l'API mobile libera anche una prenotazione se non ci sono ordini o pagamenti aperti", () => {
    const tablesApi = readSource("src/api/tables.ts");
    const freeFunctionStart = tablesApi.indexOf("export async function freeDiningTable");
    expect(freeFunctionStart).toBeGreaterThan(-1);
    const freeFunction = tablesApi.slice(
      freeFunctionStart,
      tablesApi.indexOf("export async function moveDiningTable")
    );

    expect(freeFunction).toContain("table.ordersInProgress > 0 || table.amountDue > 0");
    expect(freeFunction).not.toContain('occupancyState === "reserved"');
    expect(freeFunction).toContain('occupancyState: "free"');
  });
});
