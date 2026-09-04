import { describe, expect, it } from "vitest";
import type { DiningTable } from "../src/api/tables";
import type { TableGroup } from "../src/api/tableGroups";
import { evaluateUnionReadiness } from "../src/pages/home/tables/reservationTableUnion";

const tavolo = (id: string, extra: Partial<DiningTable> = {}) =>
  ({
    id,
    number: Number(id.replace(/\D/g, "")) || 1,
    occupancyState: "free",
    ordersInProgress: 0,
    amountDue: 0,
    ...extra,
  }) as DiningTable;

const gruppo = (id: string, figli: string[]): TableGroup => ({
  id,
  type: "complex",
  children: figli.map((child) => ({ id: child, type: "simple" as const })),
  updatedAt: "2026-08-28T00:00:00.000Z",
});

describe("prontezza dell'unione da prenotazione", () => {
  it("e' pronta quando tutti i tavoli assegnati sono liberi", () => {
    const esito = evaluateUnionReadiness([tavolo("t1"), tavolo("t2")], ["t1", "t2"], []);
    expect(esito.ready).toBe(true);
    expect(esito.toFree).toHaveLength(0);
    expect(esito.blocked).toHaveLength(0);
  });

  it("separa i tavoli da liberare da quelli bloccati", () => {
    const esito = evaluateUnionReadiness(
      [
        tavolo("t1", { occupancyState: "seated" }),
        tavolo("t2", { occupancyState: "seated", ordersInProgress: 1 }),
        tavolo("t3", { occupancyState: "seated", amountDue: 12 }),
      ],
      ["t1", "t2", "t3"],
      []
    );
    expect(esito.ready).toBe(false);
    expect(esito.toFree.map((t) => t.id)).toEqual(["t1"]);
    expect(esito.blocked.map((t) => t.id)).toEqual(["t2", "t3"]);
  });

  it("segnala i tavoli gia' dentro un gruppo diverso", () => {
    const esito = evaluateUnionReadiness(
      [tavolo("t1"), tavolo("t2"), tavolo("t9")],
      ["t1", "t2"],
      [gruppo("g1", ["t1", "t9"])]
    );
    expect(esito.conflicting.map((t) => t.id)).toEqual(["t1"]);
    expect(esito.ready).toBe(false);
  });

  it("non riforma un'unione gia' esatta", () => {
    const esito = evaluateUnionReadiness(
      [tavolo("t1"), tavolo("t2")],
      ["t1", "t2"],
      [gruppo("g1", ["t1", "t2"])]
    );
    expect(esito.alreadyUnited).toBe(true);
    expect(esito.ready).toBe(false);
  });

  it("elenca gli assegnati che non stanno in questa sala", () => {
    const esito = evaluateUnionReadiness([tavolo("t1")], ["t1", "altrove"], []);
    expect(esito.missing).toEqual(["altrove"]);
    expect(esito.ready).toBe(false);
  });

  it("un solo tavolo non forma unione", () => {
    expect(evaluateUnionReadiness([tavolo("t1")], ["t1"], []).ready).toBe(false);
  });
});
