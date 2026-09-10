import { describe, expect, it } from "vitest";
import { cashMovementDisplayKind } from "../src/pages/home/analytics/CashMovementsView";

describe("cashMovementDisplayKind", () => {
  it("maps persisted movement types to the four operator-facing meanings", () => {
    expect(cashMovementDisplayKind({ type: "load", justification: "Rifornimento" })).toBe("refill");
    expect(cashMovementDisplayKind({ type: "exchange", justification: "Cambio tagli" })).toBe("exchange");
    expect(cashMovementDisplayKind({ type: "withdrawal", justification: "Erogazione contanti" })).toBe("withdrawal");
    expect(cashMovementDisplayKind({ type: "withdrawal", justification: "Estrazione cassetto overflow" })).toBe("extraction");
  });
});
